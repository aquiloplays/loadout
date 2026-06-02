// /web/* — site → bot RPC for the aquilo.gg minigames page.
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
// dice — same code path that Discord's /loadout and the Twitch
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
  getCatalog,
  getPrice,
  getHistory,
  getHoldings,
  runBuyJson,
  runSellJson,
  buildStocksPortfolio,
  getStockAlerts,
  createStockAlert,
  deleteStockAlert,
} from './stocks.js';
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
import {
  loadHero,
  attackOf,
  defenseOf,
  doInventory,
  doEquip,
  doUnequip,
  doSell,
  getDailyShop,
  doShopBuy,
} from './dungeon.js';
import {
  executeRaid,
  _editorTownBuild,
  _editorTownGarrison,
  _editorDonate,
  _editorClearObstacle,
  _editorTownSell,
  _editorTownLayout,
  canManageTown,
} from './clash.js';
import { ensureTown, getQueue } from './clash-state.js';
import {
  getCharacterLookWeb,
  saveCharacterLookWeb,
  applyClassWeb,
  resetCharacterWeb,
  putAvatarWeb,
  clearAvatarWeb,
} from './character.js';
import { handleAdminWeb } from './admin-web.js';
import { routeBoltbound, isBoltboundRoute } from './cards-web.js';
import { routeBoard, isBoardRoute } from './boardgames-web.js';
import {
  BUILDINGS, TROOPS_GARRISON, OBSTACLES,
  withBuildingSprites, withGarrisonSprites, withObstacleSprites,
  townBuildCost, townGarrisonCost,
  spriteIdForBuildingV2, spriteIdForTroopV2,
} from './clash-content.js';
import { getTown, getTreasury } from './clash-state.js';

const ROUTES = new Set([
  'wallet',
  'daily',
  'coinflip',
  'dice',
  // Community-chat reactions surface — see aquilo/community-chat.js
  // for the storage + Discord REST wiring. /web/chat/recent returns
  // the ringbuffer enriched with per-message reactions (native
  // Discord + web-side KV merged). /web/chat/react + /web/chat/unreact
  // toggle on behalf of the requesting aquilo user.
  'chat/recent',
  'chat/react',
  'chat/unreact',
  // Live-poll admin surface — PWA admin UI consumes these. Owner-
  // gated via the existing _owner flag pattern. See custom-polls.js
  // adminListPolls / adminPollDetail / adminLockPoll / adminExtendPoll
  // / adminCancelPoll. Each accepts a body { pollId, ... } except
  // `list` which is parameterless.
  'admin/polls/list',
  'admin/polls/detail',
  'admin/polls/lock',
  'admin/polls/extend',
  'admin/polls/cancel',
  // Support tickets — PWA admin compartment (Clay 2026-05-28).
  // Owner-gated via the same _owner flag pattern. See
  // support-tickets.js. Read + mutate the ticket queue.
  'admin/tickets/list',
  'admin/tickets/detail',
  'admin/tickets/respond',
  'admin/tickets/close',
  'admin/tickets/assign',
  'admin/tickets/priority',
  'admin/tickets/category',
  // L9 — PWA chat (Clay 2026-05-28): expose every guild text channel
  // the requesting Discord user has VIEW_CHANNEL permission on, so
  // the PWA can switch between channels instead of being capped at
  // the COMMUNITY_CHAT_CHANNELS_JSON allow-list.
  'chat/channels',
  // 2026-05 expansion — quick bolts games. Stateful games (blackjack,
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
  'stocks/snapshot',
  'stocks/buy',
  'stocks/sell',
  'stocks/portfolio',
  'stocks/alerts/list',
  'stocks/alerts/create',
  'stocks/alerts/delete',
  'bet/snapshot',
  'bet/place',
  'queues/snapshot',
  'queues/open',
  'queues/close',
  'queues/close-night',
  'hero',
  'equip',
  'unequip',
  'sell',
  'shop',
  'shop/buy',
  'dungeon/skip-cooldown',
  // Hero soft-death revive (2026-05-29). buy-revive purchases a
  // Revive Elixir into the player's bag for the level-scaled bolts
  // cost; use-revive consumes one elixir + flips the hero back to
  // alive at full HP. Lost gear stays lost — see hero-death.js.
  'dungeon/buy-revive',
  'dungeon/use-revive',
  // Banners + Banner Wars (2026-05-29). 5-25 player alliances + weekly
  // bracketed war state. Site UI was scaffolded with greyed-out
  // buttons; these endpoints light up the flow. See banners.js +
  // banner-wars.js.
  // 2026-05-29 — UI-live unblockers. MVPs land worker endpoints for
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
  // 2026-05-29 Phase A hero customization — composite manifest the
  // site renderer consumes to stack PNG layers.
  'character/composite',
  'character/backgrounds',
  // 2026-05-29 sprint — Aquilo Pass + stream-bonus probe.
  'pass/state',
  'pass/claim-tier',
  'stream/bonus-state',
  // 2026-05-29 sprint — 3 outstanding chips: skills, cosmetics, card backs.
  'play/skills/snapshot',
  'play/skills/allocate',
  'play/skills/respec',
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
  'clash/raid',
  'clash/build',
  'clash/garrison',
  'clash/sell',
  'clash/layout',
  'clash/town',
  'clash/setup',
  // 2026-05 Phase 5 — wallet → treasury donation on the play surface
  // (closes the "bolts don't sync over to Clash" gap; the editor
  // already had a donate route but required pasting a Discord ID).
  'clash/donate',
  // 2026-05 Phase 5 — obstacle clear (Engineer dispatch). Mod-gated.
  'clash/clear-obstacle',
  'pet/snapshot',
  'pet/collect',
  'expedition/status',
  'expedition/start',
  'expedition/claim',
  'expedition/history',
  'expedition/backpack/catalog',
  'expedition/backpack/buy',
  'expedition/backpack/supply',
  'season/claim',
  'character',
  'character/save',
  'character/class',
  'character/reset',
  // May 2026: user-uploaded hero avatar — supersedes the visible
  // procedural character on the site. NOT subject to character-locked
  // (see putAvatarWeb / clearAvatarWeb in character.js). Same path
  // services upload + clear; clear is triggered by `clear: true` flag
  // or by submitting an empty dataBase64.
  'character/avatar',
  // New-viewer funnel — referral attribution. /me returns the
  // caller's stable referral code + bring-in stats; /attribute is
  // what the site POSTs after Patreon-link to record (refereeId,
  // refCode). Reward payout (50 Bolts + 1 'bolt' pack to the
  // referrer) fires via recordMilestone('first-game') from the
  // noteFirstGame helper, hooked into routeDaily / routeCoinflip /
  // routeDice below — first daily/coinflip/dice on an attributed
  // user pays out, then stamps the referee record so subsequent
  // plays are no-ops. A future quests.js port can fire additional
  // milestone kinds (first-checkin, patreon-link, …) without
  // colliding — recordMilestone is gated on milestoneFiredUtc, not
  // on the kind.
  'referral/me',
  'referral/attribute',
  'admin/snapshot',
  'admin/config',
  'admin/active-guild',
  'admin/clear-binding',
  'admin/pipe-tests',
  'admin/anniversary-backfill',  // POST {_owner, maxPages?, cursor?} — stamp legacy anniv:seen
  'admin/triple-c/set',          // POST {_owner, gameSlug} — lock the Triple-C campaign + announce
  // Daily community check-in (unified with /checkin slash command).
  'checkin',                 // POST — record today's check-in
  'checkin/status',          // POST — read streak + card + pending bonuses
  'checkin/card',            // POST — upsert the user's embed card config
  'checkin/bonus/collect',   // POST — claim one bonus (or 'all')
  // Boltbound per-user card art override (meme-GIF skin layer).
  // Rendering integrated 2026-05-28: cards-web routeState ships the
  // user's overrides + the global defaults in the bootstrap payload.
  'cards/art-override',      // POST — { op: 'get'|'set'|'clear'|'list', cardId, url? }
  'cards/suggest-art-terms', // POST — { cardId } → { searchTerms, description }
  // Skin endpoints — thin REST-shaped wrappers on cards-art-override
  // for the site to call directly instead of building op:set/etc
  // payloads. /web is POST-only so the spec's DELETE + GET get
  // mapped to POST /cards/skin/clear + POST /cards/skins.
  'cards/skin',              // POST — { cardId, gifUrl } → set the user's skin
  'cards/skin/clear',        // POST — { cardId }         → clear it
  'cards/skins',             // POST — {}                 → { skins: { cardId: url } }
  // Seasonal Spire (Boltbound solo roguelike). Spec: discord-bot/spire.js.
  'play/spire/season',       // POST — current month's theme + reward preview + countdown
  'play/spire/run/me',       // POST — active run state (or { active: null })
  'play/spire/run/start',    // POST — start a new run (snapshots active deck)
  'play/spire/run/result',   // POST — { floor, won } record floor outcome
  'play/spire/run/abandon',  // POST — abandon active run
  'play/spire/run/floor',    // POST — { floor } returns the NPC + decks for that floor's match
  'play/spire/leaderboard',  // POST — { limit? } monthly clears + total clear count
  // New-viewer funnel — referrals + onboarding quest.
  'referral/me',             // POST — my code + stats
  'referral/attribute',      // POST — record that this user was referred by CODE
  // Anniversary celebrations (anniversary.js). The premium-feature
  // spec wrote these as GET/POST /web/anniversary/{check,celebrate}/:userId,
  // but every /web/* route here is POST + HMAC + body-bound discordId
  // (you can only act as yourself), so these follow that convention:
  // the acting user is body.discordId, no :userId path param.
  'anniversary/check',       // POST — { discordId, guildId } → anniversary state (or null)
  'anniversary/celebrate',   // POST — claim this year's reward (idempotent)
  // Stream Squad (stream-squad.js) — co-watch sessions + shared feed.
  'squad/create',            // POST — { twitchChannel } → new squad (owner auto-joins)
  'squad/active',            // POST — { twitchChannel? } → active sessions
  'squad/get',               // POST — { squadId } → session + roster
  'squad/join',              // POST — { squadId }
  'squad/leave',             // POST — { squadId }
  'squad/end',               // POST — { squadId } (owner-only)
  'squad/event',             // POST — { squadId, kind, payload } → append to feed
  'squad/feed',              // POST — { squadId, limit?, before? } → newest-first feed
  // Aether economy (aether.js) — D1 ledger, spendable premium currency.
  'aether/balance',          // POST — { discordId, guildId } → balance + lifetime totals
  'aether/spend',            // POST — { amount, reason? } → debit (insufficient-aether on overdraw)
  'aether/history',          // POST — { limit? } → newest-first transaction ledger
  // Aquilo Pass v2 (aquilo-pass-d1.js) — D1 battle pass, 30 tiers,
  // free+premium. Namespaced pass2/* so it coexists with the legacy
  // KV pass at pass/state + pass/claim-tier.
  'pass2/state',             // POST — full season + progress + per-tier reward state
  'pass2/claim',             // POST — { tier, track } → claim one reward (idempotent)
  'pass2/buy-premium',       // POST — own the premium track (gated on paid Patreon)
  // Bolt Rain (bolt-rain.js) — Patreon-T2+-triggered 60s claim window.
  'boltrain/trigger',        // POST — open a rain (T2+ only)
  'boltrain/claim',          // POST — first-click claim
  'boltrain/state',          // POST — current event state (+ youClaimed)
  // Random Drops (random-drops.js) — rarity-weighted chest spawns.
  'randomdrop/state',        // POST — current drop (+ youClaimed)
  'randomdrop/claim',        // POST — first-click claim
  'randomdrop/spawn',        // POST — owner-only manual spawn (testing)
  'quest/snapshot',          // POST — checklist with claim state
  'quest/claim',             // POST — claim one step (or 'all')
  'quest/mark-patreon-linked', // POST — flip the patreon-linked completion flag (called by site after OAuth)
  // Productization — self-serve setup wizard (web parity with /loadout-setup).
  'setup/snapshot',          // POST — full tenant + channel + feature state
  'setup/init',              // POST — register the tenant (idempotent)
  'setup/channel',           // POST — bind one channel slot
  'setup/feature',           // POST — toggle one feature on/off
  'setup/finish',            // POST — mark setup as complete
  'setup/branding',          // POST — { op: 'get' | undefined, brand: {...} }
  // Two-way Discord ↔ PWA chat relay. NOTE: the read path is namespaced
  // as `chat/relay/recent` to avoid colliding with main's existing
  // `chat/recent` (community-chat reactions reader, see L112). The
  // parallel aquilo-site session needs to call `/web/chat/relay/recent`
  // for the relay read; the reactions path stays at `/web/chat/recent`.
  'chat/send',               // POST — { channelId, content } → webhook post styled as caller
  'chat/relay/recent',       // POST — { channelId, limit? } → relay ringbuffer + per-msg sentViaPwa decoration
]);

