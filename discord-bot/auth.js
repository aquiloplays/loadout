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
