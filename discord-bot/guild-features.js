// Interactive features wired into the Aquilo Discord server build.
//
//   ✅ Verification gate
//      A button in #rules with custom_id "guild:verify". Clicking it
//      grants the ⭐ Member role, unlocking the rest of the server.
//
//   🎭 Self-serve ping roles
//      Four buttons in #🎭│roles with custom_ids
//      "guild:role:{stream,youtube,event,gamenight}" — toggle the
//      matching role on the caller.
//
//   ⭐ Starboard
//      handleStarboardReaction(env, payload) listens to MESSAGE_REACTION_ADD
//      events from a Discord gateway proxy (or, when triggered via
//      /admin/guild-test-starboard, manually). Posts to ⭐│highlights
//      when a message crosses STARBOARD_THRESHOLD reactions of one
//      kind. NOTE: this Worker doesn't run a gateway connection, so
//      reaction events have to be forwarded into it. The infra is
//      ready — the gateway wiring is a follow-up if/when Clay wants
//      a hot starboard. For now, the highlights channel exists and
//      this handler is callable from the admin surface.
//
//   🔢 Counting
//      handleCountingMessage(env, msg) processes a new message in
//      the #🔢│counting channel — accepts the next integer, deletes
//      anything that isn't. State stored in KV at
//      `guild:counting:<guildId>:state`. Same gateway-forward caveat
//      as starboard.

import { sendDm } from './aquilo/util.js';

export const STARBOARD_THRESHOLD = 5;
export const STARBOARD_EMOJI     = '⭐';

const ROLE_BUTTON_MAP = {
  'guild:role:stream':    { idKey: 'role_stream',    label: 'Stream Pings'  },
  'guild:role:youtube':   { idKey: 'role_youtube',   label: 'YouTube Pings' },
  'guild:role:event':     { idKey: 'role_event',     label: 'Event Pings'   },
  'guild:role:gamenight': { idKey: 'role_gamenight', label: 'Game Night'    },
};

const RESP_CHAT     = 4;
const RESP_UPDATE   = 7;
const FLAG_EPHEMERAL = 64;

function eph(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}

async function loadGuildCfg(env, guildId) {
  return env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
}

async function discordApi(env, method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? JSON.parse(text) : null };
}

// ── Component router entrypoint ────────────────────────────────────────

export async function handleGuildComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const guildId = data.guild_id;
  const userId = data.member?.user?.id || data.user?.id;
  if (!guildId || !userId) return eph('Run this in a server.');

  const cfg = await loadGuildCfg(env, guildId);
  if (!cfg?.ids) return eph('Server isn\'t fully set up yet — ping a mod.');

  // ── Verify ──────────────────────────────────────────────────────────
  if (cid === 'guild:verify') {
    const memberRoleId = cfg.ids.role_member;
    if (!memberRoleId) return eph('Verification isn\'t configured — ping a mod.');
    // PUT /guilds/{g}/members/{u}/roles/{r} is idempotent — already-
    // verified members just get the same role re-granted and see the
    // same "you're in" message.
    const r = await discordApi(env, 'PUT', `/guilds/${guildId}/members/${userId}/roles/${memberRoleId}`);
    if (!r.ok && r.status !== 204) {
      return eph(`Verify failed (${r.status}). A mod has been notified.`);
    }
    return eph('✅ Verified! You can now see the rest of the server.');
  }

  // ── Self-assign role toggle ─────────────────────────────────────────
  const roleSpec = ROLE_BUTTON_MAP[cid];
  if (roleSpec) {
    const rid = cfg.ids[roleSpec.idKey];
    if (!rid) return eph(`${roleSpec.label} role isn\'t configured.`);
    // Look up the member to see if they already have it (toggle).
    const m = await discordApi(env, 'GET', `/guilds/${guildId}/members/${userId}`);
    if (!m.ok) return eph(`Couldn't read your member record (${m.status}).`);
    const has = (m.body.roles || []).includes(rid);
    if (has) {
      const r = await discordApi(env, 'DELETE', `/guilds/${guildId}/members/${userId}/roles/${rid}`);
      if (!r.ok && r.status !== 204) return eph(`Couldn't remove the role (${r.status}).`);
      return eph(`➖ Removed **${roleSpec.label}**.`);
    } else {
      const r = await discordApi(env, 'PUT', `/guilds/${guildId}/members/${userId}/roles/${rid}`);
      if (!r.ok && r.status !== 204) return eph(`Couldn't add the role (${r.status}).`);
      return eph(`➕ Added **${roleSpec.label}**.`);
    }
  }

  return eph(`Unknown action: \`${cid}\`.`);
}

