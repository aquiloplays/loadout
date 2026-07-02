// /web/*, site → bot RPC for the aquilo.gg site.
//
// aquilo-site's Pages Functions own the Patreon auth (aq_link cookie +
// per-session webSig CSRF token). When a logged-in patron triggers an
// action on the website, the site Pages Function verifies the cookie,
// then HMAC-signs a request here. We trust the discordId the site
// claims as long as the HMAC verifies.
//
// All POST so the HMAC body is always present and the signing
// scheme is uniform. HMAC = SHA-256 over `ts + "\n" + body`,
// hex-encoded. Headers: x-aquilo-web-ts, x-aquilo-web-sig. 5-min
// timestamp skew. Mirrors the /sync/:guildId scheme exactly.
//
// (Bolts economy sunset 2026-06: the wallet / daily / coinflip / dice /
// quick-games / sports-betting / banner / spire / aether routes that used
// to live here have been removed along with their backing modules.)

// (Bolts economy sunset 2026-06: games.js / games-quick.js / wallet.js /
// bet.js imports removed — coinflip/dice/daily, quick games, wallet, and
// sports betting are gone.)
import { recordStat } from './recap.js';
import { verifyHmac } from './auth.js';
import {
  snapshotQueue,
  openQueue,
  closeQueue,
  closeNight,
  notifyQueueOpened,
} from './queue.js';
import { handleAdminWeb } from './admin-web.js';
// (Bolts economy sunset 2026-06: cards-web.js / boardgames-web.js imports
// removed — Boltbound + board games are dormant and must not be bundled.)

const ROUTES = new Set([
  // (Bolts economy sunset 2026-06: wallet / daily / coinflip / dice routes removed)
  // Community-chat reactions surface, see aquilo/community-chat.js
  // for the storage + Discord REST wiring. /web/chat/recent returns
  // the ringbuffer enriched with per-message reactions (native
  // Discord + web-side KV merged). /web/chat/react + /web/chat/unreact
  // toggle on behalf of the requesting aquilo user.
  'chat/recent',
  'chat/react',
  'chat/unreact',
  // Live-poll admin surface, PWA admin UI consumes these. Owner-
  // gated via the existing _owner flag pattern. See custom-polls.js
  // adminListPolls / adminPollDetail / adminLockPoll / adminExtendPoll
  // / adminCancelPoll. Each accepts a body { pollId, ... } except
  // `list` which is parameterless.
  'admin/polls/list',
  'admin/polls/detail',
  'admin/polls/lock',
  'admin/polls/extend',
  'admin/polls/cancel',
  // Support tickets, PWA admin compartment (Clay 2026-05-28).
  // Owner-gated via the same _owner flag pattern. See
  // support-tickets.js. Read + mutate the ticket queue.
  'admin/tickets/list',
  'admin/tickets/detail',
  'admin/tickets/respond',
  'admin/tickets/close',
  'admin/tickets/assign',
  'admin/tickets/priority',
  'admin/tickets/category',
  // Streamlabs multistream RTMP creds surface for the OBS dock (Clay
  // 2026-06-04). Owner-only via the same _owner flag. Streamlabs has no
  // API for the RTMP ingest URL / stream key, so Clay pastes them once
  // (save) and the OBS dock reads them back with copy buttons. Stored in
  // KV streamlabs:multistream:<discordId>.
  'admin/dock/streamkey',
  'admin/dock/streamkey-save',
  // L9, PWA chat (Clay 2026-05-28): expose every guild text channel
  // the requesting Discord user has VIEW_CHANNEL permission on, so
  // the PWA can switch between channels instead of being capped at
  // the COMMUNITY_CHAT_CHANNELS_JSON allow-list.
  'chat/channels',
  // (Bolts economy sunset 2026-06: quick bolts games removed —
  // quick/snapshot, blackjack/*, roulette, wheel, hilo/*, mines/*, plinko.)
  // (Bolts economy sunset 2026-06: sports betting removed — bet/snapshot, bet/place.)
  'queues/snapshot',
  'queues/open',
  'queues/close',
  'queues/close-night',
  // (Bolts economy sunset 2026-06: Banners + Banner Wars routes removed —
  // banner founding cost bolts.)
  // 2026-05-29, UI-live unblockers. MVPs land worker endpoints for
  // four features whose site UI shipped against stubs.
  'play/supporters/hall',
  'play/supporters/opt-out',
  'play/patron-of-month/current',
  'play/patron-of-month/history',
  'play/patron-of-month/opt-out',
  // (Bolts economy sunset: Boltbound dust-crafting (play/dust/*) and
  // card-pack drops (play/drops/*) routes were removed.)
  // (Bolts economy sunset 2026-06: stream/bonus-state removed — economy multipliers.)
  'play/cosmetics/me',
  // (Bolts economy sunset 2026-06: play/banner/* + play/war/* routes removed)
  // New-viewer funnel, referral attribution. /me returns the
  // caller's stable referral code + bring-in stats; /attribute is
  // what the site POSTs after Patreon-link to record (refereeId,
  // refCode). (Bolts economy sunset 2026-06: the first-game milestone
  // payout that used to fire from the game routes is gone; the
  // patreon-link milestone still fires from routeQuestMarkPatreonLinked.)
  'referral/me',
  'referral/attribute',
  'admin/snapshot',
  'admin/panel-test',           // POST {_owner, action, ...}, owner-only panel test harness (isolated test:* state, dry-run tampers)
  'admin/vault/api',            // POST {_owner, action, ...}, Knowledge Vault (Kindle + PDF highlights). See vault.js
  'admin/kitchen/api',          // POST {_owner, action, ...}, Aquilo Kitchen (weekly meal planner). See kitchen.js
  'admin/config',
  'admin/active-guild',
  'admin/clear-binding',
  'admin/pipe-tests',
  'admin/triple-c/set',          // POST {_owner, gameSlug}, lock the Triple-C campaign + announce
  'admin/dad-sunday/set',        // POST {_owner, gameSlug}, lock Dad Game Sunday + announce
  'admin/lineup/post',           // POST {_owner}, (re)post + pin the weekly lineup recap
  'admin/stream-events/sync',    // POST {_owner, horizonDays?}, mirror schedule → Discord events
  // Daily community check-in (unified with /checkin slash command).
  'checkin',                 // POST, record today's check-in
  'checkin/status',          // POST, read streak + card + pending bonuses
  'checkin/card',            // POST, upsert the user's embed card config
  'checkin/emotes',          // POST, the guild's custom emoji (punch-stamp picker)
  // (Bolts economy sunset 2026-06: checkin/bonus/collect removed — bonus payout was removed)
  // Stream check-in card (on-stream "I'm here" card; stream-checkin.js).
  // Separate from the daily check-in above, D1-backed customization +
  // entitlement-gated cosmetics + the OBS overlay trigger.
  'checkin/card/me',         // POST, saved config + earned badges + filtered catalogs
  'checkin/card/save',       // POST, validate vs entitlements + upsert config
  'checkin/show',            // POST, rate-limited; publish streamcheckin.shown to OBS
  'checkin/badges',          // POST, earned-badge list (optional lookupUserId)
  // Boltbound per-user card art override (meme-GIF skin layer).
  // Rendering integrated 2026-05-28: cards-web routeState ships the
  // user's overrides + the global defaults in the bootstrap payload.
  'cards/art-override',      // POST, { op: 'get'|'set'|'clear'|'list', cardId, url? }
  'cards/suggest-art-terms', // POST, { cardId } → { searchTerms, description }
  // Skin endpoints, thin REST-shaped wrappers on cards-art-override
  // for the site to call directly instead of building op:set/etc
  // payloads. /web is POST-only so the spec's DELETE + GET get
  // mapped to POST /cards/skin/clear + POST /cards/skins.
  'cards/skin',              // POST, { cardId, gifUrl } → set the user's skin
  'cards/skin/clear',        // POST, { cardId }         → clear it
  'cards/skins',             // POST, {}                 → { skins: { cardId: url } }
  // (Bolts economy sunset 2026-06: Seasonal Spire routes removed —
  // Boltbound-deck roguelike riding with the dormant Boltbound surface.)
  // New-viewer funnel, referrals + onboarding quest.
  'referral/me',             // POST, my code + stats
  'referral/attribute',      // POST, record that this user was referred by CODE
  // (Bolts economy sunset 2026-06: Aether economy routes removed — premium currency.)
  'quest/snapshot',          // POST, checklist with claim state
  'quest/claim',             // POST, claim one step (or 'all')
  'quest/mark-patreon-linked', // POST, flip the patreon-linked completion flag (called by site after OAuth)
  // Productization, self-serve setup wizard (web parity with /loadout-setup).
  'setup/snapshot',          // POST, full tenant + channel + feature state
  'setup/init',              // POST, register the tenant (idempotent)
  'setup/channel',           // POST, bind one channel slot
  'setup/feature',           // POST, toggle one feature on/off
  'setup/finish',            // POST, mark setup as complete
  'setup/branding',          // POST, { op: 'get' | undefined, brand: {...} }
  // Two-way Discord ↔ PWA chat relay. NOTE: the read path is namespaced
  // as `chat/relay/recent` to avoid colliding with main's existing
  // `chat/recent` (community-chat reactions reader, see L112). The
  // parallel aquilo-site session needs to call `/web/chat/relay/recent`
  // for the relay read; the reactions path stays at `/web/chat/recent`.
  'chat/send',               // POST, { channelId, content } → webhook post styled as caller
  'chat/relay/recent',       // POST, { channelId, limit? } → relay ringbuffer + per-msg sentViaPwa decoration
]);

