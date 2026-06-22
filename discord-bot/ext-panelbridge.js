// B3 panel-bridge, the cloud half of the DLL <-> panel live-state
// channel (sub-phase 1: state DOWN, read-only).
//
// The DLL's PanelBridgeModule (Clay's install only, gated by
// %APPDATA%\Aquilo\panel-bridge.json) POSTs serialized dungeon /
// mini-game state to /relay/dll-ingest. The panel reads it back via
// the JWT-gated /ext/dungeon/state and /ext/minigame/state routes.

import { json } from './ext-shared.js';
import { resolveTwitchLoginById } from './ext-loadout.js';
import { verifyBitsReceipt } from './auth.js';
// (Bolts economy sunset 2026-06: the wallet.js `spend` import was
// removed. The dungeon-skip bolts-debit path in skipCooldown is gone;
// the Bits-receipt path is kept. NB: the panel bridge as a whole is no
// longer wired into ext.js — only dungeonCooldownState is still imported
// by ext-mod.js — but the file stays on disk with the DLL dungeon
// surface intact for a future revival.)

// How long a pushed state stays "live". KV's own expirationTtl floors
// at 60s; the tighter window is enforced here off the stored ts, so
// the panel hides promptly once the DLL stops pushing.
const STATE_TTL_MS = 30 * 1000;

const STATE_KEY = {
  dungeon: 'panelbridge:dungeon',
  minigame: 'panelbridge:minigame',
  duel: 'panelbridge:duel',
  cooldown: 'panelbridge:cooldown:dungeon',
};

// POST /relay/dll-ingest, token-gated (X-Relay-Token), not JWT: the
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
  // Cooldown records need to outlive the usual 60 s window, the
  // panel reads them while no dungeon is active, until the cooldown
  // itself expires. Derive TTL from the carried untilUtc + a buffer;
  // everything else keeps the default short TTL so stale dungeon /
  // minigame / duel state ages out cleanly.
  let ttl = 60;
  if (body.type === 'cooldown' && body.state && body.state.untilUtc) {
    const remainMs = Date.parse(body.state.untilUtc) - Date.now();
    if (remainMs > 0) ttl = Math.max(60, Math.ceil(remainMs / 1000) + 30);
  }
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(record), { expirationTtl: ttl });
  return json({ ok: true });
}

// Read-side for cooldown is its own function, the dungeon-style
// `panelBridgeState` enforces a 30-second staleness gate off `ts`,
// which would expire a fresh cooldown record long before its actual
// untilUtc. Here we trust the stored untilUtc directly.
export async function dungeonCooldownState(env) {
  const key = STATE_KEY.cooldown;
  let rec = null;
  try { rec = await env.LOADOUT_BOLTS.get(key, { type: 'json' }); } catch { /* idle */ }
  if (!rec || !rec.state || !rec.state.untilUtc) {
    return json({ active: false });
  }
  const untilMs = Date.parse(rec.state.untilUtc);
  if (!isFinite(untilMs) || Date.now() >= untilMs) {
    return json({ active: false });
  }
  return json({
    active: true,
    untilUtc: rec.state.untilUtc,
    durationSec: rec.state.durationSec || 0,
  });
}

// GET /ext/{dungeon,minigame}/state, JWT-gated panel reads. Returns
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
// existing game engines (no engine changes, the engines already parse
// chat commands).

// Per-kind action allowlists, anything else is rejected at the edge so
// the DLL only ever sees a known-good verb. `skip` is never accepted
// from /ext/dungeon/cmd (it's gated by payment); see skipCooldown below.
const CMD_ACTIONS = {
  dungeon: ['dungeon', 'join', 'duel', 'vote'],
  minigame: ['coinflip', 'dice', 'slots', 'rps', 'roulette'],
};

const SKIP_BITS_SKU = 'dungeon_skip_cooldown';
const SKIP_BOLTS_COST = 500;

// Per-viewer-per-action debounce. KV's expirationTtl floors at 60 s, so
// the entry lives at the cooldown record we actually want: a stored
// ts that we compare against now() against COOLDOWN_MS. Anonymous
// (no viewerId) requests skip the check, at-most-once is the goal,
// not anonymous DoS protection.
const COOLDOWN_MS = 2000;

