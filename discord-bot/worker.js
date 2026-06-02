// Loadout Discord bot - Cloudflare Worker entry point.
//
// Single-tenant Discord application: one bot ("Loadout"), one Public Key,
// many guilds. Streamers don't create their own Discord app anymore —
// they invite our bot and run /loadout-claim with a code minted by their
// Loadout install.
//
// Routes:
//   POST /interactions               - Discord slash command webhook
//   POST /claim                      - Loadout-side: mint a claim code (TTL 10m)
//   GET  /claim/:code/status         - Loadout-side: poll whether the code was claimed
//   POST /sync/:guildId/init         - Loadout-side: complete registration after claim
//   GET  /sync/:guildId              - Loadout-side: pull wallet snapshot (HMAC)
//   POST /sync/:guildId              - Loadout-side: push wallet snapshot (HMAC)
//   GET  /sync/:guildId/games?since= - Loadout-side: pull recent off-stream
//                                      minigame results so the DLL can
//                                      republish them on the local Aquilo
//                                      Bus and the OBS overlay can render
//                                      them (HMAC).
//   GET  /sync/:guildId/profiles?since= - Loadout-side: pull viewer profile
//                                      edits made via /profile-set-* slash
//                                      commands (HMAC).
//   GET  /health                     - liveness probe
//
// KV layout:
//   publickey                        - the (single) Loadout Discord public key (set once at deploy)
//   claim:<code>                     - { secret, mintedUtc, ttlExpiresUtc, claimedGuildId? }
//   secret:<guildId>                 - { secret, registeredUtc, ownerStreamerName }
//   wallet:<guildId>:<userId>        - per-viewer wallet (see wallet.js)
//   guildowner:<guildId>             - { discordUserId, claimedAt } - the claimer
//   games:<guildId>                  - JSON array (cap 32) of recent minigame
//                                      results, 5-min TTL. DLL polls via
//                                      /sync/:guildId/games to republish on
//                                      the local Aquilo Bus.

import { verifyDiscordSignature, verifyHmac } from './auth.js';
import { handleInteraction } from './commands.js';
import { applySnapshot, readSnapshot, getSecret, setSecret, applyVaultDelta, resetAllWallets, leaderboard } from './wallet.js';
import { readSince as readProfilesSince } from './profiles.js';
import { COMMANDS } from './commands-spec.js';
import { handleExt, handleRelay } from './ext.js';

// Aquilo-bot fold-in: re-export the OverlayBroadcaster Durable Object
// class at the entrypoint so wrangler can attach it to the OVERLAY_DO
// binding declared in wrangler.toml. The DO state on Cloudflare lives
// attached to the *script* that declares it, so even though the
// implementation file is under aquilo/, the class needs to surface
// from the top-level Worker entrypoint module.
export { OverlayBroadcaster } from './aquilo/worker.js';
// Community-activity SSE fan-out DO (activity-do.js). Bound as
// ACTIVITY_DO; see wrangler.toml [[migrations]] v2-activity-do.
export { ActivityBroadcaster } from './activity-do.js';

