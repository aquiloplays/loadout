// Tier 2 viewer-engagement routes, /ext/cheer, and (as those features
// ship) the poll / quiz / code / raise-hand viewer endpoints.
//
// Every viewer action is JWT- + channel-gated by ext.js. Overlay-bound
// results are enqueued as relay:overlay-* KV triggers carrying a
// bus_kind, which the unified Aquilo Relay action republishes onto the
// local bus for the OBS engagement overlay.

import { json, debounced } from './ext-shared.js';

// Tap-to-cheer emote set, kept in sync with the panel's cheer bar.
export const CHEER_EMOTES = ['🔥', '⚡', '💜', '🎮', '☕', '👏'];

// Enqueue an overlay-bound trigger for the unified relay (?for=overlay).
export async function enqueueOverlay(env, trigger) {
  await env.LOADOUT_BOLTS.put(
    `relay:overlay-${crypto.randomUUID()}`,
    JSON.stringify(trigger),
    { expirationTtl: 120 },
  );
}

async function routeCheer(env, guildId, userId, body) {
  const emote = String(body.emote || '');
  if (CHEER_EMOTES.indexOf(emote) === -1) return json({ ok: false, reason: 'bad-emote' }, 400);
  if (await debounced(env, 'cheer-' + emote, guildId, userId)) {
    return json({ ok: false, reason: 'debounce' }, 429);
  }
  await enqueueOverlay(env, {
    type: 'cheer',
    bus_kind: 'cheer.shown',
    emote,
    user: String(body.displayName || '').slice(0, 40),
    ts: Date.now(),
  });
  return json({ ok: true });
}

// Dispatched from ext.js handleExt for Tier 2 engagement routes.
export async function handleEngage(env, guildId, userId, route, req) {
  let body = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { /* empty body tolerated */ }
  }
  if (req.method === 'POST' && route === 'cheer') {
    return routeCheer(env, guildId, userId, body);
  }
  return json({ error: 'not-found' }, 404);
}
