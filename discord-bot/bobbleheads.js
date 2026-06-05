// Fallout bobblehead collection: the 27-piece catalog + earning rules + the
// award core. The earning automation (chat milestones, cheers, follows, the
// scratch rare drop, Patreon-tier SPECIAL unlocks, Discord milestone posts)
// is wired in a follow-up; this module is the data + storage foundation so the
// profile shelf + collection page can render now and the hooks can call
// awardBobblehead() when they land. See AQUILO-VAULT-DESIGN.md sibling docs.
//
// Art: aquilo.gg/images/fallout/bobbleheads/<id>.webp

// group: special (SPECIAL set) | skill | rare | aquilo
// earn:  short human description of how it is earned (also the spec contract).
export const BOBBLEHEADS = [
  // SPECIAL set (7), unlocked by Patreon tier.
  { id: 'charisma', name: 'Charisma', group: 'special', earn: 'Patreon Tier 1+' },
  { id: 'strength', name: 'Strength', group: 'special', earn: 'Patreon Tier 2+' },
  { id: 'perception', name: 'Perception', group: 'special', earn: 'Patreon Tier 3' },
  { id: 'endurance', name: 'Endurance', group: 'special', earn: 'Patreon Tier 3' },
  { id: 'intelligence', name: 'Intelligence', group: 'special', earn: 'Patreon Tier 3' },
  { id: 'agility', name: 'Agility', group: 'special', earn: 'Patreon Tier 3' },
  { id: 'luck', name: 'Luck', group: 'special', earn: 'Patreon Tier 3' },
  // Skill bobbleheads (13), chat-engagement milestones.
  { id: 'speech', name: 'Speech', group: 'skill', earn: '100 chat messages in a week' },
  { id: 'big-guns', name: 'Big Guns', group: 'skill', earn: '50 cheers' },
  { id: 'medicine', name: 'Medicine', group: 'skill', earn: '10 deaths watched' },
  { id: 'barter', name: 'Barter', group: 'skill', earn: 'Trade 5 Boltbound cards' },
  { id: 'energy-weapons', name: 'Energy Weapons', group: 'skill', earn: 'Win 10 mini-games' },
  { id: 'explosives', name: 'Explosives', group: 'skill', earn: 'Trigger 5 scratch tampers' },
  { id: 'lockpick', name: 'Lockpick', group: 'skill', earn: 'Open 10 Boltbound packs' },
  { id: 'melee-weapons', name: 'Melee Weapons', group: 'skill', earn: 'Win 10 Boltbound matches' },
  { id: 'repair', name: 'Repair', group: 'skill', earn: 'Craft 3 Boltbound cards' },
  { id: 'science', name: 'Science', group: 'skill', earn: 'Reach account level 10' },
  { id: 'small-guns', name: 'Small Guns', group: 'skill', earn: '25 follows referred' },
  { id: 'sneak', name: 'Sneak', group: 'skill', earn: 'Lurk 5 full streams' },
  { id: 'unarmed', name: 'Unarmed', group: 'skill', earn: 'Win a PvP duel' },
  // Rare event drops (5).
  { id: 'vault-tec-rep', name: 'Vault-Tec Rep', group: 'rare', earn: 'Link your Patreon' },
  { id: 'mr-handy', name: 'Mr. Handy', group: 'rare', earn: 'Attend your first stream' },
  { id: 'captain-cosmos', name: 'Captain Cosmos', group: 'rare', earn: 'Community-join anniversary' },
  { id: 'mothman', name: 'Mothman', group: 'rare', earn: 'Log in during a stream after midnight ET' },
  { id: 'pip-boy', name: 'Pip-Boy', group: 'rare', earn: 'Use the Rotation Pip-Boy preset on your stream' },
  // Aquilo exclusives (2).
  { id: 'aquilo-brand', name: 'Aquilo Brand', group: 'aquilo', earn: 'Lifetime supporter ($100+ total)' },
  { id: 'boltbound', name: 'Boltbound', group: 'aquilo', earn: 'Unlock a Boltbound legendary card' },
];

const ID_SET = new Set(BOBBLEHEADS.map((b) => b.id));
const KEY = (userId) => `bobbleheads:${userId}`;

// Award a bobblehead to a user. Idempotent; returns { awarded, total } where
// awarded is true only on the first time. Callers (the future earning hooks)
// fire this; a true return is the cue to post the Discord milestone embed.
export async function awardBobblehead(env, userId, id, meta = {}) {
  if (!userId || !ID_SET.has(id)) return { awarded: false };
  const k = KEY(String(userId));
  let owned = {};
  try { owned = (await env.LOADOUT_BOLTS.get(k, { type: 'json' })) || {}; } catch { /* ignore */ }
  if (owned[id]) return { awarded: false, total: Object.keys(owned).length };
  owned[id] = { at: Date.now(), via: String(meta.via || '').slice(0, 40) };
  try { await env.LOADOUT_BOLTS.put(k, JSON.stringify(owned)); } catch { /* best-effort */ }
  return { awarded: true, total: Object.keys(owned).length };
}

// Per-user shelf for the profile / collection page.
export async function getShelf(env, userId) {
  let owned = {};
  try { owned = (await env.LOADOUT_BOLTS.get(KEY(String(userId)), { type: 'json' })) || {}; } catch { /* ignore */ }
  const items = BOBBLEHEADS.map((b) => ({ ...b, owned: !!owned[b.id], at: owned[b.id]?.at || null }));
  return { total: BOBBLEHEADS.length, owned: Object.keys(owned).length, items };
}