// Only the bisherclay@gmail.com session is currently allowed to open
// or close queues from aquilo-site /admin. Owner-side gating happens
// on the site (functions/api/admin/queues/*) — we double-check here
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
    if (route === 'stocks/snapshot') return await routeStocksSnapshot(env, guildId, discordId);
    if (route === 'stocks/buy')  return await routeStocksBuy(env, guildId, discordId, body);
    if (route === 'stocks/sell') return await routeStocksSell(env, guildId, discordId, body);
    if (route === 'stocks/portfolio') return await routeStocksPortfolio(env, guildId, discordId);
    if (route === 'stocks/alerts/list')   return await routeStocksAlertsList(env, guildId, discordId);
    if (route === 'stocks/alerts/create') return await routeStocksAlertsCreate(env, guildId, discordId, body);
    if (route === 'stocks/alerts/delete') return await routeStocksAlertsDelete(env, guildId, discordId, body);
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
    if (route === 'hero')     return await routeHero(env, guildId, discordId);
    if (route === 'equip')    return await routeEquip(env, guildId, discordId, body);
    if (route === 'unequip')  return await routeUnequip(env, guildId, discordId, body);
    if (route === 'sell')     return await routeSell(env, guildId, discordId, body);
    if (route === 'shop')     return await routeShop(env, guildId, discordId);
    if (route === 'shop/buy') return await routeShopBuy(env, guildId, discordId, body);
    if (route === 'dungeon/skip-cooldown') return await routeDungeonSkip(env, guildId, discordId);
    if (route === 'dungeon/buy-revive')    return await routeDungeonBuyRevive(env, guildId, discordId);
    if (route === 'dungeon/use-revive')    return await routeDungeonUseRevive(env, guildId, discordId);
    if (route === 'clash/raid')            return await routeClashRaid(env, guildId, discordId, body);
    if (route === 'character/class')       return await routeCharacterClass(env, guildId, discordId, body);
    if (route.startsWith('admin/'))        return await handleAdminWeb(env, route, guildId, body);
    if (route === 'clash/build')           return await routeClashBuild(env, guildId, discordId, body);
    if (route === 'clash/garrison')        return await routeClashGarrison(env, guildId, discordId, body);
    if (route === 'clash/sell')            return await routeClashSell(env, guildId, discordId, body);
    if (route === 'clash/layout')          return await routeClashLayout(env, guildId, discordId, body);
    if (route === 'clash/town')            return await routeClashTown(env, guildId, discordId);
    if (route === 'clash/setup')           return await routeClashSetup(env, guildId, discordId);
    if (route === 'clash/donate')          return await routeClashDonate(env, guildId, discordId, body);
    if (route === 'clash/clear-obstacle')  return await routeClashClearObstacle(env, guildId, discordId, body);
    if (route === 'pet/snapshot')          return await routePetSnapshot(env, guildId, discordId);
    if (route === 'pet/collect')           return await routePetCollect(env, guildId, discordId);
    if (route === 'checkin')               return await routeCommunityCheckin(env, guildId, discordId);
    if (route === 'checkin/status')        return await routeCommunityCheckinStatus(env, guildId, discordId);
    if (route === 'checkin/card')          return await routeCommunityCheckinCard(env, guildId, discordId, body);
    if (route === 'checkin/bonus/collect') return await routeCommunityCheckinBonusCollect(env, guildId, discordId, body);
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
    if (route === 'character/composite')          return await routeCharacterComposite(env, guildId, discordId);
    if (route === 'character/backgrounds')        return await routeCharacterBackgrounds(env, discordId);
    if (route === 'pass/state')                   return await routePassState(env, discordId);
    if (route === 'pass/claim-tier')              return await routePassClaim(env, guildId, discordId, body);
    if (route === 'stream/bonus-state')           return await routeStreamBonusState(env);
    if (route === 'play/skills/snapshot')         return await routeSkillsSnapshot(env, guildId, discordId);
    if (route === 'play/skills/allocate')         return await routeSkillsAllocate(env, guildId, discordId, body);
    if (route === 'play/skills/respec')           return await routeSkillsRespec(env, guildId, discordId);
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
    if (route === 'squad/create')             return await routeSquadCreate(env, discordId, body);
    if (route === 'squad/active')             return await routeSquadActive(env, body);
    if (route === 'squad/get')                return await routeSquadGet(env, body);
    if (route === 'squad/join')               return await routeSquadJoin(env, discordId, body);
    if (route === 'squad/leave')              return await routeSquadLeave(env, discordId, body);
    if (route === 'squad/end')                return await routeSquadEnd(env, discordId, body);
    if (route === 'squad/event')              return await routeSquadEvent(env, discordId, body);
    if (route === 'squad/feed')               return await routeSquadFeed(env, body);
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
    if (route.startsWith('expedition/')) {
      const sub = route.slice('expedition/'.length);
      const { handleExpeditionWeb } = await import('./expedition.js');
      return await handleExpeditionWeb(env, guildId, discordId, body, sub);
    }
    if (route === 'character')             return await routeCharacterGet(env, guildId, discordId);
    if (route === 'character/save')        return await routeCharacterSave(env, guildId, discordId, body);
    if (route === 'character/reset')       return await routeCharacterReset(env, guildId, discordId);
    if (route === 'character/avatar')      return await routeCharacterAvatar(env, guildId, discordId, body);
    if (isBoltboundRoute(route))           return await routeBoltbound(env, guildId, discordId, route, body);
    if (isBoardRoute(route))               return await routeBoard(env, route, guildId, discordId, body);
  } catch (e) {
    return json({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
  return json({ error: 'not-found' }, 404);
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
// on every play is safe — only the first one for an attributed
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
  // Anniversary firstSeen heartbeat — daily claim is the cheapest
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
    // Aquilo Pass v2 XP — daily claim feeds battle-pass progression.
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

async function routeStocksSnapshot(env, guildId, userId) {
  const [catalog, holdings, wallet] = await Promise.all([
    getCatalog(env),
    getHoldings(env, guildId, userId),
    getWallet(env, guildId, userId),
  ]);
  // Pull prices + a short history per ticker so the UI can chart trends
  // without a second call. The list is small (~20 tickers).
  const tickers = (catalog && catalog.tickers) || [];
  const priced = await Promise.all(
    tickers.map(async (def) => {
      const ticker = def && def.ticker;
      if (!ticker) return null;
      const [rec, history] = await Promise.all([
        getPrice(env, ticker),
        getHistory(env, ticker),
      ]);
      return {
        ticker,
        name: def.name || ticker,
        source: def.source || null,
        sourceRef: def.sourceRef || null,
        price: (rec && rec.price) || null,
        updatedAt: (rec && rec.updatedAt) || null,
        history: Array.isArray(history) ? history.slice(-24) : [],
        held: Number(holdings[ticker]) || 0,
      };
    }),
  );
  return json({
    ok: true,
    tickers: priced.filter(Boolean),
    balance: wallet.balance || 0,
    feePct: 1,
  });
}

// Full per-user portfolio: positions with cost-basis + unrealized
// gain, totals, recent transactions, and trading stats. Built on top
// of getHoldings (qty source of truth) + the new transaction log
// (cost-basis source of truth). Heavy enough to skip the snapshot
// route on initial page load and only call here.
async function routeStocksPortfolio(env, guildId, userId) {
  const p = await buildStocksPortfolio(env, guildId, userId);
  return json(p);
}

// ── /web/stocks/alerts/* ─────────────────────────────────────────────
//
// Per-user price alerts. List is GET-style (cheap, read-only).
// Create takes { ticker, target, direction:"above"|"below" }; the
// worker validates the ticker against the catalogue and the user's
// alert-count cap (20). Delete takes { id }; idempotent. All gated
// by the standard HMAC session — discordId/guildId come from the
// verified Patreon session, not the browser.
async function routeStocksAlertsList(env, guildId, userId) {
  const alerts = await getStockAlerts(env, guildId, userId);
  return json({ ok: true, alerts });
}

async function routeStocksAlertsCreate(env, guildId, userId, body) {
  const r = await createStockAlert(env, guildId, userId, {
    ticker: body && body.ticker,
    direction: body && body.direction,
    target: body && body.target,
  });
  return json(r, r.ok ? 200 : 400);
}

async function routeStocksAlertsDelete(env, guildId, userId, body) {
  const id = body && body.id;
  if (!id) return json({ ok: false, error: 'bad-id', message: 'id is required.' }, 400);
  const r = await deleteStockAlert(env, guildId, userId, id);
  return json(r);
}

async function routeStocksBuy(env, guildId, userId, body) {
  const ticker = String(body && body.ticker || '').toUpperCase();
  const bolts = Number(body && body.bolts);
  if (!ticker) return json({ ok: false, error: 'bad-ticker', message: 'Pick a ticker.' }, 400);
  if (!Number.isFinite(bolts) || bolts <= 0) {
    return json({ ok: false, error: 'bad-bolts', message: 'Bolts must be a positive number.' }, 400);
  }
  const r = await runBuyJson(env, guildId, userId, { ticker, bolts: Math.floor(bolts) });
  // Buy and sell don't write to recap stats today (Discord's stock
  // command never has either). Leave it that way for now -- stocks
  // are a separate ledger from the "games_won/lost" win-rate stat.
  return json(r, r.ok ? 200 : 400);
}

async function routeStocksSell(env, guildId, userId, body) {
  const ticker = String(body && body.ticker || '').toUpperCase();
  const shares = Number(body && body.shares);
  if (!ticker) return json({ ok: false, error: 'bad-ticker', message: 'Pick a ticker.' }, 400);
  if (!Number.isInteger(shares) || shares <= 0) {
    return json({ ok: false, error: 'bad-shares', message: 'Shares must be a positive integer.' }, 400);
  }
  const r = await runSellJson(env, guildId, userId, { ticker, shares });
  return json(r, r.ok ? 200 : 400);
}

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
  // Solo bet — same validation as before but kind-aware.
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

// ── Hero / Inventory / Equip / Unequip / Sell (Phase 2) ───────────────

async function routeHero(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId);
  const { bag, equipped } = await doInventory(env, guildId, userId);
  return json({
    ok: true,
    hero: {
      name: hero.name || '',
      class: hero.class || 'rogue',
      level: hero.level || 1,
      hp: hero.hp || 0,
      maxHp: hero.maxHp || 0,
      attack: attackOf(hero),
      defense: defenseOf(hero),
      portrait: hero.portrait || null,
    },
    bag: Array.isArray(bag) ? bag : [],
    equipped: equipped || {},
  });
}

async function routeEquip(env, guildId, userId, body) {
  const id = String(body && body.itemId || '').trim();
  if (!id) return json({ ok: false, error: 'bad-args', message: 'Pick an item.' }, 400);
  const r = await doEquip(env, guildId, userId, id);
  if (!r.ok) {
    const msg = r.reason === 'not-found'
      ? `No item starting with \`${id}\` in your bag.`
      : 'That item has no equip slot.';
    return json({ ok: false, error: r.reason, message: msg }, 400);
  }
  return json({ ok: true, item: r.item, message: `Equipped ${r.item.name}.` });
}

async function routeUnequip(env, guildId, userId, body) {
  const slot = String(body && body.slot || '').trim().toLowerCase();
  if (!slot) return json({ ok: false, error: 'bad-args', message: 'Pick a slot.' }, 400);
  const r = await doUnequip(env, guildId, userId, slot);
  if (!r.ok) return json({ ok: false, error: r.reason, message: `Nothing equipped in ${slot}.` }, 400);
  return json({ ok: true, slot, message: `Unequipped ${slot}.` });
}

async function routeSell(env, guildId, userId, body) {
  const id = String(body && body.itemId || '').trim();
  if (!id) return json({ ok: false, error: 'bad-args', message: 'Pick an item.' }, 400);
  const r = await doSell(env, guildId, userId, id);
  if (!r.ok) return json({ ok: false, error: r.reason, message: `No item starting with \`${id}\`.` }, 400);
  return json({ ok: true, item: r.item, refund: r.refund, message: `Sold for ${r.refund} bolts.` });
}

// ── Shop (Phase 3) ────────────────────────────────────────────────────

async function routeShop(env, guildId, userId) {
  const stock = await getDailyShop(env, guildId);
  // getDailyShop returns { date, items: [[slot, rarity, name, glyph, atk, def, price, setName, weaponType, preferredClass, ability], ...] }
  // Reshape to JSON-friendly objects.
  const items = (stock && stock.items ? stock.items : []).map((row) => ({
    slot: row[0],
    rarity: row[1],
    name: row[2],
    glyph: row[3],
    powerBonus: row[4] || 0,
    defenseBonus: row[5] || 0,
    price: row[6] || 0,
    setName: row[7] || '',
    weaponType: row[8] || '',
    preferredClass: row[9] || '',
    ability: row[10] || '',
  }));
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    date: stock && stock.date,
    items,
    balance: w.balance || 0,
  });
}

