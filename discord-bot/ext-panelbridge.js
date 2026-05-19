// B3 panel-bridge — the cloud half of the DLL <-> panel live-state
// channel (sub-phase 1: state DOWN, read-only).
//
// The DLL's PanelBridgeModule (Clay's install only, gated by
// %APPDATA%\Aquilo\panel-bridge.json) POSTs serialized dungeon /
// mini-game state to /relay/dll-ingest. The panel reads it back via
// the JWT-gated /ext/dungeon/state and /ext/minigame/state routes.

import { json } from './ext-shared.js';

// How long a pushed state stays "live". KV's own expirationTtl floors
// at 60s; the tighter window is enforced here off the stored ts, so
// the panel hides promptly once the DLL stops pushing.
const STATE_TTL_MS = 30 * 1000;

const STATE_KEY = { dungeon: 'panelbridge:dungeon', minigame: 'panelbridge:minigame' };

// POST /relay/dll-ingest — token-gated (X-Relay-Token), not JWT: the
// caller is the local DLL module, not a Twitch viewer.
export async function ingestDllState(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const token = req.headers.get('X-Relay-Token') || '';
  if (!env.RELAY_TOKEN || token !== env.RELAY_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad-json' }, 400);
  }
  const key = STATE_KEY[String(body && body.type)];
  if (!key) return json({ error: 'bad-type' }, 400);
  const record = {
    active: body.active === false ? false : true,
    state: body.state || null,
    ts: Date.now(),
  };
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(record), { expirationTtl: 60 });
  return json({ ok: true });
}

// GET /ext/{dungeon,minigame}/state — JWT-gated panel reads. Returns
// the cached state, or { active: false } when nothing is live.
export async function panelBridgeState(env, kind) {
  const key = STATE_KEY[kind];
  if (!key) return json({ active: false });
  let rec = null;
  try {
    rec = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  } catch {
    /* treat a read failure as idle */
  }
  if (!rec || rec.active === false || Date.now() - (rec.ts || 0) > STATE_TTL_MS) {
    return json({ active: false });
  }
  return json({ active: true, state: rec.state || null, ts: rec.ts });
}
