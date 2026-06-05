// Vertibird Power Armor drops. Each gifted sub drops one power armor crate on
// the stream (the power-armor-drop overlay) and adds the suit to the Vault
// Hangar (the power-armor-hangar overlay + aquilo.gg/hangar). Variants cycle
// sequentially through the 15 so every suit shows up over time.
//
// Emits the `vertibird.drop` Aquilo Bus event via publishActivity (so it
// reaches the OBS overlays through the same bridge the activity overlay uses).
import { publishActivity } from './activity-do.js';

export const POWER_ARMOR = [
  { id: 't-45', name: 'T-45 Power Armor' },
  { id: 't-51', name: 'T-51 Power Armor' },
  { id: 't-60', name: 'T-60 Power Armor' },
  { id: 't-65', name: 'T-65 Power Armor' },
  { id: 'x-01', name: 'X-01 Power Armor' },
  { id: 'x-02-hellfire', name: 'X-02 Hellfire' },
  { id: 'tesla', name: 'Tesla Power Armor' },
  { id: 'excavator', name: 'Excavator Power Armor' },
  { id: 'hotrod-flames', name: 'Hot Rod Flames' },
  { id: 'hotrod-shark', name: 'Hot Rod Shark' },
  { id: 'strangler-heart', name: 'Strangler Heart' },
  { id: 'ultracite', name: 'Ultracite Power Armor' },
  { id: 'raider', name: 'Raider Power Armor' },
  { id: 'vault-tec', name: 'Vault-Tec Power Armor' },
  { id: 'aquilo-signature', name: 'Aquilo Signature' },
];

const CURSOR = (gid) => `power-armor:cursor:${gid}`;
const HANGAR = (gid) => `power-armor:hangar:${gid}`;
const HANGAR_CAP = 500;

// Twitch tier strings ("1000"/"2000"/"3000") -> 1/2/3.
export function normTier(t) {
  const n = parseInt(String(t || ''), 10);
  if (n >= 3000) return 3;
  if (n >= 2000) return 2;
  if (n >= 1000) return 1;
  return (n >= 1 && n <= 3) ? n : null;
}

async function nextVariant(env, gid) {
  let i = 0;
  try { i = parseInt(await env.LOADOUT_BOLTS.get(CURSOR(gid)) || '0', 10) || 0; } catch { /* ignore */ }
  const v = POWER_ARMOR[((i % POWER_ARMOR.length) + POWER_ARMOR.length) % POWER_ARMOR.length];
  try { await env.LOADOUT_BOLTS.put(CURSOR(gid), String((i + 1) % POWER_ARMOR.length)); } catch { /* ignore */ }
  return v;
}

// Drop `count` crates: assign variants, fire a vertibird.drop per crate, and
// append to the hangar collection. The overlay paces multiple drops itself.
export async function dropPowerArmor(env, gid, { gifter, tier, count = 1 } = {}) {
  if (!gid) return { drops: [] };
  const n = Math.max(1, Math.min(parseInt(count, 10) || 1, 50));
  const t = normTier(tier);
  const ts = Date.now();
  const drops = [];
  for (let k = 0; k < n; k++) {
    const v = await nextVariant(env, gid);
    drops.push({ variant: v.id, name: v.name });
    await publishActivity(env, {
      kind: 'vertibird.drop', variant: v.id, name: v.name,
      gifter: gifter || 'A viewer', tier: t,
    }).catch(() => {});
  }
  try {
    const list = (await env.LOADOUT_BOLTS.get(HANGAR(gid), { type: 'json' })) || [];
    for (const d of drops) list.push({ variant: d.variant, gifter: gifter || 'A viewer', tier: t, ts });
    await env.LOADOUT_BOLTS.put(HANGAR(gid), JSON.stringify(list.slice(-HANGAR_CAP)));
  } catch { /* best-effort */ }
  return { drops };
}

// Aggregated collection for the hangar overlay + page.
export async function getHangar(env, gid) {
  let list = [];
  try { list = (await env.LOADOUT_BOLTS.get(HANGAR(gid), { type: 'json' })) || []; } catch { /* ignore */ }
  const by = {};
  for (const d of list) {
    const e = by[d.variant] || (by[d.variant] = { count: 0, drops: [] });
    e.count += 1;
    e.drops.push({ gifter: d.gifter, tier: d.tier, ts: d.ts });
  }
  const variants = POWER_ARMOR.map((p) => ({
    id: p.id, name: p.name,
    count: (by[p.id] && by[p.id].count) || 0,
    drops: (by[p.id] && by[p.id].drops.slice(-12)) || [],
  }));
  return { total: list.length, owned: variants.filter((v) => v.count > 0).length, variants };
}