async function routeShopBuy(env, guildId, userId, body) {
  const name = String(body && body.name || '').trim();
  if (!name) return json({ ok: false, error: 'bad-args', message: 'Pick an item.' }, 400);
  const r = await doShopBuy(env, guildId, userId, name);
  if (!r.ok) {
    const msg = r.reason === 'not-in-stock'
      ? "That item isn't in today's shop stock."
      : r.reason === 'insufficient'
      ? `Need ${r.price} bolts; you have ${r.balance}.`
      : 'Couldn\'t buy — try again.';
    return json({ ok: false, error: r.reason, message: msg, ...r }, 400);
  }
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    item: r.item || null,
    balance: w.balance || 0,
    message: `Bought ${r.item ? r.item.name : 'item'}.`,
  });
}

// ── Revive elixir ────────────────────────────────────────────────
// Buy: charges level-scaled bolts and adds a Revive Elixir to bag.
// Use: consumes one elixir + flips the hero from dead → alive @ full HP.
// Two-step (buy then use) is intentional so a player who already owns
// an elixir can revive without an extra purchase, and so the bag-state
// matches Clay's spec ("an item the player owns").

async function routeDungeonBuyRevive(env, guildId, userId) {
  const { loadHero, saveHero, SHOP_ESSENTIALS } = await import('./dungeon.js');
  const { reviveCost, REVIVE_ITEM_ID } = await import('./hero-death.js');
  const hero = await loadHero(env, guildId, userId);
  if (!hero) return json({ ok: false, error: 'no-hero' }, 400);
  const cost = reviveCost(hero);
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < cost) {
    return json({
      ok: false, error: 'insufficient-bolts',
      message: `Need ${cost} bolts; you have ${wallet.balance || 0}.`,
      need: cost, have: wallet.balance || 0,
    }, 400);
  }
  try {
    await applyVaultDelta(env, guildId, userId, -cost, 'dungeon:buy-revive');
  } catch (e) {
    return json({ ok: false, error: 'bolts-debit-failed', detail: String(e?.message || e) }, 500);
  }
  // Push a fresh elixir into the bag — the catalogue entry minus the
  // gameplay-irrelevant description field, matching how other bag items
  // are stored (see dungeon.js doShopBuy).
  const tpl = (SHOP_ESSENTIALS || []).find(e => e.id === REVIVE_ITEM_ID);
  const item = tpl ? {
    id: tpl.id, slot: tpl.slot, rarity: tpl.rarity, name: tpl.name,
    glyph: tpl.glyph, goldValue: cost, consumable: true,
    spriteId: tpl.spriteId,
  } : { id: REVIVE_ITEM_ID, slot: 'consumable', rarity: 'rare', name: 'Revive Elixir', glyph: '✨', goldValue: cost, consumable: true };
  hero.bag = Array.isArray(hero.bag) ? hero.bag : [];
  hero.bag.push(item);
  await saveHero(env, guildId, userId, hero);
  const fresh = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    item,
    balance: fresh.balance || 0,
    spent: cost,
    message: `Bought Revive Elixir for ${cost} bolts.`,
  });
}