// Only the bisherclay@gmail.com session is currently allowed to open
// or close queues from aquilo-site /admin. Owner-side gating happens
// on the site (functions/api/admin/queues/*), we double-check here
// by requiring the request to carry a `_owner: true` flag the site
// stamps after verifying the aq_link cookie's `o:1` field.
function ownerCheck(body) {
  return body && body._owner === true;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function handleWeb(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  if (!env.AQUILO_SITE_WEB_SECRET) {
    return json({ error: 'not-configured', message: 'AQUILO_SITE_WEB_SECRET missing on the bot' }, 503);
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/web\//, '').replace(/\/+$/, '');
  // (Bolts economy sunset 2026-06: Boltbound + board route prefix checks removed.)
  if (!ROUTES.has(route)) return json({ error: 'not-found' }, 404);

  // Read body once; verify HMAC against the raw bytes; only then parse.
  const bodyText = await req.text();
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad-json' }, 400); }

  const discordId = String((body && body.discordId) || '').trim();
  const guildId = String((body && body.guildId) || '').trim();
  if (!/^\d{5,25}$/.test(discordId)) return json({ error: 'bad-discord-id' }, 400);
  if (!/^\d{5,25}$/.test(guildId))   return json({ error: 'bad-guild-id' }, 400);

  // Bot-side multi-tenant gate. A guild must be a registered tenant
  // (created via /setup) to use any /web/* route. Aquilo is grandfathered
  // in via env.AQUILO_VAULT_GUILD_ID. A forged session for a guild that
  // never ran /setup still 403s here.
  //
  // Exception: setup/* routes bypass the gate because /setup is HOW a
  // guild becomes a tenant. They're still HMAC-gated and discordId-
  // bound, so only a logged-in user with site auth can hit them.
  if (!route.startsWith('setup/')) {
    const { isRegisteredTenant } = await import('./tenants.js');
    if (!(await isRegisteredTenant(env, guildId))) {
      return json({ error: 'guild-not-registered', message: 'This server has not completed /setup yet.' }, 403);
    }
  }

  try {
    // (Bolts economy sunset 2026-06: wallet + daily dispatch removed)
    if (route === 'chat/recent')  return await routeChatRecent(env, discordId, body);
    if (route === 'chat/react')   return await routeChatReact(env, discordId, body);
    if (route === 'chat/unreact') return await routeChatUnreact(env, discordId, body);
    if (route === 'chat/channels') return await routeChatChannels(env, guildId, discordId);
    if (route === 'admin/polls/list') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routePollsList(env);
    }
    if (route === 'admin/polls/detail') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routePollsDetail(env, body);
    }
    if (route === 'admin/polls/lock') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routePollsLock(env, body);
    }
    if (route === 'admin/polls/extend') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routePollsExtend(env, body);
    }
    if (route === 'admin/polls/cancel') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routePollsCancel(env, body);
    }
    if (route === 'admin/panel-test') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      const { handlePanelTest } = await import('./panel-test.js');
      return handlePanelTest(env, guildId, discordId, body);
    }
    if (route === 'admin/vault/api') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      const { handleVaultApi } = await import('./vault.js');
      return handleVaultApi(env, body);
    }
    if (route === 'admin/kitchen/api') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      const { handleKitchenApi } = await import('./kitchen.js');
      return handleKitchenApi(env, body);
    }
    if (route === 'admin/tickets/list') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeTicketsList(env, guildId, body);
    }
    if (route === 'admin/tickets/detail') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeTicketsDetail(env, body);
    }
    if (route === 'admin/tickets/respond') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeTicketsRespond(env, discordId, body);
    }
    if (route === 'admin/tickets/close') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeTicketsClose(env, discordId, body);
    }
    if (route === 'admin/tickets/assign') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeTicketsAssign(env, discordId, body);
    }
    if (route === 'admin/tickets/priority') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeTicketsPriority(env, discordId, body);
    }
    if (route === 'admin/tickets/category') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeTicketsCategory(env, discordId, body);
    }
    if (route === 'admin/dock/streamkey') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeDockStreamkeyGet(env, discordId);
    }
    if (route === 'admin/dock/streamkey-save') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeDockStreamkeySave(env, discordId, body);
    }
    // (Bolts economy sunset 2026-06: coinflip / dice / quick games
    // (blackjack/roulette/wheel/hilo/mines/plinko) / sports betting dispatch removed)
    if (route === 'queues/snapshot') return await routeQueuesSnapshot(env, guildId, body);
    if (route === 'queues/open') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeQueuesOpen(env, guildId, body);
    }
    if (route === 'queues/close') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeQueuesClose(env, guildId, body);
    }
    if (route === 'queues/close-night') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeQueuesCloseNight(env, guildId);
    }
    if (route.startsWith('admin/'))        return await handleAdminWeb(env, route, guildId, body);
    if (route === 'checkin')               return await routeCommunityCheckin(env, guildId, discordId, body);
    if (route === 'checkin/status')        return await routeCommunityCheckinStatus(env, guildId, discordId);
    if (route === 'checkin/card')          return await routeCommunityCheckinCard(env, guildId, discordId, body);
    if (route === 'checkin/emotes') {
      const { getGuildEmotes } = await import('./community-checkin.js');
      return json({ ok: true, emotes: await getGuildEmotes(env, guildId) });
    }
    // (Bolts economy sunset 2026-06: checkin/bonus/collect dispatch removed — bonus payout was removed)
    if (route === 'checkin/card/me')       return await routeStreamCheckinCardMe(env, guildId, discordId);
    if (route === 'checkin/card/save')     return await routeStreamCheckinCardSave(env, guildId, discordId, body);
    if (route === 'checkin/show')          return await routeStreamCheckinShow(env, guildId, discordId, body);
    if (route === 'checkin/badges')        return await routeStreamCheckinBadges(env, guildId, discordId, body);
    if (route === 'cards/art-override')    return await routeCardsArtOverride(env, guildId, discordId, body);
    if (route === 'cards/suggest-art-terms') return await routeCardsSuggestArtTerms(env, body);
    if (route === 'cards/skin')            return await routeCardsSkinSet(env, guildId, discordId, body);
    if (route === 'cards/skin/clear')      return await routeCardsSkinClear(env, guildId, discordId, body);
    if (route === 'cards/skins')           return await routeCardsSkinList(env, guildId, discordId);
    // (Bolts economy sunset 2026-06: Seasonal Spire dispatch removed — Boltbound-deck roguelike)
    if (route === 'play/supporters/hall')         return await routeSupportersHall(env);
    if (route === 'play/supporters/opt-out')      return await routeSupportersOptOut(env, discordId, body);
    if (route === 'play/patron-of-month/current') return await routePatronCurrent(env);
    if (route === 'play/patron-of-month/history') return await routePatronHistory(env, body);
    if (route === 'play/patron-of-month/opt-out') return await routePatronOptOut(env, discordId, body);
    // (Bolts economy sunset 2026-06: Boltbound dust (play/dust/*) +
    // drops (play/drops/*) + card-back cosmetics (play/cards/back/*)
    // dispatch removed — all Boltbound surfaces.
    // stream/bonus-state dispatch removed — economy multipliers.)
    if (route === 'play/cosmetics/me')            return await routeCosmeticsMe(env, discordId);
    // (Bolts economy sunset 2026-06: play/banner/* + play/war/* dispatch removed)
    if (route === 'referral/me')              return await routeReferralMe(env, guildId, discordId);
    if (route === 'referral/attribute')       return await routeReferralAttribute(env, guildId, discordId, body);
    // (Bolts economy sunset 2026-06: aether/* dispatch removed — premium currency)
    if (route === 'quest/snapshot')           return await routeQuestSnapshot(env, guildId, discordId);
    if (route === 'quest/claim')              return await routeQuestClaim(env, guildId, discordId, body);
    if (route === 'quest/mark-patreon-linked') return await routeQuestMarkPatreonLinked(env, guildId, discordId);
    if (route === 'setup/snapshot')   return await routeSetupSnapshot(env, guildId, discordId);
    if (route === 'setup/init')       return await routeSetupInit(env, guildId, discordId);
    if (route === 'setup/channel')    return await routeSetupChannel(env, guildId, body);
    if (route === 'setup/feature')    return await routeSetupFeature(env, guildId, body);
    if (route === 'setup/finish')     return await routeSetupFinish(env, guildId, discordId);
    if (route === 'setup/branding')   return await routeSetupBranding(env, guildId, body);
    if (route === 'chat/send')        return await routeChatSend(env, guildId, discordId, body);
    if (route === 'chat/relay/recent') return await routeChatRelayRecent(env, guildId, discordId, body);
    // (Bolts economy sunset 2026-06: Boltbound + board route dispatch removed)
  } catch (e) {
    return json({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
  return json({ error: 'not-found' }, 404);
}

// ── Discord rich-presence web fallback ────────────────────────────────
// The browser can't reach Discord's local IPC, so the site reports the
// viewer's current aquilo.gg activity here and the worker persists it to
// KV (STATE) under presence:user:<id> with a short heartbeat-expiry. The
// site re-reports every 60s; a 200s TTL survives ~3 missed beats then the
// entry self-expires, so a closed tab never leaves a stale status stuck.
//
// This is the durable handoff: the actual "set the user's Discord status"
// step is a desktop concern (StreamFusion's discord-rpc client), blocked
// on Clay minting a Discord application client ID. Until then this feed is
// the source of truth that step will poll. See DISCORD-RICH-PRESENCE.md.
const PRESENCE_TTL_SEC = 200;
const PRESENCE_PREFIX = 'presence:user:';

function presenceKey(userId) { return PRESENCE_PREFIX + userId; }

// Trim free-text presence fields to a sane length so a forged payload
// can't bloat a KV value. Discord custom statuses cap ~128 chars anyway.
function clampPresenceStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').slice(0, max).trim();
}

export async function routePresenceUpdate(env, body) {
  const userId = String((body && body.userId) || '').trim();
  if (!/^\d{5,25}$/.test(userId)) return json({ error: 'bad-user-id' }, 400);
  if (!env.STATE) return json({ error: 'not-configured' }, 503);
  const rec = {
    userId,
    key: clampPresenceStr(body && body.key, 32) || 'idle',
    state: clampPresenceStr(body && body.state, 128),
    detail: clampPresenceStr(body && body.detail, 128),
    ts: Date.now(),
  };
  try {
    await env.STATE.put(presenceKey(userId), JSON.stringify(rec), { expirationTtl: PRESENCE_TTL_SEC });
  } catch (e) {
    return json({ error: 'store-failed', message: String((e && e.message) || e) }, 500);
  }
  return json({ ok: true, ttl: PRESENCE_TTL_SEC });
}

export async function routePresenceClear(env, body) {
  const userId = String((body && body.userId) || '').trim();
  if (!/^\d{5,25}$/.test(userId)) return json({ error: 'bad-user-id' }, 400);
  if (!env.STATE) return json({ error: 'not-configured' }, 503);
  try { await env.STATE.delete(presenceKey(userId)); } catch { /* idle */ }
  return json({ ok: true });
}

// Owner-gated read for the future desktop RPC consumer. Lists every live
// presence (KV TTL already evicts stale ones). Capped at 1000 keys, the
// active-viewer set never approaches that.
export async function routePresenceFeed(env) {
  if (!env.STATE) return json({ error: 'not-configured' }, 503);
  const out = [];
  try {
    const listed = await env.STATE.list({ prefix: PRESENCE_PREFIX, limit: 1000 });
    for (const k of listed.keys || []) {
      const raw = await env.STATE.get(k.name);
      if (!raw) continue;
      try { out.push(JSON.parse(raw)); } catch { /* skip malformed */ }
    }
  } catch (e) {
    return json({ error: 'read-failed', message: String((e && e.message) || e) }, 500);
  }
  return json({ ok: true, presences: out });
}

// (Bolts economy sunset 2026-06: routeWallet, noteGamePlayed, noteFirstGame,
// routeDaily, and routeCoinflip removed — wallet + daily + coinflip economy.)

// ── Stocks ────────────────────────────────────────────────────────────
// Mirror the panel's read pattern (catalog + per-ticker price + tiny
// recent-history slice for sparklines), plus the caller's holdings +
// balance so the trade panel can render position size & cost basis.

// (Bolts economy sunset 2026-06: Sports betting removed —
// routeBetSnapshot + routeBetPlace deleted.)

// ── Queue (Community / Variety Night) ─────────────────────────────────

async function routeQueuesSnapshot(env, guildId, body) {
  const date = body && body.streamDate ? String(body.streamDate) : null;
  const snap = await snapshotQueue(env, guildId, date);
  return json({ ok: true, ...snap });
}

async function routeQueuesOpen(env, guildId, body) {
  const r = await openQueue(env, guildId, {
    gameId: String(body && body.gameId || '').trim(),
    capMode: body && body.capMode,
    cap: body && body.cap,
    source: 'web',
  });
  // If this is the FIRST queue of the night, fire the PWA push fan-out
  // via the site's /api/push/queue-open receiver. Best-effort -- a
  // failed push doesn't block the queue from opening.
  if (r.ok) {
    try {
      await notifyQueueOpened(env, guildId, r.streamDate, r.gameId);
    } catch (e) {
      console.error('queue-open push notify failed:', e && e.message);
    }
  }
  return json(r, r.ok ? 200 : 400);
}

async function routeQueuesClose(env, guildId, body) {
  const r = await closeQueue(env, guildId, String(body && body.gameId || '').trim());
  return json(r, r.ok ? 200 : 400);
}

async function routeQueuesCloseNight(env, guildId) {
  const r = await closeNight(env, guildId);
  return json(r, r.ok ? 200 : 400);
}


// (Bolts economy sunset 2026-06: routeDice removed — dice economy game.)


// ── /web/referral/*, new-viewer funnel ─────────────────────────────
//
// POST /web/referral/me
//   Body:  { discordId, guildId }
//   Returns:
//     { ok: true,
//       code:  'ABC23456',                       // stable 8-char Crockford
//       link:  'https://aquilo.gg/?ref=ABC23456',
//       stats: { count, paid, lastUtc, history } }
//
// POST /web/referral/attribute
//   Body:  { discordId, guildId, refCode }
//   First-attribution-wins. Refuses self-referral and unknown codes.
//   Returns:
//     { ok: true,  referrerId, refCode }
//     { ok: false, error: 'refCode-required'  }   // HTTP 400
//     { ok: false, error: 'unknown-code'      }   // HTTP 400
//     { ok: false, error: 'self-referral'     }   // HTTP 400
//     { ok: false, error: 'already-attributed', referrerId }   // HTTP 400
//
// Module is dynamically imported so the cards-packs dependency only
// loads when referral KV is touched (keeps cold-start trim).
async function routeReferralMe(env, guildId, discordId) {
  const { getOrMintCode, getReferrerStats } = await import('./referrals.js');
  const code  = await getOrMintCode(env, guildId, discordId);
  const stats = await getReferrerStats(env, guildId, discordId);
  return json({
    ok: true,
    code,
    link: `https://aquilo.gg/?ref=${code}`,
    stats,
  });
}

async function routeReferralAttribute(env, guildId, discordId, body) {
  const refCode = String((body && body.refCode) || '').toUpperCase().trim();
  if (!refCode) return json({ ok: false, error: 'refCode-required' }, 400);
  const { recordAttribution } = await import('./referrals.js');
  const r = await recordAttribution(env, guildId, discordId, refCode);
  return json(r, r.ok ? 200 : 400);
}

// ── /web/anniversary/*, celebrations ────────────────────────────────
//
// POST /web/anniversary/check
//   Body: { discordId, guildId }
//   Returns: { ok: true, firstSeenUtc, anniversary: { years, daysUntil,
//              milestone, anniversaryToday, claimed, reward } | null }
//   `anniversary` is null when the user has no firstSeen record yet.
//
// POST /web/anniversary/celebrate
//   Body: { discordId, guildId }
//   Idempotent per (user, year). Grants scaling bolts + a cosmetic
//   anniversary badge only when today actually is the user's
//   anniversary AND that year hasn't been claimed.
//   Returns: { ok, granted, years?, reward?, reason? }
//
// (Bolts economy sunset 2026-06: Aether economy ledger removed —
// routeAetherBalance / routeAetherSpend / routeAetherHistory deleted.)

// (Bolts economy sunset 2026-06: Quick bolts games removed — applyRecap,
// routeQuickSnapshot, routeBlackjack{Start,Hit,Stand}, routeRoulette,
// routeWheel, routeHilo{Start,Guess,Cashout}, routeMines{Start,Reveal,Cashout},
// and routePlinko deleted.)

// ── Community-chat reactions ─────────────────────────────────────────
//
// Web users (aquilo.gg PWA / desktop) react to bridged Discord chat
// messages via these three routes. The bot is the only Discord-side
// reactor, see aquilo/community-chat.js for the per-user state
// model and the merge that produces the `me` flag.
//
// All three routes carry the standard discordId/guildId pair plus a
// channelId/messageId/emoji triple. channelId must be on the
// community-chat allow-list (parseAllowedChannels) so the surface
// can't be used to react in arbitrary channels.
//
// Exact reaction contract surfaced to the website (parallel
// aquilo-site session: build the UI against this shape):
//
//   {
//     emoji: { name: string, id: string|null, animated: boolean },
//     count: number,   // discord-native + web users beyond the first
//     me:    boolean   // requesting aquilo user is in the web set
//   }
//
// On /chat/recent each message gets `reactions: [...above...]`. On
// react/unreact the response returns the freshly-recomputed reactions
// array for the message so the UI can update without a refetch.

async function chatChannelCheck(env, channelId) {
  const { parseAllowedChannels } = await import('./aquilo/community-chat.js');
  const allowed = parseAllowedChannels(env);
  if (!allowed.includes(String(channelId))) {
    return { ok: false, error: 'channel-not-allowed', message: 'That channel is not on the community-chat allow-list.' };
  }
  return { ok: true };
}

async function routeChatRecent(env, discordId, body) {
  const channelId = String((body && body.channelId) || '').trim();
  const limit = Number((body && body.limit) || 25);
  if (!/^\d{5,25}$/.test(channelId)) return json({ ok: false, error: 'bad-channel-id' }, 400);
  const gate = await chatChannelCheck(env, channelId);
  if (!gate.ok) return json(gate, 403);
  const { readCommunityChatWithReactions } = await import('./aquilo/community-chat.js');
  const r = await readCommunityChatWithReactions(env, channelId, limit, discordId);
  return json(r);
}

// ── /web/chat/channels (HMAC) ────────────────────────────────────
//
// Returns every guild text channel the requesting Discord user can
// VIEW. Lets the PWA switch between channels instead of being capped
// to the COMMUNITY_CHAT_CHANNELS_JSON allow-list.
//
// Discord permission computation (per Discord API docs §6):
//   1. Start with the @everyone role's base permissions.
//   2. OR in the permissions of every role the user has.
//   3. If ADMINISTRATOR bit is set, user can see everything, skip
//      overwrites.
//   4. Apply channel overwrites in order:
//      a. @everyone overwrite (deny then allow)
//      b. Aggregate per-role overwrites for the user's roles
//         (combined deny then combined allow)
//      c. Per-user overwrite for this specific user (deny then allow)
//   5. VIEW_CHANNEL bit (0x400) set → user can see it.
//
// We rate-limit ourselves to ONE guild-channels fetch + one
// guild-member fetch per call; both are cached by Discord's CDN
// edge for ~few seconds, fine for a per-page-load read.
async function routeChatChannels(env, guildId, discordId) {
  if (!env.DISCORD_BOT_TOKEN) return json({ ok: false, error: 'no-bot-token' }, 503);
  if (!guildId) return json({ ok: false, error: 'no-guild-id' }, 400);
  if (!/^\d{5,25}$/.test(discordId)) return json({ ok: false, error: 'bad-user' }, 400);

  // 1. Fetch guild member (for roles[]) + guild roles (for permissions).
  let member, allRoles, channels;
  try {
    const headers = {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'User-Agent':    'aquilo-bot-worker chat-channels',
    };
    const [mResp, rResp, cResp] = await Promise.all([
      fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordId)}`, { headers }),
      fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`,    { headers }),
      fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, { headers }),
    ]);
    if (mResp.status === 404) {
      // User isn't in the guild, return an empty list (rather than 403)
      // so the PWA can render a friendly "join the server" prompt.
      return json({ ok: true, channels: [], reason: 'not-in-guild' });
    }
    if (!mResp.ok || !rResp.ok || !cResp.ok) {
      return json({ ok: false, error: 'discord-fetch-failed',
                    statuses: { member: mResp.status, roles: rResp.status, channels: cResp.status } }, 502);
    }
    member   = await mResp.json();
    allRoles = await rResp.json();
    channels = await cResp.json();
  } catch (e) {
    return json({ ok: false, error: 'fetch-error', detail: String(e?.message || e) }, 502);
  }
  if (!Array.isArray(member?.roles) || !Array.isArray(allRoles) || !Array.isArray(channels)) {
    return json({ ok: false, error: 'unexpected-shape' }, 502);
  }
  const userRoleIds = new Set([guildId, ...member.roles.map(String)]);   // @everyone is always included
  const rolesById = new Map();
  for (const r of allRoles) if (r?.id) rolesById.set(String(r.id), r);

  // 2-3. Base permissions across roles.
  let basePerms = 0n;
  for (const rid of userRoleIds) {
    const r = rolesById.get(rid);
    if (r?.permissions != null) basePerms |= BigInt(r.permissions);
  }
  const ADMIN_BIT = 0x8n;
  const VIEW_BIT  = 0x400n;
  const isAdmin = (basePerms & ADMIN_BIT) === ADMIN_BIT;

  // 4. Per-channel overwrite layer + filter.
  const visible = [];
  for (const ch of channels) {
    // Only text-flavoured channels, type 0 (GUILD_TEXT) and 5 (GUILD_ANNOUNCEMENT)
    // qualify. Voice / forum / category etc. skipped.
    if (ch?.type !== 0 && ch?.type !== 5) continue;

    let perms = basePerms;
    if (!isAdmin) {
      const ows = Array.isArray(ch.permission_overwrites) ? ch.permission_overwrites : [];
      // 4a. @everyone overwrite
      const everyone = ows.find(o => String(o.id) === guildId);
      if (everyone) {
        perms &= ~BigInt(everyone.deny  || '0');
        perms |=  BigInt(everyone.allow || '0');
      }
      // 4b. Per-role overwrites aggregated for THIS user's roles
      let roleDeny  = 0n;
      let roleAllow = 0n;
      for (const o of ows) {
        if (o.type !== 0) continue;            // 0 = role overwrite
        if (String(o.id) === guildId) continue;
        if (!userRoleIds.has(String(o.id))) continue;
        roleDeny  |= BigInt(o.deny  || '0');
        roleAllow |= BigInt(o.allow || '0');
      }
      perms &= ~roleDeny;
      perms |= roleAllow;
      // 4c. Per-user overwrite for THIS user
      const userOw = ows.find(o => o.type === 1 && String(o.id) === discordId);
      if (userOw) {
        perms &= ~BigInt(userOw.deny  || '0');
        perms |=  BigInt(userOw.allow || '0');
      }
    }
    if ((perms & VIEW_BIT) !== VIEW_BIT && !isAdmin) continue;

    visible.push({
      id:       String(ch.id),
      name:     String(ch.name || '').slice(0, 100),
      type:     ch.type,
      position: Number(ch.position || 0),
      parentId: ch.parent_id ? String(ch.parent_id) : null,
      // `kind` matches the COMMUNITY_CHAT_CHANNELS_JSON shape so the
      // PWA can render with the same nameplate styling.
      kind:     'discord',
    });
  }
  // Position-sort matches Discord's sidebar.
  visible.sort((a, b) => a.position - b.position);
  return json({ ok: true, count: visible.length, channels: visible });
}

