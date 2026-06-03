// Progression, XP grant table.
//
// PROGRESSION-SYSTEM-DESIGN.md §4.2, the single source of truth for
// "how much XP does <event kind> grant?". Hot-swappable from KV
// (pxp:table singleton) so we can re-tune without a deploy; this
// module is the embedded fallback when the KV record isn't loaded yet.
//
// Daily cap mechanics:
//   - dailyCap          a per-event cap (e.g. discord.message capped at 25/day)
//   - global soft cap   500 XP/day across all sources; beyond that, grants accrue at 1/3 rate (see xp.js)
//
// Calibration target (§4.2): ~150-300 XP/day for an active viewer,
// ~50/day for a check-in-only viewer.

// Each entry: { xp, dailyCap?, perKindCap?, notes? }
// - dailyCap is the max XP from THIS kind in one UTC day for a user.
// - perKindCap is an alternate cap counting the number of events (used for
//   "max N grants of size xp"); if both are set, the lower binding wins.
export const XP_TABLE = {
  // ── Stream + community ──────────────────────────────────────────
  'stream.checkin':       { xp: 25, dailyCap: 25,  notes: 'once per stream check-in' },
  'stream.watched.15m':   { xp:  5, dailyCap: 20,  notes: '4×/day cap = 60min counted' },
  'stream.watched.1h':    { xp: 15, dailyCap: 15,  notes: 'awarded on top of the 4× quarter-hour grants' },
  'discord.message':      { xp:  2, dailyCap: 50,  notes: 'cap = 25 unique messages/day' },
  'community.vote':       { xp:  5, dailyCap: 25 },

  // ── Daily ─────────────────────────────────────────────────────────
  'daily.claimed':        { xp: 20, dailyCap: 20 },
  'daily.streak.7':       { xp: 50,                notes: 'awarded once per crossing' },
  'daily.streak.30':      { xp: 200 },
  'daily.streak.100':     { xp: 1000 },

  // ── Loadout (hero / shop / dungeon / duel / minigame) ────────────
  'loadout.actioned':     { xp:  1, dailyCap: 10,  notes: 'equip/sell/shop interactions' },
  'dungeon.cleared':      { xp: 30 },
  'duel.won':             { xp: 15 },
  'minigame.played':      { xp:  4, dailyCap: 24,  notes: 'cap = 6 plays' },
  'hero.levelup':         { xp: 25 },

  // ── Clash ────────────────────────────────────────────────────────
  'clash.raid.played':    { xp:  8,                notes: 'floor, fired even on 0★ losses' },
  'clash.raid.won.1':     { xp: 12 },
  'clash.raid.won.2':     { xp: 25 },
  'clash.raid.won.3':     { xp: 50 },
  'clash.defended.goblin':{ xp: 15 },
  'clash.defended.pvp':   { xp: 30 },
  'clash.donated':        { xp:  1, dailyCap: 50,  notes: '1 XP per 100 bolts donated, cap 50/day' },

  // ── Boltbound ────────────────────────────────────────────────────
  'cards.match.played':   { xp: 10,                notes: 'floor, fired on every match start' },
  'cards.match.won.npc':  { xp: 15 },
  'cards.match.won.pvp':  { xp: 30 },
  'cards.pack.opened':    { xp:  5 },
  'cards.crafted':        { xp: 20 },

  // ── Board games ──────────────────────────────────────────────────
  'board.match.played':   { xp: 12 },
  'board.match.won':      { xp: 25 },

  // ── Quick games ──────────────────────────────────────────────────
  'quick.game.played':    { xp:  4, dailyCap: 32,  notes: 'cap = 8 plays across all quick games' },
  'quick.game.bigwin':    { xp: 15,                notes: 'payout > 5× stake' },

  // ── Stocks + betting ─────────────────────────────────────────────
  'stocks.trade':         { xp:  3, dailyCap: 15 },
  'bet.placed':           { xp:  2, dailyCap: 20 },
  'bet.won':              { xp:  8 },
  'bet.won.parlay':       { xp: 25 },

  // ── Pets ─────────────────────────────────────────────────────────
  'pet.tamed':            { xp: 40,                notes: 'once per pet species' },
  'pet.fed':              { xp:  3, dailyCap: 3 },

  // ── Achievements (variable XP, see catalog entry's xpReward) ────
  'achievement.unlocked': { xp: 50,                notes: 'default; overridden by catalog entry' },

  // ── Tournament ────────────────────────────────────────────────────
  'tourn.entered':        { xp: 25 },
  'tourn.round.won':      { xp: 50 },
  'tourn.victory':        { xp: 500, exemptDailyCap: true },
  'tourn.runnerup':       { xp: 250, exemptDailyCap: true },
};

// Hot-swap loader. Reads pxp:table singleton, falls back to the embedded
// table. Cached for 1 hour so the cron can refresh without per-request KV.
const TABLE_TTL_MS = 60 * 60 * 1000;
let _tableCache = null;
let _tableCachedAtUtc = 0;

export async function loadXpTable(env, nowUtc = Date.now()) {
  if (_tableCache && (nowUtc - _tableCachedAtUtc) < TABLE_TTL_MS) {
    return _tableCache;
  }
  let kv = null;
  try {
    kv = await env.LOADOUT_BOLTS.get('pxp:table', { type: 'json' });
  } catch { /* ignore, fall through to embedded */ }
  _tableCache = { ...XP_TABLE, ...(kv || {}) };
  _tableCachedAtUtc = nowUtc;
  return _tableCache;
}

// For tests + cron, bust the cache.
export function _resetXpTableCache() { _tableCache = null; _tableCachedAtUtc = 0; }

// Convenience.
export function xpForKind(kind, table = XP_TABLE) {
  return table[kind]?.xp || 0;
}
export function dailyCapForKind(kind, table = XP_TABLE) {
  return table[kind]?.dailyCap || 0;
}
