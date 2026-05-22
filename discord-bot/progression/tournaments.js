// Progression — tournaments.
//
// PROGRESSION-SYSTEM-DESIGN.md §9. Random-spawn brackets + ladders
// across 4 games (Boltbound, board games, Clash, quick games). The
// cron tick rolls a daily spawn check; sign-ups open 24h before start,
// matches resolve through the existing per-game engines, rewards
// land via the bus + badge module on completion.
//
// State layout:
//   tourn:active:<game>       { tournId, format, startUtc, endUtc, signupEndsUtc, state, participants, brackets/scores }
//   tourn:archive:<tournId>   same shape
//   ptourn:<userId>:<tournId> { signedUpUtc, matches, placement?, rewards? }
//   tourn:lastSpawnDayUtc     marker, used by the spawn scheduler

import { awardBadge } from './badges.js';
import { emitProgressionEvent } from './event-bus.js';
import { addFragments } from '../cards-fragments.js';

const ACTIVE_KEY = (game) => `tourn:active:${game}`;
const ARCHIVE_KEY = (tournId) => `tourn:archive:${tournId}`;
const USER_KEY = (uid, tournId) => `ptourn:${uid}:${tournId}`;
const SPAWN_MARKER = 'tourn:lastSpawnDayUtc';
const SPAWN_FORCE_MARKER = 'tourn:lastForceSpawnUtc';

// Per-game configs. Each lists the format (bracket vs ladder), the
// possible durations (2-4 days), reward shape, and the engine-specific
// "scoring" function used by the live cron pass.
const GAMES = {
  boltbound: { format: 'bracket', durationDays: [2, 3], capacity: 64,
               weight: 4, label: 'Boltbound' },
  board:     { format: 'bracket', durationDays: [3, 4], capacity: 32,
               weight: 2, label: 'Board Games' },
  clash:     { format: 'ladder',  durationDays: [3, 3], capacity: 9999,
               weight: 2, label: 'Clash' },
  quick:     { format: 'ladder',  durationDays: [1, 2], capacity: 9999,
               weight: 2, label: 'Quick Games' },
};
const TOTAL_WEIGHT = Object.values(GAMES).reduce((s, g) => s + g.weight, 0);

const REWARDS = {
  bracket: {
    1: { xp: 500, bolts: 5000, badgeIdSuffix: '-1st' },
    2: { xp: 250, bolts: 2500, badgeIdSuffix: '-2nd' },
    3: { xp: 150, bolts: 1000, badgeIdSuffix: '-3rd' },
    top8: { xp: 100, bolts: 500, badgeIdSuffix: '-top8' },
    participant: { xp: 25, bolts: 0, badgeIdSuffix: '-participant' },
  },
  ladder: {
    1: { xp: 300, bolts: 3000, badgeIdSuffix: '-1st' },
    2: { xp: 150, bolts: 1500, badgeIdSuffix: '-2nd' },
    3: { xp: 100, bolts: 750, badgeIdSuffix: '-3rd' },
    top10pct: { xp: 50, bolts: 300, badgeIdSuffix: '-top10' },
    participant: { xp: 25, bolts: 0, badgeIdSuffix: '-participant' },
  },
};

// ── Scheduler ─────────────────────────────────────────────────────
//
// Fires from clash-cron.js :23 tick. Per the design:
//   - 15% chance/day to spawn a tournament when none is live in any
//     game type (random pick weighted by `weight`)
//   - Floor: force-spawn one if 14 days since last forced
//   - Ceiling: at most one live tournament PER GAME at a time

