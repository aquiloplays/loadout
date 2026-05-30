// Hero skill trees — 60 nodes across 5 classes × 3 paths × 4 tiers.
//
// 2026-05-29 sprint. Unlocks at hero.level === 5; one skillPoint per
// level after that. Allocate respects prereqs. Respec returns all
// points, charges (level * 100) bolts, locked behind a 7-day cooldown.

import { loadHero, saveHero, attackOf, defenseOf } from './dungeon.js';
import { spend as walletSpend, earn as walletEarn } from './wallet.js';

const UNLOCK_LEVEL = 5;
const RESPEC_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const RESPEC_COST_PER_LEVEL = 100;

// Stat-modifier shape: { atkFlat, atkPct, defFlat, defPct, hpFlat,
//                        hpRegenPct, critPct, dodgePct, lootPct,
//                        xpPct, abilities: ['lifesteal' | 'lucky' | ...] }
// All optional; computeSkillStatBonus sums them across unlocked nodes.

// Helper: build a node with sensible defaults.
function N(id, classId, path, tier, prereq, name, description, statModifier = {}, iconKind = 'skill') {
  return { id, classId, path, tier, cost: 1, prereq, name, description, statModifier, iconKind };
}

// ── Trees ────────────────────────────────────────────────────────

const WARRIOR_TREE = [
  // Offense
  N('warrior.off.t1', 'warrior', 'offense', 1, null, 'Heavy Strike', '+1 atk on every swing', { atkFlat: 1 }),
  N('warrior.off.t2', 'warrior', 'offense', 2, 'warrior.off.t1', 'Sword Mastery', '+2 atk when wielding a sword', { atkFlat: 2 }),
  N('warrior.off.t3', 'warrior', 'offense', 3, 'warrior.off.t2', 'Berserker Stance', '+3 atk, -1 def', { atkFlat: 3, defFlat: -1 }),
  N('warrior.off.t4', 'warrior', 'offense', 4, 'warrior.off.t3', 'Bladestorm', '+5 atk, AoE attacks', { atkFlat: 5, abilities: ['aoe'] }),
  // Defense
  N('warrior.def.t1', 'warrior', 'defense', 1, null, 'Shield Brace', '+1 def', { defFlat: 1 }),
  N('warrior.def.t2', 'warrior', 'defense', 2, 'warrior.def.t1', 'Iron Will', '+2 def, +10 hp', { defFlat: 2, hpFlat: 10 }),
  N('warrior.def.t3', 'warrior', 'defense', 3, 'warrior.def.t2', 'Bulwark', '+3 def, +20% block', { defFlat: 3, dodgePct: 20 }),
  N('warrior.def.t4', 'warrior', 'defense', 4, 'warrior.def.t3', 'Unbreakable', '+5 def, immune to first hit/raid', { defFlat: 5, abilities: ['first-hit-immune'] }),
  // Utility
  N('warrior.util.t1', 'warrior', 'utility', 1, null, 'Battle Cry', '+5% loot', { lootPct: 5 }),
  N('warrior.util.t2', 'warrior', 'utility', 2, 'warrior.util.t1', 'Iron Stomach', '+25% hp regen between fights', { hpRegenPct: 25 }),
  N('warrior.util.t3', 'warrior', 'utility', 3, 'warrior.util.t2', 'Veteran', '+15% XP', { xpPct: 15 }),
  N('warrior.util.t4', 'warrior', 'utility', 4, 'warrior.util.t3', 'Warlord', '+25% loot + lifesteal 5%', { lootPct: 20, abilities: ['lifesteal'] }),
];

const MAGE_TREE = [
  N('mage.off.t1', 'mage', 'offense', 1, null, 'Arcane Bolt', '+1 atk via spell damage', { atkFlat: 1 }),
  N('mage.off.t2', 'mage', 'offense', 2, 'mage.off.t1', 'Elemental Focus', '+2 atk, +10% crit', { atkFlat: 2, critPct: 10 }),
  N('mage.off.t3', 'mage', 'offense', 3, 'mage.off.t2', 'Spellweaver', '+3 atk, AoE on crit', { atkFlat: 3, abilities: ['aoe-on-crit'] }),
  N('mage.off.t4', 'mage', 'offense', 4, 'mage.off.t3', 'Archmage', '+5 atk, +20% crit', { atkFlat: 5, critPct: 20 }),
  N('mage.def.t1', 'mage', 'defense', 1, null, 'Mage Armor', '+1 def via barrier', { defFlat: 1 }),
  N('mage.def.t2', 'mage', 'defense', 2, 'mage.def.t1', 'Mana Shield', '+2 def, +5% dodge', { defFlat: 2, dodgePct: 5 }),
  N('mage.def.t3', 'mage', 'defense', 3, 'mage.def.t2', 'Counterspell', '+3 def, reflect 10%', { defFlat: 3, abilities: ['reflect'] }),
  N('mage.def.t4', 'mage', 'defense', 4, 'mage.def.t3', 'Arcane Bulwark', '+5 def, immune to first spell', { defFlat: 5, abilities: ['spell-immune-first'] }),
  N('mage.util.t1', 'mage', 'utility', 1, null, 'Insight', '+10% XP', { xpPct: 10 }),
  N('mage.util.t2', 'mage', 'utility', 2, 'mage.util.t1', 'Mystic Eye', '+15% loot rarity', { lootPct: 15 }),
  N('mage.util.t3', 'mage', 'utility', 3, 'mage.util.t2', 'Time Dilation', 'expeditions complete 15% faster', { abilities: ['expedition-speed'] }),
  N('mage.util.t4', 'mage', 'utility', 4, 'mage.util.t3', 'Grand Magister', '+25% XP, lucky pulls', { xpPct: 15, abilities: ['lucky'] }),
];

