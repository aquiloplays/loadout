// /web/admin/* — owner-only admin surface, called from aquilo.gg/admin.
//
// Background: Clay can't bind channels via Discord slash commands
// because the bot token is invalid in this deploy (/admin and /setup
// never registered). The website is now the canonical admin surface
// — every channel binding, every config toggle, every setup/status
// action lives here.
//
// Auth model (mirrors queues/*):
//   - HMAC + per-request timestamp verified by web.js handleWeb()
//   - discordId + guildId come from the verified Patreon session
//   - body MUST carry `_owner: true` (stamped by aquilo-site's
//     /api/web/play/admin/* Pages Functions after checking the
//     aq_link cookie's `o:1` field)
//
// Endpoints exposed via web.js:
//   POST /web/admin/snapshot         -> read all bindings + config for a guild
//   POST /web/admin/config           -> write one (aquilo or loadout) binding
//   POST /web/admin/active-guild     -> set the global active-guild pointer
//   POST /web/admin/clear-binding    -> clear a loadout channel binding
//
// All routes return { ok:true, ... } on success, { ok:false, error, message }
// on failure. HTTP status is always 200 — the structured ok flag is
// the source of truth (mirrors /web/clash/raid contract).

import {
  SETUP_KEYS,
  getGuildConfig,
  setGuildConfigValue,
  setActiveGuildId,
  getActiveGuildId,
} from './aquilo/config.js';
import { runAllPipes } from './admin-menu.js';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ── Loadout channel bindings ─────────────────────────────────────
//
// Four KV-backed channel records live in LOADOUT_BOLTS. Each one's
// payload shape differs slightly (sports carries knownGameIds for
// dedup on re-bind, stocks/bolts carry messageId for in-place edits)
// but every record has at least { channelId, boundAt }.
//
// The keys here mirror admin-menu.js / bolts-feed.js / stocks.js so
// re-binding from the web hits the same records the Discord /admin
// menu wrote to. Same source of truth.
const LOADOUT_BINDINGS = {
  sports:        { key: (g) => 'sports:channel:guild:'       + g, preserveKnownGameIds: true,  hasMessageId: false },
  stocks:        { key: (g) => 'stocks:ticker:guild:'        + g, preserveKnownGameIds: false, hasMessageId: true  },
  bolts:         { key: (g) => 'bolts:feed:guild:'           + g, preserveKnownGameIds: false, hasMessageId: true  },
  checkin:       { key: (g) => 'checkin:channel:guild:'      + g, preserveKnownGameIds: false, hasMessageId: false },
  // StreamFusion community-share channel (see sf-community.js). New
  // embeds posted per "now live" announcement + per relayed event, no
  // in-place edits, so the binding is the lightest of the bunch —
  // just { channelId, boundAt }.
  sf_community:  { key: (g) => 'sf_community:channel:guild:' + g, preserveKnownGameIds: false, hasMessageId: false },
};

async function readLoadoutBinding(env, kind, guildId) {
  const def = LOADOUT_BINDINGS[kind];
  if (!def) return null;
  try {
    return await env.LOADOUT_BOLTS.get(def.key(guildId), { type: 'json' });
  } catch {
    return null;
  }
}

async function writeLoadoutBinding(env, kind, guildId, channelId) {
  const def = LOADOUT_BINDINGS[kind];
  if (!def) return false;
  // Preserve knownGameIds across re-binds (sports) so the cron doesn't
  // re-announce already-mentioned games. messageId is cleared on
  // re-bind so the next cron tick posts a fresh embed in the new
  // channel rather than trying to PATCH a stale message in the old
  // one.
  const existing = await readLoadoutBinding(env, kind, guildId);
  const next = { channelId, boundAt: Date.now() };
  if (def.preserveKnownGameIds && existing && Array.isArray(existing.knownGameIds)) {
    next.knownGameIds = existing.knownGameIds;
  }
  if (def.hasMessageId) {
    next.messageId = null; // force fresh post on next cron
  }
  await env.LOADOUT_BOLTS.put(def.key(guildId), JSON.stringify(next));
  return true;
}

