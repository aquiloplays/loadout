// Boltbound — /web/boltbound/* + /ext/boltbound/* route handlers.
//
// Authoritative game logic lives in cards-*.js. This module is the
// thin web glue: bootstrap one read for the page-load surface
// (`state`), then thin wrappers around each user action that the
// site / panel can call.
//
// Auth is enforced upstream by web.js (HMAC) and ext.js (JWT). Both
// dispatch into routeBoltbound() below with a `(env, guildId, userId,
// route, body)` signature; we don't re-check auth here.

import { CARDS, CHAMPIONS } from './cards-content.js';
import {
  getCollection, ensureCollection, addCardsToCollection,
  getActiveDeckId,
  listPendingPacks,
  getActiveMatch, readLog, getTrophies,
  hasClaimedFreePackToday,
  newId,
} from './cards-state.js';
import {
  saveDeck, dropDeck, activateDeck, listDeckSummaries, buildStarterDeck, buildPoolStarterDeck,
} from './cards-decks.js';
import {
  buyPack, openPack, claimDailyFreePack, creditPack,
} from './cards-packs.js';
import {
  proposeTrade, acceptTrade, declineTrade, cancelTrade,
  getTrade, listTrades, tradeableCollection,
} from './cards-trade.js';
import { sendDm } from './aquilo/util.js';
import {
  getFragments, recycleCard, craftPack,
  RECYCLE_YIELD, CRAFT_COST,
} from './cards-fragments.js';
import {
  startNpcMatch, queueOrMatchPvp, challengeUser, acceptChallenge,
  takeAction, takeMulligan, renderableState, sideOf,
} from './cards-match.js';
import { loadHero } from './hero-state.js';
import { getWallet } from './wallet.js';
import { getLoginStatus, claimDailyLogin } from './boltbound-login.js';
import { listTodaysQuests, claimQuest, rerollQuest, progressBoltbound } from './daily-quests.js';
import { getStats, recordPlay, recordMatchEnd, recordPackOpen, statForTrigger, triggerEvents } from './boltbound-stats.js';
import { listAchievements, getUserAchievements, checkAndUnlock } from './achievements-d1.js';
import { getRankedMe, getRankedLeaderboard } from './boltbound-ranked.js';
import { getArenaState, startArenaRun, pickArenaCard, playArenaMatch, retireArenaRun, getArenaHistory } from './boltbound-arena.js';
import {
  SETS, SET_IDS, isReleased, isNewlyReleased, timeUntilRelease,
} from './boltbound-sets.js';
import { getChannelBinding } from './channel-bindings.js';
import { postChannelMessage } from './aquilo/util.js';

const ROUTES = new Set([
  'boltbound/state',
  'boltbound/catalogue',
  // RET-2: Boltbound daily quests (today/claim/reroll).
  'boltbound/quests/today',
  'boltbound/quests/claim',
  'boltbound/quests/reroll',
  // RET-3: achievement gallery (catalog + per-viewer unlock/progress).
  'boltbound/achievements/list',
  'boltbound/achievements/me',
  // RET-4: ranked ladder (current rank + season + leaderboard).
  'boltbound/ranked/me',
  'boltbound/ranked/leaderboard',
  // RET-5: Arena draft mode (draft -> run -> escalating rewards).
  'boltbound/arena/state',
  'boltbound/arena/start',
  'boltbound/arena/pick',
  'boltbound/arena/match',
  'boltbound/arena/retire',
  'boltbound/arena/history',
  'boltbound/decks/save',
  'boltbound/decks/delete',
  'boltbound/decks/activate',
  'boltbound/decks/starter',
  'boltbound/starter-deck',
  'boltbound/packs/buy',
  'boltbound/packs/open',
  'boltbound/packs/free-daily',
  // CR-2: expansion-set gallery (released/upcoming + countdowns).
  'boltbound/sets',
  'boltbound/match/start-npc',
  'boltbound/match/queue',
  'boltbound/match/challenge',
  'boltbound/match/accept',
  'boltbound/match/state',
  'boltbound/match/action',
  'boltbound/match/mulligan',
  'boltbound/match/concede',
  'boltbound/log',
  // RET-1: grindy daily login rewards (streak-gated; no daily packs).
  'boltbound/login/status',
  'boltbound/login/claim',
  // Per-user client prefs that sync cross-device (arena backdrop choice
  // + shuffle). Stored on the player profile in KV.
  'boltbound/settings/get',
  'boltbound/settings/set',
  // CR-1: recycle/craft surface
  'boltbound/fragments',
  'boltbound/recycle',
  'boltbound/craft',
  // T-1: player-to-player card trading
  'boltbound/trade/propose',
  'boltbound/trade/list',
  'boltbound/trade/get',
  'boltbound/trade/accept',
  'boltbound/trade/decline',
  'boltbound/trade/cancel',
  'boltbound/trade/collection',
]);

// Read-only sub-routes the proxy may skip rate-limit for.
const READ_ROUTES = new Set([
  'boltbound/state',
  'boltbound/catalogue',
  'boltbound/quests/today',
  'boltbound/achievements/list',
  'boltbound/achievements/me',
  'boltbound/ranked/me',
  'boltbound/ranked/leaderboard',
  'boltbound/arena/state',
  'boltbound/arena/history',
  'boltbound/sets',
  'boltbound/match/state',
  'boltbound/log',
  'boltbound/login/status',
  'boltbound/settings/get',
  'boltbound/fragments',
  'boltbound/trade/list',
  'boltbound/trade/get',
  'boltbound/trade/collection',
]);

