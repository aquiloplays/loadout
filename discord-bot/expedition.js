// Expeditions — the hero embarks on a multi-hour journey, encounters
// random events while away, eats supplies in combat, and may die if
// the backpack runs dry against a strong enemy.
//
// Time model: stateless. Departure stamps `embarkUtc` + `returnUtc`
// + an event schedule (one event per "tick" — 30 min default, jitter
// added for flavour). Resolution is pure: given the hero, backpack,
// and schedule, walk the events deterministically (seeded by the
// expedition id) and produce a result. The cron tick + the player's
// own status-check call both run the same resolver — whichever fires
// first finalizes. No background work required.
//
// KV layout:
//   expedition:active:<guildId>:<userId>   one active expedition per hero
//   expedition:hist:<guildId>:<userId>     ring of recent expeditions (cap 10)
//
// Death consequence (sensible, not rage-inducing):
//   • Hero HP → 1 (not zero — they limp home, alive)
//   • Loose half the gold collected this expedition (kept loot stays)
//   • 6h "infirmary" cooldown before next embark
//   • Equipped gear is NOT destroyed
//
// Reuses existing systems:
//   attackOf / defenseOf from dungeon.js for combat strength
//   creditPack            from cards-packs.js for Boltbound pack drops
//   addResources          from clash-resources.js for Clash mat drops
//   addFragments          from cards-fragments.js for fragments
//   applyVaultDelta       from wallet.js for bolts payout
//
// Public API:
//   startExpedition(env, guildId, userId, { hours, backpack })
//   checkExpedition(env, guildId, userId)
//   claimExpedition(env, guildId, userId)
//   buyBackpackItem(env, guildId, userId, itemId, count)
//   listBackpackCatalog()        sync — supply-store catalog
//
// HTTP wiring lives in web.js (handleExpeditionWeb dispatch).

import { loadHero, attackOf, defenseOf } from './dungeon.js';
import { applyVaultDelta, getWallet } from './wallet.js';

// ── Tuning ──────────────────────────────────────────────────────

const MIN_HOURS = 1;
const MAX_HOURS = 24;
const TICK_MS   = 30 * 60_000;             // 1 event per 30 min nominal
const INFIRMARY_COOLDOWN_MS = 6 * 3_600_000;
const HIST_CAP  = 10;

// Per-tick event-kind weights. Combat is the headline, but most
// ticks should be quieter so a 24h expedition isn't 48 fights.
const EVENT_WEIGHTS = [
  { kind: 'combat',   weight: 30 },
  { kind: 'loot',     weight: 22 },
  { kind: 'forage',   weight: 15 },
  { kind: 'pack',     weight: 10 },
  { kind: 'material', weight: 10 },
  { kind: 'rest',     weight:  8 },
  { kind: 'trap',     weight:  5 },
];

// ── Backpack catalog ────────────────────────────────────────────
//
// Supplies the player can stuff into the pack before embarking.
// Costs are bolt amounts charged at purchase time (so they don't
// reset on every embark — leftover supplies persist in the active
// pack). Effects fire during combat in the order listed.

export const BACKPACK_CATALOG = {
  bandage:    { name: 'Bandage',     cost: 25,  heal: 8,                  desc: '+8 HP in combat when the hero is low.' },
  potion:     { name: 'Health Potion', cost: 75, heal: 25,                desc: '+25 HP — a meatier heal for tougher fights.' },
  elixir:     { name: 'Greater Elixir', cost: 200, heal: 60,              desc: '+60 HP. Pricey but a fight-saver.' },
  smokebomb:  { name: 'Smoke Bomb',  cost: 60,  flee: true,               desc: 'Auto-flee a combat encounter (no rewards but no damage).' },
  warhorn:    { name: 'War Horn',    cost: 120, atkBoost: 5,              desc: '+5 ATK on a single combat encounter.' },
  ration:     { name: 'Trail Ration', cost: 10, foragePerTick: 1,         desc: 'Tiny passive bolt-yield per quiet tick.' },
  torch:      { name: 'Torch',       cost: 40,  trapShield: true,         desc: 'Negates one trap encounter.' },
};

