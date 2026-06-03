// Boltbound, per-user lifetime stat counters (RET-3).
//
// The achievements engine (achievements-d1.js) is stateless about
// counts: the caller passes the *current cumulative* value and the
// engine unlocks every def whose threshold is met. This module is that
// source of truth, a small KV-backed counter bag the web match/pack
// paths bump, then hand to checkAndUnlock(). It also drives the
// achievement gallery's progress bars.
//
// Storage (per-user, account-wide like trophies / fragments / dust):
//   cards:bbstats:<userId> -> { wins, losses, matches, packsOpened,
//     cardsPlayed, spellsCast, minionsSummoned, curWinStreak,
//     bestWinStreak, bestDamageTurn, comboCount, classWins:{class:n} }

const STATS_KEY = (userId) => `cards:bbstats:${userId}`;

function blank() {
  return {
    wins: 0, losses: 0, matches: 0, packsOpened: 0,
    cardsPlayed: 0, spellsCast: 0, minionsSummoned: 0,
    curWinStreak: 0, bestWinStreak: 0, bestDamageTurn: 0,
    comboCount: 0, classWins: {},
  };
}

export async function getStats(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(STATS_KEY(userId), { type: 'json' });
  return { ...blank(), ...(raw || {}), classWins: { ...((raw && raw.classWins) || {}) } };
}

async function putStats(env, userId, s) {
  await env.LOADOUT_BOLTS.put(STATS_KEY(userId), JSON.stringify(s));
}

// Record a card play. Returns the updated stats.
export async function recordPlay(env, userId, cardType) {
  const s = await getStats(env, userId);
  s.cardsPlayed += 1;
  if (cardType === 'spell') s.spellsCast += 1;
  else if (cardType === 'minion') s.minionsSummoned += 1;
  await putStats(env, userId, s);
  return s;
}

// Record a finished match. `won` true on a win; `championClass` is the
// player's champion class (for class-mastery achievements). Win streak
// resets on a loss (deathless tracking). Returns updated stats.
export async function recordMatchEnd(env, userId, won, championClass) {
  const s = await getStats(env, userId);
  s.matches += 1;
  if (won) {
    s.wins += 1;
    s.curWinStreak += 1;
    if (s.curWinStreak > s.bestWinStreak) s.bestWinStreak = s.curWinStreak;
    if (championClass) s.classWins[championClass] = (s.classWins[championClass] || 0) + 1;
  } else {
    s.losses += 1;
    s.curWinStreak = 0;
  }
  await putStats(env, userId, s);
  return s;
}

export async function recordPackOpen(env, userId, n = 1) {
  const s = await getStats(env, userId);
  s.packsOpened += Math.max(1, n | 0);
  await putStats(env, userId, s);
  return s;
}

// Map an achievement trigger_type to the current cumulative count for a
// user, given their stats. Returns null for triggers this module can't
// source yet (e.g. engine-internal combo/crit signals) so the gallery
// shows them as locked-without-progress rather than fake-0/at-goal.
export function statForTrigger(triggerType, stats) {
  switch (triggerType) {
    case 'boltbound-win':    return stats.wins;
    case 'boltbound-match':  return stats.matches;
    case 'boltbound-pack':   return stats.packsOpened;
    case 'boltbound-cards':  return stats.cardsPlayed;
    case 'boltbound-spell':  return stats.spellsCast;
    case 'boltbound-summon': return stats.minionsSummoned;
    case 'boltbound-streak': return stats.bestWinStreak;
    case 'boltbound-combo':  return stats.comboCount;
    case 'boltbound-crit':   return stats.bestDamageTurn;
    default:
      if (triggerType && triggerType.startsWith('boltbound-class-')) {
        const cls = triggerType.slice('boltbound-class-'.length);
        return stats.classWins[cls] || 0;
      }
      return null;
  }
}

// The trigger types this module can currently feed checkAndUnlock with,
// paired with the cumulative count to pass. Used by the match/pack
// paths to fire unlock checks without N hand-written calls.
export function triggerEvents(stats) {
  const evs = [
    { type: 'boltbound-win',    count: stats.wins },
    { type: 'boltbound-match',  count: stats.matches },
    { type: 'boltbound-pack',   count: stats.packsOpened },
    { type: 'boltbound-cards',  count: stats.cardsPlayed },
    { type: 'boltbound-spell',  count: stats.spellsCast },
    { type: 'boltbound-summon', count: stats.minionsSummoned },
    { type: 'boltbound-streak', count: stats.bestWinStreak },
  ];
  for (const [cls, n] of Object.entries(stats.classWins || {})) {
    evs.push({ type: `boltbound-class-${cls}`, count: n });
  }
  return evs;
}
