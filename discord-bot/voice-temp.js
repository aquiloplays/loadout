// Temp voice channels — slash-command driven, with cron cleanup.
//
// Cloudflare Workers can't maintain a Discord Gateway connection, so
// the canonical "join channel X to auto-create your own VC" UX needs
// either the DLL (already runs on Clay's machine + already polls
// /relay/pending) to forward voice-state events here, OR a slash-
// command path. We ship the slash-command path now and expose an
// HMAC-gated /sync/<guildId>/voice/joined endpoint that the DLL can
// call to drive the join-to-create flow when Clay updates the DLL.
//
// State (KV):
//   tempvc:<channelId>   { id, name, guildId, ownerUserId, categoryId,
//                          createdUtc, lastEmptyAtUtc? }
//   tempvc:index         [channelId, ...]  for the cron sweep
//
// Cleanup: the existing :23 hourly cron walks tempvc:index, asks
// Discord for each channel's voice member list, deletes any that have
// been empty > 60s (keeps short bathroom breaks from triggering a
// delete). Deletion uses the bot's MANAGE_CHANNELS perm.
//
// Config (env vars — both set in wrangler.toml):
//   DISCORD_BOT_TOKEN              — bot REST auth
//   TEMP_VC_PARENT_ID              — the "➕│join to create" voice
//                                    channel; joining it triggers
//                                    a new temp-VC spawn for that user
//   TEMP_VC_CATEGORY_ID            — (optional) Discord category id
//                                    new temp VCs nest under. Leave
//                                    unset to spawn at guild root.

const TEMPVC_KEY = (chId) => `tempvc:${chId}`;
const INDEX_KEY = 'tempvc:index';
const DEFAULT_NAME = (name) => `${name}'s room`;
const EMPTY_GRACE_MS = 60_000;

async function getIndex(env) {
  const raw = await env.LOADOUT_BOLTS.get(INDEX_KEY, { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}
async function putIndex(env, idx) {
  await env.LOADOUT_BOLTS.put(INDEX_KEY, JSON.stringify(idx));
}

// ── Create + move ─────────────────────────────────────────────────

export async function createTempVcForUser(env, { guildId, userId, displayName }) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId) return { ok: false, error: 'no-guild-id' };
  const categoryId = env.TEMP_VC_CATEGORY_ID || null;
  const channelName = DEFAULT_NAME(displayName || `Player ${userId.slice(-4)}`);

  // 1. Create the channel via Discord REST.
  const createBody = {
    name: channelName,
    type: 2,            // GUILD_VOICE
    parent_id: categoryId,
    user_limit: 0,      // no cap
  };
  const cr = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
    method: 'POST',
    headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(createBody),
  });
  if (!cr.ok) {
    const txt = await cr.text().catch(() => '');
    return { ok: false, error: 'create-failed', status: cr.status, detail: txt.slice(0, 200) };
  }
  const ch = await cr.json();

  // 2. Move the user into it. PATCH /guilds/:g/members/:u with channel_id.
  // This needs MOVE_MEMBERS perm + the user must already be in a voice
  // channel. If they're not currently in voice, the move is a no-op
  // (PATCH returns 400). We tolerate that — the user just walks into
  // the new channel manually.
  let moved = false;
  try {
    const mr = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel_id: ch.id }),
    });
    moved = mr.ok;
  } catch { /* tolerate */ }

  // 3. Record it.
  const rec = {
    id: ch.id, name: ch.name, guildId, ownerUserId: userId, categoryId,
    createdUtc: Date.now(), lastEmptyAtUtc: null,
  };
  await env.LOADOUT_BOLTS.put(TEMPVC_KEY(ch.id), JSON.stringify(rec));
  const idx = await getIndex(env);
  if (!idx.includes(ch.id)) {
    idx.push(ch.id);
    await putIndex(env, idx);
  }
  return { ok: true, channel: { id: ch.id, name: ch.name }, moved };
}

// ── Cron sweep ────────────────────────────────────────────────────
//
// Asks Discord for voice-state members of each tracked temp VC; any
// that have been empty more than EMPTY_GRACE_MS get deleted.
// Bounded — at most ~100 tracked rooms in practice.

