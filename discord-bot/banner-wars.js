// Banner Wars — weekly bracketed PvP between Banners.
//
// 2026-05-29 MVP. The site-side war UI is scaffolded with greyed-out
// buttons; this module emits the data model + endpoint surface so
// the scaffold can light up with shape-correct responses. The actual
// bracket-engine (seeding, advancing, scoring) is a follow-up — for
// MVP, war state is "no active war" by default + a declare flow that
// records a 1-on-1 challenge.
//
// KV layout:
//   war:week:<weekId>              -> War JSON     (active or finished)
//   war:active-week:<guildId>      -> string weekId of currently active war
//   war:raid:<weekId>:<raidId>     -> Raid JSON    (per-raid history)
//
// War shape:
//   { weekId, guildId, state: 'open'|'live'|'closed',
//     declarations: [{ attacker:bannerId, defender:bannerId, declaredUtc }],
//     bracket: [[bannerId, bannerId], ...],  // pairings once seeded
//     scores: { [bannerId]: starPoints },
//     opensUtc, closesUtc }
//
// State machine (MVP):
//   open  — banners declare interest, no actual raids yet
//   live  — bracket seeded, raids count toward score
//   closed — week ended, winners archived

import { _internal as B } from './banners.js';

const WEEK_OPEN_MS = 24 * 3600_000;        // 1 day to declare interest
const WEEK_LIVE_MS = 6 * 24 * 3600_000;    // 6 days of live raiding

function nowIso() { return new Date().toISOString(); }
function nowMs()  { return Date.now(); }