const ROGUE_TREE = [
  N('rogue.off.t1', 'rogue', 'offense', 1, null, 'Backstab', '+1 atk, +5% crit', { atkFlat: 1, critPct: 5 }),
  N('rogue.off.t2', 'rogue', 'offense', 2, 'rogue.off.t1', 'Twin Strike', '+2 atk, +10% crit', { atkFlat: 2, critPct: 10 }),
  N('rogue.off.t3', 'rogue', 'offense', 3, 'rogue.off.t2', 'Shadow Step', '+3 atk, +15% dodge', { atkFlat: 3, dodgePct: 15 }),
  N('rogue.off.t4', 'rogue', 'offense', 4, 'rogue.off.t3', 'Assassinate', '+5 atk, instant-kill chance', { atkFlat: 5, abilities: ['execute'] }),
  N('rogue.def.t1', 'rogue', 'defense', 1, null, 'Evasion', '+10% dodge', { dodgePct: 10 }),
  N('rogue.def.t2', 'rogue', 'defense', 2, 'rogue.def.t1', 'Leather Mastery', '+1 def, +10% dodge', { defFlat: 1, dodgePct: 10 }),
  N('rogue.def.t3', 'rogue', 'defense', 3, 'rogue.def.t2', 'Smoke Bomb', '+2 def, escape lethal once/run', { defFlat: 2, abilities: ['escape-lethal'] }),
  N('rogue.def.t4', 'rogue', 'defense', 4, 'rogue.def.t3', 'Phantom', '+3 def, +30% dodge', { defFlat: 3, dodgePct: 20 }),
  N('rogue.util.t1', 'rogue', 'utility', 1, null, 'Pickpocket', '+10% loot', { lootPct: 10 }),
  N('rogue.util.t2', 'rogue', 'utility', 2, 'rogue.util.t1', 'Stealth Scout', '+10% XP, +10% loot', { xpPct: 10, lootPct: 10 }),
  N('rogue.util.t3', 'rogue', 'utility', 3, 'rogue.util.t2', 'Treasure Hunter', '+25% loot, rare drops doubled', { lootPct: 15, abilities: ['treasure-hunter'] }),
  N('rogue.util.t4', 'rogue', 'utility', 4, 'rogue.util.t3', 'Master Thief', '+50% gold', { lootPct: 25, abilities: ['gold-double'] }),
];

const RANGER_TREE = [
  N('ranger.off.t1', 'ranger', 'offense', 1, null, 'Aimed Shot', '+1 atk via bow', { atkFlat: 1 }),
  N('ranger.off.t2', 'ranger', 'offense', 2, 'ranger.off.t1', 'Hawkeye', '+2 atk, +10% crit', { atkFlat: 2, critPct: 10 }),
  N('ranger.off.t3', 'ranger', 'offense', 3, 'ranger.off.t2', 'Volley', '+3 atk, AoE arrows', { atkFlat: 3, abilities: ['aoe'] }),
  N('ranger.off.t4', 'ranger', 'offense', 4, 'ranger.off.t3', 'Marksman', '+5 atk, +15% crit', { atkFlat: 5, critPct: 15 }),
  N('ranger.def.t1', 'ranger', 'defense', 1, null, 'Cover', '+1 def, +5% dodge', { defFlat: 1, dodgePct: 5 }),
  N('ranger.def.t2', 'ranger', 'defense', 2, 'ranger.def.t1', 'Mobility', '+1 def, +15% dodge', { defFlat: 1, dodgePct: 15 }),
  N('ranger.def.t3', 'ranger', 'defense', 3, 'ranger.def.t2', 'Wilderness Survival', '+2 def, +30% hp regen', { defFlat: 2, hpRegenPct: 30 }),
  N('ranger.def.t4', 'ranger', 'defense', 4, 'ranger.def.t3', 'Untouchable', '+3 def, +25% dodge', { defFlat: 3, dodgePct: 25 }),
  N('ranger.util.t1', 'ranger', 'utility', 1, null, 'Beast Whisperer', 'pet bonuses doubled', { abilities: ['pet-double'] }),
  N('ranger.util.t2', 'ranger', 'utility', 2, 'ranger.util.t1', 'Trail Sense', '+10% XP, +10% loot', { xpPct: 10, lootPct: 10 }),
  N('ranger.util.t3', 'ranger', 'utility', 3, 'ranger.util.t2', 'Trapper', 'random bonus loot per expedition', { lootPct: 15, abilities: ['trap-bonus'] }),
  N('ranger.util.t4', 'ranger', 'utility', 4, 'ranger.util.t3', 'Pathfinder', '+25% loot, +25% XP', { xpPct: 15, lootPct: 15 }),
];

