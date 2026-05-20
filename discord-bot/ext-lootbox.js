// Tier 3 — Bits-fueled loot boxes.
//
// POST /ext/lootbox/roll  (JWT-gated, Bits-receipt-gated):
//   body: { bits: <transactionReceipt JWT from Twitch.ext.bits.useBits> }
// On valid receipt (topic=bits_transaction_receipt, sku=loot_box) it:
//   - reads the curated catalog from KV (or the default below)
//   - rolls one item weighted by rarity
//   - appends it to the viewer's existing hero bag KV (same shape as
//     dungeon drops + shop buys — so loot lands in the regular bag)
//   - returns the rolled item
//
// GET  /ext/lootbox/catalog  (JWT-gated, read-only): returns the active
// catalog so the panel can show what's in the pool.
//
// The companion editor lives on aquilo-site Pages Functions at
// /api/admin/lootbox/catalog (owner-cookie-gated). Both surfaces write
// to LOADOUT_BOLTS under the key below, so Clay can edit the catalog
// without redeploying the Worker.

import { json } from './ext-shared.js';
import { verifyBitsReceipt } from './auth.js';

const CATALOG_KEY = 'lootbox:catalog:v1';
const PRODUCT_SKU = 'loot_box';

// Shipped if the KV catalog hasn't been authored yet. Curated to ~12
// items (1 legendary, 2 epic, 3 rare, 6 common) by hand from
// discord-bot/dungeon.js SHOP_POOL so the loot looks at home next to
// what dungeons and the shop already drop.
// Glyphs are intentionally empty -- new standing rule (2026-05) is
// custom pixel-art sprites only, no emoji. The website + Twitch panel
// pick a sprite by item.slot (and/or name) at render time. Leaving the
// `glyph` field present-but-empty preserves the existing object shape
// so any callers that destructure { glyph } don't crash.
export const DEFAULT_CATALOG = {
  items: [
    // common
    { slot: 'weapon',  rarity: 'common',    name: 'Wooden Sword',   glyph: '', powerBonus: 1, defenseBonus: 0, ability: '',         goldValue: 40 },
    { slot: 'head',    rarity: 'common',    name: 'Leather Cap',    glyph: '', powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 45 },
    { slot: 'chest',   rarity: 'common',    name: 'Hide Vest',      glyph: '', powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 40 },
    { slot: 'legs',    rarity: 'common',    name: 'Hempen Trousers', glyph: '', powerBonus: 0, defenseBonus: 1, ability: '',       goldValue: 40 },
    { slot: 'boots',   rarity: 'common',    name: 'Worn Boots',     glyph: '', powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 40 },
    { slot: 'trinket', rarity: 'common',    name: 'Lucky Coin',     glyph: '', powerBonus: 1, defenseBonus: 0, ability: 'lucky',    goldValue: 70 },
    // rare
    { slot: 'weapon',  rarity: 'rare',      name: 'Flamberge',      glyph: '', powerBonus: 5, defenseBonus: 0, ability: '',         goldValue: 540 },
    { slot: 'chest',   rarity: 'rare',      name: 'Dragonscale Plate', glyph: '', powerBonus: 2, defenseBonus: 4, ability: '',      goldValue: 650 },
    { slot: 'trinket', rarity: 'rare',      name: 'Crystal Pendant', glyph: '', powerBonus: 2, defenseBonus: 2, ability: '',        goldValue: 500 },
    // epic
    { slot: 'weapon',  rarity: 'epic',      name: 'Shadowfang',     glyph: '', powerBonus: 7, defenseBonus: 1, ability: '',         goldValue: 1200 },
    { slot: 'chest',   rarity: 'epic',      name: 'Mithril Plate',  glyph: '', powerBonus: 2, defenseBonus: 7, ability: 'wardstone', goldValue: 1300 },
    // legendary
    { slot: 'weapon',  rarity: 'legendary', name: 'Excalibur',      glyph: '', powerBonus: 10, defenseBonus: 2, ability: '',        goldValue: 3000 },
  ],
  // Per-rarity selection weights — drawing the rarity tier first, then a
  // uniform item within. Sums don't need to be 100; ratios are what
  // matters. Tuned so legendaries feel rare but reachable over a session
  // of bits spending.
  weights: { common: 60, rare: 25, epic: 12, legendary: 3 },
};

const HERO_KEY = (guild, userId) => `hero:${guild}:${userId}`;

