// Loadout TTS pipeline. Streamer brings their own provider key (OpenAI
// for v1; ElevenLabs/Google/Streamlabs/Speechify are wired into the UI
// as comingSoon stubs). Browser SpeechSynthesis is also surfaced as a
// no-key fallback the overlay plays without ever calling the worker for
// audio bytes (only the SSE event fires for the queued line).
//
// Wire-up (worker.js):
//   GET  /api/tts/settings/:broadcaster      HMAC, owner. Returns the
//                                            tier-filter prefs + which
//                                            provider is configured.
//                                            API keys never echoed.
//   POST /api/tts/settings/:broadcaster      HMAC, owner. Save provider
//                                            + voice + tier filter; if
//                                            body.apiKey set, encrypts
//                                            and stores it.
//   POST /api/tts/generate                   HMAC, owner. Body:
//                                              { broadcaster, provider,
//                                                voice, text, payerId,
//                                                payerName, source,
//                                                tier?: 'sub' | 'owner' |
//                                                       'everyone' }
//                                            Validates the per-broadcaster
//                                            tier filter + 5min per-user
//                                            cooldown, then either calls
//                                            OpenAI and stores the mp3
//                                            in R2, OR (provider==='browser')
//                                            skips audio synth and just
//                                            queues the text. Publishes
//                                            an SSE event to the
//                                            broadcaster's TtsBroadcaster
//                                            DO so the overlay plays it.
//   GET  /api/tts/events/:broadcaster        SSE stream consumed by the
//                                            OBS browser source.
//   GET  /api/tts/audio/:key                 R2 fetch with a fresh 1h
//                                            signed-ish URL. (R2 in
//                                            Workers doesn't ship a
//                                            presign API yet, so we
//                                            proxy + HMAC the key with
//                                            a per-broadcaster nonce.)
//
// KV layout:
//   tts:cfg:<broadcaster>   JSON { provider, voice, tier, cooldownSec,
//                                  keyCipherB64?, keyIvB64?,
//                                  updatedUtc }
//   tts:cool:<broadcaster>:<payerId>  expiry-stamped string; KV TTL
//                                    enforces the cooldown without a
//                                    cron sweep.
//   tts:audio:<broadcaster>:<ulid>   R2 metadata (text, payer, ts)
//                                    short JSON; the bytes live in R2
//                                    under the same key.

import { verifyHmac } from './auth.js';
import { publishTts } from './tts-do.js';

const TTS_CFG_PREFIX  = 'tts:cfg:';
const TTS_COOL_PREFIX = 'tts:cool:';
const TTS_R2_PREFIX   = 'tts/';
const COOLDOWN_DEFAULT_SEC = 300;       // 5 minute per-payer cooldown
const MAX_TEXT_LEN = 500;               // hard cap to keep OpenAI bills sane

const PROVIDERS_V1 = new Set(['openai', 'browser']);
const PROVIDERS_COMING_SOON = new Set([
  'elevenlabs', 'google', 'streamlabs', 'speechify',
]);
const TIERS_V1 = new Set(['everyone', 'sub', 'owner']);
// Patreon T1/T2/T3 + custom Discord role land in v2; stubbed in the UI.

const OPENAI_VOICES = new Set([
  'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer',
]);

// ── HMAC verification shared by every /api/tts/* route ──────────────
async function verifyTtsAuth(req, env, body) {
  const ts  = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  if (!ts || !sig || !env.AQUILO_SITE_WEB_SECRET) return false;
  return verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts, body, sig);
}

function ownerFromReq(req) {
  return req.headers.get('x-aquilo-owner-id') || '';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bad(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

// ── AES-GCM at-rest encryption for the streamer's TTS API key. The
// key is derived from AQUILO_SITE_WEB_SECRET (already a high-entropy
// secret) via SHA-256 so we don't have to provision a separate
// TTS_KEY_AES_SECRET binding for v1. v2 SHOULD provision one and
// rotate. The IV is random per-write and persisted alongside the
// ciphertext, so re-encrypting the same plaintext produces different
// ciphertexts (correctness check during testing).
async function deriveAesKey(env) {
  const seed = new TextEncoder().encode(
    (env.AQUILO_SITE_WEB_SECRET || 'dev') + ':tts-key-v1',
  );
  const hash = await crypto.subtle.digest('SHA-256', seed);
  return crypto.subtle.importKey(
    'raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  );
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encryptKey(env, plain) {
  const key = await deriveAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain),
  );
  return {
    keyCipherB64: bytesToB64(new Uint8Array(ct)),
    keyIvB64: bytesToB64(iv),
  };
}

async function decryptKey(env, cfg) {
  if (!cfg?.keyCipherB64 || !cfg?.keyIvB64) return null;
  try {
    const key = await deriveAesKey(env);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(cfg.keyIvB64) },
      key,
      b64ToBytes(cfg.keyCipherB64),
    );
    return new TextDecoder().decode(pt);
  } catch (e) {
    console.warn('[tts] decryptKey', e?.message || e);
    return null;
  }
}