async function deleteLoadoutBinding(env, kind, guildId) {
  const def = LOADOUT_BINDINGS[kind];
  if (!def) return false;
  try {
    await env.LOADOUT_BOLTS.delete(def.key(guildId));
    return true;
  } catch {
    return false;
  }
}

// ── Aquilo per-guild config typing ──────────────────────────────
//
// SETUP_KEYS from aquilo/config.js is the authoritative list of
// admin-writable keys. We add light type metadata so the website
// can render the right input control (channel-id input vs free text
// vs JSON textarea) without hard-coding the shape in two places.
//
// Types:
//   "channel"  - Discord channel ID (string of 17-21 digits)
//   "role"     - Discord role ID (same shape)
//   "int"      - non-negative integer
//   "string"   - free text (URL, HH:MM, etc.)
//   "json"     - JSON-encoded value (array, object)
export const CONFIG_FIELD_META = {
  SCHEDULE_CHANNEL_ID:        { type: 'channel', label: 'Schedule channel',         section: 'channels' },
  POLL_CHANNEL_ID:            { type: 'channel', label: 'Community poll channel',   section: 'channels' },
  QUEUE_CHANNEL_ID:           { type: 'channel', label: 'Community-night queue',    section: 'channels' },
  ENGAGEMENT_CHANNEL_ID:      { type: 'channel', label: 'Engagement (prompts)',     section: 'channels' },
  COUNTDOWN_CHANNEL_ID:       { type: 'channel', label: 'Countdown embed channel',  section: 'channels' },
  COUNTDOWN_VC_ID:            { type: 'channel', label: 'Countdown voice channel',  section: 'channels' },
  ROLES_CHANNEL_ID:           { type: 'channel', label: 'Self-roles channel',       section: 'channels' },
  COUNTING_CHANNEL_ID:        { type: 'channel', label: 'Counting game channel',    section: 'channels' },
  FOURTHWALL_SALES_CHANNEL:   { type: 'channel', label: 'Fourthwall sales channel', section: 'channels' },
  ROTATION_POLL_CHANNEL_ID:   { type: 'channel', label: 'Rotation poll channel',    section: 'channels' },
  COUNTING_FAIL_ROLE_ID:      { type: 'role',    label: 'Counting fail role',       section: 'roles'    },
  STAFF_ROLE_ID:              { type: 'role',    label: 'Staff role (announce)',    section: 'roles'    },
  QUEUE_ELIGIBLE_ROLES_JSON:  { type: 'json',    label: 'Queue eligible roles',     section: 'roles', hint: 'JSON array of role IDs in priority order' },
  STREAM_TIME_ET:             { type: 'string',  label: 'Stream time (HH:MM ET)',   section: 'tuning'   },
  PATREON_URL:                { type: 'string',  label: 'Patreon URL',              section: 'tuning'   },
  COUNTING_BASE_REWARD:       { type: 'int',     label: 'Counting base reward',     section: 'tuning'   },
  COUNTING_FAIL_PENALTY:      { type: 'int',     label: 'Counting fail penalty',    section: 'tuning'   },
  COUNTING_FAIL_DURATION_MIN: { type: 'int',     label: 'Counting fail duration (min)', section: 'tuning' },
  PRODUCTS:                   { type: 'json',    label: 'Products map',             section: 'advanced', hint: 'JSON object: {"loadout":{"channel":"…","role_ping":"…"}}' },
  SR_ROLE_LIMITS_JSON:        { type: 'json',    label: 'Song-request role limits', section: 'advanced', hint: 'JSON object — see README' },
  ACHIEVEMENT_ROLES_JSON:     { type: 'json',    label: 'Achievement roles',        section: 'advanced', hint: 'JSON object' },
  CHECKIN_CHANNEL_ID:         { type: 'channel', label: 'Daily check-in channel',   section: 'channels' },
  LEADERBOARD_CHANNEL_ID:     { type: 'channel', label: 'Leaderboard channel',      section: 'channels' },
  CLIPS_CHANNEL_ID:           { type: 'channel', label: 'Clips channel',            section: 'channels' },
  AQUILO_ADMIN_HUB_CHANNEL_ID:{ type: 'channel', label: 'Aquilo admin hub channel', section: 'channels' },
};