export function listBackpackCatalog() {
  return Object.entries(BACKPACK_CATALOG).map(([id, def]) => ({ id, ...def }));
}

// ── Storage helpers ─────────────────────────────────────────────

const ACTIVE_KEY = (g, u) => `expedition:active:${g}:${u}`;
const HIST_KEY   = (g, u) => `expedition:hist:${g}:${u}`;

export async function readActive(env, guildId, userId) {
  return await env.LOADOUT_BOLTS.get(ACTIVE_KEY(guildId, userId), { type: 'json' });
}
async function writeActive(env, guildId, userId, rec) {
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY(guildId, userId), JSON.stringify(rec));
}
async function clearActive(env, guildId, userId) {
  await env.LOADOUT_BOLTS.delete(ACTIVE_KEY(guildId, userId));
}
async function appendHist(env, guildId, userId, finalRec) {
  const raw = (await env.LOADOUT_BOLTS.get(HIST_KEY(guildId, userId), { type: 'json' })) || [];
  raw.unshift(finalRec);
  if (raw.length > HIST_CAP) raw.length = HIST_CAP;
  await env.LOADOUT_BOLTS.put(HIST_KEY(guildId, userId), JSON.stringify(raw));
}

// ── Deterministic PRNG (Mulberry32) ─────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

function pickWeighted(rand, table) {
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = rand() * total;
  for (const e of table) { r -= e.weight; if (r <= 0) return e; }
  return table[0];
}

function randInt(rand, lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }

// ── Event resolver ──────────────────────────────────────────────
//
// Pure function: given the hero stats snapshot, a backpack contents
// map, and the schedule, walk ticks and produce an event log + final
// state. Re-runnable for read-only status checks (calls with the
// same id always produce the same log).

function snapshotHeroForExpedition(hero) {
  return {
    level: hero.level || 1,
    hpMax: hero.hpMax || 25,
    hpCurrent: hero.hpCurrent || hero.hpMax || 25,
    atk: attackOf(hero),
    def: defenseOf(hero),
    className: hero.className || '',
  };
}