// ── Settings read/write ─────────────────────────────────────────────
async function readCfg(env, broadcaster) {
  const raw = await env.LOADOUT_BOLTS.get(TTS_CFG_PREFIX + broadcaster, {
    type: 'json',
  });
  return raw || null;
}

async function writeCfg(env, broadcaster, cfg) {
  await env.LOADOUT_BOLTS.put(
    TTS_CFG_PREFIX + broadcaster,
    JSON.stringify({ ...cfg, updatedUtc: Date.now() }),
  );
}

// Strips secrets before sending the cfg back to the admin UI.
function publicCfg(cfg) {
  if (!cfg) {
    return {
      provider: 'browser',
      voice: 'alloy',
      tier: 'everyone',
      cooldownSec: COOLDOWN_DEFAULT_SEC,
      hasKey: false,
      updatedUtc: 0,
    };
  }
  return {
    provider: cfg.provider || 'browser',
    voice: cfg.voice || 'alloy',
    tier: cfg.tier || 'everyone',
    cooldownSec: Number(cfg.cooldownSec) || COOLDOWN_DEFAULT_SEC,
    hasKey: !!cfg.keyCipherB64,
    updatedUtc: cfg.updatedUtc || 0,
  };
}

// ── Tier filter ─────────────────────────────────────────────────────
// `payerTier` is the caller-supplied tier hint ('sub' | 'owner' |
// 'everyone'); the dispatcher (Punchcard, !checkin handler, channel
// point redemption) stamps it after looking up the user's actual
// Twitch sub status. Owner cfg tier 'everyone' accepts any payer.
function tierAllows(cfgTier, payerTier) {
  if (cfgTier === 'everyone') return true;
  if (cfgTier === 'owner')    return payerTier === 'owner';
  if (cfgTier === 'sub')      return payerTier === 'sub' || payerTier === 'owner';
  return false;
}

// ── Cooldown ────────────────────────────────────────────────────────
async function takeCooldown(env, broadcaster, payerId, cooldownSec) {
  if (!payerId) return { ok: true };                                // anonymous payer: skip
  const key = TTS_COOL_PREFIX + broadcaster + ':' + payerId;
  const existing = await env.LOADOUT_BOLTS.get(key);
  if (existing) {
    const remainSec = Math.max(0, parseInt(existing, 10) - Math.floor(Date.now() / 1000));
    return { ok: false, remainSec };
  }
  const expiresAt = Math.floor(Date.now() / 1000) + cooldownSec;
  await env.LOADOUT_BOLTS.put(key, String(expiresAt), { expirationTtl: cooldownSec });
  return { ok: true };
}

// ── OpenAI TTS provider ─────────────────────────────────────────────
async function synthOpenAi(apiKey, voice, text) {
  const v = OPENAI_VOICES.has(voice) ? voice : 'alloy';
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: v,
      input: text.slice(0, MAX_TEXT_LEN),
      response_format: 'mp3',
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    return { ok: false, status: r.status, error: errText.slice(0, 200) };
  }
  const buf = await r.arrayBuffer();
  return { ok: true, bytes: new Uint8Array(buf), contentType: 'audio/mpeg' };
}

// ── R2 storage ──────────────────────────────────────────────────────
// We reuse the OVERLAY_REFERENCES bucket binding (already wired) with a
// `tts/` prefix to avoid a wrangler.toml bucket change for v1. The
// dedicated bucket gets stood up in v2 once Clay confirms storage
// volume.
function newAudioKey(broadcaster) {
  const t = Date.now().toString(36);
  const rand = crypto.getRandomValues(new Uint8Array(4));
  let s = '';
  for (const b of rand) s += b.toString(16).padStart(2, '0');
  return TTS_R2_PREFIX + broadcaster + '/' + t + '-' + s + '.mp3';
}

async function storeAudio(env, key, bytes, meta) {
  if (!env.OVERLAY_REFERENCES) return false;
  await env.OVERLAY_REFERENCES.put(key, bytes, {
    httpMetadata: { contentType: 'audio/mpeg' },
    customMetadata: {
      owner: meta.broadcaster || '',
      payer: meta.payerId || '',
      source: meta.source || '',
      ts: String(Date.now()),
    },
  });
  return true;
}

