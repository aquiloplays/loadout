// Rotation widget — Discord pre-queue.
//
// Lets viewers add songs to the streamer's Rotation widget queue via
// Discord slash commands BEFORE the stream goes live. The widget at
// widget.aquilo.gg/rotation pulls from the GET /sr/pending endpoint
// either automatically on stream start (OBS WebSocket detection) or
// via a manual button in the streamer's config UI.
//
// Slash commands (registered in src/register-commands.js):
//   /sr-add   <song-or-url>           viewer adds a song
//   /sr-list                          viewer sees their own pending entries
//   /sr-remove <position>             viewer removes their own entry
//   /sr-clear                         mod-only: wipe the whole queue
//
// HTTP routes (handled in worker.js):
//   GET    /sr/pending     widget pulls pending entries (auth: AQUILO_BOT_SECRET)
//   DELETE /sr/pending     widget clears all delivered entries (auth: AQUILO_BOT_SECRET)
//   DELETE /sr/pending/:id widget clears a single delivered entry (auth: AQUILO_BOT_SECRET)
//
// Storage: Workers KV under `sr:pending` (single-streamer for now —
// per-guild keying is a v2 if/when this bot becomes multi-tenant).
//
// Role-based limits via wrangler.toml [vars].SR_ROLE_LIMITS_JSON:
//   [
//     {"role_id":"1234567","label":"supporter","max":5},
//     {"role_id":"7654321","label":"booster",  "max":3},
//     {"role_id":"@everyone","label":"everyone","max":1}
//   ]
//
// First matching role (top-to-bottom) wins. @everyone is the implicit
// fallback at the bottom — if no entry has role_id="@everyone", users
// with no listed roles can't add at all.

import { ephemeral, flattenOptions, FLAG_EPHEMERAL, RESP_CHAT } from './util.js';

const KEY = 'sr:pending';
const MAX_TOTAL_ENTRIES = 200;            // hard cap per channel — defends against runaway viewer adds

// ---------- Storage helpers ----------

async function loadPending(env) {
  if (!env.STATE) return [];
  const raw = await env.STATE.get(KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) || []; }
  catch { return []; }
}

async function savePending(env, list) {
  if (!env.STATE) throw new Error('STATE KV not bound');
  await env.STATE.put(KEY, JSON.stringify(list));
}

// ---------- Role-limit resolution ----------

// Parse the SR_ROLE_LIMITS_JSON env var into an ordered list. Returns
// [] when not set, which effectively disables the feature (no role
// can add anything). The order in the JSON IS the priority order:
// first entry with a matching role wins.
function getRoleLimits(env) {
  if (!env.SR_ROLE_LIMITS_JSON) return [];
  try { return JSON.parse(env.SR_ROLE_LIMITS_JSON) || []; }
  catch (e) {
    console.error('[song-prequeue] SR_ROLE_LIMITS_JSON parse error:', e?.message);
    return [];
  }
}

// Returns { role: { role_id, label, max }, isMod } for the requesting
// member. `role` is null when the member has no eligible role; the
// caller surfaces a friendly "you can't add" message in that case.
function resolveMemberLimit(member, env) {
  const limits = getRoleLimits(env);
  const memberRoles = member?.roles || [];
  // Mod-detection mirrors how the existing CN queue does it: any
  // ManageMessages-like permission counts. Discord's Permissions
  // bitfield string is verbose; use Discord's Administrator (0x8) +
  // ManageMessages (0x2000) as the practical signal.
  const permsStr = member?.permissions || '0';
  const perms = BigInt(permsStr);
  const isMod = (perms & 0x8n) !== 0n || (perms & 0x2000n) !== 0n;
  for (const limit of limits) {
    if (limit.role_id === '@everyone') return { role: limit, isMod };
    if (memberRoles.includes(limit.role_id)) return { role: limit, isMod };
  }
  return { role: null, isMod };
}

function countByUser(list, userId) {
  return list.filter(e => e.userId === userId).length;
}

// ---------- Slash command handlers ----------