// Map every SETUP_KEY so the snapshot returns an entry for each even
// if it isn't in the explicit meta above (defensive — surface unknown
// keys with a sensible default rather than dropping them).
function metaForKey(key) {
  return CONFIG_FIELD_META[key] || { type: 'string', label: key, section: 'advanced' };
}

// Validate a value matches its declared type. Returns { ok, value: <normalised>, error? }.
function validateField(key, raw) {
  const meta = metaForKey(key);
  // "" / null means "clear this binding" — always allowed.
  if (raw == null || raw === '') return { ok: true, value: '' };
  const v = String(raw).trim();
  switch (meta.type) {
    case 'channel':
    case 'role':
      if (!/^\d{17,21}$/.test(v)) {
        return { ok: false, error: 'bad-snowflake', message: meta.label + ' must be a Discord ID (17-21 digits).' };
      }
      return { ok: true, value: v };
    case 'int': {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== v) {
        return { ok: false, error: 'bad-int', message: meta.label + ' must be a non-negative integer.' };
      }
      return { ok: true, value: String(n) };
    }
    case 'json':
      try { JSON.parse(v); }
      catch { return { ok: false, error: 'bad-json', message: meta.label + ' must be valid JSON.' }; }
      return { ok: true, value: v };
    case 'string':
    default:
      // Light sanity caps so we don't accidentally put a 10MB blob in KV.
      if (v.length > 4000) return { ok: false, error: 'too-long', message: meta.label + ' is too long (max 4000 chars).' };
      return { ok: true, value: v };
  }
}

// ── Route handlers ──────────────────────────────────────────────
//
// Each takes (env, guildId, body) and returns a Response. The web.js
// dispatcher resolves the route name and forwards to the matching
// handler below. discordId is unused — admin actions are guild-wide
// and gated by the _owner flag, not per-user identity.

// Snapshot: returns every binding + every config value the web admin
// UI needs to render. One round-trip per page load.
//
// The site sends the targeted guildId (typically AQUILO_VAULT_GUILD_ID
// once the streamer-claim flow has set it). For pre-claim use, we
// also return the active-guild pointer so the UI can offer to flip it.
async function routeAdminSnapshot(env, guildId) {
  const [aquiloCfg, activeGuildId, sports, stocks, bolts, checkin, sfCommunity] = await Promise.all([
    getGuildConfig(env, guildId),
    getActiveGuildId(env),
    readLoadoutBinding(env, 'sports',       guildId),
    readLoadoutBinding(env, 'stocks',       guildId),
    readLoadoutBinding(env, 'bolts',        guildId),
    readLoadoutBinding(env, 'checkin',      guildId),
    readLoadoutBinding(env, 'sf_community', guildId),
  ]);

  // Envelope: for every SETUP_KEY, expose { key, meta, value, envDefault }.
  // envDefault helps the UI label "unset (using deploy default X)" instead
  // of "empty" — important for keys like STREAM_TIME_ET where the default
  // is meaningful behaviour.
  const fields = SETUP_KEYS.map((key) => ({
    key,
    meta: metaForKey(key),
    value: aquiloCfg[key] || '',
    envDefault: env[key] != null ? String(env[key]) : '',
  }));

  return json({
    ok: true,
    guildId,
    activeGuildId: activeGuildId || null,
    aquilo: { fields },
    loadout: {
      sports:       sports       || { channelId: null },
      stocks:       stocks       || { channelId: null },
      bolts:        bolts        || { channelId: null },
      checkin:      checkin      || { channelId: null },
      sf_community: sfCommunity  || { channelId: null },
    },
    // Diagnostic flags for the UI's "Setup & Status" card.
    flags: {
      hasDiscordToken:   !!env.DISCORD_BOT_TOKEN,
      hasVaultSecret:    !!env.AQUILO_VAULT_BOLTS_SECRET,
      hasWebSecret:      !!env.AQUILO_SITE_WEB_SECRET,
      vaultGuildId:      env.AQUILO_VAULT_GUILD_ID || null,
      twitchChannelId:   env.CLAY_TWITCH_CHANNEL_ID || null,
    },
  });
}