async function routeDungeonUseRevive(env, guildId, userId) {
  const { useReviveElixir, reviveCost } = await import('./hero-death.js');
  const r = await useReviveElixir(env, guildId, userId);
  if (!r.ok) {
    const message =
      r.error === 'no-hero'   ? "No hero on record."
    : r.error === 'not-dead'  ? "Your hero is already alive."
    : r.error === 'no-elixir' ? `No Revive Elixir in your bag. Buy one for ${r.reviveCost} bolts.`
    : "Couldn't revive — try again.";
    return json({ ok: false, error: r.error, message, reviveCost: r.reviveCost }, 400);
  }
  return json({
    ok: true,
    hero: r.hero,
    message: 'Hero revived to full HP. Lost gear stays lost.',
  });
}

// ── Dungeon skip-cooldown ────────────────────────────────────────
//
// I3 (2026-05): per-viewer cooldown removed. Dungeons only run while
// Clay is live, so there's no rate-abuse vector — the 10-min
// per-viewer lockout was friction without a purpose. The endpoint
// now always queues a skip command for the DLL; PanelBridgeModule
// stamps the trusted skip flag exactly as before.
//
// Bits + bolts payment paths (ext-panelbridge.js skipCooldown) are
// unchanged — they're Twitch panel monetization SKUs, not part of
// the website's web-skip flow.

async function routeDungeonSkip(env, guildId, userId) {
  const record = {
    kind: 'dungeon',
    action: 'skip',
    arg: '',
    user: { id: String(userId), name: 'web-patron', role: 'viewer' },
    ts: Date.now(),
  };
  const key = 'relay:dll-pending:' + record.ts + '-' + Math.random().toString(36).slice(2, 8);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(record), { expirationTtl: 90 });
  return json({ ok: true, message: 'Cooldown skip queued. Watch the stream.' });
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

// POST /web/clash/raid
//
// Web mirror of the `/clash raid` Discord slash command. Same code
// path (clash.js executeRaid) — same token-consume, same simulator,
// same loot economy, same shields + war scoring + push notifications
// and bus events. The only difference is the response shape:
// structured JSON the web UI can render directly, no Discord-flavoured
// formatting.
//
// Body fields:
//   discordId   the attacker (set by the site session)
//   guildId     the attacker's home channel (set by the site session,
//               guild-allow-list checked above)
//   kind        'goblin' | 'npc' | 'player'
//   userName    optional display name; defaults to "viewer" if absent.
//               Used in push titles + ring-buffer events so the OBS
//               overlay shows the right person.
//
// Returns the executeRaid structured result verbatim (see clash.js).
// HTTP status is always 200 — errors come back as `{ ok:false, error,
// ... }` so the UI can render specific copy per case.
async function routeClashRaid(env, guildId, userId, body) {
  const kind = String((body && body.kind) || '').toLowerCase();
  if (kind !== 'goblin' && kind !== 'npc' && kind !== 'player') {
    return json({ ok: false, error: 'bad-kind', message: 'kind must be goblin, npc, or player' }, 400);
  }
  const userName = String((body && body.userName) || '').trim() || 'viewer';
  const r = await executeRaid(env, guildId, userId, userName, kind);
  return json({ ok: !!r.ok, ...r });
}

// ── /web/clash/build ─────────────────────────────────────────────
//
// Drop-in for the slash command `/clash town build kind:<...>
// buildingId:<...?>` — same code path (clash.js handleTownBuild via
// _editorTownBuild adapter) so all the validation, treasury maths,
// hero-level gate, build-queue mutation, and cooldown plumbing
// happen exactly once.
//
// Gated by canManageTown — only the streamer + designated mods can
// queue town builds. The site verifies the Patreon session → Discord
// link before signing this request, so the discordId we receive has
// already been authenticated. We re-check ownership/mod status here
// against the bot-side town record (defence-in-depth).
//
// Body fields:
//   discordId   the acting user (mod or streamer, set by site session)
//   guildId     the target town's guild
//   kind        building kind — townhall|wall|cannon|archerTower|trap|
//               storage|barracks|warTent
//   buildingId  (optional) numeric id of an existing building. If
//               present → upgrade that building one level. If absent
//               → build a new one of `kind` at the next free tile.
//
// Response:
//   { ok: true,  message: "🏗 Upgrading Wall #4 → L3. Ready in 30 min." }
//   { ok: false, error: 'permission', message: "🔒 ..." }
//   { ok: false, error: 'badkind'|'treasury'|'maxlevel'|'herogate'|'badbuilding',
//     message: "❌ ..." }
//
// HTTP status is always 200 — the structured `ok` flag is the source
// of truth; the message string is the Discord-formatted user copy
// the UI can display verbatim. (Mirrors /web/clash/raid contract.)
function classifyBuildMessage(msg) {
  if (typeof msg !== 'string' || !msg) return { ok: false, error: 'unknown' };
  if (msg.startsWith('🏗') || msg.startsWith('⛺')) return { ok: true };
  if (msg.startsWith('🔒')) return { ok: false, error: 'permission' };
  if (msg.includes('Treasury short'))     return { ok: false, error: 'treasury' };
  if (msg.includes('maxed') || msg.includes('Max level')) return { ok: false, error: 'maxlevel' };
  if (msg.includes('needs at least one community hero')) return { ok: false, error: 'herogate' };
  if (msg.includes('Unknown building'))   return { ok: false, error: 'badkind' };
  if (msg.includes('Unknown garrison'))   return { ok: false, error: 'badtroop' };
  if (msg.includes('No building with id')) return { ok: false, error: 'badbuilding' };
  return { ok: false, error: 'other' };
}