// Discord interaction "claim" command custom handler — defined here rather
// than commands.js because it touches the claim KV and cross-cuts the
// invite flow's state. Returns a Discord interaction response object.
async function handleClaimCommand(env, data) {
  const code = (data?.data?.options?.find(o => o.name === 'code')?.value || '').toUpperCase().trim();
  const guildId = data?.guild_id;
  const member = data?.member;
  const userId = member?.user?.id;

  if (!guildId)
    return { type: 4, data: { content: 'This command must be run in a server.', flags: 64 } };
  if (!code || !/^[A-Z0-9]{4,12}$/.test(code))
    return { type: 4, data: { content: 'Code must be 4-12 alphanumeric characters.', flags: 64 } };

  // Permission check: only members with MANAGE_GUILD (0x20 = 32) can claim.
  // member.permissions is a string of the bitfield in Discord's payload.
  const perms = BigInt(member?.permissions || '0');
  const MANAGE_GUILD = 1n << 5n;
  if ((perms & MANAGE_GUILD) === 0n)
    return { type: 4, data: { content: '🔒 Only server admins (with **Manage Server**) can claim a code.', flags: 64 } };

  // Look up the code. Pop-on-claim: once claimed, the entry is replaced
  // with a usedAt marker and the secret is moved to secret:<guildId>.
  const key = 'claim:' + code;
  const raw = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  if (!raw)
    return { type: 4, data: { content: '❌ That code doesn\'t exist or has expired. Generate a new one in Loadout.', flags: 64 } };
  if (raw.claimedGuildId)
    return { type: 4, data: { content: '⚠️ That code was already claimed.', flags: 64 } };
  if (raw.ttlExpiresUtc && Date.now() > raw.ttlExpiresUtc)
    return { type: 4, data: { content: '⏰ That code expired. Generate a fresh one in Loadout (codes are valid for 10 minutes).', flags: 64 } };

  // Reject if this guild is already claimed (stops a streamer from accidentally
  // overwriting). Re-claiming requires the streamer to first hit "Unlink"
  // in Loadout, which talks to /sync/:guildId/init with the existing secret.
  const existing = await getSecret(env, guildId);
  if (existing?.secret)
    return { type: 4, data: { content: '⚠️ This server is already claimed by another Loadout install. Unlink first if you\'re moving rigs.', flags: 64 } };

  // Bind the code to this guild + persist the secret as the guild's
  // sync key. The Loadout install will poll /claim/:code/status and
  // see the claimedGuildId field flip; that's its signal to mark
  // setup complete.
  const claimed = { ...raw, claimedGuildId: guildId, claimedUtc: Date.now(), claimedByDiscordUserId: userId };
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(claimed), { expirationTtl: 3600 });   // keep 1h for status polls
  await setSecret(env, guildId, raw.secret, raw.ownerName || 'streamer');
  await env.LOADOUT_BOLTS.put('guildowner:' + guildId, JSON.stringify({
    discordUserId: userId,
    claimedAt: Date.now()
  }));

  return {
    type: 4,
    data: {
      content: '✅ **Loadout claimed for this server.**\n' +
               'The streamer can finish setup back in their Loadout window now. Try `/help` to see available commands.'
    }
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && (path === '/' || path === '/health')) {
      return new Response('loadout-discord ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // Public leaderboard for a guild — read-only, no auth. Filters out
    // wallets with no linked public platform so Discord-only users
    // don't get surfaced on the open web.
    if (method === 'GET' && path.startsWith('/leaderboard/')) {
      return handlePublicLeaderboard(req, env, path);
    }

    if (method === 'POST' && path === '/interactions') {
      return handleDiscordInteractions(req, env, ctx);
    }

    // Loadout-side endpoints
    if (method === 'POST' && path === '/claim')                      return mintClaim(req, env);
    if (method === 'GET'  && path.startsWith('/claim/') && path.endsWith('/status')) return claimStatus(req, env, path);
    // Clash sync routes MUST come before the generic /sync/ catch-all
    // below — otherwise handleSync swallows /sync/<g>/clash-events,
    // /sync/<g>/clash, /sync/<g>/clash/build, etc. and serves them as
    // wallet snapshots, silently dropping the DLL's clash-events
    // ring-buffer poll and the web editor's town write-throughs.
    if (method === 'GET' && path.startsWith('/sync/') && path.endsWith('/clash-events')) {
      const { handleClashEventsPull } = await import('./clash-http.js');
      return handleClashEventsPull(req, env, path);
    }
    if (path.startsWith('/sync/') && (path.endsWith('/clash') || path.includes('/clash/'))) {
      const { handleClashSync } = await import('./clash-http.js');
      return handleClashSync(req, env, path);
    }
    if (path.startsWith('/sync/'))                                   return handleSync(req, env, path);
    if (path.startsWith('/tips/'))                                   return handleTip(req, env, path);

    // Aquilo's Vault integration: gated to the guild in env.AQUILO_VAULT_GUILD_ID
    if (method === 'POST' && path === '/credit-bolts')               return handleVaultCredit(req, env);

    // Read-only balance lookup for cross-bot surfaces (FS Bot /wallet,
    // future StreamFusion widget). HMAC-gated with the same
    // X-Aquilo-Vault-Bolts-Secret as /credit-bolts so we don't expose
    // arbitrary wallet shapes on the open web. Guild allow-list also
    // applies — only AQUILO_VAULT_GUILD_ID can be queried.
    if (method === 'GET' && path === '/wallet-balance')              return handleWalletBalanceRead(req, env);

    // aquilo-bot counting game integration. Awards/deducts bolts when a
    // viewer correctly counts (or breaks the chain) in the counting
    // channel. Auth: shared secret in X-Counting-Secret header
    // (set as LOADOUT_BOLT_API_SECRET on both workers).
    if (method === 'POST' && path === '/counting/award-bolts')       return handleCountingAward(req, env);

    // Streak Freeze cross-Worker consume/read. aquilo-bot's Discord
    // pic/gif check-in handler calls these when a streak-break is
    // detected so it can decide whether to protect the streak. HMAC
    // shares the same LOADOUT_BOLT_API_SECRET used by counting.
    if (method === 'POST' && path === '/streak-freeze/consume') {
      const { handleStreakFreezeConsume } = await import('./streak-freeze.js');
      return handleStreakFreezeConsume(req, env);
    }
    if (method === 'GET'  && path === '/streak-freeze/get') {
      const { handleStreakFreezeRead } = await import('./streak-freeze.js');
      return handleStreakFreezeRead(req, env);
    }

    // Public read for the /admin-bound Discord check-in channel. Polled
    // by aquilo-presence (decide which channels to forward) and by
    // aquilo-bot's checkin.js (filter incoming forwarded messages).
    // Unauthed -- channel IDs aren't sensitive and gating would force
    // every poller through a secret-share setup that buys nothing.
    if (method === 'GET' && path.startsWith('/checkin-channel/')) {
      const guildId = path.slice('/checkin-channel/'.length).replace(/\/+$/, '');
      if (!guildId) return new Response('guildId required', { status: 400 });
      const { handleCheckinChannelRead } = await import('./admin-menu.js');
      return handleCheckinChannelRead(env, guildId);
    }

    // Self-register Loadout slash commands using the Worker's bot
    // token secret. HMAC-gated (same scheme as wallet sync). Lets a
    // Loadout install push the latest commands.spec without the
    // streamer needing to paste the bot token into a shell.
    if (method === 'POST' && path.startsWith('/admin/register-commands/')) {
      return handleRegisterCommands(req, env, path);
    }
    // Drop the onboarding welcome embed into a guild text channel
    // from the admin tooling — same HMAC scheme as register-commands,
    // body { channelId?, channelName? }. See onboarding.js for the
    // channel-pick heuristic and the shared poster.
    if (method === 'POST' && path.startsWith('/admin/onboarding/post-embed/')) {
      return handleOnboardingPostEmbed(req, env, path);
    }
    // Heuristically match the guild's existing roles to the six
    // onboarding interest keys and persist the mapping at
    // onboard:role-map:<g>. Body {}. See onboarding.js
    // matchInterestRoles.
    if (method === 'POST' && path.startsWith('/admin/onboarding/setup-roles/')) {
      return handleOnboardingSetupRoles(req, env, path);
    }
    // Create the baseline opt-in interest roles if a guild doesn't
    // already have a role matching each interest's heuristic. Body
    // { roles?: [{ key, name, color?, mentionable?, hoist?,
    //   permissions? }] } — omit `roles` to use BASELINE_ROLE_SPECS.
    // Idempotent — existing matching roles are skipped, not duped.
    if (method === 'POST' && path.startsWith('/admin/onboarding/ensure-roles/')) {
      return handleOnboardingEnsureRoles(req, env, path);
    }
    // Level-tier roles (Apprentice/Veteran/Elite/Mythic) — create
    // the four roles + map them in KV. Idempotent. See
    // level-tier-roles.js for the threshold spec.
    if (method === 'POST' && path.startsWith('/admin/level-tier-roles/ensure/')) {
      return handleLevelTierRolesEnsure(req, env, path);
    }
    // One-time-per-guild backfill: walk every pxp:* record and
    // grant tier roles to anyone who has already crossed the
    // threshold. Idempotent via a KV marker; pass `{ force: true }`
    // to re-scan.
    if (method === 'POST' && path.startsWith('/admin/level-tier-roles/backfill/')) {
      return handleLevelTierRolesBackfill(req, env, path);
    }
    // Streamer.bot webhook for gifter/cheer/tip events. HMAC scheme
    // is verified inside the handler against STREAMERBOT_WEBHOOK_SECRET.
    // See gifter-roles.js for the body schema.
    if (method === 'POST' && path === '/streamerbot/event') {
      const { handleStreamerbotEvent } = await import('./gifter-roles.js');
      return handleStreamerbotEvent(req, env);
    }
    // TikFinity webhook (TikTok-Live gift events). Bearer-style
    // shared secret in X-TikFinity-Secret because TikFinity can
    // attach custom headers but can't sign HMAC. Routes through the
    // same gifter aggregator as the Streamer.bot path. See
    // tikfinity.js for the body schema.
    if (method === 'POST' && path === '/tikfinity/event') {
      const { handleTikFinityEvent } = await import('./tikfinity.js');
      return handleTikFinityEvent(req, env);
    }
    // PrinterBot Discord webhook — Clay's receipt-style image
    // generator posts directly into a dedicated channel. We create
    // a channel-scoped Discord webhook once + persist the URL at
    // printerbot:webhook-url:<g>. See printerbot.js.
    if (method === 'POST' && path.startsWith('/admin/printerbot/setup/')) {
      return handlePrinterBotSetup(req, env, path);
    }
    if (method === 'GET' && path.startsWith('/admin/printerbot/webhook-url/')) {
      return handlePrinterBotWebhookUrl(req, env, path);
    }
    // DESTRUCTIVE — wipes user-facing economy + progression for a guild.
    // Requires body { confirm: "yes-i-mean-it" } so a misfire can't
    // nuke the data. See reset-user-data.js for the wiped/preserved
    // prefix list.
    if (method === 'POST' && path.startsWith('/admin/reset-user-data/')) {
      return handleResetUserData(req, env, path);
    }
    // Counting-channel cleanup. Bulk-deletes bot-authored messages
    // within the optional `?since=<unix>` window (default: no lower
    // bound — capped by Discord's 14-day bulk-delete limit). See
    // counting-purge.js.
    if (method === 'POST' && path.startsWith('/admin/counting/purge-bot-messages/')) {
      return handleCountingPurgeBotMessages(req, env, path);
    }
    // Wipe counting state for a guild back to fresh (current=0,
    // lastUserId=null). Used after the May 2026 bot-loop incident
    // and any other time the chain needs to start over without
    // touching wallets. HMAC-gated like the other counting admins.
    if (method === 'POST' && path.startsWith('/admin/counting/reset/')) {
      return handleCountingReset(req, env, path);
    }
    // Rebuild a channel's rules-list message. Scans recent bot/text
    // messages, deletes the first non-image one (the old rules), and
    // posts the new body. Image-only banner messages stay in place.
    if (method === 'POST' && path.startsWith('/admin/rules/rebuild/')) {
      return handleRulesRebuild(req, env, path);
    }
    // Apply send-message lockdown to a category + child channels +
    // any extra channel ids. Allows the configured roles to post;
    // denies @everyone.
    if (method === 'POST' && path.startsWith('/admin/perms/lockdown/')) {
      return handlePermsLockdown(req, env, path);
    }
    // Post (or replace) a product release-notes embed in a target
    // channel. Tracks the message id at release-notes:<g>:<product>
    // so re-running deletes the prior post first.
    if (method === 'POST' && path.startsWith('/admin/release-notes/post/')) {
      return handleReleaseNotesPost(req, env, path);
    }
    // Provision the 18+ role + category + age-restricted channel
    // (idempotent — reuses any matching role/channel found by name).
    if (method === 'POST' && path.startsWith('/admin/discord/setup-18plus/')) {
      return handleSetup18Plus(req, env, path);
    }
    // Create a locked text channel (post-only by configured roles)
    // under a given category. Used for #community-night-games and
    // similar staff-broadcast channels.
    if (method === 'POST' && path.startsWith('/admin/discord/create-locked-channel/')) {
      return handleCreateLockedChannel(req, env, path);
    }
    // Post (or edit-in-place) the Steam-backed community-night
    // game roster. Optional body { channelId, appIds: [...] };
    // defaults to channel-binding(vote) + cn-games-roster.js
    // DEFAULT_APPIDS.
    if (method === 'POST' && path.startsWith('/admin/cn-roster/post/')) {
      return handleCnRosterPost(req, env, path);
    }
    // Repost (or edit-in-place) the self-roles channel message —
    // picks up D1 self_roles changes AND injects the standalone
    // 18+ self-claim button. Same path the hub button takes, just
    // HMAC-authed so it can be triggered programmatically.
    if (method === 'POST' && path.startsWith('/admin/self-roles/post/')) {
      return handleSelfRolesPost(req, env, path);
    }
    // Sectioned self-roles hub — provision + post. Provision creates
    // the Discord roles for each category (Pings / Name Color /
    // Region / Platform / Pronouns) and stores their IDs in
    // self-roles-hub:roles:<g>. Post lays out one message per
    // category in #roles. See aquilo/self-roles-hub.js.
    if (method === 'POST' && path.startsWith('/admin/self-roles-hub/provision/')) {
      return handleSelfRolesHubProvision(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/self-roles-hub/post/')) {
      return handleSelfRolesHubPost(req, env, path);
    }
    // Generic one-shot embed poster. Useful for ad-hoc admin posts
    // (channel explainer embeds, announcements that don't fit a
    // dedicated endpoint, etc.) without hand-rolling a new route
    // per use case. Body { channelId, embeds: [...], components?,
    // content? } — POST verbatim to the channel as the bot.
    if (method === 'POST' && path.startsWith('/admin/post-embed/')) {
      return handlePostEmbed(req, env, path);
    }
    // Provision the counting-game "I CAN'T COUNT" shame role +
    // (optionally) apply a SEND_MESSAGES channel deny on the
    // counting channel for that role. Idempotent — reuses any
    // existing role with the same name. Stamps the resolved
    // role ID at KV `counting:fail_role_id:<g>` so the counting
    // fail-handler picks it up without a worker redeploy.
    if (method === 'POST' && path.startsWith('/admin/counting/provision-shame-role/')) {
      return handleCountingProvisionShameRole(req, env, path);
    }
    // One-shot test post for the check-in v2 composite renderer
    // (variant C — bg + gif composite). Posts a sample embed to a
    // DM (recipientUserId) or a channel (channelId fallback). Used
    // while CHECKIN_EMBED_V2 is still gated off so Clay can preview
    // the design without enabling it for all users.
    if (method === 'POST' && path.startsWith('/admin/checkin-v2/test-post/')) {
      return handleCheckinV2TestPost(req, env, path);
    }
    // Seed guild:join-counter:<g> from Discord's
    // approximate_member_count so the first observed new member
    // doesn't display "1st member" in a pre-existing guild. See
    // welcome.js backfillJoinCounter.
    if (method === 'POST' && path.startsWith('/admin/welcome/backfill-counter/')) {
      return handleWelcomeBackfillCounter(req, env, path);
    }
    // Swap a section-divider banner in a Discord channel. Designed
    // for the rules / welcome / moderation / invite headers under
    // the v2 brand-refresh. Scans for the most-recent bot/webhook
    // message with an image attachment, deletes it, posts the new
    // image, and stamps the new message id at
    // branding:section-banner:<g>:<key>.
    if (method === 'POST' && path.startsWith('/admin/banner/replace-section/')) {
      return handleBannerReplaceSection(req, env, path);
    }
    // Create the three gifter roles + persist {key: roleId} at
    // gifter-roles:<g>. Idempotent. See gifter-roles.js
    // ensureGifterRoles.
    if (method === 'POST' && path.startsWith('/admin/gifter-roles/ensure/')) {
      return handleGifterRolesEnsure(req, env, path);
    }
    // Scheduled-messages CRUD — admin-authored, fires from the :23
    // hourly cron. Four routes share the same HMAC scheme as the
    // other /admin/* endpoints. See scheduled-messages.js for the
    // record schema + index layout.
    if (path.startsWith('/admin/schedule-msg/')) {
      return handleScheduleMsg(req, env, path, method);
    }
    // Per-guild channel-binding management. Lets Clay rebind the
    // queue / live / recap / clips / lfg channels without
    // redeploying. See channel-bindings.js for the binding keys +
    // env-var fallbacks.
    if (method === 'POST' && path.startsWith('/admin/channels/bind/')) {
      return handleChannelsBind(req, env, path);
    }
    if (method === 'GET' && path.startsWith('/admin/channels/list/')) {
      return handleChannelsList(req, env, path);
    }
    // Persistent LFG hub embed — admin posts it once into the LFG
    // channel; users click buttons instead of typing /lfg. See
    // lfg-hub.js. Mirrors /admin/onboarding/post-embed.
    if (method === 'POST' && path.startsWith('/admin/lfg/post-hub/')) {
      return handleLfgPostHub(req, env, path);
    }
    // Force a fresh schedule embed post / refresh. With the schedule
    // channel binding now KV-driven, this is the simplest way to
    // immediately relocate the embed after a rebind — calls
    // aquilo/aq-schedule.postOrRefreshSchedule which detects the
    // channel-mismatch + handles the delete-old + post-new dance.
    if (method === 'POST' && path.startsWith('/admin/aquilo/refresh-schedule/')) {
      return handleAquiloRefreshSchedule(req, env, path);
    }
    // CN vote-menu hub — persistent embed in the poll-bound channel
    // with vote / standings / queue-join / status buttons. Defers to
    // postCnVoteHubForGuild in cn-vote-hub.js.
    if (method === 'POST' && path.startsWith('/admin/cn-vote/post-hub/')) {
      return handleCnVotePostHub(req, env, path);
    }
    // Unified vote hub (variety + CN, one channel). See vote-hub.js.
    if (method === 'POST' && path.startsWith('/admin/vote-hub/post-hub/')) {
      return handleVoteHubPostHub(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/vote-hub/config/')) {
      return handleVoteHubConfig(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/vote-hub/retire-legacy/')) {
      return handleVoteHubRetireLegacy(req, env, path);
    }
    // Aquilo's Vault — webhook for game events from FS-Bot (Railway)
    // + admin endpoint to (re)post the actions hub.
    if (method === 'POST' && path === '/vault/event') {
      const { handleVaultEventWebhook } = await import('./vault-hub.js');
      return handleVaultEventWebhook(req, env);
    }
    if (method === 'POST' && path.startsWith('/admin/vault/post-actions/')) {
      return handleVaultPostActions(req, env, path);
    }
    // CN games-list catalogue. Multi-embed listing of every active
    // CN game with art + Steam links. See cn-games-list-hub.js.
    if (method === 'POST' && path.startsWith('/admin/cn-games-list/post-hub/')) {
      return handleCnGamesListPostHub(req, env, path);
    }
    // Phase-1 channel hubs — one route, key in the path. See
    // channel-hubs.js for the catalogue + HUB_KEYS.
    if (method === 'POST' && path.startsWith('/admin/hubs/post/')) {
      return handleChannelHubPost(req, env, path);
    }
    // Twitch EventSub webhook. Signature is verified inside the
    // handler against env.TWITCH_EVENTSUB_SECRET. Three message
    // types: webhook_callback_verification (challenge handshake),
    // notification (real event — dispatch to twitch-live.js),
    // revocation (log + ack). See twitch-eventsub.js.
    if (method === 'POST' && path === '/twitch/eventsub') {
      const { handleEventSubWebhook } = await import('./twitch-eventsub.js');
      return handleEventSubWebhook(req, env, ctx);
    }
    // Admin-side EventSub subscription manager. HMAC-gated. Creates
    // stream.online + stream.offline subs for Clay's broadcaster id
    // pointing at THIS worker's /twitch/eventsub URL. Idempotent —
    // skips subs that already exist.
    if (method === 'POST' && path.startsWith('/admin/twitch-setup/')) {
      return handleTwitchSetup(req, env, path);
    }
    // Self-serve Twitch OAuth — bootstrap-token-gated start URL Clay
    // clicks once, Twitch redirects back to /admin/twitch-oauth/callback,
    // refresh token lands in KV, EventSub subs auto-provision. The
    // start URL is mintable via `wrangler kv key put bootstrap-twitch-oauth-token <value>`.
    if (method === 'GET' && path.startsWith('/admin/_twitch-oauth-start/')) {
      const token = path.split('/').filter(Boolean)[2];
      const { handleTwitchOauthStart } = await import('./twitch-oauth.js');
      return handleTwitchOauthStart(req, env, token);
    }
    if (method === 'GET' && path === '/admin/twitch-oauth/callback') {
      const { handleTwitchOauthCallback } = await import('./twitch-oauth.js');
      return handleTwitchOauthCallback(req, env);
    }
    // Global Boltbound card-art defaults — bulk-set used by the
    // backfill script. KV-token-gated so the local script can call
    // without HMAC signing. Same one-shot consumption pattern as
    // _clay-batch / _rewards-bootstrap. Self-destructs on first hit.
    if (method === 'POST' && path.startsWith('/admin/_card-art-bulk-set/')) {
      return handleCardArtBulkSetBootstrap(req, env, path);
    }
    // Iterating slice of the Giphy backfill — operator calls this in
    // a curl loop with ?offset=N&limit=K. KV-token NOT consumed per
    // call (so the loop can drive many requests); the operator
    // deletes the token after they're done. The token-vs-empty check
    // is the only gate on this endpoint.
    if (method === 'POST' && path.startsWith('/admin/_card-art-backfill/')) {
      return handleCardArtBackfillSlice(req, env, path);
    }
    // Backup every global-card-art:* entry to
    // global-card-art-backup-gifs-<date>:* before the pixel-art
    // overhaul overwrites them. KV-token NOT consumed (re-runnable
    // if interrupted). Skip-if-backup-already-exists keeps it
    // idempotent. Returns { copied, skipped, total }.
    if (method === 'POST' && path.startsWith('/admin/_card-art-backup/')) {
      return handleCardArtBackup(req, env, path);
    }
    // 2026-05-29: Clay went all-in on pixel art, axing the Giphy
    // backfill as the default render layer. This endpoint wipes the
    // entire global-card-art:* prefix in one call. The dated backup
    // (global-card-art-backup-gifs-2026-05-29:*) is left intact so
    // the audit trail survives. Token NOT self-destructed — repeats
    // are idempotent (a second run hits an empty prefix and reports 0).
    if (method === 'POST' && path.startsWith('/admin/_card-art-wipe/')) {
      return handleCardArtWipe(req, env, path);
    }
    // Diagnostic: validate the stored Twitch user token. Returns the
    // login + user_id + actual granted scopes. Use when EventSub
    // create fails with `twitch-error 401` to confirm scope coverage.
    if ((method === 'POST' || method === 'GET') &&
        path.startsWith('/admin/_twitch-token-validate/')) {
      return handleTwitchTokenValidate(req, env, path);
    }
    // Diagnostic: run setupTwitchSubscriptions with debug error
    // surfacing. Same as twitch-setup but token-gated so I can fire
    // it without HMAC during diagnosis.
    if (method === 'POST' && path.startsWith('/admin/_twitch-setup-debug/')) {
      return handleTwitchSetupDebug(req, env, path);
    }
    // Post the backfill summary embed to the admin hub channel.
    // KV-token gated, self-destructing — Clay re-mints when he wants
    // a fresh snapshot.
    if (method === 'POST' && path.startsWith('/admin/_card-art-summary/')) {
      return handleCardArtSummaryBootstrap(req, env, path);
    }
    // List every global card-art default — used by the run-summary
    // step + Clay's spot-check. HMAC-gated.
    if (method === 'GET' && path === '/admin/card-art/list') {
      return handleCardArtList(req, env);
    }
    // Single-card global set/clear — used by /admin card-art remix.
    if (method === 'POST' && path === '/admin/card-art/set') {
      return handleCardArtSet(req, env);
    }
    if (method === 'POST' && path === '/admin/card-art/clear') {
      return handleCardArtClear(req, env);
    }
    // Post or refresh the pinned Games-Menu message in #games
    // (channel defaults to 1507973935973531808 for the Aquilo guild,
    // can be overridden via body {channelId}). Idempotent — uses
    // games-menu:msg:<gid> KV to PATCH the existing pin.
    if (method === 'POST' && path.startsWith('/admin/games-menu/post/')) {
      return handleGamesMenuPost(req, env, path);
    }
    // Custom-poll lifecycle — see custom-polls.js for the model.
    // /admin/polls/launch         posts the two pre-defined Triple-C
    //                              + Variety polls (Clay 2026-05-28).
    // /admin/polls/close/:pollId  force-closes a poll regardless of
    //                              its closeAt (testing / early call).
    if (method === 'POST' && path === '/admin/polls/launch') {
      return handlePollsLaunch(req, env);
    }
    // One-shot KV-token-gated launch — used by operator scripts that
    // don't have HMAC signing capability. Set the matching token in
    // KV (`bootstrap-poll-launch-token`) via wrangler kv key put +
    // call this URL. Self-destructs on success so it can't be replayed.
    if (method === 'POST' && path.startsWith('/admin/_poll-launch/')) {
      return handlePollsLaunchBootstrap(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/polls/close/')) {
      return handlePollsForceClose(req, env, path);
    }
    // One-shot — scan the guild for members currently holding the
    // I CAN'T COUNT shame role + remove. Used to clean up users whose
    // expiry KV entry was lost to the pre-2026-05-28 silent-drop
    // sweep bug. Idempotent: re-running on a clean guild scans +
    // removes nothing.
    if (method === 'POST' && path.startsWith('/admin/counting/clear-shame-role/')) {
      return handleCountingClearShameRole(req, env, path);
    }
    // MC whitelist gating removed 2026-05-31 (Clay dropped Minecraft as
    // a featured offering). One remaining one-shot, KV-token-gated
    // endpoint deletes the "Minecraft Whitelist" Discord role + clears
    // its KV id. Token written via `wrangler kv key put
    // bootstrap-mc-role-delete-token <value>`; self-destructs on use.
    if (method === 'POST' && path.startsWith('/admin/_mc-role-delete/')) {
      return handleMcRoleDelete(req, env, path);
    }
    // Twitch reward roles — provision Twitch Sub / T2 / T3 roles +
    // store ids at twitch-rewards:role:<gid>:<tier>. Idempotent.
    if (method === 'POST' && path.startsWith('/admin/twitch-rewards/ensure-roles/')) {
      return handleTwitchRewardsEnsureRoles(req, env, path);
    }
    // One-shot KV-token-gated bootstrap — creates the #rewards
    // channel, binds twitch-rewards-feed to it, AND provisions the
    // three sub-tier roles in a single shot. Used to fire the
    // rewards feature live without needing HMAC signing in the
    // operator shell. Self-destructs on success.
    if (method === 'POST' && path.startsWith('/admin/_rewards-bootstrap/')) {
      return handleRewardsBootstrap(req, env, path);
    }
    // Support tickets — post or refresh the persistent embed in
    // the configured #support channel. Idempotent: PATCHes via the
    // support-tickets:panel:<gid> KV pointer, falls back to a
    // fresh post + pin if the prior message was deleted.
    if (method === 'POST' && path.startsWith('/admin/support-tickets/post-panel/')) {
      return handleSupportTicketsPostPanel(req, env, path);
    }
    // KV-token operator helper for posting the panel without HMAC.
    if (method === 'POST' && path.startsWith('/admin/_mc-howto-post/')) {
      return handleMcHowtoBootstrap(req, env, path);
    }
    // Public read for mc-howto images backing the join-the-MC-server
    // embed. KV-backed, year-long cache, mirrors the twitch-banner
    // asset pattern. Slugs are: server-logo, verify-msg, dm-screenshot.
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/asset/mc-howto/')) {
      return handleMcHowtoAsset(req, env, path);
    }
    // Hero background pixel-art scenes (Phase A.5). KV-backed,
    // year-long cache. URLs at /asset/hero-bg/<id>.png from
    // pixel-art-hero-bg:<id>.
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/asset/hero-bg/')) {
      return handleHeroBgAsset(req, env, path);
    }
    // Spire art (2026-05-29 sprint) — 12 themes × (boss + backdrop + 9 NPCs).
    // KV keys: pixel-art-spire-{boss,backdrop,npc}:<theme>[:<role>]
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/asset/spire-art/')) {
      return handleSpireAsset(req, env, path);
    }
    // Phase B character customization layers — hair (sex+style),
    // eyes (style only), facial (style only). KV-backed, year-long
    // cache. Composite manifest points renderers at these.
    if ((method === 'GET' || method === 'HEAD') && (
      path.startsWith('/asset/hero-hair/') ||
      path.startsWith('/asset/hero-eyes/') ||
      path.startsWith('/asset/hero-facial/')
    )) {
      return handleHeroCustomLayerAsset(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/_support-panel-post/')) {
      return handleSupportPanelBootstrap(req, env, path);
    }
    // One-shot KV-token-gated post: Patreon gift embed + link button
    // in a target channel. Idempotent — KV pointer + title-match
    // fallback. Self-destructs on success.
    if (method === 'POST' && path.startsWith('/admin/_gift-embed-post/')) {
      return handleGiftEmbedPost(req, env, path);
    }
    // One-shot KV-token-gated batch — runs the four "Clay would
    // otherwise have to fire by hand" admin actions in sequence:
    // self-roles-hub provision, games-menu post, mc-whitelist
    // ensure-role, slash-command re-register. Self-destructs.
    if (method === 'POST' && path.startsWith('/admin/_clay-batch/')) {
      return handleClayBatch(req, env, path);
    }
    // Diagnostic — dumps the current Twitch-side EventSub
    // subscriptions for the configured app token. HMAC-gated like
    // /admin/twitch-setup so Clay can call from the site admin or
    // a wrangler-secret-aware operator script.
    if (method === 'POST' && path.startsWith('/admin/twitch-eventsub/list/')) {
      return handleTwitchEventsubList(req, env, path);
    }
    // Public asset route — Twitch event embed gradient banners. PNGs
    // live in LOADOUT_BOLTS under keys `twitch-banner:<type>`,
    // uploaded once via `wrangler kv key put --path`. Served with a
    // year-long immutable cache so Discord's CDN warms once and
    // never refetches. HEAD supported (some crawlers/HEAD-probe
    // their cache before the embed-preview GET).
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/asset/twitch-banner/')) {
      return handleTwitchBannerAsset(req, env, path);
    }
    // Boltbound v9 pixel-art card asset route. KV-backed (storage
    // option chosen 2026-05-29 — R2 would have been faster-serving
    // but ships slower; this gets pixel art live today). One key per
    // card: `pixel-art-card:<cardId>` → raw PNG bytes. The site
    // renderer looks up via globalArt map (cards-global-art.js), so
    // this URL is what the global record points at.
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/asset/card-art/')) {
      return handleCardArtAsset(req, env, path);
    }
    // Generic pixel-art asset routes — heroes, gear, clash buildings/
    // units, pets. All share the same KV-backed pattern as card-art:
    //   /asset/hero-art/<classId>.png      -> pixel-art-hero:<classId>
    //   /asset/gear-art/<slot>/<name>/<rarity>.png
    //                                       -> pixel-art-gear:<slot>:<name>:<rarity>
    //   /asset/clash-art/buildings/<kind>/<level>.png
    //                                       -> pixel-art-clash:buildings:<kind>:<level>
    //   /asset/clash-art/units/<id>.png    -> pixel-art-clash:units:<id>
    //   /asset/pet-art/<petId>.png         -> pixel-art-pet:<petId>
    if ((method === 'GET' || method === 'HEAD') && (
      path.startsWith('/asset/hero-art/') ||
      path.startsWith('/asset/gear-art/') ||
      path.startsWith('/asset/clash-art/') ||
      path.startsWith('/asset/pet-art/') ||
      path.startsWith('/asset/boltbound-ui/') ||
      path.startsWith('/asset/cardback/') ||
      path.startsWith('/asset/pack/') ||
      path.startsWith('/asset/hero-body/') ||
      path.startsWith('/asset/spire-boss/') ||
      path.startsWith('/asset/spire-map/') ||
      path.startsWith('/asset/vault/')
    )) {
      return handlePixelArtAsset(req, env, path);
    }
    // Poll composite art (see custom-polls.js). PNGs live in
    // LOADOUT_BOLTS under `poll-composite:<id>`, generated by
    // build-poll-composite.py. Same cache+HEAD model as the twitch
    // banner route. The `?v=N` cache-buster lets us refresh art
    // when a composite is re-rendered.
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/asset/poll-composite/')) {
      return handlePollCompositeAsset(req, env, path);
    }
    // Boltbound match FX (damage numbers, beams, particles). Served
    // straight off pixel-art-boltbound:fx:<name> — the .png suffix is
    // kept in the key (unlike the stripping pixel-art route) so it
    // matches the upload convention. e.g.
    //   /asset/boltbound-fx/damage-numbers-sheet.png
    //     -> pixel-art-boltbound:fx:damage-numbers-sheet.png
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/asset/boltbound-fx/')) {
      return handleBoltboundFxAsset(req, env, path);
    }
    // Boltbound arena environment assets (stone-arena bg, medallion
    // frames, lane-slot, critters, fog/ember overlays). Served off
    // pixel-art-overlays:boltbound-arena:<name>. Short cache (active
    // aesthetic build, re-arted in place).
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/asset/boltbound-arena/')) {
      return handleBoltboundArenaAsset(req, env, path);
    }
    // Streamer Watchtower — public live-stats JSON for an OBS Browser
    // Source. CORS-open, 5s-cached. GET /watchtower/stream/:channel
    // (channel = login | numeric id | 'me' for Clay's channel).
    if (path.startsWith('/watchtower/stream/')) {
      return handleWatchtower(req, env, path);
    }
    // Community-activity SSE feed (activity-do.js). GET /activity/sse is
    // the public EventSource stream; POST /activity/publish is the
    // internal HMAC-gated producer endpoint (also reachable in-process
    // via publishActivity()).
    if (path === '/activity/sse' || path === '/activity/publish') {
      return handleActivityStream(req, env, path);
    }
    // Triple-C current campaign + pool — public, CORS-open (site's
    // StreamSchedule + admin dropdown). Owner-gated `set` is at
    // POST /web/admin/triple-c/set.
    if (path === '/triple-c/current' || path === '/triple-c/pool') {
      return handleTripleCPublic(req, env, path);
    }
    // Dad Game Sunday current game + pool — public, CORS-open (mirrors
    // Triple-C). Owner-gated `set` is at POST /web/admin/dad-sunday/set.
    if (path === '/dad-sunday/current' || path === '/dad-sunday/pool') {
      return handleDadSundayPublic(req, env, path);
    }
    if (path === '/vote-hub/lineup') {
      return handleLineupPublic(req, env);
    }
    if (method === 'POST' && path.startsWith('/admin/list-commands/')) {
      return handleListCommands(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/guild-inventory/')) {
      return handleGuildInventory(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/guild-build/')) {
      return handleGuildBuild(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/guild-finalize/')) {
      return handleGuildFinalize(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/guild-automod/')) {
      return handleGuildAutomod(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/ticket-panel/')) {
      return handleTicketPanelPost(req, env, path);
    }
    // One-shot L8 deploy bootstrap. Token-gated via a KV-stored secret
    // (`bootstrap-l8-token`) written by the operator immediately before
    // calling this endpoint. The KV entry self-destructs on first
    // successful use, so the endpoint is harmless without it. Does:
    //   1. PUT slash commands (global + per-guild)
    //   2. Post the ticket panel into 🛠️│support (looked up by name)
    //   3. Backfill guild:cfg.ids with ch_introductions (looked up
    //      by name) — vc_join_to_create + cat_voice already present.
    if (method === 'POST' && path.startsWith('/admin/_bootstrap-l8/')) {
      return handleBootstrapL8(req, env, path);
    }
    // L9 phase-2: create missing channels, bind feature slots,
    // bind commands → channels, post the current schedule. Same
    // one-shot KV-token gate as the L8 bootstrap. See handler for
    // full action list.
    if (method === 'POST' && path.startsWith('/admin/_phase2/')) {
      return handlePhase2(req, env, path);
    }
    // L10 phase-3: create the self-promo channel if missing + post the
    // stylized rules embed above the existing verify button in
    // 🫡│rules. Same one-shot KV-token gate.
    if (method === 'POST' && path.startsWith('/admin/_phase3-rules/')) {
      return handlePhase3Rules(req, env, path);
    }
    // L10 chat-test: drive sendFromPwa with explicit args + return
    // the diagnostic so we can verify the end-to-end webhook flow
    // without needing a real PWA caller. Same token-gate.
    if (method === 'POST' && path.startsWith('/admin/_chat-test/')) {
      return handleChatTest(req, env, path);
    }
    // L10 phase-4: audit + repair category/channel permissions. Each
    // category gets the intended overwrite profile (open / member /
    // patron / staff); every child channel is then synced to its
    // category (overwrites match parent), with extra read-only on
    // announce/rules/feed-style channels. Same one-shot KV-token gate.
    if (method === 'POST' && path.startsWith('/admin/_phase4-perms/')) {
      return handlePhase4Perms(req, env, path);
    }
    // Trace the linked-patreon completion check for a specific user:
    // dumps every signal the worker considers + the snapshot result +
    // the claim outcome. Token-gated, single-use. Lets us prove
    // end-to-end that Clay's user can both see the step as claimable
    // AND successfully claim.
    if (method === 'POST' && path.startsWith('/admin/_quest-trace/')) {
      return handleQuestTrace(req, env, path);
    }
    // Aquilo's Vault — one-shot guild setup: create the Vault Dweller /
    // Overseer / Crisis Responder roles, the Vault category, and the
    // #vault-status / #vault-crises / #vault-overseer channels, persisting
    // ids to guild:cfg. Token-gated (KV `vault-setup-token`). Idempotent
    // (matches existing roles/channels by name) so re-runs are safe.
    if (method === 'POST' && path.startsWith('/admin/vault/setup/')) {
      return handleVaultSetup(req, env, path);
    }

    // Twitch panel extension backend — additive, JWT- + channel-gated.
    // Public read-only stocks snapshot for the aquilo.gg /stocks page +
    // the Twitch panel's read-only Stocks tab. No auth gate — returns
    // catalog + prices + sparkline history slices.
    if (method === 'GET' && path === '/stocks/public') {
      const { publicStocksSnapshot } = await import('./stocks.js');
      return publicStocksSnapshot(env);
    }
    // Public read-only sports snapshot for the panel's Sports tab — the
    // 48h upcoming-games slice with optional moneyline odds.
    if (method === 'GET' && path === '/sports/public') {
      const { publicSportsSnapshot } = await import('./bet.js');
      return publicSportsSnapshot(env);
    }

    // Public read-only schedule snapshot for aquilo.gg + (later) the
    // panel's Schedule tab. Composes schedule:v1 + games:v1 +
    // channel:vote:guild and computes nextStream + voteActive. See
    // SCHEDULE-SYSTEM-DESIGN.md Phase 2.
    if (method === 'GET' && path === '/schedule/public') {
      const { handlePublicScheduleHttp } = await import('./schedule.js');
      return handlePublicScheduleHttp(env);
    }
    if (method === 'GET' && path === '/games/public') {
      const { handlePublicGamesHttp } = await import('./schedule.js');
      return handlePublicGamesHttp(env);
    }
    // Public canonical aquilo schedule — same data the Discord
    // schedule embed renders from, served as JSON for the
    // aquilo.gg /schedule page. Edge-cached 30s. See
    // aquilo/aq-schedule.js getPublicSchedule for the response
    // shape contract.
    if (method === 'GET' && path.startsWith('/aquilo/schedule/public/')) {
      const guildId = path.slice('/aquilo/schedule/public/'.length).replace(/\/+$/, '');
      const { getPublicSchedule } = await import('./aquilo/aq-schedule.js');
      const data = await getPublicSchedule(env, guildId);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=0, s-maxage=30',
          'access-control-allow-origin': '*',
        },
      });
    }
    // Public read-only queue snapshot for aquilo.gg /community page +
    // the panel's Schedule tab. No auth -- counts only, no joiner
    // names. See queue.js + SCHEDULE-SYSTEM-DESIGN.md Phase 3.
    if (method === 'GET' && path === '/queues/public') {
      const { snapshotQueue } = await import('./queue.js');
      const guildId = env.AQUILO_VAULT_GUILD_ID;
      if (!env.LOADOUT_BOLTS || !guildId) {
        return new Response(JSON.stringify({ error: 'not-configured' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }
      const url2 = new URL(req.url);
      const date = url2.searchParams.get('date');
      const snap = await snapshotQueue(env, guildId, date);
      return new Response(JSON.stringify({ ok: true, ...snap }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=0, s-maxage=10',
          'access-control-allow-origin': '*',
        },
      });
    }

    if (path.startsWith('/ext/')) return handleExt(req, env, ctx);

    // Public read-only starboard wall for aquilo.gg /community/. Same
    // public-read shape as /stocks/public + /queues/public — no
    // auth, edge-cacheable. Path sits under /web/ for parity with the
    // site's other /api/* proxy paths, but is claimed BEFORE the
    // /web/* HMAC dispatcher below since it's a public read.
    //
    // Response shape (matches the aquilo-site wall consumer):
    //   {
    //     ok: true,
    //     items: [{
    //       messageId, authorName, authorAvatarUrl?, content,
    //       attachments?, starCount, originalUrl?, ts
    //     }, ...]
    //   }
    //
    // Source: KV ringbuffer fed by handleStarboardReaction once a
    // message crosses STARBOARD_THRESHOLD. See guild-features.js.
    // Guild defaults to AQUILO_VAULT_GUILD_ID; ?guildId=<id> overrides.
    if (method === 'GET' && path === '/web/starboard/recent') {
      const { readStarboardRecent } = await import('./guild-features.js');
      const url2 = new URL(req.url);
      const guildId = url2.searchParams.get('guildId') || env.AQUILO_VAULT_GUILD_ID;
      const limit = url2.searchParams.get('limit') || '25';
      if (!env.LOADOUT_BOLTS || !guildId) {
        return new Response(JSON.stringify({ ok: false, error: 'not-configured', items: [] }), {
          status: 503,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        });
      }
      const r = await readStarboardRecent(env, guildId, limit);
      return new Response(JSON.stringify(r), {
        status: r.ok ? 200 : 404,
        headers: {
          'content-type': 'application/json',
          // 30s edge cache + a fresh wall feels live without
          // hammering KV on every viewer pageload.
          'cache-control': 'public, max-age=0, s-maxage=30',
          'access-control-allow-origin': '*',
        },
      });
    }

    // Progression (P2) routes — public reads, claimed BEFORE the
    // generic /web/* dispatcher below (which is HMAC-gated and would
    // reject public reads). /p/season/* must be matched FIRST since
    // it's a sub-path of /p/* and the userId-shaped path below would
    // otherwise treat "season" as a userId.
    if (method === 'GET' && path.startsWith('/p/season')) {
      const { handlePublicSeason } = await import('./progression/http.js');
      return handlePublicSeason(req, env, path);
    }
    if (method === 'GET' && path.startsWith('/p/')) {
      const { handleProfilePage } = await import('./progression/http.js');
      return handleProfilePage(req, env, path);
    }
    // P5 — account-link OAuth/OpenID flows. These live under
    // /web/profile/link/ specifically so the more-generic profile
    // dispatcher below doesn't intercept the redirect callbacks.
    if (path.startsWith('/web/profile/link/')) {
      const { handleWebProfileLink } = await import('./progression/http.js');
      return handleWebProfileLink(req, env, path);
    }
    if (path.startsWith('/web/profile/')) {
      const { handleWebProfile } = await import('./progression/http.js');
      return handleWebProfile(req, env, path);
    }
    if (path.startsWith('/web/xp/')) {
      const { handleWebXp } = await import('./progression/http.js');
      return handleWebXp(req, env, path);
    }
    if (path.startsWith('/web/achievements/')) {
      const { handleWebAchievements } = await import('./progression/http.js');
      return handleWebAchievements(req, env, path);
    }
    if (path.startsWith('/web/badges/')) {
      const { handleWebBadges } = await import('./progression/http.js');
      return handleWebBadges(req, env, path);
    }
    // (season public read is dispatched up top under /p/season — see
    // line 245. Claim POST is routed via the HMAC-gated /web/* path
    // → /web/season/claim in web.js.)
    if (path.startsWith('/web/tournaments')) {
      const { handleWebTournaments } = await import('./progression/http.js');
      return handleWebTournaments(req, env, path);
    }
    if (path === '/web/progression/dashboard') {
      const { handleWebDashboard } = await import('./progression/http.js');
      return handleWebDashboard(req, env, path);
    }

    // ── B-batch: community + LFG + DM fan-out + voice ───────────────
    // All HMAC-gated against AQUILO_SITE_WEB_SECRET (the same secret
    // the existing /web/* surface uses). Aquilo-site's Pages Functions
    // bridge to these. Ordered BEFORE the generic /web/ dispatcher so
    // public-GET endpoints don't get gated by web.js's method check.

    // B1 — Username
    if (path.startsWith('/web/community/username')) {
      const { handleUsername } = await import('./community.js');
      return handleUsername(req, env, path);
    }
    // B2 — Gamertags
    if (path.startsWith('/web/gamertags/')) {
      const { handleGamertags } = await import('./community.js');
      return handleGamertags(req, env, path);
    }
    // B3 — Guild channels
    if (path.startsWith('/web/guild/') && path.endsWith('/channels')) {
      const { handleGuildChannels } = await import('./community.js');
      return handleGuildChannels(req, env, path);
    }
    // B4 — Members list
    if (path === '/web/community/members') {
      const { handleMembers } = await import('./community.js');
      return handleMembers(req, env, path);
    }
    // Public supporter wall (B1 integration — username field surfaces here)
    if (path === '/community/supporters' && method === 'GET') {
      const { handleSupporterWall } = await import('./community.js');
      return handleSupporterWall(req, env, path);
    }
    // B5 — LFG
    if (path.startsWith('/web/lfg')) {
      const { handleLfgRoute } = await import('./lfg.js');
      return handleLfgRoute(req, env, path);
    }
    // B6 — Discord-DM fan-out
    if (path === '/push/dm') {
      const { handlePushDm } = await import('./push-dm.js');
      return handlePushDm(req, env);
    }
    // F1 — Friends system (HMAC-gated writes, public GETs)
    if (path.startsWith('/web/friends/') || path === '/web/friends') {
      const { handleFriendsRoute } = await import('./friends.js');
      return handleFriendsRoute(req, env, path);
    }
    // Daily Quests — cross-game rotating quest set (HMAC-gated writes,
    // public GET for today's rotation). See daily-quests.js.
    if (path.startsWith('/web/quests/')) {
      const { handleQuestsRoute } = await import('./daily-quests.js');
      return handleQuestsRoute(req, env, path);
    }
    // Trash-talk emotes — per-match emote ring buffer + rate limit.
    // POST is HMAC-gated; GET feed is public. See boltbound-emotes.js.
    if (path === '/web/boltbound/emote' || path.startsWith('/web/boltbound/emote/feed/')) {
      const { handleEmoteRoute } = await import('./boltbound-emotes.js');
      return handleEmoteRoute(req, env, path);
    }
    // Replay reactions + comments — extends the existing Boltbound
    // replays surface with a social layer. See boltbound-replays-rx.js.
    if (path.startsWith('/web/boltbound/replays/') && (
        path.endsWith('/react') || path.endsWith('/comment') ||
        path.endsWith('/reactions') || path.endsWith('/comments'))) {
      const { handleReplayRxRoute } = await import('./boltbound-replays-rx.js');
      return handleReplayRxRoute(req, env, path);
    }
    // Twitch Drops — per-viewer cumulative watch-time + milestone
    // claims. handleDropsRoute dispatches both GET /me and POST /claim
    // by method+path. See twitch-drops.js.
    if (path === '/web/twitch-drops/me' || path === '/web/twitch-drops/claim') {
      const { handleDropsRoute } = await import('./twitch-drops.js');
      return handleDropsRoute(req, env, path);
    }
    // Pet leveling / abilities / evolutions — extends the existing
    // pet schema with level/xp/abilities. 4 endpoints dispatched by
    // handlePetLevelingRoute: GET /level/:petId, GET /abilities/:petId,
    // POST /evolve, POST /xp. See pet-leveling.js.
    if (path.startsWith('/web/pet/level/') ||
        path.startsWith('/web/pet/abilities/') ||
        path === '/web/pet/evolve' || path === '/web/pet/xp') {
      const { handlePetLevelingRoute } = await import('./pet-leveling.js');
      return handlePetLevelingRoute(req, env, path);
    }
    // Spire Maps — Slay-the-Spire branching path layer per run.
    // 4 endpoints dispatched by handleSpireMapRoute: POST /generate,
    // GET /me/:runId, POST /advance, POST /resolve. See spire-map.js.
    if (path.startsWith('/web/spire-map/')) {
      const { handleSpireMapRoute } = await import('./spire-map.js');
      return handleSpireMapRoute(req, env, path);
    }
    // Anniversary celebrations — public GET /me/<g>/<u> for the
    // firstSeen + anniversary-today view; POST /celebrate HMAC-gated
    // to claim the per-year reward (cron handles the announcement
    // post automatically). See anniversary.js.
    if (path.startsWith('/web/anniversary/')) {
      const { handleAnniversaryRoute } = await import('./anniversary.js');
      return handleAnniversaryRoute(req, env, path);
    }
    // F3 — Community activity feed (public GET)
    if (path === '/community/feed') {
      const { handleCommunityFeedRoute } = await import('./activity-feed.js');
      return handleCommunityFeedRoute(req, env);
    }
    // G2 — Weekly community challenge (public GET)
    if (path === '/community/challenge' || path === '/community/challenge/history') {
      const { handleChallengeRoute } = await import('./challenges.js');
      return handleChallengeRoute(req, env, path);
    }

    // aquilo.gg website minigames -- HMAC from the site's Pages
    // Functions, signed with AQUILO_SITE_WEB_SECRET. See web.js +
    // MINIGAMES-WEB-DESIGN.md.
    // Death counter — its own token-auth subsystem (Stream Deck button
    // + OBS overlay). Must be claimed BEFORE the generic /web router so
    // the public GET reads + token-gated writes bypass the site HMAC.
    // See death-counter.js.
    if (path.startsWith('/web/death-count/') || path.startsWith('/web/admin/death-count/')) {
      const { handleDeathCount } = await import('./death-counter.js');
      return handleDeathCount(req, env, path);
    }

    // Twitch panel scratch-off cards — its own token/secret-auth subsystem
    // (Twitch panel + on-stream relay). Claimed BEFORE the generic /web
    // router so public reads + gated writes bypass the site HMAC. The
    // bit-purchase webhook is gated on SCRATCH_WEBHOOK_SECRET; admin writes
    // on SCRATCH_ADMIN_TOKEN/STREAMDECK_TOKEN. See scratch-off.js.
    if (path.startsWith('/web/scratch/') ||
        path.startsWith('/web/admin/scratch/') ||
        path === '/web/twitch/bit-purchase-webhook') {
      const { handleScratch } = await import('./scratch-off.js');
      return handleScratch(req, env, path);
    }

    // Aquilo's Vault — public cross-section snapshot for the /play/vault
    // viewer + on-stream overlay. Claimed BEFORE the generic /web router
    // so this GET bypasses the site HMAC (read-only, CORS-open, short
    // cache). Mutations go through the HMAC-gated POST /web/vault/*
    // routes in web.js. See vault-community.js.
    if ((method === 'GET' || method === 'HEAD') && path === '/web/vault/state') {
      const guild = url.searchParams.get('guild') || env.AQUILO_VAULT_GUILD_ID;
      let snap;
      try {
        const { snapshot } = await import('./vault-community.js');
        snap = await snapshot(env, guild);
      } catch (e) {
        snap = { ok: false, error: String(e?.message || e) };
      }
      const headers = {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=5',
        'access-control-allow-origin': '*',
      };
      if (method === 'HEAD') return new Response(null, { status: snap.ok ? 200 : 500, headers });
      return new Response(JSON.stringify(snap), { status: snap.ok ? 200 : 500, headers });
    }

    // PvP duels — viewer-vs-viewer D20 hero battles. Self-routing module owns
    // its HMAC gate (challenge/accept/decline/bet/spectator-pick are POST,
    // HMAC-signed) plus public GET reads (battle/queue/snapshot/history) that
    // must bypass web.js's POST-only gate. Claimed BEFORE the generic /web
    // router. See pvp.js.
    if (path.startsWith('/web/pvp/')) {
      const { handlePvpRoute } = await import('./pvp.js');
      return handlePvpRoute(req, env, path);
    }

    if (path.startsWith('/web/')) {
      const { handleWeb } = await import('./web.js');
      return handleWeb(req, env);
    }

    // Overlay relay queue — polled by Streamer.bot, RELAY_TOKEN-gated.
    if (path.startsWith('/relay/')) return handleRelay(req, env);

    // StreamFusion release-notes webhook (ported from the retired
    // StreamFusion/bot-service /post-release Node service). Voice-
    // channel detection — the only piece that needed a persistent
    // Gateway connection — was scrapped per Clay, so this is the
    // only SF-specific feature worth migrating into the Worker.
    // X-SF-Release-Secret header carries the auth; matches
    // SF_RELEASE_SECRET. See discord-bot/sf-release.js.
    if (method === 'POST' && path === '/sf/post-release') {
      const { handlePostRelease } = await import('./sf-release.js');
      return handlePostRelease(req, env);
    }

    // StreamFusion community-sharing surface — see sf-community.js.
    //   POST /sf/community-live     opt-in live-status heartbeat
    //   POST /sf/community-event    opt-in event relay (follows/subs/etc)
    //   GET  /community/live        public radar consumed by aquilo.gg
    if (method === 'POST' && path === '/sf/community-live') {
      const { handleCommunityLive } = await import('./sf-community.js');
      return handleCommunityLive(req, env);
    }
    if (method === 'POST' && path === '/sf/community-event') {
      const { handleCommunityEvent } = await import('./sf-community.js');
      return handleCommunityEvent(req, env);
    }
    if (method === 'GET' && path === '/community/live') {
      const { handlePublicCommunityLive } = await import('./sf-community.js');
      return handlePublicCommunityLive(req, env);
    }

    // StreamFusion community-night queue manager — see sf-queue.js.
    //   POST /sf/queue          full queue + per-joiner links for the panel
    //   POST /sf/queue/remove   drop a joiner after the streamer marks done
    if (method === 'POST' && path === '/sf/queue') {
      const { handleSfQueueRead } = await import('./sf-queue.js');
      return handleSfQueueRead(req, env);
    }
    if (method === 'POST' && path === '/sf/queue/remove') {
      const { handleSfQueueRemove } = await import('./sf-queue.js');
      return handleSfQueueRemove(req, env);
    }

    // Character paper-doll render endpoint. Public read; ETag/
    // cache-control tied to ?v=<lookVersion> so Discord embeds
    // re-fetch after a customisation change. See character.js.
    if (method === 'GET' && path.startsWith('/character/render/')) {
      const { handleCharacterRender } = await import('./character.js');
      return handleCharacterRender(req, env, path);
    }

    // User-uploaded hero avatar — public read. Stored in KV with
    // contentType metadata; route streams the bytes back. Cache pinned
    // to ?v=<uploadedAt>. See character.js handleCharacterAvatar.
    // Path shape: /character/avatar/<userId>(.bin|.png|.jpg|...)
    if (method === 'GET' && path.startsWith('/character/avatar/')) {
      const { handleCharacterAvatar } = await import('./character.js');
      return handleCharacterAvatar(req, env, path);
    }

    // Aquilo-bot fold-in HTTP routes. Returns null when none of the
    // aquilo routes match so we fall through to the final 404.
    // Covers: /today-game, /overlay/ws, /counting/message,
    // /forward-channels, /announce, /broadcast, /fourthwall,
    // /sr/pending. See discord-bot/aquilo/worker.js.
    {
      const { handleAquiloHttp } = await import('./aquilo/worker.js');
      const r = await handleAquiloHttp(req, env, ctx, url);
      if (r) return r;
    }

    // ── Clash (Phase 4) ────────────────────────────────────────────
    // Public global leaderboard (top raiders + top towns) — no auth,
    // mirrors /leaderboard/<guildId>. Future aquilo.gg /clash page
    // hits this for the ranked-ladder view.
    if (method === 'GET' && path === '/clash-leaderboard') {
      const { handleClashLeaderboardHttp } = await import('./clash-http.js');
      return handleClashLeaderboardHttp(req, env);
    }
    // Public per-town read for the web base editor + Twitch panel —
    // returns enough state to render the town view client-side.
    if (method === 'GET' && path.startsWith('/clash/town/')) {
      const { handleClashTownPublic } = await import('./clash-http.js');
      return handleClashTownPublic(env, path);
    }
    // /sync/<g>/clash[-events] are dispatched earlier (before the
    // generic /sync/ catch-all). See the block near /claim.

    // /p/ profile page hoisted earlier in dispatch order doesn't fit
    // here cleanly because /p/ doesn't collide with anything; placed
    // earlier to be findable. (handled above the /web/ block.)

    return new Response('not found', { status: 404 });
  },

  // Cron dispatcher. Wired via [triggers] crons in wrangler.toml.
  //   17 * * * *      stocks price refresh (stocks.js)
  //   23 * * * *      sports games + bet settlement + bolts-feed digest
  //   0 1,2 * * *     queue auto-open at 9 PM ET (1 UTC = 21 EST,
  //                   2 UTC = 21 EDT — one fires per day depending on
  //                   DST. autoOpenIfDue() filters on local hour == 21
  //                   so only the live one actually does anything.)
  // Errors caught per job so a single bad source can't break the rest.
  async scheduled(event, env, ctx) {
    try {
      // 2026-05-29 sprint — what was the `:17` hourly cron is now the
      // every-minute trigger so the live-status-embed dashboard can
      // refresh per minute. The original hourly work is gated by
      // `mm === 17` below so its cadence is preserved. The other 59
      // ticks per hour run ONLY the live-status refresh (cheap: one
      // KV read + a noop unless an embed is tracked).
      if (event.cron === '* * * * *') {
        const mm = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
        // Every-minute dashboard refresh. KV-gated — no-ops cleanly
        // when no stream is being tracked.
        ctx.waitUntil((async () => {
          try {
            const { refreshLiveStatusEmbed } = await import('./live-status-embed.js');
            await refreshLiveStatusEmbed(env);
          } catch (e) { console.warn('[cron] live-status refresh', e?.message || e); }
        })());
        // Stream-bonus accrual — Aether + Watchtower per-minute ticks.
        // Both no-op when Clay isn't live (isStreamLive read inside).
        // Independent waitUntil per call so a slow KV list on one
        // doesn't block the other.
        const activeGuildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
        if (activeGuildId) {
          ctx.waitUntil((async () => {
            try {
              const { liveAccrueAetherTick } = await import('./stream-bonus.js');
              await liveAccrueAetherTick(env, activeGuildId);
            } catch (e) { console.warn('[cron] aether tick', e?.message || e); }
          })());
          ctx.waitUntil((async () => {
            try {
              const { liveAccrueWatchtowerBoltsTick } = await import('./stream-bonus.js');
              await liveAccrueWatchtowerBoltsTick(env, activeGuildId);
            } catch (e) { console.warn('[cron] watchtower tick', e?.message || e); }
          })());
          // Bolt rain — fires every 5 minutes (mm % 5 === 0). Random
          // drops to ~5 viewers chosen from the wallet prefix.
          // Lighter cadence so it stays a "treat" not a firehose.
          if (mm % 5 === 0) {
            ctx.waitUntil((async () => {
              try {
                const { boltRainTick } = await import('./stream-bonus.js');
                const r = await boltRainTick(env, activeGuildId, { count: 5 });
                if (r?.ok && r.drops?.length) {
                  console.log('[cron] bolt-rain:', r.drops.length, 'drops,',
                              r.total, 'total bolts');
                }
              } catch (e) { console.warn('[cron] bolt-rain', e?.message || e); }
            })());
            // Twitch Drops watch-time tick (shares the 5-min cadence).
            // Walks linked viewers, +5 min to each while live, checks
            // milestone crossings. No-op when stream is offline.
            ctx.waitUntil((async () => {
              try {
                const { watchTimeTickCron } = await import('./twitch-drops.js');
                const r = await watchTimeTickCron(env);
                if (r?.ok && (r.credited || r.crossings)) {
                  console.log('[cron] twitch-drops:', r.walkedUsers, 'viewers,',
                              r.credited, 'min credited,', r.crossings, 'crossings');
                }
              } catch (e) { console.warn('[cron] twitch-drops', e?.message || e); }
            })());
            // Aquilo's Vault — every-5-min tick: expire stale crises,
            // low-probability crisis spawn, recompute resource bars.
            // Rides the every-minute trigger (4-cron ceiling). No-ops
            // cleanly when the vault hasn't been seeded yet.
            ctx.waitUntil((async () => {
              try {
                const { tickVault } = await import('./vault-community.js');
                const r = await tickVault(env, activeGuildId);
                if (r?.spawn) console.log('[cron] vault crisis spawned:', r.spawn.kind, r.spawn.crisisId);
                if (r?.expired?.length) console.log('[cron] vault crises expired:', r.expired.length);
              } catch (e) { console.warn('[cron] vault tick', e?.message || e); }
            })());
          }
        }
        // Random Drops — rarity-weighted community chest spawn every 2
        // hours. randomDropCron self-gates to even-hour:00 via a KV
        // 2h-bucket marker (the account is at the 4-cron ceiling, so
        // this rides the every-minute trigger instead of its own
        // `0 */2 * * *` cron). No-op off-cadence / already-spawned.
        if (activeGuildId) {
          ctx.waitUntil((async () => {
            try {
              const { randomDropCron } = await import('./random-drops.js');
              const r = await randomDropCron(env);
              if (r?.spawned?.ok && !r.spawned.alreadyActive) {
                console.log('[cron] random-drop spawned', r.spawned.rarity, 'bucket', r.bucket);
              }
            } catch (e) { console.warn('[cron] random-drop', e?.message || e); }
          })());
        }
        // 30-minute pre-stream ping. Opt-in via STREAM_PING_CHANNEL —
        // the helper no-ops (and we skip the import) when it's unset,
        // so this stays cheap on the every-minute trigger. A per-event
        // KV marker guarantees exactly one ping per stream.
        if (env.STREAM_PING_CHANNEL && env.AQUILO_VAULT_GUILD_ID) {
          ctx.waitUntil((async () => {
            try {
              const { preStreamPings } = await import('./stream-events.js');
              const r = await preStreamPings(env, env.AQUILO_VAULT_GUILD_ID);
              if (r?.sent?.length) console.log('[cron] pre-stream ping:', JSON.stringify(r.sent));
            } catch (e) { console.warn('[cron] pre-stream ping', e?.message || e); }
          })());
        }
        // Hourly work below is the OLD :17 schedule — only runs when
        // the current minute is 17 to preserve the original cadence.
        if (mm !== 17) {
          return;
        }
      }
      if (event.cron === '17 * * * *' || (event.cron === '* * * * *' &&
          new Date(event.scheduledTime || Date.now()).getUTCMinutes() === 17)) {
        const { stocksCronTick } = await import('./stocks.js');
        ctx.waitUntil(stocksCronTick(env));
        // CN-games roster Steam-price refresh. Fires every :17 but the
        // refreshRosterIfDue() helper short-circuits on a 6-hour KV
        // marker so it only actually re-fetches Steam ~4 times/day.
        // No-op when cn-roster:<g> isn't populated (i.e. no admin has
        // run /admin/cn-roster/post for the active guild).
        ctx.waitUntil((async () => {
          try {
            const activeGuild = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
            if (!activeGuild) return;
            const { refreshRosterIfDue } = await import('./cn-games-roster.js');
            const r = await refreshRosterIfDue(env, activeGuild);
            if (r.ok) console.log('[cron] cn-roster refresh:', JSON.stringify(r));
          } catch (e) {
            console.warn('[cron] cn-roster refresh', e?.message || e);
          }
        })());
        // Twitch hourly bundle — live-embed refresh + clip poll +
        // Sunday-22-ET clip-of-the-week + Sunday-20-ET weekly recap.
        // Each task is independently best-effort + no-ops cleanly
        // when the relevant secrets/env aren't set.
        ctx.waitUntil((async () => {
          try {
            const { isTwitchConfigured } = await import('./twitch-helix.js');
            if (isTwitchConfigured(env) && env.CLAY_TWITCH_CHANNEL_ID) {
              // Mid-stream refresh: hourly cadence (the cron tier
              // we're on caps at 4 triggers, all used elsewhere).
              // EventSub gives us instant on/off; the hourly tick
              // just keeps viewer-count + game name from going
              // stale during long sessions.
              const { refreshLiveEmbed } = await import('./twitch-live.js');
              await refreshLiveEmbed(env, env.CLAY_TWITCH_CHANNEL_ID).catch(e =>
                console.warn('[cron] refreshLiveEmbed', e?.message || e));
              const { pollNewClipsCron } = await import('./twitch-clips.js');
              await pollNewClipsCron(env).catch(e =>
                console.warn('[cron] pollNewClipsCron', e?.message || e));
            }
          } catch (e) {
            console.warn('[cron] twitch hourly bundle', e?.message || e);
          }
        })());
        // Sunday 8pm ET → weekly recap. Sunday 10pm ET → clip of
        // the week. ET-gated via getETInfo so DST is handled
        // automatically; both functions are KV-marker idempotent
        // so the at-least-once cron semantics don't double-fire.
        ctx.waitUntil((async () => {
          try {
            const { getETInfo } = await import('./aquilo/util.js');
            const { weekday, hour } = getETInfo(new Date(event.scheduledTime || Date.now()));
            if (weekday === 'sunday' && hour === 20) {
              const { postWeeklyRecap } = await import('./weekly-recap.js');
              const r = await postWeeklyRecap(env);
              console.log('[cron] weekly-recap', JSON.stringify(r));
            }
            if (weekday === 'sunday' && hour === 22) {
              const { postClipOfTheWeekCron } = await import('./twitch-clips.js');
              const r = await postClipOfTheWeekCron(env);
              console.log('[cron] clip-of-the-week', JSON.stringify(r));
            }
          } catch (e) {
            console.warn('[cron] sunday gates', e?.message || e);
          }
        })());
      } else if (event.cron === '23 * * * *') {
        const { betCronTick } = await import('./bet.js');
        ctx.waitUntil(betCronTick(env));
        // Bolts-feed digest piggybacks on the :23 tick — no extra cron
        // slot needed in wrangler.toml. Independent waitUntil so a
        // failure in one doesn't cancel the other.
        const { boltsFeedCronTick } = await import('./bolts-feed.js');
        ctx.waitUntil(boltsFeedCronTick(env));
      } else if (event.cron === '0 1 * * *' || event.cron === '0 2 * * *') {
        // Queue auto-open at 9 PM ET on variety/community nights.
        // autoOpenIfDue is idempotent + bails if conditions aren't met.
        const guildId = env.AQUILO_VAULT_GUILD_ID;
        if (guildId) {
          ctx.waitUntil((async () => {
            const { autoOpenIfDue } = await import('./queue.js');
            const r = await autoOpenIfDue(env, guildId);
            if (!r.fired) {
              console.log('queue auto-open: skipped (' + r.reason + ')');
              return;
            }
            // Empty queue created; tell aquilo-site to fan out the PWA push
            // (best-effort, never blocks the open).
            try {
              const { notifyQueueAutoOpened } = await import('./queue.js');
              await notifyQueueAutoOpened(env, guildId, r.streamDate, r.kind);
            } catch (e) {
              console.error('queue auto-open notify failed:', e && e.message);
            }
          })());
        }
        // Daily-quests rotation pre-warm. Piggybacks on this :01 UTC
        // cron because CF caps the worker at 4 cron triggers. The 1h
        // delay vs intended 00:00 UTC reset is cosmetic — getRotation
        // is lazy + idempotent so the first request after midnight
        // computes the new day's set if the cron hasn't yet.
        ctx.waitUntil((async () => {
          try {
            const { dailyResetCron } = await import('./daily-quests.js');
            const r = await dailyResetCron(env);
            if (r?.ok) console.log('[cron] daily-quests:', r.dayKey, 'warmed', r.warmed, 'ids');
            else console.warn('[cron] daily-quests:', r?.error);
          } catch (e) { console.warn('[cron] daily-quests', e?.message || e); }
        })());
        // Pet evolutions sweep — bounded to 5k pets per call. Any pet
        // that crossed its evolution-level threshold yesterday gets
        // its species mutated. Per-pet errors are collected into the
        // return value rather than crashing the cron.
        ctx.waitUntil((async () => {
          try {
            const { autoEvolveCron } = await import('./pet-leveling.js');
            const r = await autoEvolveCron(env);
            if (r?.scanned) console.log('[cron] pet-evolve:', r.scanned, 'scanned,', r.evolved, 'evolved');
          } catch (e) { console.warn('[cron] pet-evolve', e?.message || e); }
        })());
        // Mirror the stream schedule into Discord guild scheduled
        // events (idempotent — skips dateKeys already created). See
        // stream-events.js.
        if (env.AQUILO_VAULT_GUILD_ID) {
          ctx.waitUntil((async () => {
            try {
              const { syncStreamEvents } = await import('./stream-events.js');
              const r = await syncStreamEvents(env, env.AQUILO_VAULT_GUILD_ID);
              if (r?.created?.length) console.log('[cron] stream-events:', JSON.stringify(r));
            } catch (e) { console.warn('[cron] stream-events', e?.message || e); }
          })());
        }
      }
      // Clash housekeeping piggybacks on the :23 hourly tick — CF
      // free plan caps a Worker at 5 cron triggers and we're using
      // all five for stocks/sports/queue/aquilo. Inside
      // clash-cron.js the tick gates the once-per-day trophy decay
      // via a `clash:cron:last-decay` KV marker so it only runs once
      // per UTC day even though the cron fires hourly.
      if (event.cron === '23 * * * *') {
        const { clashDailyCronTick } = await import('./clash-cron.js');
        ctx.waitUntil(clashDailyCronTick(env, event.cron));
        // Aquilo-bot fold-in piggybacks on the same :23 tick (CF
        // free-plan 4-cron ceiling on this account). The aquilo
        // handler runs per-task hour checks and KV-marker dedupe so
        // firing once per hour is correct and idempotent. The
        // standalone worker's old 12:30 AM ET queue-cleanup minute-
        // branch shifts to 1:23 AM ET, which is a cosmetic ~30 min
        // delay on a post-stream message cleanup — fine.
        const { aquiloScheduledTick } = await import('./aquilo/worker.js');
        ctx.waitUntil(aquiloScheduledTick(event, env, ctx));
        // Consolidated daily-bonus push — first :23 tick at/after
        // 13 UTC fires the once-per-day PWA notification to
        // subscribers reminding them that boltbound free pack,
        // loadout daily, check-in, and daily missions are all
        // claimable again. KV-marker dedupe means only one fires
        // per UTC day even though the cron runs hourly.
        const { dailyBonusCronTick } = await import('./daily-bonus-push.js');
        ctx.waitUntil(dailyBonusCronTick(env));
        // Board-game async forfeit sweep — any correspondence match
        // whose 24h per-move deadline elapsed gets resolved to the
        // opponent (wager goes with the win). On-read paths in
        // boardgames-engine.js also catch expired matches when a
        // player actively loads them; this sweep is the safety net
        // for games no one is watching.
        const { cronSweepExpiredMatches } = await import('./boardgames-engine.js');
        ctx.waitUntil(cronSweepExpiredMatches(env));
        // Gifter roles — rebuilds top-3 membership per category from
        // the rolling 30d buckets + trims old buckets. KV-marker
        // gated to once per UTC day so the hourly :23 firing doesn't
        // thrash Discord role REST 24× a day.
        const { gifterRolesDailyTick } = await import('./gifter-roles.js');
        ctx.waitUntil(gifterRolesDailyTick(env).then(r =>
          console.log('[cron] gifter-roles daily', JSON.stringify(r))).catch(e =>
          console.warn('[cron] gifter-roles', e?.message || e)));
        // (Removed 2026-05-31: the MC paid-Patreon whitelist daily sweep.
        // Clay dropped Minecraft as a featured offering — no more role
        // gating. The #smp-chat channel + DiscordSRV bridge stay; only
        // the "Minecraft Whitelist" role + its gating were removed.)
        // Custom-poll close sweep — runs every :23 (hourly), no marker
        // needed since pollsCronSweep is itself a per-poll closeAt
        // gate. Cost is one KV-list of ~5 keys; cheap.
        ctx.waitUntil((async () => {
          try {
            const { pollsCronSweep } = await import('./custom-polls.js');
            const r = await pollsCronSweep(env);
            if (r.closed > 0) console.log('[cron] custom-polls', JSON.stringify(r));
          } catch (e) {
            console.warn('[cron] custom-polls sweep', e?.message || e);
          }
        })());
        // Twitch reward-role expiry sweep — hourly, idempotent. Iterates
        // the twitch-rewards:expiry list + removes expired sub-tier
        // roles. Same retry-on-failure shape as the counting sweep.
        ctx.waitUntil((async () => {
          try {
            const { sweepExpiredRewardRoles } = await import('./twitch-rewards.js');
            const r = await sweepExpiredRewardRoles(env);
            if (r.swept > 0 || r.abandoned > 0) {
              console.log('[cron] twitch-rewards expiry', JSON.stringify(r));
            }
          } catch (e) {
            console.warn('[cron] twitch-rewards expiry', e?.message || e);
          }
        })());
        // Support-ticket stale sweep — once-per-UTC-day via marker.
        // Closes tickets with no activity for 30 days; archives the
        // thread + DMs the requester. Cheap when no candidates.
        ctx.waitUntil((async () => {
          const today = new Date().toISOString().slice(0, 10);
          const marker = await env.LOADOUT_BOLTS.get('support-tickets:cron:last-sweep').catch(() => null);
          if (marker === today) return;
          try {
            const { autoCloseStaleTickets } = await import('./support-tickets.js');
            const r = await autoCloseStaleTickets(env);
            if (r.closed > 0) console.log('[cron] support-tickets auto-close', JSON.stringify(r));
            await env.LOADOUT_BOLTS.put('support-tickets:cron:last-sweep', today);
          } catch (e) {
            console.warn('[cron] support-tickets auto-close', e?.message || e);
          }
        })());
        // Anniversary celebrations — once-per-UTC-day sweep (gated by
        // an anniv:cron:last-sweep KV marker inside the helper). Walks
        // the anniv:seen keyspace + posts a celebratory embed in the
        // games-hub channel for anyone whose join-anniversary is today.
        // Reward claim itself is pull-based via /web/anniversary/celebrate.
        ctx.waitUntil((async () => {
          try {
            const { anniversaryDailyCron } = await import('./anniversary.js');
            const r = await anniversaryDailyCron(env);
            if (r?.announced) console.log('[cron] anniversary', JSON.stringify(r));
          } catch (e) {
            console.warn('[cron] anniversary', e?.message || e);
          }
        })());
        // Seasonal Spire monthly rotation. Piggybacked on :23; the
        // helper is gated by a `spire:rotate:last-month` KV marker so
        // re-running mid-month is a no-op. Logs the rotation outcome.
        ctx.waitUntil((async () => {
          try {
            const { rotateSeasonIfNeeded } = await import('./spire.js');
            const r = await rotateSeasonIfNeeded(env);
            if (r?.rotated) console.log('[cron] spire rotate', JSON.stringify(r));
          } catch (e) {
            console.warn('[cron] spire rotate', e?.message || e);
          }
        })());
        // Unified vote-hub phase transitions — runs hourly, re-renders
        // the hub embed on phase change. See vote-hub.js.
        const guildIdForVoteHub = env.AQUILO_VAULT_GUILD_ID;
        if (guildIdForVoteHub) {
          const { tickPhaseTransition } = await import('./vote-hub.js');
          ctx.waitUntil(tickPhaseTransition(env, guildIdForVoteHub).then(r =>
            console.log('[cron] vote-hub', JSON.stringify(r))).catch(e =>
            console.warn('[cron] vote-hub', e?.message || e)));
          // Refresh the rolling weekly-schedule pinned embed (edit-in-
          // place, idempotent — no-ops when nothing changed / no schedule
          // channel is bound). Keeps the pinned embed current with the
          // Triple-C campaign + vote winners; self-heals the 2026-06 stale-
          // Minecraft embed without a manual trigger.
          ctx.waitUntil((async () => {
            try {
              const { postOrRefreshSchedule } = await import('./aquilo/aq-schedule.js');
              await postOrRefreshSchedule(env, guildIdForVoteHub);
            } catch (e) {
              console.warn('[cron] schedule-embed', e?.message || e);
            }
          })());
        }
        // Scheduled messages — scan due records + send. Cron fires
        // hourly so the worst-case delivery latency is ~1h; the
        // record's status flips to 'sent' on success, 'failed' on
        // the second consecutive failure. See scheduled-messages.js.
        const guildId = env.AQUILO_VAULT_GUILD_ID;
        if (guildId) {
          const { processDueMessages } = await import('./scheduled-messages.js');
          ctx.waitUntil(processDueMessages(env, guildId).then(r =>
            console.log('[cron] schedule-msg', JSON.stringify(r))).catch(e =>
            console.warn('[cron] schedule-msg', e?.message || e)));
        }
      }
    } catch (e) {
      console.error('scheduled cron failed:', e && e.message);
    }
  },
};

// ---- /leaderboard/:guildId (public, read-only) ---------------------------
// Returns the top-N wallets for a guild, filtered to viewers who have
// linked at least one public platform handle (twitch/youtube/etc). The
// goal is community-facing "top contributors" surfaces — Discord-only
// users haven't opted in to public identification, so we omit them.
//
// Response shape:
//   {
//     guildId: "1504103035951906883",
//     updatedAt: 1700000000000,
//     entries: [
//       { rank: 1, display: "MidnightWolf", platform: "twitch", balance: 12450, lifetimeEarned: 25000 },
//       ...
//     ]
//   }
//
// Cached server-side in KV for 60s so a busy homepage doesn't churn
// the wallet:* list-and-fetch on every page view.

const LEADERBOARD_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'public, max-age=60',
};

async function handlePublicLeaderboard(req, env, path) {
  // path = /leaderboard/<guildId>
  const guildId = path.split('/')[2] || '';
  if (!/^\d{5,25}$/.test(guildId)) {
    return jsonCors({ error: 'guildId must be a numeric Discord snowflake' }, 400);
  }

  const url = new URL(req.url);
  const limit = Math.min(
    25,
    Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10) || 10)
  );

  // Server-side cache — leaderboard is the same for everyone, no point
  // recomputing per request.
  const cacheKey = `leaderboard-cache:${guildId}`;
  try {
    const cached = await env.LOADOUT_BOLTS.get(cacheKey, { type: 'json' });
    if (cached && cached.updatedAt && Date.now() - cached.updatedAt < 60_000) {
      // Trim to the requested limit even if the cache holds more.
      const out = { ...cached, entries: cached.entries.slice(0, limit) };
      return jsonCors(out, 200);
    }
  } catch {
    /* fall through to recompute */
  }

  try {
    // Fetch up to top 50 by raw balance, then filter and trim.
    const top = await leaderboard(env, guildId, 50);
    const filtered = top.filter(
      ({ w }) =>
        w &&
        Array.isArray(w.links) &&
        w.links.some(l => l && l.platform && l.username)
    );
    const entries = filtered.slice(0, limit).map(({ w }, i) => {
      const primary =
        (w.links || []).find(l => l && l.platform === 'twitch') ||
        (w.links || []).find(l => l && l.platform && l.username) ||
        null;
      return {
        rank: i + 1,
        display: primary?.username || 'Viewer',
        platform: primary?.platform || null,
        balance: Number(w.balance || 0),
        lifetimeEarned: Number(w.lifetimeEarned || 0),
      };
    });

    const payload = {
      guildId,
      updatedAt: Date.now(),
      entries,
    };

    // Cache for 2x the freshness window so a stampede doesn't all
    // recompute at exactly 60s. Lazy refresh — first request after
    // expiry rebuilds and overwrites.
    try {
      await env.LOADOUT_BOLTS.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: 300,
      });
    } catch {
      /* non-fatal */
    }

    return jsonCors(payload, 200);
  } catch (err) {
    return jsonCors({ error: 'leaderboard failed', detail: String(err) }, 500);
  }
}