async function checkCooldown(env, viewerId, action) {
  if (!viewerId) return 0;
  const key = 'cmdcd:' + viewerId + ':' + action;
  let stored = null;
  try { stored = await env.LOADOUT_BOLTS.get(key); } catch { /* idle path */ }
  if (stored) {
    const prev = parseInt(stored, 10);
    if (prev && Date.now() - prev < COOLDOWN_MS) {
      return COOLDOWN_MS - (Date.now() - prev);
    }
  }
  try {
    await env.LOADOUT_BOLTS.put(key, String(Date.now()), { expirationTtl: 60 });
  } catch { /* a missed re-stamp at worst means the next click also gates */ }
  return 0;
}

// Freeform command argument (wager, dice target, rps pick, @duel-target).
// Kept deliberately small + plain so a queued command can't smuggle
// anything odd into the synthesized chat line on the DLL side.
function cleanCmdArg(v) {
  return String(v == null ? '' : v)
    .replace(/[^\w @-]/g, '')
    .trim()
    .slice(0, 40);
}

// POST /ext/{dungeon,minigame}/cmd, JWT-gated. handleExt has already
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

  const viewerId = String(
    (payload && (payload.user_id || payload.opaque_user_id)) || '',
  );
  const wait = await checkCooldown(env, viewerId, action);
  if (wait > 0) return json({ error: 'cooldown', retryMs: wait }, 429);

  // role is JWT-derived (trusted). For identity-shared viewers, resolve
  // user_id -> canonical Twitch login via Helix so the wallet credits the
  // same key as their chat play (cached per-id for 24 h). Opaque-only
  // viewers can't be linked to a chat identity; fall back to the panel-
  // body name (cosmetic, that wallet stays panel-only).
  let canonicalName = '';
  if (payload && payload.user_id) {
    canonicalName = (await resolveTwitchLoginById(env, payload.user_id)) || '';
  }
  const record = {
    kind,
    action,
    arg: cleanCmdArg(body && body.arg),
    user: {
      id: viewerId,
      name: canonicalName || cleanCmdArg(body && body.name) || 'viewer',
      role: String((payload && payload.role) || 'viewer').toLowerCase(),
    },
    ts: Date.now(),
  };
  const key =
    'relay:dll-pending:' + record.ts + '-' + Math.random().toString(36).slice(2, 8);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(record), { expirationTtl: 90 });
  return json({ ok: true });
}

// POST /ext/dungeon/skip-cooldown, JWT-gated, panel-driven. Pays the
// 10-min channel cooldown via either Bits (SKU dungeon_skip_cooldown,
// 100 bits) OR a 500-bolts wallet debit. On success, enqueues a
// dungeon "skip" command into the same dll-pending queue the DLL
// already polls, PanelBridgeModule stamps the trusted skip flag so
// DungeonModule.OnEvent bypasses its cooldown + mod gates exactly once.
export async function skipCooldown(env, guildId, userId, payload, req) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }

  // Path 1: Bits receipt.
  if (body && body.bits) {
    const receipt = await verifyBitsReceipt(body.bits, env.TWITCH_EXT_SECRET);
    const product = receipt && receipt.data && receipt.data.product;
    if (
      !receipt ||
      receipt.topic !== 'bits_transaction_receipt' ||
      !product ||
      product.sku !== SKIP_BITS_SKU
    ) {
      return json({ error: 'bad-payment' }, 402);
    }
  // (Bolts economy sunset: the bolts-debit payment path was removed.
  // Only the Bits-receipt path above remains.)
  } else {
    return json({ error: 'choose-payment' }, 400);
  }

  // Resolve the canonical name same as enqueuePanelCmd, opaque viewers
  // keep their cosmetic body name, identity-shared viewers ride Helix.
  let canonicalName = '';
  if (payload && payload.user_id) {
    canonicalName = (await resolveTwitchLoginById(env, payload.user_id)) || '';
  }
  const record = {
    kind: 'dungeon',
    action: 'skip',
    arg: '',
    user: {
      id: String((payload && (payload.user_id || payload.opaque_user_id)) || ''),
      name: canonicalName || cleanCmdArg(body && body.name) || 'viewer',
      role: String((payload && payload.role) || 'viewer').toLowerCase(),
    },
    ts: Date.now(),
  };
  const key =
    'relay:dll-pending:' + record.ts + '-' + Math.random().toString(36).slice(2, 8);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(record), { expirationTtl: 90 });
  return json({ ok: true });
}

// GET /relay/dll-pending, X-Relay-Token gated, polled by the DLL. Returns
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