const HEALER_TREE = [
  N('healer.off.t1', 'healer', 'offense', 1, null, 'Holy Strike', '+1 atk', { atkFlat: 1 }),
  N('healer.off.t2', 'healer', 'offense', 2, 'healer.off.t1', 'Smite', '+2 atk on undead-tagged foes', { atkFlat: 2 }),
  N('healer.off.t3', 'healer', 'offense', 3, 'healer.off.t2', 'Radiant Bolt', '+3 atk, heal on hit', { atkFlat: 3, abilities: ['lifesteal'] }),
  N('healer.off.t4', 'healer', 'offense', 4, 'healer.off.t3', 'Wrath of Aurora', '+5 atk, AoE light', { atkFlat: 5, abilities: ['aoe'] }),
  N('healer.def.t1', 'healer', 'defense', 1, null, 'Blessing', '+1 def, +15 hp', { defFlat: 1, hpFlat: 15 }),
  N('healer.def.t2', 'healer', 'defense', 2, 'healer.def.t1', 'Sanctuary', '+2 def, +50% hp regen', { defFlat: 2, hpRegenPct: 50 }),
  N('healer.def.t3', 'healer', 'defense', 3, 'healer.def.t2', 'Divine Shield', '+3 def, immune to first death', { defFlat: 3, abilities: ['death-save-once'] }),
  N('healer.def.t4', 'healer', 'defense', 4, 'healer.def.t3', 'Avatar', '+5 def, +25 hp', { defFlat: 5, hpFlat: 25 }),
  N('healer.util.t1', 'healer', 'utility', 1, null, 'Mend', 'heal between fights', { hpRegenPct: 25 }),
  N('healer.util.t2', 'healer', 'utility', 2, 'healer.util.t1', 'Prayer', '+10% XP, +10% loot', { xpPct: 10, lootPct: 10 }),
  N('healer.util.t3', 'healer', 'utility', 3, 'healer.util.t2', 'Guardian', 'party heals 25% more', { abilities: ['party-heal'] }),
  N('healer.util.t4', 'healer', 'utility', 4, 'healer.util.t3', 'Saint', '+25% XP, hp regen between expeditions', { xpPct: 15, abilities: ['regen-between-runs'] }),
];

export const SKILL_TREES = Object.freeze({
  warrior: WARRIOR_TREE,
  mage:    MAGE_TREE,
  rogue:   ROGUE_TREE,
  ranger:  RANGER_TREE,
  healer:  HEALER_TREE,
});

// Flat node id index for O(1) lookups.
const NODES_BY_ID = Object.freeze(Object.fromEntries(
  Object.values(SKILL_TREES).flat().map(n => [n.id, n]),
));

// ── Bonus aggregation ─────────────────────────────────────────────

export function computeSkillStatBonus(hero) {
  const out = {
    atkFlat: 0, atkPct: 0,
    defFlat: 0, defPct: 0,
    hpFlat: 0, hpRegenPct: 0,
    critPct: 0, dodgePct: 0,
    lootPct: 0, xpPct: 0,
    abilities: [],
  };
  const unlocked = Array.isArray(hero?.unlockedNodes) ? hero.unlockedNodes : [];
  for (const nid of unlocked) {
    const n = NODES_BY_ID[nid];
    if (!n) continue;
    const m = n.statModifier || {};
    for (const k of Object.keys(out)) {
      if (k === 'abilities') {
        if (Array.isArray(m.abilities)) for (const a of m.abilities) {
          if (!out.abilities.includes(a)) out.abilities.push(a);
        }
        continue;
      }
      out[k] += Number(m[k]) || 0;
    }
  }
  return out;
}

// ── Lifecycle ─────────────────────────────────────────────────────

