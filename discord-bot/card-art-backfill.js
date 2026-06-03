// Worker-side Giphy backfill for global Boltbound card art.
//
// Iterates a slice of cards[offset..offset+limit], runs suggestArtTerms,
// hits Giphy per term until a usable GIF is found, persists to KV
// under `global-card-art:<cardId>`. The HTTP layer (worker.js)
// gates with a one-shot bootstrap-card-art-backfill-token KV entry
// and drives this in a curl-loop until `done: true`.
//
// Why server-side rather than a local Node script: GIPHY_API_KEY is
// a worker secret. Exposing it locally just to run a backfill would
// leak the secret + still need a second round-trip to write KV.
// Keeping the search inside the worker gives the script GET/POST
// access to the API key without sharing it outside the binding.
//
// Filters (mirror tools/backfill-card-art.mjs in spirit):
//   - host must be on the same allow-list as cards-art-override.js
//   - file size must be ≤ 5 MB (Giphy reports orig.size when known)
//   - aspect ratio in [0.4, 2.5], reject super-tall or super-wide
//   - rating=pg (SFW gate) at the search layer
//
// Worker CPU time scales with active work, not idle fetch waits, so
// processing 25-50 cards per request is well within the per-invocation
// budget. The default LIMIT keeps things conservative.

import { CARDS } from './cards-content.js';
import { suggestArtTerms } from './cards-art-suggest.js';
import { setGlobalArt, getGlobalArt } from './cards-global-art.js';

const DEFAULT_LIMIT = 25;
const MAX_BYTES     = 5_000_000;
const MIN_ASPECT    = 0.4;
const MAX_ASPECT    = 2.5;
const GIPHY_LIMIT   = 10;
const GIPHY_RATING  = 'pg';
// Default in-slice pacing, sleep between cards. Giphy's free public
// tier rate-limits at ~100 searches/hour per key; at avg 3 terms per
// card the safe budget is ~33 cards/hour = ~108 seconds per card.
// We cap default delay lower than that and let the driver compensate
// with longer between-slice sleeps; ?pacingMs= overrides per-call.
const DEFAULT_PACING_MS = 3500;

const ALLOWED_HOSTS = new Set([
  'media.giphy.com',
  'i.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
]);

function hostAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

function pickGifFromResponse(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  for (const g of data) {
    const orig = g?.images?.original;
    if (!orig?.url) continue;
    if (!hostAllowed(orig.url)) continue;
    const size = parseInt(orig.size || '0', 10) || 0;
    if (size > 0 && size > MAX_BYTES) continue;
    const w = parseInt(orig.width  || '0', 10) || 0;
    const h = parseInt(orig.height || '0', 10) || 0;
    if (w > 0 && h > 0) {
      const ratio = h / w;
      if (ratio < MIN_ASPECT || ratio > MAX_ASPECT) continue;
    }
    return {
      url:           orig.url,
      contentLength: size || null,
      width:         w || null,
      height:        h || null,
      title:         g.title || null,
    };
  }
  return null;
}

async function giphySearch(apiKey, term) {
  const url = new URL('https://api.giphy.com/v1/gifs/search');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('q',       term);
  url.searchParams.set('limit',   String(GIPHY_LIMIT));
  url.searchParams.set('rating',  GIPHY_RATING);
  url.searchParams.set('lang',    'en');
  const resp = await fetch(url.toString());
  if (!resp.ok) return { ok: false, status: resp.status };
  let json;
  try { json = await resp.json(); }
  catch { return { ok: false, status: resp.status, error: 'bad-json' }; }
  return { ok: true, json };
}

// suggestArtTerms ranks SHORTEST FIRST (broader search) which is the
// right default for a user-facing picker, the user sees 6 suggestions
// and picks. For the backfill we want the OPPOSITE: longest first, so
// specific terms like "champion steel" beat the generic type fallback
// "hero" (otherwise every Champion-type card picks the same GIF off
// the top "hero" search result). Single-token name words beat
// type fallbacks for the same reason.
function rerankForBackfill(suggestion) {
  const terms = Array.isArray(suggestion?.searchTerms) ? [...suggestion.searchTerms] : [];
  // Multi-word phrases get the strongest preference (most specific).
  // Beyond that: longer = more specific. Stable sort.
  return terms.sort((a, b) => {
    const aWords = a.split(/\s+/).length;
    const bWords = b.split(/\s+/).length;
    if (aWords !== bWords) return bWords - aWords;
    return b.length - a.length;
  });
}