async function routeChatReact(env, discordId, body) {
  const channelId = String((body && body.channelId) || '').trim();
  const messageId = String((body && body.messageId) || '').trim();
  if (!/^\d{5,25}$/.test(channelId)) return json({ ok: false, error: 'bad-channel-id' }, 400);
  if (!/^\d{5,25}$/.test(messageId)) return json({ ok: false, error: 'bad-message-id' }, 400);
  const gate = await chatChannelCheck(env, channelId);
  if (!gate.ok) return json(gate, 403);
  const { parseEmoji, addWebReaction, readCommunityChatWithReactions } =
    await import('./aquilo/community-chat.js');
  const emoji = parseEmoji(body && body.emoji);
  if (!emoji) return json({ ok: false, error: 'bad-emoji' }, 400);
  try {
    const r = await addWebReaction(env, channelId, messageId, emoji, discordId);
    // Return the freshly-merged reactions array for the single
    // message so the UI can swap state in-place. Re-uses the same
    // enrichment path /chat/recent uses to guarantee shape parity.
    const after = await readCommunityChatWithReactions(env, channelId, 50, discordId);
    const msg = after.ok && after.messages.find(m => m.id === messageId);
    return json({ ok: true, ...r, reactions: msg ? msg.reactions : [] });
  } catch (e) {
    return json({ ok: false, error: 'discord-react-failed', message: String(e?.message || e) }, 502);
  }
}

