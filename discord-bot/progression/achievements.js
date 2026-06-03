// Progression, achievements engine.
//
// PROGRESSION-SYSTEM-DESIGN.md §6, checks every progressionEvent
// against the catalogue (achievements-catalog.js), updates per-user
// progress counters at pach:<userId>, and unlocks entries whose
// triggers are all satisfied. Pure read-modify-write per event;
// idempotency is the event-bus's job (dedup table).
//
// Wired into event-bus.js via the dynamic import named
// `checkAchievements`. Returns an array of newly-unlocked ids.

import {
  ACHIEVEMENTS_BY_ID,
  ACHIEVEMENTS_BY_TRIGGER_KIND,
} from './achievements-catalog.js';

const REC_KEY = (uid) => `pach:${uid}`;
const COUNTS_KEY = (uid) => `pach:counts:${uid}`;

function freshRecord() {
  return { unlocked: {}, progress: {} };
}

export async function getAchievements(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(REC_KEY(userId), { type: 'json' });
  if (!raw) return freshRecord();
  return { ...freshRecord(), ...raw, unlocked: { ...raw.unlocked }, progress: { ...raw.progress } };
}

export async function putAchievements(env, userId, rec) {
  await env.LOADOUT_BOLTS.put(REC_KEY(userId), JSON.stringify(rec));
}

// ── Trigger evaluation ────────────────────────────────────────────
//
// `event` is the {kind, userId, meta, ...} payload from the bus.
// `progress` is the user's per-achievement counter store.
// For each achievement that LISTS this event's kind in any trigger,
// we (a) bump the relevant counter, (b) re-check the full trigger
// spec to see if it's now satisfied. Returns the list of achievement
// IDs whose progress changed (so we know which to re-test).

function metaMatches(achMeta, eventMeta) {
  if (!achMeta) return true;
  for (const k of Object.keys(achMeta)) {
    const want = achMeta[k];
    const got = eventMeta?.[k];
    if (typeof want === 'boolean') {
      if (!!got !== want) return false;
    } else if (typeof want === 'number') {
      // For numeric meta, treat the achievement value as a >= threshold.
      // e.g. { bet: 1000 } matches an event with bet >= 1000.
      if (typeof got !== 'number' || got < want) return false;
    } else {
      if (got !== want) return false;
    }
  }
  return true;
}

// Counter key for a single trigger spec under one achievement. We
// hash the spec into a short stable suffix so the same trigger across
// multiple events accumulates one counter.
function specKey(spec) {
  if (spec.kind) {
    const m = spec.withMeta ? Object.entries(spec.withMeta).map(([k,v]) => `${k}=${v}`).join('&') : '';
    return `${spec.kind}${m ? '|' + m : ''}`;
  }
  if (spec.anyOf) return 'anyOf';
  if (spec.allOf) return 'allOf';
  return '?';
}

// Bump the per-spec counter inside progress[achId]. For sumAtLeast,
// the bump is the meta field's numeric value; for countAtLeast it's
// 1. Returns the new counter value.
function bumpForSpec(progress, achId, spec, event) {
  const key = specKey(spec);
  progress[achId] = progress[achId] || {};
  const cur = progress[achId][key] || 0;
  if (spec.sumAtLeast) {
    const v = Number(event.meta?.[spec.sumAtLeast.metaField] || 0);
    if (v > 0) progress[achId][key] = cur + v;
  } else {
    progress[achId][key] = cur + 1;
  }
  return progress[achId][key];
}

// Is this spec satisfied given the user's progress counters?
function specSatisfied(progress, achId, spec) {
  if (spec.anyOf) {
    return (spec.anyOf || []).some(s => specSatisfied(progress, achId, s));
  }
  if (spec.allOf) {
    return (spec.allOf || []).every(s => specSatisfied(progress, achId, s));
  }
  const key = specKey(spec);
  const cur = progress[achId]?.[key] || 0;
  if (spec.countAtLeast != null) return cur >= spec.countAtLeast;
  if (spec.sumAtLeast != null)   return cur >= spec.sumAtLeast.value;
  return false;
}

function achievementSatisfied(progress, ach) {
  return (ach.triggers || []).every(t => specSatisfied(progress, ach.id, t));
}

// ── Public: checkAchievements ─────────────────────────────────────
//
// Called by event-bus.js. Returns an array of newly-unlocked
// achievement records (with xpReward + badgeId so the bus can grant
// follow-up effects). Failed lookups return [] silently.

