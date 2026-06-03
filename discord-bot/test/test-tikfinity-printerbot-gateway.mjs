// Coverage for the May 2026 batch:
//   • tikfinity.js, auth + payload mapping + non-gift skip + amount math
//   • printerbot.js, webhook create + reuse + missing channelId
//   • auth.js verifyGatewaySig, legacy header + HMAC + bad-secret reject
//   • guild-features.handleStarboardReaction, action:"remove" skipped
//
// Run from repo root:
//   node discord-bot/test/test-tikfinity-printerbot-gateway.mjs

import { handleTikFinityEvent } from '../tikfinity.js';
import { ensurePrinterBotWebhook, readPrinterBotWebhook } from '../printerbot.js';
import { verifyGatewaySig } from '../auth.js';
import { handleStarboardReaction } from '../guild-features.js';
import { recordGifterEvent } from '../gifter-roles.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ✅ ' + label);
  else { failures++; console.log('  ❌ ' + label); }
}
function eq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('    expected', JSON.stringify(b), '\n    got     ', JSON.stringify(a));
  assert(ok, label);
}

function makeKv() {
  const store = new Map();
  return {
    async put(key, value) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
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

let fetchHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (fetchHandler) return fetchHandler(String(input), init || {});
  return new Response('no fetchHandler set', { status: 599 });
};

const GUILD = '1504103035951906883';
const TF_SECRET = 'tikfinity-test-secret-please-rotate';
const GW_SECRET = 'gateway-test-secret-not-real';

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── TikFinity ────────────────────────────────────────────────────
console.log('- tikfinity: no secret → 503');
{
  const env = { LOADOUT_BOLTS: makeKv(), AQUILO_VAULT_GUILD_ID: GUILD };
  const req = new Request('https://w/tikfinity/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tikfinity-secret': 'whatever' },
    body: JSON.stringify({ event: 'gift' }),
  });
  const r = await handleTikFinityEvent(req, env);
  eq(r.status, 503, '503 with no TIKFINITY_WEBHOOK_SECRET');
}

console.log('- tikfinity: bad/missing secret → 401');
{
  const env = { LOADOUT_BOLTS: makeKv(), TIKFINITY_WEBHOOK_SECRET: TF_SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
  const req = new Request('https://w/tikfinity/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tikfinity-secret': 'WRONG' },
    body: JSON.stringify({ event: 'gift', uniqueId: 'a', diamondCount: 1, repeatCount: 1 }),
  });
  const r = await handleTikFinityEvent(req, env);
  eq(r.status, 401, '401 on wrong secret');

  const req2 = new Request('https://w/tikfinity/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },   // no header at all
    body: JSON.stringify({ event: 'gift', uniqueId: 'a' }),
  });
  const r2 = await handleTikFinityEvent(req2, env);
  eq(r2.status, 401, '401 on missing secret header');
}

console.log('- tikfinity: gift event credits the contributor');
{
  const env = { LOADOUT_BOLTS: makeKv(), TIKFINITY_WEBHOOK_SECRET: TF_SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
  const ts0 = Date.UTC(2026, 4, 26, 12, 0, 0);   // 2026-05-26 12:00 UTC
  const body = JSON.stringify({
    event: 'gift', uniqueId: 'TikFan', nickname: 'TikFan Display',
    diamondCount: 5, repeatCount: 10, timestamp: ts0,
  });
  const req = new Request('https://w/tikfinity/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tikfinity-secret': TF_SECRET },
    body,
  });
  const r = await handleTikFinityEvent(req, env);
  eq(r.status, 200, '200 on valid gift');
  const j = await r.json();
  eq(j.ok, true, 'ok:true');
  eq(j.source, 'tikfinity', 'source tagged');
  eq(j.category, 'tiktok', 'category tiktok');
  eq(j.totalToday, 50, '5 × 10 = 50 diamonds');
  // Bucket persisted under the lowercased uniqueId.
  const bucket = await env.LOADOUT_BOLTS.get(`gifter:tiktok:${GUILD}:tiktok:tikfan:2026-05-26`);
  eq(bucket, '50', 'KV bucket persisted');
}

console.log('- tikfinity: non-gift events 200 + skipped');
{
  const env = { LOADOUT_BOLTS: makeKv(), TIKFINITY_WEBHOOK_SECRET: TF_SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
  const body = JSON.stringify({ event: 'follow', uniqueId: 'anyone' });
  const req = new Request('https://w/tikfinity/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tikfinity-secret': TF_SECRET },
    body,
  });
  const r = await handleTikFinityEvent(req, env);
  eq(r.status, 200, '200 on non-gift');
  const j = await r.json();
  eq(j.skipped, 'unhandled-event', 'skipped tag');
  eq(j.event, 'follow', 'event echoed');
}