// Public audio URL the overlay loads. Workers R2 has no native presign
// (yet); we route through the worker so we can stamp cache headers +
// reject expired tokens. Token = HMAC(secret, key + '\n' + exp).
async function signAudioUrl(env, key, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const message = key + '\n' + exp;
  const aesKey = await deriveAesKey(env);
  // Re-use the AES key as HMAC seed via raw → HMAC import. We could
  // import a separate HMAC key from the same seed; AES-GCM derive doesn't
  // share the same usages. Quick path: re-derive a raw key bytes from the
  // same seed and import as HMAC.
  void aesKey;
  const seed = new TextEncoder().encode(
    (env.AQUILO_SITE_WEB_SECRET || 'dev') + ':tts-url-v1',
  );
  const hash = await crypto.subtle.digest('SHA-256', seed);
  const hmacKey = await crypto.subtle.importKey(
    'raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    'HMAC', hmacKey, new TextEncoder().encode(message),
  );
  const sigHex = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return `/api/tts/audio/${encodeURIComponent(key)}?exp=${exp}&sig=${sigHex}`;
}

async function verifyAudioSig(env, key, exp, sig) {
  if (!exp || !sig) return false;
  if (Math.floor(Date.now() / 1000) > parseInt(exp, 10)) return false;
  const seed = new TextEncoder().encode(
    (env.AQUILO_SITE_WEB_SECRET || 'dev') + ':tts-url-v1',
  );
  const hash = await crypto.subtle.digest('SHA-256', seed);
  const hmacKey = await crypto.subtle.importKey(
    'raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const sigBytes = new Uint8Array(sig.length / 2);
  for (let i = 0; i < sig.length; i += 2) sigBytes[i >> 1] = parseInt(sig.slice(i, i + 2), 16);
  return crypto.subtle.verify(
    'HMAC', hmacKey, sigBytes,
    new TextEncoder().encode(key + '\n' + exp),
  );
}

// ── Route handlers ──────────────────────────────────────────────────
export async function handleTtsSettingsRead(req, env, path) {
  const broadcaster = path.split('/').pop() || '';
  if (!broadcaster) return bad('broadcaster required', 400);
  const body = '';                                                  // GET, no body in HMAC
  const ok = await verifyTtsAuth(req, env, body);
  if (!ok) return bad('unauthorized', 401);
  const cfg = await readCfg(env, broadcaster);
  return json({ ok: true, cfg: publicCfg(cfg) });
}

export async function handleTtsSettingsWrite(req, env, path) {
  const broadcaster = path.split('/').pop() || '';
  if (!broadcaster) return bad('broadcaster required', 400);
  const body = await req.text();
  const ok = await verifyTtsAuth(req, env, body);
  if (!ok) return bad('unauthorized', 401);
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { return bad('bad json', 400); }
  const cur = (await readCfg(env, broadcaster)) || {};
  const next = { ...cur };
  if (typeof payload.provider === 'string') {
    if (PROVIDERS_V1.has(payload.provider)) next.provider = payload.provider;
    else if (PROVIDERS_COMING_SOON.has(payload.provider)) {
      return bad('provider-coming-soon', 400);
    }
  }
  if (typeof payload.voice === 'string') next.voice = payload.voice;
  if (typeof payload.tier === 'string' && TIERS_V1.has(payload.tier)) {
    next.tier = payload.tier;
  }
  if (typeof payload.cooldownSec === 'number') {
    next.cooldownSec = Math.max(0, Math.min(3600, Math.floor(payload.cooldownSec)));
  }
  if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
    const { keyCipherB64, keyIvB64 } = await encryptKey(env, payload.apiKey.trim());
    next.keyCipherB64 = keyCipherB64;
    next.keyIvB64 = keyIvB64;
  }
  if (payload.clearKey === true) {
    delete next.keyCipherB64;
    delete next.keyIvB64;
  }
  await writeCfg(env, broadcaster, next);
  return json({ ok: true, cfg: publicCfg(next) });
}

