// /web/*, site → bot RPC for the aquilo.gg minigames page.
//
// aquilo-site's Pages Functions own the Patreon auth (aq_link cookie +
// per-session webSig CSRF token). When a logged-in patron clicks
// "Daily" / "Coinflip" / "Dice" on the website, the site Pages
// Function verifies the cookie, then HMAC-signs a request here. We
// trust the discordId the site claims as long as the HMAC verifies.
//
// Routes:
//   POST /web/wallet      { discordId, guildId }                  -> wallet snapshot
//   POST /web/daily       { discordId, guildId }                  -> daily claim
//   POST /web/coinflip    { discordId, guildId, bet }             -> { won, payout, balance }
//   POST /web/dice        { discordId, guildId, bet, target }     -> { won, roll, payout, balance }
//
// All POST so the HMAC body is always present and the signing
// scheme is uniform. HMAC = SHA-256 over `ts + "\n" + body`,
// hex-encoded. Headers: x-aquilo-web-ts, x-aquilo-web-sig. 5-min
// timestamp skew. Mirrors the /sync/:guildId scheme exactly.
//
// games.js is the single source of truth for daily / coinflip /
// dice, same code path that Discord's /loadout and the Twitch
// panel's /ext/daily already use. No surface drift possible.

import { coinflip, dice, daily } from './games.js';
import {
  cooldownCheck, cooldownTouch,
  blackjackStart, blackjackHit, blackjackStand,
  roulette, wheel,
  hiloStart, hiloGuess, hiloCashout,
  minesStart, minesReveal, minesCashout,
  plinko, crash,
  quickGamesSnapshot,
} from './games-quick.js';
import { getWallet, applyVaultDelta } from './wallet.js';
import { recordStat } from './recap.js';
import { verifyHmac } from './auth.js';
import {
  publicSportsSnapshot,
  readGamesCache,
  refreshGamesCache,
  runPlaceJson,
  getUserBetsPublic,
} from './bet.js';
import {
  snapshotQueue,
  openQueue,
  closeQueue,
  closeNight,
  notifyQueueOpened,
} from './queue.js';
import { handleAdminWeb } from './admin-web.js';
import { routeBoltbound, isBoltboundRoute } from './cards-web.js';
import { routeBoard, isBoardRoute } from './boardgames-web.js';

