// Per-guild runtime configuration. Lets a streamer point the bot at a
// fresh Discord server via /setup without redeploying the Worker.
//
// Storage layout (KV):
//   config:active_guild_id     - global pointer; cron + bootstrap read this
//   config:<guildId>:<KEY>     - per-guild override of any wrangler [vars] entry
//
// Read model: `envForGuild(env, guildId)` returns a Proxy over `env`. Any
// property read first looks at the per-guild override; if absent, it falls
// through to the original env (which is where bindings like STATE/DB and
// the deploy-time defaults still live). Handlers don't need to change.

const KV_ACTIVE_GUILD = 'config:active_guild_id';
const PREFIX = (gid) => 'config:' + gid + ':';

// Every key the /setup wizard may write. Used by the overview render so
// we can show "unset" for missing values without listing the full KV.
export const SETUP_KEYS = [
  // Channels A (5)
  'SCHEDULE_CHANNEL_ID',
  'POLL_CHANNEL_ID',
  'QUEUE_CHANNEL_ID',
  'ENGAGEMENT_CHANNEL_ID',
  'COUNTDOWN_CHANNEL_ID',
  // Channels B (5)
  'COUNTDOWN_VC_ID',
  'ROLES_CHANNEL_ID',
  'COUNTING_CHANNEL_ID',
  'FOURTHWALL_SALES_CHANNEL',
  'ROTATION_POLL_CHANNEL_ID',
  // Roles & gates (3)
  'QUEUE_ELIGIBLE_ROLES_JSON',
  'COUNTING_FAIL_ROLE_ID',
  'STAFF_ROLE_ID',
  // Tuning (5)
  'STREAM_TIME_ET',
  'PATREON_URL',
  'COUNTING_BASE_REWARD',
  'COUNTING_FAIL_PENALTY',
  'COUNTING_FAIL_DURATION_MIN',
  // Advanced JSON (2)
  'PRODUCTS',
  'SR_ROLE_LIMITS_JSON'
];

export async function setActiveGuildId(env, guildId) {
  if (!guildId) return;
  await env.STATE.put(KV_ACTIVE_GUILD, String(guildId));
}

export async function getActiveGuildId(env) {
  return env.STATE.get(KV_ACTIVE_GUILD);
}

export async function setGuildConfigValue(env, guildId, key, value) {
  if (!guildId || !key) return;
  const k = PREFIX(guildId) + key;
  if (value == null || value === '') {
    await env.STATE.delete(k);
  } else {
    await env.STATE.put(k, String(value));
  }
}

// Read ALL config rows for a guild as a flat object. Empty object if
// no setup has been done for this guild yet.
export async function getGuildConfig(env, guildId) {
  if (!guildId) return {};
  const prefix = PREFIX(guildId);
  const out = {};
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.STATE.list({ prefix, cursor });
    for (const k of r.keys) {
      const v = await env.STATE.get(k.name);
      if (v != null) out[k.name.slice(prefix.length)] = v;
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}

// Wrap the Worker's env binding object with a Proxy that returns
// per-guild config values when present. Bindings (STATE/DB/etc.) and
// undeclared properties fall straight through to the real env so all
// existing module code continues to work unchanged.
export async function envForGuild(env, guildId) {
  if (!guildId) return env;
  const overrides = await getGuildConfig(env, guildId);
  if (Object.keys(overrides).length === 0) return env;
  return new Proxy(env, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      return target[prop];
    },
    has(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return true;
      return prop in target;
    }
  });
}