function resolveExpedition(rec, nowUtc = Date.now()) {
  const seed = hashSeed(rec.id);
  const rand = mulberry32(seed);
  const hero = { ...rec.heroSnapshot };
  const pack = { ...(rec.backpack || {}) };
  const tickCount = rec.schedule.length;
  const elapsedTicks = Math.min(tickCount, Math.floor((nowUtc - rec.embarkUtc) / TICK_MS));
  const events = [];
  let bolts = 0;
  let fragments = 0;
  const materials = {};
  const packs = [];
  let died = false;

  for (let i = 0; i < elapsedTicks; i++) {
    if (died) break;
    const ev = rec.schedule[i];
    const utc = rec.embarkUtc + (i + 1) * TICK_MS;
    switch (ev.kind) {
      case 'combat': {
        const enemyPower = ev.power;
        const enemyHp    = ev.hp;
        // Smoke bomb? auto-flee.
        if (pack.smokebomb > 0) {
          pack.smokebomb--;
          events.push({ utc, kind: 'combat-flee', desc: `Smoke bomb — fled a level-${enemyPower} enemy.` });
          break;
        }
        // Warhorn? +5 atk this fight.
        let bonusAtk = 0;
        if (pack.warhorn > 0) { pack.warhorn--; bonusAtk = 5; }
        // Simple combat: rounds until one side drops. Hero deals
        // max(1, atk - enemyDef) per round; enemy deals max(1,
        // enemyPower - hero.def). Stops at first death.
        const enemyDef = Math.floor(enemyPower / 3);
        const heroDmg  = Math.max(1, hero.atk + bonusAtk - enemyDef);
        const enemyDmg = Math.max(1, enemyPower - hero.def);
        let eHp = enemyHp;
        while (eHp > 0 && hero.hpCurrent > 0) {
          eHp -= heroDmg;
          if (eHp <= 0) break;
          hero.hpCurrent -= enemyDmg;
          // Heal between rounds if low + supplies present.
          if (hero.hpCurrent > 0 && hero.hpCurrent < hero.hpMax * 0.4) {
            if (pack.elixir > 0)        { pack.elixir--;  hero.hpCurrent = Math.min(hero.hpMax, hero.hpCurrent + BACKPACK_CATALOG.elixir.heal); }
            else if (pack.potion > 0)   { pack.potion--;  hero.hpCurrent = Math.min(hero.hpMax, hero.hpCurrent + BACKPACK_CATALOG.potion.heal); }
            else if (pack.bandage > 0)  { pack.bandage--; hero.hpCurrent = Math.min(hero.hpMax, hero.hpCurrent + BACKPACK_CATALOG.bandage.heal); }
          }
        }
        if (hero.hpCurrent <= 0) {
          died = true;
          events.push({ utc, kind: 'combat-defeat', desc: `Fell to a level-${enemyPower} enemy. The hero limps home wounded.` });
          break;
        }
        const lootBolts = randInt(rand, 30, 90) + enemyPower * 4;
        bolts += lootBolts;
        events.push({ utc, kind: 'combat-victory', desc: `Defeated a level-${enemyPower} enemy. (+${lootBolts} bolts)`, bolts: lootBolts });
        break;
      }
      case 'loot': {
        const n = randInt(rand, 50, 180);
        bolts += n;
        events.push({ utc, kind: 'loot', desc: `Stumbled across a coin cache. (+${n} bolts)`, bolts: n });
        break;
      }
      case 'forage': {
        // Bonus from rations.
        const rations = pack.ration > 0 ? 10 : 0;
        if (rations) pack.ration--;
        const n = randInt(rand, 5, 20) + rations;
        bolts += n;
        events.push({ utc, kind: 'forage', desc: `Foraged the wilds. (+${n} bolts)`, bolts: n });
        break;
      }
      case 'pack': {
        const t = rand() < 0.15 ? 'rare' : 'common';
        packs.push(t);
        events.push({ utc, kind: 'pack', desc: `Found a Boltbound ${t} pack.`, packType: t });
        break;
      }
      case 'material': {
        const mats = ['wood', 'stone', 'iron', 'scrap'];
        const mat = mats[Math.floor(rand() * mats.length)];
        const amt = randInt(rand, 30, 120);
        materials[mat] = (materials[mat] || 0) + amt;
        events.push({ utc, kind: 'material', desc: `Quarried ${amt} ${mat}.`, material: mat, amount: amt });
        break;
      }
      case 'rest': {
        const heal = Math.min(hero.hpMax - hero.hpCurrent, randInt(rand, 5, 15));
        if (heal > 0) hero.hpCurrent += heal;
        events.push({ utc, kind: 'rest', desc: `Made camp and recovered ${heal} HP.`, heal });
        break;
      }
      case 'trap': {
        if (pack.torch > 0) {
          pack.torch--;
          events.push({ utc, kind: 'trap-avoided', desc: 'A torch revealed a trap before you stepped on it.' });
          break;
        }
        const dmg = randInt(rand, 8, 22);
        hero.hpCurrent -= dmg;
        if (hero.hpCurrent <= 0) {
          died = true;
          events.push({ utc, kind: 'trap-fatal', desc: `A trap dealt ${dmg} damage — the hero collapsed in the wilds.`, damage: dmg });
        } else {
          events.push({ utc, kind: 'trap', desc: `Sprung a trap for ${dmg} damage.`, damage: dmg });
        }
        const fragGain = randInt(rand, 2, 6);
        if (!died) {
          fragments += fragGain;
          events.push({ utc: utc + 1, kind: 'fragments', desc: `Salvaged ${fragGain} card fragments from the trap.`, fragments: fragGain });
        }
        break;
      }
    }
  }
  return {
    elapsedTicks,
    totalTicks: tickCount,
    events,
    hero,
    pack,
    rewards: { bolts, fragments, materials, packs },
    died,
    finished: elapsedTicks >= tickCount || died,
    nextTickUtc: rec.embarkUtc + (elapsedTicks + 1) * TICK_MS,
  };
}