async function routeClashBuild(env, guildId, userId, body) {
  const kind = String((body && body.kind) || '').trim();
  const buildingId = body && body.buildingId != null ? String(body.buildingId).trim() : null;
  if (!kind || !BUILDINGS[kind]) {
    return json({ ok: false, error: 'badkind', message: '❌ Unknown building. Try: ' + Object.keys(BUILDINGS).join(', ') }, 200);
  }
  // Belt-and-braces — _editorTownBuild also checks but we want a
  // distinct error code instead of leaning on the embedded copy.
  if (!await canManageTown(env, guildId, userId)) {
    return json({ ok: false, error: 'permission', message: '🔒 Only the streamer + designated mods can queue town builds.' }, 200);
  }
  const message = await _editorTownBuild(env, guildId, userId, kind, buildingId);
  const cls = classifyBuildMessage(message);
  return json({ ...cls, message });
}

// ── /web/clash/garrison ──────────────────────────────────────────
//
// Mirror of `/clash town garrison troop:<...> count:<n>`. Same gate,
// same code path (handleTownGarrison via _editorTownGarrison).
//
// Body fields:
//   discordId   the acting user
//   guildId     the target town
//   troopId     scrapper | boltKnight | voltaicMage | archerLite
//   count       1..20 (clamped server-side)
async function routeClashGarrison(env, guildId, userId, body) {
  const troopId = String((body && body.troopId) || '').trim();
  const count = Math.max(1, Math.min(20, Number((body && body.count) || 1) || 1));
  if (!troopId || !TROOPS_GARRISON[troopId]) {
    return json({ ok: false, error: 'badtroop', message: '❌ Unknown garrison troop. Try: ' + Object.keys(TROOPS_GARRISON).join(', ') }, 200);
  }
  if (!await canManageTown(env, guildId, userId)) {
    return json({ ok: false, error: 'permission', message: '🔒 Only the streamer + designated mods can train town garrison.' }, 200);
  }
  const message = await _editorTownGarrison(env, guildId, userId, troopId, count);
  const cls = classifyBuildMessage(message);
  return json({ ...cls, message });
}

// ── /web/clash/sell ──────────────────────────────────────────────
//
// H1 — Sell a building and refund 25 % of its build cost. CoC-style
// partial refund. Same gate + side-effects as the in-game demolish,
// but allowed on idle buildings (not just damaged/destroyed).
//
// Body fields:
//   discordId   the acting user
//   guildId     the target town
//   buildingId  numeric id of the building to sell
//
// Returns: { ok, refund: { bolts?, scrap?, cores?, wood?, stone?,
//                          iron?, gold? }, layoutVersion, message }
async function routeClashSell(env, guildId, userId, body) {
  const buildingId = body?.buildingId;
  if (buildingId == null) {
    return json({ ok: false, error: 'bad-id', message: '❌ Pass buildingId.' }, 200);
  }
  const r = await _editorTownSell(env, guildId, userId, buildingId);
  return json(r, 200);
}

// ── /web/clash/layout ────────────────────────────────────────────
//
// H2 — In-app layout-save. Mirror of the secret-path
// /sync/<guildId>/clash/layout (used by the ClashEditor SPA);
// this is the path the in-app TownManager edit mode uses since it's
// authed via the Patreon session, not the editor secret.
//
// Body fields:
//   discordId   the acting user
//   guildId     the target town
//   layout      [{ id?, kind, x, y, level? }, ...]
//                 existing buildings carry `id`; new placements omit it
//
// Returns: { ok, layoutVersion?, errors?: [...] }
async function routeClashLayout(env, guildId, userId, body) {
  const layout = Array.isArray(body?.layout) ? body.layout : null;
  if (!layout) return json({ ok: false, errors: ['layout-array-required'] }, 200);
  const r = await _editorTownLayout(env, guildId, userId, layout);
  return json(r, 200);
}

// ── /web/clash/town ──────────────────────────────────────────────
//
// Convenience read for the website's town-management UI — same
// payload as the public GET /clash/town/<guildId> route but reached
// through the /web/* HMAC channel (so the site can hide private
// details from public callers later without breaking its own UI).
// Buildings come pre-enriched with spriteId per entry; garrison
// counts come with a parallel sprites map.
async function routeClashTown(env, guildId, userId) {
  const town = await getTown(env, guildId);
  if (!town) return json({ ok: false, error: 'no-town', message: 'no town for this guild' }, 200);
  if (!await canManageTown(env, guildId, userId)) {
    return json({ ok: false, error: 'permission', message: '🔒 Only the streamer + designated mods can read the management view.' }, 200);
  }
  const treasury = await getTreasury(env, guildId);
  const wallet = await getWallet(env, guildId, userId);
  const myContribRaw = await env.LOADOUT_BOLTS.get(`clash:contributions:${guildId}:${userId}`, { type: 'json' });
  const obstacles = withObstacleSprites(town.obstacles || []);
  const engineersTotal = Math.max(1, town.engineers?.total || 1);
  const engineersBusy = obstacles.filter(o => o.status === 'clearing').length;
  // Pre-compute upgrade preview per building (cost + time for next
  // level) so the UI can render "Upgrade →" buttons without a second
  // round trip per building.
  const buildings = (town.buildings || []).map(b => {
    const def = BUILDINGS[b.kind] || {};
    const maxLevel = (def.hp?.length || 2) - 1;
    const nextLevel = (b.level || 1) + 1;
    const nextCost = nextLevel <= maxLevel ? townBuildCost(b.kind, nextLevel) : null;
    const lvl = b.level || 1;
    // H3 — flatten per-level stats (damage/range/dps/hp/storage/
    // capacity/burst/production) into one object the site's info-popup
    // can iterate to render lines. Only present keys are included so
    // the popup doesn't render "damage: —" for a Sawmill.
    const stats = {};
    if (def.hp?.[lvl] != null)               stats.hp = def.hp[lvl];
    if (def.dps?.[lvl] != null)              stats.dps = def.dps[lvl];
    if (def.dps?.[lvl] != null)              stats.damage = def.dps[lvl];
    if (def.range != null)                   stats.range = def.range;
    if (def.targets)                         stats.targets = def.targets;
    if (def.burst?.[lvl] != null)            stats.burst = def.burst[lvl];
    if (def.capacityBonus?.[lvl] != null)    stats.storage = def.capacityBonus[lvl];
    if (def.garrisonCapBonus?.[lvl] != null) stats.capacity = def.garrisonCapBonus[lvl];
    if (def.productionRate?.[lvl] != null)   stats.productionPerMin = def.productionRate[lvl];
    if (def.collectorStorage?.[lvl] != null) stats.collectorStorage = def.collectorStorage[lvl];
    if (def.grantsBuildSlots?.[lvl] != null) stats.buildSlots = def.grantsBuildSlots[lvl];
    if (def.grantsBarracksCap?.[lvl] != null) stats.barracksCap = def.grantsBarracksCap[lvl];
    if (def.grantsGatherSlots?.[lvl] != null) stats.gatherSlots = def.grantsGatherSlots[lvl];
    if (def.championHpMult?.[lvl] != null)   stats.championHpMult = def.championHpMult[lvl];
    if (def.collectorOf)                     stats.produces = def.collectorOf;
    if (def.footprint)                       stats.footprint = def.footprint;
    return {
      ...b,
      spriteId:   `clash/buildings/${b.kind}-L${b.level || 1}.png`,        // V1 legacy (OBS overlay)
      spriteIdV2: spriteIdForBuildingV2(b.kind, b.level || 1),             // glossy SVG — in-app TownManager reads this
      maxLevel,
      nextLevel: nextLevel <= maxLevel ? nextLevel : null,
      nextCost: nextCost ? { cost: nextCost.cost, timeMs: nextCost.timeMs } : null,
      stats,
    };
  });
  // Available "new build" kinds + their L1 costs.
  const newBuildOptions = Object.keys(BUILDINGS).map(k => {
    const c = townBuildCost(k, 1);
    return {
      kind: k,
      name: BUILDINGS[k].name,
      glyph: BUILDINGS[k].glyph,
      spriteId:   `clash/buildings/${k}-L1.png`,
      spriteIdV2: spriteIdForBuildingV2(k, 1),
      cost: c ? c.cost : null,
      timeMs: c ? c.timeMs : null,
    };
  });
  const garrison = town.garrison || {};
  const garrisonSprites = withGarrisonSprites(garrison).sprites;
  const garrisonOptions = Object.keys(TROOPS_GARRISON).map(t => {
    const c = townGarrisonCost(t, 1);
    return {
      troopId: t,
      name: TROOPS_GARRISON[t].name,
      glyph: TROOPS_GARRISON[t].glyph,
      spriteId:   `clash/troops/${t}.png`,
      spriteIdV2: spriteIdForTroopV2(t),
      bolts: c ? c.bolts : null,
      timeMs: c ? c.timeMs : null,
    };
  });
  // H4 — Total builder slots = TH grant for current level + 1 per
  // built Builder's Hut. Mirrors the formula clash-layout.js +
  // handleTownBuild use when capping the queue length.
  const thBuilding = (town.buildings || []).find(b => b.kind === 'townhall');
  const thBuildSlots = thBuilding ? (BUILDINGS.townhall?.grantsBuildSlots?.[thBuilding.level || 1] || 1) : 1;
  const hutSlots = (town.buildings || []).filter(b => b.kind === 'buildersHut').length;
  const builderSlots = Math.min(4, thBuildSlots + hutSlots);

  // H5 — Mirror the build queue onto this payload so the in-app
  // build-queue rail can render live timers. Same shape clash-http.js
  // returns on the secret-path /sync read.
  const q = await getQueue(env, `clash:queue:${guildId}`);
  const queue = (q.items || []).map(item => ({
    id: item.id,
    kind: item.kind,
    target: item.target || null,
    endsAt: item.endsAt || 0,
  }));

  return json({
    ok: true,
    guildId,
    thLevel: town.thLevel,
    treasury,
    // Phase 5 — the calling user's wallet ships with the read so the
    // play UI can render "you have N Bolts to donate" without a
    // second round trip. Closes the long-standing gap where Clash
    // costs were visible but the wallet wasn't.
    wallet: {
      balance: wallet.balance || 0,
      lifetimeEarned: wallet.lifetimeEarned || 0,
      lifetimeSpent: wallet.lifetimeSpent || 0,
    },
    myContributions: myContribRaw?.lifetimeBolts || 0,
    buildings,
    garrison,
    garrisonSprites,
    newBuildOptions,
    garrisonOptions,
    // Phase 5 — obstacles + the Engineer slot. The site Clash UI uses
    // these to highlight buildable cells (in-grid, no building, no
    // uncleared obstacle) and to render the clear-obstacle CTA.
    grid: town.grid || { w: 48, h: 48 },
    obstacles,
    obstacleCatalogue: OBSTACLES,
    engineers: { total: engineersTotal, busy: engineersBusy },
    layoutVersion: town.layoutVersion,
    builderSlots,
    queue,
  });
}

