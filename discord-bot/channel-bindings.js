// Per-guild channel bindings — KV-backed config with wrangler.toml
// fallback. Lets Clay rebind a channel (queue / live / recap / clips
// / lfg) without redeploying the worker.
//
// Resolution order:
//   1. KV `channel-binding:<guildId>:<key>` (string value, the
//      channel snowflake)
//   2. wrangler.toml [vars] env-var fallback (per BINDING_ENV_FALLBACK
//      below) — preserves legacy behaviour when nothing is bound
//   3. null (caller decides whether to skip / surface an error)
//
// Admin route POST /admin/channels/bind/<guildId> takes
//   { binding, channelId }
// and writes the KV entry. channelId="" clears the binding so the
// fallback re-engages. binding must be one of BINDING_KEYS.

const BINDING_KEYS = Object.freeze([
  'queue', 'live', 'recap', 'clips', 'lfg', 'schedule', 'poll',
  // Phase: CN games-list catalogue channel (cn-games-list-hub.js)
  'games-list',
  // Phase 1 channel hubs (check-in / character / bolts / play /
  // achievements) — see <key>-hub.js for each.
  'checkin', 'character', 'bolts', 'play', 'achievements',
]);

// Source-of-truth mapping from binding key → fallback env var name.
// Adding a new binding key is two edits: append to BINDING_KEYS +
// add the env var here. (No env fallback for hub-channel bindings
// — they're KV-only; admins set them via /admin/channels/bind/<g>.)
const BINDING_ENV_FALLBACK = Object.freeze({
  queue:        'QUEUE_CHANNEL_ID',
  live:         'LIVE_CHANNEL_ID',
  recap:        'RECAP_CHANNEL_ID',
  clips:        'CLIPS_CHANNEL_ID',
  lfg:          'LFG_CHANNEL_ID',
  schedule:     'SCHEDULE_CHANNEL_ID',
  poll:         'POLL_CHANNEL_ID',
  'games-list': null,
  checkin:      'CHECKIN_CHANNEL_ID',
  character:    null,
  bolts:        null,
  play:         null,
  achievements: null,
});

const BINDING_KEY = (g, k) => `channel-binding:${g}:${k}`;

export function isValidBinding(key) {
  return BINDING_KEYS.includes(String(key));
}

// Async — KV reads are async. Every call site that needs a channel
// id calls this. Returns the resolved channel snowflake or null.
// `guildId` may be null (worker has no guild context) — falls
// straight to the env-var fallback.
export async function getChannelBinding(env, guildId, key) {
  if (!isValidBinding(key)) return null;
  if (guildId && env?.LOADOUT_BOLTS) {
    try {
      const v = await env.LOADOUT_BOLTS.get(BINDING_KEY(guildId, key));
      if (v && /^\d{5,25}$/.test(v)) return v;
    } catch { /* fall through to env */ }
  }
  const envVar = BINDING_ENV_FALLBACK[key];
  const fallback = envVar ? env?.[envVar] : null;
  if (fallback && /^\d{5,25}$/.test(String(fallback))) return String(fallback);
  return null;
}

// Set / clear a binding. channelId === '' clears (deletes the KV
// entry → next read falls back to env). Returns the new resolved
// value the caller can echo in the response.
export async function setChannelBinding(env, guildId, key, channelId) {
  if (!isValidBinding(key)) return { ok: false, error: 'unknown-binding', allowed: BINDING_KEYS };
  if (!guildId) return { ok: false, error: 'no-guild-id' };
  const raw = String(channelId || '').trim();
  if (raw === '') {
    await env.LOADOUT_BOLTS.delete(BINDING_KEY(guildId, key)).catch(() => {});
    const fallback = await getChannelBinding(env, guildId, key);
    return { ok: true, binding: key, channelId: null, fallback };
  }
  if (!/^\d{5,25}$/.test(raw)) return { ok: false, error: 'bad-channel-id' };
  await env.LOADOUT_BOLTS.put(BINDING_KEY(guildId, key), raw);
  return { ok: true, binding: key, channelId: raw };
}

// Bulk read for the admin status surface — returns { key: { kv,
// env, resolved } } for every binding. KV value is what /admin set;
// env is the wrangler fallback; resolved is the effective value.
export async function listChannelBindings(env, guildId) {
  const out = {};
  for (const key of BINDING_KEYS) {
    const envVar = BINDING_ENV_FALLBACK[key];
    let kv = null;
    if (guildId && env?.LOADOUT_BOLTS) {
      try { kv = await env.LOADOUT_BOLTS.get(BINDING_KEY(guildId, key)); }
      catch { kv = null; }
    }
    const envVal = envVar ? (env?.[envVar] || null) : null;
    out[key] = {
      kv:       kv || null,
      env:      envVal || null,
      envVar,
      resolved: (kv && /^\d{5,25}$/.test(kv)) ? kv
              : (envVal && /^\d{5,25}$/.test(String(envVal))) ? String(envVal)
              : null,
    };
  }
  return out;
}

export const _BINDING_KEYS_FOR_TEST = BINDING_KEYS;
export const _BINDING_ENV_FALLBACK_FOR_TEST = BINDING_ENV_FALLBACK;
