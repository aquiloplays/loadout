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
  // Front-door welcome embed (welcome.js handleMemberJoined). KV-only.
  // Takes precedence over the legacy guild:welcome-cfg.channelId and
  // guild:cfg.ids.ch_introductions so future rebinds land without a
  // redeploy.
  'welcome',
  // Phase: CN games-list catalogue channel (cn-games-list-hub.js)
  'games-list',
  // Phase 1 channel hubs (check-in / character / bolts / play /
  // achievements) — see <key>-hub.js for each.
  // NOTE: `checkin` is the HUB channel (interactive surface);
  // `checkin-results` is where the "X checked in! +N bolts" embed
  // lands. Separating them lets the hub live in a low-noise
  // interactive room while completion posts go to general/feed.
  'checkin', 'checkin-results',
  'character', 'bolts', 'play', 'achievements',
  // Unified voting hub — variety + community night, separate events
  // sharing one channel. See vote-hub.js. KV-only (admins bind via
  // /admin/channels/bind/<g>).
  'vote',
  // Aquilo's Vault — split across two channels per Clay's request.
  // vault-events: outbound game events from Railway with action
  // buttons. vault-actions: persistent player-action menu.
  'vault-events', 'vault-actions',
  // Twitch event embed routing (see twitch-events.js).
  //   stream-notifications: catch-all default for follows / subs /
  //     gifts / cheers / raids / redemptions etc. when no per-event
  //     override is set (see twitch-event-channel:<eventType> KV).
  //   live-now: bigger "going live" announcement embed channel —
  //     separate from the existing `live` binding which is the
  //     edit-in-place lifecycle (postLiveEmbed → markStreamOffline).
  //     If unbound, falls through to the `live` binding so the
  //     existing single-channel setup keeps working.
  //   redemptions-feed: channel-point redemption embeds (high-volume
  //     for active streams — Clay can route it to a low-noise
  //     "feed" channel).
  'stream-notifications', 'live-now', 'redemptions-feed',
  // Twitch rewards feed (see twitch-rewards.js). Bolt + role grants
  // for Twitch events fire a short embed here so the community sees
  // who earned what. Distinct from `stream-notifications` (the
  // event embed itself) — these are the *reward* posts.
  'twitch-rewards-feed',
  // Seasonal Spire clear feed — milestone floor 5/9/boss embeds posted
  // here when a player clears. Falls back to twitch-rewards-feed
  // (the #rewards channel) if unbound, which is the natural overflow.
  'spire-clears',
  // Dynamic live-status dashboard embed (live-status-embed.js).
  // Distinct from `live` / `live-now`: this is the per-minute refreshing
  // dashboard with viewer count + hype-train state. Falls back to the
  // hardcoded channel ID in live-status-embed.js if unbound.
  'live-status-embed',
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
  welcome:           null,
  'games-list':      null,
  checkin:           'CHECKIN_CHANNEL_ID',
  'checkin-results': null,
  character:         null,
  bolts:             null,
  play:              null,
  achievements:      null,
  vote:              null,
  'vault-events':    null,
  'vault-actions':   null,
  // Twitch event channels — KV-only, set via /twitch-event set.
  'stream-notifications': null,
  'live-now':             null,
  'redemptions-feed':     null,
  'twitch-rewards-feed':  null,
  'spire-clears':         null,
  // Live-status dashboard: KV-only. Fallback to hardcoded channel ID
  // happens inside live-status-embed.js, not via env-var, so this
  // stays null (the keyed-but-empty entry satisfies the catalog test).
  'live-status-embed':    null,
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
