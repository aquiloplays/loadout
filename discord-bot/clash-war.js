// Clash Phase 2 — community-vs-community wars.
//
// Two streamer communities clash through a vote-driven 24h war
// window. Same vote-mechanic family as the dungeon `!join` recruit
// pattern, just wired to Discord buttons instead of chat commands:
//
//   1. Streamer A's mod runs `/clash war declare target:<guildId>`.
//      A's community votes yes/no on whether to declare for 10 min.
//      If >=3 voters and >50% yes, advances.
//   2. B's community gets a PWA push + a Discord post with
//      Accept/Refuse buttons. 1 h window. Streamer/mods can also
//      directly accept/refuse without the vote.
//   3. On accept: 24h active war window. Both communities can raid
//      each other for amplified rewards (30% loot cap, 1.5× trophy
//      delta). All such raids are recorded into war.raids[] and
//      contribute stars to the side's cumulative score.
//   4. After 24h: winner = side with more stars (defender wins ties
//      — slight defender bias is fine in a community-defending-its-
//      town game). Winner gets a 7-day Victorious banner and Cores
//      tribute to their treasury.
//
// State machine — advance is *read-time*. Whenever a Clash command
// touches the war (any side, any subcommand), we walk the current
// state forward against `now`. The daily cron in clash-cron.js also
// sweeps active wars so timed-out states resolve even if nobody
// interacts.
//
// KV layout:
//   clash:war:<warId>                   full war record
//   clash:waractive:<guildId>           current war id (active OR pending)
//   clash:warvote:<warId>:<voterId>     individual vote { side, choice, ts }
//   clash:warcd:<guildId>               { until } post-war cooldown
//   clash:warbadge:<guildId>            { wonUtc, expiresUtc } Victorious banner

import { getTown, getTreasury, addTreasury, adjustPrestige } from './clash-state.js';

export const DECLARE_VOTE_MS = 10 * 60_000;
export const ACCEPT_VOTE_MS  = 60 * 60_000;
export const WAR_WINDOW_MS   = 24 * 3_600_000;
export const POST_WAR_COOLDOWN_MS = 24 * 3_600_000;
export const BADGE_TTL_MS    = 7 * 86_400_000;
export const MIN_VOTERS      = 3;
export const WAR_LOOT_CAP_PCT   = 0.30;      // up from 0.20
export const WAR_TROPHY_MULT    = 1.5;
export const WAR_VOLTAIC_BONUS  = 0.15;      // +15 % per-raid Voltaic drop chance

export const STATE = {
  DECLARING:      'declaring',
  PENDING_ACCEPT: 'pending_accept',
  ACTIVE:         'active',
  COMPLETED:      'completed',
  CANCELLED:      'cancelled',     // declaration vote failed
  REFUSED:        'refused',       // defender refused
  TIMED_OUT:      'timed_out',     // defender didn't respond in time
};

// ── Persistence helpers ─────────────────────────────────────────────

export async function getWar(env, warId) {
  return env.LOADOUT_BOLTS.get('clash:war:' + warId, { type: 'json' });
}
export async function putWar(env, war) {
  // Wars keep for 60 d so the recent-history view is meaningful.
  await env.LOADOUT_BOLTS.put('clash:war:' + war.warId, JSON.stringify(war), {
    expirationTtl: 60 * 86400,
  });
}
export async function getActiveWarId(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get('clash:waractive:' + guildId, { type: 'json' });
  return raw?.warId || null;
}
export async function setActiveWarId(env, guildId, warId) {
  await env.LOADOUT_BOLTS.put('clash:waractive:' + guildId, JSON.stringify({ warId }), {
    expirationTtl: 7 * 86400,
  });
}
export async function clearActiveWarId(env, guildId) {
  await env.LOADOUT_BOLTS.delete('clash:waractive:' + guildId);
}
export async function getWarCooldown(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get('clash:warcd:' + guildId, { type: 'json' });
  if (!raw?.until) return null;
  if (raw.until < Date.now()) {
    await env.LOADOUT_BOLTS.delete('clash:warcd:' + guildId);
    return null;
  }
  return raw;
}
export async function setWarCooldown(env, guildId, untilUtc) {
  const ttl = Math.max(60, Math.ceil((untilUtc - Date.now()) / 1000) + 60);
  await env.LOADOUT_BOLTS.put('clash:warcd:' + guildId, JSON.stringify({ until: untilUtc }), {
    expirationTtl: ttl,
  });
}
export async function getWarBadge(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get('clash:warbadge:' + guildId, { type: 'json' });
  if (!raw) return null;
  if (raw.expiresUtc && raw.expiresUtc < Date.now()) {
    await env.LOADOUT_BOLTS.delete('clash:warbadge:' + guildId);
    return null;
  }
  return raw;
}

