// Per-user Boltbound card art overrides.
//
// Cards in cards-content.js are a STATIC catalogue — every player
// who owns a copy of "MIMESIS" sees the same baked sprite at
// aquilo.gg/sprites/cards/<cardId>.png. This module adds a thin
// per-(guild, user, cardId) override layer so players can swap the
// rendered asset for a meme GIF without us editing the catalogue.
//
// Storage:
//   KV `cards:art-override:<g>:<u>:<cardId>` →
//     { memeGifUrl, contentLength, validatedAt, updatedAt }
//
// Rendering integration (2026-05-28): the per-user `artOverrides`
// map is attached to the cards-web bootstrap response (routeState in
// cards-web.js). The site renderer prefers artOverrides[cardId] over
// the static spriteId in every card-display surface (collection,
// deck builder, pack reveals, match boards). Editor write paths still
// go through /web/cards/art-override (op:set/clear).
//
// Validation:
//   • URL must be https://
//   • HEAD request → Content-Type must start with "image/gif"
//   • Content-Length must be ≤ MAX_BYTES (5 MB)
//   • Origin must be on an allowed list (giphy / tenor / imgur /
//     media.discordapp.net / cdn.discordapp.com / aquilo.gg). Keeps
//     us off arbitrary user-hosted URLs that could rotate to NSFW
//     content after the validation pass.
//
// Content-rating gate (Giphy/Tenor "g" or "pg" only) is enforced by
// the caller — when the player picks a GIF via the search modal in
// the editor, the editor passes only `rating: 'pg'` to the Giphy
// search. URLs pasted directly fall back to the host-allowlist
// check; we can't read a rating off a raw CDN URL.

import { CARDS } from './cards-content.js';

const KEY_PREFIX = 'cards:art-override:';
const KEY = (g, u, cardId) => `${KEY_PREFIX}${g}:${u}:${cardId}`;
const MAX_BYTES = 5_000_000;   // 5 MB cap (Clay's spec)

// Allow-list of hosts a meme-GIF URL can come from. Most direct GIF
// CDNs from the major search providers + Discord's own CDN. Tenor +
// Giphy both stream from these origins; raw `.gif` URLs elsewhere
// (random forum hotlinks, etc.) get rejected at validation time so
// we're not chasing rotated/expired sources.
const ALLOWED_HOSTS = new Set([
  'media.giphy.com',
  'i.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'media.tenor.com',
  'c.tenor.com',
  'i.imgur.com',
  'media.discordapp.net',
  'cdn.discordapp.com',
  'aquilo.gg',
]);

function isHostAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