// ── Polls admin (owner-gated, see ownerCheck) ───────────────────
async function routePollsList(env) {
  const { adminListPolls } = await import('./custom-polls.js');
  const r = await adminListPolls(env);
  return json(r, r.ok ? 200 : 400);
}

async function routePollsDetail(env, body) {
  const pollId = String((body && body.pollId) || '').trim();
  if (!pollId) return json({ ok: false, error: 'pollId required' }, 400);
  const { adminPollDetail } = await import('./custom-polls.js');
  const r = await adminPollDetail(env, pollId);
  return json(r, r.ok ? 200 : 400);
}

async function routePollsLock(env, body) {
  const pollId = String((body && body.pollId) || '').trim();
  if (!pollId) return json({ ok: false, error: 'pollId required' }, 400);
  const { adminLockPoll } = await import('./custom-polls.js');
  const r = await adminLockPoll(env, pollId);
  return json(r, r.ok ? 200 : 400);
}

async function routePollsExtend(env, body) {
  const pollId = String((body && body.pollId) || '').trim();
  const hours  = Number((body && body.hours) || 0);
  if (!pollId) return json({ ok: false, error: 'pollId required' }, 400);
  const { adminExtendPoll } = await import('./custom-polls.js');
  const r = await adminExtendPoll(env, pollId, hours);
  return json(r, r.ok ? 200 : 400);
}