// ── Free-loot-box allowances (per stream) ─────────────────────────────
//   - Twitch subscriber:  1 / stream
//   - Patron (tier >= 1): 3 / stream
//   - Both: the larger of the two (no stacking).
//
// "Per stream" is keyed off `recap:streamLiveStamp` (the live-online
// epoch ms written by aquilo-site's EventSub receiver and deleted on
// stream.offline). New stream -> fresh stamp -> fresh counter.
// Counter TTL = 25h so the record self-cleans even if stream.offline
// fires later than expected.

const FREE_COUNTER_KEY = (guild, userId, stamp) =>
  `lbfree:${guild}:${userId}:${stamp}`;
const STREAM_LIVE_KEY = 'recap:streamLiveStamp';
const TW_PATREON_KEY = (userId) => `tw_patreon:${userId}`;
const FREE_COUNTER_TTL = 25 * 60 * 60; // 25h

const SUB_ALLOWANCE = 1;
const PATRON_ALLOWANCE = 3;

async function currentStreamStamp(env) {
  try {
    const v = await env.LOADOUT_BOLTS.get(STREAM_LIVE_KEY);
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

// Read the panel's tw->Patreon mapping (populated by aquilo-site's
// /api/link/callback when the viewer linked through the panel). No
// fallback to wallet.links here — keep this path narrow and explicit.
async function isPatronTw(env, userId) {
  try {
    const map = await env.LOADOUT_BOLTS.get(TW_PATREON_KEY(userId), {
      type: 'json',
    });
    return !!(map && Number(map.tier || 0) >= 1);
  } catch {
    return false;
  }
}

async function freeAllowance(env, userId, subscribed) {
  const patron = await isPatronTw(env, userId);
  let cap = 0;
  if (patron) cap = Math.max(cap, PATRON_ALLOWANCE);
  if (subscribed) cap = Math.max(cap, SUB_ALLOWANCE);
  return { allowance: cap, patron, subscribed: !!subscribed };
}

async function getUsed(env, key) {
  try {
    const v = await env.LOADOUT_BOLTS.get(key);
    return parseInt(v || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function buildRolledItem(pick) {
  return {
    id: newItemId(),
    slot: pick.slot || '',
    rarity: pick.rarity || 'common',
    name: pick.name || '',
    glyph: pick.glyph || '',
    powerBonus: pick.powerBonus || 0,
    defenseBonus: pick.defenseBonus || 0,
    ability: pick.ability || '',
    goldValue: pick.goldValue || 0,
    setName: pick.setName || '',
    weaponType: pick.weaponType || '',
    foundIn: 'Loot Box',
    foundUtc: new Date().toISOString(),
  };
}

async function appendToBag(env, guildId, userId, item) {
  const key = HERO_KEY(guildId, userId);
  const hero = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {};
  if (!Array.isArray(hero.bag)) hero.bag = [];
  hero.bag.push(item);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(hero));
}

async function loadCatalog(env) {
  try {
    const c = await env.LOADOUT_BOLTS.get(CATALOG_KEY, { type: 'json' });
    if (c && Array.isArray(c.items) && c.items.length > 0) return c;
  } catch { /* fall through to default */ }
  return DEFAULT_CATALOG;
}

function rollItem(catalog, rng) {
  const r = rng || Math.random;
  const weights = catalog.weights || DEFAULT_CATALOG.weights;
  const byRarity = {};
  for (const it of catalog.items) {
    const k = String(it.rarity || 'common').toLowerCase();
    (byRarity[k] = byRarity[k] || []).push(it);
  }
  // Roll a rarity tier weighted, then a uniform item within.
  const tiers = Object.keys(weights).filter((k) => byRarity[k] && byRarity[k].length > 0);
  if (tiers.length === 0) return null;
  const total = tiers.reduce((s, k) => s + Math.max(0, weights[k] || 0), 0);
  let pick = r() * total;
  let chosenTier = tiers[0];
  for (const k of tiers) {
    pick -= Math.max(0, weights[k] || 0);
    if (pick <= 0) { chosenTier = k; break; }
  }
  const pool = byRarity[chosenTier];
  return pool[Math.floor(r() * pool.length)];
}

// Stable-enough item id: same shape DungeonGameStore uses (32-char
// lower-hex GUID).
function newItemId() {
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

// JWT-gated. handleExt has already verified the JWT + channel gate;
// we just need to validate the Bits receipt the panel sends with the
// roll and write the result into the same hero KV the rest of /ext
// (and the dungeon engine) uses.
export async function rollLootBox(env, guildId, userId, req) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }

  const receipt = await verifyBitsReceipt(body && body.bits, env.TWITCH_EXT_SECRET);
  const product = receipt && receipt.data && receipt.data.product;
  if (
    !receipt ||
    receipt.topic !== 'bits_transaction_receipt' ||
    !product ||
    product.sku !== PRODUCT_SKU
  ) {
    return json({ error: 'bad-payment' }, 402);
  }

  const catalog = await loadCatalog(env);
  const pick = rollItem(catalog);
  if (!pick) return json({ error: 'empty-catalog' }, 500);

  const item = buildRolledItem(pick);
  // Append to the hero's bag. The dungeon engine + shop write to the
  // same key with the same shape, so the new item shows up in the
  // existing /ext/loadout/inventory render without any panel changes.
  await appendToBag(env, guildId, userId, item);

  return json({ ok: true, item: item });
}

// JWT-gated free-loot-box roll. Allowed when:
//   - a stream is currently live (recap:streamLiveStamp present)
//   - the viewer has free boxes remaining this stream
//   - eligibility: subscribers get 1/stream, patrons get 3/stream
//     (linked via tw_patreon:<userId> by aquilo-site's panel-driven
//     Patreon link flow), the larger of the two when both apply.
//
// subscribed: passed by the panel as ?subscribed=1 from
// Twitch.ext.viewer.subscriptionStatus — the JWT itself doesn't carry
// subscription state, same pattern Tier-1 patron-corner uses.
export async function rollLootBoxFree(env, guildId, userId, req) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const url = new URL(req.url);
  const subscribed = url.searchParams.get('subscribed') === '1';

  const stamp = await currentStreamStamp(env);
  if (!stamp) {
    return json(
      { error: 'no-stream', message: 'No stream is live right now.' },
      400,
    );
  }
  const { allowance, patron } = await freeAllowance(env, userId, subscribed);
  if (allowance <= 0) {
    return json(
      {
        error: 'not-eligible',
        message:
          'Free loot boxes are for Twitch subscribers (1/stream) and Patrons (3/stream).',
      },
      402,
    );
  }

  const counterKey = FREE_COUNTER_KEY(guildId, userId, stamp);
  const used = await getUsed(env, counterKey);
  if (used >= allowance) {
    return json(
      { error: 'allowance-exceeded', allowance, used, remaining: 0, patron, subscribed },
      429,
    );
  }

  const catalog = await loadCatalog(env);
  const pick = rollItem(catalog);
  if (!pick) return json({ error: 'empty-catalog' }, 500);

  const item = buildRolledItem(pick);
  item.foundIn = 'Free Loot Box';
  await appendToBag(env, guildId, userId, item);

  // Increment AFTER the roll so a roll failure (catalog empty, KV
  // write throwing) doesn't burn a free box. KV is eventually
  // consistent — a fast double-click could in theory let a viewer
  // claim allowance+1 on rare occasions; the blast radius is small
  // enough that we don't pay the Durable-Objects price to avoid it.
  await env.LOADOUT_BOLTS.put(counterKey, String(used + 1), {
    expirationTtl: FREE_COUNTER_TTL,
  });

  return json({
    ok: true,
    item,
    allowance,
    used: used + 1,
    remaining: Math.max(0, allowance - (used + 1)),
    patron,
    subscribed,
  });
}

// GET /ext/lootbox/free-state — what the panel calls on load to decide
// whether to show a "Free loot box" button + how many are left.
export async function freeLootBoxState(env, guildId, userId, req) {
  const url = new URL(req.url);
  const subscribed = url.searchParams.get('subscribed') === '1';

  const stamp = await currentStreamStamp(env);
  const { allowance, patron } = await freeAllowance(env, userId, subscribed);

  if (!stamp) {
    return json({
      live: false,
      allowance,
      used: 0,
      remaining: 0,
      patron,
      subscribed: !!subscribed,
    });
  }
  if (allowance <= 0) {
    return json({
      live: true,
      allowance: 0,
      used: 0,
      remaining: 0,
      patron,
      subscribed: !!subscribed,
    });
  }
  const used = await getUsed(env, FREE_COUNTER_KEY(guildId, userId, stamp));
  return json({
    live: true,
    allowance,
    used,
    remaining: Math.max(0, allowance - used),
    patron,
    subscribed: !!subscribed,
  });
}

// JWT-gated read so the panel can preview the pool (and Clay can sanity-
// check what would drop without spending bits).
export async function readLootBoxCatalog(env) {
  const c = await loadCatalog(env);
  return json({ catalog: c, sku: PRODUCT_SKU, bits: 50 });
}