export async function tournamentSpawnTick(env, nowUtc = Date.now()) {
  // Only run the dice once per UTC day.
  const today = new Date(nowUtc).toISOString().slice(0, 10);
  const last = await env.LOADOUT_BOLTS.get(SPAWN_MARKER, { type: 'text' });
  if (last === today) return { rolled: false, reason: 'already-rolled-today' };
  await env.LOADOUT_BOLTS.put(SPAWN_MARKER, today, { expirationTtl: 86400 * 3 });

  // Force-spawn floor: if 14 days since last spawn at all, definitely spawn.
  const lastForceRaw = await env.LOADOUT_BOLTS.get(SPAWN_FORCE_MARKER, { type: 'text' });
  const lastForce = parseInt(lastForceRaw || '0', 10);
  const daysSinceForce = (nowUtc - lastForce) / 86400_000;
  const mustSpawn = !lastForce || daysSinceForce >= 14;
  const baseRoll = Math.random();
  const shouldSpawn = mustSpawn || baseRoll < 0.15;
  if (!shouldSpawn) return { rolled: true, fired: false, baseRoll };

  // Pick a game that doesn't currently have an active tournament,
  // weighted by GAMES[g].weight.
  const candidates = [];
  for (const game of Object.keys(GAMES)) {
    const active = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(game), { type: 'json' });
    if (!active) candidates.push(game);
  }
  if (!candidates.length) return { rolled: true, fired: false, reason: 'all-games-have-active' };
  const totalW = candidates.reduce((s, g) => s + GAMES[g].weight, 0);
  let r = Math.random() * totalW;
  let pick = candidates[0];
  for (const g of candidates) {
    r -= GAMES[g].weight;
    if (r <= 0) { pick = g; break; }
  }

  // Mint the tournament.
  const cfg = GAMES[pick];
  const duration = cfg.durationDays[Math.floor(Math.random() * cfg.durationDays.length)];
  const startUtc = nowUtc + 24 * 3600_000;  // sign-up window 24h
  const endUtc = startUtc + duration * 86400_000;
  const tournId = `t-${pick}-${new Date(nowUtc).toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  const tourn = {
    tournId,
    game: pick,
    format: cfg.format,
    label: cfg.label,
    createdUtc: nowUtc,
    signupEndsUtc: startUtc,
    startUtc,
    endUtc,
    durationDays: duration,
    capacity: cfg.capacity,
    state: 'signup',
    participants: [],
    bracket: cfg.format === 'bracket' ? { rounds: [] } : null,
    ladder: cfg.format === 'ladder' ? { scores: {} } : null,
  };
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY(pick), JSON.stringify(tourn));
  await env.LOADOUT_BOLTS.put(SPAWN_FORCE_MARKER, String(nowUtc));
  return { rolled: true, fired: true, tournId, game: pick, durationDays: duration };
}

// ── Sign-up ───────────────────────────────────────────────────────

export async function signUp(env, userId, game, displayName) {
  if (!GAMES[game]) return { ok: false, error: 'unknown-game' };
  const tourn = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(game), { type: 'json' });
  if (!tourn) return { ok: false, error: 'no-active-tournament' };
  if (tourn.state !== 'signup') return { ok: false, error: 'signup-closed', state: tourn.state };
  if (Date.now() >= tourn.signupEndsUtc) return { ok: false, error: 'signup-closed' };
  if (tourn.participants.find(p => p.userId === userId)) return { ok: false, error: 'already-signed-up' };
  if (tourn.participants.length >= tourn.capacity) return { ok: false, error: 'full' };
  tourn.participants.push({ userId, displayName: displayName || '', signedUpUtc: Date.now() });
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY(game), JSON.stringify(tourn));
  await env.LOADOUT_BOLTS.put(USER_KEY(userId, tourn.tournId), JSON.stringify({
    tournId: tourn.tournId, game, signedUpUtc: Date.now(), matches: [],
  }));
  // Achievement event.
  try {
    await emitProgressionEvent(env, {
      kind: 'tourn.entered', userId,
      meta: { tournId: tourn.tournId, game }, stableKeys: ['tournId'],
    });
  } catch { /* non-fatal */ }
  return { ok: true, tournId: tourn.tournId, signedUpCount: tourn.participants.length };
}

// ── Cron tick — advance live tournaments ──────────────────────────

export async function advanceTournaments(env, nowUtc = Date.now()) {
  const out = [];
  for (const game of Object.keys(GAMES)) {
    const t = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(game), { type: 'json' });
    if (!t) continue;
    if (t.state === 'signup' && nowUtc >= t.signupEndsUtc) {
      // Transition signup → live. For brackets, seed the bracket
      // with random seeding; for ladders, just flip state.
      if (t.format === 'bracket') {
        t.bracket = seedBracket(t.participants);
      }
      t.state = 'live';
      await env.LOADOUT_BOLTS.put(ACTIVE_KEY(game), JSON.stringify(t));
      out.push({ tournId: t.tournId, transition: 'signup→live' });
    }
    if (t.state === 'live' && nowUtc >= t.endUtc) {
      // Tournament ended — finalise + grant rewards + archive.
      await finaliseTournament(env, t);
      await env.LOADOUT_BOLTS.put(ARCHIVE_KEY(t.tournId), JSON.stringify(t));
      await env.LOADOUT_BOLTS.delete(ACTIVE_KEY(game));
      out.push({ tournId: t.tournId, transition: 'live→archived' });
    }
  }
  return out;
}

// Build a single-elim bracket from a participant list. Pads to power
// of 2 with byes. Random seeding for v1.
function seedBracket(participants) {
  const shuffled = participants.slice().sort(() => Math.random() - 0.5);
  let size = 1;
  while (size < shuffled.length) size *= 2;
  while (shuffled.length < size) shuffled.push({ userId: '__bye', displayName: 'BYE' });
  const round1 = [];
  for (let i = 0; i < size; i += 2) {
    round1.push({ matchId: `r1m${i/2}`, a: shuffled[i], b: shuffled[i+1], winner: null });
  }
  return { rounds: [round1] };
}

// ── Score reporting (ladder + bracket) ────────────────────────────
//
// Called by the per-game engine (event-bus consumer) when a ladder-
// qualifying event fires during a live tournament window. Bracket
// matches are reported via a separate `recordBracketResult` once the
// game engine resolves a tournament-flagged match.

export async function bumpLadder(env, game, userId, scoreDelta) {
  const t = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(game), { type: 'json' });
  if (!t || t.state !== 'live' || t.format !== 'ladder') return null;
  // Daily cap on contributions per user (anti-grind) — applied here.
  t.ladder.scores[userId] = (t.ladder.scores[userId] || 0) + scoreDelta;
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY(game), JSON.stringify(t));
  return t.ladder.scores[userId];
}

export async function recordBracketResult(env, game, matchId, winnerUserId) {
  const t = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(game), { type: 'json' });
  if (!t || t.state !== 'live' || t.format !== 'bracket') return null;
  // Find the match in the current round; mark winner; if round complete,
  // build the next round from winners.
  for (const round of t.bracket.rounds) {
    const m = round.find(x => x.matchId === matchId);
    if (!m) continue;
    if (m.winner) return { ok: false, error: 'already-decided' };
    if (m.a.userId !== winnerUserId && m.b.userId !== winnerUserId) {
      return { ok: false, error: 'winner-not-in-match' };
    }
    m.winner = winnerUserId;
    // Round complete?
    if (round.every(x => x.winner)) {
      const winners = round.map(x => ({ userId: x.winner, displayName: x.a.userId === x.winner ? x.a.displayName : x.b.displayName }));
      if (winners.length > 1) {
        const next = [];
        for (let i = 0; i < winners.length; i += 2) {
          next.push({ matchId: `r${t.bracket.rounds.length + 1}m${i/2}`, a: winners[i], b: winners[i+1], winner: null });
        }
        t.bracket.rounds.push(next);
      }
    }
    await env.LOADOUT_BOLTS.put(ACTIVE_KEY(game), JSON.stringify(t));
    return { ok: true };
  }
  return { ok: false, error: 'match-not-found' };
}

// ── Finalisation ──────────────────────────────────────────────────

async function finaliseTournament(env, t) {
  let placements = [];  // [{userId, place}]
  if (t.format === 'bracket') {
    placements = bracketPlacements(t.bracket);
  } else {
    placements = ladderPlacements(t.ladder, t.participants.length);
  }
  // Grant rewards.
  const rewardSet = REWARDS[t.format];
  for (const { userId, place } of placements) {
    const reward = pickReward(rewardSet, place, placements.length);
    if (!reward) continue;
    try {
      // XP grant — bus call (tournament XP is exempt from the daily
      // soft cap per xp-table.js).
      await emitProgressionEvent(env, {
        kind: place === 1 ? 'tourn.victory'
              : place === 2 ? 'tourn.runnerup'
              : 'tourn.round.won',
        userId,
        meta: { tournId: t.tournId, game: t.game, place },
        stableKeys: ['tournId', 'place'],
      });
      // Badge — synthetic id per (game, place); the badges-catalog
      // doesn't carry these by default, the engine grants whatever
      // suffix is supplied + skips silently if catalog lookup misses
      // (P4 awardBadge guards with BADGES_BY_ID — we'll add
      // tournament badges to the catalog in a follow-up so they
      // populate the cabinet; for now the placement XP + bolts land).
      if (reward.badgeIdSuffix) {
        await awardBadge(env, userId, `${t.game}${reward.badgeIdSuffix}`, `tournament:${t.tournId}`);
      }
      // Bolts via the pseason:bolts ledger (same pattern as season).
      if (reward.bolts > 0) {
        const ledKey = `pseason:bolts:${userId}`;
        const cur = (await env.LOADOUT_BOLTS.get(ledKey, { type: 'json' })) || { bolts: 0 };
        cur.bolts += reward.bolts;
        await env.LOADOUT_BOLTS.put(ledKey, JSON.stringify(cur));
      }
      // Record on the per-user tournament record.
      const userKey = USER_KEY(userId, t.tournId);
      const rec = (await env.LOADOUT_BOLTS.get(userKey, { type: 'json' })) || { tournId: t.tournId };
      rec.placement = place;
      rec.rewards = reward;
      await env.LOADOUT_BOLTS.put(userKey, JSON.stringify(rec));
    } catch (e) {
      console.warn('[tourn] finalise grant failed for', userId, e && e.message);
    }
  }
  t.placements = placements;
  t.finalisedUtc = Date.now();
}

function bracketPlacements(bracket) {
  if (!bracket?.rounds?.length) return [];
  const final = bracket.rounds[bracket.rounds.length - 1];
  const places = [];
  if (final.length && final[0].winner) {
    const champ = final[0].winner;
    const runner = final[0].a.userId === champ ? final[0].b.userId : final[0].a.userId;
    if (champ && champ !== '__bye') places.push({ userId: champ, place: 1 });
    if (runner && runner !== '__bye') places.push({ userId: runner, place: 2 });
  }
  // Semi-final losers → 3rd/4th.
  if (bracket.rounds.length >= 2) {
    const semi = bracket.rounds[bracket.rounds.length - 2];
    for (const m of semi) {
      if (!m.winner) continue;
      const loser = m.a.userId === m.winner ? m.b.userId : m.a.userId;
      if (loser && loser !== '__bye' && !places.find(p => p.userId === loser)) {
        places.push({ userId: loser, place: 3 });
      }
    }
  }
  return places;
}

function ladderPlacements(ladder, participantCount) {
  const entries = Object.entries(ladder.scores || {});
  entries.sort((a, b) => b[1] - a[1]);
  const out = [];
  const top10pctCount = Math.max(3, Math.floor(participantCount * 0.1));
  for (let i = 0; i < entries.length; i++) {
    const [userId] = entries[i];
    const place = i + 1;
    if (place <= 3) out.push({ userId, place });
    else if (place <= top10pctCount) out.push({ userId, place: 'top10pct' });
    else out.push({ userId, place: 'participant' });
  }
  return out;
}

function pickReward(set, place, _total) {
  if (place === 1) return set[1];
  if (place === 2) return set[2];
  if (place === 3) return set[3];
  if (place === 'top10pct') return set.top10pct || set.top8;
  if (place === 'top8') return set.top8;
  return set.participant;
}

// ── Read-side display ─────────────────────────────────────────────

export async function readActiveTournaments(env) {
  const out = [];
  for (const game of Object.keys(GAMES)) {
    const t = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(game), { type: 'json' });
    if (t) out.push(t);
  }
  return out;
}

export async function readTournament(env, tournId) {
  // Try active by scanning — small set; cheaper than a per-tournId index.
  for (const game of Object.keys(GAMES)) {
    const t = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(game), { type: 'json' });
    if (t && t.tournId === tournId) return t;
  }
  const archived = await env.LOADOUT_BOLTS.get(ARCHIVE_KEY(tournId), { type: 'json' });
  return archived;
}

export async function readUserTournament(env, userId, tournId) {
  const raw = await env.LOADOUT_BOLTS.get(USER_KEY(userId, tournId), { type: 'json' });
  return raw;
}