function jsonCors(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...LEADERBOARD_CORS },
  });
}

// ---- /credit-bolts (Aquilo's Vault → Loadout Bolts) ---------------------
// Vault bot calls here to mirror cap activity into off-stream Bolts.
// Auth: shared secret in X-Aquilo-Vault-Bolts-Secret header.
// Allow-list: env.AQUILO_VAULT_GUILD_ID restricts which guild can be credited
// (so a leaked secret can only target the configured Vault server, not any
// random Loadout-using server).

async function handleVaultCredit(req, env) {
  const expected = env.AQUILO_VAULT_BOLTS_SECRET;
  if (!expected) return new Response('credit endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-aquilo-vault-bolts-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const guildId = String(body.guild_id || '');
  const userId  = String(body.user_id  || '');
  const amount  = Number(body.amount);
  const reason  = String(body.reason || 'vault');

  if (!guildId || !userId || !Number.isFinite(amount)) {
    return new Response('guild_id, user_id, integer amount required', { status: 400 });
  }
  const allowed = env.AQUILO_VAULT_GUILD_ID;
  if (allowed && guildId !== String(allowed)) {
    return new Response('guild not allowed', { status: 403 });
  }

  const { wallet, was_new } = await applyVaultDelta(env, guildId, userId, Math.trunc(amount), reason);
  return json({ ok: true, balance: wallet.balance, was_new });
}

// ---- /wallet-balance (read-only cross-bot lookup) -----------------------
// Lets the Aquilo's Vault bot's /wallet command (and future surfaces)
// show the SAME bolts number that /loadout shows in this server. No
// mutation — pure read. Auth + allow-list mirror /credit-bolts.
async function handleWalletBalanceRead(req, env) {
  const expected = env.AQUILO_VAULT_BOLTS_SECRET;
  if (!expected) return new Response('wallet endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-aquilo-vault-bolts-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  const url = new URL(req.url);
  const guildId = String(url.searchParams.get('guild_id') || '');
  const userId  = String(url.searchParams.get('user_id')  || '');
  if (!guildId || !userId) {
    return new Response('guild_id, user_id query params required', { status: 400 });
  }
  const allowed = env.AQUILO_VAULT_GUILD_ID;
  if (allowed && guildId !== String(allowed)) {
    return new Response('guild not allowed', { status: 403 });
  }

  const { getWallet } = await import('./wallet.js');
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    balance:        w.balance        || 0,
    lifetimeEarned: w.lifetimeEarned || 0,
    lifetimeSpent:  w.lifetimeSpent  || 0,
    dailyStreak:    w.dailyStreak    || 0,
    lastEarnUtc:    w.lastEarnUtc    || 0,
    lastEarnReason: w.lastEarnReason || '',
    linkedCount:   (w.links || []).length,
  });
}