// Write one (aquilo or loadout) binding. Body fields:
//   scope:   "aquilo" | "loadout"
//   key:     SETUP_KEYS member (scope=aquilo) or
//            "sports" | "stocks" | "bolts" | "checkin" (scope=loadout)
//   value:   string — channel ID, role ID, JSON, free text, or "" to clear
async function routeAdminConfig(env, guildId, body) {
  const scope = String((body && body.scope) || '').toLowerCase();
  const key = String((body && body.key) || '').trim();
  const raw = body && body.value;

  if (scope === 'aquilo') {
    if (!SETUP_KEYS.includes(key) && !CONFIG_FIELD_META[key]) {
      return json({ ok: false, error: 'unknown-key', message: 'No such config key.' });
    }
    const v = validateField(key, raw);
    if (!v.ok) return json({ ok: false, error: v.error, message: v.message });
    await setGuildConfigValue(env, guildId, key, v.value);
    return json({ ok: true, scope, key, value: v.value });
  }

  if (scope === 'loadout') {
    if (!(key in LOADOUT_BINDINGS)) {
      return json({ ok: false, error: 'unknown-binding', message: 'Unknown Loadout binding.' });
    }
    const v = validateField('SCHEDULE_CHANNEL_ID', raw); // reuse channel-snowflake validation
    if (!v.ok) return json({ ok: false, error: v.error, message: v.message });
    if (v.value === '') {
      await deleteLoadoutBinding(env, key, guildId);
      return json({ ok: true, scope, key, cleared: true });
    }
    await writeLoadoutBinding(env, key, guildId, v.value);
    return json({ ok: true, scope, key, channelId: v.value });
  }

  return json({ ok: false, error: 'bad-scope', message: 'scope must be aquilo or loadout.' });
}

// Flip the global active-guild pointer. This is what the :17/:23/:01/:02
// crons read on each tick to know which guild to process.
async function routeAdminActiveGuild(env, _guildId, body) {
  const gid = String((body && body.targetGuildId) || '').trim();
  if (!/^\d{5,25}$/.test(gid)) {
    return json({ ok: false, error: 'bad-guild', message: 'targetGuildId must be a Discord snowflake.' });
  }
  await setActiveGuildId(env, gid);
  return json({ ok: true, activeGuildId: gid });
}

// Clear a Loadout channel binding without re-pointing it. Equivalent
// to the "Clear" buttons on the Discord /admin → Setup & Status view.
async function routeAdminClearBinding(env, guildId, body) {
  const key = String((body && body.binding) || '').trim();
  if (!(key in LOADOUT_BINDINGS)) {
    return json({ ok: false, error: 'unknown-binding', message: 'Unknown binding.' });
  }
  await deleteLoadoutBinding(env, key, guildId);
  return json({ ok: true, binding: key, cleared: true });
}

