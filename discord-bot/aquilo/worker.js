// aquilo-bot dispatch module — post bot-consolidation fold-in.
//
// Originally this file WAS the aquilo-bot Worker entrypoint. After the
// consolidation it's a sibling dispatch module under the loadout-discord
// Worker. The default-export Cloudflare Worker shape is gone; in its
// place are named exports the Loadout entrypoint imports and calls
// directly:
//
//   handleAquiloHttp           HTTP routes: /today-game, /overlay/ws,
//                              /counting/message, /forward-channels,
//                              /announce, /broadcast, /fourthwall,
//                              /sr/pending
//   dispatchAquiloInteraction  Discord interaction routing (assumes
//                              signature already verified by the
//                              Loadout entrypoint with the unified
//                              app's public key — no re-verify here)
//   aquiloScheduledTick        cron entrypoint for the 0,30 * * * *
//                              trigger
//
// Plus the Durable Object class re-export so wrangler can attach
// it to the OVERLAY_DO binding declared in the Loadout
// wrangler.toml.
//
// Bindings (wrangler.toml, all defined on the merged loadout-discord
// Worker):
//   STATE      - KV namespace, used by aq-schedule.js, aq-queue.js, bootstrap.js
//   DB         - D1 database, used by poll.js, bootstrap.js
//   OVERLAY_DO - Durable Object (OverlayBroadcaster), used by
//                /overlay/ws + the today-game push.

import { verifyDiscordSignature } from './auth.js';
import { verifyGatewaySig } from '../auth.js';
import { buildAnnouncementEmbed } from './embed.js';
import { getProducts } from './products.js';
import { ephemeral, getETInfo } from './util.js';
import { ensureBootstrap } from './bootstrap.js';
import { handleHubCommand, handleHubButton } from './hub.js';
import { handleVoteClick, runScheduledPoll } from './poll.js';
import { handleQueueButton } from './aq-queue.js';
import { handleNotifyButton } from './notify.js';
import {
  handleGameAddSubmit, handleGameRemoveSubmit, handleGameSetArtSubmit
} from './aq-games.js';
import { postWeeklyRecap } from './recap.js';
import { postDailyPrompt, handlePromptsEditSubmit } from './prompts.js';
import { refreshCountdown } from './countdown.js';
import { postPatronSpotlight } from './spotlight.js';
import {
  runDailyPoll, handleDailyPollVote, handleDailyPollEditSubmit
} from './daily-poll.js';
import { handleSuggestCommand, handleSuggestionAction } from './suggestions.js';
import { cleanupQueueAfterStream } from './aq-queue.js';
import { notifyUnvotedEligibles } from './notify.js';
import { cleanupOldPollMessages } from './cleanup.js';
import {
  handleSelfRoleAddSubmit, handleSelfRoleRemoveSubmit, handleRoleToggle
} from './self-roles.js';
import { handleHubSelect } from './self-roles-hub.js';
import { OverlayBroadcaster } from './overlay-do.js';
import { handleCountingMessage, sweepFailRoles, sweepCountingChannelTimeouts } from './counting.js';
import {
  handleSetupCommand, handleSetupButton,
  handleSetupChannelsASubmit, handleSetupChannelsBSubmit,
  handleSetupRolesSubmit, handleSetupTuningSubmit, handleSetupAdvancedSubmit
} from './setup.js';
import { envForGuild, getActiveGuildId } from './config.js';
import { handleEncounterCommand } from './encounter.js';
import { checkMemberMilestones } from './goals.js';
import { refreshHubMessage } from './hub.js';
import {
  handleViewerHubButton,
  handleViewerSuggestSubmit, handleViewerSrAddSubmit, handleViewerSrRemoveSubmit
} from './viewer-hub.js';
import {
  handleTicketComponent,
  handleTicketConfigSubmit, handleTicketTypeAddSubmit, handleTicketTypeRemoveSubmit
} from './tickets.js';
import {
  handleCheckinSearchButton, handleCheckinPickButton,
  handleCheckinSearchSubmit,
} from './checkin-slash.js';
// /checkin v2 — modal-first compose flow (gif + message before posting).
// Old aqci:* chain above stays wired for backward compat.
import {
  handleCheckinComposeSubmit, handleCheckinPickSubmit,
} from '../community-checkin.js';

// Re-export the Durable Object class so wrangler can wire it to the
// OVERLAY_DO binding. Required at the entrypoint script.
export { OverlayBroadcaster };
import {
  handleSrAdd, handleSrList, handleSrRemove, handleSrClear,
  handlePendingGet, handlePendingDelete,
} from './song-prequeue.js';
import { handleRotationPoll, runScheduledRotationPoll } from './rotation-poll.js';
import { handleTodayGame } from './today-game.js';