export async function handleTtsGenerate(req, env) {
  const body = await req.text();
  const ok = await verifyTtsAuth(req, env, body);
  if (!ok) return bad('unauthorized', 401);
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { return bad('bad json', 400); }
  const broadcaster = String(payload.broadcaster || '');
  if (!broadcaster) return bad('broadcaster required', 400);
  const text = String(payload.text || '').slice(0, MAX_TEXT_LEN).trim();
  if (!text) return bad('text required', 400);
  const payerId   = String(payload.payerId   || '');
  const payerName = String(payload.payerName || '');
  const source    = String(payload.source    || 'unknown');
  const payerTier = String(payload.tier      || 'everyone');

  const cfg = (await readCfg(env, broadcaster)) || {};
  const cfgTier = cfg.tier || 'everyone';
  if (!tierAllows(cfgTier, payerTier)) {
    return json({ ok: false, error: 'tier-blocked', cfgTier, payerTier });
  }
  const cooldownSec = Number(cfg.cooldownSec) || COOLDOWN_DEFAULT_SEC;
  const cool = await takeCooldown(env, broadcaster, payerId, cooldownSec);
  if (!cool.ok) {
    return json({ ok: false, error: 'cooldown', remainSec: cool.remainSec });
  }

  const provider = (payload.provider || cfg.provider || 'browser');
  const voice    = (payload.voice    || cfg.voice    || 'alloy');

  let audioUrl = null;
  let r2Key = null;
  if (provider === 'openai') {
    const apiKey = await decryptKey(env, cfg);
    if (!apiKey) return json({ ok: false, error: 'no-api-key' });
    const synth = await synthOpenAi(apiKey, voice, text);
    if (!synth.ok) return json({ ok: false, error: 'openai-failed', status: synth.status });
    r2Key = newAudioKey(broadcaster);
    const stored = await storeAudio(env, r2Key, synth.bytes, {
      broadcaster, payerId, source,
    });
    if (!stored) return json({ ok: false, error: 'r2-not-wired' });
    audioUrl = await signAudioUrl(env, r2Key, 3600);
  }
  // 'browser' (and anything else) leaves audioUrl null; the overlay
  // falls back to window.speechSynthesis on receipt.

  const evt = {
    kind: 'tts',
    broadcaster,
    provider,
    voice,
    text,
    payerId,
    payerName,
    source,
    audioUrl,
    r2Key,
    ts: Date.now(),
  };
  await publishTts(env, broadcaster, evt);

  return json({ ok: true, event: evt });
}

export async function handleTtsAudio(req, env, path) {
  // path = /api/tts/audio/<encoded-key>?exp=&sig=
  const url = new URL(req.url);
  const keyRaw = path.replace(/^\/api\/tts\/audio\//, '');
  const key = decodeURIComponent(keyRaw);
  const exp = url.searchParams.get('exp') || '';
  const sig = url.searchParams.get('sig') || '';
  const ok = await verifyAudioSig(env, key, exp, sig);
  if (!ok) return new Response('bad signature or expired', { status: 401 });
  if (!env.OVERLAY_REFERENCES) return new Response('r2-not-wired', { status: 503 });
  const obj = await env.OVERLAY_REFERENCES.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'audio/mpeg',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
}

export async function handleTtsEventsSse(req, env, path) {
  // Open the per-broadcaster TtsBroadcaster DO and forward.
  const broadcaster = path.replace(/^\/api\/tts\/events\//, '').replace(/\/+$/, '');
  if (!broadcaster) return new Response('broadcaster required', { status: 400 });
  if (!env.TTS_DO) return new Response('do-not-wired', { status: 503 });
  const id = env.TTS_DO.idFromName(broadcaster);
  const stub = env.TTS_DO.get(id);
  return stub.fetch('https://do/sse', { headers: req.headers });
}

// Used by the admin UI's "Preview" button. Same as generate but always
// owner-tier, fixed source, ignores cooldown.
export async function handleTtsPreview(req, env) {
  const body = await req.text();
  const ok = await verifyTtsAuth(req, env, body);
  if (!ok) return bad('unauthorized', 401);
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { return bad('bad json', 400); }
  const broadcaster = String(payload.broadcaster || '');
  if (!broadcaster) return bad('broadcaster required', 400);
  const text = String(payload.text || 'Hello from Aquilo TTS preview.').slice(0, MAX_TEXT_LEN);
  const cfg = (await readCfg(env, broadcaster)) || {};
  const provider = payload.provider || cfg.provider || 'browser';
  const voice    = payload.voice    || cfg.voice    || 'alloy';
  if (provider === 'openai') {
    const apiKey = await decryptKey(env, cfg);
    if (!apiKey) return json({ ok: false, error: 'no-api-key' });
    const synth = await synthOpenAi(apiKey, voice, text);
    if (!synth.ok) return json({ ok: false, error: 'openai-failed', status: synth.status });
    const r2Key = newAudioKey(broadcaster);
    const stored = await storeAudio(env, r2Key, synth.bytes, {
      broadcaster, payerId: 'preview', source: 'preview',
    });
    if (!stored) return json({ ok: false, error: 'r2-not-wired' });
    const audioUrl = await signAudioUrl(env, r2Key, 1800);
    const evt = {
      kind: 'tts', broadcaster, provider, voice, text,
      payerId: 'preview', payerName: 'Owner preview',
      source: 'preview', audioUrl, r2Key, ts: Date.now(),
    };
    await publishTts(env, broadcaster, evt);
    return json({ ok: true, event: evt });
  }
  // Browser preview: just push the SSE event with no audio URL.
  const evt = {
    kind: 'tts', broadcaster, provider: 'browser', voice, text,
    payerId: 'preview', payerName: 'Owner preview',
    source: 'preview', audioUrl: null, r2Key: null, ts: Date.now(),
  };
  await publishTts(env, broadcaster, evt);
  return json({ ok: true, event: evt });
}

export { ownerFromReq };