const ROUTES = new Set([
  'wallet',
  'daily',
  'coinflip',
  'dice',
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
  // L9, PWA chat (Clay 2026-05-28): expose every guild text channel
  // the requesting Discord user has VIEW_CHANNEL permission on, so
  // the PWA can switch between channels instead of being capped at
  // the COMMUNITY_CHAT_CHANNELS_JSON allow-list.
  'chat/channels',
  // 2026-05 expansion, quick bolts games. Stateful games (blackjack,
  // hilo, mines) split into start/play/cashout sub-routes so the bot
  // can persist hand state across calls without re-deriving it from
  // the client. quick/snapshot is the page-load read that surfaces
  // any in-progress hand + the per-viewer cooldown window.
  'quick/snapshot',
  'blackjack/start',
  'blackjack/hit',
  'blackjack/stand',
  'roulette',
  'wheel',
  'hilo/start',
  'hilo/guess',
  'hilo/cashout',
  'mines/start',
  'mines/reveal',
  'mines/cashout',
  'plinko',
  'crash',
  'bet/snapshot',
  'bet/place',
  'queues/snapshot',
  'queues/open',
  'queues/close',
  'queues/close-night',
  // Banners + Banner Wars (2026-05-29). 5-25 player alliances + weekly
  // bracketed war state. Site UI was scaffolded with greyed-out
  // buttons; these endpoints light up the flow. See banners.js +
  // banner-wars.js.
  // 2026-05-29, UI-live unblockers. MVPs land worker endpoints for
  // four features whose site UI shipped against stubs.
  'play/supporters/hall',
  'play/supporters/opt-out',
  'play/patron-of-month/current',
  'play/patron-of-month/history',
  'play/patron-of-month/opt-out',
  'play/dust/snapshot',
  'play/dust/disenchant',
  'play/dust/craft',
  'play/drops/active',
  'play/drops/upcoming',
  // 2026-05-29 sprint, Aquilo Pass + stream-bonus probe.
  'pass/state',
  'pass/claim-tier',
  'stream/bonus-state',
  'play/cosmetics/me',
  'play/cards/back/list',
  'play/cards/back/set',
  'play/banner/me',
  'play/banner/browse',
  'play/banner/create',
  'play/banner/join',
  'play/banner/leave',
  'play/banner/kick',
  'play/war/active',
  'play/war/declare',
  'play/war/raid',
  'season/claim',
  // Discord rich-presence web fallback (Batch B). The site reports the
  // viewer's current aquilo.gg activity here; the worker persists it to
  // KV with a heartbeat-expiry so a future desktop consumer (StreamFusion
  // Discord RPC) can read the feed. userId-keyed + guild-agnostic, so
  // these three bypass the strict discordId/guildId gate (handled early
  // in handleWeb, before that gate). See DISCORD-RICH-PRESENCE.md.
  'presence/update',
  'presence/clear',
  'presence/feed',
  // New-viewer funnel, referral attribution. /me returns the
  // caller's stable referral code + bring-in stats; /attribute is
  // what the site POSTs after Patreon-link to record (refereeId,
  // refCode). Reward payout (50 Bolts + 1 'bolt' pack to the
  // referrer) fires via recordMilestone('first-game') from the
  // noteFirstGame helper, hooked into routeDaily / routeCoinflip /
  // routeDice below, first daily/coinflip/dice on an attributed
  // user pays out, then stamps the referee record so subsequent
  // plays are no-ops. A future quests.js port can fire additional
  // milestone kinds (first-checkin, patreon-link, …) without
  // colliding, recordMilestone is gated on milestoneFiredUtc, not
  // on the kind.
  'referral/me',
  'referral/attribute',
  'admin/snapshot',
  'admin/config',
  'admin/active-guild',
  'admin/clear-binding',
  'admin/pipe-tests',
  'admin/anniversary-backfill',  // POST {_owner, maxPages?, cursor?}, stamp legacy anniv:seen
  'admin/triple-c/set',          // POST {_owner, gameSlug}, lock the Triple-C campaign + announce
  'admin/dad-sunday/set',        // POST {_owner, gameSlug}, lock Dad Game Sunday + announce
  'admin/lineup/post',           // POST {_owner}, (re)post + pin the weekly lineup recap
  'admin/stream-events/sync',    // POST {_owner, horizonDays?}, mirror schedule → Discord events
  // Daily community check-in (unified with /checkin slash command).
  'checkin',                 // POST, record today's check-in
  'checkin/status',          // POST, read streak + card + pending bonuses
  'checkin/card',            // POST, upsert the user's embed card config
  'checkin/bonus/collect',   // POST, claim one bonus (or 'all')
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
  // Seasonal Spire (Boltbound solo roguelike). Spec: discord-bot/spire.js.
  'play/spire/season',       // POST, current month's theme + reward preview + countdown
  'play/spire/run/me',       // POST, active run state (or { active: null })
  'play/spire/run/start',    // POST, start a new run (snapshots active deck)
  'play/spire/run/result',   // POST, { floor, won } record floor outcome
  'play/spire/run/abandon',  // POST, abandon active run
  'play/spire/run/floor',    // POST, { floor } returns the NPC + decks for that floor's match
  'play/spire/leaderboard',  // POST, { limit? } monthly clears + total clear count
  // New-viewer funnel, referrals + onboarding quest.
  'referral/me',             // POST, my code + stats
  'referral/attribute',      // POST, record that this user was referred by CODE
  // Anniversary celebrations (anniversary.js). The premium-feature
  // spec wrote these as GET/POST /web/anniversary/{check,celebrate}/:userId,
  // but every /web/* route here is POST + HMAC + body-bound discordId
  // (you can only act as yourself), so these follow that convention:
  // the acting user is body.discordId, no :userId path param.
  'anniversary/check',       // POST, { discordId, guildId } → anniversary state (or null)
  'anniversary/celebrate',   // POST, claim this year's reward (idempotent)
  // Aether economy (aether.js), D1 ledger, spendable premium currency.
  'aether/balance',          // POST, { discordId, guildId } → balance + lifetime totals
  'aether/spend',            // POST, { amount, reason? } → debit (insufficient-aether on overdraw)
  'aether/history',          // POST, { limit? } → newest-first transaction ledger
  // Aquilo Pass v2 (aquilo-pass-d1.js), D1 battle pass, 30 tiers,
  // free+premium. Namespaced pass2/* so it coexists with the legacy
  // KV pass at pass/state + pass/claim-tier.
  'pass2/state',             // POST, full season + progress + per-tier reward state
  'pass2/claim',             // POST, { tier, track } → claim one reward (idempotent)
  'pass2/buy-premium',       // POST, own the premium track (gated on paid Patreon)
  // Bolt Rain (bolt-rain.js), Patreon-T2+-triggered 60s claim window.
  'boltrain/trigger',        // POST, open a rain (T2+ only)
  'boltrain/claim',          // POST, first-click claim
  'boltrain/state',          // POST, current event state (+ youClaimed)
  // Random Drops (random-drops.js), rarity-weighted chest spawns.
  'randomdrop/state',        // POST, current drop (+ youClaimed)
  'randomdrop/claim',        // POST, first-click claim
  'randomdrop/spawn',        // POST, owner-only manual spawn (testing)
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
  if (!ROUTES.has(route) && !isBoltboundRoute(route) && !isBoardRoute(route)) return json({ error: 'not-found' }, 404);

  // Read body once; verify HMAC against the raw bytes; only then parse.
  const bodyText = await req.text();
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad-json' }, 400); }

  // Discord-presence web fallback, handled BEFORE the discordId/guildId
  // gate below because presence is per-user + guild-agnostic: the site
  // proxy forwards { userId, key, state, detail } (no guildId, and
  // `userId` not `discordId`). Already HMAC-verified above. feed is
  // owner-gated for the future desktop RPC consumer.
  if (route === 'presence/update') return await routePresenceUpdate(env, body);
  if (route === 'presence/clear')  return await routePresenceClear(env, body);
  if (route === 'presence/feed') {
    if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
    return await routePresenceFeed(env);
  }

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
    if (route === 'wallet') return await routeWallet(env, guildId, discordId);
    if (route === 'daily')  return await routeDaily(env, guildId, discordId);
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
    if (route === 'coinflip') return await routeCoinflip(env, guildId, discordId, body);
    if (route === 'dice')   return await routeDice(env, guildId, discordId, body);
    if (route === 'quick/snapshot')     return await routeQuickSnapshot(env, guildId, discordId);
    if (route === 'blackjack/start')    return await routeBlackjackStart(env, guildId, discordId, body);
    if (route === 'blackjack/hit')      return await routeBlackjackHit(env, guildId, discordId);
    if (route === 'blackjack/stand')    return await routeBlackjackStand(env, guildId, discordId);
    if (route === 'roulette')           return await routeRoulette(env, guildId, discordId, body);
    if (route === 'wheel')              return await routeWheel(env, guildId, discordId, body);
    if (route === 'hilo/start')         return await routeHiloStart(env, guildId, discordId, body);
    if (route === 'hilo/guess')         return await routeHiloGuess(env, guildId, discordId, body);
    if (route === 'hilo/cashout')       return await routeHiloCashout(env, guildId, discordId);
    if (route === 'mines/start')        return await routeMinesStart(env, guildId, discordId, body);
    if (route === 'mines/reveal')       return await routeMinesReveal(env, guildId, discordId, body);
    if (route === 'mines/cashout')      return await routeMinesCashout(env, guildId, discordId);
    if (route === 'plinko')             return await routePlinko(env, guildId, discordId, body);
    if (route === 'crash')              return await routeCrash(env, guildId, discordId, body);
    if (route === 'bet/snapshot') return await routeBetSnapshot(env, guildId, discordId);
    if (route === 'bet/place')    return await routeBetPlace(env, guildId, discordId, body);
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
    if (route === 'checkin')               return await routeCommunityCheckin(env, guildId, discordId);
    if (route === 'checkin/status')        return await routeCommunityCheckinStatus(env, guildId, discordId);
    if (route === 'checkin/card')          return await routeCommunityCheckinCard(env, guildId, discordId, body);
    if (route === 'checkin/bonus/collect') return await routeCommunityCheckinBonusCollect(env, guildId, discordId, body);
    if (route === 'checkin/card/me')       return await routeStreamCheckinCardMe(env, guildId, discordId);
    if (route === 'checkin/card/save')     return await routeStreamCheckinCardSave(env, guildId, discordId, body);
    if (route === 'checkin/show')          return await routeStreamCheckinShow(env, guildId, discordId, body);
    if (route === 'checkin/badges')        return await routeStreamCheckinBadges(env, guildId, discordId, body);
    if (route === 'cards/art-override')    return await routeCardsArtOverride(env, guildId, discordId, body);
    if (route === 'cards/suggest-art-terms') return await routeCardsSuggestArtTerms(env, body);
    if (route === 'cards/skin')            return await routeCardsSkinSet(env, guildId, discordId, body);
    if (route === 'cards/skin/clear')      return await routeCardsSkinClear(env, guildId, discordId, body);
    if (route === 'cards/skins')           return await routeCardsSkinList(env, guildId, discordId);
    if (route === 'play/spire/season')      return await routeSpireSeason(env);
    if (route === 'play/spire/run/me')      return await routeSpireRunMe(env, discordId);
    if (route === 'play/spire/run/start')   return await routeSpireRunStart(env, guildId, discordId);
    if (route === 'play/spire/run/result')  return await routeSpireRunResult(env, guildId, discordId, body);
    if (route === 'play/spire/run/abandon') return await routeSpireRunAbandon(env, guildId, discordId);
    if (route === 'play/spire/run/floor')   return await routeSpireRunFloor(env, discordId, body);
    if (route === 'play/spire/leaderboard') return await routeSpireLeaderboard(env, body);
    if (route === 'play/supporters/hall')         return await routeSupportersHall(env);
    if (route === 'play/supporters/opt-out')      return await routeSupportersOptOut(env, discordId, body);
    if (route === 'play/patron-of-month/current') return await routePatronCurrent(env);
    if (route === 'play/patron-of-month/history') return await routePatronHistory(env, body);
    if (route === 'play/patron-of-month/opt-out') return await routePatronOptOut(env, discordId, body);
    if (route === 'play/dust/snapshot')           return await routeDustSnapshot(env, guildId, discordId);
    if (route === 'play/dust/disenchant')         return await routeDustDisenchant(env, guildId, discordId, body);
    if (route === 'play/dust/craft')              return await routeDustCraft(env, guildId, discordId, body);
    if (route === 'play/drops/active')            return await routeDropsActive(env);
    if (route === 'play/drops/upcoming')          return await routeDropsUpcoming(env, body);
    if (route === 'pass/state')                   return await routePassState(env, discordId);
    if (route === 'pass/claim-tier')              return await routePassClaim(env, guildId, discordId, body);
    if (route === 'stream/bonus-state')           return await routeStreamBonusState(env);
    if (route === 'play/cosmetics/me')            return await routeCosmeticsMe(env, discordId);
    if (route === 'play/cards/back/list')         return await routeCardBackList(env, discordId);
    if (route === 'play/cards/back/set')          return await routeCardBackSet(env, discordId, body);
    if (route === 'play/banner/me')        return await routeBannerMe(env, guildId, discordId);
    if (route === 'play/banner/browse')    return await routeBannerBrowse(env, guildId, body);
    if (route === 'play/banner/create')    return await routeBannerCreate(env, guildId, discordId, body);
    if (route === 'play/banner/join')      return await routeBannerJoin(env, guildId, discordId, body);
    if (route === 'play/banner/leave')     return await routeBannerLeave(env, guildId, discordId);
    if (route === 'play/banner/kick')      return await routeBannerKick(env, guildId, discordId, body);
    if (route === 'play/war/active')       return await routeWarActive(env, guildId, discordId);
    if (route === 'play/war/declare')      return await routeWarDeclare(env, guildId, discordId, body);
    if (route === 'play/war/raid')         return await routeWarRaid(env, guildId, discordId, body);
    if (route === 'referral/me')              return await routeReferralMe(env, guildId, discordId);
    if (route === 'referral/attribute')       return await routeReferralAttribute(env, guildId, discordId, body);
    if (route === 'anniversary/check')        return await routeAnniversaryCheck(env, guildId, discordId);
    if (route === 'anniversary/celebrate')    return await routeAnniversaryCelebrate(env, guildId, discordId);
    if (route === 'aether/balance')           return await routeAetherBalance(env, guildId, discordId);
    if (route === 'aether/spend')             return await routeAetherSpend(env, guildId, discordId, body);
    if (route === 'aether/history')           return await routeAetherHistory(env, guildId, discordId, body);
    if (route === 'pass2/state')              return await routePass2State(env, discordId);
    if (route === 'pass2/claim')              return await routePass2Claim(env, guildId, discordId, body);
    if (route === 'pass2/buy-premium')        return await routePass2BuyPremium(env, guildId, discordId);
    if (route === 'boltrain/trigger')         return await routeBoltRainTrigger(env, guildId, discordId);
    if (route === 'boltrain/claim')           return await routeBoltRainClaim(env, guildId, discordId);
    if (route === 'boltrain/state')           return await routeBoltRainState(env, guildId, discordId);
    if (route === 'randomdrop/state')         return await routeRandomDropState(env, guildId, discordId);
    if (route === 'randomdrop/claim')         return await routeRandomDropClaim(env, guildId, discordId);
    if (route === 'randomdrop/spawn') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeRandomDropSpawn(env, guildId);
    }
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
    if (route === 'season/claim')          return await routeSeasonClaim(env, discordId, body);
    if (isBoltboundRoute(route))           return await routeBoltbound(env, guildId, discordId, route, body);
    if (isBoardRoute(route))               return await routeBoard(env, route, guildId, discordId, body);
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

async function routeWallet(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    wallet: {
      balance: w.balance || 0,
      lifetimeEarned: w.lifetimeEarned || 0,
      lifetimeSpent: w.lifetimeSpent || 0,
      dailyStreak: w.dailyStreak || 0,
      lastDailyUtc: w.lastDailyUtc || 0,
      lastDailyEtDate: w.lastDailyEtDate || null,
    },
  });
}