// ── /web/clash/donate ───────────────────────────────────────────────
//
// Moves Bolts from the caller's wallet into the town treasury. Body:
//   { discordId, guildId, amount }              // amount in Bolts (int>=1)
// Response:
//   { ok: true,  message, accepted, treasury, wallet }
//   { ok: false, error: 'bad-amount'|'wallet-empty'|'treasury-full'|'other',
//                message, treasury, wallet }
// No mod gate — any wallet-holder can donate. Treasury caps at the
// Storage-bonus capacity; over-cap donations clamp + report
// 'treasury-full' so the UI can prompt for a Storage upgrade.
async function routeClashDonate(env, guildId, userId, body) {
  const raw = Number((body && body.amount) || 0);
  const amount = Math.floor(raw);
  if (!Number.isFinite(raw) || amount < 1) {
    return json({
      ok: false, error: 'bad-amount',
      message: '❌ Donate at least 1 Bolt — pass { amount: <int> }.',
    });
  }
  const message = await _editorDonate(env, guildId, userId, amount);
  const treasury = await getTreasury(env, guildId);
  const wallet = await getWallet(env, guildId, userId);
  // handleDonate's reply strings: 💰 success, 🏛 treasury full, ❌ failure
  let ok = false, error;
  if (typeof message === 'string') {
    if (message.startsWith('💰'))      ok = true;
    else if (message.startsWith('🏛')) { ok = false; error = 'treasury-full'; }
    else if (message.includes('Not enough Bolts')) { ok = false; error = 'wallet-empty'; }
    else                               { ok = false; error = 'other'; }
  }
  return json({
    ok, error, message,
    treasury,
    wallet: {
      balance: wallet.balance || 0,
      lifetimeEarned: wallet.lifetimeEarned || 0,
      lifetimeSpent: wallet.lifetimeSpent || 0,
    },
  });
}

// ── /web/clash/clear-obstacle ───────────────────────────────────────
//
// Streamer/mod dispatches the town Engineer to clear one obstacle.
// Body:
//   { discordId, guildId, obstacleId }          // obstacleId: number
// Response:
//   { ok: true,  message, obstacleId, endsAt, treasury, engineers,
//     obstacles }
//   { ok: false, error: 'permission'|'no-obstacle'|'busy'|'no-engineer'
//                       |'treasury'|'badkind'|'other',
//                message, treasury, engineers, obstacles }
// All errors mirror the slash command's user-facing string so the UI
// can either render `message` verbatim or branch on `error`.
async function routeClashClearObstacle(env, guildId, userId, body) {
  if (!await canManageTown(env, guildId, userId)) {
    return json({
      ok: false, error: 'permission',
      message: '🔒 Only the streamer + designated mods can direct the Engineer.',
    });
  }
  const obstacleId = body && body.obstacleId;
  const message = await _editorClearObstacle(env, guildId, userId, obstacleId);
  const town = await getTown(env, guildId);
  const treasury = await getTreasury(env, guildId);
  const obstacles = withObstacleSprites(town?.obstacles || []);
  const engineersTotal = Math.max(1, town?.engineers?.total || 1);
  const engineersBusy = obstacles.filter(o => o.status === 'clearing').length;
  // Classify message → { ok, error }.
  let ok = false, error, endsAt = null;
  if (typeof message === 'string') {
    if (message.startsWith('⛏ Engineer dispatched')) {
      ok = true;
      const o = obstacles.find(x => String(x.id) === String(obstacleId));
      endsAt = o?.clearEndsAt || null;
    } else if (message.startsWith('🔒'))                    error = 'permission';
    else if (message.includes('No obstacle'))               error = 'no-obstacle';
    else if (message.includes('already being cleared'))     error = 'busy';
    else if (message.includes('Engineer is busy'))          error = 'no-engineer';
    else if (message.includes('Treasury short'))            error = 'treasury';
    else if (message.includes('Unknown obstacle'))          error = 'badkind';
    else if (message.includes('Pass an obstacle'))          error = 'bad-id';
    else                                                    error = 'other';
  }
  return json({
    ok, error, message,
    obstacleId: obstacleId != null ? Number(obstacleId) : null,
    endsAt,
    treasury,
    engineers: { total: engineersTotal, busy: engineersBusy },
    obstacles,
  });
}

// ── /web/character ──────────────────────────────────────────────
//
// Read + save the player's pixel-art character look from the
// aquilo.gg /character page. Same hero record + lookVersion bump as
// the Discord `/character` slash command — so a save here updates
// every render URL pinned to ?v=<lookVersion> in Discord embeds,
// Twitch panel, and the site preview.
//
// POST /web/character
//   Body:  { discordId, guildId }
//   Returns:
//     { ok: true,
//       look: { bodyType, skinTone, hairStyle, hairColor, eyeColor, accent },
//       lookVersion: <int>,
//       renderUrl: 'https://.../character/render/<guildId>/<userId>.png?v=<N>',
//       options: { bodyType, skinTone, hairStyle, hairColor, eyeColor, accent },
//                                                              // arrays of valid values
//       hairSwatches: { brown: '#5a3a26', black: '#2a2a30', ... } }
//                                                              // hex previews for the UI
//
// POST /web/character/save
//   Body:  { discordId, guildId, look: { bodyType?, skinTone?, hairStyle?,
//                                        hairColor?, eyeColor?, accent? } }
//   Partial updates allowed — unspecified fields stay unchanged.
//   Validates every submitted axis against the same option lists the
//   GET returns. Bumps lookVersion and lastUpdatedUtc on change.
//   Returns:
//     { ok: true,  look, lookVersion, renderUrl, changed: <bool> }
//     { ok: false, error: 'bad-look', field: '<axis>', value: '<bad>' }
//
// First-time visitors get a deterministic Phase-0 backfill so the
// GET always returns a complete look — no empty-state branch needed
// on the UI side.