// ---- /counting/award-bolts (aquilo-bot → Loadout) ----------------------
// Counting-game integration. aquilo-bot calls here on each successful
// count (positive amount) or fail (negative amount). Same wallet
// primitive as the Vault integration — applyVaultDelta handles the
// balance clamp at 0 and tracks lifetimeEarned/Spent correctly.
//
// Auth: shared secret in X-Counting-Secret header, set as
// LOADOUT_BOLT_API_SECRET on this worker (and the same value on
// aquilo-bot's wrangler secret of the same name).
async function handleCountingAward(req, env) {
  const expected = env.LOADOUT_BOLT_API_SECRET;
  if (!expected) return new Response('counting endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-counting-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const guildId = String(body.guildId || body.guild_id || '');
  const userId  = String(body.userId  || body.user_id  || '');
  const amount  = Number(body.amount);
  const reason  = String(body.reason || 'counting');

  if (!guildId || !userId || !Number.isFinite(amount)) {
    return new Response('guildId, userId, integer amount required', { status: 400 });
  }

  const { wallet, was_new } = await applyVaultDelta(env, guildId, userId, Math.trunc(amount), reason);
  return json({ ok: true, balance: wallet.balance, was_new });
}

// ---- /interactions ------------------------------------------------------

async function handleDiscordInteractions(req, env, ctx) {
  // Single-tenant: one public key. Set it once via:
  //   wrangler kv:key put --binding=LOADOUT_BOLTS publickey <hex>
  const publicKey = await env.LOADOUT_BOLTS.get('publickey');
  if (!publicKey) return new Response('worker not provisioned', { status: 500 });

  const body = await req.text();
  const reReq = new Request(req.url, { method: 'POST', headers: req.headers, body });
  const v = await verifyDiscordSignature(reReq, publicKey);
  if (!v.ok) return new Response('bad signature', { status: 401 });

  let data;
  try { data = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }

  // PING
  if (data.type === 1) return json({ type: 1 });

  // /loadout-claim is special-cased — handled inline because it touches
  // the claim KV. Everything else flows through handleInteraction.
  if (data.type === 2 && data?.data?.name === 'loadout-claim') {
    const resp = await handleClaimCommand(env, data);
    return json(resp);
  }

  return handleInteraction(req, env, body, ctx);
}

// ---- /claim (Loadout mints a code) --------------------------------------

async function mintClaim(req, env) {
  // Loadout-side bootstrap: a streamer hits "Get my code" in Settings;
  // Loadout calls this with no auth (well, just the worker URL the user
  // configured). We mint a short alphanumeric code, generate a fresh
  // HMAC secret, and store both with a 10-min TTL. The streamer types
  // the code in their Discord server; that POSTs through /interactions
  // and gets bound to a guild id.
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const ownerName = (body.ownerName || '').slice(0, 64);

  const code = randomCode(8);
  const secret = randomSecret();
  const ttlMs = 10 * 60 * 1000;

  await env.LOADOUT_BOLTS.put('claim:' + code, JSON.stringify({
    secret,
    ownerName,
    mintedUtc: Date.now(),
    ttlExpiresUtc: Date.now() + ttlMs
  }), { expirationTtl: 600 });

  return json({
    code,
    secret,
    expiresInSec: 600,
    invite: 'https://discord.com/oauth2/authorize?client_id=' + (env.DISCORD_APP_ID || 'CLIENT_ID') +
            '&permissions=2147485696&scope=bot+applications.commands'
  });
}

// ---- /claim/:code/status (Loadout polls until claimed) ------------------

async function claimStatus(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['claim', '<code>', 'status']
  const code = (parts[1] || '').toUpperCase();
  if (!code) return new Response('code required', { status: 400 });
  const raw = await env.LOADOUT_BOLTS.get('claim:' + code, { type: 'json' });
  if (!raw) return json({ status: 'expired' });
  if (raw.claimedGuildId) return json({ status: 'claimed', guildId: raw.claimedGuildId });
  return json({ status: 'pending' });
}

// ---- /tips/:guildId/:secret --------------------------------------------
// Streamer's tip-provider (Streamlabs / StreamElements / Ko-fi / etc.)
// posts a normalized donation here. We append it to a rolling per-guild
// log; the DLL polls /sync/<guild>/tips?since=<ms> to pick them up,
// award bolts, and republish on the local Aquilo Bus so overlays light
// up. We deliberately don't accept upstream webhook formats directly —
// the streamer wires their provider to this endpoint via a Streamer.bot
// HTTP request action that posts the normalized shape:
//
//   POST /tips/<guildId>/<secret>
//   {
//     "tipper": "rosie",                // display name
//     "tipperPlatform": "twitch",       // optional, lowercase
//     "tipperHandle": "rosie_91",       // optional, the actual handle on the platform
//     "amount": 5.00,
//     "currency": "USD",
//     "message": "love the stream",
//     "source": "streamlabs",           // audit only
//     "tipId": "sl-12345"               // dedup key (optional)
//   }
//
// Why a path-segment secret: tip providers tend to be picky about
// custom headers but happy to take an arbitrary URL. Easier wire-up
// for streamers, comparable security to a header-bearing token.
async function handleTip(req, env, path) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const parts = path.split('/').filter(Boolean);   // ['tips', '<guildId>', '<secret>']
  if (parts.length < 3) return new Response('guildId and secret required', { status: 400 });
  const guildId = parts[1];
  const presented = parts[2];
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('guild not registered', { status: 404 });
  // Constant-time-ish compare. Worker timing isn't a great side-channel
  // anyway, but no reason to leak more than necessary.
  if (presented.length !== stored.secret.length) return new Response('bad secret', { status: 401 });
  let acc = 0;
  for (let i = 0; i < presented.length; i++) acc |= presented.charCodeAt(i) ^ stored.secret.charCodeAt(i);
  if (acc !== 0) return new Response('bad secret', { status: 401 });

  let payload;
  try { payload = await req.json(); }
  catch { return new Response('bad json', { status: 400 }); }
  const amount = Number(payload?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return new Response('amount required', { status: 400 });

  const tip = {
    tipper:         String(payload.tipper        || 'anonymous').slice(0, 64),
    tipperPlatform: String(payload.tipperPlatform || '').toLowerCase().slice(0, 16),
    tipperHandle:   String(payload.tipperHandle  || '').slice(0, 64),
    amount,
    currency:       String(payload.currency || 'USD').toUpperCase().slice(0, 8),
    message:        String(payload.message  || '').slice(0, 240),
    source:         String(payload.source   || 'unknown').toLowerCase().slice(0, 32),
    tipId:          String(payload.tipId    || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
    ts:             Date.now()
  };

  // Append to the rolling tip log. Capped at 200 entries — the DLL
  // polls every minute and clears its cursor, so even an active
  // multi-day-offline backlog stays well under cap.
  const key = 'tips:' + guildId;
  const existing = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
  // Dedup by tipId — re-deliveries from the streamer's tip provider
  // would otherwise double-credit the viewer.
  if (existing.some(e => e.tipId === tip.tipId)) {
    return new Response(JSON.stringify({ ok: true, dedup: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  existing.push(tip);
  while (existing.length > 200) existing.shift();
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(existing));

  return new Response(JSON.stringify({ ok: true, tipId: tip.tipId }),
                      { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /sync/:guildId... --------------------------------------------------

async function handleSync(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['sync', ':guildId', maybe 'init'|'games']
  const guildId = parts[1];
  const sub = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  if (sub === 'init' && req.method === 'POST') return handleSyncInit(req, env, guildId);

  const ts  = req.headers.get('x-loadout-ts');
  const sig = req.headers.get('x-loadout-sig');
  const body = req.method === 'POST' ? await req.text() : '';
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('guild not registered', { status: 404 });

  const ok = await verifyHmac(stored.secret, ts || '', body, sig || '');
  if (!ok) return new Response('bad signature', { status: 401 });

  // B7 — /sync/:guildId/voice/joined — DLL forwards Discord voice-state
  // events here so the worker can drive "join channel X → spawn a temp
  // VC" without maintaining a Gateway connection. HMAC same as the
  // other /sync/* routes. Body: { userId, displayName?, channelId|null }.
  // channelId === TEMP_VC_PARENT_ID → spawn-then-move flow;
  // channelId on a tracked temp VC → stamp lastActivityUtc so the
  // cleanup heuristic doesn't delete a busy room.
  if (sub === 'voice' && parts[3] === 'joined' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(body); } catch { return new Response('bad-json', { status: 400 }); }
    const { handleVoiceStateUpdate } = await import('./voice-temp.js');
    const r = await handleVoiceStateUpdate(env, { ...payload, guildId });
    return new Response(JSON.stringify(r), { status: r.ok ? 200 : 400, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/games?since=<ms> — DLL pulls recent minigame results so
  // they can be republished on the local Aquilo Bus. Same HMAC scheme as
  // the wallet endpoints; ts+\n is the signed payload for GETs.
  if (sub === 'games' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const all = (await env.LOADOUT_BOLTS.get('games:' + guildId, { type: 'json' })) || [];
    const fresh = all.filter(e => (e.ts || 0) > sinceMs);
    const latest = fresh.length > 0 ? fresh[fresh.length - 1].ts : (all.length > 0 ? all[all.length - 1].ts : sinceMs);
    return new Response(JSON.stringify({ events: fresh, ts: latest }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/tips?since=<ms> — DLL pulls recent tip events to award
  // bolts locally and republish on the Aquilo Bus. Same HMAC scheme as
  // the wallet endpoints; ts+\n is the signed payload for GETs. Returns
  // { tips: [...], ts } so the DLL can advance its cursor.
  if (sub === 'tips' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const all = (await env.LOADOUT_BOLTS.get('tips:' + guildId, { type: 'json' })) || [];
    const fresh = all.filter(e => (e.ts || 0) > sinceMs);
    const latest = fresh.length > 0 ? fresh[fresh.length - 1].ts : (all.length > 0 ? all[all.length - 1].ts : sinceMs);
    return new Response(JSON.stringify({ tips: fresh, ts: latest }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/profiles?since=<ms> — DLL pulls Discord-side profile
  // edits (/profile-set-bio, etc.) and merges them into its local
  // ViewerProfileStore via the wallet's identity links. Returns
  // { profiles: [{userId, profile, deleted, ts}], ts } so the DLL can
  // advance its cursor to the latest seen.
  if (sub === 'profiles' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const page = await readProfilesSince(env, guildId, sinceMs);
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/heroes — DLL pushes the dungeon hero registry
  // (DungeonGameStore) so the /loadout menu can render stream-earned
  // gear without polling the DLL on every Hero / Bag click. Body:
  //   { ts: <ms>, heroes: { "twitch:bish":  {level,xp,bag,equipped,...}, ... } }
  // Stored under d:hero-by-handle:<guild>:<platform>:<handle> so the
  // /loadout menu can resolve a Discord user → wallet → first link →
  // hero in two KV reads. The Worker's own per-Discord-user hero
  // (d:hero:<guild>:<userId>) stays as fallback for users who haven't
  // linked yet — it's the off-stream-only progression path.
  if (sub === 'heroes' && req.method === 'POST') {
    let payload; try { payload = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const heroes = payload?.heroes || {};
    let count = 0;
    for (const key of Object.keys(heroes)) {
      // key is "platform:handle" lowercase. Mirror that into the KV key.
      const safeKey = key.replace(/[^a-z0-9_:.-]/gi, '');
      if (!safeKey.includes(':')) continue;
      await env.LOADOUT_BOLTS.put('d:hero-by-handle:' + guildId + ':' + safeKey,
                                  JSON.stringify(heroes[key]));
      count++;
    }
    return new Response(JSON.stringify({ ok: true, applied: count }),
                        { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/digest — DLL posts a weekly stats snapshot here once
  // a week. We format it as a rich Discord embed and POST to the
  // configured channel via the bot token. The DLL only retries on
  // failure, so a Discord 5xx self-heals next minute.
  if (sub === 'digest' && req.method === 'POST') {
    let payload; try { payload = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const channelId = String(payload?.channelId || '').trim();
    if (!channelId) return new Response('channelId required', { status: 400 });
    const token = env.DISCORD_BOT_TOKEN;
    if (!token) return new Response('bot token not set', { status: 500 });
    const embed = buildDigestEmbed(payload);
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bot ' + token,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ embeds: [embed] })
      });
      if (!resp.ok) {
        const txt = await resp.text();
        return new Response(JSON.stringify({ ok: false, status: resp.status, body: txt.slice(0, 400) }),
                            { status: 502, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }),
                          { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
                          { status: 500, headers: { 'content-type': 'application/json' } });
    }
  }

  // /sync/:guildId/reset-wallets — streamer-initiated wipe of every
  // wallet balance + lifetime counter for the guild. Links and the
  // streamer's bot config are preserved so viewers don't need to
  // re-link after a reset. HMAC-gated by the same scheme as push/pull.
  if (sub === 'reset-wallets' && req.method === 'POST') {
    const cleared = await resetAllWallets(env, guildId);
    return new Response(JSON.stringify({ ok: true, cleared }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (req.method === 'GET') {
    const snap = await readSnapshot(env, guildId);
    return new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (req.method === 'POST') {
    let snap; try { snap = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const n = await applySnapshot(env, guildId, snap);
    return new Response(JSON.stringify({ ok: true, applied: n }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('method not allowed', { status: 405 });
}

async function handleSyncInit(req, env, guildId) {
  // After a successful claim the guild's secret is already in KV from the
  // /interactions handler. Init now is just a no-op confirmation OR
  // unlink (if body says so). Loadout calls this to confirm the binding
  // is intact, or to clear it.
  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  if (body.action === 'unlink') {
    if (body.existingSecret !== (await getSecret(env, guildId))?.secret)
      return new Response('existingSecret required', { status: 401 });
    await env.LOADOUT_BOLTS.delete('secret:' + guildId);
    await env.LOADOUT_BOLTS.delete('guildowner:' + guildId);
    return json({ ok: true, unlinked: true });
  }
  // Default: confirm.
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('not registered', { status: 404 });
  return json({ ok: true, registeredUtc: stored.registeredUtc });
}

// ---- /admin/register-commands/:guildId (HMAC) ---------------------------
// POST body: optional. Empty body is fine — the commands list is baked
// into the deployed Worker. Returns Discord's response so the caller can
// confirm the new command count.

// Verify the request via either the per-guild HMAC secret (DLL install
// path, header `x-loadout-{ts,sig}`) OR the shared site-admin
// HMAC secret (`x-aquilo-web-{ts,sig}`, AQUILO_SITE_WEB_SECRET). The
// guildId in the URL determines which per-guild secret to try; if
// that guild isn't registered, the site-admin secret is the fallback.
async function verifyAdminAuth(req, env, guildId, body) {
  // Try per-guild first (DLL-installed bots).
  const lts = req.headers.get('x-loadout-ts');
  const lsig = req.headers.get('x-loadout-sig');
  if (lts && lsig) {
    const stored = await getSecret(env, guildId);
    if (stored?.secret) {
      const ok = await verifyHmac(stored.secret, lts, body, lsig);
      if (ok) return { ok: true, via: 'guild' };
    }
  }
  // Fall back to the site-admin HMAC (the same secret /web/* uses).
  const wts = req.headers.get('x-aquilo-web-ts');
  const wsig = req.headers.get('x-aquilo-web-sig');
  if (wts && wsig && env.AQUILO_SITE_WEB_SECRET) {
    const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, wts, body, wsig);
    if (ok) return { ok: true, via: 'site' };
  }
  return { ok: false };
}

async function handleRegisterCommands(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'register-commands', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const url0 = new URL(req.url);
  const scope = (url0.searchParams.get('scope') || 'global').toLowerCase(); // 'global' | 'guild'

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature or guild not registered', { status: 401 });

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token)
    return new Response('worker not provisioned (DISCORD_APP_ID + DISCORD_BOT_TOKEN required)', { status: 503 });

  // PUT replaces the entire command set with the body. For scope=guild
  // the registration is instant; global propagates over ~1 hour.
  const url = scope === 'guild'
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS)
  });
  const text = await r.text();
  if (!r.ok)
    return new Response(JSON.stringify({ ok: false, scope, status: r.status, body: text.slice(0, 800) }),
                        { status: 502, headers: { 'content-type': 'application/json' } });

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const names = Array.isArray(parsed) ? parsed.map(c => c.name) : null;
  return new Response(JSON.stringify({
    ok: true,
    scope,
    guildId: scope === 'guild' ? guildId : null,
    registered: Array.isArray(parsed) ? parsed.length : COMMANDS.length,
    via: auth.via,
    commands: names,
    status: r.status,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ── /admin/onboarding/post-embed/:guildId (HMAC) ─────────────────────
//
// Posts the persistent welcome embed into a guild text channel from
// the admin tooling — useful when Clay isn't running the
// /onboard post-embed slash in-server.
//
// Body (JSON, optional fields):
//   { channelId?: '<snowflake>', channelName?: 'string' }
//
// Resolution order:
//   1. channelId — used verbatim, no REST lookup
//   2. channelName — first GUILD_TEXT channel whose name contains
//                     the lowercased search string (substring match)
//   3. neither    — first GUILD_TEXT channel matching any of
//                     'start-here', 'welcome', 'introductions', '👋',
//                     tried in that order
//
// Idempotent — any prior welcome message tracked at
// `onboard:welcome-msg:<g>` is deleted before posting. Re-running
// just relocates the embed.
//
// Returns:
//   { ok: true, channelId, channelName, messageId, deletedPrior }
//   { ok: false, error: '<reason>', ... }
async function handleOnboardingPostEmbed(req, env, path) {
  const parts = path.split('/').filter(Boolean);    // ['admin', 'onboarding', 'post-embed', ':guildId']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postWelcomeEmbedForGuild } = await import('./onboarding.js');
  const r = await postWelcomeEmbedForGuild(env, guildId, {
    channelId:   typeof opts.channelId   === 'string' ? opts.channelId.trim()   : undefined,
    channelName: typeof opts.channelName === 'string' ? opts.channelName.trim() : undefined,
  });
  if (!r.ok) {
    const status = r.error === 'no-channel-match' ? 404
      : r.error === 'channels-fetch-failed' || r.error === 'post-failed' ? 502
      : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/onboarding/setup-roles/:guildId (HMAC) ─────────────────
//
// Heuristically match the guild's existing roles to the six
// onboarding interest keys (see INTERESTS in onboarding.js) and
// persist the mapping at `onboard:role-map:<g>`.
//
// Body: {} (no inputs — the heuristic is fixed in code so re-running
// against the same guild always produces the same mapping for the
// same role names).
//
// Returns:
//   { ok: true, mapped: { key: { id, name } }, unmapped: [...keys],
//     roleCount }
//   { ok: false, error: '<reason>', ... }
async function handleOnboardingSetupRoles(req, env, path) {
  const parts = path.split('/').filter(Boolean);    // ['admin', 'onboarding', 'setup-roles', ':guildId']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  const { matchAndSetupGuildRoles } = await import('./onboarding.js');
  const r = await matchAndSetupGuildRoles(env, guildId);
  if (!r.ok) {
    const status = r.error === 'roles-fetch-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/onboarding/ensure-roles/:guildId (HMAC) ────────────────
//
// Create the baseline opt-in interest roles if (and only if) the
// guild doesn't already have a role satisfying the same heuristic
// for each interest key. Idempotent — re-running on a guild that
// already has matching roles returns every key under `skipped`
// with reason `already-exists`. See onboarding.js
// ensureBaselineRoles for the per-key shape.
//
// Body (JSON, optional):
//   { roles?: [{ key, name, color?, mentionable?, hoist?,
//                permissions? }] }
// Omit `roles` to use BASELINE_ROLE_SPECS (the five standard
// opt-in pings: clash, boltbound, boardgames, watching, art).
//
// Caller typically chains this with /admin/onboarding/setup-roles
// to refresh the KV mapping after creates.
//
// Returns:
//   { ok: true, created: [{ key, id, name, color }],
//     skipped: [{ key, reason, existing?, status? }], roleCount }
// ── /admin/twitch-setup/:guildId (HMAC) ─────────────────────────
//
// Create (or refresh) the Twitch EventSub subscriptions for Clay's
// broadcaster id, pointing at this worker's /twitch/eventsub URL.
// Idempotent — re-running on an already-configured guild returns
// the existing subs in the `existing` array.
//
// Body (JSON, optional):
//   { broadcasterId?, callbackUrl? }
// Both default sensibly: broadcasterId defaults to env.CLAY_TWITCH_CHANNEL_ID,
// callbackUrl defaults to env.PUBLIC_WORKER_URL + '/twitch/eventsub'
// (with the workers.dev URL as the ultimate fallback).
//
// Returns:
//   { ok: true, broadcasterId, callbackUrl,
//     created: [{ type, id, status }],
//     existing: [{ type, id, status }],
//     failed: [{ type, reason }] }
async function handleTwitchSetup(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'twitch-setup', ':guildId']
  const guildId = parts[2];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { setupTwitchSubscriptions } = await import('./twitch-eventsub.js');
  const r = await setupTwitchSubscriptions(env, opts);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── GET /asset/twitch-banner/:type[.png] ─────────────────────────
//
// Public — no auth. Type is one of the keys produced by
// build-twitch-banners.py (follow, sub-t1/2/3, gift, resub, cheer,
// raid, live, ended, hype, redemption, poll, prediction, ban,
// unban). Strips an optional `.png` suffix so the URL can be either
// /asset/twitch-banner/follow or /asset/twitch-banner/follow.png —
// the .png variant is what we put in embed image URLs because some
// CDNs sniff extension over content-type.
const TWITCH_BANNER_RE = /^\/asset\/twitch-banner\/([a-z0-9-]+?)(?:\.png)?$/;

async function handleTwitchBannerAsset(req, env, path) {
  const m = path.match(TWITCH_BANNER_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const type = m[1];
  const buf = await env.LOADOUT_BOLTS.get(`twitch-banner:${type}`, { type: 'arrayBuffer' });
  if (!buf) return new Response('banner-not-uploaded', { status: 404 });
  const headers = {
    'content-type':   'image/png',
    // Immutable + 1 year — banners are content-addressed by their
    // event-type key. To update an existing type, re-upload with
    // the same key; Discord won't fetch again until the cache
    // expires at its edge (or a fresh embed forces a re-fetch).
    'cache-control':  'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  // HEAD: same headers, no body. Some crawlers HEAD-probe before
  // pulling the body and we don't want a 404 there to poison their cache.
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── GET /asset/card-art/:cardId[.png] ────────────────────────────
//
// Public — no auth. cardId can be a dotted identifier (e.g.
// "champ.warrior", "arcane.c001", "spire.token.frost"). Strips an
// optional trailing `.png` so embed URLs can include the extension
// for picky CDNs.
//
// The regex bans path-traversal characters: only [a-z0-9.-] is
// allowed in the cardId segment, and the segment must start with
// [a-z0-9] (so an empty / `.` / `..` cardId is rejected by the
// pattern itself).
const CARD_ART_RE = /^\/asset\/card-art\/([a-z0-9][a-z0-9.\-]*?)(?:\.png)?$/;

async function handleCardArtAsset(req, env, path) {
  const m = path.match(CARD_ART_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const cardId = m[1];
  const buf = await env.LOADOUT_BOLTS.get(`pixel-art-card:${cardId}`, { type: 'arrayBuffer' });
  if (!buf) return new Response('card-art-not-uploaded', { status: 404 });
  const headers = {
    'content-type':   'image/png',
    // Year-long browser cache + edge cache. Pixel art is content-
    // addressed by cardId — a re-render uploads the same key and
    // requires a versioned URL (or a manual KV clear + edge purge)
    // to roll out faster than the cache TTL.
    'cache-control':  'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── Generic pixel-art asset router ───────────────────────────────
//
// Maps /asset/<category>/<path>.png → KV key pixel-art-<category>:<path>
// where <category> is `hero`, `gear`, `clash`, or `pet`. Path
// components are slash-separated in the URL and colon-joined in the
// KV key — matches the asset-overhaul phase taxonomy.
//
// Same caching contract as card-art: 1-year immutable + open CORS.
//
// Strict character class on path components prevents traversal /
// shell injection / wide-open lookups. We allow lowercase alpha-
// numeric + period + hyphen — enough for `champ.warrior`, `level-3`,
// etc., but no slashes/dots/dot-dot.
const PIXEL_ART_ROUTE_RE = /^\/asset\/(hero-art|gear-art|clash-art|pet-art|boltbound-ui|cardback|pack|hero-body|spire-boss|spire-map|vault)\/([A-Za-z0-9][A-Za-z0-9.\-\/]*?)(?:\.png)?$/;
const PIXEL_ART_SEG_RE   = /^[A-Za-z0-9][A-Za-z0-9.\-]*$/;
const PIXEL_ART_CATEGORY = {
  'hero-art':     'hero',
  'gear-art':     'gear',
  'clash-art':    'clash',
  'pet-art':      'pet',
  // 2026-05-30 — sprite-redesign batch namespaces. Boltbound UI
  // assets (hero frames, crystals, buttons, dropzones, bgs, chest)
  // upload to pixel-art-boltbound-ui:<head>:<rest>. Cardbacks +
  // packs are flat — pixel-art-cardback:<id> and pixel-art-pack:<id>.
  'boltbound-ui': 'boltbound-ui',
  'cardback':     'cardback',
  'pack':         'pack',
  // 2026-05-30 — paper-doll base bodies (P-A.2 cascade) +
  // Pro-Ultra-generated monthly Spire boss portraits.
  'hero-body':    'hero-body',
  'spire-boss':   'spire-boss',
  // 2026-05-30 — Spire Maps (Slay-the-Spire branching paths).
  // Keys: pixel-art-spire-map:bg:<theme>, :node:<type>, :path:<id>.
  'spire-map':    'spire-map',
  // 2026-06-02 — Aquilo's Vault cross-section art (terrain/door/rooms/
  // dwellers/crisis-fx/HUD). Keys: pixel-art-vault:<asset>. Served on a
  // short TTL while the art batch is actively being built/re-arted.
  'vault':        'vault',
};

async function handlePixelArtAsset(req, env, path) {
  const m = path.match(PIXEL_ART_ROUTE_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const category = PIXEL_ART_CATEGORY[m[1]];
  if (!category) return new Response('not-found', { status: 404 });
  // Validate every path component — guards against `..` and other
  // identifiers that slipped past the outer regex's lazy match.
  const segments = m[2].split('/');
  for (const s of segments) {
    if (!PIXEL_ART_SEG_RE.test(s)) return new Response('bad-id', { status: 400 });
  }
  const kvKey = `pixel-art-${category}:${segments.join(':')}`;
  const buf = await env.LOADOUT_BOLTS.get(kvKey, { type: 'arrayBuffer' });
  if (!buf) return new Response('art-not-uploaded', { status: 404 });
  // Clash assets are mid-aesthetic-overhaul (2026-06 warm-CoC re-tint):
  // they're re-arted in place under the SAME URL, so a year-long
  // immutable cache would pin the old cosmic-palette art on clients (the
  // same trap the card-art cache-bust hit). Serve clash art with a short
  // TTL so re-tints propagate within ~an hour without versioning every
  // site-constructed URL; everything else stays immutable (content-
  // addressed, never re-arted in place). Restore immutable for clash
  // once the overhaul lands + URLs are versioned.
  // Short cache during active aesthetic work for categories re-arted in
  // place under the same URL (clash overhaul; pack/cardback brand-fix) —
  // otherwise the year-long immutable cache pins stale bytes (the
  // card-art cache trap). Restore immutable once each stabilizes.
  // 2026-06 hero customization overhaul: hero-body (skin-tone variants) +
  // hero-art are re-uploaded in place during the build, so keep them on a
  // short TTL until the paper-doll set stabilizes, then restore immutable.
  const isShortCache = ['clash', 'pack', 'cardback', 'hero-body', 'hero', 'vault'].includes(category);
  const headers = {
    'content-type':   'image/png',
    'cache-control':  isShortCache ? 'public, max-age=3600' : 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── Boltbound FX asset route ────────────────────────────────────
// Match-polish FX live under pixel-art-boltbound:fx:<name>. The name
// segment keeps its extension (.png) — these are sprite sheets the
// match renderer slices, not the suffix-stripped per-card art.
const BOLTBOUND_FX_RE = /^\/asset\/boltbound-fx\/([A-Za-z0-9][A-Za-z0-9.\-]*)$/;

async function handleBoltboundFxAsset(req, env, path) {
  const m = path.match(BOLTBOUND_FX_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const name = m[1];
  const buf = await env.LOADOUT_BOLTS.get(`pixel-art-boltbound:fx:${name}`, { type: 'arrayBuffer' });
  if (!buf) return new Response('fx-not-uploaded', { status: 404 });
  const ext = name.toLowerCase();
  const contentType = ext.endsWith('.json') ? 'application/json'
                    : ext.endsWith('.webp') ? 'image/webp'
                    : 'image/png';
  const headers = {
    'content-type':   contentType,
    'cache-control':  'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── Boltbound arena environment route ───────────────────────────
// Backdrop + frames + critters + overlays under
// pixel-art-overlays:boltbound-arena:<name>. Short cache during the
// active aesthetic build (re-arted in place); .json manifests allowed.
const BOLTBOUND_ARENA_RE = /^\/asset\/boltbound-arena\/([A-Za-z0-9][A-Za-z0-9.\-]*)$/;

async function handleBoltboundArenaAsset(req, env, path) {
  const m = path.match(BOLTBOUND_ARENA_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const name = m[1];
  const buf = await env.LOADOUT_BOLTS.get(`pixel-art-overlays:boltbound-arena:${name}`, { type: 'arrayBuffer' });
  if (!buf) return new Response('arena-asset-not-uploaded', { status: 404 });
  const ext = name.toLowerCase();
  const contentType = ext.endsWith('.json') ? 'application/json'
                    : ext.endsWith('.webp') ? 'image/webp'
                    : 'image/png';
  const headers = {
    'content-type':   contentType,
    'cache-control':  'public, max-age=3600',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── Streamer Watchtower OBS panel ───────────────────────────────
const WATCHTOWER_RE = /^\/watchtower\/stream\/([A-Za-z0-9_]{1,40}|me)$/;

async function handleWatchtower(req, env, path) {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': '*',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method', { status: 405, headers: cors });
  }
  const m = path.match(WATCHTOWER_RE);
  if (!m) return new Response(JSON.stringify({ ok: false, error: 'bad-channel' }),
    { status: 400, headers: { 'content-type': 'application/json', ...cors } });

  let data;
  try {
    const { getWatchtowerStats } = await import('./watchtower.js');
    data = await getWatchtowerStats(env, m[1]);
  } catch (e) {
    data = { ok: false, error: 'watchtower-failed', detail: String(e?.message || e).slice(0, 120) };
  }
  const headers = {
    'content-type': 'application/json',
    // Short edge cache matches the 5s upstream cache; OBS polls freely.
    'cache-control': 'public, max-age=5',
    ...cors,
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(JSON.stringify(data), { status: data.ok ? 200 : 502, headers });
}

// ── Community-activity SSE feed ─────────────────────────────────
async function handleActivityStream(req, env, path) {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!env.ACTIVITY_DO) {
    return new Response(JSON.stringify({ ok: false, error: 'activity-do-unbound' }),
      { status: 503, headers: { 'content-type': 'application/json', ...cors } });
  }
  const id = env.ACTIVITY_DO.idFromName('global');
  const stub = env.ACTIVITY_DO.get(id);

  if (path === '/activity/sse') {
    if (req.method !== 'GET') return new Response('method', { status: 405, headers: cors });
    // Forward to the DO, preserving the abort signal so the DO can prune
    // the client when the browser disconnects.
    return stub.fetch('https://do/sse', { signal: req.signal });
  }

  // POST /activity/publish — internal producer endpoint. Gated by a
  // shared key so only the site/ops can push (in-process producers use
  // publishActivity() directly + don't hit this path).
  if (path === '/activity/publish') {
    if (req.method !== 'POST') return new Response('method', { status: 405, headers: cors });
    const key = req.headers.get('x-aquilo-activity-key') || '';
    if (!env.AQUILO_BOT_SECRET || key !== env.AQUILO_BOT_SECRET) {
      return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }),
        { status: 401, headers: { 'content-type': 'application/json', ...cors } });
    }
    const body = await req.text();
    let evt;
    try { evt = JSON.parse(body); } catch { evt = null; }
    if (!evt || !evt.kind) {
      return new Response(JSON.stringify({ ok: false, error: 'kind-required' }),
        { status: 400, headers: { 'content-type': 'application/json', ...cors } });
    }
    const { publishActivity } = await import('./activity-do.js');
    const r = await publishActivity(env, evt);
    return new Response(JSON.stringify(r),
      { status: r.ok ? 200 : 502, headers: { 'content-type': 'application/json', ...cors } });
  }
  return new Response('not-found', { status: 404, headers: cors });
}

// ── Triple-C current/pool (public, CORS) ────────────────────────
async function handleTripleCPublic(req, env, path) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', ...cors };
  try {
    if (path === '/triple-c/pool') {
      const { getTripleCPool } = await import('./triple-c.js');
      return new Response(JSON.stringify({ ok: true, pool: getTripleCPool() }), { status: 200, headers });
    }
    const { getCurrentTripleC } = await import('./triple-c.js');
    const current = await getCurrentTripleC(env);
    return new Response(JSON.stringify({ ok: true, current }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 120) }),
      { status: 500, headers });
  }
}

async function handleDadSundayPublic(req, env, path) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', ...cors };
  try {
    if (path === '/dad-sunday/pool') {
      const { getDadSundayPool } = await import('./dad-sunday.js');
      return new Response(JSON.stringify({ ok: true, pool: await getDadSundayPool(env) }), { status: 200, headers });
    }
    const { getCurrentDadSunday } = await import('./dad-sunday.js');
    const current = await getCurrentDadSunday(env);
    return new Response(JSON.stringify({ ok: true, current }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 120) }),
      { status: 500, headers });
  }
}

// Public: the "this week's lineup" embed (Triple-C + voted nights).
// Read-only preview — the pinned Discord post is driven by the Sat
// cron / the owner-gated POST /web/admin/lineup/post.
async function handleLineupPublic(req, env) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', ...cors };
  try {
    const { buildLineupEmbed } = await import('./vote-hub.js');
    const embed = await buildLineupEmbed(env, env.AQUILO_VAULT_GUILD_ID);
    return new Response(JSON.stringify({ ok: true, embed }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 160) }),
      { status: 500, headers });
  }
}

// ── Poll composite asset route ─────────────────────────────────
const POLL_COMPOSITE_RE = /^\/asset\/poll-composite\/([a-z0-9-]+?)(?:\.png)?$/;

async function handlePollCompositeAsset(req, env, path) {
  const m = path.match(POLL_COMPOSITE_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const key = m[1];
  const buf = await env.LOADOUT_BOLTS.get(`poll-composite:${key}`, { type: 'arrayBuffer' });
  if (!buf) return new Response('composite-not-uploaded', { status: 404 });
  const headers = {
    'content-type':   'image/png',
    'cache-control':  'public, max-age=86400',   // 1 day — re-renders are possible
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── /admin/polls/launch (HMAC) ──────────────────────────────────
//
// Posts both pre-defined polls (Triple-C + Variety). Body (optional):
//   { channelId?: string, closeAt?: number, replace?: bool }
// Defaults: channel `1508318929855184987`, close at unix 1780200000
// (Sun 2026-05-31 00:00 EDT). Idempotent — second call with the
// same pollIds returns `poll-exists` unless `replace: true`.
async function handlePollsLaunch(req, env) {
  const body = await req.text();
  // Auth — HMAC against AQUILO_VAULT_GUILD_ID so the standard admin
  // signer works without a per-poll guild context.
  const guildId = env.AQUILO_VAULT_GUILD_ID || '';
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const channelId = String(opts.channelId || '1508318929855184987');
  const closeAt   = Number(opts.closeAt || 1780200000);
  const replace   = !!opts.replace;
  const { createPoll, TRIPLE_C_POLL, VARIETY_POLL } = await import('./custom-polls.js');
  const r1 = await createPoll(env, { ...TRIPLE_C_POLL, channelId, closeAt, replace });
  const r2 = await createPoll(env, { ...VARIETY_POLL,  channelId, closeAt, replace });
  return jsonResp({ ok: true, channelId, closeAt, tripleC: r1, variety: r2, via: auth.via }, 200);
}

// ── /admin/_poll-launch/:token (KV-token, self-destruct) ────────
async function handlePollsLaunchBootstrap(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_poll-launch',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-poll-launch-token').catch(() => null);
  if (!stored || stored !== token) {
    return jsonResp({ ok: false, error: 'bad-token' }, 401);
  }
  // Self-destruct first so a half-completed launch can't be retried
  // by replay; if the createPoll calls fail, the operator regenerates
  // a fresh token + tries again.
  await env.LOADOUT_BOLTS.delete('bootstrap-poll-launch-token').catch(() => {});
  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const channelId = String(opts.channelId || '1508318929855184987');
  const closeAt   = Number(opts.closeAt || 1780200000);
  const replace   = !!opts.replace;
  const { createPoll, TRIPLE_C_POLL, VARIETY_POLL } = await import('./custom-polls.js');
  const r1 = await createPoll(env, { ...TRIPLE_C_POLL, channelId, closeAt, replace });
  const r2 = await createPoll(env, { ...VARIETY_POLL,  channelId, closeAt, replace });
  return jsonResp({ ok: true, channelId, closeAt, tripleC: r1, variety: r2 }, 200);
}

// ── /admin/polls/close/:pollId (HMAC) ───────────────────────────
//
// Force-close a poll early. Same auth + signing model as launch.
async function handlePollsForceClose(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','polls','close',':id']
  const pollId = parts[3];
  if (!pollId) return jsonResp({ ok: false, error: 'pollId required' }, 400);
  const body = await req.text();
  const guildId = env.AQUILO_VAULT_GUILD_ID || '';
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  const { closePollNow } = await import('./custom-polls.js');
  const r = await closePollNow(env, pollId);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
}

// ── /admin/games-menu/post/:guildId (HMAC) ───────────────────────
//
// Post or PATCH the pinned games-menu message in #games. Body
// (optional JSON):  { channelId?: '<override>' }. Returns the
// channel/message ids + whether a fresh post or in-place patch was
// done.
async function handleGamesMenuPost(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','games-menu','post',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postOrRefreshGamesMenu } = await import('./games-menu.js');
  const r = await postOrRefreshGamesMenu(env, guildId, opts);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/_clay-batch/:token (KV-token, self-destructing) ──────
//
// One-shot batch — runs four admin actions in sequence that Clay
// would otherwise need to HMAC-sign by hand:
//   1. self-roles-hub provision  (mints SF/Loadout/Rotation Updates roles)
//   2. games-menu post           (pinned menu in #games)
//   3. mc-whitelist ensure-role  (Minecraft Whitelist role)
//   4. register-commands         (PUT slash commands at guild scope)
// Returns a single response with all four results. Self-destructs.
async function handleClayBatch(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_clay-batch',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-clay-batch-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  await env.LOADOUT_BOLTS.delete('bootstrap-clay-batch-token').catch(() => {});

  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const guildId = String(opts.guildId || env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return jsonResp({ ok: false, error: 'no-guild-id' }, 400);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);

  const results = {};

  // 1. self-roles-hub provision.
  try {
    const { provisionHubRoles } = await import('./aquilo/self-roles-hub.js');
    results.selfRolesHubProvision = await provisionHubRoles(env, guildId);
  } catch (e) {
    results.selfRolesHubProvision = { ok: false, error: e?.message || String(e) };
  }

  // 2. games-menu post.
  try {
    const { postOrRefreshGamesMenu } = await import('./games-menu.js');
    results.gamesMenuPost = await postOrRefreshGamesMenu(env, guildId, {});
  } catch (e) {
    results.gamesMenuPost = { ok: false, error: e?.message || String(e) };
  }

  // 3. (Removed 2026-05-31) mc-whitelist ensure-role — Minecraft dropped
  //    as a featured offering; no whitelist role is provisioned anymore.

  // 4. Register slash commands at guild scope.
  try {
    const appId = env.DISCORD_APP_ID;
    if (!appId) {
      results.registerCommands = { ok: false, error: 'no-app-id' };
    } else {
      const r = await fetch(
        `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
        {
          method: 'PUT',
          headers: { 'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify(COMMANDS),
        });
      const text = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
      if (r.ok) {
        const names = Array.isArray(parsed) ? parsed.map(c => c.name) : null;
        results.registerCommands = { ok: true, scope: 'guild', registered: names?.length || 0, names };
      } else {
        results.registerCommands = { ok: false, error: 'discord-' + r.status, body: text.slice(0, 400) };
      }
    }
  } catch (e) {
    results.registerCommands = { ok: false, error: e?.message || String(e) };
  }

  return jsonResp({ ok: true, guildId, results }, 200);
}

// ── /admin/_gift-embed-post/:token (KV-token, self-destructing) ─
//
// Posts (or PATCHes) the Patreon gift embed + link button in a
// target channel. Two-tier idempotency:
//   1. KV `gift-embed:msg:<channelId>` → { messageId } — if present,
//      PATCH the message in place.
//   2. Fallback: list the last 50 channel messages, look for one
//      authored by this bot whose first embed title starts with
//      '🎁 Gift Aquilo Supporter Access'. If found, adopt it (PATCH
//      + record KV pointer).
//   3. Otherwise: POST fresh + pin + record KV pointer.
async function handleGiftEmbedPost(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_gift-embed-post',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-gift-embed-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  await env.LOADOUT_BOLTS.delete('bootstrap-gift-embed-token').catch(() => {});

  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const channelId = String(opts.channelId || '').trim();
  if (!/^\d{15,25}$/.test(channelId)) return jsonResp({ ok: false, error: 'bad-channel-id' }, 400);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);

  const payload = {
    embeds: [{
      title: '🎁 Gift Aquilo Supporter Access',
      description: [
        'Give a friend a paid Patreon membership and they unlock every Patreon perk across the Aquilo ecosystem — exclusive cosmetics, priority queue access, hero campaign slots, early access to new tools, and more.',
        '',
        'Free Patreon memberships work too, but paid gifts unlock everything immediately.',
      ].join('\n'),
      color: 0x7c5cff,
    }],
    components: [{
      type: 1,
      components: [{
        type:  2,
        style: 5,                 // LINK
        label: 'Gift a Membership',
        emoji: { name: '🎁' },
        url:   'https://www.patreon.com/aquilo/gift',
      }],
    }],
    allowed_mentions: { parse: [] },
  };

  const headers = {
    'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
    'Content-Type':  'application/json',
    'User-Agent':    'loadout-discord gift-embed-post',
  };

  // Step 1 — KV pointer.
  let priorMessageId = null;
  try {
    const ptr = await env.LOADOUT_BOLTS.get(`gift-embed:msg:${channelId}`, { type: 'json' });
    if (ptr?.messageId) priorMessageId = String(ptr.messageId);
  } catch { /* ignore */ }

  // Step 2 — title-match fallback (scan the last 50 messages).
  if (!priorMessageId) {
    try {
      const list = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=50`,
        { headers },
      );
      if (list.ok) {
        const arr = await list.json();
        if (Array.isArray(arr)) {
          const match = arr.find((m) =>
            m?.author?.bot &&
            Array.isArray(m.embeds) &&
            m.embeds.some((e) => String(e?.title || '').startsWith('🎁 Gift Aquilo Supporter Access')),
          );
          if (match?.id) priorMessageId = String(match.id);
        }
      }
    } catch { /* ignore */ }
  }

  // PATCH path.
  if (priorMessageId) {
    const patch = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(priorMessageId)}`,
      { method: 'PATCH', headers, body: JSON.stringify(payload) },
    );
    if (patch.ok) {
      await env.LOADOUT_BOLTS.put(`gift-embed:msg:${channelId}`,
        JSON.stringify({ messageId: priorMessageId, channelId }));
      return jsonResp({ ok: true, action: 'patched', channelId, messageId: priorMessageId }, 200);
    }
    // 404 → message deleted, fall through to fresh post.
    if (patch.status !== 404) {
      const t = await patch.text();
      return jsonResp({ ok: false, error: 'patch-failed', status: patch.status, body: t.slice(0, 300) }, 502);
    }
  }

  // POST fresh.
  const post = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST', headers, body: JSON.stringify(payload) },
  );
  if (!post.ok) {
    const t = await post.text();
    return jsonResp({ ok: false, error: 'post-failed', status: post.status, body: t.slice(0, 300) }, 502);
  }
  const msg = await post.json();
  const messageId = String(msg.id);
  await env.LOADOUT_BOLTS.put(`gift-embed:msg:${channelId}`, JSON.stringify({ messageId, channelId }));
  // Pin best-effort.
  const pin = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`,
    { method: 'PUT', headers },
  );
  return jsonResp({ ok: true, action: 'posted-new', channelId, messageId, pinned: pin.ok, pinStatus: pin.status }, 200);
}

// ── GET /asset/mc-howto/:slug[.png] ──────────────────────────────
//
// Same shape as the twitch-banner asset route — KV-backed PNG with
// a year-long immutable cache. Used by the mc-howto embed to host
// the server-logo + 2 screenshots without paying multipart-PATCH
// gymnastics on the Discord side.
const MC_HOWTO_RE = /^\/asset\/mc-howto\/([a-z0-9-]+?)(?:\.png)?$/;
async function handleMcHowtoAsset(req, env, path) {
  const m = path.match(MC_HOWTO_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const slug = m[1];
  const buf = await env.LOADOUT_BOLTS.get(`mc-howto-asset:${slug}`, { type: 'arrayBuffer' });
  if (!buf) return new Response('not-uploaded', { status: 404 });
  const headers = {
    'content-type':   'image/png',
    'cache-control':  'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── GET /asset/hero-{hair,eyes,facial}/:slug[.png] ───────────────
//
// Phase B character customization sprite layers. URL slug maps
// directly to the KV key segment:
//
//   /asset/hero-hair/male-short-tousled.png
//     → KV pixel-art-hero-hair:male-short-tousled
//   /asset/hero-eyes/round.png
//     → KV pixel-art-hero-eyes:round
//   /asset/hero-facial/beard.png
//     → KV pixel-art-hero-facial:beard
//
// Same year-long immutable cache as the other asset routes.
const HERO_LAYER_RE = /^\/asset\/hero-(hair|eyes|facial)\/([a-z0-9-]+?)(?:\.png)?$/;
async function handleHeroCustomLayerAsset(req, env, path) {
  const m = path.match(HERO_LAYER_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const kind = m[1];
  const slug = m[2];
  const kvKey = `pixel-art-hero-${kind}:${slug}`;
  const buf = await env.LOADOUT_BOLTS.get(kvKey, { type: 'arrayBuffer' });
  if (!buf) return new Response('not-uploaded', { status: 404 });
  const headers = {
    'content-type':   'image/png',
    // Short TTL during the 2026-06 customization overhaul (overlays are
    // re-uploaded in place as the set is refined); restore immutable after.
    'cache-control':  'public, max-age=3600',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── GET /asset/spire-art/{boss,backdrop,npc}/<theme>[/<role>][.png]
//
// Three slugs:
//   /asset/spire-art/boss/<theme>.png        -> pixel-art-spire-boss:<theme>
//   /asset/spire-art/backdrop/<theme>.png    -> pixel-art-spire-backdrop:<theme>
//   /asset/spire-art/npc/<theme>/<role>.png  -> pixel-art-spire-npc:<theme>:<role>
const SPIRE_RE = /^\/asset\/spire-art\/(boss|backdrop|npc)\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?(?:\.png)?$/;
async function handleSpireAsset(req, env, path) {
  const m = path.match(SPIRE_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const kind = m[1], theme = m[2], role = m[3];
  let kvKey;
  if (kind === 'npc') {
    if (!role) return new Response('npc-needs-role', { status: 400 });
    kvKey = `pixel-art-spire-npc:${theme}:${role}`;
  } else {
    kvKey = `pixel-art-spire-${kind}:${theme}`;
  }
  const buf = await env.LOADOUT_BOLTS.get(kvKey, { type: 'arrayBuffer' });
  if (!buf) return new Response('not-uploaded', { status: 404 });
  const headers = {
    'content-type':   'image/png',
    'cache-control':  'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── GET /asset/hero-bg/:id[.png] ─────────────────────────────────
const HERO_BG_RE = /^\/asset\/hero-bg\/([a-z0-9-]+?)(?:\.png)?$/;
async function handleHeroBgAsset(req, env, path) {
  const m = path.match(HERO_BG_RE);
  if (!m) return new Response('not-found', { status: 404 });
  const id  = m[1];
  const buf = await env.LOADOUT_BOLTS.get(`pixel-art-hero-bg:${id}`, { type: 'arrayBuffer' });
  if (!buf) return new Response('not-uploaded', { status: 404 });
  const headers = {
    'content-type':   'image/png',
    'cache-control':  'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'content-length': String(buf.byteLength),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(buf, { status: 200, headers });
}

// ── /admin/_mc-howto-post/:token (KV-token, idempotent) ─────────────
//
// Posts the "How to Join the Aquilo Minecraft Server" embed in a
// specified channel. KV pointer `mc-howto:msg:<channelId>` makes this
// idempotent — a second call PATCHes the existing message instead of
// posting a duplicate. Pins on first post. The token is NOT
// self-destructed so Clay can re-fire it when the missing screenshot
// attachments arrive (the second fire will PATCH with the images
// embedded).
//
// Body (optional JSON):
//   { channelId? — defaults to 1505948104208420924,
//     serverLogoUrl?,         // first attachment from Clay (server logo)
//     verifyScreenshotUrl?,   // second attachment (verification code msg)
//     dmScreenshotUrl?,       // third attachment (DM walkthrough)
//     guildId? — for pin perm; defaults to env.AQUILO_VAULT_GUILD_ID }
//
// Returns { ok, action: 'created'|'updated', channelId, messageId,
//           pinned, embeds: N }
async function handleMcHowtoBootstrap(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-mc-howto-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);

  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const channelId = String(opts.channelId || '1505948104208420924');
  const payload = buildMcHowtoMessage(opts);

  const pointerKey = `mc-howto:msg:${channelId}`;
  const existing = await env.LOADOUT_BOLTS.get(pointerKey);

  if (existing) {
    // Try PATCH first. If 404 (the message was deleted), fall through
    // to a fresh POST so the operator never lands on a dead pointer.
    const r = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${existing}`,
      { method: 'PATCH',
        headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify(payload) },
    );
    if (r.ok) {
      const j = await r.json();
      return jsonResp({ ok: true, action: 'updated', channelId,
                        messageId: j.id, embeds: payload.embeds.length });
    }
    if (r.status !== 404) {
      const txt = await r.text().catch(() => '');
      return jsonResp({ ok: false, error: 'patch-failed', status: r.status,
                        detail: txt.slice(0, 300) }, 502);
    }
    await env.LOADOUT_BOLTS.delete(pointerKey).catch(() => {});
  }

  // Fresh POST.
  const r = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(payload) },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return jsonResp({ ok: false, error: 'post-failed', status: r.status,
                      detail: txt.slice(0, 300) }, 502);
  }
  const j = await r.json();
  await env.LOADOUT_BOLTS.put(pointerKey, j.id);

  // Pin — best-effort. If the bot lacks Manage Messages in the channel
  // we surface the failure but still return ok:true on the post itself
  // so the operator knows the embed is up.
  let pinned = false;
  let pinError = null;
  try {
    const pr = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/pins/${j.id}`,
      { method: 'PUT', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } },
    );
    pinned = pr.ok;
    if (!pr.ok) pinError = `pin ${pr.status}`;
  } catch (e) { pinError = String(e?.message || e); }

  return jsonResp({ ok: true, action: 'created', channelId,
                    messageId: j.id, embeds: payload.embeds.length,
                    pinned, pinError });
}

// Build the message payload — embeds + link-button row. Pulled out so
// both POST + PATCH share the same shape and a second fire (after
// Clay drops the screenshots) re-renders with the images attached.
function buildMcHowtoMessage(opts = {}) {
  const PATREON_URL  = 'https://www.patreon.com/cw/aquilo/membership';
  const BEDROCK_URL  = 'https://www.youtube.com/watch?v=xHLHKuM1lRo';
  // /channels/@me/<botId> only resolves if a DM channel already exists
  // — first-time users get a 404 or blank screen. /users/<botId> opens
  // the bot's profile (works on desktop + mobile) which has a
  // Send Message button that mints the DM channel on click.
  const BOT_DM_URL   = 'https://discord.com/users/1503469848225775686';
  const PATREON_ROLE = '1507973875659706529';
  const MC_BOT_USER  = '1503469848225775686';
  const AURORA_GREEN = 0x5BFF95;
  const VIOLET       = 0x7C5CFF;
  const AURORA_PINK  = 0xFF6AB5;

  // Embed 1 — header + Steps 1-3. The server logo image anchors the
  // top of the message; Steps 1-3 walk through join + role-link +
  // connect. Step 4 (verify) lives in its own embeds below so the
  // screenshot sits next to its instructions.
  const mainEmbed = {
    color: AURORA_GREEN,
    title: '🟩 How to Join the Aquilo Minecraft Server',
    author: {
      name: 'Aquilo SMP',
      ...(opts.serverLogoUrl ? { icon_url: opts.serverLogoUrl } : {}),
    },
    description: [
      '**Step 1 — Become a paid Patreon supporter**',
      '',
      `Join Aquilo's Patreon as a paid member at:`,
      PATREON_URL,
      '',
      'The Aquilo Minecraft Server is permanently supporter-only. ' +
      'Any paid tier unlocks access.',
      '',
      '**Step 2 — Link your Discord to Patreon**',
      '',
      `After joining Patreon, link your Discord account to your Patreon ` +
      `to receive the **Patreon Supporter** role (<@&${PATREON_ROLE}>) ` +
      `on the aquilo.gg Discord server.`,
      '',
      '*As a member, to claim your role:*',
      '1. Log in to your Patreon account',
      '2. Go to Settings',
      '3. Click "More" (mobile) and select Connected Apps',
      '4. Find Discord and click Connect → Authorize',
      '5. Click "Join Server"',
      '',
      '**Step 3 — Connect to the server**',
      '',
      '**Java Edition:** Add `aquilo.mc.gg` to your server list and connect.',
      '',
      '**Bedrock Edition** (Xbox / PlayStation / Switch / Mobile / Windows 10): ' +
      'Watch this video for the connection walkthrough:',
      BEDROCK_URL,
    ].join('\n'),
    footer: { text: 'Questions? Open a ticket in #support' },
    ...(opts.serverLogoUrl ? { image: { url: opts.serverLogoUrl } } : {}),
  };

  // Embed 2 — Step 4 part 1: the in-game verification message screenshot
  // with copy explaining what the player will see when they connect.
  // Violet color marks the visual break from Steps 1-3.
  // Embed 3 — Step 4 part 2: the Discord DM walkthrough, aurora pink.
  // Discord allows up to 10 embeds per message — we use 3.
  const embeds = [mainEmbed];
  if (opts.verifyScreenshotUrl) {
    embeds.push({
      color: VIOLET,
      title: '🎮 Step 4 — Verify your account',
      description: 'When you first connect, you\'ll see this ' +
        'verification message in-game. The four-digit code shown is ' +
        'what you\'ll DM to the bot in the next step.',
      image: { url: opts.verifyScreenshotUrl },
    });
  }
  if (opts.dmScreenshotUrl) {
    embeds.push({
      color: AURORA_PINK,
      title: '🤖 Find aquilo.mc.gg Bot and DM the code',
      description: `Find the **aquilo.mc.gg bot** (<@${MC_BOT_USER}>) ` +
        'in the member list and DM it the four-digit code you got ' +
        'in-game. Once it confirms, you\'ll have full Minecraft access.',
      image: { url: opts.dmScreenshotUrl },
    });
  }

  // Three link buttons in a single action row. Discord component
  // type 2 = button, style 5 = link.
  const components = [{
    type: 1,
    components: [
      { type: 2, style: 5, label: 'Join Patreon',        emoji: { name: '🟣' }, url: PATREON_URL },
      { type: 2, style: 5, label: 'Bedrock setup video', emoji: { name: '📺' }, url: BEDROCK_URL },
      { type: 2, style: 5, label: 'Open Bot Profile',    emoji: { name: '🤖' }, url: BOT_DM_URL  },
    ],
  }];

  return { embeds, components };
}

// ── /admin/_support-panel-post/:token (KV-token, self-destructing) ──
async function handleSupportPanelBootstrap(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_support-panel-post',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-support-panel-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  await env.LOADOUT_BOLTS.delete('bootstrap-support-panel-token').catch(() => {});
  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const guildId = String(opts.guildId || env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return jsonResp({ ok: false, error: 'no-guild-id' }, 400);
  const { postOrRefreshSupportPanel } = await import('./support-tickets.js');
  const r = await postOrRefreshSupportPanel(env, guildId, opts);
  return jsonResp({ ...r }, r.ok ? 200 : 400);
}

// ── /admin/support-tickets/post-panel/:guildId (HMAC) ──────────
async function handleSupportTicketsPostPanel(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','support-tickets','post-panel',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postOrRefreshSupportPanel } = await import('./support-tickets.js');
  const r = await postOrRefreshSupportPanel(env, guildId, opts);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
}

// ── /admin/_rewards-bootstrap/:token (KV-token, self-destructing) ──
//
// One-shot helper that fires three things in sequence so Clay's
// operator can launch the Twitch-rewards feature from a single
// token-gated call:
//   1. Resolve the `live` channel binding to learn its Discord
//      parent_id; create a fresh #rewards text channel under that
//      same category, with @everyone read+history-allow + send-deny
//      and the spec'd topic copy.
//   2. setChannelBinding(twitch-rewards-feed) to the new channel.
//   3. ensureRewardRoles to provision the three "Twitch Sub" /
//      "Twitch Sub T2" / "Twitch Sub T3" Discord roles.
// Returns { channelId, parentId, roleIds:{1000, 2000, 3000}, bindings,
// roleProvisioning }.
//
// Body (optional JSON):
//   { guildId? — defaults to env.AQUILO_VAULT_GUILD_ID,
//     channelName? — defaults to '🎁│rewards' }
async function handleRewardsBootstrap(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_rewards-bootstrap',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-rewards-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  await env.LOADOUT_BOLTS.delete('bootstrap-rewards-token').catch(() => {});

  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const guildId = String(opts.guildId || env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return jsonResp({ ok: false, error: 'no-guild-id' }, 400);
  const channelName = String(opts.channelName || '🎁│rewards').slice(0, 100);

  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);

  // Step 1 — learn the parent_id of the live-now channel so the new
  // channel sits in the same notifications-style category. Falls back
  // to no parent if anything goes sideways.
  let parentId = null;
  try {
    const { getChannelBinding } = await import('./channel-bindings.js');
    const liveChannelId = await getChannelBinding(env, guildId, 'live');
    if (liveChannelId) {
      const lr = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(liveChannelId)}`, {
        headers: { 'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord rewards-bootstrap' },
      });
      if (lr.ok) {
        const lj = await lr.json();
        if (lj?.parent_id) parentId = String(lj.parent_id);
      }
    }
  } catch (e) {
    console.warn('[rewards-bootstrap] parent lookup', e?.message || e);
  }

  // Step 2 — create the channel. Permission overwrites:
  //   @everyone   allow: VIEW_CHANNEL (0x400) | READ_MESSAGE_HISTORY (0x10000) | ADD_REACTIONS (0x40)
  //               deny:  SEND_MESSAGES (0x800)
  // Bot's app role bypasses send-deny via Manage Channels grant.
  const VIEW = 0x400, SEND = 0x800, HISTORY = 0x10000, ADD_REACT = 0x40;
  const everyoneOverwrite = {
    id:    guildId,
    type:  0,                  // role
    allow: String(VIEW | HISTORY | ADD_REACT),
    deny:  String(SEND),
  };
  const createBody = {
    name:                 channelName,
    type:                 0,    // GUILD_TEXT
    topic:                'Bolts + perks earned by Patreon-linked viewers via Twitch follows, subs, cheers, and raids. Link your accounts on aquilo.gg to unlock these.',
    parent_id:            parentId,
    permission_overwrites: [everyoneOverwrite],
  };
  const cr = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
    method:  'POST',
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord rewards-bootstrap',
    },
    body: JSON.stringify(createBody),
  });
  if (!cr.ok) {
    const t = await cr.text();
    return jsonResp({ ok: false, error: 'channel-create-failed', status: cr.status, body: t.slice(0, 400) }, 502);
  }
  const channel = await cr.json();
  const channelId = String(channel.id);

  // Step 3 — bind.
  const { setChannelBinding } = await import('./channel-bindings.js');
  const bindResult = await setChannelBinding(env, guildId, 'twitch-rewards-feed', channelId);

  // Step 4 — provision the three Twitch Sub roles.
  const { ensureRewardRoles } = await import('./twitch-rewards.js');
  const roleResult = await ensureRewardRoles(env, guildId);

  return jsonResp({
    ok:           true,
    channelId,
    parentId,
    channelName:  channel.name,
    bindings:     bindResult,
    roleProvisioning: roleResult,
  }, 200);
}

// ── Twitch reward roles admin ────────────────────────────────────
async function handleTwitchRewardsEnsureRoles(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','twitch-rewards','ensure-roles',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  const { ensureRewardRoles } = await import('./twitch-rewards.js');
  const r = await ensureRewardRoles(env, guildId);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
}

// ── /admin/_mc-role-delete/:token (KV-token, self-destructing) ────
// One-shot removal of the "Minecraft Whitelist" role (Clay dropped
// Minecraft as a featured offering, 2026-05-31). Token written via
// `wrangler kv key put bootstrap-mc-role-delete-token <value>`;
// self-destructs on first use. Deletes the role by its KV-stored id +
// any role matching the canonical name, and clears the KV id key.
// Optional body { roleId } forces deletion of a specific snowflake.
async function handleMcRoleDelete(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_mc-role-delete',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-mc-role-delete-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  // Self-destruct first so a replay can't re-run it.
  await env.LOADOUT_BOLTS.delete('bootstrap-mc-role-delete-token').catch(() => {});
  let opts = {};
  const body = await req.text();
  if (body) { try { opts = JSON.parse(body) || {}; } catch { /* ignore */ } }
  const guildId = String(opts.guildId || env.AQUILO_VAULT_GUILD_ID || '');
  if (!guildId) return jsonResp({ ok: false, error: 'no-guild' }, 400);
  const { deleteWhitelistRole } = await import('./mc-whitelist.js');
  const r = await deleteWhitelistRole(env, guildId, { roleId: opts.roleId });
  return jsonResp(r, r.ok ? 200 : 400);
}

// ── /admin/_card-art-bulk-set/:token (KV-token, self-destructing) ─
//
// Used by tools/backfill-card-art.mjs to write the global-art map for
// all cards in a single trip. Auth = one-shot KV bootstrap token
// (`bootstrap-card-art-token`). Self-destructs on first hit; if the
// run partially fails the operator regenerates a fresh token + retries
// only the unset cards (default behaviour is skip-already-set unless
// body opts.force=true).
//
// Body (JSON):
//   { items: [{ cardId, url, searchTerm?, contentLength?, source? }, ...],
//     force?: boolean }
//
// Returns { ok, set, skipped, failed: [...] }.
async function handleCardArtBulkSetBootstrap(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_card-art-bulk-set',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-card-art-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  await env.LOADOUT_BOLTS.delete('bootstrap-card-art-token').catch(() => {});

  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const items = Array.isArray(opts.items) ? opts.items : [];
  if (!items.length) return jsonResp({ ok: false, error: 'items-required' }, 400);
  const { bulkSetGlobalArt } = await import('./cards-global-art.js');
  const r = await bulkSetGlobalArt(env, items, { force: !!opts.force });
  return jsonResp(r, r.ok ? 200 : 400);
}

// ── /admin/_card-art-backfill/:token (KV-token, repeatable) ────
//
// Slice processor. Body (optional JSON):
//   { offset?: number, limit?: number, force?: boolean }
// Default limit is 25 (card-art-backfill.js DEFAULT_LIMIT). The
// token gate compares against KV `bootstrap-card-art-backfill-token`
// but does NOT consume it on success — operator runs many slices in
// a loop, then deletes the token themselves once `done: true`.
async function handleCardArtBackfillSlice(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_card-art-backfill',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-card-art-backfill-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const url = new URL(req.url);
  if (url.searchParams.has('offset')) opts.offset = parseInt(url.searchParams.get('offset'), 10);
  if (url.searchParams.has('limit'))  opts.limit  = parseInt(url.searchParams.get('limit'),  10);
  if (url.searchParams.has('force'))  opts.force  = url.searchParams.get('force') === '1';
  const { runCardArtBackfillSlice } = await import('./card-art-backfill.js');
  const r = await runCardArtBackfillSlice(env, opts);
  return jsonResp(r, r.ok ? 200 : 400);
}

// ── /admin/_card-art-backup/:token (KV-token, repeatable) ────────
//
// Snapshots every global-card-art:* entry to
// global-card-art-backup-gifs-<date>:* so the pixel-art overhaul
// can overwrite the live map without losing the Giphy GIF assignments.
// Idempotent — skips entries that already have a backup record.
async function handleCardArtBackup(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_card-art-backup',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-card-art-backup-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);

  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const dateTag = String(opts.dateTag || new Date().toISOString().slice(0, 10));   // YYYY-MM-DD
  const backupPrefix = `global-card-art-backup-gifs-${dateTag}:`;
  const sourcePrefix = 'global-card-art:';

  let cursor;
  let copied = 0, skipped = 0, scanned = 0, failed = 0;
  for (let i = 0; i < 12; i++) {
    const page = await env.LOADOUT_BOLTS.list({ prefix: sourcePrefix, cursor });
    for (const k of (page.keys || [])) {
      scanned++;
      const cardId = String(k.name || '').slice(sourcePrefix.length);
      const backupKey = backupPrefix + cardId;
      // Skip if already backed up under this dateTag.
      const existing = await env.LOADOUT_BOLTS.get(backupKey);
      if (existing) { skipped++; continue; }
      const src = await env.LOADOUT_BOLTS.get(k.name);
      if (!src) { failed++; continue; }
      try {
        await env.LOADOUT_BOLTS.put(backupKey, src);
        copied++;
      } catch (e) { failed++; }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return jsonResp({ ok: true, dateTag, scanned, copied, skipped, failed,
                    sourcePrefix, backupPrefix });
}

// ── /admin/_twitch-token-validate/:token + /admin/_twitch-setup-debug/:token
//
// Diagnostics for the 2026-05-29 EventSub fail-everything case.
// Token-gated (matches `bootstrap-twitch-diag-token` in KV).
async function handleTwitchTokenValidate(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-twitch-diag-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  const { validateUserToken } = await import('./twitch-helix.js');
  const v = await validateUserToken(env);
  const REQUIRED = [
    'moderator:read:followers', 'channel:read:subscriptions', 'bits:read',
    'channel:read:redemptions', 'channel:read:hype_train', 'channel:read:polls',
    'channel:read:predictions', 'channel:moderate',
  ];
  const granted = new Set(Array.isArray(v.scopes) ? v.scopes : []);
  const missing = REQUIRED.filter(s => !granted.has(s));
  return jsonResp({ ok: v.ok, validate: v, requiredScopes: REQUIRED,
                    grantedScopes: [...granted], missingScopes: missing });
}

async function handleTwitchSetupDebug(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-twitch-diag-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  let opts = {};
  try {
    const body = await req.text();
    if (body) opts = JSON.parse(body) || {};
  } catch { /* swallow */ }
  const { setupTwitchSubscriptions } = await import('./twitch-eventsub.js');
  const r = await setupTwitchSubscriptions(env, opts);
  return jsonResp(r);
}

// ── /admin/_card-art-wipe/:token (KV-token, idempotent) ──────────
//
// Wipes every global-card-art:* entry. Clay's directive (2026-05-29)
// after going all-in on pixel art — the Giphy backfill is no longer
// the render default. Keeps the dated backup under
// global-card-art-backup-gifs-<date>:* (different prefix) untouched
// for the audit trail.
//
// IMPORTANT: also fixed a latent bug — the earlier `listAllGlobalArt`
// in cards-global-art.js did 515 sequential KV reads on every
// /web/boltbound/state call, which is what was breaking the live
// Boltbound bootstrap once the Giphy backfill loaded the prefix.
// The fn is now parallelised at 20-concurrency; this wipe + parallel
// listing together restore the bootstrap. Token NOT self-destructed
// — a second call is a no-op.
async function handleCardArtWipe(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_card-art-wipe',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-card-art-wipe-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);

  const { bulkDeleteAllGlobalArt } = await import('./cards-global-art.js');
  const r = await bulkDeleteAllGlobalArt(env);
  return jsonResp({ ok: true, deleted: r.deleted, pages: r.pages,
                    sourcePrefix: 'global-card-art:',
                    note: 'backup at global-card-art-backup-gifs-* prefix is untouched' });
}

// ── /admin/_card-art-summary/:token (KV-token, one-shot) ─────────
//
// Posts a Boltbound card-art backfill summary embed to the admin
// hub channel (defaults to env.AQUILO_ADMIN_HUB_CHANNEL_ID, can be
// overridden via body {channelId}). Self-destructing token.
//
// Embed shape:
//   • Totals — backfilled / catalogue / coverage %
//   • Source breakdown — giphy / manual-remix / other
//   • Top-N (default 20) sample rows: cardName → preview thumb url
//
// Body (optional JSON): { channelId?, sampleSize? }
async function handleCardArtSummaryBootstrap(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_card-art-summary',':token']
  const token = parts[2];
  if (!token) return jsonResp({ ok: false, error: 'token required' }, 400);
  const stored = await env.LOADOUT_BOLTS.get('bootstrap-card-art-summary-token').catch(() => null);
  if (!stored || stored !== token) return jsonResp({ ok: false, error: 'bad-token' }, 401);
  await env.LOADOUT_BOLTS.delete('bootstrap-card-art-summary-token').catch(() => {});

  let opts = {};
  const body = await req.text();
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const channelId = String(opts.channelId || env.AQUILO_ADMIN_HUB_CHANNEL_ID || '').trim();
  if (!channelId) return jsonResp({ ok: false, error: 'no-channel-id' }, 400);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  const sampleSize = Math.max(1, Math.min(20, parseInt(opts.sampleSize || 20, 10) || 20));

  const { CARDS } = await import('./cards-content.js');
  const totalCatalogue = Object.keys(CARDS).length;

  // Walk the full global-card-art KV prefix to collect records (not
  // just URLs — we want source + searchTerm + cardName).
  const records = [];
  let cursor;
  for (let i = 0; i < 12; i++) {
    const page = await env.LOADOUT_BOLTS.list({ prefix: 'global-card-art:', cursor });
    for (const k of (page.keys || [])) {
      const cardId = String(k.name || '').slice('global-card-art:'.length);
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (rec?.memeGifUrl) {
        records.push({
          cardId,
          cardName: CARDS[cardId]?.name || cardId,
          url:        rec.memeGifUrl,
          searchTerm: rec.searchTerm || null,
          source:     rec.source     || null,
          updatedAt:  rec.updatedAt  || null,
        });
      }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }

  const totalBackfilled = records.length;
  const missingCount    = Math.max(0, totalCatalogue - totalBackfilled);
  const coveragePct     = totalCatalogue
    ? (totalBackfilled / totalCatalogue * 100).toFixed(1)
    : '0.0';

  const sources = {};
  for (const r of records) {
    const s = r.source || 'unknown';
    sources[s] = (sources[s] || 0) + 1;
  }
  const sourceLines = Object.entries(sources)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `\`${s}\`: ${n}`)
    .join(' · ') || 'none';

  // Sample — pick the most recent N (rough proxy for "freshest" choices).
  const sample = [...records]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, sampleSize);
  const sampleLines = sample.map((r, i) =>
    `${i + 1}. **${r.cardName}** \`${r.cardId}\`\n   ↳ term: \`${r.searchTerm || '?'}\` · [preview](${r.url})`
  ).join('\n');

  const embed = {
    title: '🎴 Boltbound card-art backfill — summary',
    color: 0x9b6cff,
    description:
      `**${totalBackfilled} / ${totalCatalogue}** cards have global default art.  ` +
      `Coverage: **${coveragePct}%** · Missing: **${missingCount}**`,
    fields: [
      { name: 'By source',       value: sourceLines, inline: false },
      { name: `Sample (latest ${sample.length})`, value: sampleLines.slice(0, 1024) || '—', inline: false },
    ],
    footer: { text: 'Mismatches? /admin card-art remix card-id:<id> shows 5 fresh candidates.' },
    timestamp: new Date().toISOString(),
  };

  // Post to the configured channel via bot REST.
  const postUrl = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const r = await fetch(postUrl, {
    method:  'POST',
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
  });
  if (!r.ok) {
    const text = await r.text();
    return jsonResp({ ok: false, error: 'discord-' + r.status, body: text.slice(0, 400) }, 502);
  }
  const msg = await r.json();
  return jsonResp({
    ok: true,
    channelId,
    messageId: msg?.id || null,
    totalBackfilled, totalCatalogue, missingCount, coveragePct,
    sources,
  });
}

// ── /admin/card-art/list (HMAC, read) ────────────────────────────
async function handleCardArtList(req, env) {
  const body = '';
  const auth = await verifyAdminAuth(req, env, '', body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  const { listAllGlobalArt } = await import('./cards-global-art.js');
  const map = await listAllGlobalArt(env);
  return jsonResp({ ok: true, count: Object.keys(map).length, globalArt: map, via: auth.via });
}

// ── /admin/card-art/set (HMAC) ───────────────────────────────────
async function handleCardArtSet(req, env) {
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, '', body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const { setGlobalArt } = await import('./cards-global-art.js');
  const r = await setGlobalArt(env, opts.cardId, opts);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
}

// ── /admin/card-art/clear (HMAC) ─────────────────────────────────
async function handleCardArtClear(req, env) {
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, '', body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const { clearGlobalArt } = await import('./cards-global-art.js');
  const r = await clearGlobalArt(env, opts.cardId);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
}

// ── /admin/counting/clear-shame-role/:guildId (HMAC) ─────────────
//
// Scans the guild's member list, finds anyone with the shame role
// id stored at `counting:fail_role_id:<g>`, removes the role.
// Idempotent on a clean guild. Returns `{ ok, roleId, scanned,
// removed, failed: [...] }`. If a removal fails for a specific
// user the response still 200s; the operator inspects `failed[]`.
async function handleCountingClearShameRole(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','counting','clear-shame-role',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  const { clearStuckShameRoles } = await import('./aquilo/counting.js');
  const r = await clearStuckShameRoles(env, guildId);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/twitch-eventsub/list/:guildId (HMAC) ─────────────────
async function handleTwitchEventsubList(req, env, path) {
  const parts = path.split('/').filter(Boolean);     // ['admin','twitch-eventsub','list',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  const { listTwitchSubscriptions } = await import('./twitch-eventsub.js');
  const r = await listTwitchSubscriptions(env);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  return jsonResp({ ...r, via: auth.via }, 200);
}

async function handleOnboardingEnsureRoles(req, env, path) {
  const parts = path.split('/').filter(Boolean);    // ['admin', 'onboarding', 'ensure-roles', ':guildId']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { ensureBaselineRoles } = await import('./onboarding.js');
  const r = await ensureBaselineRoles(env, guildId, opts.roles);
  if (!r.ok) {
    const status = r.error === 'roles-fetch-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/level-tier-roles/ensure/:guildId (HMAC) ────────────────
//
// Create the four level-tier roles (Apprentice/Veteran/Elite/Mythic)
// + persist the {key:roleId} map at `level-tier-roles:<g>`.
// Idempotent — reuses existing roles when name OR mapped-id matches.
async function handleLevelTierRolesEnsure(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','level-tier-roles','ensure',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  const { ensureLevelTierRoles } = await import('./level-tier-roles.js');
  const r = await ensureLevelTierRoles(env, guildId);
  if (!r.ok) {
    const status = r.error === 'roles-fetch-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/level-tier-roles/backfill/:guildId (HMAC) ──────────────
//
// One-time-per-guild grant pass: for every pxp:<userId> record,
// grant the tier roles the user has already earned. Idempotent
// (KV marker — pass `{ force: true }` body to re-scan).
async function handleLevelTierRolesBackfill(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','level-tier-roles','backfill',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { backfillLevelTierRoles } = await import('./level-tier-roles.js');
  const r = await backfillLevelTierRoles(env, guildId, opts);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/schedule-msg/:guildId/[:id] (HMAC) ─────────────────────
//
// Four CRUD endpoints unified under one path prefix so they share
// the auth flow + JSON-body handling. Route by (method, has-id):
//   POST   /admin/schedule-msg/:g          create
//   GET    /admin/schedule-msg/:g          list (upcoming + recent)
//   POST   /admin/schedule-msg/:g/:id      edit (pending only)
//   DELETE /admin/schedule-msg/:g/:id      cancel (pending only)
//
// Body for POST/PATCH-style routes is required + must parse as
// JSON. GET has no body but still HMAC-verified against empty string
// (matches the existing verifyAdminAuth convention).
async function handleScheduleMsg(req, env, path, method) {
  const parts = path.split('/').filter(Boolean);   // ['admin','schedule-msg',':g',':id'?]
  const guildId = parts[2];
  const id      = parts[3] || null;
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const mod = await import('./scheduled-messages.js');

  if (method === 'POST' && !id) {
    const r = await mod.createScheduled(env, guildId, opts, opts.createdBy || auth.via);
    return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
  }
  if (method === 'GET' && !id) {
    const r = await mod.listScheduled(env, guildId, opts.limit);
    return jsonResp({ ...r, via: auth.via }, 200);
  }
  if (method === 'POST' && id) {
    const r = await mod.editScheduled(env, guildId, id, opts);
    const status = !r.ok && r.error === 'not-found' ? 404
      : !r.ok && r.error === 'not-pending' ? 409
      : r.ok ? 200 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  if (method === 'DELETE' && id) {
    const r = await mod.cancelScheduled(env, guildId, id);
    const status = !r.ok && r.error === 'not-found' ? 404
      : !r.ok && r.error === 'already-sent' ? 409
      : r.ok ? 200 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ok: false, error: 'method-or-path-not-supported', method, path }, 405);
}

// ── /admin/hubs/post/:guildId/:key (HMAC) ────────────────────────
//
// Unified post-hub endpoint for the phase-1 channel hubs. Key must
// be one of channel-hubs.HUB_KEYS (checkin / character / bolts /
// play / achievements). Body: { channelId?, channelName? } — same
// channel-discovery contract as the other post-hub routes.
async function handleChannelHubPost(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['admin','hubs','post',':g',':key']
  const guildId = parts[3];
  const key     = parts[4];
  if (!guildId || !key) return jsonResp({ ok: false, error: 'guildId and hub key required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postHubForGuild, HUB_KEYS } = await import('./channel-hubs.js');
  if (!HUB_KEYS.includes(key)) {
    return jsonResp({ ok: false, error: 'unknown-hub-key', allowed: HUB_KEYS }, 400);
  }
  const r = await postHubForGuild(env, guildId, key, {
    channelId:   typeof opts.channelId   === 'string' ? opts.channelId.trim()   : undefined,
    channelName: typeof opts.channelName === 'string' ? opts.channelName.trim() : undefined,
  });
  if (!r.ok) {
    const status = r.error === 'no-channel-match' ? 404
      : r.error === 'channels-fetch-failed' || r.error === 'post-failed' ? 502
      : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/cn-games-list/post-hub/:guildId (HMAC) ───────────────
async function handleCnGamesListPostHub(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['admin','cn-games-list','post-hub',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postGamesListHubForGuild } = await import('./cn-games-list-hub.js');
  const r = await postGamesListHubForGuild(env, guildId, {
    channelId:   typeof opts.channelId   === 'string' ? opts.channelId.trim()   : undefined,
    channelName: typeof opts.channelName === 'string' ? opts.channelName.trim() : undefined,
  });
  if (!r.ok) {
    const status = r.error === 'no-channel-match' ? 404
      : r.error === 'channels-fetch-failed' || r.error === 'post-failed' ? 502
      : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── Vote-hub admin routes ────────────────────────────────────────

async function handleVoteHubPostHub(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','vote-hub','post-hub',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postVoteHubForGuild } = await import('./vote-hub.js');
  const r = await postVoteHubForGuild(env, guildId, {
    channelId: typeof opts.channelId === 'string' ? opts.channelId.trim() : undefined,
  });
  if (!r.ok) {
    const status = r.error === 'no-vote-channel' ? 404 : r.error === 'post-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

async function handleVoteHubConfig(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['admin','vote-hub','config',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { setConfig, getConfig } = await import('./vote-hub.js');
  // GET-style read when no opts passed.
  if (!opts || Object.keys(opts).length === 0) {
    return jsonResp({ ok: true, config: await getConfig(env, guildId), via: auth.via }, 200);
  }
  const r = await setConfig(env, guildId, opts);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  return jsonResp({ ...r, via: auth.via }, 200);
}

async function handleVaultPostActions(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','vault','post-actions',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postActionsHubForGuild } = await import('./vault-hub.js');
  const r = await postActionsHubForGuild(env, guildId, {
    channelId: typeof opts.channelId === 'string' ? opts.channelId.trim() : undefined,
  });
  if (!r.ok) {
    const status = r.error === 'no-vault-actions-channel' ? 404 : r.error === 'post-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

async function handleVoteHubRetireLegacy(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  const { retireOldCnVoteHub } = await import('./vote-hub.js');
  const r = await retireOldCnVoteHub(env, guildId);
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/cn-vote/post-hub/:guildId (HMAC) ─────────────────────
async function handleCnVotePostHub(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','cn-vote','post-hub',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postCnVoteHubForGuild } = await import('./cn-vote-hub.js');
  const r = await postCnVoteHubForGuild(env, guildId, {
    channelId: typeof opts.channelId === 'string' ? opts.channelId.trim() : undefined,
  });
  if (!r.ok) {
    const status = r.error === 'no-channel-match' ? 404 : r.error === 'post-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/aquilo/refresh-schedule/:guildId (HMAC) ──────────────
//
// Trigger postOrRefreshSchedule. When the schedule channel binding
// has just flipped, the function detects the channel-mismatch on
// the stored sched.channel_id, deletes the prior message in the
// OLD channel, and posts fresh in the NEW channel. Returns the
// new message id.
async function handleAquiloRefreshSchedule(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['admin','aquilo','refresh-schedule',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  try {
    const { postOrRefreshSchedule } = await import('./aquilo/aq-schedule.js');
    const messageId = await postOrRefreshSchedule(env, guildId);
    return jsonResp({ ok: true, messageId, via: auth.via }, 200);
  } catch (e) {
    return jsonResp({ ok: false, error: String(e?.message || e), via: auth.via }, 502);
  }
}

// ── /admin/channels/bind/:guildId (HMAC) ─────────────────────────
//
// Body { binding, channelId } — binding ∈ {queue, live, recap, clips, lfg}.
// channelId="" clears the binding so the env fallback re-engages.
// Returns the resolved value after the write.
async function handleChannelsBind(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','channels','bind',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { setChannelBinding, getChannelBinding } = await import('./channel-bindings.js');
  const r = await setChannelBinding(env, guildId, opts.binding, opts.channelId);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  const resolved = await getChannelBinding(env, guildId, opts.binding);
  return jsonResp({ ...r, resolved, via: auth.via }, 200);
}

// ── /admin/channels/list/:guildId (HMAC) ─────────────────────────
//
// Status view for the admin UI: for every binding key, the KV
// override, env fallback, and effective resolved value. Surfaces
// "is this rebound or still on env" at a glance.
async function handleChannelsList(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','channels','list',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const auth = await verifyAdminAuth(req, env, guildId, '');
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  const { listChannelBindings } = await import('./channel-bindings.js');
  const bindings = await listChannelBindings(env, guildId);
  return jsonResp({ ok: true, bindings, via: auth.via }, 200);
}

// ── /admin/lfg/post-hub/:guildId (HMAC) ──────────────────────────
//
// Drop the persistent LFG hub embed into a channel. Resolution
// matches /admin/onboarding/post-embed: explicit channelId →
// explicit channelName → channel-binding(lfg) → name-hint match.
async function handleLfgPostHub(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','lfg','post-hub',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postLfgHubForGuild } = await import('./lfg-hub.js');
  const r = await postLfgHubForGuild(env, guildId, {
    channelId:   typeof opts.channelId   === 'string' ? opts.channelId.trim()   : undefined,
    channelName: typeof opts.channelName === 'string' ? opts.channelName.trim() : undefined,
  });
  if (!r.ok) {
    const status = r.error === 'no-channel-match' ? 404
      : r.error === 'channels-fetch-failed' || r.error === 'post-failed' ? 502
      : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/printerbot/setup/:guildId (HMAC) ───────────────────────
// Body (JSON): { channelId: '<snowflake>', name?: 'PrinterBot' }
// Creates or reuses a channel-scoped Discord webhook + persists the
// URL at printerbot:webhook-url:<g>. Returns the full webhook URL so
// the operator can paste it into Streamer.bot once.
async function handlePrinterBotSetup(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','printerbot','setup',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const channelId = typeof opts.channelId === 'string' ? opts.channelId.trim() : '';
  const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim() : 'PrinterBot';
  if (!channelId) return jsonResp({ ok: false, error: 'channelId required' }, 400);

  const { ensurePrinterBotWebhook } = await import('./printerbot.js');
  const r = await ensurePrinterBotWebhook(env, guildId, channelId, name);
  if (!r.ok) {
    const status =
      r.error === 'webhooks-list-failed' || r.error === 'create-failed'
        ? (Number(r.status) || 502)
        : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/printerbot/webhook-url/:guildId (HMAC, read) ───────────
// Returns the stored URL + metadata. HMAC-gated because the token in
// the URL grants posting rights to the channel.
async function handlePrinterBotWebhookUrl(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','printerbot','webhook-url',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const auth = await verifyAdminAuth(req, env, guildId, '');
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  const { readPrinterBotWebhook } = await import('./printerbot.js');
  const rec = await readPrinterBotWebhook(env, guildId);
  if (!rec) return jsonResp({ ok: false, error: 'not-set', via: auth.via }, 404);
  return jsonResp({ ok: true, ...rec, via: auth.via }, 200);
}

// ── /admin/reset-user-data/:guildId (HMAC, DESTRUCTIVE) ───────────
// Body (JSON): { confirm: "yes-i-mean-it" }
// Wipes wallet:<g>:*, community-checkin:<g>:*, community-checkin-bonus:<g>:*,
// freeze:<g>:*, and (global) pxp:*. Preserves character/referral/admin
// config — see reset-user-data.js for the full preserve list.
async function handleResetUserData(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','reset-user-data',':g']
  const guildId = parts[2];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  if (opts.confirm !== 'yes-i-mean-it') {
    return jsonResp({
      ok: false, error: 'confirm-required',
      hint: 'POST { "confirm": "yes-i-mean-it" } — this destroys economy + progression state.',
    }, 400);
  }
  const { resetUserData } = await import('./reset-user-data.js');
  const r = await resetUserData(env, guildId, opts);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
}

// ── /admin/counting/purge-bot-messages/:guildId (HMAC) ────────────
// Query: ?since=<unix-seconds>  (optional lower bound; omit = scan
// the whole 14-day window Discord bulk-delete allows).
async function handleCountingPurgeBotMessages(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','counting','purge-bot-messages',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  // Resolve the counting channel: env COUNTING_CHANNEL_ID first
  // (single source of truth for this guild today). Body can override
  // with { channelId: '...' } for guilds where Clay binds it elsewhere.
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const channelId = String(opts.channelId || env.COUNTING_CHANNEL_ID || '').trim();
  if (!channelId) return jsonResp({ ok: false, error: 'no-counting-channel' }, 400);
  const url0 = new URL(req.url);
  const sinceSec = parseInt(url0.searchParams.get('since') || '0', 10) || 0;
  const sinceMs = sinceSec ? sinceSec * 1000 : 0;
  const { purgeBotMessages } = await import('./counting-purge.js');
  const r = await purgeBotMessages(env, channelId, { sinceMs });
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
}

// ── /admin/rules/rebuild/:guildId (HMAC) ──────────────────────────
// Body: { channelId,
//         body?        — plain-text rules (used when embed is omitted),
//         embed?       — Discord embed object (title, description, color, ...),
//         withVerify?: true — append a ✅ Verify button row (custom_id: guild:verify)
//       }
//
// Resolution:
//   1. Delete the prior rules post tracked at rules:msg:<g>
//      (preferred — that's our own stamp, no scan needed)
//   2. ELSE scan recent messages and delete the first bot/webhook
//      TEXT message (no image attachment, content > 20 chars)
//   3. Post the new body or embed (+ optional Verify button)
//   4. Stamp the new id at rules:msg:<g>
async function handleRulesRebuild(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const channelId = String(opts.channelId || '').trim();
  if (!channelId) return jsonResp({ ok: false, error: 'channelId required' }, 400);
  if (!opts.body && !opts.embed) {
    return jsonResp({ ok: false, error: 'body or embed required' }, 400);
  }

  const H = { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN };

  // 1) Delete the prior tracked post if we have its id stamped
  let deletedId = null;
  const stampKey = `rules:msg:${guildId}`;
  const stamp = await env.LOADOUT_BOLTS.get(stampKey, { type: 'json' });
  if (stamp && stamp.messageId && stamp.channelId === channelId) {
    const del = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${stamp.messageId}`,
      { method: 'DELETE', headers: H });
    if (del.ok || del.status === 204 || del.status === 404) deletedId = stamp.messageId;
  } else {
    // 2) No stamp — scan + delete first bot text message (no image)
    const listRes = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=50`,
      { headers: H });
    if (listRes.ok) {
      const messages = await listRes.json();
      const prior = messages.find(m => {
        const isBot = m.author?.bot === true || !!m.webhook_id;
        if (!isBot) return false;
        const hasImage = (m.attachments || []).some(a =>
          /\.(png|jpe?g|gif|webp)$/i.test(String(a.filename || '')));
        if (hasImage) return false;
        return m.content && m.content.length >= 20;
      });
      if (prior) {
        const del = await fetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${prior.id}`,
          { method: 'DELETE', headers: H });
        if (del.ok || del.status === 204) deletedId = prior.id;
      }
    }
  }

  // 3) Build + post the new message
  const payload = { allowed_mentions: { parse: [] } };
  if (opts.embed) payload.embeds = [opts.embed];
  if (opts.body)  payload.content = String(opts.body);
  if (opts.withVerify) {
    payload.components = [{
      type: 1,
      components: [{
        type: 2, style: 3,        // GREEN button
        label: '✅ Verify',
        custom_id: 'guild:verify',
      }],
    }];
  }
  const postRes = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
  if (!postRes.ok) {
    return jsonResp({ ok: false, error: 'post-failed', status: postRes.status,
      body: (await postRes.text()).slice(0, 200), deletedId }, 502);
  }
  const newMsg = await postRes.json();
  await env.LOADOUT_BOLTS.put(stampKey, JSON.stringify({
    messageId: newMsg.id, channelId, postedAt: Date.now(),
    shape: opts.embed ? 'embed' : 'text',
    withVerify: !!opts.withVerify,
  }));
  return jsonResp({ ok: true, channelId, deletedId,
    newMessageId: newMsg.id, withVerify: !!opts.withVerify, via: auth.via }, 200);
}

// ── /admin/perms/lockdown/:guildId (HMAC) ─────────────────────────
// Body: { categoryId, extraChannelIds: [], allowSendRoles: [] }
// For every channel under the category PLUS any extras:
//   * Set @everyone overwrite to deny SEND_MESSAGES (0x800)
//   * Set each allowSendRoles overwrite to allow SEND_MESSAGES
// Uses PUT /channels/:id/permissions/:roleId (upsert).
async function handlePermsLockdown(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const categoryId = String(opts.categoryId || '').trim();
  const extras = Array.isArray(opts.extraChannelIds) ? opts.extraChannelIds.map(String) : [];
  const allowRoles = (Array.isArray(opts.allowSendRoles) ? opts.allowSendRoles : []).map(String);
  if (!categoryId && extras.length === 0) {
    return jsonResp({ ok: false, error: 'categoryId or extraChannelIds required' }, 400);
  }
  if (allowRoles.length === 0) {
    return jsonResp({ ok: false, error: 'allowSendRoles required (else no one can speak)' }, 400);
  }

  // Fetch all guild channels, filter to category children + extras
  const chRes = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
    { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } });
  if (!chRes.ok) {
    return jsonResp({ ok: false, error: 'guild-channels-failed', status: chRes.status,
      body: (await chRes.text()).slice(0, 200) }, 502);
  }
  const allChannels = await chRes.json();
  const targets = [];
  // The category itself first (so newly-created children inherit)
  const cat = allChannels.find(c => c.id === categoryId);
  if (cat) targets.push({ id: cat.id, name: cat.name, kind: 'category' });
  for (const c of allChannels) {
    if (c.parent_id === categoryId) targets.push({ id: c.id, name: c.name, kind: 'child' });
  }
  for (const x of extras) {
    if (!targets.some(t => t.id === x)) {
      const c = allChannels.find(z => z.id === x);
      targets.push({ id: x, name: c?.name || '(unknown)', kind: 'extra' });
    }
  }

  const SEND_BIT = '2048';   // 0x800 = SEND_MESSAGES
  const results = [];
  for (const t of targets) {
    const detail = { id: t.id, name: t.name, kind: t.kind, applied: [], errors: [] };
    // @everyone deny
    const evRes = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(t.id)}/permissions/${encodeURIComponent(guildId)}`,
      { method: 'PUT',
        headers: { 'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 0, allow: '0', deny: SEND_BIT }) });
    if (evRes.ok || evRes.status === 204) detail.applied.push('@everyone:deny-send');
    else detail.errors.push({ target: '@everyone', status: evRes.status,
      body: (await evRes.text()).slice(0, 150) });
    // Role allows
    for (const roleId of allowRoles) {
      const rRes = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(t.id)}/permissions/${encodeURIComponent(roleId)}`,
        { method: 'PUT',
          headers: { 'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 0, allow: SEND_BIT, deny: '0' }) });
      if (rRes.ok || rRes.status === 204) detail.applied.push(`role:${roleId}:allow-send`);
      else detail.errors.push({ target: roleId, status: rRes.status,
        body: (await rRes.text()).slice(0, 150) });
    }
    results.push(detail);
  }
  return jsonResp({ ok: true, guildId, categoryId, extras, allowRoles,
    channels: results, via: auth.via }, 200);
}

// ── /admin/release-notes/post/:guildId (HMAC) ─────────────────────
// Body: { channelId, product, version, dateIso, title?, color?,
//         bullets: [strings], imageUrl? }
// Dedupes against release-notes:<g>:<product> — deletes the prior
// post if present, then posts a new embed and stamps the id.
async function handleReleaseNotesPost(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const channelId = String(opts.channelId || '').trim();
  const product = String(opts.product || '').trim().toLowerCase();
  const version = String(opts.version || '').trim();
  const dateIso = String(opts.dateIso || new Date().toISOString().slice(0, 10));
  const bullets = Array.isArray(opts.bullets) ? opts.bullets.filter(Boolean).map(String) : [];
  if (!channelId || !product || !version || bullets.length === 0) {
    return jsonResp({ ok: false, error: 'channelId+product+version+bullets required' }, 400);
  }
  const color = Number.isInteger(opts.color) ? opts.color : 0x7c5cff;   // new brand violet
  const productLabel = product.charAt(0).toUpperCase() + product.slice(1);
  const title = String(opts.title || `${productLabel} ${version}`);
  const desc = bullets.map(b => `• ${b}`).join('\n').slice(0, 4000);
  const embed = {
    title,
    description: desc,
    color,
    footer: { text: `Released ${dateIso}` },
    timestamp: new Date().toISOString(),
  };
  if (opts.imageUrl && typeof opts.imageUrl === 'string') {
    embed.thumbnail = { url: opts.imageUrl };
  }

  // Delete prior if any
  const kvKey = `release-notes:${guildId}:${product}`;
  let priorDeletedId = null;
  const prior = await env.LOADOUT_BOLTS.get(kvKey, { type: 'json' });
  if (prior && prior.messageId && prior.channelId) {
    const del = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(prior.channelId)}/messages/${prior.messageId}`,
      { method: 'DELETE', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } });
    if (del.ok || del.status === 204) priorDeletedId = prior.messageId;
  }
  // Post new
  const postRes = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST',
      headers: { 'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }) });
  if (!postRes.ok) {
    return jsonResp({ ok: false, error: 'post-failed', status: postRes.status,
      body: (await postRes.text()).slice(0, 200), priorDeletedId }, 502);
  }
  const newMsg = await postRes.json();
  await env.LOADOUT_BOLTS.put(kvKey, JSON.stringify({
    messageId: newMsg.id, channelId, product, version, postedAt: Date.now(),
  }));
  return jsonResp({ ok: true, product, version, channelId,
    priorDeletedId, newMessageId: newMsg.id, kvKey, via: auth.via }, 200);
}

// ── /admin/counting/provision-shame-role/:guildId (HMAC) ─────────
// Body (JSON, all optional):
//   { name?: "I CAN'T COUNT", color?: 0xff6ab5,
//     applyChannelDeny?: true }
// Defaults match Clay's 2026-05 spec — aurora pink, hoisted,
// channel-deny on the configured counting channel ON by default.
async function handleCountingProvisionShameRole(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const { provisionShameRole } = await import('./aquilo/counting.js');
  const r = await provisionShameRole(env, guildId, opts);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 502);
}

// ── /admin/post-embed/:guildId (HMAC) ─────────────────────────────
// Generic admin embed-post helper. Body:
//   { channelId, embeds: [...], components?: [...], content? }
// Posts verbatim to channelId as the bot. Useful for one-shot
// admin posts (explainer embeds, announcements, etc.) without
// adding a dedicated endpoint per use case. allowed_mentions
// is locked to `{parse: []}` so the post can't accidentally
// ping @everyone / a role.
async function handlePostEmbed(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const channelId = String(opts.channelId || '').trim();
  if (!/^\d{15,25}$/.test(channelId)) {
    return jsonResp({ ok: false, error: 'bad-channelId' }, 400);
  }
  const payload = {
    allowed_mentions: { parse: [] },
  };
  if (typeof opts.content === 'string') payload.content = opts.content;
  if (Array.isArray(opts.embeds))       payload.embeds = opts.embeds;
  if (Array.isArray(opts.components))   payload.components = opts.components;
  if (!payload.content && !payload.embeds && !payload.components) {
    return jsonResp({ ok: false, error: 'empty-payload' }, 400);
  }
  const r = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
                 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) },
  );
  if (!r.ok) {
    return jsonResp({ ok: false, error: 'post-failed', status: r.status,
                     body: (await r.text()).slice(0, 300) }, 502);
  }
  const m = await r.json();
  return jsonResp({ ok: true, channelId, messageId: String(m?.id || ''),
                    via: auth.via }, 200);
}

// ── /admin/checkin-v2/test-post/:guildId (HMAC) ───────────────────
// Body (JSON):
//   { recipientUserId?, channelId?, imageBase64, message?, gifUrl?,
//     displayName?, avatarUrl?, streak?, xp?, bolts?, accentColor? }
// At least one of recipientUserId / channelId required. If
// recipientUserId is set, the bot opens a DM channel and posts
// there; otherwise it posts to channelId. The embed shape matches
// the variant C spec — composite image fills the embed, gif also
// renders as thumbnail (Discord renders animated GIF thumbnails),
// author header with displayName + avatar, description carries the
// streak/XP/bolts pills + optional message.
async function handleCheckinV2TestPost(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }

  if (!opts.imageBase64) {
    return jsonResp({ ok: false, error: 'image-required',
      message: 'POST body needs imageBase64 — the composite GIF bytes. Generate with build-checkin-v2-test.py.' }, 400);
  }

  // Decode the composite.
  let bytes;
  try {
    const bin = atob(opts.imageBase64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return jsonResp({ ok: false, error: 'bad-base64' }, 400); }

  // Resolve destination — prefer DM if recipientUserId set.
  let channelId = String(opts.channelId || '').trim();
  let destLabel = channelId ? 'channel:' + channelId : null;
  if (opts.recipientUserId) {
    const recipientUserId = String(opts.recipientUserId).trim();
    const dm = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: recipientUserId }),
    });
    if (dm.ok) {
      const m = await dm.json();
      if (m?.id) {
        channelId = String(m.id);
        destLabel = 'dm:' + recipientUserId + ' (channel ' + channelId + ')';
      }
    } else if (!channelId) {
      const dmBody = await dm.text();
      return jsonResp({ ok: false, error: 'dm-open-failed',
        status: dm.status, body: dmBody.slice(0, 200) }, 502);
    }
    // If DM open fails AND we have a fallback channelId, silently
    // fall through to channel posting.
  }
  if (!channelId) return jsonResp({ ok: false, error: 'no-destination',
    message: 'Provide recipientUserId or channelId.' }, 400);

  // Build the variant C embed shape.
  const lines = [];
  if (opts.message) lines.push(`💬 _${String(opts.message).slice(0, 300)}_`);
  const pills = [];
  if (Number.isFinite(opts.streak)) pills.push(`🔥 **${opts.streak}-day streak**`);
  if (Number.isFinite(opts.xp))     pills.push(`⚡ **${opts.xp}** XP`);
  if (Number.isFinite(opts.bolts))  pills.push(`💰 **${opts.bolts}** bolts`);
  if (pills.length) lines.push(pills.join('  ·  '));
  const display = opts.displayName || 'aquilo tester';
  const embed = {
    author: { name: `${display} checked in`,
              icon_url: opts.avatarUrl || undefined },
    description: lines.join('\n') || '_Test check-in — preview the new embed._',
    color: Number.isFinite(opts.accentColor) ? opts.accentColor : 0x7c5cff,
    image: { url: 'attachment://checkin-v2-test.gif' },
    timestamp: new Date().toISOString(),
    footer: { text: 'CHECKIN_EMBED_V2 preview · variant C · gif over background composite' },
  };
  if (opts.gifUrl) embed.thumbnail = { url: opts.gifUrl };

  // Multipart upload — same pattern as the cn-roster composite post.
  const form = new FormData();
  form.append('files[0]', new Blob([bytes], { type: 'image/gif' }), 'checkin-v2-test.gif');
  form.append('payload_json', JSON.stringify({
    embeds: [embed],
    allowed_mentions: { parse: [] },
  }));
  const post = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
      body: form },
  );
  if (!post.ok) {
    return jsonResp({ ok: false, error: 'post-failed', status: post.status,
                     body: (await post.text()).slice(0, 300),
                     destination: destLabel }, 502);
  }
  const m = await post.json();
  return jsonResp({ ok: true, channelId, messageId: String(m?.id || ''),
                    destination: destLabel, via: auth.via }, 200);
}

// ── /admin/self-roles-hub/provision/:guildId (HMAC) ───────────────
// Creates (or reuses) the Discord roles for each hub category:
//   • Pings (4): Stream / YouTube / Events / Game Night — migrates
//     IDs from guild-builder's cfg.ids when present.
//   • Name Color (11): Aquilo Violet, Aurora Pink, Aurora Green,
//     Red, Orange, Yellow, Blue, Cyan, White, Purple, Black-ish.
//   • Region (5): NA East / NA West / EU / Asia / Oceania.
//   • Platform (4): PC / Xbox / PlayStation / Switch.
//   • Pronouns (4): He/Him / She/Her / They/Them / Other-Ask-Me.
// Idempotent — reuses any role with a matching name. Stores the
// resulting {category: {value: roleId}} map at
// self-roles-hub:roles:<g>. NOTE: name-color roles are created at
// the bottom of the hierarchy; admin must reorder them above
// other coloured roles for the colour to render on names.
async function handleSelfRolesHubProvision(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  const { provisionHubRoles } = await import('./aquilo/self-roles-hub.js');
  const r = await provisionHubRoles(env, guildId);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 502);
}

// ── /admin/self-roles-hub/post/:guildId (HMAC) ────────────────────
// Posts (or edits-in-place) one message per category into the roles
// channel. Body { channelId } — defaults to env.ROLES_CHANNEL_ID
// which is the canonical #roles channel for Aquilo.
async function handleSelfRolesHubPost(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const channelId = String(opts.channelId || env.ROLES_CHANNEL_ID || '').trim();
  if (!channelId) return jsonResp({ ok: false, error: 'no-channel',
    message: 'POST body needs { channelId } or set env.ROLES_CHANNEL_ID.' }, 400);
  const { postOrRefreshHub } = await import('./aquilo/self-roles-hub.js');
  const r = await postOrRefreshHub(env, guildId, channelId);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 502);
}

// ── /admin/self-roles/post/:guildId (HMAC) ────────────────────────
// Reposts (or edits in place) the public self-roles message in
// ROLES_CHANNEL_ID. Picks up D1 self_roles edits AND re-injects the
// standalone 18+ self-claim button.
async function handleSelfRolesPost(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  const { postSelfRolesAdmin } = await import('./aquilo/self-roles.js');
  const r = await postSelfRolesAdmin(env, guildId);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 502);
}

// ── /admin/cn-roster/post/:guildId (HMAC) ─────────────────────────
// Body (JSON): { channelId, imageBase64, purgeFirst? }
//   channelId    — defaults to channel-binding(games-list) → (vote)
//   imageBase64  — REQUIRED. The composite-grid PNG generated by
//                  build-cn-composite.py. Uploaded as a Discord
//                  attachment + referenced from embed.image as
//                  attachment://cn-roster.png.
//   purgeFirst   — true wipes any prior roster message (incl. the
//                  legacy multi-embed layout) before posting.
//
// Subsequent refreshes (price edits) run via the :17 cron tick —
// they don't re-upload the composite; they PATCH the existing
// message's components in place.
async function handleCnRosterPost(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  let channelId = String(opts.channelId || '').trim();
  if (!channelId) {
    const { getChannelBinding } = await import('./channel-bindings.js');
    channelId = (await getChannelBinding(env, guildId, 'games-list'))
             || (await getChannelBinding(env, guildId, 'vote'));
  }
  if (!channelId) return jsonResp({ ok: false, error: 'no-channel' }, 400);
  if (!opts.imageBase64) return jsonResp({ ok: false, error: 'image-required',
    message: 'POST body must include imageBase64 — the composite PNG. Generate with build-cn-composite.py.' }, 400);
  const { postRoster } = await import('./cn-games-roster.js');
  const r = await postRoster(env, guildId, channelId, opts.imageBase64, {
    purgeFirst: !!opts.purgeFirst,
  });
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 502);
}

// ── /admin/discord/setup-18plus/:guildId (HMAC) ───────────────────
// Creates (or reuses) a 18+ role, a 18+ category, and an
// age-restricted text channel inside it. @everyone is denied
// VIEW_CHANNEL on the category; the 18+ role + all modAllowRoles
// can view. The channel inherits.
//
// Body: { roleName?: "18+", categoryName?: "18+", channelName?: "18-plus-chat",
//         modAllowRoleIds?: ["...","..."] }
async function handleSetup18Plus(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const roleName     = String(opts.roleName     || '18+').slice(0, 64);
  const categoryName = String(opts.categoryName || '18+').slice(0, 64);
  const channelName  = String(opts.channelName  || '18-plus-chat').slice(0, 64);
  const modAllow     = Array.isArray(opts.modAllowRoleIds) ? opts.modAllowRoleIds.map(String) : [];

  const H = { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN };
  const report = { steps: {} };

  // 1) Role — find by name or create. No extra permissions (the role
  // itself is purely a visibility gate; we apply view perms on the
  // channel).
  const rolesRes = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`,
    { headers: H });
  if (!rolesRes.ok) return jsonResp({ ok: false, error: 'roles-fetch-failed', status: rolesRes.status }, 502);
  const existingRoles = await rolesRes.json();
  let role = existingRoles.find(r => r.name?.toLowerCase() === roleName.toLowerCase() && !r.managed && String(r.id) !== String(guildId));
  if (!role) {
    const createR = await fetch(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`,
      { method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json',
                   'X-Audit-Log-Reason': 'Aquilo 18+ provisioning' },
        body: JSON.stringify({
          name: roleName, permissions: '0',
          color: 0xff6ab5, hoist: false, mentionable: false,
        }) });
    if (!createR.ok) return jsonResp({ ok: false, error: 'role-create-failed',
      status: createR.status, body: (await createR.text()).slice(0, 200) }, 502);
    role = await createR.json();
    report.steps.role = { created: true, id: role.id, name: role.name };
  } else {
    report.steps.role = { reused: true, id: role.id, name: role.name };
  }

  // 2) Category — find by name or create with view-deny @everyone + view-allow role
  const channelsRes = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
    { headers: H });
  if (!channelsRes.ok) return jsonResp({ ok: false, error: 'channels-fetch-failed' }, 502);
  const allCh = await channelsRes.json();
  const VIEW_BIT = '1024';   // VIEW_CHANNEL = 0x400
  let category = allCh.find(c => c.type === 4 && c.name?.toLowerCase() === categoryName.toLowerCase());
  const baseOverwrites = [
    { id: guildId,   type: 0, allow: '0', deny: VIEW_BIT },                // @everyone deny view
    { id: role.id,   type: 0, allow: VIEW_BIT, deny: '0' },                // 18+ role view
    ...modAllow.map(rid => ({ id: rid, type: 0, allow: VIEW_BIT, deny: '0' })),
  ];
  if (!category) {
    const createC = await fetch(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
      { method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json',
                   'X-Audit-Log-Reason': 'Aquilo 18+ provisioning' },
        body: JSON.stringify({
          name: categoryName, type: 4,
          permission_overwrites: baseOverwrites,
        }) });
    if (!createC.ok) return jsonResp({ ok: false, error: 'category-create-failed',
      status: createC.status, body: (await createC.text()).slice(0, 200), report }, 502);
    category = await createC.json();
    report.steps.category = { created: true, id: category.id, name: category.name };
  } else {
    // Re-apply overwrites in case the existing category is misconfigured
    for (const ov of baseOverwrites) {
      await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(category.id)}/permissions/${encodeURIComponent(ov.id)}`,
        { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: ov.type, allow: ov.allow, deny: ov.deny }) });
    }
    report.steps.category = { reused: true, id: category.id, name: category.name };
  }

  // 3) Age-restricted text channel inside the category
  let channel = allCh.find(c => c.type === 0 && c.parent_id === category.id &&
                                c.name?.toLowerCase().includes(channelName.toLowerCase().slice(0, 12)));
  if (!channel) {
    const createT = await fetch(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
      { method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json',
                   'X-Audit-Log-Reason': 'Aquilo 18+ provisioning' },
        body: JSON.stringify({
          name: channelName, type: 0, parent_id: category.id,
          nsfw: true,
          topic: 'Age-restricted chat. By being here you confirm you are 18+.',
        }) });
    if (!createT.ok) return jsonResp({ ok: false, error: 'channel-create-failed',
      status: createT.status, body: (await createT.text()).slice(0, 200), report }, 502);
    channel = await createT.json();
    report.steps.channel = { created: true, id: channel.id, name: channel.name, nsfw: true };
  } else {
    // Ensure nsfw: true
    if (!channel.nsfw) {
      await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channel.id)}`,
        { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nsfw: true }) });
    }
    report.steps.channel = { reused: true, id: channel.id, name: channel.name };
  }

  // 4) Stamp ids in guild:cfg.ids so onboarding step + mod log path
  //    can resolve them later.
  const cfgKey = `guild:cfg:${guildId}`;
  const cfg = (await env.LOADOUT_BOLTS.get(cfgKey, { type: 'json' })) || { ids: {} };
  cfg.ids = cfg.ids || {};
  cfg.ids.role_age18      = role.id;
  cfg.ids.cat_age18       = category.id;
  cfg.ids.ch_age18        = channel.id;
  await env.LOADOUT_BOLTS.put(cfgKey, JSON.stringify(cfg));
  report.steps.guild_cfg_stamped = {
    role_age18: role.id, cat_age18: category.id, ch_age18: channel.id,
  };

  return jsonResp({ ok: true, ...report, via: auth.via }, 200);
}

// ── /admin/discord/create-locked-channel/:guildId (HMAC) ──────────
// Body: { categoryId, channelName, topic?, allowSendRoleIds: [] }
// Creates a text channel; @everyone keeps VIEW + read but loses
// SEND_MESSAGES; the listed roles get SEND_MESSAGES allow.
async function handleCreateLockedChannel(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);
  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  const categoryId  = String(opts.categoryId || '').trim();
  const channelName = String(opts.channelName || '').trim().slice(0, 64);
  const topic       = String(opts.topic || '').slice(0, 1024);
  const allowSend   = Array.isArray(opts.allowSendRoleIds) ? opts.allowSendRoleIds.map(String) : [];
  if (!categoryId || !channelName || allowSend.length === 0) {
    return jsonResp({ ok: false, error: 'categoryId + channelName + allowSendRoleIds required' }, 400);
  }

  const H = { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN };
  // Find existing or create
  const chRes = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
    { headers: H });
  if (!chRes.ok) return jsonResp({ ok: false, error: 'channels-fetch-failed' }, 502);
  const allCh = await chRes.json();
  let channel = allCh.find(c => c.type === 0 && c.parent_id === categoryId &&
                                c.name?.toLowerCase() === channelName.toLowerCase());
  const SEND_BIT = '2048';   // 0x800 SEND_MESSAGES
  const overwrites = [
    { id: guildId, type: 0, allow: '0', deny: SEND_BIT },                  // @everyone deny send
    ...allowSend.map(rid => ({ id: rid, type: 0, allow: SEND_BIT, deny: '0' })),
  ];
  if (!channel) {
    const create = await fetch(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
      { method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json',
                   'X-Audit-Log-Reason': 'Aquilo locked-channel provisioning' },
        body: JSON.stringify({
          name: channelName, type: 0, parent_id: categoryId,
          topic, permission_overwrites: overwrites,
        }) });
    if (!create.ok) return jsonResp({ ok: false, error: 'channel-create-failed',
      status: create.status, body: (await create.text()).slice(0, 200) }, 502);
    channel = await create.json();
    return jsonResp({ ok: true, created: true, id: channel.id, name: channel.name,
      via: auth.via }, 200);
  }
  // Re-apply overwrites
  for (const ov of overwrites) {
    await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channel.id)}/permissions/${encodeURIComponent(ov.id)}`,
      { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: ov.type, allow: ov.allow, deny: ov.deny }) });
  }
  return jsonResp({ ok: true, reused: true, id: channel.id, name: channel.name,
    via: auth.via }, 200);
}

// ── /admin/counting/reset/:guildId (HMAC) ─────────────────────────
// Body (JSON, optional): { confirm: "yes-i-mean-it" }
// Wipes counting:<guildId> in STATE back to fresh (current=0,
// last_user_id=null). Does NOT touch wallets or bot-message history.
async function handleCountingReset(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','counting','reset',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) { try { opts = JSON.parse(body) || {}; }
              catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); } }
  if (opts.confirm !== 'yes-i-mean-it') {
    return jsonResp({ ok: false, error: 'confirm-required',
      hint: 'POST { "confirm": "yes-i-mean-it" }' }, 400);
  }
  if (!env.STATE) return jsonResp({ ok: false, error: 'no-state-binding' }, 503);
  const fresh = {
    current: 0, last_user_id: null, high_score: 0, high_score_user_id: null,
    successes: 0, fails: 0, started_at: null,
    updated_at: new Date().toISOString(),
  };
  await env.STATE.put('counting:' + guildId, JSON.stringify(fresh));
  return jsonResp({ ok: true, guildId, state: fresh, via: auth.via }, 200);
}

// ── /admin/welcome/backfill-counter/:guildId (HMAC) ────────────────
// Body (JSON, optional): { force?: bool, seedIfPreviewMissing?: number }
async function handleWelcomeBackfillCounter(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','welcome','backfill-counter',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { backfillJoinCounter } = await import('./welcome.js');
  const r = await backfillJoinCounter(env, guildId, opts);
  return jsonResp({ ...r, via: auth.via }, r.ok ? 200 : 400);
}

// ── /admin/banner/replace-section/:guildId (HMAC) ─────────────────
//
// Body (JSON):
//   {
//     "key":            "rules" | "welcome" | "moderation" | "invite",
//     "imageBase64":    "<base64 PNG>",
//     "imageFilename":  "discord-section-rules.png",
//     "channelId":      "<snowflake>"        // optional override
//     "channelKind":    "ch_rules"           // optional guild:cfg.ids key override
//     "scanLimit":      30                   // optional, default 30
//   }
//
// Resolution order for the target channel:
//   1. opts.channelId        — explicit override
//   2. guild:cfg.ids.<channelKind> (defaults to "ch_<key>")
//   3. fail with `no-channel`
//
// Discord REST returns messages newest-first, so messages[0] is the
// bottom of the channel UI. We scan that order and delete the first
// bot/webhook message carrying an image attachment.
async function handleBannerReplaceSection(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','banner','replace-section',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return jsonResp({ ok: false, error: 'no-bot-token' }, 503);

  let opts = {};
  try { opts = body ? JSON.parse(body) : {}; }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }

  const key = String(opts.key || '').trim();
  if (!/^[a-z][a-z0-9-]{1,32}$/.test(key)) {
    return jsonResp({ ok: false, error: 'bad-key', hint: 'lowercase letters/digits/dashes' }, 400);
  }
  const imageBase64 = String(opts.imageBase64 || '');
  if (!imageBase64) return jsonResp({ ok: false, error: 'imageBase64 required' }, 400);
  const filename = String(opts.imageFilename || ('discord-section-' + key + '.png')).slice(0, 80);

  // Resolve channel
  let channelId = String(opts.channelId || '').trim();
  let channelSource = 'override';
  if (!channelId) {
    const cfg = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
    const cfgKey = String(opts.channelKind || ('ch_' + key)).trim();
    channelId = cfg?.ids?.[cfgKey] || '';
    channelSource = 'guild:cfg.ids.' + cfgKey;
  }
  if (!channelId) return jsonResp({ ok: false, error: 'no-channel', hint: 'pass channelId or set guild:cfg.ids.ch_' + key }, 400);

  // List recent messages (newest-first)
  const scanLimit = Math.min(100, Math.max(1, Number(opts.scanLimit) || 30));
  const listRes = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=${scanLimit}`,
    { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } },
  );
  if (!listRes.ok) {
    return jsonResp({ ok: false, error: 'list-failed', status: listRes.status,
      body: (await listRes.text()).slice(0, 200) }, 502);
  }
  const messages = await listRes.json();

  // Bottom-most bot/webhook image message = first scan match (messages[0])
  let oldBanner = null;
  for (const m of messages) {
    const isBot = m.author?.bot === true || !!m.webhook_id;
    if (!isBot) continue;
    const hasImage = (m.attachments || []).some(a => {
      const n = String(a.filename || '').toLowerCase();
      return /\.(png|jpe?g|gif|webp)$/.test(n);
    });
    if (hasImage) { oldBanner = m; break; }
  }

  let deletedId = null;
  let deleteError = null;
  if (oldBanner) {
    const delRes = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${oldBanner.id}`,
      { method: 'DELETE', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } },
    );
    if (delRes.ok || delRes.status === 204) {
      deletedId = oldBanner.id;
    } else {
      deleteError = { status: delRes.status, body: (await delRes.text()).slice(0, 160) };
    }
  }

  // Decode + post the new banner via multipart/form-data
  let bytes;
  try {
    const bin = atob(imageBase64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return jsonResp({ ok: false, error: 'bad-base64' }, 400);
  }

  const form = new FormData();
  form.append('files[0]', new Blob([bytes], { type: 'image/png' }), filename);

  const postRes = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
      body: form },
  );
  if (!postRes.ok) {
    return jsonResp({ ok: false, error: 'post-failed', status: postRes.status,
      body: (await postRes.text()).slice(0, 200), deletedId, channelId }, 502);
  }
  const newMsg = await postRes.json();
  const newMessageId = String(newMsg?.id || '');

  // Stamp the new id
  const kvKey = `branding:section-banner:${guildId}:${key}`;
  await env.LOADOUT_BOLTS.put(kvKey, JSON.stringify({
    messageId: newMessageId,
    channelId,
    filename,
    sizeBytes: bytes.length,
    postedAt: Date.now(),
  }));

  return jsonResp({
    ok: true,
    key,
    channelId,
    channelSource,
    scanned: messages.length,
    oldMessageId: deletedId,
    oldAuthorId: oldBanner?.author?.id || null,
    oldFilename: oldBanner?.attachments?.[0]?.filename || null,
    deleteError,
    newMessageId,
    newSizeBytes: bytes.length,
    kvKey,
    via: auth.via,
  }, 200);
}

// ── /admin/gifter-roles/ensure/:guildId (HMAC) ────────────────────
async function handleGifterRolesEnsure(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','gifter-roles','ensure',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  const { ensureGifterRoles } = await import('./gifter-roles.js');
  const r = await ensureGifterRoles(env, guildId);
  if (!r.ok) {
    const status = r.error === 'roles-fetch-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// GET the currently-registered commands (global by default,
// ?scope=guild for the per-guild set). Same auth as register.
async function handleListCommands(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'list-commands', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const url0 = new URL(req.url);
  const scope = (url0.searchParams.get('scope') || 'global').toLowerCase();

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature or guild not registered', { status: 401 });

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token)
    return new Response('worker not provisioned (DISCORD_APP_ID + DISCORD_BOT_TOKEN required)', { status: 503 });

  const url = scope === 'guild'
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;
  const r = await fetch(url, { headers: { 'Authorization': 'Bot ' + token } });
  const text = await r.text();
  if (!r.ok)
    return new Response(JSON.stringify({ ok: false, scope, status: r.status, body: text.slice(0, 800) }),
                        { status: 502, headers: { 'content-type': 'application/json' } });

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const summary = Array.isArray(parsed)
    ? parsed.map(c => ({ id: c.id, name: c.name, description: c.description, type: c.type, options: (c.options || []).map(o => o.name) }))
    : [];
  return new Response(JSON.stringify({
    ok: true,
    scope,
    guildId: scope === 'guild' ? guildId : null,
    count: summary.length,
    commands: summary,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_bootstrap-l8/:guildId  (one-shot KV token) -----------------
//
// Self-contained deploy step for the L8 feature batch. Token-gated via
// `bootstrap-l8-token` in KV (written by the operator immediately
// before calling). On first match, the KV entry is deleted so the
// endpoint is single-use — leaving the route in place is harmless.
//
// Actions, in order:
//   1. Re-register slash commands GLOBALLY (idempotent — picks up
//      /ticket and any other newly-added entries in commands-spec.js).
//   2. Look up the live channel list for :guildId, find:
//        • 🛠️│support  (or any channel name containing "support")
//        • 👋│introductions (welcome target)
//   3. Post the ticket panel to the support channel.
//   4. Backfill guild:cfg.ids with ch_introductions so the welcome
//      handler resolves the channel without needing welcome-cfg.
//
// Returns a JSON summary of what was done + any non-fatal warnings.
// One-shot Aquilo's Vault guild setup. Token-gated (KV `vault-setup-token`,
// armed by the operator just before calling). Idempotent, so on a partial
// failure you can re-arm the token and re-run safely.
async function handleVaultSetup(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','vault','setup',':guildId']
  const guildId = parts[3];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('vault-setup-token');
  if (!expected) return new Response('vault setup not armed (set KV vault-setup-token first)', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  // Single-use — burn before side-effects. Re-arm to retry (idempotent).
  await env.LOADOUT_BOLTS.delete('vault-setup-token');

  if (!env.DISCORD_BOT_TOKEN) {
    return new Response('worker not provisioned (DISCORD_BOT_TOKEN required)', { status: 503 });
  }
  try {
    const { setupVaultGuild } = await import('./vault-discord.js');
    const report = await setupVaultGuild(env, guildId);
    return new Response(JSON.stringify(report, null, 2), {
      status: report.ok ? 200 : 207,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }
}

async function handleBootstrapL8(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_bootstrap-l8',':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('bootstrap already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });

  // Single-use — burn the token before doing any side-effects so a
  // partial failure can't be retried with the same token.
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token) {
    return new Response('worker not provisioned (DISCORD_APP_ID + DISCORD_BOT_TOKEN required)', { status: 503 });
  }
  const H = { Authorization: 'Bot ' + token };
  const report = { guildId, steps: {} };

  // 1) Re-register slash commands ON THE GUILD ONLY. We used to push
  // them both globally + per-guild, which made every command appear
  // TWICE in the Discord picker (one copy per scope). Guild-only
  // registration is instant + clean; once the bot is shipped to
  // additional guilds we'll fan-out per-guild from a known list
  // (cheap — 31 commands, one PUT each, ~200ms total).
  //
  // ALSO: PUT [] globally to clear any previously-registered global
  // copies left behind by the old dual-registration path. Idempotent
  // — re-running this is fine.
  {
    const globalUrl = `https://discord.com/api/v10/applications/${appId}/commands`;
    const clearGlobal = await fetch(globalUrl, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    const ctext = await clearGlobal.text();
    let cparsed = null; try { cparsed = JSON.parse(ctext); } catch {}
    report.steps.register_global_cleared = {
      ok: clearGlobal.ok, status: clearGlobal.status,
      cleared_count_now: Array.isArray(cparsed) ? cparsed.length : null,
      error: clearGlobal.ok ? null : ctext.slice(0, 200),
    };
  }
  {
    const guildUrl = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
    const r = await fetch(guildUrl, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    report.steps.register_guild = {
      ok: r.ok, status: r.status,
      count: Array.isArray(parsed) ? parsed.length : null,
      names: Array.isArray(parsed) ? parsed.map(c => c.name) : null,
      error: r.ok ? null : text.slice(0, 200),
    };
  }

  // 2) Channel lookup by name (case-insensitive, emoji-tolerant).
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: H });
  if (!chRes.ok) {
    report.steps.channels = { ok: false, status: chRes.status, error: (await chRes.text()).slice(0, 200) };
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const channels = await chRes.json();
  function findChannelByContains(needle) {
    const n = needle.toLowerCase();
    return channels.find(c => (c.name || '').toLowerCase().includes(n));
  }
  const supportCh = findChannelByContains('support');
  const introsCh  = findChannelByContains('introductions') || findChannelByContains('welcome');
  report.steps.channels = {
    support:        supportCh ? { id: supportCh.id, name: supportCh.name, type: supportCh.type } : null,
    introductions:  introsCh  ? { id: introsCh.id,  name: introsCh.name,  type: introsCh.type  } : null,
  };

  // 3) Post ticket panel into support channel — only if it's a TEXT
  // channel (type 0). The current 🛠️│support is a FORUM (type 15)
  // from the original guild build; per Clay's spec it's being
  // repurposed as the ticket-panel channel, so we POST regardless
  // and let Discord reject if it's a forum.
  if (supportCh) {
    try {
      const { postTicketPanel } = await import('./tickets.js');
      const r = await postTicketPanel(env, guildId, supportCh.id);
      report.steps.ticket_panel = { ok: !!r?.ok, result: r };
    } catch (e) {
      report.steps.ticket_panel = { ok: false, error: String(e?.message || e) };
    }
  } else {
    report.steps.ticket_panel = { ok: false, error: 'no-support-channel-found' };
  }

  // 4) Backfill guild:cfg.ids.ch_introductions so the welcome handler
  // resolves a channel without needing a separate welcome-cfg record.
  // vc_join_to_create + cat_voice already exist in cfg.ids — confirm
  // they're present and surface a warning if not.
  const cfgKey = `guild:cfg:${guildId}`;
  const cfg = (await env.LOADOUT_BOLTS.get(cfgKey, { type: 'json' })) || { ids: {} };
  cfg.ids = cfg.ids || {};
  const before = {
    ch_introductions:   cfg.ids.ch_introductions || null,
    vc_join_to_create:  cfg.ids.vc_join_to_create || null,
    cat_voice:          cfg.ids.cat_voice || null,
  };
  if (introsCh && !cfg.ids.ch_introductions) {
    cfg.ids.ch_introductions = introsCh.id;
  }
  await env.LOADOUT_BOLTS.put(cfgKey, JSON.stringify(cfg));
  report.steps.guild_cfg = {
    ok: true,
    before, after: {
      ch_introductions:   cfg.ids.ch_introductions || null,
      vc_join_to_create:  cfg.ids.vc_join_to_create || null,
      cat_voice:          cfg.ids.cat_voice || null,
    },
    warnings: [
      !cfg.ids.vc_join_to_create ? 'vc_join_to_create missing — temp VCs will skip' : null,
      !cfg.ids.cat_voice         ? 'cat_voice missing — new temp VCs will land at root'  : null,
      !cfg.ids.ch_introductions  ? 'ch_introductions missing — welcome embed has no target' : null,
    ].filter(Boolean),
  };

  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_phase2/:guildId  (one-shot KV token) ───────────────────────
//
// Second-pass setup. Same token-gating as the L8 bootstrap (writes
// `bootstrap-l8-token` to KV, calls endpoint, KV entry self-destructs
// on first valid call). Idempotent operations:
//
//   1. Re-register slash commands (guild-only + clear global) — re-uses
//      the same path L8 fixed for the duplicate-command issue.
//   2. Create channels that don't exist yet:
//        • 📰│activity-feed            (text — community events)
//        • 🃏│games                     (text — game commands hub)
//        • 🗳️│voting                    (text — community-night polls)
//        • 🧩│community-night-queue     (text — queue sign-ups)
//      Each create is idempotent: GET /guilds/{g}/channels first;
//      if a name match exists, adopt it.
//   3. Write the IDs into guild:cfg:<g>.ids:
//        ch_activity_feed, ch_games, ch_voting, ch_cn_queue,
//        ch_schedule (auto-discovered from 📅│schedule), ch_support
//   4. Command bindings → channels:
//        /play, /boltbound, /character, /pet, /clash      → ch_games
//        /checkin                                          → ch_checkin
//        /lfg                                              → ch_games
//        /trivia-add, /rotation-poll                       → ch_voting
//        /queue                                            → ch_cn_queue
//   5. Set the SCHEDULE_CHANNEL_ID / POLL_CHANNEL_ID / QUEUE_CHANNEL_ID
//      env values via guild:env:<g> KV overlay (so the schedule
//      module reads the new bindings without a wrangler redeploy).
//   6. Call postOrRefreshSchedule() to put the embed in #schedule.
//
// Returns a JSON report of everything that did/didn't happen.
async function handlePhase2(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_phase2',':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('phase2 already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token) return new Response('worker not provisioned', { status: 503 });
  const H = { Authorization: 'Bot ' + token };
  const report = { guildId, steps: {} };

  // 1) Re-register commands guild-only + clear globals.
  {
    const globalUrl = `https://discord.com/api/v10/applications/${appId}/commands`;
    const clear = await fetch(globalUrl, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    report.steps.register_global_cleared = { ok: clear.ok, status: clear.status };
    const guildUrl = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
    const r = await fetch(guildUrl, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    report.steps.register_guild = {
      ok: r.ok, status: r.status,
      count: Array.isArray(parsed) ? parsed.length : null,
    };
  }

  // 2) Channel lookup + idempotent create.
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: H });
  if (!chRes.ok) {
    report.steps.channels = { ok: false, status: chRes.status, error: (await chRes.text()).slice(0, 200) };
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const channels = await chRes.json();
  function findByContains(needle) {
    const n = needle.toLowerCase();
    return channels.find(c => (c.name || '').toLowerCase().includes(n));
  }
  // Reusable parent for new community-style text channels — the
  // "community" category from the existing server build, fetched
  // by name. If absent, channels land at root (still works, just
  // ungrouped). For the queue channel we prefer the games category
  // if it exists.
  const catCommunity = channels.find(c => c.type === 4 && /community/i.test(c.name || ''));
  const catGames     = channels.find(c => c.type === 4 && /games|play/i.test(c.name || ''));

  async function ensureTextChannel(name, parentId) {
    const existing = findByContains(name.replace(/[│|·\s]/g, '').toLowerCase());
    if (existing && existing.type === 0) return { id: existing.id, name: existing.name, adopted: true };
    // Try the exact name match first as a stricter signal.
    const exact = channels.find(c => c.type === 0 && c.name === name);
    if (exact) return { id: exact.id, name: exact.name, adopted: true };
    const create = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 0, parent_id: parentId || undefined }),
    });
    if (!create.ok) {
      const txt = (await create.text()).slice(0, 200);
      return { error: 'create-failed', status: create.status, body: txt };
    }
    const c = await create.json();
    channels.push(c);
    return { id: c.id, name: c.name, created: true };
  }

  const want = [
    { slot: 'ch_activity_feed', name: '📰│activity-feed',         parent: catCommunity?.id },
    { slot: 'ch_games',         name: '🃏│games',                  parent: catGames?.id || catCommunity?.id },
    { slot: 'ch_voting',        name: '🗳️│voting',                 parent: catCommunity?.id },
    { slot: 'ch_cn_queue',      name: '🧩│community-night-queue',  parent: catGames?.id || catCommunity?.id },
  ];
  report.steps.channels = {};
  for (const w of want) {
    report.steps.channels[w.slot] = await ensureTextChannel(w.name, w.parent);
  }
  // Auto-discover the existing schedule channel + support channel for
  // completeness (these were created in the original guild build).
  const schedCh = findByContains('schedule');
  const supportCh = findByContains('support');
  if (schedCh) report.steps.channels.ch_schedule = { id: schedCh.id, name: schedCh.name, adopted: true };
  if (supportCh) report.steps.channels.ch_support = { id: supportCh.id, name: supportCh.name, adopted: true };

  // 3) Write IDs into guild:cfg.
  const cfgKey = `guild:cfg:${guildId}`;
  const cfg = (await env.LOADOUT_BOLTS.get(cfgKey, { type: 'json' })) || { ids: {} };
  cfg.ids = cfg.ids || {};
  for (const [slot, info] of Object.entries(report.steps.channels)) {
    if (info?.id && !cfg.ids[slot]) cfg.ids[slot] = info.id;
  }
  await env.LOADOUT_BOLTS.put(cfgKey, JSON.stringify(cfg));
  report.steps.cfg_written = { ids: cfg.ids };

  // 4) Command → channel bindings.
  const { saveBindings } = await import('./command-bindings.js');
  const games = cfg.ids.ch_games;
  const checkin = cfg.ids.ch_checkin;
  const voting = cfg.ids.ch_voting;
  const queue  = cfg.ids.ch_cn_queue;
  const bindings = {};
  if (games)   { bindings.play = [games]; bindings.boltbound = [games]; bindings.character = [games]; bindings.pet = [games]; bindings.clash = [games]; bindings.lfg = [games]; }
  if (checkin) { bindings.checkin = [checkin]; }
  if (voting)  { bindings['rotation-poll'] = [voting]; bindings['trivia-add'] = [voting]; }
  if (queue)   { bindings.queue = [queue]; bindings.schedule = [voting || games].filter(Boolean); }
  await saveBindings(env, guildId, bindings);
  report.steps.command_bindings = bindings;

  // 5) Per-guild env-overlay for SCHEDULE / POLL / QUEUE channel ids
  // (aq-schedule.js reads from env, with KV `schedule:<g>.channel_id`
  // taking precedence — we set it directly).
  if (cfg.ids.ch_schedule) {
    const schedKey = `schedule:${guildId}`;
    const sched = (await env.STATE?.get?.(schedKey).then(v => v && JSON.parse(v)).catch(() => null)) || {};
    sched.channel_id = cfg.ids.ch_schedule;
    sched.poll_channel_id = cfg.ids.ch_voting || sched.poll_channel_id;
    try { await env.STATE.put(schedKey, JSON.stringify(sched)); } catch { /* idle */ }
    report.steps.schedule_bound = { channel_id: sched.channel_id, poll_channel_id: sched.poll_channel_id };
  }

  // 6) Post / refresh the schedule embed.
  try {
    const { postOrRefreshSchedule } = await import('./aquilo/aq-schedule.js');
    const messageId = await postOrRefreshSchedule(env, guildId);
    report.steps.schedule_posted = { ok: true, messageId };
  } catch (e) {
    report.steps.schedule_posted = { ok: false, error: String(e?.message || e) };
  }

  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_phase3-rules/:guildId ----------------------------------
//
// 1. Create 📣│self-promo under the existing community category if
//    no `*self-promo*` text channel already exists.
// 2. Find the existing verify-button message in 🫡│rules (looking for
//    the bot's own message with a button) and DELETE it — so the
//    new rules embed lands ABOVE it after a re-post.
// 3. POST the stylized rules embed (banner image + 10-rule body) to
//    🫡│rules.
// 4. RE-POST the verify button so it appears below the rules embed.
// 5. Persist self-promo + rules-message ids in guild:cfg.ids.
async function handlePhase3Rules(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('phase3-rules already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('worker not provisioned', { status: 503 });
  const H = { Authorization: 'Bot ' + token };
  const report = { guildId, steps: {} };

  // 1) Channel list + find rules / category.
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: H });
  if (!chRes.ok) {
    return new Response(JSON.stringify({ error: 'channel-list-failed', status: chRes.status }), { status: 500 });
  }
  const channels = await chRes.json();
  const rulesCh    = channels.find(c => c.type === 0 && /rules/i.test(c.name || ''));
  const catCommunity = channels.find(c => c.type === 4 && /community/i.test(c.name || ''));
  let selfPromoCh = channels.find(c => c.type === 0 && /self.?promo/i.test(c.name || ''));

  if (!selfPromoCh) {
    const create = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '📣│self-promo',
        type: 0,
        parent_id: catCommunity?.id,
        topic: 'Share your streams, videos, projects — your own content only. No bare invite links or ads.',
      }),
    });
    if (!create.ok) {
      report.steps.self_promo = { ok: false, status: create.status, error: (await create.text()).slice(0, 200) };
      return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    selfPromoCh = await create.json();
    report.steps.self_promo = { id: selfPromoCh.id, name: selfPromoCh.name, created: true };
  } else {
    report.steps.self_promo = { id: selfPromoCh.id, name: selfPromoCh.name, adopted: true };
  }

  if (!rulesCh) {
    report.steps.rules = { ok: false, error: 'no-rules-channel' };
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // 2) Find + delete the existing verify-button message (bot-authored
  //    message with a component button — newest 50 messages should
  //    cover this comfortably).
  const appId = env.DISCORD_APP_ID;
  const msgsRes = await fetch(`https://discord.com/api/v10/channels/${rulesCh.id}/messages?limit=50`, { headers: H });
  let oldVerify = null;
  if (msgsRes.ok) {
    const msgs = await msgsRes.json();
    oldVerify = msgs.find(m =>
      m.author?.id === appId &&
      Array.isArray(m.components) && m.components.length > 0
    );
  }
  if (oldVerify) {
    const del = await fetch(`https://discord.com/api/v10/channels/${rulesCh.id}/messages/${oldVerify.id}`, {
      method: 'DELETE', headers: H,
    });
    report.steps.deleted_old_verify = { id: oldVerify.id, ok: del.ok, status: del.status };
  } else {
    report.steps.deleted_old_verify = { skipped: 'no-existing-verify-button' };
  }

  // 3) Post the rules embed.
  const BRAND_ACCENT = 0xF47FFF;
  const RULES_HEADER_URL = 'https://aquilo.gg/sprites/welcome/aquilo-rules-header.png';
  const rulesEmbed = {
    title: 'Aquilo Community Rules',
    description: [
      `**1 — Be respectful.** Treat everyone with kindness. No harassment, hate speech, slurs, discrimination, or personal attacks. Disagree without being hostile.`,
      `**2 — Keep it appropriate.** No NSFW, gory, or shocking content anywhere. Keep language and content friendly for a mixed-age community.`,
      `**3 — No spam.** Don't flood channels, spam emojis or mentions, mass-ping, or post the same thing repeatedly.`,
      `**4 — Use the right channels.** Keep conversations on-topic. Support questions go through the ticket system.`,
      `**5 — No unsolicited self-promo or advertising.** Don't post invite links or ads, and don't DM members ads. Share your own content in <#${selfPromoCh.id}> where it belongs.`,
      `**6 — Respect privacy.** No sharing anyone's personal information, no posting private messages or screenshots without consent.`,
      `**7 — Settle conflicts properly.** No drama, call-outs, or witch-hunts in public. Open a ticket instead.`,
      `**8 — Play fair.** Don't cheat, exploit, or abuse bugs in the games or the bolts economy. Report bugs — don't farm them.`,
      `**9 — Follow Discord's rules.** Everyone must follow Discord's Terms of Service and Community Guidelines.`,
      `**10 — Staff have the final say.** Listen to the moderators. Rules can be updated, and staff may act on anything that harms the community.`,
      ``,
      `_Welcome to Aquilo — have fun and look out for each other._`,
    ].join('\n\n'),
    color: BRAND_ACCENT,
    image: { url: RULES_HEADER_URL },
    footer: { text: 'aquilo.gg · community rules' },
  };
  const rulesPost = await fetch(`https://discord.com/api/v10/channels/${rulesCh.id}/messages`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [rulesEmbed], allowed_mentions: { parse: [] } }),
  });
  if (!rulesPost.ok) {
    report.steps.rules_posted = { ok: false, status: rulesPost.status, error: (await rulesPost.text()).slice(0, 200) };
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const rulesMsg = await rulesPost.json();
  report.steps.rules_posted = { id: rulesMsg.id, channelId: rulesCh.id, ok: true };

  // 4) Re-post the verify button below the rules embed (if we just
  //    deleted one). Reuses the same custom_id the original button
  //    used so existing onClick handling continues to work.
  if (oldVerify) {
    // Use the original button's custom_id + label if present so we don't
    // accidentally rename / re-key it.
    const orig = oldVerify.components?.[0]?.components?.[0] || {};
    const customId = orig.custom_id || 'verify:start';
    const label    = orig.label     || '✅ Verify';
    const verifyContent = oldVerify.content && oldVerify.content.length
      ? oldVerify.content
      : 'Tap **Verify** to gain access to the rest of the server.';
    const repost = await fetch(`https://discord.com/api/v10/channels/${rulesCh.id}/messages`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: verifyContent,
        components: [{
          type: 1, components: [{
            type: 2, style: 3, label, custom_id: customId,
          }],
        }],
        allowed_mentions: { parse: [] },
      }),
    });
    if (repost.ok) {
      const m = await repost.json();
      report.steps.verify_reposted = { id: m.id, ok: true, custom_id: customId };
    } else {
      report.steps.verify_reposted = { ok: false, status: repost.status, error: (await repost.text()).slice(0, 200) };
    }
  }

  // 5) Persist channel + message ids.
  const cfgKey = `guild:cfg:${guildId}`;
  const cfg = (await env.LOADOUT_BOLTS.get(cfgKey, { type: 'json' })) || { ids: {} };
  cfg.ids = cfg.ids || {};
  cfg.ids.ch_self_promo = selfPromoCh.id;
  cfg.ids.msg_rules     = rulesMsg.id;
  await env.LOADOUT_BOLTS.put(cfgKey, JSON.stringify(cfg));
  report.steps.cfg_written = { ch_self_promo: cfg.ids.ch_self_promo, msg_rules: cfg.ids.msg_rules };

  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_chat-test/:guildId ----------------------------------------
// One-shot diagnostic for /web/chat/send. Reads ?channelId= (or
// defaults to the first COMMUNITY_CHAT_CHANNELS_JSON entry) +
// ?discordId= (the user the worker pretends to be) + ?content= and
// runs sendFromPwa() in-process. Returns the FULL diagnostic so any
// failure shows the actual webhook-list / webhook-create / webhook-
// post response detail.
async function handleChatTest(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('chat-test already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  let channelId = u.searchParams.get('channelId') || '';
  if (!channelId) {
    // Default to the first channel in the COMMUNITY_CHAT_CHANNELS_JSON
    // allow-list — that's the canonical relay-eligible channel.
    try {
      const arr = JSON.parse(env.COMMUNITY_CHAT_CHANNELS_JSON || '[]');
      const first = arr[0];
      channelId = typeof first === 'string' ? first : (first?.id || '');
    } catch { /* idle */ }
  }
  const discordId = u.searchParams.get('discordId') || env.AQUILO_VAULT_GUILD_ID || '';
  const content   = u.searchParams.get('content')   || 'chat-relay diagnostic — please ignore';

  const report = {
    inputs: { guildId, channelId, discordId, content },
    allowlist: [],
  };
  try {
    report.allowlist = JSON.parse(env.COMMUNITY_CHAT_CHANNELS_JSON || '[]');
  } catch { /* idle */ }

  if (!channelId) {
    report.error = 'no-channelId-and-no-allowlist-default';
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  try {
    const { sendFromPwa } = await import('./chat-relay.js');
    const r = await sendFromPwa(env, { discordId, guildId, channelId, content });
    report.result = r;
  } catch (e) {
    report.threw = String(e?.message || e);
  }
  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_phase4-perms/:guildId ----------------------------------
//
// Audit + repair the guild's channel permission tree. For each
// category we know about, set the intended overwrite profile; then
// for each channel under that category, sync its overwrites to the
// category's (Discord client "Sync Now" equivalent) and layer in any
// channel-specific extras (announce/rules/feed channels get a
// read-only @everyone overwrite on top).
//
// Profiles:
//   "open"     — no role-based view restriction (default for
//                start-here so the verification gate works).
//   "member"   — deny @everyone VIEW; allow `role_member` VIEW.
//   "patron"   — deny @everyone VIEW; allow `role_patron` VIEW.
//   "staff"    — deny @everyone VIEW; allow `role_owner` + `role_mod`.
//   "voice-member" — like "member" but also CONNECT + SPEAK.
//
// Read-only flag (channel-level extra): @everyone gets an explicit
//   deny on SEND_MESSAGES + CREATE_PUBLIC_THREADS + SEND_MESSAGES_IN_THREADS.
//   Bots / moderators bypass via their admin permission.
//
// Returns a per-channel diff: what the overwrites WERE vs what we
// wrote. Channels whose overwrites already matched the target shape
// are skipped (no API call), so re-running the endpoint is cheap.
async function handlePhase4Perms(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('phase4-perms already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');
  const dryRun = u.searchParams.get('dryRun') === '1';

  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('worker not provisioned', { status: 503 });
  const H = { Authorization: 'Bot ' + token };

  // ── 1. Pull live state ─────────────────────────────────────────────
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: H });
  if (!chRes.ok) return new Response('channel-list-failed', { status: 502 });
  const channels = await chRes.json();
  const cfg = (await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' })) || { ids: {} };
  const ids = cfg.ids || {};

  // Required role ids — bail loudly if any are missing rather than
  // writing partial overwrites.
  const everyoneId = guildId;                  // @everyone role id == guild id
  const memberId   = ids.role_member;
  const patronId   = ids.role_patron;
  const modId      = ids.role_mod;
  const ownerId    = ids.role_owner;
  if (!memberId || !patronId || !modId || !ownerId) {
    return new Response(JSON.stringify({
      error: 'missing-role-ids',
      need: ['role_member','role_patron','role_mod','role_owner'],
      have: { memberId, patronId, modId, ownerId },
    }, null, 2), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  // ── 2. Permission bits (Discord docs) ──────────────────────────────
  const VIEW          = 0x400n;          // VIEW_CHANNEL
  const SEND          = 0x800n;          // SEND_MESSAGES
  const HISTORY       = 0x10000n;        // READ_MESSAGE_HISTORY
  const CONNECT       = 0x100000n;       // CONNECT
  const SPEAK         = 0x200000n;       // SPEAK
  const SEND_THREAD   = 0x4000000000n;   // SEND_MESSAGES_IN_THREADS
  const CREATE_THREAD = 0x800000000n;    // CREATE_PUBLIC_THREADS

  // ── 3. Category-name → profile catalogue ───────────────────────────
  // Matched by substring (case-insensitive) on the category name. The
  // names came out of the original server build (server-spec.js); if
  // anyone renames a category in Discord, this match still works as
  // long as the keyword stays.
  // ORDER MATTERS: first match wins. Staff/admin/mod patterns are
  // listed FIRST so a hypothetical "mod hangout" in the staff
  // category can't fall through to one of the more permissive
  // member-tier profiles.
  const CAT_PROFILES = [
    { match: /staff|admin|moderator|mod[\s-]?only/i, profile: 'staff' },
    { match: /patron/i,        profile: 'patron'      },
    { match: /start/i,         profile: 'open'         },
    { match: /voice/i,         profile: 'voice-member' },
    { match: /community/i,     profile: 'member'       },
    { match: /streams|content/i, profile: 'member'     },
    { match: /products/i,      profile: 'member'       },
    { match: /games|play/i,    profile: 'member'       },
    { match: /minecraft/i,     profile: 'member'       },
  ];

  // Channel-name → extra-flag catalogue. These layer ON TOP of the
  // category profile after the sync.
  const READ_ONLY_PATTERNS = [
    /rules/i, /announcement/i, /announce/i,
    /activity.?feed/i, /live.?now/i, /highlights/i, /mod.?log/i,
  ];

  function categoryProfile(catName) {
    for (const p of CAT_PROFILES) if (p.match.test(catName || '')) return p.profile;
    return 'member';   // safe default
  }
  function isReadOnly(chName) {
    return READ_ONLY_PATTERNS.some(rx => rx.test(chName || ''));
  }

  // ── 4. Build the intended overwrite array per profile ──────────────
  function buildOverwrites(profile) {
    const out = [];
    switch (profile) {
      case 'open':
        // No overwrites — channels default to "anyone with role can see".
        // Pre-verification members hit @everyone permissions only,
        // which include VIEW_CHANNEL by default.
        break;
      case 'member':
        out.push({ id: everyoneId, type: 0, allow: '0', deny:  String(VIEW) });
        out.push({ id: memberId,   type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        out.push({ id: modId,      type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        out.push({ id: ownerId,    type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        break;
      case 'voice-member':
        out.push({ id: everyoneId, type: 0, allow: '0', deny: String(VIEW | CONNECT) });
        out.push({ id: memberId,   type: 0, allow: String(VIEW | CONNECT | SPEAK), deny: '0' });
        out.push({ id: modId,      type: 0, allow: String(VIEW | CONNECT | SPEAK), deny: '0' });
        out.push({ id: ownerId,    type: 0, allow: String(VIEW | CONNECT | SPEAK), deny: '0' });
        break;
      case 'patron':
        out.push({ id: everyoneId, type: 0, allow: '0', deny: String(VIEW) });
        out.push({ id: patronId,   type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        out.push({ id: modId,      type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        out.push({ id: ownerId,    type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        break;
      case 'staff':
        out.push({ id: everyoneId, type: 0, allow: '0', deny: String(VIEW) });
        out.push({ id: modId,      type: 0, allow: String(VIEW | HISTORY | SEND), deny: '0' });
        out.push({ id: ownerId,    type: 0, allow: String(VIEW | HISTORY | SEND), deny: '0' });
        break;
    }
    return out;
  }

  function withReadOnlyExtra(base) {
    // Merge a SEND-deny onto the @everyone row (creating one if the
    // profile didn't have it). Preserves the existing VIEW state.
    const out = base.map(o => ({ ...o }));
    let row = out.find(o => o.id === everyoneId && o.type === 0);
    const denyMask = SEND | SEND_THREAD | CREATE_THREAD;
    if (!row) {
      row = { id: everyoneId, type: 0, allow: '0', deny: String(denyMask) };
      out.unshift(row);
    } else {
      const cur = BigInt(row.deny || '0');
      row.deny = String(cur | denyMask);
    }
    return out;
  }

  // ── 5. Apply ──────────────────────────────────────────────────────
  const report = { guildId, dryRun, categories: [], channels: [] };

  // Normalise existing overwrites for diff comparison (sorted by id,
  // bigint-equality on allow/deny so a "0x400" vs "1024" string diff
  // doesn't count as a change).
  function normaliseOverwrites(arr) {
    return (Array.isArray(arr) ? arr : [])
      .map(o => ({ id: String(o.id), type: Number(o.type),
                   allow: String(BigInt(o.allow || '0')),
                   deny:  String(BigInt(o.deny  || '0')) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  function overwritesEqual(a, b) {
    const na = normaliseOverwrites(a);
    const nb = normaliseOverwrites(b);
    if (na.length !== nb.length) return false;
    for (let i = 0; i < na.length; i++) {
      if (na[i].id !== nb[i].id) return false;
      if (na[i].type !== nb[i].type) return false;
      if (na[i].allow !== nb[i].allow) return false;
      if (na[i].deny  !== nb[i].deny)  return false;
    }
    return true;
  }

  async function patchOverwrites(channelId, overwrites) {
    if (dryRun) return { ok: true, dryRun: true };
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission_overwrites: overwrites }),
    });
    if (!r.ok) return { ok: false, status: r.status, body: (await r.text()).slice(0, 200) };
    return { ok: true };
  }

  // First pass: categories.
  const catById = new Map();
  for (const c of channels) {
    if (c.type !== 4) continue;
    const profile = categoryProfile(c.name);
    const desired = buildOverwrites(profile);
    catById.set(c.id, { profile, desired });
    const before = normaliseOverwrites(c.permission_overwrites);
    const after  = normaliseOverwrites(desired);
    if (overwritesEqual(c.permission_overwrites, desired)) {
      report.categories.push({ id: c.id, name: c.name, profile, action: 'no-change' });
      continue;
    }
    const r = await patchOverwrites(c.id, desired);
    report.categories.push({
      id: c.id, name: c.name, profile,
      action: r.ok ? 'patched' : 'failed',
      detail: r.ok ? undefined : r,
      before, after,
    });
  }

  // Second pass: every non-category, non-thread child channel.
  for (const c of channels) {
    if (c.type === 4) continue;                  // skip categories
    if (c.type === 11 || c.type === 12) continue; // skip threads
    const parent = c.parent_id ? catById.get(c.parent_id) : null;
    let desired;
    let basis;
    if (parent) {
      desired = parent.desired.map(o => ({ ...o }));
      basis   = 'category:' + parent.profile;
    } else {
      // No parent — use the open profile so we don't accidentally
      // hide things at the root level.
      desired = buildOverwrites('open');
      basis   = 'orphan:open';
    }
    if (isReadOnly(c.name)) {
      desired = withReadOnlyExtra(desired);
      basis += '+readOnly';
    }
    if (overwritesEqual(c.permission_overwrites, desired)) {
      report.channels.push({ id: c.id, name: c.name, parent_id: c.parent_id || null, basis, action: 'no-change' });
      continue;
    }
    const before = normaliseOverwrites(c.permission_overwrites);
    const after  = normaliseOverwrites(desired);
    const r = await patchOverwrites(c.id, desired);
    report.channels.push({
      id: c.id, name: c.name, parent_id: c.parent_id || null, basis,
      action: r.ok ? 'patched' : 'failed',
      detail: r.ok ? undefined : r,
      before, after,
    });
  }

  // Summary counters.
  const tally = (arr) => arr.reduce((m, e) => { m[e.action] = (m[e.action] || 0) + 1; return m; }, {});
  report.summary = {
    categories: tally(report.categories),
    channels:   tally(report.channels),
  };
  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_quest-trace/:guildId/:userId  (one-shot KV token) -------
//
// Diagnostic for the linked-patreon Welcome-Checklist step. Reports
// every signal the worker reads + the snapshot result + an optional
// dry-claim outcome (?claim=1 actually runs claimStep). Used to verify
// the auto-mark-on-web fix before/after the user actually hits the
// site.
async function handleQuestTrace(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  const userId  = parts[3];
  if (!guildId || !userId) return new Response('guildId + userId required', { status: 400 });
  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('quest-trace already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  const claim = u.searchParams.get('claim') === '1';
  const markFlag = u.searchParams.get('mark') === '1';
  const report = { guildId, userId, signals: {}, snapshot: null, claim: null };

  // Read each signal individually.
  report.signals.explicit_flag = !!(await env.LOADOUT_BOLTS.get(`quest:patreon-linked:${guildId}:${userId}`));
  const tier = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
  report.signals.patreon_tier  = tier ? { present: true, hasImageUrl: !!(tier.imageUrl || tier.image_url || tier.avatar) } : { present: false };
  const wallet = await env.LOADOUT_BOLTS.get(`wallet:${guildId}:${userId}`, { type: 'json' });
  const links = Array.isArray(wallet?.links) ? wallet.links : [];
  report.signals.wallet_links = {
    present: !!wallet,
    platforms: links.map(l => l?.platform).filter(Boolean),
    hasPatreon: links.some(l => String(l?.platform || '').toLowerCase() === 'patreon'),
  };

  // Optional: pretend we hit the web bridge by marking the flag first.
  if (markFlag) {
    const { markPatreonLinked } = await import('./quests.js');
    const mark = await markPatreonLinked(env, guildId, userId);
    report.mark_applied = mark;
  }

  // Snapshot the checklist.
  const { getSnapshot, claimStep } = await import('./quests.js');
  const snap = await getSnapshot(env, guildId, userId);
  const stepRow = (snap.steps || []).find(s => s.id === 'linked-patreon');
  report.snapshot = {
    summary: snap.summary,
    linked_patreon: stepRow || null,
  };

  // Optional: actually run the claim.
  if (claim) {
    report.claim = await claimStep(env, guildId, userId, 'linked-patreon');
  }
  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/guild-inventory/:guildId ------------------------------------
//
// Read-only dump of every category, channel, role, and AutoMod rule in
// the target guild — same admin-auth as the register/list endpoints
// (per-guild HMAC OR AQUILO_SITE_WEB_SECRET fallback). Used to recon
// existing server state before applying a guild-build.
async function handleGuildInventory(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'guild-inventory', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature or guild not registered', { status: 401 });

  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });

  const H = { Authorization: 'Bot ' + token };
  async function gj(p) {
    const r = await fetch(`https://discord.com/api/v10${p}`, { headers: H });
    if (!r.ok) return { _error: `${r.status} ${(await r.text()).slice(0, 200)}` };
    return r.json();
  }
  const [guild, channels, roles, automod] = await Promise.all([
    gj(`/guilds/${guildId}?with_counts=true`),
    gj(`/guilds/${guildId}/channels`),
    gj(`/guilds/${guildId}/roles`),
    gj(`/guilds/${guildId}/auto-moderation/rules`),
  ]);

  // Channel TYPES per Discord docs:
  //   0=GUILD_TEXT, 2=GUILD_VOICE, 4=GUILD_CATEGORY, 5=GUILD_ANNOUNCEMENT,
  //   13=GUILD_STAGE_VOICE, 15=GUILD_FORUM, 16=GUILD_MEDIA
  const TYPE_NAME = {
    0: 'text', 2: 'voice', 4: 'category', 5: 'announcement',
    13: 'stage', 15: 'forum', 16: 'media',
  };
  const slim = Array.isArray(channels) ? channels.map(c => ({
    id: c.id, name: c.name, type: c.type, type_name: TYPE_NAME[c.type] || `unknown_${c.type}`,
    parent_id: c.parent_id || null, position: c.position,
  })) : [];
  slim.sort((a, b) => {
    // Group by parent: categories first (parent_id===null), then children grouped under parent.
    const ap = a.parent_id || '';
    const bp = b.parent_id || '';
    if (ap !== bp) return ap.localeCompare(bp);
    return a.position - b.position;
  });
  const rolesSlim = Array.isArray(roles) ? roles.map(r => ({
    id: r.id, name: r.name, position: r.position, color: r.color,
    hoist: r.hoist, mentionable: r.mentionable, managed: r.managed,
    permissions: r.permissions,
  })).sort((a, b) => b.position - a.position) : [];

  return new Response(JSON.stringify({
    ok: true,
    guild: guild && !guild._error ? {
      id: guild.id, name: guild.name,
      member_count: guild.approximate_member_count,
      premium_tier: guild.premium_tier, features: guild.features,
    } : { error: guild?._error },
    channels: slim,
    roles:    rolesSlim,
    automod:  Array.isArray(automod) ? automod : (automod?._error ? [{ _error: automod._error }] : []),
  }, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/guild-build/:guildId  --------------------------------------
//
// Idempotent reconciler — applies the baked SERVER_SPEC against the
// guild's current state. Default mode is DRY-RUN; pass ?apply=1 to
// execute. Same admin auth as guild-inventory.
//
// Reconciliation strategy:
//   • Categories matched by name (after normalisation). Missing →
//     created. Existing → kept (no destructive delete).
//   • Channels matched by name. Missing → created in correct
//     category. Existing → re-parented to the spec category +
//     ensured to be the right TYPE if a type mismatch is recoverable
//     (we never delete to fix a type mismatch — we leave it + log).
//   • Roles matched by name. Missing → created with color/hoist;
//     existing → kept.
//   • Nothing is deleted. The endpoint returns a `noted_extras`
//     list of channels/roles that exist in the guild but aren't in
//     the spec, so the caller can decide whether to remove them
//     manually.

async function handleGuildBuild(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'guild-build', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const url0 = new URL(req.url);
  const apply = url0.searchParams.get('apply') === '1';

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature or guild not registered', { status: 401 });

  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });

  const { SERVER_SPEC } = await import('./server-spec.js');
  const { applyServerSpec } = await import('./guild-builder.js');
  const result = await applyServerSpec(token, guildId, SERVER_SPEC, { apply });
  return new Response(JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 207,
    headers: { 'content-type': 'application/json' },
  });
}

async function handleGuildFinalize(req, env, path) {
  const guildId = path.split('/').filter(Boolean)[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature', { status: 401 });
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });
  const { applyPhase2 } = await import('./guild-builder.js');
  const result = await applyPhase2(token, guildId, env.LOADOUT_BOLTS);
  return new Response(JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 207,
    headers: { 'content-type': 'application/json' },
  });
}

async function handleGuildAutomod(req, env, path) {
  const guildId = path.split('/').filter(Boolean)[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature', { status: 401 });
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });

  // Discord AutoMod TRIGGER TYPES:
  //   1=KEYWORD, 3=SPAM, 4=KEYWORD_PRESET, 5=MENTION_SPAM, 6=MEMBER_PROFILE
  // ACTION TYPES: 1=BLOCK_MESSAGE, 2=SEND_ALERT_MESSAGE, 3=TIMEOUT
  //
  // Three baseline rules. KEYWORD_PRESET 1=PROFANITY 2=SEXUAL_CONTENT 3=SLURS.
  const cfg = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
  const modLogId = cfg?.ids?.ch_mod_log;
  const baseAction = modLogId
    ? [{ type: 1 }, { type: 2, metadata: { channel_id: modLogId } }]
    : [{ type: 1 }];

  const rules = [
    {
      // Discord caps KEYWORD_PRESET rules at ONE per guild — so all
      // three baked-in word lists go into the single rule.
      // PRESET ids: 1=PROFANITY, 2=SEXUAL_CONTENT, 3=SLURS.
      name: 'Profanity + sexual + slurs (Discord presets)',
      event_type: 1, // MESSAGE_SEND
      trigger_type: 4,
      trigger_metadata: { presets: [1, 2, 3] },
      actions: baseAction,
      enabled: true,
    },
    {
      name: 'Spam keywords (custom)',
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: {
        keyword_filter: [
          'discord-nitro', 'free-nitro', 'free nitro', 'steam-gift-card',
          '@everyone @here', '*free* *nitro*',
        ],
      },
      actions: baseAction,
      enabled: true,
    },
    {
      name: 'Mention spam (>5 unique pings)',
      event_type: 1,
      trigger_type: 5,
      trigger_metadata: { mention_total_limit: 5 },
      actions: baseAction,
      enabled: true,
    },
    {
      name: 'Suspicious links',
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: {
        keyword_filter: [
          'https://discord-nitro*', 'https://discord-gift*', 'https://steamcommunity*free*',
          'https://*.zip/*', 'https://*.ru/*free*',
        ],
      },
      actions: baseAction,
      enabled: true,
    },
  ];

  // Idempotent upsert: fetch existing rules, delete any whose name
  // matches one we're about to create (so a re-run produces the same
  // end-state instead of "max rules exceeded"). Also clean up the
  // legacy "Slurs (Discord preset)" name that the first build created.
  //
  // PLUS: trigger types 4 (KEYWORD_PRESET) and 5 (MENTION_SPAM) are
  // capped at 1 rule per type per guild. Whatever existing rule
  // occupies those slots gets removed too — our managed rule has to
  // be the single occupant for the create to succeed. (Name-match
  // alone misses these when Discord normalises the stored name
  // slightly differently than what we POSTed.)
  const existingRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules`, {
    headers: { Authorization: 'Bot ' + token },
  });
  const existing = existingRes.ok ? await existingRes.json() : [];
  const targetNames = new Set([...rules.map(r => r.name), 'Slurs (Discord preset)', 'Sexual content (Discord preset)']);
  const cappedTypes = new Set(rules.map(r => r.trigger_type).filter(t => t === 4 || t === 5));
  const deleted = [];
  const deleteFailures = [];
  for (const r of existing) {
    const byName = targetNames.has(r.name);
    const byCapType = cappedTypes.has(r.trigger_type);
    if (!byName && !byCapType) continue;
    const d = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules/${r.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bot ' + token },
    });
    if (d.ok) {
      deleted.push({ name: r.name, id: r.id, reason: byName ? 'name-match' : 'capped-type-slot' });
    } else {
      const t = await d.text();
      deleteFailures.push({ name: r.name, id: r.id, status: d.status, body: t.slice(0, 200) });
    }
    await new Promise(rr => setTimeout(rr, 250));
  }

  const created = [];
  const patched = [];
  const errors = [];
  for (const rule of rules) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules`, {
      method: 'POST',
      headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    });
    const text = await r.text();
    if (r.ok) {
      try { created.push({ rule: rule.name, id: JSON.parse(text).id }); } catch { created.push({ rule: rule.name }); }
      await new Promise(rr => setTimeout(rr, 250));
      continue;
    }
    // Fallback: if the create failed because the per-type cap is full
    // (e.g. Discord pre-installs an undeletable Mention Spam rule on
    // Community servers), find the existing rule of that trigger_type
    // and PATCH it to our desired settings instead.
    let isCapHit = false;
    try {
      const errBody = JSON.parse(text);
      if (errBody?.errors?._errors?.some(e => e.code === 'AUTO_MODERATION_MAX_RULES_OF_TYPE_EXCEEDED')) {
        isCapHit = true;
      }
    } catch { /* fall through */ }
    if (isCapHit) {
      const occupant = existing.find(e => e.trigger_type === rule.trigger_type);
      if (occupant) {
        const p = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules/${occupant.id}`, {
          method: 'PATCH',
          headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: rule.name,
            event_type: rule.event_type,
            trigger_metadata: rule.trigger_metadata,
            actions: rule.actions,
            enabled: rule.enabled,
          }),
        });
        if (p.ok) {
          patched.push({ rule: rule.name, id: occupant.id, reason: 'cap-hit-patched-existing' });
        } else {
          const pt = await p.text();
          errors.push({ rule: rule.name, status: p.status, body: pt.slice(0, 300) });
        }
        await new Promise(rr => setTimeout(rr, 250));
        continue;
      }
    }
    errors.push({ rule: rule.name, status: r.status, body: text.slice(0, 300) });
    await new Promise(rr => setTimeout(rr, 250));
  }

  return new Response(JSON.stringify({ ok: errors.length === 0, deleted, deleteFailures, created, patched, errors }, null, 2), {
    status: errors.length === 0 ? 200 : 207,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- /admin/ticket-panel/:guildId  (HMAC) --------------------------------
// Body: { channelId: "<id>" } — posts the ticket-panel button in that
// channel and remembers it as the panel target for future reposts /
// stale-message replacement.
async function handleTicketPanelPost(req, env, path) {
  const guildId = path.split('/').filter(Boolean)[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const bodyText = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, bodyText);
  if (!auth.ok) return new Response('bad signature', { status: 401 });
  if (!env.DISCORD_BOT_TOKEN) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });
  let body;
  try { body = JSON.parse(bodyText || '{}'); } catch { body = {}; }
  const channelId = String(body.channelId || '').trim();
  if (!/^\d{5,25}$/.test(channelId)) return new Response('bad channelId', { status: 400 });
  const { postTicketPanel } = await import('./tickets.js');
  const result = await postTicketPanel(env, guildId, channelId);
  return new Response(JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 502,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- helpers ------------------------------------------------------------

function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function randomCode(len) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I/L/O/0/1 to avoid OCR confusion
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
function randomSecret() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

// Build the weekly-digest Discord embed from the DLL's stats snapshot.
// Discord embed reference: https://discord.com/developers/docs/resources/channel#embed-object
function buildDigestEmbed(p) {
  const emoji = p.boltsEmoji || '⚡';
  const name  = p.boltsName  || 'Bolts';
  const fmtNum = (n) => {
    const x = Number(n) || 0;
    return x.toLocaleString('en-US');
  };
  const fmtUsd = (n) => '$' + (Number(n) || 0).toFixed(2);
  const safeStreamer = (p.streamerName || '').trim() || 'this stream';
  const accentInt = parseInt((p.accent || '#3A86FF').replace('#', ''), 16) || 0x3A86FF;

  // Top earners: fenced-code list so handles align cleanly even with
  // wide names. Markdown won't help much in Discord embeds — the
  // monospace block is the most legible option.
  const top = Array.isArray(p.topEarners) ? p.topEarners : [];
  let topField;
  if (top.length === 0) {
    topField = '_no activity this week_';
  } else {
    const maxName = top.reduce((m, e) => Math.max(m, (e.user || '').length), 0);
    const lines = top.map((e, i) => {
      const medal = ['🥇', '🥈', '🥉', '4.', '5.'][i] || ((i + 1) + '.');
      const handle = (e.user || '?').padEnd(Math.min(maxName, 16), ' ');
      return `${medal}  \`${handle}\`  ${fmtNum(e.bolts)} ${emoji}`;
    });
    topField = lines.join('\n');
  }

  // Highlights field — auto-pruned to skip rows that didn't happen.
  const highlights = [];
  if (p.hypeTrains > 0) highlights.push(`🚂  **${p.hypeTrains}** hype train${p.hypeTrains === 1 ? '' : 's'} (peak Lv ${p.hypeTrainMaxLevel || 0})`);
  if (p.heistsSucceeded > 0) {
    const crew = p.biggestHeistCrew > 0 ? ` — biggest pulled with ${p.biggestHeistCrew} crewmates for ${fmtNum(p.biggestHeistPot)} ${emoji}` : '';
    highlights.push(`🦹  **${p.heistsSucceeded}** heist${p.heistsSucceeded === 1 ? '' : 's'} pulled${crew}`);
  }
  if (p.minigamesPlayed > 0) highlights.push(`🎰  **${fmtNum(p.minigamesPlayed)}** minigames played`);
  if (p.tipsCount > 0) {
    const big = p.biggestTipUsd > 0 ? ` — biggest from **${p.biggestTipper || 'anonymous'}** at ${fmtUsd(p.biggestTipUsd)}` : '';
    highlights.push(`💖  **${p.tipsCount}** tip${p.tipsCount === 1 ? '' : 's'} totalling ${fmtUsd(p.tipsTotalUsd)}${big}`);
  }
  if (p.welcomesShown > 0) highlights.push(`👋  **${fmtNum(p.welcomesShown)}** welcome${p.welcomesShown === 1 ? '' : 's'} delivered`);
  const highlightsField = highlights.length > 0 ? highlights.join('\n') : '_quiet week — try a hype train next stream._';

  return {
    title:       `📊 Weekly digest — ${safeStreamer}`,
    description: `Here's what went down this week.`,
    color:       accentInt,
    timestamp:   new Date().toISOString(),
    fields: [
      {
        name:   `${emoji} ${name} earned`,
        value:  `**${fmtNum(p.boltsEarned)}** ${name.toLowerCase()}`,
        inline: true
      },
      {
        name:   '🎯 Activity',
        value:  `${fmtNum(p.minigamesPlayed)} games · ${fmtNum(p.heistsSucceeded)} heists · ${fmtNum(p.hypeTrains)} trains`,
        inline: true
      },
      {
        name:   '​',                        // zero-width spacer — keeps layout stable
        value:  '​',
        inline: true
      },
      {
        name:   '🏆 Top 5 earners',
        value:  topField.slice(0, 1024),         // Discord field cap
        inline: false
      },
      {
        name:   '✨ Highlights',
        value:  highlightsField.slice(0, 1024),
        inline: false
      }
    ],
    footer: {
      text: `Loadout · ${new Date(p.weekStartedUtc || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${new Date(p.weekEndedUtc || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    }
  };
}
