// Global card-art defaults — a per-cardId layer that sits between
// the per-user override (cards-art-override.js) and the baked
// sprite. Set once via the backfill script or /admin card-art remix,
// every viewer sees the meme GIF unless they've personally overridden
// the same card.
//
// Render precedence (highest → lowest):
//   1. per-user override   — cards-art-override:<g>:<u>:<cardId>
//   2. global default      — global-card-art:<cardId>       (this module)
//   3. baked sprite        — aquilo.gg/sprites/cards/<cardId>.png
//
// Storage:
//   KV `global-card-art:<cardId>` → JSON record
//     { memeGifUrl, searchTerm?, source?, contentLength?, validatedAt, updatedAt }
//
// Validation rules mirror cards-art-override.js (https only,
// host-allowlist, ≤5MB), so the same allow-list applies whether the
// URL came from the backfill or a Clay-curated remix pick.

import { CARDS } from './cards-content.js';

const KEY_PREFIX = 'global-card-art:';
const KEY        = (cardId) => `${KEY_PREFIX}${cardId}`;
const MAX_BYTES  = 5_000_000;

// Same allow-list as cards-art-override.js — keep them in sync so the
// per-user editor + the backfill share one trust boundary.
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
  // 2026-05-29: worker self-hosts pixel-art card assets at
  // /asset/card-art/<cardId>.png (KV-backed). global-card-art records
  // for the v9 pixel-art rollout point at this origin.
  'loadout-discord.aquiloplays.workers.dev',
]);

export function isHostAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

// ── Public API ───────────────────────────────────────────────────────

export async function getGlobalArt(env, cardId) {
  if (!cardId) return null;
  return env.LOADOUT_BOLTS.get(KEY(cardId), { type: 'json' });
}

export async function setGlobalArt(env, cardId, opts = {}) {
  if (!cardId) return { ok: false, error: 'cardId-required' };
  if (!CARDS[cardId]) return { ok: false, error: 'unknown-card', cardId };
  const url = String(opts.url || '').trim();
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'url-must-be-https' };
  if (!isHostAllowed(url))      return { ok: false, error: 'host-not-allowed' };
  if (opts.contentLength && opts.contentLength > MAX_BYTES) {
    return { ok: false, error: 'too-large', contentLength: opts.contentLength };
  }
  const now = Date.now();
  const record = {
    memeGifUrl:    url,
    searchTerm:    opts.searchTerm || null,
    source:        opts.source     || 'manual',
    contentLength: opts.contentLength || null,
    validatedAt:   opts.validatedAt   || now,
    updatedAt:     now,
  };
  await env.LOADOUT_BOLTS.put(KEY(cardId), JSON.stringify(record));
  return { ok: true, record };
}

export async function clearGlobalArt(env, cardId) {
  if (!cardId) return { ok: false, error: 'cardId-required' };
  await env.LOADOUT_BOLTS.delete(KEY(cardId));
  return { ok: true };
}

// Bulk-set used by the backfill script. Validates each item; partial
// success returns per-item results so the caller knows what landed.
// Skips entries that already have a global art set unless force=true.
export async function bulkSetGlobalArt(env, items, opts = {}) {
  if (!Array.isArray(items)) return { ok: false, error: 'items-array-required' };
  const force = !!opts.force;
  const out = { ok: true, set: 0, skipped: 0, failed: [] };
  for (const it of items) {
    const cardId = String(it?.cardId || '').trim();
    if (!cardId) { out.failed.push({ cardId, error: 'cardId-required' }); continue; }
    if (!force) {
      const existing = await env.LOADOUT_BOLTS.get(KEY(cardId));
      if (existing) { out.skipped++; continue; }
    }
    const r = await setGlobalArt(env, cardId, it);
    if (r.ok) out.set++;
    else      out.failed.push({ cardId, error: r.error });
  }
  return out;
}

// Read every global default in one call. Returns a compact
// { [cardId]: memeGifUrl } map so the bootstrap response can include
// the entire defaults table without ballooning the payload — the per-
// card record (searchTerm, source, validatedAt) is available via
// getGlobalArt(cardId) for the admin UI.
//
// Performance note (2026-05-29): the earlier version of this fn did
// the per-key `get` sequentially inside the page loop. Each KV read
// is a ~10-50ms subrequest, so 500+ entries blew past the bootstrap
// budget and broke /web/boltbound/state on the live Boltbound page. Now
// each page's `get`s run in parallel — wall-clock is one round-trip
// per page instead of N. The 8-page cap (1000 keys/page) covers up
// to 8000 entries; the catalogue is 1252 so two pages suffice.
//
// Cloudflare allows up to 50 simultaneous outbound subrequests per
// worker request and KV reads count as subrequests — but lazy-getting
// in 1000-key chunks would exceed that. So we chunk each page into
// concurrency-limited batches.
const LIST_GET_CONCURRENCY = 20;
export async function listAllGlobalArt(env) {
  const out = {};
  let cursor = undefined;
  for (let i = 0; i < 8; i++) {
    const page = await env.LOADOUT_BOLTS.list({ prefix: KEY_PREFIX, cursor });
    const keys = page.keys || [];
    for (let j = 0; j < keys.length; j += LIST_GET_CONCURRENCY) {
      const chunk = keys.slice(j, j + LIST_GET_CONCURRENCY);
      const recs = await Promise.all(chunk.map(k =>
        env.LOADOUT_BOLTS.get(k.name, { type: 'json' }).catch(() => null)
      ));
      for (let m = 0; m < chunk.length; m++) {
        const k = chunk[m];
        const rec = recs[m];
        const cardId = String(k.name || '').slice(KEY_PREFIX.length);
        if (rec?.memeGifUrl) out[cardId] = rec.memeGifUrl;
      }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

// Bulk-delete every global-card-art entry. Returns { deleted, pages }
// so the caller can surface the count. Used by the 2026-05-29 "axe
// Giphy" admin endpoint — Clay went all-in on pixel art and wants the
// stale Giphy backfill off the precedence chain entirely. The
// pre-existing backup at global-card-art-backup-gifs-2026-05-29:* is
// untouched (different prefix) so the audit trail survives.
//
// Deletes are issued in parallel batches (same concurrency cap as
// reads above) and the function pages through the entire prefix until
// list_complete, so it's safe to call against a fresh state where
// some pixel-art entries have already started landing — only the
// global-card-art:* prefix is touched; the backup prefix is not.
export async function bulkDeleteAllGlobalArt(env) {
  let deleted = 0;
  let pages = 0;
  let cursor = undefined;
  for (let i = 0; i < 8; i++) {
    const page = await env.LOADOUT_BOLTS.list({ prefix: KEY_PREFIX, cursor });
    pages++;
    const keys = page.keys || [];
    for (let j = 0; j < keys.length; j += LIST_GET_CONCURRENCY) {
      const chunk = keys.slice(j, j + LIST_GET_CONCURRENCY);
      await Promise.all(chunk.map(k =>
        env.LOADOUT_BOLTS.delete(k.name).catch(() => null)
      ));
      deleted += chunk.length;
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return { ok: true, deleted, pages };
}