async function pickArtForCard(apiKey, cardId) {
  const suggestion = suggestArtTerms(cardId);
  if (!suggestion.ok || !suggestion.searchTerms?.length) {
    return { ok: false, reason: 'no-search-terms' };
  }
  const ranked = rerankForBackfill(suggestion);
  for (const term of ranked) {
    let resp;
    try { resp = await giphySearch(apiKey, term); }
    catch (e) { resp = { ok: false, error: String(e?.message || e) }; }
    if (!resp.ok) {
      if (resp.status === 429) return { ok: false, reason: 'rate-limit', term };
      continue;
    }
    const pick = pickGifFromResponse(resp.json);
    if (pick) return { ok: true, ...pick, searchTerm: term };
  }
  return { ok: false, reason: 'no-usable-gif' };
}

// Process one slice of the card catalogue. Default LIMIT=25 keeps
// per-request time conservative (~5-15s real with Giphy round-trips).
//
// Returns:
//   { ok: true, offset, limit, processed, hits, misses, skipped,
//     samples: [{ cardId, cardName, url, term }, ...],   // last few hits
//     nextOffset, total, done }
export async function runCardArtBackfillSlice(env, opts = {}) {
  if (!env.GIPHY_API_KEY) {
    return { ok: false, error: 'no-giphy-api-key' };
  }
  const offset = Math.max(0, parseInt(opts.offset || 0, 10) || 0);
  const limit  = Math.max(1, Math.min(100, parseInt(opts.limit || DEFAULT_LIMIT, 10) || DEFAULT_LIMIT));
  const force  = !!opts.force;
  const pacingMs = Math.max(0, parseInt(opts.pacingMs || DEFAULT_PACING_MS, 10) || DEFAULT_PACING_MS);

  const allIds = Object.keys(CARDS);
  const total  = allIds.length;
  const slice  = allIds.slice(offset, offset + limit);

  const out = {
    ok: true, offset, limit,
    processed: 0, hits: 0, misses: 0, skipped: 0,
    samples: [], failed: [],
    nextOffset: offset + slice.length,
    total,
    done: false,
  };

  for (let i = 0; i < slice.length; i++) {
    const cardId = slice[i];
    out.processed++;

    // Skip if already set (unless force).
    if (!force) {
      const existing = await getGlobalArt(env, cardId);
      if (existing?.memeGifUrl) {
        out.skipped++;
        continue;
      }
    }

    // Per-card pacing (skip the wait before the first card and after
    // a skip-existing, both of which made no Giphy call).
    if (i > 0 && pacingMs > 0) {
      await new Promise(r => setTimeout(r, pacingMs));
    }

    let pick;
    try { pick = await pickArtForCard(env.GIPHY_API_KEY, cardId); }
    catch (e) { pick = { ok: false, reason: 'thrown', detail: String(e?.message || e) }; }

    if (pick.ok) {
      const setResult = await setGlobalArt(env, cardId, {
        url:           pick.url,
        searchTerm:    pick.searchTerm,
        source:        'giphy',
        contentLength: pick.contentLength,
      });
      if (setResult.ok) {
        out.hits++;
        out.samples.push({
          cardId,
          cardName: CARDS[cardId]?.name || cardId,
          url:      pick.url,
          term:     pick.searchTerm,
        });
      } else {
        out.misses++;
        out.failed.push({ cardId, error: setResult.error });
      }
    } else if (pick.reason === 'rate-limit') {
      // Stop this slice early. Rewind nextOffset to the rate-limited
      // card so the next slice retries it; don't count it as a miss
      // since we never actually attempted it (Giphy bounced). Without
      // this rewind, the driver burns through the catalogue without
      // doing work, the bug that lost 700+ cards on the first resume
      // run (driver thought 1155/1252, actual KV was 413).
      out.processed = i;
      out.nextOffset = offset + i;
      out.rateLimited = true;
      break;
    } else {
      out.misses++;
      out.failed.push({ cardId, error: pick.reason });
    }
  }

  // Cap samples to last 5, the operator loop logs these periodically.
  if (out.samples.length > 5) out.samples = out.samples.slice(-5);
  out.done = (out.nextOffset >= total);
  return out;
}
