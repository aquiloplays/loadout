// Shared helpers for the /ext/* route modules — one definition of the
// CORS headers, the JSON response helper, and the per-viewer debounce.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}

const DEBOUNCE_MS = 3000;

// Light per-viewer, per-action debounce. Returns true when the caller is
// still inside the cooldown window (the request should be rejected).
// KV expirationTtl floors at 60s; the 3s window is enforced by the
// stored timestamp — the TTL only auto-cleans the key.
export async function debounced(env, action, guild, userId) {
  const key = `extcd:${action}:${guild}:${userId}`;
  const last = parseInt((await env.LOADOUT_BOLTS.get(key)) || '0', 10);
  const now = Date.now();
  if (last && now - last < DEBOUNCE_MS) return true;
  await env.LOADOUT_BOLTS.put(key, String(now), { expirationTtl: 60 });
  return false;
}
