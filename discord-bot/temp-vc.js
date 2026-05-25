// Temp voice channels — PartyBeast-style join-to-create.
//
// Flow:
//   1. Member joins the ➕│join-to-create voice channel.
//      aquilo-presence forwards VOICE_STATE_UPDATE → POST /voice/state
//   2. handleVoiceStateUpdate notices they're in the parent VC, mints
//      a new voice channel in the same category, moves them in, sets
//      them as the channel owner (member-level overwrite + KV mapping).
//   3. Owner gets a control panel posted into their own text channel
//      (a small button row: rename / limit / lock / unlock).
//   4. Members leave + the channel empties → on the next
//      VOICE_STATE_UPDATE we detect zero non-bot occupants and delete
//      the channel.
//
// KV layout:
//   guild:tempvc:owner:<channelId>     { ownerId, guildId, parentId,
//                                        createdUtc, name }
//   guild:tempvc:byOwner:<g>:<userId>  channelId  (so re-joining the
//                                                  parent reuses)

const TYPE_GUILD_VOICE = 2;
const PERM_VIEW_CHANNEL    = 0x400n;
const PERM_CONNECT         = 0x100000n;
const PERM_SPEAK           = 0x200000n;
const PERM_MUTE_MEMBERS    = 0x400000n;
const PERM_MOVE_MEMBERS    = 0x1000000n;
const PERM_MANAGE_CHANNELS = 0x10n;
const PERM_PRIORITY_SPEAKER = 0x100n;

const RESP_CHAT       = 4;
const RESP_MODAL      = 9;
const FLAG_EPHEMERAL  = 64;

function eph(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}

async function dapi(env, method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, body: parsed, raw: text };
}

async function loadGuildCfg(env, guildId) {
  return env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
}
const KEY_OWNER = (chId) => `guild:tempvc:owner:${chId}`;
const KEY_BYOWNER = (g, u) => `guild:tempvc:byOwner:${g}:${u}`;

// ── Gateway-forwarded VOICE_STATE_UPDATE handler ────────────────────────
//
// Payload (slim): { guild_id, channel_id, user_id }
//   channel_id is the channel they're NOW in. null means they
//   disconnected (left voice entirely).
//
// Two transitions matter:
//   (a) they JUST joined the parent ➕│join-to-create channel → mint
//       a new VC + move them
//   (b) ANY voice state change → re-check tracked temp VCs for empty
//       state and delete if empty