// ── Lifecycle ───────────────────────────────────────────────────────

// Streamer/mod calls this. Returns the freshly created war record or
// { error } if the channel can't declare right now (cooldown, already
// in a war, or target is unavailable).
export async function declareWar(env, attackerGuildId, defenderGuildId, declarerUserId) {
  if (attackerGuildId === defenderGuildId) {
    return { error: 'self-target', message: 'Cannot declare war on your own town.' };
  }
  // Existing-war check
  const existingAttacker = await getActiveWarId(env, attackerGuildId);
  if (existingAttacker) {
    return { error: 'already-in-war', message: 'Your community is already in a war.' };
  }
  const existingDefender = await getActiveWarId(env, defenderGuildId);
  if (existingDefender) {
    return { error: 'target-in-war', message: 'Target is already in a war.' };
  }
  // Cooldown check
  const cdA = await getWarCooldown(env, attackerGuildId);
  if (cdA) {
    const minutes = Math.ceil((cdA.until - Date.now()) / 60_000);
    return { error: 'attacker-cooldown', message: `Your community can declare again in ${minutes} min.` };
  }
  const cdB = await getWarCooldown(env, defenderGuildId);
  if (cdB) {
    return { error: 'defender-cooldown', message: 'Target community is on cooldown from a recent war.' };
  }
  // Defender must exist (town autocreated)
  const defenderTown = await getTown(env, defenderGuildId);
  if (!defenderTown) {
    return { error: 'no-target', message: 'No town found in that channel.' };
  }
  const now = Date.now();
  const war = {
    warId: 'war_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    attackerGuildId,
    defenderGuildId,
    declaredByUserId: declarerUserId,
    state: STATE.DECLARING,
    declaredUtc: now,
    declarationEndsUtc: now + DECLARE_VOTE_MS,
    acceptEndsUtc: null,
    activeEndsUtc: null,
    completedUtc: null,
    declareVotes: { yes: [], no: [] },
    acceptVotes: { accept: [], refuse: [] },
    scores: { attacker: 0, defender: 0 },
    raids: [],
    winner: null,
    rewards: null,
  };
  await putWar(env, war);
  await setActiveWarId(env, attackerGuildId, war.warId);
  await setActiveWarId(env, defenderGuildId, war.warId);
  return { war };
}

// Cast a vote. side ∈ { 'attacker', 'defender' } based on which
// community the voter belongs to. choice ∈ { 'yes','no','accept','refuse' }.
// Returns the post-vote war (advanced if a threshold tripped).
export async function castVote(env, warId, voterUserId, voterGuildId, choice) {
  const war = await getWar(env, warId);
  if (!war) return { error: 'no-war' };

  // Which side is this voter on?
  const side = voterGuildId === war.attackerGuildId
    ? 'attacker'
    : voterGuildId === war.defenderGuildId
      ? 'defender'
      : null;
  if (!side) return { error: 'not-a-participant', message: 'Only members of the warring communities can vote.' };

  // Phase + choice compatibility
  if (war.state === STATE.DECLARING) {
    if (side !== 'attacker' || (choice !== 'yes' && choice !== 'no')) {
      return { error: 'wrong-phase', message: 'Declaration vote is open to the declaring community (yes / no).' };
    }
  } else if (war.state === STATE.PENDING_ACCEPT) {
    if (side !== 'defender' || (choice !== 'accept' && choice !== 'refuse')) {
      return { error: 'wrong-phase', message: 'Accept/refuse vote is open to the defending community.' };
    }
  } else {
    return { error: 'closed', message: 'This war isn\'t taking votes anymore.' };
  }

  // Record the individual vote (one per voter — re-voting overrides).
  await env.LOADOUT_BOLTS.put(
    `clash:warvote:${warId}:${voterUserId}`,
    JSON.stringify({ side, choice, ts: Date.now() }),
    { expirationTtl: 7 * 86400 },
  );
  // Update the aggregate in the war record.
  if (war.state === STATE.DECLARING) {
    // Remove from the opposite tally if present, then add.
    war.declareVotes.yes = war.declareVotes.yes.filter(u => u !== voterUserId);
    war.declareVotes.no  = war.declareVotes.no .filter(u => u !== voterUserId);
    war.declareVotes[choice].push(voterUserId);
  } else {
    war.acceptVotes.accept = war.acceptVotes.accept.filter(u => u !== voterUserId);
    war.acceptVotes.refuse = war.acceptVotes.refuse.filter(u => u !== voterUserId);
    war.acceptVotes[choice].push(voterUserId);
  }
  await putWar(env, war);

  // Advance state if a threshold trips.
  return { war: await advanceWar(env, war) };
}