async function routePollsCancel(env, body) {
  const pollId = String((body && body.pollId) || '').trim();
  const reason = String((body && body.reason) || '');
  if (!pollId) return json({ ok: false, error: 'pollId required' }, 400);
  const { adminCancelPoll } = await import('./custom-polls.js');
  const r = await adminCancelPoll(env, pollId, reason);
  return json(r, r.ok ? 200 : 400);
}

// ── Support tickets admin (owner-gated) ─────────────────────────
//
// All endpoints expect a verified site session, the worker reads
// discordId from the bridge for attribution on respond/close/assign.
//
// Filters on list: status, category, priority, assignee, requester.

async function routeTicketsList(env, guildId, body) {
  const filters = {
    status:    body?.status,
    category:  body?.category,
    priority:  body?.priority,
    assignee:  body?.assignee,
    requester: body?.requester,
  };
  const { listTickets } = await import('./support-tickets.js');
  const r = await listTickets(env, guildId, filters);
  return json(r, r.ok ? 200 : 400);
}

async function routeTicketsDetail(env, body) {
  const ticketId = parseInt(body?.ticketId, 10);
  if (!ticketId) return json({ ok: false, error: 'ticketId required' }, 400);
  const { ticketDetail } = await import('./support-tickets.js');
  const r = await ticketDetail(env, ticketId);
  return json(r, r.ok ? 200 : 400);
}

async function routeTicketsRespond(env, discordId, body) {
  const ticketId = parseInt(body?.ticketId, 10);
  const message  = String(body?.message || '').trim();
  if (!ticketId)  return json({ ok: false, error: 'ticketId required' }, 400);
  if (!message)   return json({ ok: false, error: 'message required' }, 400);
  if (message.length > 1800) return json({ ok: false, error: 'message too long' }, 400);
  const { respondAsStaff } = await import('./support-tickets.js');
  const r = await respondAsStaff(env, ticketId, { actorId: discordId, message });
  return json(r, r.ok ? 200 : 400);
}