export function isBoltboundRoute(r) { return ROUTES.has(r); }
export function isBoltboundReadRoute(r) { return READ_ROUTES.has(r); }

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
function jsonCors(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
    },
  });
}

// ── Routes ──────────────────────────────────────────────────────────

// Page-load bootstrap. One round-trip: everything the deck-builder +
// match UI need to render without follow-ups.
async function routeState(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId).catch(() => null);
  const className = (hero && hero.className) || 'warrior';
  const champId = CHAMPIONS[className]?.id || CHAMPIONS.warrior.id;

  // Bootstrap a collection if first-time (mirrors what /boltbound status
  // does on Discord) so the website is the same kind of "I just opened
  // the game" experience.
  const { isNew, collection } = await ensureCollection(env, guildId, userId, className);
  let welcomePack = null;
  if (isNew) {
    // First-time on this guild: credit a welcome Common Pack
    // (same rule as cards.js renderStatus).
    welcomePack = await creditPack(env, guildId, userId, 'common', 'welcome-web');
  }

  const { listAllGlobalArt }     = await import('./cards-global-art.js');
  const { listAllPixelArtMaps }  = await import('./pixel-art-maps.js');

  // 2026-05-30 — per-user meme-skin override feature removed. The
  // bootstrap no longer reads cards-art-override or includes an
  // `artOverrides` map. globalArt + pixelArtMaps remain as the only
  // art-override layers. The cards-art-override.js module stays on
  // disk for historical reference; its read paths are dead code.
  const [deckSummaries, activeDeckId, pendingPacks, log, trophies, wallet, freeClaimed, fragments, globalArt, pixelArtMaps] = await Promise.all([
    listDeckSummaries(env, guildId, userId),
    getActiveDeckId(env, guildId, userId),
    listPendingPacks(env, guildId, userId, 30),
    readLog(env, guildId, userId),
    getTrophies(env, userId),
    getWallet(env, guildId, userId),
    hasClaimedFreePackToday(env, guildId, userId),
    getFragments(env, userId),
    listAllGlobalArt(env),
    // 2026-05-29 asset overhaul P3-P6 — four new globalArt sibling
    // maps (hero / gear / clash / pet). Cheap: 4 parallel KV list
    // calls, no per-key GETs (URLs are deterministic from key names).
    listAllPixelArtMaps(env),
  ]);

  const activeMatch = await getActiveMatch(env, guildId, userId);
  const matchView = activeMatch ? renderableState(activeMatch, userId) : null;

  return json({
    ok: true,
    champion: { id: champId, className },
    collection: {
      cards: collection.cards || {},
      total: Object.values(collection.cards || {}).reduce((a, b) => a + b, 0),
    },
    decks: deckSummaries,
    activeDeckId: activeDeckId || null,
    // Pending packs are stored as { id, packType, source, mintedUtc,
    // rolled } in KV (see cards-state.js mintPendingPack). The client
    // contract uses `packId` for the key, so map id -> packId here.
    pendingPacks: pendingPacks.map(p => ({
      packId: p.id,
      packType: p.packType,
      source: p.source,
      opened: !!(p.rolled && p.rolled.length),
      mintedUtc: p.mintedUtc,
    })),
    // creditPack() returns { ok, pack: rec }; pull packId + packType out
    // of the inner record, not the outer wrapper.
    welcomePack: welcomePack && welcomePack.pack
      ? { packId: welcomePack.pack.id, packType: welcomePack.pack.packType }
      : null,
    log: (log || []).slice(0, 10),
    trophies: trophies || { trophies: 0, peak: 0, season: 1 },
    wallet: { balance: wallet.balance || 0 },
    freePackClaimedToday: !!freeClaimed,
    // CR-1 — fragment balance + craft economy constants. Page can
    // render the "Craft Pack" CTA + balance chip without follow-up.
    fragments: {
      balance: fragments || 0,
      recycleYield: RECYCLE_YIELD,
      craftCost: CRAFT_COST,
    },
    // 2026-05-30 — `artOverrides` removed alongside the meme-skin
    // feature pull. Site renderer precedence is now just:
    //   gifUrl = globalArt[cardId] || baked
    // Global card-art defaults — backfilled via the Giphy auto-match.
    globalArt,
    // 2026-05-29 asset overhaul P3-P6 — pixel-art maps for hero,
    // gear, clash, and pet renderers. Same precedence pattern as
    // globalArt: site renderer checks the map first, falls back to
    // baked sprite on a miss. See pixel-art-maps.js for shape.
    ...pixelArtMaps,
    match: matchView,
  });
}

// Card catalogue — public read-only (no per-viewer state). Cached on
// the worker side via a long s-maxage so the page-load fetch is cheap.
async function routeCatalogue() {
  const cards = Object.fromEntries(
    Object.values(CARDS).map(c => [c.id, {
      id: c.id, name: c.name, rarity: c.rarity, type: c.type,
      mana: c.mana, atk: c.atk, hp: c.hp,
      keywords: c.keywords, text: c.text, token: c.token,
      needsTarget: c.needsTarget,
      spriteId: c.spriteId,
      // CR-2 expansion fields — drive set badges/filters + the flavour
      // line + the keyword tooltip layer on the site.
      set: c.set || 'core',
      tribe: c.tribe || null,
      flavor: c.flavor || '',
      overload: c.overload || 0,
      chooseOne: !!c.chooseOne,
    }]),
  );
  return new Response(JSON.stringify({ ok: true, version: 1, cards }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60, s-maxage=300',
    },
  });
}