// Fire-and-forget "you've played a game" hook for the onboarding
// quest. Called from every game-play route; idempotent (markGamePlayed
// is just a KV put). Wrapped in a catch so a quest-module failure
// can't break the actual game route.
async function noteGamePlayed(env, guildId, userId) {
  try {
    const { markGamePlayed } = await import('./quests.js');
    await markGamePlayed(env, guildId, userId);
  } catch { /* idle */ }
}

// Sibling to noteGamePlayed: fire the referral-funnel milestone for
// the user's first wallet-touching activity. recordMilestone is
// idempotent on the referee's milestoneFiredUtc stamp, so calling
// on every play is safe, only the first one for an attributed
// user actually pays anything out (50 Bolts + 1 'bolt' pack to the
// referrer). Forward-compatible with quests.js firing additional
// milestone kinds; they're gated on the same stamp, not on the kind.
async function noteFirstGame(env, guildId, userId) {
  try {
    const { recordMilestone } = await import('./referrals.js');
    await recordMilestone(env, guildId, userId, 'first-game');
  } catch (e) {
    console.warn('[referrals] first-game milestone fire failed:', (e && e.message) || e);
  }
}

async function routeDaily(env, guildId, userId) {
  await noteGamePlayed(env, guildId, userId);
  // Anniversary firstSeen heartbeat, daily claim is the cheapest
  // once-per-day-per-user activity signal. Min-wins, so it never
  // overrides an earlier stamp; for users created after the last
  // backfill this captures their join date going forward.
  try {
    const { recordFirstSeen } = await import('./anniversary.js');
    await recordFirstSeen(env, guildId, userId);
  } catch { /* non-fatal */ }
  const r = await daily(env, guildId, userId);
  if (r.won) {
    // games_won bumps on a successful daily so the recap card's
    // "won X today" field reflects Daily claims too. bolts_earned
    // separately tracks the bolts the claim added.
    await recordStat(env, guildId, userId, {
      bolts_earned: r.payout || 0,
      games_won: 1,
    });
    await noteFirstGame(env, guildId, userId);
    // Aquilo Pass v2 XP, daily claim feeds battle-pass progression.
    // Best-effort (no D1 binding in some envs); never blocks the claim.
    try {
      const { seedSeasonOne, grantPassXp } = await import('./aquilo-pass-d1.js');
      await seedSeasonOne(env);
      await grantPassXp(env, userId, 50, 'daily-claim');
    } catch { /* pass optional */ }
  }
  // Surface the post-claim wallet so the UI doesn't need a follow-up
  // round trip.
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: r.won,
    error: r.won ? undefined : 'already-claimed',
    explanation: r.explanation,
    payout: r.payout || 0,
    streak: r.streak || w.dailyStreak || 0,
    balance: w.balance || 0,
  });
}