// v3 features (passport, streak, achievements, welcome, birthdays,
// trivia, shop, clip-of-the-week, returning, leaderboard channel).
import { handlePassportCommand, handlePassportButton } from './passport.js';
import { handleBirthdayCommand, runBirthdayCron } from './birthdays.js';
import {
  runTriviaCron, handleTriviaClick,
  triviaEditModal, handleTriviaEditSubmit
} from './trivia.js';
import {
  handleShopCommand, handleShopBuyClick,
  shopEditModal, handleShopEditSubmit
} from './shop.js';
import { maybeWelcome } from './welcome.js';
import { tickAsync as streakTick } from './streak.js';
import {
  trackClipMessage, refreshClipReactions, postClipOfTheWeek
} from './clipoftheweek.js';
import { touchSeen, runReturningCron } from './returning.js';
import { refreshLeaderboardChannel } from './leaderboard-channel.js';
import { isAdmin } from './util.js';

const TYPE_PING            = 1;
const TYPE_APPLICATION_CMD = 2;
const TYPE_COMPONENT       = 3;  // button + select clicks
const TYPE_MODAL_SUBMIT    = 5;
const RESP_PONG            = 1;
const RESP_CHAT            = 4;
const FLAG_EPHEMERAL       = 64;

// HTTP entrypoint — Loadout's main worker.js falls through to this
// for any aquilo-owned route. Returns `null` when no aquilo route
// matches the request so the Loadout entrypoint can keep its own
// fallthrough (404, etc.). Same signature pattern as the rest of the
// loadout-discord http-dispatch family.
export async function handleAquiloHttp(req, env, ctx, url) {
  const path = url.pathname;
  const method = req.method;

  // Public read: tonight's stream game (slug + name). Polled by the
  // multi-theme follow overlay on widget.aquilo.gg. Open CORS, no auth.
  if (method === 'GET' && path === '/today-game') return handleTodayGame(env, req);

  // WebSocket push for the overlay. Replaces the 60s polling loop with
  // an instant push when CN poll winners change. Worker upgrades and
  // hands off to the Durable Object so connection state survives across
  // worker invocations.
  if (method === 'GET' && path === '/overlay/ws') {
    if (!env.OVERLAY_DO) return txt('overlay DO not configured', 503);
    const id = env.OVERLAY_DO.idFromName('global');
    const stub = env.OVERLAY_DO.get(id);
    return stub.fetch(new Request('https://do/ws', req));
  }

  // Counting game webhook from aquilo-presence. Fail-closed if the
  // shared COUNTING_WEBHOOK_SECRET isn't configured. Fans out to clip
  // tracker + community-chat ringbuffer (each no-ops when its channel
  // doesn't match). The legacy Discord pic-attachment check-in
  // previously fanned out from here as well — retired 2026-05 in
  // favour of the unified daily check-in (community-checkin.js on
  // loadout-discord, surfaced as both /checkin and POST /web/checkin).
  if (method === 'POST' && path === '/counting/message') {
    if (!env.AQUILO_GATEWAY_SECRET && !env.COUNTING_WEBHOOK_SECRET) {
      return json({ error: 'gateway secret unset' }, 503);
    }
    const bodyText = await req.text();
    const auth = await verifyGatewaySig(req, env, bodyText);
    if (!auth.ok) return json({ error: 'unauthorized' }, 401);
    let payload;
    try { payload = JSON.parse(bodyText); } catch { return json({ error: 'bad_json' }, 400); }
    try {
      const counting = await handleCountingMessage(env, payload);
      const clip = await trackClipMessage(env, payload).catch(() => ({ tracked: false }));
      const { handleCheckinMessage } = await import('./checkin.js');
      const checkin = await handleCheckinMessage(env, payload).catch(e => ({ error: String(e?.message || e) }));
      // Community-chat ringbuffer — drops the message into KV if the
      // channel is in COMMUNITY_CHAT_CHANNELS_JSON. The /community/chat
      // public-read endpoint serves this back to the website.
      const { handleCommunityChatMessage } = await import('./community-chat.js');
      const chat = await handleCommunityChatMessage(env, payload).catch(e => ({ stored: false, error: String(e?.message || e) }));
      return json({ ok: true, counting, clip, checkin, chat, via: auth.via });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  // Gateway-forwarded GUILD_MEMBER_ADD — drives the welcome embed.
  // Same shared-secret auth as /counting/message.
  // Payload (Discord GUILD_MEMBER_ADD slim subset):
  //   { guild_id, user: { id, username, global_name, avatar, bot } }
  if (method === 'POST' && path === '/member/joined') {
    if (!env.AQUILO_GATEWAY_SECRET && !env.COUNTING_WEBHOOK_SECRET) {
      return json({ error: 'gateway secret unset' }, 503);
    }
    const bodyText = await req.text();
    const auth = await verifyGatewaySig(req, env, bodyText);
    if (!auth.ok) return json({ error: 'unauthorized' }, 401);
    let payload;
    try { payload = JSON.parse(bodyText); } catch { return json({ error: 'bad_json' }, 400); }
    try {
      const { handleMemberJoined } = await import('../welcome.js');
      const result = await handleMemberJoined(env, payload);
      return json({ ok: true, welcome: result, via: auth.via });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  // Gateway-forwarded GUILD_MEMBER_UPDATE — drives booster perks.
  // Payload (slim): { guild_id, user, premium_since, roles }
  if (method === 'POST' && path === '/member/updated') {
    if (!env.AQUILO_GATEWAY_SECRET && !env.COUNTING_WEBHOOK_SECRET) {
      return json({ error: 'gateway secret unset' }, 503);
    }
    const bodyText = await req.text();
    const auth = await verifyGatewaySig(req, env, bodyText);
    if (!auth.ok) return json({ error: 'unauthorized' }, 401);
    let payload;
    try { payload = JSON.parse(bodyText); } catch { return json({ error: 'bad_json' }, 400); }
    try {
      const { handleMemberUpdated } = await import('../boosters.js');
      const result = await handleMemberUpdated(env, payload);
      return json({ ok: true, booster: result, via: auth.via });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  // Gateway-forwarded VOICE_STATE_UPDATE — drives temp-VC create/cleanup.
  // Payload (slim): { guild_id, channel_id, user_id, session_id }
  if (method === 'POST' && path === '/voice/state') {
    if (!env.AQUILO_GATEWAY_SECRET && !env.COUNTING_WEBHOOK_SECRET) {
      return json({ error: 'gateway secret unset' }, 503);
    }
    const bodyText = await req.text();
    const auth = await verifyGatewaySig(req, env, bodyText);
    if (!auth.ok) return json({ error: 'unauthorized' }, 401);
    let payload;
    try { payload = JSON.parse(bodyText); } catch { return json({ error: 'bad_json' }, 400); }
    try {
      const { handleVoiceStateUpdate } = await import('../temp-vc.js');
      const result = await handleVoiceStateUpdate(env, payload);
      return json({ ok: true, voice: result, via: auth.via });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  // Gateway-shim signal: a tracked temp VC's occupancy dropped to zero.
  // Payload: { guild_id, channel_id }. aquilo-presence tracks per-channel
  // member counts and POSTs here when a temp-vc room empties.
  if (method === 'POST' && path === '/voice/empty') {
    if (!env.AQUILO_GATEWAY_SECRET && !env.COUNTING_WEBHOOK_SECRET) {
      return json({ error: 'gateway secret unset' }, 503);
    }
    const bodyText = await req.text();
    const auth = await verifyGatewaySig(req, env, bodyText);
    if (!auth.ok) return json({ error: 'unauthorized' }, 401);
    let payload;
    try { payload = JSON.parse(bodyText); } catch { return json({ error: 'bad_json' }, 400); }
    try {
      const { handleTempVcEmpty } = await import('../temp-vc.js');
      const result = await handleTempVcEmpty(env, payload);
      return json({ ok: true, voice: result, via: auth.via });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  // Gateway-forwarded MESSAGE_REACTION_ADD — drives the ⭐ starboard.
  // Same shared-secret auth as /counting/message (aquilo-presence
  // sends both with the same COUNTING_WEBHOOK_SECRET header).
  //
  // Payload (minimal Discord MESSAGE_REACTION_ADD subset):
  //   { guild_id, channel_id, message_id, user_id, emoji: { name } }
  if (method === 'POST' && path === '/reaction/event') {
    if (!env.AQUILO_GATEWAY_SECRET && !env.COUNTING_WEBHOOK_SECRET) {
      return json({ error: 'gateway secret unset' }, 503);
    }
    const bodyText = await req.text();
    const auth = await verifyGatewaySig(req, env, bodyText);
    if (!auth.ok) return json({ error: 'unauthorized' }, 401);
    let payload;
    try { payload = JSON.parse(bodyText); } catch { return json({ error: 'bad_json' }, 400); }
    try {
      const { handleStarboardReaction } = await import('../guild-features.js');
      const result = await handleStarboardReaction(env, payload);
      return json({ ok: true, starboard: result, via: auth.via });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  // Public read of channels aquilo-presence should forward
  // MESSAGE_CREATE for. Post-fold the LOADOUT_BOLT_API base happens to
  // point right back at this same Worker (`/checkin-channel/<guild>`
  // is defined in loadout-discord/worker.js), so the fetch is a
  // same-Worker hop now — still fine, just internally routed.
  if (method === 'GET' && path === '/forward-channels') {
    const channels = new Set();
    if (env.COUNTING_CHANNEL_ID) channels.add(String(env.COUNTING_CHANNEL_ID));
    if (env.CLIPS_CHANNEL_ID)    channels.add(String(env.CLIPS_CHANNEL_ID));
    try {
      const guildId = await (await import('./bootstrap.js')).getGuildId(env);
      if (env.LOADOUT_BOLT_API && guildId) {
        const base = new URL(env.LOADOUT_BOLT_API).origin;
        const r = await fetch(base + '/checkin-channel/' + encodeURIComponent(guildId));
        if (r.ok) {
          const j = await r.json();
          if (j && typeof j.channelId === 'string' && j.channelId) channels.add(j.channelId);
        }
      }
    } catch { /* idle */ }
    // Community-chat channels (Discord general + #in-game-chat for the
    // DiscordSRV-bridged Minecraft feed). Parsed from JSON env var so
    // Clay can change them via `wrangler secret put` without touching
    // aquilo-presence on Railway.
    try {
      const { parseAllowedChannels } = await import('./community-chat.js');
      for (const c of parseAllowedChannels(env)) channels.add(c);
    } catch { /* idle */ }
    return json({ channels: Array.from(channels) });
  }

  // Public discovery of the community-chat channels currently enabled.
  // Returns [{ id, label, kind }] so the website can render one chat
  // panel per channel without needing the IDs baked in.
  if (method === 'GET' && path === '/community/chat-channels') {
    const { parseChannelConfigs } = await import('./community-chat.js');
    return new Response(JSON.stringify({ ok: true, channels: parseChannelConfigs(env) }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=0, s-maxage=60',
        'access-control-allow-origin': '*',
      },
    });
  }

  // Public read of the community-chat ringbuffer. The query string's
  // ?channel=<id> must be in COMMUNITY_CHAT_CHANNELS_JSON; the website
  // calls this through /api/community/chat with edge caching.
  if (method === 'GET' && path === '/community/chat') {
    const channelId = url.searchParams.get('channel') || '';
    const limit = url.searchParams.get('limit') || '25';
    const { readCommunityChat } = await import('./community-chat.js');
    const r = await readCommunityChat(env, channelId, limit);
    return new Response(JSON.stringify(r), {
      status: r.ok ? 200 : 404,
      headers: {
        'content-type': 'application/json',
        // 15s edge cache + stale-while-revalidate so a busy chat
        // doesn't melt KV reads.
        'cache-control': 'public, max-age=0, s-maxage=15',
        'access-control-allow-origin': '*',
      },
    });
  }

  // Auth-gated announce paths. Fail-closed if AQUILO_BOT_SECRET unset.
  const isAuthGated =
    (method === 'POST' && (path === '/announce' || path === '/broadcast' || path === '/fourthwall')) ||
    (path === '/sr/pending');
  if (isAuthGated) {
    if (!env.AQUILO_BOT_SECRET) return json({ error: 'worker not provisioned (AQUILO_BOT_SECRET unset)' }, 503);
    const sec = req.headers.get('x-aquilo-bot-secret') || url.searchParams.get('secret') || '';
    if (sec !== env.AQUILO_BOT_SECRET) return json({ error: 'unauthorized' }, 401);
  }

  if (method === 'POST' && path === '/announce')   return handleAnnounce(req, env);
  if (method === 'POST' && path === '/broadcast')  return handleBroadcast(req, env);
  if (method === 'POST' && path === '/fourthwall') return handleFourthwall(req, env);
  if (method === 'GET'    && path === '/sr/pending') return handlePendingGet(env, req);
  if (method === 'DELETE' && path === '/sr/pending') return handlePendingDelete(env);

  // No aquilo route matched — let the Loadout entrypoint continue
  // its own dispatch.
  return null;
}

// Cron entrypoint — Loadout's scheduled() handler delegates the
// 0,30 * * * * trigger here.
export async function aquiloScheduledTick(event, env, ctx) {
  return handleScheduled(event, env, ctx);
}

// Discord interaction entrypoint. Loadout's commands.js already
// verifies the Ed25519 signature with the unified app's public key
// before reaching this code; we just dispatch.
export async function dispatchAquiloInteraction(data, env, ctx) {
  // Wrap env with the per-guild config Proxy. Handlers read env.X
  // transparently; the Proxy returns the KV-stored override when
  // /setup has written one, otherwise the deploy-time default.
  let gEnv = env;
  if (data.guild_id) {
    try { gEnv = await envForGuild(env, data.guild_id); }
    catch (e) { /* fall through to raw env */ }
    try { await ensureBootstrap(gEnv); }
    catch (e) { /* swallow — handlers below will surface clearer errors */ }
  }

  if (data.type === TYPE_APPLICATION_CMD) {
    return json(await handleAppCommand(data, gEnv, ctx));
  }
  if (data.type === TYPE_COMPONENT) {
    return json(await handleComponent(data, gEnv, ctx));
  }
  if (data.type === TYPE_MODAL_SUBMIT) {
    return json(await handleModalSubmit(data, gEnv, ctx));
  }
  return json(ephemeral('Unsupported interaction type.'));
}

async function handleScheduled(event, env, ctx) {
  const fired = new Date(event.scheduledTime || Date.now());
  const { weekday, hour, minute } = getETInfo(fired);
  // For cron, wrap env in the active-guild config proxy so per-guild
  // /setup overrides (channel ids etc) apply to scheduled handlers.
  let gEnv = env;
  try {
    const activeId = await getActiveGuildId(env);
    if (activeId) gEnv = await envForGuild(env, activeId);
  } catch { /* fall through with raw env */ }
  // Bootstrap (idempotent) before we touch DB. If it fails (e.g. bot not
  // in guild yet), nothing else can run anyway.
  try { await ensureBootstrap(gEnv); }
  catch (e) {
    console.error('[cron] bootstrap failed', e?.message || e);
    return;
  }
  // Use gEnv from here on so cron jobs see per-guild config overrides.
  env = gEnv;

  // Post-stream queue cleanup. Originally fired at 12:30 AM ET; after
  // the bot-consolidation fold-in we ride the :23 hourly cron instead
  // of a dedicated 0,30 trigger (CF free-plan 4-cron ceiling), so this
  // fires at 1:23 AM ET on Sunday — a cosmetic ~30 min delay.
  if (hour === 1 && weekday === 'sunday') {
    try { await cleanupQueueAfterStream(env); }
    catch (e) { console.error('[cron] queue cleanup', e?.message || e); }
  }

  // ---- hourly jobs (unchanged from the pre-fold cadence) ----
  // (used to gate on minute === 0; now runs every hour at :23
  // — per-task hour checks below still fire on the right hour
  // boundary, just 23 min later than the old :00 schedule.)
  await runScheduledPoll(env, weekday, hour, ctx);

  // Engagement crons (each one no-ops if its channel env var is unset).
  // Hourly: stream countdown refresh.
  try { await refreshCountdown(env); }
  catch (e) { console.error('[cron countdown]', e?.message || e); }

  // 10 AM ET daily: rotate this-or-that mini-poll (close prev, post new).
  if (hour === 10) {
    try { await runDailyPoll(env); }
    catch (e) { console.error('[cron daily-poll]', e?.message || e); }
  }

  // Noon ET daily: post the daily community prompt.
  if (hour === 12) {
    try { await postDailyPrompt(env); }
    catch (e) { console.error('[cron prompt]', e?.message || e); }
  }

  // Friday 10 AM ET: patron spotlight.
  if (weekday === 'friday' && hour === 10) {
    try { await postPatronSpotlight(env); }
    catch (e) { console.error('[cron spotlight]', e?.message || e); }
  }

  // Saturday 8 PM ET: vote-reminder DMs (1h before CN poll closes).
  // Schedule rev 2026-05-14: Saturday is the only Community Night.
  if (hour === 20 && weekday === 'saturday') {
    try {
      const guildId = await ensureBootstrap(env);
      await notifyUnvotedEligibles(env, guildId);
    }
    catch (e) { console.error('[cron vote-remind]', e?.message || e); }
  }

  // Sunday 10 AM ET — weekly community-night recap.
  if (weekday === 'sunday' && hour === 10) {
    try { await postWeeklyRecap(env); }
    catch (e) { console.error('[cron recap]', e?.message || e); }
  }

  // 10 AM ET daily — server-milestone check.
  if (hour === 10) {
    try { await checkMemberMilestones(env); }
    catch (e) { console.error('[cron milestones]', e?.message || e); }
  }

  // Every cron tick — refresh the /hub message's status panel.
  // No-op if /hub hasn't been run yet (no msg_id stored).
  try { await refreshHubMessage(env); }
  catch (e) { console.error('[cron hub-refresh]', e?.message || e); }

  // 3 AM ET daily — delete poll messages older than 7 days.
  if (hour === 3) {
    try { await cleanupOldPollMessages(env); }
    catch (e) { console.error('[cron cleanup]', e?.message || e); }
  }

  // Every cron tick — sweep expired counting-fail roles. Granularity is
  // bounded by the cron interval (currently every 30 min), so a fail
  // role can persist up to ~30 min past its configured expiry. Fine.
  try { await sweepFailRoles(env); }
  catch (e) { console.error('[cron counting-sweep]', e?.message || e); }
  try { await sweepCountingChannelTimeouts(env); }
  catch (e) { console.error('[cron counting-channel-timeouts]', e?.message || e); }

  // Refresh the Rotation pre-stream poll's live tallies. Reads each
  // option's reaction count from Discord and PATCHes the embed if any
  // tally changed since the last refresh. No-op when no rotation poll
  // is open.
  await runScheduledRotationPoll(env);

  // ---- v3 cron entries -----------------------------------------------

  // 10 AM ET daily — birthdays callout (parallel with milestones).
  if (hour === 10) {
    try { await runBirthdayCron(env); }
    catch (e) { console.error('[cron birthdays]', e?.message || e); }
  }

  // 4 PM ET daily — post the daily trivia question.
  if (hour === 16) {
    try { await runTriviaCron(env); }
    catch (e) { console.error('[cron trivia]', e?.message || e); }
  }

  // Hourly — refresh clip reactions (cheap, bounded to ≤50 messages).
  try { await refreshClipReactions(env); }
  catch (e) { console.error('[cron clip-refresh]', e?.message || e); }

  // Sunday 10 AM ET — post clip of the week.
  if (weekday === 'sunday' && hour === 10) {
    try { await postClipOfTheWeek(env); }
    catch (e) { console.error('[cron clip-of-week]', e?.message || e); }
  }

  // Monday 10 AM ET — weekly leaderboard channel refresh.
  if (weekday === 'monday' && hour === 10) {
    try { await refreshLeaderboardChannel(env); }
    catch (e) { console.error('[cron leaderboard]', e?.message || e); }
  }

  // Every cron tick — returning-member DM scan (cheap, bounded query).
  try { await runReturningCron(env); }
  catch (e) { console.error('[cron returning]', e?.message || e); }
}

// ---- /announce + /broadcast + /fourthwall (HTTP webhooks) ---------------

async function handleAnnounce(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { product, title, body: text, url, kind, ping, channel, role_id } = body || {};
  if (!product || !title || !text) return json({ error: 'product, title, body required' }, 400);
  try {
    const result = await postAnnouncement(env, {
      product, title, body: text, url, kind, ping: !!ping,
      channelOverride: channel || null,
      roleOverride: role_id || null
    });
    return json({ ok: true, ...result });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

async function handleBroadcast(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { title, body: text, url, kind } = body || {};
  if (!title || !text) return json({ error: 'title and body required' }, 400);
  const products = getProducts(env);
  const results = [];
  for (const [key, cfg] of Object.entries(products)) {
    if (!cfg.channel) continue;
    try {
      const r = await postAnnouncement(env, { product: key, title, body: text, url, kind });
      results.push({ product: key, ...r });
    } catch (e) { results.push({ product: key, error: String(e.message || e) }); }
  }
  return json({ ok: true, posts: results });
}

async function handleFourthwall(req, env) {
  let event;
  try { event = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const type    = event.type || event.event || 'unknown';
  const product = (event.data?.product || event.product || 'general').toLowerCase();
  const title   = '🛒 New ' + type;
  const blob    = '```json\n' + JSON.stringify(event, null, 2).slice(0, 1800) + '\n```';
  try {
    const result = await postAnnouncement(env, {
      product, title, body: blob, kind: 'sale',
      channelOverride: env.FOURTHWALL_SALES_CHANNEL || null
    });
    return json({ ok: true, ...result });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

// ---- /interactions wrapper retired ---------------------------------------
//
// Pre-fold-in this function did its own Ed25519 verification against
// the (separate) aquilo-bot app's DISCORD_PUBLIC_KEY. After the
// consolidation, the Loadout entrypoint does ONE verification with
// the unified app's key and then calls `dispatchAquiloInteraction`
// above for any command name in the aquilo set. The verification
// path here was dead and is gone — see commands.js for the live
// dispatch flow.

async function handleAppCommand(data, env, ctx) {
  const cmdName = data.data?.name;
  const userId = data?.member?.user?.id || data?.user?.id;

  // Best-effort presence bookkeeping for every command — drives returning-
  // member DMs + cross-product streak. Never blocks the response.
  if (userId && data.guild_id) {
    ctx.waitUntil(touchSeen(env, data.guild_id, userId));
    ctx.waitUntil(streakTick(env, data.guild_id, userId));
  }

  switch (cmdName) {
    case 'announce':       return handleAnnounceCommand(data, env);
    // /hub was renamed to /aquilo-hub during the fold-in to avoid
    // colliding with Loadout's existing /hub viewer entry point.
    case 'aquilo-hub':     return handleHubCommand(data, env);
    case 'setup':          return handleSetupCommand(data, env);
    case 'suggest':        return handleSuggestCommand(data, env);
    case 'encounter':      return handleEncounterCommand(data, env);
    // v3: cross-product profile + birthdays + Bolts shop.
    case 'passport':
      if (userId && data.guild_id) {
        ctx.waitUntil(maybeWelcome(env, data.guild_id, userId, data.member));
      }
      return handlePassportCommand(data, env);
    case 'birthday':       return handleBirthdayCommand(data, env);
    case 'shop':           return handleShopCommand(data, env);
    // Admin-only authoring commands for trivia + shop.
    case 'trivia-add':
      if (!isAdmin(data)) return ephemeral('Admin only.');
      return { type: 9, data: triviaEditModal().data };
    case 'shop-add':
      if (!isAdmin(data)) return ephemeral('Admin only.');
      return { type: 9, data: shopEditModal().data };
    // Rotation song-pre-queue commands (per-role limits via SR_ROLE_LIMITS_JSON).
    case 'sr-add':         return handleSrAdd(env, data);
    case 'sr-list':        return handleSrList(env, data);
    case 'sr-remove':      return handleSrRemove(env, data);
    case 'sr-clear':       return handleSrClear(env, data);
    // Rotation pre-stream poll with cron-refreshed live tallies.
    case 'rotation-poll':  return handleRotationPoll(env, data);
    // NB: /checkin USED to dispatch here to checkin-slash.js's
    // standalone handler. Consolidated 2026-05 into
    // community-checkin.js (with the GIPHY gif picker rolled in);
    // commands.js now routes /checkin directly there, and this
    // case never fires for the slash command.
    default:               return ephemeral('Unknown command.');
  }
}

async function handleComponent(data, env, ctx) {
  const id = data.data?.custom_id || '';
  const userId = data?.member?.user?.id || data?.user?.id;

  // Best-effort presence bookkeeping on every component click.
  if (userId && data.guild_id) {
    ctx.waitUntil(touchSeen(env, data.guild_id, userId));
    ctx.waitUntil(streakTick(env, data.guild_id, userId));
  }

  if (id.startsWith('vote:'))   return handleVoteClick(env, data);
  if (id.startsWith('queue:')) {
    const guildId = await ensureBootstrap(env);
    return handleQueueButton(env, data, guildId);
  }
  if (id.startsWith('aquilo:'))      return handleHubButton(env, data, ctx);
  if (id.startsWith('notify:'))   return handleNotifyButton(env, data);
  if (id.startsWith('tot:'))      return handleDailyPollVote(env, data);
  if (id.startsWith('sug:'))      return handleSuggestionAction(env, data);
  // Sectioned hub's string-select submits (one per category — pings,
  // colors, regions, platforms, pronouns). Buttons (roles:age18:*
  // and the legacy roles:toggle:*) fall through to handleRoleToggle.
  if (id.startsWith('roles:sel:')) return handleHubSelect(env, data);
  if (id.startsWith('roles:'))     return handleRoleToggle(env, data);
  if (id.startsWith('setup:'))    return handleSetupButton(env, data);
  if (id.startsWith('vh:')) {
    // First viewer-hub click is the natural welcome-ritual trigger for
    // viewers who haven't run a slash command yet.
    if (userId && data.guild_id) {
      ctx.waitUntil(maybeWelcome(env, data.guild_id, userId, data.member));
    }
    return handleViewerHubButton(env, data);
  }
  // v3 buttons.
  if (id.startsWith('passport:')) return handlePassportButton(env, data);
  if (id.startsWith('trivia:'))   return handleTriviaClick(env, data);
  if (id.startsWith('shop:'))     return handleShopBuyClick(env, data);
  if (id.startsWith('ticket:'))   return handleTicketComponent(env, data);
  if (id === 'aqci:search')          return handleCheckinSearchButton();
  if (id.startsWith('aqci:pick:'))   return handleCheckinPickButton(env, data);
  if (id.startsWith('ci2:pick:'))    return handleCheckinPickSubmit(env, data);
  return ephemeral('Unknown button.');
}

// Modal-submit dispatch. Custom_ids are namespaced "modal:<feature>".
async function handleModalSubmit(data, env, ctx) {
  const id = data.data?.custom_id || '';
  if (id === 'modal:game_add')        return handleGameAddSubmit(env, data);
  if (id === 'modal:game_remove')     return handleGameRemoveSubmit(env, data);
  if (id === 'modal:game_set_art')    return handleGameSetArtSubmit(env, data);
  if (id === 'modal:prompts_edit')    return handlePromptsEditSubmit(env, data);
  if (id === 'modal:tot_edit')        return handleDailyPollEditSubmit(env, data);
  if (id === 'modal:self_role_add')   return handleSelfRoleAddSubmit(env, data);
  if (id === 'modal:self_role_remove')return handleSelfRoleRemoveSubmit(env, data);
  if (id === 'modal:setup_channels_a')return handleSetupChannelsASubmit(env, data);
  if (id === 'modal:setup_channels_b')return handleSetupChannelsBSubmit(env, data);
  if (id === 'modal:setup_roles')     return handleSetupRolesSubmit(env, data);
  if (id === 'modal:setup_tuning')    return handleSetupTuningSubmit(env, data);
  if (id === 'modal:setup_advanced')  return handleSetupAdvancedSubmit(env, data);
  // v3 modals.
  if (id === 'modal:trivia_edit')     return handleTriviaEditSubmit(env, data);
  if (id === 'modal:shop_edit')       return handleShopEditSubmit(env, data);
  if (id === 'modal:vh_suggest')      return handleViewerSuggestSubmit(env, data);
  if (id === 'modal:vh_sr_add')       return handleViewerSrAddSubmit(env, data);
  if (id === 'modal:vh_sr_remove')    return handleViewerSrRemoveSubmit(env, data);
  if (id === 'modal:ticket_config')      return handleTicketConfigSubmit(env, data);
  if (id === 'modal:ticket_type_add')    return handleTicketTypeAddSubmit(env, data);
  if (id === 'modal:ticket_type_remove') return handleTicketTypeRemoveSubmit(env, data);
  if (id === 'modal:aqci_search')        return handleCheckinSearchSubmit(env, data);
  if (id === 'modal:ci2_compose')        return handleCheckinComposeSubmit(env, data);
  return ephemeral('Unknown modal: ' + id);
}

async function handleAnnounceCommand(data, env) {
  // STAFF_ROLE_ID is enforced *in addition to* any Discord-level command perms.
  const memberRoles = data.member?.roles || [];
  if (env.STAFF_ROLE_ID && !memberRoles.includes(env.STAFF_ROLE_ID)) {
    return { type: RESP_CHAT, data: { content: 'You don\'t have permission to use this.', flags: FLAG_EPHEMERAL } };
  }
  const opts = parseOpts(data.data?.options);
  try {
    const res = await postAnnouncement(env, {
      product: opts.product, title: opts.title, body: opts.body,
      url: opts.url || null, kind: opts.kind || null, ping: opts.ping ?? false
    });
    return { type: RESP_CHAT, data: { content: 'Posted to <#' + res.channelId + '>.', flags: FLAG_EPHEMERAL } };
  } catch (e) {
    return { type: RESP_CHAT, data: { content: 'Failed: ' + e.message, flags: FLAG_EPHEMERAL } };
  }
}

function parseOpts(options) {
  const out = {};
  if (!Array.isArray(options)) return out;
  for (const o of options) out[o.name] = o.value;
  return out;
}

// ---- Discord REST: post a channel message -------------------------------

async function postAnnouncement(env, { product, title, body, url, kind, ping, channelOverride, roleOverride }) {
  const products = getProducts(env);
  const cfg = products[product];
  if (!cfg) throw new Error('Unknown product: ' + product);
  const channelId = channelOverride || cfg.channel;
  if (!channelId) throw new Error('No channel configured for product: ' + product);
  if (!env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not configured');

  const embed = buildAnnouncementEmbed({ product, title, body, url, kind, productCfg: cfg });
  const roleId = roleOverride || cfg.role_ping;
  const payload = {
    embeds: [embed],
    allowed_mentions: ping && roleId ? { parse: [], roles: [roleId] } : { parse: [] }
  };
  if (ping && roleId) payload.content = '<@&' + roleId + '>';

  const resp = await fetch('https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) + '/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'aquilo-bot-worker (1.0)'
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('Discord ' + resp.status + ': ' + t.slice(0, 300));
  }
  const j = await resp.json();
  return { messageId: j.id, channelId };
}

// ---- helpers ------------------------------------------------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json' }
  });
}
function txt(t, status = 200) {
  return new Response(t, { status, headers: { 'content-type': 'text/plain' } });
}