// Expansion-set gallery — released + upcoming sets with live card counts,
// countdowns, theme/palette, and mechanics. Public read-only. Also the
// trigger point for the one-shot "new expansion" Discord announcement:
// when a player loads the gallery and a set is newly released but not yet
// announced, we fire it once (dedup'd in KV). It posts ONLY if a channel
// is actually bound — never to a guessed channel.
async function routeSets(env, guildId, userId) {
  const now = Date.now();
  // Live per-set pullable counts from the catalogue.
  const counts = {};
  for (const c of Object.values(CARDS)) {
    if (c.token) continue;
    const s = c.set || 'core';
    counts[s] = (counts[s] || 0) + 1;
  }
  const sets = SET_IDS.map(id => {
    const s = SETS[id];
    return {
      id,
      name: s.name,
      blurb: s.blurb,
      theme: s.theme,
      mechanics: s.mechanics,
      tribe: s.tribe || null,
      releaseUtc: s.releaseUtc,
      released: isReleased(id, now),
      newlyReleased: isNewlyReleased(id, now),
      msUntilRelease: timeUntilRelease(id, now),
      cardCount: counts[id] || 0,
      plannedCount: s.plannedCount,
      hidden: !!s.hidden,
    };
  });

  // Best-effort one-shot launch announcement for any newly-released set.
  for (const s of sets) {
    if (s.newlyReleased && s.id !== 'core') {
      announceExpansionReleaseOnce(env, guildId, s.id).catch(() => {});
    }
  }

  return new Response(JSON.stringify({ ok: true, now, sets }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60, s-maxage=120' },
  });
}

// Fire the "NEW: <set> is here" Discord post at most once per set. The
// KV flag dedups across every page load + every guild. Posts to the
// `game-updates` channel binding, falling back to the `play` hub; if
// neither is bound we mark it announced anyway so we don't keep trying.
async function announceExpansionReleaseOnce(env, guildId, setId) {
  const flagKey = `expansion-announced:${setId}`;
  try {
    if (await env.LOADOUT_BOLTS.get(flagKey)) return;
  } catch { return; }
  const s = SETS[setId];
  if (!s) return;
  // Reserve the flag up-front so concurrent loads don't double-post.
  try { await env.LOADOUT_BOLTS.put(flagKey, String(Date.now())); } catch { return; }

  let channelId = null;
  try {
    channelId = await getChannelBinding(env, guildId, 'game-updates')
             || await getChannelBinding(env, guildId, 'play');
  } catch { channelId = null; }
  if (!channelId || !env.DISCORD_BOT_TOKEN) return;   // nothing bound — stay quiet

  const embed = {
    title: `NEW: ${s.name} is here`,
    description: s.blurb,
    color: parseInt((s.theme?.primary || '#7c5cff').replace('#', ''), 16),
    fields: [
      { name: 'Cards', value: String(s.plannedCount || ''), inline: true },
      { name: 'Mechanics', value: (s.mechanics || []).join(', '), inline: true },
    ],
    footer: { text: 'Boltbound expansion' },
    url: 'https://aquilo.gg/play/boltbound/sets',
  };
  try {
    await postChannelMessage(env, channelId, {
      content: `A new Boltbound set just dropped. Open a **${s.name}** pack at https://aquilo.gg/play/boltbound/sets`,
      embeds: [embed],
    });
  } catch { /* non-fatal — the flag already prevents retries */ }
}

async function routeDecksSave(env, guildId, userId, body) {
  const deckId = String((body && body.deckId) || '').trim() || newId();
  const name   = String((body && body.name)   || 'Deck').slice(0, 32);
  const cards  = Array.isArray(body?.cards) ? body.cards.map(String) : [];
  const hero = await loadHero(env, guildId, userId).catch(() => null);
  const className = (hero && hero.className) || 'warrior';
  const r = await saveDeck(env, guildId, userId, { id: deckId, name, cards }, className);
  return json(r);
}
async function routeDecksDelete(env, guildId, userId, body) {
  const deckId = String((body && body.deckId) || '');
  if (!deckId) return json({ ok: false, error: 'bad-deck' }, 400);
  const r = await dropDeck(env, guildId, userId, deckId);
  return json(r);
}
async function routeDecksActivate(env, guildId, userId, body) {
  const deckId = String((body && body.deckId) || '');
  if (!deckId) return json({ ok: false, error: 'bad-deck' }, 400);
  const r = await activateDeck(env, guildId, userId, deckId);
  return json(r);
}
async function routeDecksStarter(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId).catch(() => null);
  const className = (hero && hero.className) || 'warrior';
  const col = await getCollection(env, guildId, userId);
  const deck = buildStarterDeck(col, className);
  const r = await saveDeck(env, guildId, userId, deck, className);
  if (r.ok) await activateDeck(env, guildId, userId, r.deck.id);
  return json(r);
}

// POST /web/boltbound/starter-deck — one-click "Get a starter deck" CTA
// for players with no deck. Idempotent: if the player already has any
// saved deck, returns it untouched. Otherwise grants a weak, balanced
// 20-card starter (champion + 19 cards, ~70/25/5 common/uncommon/rare,
// NO legendaries/epics) into the collection, saves it, and sets it
// ACTIVE. The deck is fully editable later via the normal deck builder.
const STARTER_CLASSES = ['warrior', 'mage', 'rogue', 'ranger', 'healer'];
async function routeStarterDeck(env, guildId, userId) {
  // Idempotent — already has a deck → return it, no changes.
  const existing = await listDeckSummaries(env, guildId, userId);
  if (existing && existing.length) {
    const activeId = await getActiveDeckId(env, guildId, userId);
    return json({ ok: true, existing: true, activeDeckId: activeId || existing[0].id, decks: existing });
  }
  // Equal-weighted champion class.
  const cls = STARTER_CLASSES[Math.floor(Math.random() * STARTER_CLASSES.length)];
  const { deck, grantIds } = buildPoolStarterDeck(cls);
  // Grant the 19 cards so saveDeck's ownership check passes (these are
  // the player's starter collection — editable/disenchantable later).
  await addCardsToCollection(env, guildId, userId, grantIds);
  const r = await saveDeck(env, guildId, userId, deck, cls);
  if (!r.ok) return json(r, 400);
  await activateDeck(env, guildId, userId, r.deck.id);
  return json({ ok: true, deck: r.deck, championClass: cls, granted: grantIds.length });
}

