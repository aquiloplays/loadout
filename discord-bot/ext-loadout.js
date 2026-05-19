// Twitch-panel Loadout routes — /ext/loadout/*.
//
// Presentation layer over the Discord bot's economy/game logic. Each
// route resolves the viewer through ext.js's `tw:` identity bridge and
// calls the structured `do*` cores in dungeon.js (or games/wallet
// directly), returning panel-ready JSON instead of Discord text.
//
// Mutating routes carry a light ~3s per-viewer debounce
// (KV extcd:<action>:<guild>:<userId>) to absorb double-taps; deeper
// gameplay caps (per-day spend/train/gift) are deferred to a config pass.

import {
  doInventory, doEquip, doUnequip, doSell, doShopBuy, doTrain,
  getDailyShop, loadHero, attackOf, defenseOf, CLASSES,
} from './dungeon.js';
import { coinflip, dice } from './games.js';
import { getWallet, transfer } from './wallet.js';
import { getProfile } from './profiles.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}

const DEBOUNCE_MS = 3000;

// Light per-viewer, per-action debounce. Returns true when the caller is
// still inside the cooldown window (the request should be rejected).
// KV expirationTtl floors at 60s; the 3s window is enforced by the
// stored timestamp, the TTL only auto-cleans the key.
async function debounced(env, action, guild, userId) {
  const key = `extcd:${action}:${guild}:${userId}`;
  const last = parseInt((await env.LOADOUT_BOLTS.get(key)) || '0', 10);
  const now = Date.now();
  if (last && now - last < DEBOUNCE_MS) return true;
  await env.LOADOUT_BOLTS.put(key, String(now), { expirationTtl: 60 });
  return false;
}