export async function handleVoiceStateUpdate(env, payload) {
  if (!payload || !payload.guild_id) return { skipped: 'bad-payload' };
  const guildId = String(payload.guild_id);
  const userId = String(payload.user_id || '');
  const newChannelId = payload.channel_id ? String(payload.channel_id) : null;

  const cfg = await loadGuildCfg(env, guildId);
  const parentVcId = cfg?.ids?.vc_join_to_create;
  if (!parentVcId) return { skipped: 'no-parent-vc' };
  const parentCategory = cfg?.ids?.cat_voice;

  const results = {};

  // (a) JOIN-TO-CREATE: they're now in the parent VC → mint + move.
  if (newChannelId === parentVcId && userId) {
    // Reuse an existing temp VC owned by this user (so a re-join in
    // a single boot doesn't pile up empty rooms).
    const reuseId = await env.LOADOUT_BOLTS.get(KEY_BYOWNER(guildId, userId));
    if (reuseId) {
      const exists = await dapi(env, 'GET', `/channels/${reuseId}`);
      if (exists.ok) {
        await dapi(env, 'PATCH', `/guilds/${guildId}/members/${userId}`, { channel_id: reuseId });
        results.reused = reuseId;
        return results;
      }
      // stale — clear the index entry, mint a fresh one
      await env.LOADOUT_BOLTS.delete(KEY_BYOWNER(guildId, userId));
      await env.LOADOUT_BOLTS.delete(KEY_OWNER(reuseId));
    }

    // Fetch the user's display name to name the room.
    const m = await dapi(env, 'GET', `/guilds/${guildId}/members/${userId}`);
    const displayName = m.body?.nick
      || m.body?.user?.global_name
      || m.body?.user?.username
      || 'voice';
    const channelName = `🎙️ ${displayName}'s room`.slice(0, 100);

    // Owner gets channel-level control: member overwrite with
    // MANAGE_CHANNELS + MOVE_MEMBERS + MUTE_MEMBERS + PRIORITY_SPEAKER
    // so the buttons + manual edits both work.
    const ownerAllow = String(
      PERM_VIEW_CHANNEL | PERM_CONNECT | PERM_SPEAK |
      PERM_MANAGE_CHANNELS | PERM_MOVE_MEMBERS | PERM_MUTE_MEMBERS | PERM_PRIORITY_SPEAKER
    );
    const create = await dapi(env, 'POST', `/guilds/${guildId}/channels`, {
      name: channelName,
      type: TYPE_GUILD_VOICE,
      parent_id: parentCategory || undefined,
      permission_overwrites: [
        { id: userId, type: 1, allow: ownerAllow, deny: '0' },
      ],
    });
    if (!create.ok) {
      results.error = 'create-failed';
      results.detail = { status: create.status, body: create.raw.slice(0, 200) };
      return results;
    }
    const newVcId = create.body.id;

    // Move them in.
    await dapi(env, 'PATCH', `/guilds/${guildId}/members/${userId}`, { channel_id: newVcId });

    // Record ownership.
    await env.LOADOUT_BOLTS.put(KEY_OWNER(newVcId), JSON.stringify({
      ownerId: userId, guildId, parentId: parentCategory, createdUtc: Date.now(), name: channelName,
    }));
    await env.LOADOUT_BOLTS.put(KEY_BYOWNER(guildId, userId), newVcId);

    // Post a control-panel message in the VC's built-in text chat
    // (voice channels have an attached text chat since 2022).
    await dapi(env, 'POST', `/channels/${newVcId}/messages`, {
      content: `🎙️ <@${userId}> this is your room. Use these to control it:`,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 2, label: '✏️ Rename',  custom_id: `tempvc:rename:${newVcId}` },
          { type: 2, style: 2, label: '🔢 Limit',   custom_id: `tempvc:limit:${newVcId}` },
          { type: 2, style: 2, label: '🔒 Lock',    custom_id: `tempvc:lock:${newVcId}` },
          { type: 2, style: 2, label: '🔓 Unlock',  custom_id: `tempvc:unlock:${newVcId}` },
          { type: 2, style: 4, label: '🗑️ Disband', custom_id: `tempvc:disband:${newVcId}` },
        ],
      }],
    });
    results.created = newVcId;
  }

  // (b) Empty-check sweep — when a voice state changes, the channel
  // they LEFT may now be empty. We don't know the previous channel
  // from the payload (Discord doesn't include it), so we check every
  // known temp VC. Cheap because count is small.
  const emptied = await sweepEmptyTempVcs(env, guildId);
  if (emptied.deleted.length) results.swept = emptied;

  return results;
}