async function routeTicketsClose(env, discordId, body) {
  const ticketId = parseInt(body?.ticketId, 10);
  const reason   = body?.reason ? String(body.reason).slice(0, 300) : null;
  if (!ticketId) return json({ ok: false, error: 'ticketId required' }, 400);
  const { closeTicket } = await import('./support-tickets.js');
  const r = await closeTicket(env, ticketId, { actorId: discordId, actorName: body?.actorName || 'staff', reason });
  return json(r, r.ok ? 200 : 400);
}

async function routeTicketsAssign(env, discordId, body) {
  const ticketId = parseInt(body?.ticketId, 10);
  const userId   = String(body?.userId || '').trim();
  if (!ticketId)               return json({ ok: false, error: 'ticketId required' }, 400);
  if (!/^\d{15,25}$/.test(userId)) return json({ ok: false, error: 'bad userId' }, 400);
  const { setAssignee } = await import('./support-tickets.js');
  const r = await setAssignee(env, ticketId, userId, { actorId: discordId, actorName: body?.actorName || 'staff' });
  return json(r, r.ok ? 200 : 400);
}

async function routeTicketsPriority(env, discordId, body) {
  const ticketId = parseInt(body?.ticketId, 10);
  const priority = String(body?.priority || '');
  if (!ticketId) return json({ ok: false, error: 'ticketId required' }, 400);
  const { setPriority } = await import('./support-tickets.js');
  const r = await setPriority(env, ticketId, priority, { actorId: discordId, actorName: body?.actorName || 'staff' });
  return json(r, r.ok ? 200 : 400);
}

async function routeTicketsCategory(env, discordId, body) {
  const ticketId = parseInt(body?.ticketId, 10);
  const category = String(body?.category || '');
  if (!ticketId) return json({ ok: false, error: 'ticketId required' }, 400);
  const { setCategory } = await import('./support-tickets.js');
  const r = await setCategory(env, ticketId, category, { actorId: discordId, actorName: body?.actorName || 'staff' });
  return json(r, r.ok ? 200 : 400);
}

// ── Streamlabs multistream stream-key surface (OBS dock) ─────────────
//
// Streamlabs exposes no API for the RTMP ingest URL / stream key, so the
// owner pastes them once via the dock's setup form (save), and the OBS
// dock reads them back with copy buttons to drop into Aitum Multistream.
// Owner-only (the route dispatch already enforces ownerCheck). The key is
// a credential: never logged, only returned in the owner-gated read.
const DOCK_STREAMKEY_KV = (discordId) => `streamlabs:multistream:${discordId}`;

async function routeDockStreamkeyGet(env, discordId) {
  const rec = await env.LOADOUT_BOLTS.get(DOCK_STREAMKEY_KV(discordId), { type: 'json' }).catch(() => null);
  if (!rec || !rec.url || !rec.key) {
    return json({ ok: true, configured: false, url: '', key: '', refreshedAt: null });
  }
  return json({
    ok: true, configured: true,
    url: String(rec.url), key: String(rec.key),
    refreshedAt: rec.refreshedAt || null,
  });
}

async function routeDockStreamkeySave(env, discordId, body) {
  const url = String((body && body.rtmpUrl) || '').trim().slice(0, 400);
  const key = String((body && body.streamKey) || '').trim().slice(0, 400);
  if (!url || !key) return json({ ok: false, error: 'missing', message: 'Both the RTMP URL and stream key are required.' }, 400);
  // Light sanity check: Streamlabs ingest URLs are rtmp(s). Stay lenient so
  // a non-standard ingest still saves, just nudge on obvious mistakes.
  const looksRtmp = /^rtmps?:\/\//i.test(url);
  const refreshedAt = Date.now();
  await env.LOADOUT_BOLTS.put(DOCK_STREAMKEY_KV(discordId), JSON.stringify({ url, key, refreshedAt }));
  // Do not echo the key back; the dock re-reads via the GET route.
  return json({ ok: true, configured: true, refreshedAt, looksRtmp });
}

async function routeChatUnreact(env, discordId, body) {
  const channelId = String((body && body.channelId) || '').trim();
  const messageId = String((body && body.messageId) || '').trim();
  if (!/^\d{5,25}$/.test(channelId)) return json({ ok: false, error: 'bad-channel-id' }, 400);
  if (!/^\d{5,25}$/.test(messageId)) return json({ ok: false, error: 'bad-message-id' }, 400);
  const gate = await chatChannelCheck(env, channelId);
  if (!gate.ok) return json(gate, 403);
  const { parseEmoji, removeWebReaction, readCommunityChatWithReactions } =
    await import('./aquilo/community-chat.js');
  const emoji = parseEmoji(body && body.emoji);
  if (!emoji) return json({ ok: false, error: 'bad-emoji' }, 400);
  try {
    const r = await removeWebReaction(env, channelId, messageId, emoji, discordId);
    const after = await readCommunityChatWithReactions(env, channelId, 50, discordId);
    const msg = after.ok && after.messages.find(m => m.id === messageId);
    return json({ ok: true, ...r, reactions: msg ? msg.reactions : [] });
  } catch (e) {
    return json({ ok: false, error: 'discord-unreact-failed', message: String(e?.message || e) }, 502);
  }
}

// ── /web/season/claim ────────────────────────────────────────────
//
// HMAC-gated battle-pass claim. Auth-gap fix (2026-05): used to live
// under /web/season/<userId>/claim which bypassed the HMAC dispatcher
// because the /web/season/* prefix was claimed first by the public
// read. Anyone who knew a userId could fire claims on someone else's
// account. Public read is now at /p/season/<userId>; the claim moved
// here so it gets the same HMAC gate every other /web/* write uses.
//
// Body fields (signed):
//   discordId   acting user (the one whose tier gets claimed)
//   tier        1..tierCount (battle pass tier number)
//   track       'free' | 'premium'
//
// guildId is required by the outer dispatcher's auth but isn't read
// by claimTier, season records are per-user, not per-guild.

// ── Daily community check-in (unified with /checkin slash command) ────
//
// All four routes share the same backing state in community-checkin.js;
// the website and Discord interaction end up at recordCheckin() either
// way, and the per-ET-day idempotency keeps the two surfaces in sync.

async function routeCommunityCheckin(env, guildId, discordId, body) {
  const { recordCheckin } = await import('./community-checkin.js');
  // body.twitchId rides in the site's HMAC-signed payload (stamped
  // server-side from the session — sess.d on Twitch sign-ins), so the
  // punch-card embed can resolve the supporter's sub tier.
  const twitchId = /^\d{1,20}$/.test(String(body?.twitchId || '')) ? String(body.twitchId) : null;
  const r = await recordCheckin(env, guildId, discordId, 'web', twitchId ? { twitchId } : {});
  return json(r, r.ok ? 200 : 400);
}

async function routeCommunityCheckinStatus(env, guildId, discordId) {
  const { getStatus } = await import('./community-checkin.js');
  const r = await getStatus(env, guildId, discordId);
  return json(r);
}