// Streamer/mod override — bypass the community vote. side must be
// 'attacker' (cancel declaration) or 'defender' (instant accept/refuse).
export async function staffOverride(env, warId, side, action) {
  const war = await getWar(env, warId);
  if (!war) return { error: 'no-war' };
  if (side === 'attacker' && war.state === STATE.DECLARING && action === 'cancel') {
    return finalize(env, war, STATE.CANCELLED);
  }
  if (side === 'defender' && war.state === STATE.PENDING_ACCEPT) {
    if (action === 'accept') return startActiveWar(env, war);
    if (action === 'refuse') return finalize(env, war, STATE.REFUSED);
  }
  return { error: 'no-op' };
}

// Read-time advancer. Call after every state-touching action and from
// the daily cron. Idempotent — if the state hasn't moved, returns the
// same war.
export async function advanceWar(env, war) {
  const now = Date.now();
  if (war.state === STATE.DECLARING) {
    const yes = war.declareVotes.yes.length;
    const no  = war.declareVotes.no.length;
    const total = yes + no;
    // Fast advance on threshold hit
    if (total >= MIN_VOTERS && yes > no) {
      return movePendingAccept(env, war);
    }
    if (now >= war.declarationEndsUtc) {
      if (total >= MIN_VOTERS && yes > no) {
        return movePendingAccept(env, war);
      }
      return finalize(env, war, STATE.CANCELLED);
    }
    return war;
  }
  if (war.state === STATE.PENDING_ACCEPT) {
    const acc = war.acceptVotes.accept.length;
    const ref = war.acceptVotes.refuse.length;
    if (acc + ref >= MIN_VOTERS) {
      if (acc > ref) return startActiveWar(env, war);
      if (ref > acc) return finalize(env, war, STATE.REFUSED);
    }
    if (now >= war.acceptEndsUtc) {
      if (acc > ref && acc + ref >= MIN_VOTERS) return startActiveWar(env, war);
      return finalize(env, war, STATE.TIMED_OUT);
    }
    return war;
  }
  if (war.state === STATE.ACTIVE) {
    if (now >= war.activeEndsUtc) {
      return finalizeWar(env, war);
    }
    return war;
  }
  return war;
}

async function movePendingAccept(env, war) {
  war.state = STATE.PENDING_ACCEPT;
  war.acceptEndsUtc = Date.now() + ACCEPT_VOTE_MS;
  await putWar(env, war);
  return war;
}

async function startActiveWar(env, war) {
  war.state = STATE.ACTIVE;
  war.activeEndsUtc = Date.now() + WAR_WINDOW_MS;
  await putWar(env, war);
  return war;
}

// Terminal-state path that ended *without* an active window (cancelled,
// refused, timed out). Clear active-war pointers + start a cooldown
// on the attacker side so they can't spam declares.
async function finalize(env, war, terminalState) {
  war.state = terminalState;
  war.completedUtc = Date.now();
  await putWar(env, war);
  await clearActiveWarId(env, war.attackerGuildId);
  await clearActiveWarId(env, war.defenderGuildId);
  // Soft cooldown: 6 h for the would-be attacker (anti-spam) when a
  // declaration fizzles. Full POST_WAR_COOLDOWN_MS only applies to a
  // war that actually ran (see finalizeWar below).
  if (terminalState === STATE.CANCELLED || terminalState === STATE.REFUSED || terminalState === STATE.TIMED_OUT) {
    await setWarCooldown(env, war.attackerGuildId, Date.now() + 6 * 3_600_000);
  }
  return war;
}

