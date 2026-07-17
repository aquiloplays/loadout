// Tier 3, Bits-fueled community loot boxes.
//
// POST /ext/lootbox/roll  (JWT-gated, Bits-receipt-gated):
//   body: { bits: <transactionReceipt JWT from Twitch.ext.bits.useBits> }
// On valid receipt (topic=bits_transaction_receipt, sku=loot_box) the
// purchase fans out to the whole audience, every viewer who currently
// has the panel open (tracked by the presence key below) gets one box
// rolled into their bag, including the buyer. One purchase, one box for
// each watcher. (Clay 2026-05: this is now a community grant, not a
// single-viewer purchase.)
//
// Purchases are extension-only, verified via verifyBitsReceipt against
// TWITCH_EXT_SECRET. There is no other purchase path (no website
// purchase, no admin grant, no slash-command buy). The website
// /api/admin/lootbox/catalog endpoint only edits the catalog; it never
// mints a box.
//
// GET  /ext/lootbox/catalog  (JWT-gated, read-only): returns the active
// catalog so the panel can show what's in the pool.
//
// GET  /ext/lootbox/grants   (JWT-gated): drains the caller's pending
// "you received a community loot box" notifications so the panel can
// show a toast for boxes minted into the bag by someone else's purchase.
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
// 2026-06 archive: the dungeon RPG, Hero paper-doll, Clash, Vault, and Pet
// were removed, so their gear/item drops are gone. The loot pool is now
// Boltbound-economy only, Bolts, Aether, and Boltbound packs. Bolts/Aether
// `slot:'bolts'|'aether'` entries credit the wallet / aether ledger;
// `slot:'pack'` mints a pending Boltbound pack via cards-packs.creditPack.
export const DEFAULT_CATALOG = {
  items: [
    // Bolts, the staple drop, amount scaled by rarity tier.
    { slot: 'bolts',  rarity: 'common',    name: '60 Bolts',    glyph: '', amount: 60 },
    { slot: 'bolts',  rarity: 'common',    name: '120 Bolts',   glyph: '', amount: 120 },
    { slot: 'bolts',  rarity: 'rare',      name: '300 Bolts',   glyph: '', amount: 300 },
    { slot: 'bolts',  rarity: 'epic',      name: '800 Bolts',   glyph: '', amount: 800 },
    { slot: 'bolts',  rarity: 'legendary', name: '2,000 Bolts', glyph: '', amount: 2000 },
    // Aether, premium currency, rarer tiers only.
    { slot: 'aether', rarity: 'rare',      name: '5 Aether',    glyph: '', amount: 5 },
    { slot: 'aether', rarity: 'epic',      name: '15 Aether',   glyph: '', amount: 15 },
    { slot: 'aether', rarity: 'legendary', name: '40 Aether',   glyph: '', amount: 40 },
    // Boltbound packs, credited via cards-packs.creditPack.
    { slot: 'pack',   rarity: 'common',    name: 'Boltbound Common Pack',  glyph: '', packType: 'common',  goldValue: 0 },
    { slot: 'pack',   rarity: 'rare',      name: 'Boltbound Bolt Pack',    glyph: '', packType: 'bolt',    goldValue: 0 },
    { slot: 'pack',   rarity: 'epic',      name: 'Boltbound Voltaic Pack', glyph: '', packType: 'voltaic', goldValue: 0 },
  ],
  // Per-rarity selection weights, draw a rarity tier, then a uniform item
  // within. Ratios matter, not the sum. Tuned so legendaries feel rare but
  // reachable over a session of bits spending.
  weights: { common: 54, rare: 28, epic: 14, legendary: 4 },
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
// fallback to wallet.links here, keep this path narrow and explicit.
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

// ── Community fan-out ────────────────────────────────────────────────
//
// presence:<guild>:<userId>, last-seen ms, 5-min TTL. Stamped from
// handleExt on every /ext/* request, so viewers who close the panel
// age out and the fan-out hits an accurate "who's watching with the
// panel open right now" set.
//
// lbgrant:<guild>:<recipient>:<grantId>, pending "you got a community
// loot box from <buyer>" notification, drained by GET /ext/lootbox/grants
// when the panel comes back to the foreground. The item itself is
// already in the recipient's bag; this record is purely so the panel
// can show a toast.
//
// Fan-out is capped at MAX_GRANT_RECIPIENTS. KV list pagination and
// the per-request Worker budget mean an uncapped fan-out to thousands
// would risk hitting limits; in practice the panel-open count is much
// smaller than that.

const PRESENCE_KEY = (guild, userId) => `presence:${guild}:${userId}`;
const PRESENCE_PREFIX = (guild) => `presence:${guild}:`;
const PRESENCE_TTL = 5 * 60; // 5 minutes
const GRANT_KEY = (guild, recipient, gid) =>
  `lbgrant:${guild}:${recipient}:${gid}`;
const GRANT_PREFIX = (guild, recipient) => `lbgrant:${guild}:${recipient}:`;
const GRANT_TTL = 60 * 60; // 1h, panel has an hour to surface the toast
const MAX_GRANT_RECIPIENTS = 500;

export async function stampPresence(env, guildId, userId) {
  try {
    await env.LOADOUT_BOLTS.put(
      PRESENCE_KEY(guildId, userId),
      String(Date.now()),
      { expirationTtl: PRESENCE_TTL },
    );
  } catch { /* presence is best-effort */ }
}

async function listCurrentViewers(env, guildId) {
  const seen = new Set();
  let cursor = undefined;
  for (let i = 0; i < 4; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: PRESENCE_PREFIX(guildId),
      cursor,
      limit: 1000,
    });
    for (const k of page.keys) {
      const id = k.name.slice(PRESENCE_PREFIX(guildId).length);
      if (id) seen.add(id);
      if (seen.size >= MAX_GRANT_RECIPIENTS) return Array.from(seen);
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return Array.from(seen);
}

// Credit a Bolts / Aether currency drop and return a toast-shaped record.
async function grantCurrency(env, guildId, recipientId, pick) {
  const amount = Number(pick.amount) || 0;
  if (pick.slot === 'bolts') {
    const { applyVaultDelta } = await import('./wallet.js');
    await applyVaultDelta(env, guildId, recipientId, amount, 'lootbox');
  } else if (pick.slot === 'aether') {
    const { grantAether } = await import('./aether.js');
    await grantAether(env, guildId, recipientId, amount, 'lootbox');
  }
  return {
    id: newItemId(),
    slot: pick.slot,
    rarity: pick.rarity || 'common',
    name: pick.name || '',
    amount,
    glyph: pick.glyph || '',
    foundUtc: new Date().toISOString(),
  };
}

async function grantOneTo(env, guildId, recipientId, catalog, buyerId) {
  const pick = rollItem(catalog);
  if (!pick) return null;
  // Boltbound pack drop, slot:'pack' entries don't land in the gear
  // bag; they mint a pending Boltbound pack via cards-packs.creditPack.
  // See CARD-GAME-DESIGN.md §4.1.
  if (pick.slot === 'pack' && pick.packType) {
    const { creditPack } = await import('./cards-packs.js');
    const credited = await creditPack(env, guildId, recipientId, pick.packType, 'lootbox');
    if (!credited.ok) return null;
    const packItem = {
      id: newItemId(),
      slot: 'pack',
      rarity: pick.rarity || 'common',
      name: pick.name || 'Boltbound Pack',
      packType: pick.packType,
      packId: credited.pack.id,
      foundIn: recipientId === buyerId ? 'Community Loot Box (yours)' : 'Community Loot Box',
      foundUtc: new Date().toISOString(),
    };
    // Pack notification ride the same grant ring buffer so the panel
    // can toast "you got a Boltbound Bolt Pack". The pack itself is
    // already pending under cards:pending, open it via /boltbound.
    if (recipientId !== buyerId) {
      const gid = newItemId().slice(0, 12);
      try {
        await env.LOADOUT_BOLTS.put(
          GRANT_KEY(guildId, recipientId, gid),
          JSON.stringify({ item: packItem, fromUserId: buyerId, ts: Date.now() }),
          { expirationTtl: GRANT_TTL },
        );
      } catch { /* idle */ }
    }
    return packItem;
  }
  // Bolts / Aether currency drop, credited to the wallet / aether ledger.
  if (pick.slot === 'bolts' || pick.slot === 'aether') {
    const item = await grantCurrency(env, guildId, recipientId, pick);
    item.foundIn = recipientId === buyerId ? 'Community Loot Box (yours)' : 'Community Loot Box';
    if (recipientId !== buyerId) {
      const gid = newItemId().slice(0, 12);
      try {
        await env.LOADOUT_BOLTS.put(
          GRANT_KEY(guildId, recipientId, gid),
          JSON.stringify({ item, fromUserId: buyerId, ts: Date.now() }),
          { expirationTtl: GRANT_TTL },
        );
      } catch { /* toast is best-effort */ }
    }
    return item;
  }
  const item = buildRolledItem(pick);
  item.foundIn = recipientId === buyerId ? 'Community Loot Box (yours)' : 'Community Loot Box';
  await appendToBag(env, guildId, recipientId, item);
  // Notification record so the recipient's panel can toast. Skip for
  // the buyer, they get the box back in the response body directly.
  if (recipientId !== buyerId) {
    const gid = newItemId().slice(0, 12);
    try {
      await env.LOADOUT_BOLTS.put(
        GRANT_KEY(guildId, recipientId, gid),
        JSON.stringify({ item, fromUserId: buyerId, ts: Date.now() }),
        { expirationTtl: GRANT_TTL },
      );
    } catch { /* toast is best-effort, the item is already in the bag */ }
  }
  return item;
}

// JWT-gated. handleExt has already verified the JWT + channel gate;
// we just need to validate the Bits receipt the panel sends with the
// purchase, then fan out a roll to every currently-present viewer.
// The buyer always gets a roll; everyone else who's watching with the
// panel open gets one too. Counted by the presence KV.
export async function rollLootBox(env, guildId, userId, req, ctx) {
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
  // Grant the buyer's own box up front so we can return it in the
  // response, the buyer always gets at least one, even if presence
  // listing somehow misses them (race with the TTL).
  const buyerItem = await grantOneTo(env, guildId, userId, catalog, userId);
  if (!buyerItem) return json({ error: 'empty-catalog' }, 500);

  const viewers = await listCurrentViewers(env, guildId);
  // Strip the buyer from the fan-out, they already got their box.
  const others = viewers.filter((id) => id !== userId);

  // Async fan-out. The buyer's response returns immediately; the other
  // recipients' boxes land within seconds. ctx.waitUntil keeps the
  // worker invocation alive past the response so the puts complete.
  const fanout = (async () => {
    for (const recipient of others) {
      try {
        await grantOneTo(env, guildId, recipient, catalog, userId);
      } catch { /* one bad recipient shouldn't break the rest */ }
    }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(fanout);
  } else {
    await fanout;
  }

  return json({
    ok: true,
    item: buyerItem,
    community: { recipients: others.length + 1 },
  });
}

// JWT-gated. Pops every pending community-grant notification for the
// caller. Each entry carries the rolled item + buyer id so the panel
// can render "you received a <rarity> <name> from <viewer>".
export async function drainLootBoxGrants(env, guildId, userId) {
  const prefix = GRANT_PREFIX(guildId, userId);
  const list = await env.LOADOUT_BOLTS.list({ prefix, limit: 50 });
  const grants = [];
  for (const k of list.keys) {
    try {
      const v = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (v) grants.push(v);
    } catch { /* skip malformed */ }
    try { await env.LOADOUT_BOLTS.delete(k.name); } catch { /* idle */ }
  }
  return json({ ok: true, grants });
}

// JWT-gated free-loot-box roll. Allowed when:
//   - a stream is currently live (recap:streamLiveStamp present)
//   - the viewer has free boxes remaining this stream
//   - eligibility: subscribers get 1/stream, patrons get 3/stream
//     (linked via tw_patreon:<userId> by aquilo-site's panel-driven
//     Patreon link flow), the larger of the two when both apply.
//
// subscribed: passed by the panel as ?subscribed=1 from
// Twitch.ext.viewer.subscriptionStatus, the JWT itself doesn't carry
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

  // Boltbound pack, mint via cards-packs.creditPack instead of bag.
  let item;
  if (pick.slot === 'pack' && pick.packType) {
    const { creditPack } = await import('./cards-packs.js');
    const credited = await creditPack(env, guildId, userId, pick.packType, 'lootbox-free');
    if (!credited.ok) return json({ error: 'pack-credit-failed' }, 500);
    item = {
      id: newItemId(),
      slot: 'pack',
      rarity: pick.rarity || 'common',
      name: pick.name || 'Boltbound Pack',
      packType: pick.packType,
      packId: credited.pack.id,
      foundIn: 'Free Loot Box',
      foundUtc: new Date().toISOString(),
    };
  } else if (pick.slot === 'bolts' || pick.slot === 'aether') {
    item = await grantCurrency(env, guildId, userId, pick);
    item.foundIn = 'Free Loot Box';
  } else {
    item = buildRolledItem(pick);
    item.foundIn = 'Free Loot Box';
    await appendToBag(env, guildId, userId, item);
  }

  // Increment AFTER the roll so a roll failure (catalog empty, KV
  // write throwing) doesn't burn a free box. KV is eventually
  // consistent, a fast double-click could in theory let a viewer
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

// GET /ext/lootbox/free-state, what the panel calls on load to decide
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

// ── Bolts gacha (2026-07-15 revival) ─────────────────────────────────────────
// Personal Bolts-priced pulls, reusing this module's rarity/roll machinery on
// a DEDICATED gacha catalog (`lootbox:gacha:v1`) — the Bits community catalog
// above was tuned for real-money purchases and is tied to the sunset hero bag.
// Prizes: `bolts` credit the live wallet EXACTLY (no booster multiplier, so
// the tuned EV holds); everything else lands in a collectible badge bag.
// Pity: an epic-or-better is guaranteed every `pityAt` pulls.
// Default EV ≈ 79 Bolts per 100-Bolt pull — a sink, never a faucet.

import { getWallet as gwGacha, putWallet as pwGacha, spend as spendGacha } from './wallet.js';

const GACHA_KEY = 'lootbox:gacha:v1';
const GACHA_BAG = (g, u) => `lootbag:${g}:${u}`;

export const GACHA_DEFAULT = {
  pullCost: 100,
  pityAt: 8,
  weights: { common: 62, rare: 26, epic: 9.5, legendary: 2.5 },
  items: [
    { slot: 'bolts', rarity: 'common',    name: '40 Bolts',  amount: 40 },
    { slot: 'bolts', rarity: 'common',    name: '60 Bolts',  amount: 60 },
    { slot: 'bolts', rarity: 'common',    name: '80 Bolts',  amount: 80 },
    { slot: 'badge', rarity: 'common',    name: 'Rusty Bolt',    glyph: '🔩' },
    { slot: 'badge', rarity: 'common',    name: 'Paper Clip',    glyph: '📎' },
    { slot: 'bolts', rarity: 'rare',      name: '150 Bolts', amount: 150 },
    { slot: 'bolts', rarity: 'rare',      name: '220 Bolts', amount: 220 },
    { slot: 'badge', rarity: 'rare',      name: 'Blue Feather',  glyph: '🪶' },
    { slot: 'badge', rarity: 'rare',      name: 'Static Charge', glyph: '⚡' },
    { slot: 'bolts', rarity: 'epic',      name: '450 Bolts', amount: 450 },
    { slot: 'badge', rarity: 'epic',      name: 'Storm Crown',   glyph: '👑' },
    { slot: 'badge', rarity: 'epic',      name: 'Violet Flame',  glyph: '🔮' },
    { slot: 'bolts', rarity: 'legendary', name: '1,500 Bolts', amount: 1500 },
    { slot: 'badge', rarity: 'legendary', name: 'Golden Aquilo', glyph: '🐦' },
  ],
};

async function loadGachaCatalog(env) {
  try {
    const c = await env.LOADOUT_BOLTS.get(GACHA_KEY, { type: 'json' });
    if (c && Array.isArray(c.items) && c.items.length) return c;
  } catch { /* fall through */ }
  return GACHA_DEFAULT;
}

// Pity roll: restrict the rarity draw to epic+legendary (keeping their
// relative ratio); falls back to a normal roll if those pools are empty.
function rollGacha(catalog, forceEpicPlus) {
  if (!forceEpicPlus) return rollItem(catalog);
  const w = catalog.weights || GACHA_DEFAULT.weights;
  const hi = Object.assign({}, catalog, { weights: { epic: Math.max(0.0001, w.epic || 0), legendary: Math.max(0.0001, w.legendary || 0) } });
  return rollItem(hi) || rollItem(catalog);
}

export async function handleGacha(env, guildId, userId, sub, req, gameMeta) {
  if (req.method === 'OPTIONS') return json({ ok: true });
  const cat = await loadGachaCatalog(env);
  const cost = Math.max(1, Math.floor(cat.pullCost || 100));
  const pityAt = Math.max(2, Math.floor(cat.pityAt || 8));
  const bagKey = GACHA_BAG(guildId, userId);
  const bag = (await env.LOADOUT_BOLTS.get(bagKey, { type: 'json' }).catch(() => null)) || { badges: [], pulls: 0, pity: 0 };

  if (sub === 'state' || sub === '') {
    const w = await gwGacha(env, guildId, userId);
    return json({
      ok: true, cost, pityAt, pity: bag.pity || 0, pulls: bag.pulls || 0,
      badges: (bag.badges || []).slice(-24).reverse(), balance: w.balance || 0,
      preview: cat.items.map((i) => ({ name: i.name, rarity: i.rarity || 'common', slot: i.slot, glyph: i.glyph || '' })),
    });
  }

  if (sub === 'pull' && req.method === 'POST') {
    const sp = await spendGacha(env, guildId, userId, cost, 'gacha pull');
    if (!sp.ok) return json({ ok: false, error: 'insufficient', balance: sp.balance || 0, need: cost }, 402);
    const pityHit = (bag.pity || 0) + 1 >= pityAt;
    const item = rollGacha(cat, pityHit) || { slot: 'bolts', rarity: 'common', name: cost + ' Bolts back', amount: cost };
    const rare = ['epic', 'legendary'].indexOf(String(item.rarity || '').toLowerCase()) !== -1;
    bag.pulls = (bag.pulls || 0) + 1;
    bag.pity = rare ? 0 : (bag.pity || 0) + 1;
    let balance = (sp.wallet && sp.wallet.balance) || 0;
    if (item.slot === 'bolts' && item.amount > 0) {
      // Exact credit (earn() would apply the booster multiplier and break EV).
      const w = await gwGacha(env, guildId, userId);
      w.balance += Math.floor(item.amount);
      w.lifetimeEarned = (w.lifetimeEarned || 0) + Math.floor(item.amount);
      await pwGacha(env, guildId, userId, w);
      balance = w.balance;
    } else {
      bag.badges = (bag.badges || []).concat([{ name: item.name, rarity: item.rarity || 'common', glyph: item.glyph || '', at: Date.now() }]).slice(-60);
    }
    await env.LOADOUT_BOLTS.put(bagKey, JSON.stringify(bag));
    return json({
      ok: true,
      prize: { name: item.name, rarity: item.rarity || 'common', slot: item.slot, glyph: item.glyph || '', amount: Math.floor(item.amount || 0) },
      pityHit, pity: bag.pity, pityAt, balance,
      badges: (bag.badges || []).slice(-24).reverse(),
    });
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
