// Hero death + revive module.
//
// Soft-death model (2026-05-29 Clay): when a hero is defeated on
// an expedition (or any other death-emitting flow), the hero stays
// in the player's roster but flips to a `dead` state:
//   - hero.status = 'dead'
//   - hero.diedAt = ISO timestamp
//   - hero.equipped is cleared (all equipped gear is destroyed)
//   - hero.bag is preserved (loose items in pack stay with the player)
//   - hero.hpCurrent stays at 0 — semantically "they're down"
//
// To revive: spend a revive-elixir (sold via the dungeon shop for
// 500 bolts). The elixir flips:
//   - hero.status = 'alive'
//   - hero.diedAt = null
//   - hero.hpCurrent = hero.hpMax (full HP)
//   - Lost equipped gear stays lost — the player must re-equip from
//     bag or buy new at the shop.
//
// The old `expedition:infirmary:<g>:<u>` 6-hour cooldown is
// superseded: a dead hero blocks NEW expeditions until revived;
// there is no time-based unlock. The infirmary KV key keeps being
// honored if present so in-flight cooldowns don't surprise anyone,
// but new deaths land in the hero record instead of writing it.

import { loadHero, saveHero } from './dungeon.js';

const REVIVE_ITEM_ID = 'consumable.revive-elixir';
const REVIVE_BASE_COST_BOLTS = 500;

// Computed cost — base + level scaling (encourages mid-level deaths
// to feel slightly more expensive but not punishingly so). Capped at
// 2500 so end-game revives don't bankrupt the player.
export function reviveCost(hero) {
  const lvl = Math.max(1, hero?.level || 1);
  return Math.min(2500, REVIVE_BASE_COST_BOLTS + (lvl - 1) * 25);
}

export function isDead(hero) {
  return !!hero && hero.status === 'dead';
}

// Flip a hero's state to dead. Returns the cleared equipment IDs so
// callers can include them in the death-event narration (e.g. "You
// lost your iron sword and steel helm.").
export async function killHero(env, guildId, userId, opts = {}) {
  const hero = await loadHero(env, guildId, userId);
  if (!hero) return { ok: false, error: 'no-hero' };
  if (hero.status === 'dead') return { ok: true, alreadyDead: true };

  // Destroy equipped gear — store IDs we cleared so caller can render
  // the loss in the death summary, but the items themselves are gone.
  const lostEquipped = { ...(hero.equipped || {}) };

  // Also delete the actual items from bag (equipped IDs reference bag
  // entries). Otherwise the items still take up bag slots after
  // unequip, which would let the player just re-equip them after
  // revive — defeating the stakes.
  const lostIds = new Set(Object.values(lostEquipped));
  if (Array.isArray(hero.bag) && lostIds.size) {
    hero.bag = hero.bag.filter(it => !lostIds.has(it.id));
  }
  hero.equipped = {};
  hero.status   = 'dead';
  hero.diedAt   = new Date().toISOString();
  hero.deathReason = opts.reason || 'expedition';
  hero.hpCurrent = 0;
  await saveHero(env, guildId, userId, hero);

  return { ok: true, lostEquipped, reviveCost: reviveCost(hero) };
}

// Revive a dead hero. Returns false-ish errors on bad input so the
// caller can render a user-facing message. The revive item itself is
// consumed by the caller (shop /web/dungeon/use-revive handler) —
// this helper only mutates the hero.
export async function reviveHero(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId);
  if (!hero) return { ok: false, error: 'no-hero' };
  if (hero.status !== 'dead') return { ok: false, error: 'not-dead' };

  hero.status = 'alive';
  hero.diedAt = null;
  hero.deathReason = null;
  hero.hpCurrent = Math.max(1, hero.hpMax || 25);
  await saveHero(env, guildId, userId, hero);
  return { ok: true, hero: {
    status: hero.status, hpCurrent: hero.hpCurrent, hpMax: hero.hpMax,
  } };
}

// Catalogue entry — referenced by dungeon.js SHOP_POOL.
export const REVIVE_ITEM = Object.freeze({
  id:           REVIVE_ITEM_ID,
  name:         'Revive Elixir',
  slot:         'consumable',
  rarity:       'rare',
  goldValue:    REVIVE_BASE_COST_BOLTS,
  glyph:        '✨',
  spriteId:     'items/revive-elixir.png',
  consumable:   true,
  // The dungeon /shop UI uses this string to render the tooltip line.
  description:  'Restore a fallen hero to full HP. Lost gear stays lost.',
});

export { REVIVE_ITEM_ID };

// Helper exposed for the web /play/dungeon/use-revive route — checks
// the player has at least one revive elixir in their bag, consumes
// one, and calls reviveHero. Atomic so a double-click can't revive
// twice and consume two elixirs.
export async function useReviveElixir(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId);
  if (!hero) return { ok: false, error: 'no-hero' };
  if (hero.status !== 'dead') return { ok: false, error: 'not-dead' };
  const idx = Array.isArray(hero.bag)
    ? hero.bag.findIndex(it => it.id === REVIVE_ITEM_ID)
    : -1;
  if (idx < 0) return { ok: false, error: 'no-elixir', reviveCost: reviveCost(hero) };

  // Consume the elixir + flip hero state in a single saveHero call.
  hero.bag.splice(idx, 1);
  hero.status = 'alive';
  hero.diedAt = null;
  hero.deathReason = null;
  hero.hpCurrent = Math.max(1, hero.hpMax || 25);
  await saveHero(env, guildId, userId, hero);
  return { ok: true, hero: {
    status: hero.status, hpCurrent: hero.hpCurrent, hpMax: hero.hpMax,
  } };
}

// DM helper — surface the death to the player via Discord DM with
// the revive cost + a link to the shop. The bot uses postDM via the
// existing direct-message helper. Caller wraps in try/catch since DM
// delivery can fail for closed-DM users.
export async function notifyDeathDM(env, userId, hero, lostEquipped) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const name = (hero.custom?.name) || hero.className || 'Your hero';
  const cost = reviveCost(hero);
  const lostNames = Object.values(lostEquipped || {});
  const lostLine = lostNames.length
    ? `\nLost equipped gear: ${lostNames.length} item${lostNames.length === 1 ? '' : 's'}.`
    : '';
  const body = {
    embeds: [{
      title: '💀 Your hero has fallen',
      color: 0xa1101a,
      description:
        `**${name}** fell in the field.${lostLine}\n\n` +
        `Revive at the dungeon shop with a **Revive Elixir** ` +
        `(${cost} bolts).`,
      footer: { text: 'Lost gear stays lost — bring your replacements.' },
    }],
  };
  // Open a DM channel + post.
  try {
    const dm = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient_id: String(userId) }),
    });
    if (!dm.ok) return { ok: false, error: 'open-dm-failed', status: dm.status };
    const ch = await dm.json();
    const r = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: 'post-dm-failed', status: r.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'dm-throw', detail: String(e?.message || e) };
  }
}