async function routeCoinflip(env, guildId, userId, body) {
  await noteGamePlayed(env, guildId, userId);
  const bet = Number(body && body.bet);
  if (!Number.isFinite(bet) || bet <= 0) {
    return json({ ok: false, error: 'bad-bet', explanation: 'Bet must be a positive number.' }, 400);
  }
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false, explanation: cd.message }, 429);
  const r = await coinflip(env, guildId, userId, bet);
  if (typeof r.payout !== 'number') {
    return json({ ok: false, error: 'rejected', explanation: r.explanation || 'Couldn\'t place that bet.' }, 400);
  }
  if (r.won) await recordStat(env, guildId, userId, { games_won: 1, bolts_earned: r.payout });
  else await recordStat(env, guildId, userId, { games_lost: 1, bolts_spent: -r.payout });
  await noteFirstGame(env, guildId, userId);
  const w = await getWallet(env, guildId, userId);
  const cooldownUntil = await cooldownTouch(env, userId);
  return json({
    ok: true,
    won: r.won,
    payout: r.payout,
    balance: w.balance || 0,
    explanation: r.explanation,
    cooldownUntil,
  });
}

// ── Stocks ────────────────────────────────────────────────────────────
// Mirror the panel's read pattern (catalog + per-ticker price + tiny
// recent-history slice for sparklines), plus the caller's holdings +
// balance so the trade panel can render position size & cost basis.

// ── Sports betting ────────────────────────────────────────────────────
// Snapshot pulls the public games list (~48h window) and the caller's
// active + recent-history bets. /web/bet/place runs the same runPlace
// flow Discord's /bet sports place uses; settlement still happens via
// the existing :23 cron tick (betCronTick).

async function routeBetSnapshot(env, guildId, userId) {
  let games = await readGamesCache(env);
  if (games.length === 0) games = await refreshGamesCache(env);
  const [bets, wallet] = await Promise.all([
    getUserBetsPublic(env, guildId, userId),
    getWallet(env, guildId, userId),
  ]);
  // 48h pre-game window only -- same slice the panel surfaces.
  const cutoff = Date.now() + 48 * 60 * 60 * 1000;
  const upcoming = games.filter((g) => g && g.state === 'pre' && (g.startUtc || 0) <= cutoff);
  return json({
    ok: true,
    games: upcoming,
    active: Array.isArray(bets.active) ? bets.active : [],
    history: Array.isArray(bets.history) ? bets.history.slice(-20).reverse() : [],
    balance: wallet.balance || 0,
  });
}