// Twitch app token (client-credentials, cached) — used to resolve a
// gift recipient's login name to a numeric id.
async function getTwitchAppToken(env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return null;
  const cached = await env.LOADOUT_BOLTS.get('twitch:apptoken');
  if (cached) return cached;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(env.TWITCH_CLIENT_ID)}` +
            `&client_secret=${encodeURIComponent(env.TWITCH_CLIENT_SECRET)}` +
            `&grant_type=client_credentials`,
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.access_token) return null;
    await env.LOADOUT_BOLTS.put('twitch:apptoken', d.access_token, {
      expirationTtl: Math.max(60, (d.expires_in || 3600) - 600),
    });
    return d.access_token;
  } catch {
    return null;
  }
}

async function resolveTwitchLogin(env, login) {
  const token = await getTwitchAppToken(env);
  if (!token) return null;
  try {
    const res = await fetch(
      'https://api.twitch.tv/helix/users?login=' + encodeURIComponent(login),
      { headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const u = d && d.data && d.data[0];
    return u ? { id: String(u.id), login: u.login, displayName: u.display_name } : null;
  } catch {
    return null;
  }
}

// Trim a bag/shop item to the fields the panel renders.
function panelItem(it) {
  return {
    id: it.id,
    slot: it.slot || '',
    rarity: it.rarity || 'common',
    name: it.name || '',
    glyph: it.glyph || '',
    powerBonus: it.powerBonus || 0,
    defenseBonus: it.defenseBonus || 0,
    ability: it.ability || '',
    goldValue: it.goldValue || 0,
  };
}

async function routeInventory(env, guild, userId) {
  const { bag, equipped } = await doInventory(env, guild, userId);
  return json({ count: bag.length, items: bag.map(panelItem), equipped });
}

async function routeShop(env, guild) {
  const stock = await getDailyShop(env, guild);
  const items = (stock.items || []).map((row) => {
    const [slot, rarity, name, glyph, atk, def, price, setName, weaponType, preferredClass, ability] = row;
    return { slot, rarity, name, glyph, atk, def, price, setName, weaponType, preferredClass, ability };
  });
  return json({ day: stock.day, items });
}

async function routeProfile(env, guild, userId) {
  const hero = await loadHero(env, guild, userId);
  const wallet = await getWallet(env, guild, userId);
  const profile = await getProfile(env, guild, userId);
  const cls = CLASSES[hero.className] || null;
  return json({
    hero: {
      className: hero.className || '',
      classMeta: cls ? { name: cls.name, glyph: cls.glyph } : null,
      level: hero.level || 1,
      xp: hero.xp || 0,
      hpMax: hero.hpMax || 0,
      hpCurrent: hero.hpCurrent || 0,
      atk: attackOf(hero),
      def: defenseOf(hero),
      bagCount: (hero.bag || []).length,
      dungeonsSurvived: hero.dungeonsSurvived || 0,
      bossesSlain: hero.bossesSlain || 0,
      duelsWon: hero.duelsWon || 0,
      duelsLost: hero.duelsLost || 0,
    },
    wallet: {
      balance: wallet.balance || 0,
      lifetimeEarned: wallet.lifetimeEarned || 0,
      lifetimeSpent: wallet.lifetimeSpent || 0,
      dailyStreak: wallet.dailyStreak || 0,
    },
    profile: {
      bio: profile.bio || '',
      pronouns: profile.pronouns || '',
      socials: profile.socials || {},
      gamerTags: profile.gamerTags || {},
    },
  });
}

// Dispatched from ext.js handleExt for routes under /ext/loadout/.
export async function handleLoadout(env, guildId, userId, sub, req) {
  // Read routes ----------------------------------------------------------
  if (req.method === 'GET' && sub === 'inventory') return routeInventory(env, guildId, userId);
  if (req.method === 'GET' && sub === 'shop') return routeShop(env, guildId);
  if (req.method === 'GET' && sub === 'profile') return routeProfile(env, guildId, userId);

  if (req.method !== 'POST') return json({ error: 'not-found' }, 404);

  let body = {};
  try { body = await req.json(); } catch { /* empty body tolerated */ }

  // Mutating routes — debounced -----------------------------------------
  if (sub === 'equip') {
    if (await debounced(env, 'equip', guildId, userId)) return json({ ok: false, reason: 'debounce' }, 429);
    const r = await doEquip(env, guildId, userId, String(body.itemId || ''));
    if (!r.ok) return json({ ok: false, reason: r.reason });
    return json({ ok: true, item: panelItem(r.item) });
  }
  if (sub === 'unequip') {
    if (await debounced(env, 'unequip', guildId, userId)) return json({ ok: false, reason: 'debounce' }, 429);
    const r = await doUnequip(env, guildId, userId, String(body.slot || ''));
    return json(r.ok ? { ok: true } : { ok: false, reason: r.reason });
  }
  if (sub === 'buy') {
    if (await debounced(env, 'buy', guildId, userId)) return json({ ok: false, reason: 'debounce' }, 429);
    const r = await doShopBuy(env, guildId, userId, String(body.itemName || ''));
    if (!r.ok) return json({ ok: false, reason: r.reason, price: r.price, balance: r.balance });
    return json({ ok: true, item: panelItem(r.item), price: r.price });
  }
  if (sub === 'sell') {
    if (await debounced(env, 'sell', guildId, userId)) return json({ ok: false, reason: 'debounce' }, 429);
    const r = await doSell(env, guildId, userId, String(body.itemId || ''));
    if (!r.ok) return json({ ok: false, reason: r.reason });
    return json({ ok: true, item: panelItem(r.item), refund: r.refund });
  }
  if (sub === 'train') {
    if (await debounced(env, 'train', guildId, userId)) return json({ ok: false, reason: 'debounce' }, 429);
    const focus = String(body.focus || '');
    if (!['hp', 'attack', 'dodge'].includes(focus)) return json({ ok: false, reason: 'bad-focus' }, 400);
    const r = await doTrain(env, guildId, userId, focus, Math.floor(Number(body.rounds) || 0));
    if (!r.ok) return json({ ok: false, reason: r.reason, cost: r.cost, balance: r.balance });
    return json({
      ok: true, rounds: r.rounds, cost: r.cost, focus: r.focus, summary: r.summary,
      hero: { level: r.hero.level, xp: r.hero.xp, hpMax: r.hero.hpMax, hpCurrent: r.hero.hpCurrent },
    });
  }
  if (sub === 'coinflip') {
    if (await debounced(env, 'coinflip', guildId, userId)) return json({ ok: false, reason: 'debounce' }, 429);
    const r = await coinflip(env, guildId, userId, Math.floor(Number(body.bet) || 0));
    // coinflip returns payout 0 with no win only when the wager never
    // happened (bad bet / insufficient balance) — surface that as a reject.
    if (!r.won && r.payout === 0) return json({ ok: false, reason: r.explanation });
    const w = await getWallet(env, guildId, userId);
    return json({ ok: true, won: r.won, payout: r.payout, explanation: r.explanation, balance: w.balance || 0 });
  }
  if (sub === 'dice') {
    if (await debounced(env, 'dice', guildId, userId)) return json({ ok: false, reason: 'debounce' }, 429);
    const r = await dice(env, guildId, userId, Math.floor(Number(body.bet) || 0), Math.floor(Number(body.target) || 0));
    if (!r.won && r.payout === 0) return json({ ok: false, reason: r.explanation });
    const w = await getWallet(env, guildId, userId);
    return json({ ok: true, won: r.won, roll: r.roll || 0, payout: r.payout, explanation: r.explanation, balance: w.balance || 0 });
  }
  if (sub === 'gift') {
    if (await debounced(env, 'gift', guildId, userId)) return json({ ok: false, reason: 'debounce' }, 429);
    const toLogin = String(body.toLogin || '').trim().toLowerCase().replace(/^@/, '');
    const amount = Math.floor(Number(body.amount) || 0);
    if (!toLogin) return json({ ok: false, reason: 'no-recipient' }, 400);
    if (!(amount > 0)) return json({ ok: false, reason: 'bad-amount' }, 400);
    const target = await resolveTwitchLogin(env, toLogin);
    if (!target) return json({ ok: false, reason: 'unknown-user' }, 404);
    const r = await transfer(env, guildId, userId, 'tw:' + target.id, amount);
    if (!r.ok) return json({ ok: false, reason: r.reason });
    return json({ ok: true, amount, to: target.displayName || target.login, balance: (r.sender && r.sender.balance) || 0 });
  }

  return json({ error: 'not-found' }, 404);
}