console.log('- tikfinity: missing uniqueId → 400');
{
  const env = { LOADOUT_BOLTS: makeKv(), TIKFINITY_WEBHOOK_SECRET: TF_SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
  const body = JSON.stringify({ event: 'gift', diamondCount: 1, repeatCount: 1 });
  const req = new Request('https://w/tikfinity/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tikfinity-secret': TF_SECRET },
    body,
  });
  const r = await handleTikFinityEvent(req, env);
  eq(r.status, 400, '400 on missing uniqueId');
  const j = await r.json();
  eq(j.error, 'no-uniqueId', 'no-uniqueId error');
}

console.log('- tikfinity: zero diamonds → 400');
{
  const env = { LOADOUT_BOLTS: makeKv(), TIKFINITY_WEBHOOK_SECRET: TF_SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
  const body = JSON.stringify({ event: 'gift', uniqueId: 'a', diamondCount: 0, repeatCount: 5 });
  const req = new Request('https://w/tikfinity/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tikfinity-secret': TF_SECRET },
    body,
  });
  const r = await handleTikFinityEvent(req, env);
  eq(r.status, 400, '400 on zero diamonds');
}

// ── recordGifterEvent direct ─────────────────────────────────────
console.log('- recordGifterEvent: bad shape returns ok:false');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r1 = await recordGifterEvent(env, GUILD, 'tip', 'tiktok', '', 5, Date.now());
  eq(r1.ok, false, 'empty login → ok:false');
  eq(r1.error, 'no-contributor-login', 'shape mismatch error');
  const r2 = await recordGifterEvent(env, GUILD, 'whatever', 'tiktok', 'a', 5, Date.now());
  eq(r2.ok, false, 'bad type → ok:false');
  eq(r2.error, 'unhandled-event-type', 'unhandled-event-type');
}

// ── verifyGatewaySig ─────────────────────────────────────────────
console.log('- verifyGatewaySig: legacy x-counting-secret accepted');
{
  const env = { AQUILO_GATEWAY_SECRET: GW_SECRET };
  const req = new Request('https://w/whatever', {
    method: 'POST',
    headers: { 'x-counting-secret': GW_SECRET },
    body: 'hi',
  });
  const r = await verifyGatewaySig(req, env, 'hi');
  eq(r.ok, true, 'legacy header matches gateway secret');
  eq(r.via, 'shared-gateway', 'via tag');
}

console.log('- verifyGatewaySig: legacy COUNTING_WEBHOOK_SECRET also accepted');
{
  const env = { COUNTING_WEBHOOK_SECRET: 'old-counting' };
  const req = new Request('https://w/whatever', {
    method: 'POST',
    headers: { 'x-counting-secret': 'old-counting' },
    body: 'hi',
  });
  const r = await verifyGatewaySig(req, env, 'hi');
  eq(r.ok, true, 'legacy header matches counting secret');
  eq(r.via, 'shared-counting', 'via tag legacy counting');
}

console.log('- verifyGatewaySig: HMAC path');
{
  const env = { AQUILO_GATEWAY_SECRET: GW_SECRET };
  const body = '{"hello":"world"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await hmacHex(GW_SECRET, ts + '\n' + body);
  const req = new Request('https://w/whatever', {
    method: 'POST',
    headers: { 'x-aquilo-gw-ts': ts, 'x-aquilo-gw-sig': sig },
    body,
  });
  const r = await verifyGatewaySig(req, env, body);
  eq(r.ok, true, 'HMAC accepted');
  eq(r.via, 'gw-hmac', 'via tag hmac');
}

console.log('- verifyGatewaySig: wrong secret rejected');
{
  const env = { AQUILO_GATEWAY_SECRET: GW_SECRET };
  const req = new Request('https://w/whatever', {
    method: 'POST',
    headers: { 'x-counting-secret': 'wrong-secret' },
    body: 'hi',
  });
  const r = await verifyGatewaySig(req, env, 'hi');
  eq(r.ok, false, 'wrong secret → ok:false');
}