async function routeBetPlace(env, guildId, userId, body) {
  // Parlay payload: { kind:'parlay', bolts, legs:[{game, kind, side}] }.
  // Solo payload: { gameId, kind?, side, bolts }.
  const kind = String((body && body.kind) || 'moneyline').toLowerCase();
  const bolts = Number(body && body.bolts);
  if (!Number.isFinite(bolts) || bolts <= 0) {
    return json({ ok: false, error: 'bad-bolts', message: 'Bolts must be a positive number.' }, 400);
  }
  if (kind === 'parlay') {
    const legs = Array.isArray(body && body.legs) ? body.legs : [];
    if (legs.length < 2) {
      return json({ ok: false, error: 'too-few-legs', message: 'A parlay needs at least 2 legs.' }, 400);
    }
    const r = await runPlaceJson(env, guildId, userId, {
      kind: 'parlay',
      bolts: Math.floor(bolts),
      legs,
    });
    return json(r, r.ok ? 200 : 400);
  }
  // Solo bet, same validation as before but kind-aware.
  const gameId = String(body && body.gameId || '').trim();
  const side = String(body && body.side || '').toLowerCase();
  if (!gameId) return json({ ok: false, error: 'bad-game', message: 'Pick a game.' }, 400);
  if (kind === 'moneyline' || kind === 'spread') {
    if (side !== 'home' && side !== 'away') {
      return json({ ok: false, error: 'bad-side', message: 'Side must be home or away.' }, 400);
    }
  } else if (kind === 'total') {
    if (side !== 'over' && side !== 'under') {
      return json({ ok: false, error: 'bad-side', message: 'Side must be over or under.' }, 400);
    }
  } else {
    return json({ ok: false, error: 'bad-kind', message: 'kind must be moneyline, spread, total, or parlay.' }, 400);
  }
  const r = await runPlaceJson(env, guildId, userId, {
    game: gameId,
    kind,
    side,
    bolts: Math.floor(bolts),
  });
  return json(r, r.ok ? 200 : 400);
}

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


async function routeDice(env, guildId, userId, body) {
  await noteGamePlayed(env, guildId, userId);
  const bet = Number(body && body.bet);
  const target = Number(body && body.target);
  if (!Number.isFinite(bet) || bet <= 0) {
    return json({ ok: false, error: 'bad-bet', explanation: 'Bet must be a positive number.' }, 400);
  }
  if (!Number.isInteger(target) || target < 1 || target > 6) {
    return json({ ok: false, error: 'bad-target', explanation: 'Target must be 1-6.' }, 400);
  }
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false, explanation: cd.message }, 429);
  const r = await dice(env, guildId, userId, bet, target);
  if (typeof r.payout !== 'number') {
    return json({ ok: false, error: 'rejected', explanation: r.explanation || 'Couldn\'t place that bet.' }, 400);
  }
  if (r.won) await recordStat(env, guildId, userId, { games_won: 1, bolts_earned: r.payout });
  else await recordStat(env, guildId, userId, { games_lost: 1, bolts_spent: -r.payout });
  await noteFirstGame(env, guildId, userId);
  const w = await getWallet(env, guildId, userId);
  const cooldownUntil = await cooldownTouch(env, userId);
  return json({
    ok: true,
    won: r.won,
    roll: r.roll,
    payout: r.payout,
    balance: w.balance || 0,
    explanation: r.explanation,
    cooldownUntil,
  });
}


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
// Touches firstSeen as a side effect, visiting the dashboard counts
// as activity, so an unseen user gets stamped on first check (their
// anniversary clock starts now). Existing users keep their earlier
// stamp (recordFirstSeen is min-wins).
async function routeAnniversaryCheck(env, guildId, discordId) {
  const { recordFirstSeen, checkAnniversary } = await import('./anniversary.js');
  await recordFirstSeen(env, guildId, discordId);
  const r = await checkAnniversary(env, guildId, discordId);
  return json(r, r.ok ? 200 : 400);
}

async function routeAnniversaryCelebrate(env, guildId, discordId) {
  const { celebrateAnniversary } = await import('./anniversary.js');
  const r = await celebrateAnniversary(env, guildId, discordId);
  return json(r, statusFor(r));
}

// ── /web/aether/*, Aether economy ledger ────────────────────────────
async function routeAetherBalance(env, guildId, discordId) {
  const { getAetherBalance } = await import('./aether.js');
  const r = await getAetherBalance(env, guildId, discordId);
  return json(r, r.ok ? 200 : 400);
}

async function routeAetherSpend(env, guildId, discordId, body) {
  const amount = Math.floor(Number(body && body.amount) || 0);
  if (amount <= 0) return json({ ok: false, error: 'bad-amount' }, 400);
  const { spendAether } = await import('./aether.js');
  const r = await spendAether(env, guildId, discordId, amount,
    String((body && body.reason) || 'spend'));
  return json(r, r.ok ? 200 : (r.error === 'insufficient-aether' ? 402 : 400));
}

async function routeAetherHistory(env, guildId, discordId, body) {
  const { getAetherHistory } = await import('./aether.js');
  const r = await getAetherHistory(env, guildId, discordId, body && body.limit);
  return json(r, r.ok ? 200 : 400);
}

// ── /web/pass2/*, Aquilo Pass v2 (D1) ───────────────────────────────
const PASS2_PREMIUM_AETHER_COST = 500;

async function routePass2State(env, discordId) {
  const { seedSeasonOne, getPassState } = await import('./aquilo-pass-d1.js');
  // Lazy-seed Season 1 on first read so the pass is always populated.
  await seedSeasonOne(env).catch(() => {});
  const r = await getPassState(env, discordId);
  return json(r, r.ok ? 200 : 400);
}