export async function checkAchievements(env, event) {
  if (!event || !event.kind || !event.userId) return [];
  const candidateIds = ACHIEVEMENTS_BY_TRIGGER_KIND[event.kind] || [];
  if (!candidateIds.length) return [];

  const rec = await getAchievements(env, event.userId);
  const unlocked = [];

  for (const achId of candidateIds) {
    const ach = ACHIEVEMENTS_BY_ID[achId];
    if (!ach) continue;
    if (rec.unlocked[achId]) continue;   // already won
    // Bump any spec whose kind matches AND meta filter matches.
    let bumped = false;
    function bumpRecursive(spec) {
      if (!spec) return;
      if (spec.kind === event.kind && metaMatches(spec.withMeta, event.meta)) {
        bumpForSpec(rec.progress, achId, spec, event);
        bumped = true;
      }
      if (Array.isArray(spec.allOf)) for (const s of spec.allOf) bumpRecursive(s);
      if (Array.isArray(spec.anyOf)) for (const s of spec.anyOf) bumpRecursive(s);
    }
    for (const t of (ach.triggers || [])) bumpRecursive(t);
    if (!bumped) continue;
    // Re-test full satisfaction.
    if (achievementSatisfied(rec.progress, ach)) {
      rec.unlocked[achId] = Date.now();
      unlocked.push(ach);
    }
  }
  await putAchievements(env, event.userId, rec);

  // Side effects of unlock, XP + badge + push + recursive trigger
  // for meta-achievements ("achievement.unlocked"). All wrapped so a
  // single failure doesn't abort the others.
  for (const ach of unlocked) {
    try {
      await applyUnlockSideEffects(env, event.userId, ach);
    } catch (e) {
      console.warn('[ach] side-effect failure for', ach.id, e && e.message);
    }
  }

  return unlocked;
}

async function applyUnlockSideEffects(env, userId, ach) {
  // XP grant, use the catalogue xpReward (overrides table default).
  try {
    const { grantXp } = await import('./xp.js');
    await grantXp(env, userId, 'achievement.unlocked', {
      overrideXp: ach.xpReward || 50,
    });
  } catch { /* non-fatal */ }

  // Badge grant, P4 wires the catalog; until then we still record
  // ownership on `pbadge:<userId>` so the inventory is populated when
  // P4 lands.
  if (ach.badgeId) {
    try {
      const key = `pbadge:${userId}`;
      const rec = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {
        owned: [], firstEarnedUtc: {}, showcase: [],
      };
      if (!rec.owned.includes(ach.badgeId)) {
        rec.owned.push(ach.badgeId);
        rec.firstEarnedUtc[ach.badgeId] = Date.now();
        await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec));
      }
    } catch { /* non-fatal */ }
  }

  // Meta-achievement: emit achievement.unlocked into the bus so the
  // "unlock N achievements" achievements can fire on themselves. We
  // import the bus lazily to avoid circular deps.
  try {
    const { emitProgressionEvent } = await import('./event-bus.js');
    await emitProgressionEvent(env, {
      kind: 'achievement.unlocked',
      userId,
      meta: { achId: ach.id, rarity: ach.rarity },
      stableKeys: ['achId'],
    });
  } catch { /* non-fatal */ }

  // Push notification, uses the dedicated pushAchievementUnlocked
  // helper so the PWA sees kind='achievement.unlocked' with the right
  // title + body.
  try {
    const { pushAchievementUnlocked } = await import('../push.js');
    if (pushAchievementUnlocked) {
      await pushAchievementUnlocked(env, {
        userId,
        achTitle: ach.title,
        achDescription: ach.description,
        rarity: ach.rarity,
      });
    }
  } catch { /* non-fatal */ }
}

// ── Read-side helpers for the profile page ────────────────────────

export async function readAchievementsDisplay(env, userId) {
  const rec = await getAchievements(env, userId);
  const total = Object.keys(ACHIEVEMENTS_BY_ID).length;
  const earned = Object.keys(rec.unlocked).length;
  // Build a render-friendly list: unlocked + close-to-unlock.
  const items = [];
  for (const achId of Object.keys(ACHIEVEMENTS_BY_ID)) {
    const ach = ACHIEVEMENTS_BY_ID[achId];
    const wonUtc = rec.unlocked[achId] || 0;
    const isUnlocked = !!wonUtc;
    if (!isUnlocked && ach.secret) continue;   // hidden until earned
    items.push({
      id: ach.id,
      title: ach.title,
      description: ach.description,
      category: ach.category,
      iconKind: ach.iconKind,
      rarity: ach.rarity,
      xpReward: ach.xpReward,
      wonUtc,
      unlocked: isUnlocked,
      progress: rec.progress[achId] || null,
    });
  }
  items.sort((a, b) => {
    if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
    if (a.unlocked && b.unlocked) return b.wonUtc - a.wonUtc;
    return 0;
  });
  return {
    earned,
    total,
    items,
  };
}

// Lightweight count-only summary for the profile "header" badge.
export async function achievementCountsFor(env, userId) {
  const rec = await getAchievements(env, userId);
  const byRarity = { common: 0, rare: 0, epic: 0, legendary: 0 };
  for (const achId of Object.keys(rec.unlocked)) {
    const ach = ACHIEVEMENTS_BY_ID[achId];
    if (ach) byRarity[ach.rarity] = (byRarity[ach.rarity] || 0) + 1;
  }
  return { total: Object.keys(rec.unlocked).length, byRarity };
}
