// Overlay test ping relay. A product customizer on aquilo.gg fires a test
// at the streamer's LIVE OBS browser source so they can check placement on
// the real canvas. Pairing is an unguessable token the customizer generates
// once per browser and appends to every overlay URL it builds
// (`pair=<token>`); the channel key is `<token>:<slug>` so one token covers
// all products without a test for one overlay firing the others.
//
//   POST /api/overlay-test/send     { ch, kinds:['flash','demo'], flashMs? }
//   GET  /api/overlay-test/pending  ?ch=<ch>&after=<nonce>   (overlay polls)
//   GET  /api/overlay-test/ack      ?ch=<ch>&n=<nonce>       (customizer polls)
//
// Events live in KV ~2 min so a test fired while the source is still
// loading is picked up on its first poll. Delivery writes a receipt the
// customizer reads to show "Delivered" vs "no overlay picked this up".
// No auth by design: tokens are random, sends are rate limited, and the
// worst a forged send can do is flash a placement frame on one overlay.

import { CORS, json } from './ext-shared.js';

const EVENT_TTL_S = 120;
const ACK_TTL_S = 600;
const RL_MAX_PER_10S = 8;
const CH_RE = /^[a-z0-9]{6,32}:[a-z0-9][a-z0-9-]{0,23}$/;
const KINDS = ['flash', 'demo'];

export async function handleOverlayTest(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (path === '/api/overlay-test/send' && req.method === 'POST') return send(req, env);
  if (path === '/api/overlay-test/pending' && req.method === 'GET') return pending(req, env);
  if (path === '/api/overlay-test/ack' && req.method === 'GET') return ack(req, env);
  return json({ ok: false, error: 'not found' }, 404);
}

async function send(req, env) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const bucket = Math.floor(Date.now() / 10000);
  const rlKey = `otest-rl:${ip}:${bucket}`;
  const used = parseInt((await env.LOADOUT_BOLTS.get(rlKey)) || '0', 10);
  if (used >= RL_MAX_PER_10S) return json({ ok: false, error: 'rate limited' }, 429);
  await env.LOADOUT_BOLTS.put(rlKey, String(used + 1), { expirationTtl: 60 });

  let body = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const ch = String(body.ch || '').toLowerCase();
  if (!CH_RE.test(ch)) return json({ ok: false, error: 'bad channel' }, 400);
  let kinds = Array.isArray(body.kinds) ? body.kinds.filter((k) => KINDS.includes(k)) : [];
  if (!kinds.length) kinds = ['flash'];

  const n = Date.now();
  const evt = { n, kinds };
  const flashMs = Number(body.flashMs);
  if (Number.isFinite(flashMs) && flashMs >= 1000 && flashMs <= 15000) evt.flashMs = Math.round(flashMs);
  // Optional payload an overlay may act on (e.g. Gift Guide "preview this
  // profile" — the editor sends the selected profile/category name).
  if (typeof body.game === 'string' && body.game) evt.game = body.game.slice(0, 60);
  await env.LOADOUT_BOLTS.put(`otest:${ch}`, JSON.stringify(evt), { expirationTtl: EVENT_TTL_S });
  return json({ ok: true, n });
}

async function pending(req, env) {
  const u = new URL(req.url);
  const ch = String(u.searchParams.get('ch') || '').toLowerCase();
  if (!CH_RE.test(ch)) return json({ ok: false, error: 'bad channel' }, 400);
  const after = parseInt(u.searchParams.get('after') || '0', 10) || 0;
  const raw = await env.LOADOUT_BOLTS.get(`otest:${ch}`);
  if (!raw) return new Response(null, { status: 204, headers: CORS });
  let evt = null;
  try { evt = JSON.parse(raw); } catch { evt = null; }
  if (!evt || !(Number(evt.n) > after)) return new Response(null, { status: 204, headers: CORS });
  // Delivery receipt, written only on an actual handoff so it costs one KV
  // write per received test, not one per poll.
  await env.LOADOUT_BOLTS.put(`otestack:${ch}`, JSON.stringify({ n: Number(evt.n), ts: Date.now() }), { expirationTtl: ACK_TTL_S });
  return json(evt);
}

async function ack(req, env) {
  const u = new URL(req.url);
  const ch = String(u.searchParams.get('ch') || '').toLowerCase();
  if (!CH_RE.test(ch)) return json({ ok: false, error: 'bad channel' }, 400);
  const n = parseInt(u.searchParams.get('n') || '0', 10) || 0;
  const raw = await env.LOADOUT_BOLTS.get(`otestack:${ch}`);
  let delivered = false;
  if (raw) { try { delivered = Number(JSON.parse(raw).n) >= n; } catch { delivered = false; } }
  return json({ ok: true, delivered });
}