async function routePass2Claim(env, guildId, discordId, body) {
  const tier = Math.floor(Number(body && body.tier) || 0);
  const track = (body && body.track) === 'premium' ? 'premium' : 'free';
  if (tier < 1) return json({ ok: false, error: 'tier-required' }, 400);
  const { claimTier } = await import('./aquilo-pass-d1.js');
  const r = await claimTier(env, guildId, discordId, tier, track);
  const code = r.ok ? 200
    : r.error === 'tier-not-reached' ? 409
    : r.error === 'premium-locked' ? 403
    : 400;
  return json(r, code);
}

// Own the premium track: free for paid Patreon supporters, otherwise
// purchasable for PASS2_PREMIUM_AETHER_COST aether.
async function routePass2BuyPremium(env, guildId, discordId) {
  const { setPremium, getPassState } = await import('./aquilo-pass-d1.js');
  const state = await getPassState(env, discordId);
  if (!state.ok) return json(state, 400);
  if (state.progress.premium) return json({ ok: true, premium: true, alreadyOwned: true });

  // Paid Patreon → free unlock.
  let paid = false;
  try {
    const rec = await env.LOADOUT_BOLTS.get(`patreon:tier:${discordId}`, { type: 'json' });
    const tier = String(rec?.tier || rec?.tierName || '').trim().toLowerCase();
    paid = !!tier && tier !== 'free';
  } catch { /* no patreon record */ }

  if (paid) {
    await setPremium(env, discordId, true);
    return json({ ok: true, premium: true, via: 'patreon' });
  }
  // Otherwise buy with aether.
  const { spendAether } = await import('./aether.js');
  const spent = await spendAether(env, guildId, discordId, PASS2_PREMIUM_AETHER_COST, 'pass2:premium-unlock');
  if (!spent.ok) {
    return json({ ok: false, error: 'insufficient-aether', costAether: PASS2_PREMIUM_AETHER_COST,
                  balance: spent.balance ?? 0 }, 402);
  }
  await setPremium(env, discordId, true);
  return json({ ok: true, premium: true, via: 'aether', spentAether: PASS2_PREMIUM_AETHER_COST,
                aetherBalance: spent.balance });
}

// ── /web/boltrain/*, interactive bolt rain ─────────────────────────
async function routeBoltRainTrigger(env, guildId, discordId) {
  const { triggerBoltRain } = await import('./bolt-rain.js');
  const r = await triggerBoltRain(env, guildId, discordId);
  const code = r.ok ? 200
    : r.error === 'not-tier-2' ? 403
    : r.error === 'already-active' ? 409
    : 400;
  return json(r, code);
}

async function routeBoltRainClaim(env, guildId, discordId) {
  const { claimBoltRain } = await import('./bolt-rain.js');
  const r = await claimBoltRain(env, guildId, discordId);
  const code = r.ok ? 200
    : r.error === 'not-active' ? 410
    : r.error === 'already-claimed' ? 409
    : r.error === 'depleted' ? 409
    : 400;
  return json(r, code);
}

async function routeBoltRainState(env, guildId, discordId) {
  const { getBoltRainState } = await import('./bolt-rain.js');
  const r = await getBoltRainState(env, guildId, discordId);
  return json(r, r.ok ? 200 : 400);
}

// ── /web/randomdrop/*, rarity-weighted chest spawns ─────────────────
async function routeRandomDropState(env, guildId, discordId) {
  const { getRandomDropState } = await import('./random-drops.js');
  const r = await getRandomDropState(env, guildId, discordId);
  return json(r, r.ok ? 200 : 400);
}

async function routeRandomDropClaim(env, guildId, discordId) {
  const { claimRandomDrop } = await import('./random-drops.js');
  const r = await claimRandomDrop(env, guildId, discordId);
  const code = r.ok ? 200
    : r.error === 'not-active' ? 410
    : r.error === 'already-claimed' ? 409
    : r.error === 'depleted' ? 409
    : 400;
  return json(r, code);
}

async function routeRandomDropSpawn(env, guildId) {
  const { spawnRandomDrop } = await import('./random-drops.js');
  const r = await spawnRandomDrop(env, guildId);
  return json(r, r.ok ? 200 : 400);
}

// ── Quick bolts games (2026-05) ──────────────────────────────────────
//
// Shared protocol for blackjack/roulette/wheel/hilo/mines/plinko/crash:
//   - Start actions touch the per-viewer cooldown (cooldownTouch())
//     so the next quick-game play is gated.
//   - Mid-hand actions (hit, reveal, guess) do NOT touch the cooldown
//, once you're in a hand the pace is yours.
//   - All handlers attach `cooldownUntil` (ms-epoch, 0 = clear) on
//     terminal responses so the UI can render an accurate countdown
//     without an extra round-trip.
//   - games_won/games_lost recap stats fire on terminal results so
//     the panel's win-rate field aggregates the new games with
//     coinflip + dice.

function applyRecap(env, guildId, userId, r) {
  if (typeof r.payout !== 'number') return;
  if (r.payout > 0) recordStat(env, guildId, userId, { games_won: 1, bolts_earned: r.payout });
  else if (r.payout < 0) recordStat(env, guildId, userId, { games_lost: 1, bolts_spent: -r.payout });
}

async function routeQuickSnapshot(env, guildId, userId) {
  const r = await quickGamesSnapshot(env, guildId, userId);
  return json(r);
}

async function routeBlackjackStart(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false }, 429);
  const r = await blackjackStart(env, guildId, userId, bet);
  if (!r.ok) return json(r, 400);
  if (r.phase === 'done') {
    applyRecap(env, guildId, userId, r);
    r.cooldownUntil = await cooldownTouch(env, userId);
  } else {
    // Cooldown still arms on hand-start so people can't spam-start &
    // surrender to dodge the wait.
    r.cooldownUntil = await cooldownTouch(env, userId);
  }
  return json(r);
}