async function routePacksBuy(env, guildId, userId, body) {
  const packType = String((body && body.packType) || 'bolt');
  // CR-2: optional set selector. Default 'core' (legacy behaviour). An
  // unknown / unreleased set is rejected inside buyPack().
  const setId = SET_IDS.includes(String(body && body.set)) ? String(body.set) : 'core';
  const r = await buyPack(env, guildId, userId, packType, setId);
  return json(r);
}
async function routePacksOpen(env, guildId, userId, body) {
  const packId = String((body && body.packId) || '');
  if (!packId) return json({ ok: false, error: 'bad-pack' }, 400);
  const r = await openPack(env, guildId, userId, packId);
  // RET-3 — pack-open count drives the 'Pack Rat' achievement line.
  if (r && r.ok) {
    try {
      const stats = await recordPackOpen(env, userId, 1);
      await checkAndUnlock(env, userId, { type: 'boltbound-pack', count: stats.packsOpened });
    } catch { /* non-fatal */ }
  }
  return json(r);
}
async function routePacksFreeDaily(env, guildId, userId) {
  const r = await claimDailyFreePack(env, guildId, userId);
  return json(r);
}

async function routeMatchStartNpc(env, guildId, userId, body) {
  const archetype = String((body && body.archetype) || '');
  const r = await startNpcMatch(env, guildId, userId, archetype || null);
  if (r.ok) return json({ ok: true, match: renderableState(r.match, userId) });
  return json(r);
}
async function routeMatchQueue(env, guildId, userId) {
  const r = await queueOrMatchPvp(env, guildId, userId);
  if (r.ok && r.match) return json({ ok: true, match: renderableState(r.match, userId) });
  return json(r);
}
async function routeMatchChallenge(env, guildId, userId, body) {
  const recipientId = String((body && body.recipientId) || '');
  if (!/^\d{5,25}$/.test(recipientId)) return json({ ok: false, error: 'bad-recipient' }, 400);
  const r = await challengeUser(env, guildId, userId, recipientId);
  return json(r);
}
async function routeMatchAccept(env, guildId, userId, body) {
  const senderId = String((body && body.senderId) || '');
  if (!/^\d{5,25}$/.test(senderId)) return json({ ok: false, error: 'bad-sender' }, 400);
  const r = await acceptChallenge(env, guildId, userId, senderId);
  if (r.ok) return json({ ok: true, match: renderableState(r.match, userId) });
  return json(r);
}
async function routeMatchState(env, guildId, userId) {
  const m = await getActiveMatch(env, guildId, userId);
  if (!m) return json({ ok: true, match: null });
  return json({ ok: true, match: renderableState(m, userId) });
}
async function routeMatchAction(env, guildId, userId, body) {
  const m = await getActiveMatch(env, guildId, userId);
  if (!m) return json({ ok: false, error: 'no-active-match' });
  const side = sideOf(m, userId);
  if (!side) return json({ ok: false, error: 'not-in-match' });

  const kind = String((body && body.kind) || '');
  // The web client speaks a simplified vocabulary; translate into the
  // shape applyAction() expects in cards-battle.js.
  //   play     -> playCard { handIdx, targetUid }
  //   attack   -> attack   { attackerUid, defenderUid }
  // Targets are uid strings (board minion uid) or the sentinels
  // "hero" / "selfHero" (the resolver maps "hero" -> opp hero on a
  // play-card targeting context, and "hero" -> opp hero on an attack;
  // explicit "selfHero" is for self-target spells like Iron Skin).
  let action = null;
  let playedCardId = null;
  if (kind === 'play') {
    const handIdx = Number(body && body.handIndex);
    if (!Number.isInteger(handIdx) || handIdx < 0) return json({ ok: false, error: 'bad-hand-index' });
    const t = body && body.target;
    const targetUid = (t === null || t === undefined || t === '') ? null : String(t);
    action = { kind: 'playCard', handIdx, targetUid };
    playedCardId = (m.hands[side] && m.hands[side][handIdx]) || null;
    // CR-2 pick-one mechanics (Choose One / Adapt / Discover). Optional —
    // the resolver falls back to a seeded default when absent.
    if (Number.isInteger(+body.chooseOption))   action.chooseOption   = +body.chooseOption;
    if (Number.isInteger(+body.adaptChoice))    action.adaptChoice    = +body.adaptChoice;
    if (Number.isInteger(+body.discoverChoice)) action.discoverChoice = +body.discoverChoice;
  } else if (kind === 'attack') {
    const attackerUid = String((body && body.attackerUid) || '');
    if (!attackerUid) return json({ ok: false, error: 'bad-attacker' });
    const t = body && body.target;
    const defenderUid = (t === null || t === undefined || t === '') ? 'hero' : String(t);
    action = { kind: 'attack', attackerUid, defenderUid };
  } else if (kind === 'endTurn') {
    action = { kind: 'endTurn' };
  } else if (kind === 'concede') {
    action = { kind: 'concede' };
  } else {
    return json({ ok: false, error: 'bad-kind' });
  }
  const r = await takeAction(env, m, side, action);
  // RET-2 — Boltbound daily-quest progress for web matches. Best-effort;
  // a tracking failure must never block the action response.
  try {
    if (r.ok && kind === 'play' && playedCardId) {
      const c = CARDS[playedCardId];
      await progressBoltbound(env, userId, 'cards', 1);
      if (c && c.type === 'spell') await progressBoltbound(env, userId, 'cast', 1);
      else if (c && c.type === 'minion') await progressBoltbound(env, userId, 'summon', 1);
      if (c) await recordPlay(env, userId, c.type);
    }
    if (r.ok && r.ended && r.match) {
      await progressBoltbound(env, userId, 'play', 1);
      const won = r.match.status === (side === 'A' ? 'A-won' : 'B-won');
      if (won) await progressBoltbound(env, userId, 'win', 1);
      // RET-3 — lifetime stats + achievement unlocks.
      const hero = await loadHero(env, guildId, userId).catch(() => null);
      const stats = await recordMatchEnd(env, userId, won, hero && hero.className);
      for (const ev of triggerEvents(stats)) await checkAndUnlock(env, userId, ev);
    }
  } catch { /* non-fatal */ }
  return json({ ok: !!r.ok, error: r.error || null, match: r.match ? renderableState(r.match, userId) : null, ended: !!r.ended });
}
async function routeMatchMulligan(env, guildId, userId, body) {
  const m = await getActiveMatch(env, guildId, userId);
  if (!m) return json({ ok: false, error: 'no-active-match' });
  const side = sideOf(m, userId);
  if (!side) return json({ ok: false, error: 'not-in-match' });
  const keep = Array.isArray(body?.keep) ? body.keep.map(Number).filter(n => Number.isInteger(n) && n >= 0) : [];
  // The handIndices param to takeMulligan is "indices to redraw" — caller
  // passes "keep"; we invert to "redraw everything not in keep".
  const handSize = m.hands[side].length;
  const redraw = [];
  for (let i = 0; i < handSize; i++) if (!keep.includes(i)) redraw.push(i);
  const r = await takeMulligan(env, m, side, redraw);
  return json({ ok: !!r.ok, match: r.match ? renderableState(r.match, userId) : null });
}
async function routeMatchConcede(env, guildId, userId) {
  const m = await getActiveMatch(env, guildId, userId);
  if (!m) return json({ ok: false, error: 'no-active-match' });
  const side = sideOf(m, userId);
  if (!side) return json({ ok: false, error: 'not-in-match' });
  const r = await takeAction(env, m, side, { kind: 'concede' });
  return json({ ok: !!r.ok, match: r.match ? renderableState(r.match, userId) : null, ended: true });
}
async function routeLog(env, guildId, userId) {
  const log = await readLog(env, guildId, userId);
  return json({ ok: true, log: (log || []).slice(0, 25) });
}

