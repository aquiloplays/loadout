// Discord Ed25519 signature verification using the discord-interactions
// library. Earlier this file hand-rolled WebCrypto Ed25519, which works
// in unit tests but kept failing Discord's developer-portal endpoint
// verification — silent false return, no error trace. Switching to the
// library removes my code as a variable; if it can't verify, the issue
// is elsewhere (public key mismatch, body mutation upstream, etc.).
//
// Library source: https://github.com/discord/discord-interactions-js
// Internals: crypto.subtle.verify('Ed25519', ...).

import { verifyKey } from 'discord-interactions';

export async function verifyDiscordSignature(req, publicKeyHex) {
  const sig = req.headers.get('x-signature-ed25519');
  const ts  = req.headers.get('x-signature-timestamp');
  if (!sig || !ts || !publicKeyHex) return { ok: false, body: null };

  const body = await req.text();
  try {
    const ok = await verifyKey(body, sig, ts, publicKeyHex);
    return { ok, body };
  } catch (e) {
    console.error('[auth] verifyKey threw:', e?.message || e);
    return { ok: false, body };
  }
}

// HMAC-SHA-256 verification for /sync/:guildId calls. Loadout-side, not
// Discord, so we keep using WebCrypto directly here.
export async function verifyHmac(secret, ts, body, hexSig) {
  const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts || '0', 10));
  if (!secret || !ts || !hexSig || skew > 300) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = hexToBytes(hexSig);
    const message = new TextEncoder().encode(ts + '\n' + body);
    return await crypto.subtle.verify('HMAC', key, sigBytes, message);
  } catch { return false; }
}

function hexToBytes(h) {
  if (typeof h !== 'string' || h.length % 2 !== 0) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {
    const b = parseInt(h.slice(i, i + 2), 16);
    if (Number.isNaN(b)) return null;
    out[i >> 1] = b;
  }
  return out;
}

// Twitch Extension JWT verification (HS256). The extension "secret" from
// the Twitch dev console is base64-encoded; decode it to the HMAC key.
// Returns the decoded payload ({ channel_id, opaque_user_id, user_id?,
// role, exp, ... }) on success, or null on any failure — so callers can
// treat null as "unauthorized" without distinguishing the cause.
export async function verifyTwitchExtJwt(token, base64Secret) {
  if (!token || !base64Secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const keyBytes = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(parts[2]), data);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (!payload || typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// Sign an HS256 JWT with the same base64-encoded extension secret used
// by verifyTwitchExtJwt. Used by the panel-bridge Patreon-link route to
// mint a short-lived JWT that the aquilo-site Pages Function can verify
// (both sides share TWITCH_EXT_SECRET). Caller supplies `payload`; an
// `exp` should be set there.
export async function signHs256(base64Secret, payload) {
  const headerB64 = b64url(new TextEncoder().encode(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ));
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = headerB64 + '.' + payloadB64;
  const keyBytes = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(data),
  );
  return data + '.' + b64url(new Uint8Array(sig));
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlToBytes(s) {
  let b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Twitch Bits transaction receipt — signed with the same HS256 extension
// secret as the auth JWT. Verifies the signature and returns the payload
// ({ topic, exp?, data: { transactionId, userId, product: { sku, cost } } })
// or null. `exp` is checked only when present (receipts may omit it).
export async function verifyBitsReceipt(token, base64Secret) {
  if (!token || !base64Secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const keyBytes = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(parts[2]), data);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (payload && typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