// Call from grantXp when the hero's level crosses a threshold ≥ 5.
// Idempotent within a single level cross via the lastSkillGrantedLevel
// stamp on the hero record.
export function maybeGrantSkillPointsOnLevelUp(hero) {
  if (!hero) return { granted: 0 };
  const lvl = hero.level || 1;
  if (lvl < UNLOCK_LEVEL) return { granted: 0 };
  const last = hero.lastSkillGrantedLevel || (UNLOCK_LEVEL - 1);
  if (lvl <= last) return { granted: 0 };
  const points = lvl - last;
  hero.skillPoints = (hero.skillPoints || 0) + points;
  hero.unlockedNodes = hero.unlockedNodes || [];
  hero.lastSkillGrantedLevel = lvl;
  return { granted: points };
}

// ── Web-facing ────────────────────────────────────────────────────

export async function getSkillsSnapshot(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId);
  if (!hero) return { ok: false, error: 'no-hero' };
  const className = String(hero.className || 'warrior').toLowerCase();
  const tree = SKILL_TREES[className] || [];
  return {
    ok: true,
    className,
    level:           hero.level || 1,
    unlocked:        (hero.level || 1) >= UNLOCK_LEVEL,
    skillPoints:     hero.skillPoints || 0,
    unlockedNodes:   hero.unlockedNodes || [],
    nextRespecAvailableUtc: hero.lastRespecUtc
      ? new Date(hero.lastRespecUtc + RESPEC_COOLDOWN_MS).toISOString()
      : null,
    tree,
    bonus:           computeSkillStatBonus(hero),
  };
}

export async function allocateSkillPoint(env, guildId, userId, opts = {}) {
  const nodeId = String(opts.nodeId || '').trim();
  const node = NODES_BY_ID[nodeId];
  if (!node) return { ok: false, error: 'bad-node' };
  const hero = await loadHero(env, guildId, userId);
  if (!hero) return { ok: false, error: 'no-hero' };
  const className = String(hero.className || '').toLowerCase();
  if (node.classId !== className) {
    return { ok: false, error: 'wrong-class',
             message: `${node.name} belongs to ${node.classId}.` };
  }
  if ((hero.level || 1) < UNLOCK_LEVEL) {
    return { ok: false, error: 'tree-locked',
             message: `Skill tree unlocks at level ${UNLOCK_LEVEL}.` };
  }
  hero.unlockedNodes = hero.unlockedNodes || [];
  if (hero.unlockedNodes.includes(nodeId)) {
    return { ok: false, error: 'already-allocated' };
  }
  if (node.prereq && !hero.unlockedNodes.includes(node.prereq)) {
    return { ok: false, error: 'prereq-not-met', prereq: node.prereq };
  }
  if ((hero.skillPoints || 0) < node.cost) {
    return { ok: false, error: 'no-points', have: hero.skillPoints || 0, need: node.cost };
  }
  hero.skillPoints -= node.cost;
  hero.unlockedNodes.push(nodeId);
  await saveHero(env, guildId, userId, hero);
  return { ok: true, nodeId, skillPoints: hero.skillPoints,
           unlockedNodes: hero.unlockedNodes,
           bonus: computeSkillStatBonus(hero) };
}

export async function respecSkillTree(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId);
  if (!hero) return { ok: false, error: 'no-hero' };
  const now = Date.now();
  const last = hero.lastRespecUtc || 0;
  if (now - last < RESPEC_COOLDOWN_MS) {
    return { ok: false, error: 'on-cooldown',
             nextAvailableUtc: new Date(last + RESPEC_COOLDOWN_MS).toISOString() };
  }
  const cost = (hero.level || 1) * RESPEC_COST_PER_LEVEL;
  const spendRes = await walletSpend(env, guildId, userId, cost, 'hero-skills-respec');
  if (!spendRes.ok) {
    return { ok: false, error: 'insufficient-bolts', need: cost, have: spendRes.balance || 0 };
  }
  const refunded = (hero.unlockedNodes || []).length;
  hero.skillPoints = (hero.skillPoints || 0) + refunded;
  hero.unlockedNodes = [];
  hero.lastRespecUtc = now;
  await saveHero(env, guildId, userId, hero);
  return { ok: true, cost, refundedPoints: refunded,
           skillPoints: hero.skillPoints };
}

// ── Combat integration hook ───────────────────────────────────────
//
// expedition.js can call computeEffectiveStats(hero) instead of
// attackOf/defenseOf to factor in skill bonuses. Kept as a separate
// helper so the existing call sites don't need a sweep.

export function computeEffectiveStats(hero) {
  const base = { atk: attackOf(hero), def: defenseOf(hero) };
  const b = computeSkillStatBonus(hero);
  const atk = Math.round(base.atk + b.atkFlat + (base.atk * b.atkPct / 100));
  const def = Math.round(base.def + b.defFlat + (base.def * b.defPct / 100));
  return { atk, def, bonus: b };
}

export const _consts = { UNLOCK_LEVEL, RESPEC_COOLDOWN_MS, RESPEC_COST_PER_LEVEL };