async function routeCommunityCheckinCard(env, guildId, discordId, body) {
  // POST { discordId, guildId, card: { imageUrl, accentColor?, headline?,
  //          subtitle?, backgroundId? } }
  // OR  POST { discordId, guildId, op: 'get', lookupUserId? }
  //, lookupUserId lets the site's /api/web/checkin/user-background
  //     endpoint resolve another user's saved card (just the bg
  //     picker, the card fields are non-sensitive: image URL,
  //     accent colour, headline, subtitle, backgroundId slug).
  //     Falls back to the authenticated user's own card when
  //     lookupUserId is unset, missing, or fails the digits-only
  //     format check.
  const { getCard, putCard, getSubTier } = await import('./community-checkin.js');
  const twitchId = /^\d{1,20}$/.test(String(body?.twitchId || '')) ? String(body.twitchId) : null;
  if (body && body.op === 'get') {
    let targetId = discordId;
    const lookupRaw = body.lookupUserId;
    if (lookupRaw != null) {
      const lookup = String(lookupRaw).trim();
      if (/^\d{5,25}$/.test(lookup)) targetId = lookup;
    }
    const card = await getCard(env, guildId, targetId);
    // Own-card reads also report the viewer's sub tier so the site
    // customizer can gate premium frames without a second round-trip.
    const subTier = (targetId === discordId && twitchId) ? await getSubTier(env, twitchId) : 0;
    return json({ ok: true, card: card || null, userId: targetId,
                  lookedUp: targetId !== discordId, subTier });
  }
  // Frame writes need the tier; imageUrl/accent/etc. don't. Resolve
  // only when the patch carries a frame (keeps the common path cheap).
  const wantsFrame = body?.card && body.card.frame !== undefined;
  const subTier = wantsFrame ? (twitchId ? await getSubTier(env, twitchId) : 0) : null;
  const r = await putCard(env, guildId, discordId, body?.card || {}, subTier);
  return json(r, r.ok ? 200 : 400);
}

// ── Stream check-in card (on-stream "I'm here" card) ──────────────────
async function routeStreamCheckinCardMe(env, guildId, discordId) {
  const { cardMe } = await import('./stream-checkin.js');
  return json(await cardMe(env, guildId, discordId));
}

async function routeStreamCheckinCardSave(env, guildId, discordId, body) {
  // POST { discordId, guildId, card: { frame, bg, anim, badges[], tagline } }
  const { saveCardConfig } = await import('./stream-checkin.js');
  const r = await saveCardConfig(env, guildId, discordId, body?.card || {});
  return json(r, r.ok ? 200 : 400);
}

async function routeStreamCheckinShow(env, guildId, discordId, body) {
  // POST { discordId, guildId, displayName?, profilePic? }
  const { showOnStream } = await import('./stream-checkin.js');
  const r = await showOnStream(env, guildId, discordId, body || {});
  return json(r, r.ok ? 200 : (r.error === 'rate-limited' ? 429 : 400));
}

async function routeStreamCheckinBadges(env, guildId, discordId, body) {
  // POST { discordId, guildId, lookupUserId? }, earned badges (self by default).
  const { badgesFor } = await import('./stream-checkin.js');
  let targetId = discordId;
  const lookupRaw = body?.lookupUserId;
  if (lookupRaw != null) {
    const lookup = String(lookupRaw).trim();
    if (/^\d{5,25}$/.test(lookup)) targetId = lookup;
  }
  return json(await badgesFor(env, guildId, targetId));
}

// Boltbound per-user card art override. POST shape:
//   { op: 'get',   cardId }              → return current override (or null)
//   { op: 'set',   cardId, url }         → validate + save
//   { op: 'clear', cardId }              → drop the override
//   { op: 'list' }                       → list every override for this user
// Validation in cards-art-override.js, HTTPS only, host-allow-listed,
// HEAD-checked Content-Type=image/gif, size ≤ 5 MB. Rendering switch
// to the override lands in a follow-up (per Clay 2026-05).
async function routeCardsArtOverride(env, guildId, discordId, body) {
  const op = String((body && body.op) || 'get').toLowerCase();
  const m = await import('./cards-art-override.js');
  if (op === 'list') {
    const items = await m.listOverridesForUser(env, guildId, discordId);
    return json({ ok: true, overrides: items });
  }
  const cardId = String((body && body.cardId) || '').trim();
  if (!cardId) return json({ ok: false, error: 'cardId-required' }, 400);
  if (op === 'get') {
    const rec = await m.getOverride(env, guildId, discordId, cardId);
    return json({ ok: true, override: rec || null });
  }
  if (op === 'set') {
    const url = String((body && body.url) || '').trim();
    const r = await m.setOverride(env, guildId, discordId, cardId, url);
    return json(r, r.ok ? 200 : 400);
  }
  if (op === 'clear') {
    const r = await m.clearOverride(env, guildId, discordId, cardId);
    return json(r);
  }
  return json({ ok: false, error: 'bad-op', allowed: ['get', 'set', 'clear', 'list'] }, 400);
}

// 2026-05-30, meme-skin card-art override feature REMOVED.
// All three skin endpoints (set / clear / list) return 410 Gone.
// The underlying cards-art-override.js module stays on disk for
// historical reference + in case Clay decides to revert, but no
// user-facing path reaches it. The bootstrap response (cards-web.js)
// no longer includes the per-user artOverrides map either.
async function routeCardsSkinSet() {
  return json({
    ok: false,
    error: 'gone',
    message: 'Card skin feature has been removed.',
  }, 410);
}

async function routeCardsSkinClear() {
  return json({
    ok: false,
    error: 'gone',
    message: 'Card skin feature has been removed.',
  }, 410);
}

async function routeCardsSkinList() {
  return json({
    ok: false,
    error: 'gone',
    message: 'Card skin feature has been removed.',
  }, 410);
}

// (Bolts economy sunset 2026-06: Seasonal Spire web wrappers removed —
// routeSpireSeason / routeSpireRunMe / routeSpireRunStart / routeSpireRunResult /
// routeSpireRunAbandon / routeSpireRunFloor / routeSpireLeaderboard deleted.)

// (Bolts economy sunset 2026-06: Banners + Banner Wars web wrappers removed —
// routeBanner{Me,Browse,Create,Join,Leave,Kick} + routeWar{Active,Declare,Raid}
// deleted; banner founding cost bolts.)

// ── UI-live unblockers (2026-05-29) ──────────────────────────────
// MVP web wrappers for features whose site UI shipped against stubs.

async function routeSupportersHall(env) {
  const { getSupportersHall } = await import('./supporters-hall.js');
  return json(await getSupportersHall(env));
}
async function routeSupportersOptOut(env, userId, body) {
  const { setSupportersHallOptOut } = await import('./supporters-hall.js');
  return json(await setSupportersHallOptOut(env, userId, !!body?.optOut));
}
async function routePatronCurrent(env) {
  const { getCurrentPatron } = await import('./patron-of-month.js');
  return json(await getCurrentPatron(env));
}
async function routePatronHistory(env, body) {
  const { getPatronHistory } = await import('./patron-of-month.js');
  return json(await getPatronHistory(env, { limit: body?.limit }));
}
async function routePatronOptOut(env, userId, body) {
  const { setPatronOptOut } = await import('./patron-of-month.js');
  return json(await setPatronOptOut(env, userId, !!body?.optOut));
}
// (Bolts economy sunset 2026-06: routeDustSnapshot/Disenchant/Craft
// (cards-dust.js), routeDropsActive/Upcoming (cards-drops.js),
// routeCardBackList/Set (card-backs-animated.js) and routeStreamBonusState
// (stream-bonus.js) were removed — all Boltbound/economy surfaces.)

async function routeCosmeticsMe(env, userId) {
  const { getCosmeticsForUser } = await import('./monthly-cosmetic-grant.js');
  return json(await getCosmeticsForUser(env, userId));
}

