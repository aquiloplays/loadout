// Verifies the two 2026-06-02 check-in embed tweaks:
//   1. No-card check-ins no longer carry the "Welcome Back"
//      default-card.png image. The embed only shows an image when it
//      comes from a real user source (chosen GIF or saved custom card).
//   2. The user's optional compose-modal message renders in the embed
//      (blockquote at the top of the description), for BOTH default and
//      customised cards, and is absent when no message was typed.
//
// Run from repo root:
//   node discord-bot/test/test-checkin-embed.mjs

import { recordCheckin, putCard } from '../community-checkin.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ✅ ' + label);
  else { failures++; console.log('  ❌ ' + label); }
}

function makeKv() {
  const store = new Map();
  return {
    async put(key, value) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') { try { return JSON.parse(v); } catch { return null; } }
      return v;
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

const GUILD = '1504103035951906883';
const CHANNEL = '1507973920282640485';

// Stub global fetch: capture the Discord message POST payload, ack the
// member GET, swallow everything else (giphy/site composite/etc).
let lastPostedEmbed = null;
function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/messages') && (init.method || 'GET') === 'POST') {
      const body = JSON.parse(init.body);
      lastPostedEmbed = body.embeds?.[0] || null;
      return { ok: true, status: 200, async json() { return { id: '999' }; }, async text() { return ''; } };
    }
    if (u.includes('/guilds/') && u.includes('/members/')) {
      return { ok: true, status: 200, async json() {
        return { nick: null, user: { username: 'clay', global_name: 'Clay', avatar: null, id: '42' } };
      }, async text() { return ''; } };
    }
    // Unused side paths (composite endpoint, etc.) — pretend not-found.
    return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; } };
  };
}

function makeEnv(kv) {
  return { LOADOUT_BOLTS: kv, DISCORD_BOT_TOKEN: 'x' };
}

async function bindChannel(kv) {
  await kv.put(`channel-binding:${GUILD}:checkin-results`, CHANNEL);
}

installFetch();

// ── Case 1: no card + a typed message ─────────────────────────────────
console.log('— no custom card + a typed message');
{
  const kv = makeKv();
  await bindChannel(kv);
  const env = makeEnv(kv);
  lastPostedEmbed = null;
  const r = await recordCheckin(env, GUILD, '100000000000000001', 'discord', {
    message: 'feeling good today',
    gifUrl: 'https://media.giphy.com/x.gif',
  });
  assert(r.embed?.posted, 'embed posted');
  // GIF was chosen → it IS the image. Default-card.png must NOT appear.
  assert(lastPostedEmbed.image?.url === 'https://media.giphy.com/x.gif', 'image is the chosen GIF');
  assert(!String(lastPostedEmbed.image?.url || '').includes('default-card.png'), 'no Welcome Back default image');
  assert(/> _feeling good today_/.test(lastPostedEmbed.description), 'typed message renders as blockquote');
}

// ── Case 1b: no card, no gif (web-style check-in), no message ──────────
console.log('— no custom card, no GIF, no message (web surface)');
{
  const kv = makeKv();
  await bindChannel(kv);
  const env = makeEnv(kv);
  lastPostedEmbed = null;
  // Mirrors web.js:1548 → recordCheckin(env, guildId, userId, 'web') with no opts.
  const r = await recordCheckin(env, GUILD, '100000000000000002', 'web');
  assert(r.embed?.posted, 'embed posted');
  assert(lastPostedEmbed.image === undefined, 'NO image key at all (no default-card.png)');
  assert(/🔥 \*\*1-day streak\*\*/.test(lastPostedEmbed.description), 'streak line present');
  assert(!/> _/.test(lastPostedEmbed.description), 'no phantom message blockquote');
}

// ── Case 2: customised card + a typed message ─────────────────────────
console.log('— customised card + a typed message');
{
  const kv = makeKv();
  await bindChannel(kv);
  const env = makeEnv(kv);
  await putCard(env, GUILD, '100000000000000003', { imageUrl: 'https://aquilo.gg/u/custom.png' });
  lastPostedEmbed = null;
  const r = await recordCheckin(env, GUILD, '100000000000000003', 'web', { message: 'custom vibes' });
  assert(r.embed?.posted, 'embed posted');
  assert(lastPostedEmbed.image?.url === 'https://aquilo.gg/u/custom.png', 'image is the saved custom card');
  assert(/> _custom vibes_/.test(lastPostedEmbed.description), 'typed message renders for customised card');
}

// ── Case 3: customised card, no message ───────────────────────────────
console.log('— customised card, no message');
{
  const kv = makeKv();
  await bindChannel(kv);
  const env = makeEnv(kv);
  await putCard(env, GUILD, '100000000000000004', { imageUrl: 'https://aquilo.gg/u/custom2.png' });
  lastPostedEmbed = null;
  const r = await recordCheckin(env, GUILD, '100000000000000004', 'web');
  assert(r.embed?.posted, 'embed posted');
  assert(lastPostedEmbed.image?.url === 'https://aquilo.gg/u/custom2.png', 'custom image still shown');
  assert(!/> _/.test(lastPostedEmbed.description), 'no phantom message field when none typed');
}

console.log('');
console.log(failures === 0 ? 'PASSED — all assertions ok' : `FAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