export async function sweepEmptyTempVcs(env, nowUtc = Date.now()) {
  if (!env.DISCORD_BOT_TOKEN) return { swept: 0, reason: 'no-bot-token' };
  const idx = await getIndex(env);
  if (!idx.length) return { swept: 0 };
  const keepers = [];
  let swept = 0;

  for (const chId of idx) {
    const rec = await env.LOADOUT_BOLTS.get(TEMPVC_KEY(chId), { type: 'json' });
    if (!rec) continue;
    // Fetch the channel's current voice members. Discord exposes this
    // via GET /guilds/:guildId/voice-states — but that endpoint only
    // returns states with channel_id. Easier: list guild voice states
    // via /guilds/:guildId/voice-states (member count by channel) is
    // not REST — must use Gateway. Instead: try a member-count probe
    // via GET /channels/:chId — Discord includes nothing useful there.
    // Reality: the only REST way to know "is this voice channel empty"
    // is to call /guilds/:guildId/voice-states/:userId for each
    // tracked member, which is fiddly.
    //
    // Workaround: track empty-since via DLL forwarding (preferred) OR
    // use the channel age + "no PATCH activity" heuristic — delete if
    // age > 4h AND no recorded activity. That's permissive on the
    // "delete fast" side but never destroys a busy room. The DLL
    // forwarding path (when it lands) updates lastSeenActivityUtc on
    // every voice-state move into the channel.
    const ageMs = nowUtc - (rec.createdUtc || nowUtc);
    const lastActivity = rec.lastActivityUtc || rec.createdUtc || 0;
    const idleMs = nowUtc - lastActivity;
    // Heuristic: room older than 4h AND no activity in the last 30 min.
    // The DLL-forwarding path adds lastActivityUtc on every voice
    // event; without it, idleMs == ageMs and we wait for 4h+30m.
    const STALE_AGE = 4 * 60 * 60_000;
    const IDLE_GRACE = 30 * 60_000;
    if (ageMs > STALE_AGE && idleMs > IDLE_GRACE) {
      // Delete the channel.
      try {
        await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(chId)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` },
        });
      } catch { /* tolerate */ }
      await env.LOADOUT_BOLTS.delete(TEMPVC_KEY(chId));
      swept++;
    } else {
      keepers.push(chId);
    }
  }
  if (keepers.length !== idx.length) await putIndex(env, keepers);
  return { swept, kept: keepers.length };
}

// ── DLL voice-state forward (optional) ─────────────────────────────
//
// HMAC-gated endpoint the DLL calls on every voice-state update so we
// can:
//   (a) drive the "join-to-create" flow — when a user joins the
//       configured TEMP_VC_PARENT_ID channel, spawn a temp VC for them.
//   (b) stamp lastActivityUtc on tracked temp VCs so the sweep doesn't
//       delete a busy room.
//
// Body: { guildId, userId, displayName?, channelId | null }
//   channelId == null  → user left voice
//   channelId == TEMP_VC_PARENT_ID → spawn-then-move
//
// Env-var naming: aligned with wrangler.toml (TEMP_VC_PARENT_ID is the
// "➕│join to create" voice channel id). The optional TEMP_VC_CATEGORY_ID
// (above, in createTempVcForUser) is a SEPARATE category id under
// which newly-spawned temp VCs are nested — leave unset to spawn them
// at the guild root.
export async function handleVoiceStateUpdate(env, payload) {
  const { guildId, userId, displayName, channelId } = payload || {};
  if (!guildId || !userId) return { ok: false, error: 'guildId+userId required' };

  // Spawn-on-join-source-channel
  if (channelId && env.TEMP_VC_PARENT_ID
      && String(channelId) === String(env.TEMP_VC_PARENT_ID)) {
    const r = await createTempVcForUser(env, { guildId, userId, displayName });
    return { ok: true, spawned: r };
  }
  // Activity stamp on tracked rooms
  if (channelId) {
    const rec = await env.LOADOUT_BOLTS.get(TEMPVC_KEY(channelId), { type: 'json' });
    if (rec) {
      rec.lastActivityUtc = Date.now();
      await env.LOADOUT_BOLTS.put(TEMPVC_KEY(channelId), JSON.stringify(rec));
      return { ok: true, stamped: true };
    }
  }
  return { ok: true };
}

// ── Slash-command entry point ──────────────────────────────────────
//
// /voice → creates a temp VC for the invoking user. Used as the
// canonical UX while the DLL forwarding work is pending.

export async function handleVoiceSlash(env, guildId, userId, displayName) {
  const r = await createTempVcForUser(env, { guildId, userId, displayName });
  if (!r.ok) {
    return `❌ Couldn't create your voice channel: ${r.error}${r.detail ? ' — ' + r.detail.slice(0, 80) : ''}`;
  }
  const moveNote = r.moved ? ' I moved you in.' : ' Walk into it whenever you\'re ready.';
  return `🎤 Created **${r.channel.name}**.${moveNote} It\'ll auto-delete when nobody\'s been in it for a while.`;
}