console.log('- verifyGatewaySig: tampered HMAC rejected');
{
  const env = { AQUILO_GATEWAY_SECRET: GW_SECRET };
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await hmacHex(GW_SECRET, ts + '\n' + 'original');
  const req = new Request('https://w/whatever', {
    method: 'POST',
    headers: { 'x-aquilo-gw-ts': ts, 'x-aquilo-gw-sig': sig },
    body: 'tampered',
  });
  const r = await verifyGatewaySig(req, env, 'tampered');
  eq(r.ok, false, 'tampered body rejected');
}

// ── handleStarboardReaction action discriminator ─────────────────
console.log('- starboard: action:"remove" is a no-op');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r = await handleStarboardReaction(env, {
    action: 'remove',
    guild_id: GUILD,
    channel_id: 'C',
    message_id: 'M',
    user_id: 'U',
    emoji: { name: '⭐' },
  });
  eq(r.skipped, 'remove-action', 'remove skipped');
  // Should NOT have written the dedup stamp, no Discord call either.
  const stamp = await env.LOADOUT_BOLTS.get(`guild:star:${GUILD}:M`);
  eq(stamp, null, 'no dedup stamp on remove');
}

console.log('- starboard: action:"add" + non-star emoji still routed through emoji check');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r = await handleStarboardReaction(env, {
    action: 'add', emoji: { name: '🤔' },
  });
  eq(r.skipped, 'wrong-emoji', 'add + non-⭐ still hits wrong-emoji branch');
}

console.log('- starboard: undefined action (legacy forwarder) still flows through');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  // No `action` field, should reach the emoji check, not be auto-skipped.
  const r = await handleStarboardReaction(env, {
    emoji: { name: 'not-a-star' },
  });
  eq(r.skipped, 'wrong-emoji', 'undefined action falls through to emoji check');
}

// ── PrinterBot ───────────────────────────────────────────────────
console.log('- printerbot: no token → ok:false');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r = await ensurePrinterBotWebhook(env, GUILD, 'C123');
  eq(r.ok, false, 'no DISCORD_BOT_TOKEN → ok:false');
  eq(r.error, 'no-bot-token', 'no-bot-token error');
}

console.log('- printerbot: missing channelId → ok:false');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  const r = await ensurePrinterBotWebhook(env, GUILD, '');
  eq(r.ok, false, 'empty channelId rejected');
  eq(r.error, 'channel-id-required', 'channel-id-required error');
}

console.log('- printerbot: create-new path persists URL');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async (url, init) => {
    if ((!init.method || init.method === 'GET') && url.endsWith('/channels/CHAN/webhooks')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (init.method === 'POST' && url.endsWith('/channels/CHAN/webhooks')) {
      const body = JSON.parse(init.body);
      eq(body.name, 'PrinterBot', 'POST body name=PrinterBot');
      return new Response(JSON.stringify({ id: 'WID', token: 'TKN', name: body.name }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await ensurePrinterBotWebhook(env, GUILD, 'CHAN');
  fetchHandler = null;
  eq(r.ok, true, 'create ok');
  eq(r.url, 'https://discord.com/api/webhooks/WID/TKN', 'url shape');
  eq(r.reused, false, 'first create not reused');
  const stored = await readPrinterBotWebhook(env, GUILD);
  eq(stored.url, 'https://discord.com/api/webhooks/WID/TKN', 'persisted url');
  eq(stored.webhookId, 'WID', 'persisted webhook id');
  eq(stored.channelId, 'CHAN', 'persisted channel id');
}

console.log('- printerbot: reuses existing webhook on re-run');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async (url, init) => {
    if ((!init.method || init.method === 'GET') && url.endsWith('/channels/CHAN/webhooks')) {
      return new Response(JSON.stringify([
        { id: 'EXISTING', token: 'EXISTING_TOKEN', name: 'PrinterBot' },
      ]), { status: 200 });
    }
    return new Response('should-not-create', { status: 500 });
  };
  const r = await ensurePrinterBotWebhook(env, GUILD, 'CHAN');
  fetchHandler = null;
  eq(r.ok, true, 'reuse ok');
  eq(r.url, 'https://discord.com/api/webhooks/EXISTING/EXISTING_TOKEN', 'reuse url');
  eq(r.reused, true, 'flagged reused');
}

console.log('- printerbot: list-fail surfaces error');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async () => new Response('forbidden', { status: 403 });
  const r = await ensurePrinterBotWebhook(env, GUILD, 'CHAN');
  fetchHandler = null;
  eq(r.ok, false, 'list-fail → ok:false');
  eq(r.error, 'webhooks-list-failed', 'webhooks-list-failed');
  eq(r.status, 403, 'status surfaced');
}

console.log('');
globalThis.fetch = realFetch;
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