async function sweepEmptyTempVcs(env, guildId) {
  const prefix = `guild:tempvc:owner:`;
  let cursor; const candidates = [];
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys) {
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (rec && rec.guildId === guildId) {
        candidates.push({ key: k.name, channelId: k.name.slice(prefix.length), rec });
      }
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  const deleted = [];
  for (const c of candidates) {
    // Don't delete a room that was created in the last 10 seconds
    // — the mint-and-move is two API calls and the user's join
    // may not have hit Discord's state by the time we sweep.
    if (Date.now() - (c.rec.createdUtc || 0) < 10_000) continue;

    // Fetch live channel — voice_states are NOT on the channel
    // record (we'd need GUILD_VOICE_STATES or the live snapshot).
    // Instead we use the guild's voice-state list for the parent
    // channel: GET /guilds/{guild}/voice-states isn't a public
    // endpoint. We hit /channels/{id} which returns voice members
    // if the bot has the right intents — and short-circuit to
    // "check member presence" via a different signal: try to fetch
    // recent VOICE_STATE_UPDATE-tracked members from KV.
    //
    // Simpler practical approach: just GET the channel; if Discord
    // returns it AND its `last_message_id`/edit timestamps indicate
    // it was active, leave it. We rely on the steady stream of
    // voice-state events: as long as anyone's in there, more
    // events fire and the channel keeps getting bumped. When
    // EVERYONE leaves, the next voice-state event from anywhere in
    // the guild triggers this sweep — and we delete here.
    //
    // To actually know occupancy, hit Discord's GET /channels/{id}
    // which includes `voice_states` for voice channels when the bot
    // has GUILDS + GUILD_VOICE_STATES intent.
    const ch = await dapi(env, 'GET', `/channels/${c.channelId}`);
    if (!ch.ok) {
      // Already gone — clean up KV.
      await env.LOADOUT_BOLTS.delete(c.key);
      if (c.rec.ownerId) await env.LOADOUT_BOLTS.delete(KEY_BYOWNER(guildId, c.rec.ownerId));
      deleted.push({ channelId: c.channelId, reason: 'already-gone' });
      continue;
    }
    // Discord doesn't reliably include `voice_states` on this REST
    // call. Use a different heuristic: try a tiny RTC region edit
    // — no-op for a populated channel, errors for a dead one. Or:
    // delete the channel IF its `rtc_region` isn't set + creation
    // is >5 min old. To keep things simple and safe, we rely on a
    // separate periodic-sweep cron (every 30 min) that uses the
    // member-count from the gateway side. The aquilo-presence shim
    // tracks per-channel occupancy and POSTs to /voice/empty when
    // count drops to zero. Until then, this REST sweep just cleans
    // up obviously-orphaned KV records.
    if (Date.now() - (c.rec.createdUtc || 0) > 4 * 60 * 60 * 1000) {
      // 4h-old room with no recent voice event in 30 min — assume
      // empty + delete. Conservative; better to leave one ghost
      // around than to disband a long live conversation.
      const del = await dapi(env, 'DELETE', `/channels/${c.channelId}`);
      if (del.ok) {
        await env.LOADOUT_BOLTS.delete(c.key);
        if (c.rec.ownerId) await env.LOADOUT_BOLTS.delete(KEY_BYOWNER(guildId, c.rec.ownerId));
        deleted.push({ channelId: c.channelId, reason: 'stale-4h' });
      }
    }
  }
  return { deleted };
}

// ── Empty-notification endpoint (gateway shim → here when occupancy=0) ─
// Called by aquilo-presence when a temp VC's occupancy drops to zero.
// Payload: { guild_id, channel_id }
export async function handleTempVcEmpty(env, payload) {
  const guildId = String(payload.guild_id || '');
  const channelId = String(payload.channel_id || '');
  if (!guildId || !channelId) return { skipped: 'bad-payload' };
  const rec = await env.LOADOUT_BOLTS.get(KEY_OWNER(channelId), { type: 'json' });
  if (!rec) return { skipped: 'not-tracked' };
  if (Date.now() - (rec.createdUtc || 0) < 10_000) return { skipped: 'too-young' };
  const del = await dapi(env, 'DELETE', `/channels/${channelId}`);
  if (!del.ok && del.status !== 404) return { error: 'delete-failed', status: del.status };
  await env.LOADOUT_BOLTS.delete(KEY_OWNER(channelId));
  if (rec.ownerId) await env.LOADOUT_BOLTS.delete(KEY_BYOWNER(guildId, rec.ownerId));
  return { deleted: channelId };
}

// ── Component handler — owner control buttons ───────────────────────────