// ── /web/clash/setup ─────────────────────────────────────────────
//
// First-time town creation from the website. Mirrors what the bot
// does on the first /clash subcommand on a fresh guild — ensures a
// town record with a sane default layout exists. Idempotent: a
// repeat call against a guild that already has a town returns the
// existing record without mutating it.
//
// Auth model:
//   - The Patreon session is already linked → Discord ID,
//     verified upstream (handleWeb).
//   - The guild must already be claimed via /loadout-claim (the
//     `guildowner:<guildId>` KV record). Town setup intentionally
//     doesn't auto-pin a random user as town owner; the guild owner
//     is the only valid creator.
//   - The caller's Discord ID must match the guild owner's. Mods
//     can't call setup (canManageTown only matters once a town
//     exists; a mod predates the town here).
//
// Body fields:
//   discordId   the acting user (set by site session)
//   guildId     target guild
//
// Response:
//   { ok: true,  alreadyExisted: <bool>, town: <fresh-or-existing> }
//   { ok: false, error: 'not-claimed' | 'permission' }
async function routeClashSetup(env, guildId, userId) {
  const ownerRec = await env.LOADOUT_BOLTS.get('guildowner:' + guildId, { type: 'json' });
  if (!ownerRec?.discordUserId) {
    return json({
      ok: false,
      error: 'not-claimed',
      message: 'guild not bound to Loadout — run /loadout-claim in Discord first',
    }, 200);
  }
  if (ownerRec.discordUserId !== userId) {
    return json({
      ok: false,
      error: 'permission',
      message: 'only the guild owner can create the town',
    }, 200);
  }
  const before = await getTown(env, guildId);
  const town = await ensureTown(env, guildId, ownerRec.discordUserId);
  return json({
    ok: true,
    alreadyExisted: !!before,
    town: {
      thLevel: town.thLevel,
      ownerUserId: town.ownerUserId,
      layoutVersion: town.layoutVersion,
    },
  });
}

async function routeCharacterGet(env, guildId, userId) {
  const r = await getCharacterLookWeb(env, guildId, userId);
  return json(r, r.ok ? 200 : 400);
}

async function routeCharacterSave(env, guildId, userId, body) {
  const lookPatch = (body && typeof body.look === 'object' && body.look) ? body.look : null;
  if (!lookPatch) {
    return json({ ok: false, error: 'bad-body', message: 'look object required' }, 400);
  }
  const r = await saveCharacterLookWeb(env, guildId, userId, lookPatch);
  return json(r, statusFor(r));
}

// POST /web/character/reset
//
// Charges CHARACTER_RESET_COST Bolts (5,000) from the caller's wallet
// and flips hero.locked back to false so the player can re-pick their
// class + customisation. The look + class stay intact on reset; only
// the lock flag clears. Re-saving will re-lock.
//
// Body fields:
//   discordId   the acting user (set by site session)
//   guildId     the player's home guild (set by site session)
//   (no other fields — the cost is server-fixed, no client input)
//
// Response (HTTP status mirrors the error class — 200 ok, 409 locked,
// 400 not-locked, 402 insufficient-bolts, 500 reset-failed):
//   { ok: true, charged: 5000,
//     wallet: { balance, lifetimeEarned, lifetimeSpent },
//     locked: false, look, lookVersion, renderUrl }
//   { ok: false, error: 'not-locked',         message, wallet }
//   { ok: false, error: 'insufficient-bolts', required: 5000, balance, message, wallet }
//   { ok: false, error: 'reset-failed',       message, wallet }
async function routeCharacterReset(env, guildId, userId) {
  const r = await resetCharacterWeb(env, guildId, userId);
  return json(r, statusFor(r));
}

// POST /web/character/avatar — upload or clear a user-uploaded hero
// picture. Replaces the procedural visible-character UX on the site.
//
// Body shape (JSON, HMAC-signed like every /web/* route):
//   {
//     discordId, guildId,
//     contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
//     dataBase64:  '<base64-encoded image bytes>',
//     clear?: boolean
//   }
//
// Semantics:
//   - `clear: true` OR an empty `dataBase64` → delete the avatar
//     (idempotent; returns avatarUrl: null either way).
//   - Otherwise validate contentType + decoded size (≤ 4 MB),
//     persist into KV with metadata, return the public avatar URL.
//
// NOT subject to character-locked — uploads are an independent
// cosmetic slot the player owns regardless of class-lock state. See
// putAvatarWeb in character.js for rationale.
//
// Status codes:
//   200 — { ok: true, avatarUrl: <string|null>, contentType?, size? }
//   400 — { ok: false, error: 'bad-content-type' | 'bad-data' }
//   413 — { ok: false, error: 'too-large', max, size }
//   503 — { ok: false, error: 'no-kv' | 'delete-failed' }
async function routeCharacterAvatar(env, guildId, userId, body) {
  const clear = !!(body && body.clear);
  const dataBase64 = body && body.dataBase64;
  if (clear || !dataBase64) {
    const r = await clearAvatarWeb(env, userId);
    return json(r, r.ok ? 200 : 503);
  }
  const contentType = body && body.contentType;
  const r = await putAvatarWeb(env, userId, contentType, dataBase64, guildId);
  if (r.ok) return json(r, 200);
  if (r.error === 'too-large') return json(r, 413);
  if (r.error === 'no-kv')     return json(r, 503);
  return json(r, 400);
}

// Map the structured `error` discriminator → HTTP status. 200 for
// success, 409 for state-conflict ('character-locked'), 402 for
// insufficient-bolts, 500 for reset-failed, 400 for everything else
// (validation + not-locked). The UI keys off the `error` string, so
// the status is informational — but it lets cURL + browser devtools
// glance at the right colour code at a glance.
function statusFor(r) {
  if (r && r.ok) return 200;
  switch (r && r.error) {
    case 'character-locked':   return 409;
    case 'insufficient-bolts': return 402;
    case 'reset-failed':       return 500;
    default:                   return 400;
  }
}

// ── /web/character/class ─────────────────────────────────────────
//
// Set the hero's class. Mirrors the Discord /loadout class slash
// command but returns a structured response the site can render.
//
// Body fields:
//   discordId   acting user (set by site session)
//   guildId     target guild (set by site session)
//   className   one of: warrior | mage | rogue | ranger | healer
//
// First-time selection mints the class's starter-gear loadout into
// the hero's bag (5 items, all common rarity, class-flavoured).
// Subsequent class changes only flip className + HP — gear is never
// re-granted (tracked via hero.starterGranted).
//
// Response:
//   { ok: true, className, classMeta: {name, atk, def, hp},
//     granted: [{slot, name, rarity, powerBonus, defenseBonus, ...}],
//     starterGranted: <bool>, hpMax }
//   { ok: false, error: 'bad-class', value: '<bad>' }
async function routeCharacterClass(env, guildId, userId, body) {
  const className = body && body.className;
  const r = await applyClassWeb(env, guildId, userId, className);
  return json(r, statusFor(r));
}

// ── /web/referral/* — new-viewer funnel ─────────────────────────────
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

// ── /web/anniversary/* — celebrations ────────────────────────────────
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
// Touches firstSeen as a side effect — visiting the dashboard counts
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

// ── /web/squad/* — Stream Squad co-watch ─────────────────────────────
//
// All bound to body.discordId (the acting user). twitchChannel /
// squadId / kind / payload come off the body. Module dynamically
// imported so the D1 dependency only loads when a squad route is hit.
async function routeSquadCreate(env, discordId, body) {
  const twitchChannel = String((body && body.twitchChannel) || '').trim().toLowerCase();
  if (!twitchChannel) return json({ ok: false, error: 'twitchChannel-required' }, 400);
  const { createSquad } = await import('./stream-squad.js');
  const r = await createSquad(env, { ownerUserId: discordId, twitchChannel });
  return json(r, r.ok ? 200 : 400);
}

async function routeSquadActive(env, body) {
  const twitchChannel = body && body.twitchChannel
    ? String(body.twitchChannel).trim().toLowerCase() : undefined;
  const { listActiveSquads } = await import('./stream-squad.js');
  const r = await listActiveSquads(env, { twitchChannel, limit: body && body.limit });
  return json(r, r.ok ? 200 : 400);
}