// ── Public API ──────────────────────────────────────────────────

export async function startExpedition(env, guildId, userId, { hours, backpack = {} }) {
  const h = Math.max(MIN_HOURS, Math.min(MAX_HOURS, parseInt(hours, 10) || 0));
  if (!h) return { ok: false, error: 'bad-hours', range: [MIN_HOURS, MAX_HOURS] };

  // One expedition at a time per hero.
  const existing = await readActive(env, guildId, userId);
  if (existing && !existing.claimedUtc) {
    const resolved = resolveExpedition(existing);
    if (!resolved.finished) {
      return { ok: false, error: 'already-active', expedition: { ...existing, resolved } };
    }
  }

  // Infirmary cooldown? Block re-embark for 6h after a death.
  const lastDeath = await env.LOADOUT_BOLTS.get(`expedition:infirmary:${guildId}:${userId}`, { type: 'json' });
  if (lastDeath?.until && lastDeath.until > Date.now()) {
    return { ok: false, error: 'infirmary', until: lastDeath.until };
  }

  const hero = await loadHero(env, guildId, userId);
  if (!hero) return { ok: false, error: 'no-hero' };
  if ((hero.hpCurrent || 0) < (hero.hpMax || 25) * 0.5) {
    return { ok: false, error: 'hero-too-wounded', message: 'Heal up before embarking — hero is below 50% HP.' };
  }

  // Validate the backpack — caller passes { itemId: count } for items
  // already purchased into their personal supply. We deduct counts
  // from the purchased pool here so they're "loaded" onto the trip.
  const supply = await readSupply(env, guildId, userId);
  const loadedPack = {};
  for (const [id, count] of Object.entries(backpack)) {
    if (!BACKPACK_CATALOG[id]) return { ok: false, error: 'unknown-item', itemId: id };
    const n = Math.max(0, parseInt(count, 10) || 0);
    if (n <= 0) continue;
    if ((supply[id] || 0) < n) return { ok: false, error: 'insufficient-supplies', itemId: id, have: supply[id] || 0, need: n };
    loadedPack[id] = n;
    supply[id] = (supply[id] || 0) - n;
  }
  await writeSupply(env, guildId, userId, supply);

  const tickCount = Math.floor((h * 3_600_000) / TICK_MS);
  const id = `xp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const seed = hashSeed(id);
  const rand = mulberry32(seed);
  // Pre-roll the schedule. Combat power scales with hero level so
  // a level-30 hero fights tougher mobs (and bigger payouts).
  const baseLevel = hero.level || 1;
  const schedule = [];
  for (let i = 0; i < tickCount; i++) {
    const pick = pickWeighted(rand, EVENT_WEIGHTS);
    const ev = { kind: pick.kind };
    if (pick.kind === 'combat') {
      ev.power = Math.max(2, baseLevel + randInt(rand, -2, 4));
      ev.hp    = Math.max(8, ev.power * randInt(rand, 6, 10));
    }
    schedule.push(ev);
  }

  const embarkUtc = Date.now();
  const rec = {
    id, guildId, userId,
    embarkUtc,
    returnUtc: embarkUtc + tickCount * TICK_MS,
    durationHours: h,
    schedule,
    backpack: loadedPack,
    heroSnapshot: snapshotHeroForExpedition(hero),
    claimedUtc: null,
  };
  await writeActive(env, guildId, userId, rec);
  return { ok: true, expedition: rec };
}

export async function checkExpedition(env, guildId, userId) {
  const rec = await readActive(env, guildId, userId);
  if (!rec) return { ok: true, expedition: null };
  const resolved = resolveExpedition(rec);
  return { ok: true, expedition: rec, resolved };
}

export async function claimExpedition(env, guildId, userId) {
  const rec = await readActive(env, guildId, userId);
  if (!rec) return { ok: false, error: 'no-active' };
  if (rec.claimedUtc) return { ok: false, error: 'already-claimed' };
  const resolved = resolveExpedition(rec);
  if (!resolved.finished) return { ok: false, error: 'not-finished', resolved };

  // Stamp claimedUtc + persist BEFORE applying rewards so a second
  // concurrent claim (manual + cron racing inside the same minute)
  // re-reads the active record, sees claimedUtc set, and bails out
  // with `already-claimed` instead of double-issuing bolts/packs.
  // KV is eventually consistent globally but the worker isolate
  // sees its own writes immediately, which is the meaningful guard
  // against the user-vs-cron race inside one worker.
  rec.claimedUtc = Date.now();
  await writeActive(env, guildId, userId, rec);

  // Apply rewards.
  if (resolved.rewards.bolts > 0) {
    try { await applyVaultDelta(env, guildId, userId, resolved.rewards.bolts, `expedition:${rec.id}`); }
    catch (e) { console.warn('[expedition] bolts apply failed:', e && e.message); }
  }
  if (Object.keys(resolved.rewards.materials).length) {
    try {
      const { addResources } = await import('./clash-resources.js');
      await addResources(env, guildId, resolved.rewards.materials);
    } catch (e) { console.warn('[expedition] materials failed:', e && e.message); }
  }
  if (resolved.rewards.fragments > 0) {
    try {
      const { addFragments } = await import('./cards-fragments.js');
      await addFragments(env, userId, resolved.rewards.fragments, `expedition:${rec.id}`);
    } catch (e) { console.warn('[expedition] fragments failed:', e && e.message); }
  }
  for (const t of resolved.rewards.packs) {
    try {
      const { creditPack } = await import('./cards-packs.js');
      await creditPack(env, guildId, userId, t, `expedition:${rec.id}`);
    } catch (e) { console.warn('[expedition] pack failed:', e && e.message); }
  }

  // Death consequences. Halve the bolts that landed and stamp the
  // infirmary cooldown. Equipped gear is untouched — losing kit
  // would be the rage-inducing version.
  if (resolved.died && resolved.rewards.bolts > 0) {
    const lost = Math.floor(resolved.rewards.bolts / 2);
    try { await applyVaultDelta(env, guildId, userId, -lost, `expedition:death:${rec.id}`); }
    catch { /* non-fatal */ }
    resolved.deathPenaltyBolts = lost;
  }
  if (resolved.died) {
    await env.LOADOUT_BOLTS.put(
      `expedition:infirmary:${guildId}:${userId}`,
      JSON.stringify({ until: Date.now() + INFIRMARY_COOLDOWN_MS, fromExpeditionId: rec.id }),
      { expirationTtl: Math.ceil(INFIRMARY_COOLDOWN_MS / 1000) + 60 },
    );
  }

  // Archive + clear active. claimedUtc was already stamped before
  // applying rewards (see above) — preserved on rec so the archive
  // copy carries the timestamp too.
  rec.resolved = resolved;
  await appendHist(env, guildId, userId, rec);
  await clearActive(env, guildId, userId);

  // Refund unused supplies back to the player's pool.
  if (resolved.pack && Object.values(resolved.pack).some(v => v > 0)) {
    const supply = await readSupply(env, guildId, userId);
    for (const [id, count] of Object.entries(resolved.pack)) {
      if (!count) continue;
      supply[id] = (supply[id] || 0) + count;
    }
    await writeSupply(env, guildId, userId, supply);
  }

  // Patch the hero's hpCurrent so the in-game stat reflects the
  // beating. Persist via the local hero record only — DLL sync
  // doesn't track expeditions yet.
  try {
    const wallet = await getWallet(env, guildId, userId);
    const HERO_KEY = `d:hero:${guildId}:${userId}`;
    const raw = await env.LOADOUT_BOLTS.get(HERO_KEY);
    if (raw) {
      const hero = JSON.parse(raw);
      hero.hpCurrent = Math.max(1, resolved.died ? 1 : resolved.hero.hpCurrent);
      await env.LOADOUT_BOLTS.put(HERO_KEY, JSON.stringify(hero));
    }
    void wallet;
  } catch { /* non-fatal */ }

  return { ok: true, expedition: rec, resolved };
}

// ── Backpack supply store ───────────────────────────────────────
//
// Items are pre-purchased into a personal supply pool, then "loaded"
// onto an expedition at start time. Supplies that come back unused
// re-enter the pool.

const SUPPLY_KEY = (g, u) => `expedition:supply:${g}:${u}`;

export async function readSupply(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(SUPPLY_KEY(guildId, userId), { type: 'json' });
  return raw || {};
}
async function writeSupply(env, guildId, userId, supply) {
  await env.LOADOUT_BOLTS.put(SUPPLY_KEY(guildId, userId), JSON.stringify(supply));
}

export async function buyBackpackItem(env, guildId, userId, itemId, count) {
  const item = BACKPACK_CATALOG[itemId];
  if (!item) return { ok: false, error: 'unknown-item' };
  const n = Math.max(1, Math.min(99, parseInt(count, 10) || 1));
  const totalCost = item.cost * n;
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < totalCost) {
    return { ok: false, error: 'insufficient-bolts', need: totalCost, have: wallet.balance || 0 };
  }
  await applyVaultDelta(env, guildId, userId, -totalCost, `expedition:buy:${itemId}`);
  const supply = await readSupply(env, guildId, userId);
  supply[itemId] = (supply[itemId] || 0) + n;
  await writeSupply(env, guildId, userId, supply);
  return { ok: true, itemId, added: n, totalCost, supply };
}

// ── Cron tick — finalize expeditions whose window has closed ────
//
// Walks every active record and finalizes any whose returnUtc has
// passed AND that have NOT been claimed by the player yet. This is
// the safety net for players who don't manually click claim — their
// rewards just land at the next :23 tick.

export async function expeditionCronTick(env) {
  let cursor;
  let finalized = 0;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'expedition:active:', cursor, limit: 1000 });
    for (const k of r.keys) {
      try {
        const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
        if (!rec || rec.claimedUtc) continue;
        if (rec.returnUtc > Date.now()) continue;
        await claimExpedition(env, rec.guildId, rec.userId);
        finalized++;
      } catch (e) {
        console.warn('[expedition] cron finalize failed for', k.name, e && e.message);
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  if (finalized) console.log('[expedition] cron finalized', finalized, 'expeditions');
  return { finalized };
}

// ── HTTP route handler ──────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

// Sub-path dispatch — called from web.js after HMAC + guildId/discordId
// extraction. The body shape varies per sub; document on each branch.
export async function handleExpeditionWeb(env, guildId, userId, body, sub) {
  switch (sub) {
    case 'status': {
      const r = await checkExpedition(env, guildId, userId);
      const supply = await readSupply(env, guildId, userId);
      const infirmary = await env.LOADOUT_BOLTS.get(`expedition:infirmary:${guildId}:${userId}`, { type: 'json' });
      return json({ ...r, supply, infirmary });
    }
    case 'start': {
      const hours = body?.hours;
      const backpack = body?.backpack || {};
      const r = await startExpedition(env, guildId, userId, { hours, backpack });
      return json(r, r.ok ? 200 : 400);
    }
    case 'claim': {
      const r = await claimExpedition(env, guildId, userId);
      return json(r, r.ok ? 200 : 400);
    }
    case 'history': {
      const raw = (await env.LOADOUT_BOLTS.get(HIST_KEY(guildId, userId), { type: 'json' })) || [];
      return json({ ok: true, history: raw });
    }
    case 'backpack/catalog': {
      return json({ ok: true, catalog: listBackpackCatalog() });
    }
    case 'backpack/buy': {
      const itemId = String(body?.itemId || '').trim();
      const count  = body?.count;
      const r = await buyBackpackItem(env, guildId, userId, itemId, count);
      return json(r, r.ok ? 200 : 400);
    }
    case 'backpack/supply': {
      const supply = await readSupply(env, guildId, userId);
      return json({ ok: true, supply });
    }
    default:
      return json({ ok: false, error: 'unknown-sub' }, 404);
  }
}