async function routeBlackjackHit(env, guildId, userId) {
  const r = await blackjackHit(env, guildId, userId);
  if (!r.ok) return json(r, 400);
  if (r.phase === 'done') applyRecap(env, guildId, userId, r);
  return json(r);
}

async function routeBlackjackStand(env, guildId, userId) {
  const r = await blackjackStand(env, guildId, userId);
  if (!r.ok) return json(r, 400);
  if (r.phase === 'done') applyRecap(env, guildId, userId, r);
  return json(r);
}

async function routeRoulette(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  const pick = body && body.pick;
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false }, 429);
  const r = await roulette(env, guildId, userId, bet, pick);
  if (!r.ok) return json(r, 400);
  applyRecap(env, guildId, userId, r);
  r.cooldownUntil = await cooldownTouch(env, userId);
  return json(r);
}

async function routeWheel(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  const risk = body && body.risk;
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false }, 429);
  const r = await wheel(env, guildId, userId, bet, risk);
  if (!r.ok) return json(r, 400);
  applyRecap(env, guildId, userId, r);
  r.cooldownUntil = await cooldownTouch(env, userId);
  return json(r);
}

async function routeHiloStart(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false }, 429);
  const r = await hiloStart(env, guildId, userId, bet);
  if (!r.ok) return json(r, 400);
  r.cooldownUntil = await cooldownTouch(env, userId);
  return json(r);
}

async function routeHiloGuess(env, guildId, userId, body) {
  const guess = String((body && body.guess) || '').toLowerCase();
  const r = await hiloGuess(env, guildId, userId, guess);
  if (!r.ok) return json(r, 400);
  if (r.phase === 'done') applyRecap(env, guildId, userId, r);
  return json(r);
}

async function routeHiloCashout(env, guildId, userId) {
  const r = await hiloCashout(env, guildId, userId);
  if (!r.ok) return json(r, 400);
  applyRecap(env, guildId, userId, r);
  return json(r);
}

async function routeMinesStart(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  const bombs = Number(body && body.bombs);
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false }, 429);
  const r = await minesStart(env, guildId, userId, bet, bombs);
  if (!r.ok) return json(r, 400);
  r.cooldownUntil = await cooldownTouch(env, userId);
  return json(r);
}

async function routeMinesReveal(env, guildId, userId, body) {
  const tile = Number(body && body.tile);
  const r = await minesReveal(env, guildId, userId, tile);
  if (!r.ok) return json(r, 400);
  if (r.phase === 'done') applyRecap(env, guildId, userId, r);
  return json(r);
}

async function routeMinesCashout(env, guildId, userId) {
  const r = await minesCashout(env, guildId, userId);
  if (!r.ok) return json(r, 400);
  applyRecap(env, guildId, userId, r);
  return json(r);
}

async function routePlinko(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  const risk = body && body.risk;
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false }, 429);
  const r = await plinko(env, guildId, userId, bet, risk);
  if (!r.ok) return json(r, 400);
  applyRecap(env, guildId, userId, r);
  r.cooldownUntil = await cooldownTouch(env, userId);
  return json(r);
}

async function routeCrash(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  const cashout = Number(body && body.cashout);
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return json({ ...cd, ok: false }, 429);
  const r = await crash(env, guildId, userId, bet, cashout);
  if (!r.ok) return json(r, 400);
  applyRecap(env, guildId, userId, r);
  r.cooldownUntil = await cooldownTouch(env, userId);
  return json(r);
}

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
async function routeSeasonClaim(env, discordId, body) {
  const tier = parseInt(body && body.tier, 10) || 0;
  const track = (body && body.track) || 'free';
  const { claimTier } = await import('./progression/season.js');
  const r = await claimTier(env, discordId, tier, track);
  return json(r, r.ok ? 200 : 400);
}

// ── Daily community check-in (unified with /checkin slash command) ────
//
// All four routes share the same backing state in community-checkin.js;
// the website and Discord interaction end up at recordCheckin() either
// way, and the per-ET-day idempotency keeps the two surfaces in sync.