async function routeSquadGet(env, body) {
  const squadId = String((body && body.squadId) || '').trim();
  if (!squadId) return json({ ok: false, error: 'squadId-required' }, 400);
  const { getSquad } = await import('./stream-squad.js');
  const r = await getSquad(env, squadId);
  return json(r, r.ok ? 200 : 404);
}

async function routeSquadJoin(env, discordId, body) {
  const squadId = String((body && body.squadId) || '').trim();
  if (!squadId) return json({ ok: false, error: 'squadId-required' }, 400);
  const { joinSquad } = await import('./stream-squad.js');
  const r = await joinSquad(env, squadId, discordId);
  return json(r, r.ok ? 200 : (r.error === 'not-found' ? 404 : 400));
}

async function routeSquadLeave(env, discordId, body) {
  const squadId = String((body && body.squadId) || '').trim();
  if (!squadId) return json({ ok: false, error: 'squadId-required' }, 400);
  const { leaveSquad } = await import('./stream-squad.js');
  const r = await leaveSquad(env, squadId, discordId);
  return json(r, r.ok ? 200 : (r.error === 'not-found' ? 404 : 400));
}

async function routeSquadEnd(env, discordId, body) {
  const squadId = String((body && body.squadId) || '').trim();
  if (!squadId) return json({ ok: false, error: 'squadId-required' }, 400);
  const { endSquad } = await import('./stream-squad.js');
  const r = await endSquad(env, squadId, discordId);
  return json(r, r.ok ? 200 : (r.error === 'not-found' ? 404 : (r.error === 'not-owner' ? 403 : 400)));
}

async function routeSquadEvent(env, discordId, body) {
  const squadId = String((body && body.squadId) || '').trim();
  const kind = String((body && body.kind) || '').trim();
  if (!squadId) return json({ ok: false, error: 'squadId-required' }, 400);
  if (!kind)    return json({ ok: false, error: 'kind-required' }, 400);
  const { postSquadEvent } = await import('./stream-squad.js');
  const r = await postSquadEvent(env, squadId, discordId, kind, body && body.payload);
  return json(r, r.ok ? 200 : (r.error === 'not-found' ? 404 : (r.error === 'not-a-member' ? 403 : 400)));
}

async function routeSquadFeed(env, body) {
  const squadId = String((body && body.squadId) || '').trim();
  if (!squadId) return json({ ok: false, error: 'squadId-required' }, 400);
  const { getSquadFeed } = await import('./stream-squad.js');
  const r = await getSquadFeed(env, squadId, { limit: body && body.limit, before: body && body.before });
  return json(r, r.ok ? 200 : 400);
}

// ── /web/aether/* — Aether economy ledger ────────────────────────────
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

// ── /web/pass2/* — Aquilo Pass v2 (D1) ───────────────────────────────
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

// ── /web/boltrain/* — interactive bolt rain ─────────────────────────
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

// ── /web/randomdrop/* — rarity-weighted chest spawns ─────────────────
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
//     — once you're in a hand the pace is yours.
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
// reactor — see aquilo/community-chat.js for the per-user state
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
//   3. If ADMINISTRATOR bit is set, user can see everything — skip
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
      // User isn't in the guild — return an empty list (rather than 403)
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
    // Only text-flavoured channels — type 0 (GUILD_TEXT) and 5 (GUILD_ANNOUNCEMENT)
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
// All endpoints expect a verified site session — the worker reads
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

// ── /web/pet/snapshot ────────────────────────────────────────────
//
// Returns current pet state + pending-delivery preview. The website's
// pet card uses this to show "deliveries waiting: N" and the
// next-delivery countdown.
async function routePetSnapshot(env, guildId, userId) {
  const { getPet, computeMood, pendingDeliveriesFor } = await import('./pet.js');
  const pet = await getPet(env, guildId, userId);
  if (!pet) return json({ ok: true, pet: null });
  const mood = computeMood(pet);
  const pending = pendingDeliveriesFor(pet);
  return json({
    ok: true,
    pet: {
      species: pet.species,
      colour: pet.colour,
      name: pet.name,
      adoptedUtc: pet.adoptedUtc,
      mood,
      lastDeliveryUtc: pet.lastDeliveryUtc || pet.adoptedUtc,
    },
    deliveries: {
      pending: pending.count,
      cap: 12,
      intervalMs: pending.intervalMs,
      nextInMs: pending.nextInMs,
      nextDeliveryUtc: Date.now() + (pending.nextInMs || 0),
    },
  });
}

// ── /web/pet/collect ─────────────────────────────────────────────
//
// Claims all pending deliveries and returns the breakdown + the
// fresh wallet snapshot. Empty result (claimed:0) is not an error —
// the website can poll snapshot for the next-delivery timer.
async function routePetCollect(env, guildId, userId) {
  const { claimPetDeliveries } = await import('./pet.js');
  const r = await claimPetDeliveries(env, guildId, userId);
  return json(r, r.ok ? 200 : 400);
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
// by claimTier — season records are per-user, not per-guild.
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
  //   — lookupUserId lets the site's /api/web/checkin/user-background
  //     endpoint resolve another user's saved card (just the bg
  //     picker — the card fields are non-sensitive: image URL,
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

// Boltbound per-user card art override. POST shape:
//   { op: 'get',   cardId }              → return current override (or null)
//   { op: 'set',   cardId, url }         → validate + save
//   { op: 'clear', cardId }              → drop the override
//   { op: 'list' }                       → list every override for this user
// Validation in cards-art-override.js — HTTPS only, host-allow-listed,
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

// 2026-05-30 — meme-skin card-art override feature REMOVED.
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

// ── Seasonal Spire — thin wrappers over spire.js helpers ──────────

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
// over banners.js + banner-wars.js — the heavy logic stays in the
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

async function routeCharacterComposite(env, guildId, userId) {
  const { loadHero, applyLookBackfill } = await import('./dungeon.js');
  const { buildCompositeManifest }       = await import('./character-composite.js');
  const { resolveHeroBackground }        = await import('./character-backgrounds.js');
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  const background = await resolveHeroBackground(env, userId, hero);
  return json({ ok: true, manifest: buildCompositeManifest(hero),
                background,
                hero: { className: hero.className, custom: hero.custom,
                        equipped: hero.equipped, lookVersion: hero.lookVersion || 0 } });
}

async function routeCharacterBackgrounds(env, userId) {
  const { listBackgroundsForUser } = await import('./character-backgrounds.js');
  return json(await listBackgroundsForUser(env, userId));
}

async function routePassState(env, userId) {
  const { getPassState } = await import('./aquilo-pass.js');
  return json(await getPassState(env, userId));
}
async function routePassClaim(env, guildId, userId, body) {
  const { claimPassTier } = await import('./aquilo-pass.js');
  const r = await claimPassTier(env, guildId, userId, body || {});
  return json(r, r.ok ? 200 : 400);
}
async function routeStreamBonusState(env) {
  const { isStreamLive, _consts } = await import('./stream-bonus.js');
  const live = await isStreamLive(env);
  return json({ ok: true, live, multipliers: _consts });
}

async function routeSkillsSnapshot(env, guildId, userId) {
  const { getSkillsSnapshot } = await import('./hero-skills.js');
  return json(await getSkillsSnapshot(env, guildId, userId));
}
async function routeSkillsAllocate(env, guildId, userId, body) {
  const { allocateSkillPoint } = await import('./hero-skills.js');
  const r = await allocateSkillPoint(env, guildId, userId, body || {});
  return json(r, r.ok ? 200 : 400);
}
async function routeSkillsRespec(env, guildId, userId) {
  const { respecSkillTree } = await import('./hero-skills.js');
  const r = await respecSkillTree(env, guildId, userId);
  return json(r, r.ok ? 200 : 400);
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

// /web/cards/suggest-art-terms — DEPRECATED 2026-05-30 alongside the
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
// Patreon session — aquilo-site's bridge ([[route]].js → postToBot)
// requires a valid aq_link cookie, which is issued ONLY by the
// Patreon OAuth callback. So if the bot receives the request with
// a valid HMAC + a real discordId, that user has linked Patreon
// (regardless of whether their Patreon profile had an avatar, or
// whether any of the older worker-side signals — `patreon:tier:<u>`
// presence, `wallet.links` patreon entry — were ever written).
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
// `chat/relay/recent` instead — the parallel aquilo-site session will
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
  // The flag-set is unconditional + idempotent — repeat calls just
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
