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

// Full per-guild wiring surface — every deploy-time [vars] entry that is
// tenant-specific (channel/role ids, targets, per-guild tunables), i.e.
// everything EXCEPT global identity/behavior (AQUILO_VAULT_GUILD_ID,
// CLAY_TWITCH_*, DISCORD_APP_ID, ALLOW_ANY_GUILD, LOADOUT_BOLT_API).
// Used by /admin/guild-seed-config to snapshot the Aquilo defaults into
// config:<guildId>:<KEY> before the [vars] are neutralized, and (once
// SETUP_KEYS is widened to this set) by the onboarding wizard. Twitch
// identity keys are intentionally excluded here — per-streamer Twitch
// mapping is a later phase.
export const SEED_KEYS = [
  // Tier 1 — read on the interaction path (leak-critical, get neutralized)
  'SCHEDULE_CHANNEL_ID', 'POLL_CHANNEL_ID', 'QUEUE_CHANNEL_ID',
  'QUEUE_ELIGIBLE_ROLES_JSON', 'STAFF_ROLE_ID', 'ACHIEVEMENT_ROLES_JSON',
  'PATREON_URL', 'CHECKIN_CHANNEL_ID', 'LFG_CHANNEL_ID', 'TEMP_VC_PARENT_ID',
  'ROLES_CHANNEL_ID', 'ENGAGEMENT_CHANNEL_ID', 'COUNTDOWN_CHANNEL_ID',
  'COUNTDOWN_VC_ID', 'DAILY_POLL_CHANNEL_ID', 'QOTD_CHANNEL_ID',
  'LEADERBOARD_CHANNEL_ID', 'AQUILO_ADMIN_HUB_CHANNEL_ID', 'SR_ROLE_LIMITS_JSON',
  'PRODUCTS',
  // Tier 2 — webhook/cron-only (kept populated in Phase 1, seeded for parity)
  'COUNTING_CHANNEL_ID', 'CLIPS_CHANNEL_ID', 'ANNOUNCE_DISCORD_CHANNEL_ID',
  'COMMUNITY_CHAT_CHANNELS_JSON', 'FOURTHWALL_SALES_CHANNEL', 'VOD_CHANNEL_ID',
  'STREAM_PING_ROLE_ID', 'LIVE_CHANNEL_ID', 'RECAP_CHANNEL_ID',
  'PRINTERBOT_DISCORD_CHANNEL_ID',
  // Other per-guild wiring + tunables currently in [vars]
  'ROTATION_POLL_CHANNEL_ID', 'SCRATCH_ECHO_CHANNEL_ID', 'COUNTING_FAIL_ROLE_ID',
  'COUNTING_BASE_REWARD', 'COUNTING_FAIL_PENALTY', 'COUNTING_FAIL_DURATION_MIN',
  'STREAM_TIME_ET',
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