async function routeCommunityCheckin(env, guildId, discordId) {
  const { recordCheckin } = await import('./community-checkin.js');
  const r = await recordCheckin(env, guildId, discordId, 'web');
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
  const { getCard, putCard } = await import('./community-checkin.js');
  if (body && body.op === 'get') {
    let targetId = discordId;
    const lookupRaw = body.lookupUserId;
    if (lookupRaw != null) {
      const lookup = String(lookupRaw).trim();
      if (/^\d{5,25}$/.test(lookup)) targetId = lookup;
    }
    const card = await getCard(env, guildId, targetId);
    return json({ ok: true, card: card || null, userId: targetId,
                  lookedUp: targetId !== discordId });
  }
  const r = await putCard(env, guildId, discordId, body?.card || {});
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

// ── Seasonal Spire, thin wrappers over spire.js helpers ──────────

async function routeSpireSeason(env) {
  const { getSeasonView } = await import('./spire.js');
  const view = await getSeasonView(env);
  return json({ ok: true, season: view });
}

async function routeSpireRunMe(env, discordId) {
  const { getRunView } = await import('./spire.js');
  const view = await getRunView(env, discordId);
  return json({ ok: true, run: view });
}

async function routeSpireRunStart(env, guildId, discordId) {
  const { startRun } = await import('./spire.js');
  const r = await startRun(env, guildId, discordId);
  return json(r, r.ok ? 200 : 400);
}

async function routeSpireRunResult(env, guildId, discordId, body) {
  const floor = parseInt(body?.floor, 10);
  if (!Number.isFinite(floor) || floor < 1 || floor > 10) {
    return json({ ok: false, error: 'bad-floor' }, 400);
  }
  const { recordResult } = await import('./spire.js');
  const r = await recordResult(env, guildId, discordId, {
    floor,
    won:           !!body?.won,
    finalSnapshot: body?.finalSnapshot || null,
  });
  return json(r, r.ok ? 200 : 400);
}

async function routeSpireRunAbandon(env, guildId, discordId) {
  const { abandonRun } = await import('./spire.js');
  const r = await abandonRun(env, guildId, discordId);
  return json(r, r.ok ? 200 : 400);
}

async function routeSpireRunFloor(env, discordId, body) {
  const floor = parseInt(body?.floor, 10);
  if (!Number.isFinite(floor)) return json({ ok: false, error: 'bad-floor' }, 400);
  const { getActiveRun, currentSeason, buildSpireFloorMatch } = await import('./spire.js');
  const season = await currentSeason(env);
  const run    = await getActiveRun(env, discordId, season.id);
  if (!run) return json({ ok: false, error: 'no-active-run' }, 400);
  if (floor !== run.current_floor) {
    return json({ ok: false, error: 'floor-mismatch', expected: run.current_floor }, 400);
  }
  const view = await buildSpireFloorMatch(env, discordId, run);
  return json({ ok: true, floorMatch: view });
}

async function routeSpireLeaderboard(env, body) {
  const { getLeaderboard } = await import('./spire.js');
  const r = await getLeaderboard(env, { limit: body?.limit });
  return json({ ok: true, leaderboard: r });
}

// ── Banners + Banner Wars (2026-05-29) ────────────────────────────
//
// MVP backend behind the site-side scaffolded UI. Thin web wrappers
// over banners.js + banner-wars.js, the heavy logic stays in the
// modules so a future Discord-slash front-end can reuse it.

async function routeBannerMe(env, guildId, userId) {
  const { getMyBanner } = await import('./banners.js');
  return json(await getMyBanner(env, guildId, userId));
}

async function routeBannerBrowse(env, guildId, body) {
  const { browseBanners } = await import('./banners.js');
  return json(await browseBanners(env, guildId, { limit: body?.limit }));
}

async function routeBannerCreate(env, guildId, userId, body) {
  const { createBanner } = await import('./banners.js');
  const r = await createBanner(env, guildId, userId, body || {});
  return json(r, r.ok ? 200 : 400);
}

async function routeBannerJoin(env, guildId, userId, body) {
  const { joinBanner } = await import('./banners.js');
  const r = await joinBanner(env, guildId, userId, body || {});
  return json(r, r.ok ? 200 : 400);
}

async function routeBannerLeave(env, guildId, userId) {
  const { leaveBanner } = await import('./banners.js');
  const r = await leaveBanner(env, guildId, userId);
  return json(r, r.ok ? 200 : 400);
}

async function routeBannerKick(env, guildId, userId, body) {
  const { kickFromBanner } = await import('./banners.js');
  const r = await kickFromBanner(env, guildId, userId, body || {});
  return json(r, r.ok ? 200 : 400);
}

async function routeWarActive(env, guildId, userId) {
  const { getActiveWar } = await import('./banner-wars.js');
  return json(await getActiveWar(env, guildId, userId));
}

async function routeWarDeclare(env, guildId, userId, body) {
  const { declareWar } = await import('./banner-wars.js');
  const r = await declareWar(env, guildId, userId, body || {});
  return json(r, r.ok ? 200 : 400);
}

async function routeWarRaid(env, guildId, userId, body) {
  const { recordRaid } = await import('./banner-wars.js');
  const r = await recordRaid(env, guildId, userId, body || {});
  return json(r, r.ok ? 200 : 400);
}

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
async function routeDustSnapshot(env, guildId, userId) {
  const { getDust, DUST_DISENCHANT_BY_RARITY, DUST_CRAFT_BY_RARITY } = await import('./cards-dust.js');
  const d = await getDust(env, guildId, userId);
  return json({ ok: true, ...d,
                disenchantTable: DUST_DISENCHANT_BY_RARITY,
                craftTable:      DUST_CRAFT_BY_RARITY });
}
async function routeDustDisenchant(env, guildId, userId, body) {
  const { disenchant } = await import('./cards-dust.js');
  const r = await disenchant(env, guildId, userId,
    String(body?.cardId || ''), { force: !!body?.force });
  return json(r, r.ok ? 200 : 400);
}
async function routeDustCraft(env, guildId, userId, body) {
  const { craft } = await import('./cards-dust.js');
  const r = await craft(env, guildId, userId, String(body?.cardId || ''));
  return json(r, r.ok ? 200 : 400);
}
async function routeDropsActive(env) {
  const { getActiveDrop } = await import('./cards-drops.js');
  return json(await getActiveDrop(env));
}
async function routeDropsUpcoming(env, body) {
  const { getUpcomingDrops } = await import('./cards-drops.js');
  return json(await getUpcomingDrops(env, { limit: body?.limit }));
}

async function routeStreamBonusState(env) {
  const { isStreamLive, _consts } = await import('./stream-bonus.js');
  const live = await isStreamLive(env);
  return json({ ok: true, live, multipliers: _consts });
}

async function routeCosmeticsMe(env, userId) {
  const { getCosmeticsForUser } = await import('./monthly-cosmetic-grant.js');
  return json(await getCosmeticsForUser(env, userId));
}
async function routeCardBackList(env, userId) {
  const { listCardBacksForUser } = await import('./card-backs-animated.js');
  return json(await listCardBacksForUser(env, userId));
}
async function routeCardBackSet(env, userId, body) {
  const { setCardBackForUser } = await import('./card-backs-animated.js');
  const r = await setCardBackForUser(env, userId, body || {});
  return json(r, r.ok ? 200 : 400);
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

async function routeCommunityCheckinBonusCollect(env, guildId, discordId, body) {
  // POST { discordId, guildId, bonusId: '<id>' | 'all' }
  const id = String((body && body.bonusId) || 'all');
  const { collectBonus } = await import('./community-checkin.js');
  const r = await collectBonus(env, guildId, discordId, id);
  return json(r, r.ok ? 200 : 400);
}

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