// ISO YYYY-Www format for stable weekId.
function currentWeekId() {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;        // Mon=0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  // Week-of-year via Thursday: ISO week starts on Mon, ISO year on the
  // year whose Thursday falls in this week.
  const target = new Date(monday);
  target.setUTCDate(target.getUTCDate() + 3);
  const year = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const weekNo = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${year}-W${String(weekNo).padStart(2, '0')}`;
}

const KEY = {
  week:       (w)    => `war:week:${w}`,
  active:     (g)    => `war:active-week:${g}`,
  raid:       (w, r) => `war:raid:${w}:${r}`,
};

async function readWar(env, weekId) {
  if (!weekId) return null;
  return await env.LOADOUT_BOLTS.get(KEY.week(weekId), { type: 'json' });
}

async function writeWar(env, war) {
  await env.LOADOUT_BOLTS.put(KEY.week(war.weekId), JSON.stringify(war));
}

// ── Public surface ──────────────────────────────────────────────

// Returns the current war state for the caller's guild + banner. Site
// uses this to drive the "Declare War" / "Live Raids" / "Results" CTA.
export async function getActiveWar(env, guildId, userId) {
  const weekId = await env.LOADOUT_BOLTS.get(KEY.active(guildId)) || currentWeekId();
  const war = await readWar(env, weekId);
  const myMember = await B.readMember(env, guildId, userId);
  const myBanner = myMember?.bannerId
    ? await B.readBanner(env, guildId, myMember.bannerId)
    : null;
  return {
    ok: true,
    weekId,
    war: war || { weekId, state: 'open', declarations: [], bracket: [],
                  scores: {}, opensUtc: null, closesUtc: null },
    me: { banner: myBanner ? { id: myBanner.id, name: myBanner.name, tag: myBanner.tag } : null },
  };
}

// Owner-only. Declare interest in this week's war. If no war record
// exists for this week yet, mint one + flag this guild's active week.
export async function declareWar(env, guildId, userId, opts = {}) {
  const targetBannerId = String(opts.targetBannerId || '').trim();
  const myMember = await B.readMember(env, guildId, userId);
  if (!myMember?.bannerId) {
    return { ok: false, error: 'not-in-banner', message: 'You must be in a banner to declare war.' };
  }
  const myBanner = await B.readBanner(env, guildId, myMember.bannerId);
  if (!myBanner || myBanner.ownerId !== userId) {
    return { ok: false, error: 'forbidden', message: 'Only the banner owner can declare war.' };
  }
  if (targetBannerId && targetBannerId === myMember.bannerId) {
    return { ok: false, error: 'cant-target-self' };
  }

  const weekId = currentWeekId();
  let war = await readWar(env, weekId);
  if (!war) {
    war = {
      weekId, guildId,
      state: 'open',
      declarations: [],
      bracket: [],
      scores: {},
      opensUtc: nowIso(),
      closesUtc: new Date(nowMs() + WEEK_OPEN_MS + WEEK_LIVE_MS).toISOString(),
    };
  }
  if (war.state !== 'open') {
    return { ok: false, error: 'war-locked',
             message: 'War for this week has already moved past declaration.' };
  }
  // Dedup: one declaration per banner per week.
  if (war.declarations.some(d => d.attacker === myMember.bannerId)) {
    return { ok: false, error: 'already-declared' };
  }
  war.declarations.push({
    attacker: myMember.bannerId,
    defender: targetBannerId || null,         // null = open challenge (anyone can pair)
    declaredUtc: nowIso(),
  });
  war.scores[myMember.bannerId] = war.scores[myMember.bannerId] || 0;
  await writeWar(env, war);
  await env.LOADOUT_BOLTS.put(KEY.active(guildId), weekId);
  return { ok: true, weekId, war };
}

// Member raid — accumulates star points toward the banner's score.
// MVP: caller asserts a raid outcome (`stars: 0..3`). The full
// validation (defense layout snapshot, replay seed, anti-cheat) is a
// follow-up that lands when the Clash raid resolver gets refactored.
export async function recordRaid(env, guildId, userId, opts = {}) {
  const stars = Math.max(0, Math.min(3, parseInt(opts.stars, 10) || 0));
  const targetBannerId = String(opts.targetBannerId || '').trim();
  const myMember = await B.readMember(env, guildId, userId);
  if (!myMember?.bannerId) {
    return { ok: false, error: 'not-in-banner' };
  }
  if (!targetBannerId) return { ok: false, error: 'bad-args', message: 'Need a targetBannerId.' };
  const weekId = await env.LOADOUT_BOLTS.get(KEY.active(guildId));
  if (!weekId) return { ok: false, error: 'no-active-war' };
  const war = await readWar(env, weekId);
  if (!war || war.state === 'closed') {
    return { ok: false, error: 'no-active-war' };
  }
  if (war.state === 'open') {
    return { ok: false, error: 'war-not-live', message: 'Wait for declarations to close.' };
  }
  // Cap of 3 raids per attacker per defender per week.
  const raidId = `${myMember.bannerId}__${targetBannerId}__${userId}`;
  const key = KEY.raid(weekId, raidId);
  const prev = await env.LOADOUT_BOLTS.get(key, { type: 'json' }) || { count: 0, stars: 0 };
  if (prev.count >= 3) {
    return { ok: false, error: 'cap-reached', message: '3 raids per defender per week.' };
  }
  const best = Math.max(prev.stars || 0, stars);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify({
    weekId, attackerBanner: myMember.bannerId, defenderBanner: targetBannerId,
    userId, count: prev.count + 1, stars: best, lastRaidUtc: nowIso(),
  }));
  // Score: best of 3 per (attacker, defender) pair contributes once
  // per pair to the attacker's tally.
  if (best > (prev.stars || 0)) {
    war.scores[myMember.bannerId] = (war.scores[myMember.bannerId] || 0) + (best - (prev.stars || 0));
    await writeWar(env, war);
  }
  return { ok: true, stars: best, scoreDelta: best - (prev.stars || 0),
           score: war.scores[myMember.bannerId] };
}

// Admin/cron — flip an open war to live by seeding the bracket from
// the declarations list. MVP: round-robin (every banner pairs vs
// every other). Bracket engine v2 will do single-elim seeded by
// previous-week scores.
export async function seedWarBracket(env, guildId) {
  const weekId = await env.LOADOUT_BOLTS.get(KEY.active(guildId));
  if (!weekId) return { ok: false, error: 'no-week' };
  const war = await readWar(env, weekId);
  if (!war || war.state !== 'open') return { ok: false, error: 'not-open' };
  const attackers = [...new Set(war.declarations.map(d => d.attacker))];
  // Round-robin pairings.
  const bracket = [];
  for (let i = 0; i < attackers.length; i++) {
    for (let j = i + 1; j < attackers.length; j++) {
      bracket.push([attackers[i], attackers[j]]);
    }
  }
  war.bracket = bracket;
  war.state   = 'live';
  await writeWar(env, war);
  return { ok: true, weekId, pairings: bracket.length };
}

// Admin/cron — close + archive a war.
export async function closeWar(env, guildId) {
  const weekId = await env.LOADOUT_BOLTS.get(KEY.active(guildId));
  if (!weekId) return { ok: false, error: 'no-week' };
  const war = await readWar(env, weekId);
  if (!war) return { ok: false, error: 'no-war' };
  war.state = 'closed';
  war.closedUtc = nowIso();
  await writeWar(env, war);
  await env.LOADOUT_BOLTS.delete(KEY.active(guildId));
  // Bump warsWon/Lost on each banner. MVP: highest score = +1 warsWon,
  // everyone else +1 warsLost.
  const ranking = Object.entries(war.scores || {})
    .sort((a, b) => b[1] - a[1]);
  if (ranking.length) {
    const [winnerBannerId] = ranking[0];
    for (const [bannerId] of ranking) {
      const b = await B.readBanner(env, guildId, bannerId);
      if (!b) continue;
      if (bannerId === winnerBannerId) b.warsWon = (b.warsWon || 0) + 1;
      else                              b.warsLost = (b.warsLost || 0) + 1;
      await B.writeBanner(env, b);
    }
  }
  return { ok: true, weekId, ranking };
}