// ── Boltbound client prefs (arena backdrop) ─────────────────────────
//
// Stored on the per-user profile in KV under a `boltbound` sub-object so
// the chosen arena + shuffle flag follow the player across devices. The
// client treats localStorage as the fast local source of truth and uses
// these endpoints purely to hydrate/persist cross-device — so a missing
// value or a never-deployed worker degrades to "local only", never an
// error path the UI surfaces.

async function readProfile(env, userId) {
  try {
    return (await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' })) || {};
  } catch {
    return {};
  }
}

async function routeSettingsGet(env, userId) {
  const prof = await readProfile(env, userId);
  const bb = (prof && prof.boltbound) || {};
  return json({
    ok: true,
    settings: {
      preferredArena: typeof bb.preferredArena === 'string' ? bb.preferredArena : null,
      arenaShuffle: typeof bb.arenaShuffle === 'boolean' ? bb.arenaShuffle : null,
    },
  });
}

async function routeSettingsSet(env, userId, body) {
  const prof = await readProfile(env, userId);
  const next = { ...prof, boltbound: { ...(prof.boltbound || {}) } };
  if (typeof body?.preferredArena === 'string') {
    next.boltbound.preferredArena = body.preferredArena.slice(0, 48);
  }
  if (typeof body?.arenaShuffle === 'boolean') {
    next.boltbound.arenaShuffle = body.arenaShuffle;
  }
  try {
    await env.LOADOUT_BOLTS.put(`pprofile:${userId}`, JSON.stringify(next));
  } catch (e) {
    return json({ ok: false, error: 'persist', message: String((e && e.message) || e) }, 500);
  }
  return json({ ok: true, settings: next.boltbound });
}

// ── CR-1: recycle/craft routes ──────────────────────────────────────
//
// `boltbound/fragments` (read-only) → balance + economy constants.
// `boltbound/recycle` (POST) → recycle owned cards into frags.
// `boltbound/craft`   (POST) → spend frags to mint a pack.

async function routeFragments(env, guildId, userId) {
  const frags = await getFragments(env, userId);
  return json({
    ok: true,
    fragments: frags,
    recycleYield: RECYCLE_YIELD,
    craftCost: CRAFT_COST,
  });
}

async function routeRecycle(env, guildId, userId, body) {
  const cardId = String((body && body.cardId) || '').trim();
  const count = Math.max(1, parseInt(body?.count || '1', 10) || 1);
  if (!cardId) return json({ ok: false, error: 'bad-cardId' }, 400);
  const r = await recycleCard(env, guildId, userId, cardId, count);
  return json(r);
}

async function routeCraft(env, guildId, userId, body) {
  const packType = String((body && body.packType) || '').trim();
  if (!packType) return json({ ok: false, error: 'bad-packType' }, 400);
  const r = await craftPack(env, guildId, userId, packType);
  return json(r);
}

// ── RET-1: daily login reward routes ────────────────────────────────
//
// `boltbound/login/status` (read) → current streak + next-milestone
// preview + whether today is claimable.
// `boltbound/login/claim`  (write) → bank the streak + grant the
// (grindy) daily reward; packs only at 30/90/365-day milestones.

async function routeLoginStatus(env, guildId, userId) {
  const status = await getLoginStatus(env, userId);
  return json(status);
}
async function routeLoginClaim(env, guildId, userId) {
  const r = await claimDailyLogin(env, guildId, userId);
  return json(r, r.ok || r.alreadyClaimed ? 200 : 400);
}

// ── RET-2: Boltbound daily quests ───────────────────────────────────
//
// Thin wrappers over the shared daily-quests engine, scoped to
// game='boltbound'. `today` maps the worker quest shape onto the
// site's QuestDef contract; `claim` grants the reward; `reroll`
// swaps one quest (1/day).

function mapQuest(entry) {
  const d = entry.def || {};
  const reward = d.reward || {};
  const bits = [];
  if (reward.bolts) bits.push(`${reward.bolts} Bolts`);
  if (reward.aether) bits.push(`${reward.aether} Aether`);
  if (reward.xp) bits.push(`${reward.xp} XP`);
  return {
    id: d.id,
    title: d.title || d.id,
    description: d.description || '',
    progress: entry.progress || 0,
    goal: d.threshold || 1,
    rewardBolts: reward.bolts || 0,
    rewardLabel: bits.join(' + ') || null,
    claimed: !!entry.claimed,
  };
}
function nextUtcMidnight() {
  const now = Date.now();
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}
async function routeQuestsToday(env, guildId, userId) {
  const entries = await listTodaysQuests(env, userId, 'boltbound');
  return json({ ok: true, quests: entries.map(mapQuest), resetUtc: nextUtcMidnight() });
}
async function routeQuestsClaim(env, guildId, userId, body) {
  const questId = String((body && body.questId) || '').trim();
  if (!questId) return json({ ok: false, error: 'bad-quest-id' }, 400);
  const r = await claimQuest(env, userId, questId, { guildId });
  if (!r.ok) return json({ ok: false, error: r.reason || 'claim-failed' }, 400);
  const wallet = await getWallet(env, guildId, userId);
  return json({ ok: true, granted: r.granted || null, wallet: { balance: wallet.balance || 0 } });
}
async function routeQuestsReroll(env, guildId, userId, body) {
  const questId = body && body.questId ? String(body.questId).trim() : null;
  const r = await rerollQuest(env, userId, 'boltbound', questId);
  if (!r.ok) return json({ ok: false, error: r.reason || 'reroll-failed' }, 400);
  return json({ ok: true, oldId: r.oldId, newId: r.newId, quests: (r.quests || []).map(mapQuest) });
}

// ── RET-3: achievements ─────────────────────────────────────────────
//
// `list` is the Boltbound catalog (every def whose trigger starts with
// 'boltbound'); `me` joins that catalog with the viewer's unlocks +
// live progress (from boltbound-stats) so the gallery renders locked /
// unlocked / progress-bar states in one round-trip.

function isBbAchievement(a) {
  return a && a.trigger && typeof a.trigger.type === 'string' && a.trigger.type.startsWith('boltbound');
}
async function routeAchievementsList(env, guildId, userId) {
  const all = await listAchievements(env);
  return json({ ok: true, achievements: all.filter(isBbAchievement) });
}
async function routeAchievementsMe(env, guildId, userId) {
  const [all, mine, stats] = await Promise.all([
    listAchievements(env),
    getUserAchievements(env, userId),
    getStats(env, userId),
  ]);
  const unlockedAt = new Map(mine.map(a => [a.id, a.unlockedAt]));
  const achievements = all.filter(isBbAchievement).map(a => {
    const goal = a.trigger.threshold || 1;
    const current = statForTrigger(a.trigger.type, stats);
    return {
      id: a.id, name: a.name, description: a.description, icon: a.icon,
      tier: a.tier, points: a.points, goal,
      progress: current == null ? null : Math.min(current, goal),
      trackable: current != null,
      unlocked: unlockedAt.has(a.id),
      unlockedAt: unlockedAt.get(a.id) || null,
    };
  });
  const earned = achievements.filter(a => a.unlocked).reduce((s, a) => s + (a.points || 0), 0);
  const total = achievements.reduce((s, a) => s + (a.points || 0), 0);
  return json({ ok: true, achievements, points: { earned, total } });
}

// ── RET-4: ranked ladder ────────────────────────────────────────────
//
// Reads only — the ladder mutates server-side on PvP match finalise
// (cards-match.js → applyRankedResult). `me` returns current rank +
// season countdown; `leaderboard` is the season's top 100.

async function routeRankedMe(env, guildId, userId) {
  return json(await getRankedMe(env, userId));
}
async function routeRankedLeaderboard(env, guildId, userId) {
  return json(await getRankedLeaderboard(env, 100));
}

// ── RET-5: Arena draft mode ─────────────────────────────────────────
//
// state/history are reads; start/pick/match/retire are writes. Entry
// costs 1000 Bolts or 1 Arena ticket; the draft + run + rewards loop
// lives in boltbound-arena.js.

async function routeArenaState(env, guildId, userId) {
  return json(await getArenaState(env, guildId, userId));
}
async function routeArenaStart(env, guildId, userId, body) {
  return json(await startArenaRun(env, guildId, userId, !!(body && body.useTicket)));
}
async function routeArenaPick(env, guildId, userId, body) {
  const cardId = String((body && body.cardId) || '').trim();
  if (!cardId) return json({ ok: false, error: 'bad-card' }, 400);
  return json(await pickArenaCard(env, guildId, userId, cardId));
}
async function routeArenaMatch(env, guildId, userId) {
  return json(await playArenaMatch(env, guildId, userId));
}
async function routeArenaRetire(env, guildId, userId) {
  return json(await retireArenaRun(env, guildId, userId));
}
async function routeArenaHistory(env, guildId, userId) {
  return json(await getArenaHistory(env, userId, 10));
}

// ── Trade routes ───────────────────────────────────────────────────
//
// Auth is already enforced upstream by web.js (HMAC) — `userId` here
// is the signed-in viewer, used as the actor for every trade action.
// The HTTP-level `discordId` becomes the proposer (propose), the
// acceptor/decliner (accept/decline), or the canceller (cancel).

async function routeTradePropose(env, guildId, userId, body) {
  const toUserId = String((body && body.toUserId) || '').trim();
  const result = await proposeTrade(env, {
    guildId,
    fromUserId: userId,
    toUserId,
    fromCards: body?.fromCards || [],
    toCards:   body?.toCards   || [],
    fromBolts: body?.fromBolts || 0,
    toBolts:   body?.toBolts   || 0,
    note:      body?.note || '',
  });
  if (!result.ok) return json(result, 400);

  // Fire-and-forget DM to the recipient. Respects per-user push prefs
  // via the same path /push/dm uses (pprofile.pushPrefs.discordDm +
  // pprofile.pushPrefs.kinds['boltbound-trade-offer']).
  notifyRecipient(env, result.trade).catch((e) =>
    console.warn('[trade] notify failed', e && e.message)
  );

  return json({ ok: true, trade: result.trade });
}

async function routeTradeList(env, guildId, userId, body) {
  const direction = (body && body.direction) || 'both';
  if (!['incoming', 'outgoing', 'both'].includes(direction)) {
    return json({ ok: false, error: 'bad-direction' }, 400);
  }
  const trades = await listTrades(env, guildId, userId, direction);
  return json({ ok: true, trades });
}

async function routeTradeGet(env, guildId, userId, body) {
  const tradeId = String((body && body.tradeId) || '').trim();
  if (!tradeId) return json({ ok: false, error: 'bad-trade-id' }, 400);
  const trade = await getTrade(env, guildId, tradeId);
  if (!trade) return json({ ok: false, error: 'not-found' }, 404);
  // Only allow the proposer or the recipient to view the trade. This
  // hides offer contents from third parties.
  if (String(trade.fromUserId) !== String(userId) &&
      String(trade.toUserId)   !== String(userId)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  return json({ ok: true, trade });
}

async function routeTradeAccept(env, guildId, userId, body) {
  const tradeId = String((body && body.tradeId) || '').trim();
  if (!tradeId) return json({ ok: false, error: 'bad-trade-id' }, 400);
  const result = await acceptTrade(env, guildId, tradeId, userId);
  if (!result.ok) return json(result, 400);
  return json(result);
}

async function routeTradeDecline(env, guildId, userId, body) {
  const tradeId = String((body && body.tradeId) || '').trim();
  if (!tradeId) return json({ ok: false, error: 'bad-trade-id' }, 400);
  const result = await declineTrade(env, guildId, tradeId, userId);
  if (!result.ok) return json(result, 400);
  return json(result);
}

async function routeTradeCancel(env, guildId, userId, body) {
  const tradeId = String((body && body.tradeId) || '').trim();
  if (!tradeId) return json({ ok: false, error: 'bad-trade-id' }, 400);
  const result = await cancelTrade(env, guildId, tradeId, userId);
  if (!result.ok) return json(result, 400);
  return json(result);
}

async function routeTradeCollection(env, guildId, userId, body) {
  const ownerId = String((body && body.ownerId) || '').trim();
  if (!/^\d{5,25}$/.test(ownerId)) return json({ ok: false, error: 'bad-owner-id' }, 400);
  const view = await tradeableCollection(env, guildId, ownerId);
  return json({ ok: true, viewerId: userId, ...view });
}

// Send a Discord DM to the trade recipient. Mirrors the format used
// elsewhere (LFG / friend requests). Respects per-user push prefs
// the same way /push/dm does — if the recipient opted out of DMs
// or specifically opted out of kind='boltbound-trade-offer', the
// notification is silently skipped.
async function notifyRecipient(env, trade) {
  if (!env.DISCORD_BOT_TOKEN) return;
  // Re-check prefs inline (no helper export exists; same shape as push-dm.js).
  let prefs = { discordDm: true, web: true, kinds: {} };
  try {
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${trade.toUserId}`, { type: 'json' });
    if (p?.pushPrefs) prefs = { ...prefs, ...p.pushPrefs };
  } catch { /* fall through to defaults */ }
  if (prefs.discordDm === false) return;
  if (prefs.kinds && prefs.kinds['boltbound-trade-offer'] === false) return;

  const fromName = `<@${trade.fromUserId}>`;
  const summary = describeTradeOffer(trade);
  const url = `https://aquilo.gg/play/boltbound/trade/${encodeURIComponent(trade.tradeId)}`;
  const content = `**${fromName} sent you a Boltbound trade offer**\n${summary}\n${url}`;
  await sendDm(env, trade.toUserId, { content: content.slice(0, 1900) });
}

function describeTradeOffer(trade) {
  const offer = describeSide(trade.fromCards, trade.fromBolts);
  const want  = describeSide(trade.toCards,   trade.toBolts);
  let s = `Offers: ${offer}\nWants: ${want}`;
  if (trade.note) s += `\nNote: ${trade.note}`;
  return s;
}
function describeSide(cardIds, bolts) {
  const parts = [];
  if (cardIds && cardIds.length) {
    const tally = {};
    for (const cid of cardIds) tally[cid] = (tally[cid] || 0) + 1;
    for (const [cid, n] of Object.entries(tally)) {
      const card = CARDS[cid];
      const name = card?.name || cid;
      parts.push(n > 1 ? `${n}× ${name}` : name);
    }
  }
  if (bolts > 0) parts.push(`${bolts} bolts`);
  if (parts.length === 0) parts.push('nothing');
  return parts.join(', ');
}

// ── Public dispatch ────────────────────────────────────────────────

export async function routeBoltbound(env, guildId, userId, route, body, opts) {
  const cors = !!(opts && opts.cors);
  const wrap = cors ? jsonCors : json;
  try {
    if (route === 'boltbound/state')           return await routeState(env, guildId, userId);
    if (route === 'boltbound/catalogue')       return await routeCatalogue();
    if (route === 'boltbound/decks/save')      return await routeDecksSave(env, guildId, userId, body);
    if (route === 'boltbound/decks/delete')    return await routeDecksDelete(env, guildId, userId, body);
    if (route === 'boltbound/decks/activate')  return await routeDecksActivate(env, guildId, userId, body);
    if (route === 'boltbound/decks/starter')   return await routeDecksStarter(env, guildId, userId);
    if (route === 'boltbound/starter-deck')    return await routeStarterDeck(env, guildId, userId);
    if (route === 'boltbound/packs/buy')       return await routePacksBuy(env, guildId, userId, body);
    if (route === 'boltbound/packs/open')      return await routePacksOpen(env, guildId, userId, body);
    if (route === 'boltbound/packs/free-daily') return await routePacksFreeDaily(env, guildId, userId);
    if (route === 'boltbound/sets')            return await routeSets(env, guildId, userId);
    if (route === 'boltbound/match/start-npc') return await routeMatchStartNpc(env, guildId, userId, body);
    if (route === 'boltbound/match/queue')     return await routeMatchQueue(env, guildId, userId);
    if (route === 'boltbound/match/challenge') return await routeMatchChallenge(env, guildId, userId, body);
    if (route === 'boltbound/match/accept')    return await routeMatchAccept(env, guildId, userId, body);
    if (route === 'boltbound/match/state')     return await routeMatchState(env, guildId, userId);
    if (route === 'boltbound/match/action')    return await routeMatchAction(env, guildId, userId, body);
    if (route === 'boltbound/match/mulligan')  return await routeMatchMulligan(env, guildId, userId, body);
    if (route === 'boltbound/match/concede')   return await routeMatchConcede(env, guildId, userId);
    if (route === 'boltbound/log')             return await routeLog(env, guildId, userId);
    if (route === 'boltbound/login/status')    return await routeLoginStatus(env, guildId, userId);
    if (route === 'boltbound/login/claim')     return await routeLoginClaim(env, guildId, userId);
    if (route === 'boltbound/quests/today')    return await routeQuestsToday(env, guildId, userId);
    if (route === 'boltbound/quests/claim')    return await routeQuestsClaim(env, guildId, userId, body);
    if (route === 'boltbound/quests/reroll')   return await routeQuestsReroll(env, guildId, userId, body);
    if (route === 'boltbound/achievements/list') return await routeAchievementsList(env, guildId, userId);
    if (route === 'boltbound/achievements/me')   return await routeAchievementsMe(env, guildId, userId);
    if (route === 'boltbound/ranked/me')         return await routeRankedMe(env, guildId, userId);
    if (route === 'boltbound/ranked/leaderboard') return await routeRankedLeaderboard(env, guildId, userId);
    if (route === 'boltbound/arena/state')       return await routeArenaState(env, guildId, userId);
    if (route === 'boltbound/arena/start')       return await routeArenaStart(env, guildId, userId, body);
    if (route === 'boltbound/arena/pick')        return await routeArenaPick(env, guildId, userId, body);
    if (route === 'boltbound/arena/match')       return await routeArenaMatch(env, guildId, userId);
    if (route === 'boltbound/arena/retire')      return await routeArenaRetire(env, guildId, userId);
    if (route === 'boltbound/arena/history')     return await routeArenaHistory(env, guildId, userId);
    if (route === 'boltbound/settings/get')    return await routeSettingsGet(env, userId);
    if (route === 'boltbound/settings/set')    return await routeSettingsSet(env, userId, body);
    if (route === 'boltbound/fragments')       return await routeFragments(env, guildId, userId);
    if (route === 'boltbound/recycle')         return await routeRecycle(env, guildId, userId, body);
    if (route === 'boltbound/craft')           return await routeCraft(env, guildId, userId, body);
    if (route === 'boltbound/trade/propose')    return await routeTradePropose(env, guildId, userId, body);
    if (route === 'boltbound/trade/list')       return await routeTradeList(env, guildId, userId, body);
    if (route === 'boltbound/trade/get')        return await routeTradeGet(env, guildId, userId, body);
    if (route === 'boltbound/trade/accept')     return await routeTradeAccept(env, guildId, userId, body);
    if (route === 'boltbound/trade/decline')    return await routeTradeDecline(env, guildId, userId, body);
    if (route === 'boltbound/trade/cancel')     return await routeTradeCancel(env, guildId, userId, body);
    if (route === 'boltbound/trade/collection') return await routeTradeCollection(env, guildId, userId, body);
    return wrap({ error: 'not-found' }, 404);
  } catch (e) {
    return wrap({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
}
