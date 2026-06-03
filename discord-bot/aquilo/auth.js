// Discord Ed25519 signature verification using discord-interactions library.
//
// Earlier this file hand-rolled the Ed25519 verify against Cloudflare's
// WebCrypto. Worked in tests but Discord's developer-portal "verify
// endpoint" save kept failing, and the failure mode was a silent
// crypto.subtle.verify -> false, no error trace, hard to diagnose. We
// switched to the discord-interactions library because:
//   1. It's used by 100k+ Discord bots; if it can't verify, the issue
//      is elsewhere (key value, body mutation, etc.).
//   2. Removes my code as a variable when debugging.
//   3. Their verifyKey exposes a Boolean, same shape we need.
//
// Library source: https://github.com/discord/discord-interactions-js
// Internally uses crypto.subtle.verify('Ed25519', ...) against an
// importKey('raw', ..., { name: 'Ed25519' }).

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
    // Surface a hint about what failed - hex parse error, key length wrong,
    // WebCrypto rejection, etc. The body comes back regardless so the caller
    // can still parse + return a 401 cleanly.
    console.error('[auth] verifyKey threw:', e?.message || e);
    return { ok: false, body };
  }
}

// HMAC-SHA-256 verification for /sync/:guildId calls. Keeps using
// WebCrypto directly since this is Loadout-side, not Discord-spec.
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
