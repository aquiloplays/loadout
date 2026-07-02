// Card picture upload — a viewer uploads a custom image for their check-in
// card. Stored in R2 (OVERLAY_REFERENCES bucket, `card/<uid>/<ts>.<ext>`) and
// served back through GET /card-image/<key> (no public R2 domain needed).
//
// Upload is HMAC-gated: aquilo.gg's /api/web/card-image proxies the signed-in
// viewer and signs `${ts}\n${uid}` with AQUILO_SITE_WEB_SECRET (the binary
// image is the body; the MAC is over the compact header string so we don't
// have to hash megabytes). The served URL becomes the card's imageUrl.

import { verifyHmac } from './auth.js';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  });
}

// POST /web/card-image
export async function handleCardImageUpload(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!env.AQUILO_SITE_WEB_SECRET) return json({ error: 'not-configured' }, 503);
  if (!env.OVERLAY_REFERENCES) return json({ error: 'r2-not-wired' }, 503);

  const ts = req.headers.get('x-aquilo-web-ts') || '';
  const sig = req.headers.get('x-aquilo-web-sig') || '';
  const uid = String(req.headers.get('x-aquilo-uid') || '');
  if (!/^[0-9]{3,25}$/.test(uid)) return json({ error: 'bad-uid' }, 400);
  if (!(await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts, uid, sig))) return json({ error: 'unauthorized' }, 401);

  const mime = String(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED.has(mime)) return json({ error: 'unsupported-mime', mime }, 415);
  const buf = await req.arrayBuffer();
  if (!buf || buf.byteLength === 0) return json({ error: 'empty' }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ error: 'too-large', limit: MAX_BYTES }, 413);

  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
  const key = `card/${uid}/${Date.now()}.${ext}`;
  await env.OVERLAY_REFERENCES.put(key, new Uint8Array(buf), {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=86400' },
    customMetadata: { uid },
  });
  const base = String(env.PUBLIC_WORKER_URL || 'https://loadout-discord.aquiloplays.workers.dev').replace(/\/$/, '');
  return json({ ok: true, url: `${base}/card-image/${key}`, bytes: buf.byteLength, mime });
}

// GET /card-image/<key...> — public serve of an uploaded card image.
export async function serveCardImage(env, path) {
  if (!env.OVERLAY_REFERENCES) return json({ error: 'r2-not-wired' }, 503);
  const key = decodeURIComponent(path.replace(/^\/card-image\//, ''));
  // Only serve keys under card/ and reject traversal.
  if (!key || key.indexOf('card/') !== 0 || key.indexOf('..') >= 0) return json({ error: 'bad-key' }, 400);
  const obj = await env.OVERLAY_REFERENCES.get(key);
  if (!obj) return json({ error: 'not-found' }, 404);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/png',
      'cache-control': 'public, max-age=86400',
      'access-control-allow-origin': '*',
    },
  });
}
