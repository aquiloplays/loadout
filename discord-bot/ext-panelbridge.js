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

// --- B3 sub-phase 2: commands UP (panel -> DLL) -----------------------
//
// The panel POSTs viewer-driven game commands; the DLL's PanelBridgeModule
// polls them back and replays each as a synthesized chat event into its
// existing game engines (no engine changes — the engines already parse
// chat commands).

// Per-kind action allowlists — anything else is rejected at the edge so
// the DLL only ever sees a known-good verb.
const CMD_ACTIONS = {
  dungeon: ['dungeon', 'join', 'duel'],
  minigame: ['coinflip', 'dice', 'slots', 'rps', 'roulette'],
};

// Freeform command argument (wager, dice target, rps pick, @duel-target).
// Kept deliberately small + plain so a queued command can't smuggle
// anything odd into the synthesized chat line on the DLL side.
function cleanCmdArg(v) {
  return String(v == null ? '' : v)
    .replace(/[^\w @-]/g, '')
    .trim()
    .slice(0, 40);
}

// POST /ext/{dungeon,minigame}/cmd — JWT-gated. handleExt has already
// verified the Twitch ext JWT and the channel gate, so `payload` is
// trusted; only `role` is security-relevant (it gates !dungeon etc.).
export async function enqueuePanelCmd(env, kind, payload, req) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const actions = CMD_ACTIONS[kind];
  if (!actions) return json({ error: 'bad-kind' }, 400);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad-json' }, 400);
  }
  const action = String((body && body.action) || '').toLowerCase();
  if (actions.indexOf(action) < 0) return json({ error: 'bad-action' }, 400);

  // role is JWT-derived (trusted); name is cosmetic — it only steers which
  // wallet the DLL credits, and B3 is Clay-only, so a body value is fine.
  const record = {
    kind,
    action,
    arg: cleanCmdArg(body && body.arg),
    user: {
      id: String(payload.user_id || payload.opaque_user_id || ''),
      name: cleanCmdArg(body && body.name) || 'viewer',
      role: String(payload.role || 'viewer').toLowerCase(),
    },
    ts: Date.now(),
  };
  const key =
    'relay:dll-pending:' + record.ts + '-' + Math.random().toString(36).slice(2, 8);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(record), { expirationTtl: 90 });
  return json({ ok: true });
}

// GET /relay/dll-pending — X-Relay-Token gated, polled by the DLL. Returns
// and deletes every queued command (at-most-once, single poller), oldest
// first so they replay into the engines in submit order.
export async function drainDllCommands(req, env) {
  if (req.method !== 'GET') return json({ error: 'method' }, 405);
  const token = req.headers.get('X-Relay-Token') || '';
  if (!env.RELAY_TOKEN || token !== env.RELAY_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  const list = await env.LOADOUT_BOLTS.list({ prefix: 'relay:dll-pending:' });
  const commands = [];
  for (const k of list.keys) {
    const v = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
    if (v) commands.push(v);
    await env.LOADOUT_BOLTS.delete(k.name);
  }
  commands.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return json({ commands });
}