export async function handleSrAdd(env, data) {
  const opts = flattenOptions(data.data?.options);
  const songText = String(opts.song || '').trim();
  if (!songText) return ephemeral('Pass a song name or URL.');
  if (songText.length > 300) return ephemeral('Song name is too long (max 300 chars).');

  const member = data.member;
  const userId = member?.user?.id;
  const username = member?.user?.username || 'unknown';
  if (!userId) return ephemeral('Couldn\'t identify you.');

  const { role, isMod } = resolveMemberLimit(member, env);
  if (!role) {
    return ephemeral(
      'You don\'t have a role that can add to the pre-stream queue. ' +
      'Ask the streamer about supporter / booster roles, or wait for stream and use chat instead.'
    );
  }

  const list = await loadPending(env);
  if (list.length >= MAX_TOTAL_ENTRIES) {
    return ephemeral(`Queue is full (${MAX_TOTAL_ENTRIES} max). Try again after the streamer pulls.`);
  }

  // Per-user-per-role cap. Mods bypass to seed the queue at will.
  const used = countByUser(list, userId);
  if (!isMod && used >= role.max) {
    return ephemeral(
      `You've already added **${used}/${role.max}** songs for the **${role.label}** role. ` +
      `Use \`/sr-remove\` to free up a slot, or wait for the streamer to pull and re-add.`
    );
  }

  // Detect Spotify URLs vs free-text searches. The widget's url-resolver
  // handles Spotify / YouTube / Apple Music / SoundCloud; we just pass
  // through whatever the viewer typed and let the widget figure it out.
  const trackId = extractSpotifyTrackId(songText);
  const entry = {
    id:           `sr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    username,
    role:         role.label,
    requestedAt:  new Date().toISOString(),
    // The widget consumer picks whichever fields are present:
    //   - trackId (preferred)  → direct Spotify resolution
    //   - trackUrl             → url-resolver path
    //   - title + artist       → search by name
    trackId:      trackId || null,
    trackUrl:     /^https?:\/\//i.test(songText) ? songText : null,
    title:        trackId ? null : songText,         // free-text becomes search
    artist:       null,
    requestedBy:  username,
  };
  list.push(entry);
  await savePending(env, list);

  const position = list.length;
  return ephemeral(
    `🎵 Added to the pre-queue at position **#${position}**: \`${songText}\`\n` +
    `_Limit for **${role.label}**: ${used + 1}/${role.max}._`
  );
}

export async function handleSrList(env, data) {
  const userId = data.member?.user?.id;
  if (!userId) return ephemeral('Couldn\'t identify you.');
  const list = await loadPending(env);
  const mine = list.filter(e => e.userId === userId);
  if (!mine.length) {
    return ephemeral('You don\'t have any songs in the pre-queue. Use `/sr-add <song>` to add one.');
  }
  const lines = mine.map((e, i) => {
    const label = e.trackUrl || e.title || '(unknown)';
    return `${i + 1}. ${label}`;
  });
  return ephemeral(`**Your pre-queued songs (${mine.length}):**\n${lines.join('\n')}\n\n_Use \`/sr-remove <position>\` to remove one._`);
}

export async function handleSrRemove(env, data) {
  const opts = flattenOptions(data.data?.options);
  const position = Number(opts.position) | 0;
  if (position < 1) return ephemeral('Pass a valid position number from `/sr-list`.');
  const userId = data.member?.user?.id;
  if (!userId) return ephemeral('Couldn\'t identify you.');

  const list = await loadPending(env);
  const mine = list.filter(e => e.userId === userId);
  if (position > mine.length) {
    return ephemeral(`You only have ${mine.length} song${mine.length === 1 ? '' : 's'} in the queue.`);
  }
  const target = mine[position - 1];
  const next = list.filter(e => e.id !== target.id);
  await savePending(env, next);
  return ephemeral(`✓ Removed: \`${target.trackUrl || target.title}\``);
}

export async function handleSrClear(env, data) {
  const member = data.member;
  const permsStr = member?.permissions || '0';
  const perms = BigInt(permsStr);
  const isMod = (perms & 0x8n) !== 0n || (perms & 0x2000n) !== 0n;
  if (!isMod) return ephemeral('Mod-only command.');
  await savePending(env, []);
  return ephemeral('🗑️ Pre-queue cleared.');
}

// ---------- HTTP route handlers (called from worker.js) ----------

// GET /sr/pending — widget pulls. Returns JSON in the shape that
// rotation/src/prequeue-puller.js expects:
//   { asOf: ISO, entries: [...] }
// The widget injects each entry via submitRequest with mod-bypass.
//
// `since` query param (ms epoch) lets the widget short-circuit by
// ignoring entries it already pulled. We don't actively prune older
// entries here — the widget calls DELETE /sr/pending after a
// successful pull to clear delivered ones.
export async function handlePendingGet(env, request) {
  const url = new URL(request.url);
  const since = Number(url.searchParams.get('since') || 0);
  const list = await loadPending(env);
  const filtered = since > 0
    ? list.filter(e => new Date(e.requestedAt).getTime() > since)
    : list;
  return new Response(JSON.stringify({
    asOf:    new Date().toISOString(),
    entries: filtered.map(e => ({
      // Only expose what the widget needs; drop internal id used for
      // mod-side removal so the widget can't accidentally double-pull.
      trackId:     e.trackId,
      trackUrl:    e.trackUrl,
      title:       e.title,
      artist:      e.artist,
      requestedBy: e.requestedBy,
      role:        e.role,
    })),
  }), {
    status:  200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// DELETE /sr/pending — widget clears the whole queue after a
// successful pull. Bot-side state stays empty until the next
// /sr-add. Idempotent — calling on an already-empty list is fine.
export async function handlePendingDelete(env) {
  await savePending(env, []);
  return new Response(JSON.stringify({ ok: true, cleared: true }), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- Helpers ----------

function extractSpotifyTrackId(s) {
  // Match both "spotify:track:<id>" and "https://open.spotify.com/track/<id>"
  // forms. International prefixes like /intl-en/track/ are handled.
  const url = String(s || '').match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([a-zA-Z0-9]{22})/);
  if (url) return url[1];
  const uri = String(s || '').match(/^spotify:track:([a-zA-Z0-9]{22})$/);
  if (uri) return uri[1];
  return null;
}