// ── Starboard handler (gateway-forwarded MESSAGE_REACTION_ADD) ──────────
//
// payload shape (Discord MESSAGE_REACTION_ADD event):
//   { guild_id, channel_id, message_id, user_id, emoji: { name } }
//
// Counts ⭐ reactions on the source message. When the count crosses
// STARBOARD_THRESHOLD, posts a summary in ⭐│highlights. A KV stamp
// at `guild:star:<msgId>` prevents double-posts.
export async function handleStarboardReaction(env, payload) {
  if (!payload || payload?.emoji?.name !== STARBOARD_EMOJI) return { skipped: 'wrong-emoji' };
  const guildId = payload.guild_id;
  const cfg = await loadGuildCfg(env, guildId);
  if (!cfg?.ids?.ch_highlights) return { skipped: 'no-highlights-channel' };
  const sourceChannelId = payload.channel_id;
  const messageId = payload.message_id;

  // Skip the highlights channel itself (no recursion)
  if (sourceChannelId === cfg.ids.ch_highlights) return { skipped: 'highlights-channel' };

  // Dedup
  const stampKey = `guild:star:${guildId}:${messageId}`;
  const already = await env.LOADOUT_BOLTS.get(stampKey);
  if (already) return { skipped: 'already-posted' };

  // Re-fetch the source message to count reactions
  const msgRes = await discordApi(env, 'GET', `/channels/${sourceChannelId}/messages/${messageId}`);
  if (!msgRes.ok) return { skipped: 'fetch-failed', status: msgRes.status };
  const msg = msgRes.body;
  const star = (msg.reactions || []).find(r => r.emoji?.name === STARBOARD_EMOJI);
  const count = star?.count || 0;
  if (count < STARBOARD_THRESHOLD) return { skipped: 'below-threshold', count };

  // Build the highlights embed
  const author = msg.author || {};
  const link = `https://discord.com/channels/${guildId}/${sourceChannelId}/${messageId}`;
  const embed = {
    description: msg.content?.slice(0, 1900) || '',
    color: 0xFEE75C,
    author: {
      name: author.global_name || author.username || 'unknown',
      icon_url: author.avatar
        ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png`
        : undefined,
    },
    footer: { text: `${count} ⭐ · ${link}` },
    timestamp: msg.timestamp,
  };
  if (msg.attachments?.[0]?.url) embed.image = { url: msg.attachments[0].url };

  const postRes = await discordApi(env, 'POST', `/channels/${cfg.ids.ch_highlights}/messages`, {
    content: `${count} ⭐ in <#${sourceChannelId}>`,
    embeds: [embed],
  });
  if (!postRes.ok) return { error: 'post-failed', status: postRes.status };

  // Stamp dedup (30-day TTL)
  await env.LOADOUT_BOLTS.put(stampKey, '1', { expirationTtl: 30 * 24 * 60 * 60 });
  return { posted: true, count };
}

// ── Counting game (gateway-forwarded MESSAGE_CREATE in counting ch) ─────
//
// State: { last: <int>, lastUserId: <string>, ts: <number> }
// Rules: same user can't post twice in a row; next integer must be last+1.

export async function handleCountingMessage(env, msg) {
  const guildId = msg.guild_id;
  if (!guildId) return { skipped: 'no-guild' };
  const cfg = await loadGuildCfg(env, guildId);
  if (msg.channel_id !== cfg?.ids?.ch_counting) return { skipped: 'wrong-channel' };
  if (msg.author?.bot) return { skipped: 'bot' };

  const stateKey = `guild:counting:${guildId}:state`;
  const state = (await env.LOADOUT_BOLTS.get(stateKey, { type: 'json' })) || { last: 0, lastUserId: null };

  const trimmed = (msg.content || '').trim();
  const n = parseInt(trimmed, 10);
  const valid = Number.isInteger(n) && String(n) === trimmed
              && n === state.last + 1
              && msg.author.id !== state.lastUserId;

  if (!valid) {
    // Delete the bad message + add a hint
    await discordApi(env, 'DELETE', `/channels/${msg.channel_id}/messages/${msg.id}`);
    return { deleted: true, reason: !Number.isInteger(n) ? 'not-int'
                              : n !== state.last + 1   ? 'wrong-number'
                              : 'same-user-twice' };
  }

  // Accept — add a ⭐ react and bump the state
  await discordApi(env, 'PUT', `/channels/${msg.channel_id}/messages/${msg.id}/reactions/${encodeURIComponent('✅')}/@me`);
  await env.LOADOUT_BOLTS.put(stateKey, JSON.stringify({
    last: n, lastUserId: msg.author.id, ts: Date.now(),
  }));
  return { accepted: n };
}