// HEAD-check the URL: confirm it returns image/gif AND fits the
// size cap. Returns { ok, contentLength, contentType, status, error? }.
// Some CDNs (Giphy) reject HEAD with 405; if that happens we fall
// through to a partial GET (Range: bytes=0-7) so we can at least
// sniff the magic bytes and read Content-Type from the response.
async function probeGifUrl(url) {
  let headRes;
  try {
    headRes = await fetch(url, { method: 'HEAD',
      headers: { 'User-Agent': 'loadout-discord/cards-art-override' } });
  } catch (e) {
    return { ok: false, error: 'fetch-failed', detail: e?.message || String(e) };
  }

  if (headRes.status === 405 || headRes.status === 403) {
    // CDN refused HEAD — fall back to a tiny ranged GET. Even if the
    // CDN ignores the Range header we cap on Content-Length below.
    try {
      const ranged = await fetch(url, {
        headers: { 'Range': 'bytes=0-7', 'User-Agent': 'loadout-discord/cards-art-override' },
      });
      if (!ranged.ok && ranged.status !== 206) {
        return { ok: false, error: 'probe-failed', status: ranged.status };
      }
      const contentType = String(ranged.headers.get('content-type') || '').toLowerCase();
      const contentLength = parseInt(ranged.headers.get('content-length') || '0', 10) || 0;
      // Also sniff the first 4 bytes for the GIF89a magic — belt
      // and braces against a server lying about Content-Type.
      const bytes = new Uint8Array(await ranged.arrayBuffer());
      const magic = String.fromCharCode(...bytes.slice(0, 4));
      const isGifMagic = magic === 'GIF8';
      if (!contentType.startsWith('image/gif') && !isGifMagic) {
        return { ok: false, error: 'not-gif', contentType, magic };
      }
      if (contentLength && contentLength > MAX_BYTES) {
        return { ok: false, error: 'too-large', contentLength };
      }
      return { ok: true, contentType: contentType || 'image/gif', contentLength };
    } catch (e) {
      return { ok: false, error: 'ranged-fetch-failed', detail: e?.message || String(e) };
    }
  }

  if (!headRes.ok) {
    return { ok: false, error: 'bad-status', status: headRes.status };
  }
  const contentType = String(headRes.headers.get('content-type') || '').toLowerCase();
  const contentLength = parseInt(headRes.headers.get('content-length') || '0', 10) || 0;
  if (!contentType.startsWith('image/gif')) {
    return { ok: false, error: 'not-gif', contentType };
  }
  if (contentLength > MAX_BYTES) {
    return { ok: false, error: 'too-large', contentLength };
  }
  return { ok: true, contentType, contentLength };
}

// ── Public API ───────────────────────────────────────────────────────

export async function getOverride(env, guildId, userId, cardId) {
  if (!guildId || !userId || !cardId) return null;
  return env.LOADOUT_BOLTS.get(KEY(guildId, userId, cardId), { type: 'json' });
}

export async function setOverride(env, guildId, userId, cardId, url) {
  if (!guildId || !userId || !cardId) {
    return { ok: false, error: 'bad-args' };
  }
  // Card must exist in the static catalogue — overriding a non-card
  // is meaningless and a sign of a bad client.
  if (!CARDS[cardId]) {
    return { ok: false, error: 'unknown-card', cardId };
  }
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'url-required' };
  }
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    return { ok: false, error: 'url-must-be-https' };
  }
  if (!isHostAllowed(trimmed)) {
    return { ok: false, error: 'host-not-allowed',
             message: 'URL must be from Giphy, Tenor, Imgur, Discord CDN, or aquilo.gg.' };
  }
  const probe = await probeGifUrl(trimmed);
  if (!probe.ok) {
    return { ok: false, error: probe.error, detail: probe };
  }
  const now = Date.now();
  const record = {
    memeGifUrl:    trimmed,
    contentLength: probe.contentLength || null,
    contentType:   probe.contentType || 'image/gif',
    validatedAt:   now,
    updatedAt:     now,
  };
  await env.LOADOUT_BOLTS.put(KEY(guildId, userId, cardId), JSON.stringify(record));
  return { ok: true, override: record };
}

export async function clearOverride(env, guildId, userId, cardId) {
  if (!guildId || !userId || !cardId) return { ok: false, error: 'bad-args' };
  await env.LOADOUT_BOLTS.delete(KEY(guildId, userId, cardId));
  return { ok: true };
}

// List every override the user has set for a given guild. Used by
// the editor UI to show "you've customised these N cards" status.
// KV list is a single round-trip with a prefix scan — fine for a
// per-user view (player will have at most a few dozen overrides
// in practice).
export async function listOverridesForUser(env, guildId, userId) {
  if (!guildId || !userId) return [];
  const prefix = `${KEY_PREFIX}${guildId}:${userId}:`;
  const out = [];
  let cursor = undefined;
  for (let i = 0; i < 8; i++) {   // safety cap, avoid runaway lists
    const page = await env.LOADOUT_BOLTS.list({ prefix, cursor });
    for (const k of (page.keys || [])) {
      const cardId = String(k.name || '').slice(prefix.length);
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (rec) out.push({ cardId, ...rec });
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}