// /web/cards/suggest-art-terms, DEPRECATED 2026-05-30 alongside the
// meme-skin removal. The endpoint still returns search terms +
// description so site code that uses the description text in other
// surfaces (deck-builder card tooltips, etc.) keeps working, but it
// is NO LONGER the source for a user-facing GIF picker. Site should
// stop calling this once the meme-GIF editor UI is removed.
async function routeCardsSuggestArtTerms(env, body) {
  const cardId = String((body && body.cardId) || '').trim();
  if (!cardId) return json({ ok: false, error: 'cardId-required' }, 400);
  const { suggestArtTerms } = await import('./cards-art-suggest.js');
  const r = suggestArtTerms(cardId);
  return json({ ...r, deprecated: true }, r.ok ? 200 : 400);
}

// (Bolts economy sunset 2026-06: routeCommunityCheckinBonusCollect removed —
// the check-in bonus payout was removed; plain check-in routes stay.)

// Web-bridge implicit Patreon-link signal.
//
// Reaching any /web/quest/* route IS proof the caller has a verified
// Patreon session, aquilo-site's bridge ([[route]].js → postToBot)
// requires a valid aq_link cookie, which is issued ONLY by the
// Patreon OAuth callback. So if the bot receives the request with
// a valid HMAC + a real discordId, that user has linked Patreon
// (regardless of whether their Patreon profile had an avatar, or
// whether any of the older worker-side signals, `patreon:tier:<u>`
// presence, `wallet.links` patreon entry, were ever written).
//
// We therefore mark the explicit `quest:patreon-linked:<g>:<u>` flag
// at the top of every web-quest route so the step's completion check
// agrees with itself across snapshot / claim / mark calls. This was
// the root cause of the "snapshot says claimable but claim rejects"
// bug Clay hit three times in a row:
//   • snapshot returned `completed: true` only because the SITE
//     optimistically overrode it (OnboardingQuest.tsx line 138-147);
//     the worker actually returned `completed: false` because none of
//     the prior 3 signals matched for a Patreon-only user.
//   • claim re-ran the SAME completion check (it shares getSnapshot)
//     but the optimistic override doesn't apply to claim, so claim
//     rejected with `error: 'not-completed'`.
// Auto-marking on every web touch makes the signal durable + cheap
// (KV put is sub-millisecond, idempotent).
//
// Note: the /quest slash command DOES NOT auto-mark. It runs through
// handleQuestCommand → getSnapshot directly; a slash command caller
// hasn't proven a Patreon link.
async function autoMarkWebPatreonLink(env, guildId, discordId) {
  try {
    const { markPatreonLinked } = await import('./quests.js');
    await markPatreonLinked(env, guildId, discordId);
  } catch { /* idle */ }
}

async function routeQuestSnapshot(env, guildId, discordId) {
  await autoMarkWebPatreonLink(env, guildId, discordId);
  const { getSnapshot } = await import('./quests.js');
  return json(await getSnapshot(env, guildId, discordId));
}

async function routeQuestClaim(env, guildId, discordId, body) {
  // POST { discordId, guildId, stepId: '<id>' | 'all' }
  // Auto-mark the patreon-linked flag FIRST so the snapshot the
  // claimStep computes internally sees completed:true for the
  // linked-patreon step. Without this, the claim rejects with
  // `not-completed` even though the snapshot route showed claimable
  // (the site's OnboardingQuest.tsx optimistically flips the UI; the
  // worker side needs to actually agree).
  await autoMarkWebPatreonLink(env, guildId, discordId);
  const stepId = String((body && body.stepId) || 'all');
  const { claimStep } = await import('./quests.js');
  const r = await claimStep(env, guildId, discordId, stepId);
  return json(r, r.ok ? 200 : 400);
}

// ── Self-serve setup wizard (web parity with /loadout-setup) ──────────

async function routeSetupSnapshot(env, guildId, discordId) {
  const { webSnapshot } = await import('./setup-wizard.js');
  return json(await webSnapshot(env, guildId, discordId));
}
async function routeSetupInit(env, guildId, discordId) {
  const { webInit } = await import('./setup-wizard.js');
  return json(await webInit(env, guildId, discordId));
}
async function routeSetupChannel(env, guildId, body) {
  // body: { discordId, guildId, slot, channelId }
  const { webBindChannel } = await import('./setup-wizard.js');
  const r = await webBindChannel(env, guildId, body);
  return json(r, r.ok ? 200 : 400);
}
async function routeSetupFeature(env, guildId, body) {
  // body: { discordId, guildId, id, enabled }
  const { webToggleFeature } = await import('./setup-wizard.js');
  const r = await webToggleFeature(env, guildId, body);
  return json(r, r.ok ? 200 : 400);
}
async function routeSetupFinish(env, guildId, discordId) {
  const { webFinish } = await import('./setup-wizard.js');
  return json(await webFinish(env, guildId, discordId));
}
// ── Discord ↔ PWA chat relay ─────────────────────────────────────────

async function routeChatSend(env, guildId, discordId, body) {
  // POST { discordId, guildId, channelId, content }
  const channelId = String((body && body.channelId) || '');
  const content   = String((body && body.content) || '');
  if (!channelId || !content) return json({ ok: false, error: 'channelId+content required' }, 400);
  const { sendFromPwa } = await import('./chat-relay.js');
  const r = await sendFromPwa(env, { discordId, guildId, channelId, content });
  return json(r, r.ok ? 200 : (r.error === 'rate-limited' ? 429 : 400));
}

// Renamed during the reconcile/main-superset merge to avoid colliding
// with the community-chat reactions reader (`routeChatRecent` above,
// 3-arg). Both have the same route name `chat/recent` on their
// respective branches; main's reactions handler keeps the original
// path. This PWA chat-relay reader is dispatched under
// `chat/relay/recent` instead, the parallel aquilo-site session will
// have to swap to that path when it wires the chat-relay UI.
async function routeChatRelayRecent(env, guildId, discordId, body) {
  // POST { discordId, guildId, channelId, limit? }
  const channelId = String((body && body.channelId) || '');
  if (!channelId) return json({ ok: false, error: 'channelId required' }, 400);
  const limit = body && Number(body.limit) || 25;
  const { recentForPwa } = await import('./chat-relay.js');
  return json(await recentForPwa(env, { channelId, limit, discordId }));
}

async function routeSetupBranding(env, guildId, body) {
  // POST { discordId, guildId, op: 'get' }  →  read merged branding
  // POST { discordId, guildId, brand: { siteUrl?, accentColor?, ... } } → upsert
  const { getBranding, putBranding } = await import('./branding.js');
  if (body && body.op === 'get') {
    return json({ ok: true, branding: await getBranding(env, guildId) });
  }
  const r = await putBranding(env, guildId, body?.brand || {});
  return json(r, r.ok ? 200 : 400);
}

async function routeQuestMarkPatreonLinked(env, guildId, discordId) {
  // Site calls this whenever it has a verified Patreon-linked session
  // (regardless of how many other social platforms are linked). Flips
  // the quest-completion flag AND fires the referral milestone (no-op
  // if the user isn't attributed or already-paid).
  //
  // The flag-set is unconditional + idempotent, repeat calls just
  // re-stamp + return the same `verified` snapshot. The site is the
  // source of truth on "is this session Patreon-verified"; the worker
  // additionally confirms via patreon:tier:<userId> when present so
  // an "optimistic UI, worker can't see the link" mismatch surfaces
  // in the response payload.
  const { markPatreonLinked } = await import('./quests.js');
  const mark = await markPatreonLinked(env, guildId, discordId);
  let milestone = { paid: false, reason: 'unknown' };
  try {
    const { recordMilestone } = await import('./referrals.js');
    milestone = await recordMilestone(env, guildId, discordId, 'patreon-link');
  } catch (e) {
    milestone = { paid: false, reason: 'throw:' + (e?.message || e) };
  }
  return json({ ok: true, marked: true, verified: mark.verified, milestone });
}