// Terminal-state path that *did* run a 24h window. Score the war,
// flip the Victorious banner, redistribute tribute.
async function finalizeWar(env, war) {
  war.state = STATE.COMPLETED;
  war.completedUtc = Date.now();
  const a = war.scores.attacker;
  const d = war.scores.defender;
  // Defender wins ties — slight defensive bias on purpose.
  const winnerSide = a > d ? 'attacker' : 'defender';
  war.winner = winnerSide;
  const winnerGuildId = winnerSide === 'attacker' ? war.attackerGuildId : war.defenderGuildId;
  const margin = Math.abs(a - d);
  // Tribute scales with margin, capped reasonable.
  const coresTribute  = Math.min(60, 10 + margin * 3);
  const prestigeDelta = Math.min(300, 50 + margin * 8);
  war.rewards = { winnerGuildId, coresTribute, prestigeDelta };
  await putWar(env, war);

  await addTreasury(env, winnerGuildId, { cores: coresTribute });
  await adjustPrestige(env, winnerGuildId, prestigeDelta);
  await env.LOADOUT_BOLTS.put(
    'clash:warbadge:' + winnerGuildId,
    JSON.stringify({ wonUtc: Date.now(), expiresUtc: Date.now() + BADGE_TTL_MS, warId: war.warId }),
    { expirationTtl: Math.ceil(BADGE_TTL_MS / 1000) + 60 },
  );

  // Both sides cooldown after a real war.
  const until = Date.now() + POST_WAR_COOLDOWN_MS;
  await setWarCooldown(env, war.attackerGuildId, until);
  await setWarCooldown(env, war.defenderGuildId, until);
  await clearActiveWarId(env, war.attackerGuildId);
  await clearActiveWarId(env, war.defenderGuildId);
  return war;
}

// Called by the raid resolver when a raid lands during an active war
// pairing. Increments the scoring side's stars, appends the raid id
// to war.raids[].
export async function recordWarRaid(env, war, attackerGuildId, raidId, stars) {
  if (war.state !== STATE.ACTIVE) return war;
  const side = attackerGuildId === war.attackerGuildId
    ? 'attacker'
    : attackerGuildId === war.defenderGuildId
      ? 'defender'
      : null;
  if (!side) return war;
  war.scores[side] += stars;
  war.raids.push({ raidId, side, stars, ts: Date.now() });
  await putWar(env, war);
  return war;
}

// Helper: given a raider's home guild and a target guild, return the
// active war record if the raid is part of one, else null. Used by
// the raid resolver to apply amplification.
export async function findActiveWarForRaid(env, attackerHomeGuildId, targetGuildId) {
  if (!attackerHomeGuildId || !targetGuildId) return null;
  const warId = await getActiveWarId(env, attackerHomeGuildId);
  if (!warId) return null;
  const war = await getWar(env, warId);
  if (!war || war.state !== STATE.ACTIVE) return null;
  // Pairing must match (in either direction).
  const matches =
    (war.attackerGuildId === attackerHomeGuildId && war.defenderGuildId === targetGuildId) ||
    (war.defenderGuildId === attackerHomeGuildId && war.attackerGuildId === targetGuildId);
  return matches ? war : null;
}

// Sweep all currently active wars; advance any whose window expired.
// Called from clash-cron.js. Lightweight — uses the `clash:waractive:`
// index instead of scanning every war record.
export async function sweepActiveWars(env) {
  let cursor;
  const seen = new Set();
  const ended = [];
  for (let i = 0; i < 3; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'clash:waractive:', cursor, limit: 1000 });
    for (const k of r.keys) {
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      const warId = rec?.warId;
      if (!warId || seen.has(warId)) continue;
      seen.add(warId);
      const war = await getWar(env, warId);
      if (!war) {
        await env.LOADOUT_BOLTS.delete(k.name);
        continue;
      }
      const advanced = await advanceWar(env, war);
      if (advanced.state === STATE.COMPLETED && war.state !== STATE.COMPLETED) {
        ended.push(advanced);
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return ended;
}