// Run the five integration-health pipe tests. Same checks the Discord
// /admin "Run pipe tests" button does — Yahoo (stocks), ESPN (sports),
// bolts-feed digest assembly, channel-reach via Discord API, and a KV
// write→read→delete round-trip. Each check has its own 10s timeout;
// all five run in parallel so total wall time is whichever is slowest.
//
// Response:
//   { ok: true,
//     totalMs: <int>,
//     passed: <int>,
//     failed: <int>,
//     results: [{ ok, label, detail, ms }, ...] }
//
// `detail` carries either the success summary (e.g. "AAPL = $187.42")
// or the error message verbatim, so the web UI can show it without
// re-translating.
async function routeAdminPipeTests(env, guildId) {
  const report = await runAllPipes(env, guildId);
  const passed = report.results.filter((r) => r.ok).length;
  return json({
    ok: true,
    totalMs: report.totalMs,
    passed,
    failed: report.results.length - passed,
    results: report.results,
  });
}

// ── Dispatcher ──────────────────────────────────────────────────
//
// Called by web.js after the HMAC verification + _owner gate. We
// re-check _owner here too as defence in depth in case the caller
// forgot.
// Owner-only: backfill anniv:seen records for legacy wallet holders.
// Cursor-paginated — pass back the returned `cursor` to continue a
// large guild across calls. Idempotent (already-stamped users skip).
async function routeAnniversaryBackfill(env, guildId, body) {
  const { backfillFirstSeen } = await import('./anniversary.js');
  const r = await backfillFirstSeen(env, guildId, {
    maxPages: Number(body?.maxPages) || 6,
    cursor: body?.cursor || undefined,
  });
  return json(r, r.ok ? 200 : 400);
}

// Owner-only: lock in the current Triple-C campaign game + announce it.
async function routeTripleCSet(env, guildId, body) {
  const gameSlug = String(body?.gameSlug || '').trim();
  if (!gameSlug) return json({ ok: false, error: 'gameSlug-required' }, 400);
  const { setCurrentTripleC, announceTripleC } = await import('./triple-c.js');
  const r = await setCurrentTripleC(env, guildId, gameSlug, body?._setBy || null);
  if (!r.ok) return json(r, 400);
  // Best-effort Discord announce; never blocks the set.
  let announced = null;
  try { announced = await announceTripleC(env, r.current); } catch { /* ignore */ }
  return json({ ok: true, current: r.current, announced });
}

// Owner-only: (re)post + pin the weekly lineup recap on demand.
async function routeLineupPost(env, guildId, body) {
  const { postLineupRecap } = await import('./vote-hub.js');
  const r = await postLineupRecap(env, guildId);
  return json(r, r.ok ? 200 : 502);
}

// Owner-only: mirror the upcoming schedule into Discord scheduled events.
async function routeStreamEventsSync(env, guildId, body) {
  const { syncStreamEvents } = await import('./stream-events.js');
  const horizonDays = Number.isInteger(body?.horizonDays) ? body.horizonDays : 7;
  const r = await syncStreamEvents(env, guildId, { horizonDays });
  return json(r, r.ok ? 200 : 502);
}

export async function handleAdminWeb(env, route, guildId, body) {
  if (!body || body._owner !== true) {
    return json({ ok: false, error: 'forbidden', message: 'owner-only.' }, 403);
  }
  switch (route) {
    case 'admin/snapshot':       return await routeAdminSnapshot(env, guildId);
    case 'admin/config':         return await routeAdminConfig(env, guildId, body);
    case 'admin/active-guild':   return await routeAdminActiveGuild(env, guildId, body);
    case 'admin/clear-binding':  return await routeAdminClearBinding(env, guildId, body);
    case 'admin/pipe-tests':     return await routeAdminPipeTests(env, guildId);
    case 'admin/anniversary-backfill': return await routeAnniversaryBackfill(env, guildId, body);
    case 'admin/triple-c/set':         return await routeTripleCSet(env, guildId, body);
    case 'admin/lineup/post':          return await routeLineupPost(env, guildId, body);
    case 'admin/stream-events/sync':   return await routeStreamEventsSync(env, guildId, body);
    default:                     return json({ ok: false, error: 'not-found' }, 404);
  }
}