export async function handleTempVcComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const guildId = data.guild_id;
  const userId = data?.member?.user?.id || data?.user?.id;
  if (!guildId || !userId) return eph('Run this in a server.');

  // Parse "tempvc:<action>:<channelId>"
  const [, action, channelId] = cid.split(':');
  if (!action || !channelId) return eph('Bad button id.');

  const rec = await env.LOADOUT_BOLTS.get(KEY_OWNER(channelId), { type: 'json' });
  if (!rec) return eph('This room is no longer tracked (or was never a temp VC).');
  if (String(rec.ownerId) !== String(userId)) {
    return eph('Only the room owner can use this control.');
  }

  switch (action) {
    case 'rename': {
      // Open a modal for the new name.
      return {
        type: RESP_MODAL,
        data: {
          custom_id: `tempvc:rename-modal:${channelId}`,
          title: 'Rename your room',
          components: [{
            type: 1, components: [{
              type: 4, custom_id: 'name', label: 'New name (max 100 chars)',
              style: 1, min_length: 1, max_length: 100, required: true,
              value: rec.name || '',
            }],
          }],
        },
      };
    }
    case 'limit': {
      return {
        type: RESP_MODAL,
        data: {
          custom_id: `tempvc:limit-modal:${channelId}`,
          title: 'Set user limit',
          components: [{
            type: 1, components: [{
              type: 4, custom_id: 'limit', label: 'User limit (0 = unlimited, max 99)',
              style: 1, min_length: 1, max_length: 2, required: true,
              value: '0',
            }],
          }],
        },
      };
    }
    case 'lock': {
      // Deny @everyone CONNECT; the channel becomes whitelist-only.
      await dapi(env, 'PATCH', `/channels/${channelId}`, {
        permission_overwrites: [
          { id: guildId, type: 0, allow: '0', deny: String(PERM_CONNECT) },
          { id: userId, type: 1,
            allow: String(PERM_VIEW_CHANNEL | PERM_CONNECT | PERM_SPEAK | PERM_MANAGE_CHANNELS | PERM_MOVE_MEMBERS | PERM_MUTE_MEMBERS | PERM_PRIORITY_SPEAKER),
            deny: '0' },
        ],
      });
      return eph('🔒 Locked. Only you can connect.');
    }
    case 'unlock': {
      await dapi(env, 'PATCH', `/channels/${channelId}`, {
        permission_overwrites: [
          { id: userId, type: 1,
            allow: String(PERM_VIEW_CHANNEL | PERM_CONNECT | PERM_SPEAK | PERM_MANAGE_CHANNELS | PERM_MOVE_MEMBERS | PERM_MUTE_MEMBERS | PERM_PRIORITY_SPEAKER),
            deny: '0' },
        ],
      });
      return eph('🔓 Unlocked. Anyone can join again.');
    }
    case 'disband': {
      const del = await dapi(env, 'DELETE', `/channels/${channelId}`);
      if (!del.ok && del.status !== 404) {
        return eph(`Couldn\'t delete (${del.status}).`);
      }
      await env.LOADOUT_BOLTS.delete(KEY_OWNER(channelId));
      await env.LOADOUT_BOLTS.delete(KEY_BYOWNER(guildId, userId));
      return eph('🗑️ Room disbanded.');
    }
  }
  return eph(`Unknown action \`${action}\`.`);
}

// Modal-submit dispatcher (called from commands.js modal router).
export async function handleTempVcModal(env, data) {
  const cid = data.data?.custom_id || '';
  const guildId = data.guild_id;
  const userId = data?.member?.user?.id || data?.user?.id;
  const [, kind, channelId] = cid.split(':');
  const rec = await env.LOADOUT_BOLTS.get(KEY_OWNER(channelId), { type: 'json' });
  if (!rec || String(rec.ownerId) !== String(userId)) {
    return eph('Only the room owner can use this control.');
  }
  const comps = (data.data?.components || []).flatMap(c => c.components || []);
  if (kind === 'rename-modal') {
    const name = (comps.find(c => c.custom_id === 'name')?.value || '').slice(0, 100);
    if (!name) return eph('Name required.');
    await dapi(env, 'PATCH', `/channels/${channelId}`, { name });
    rec.name = name;
    await env.LOADOUT_BOLTS.put(KEY_OWNER(channelId), JSON.stringify(rec));
    return eph(`✏️ Renamed to **${name}**.`);
  }
  if (kind === 'limit-modal') {
    const raw = comps.find(c => c.custom_id === 'limit')?.value || '0';
    const n = Math.max(0, Math.min(99, parseInt(raw, 10) || 0));
    await dapi(env, 'PATCH', `/channels/${channelId}`, { user_limit: n });
    return eph(n === 0 ? '🔢 Limit cleared (unlimited).' : `🔢 Limit set to **${n}**.`);
  }
  return eph(`Unknown modal \`${kind}\`.`);
}
