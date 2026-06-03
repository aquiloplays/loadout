// Community-Night vote menu hub, persistent embed in the CN
// channel with four buttons that walk users through the existing
// vote / queue / status flows without typing slash commands.
//
// All four buttons emit either a "cnv:*" custom_id (handled here)
// or fall through to an existing aquilo handler:
//   cnv:vote          → ephemeral game-picker (the per-game buttons
//                        emit the existing `vote:<pollId>:<gameId>`
//                        custom_id which the aquilo poll handler
//                        already catches)
//   cnv:standings     → ephemeral live tally
//   cnv:queue-join    → emits `queue:join` UX via aquilo-queue.js
//                        directly (no slash-command round-trip)
//   cnv:status        → ephemeral: your vote + queue position
//
// KV: cn-vote:hub-msg:<g> tracks the hub message id (delete-and-
// repost on /admin/cn-vote/post-hub re-runs).

import { getChannelBinding } from './channel-bindings.js';
import { getBranding } from './branding.js';

const HUB_MSG_KEY = (g) => `cn-vote:hub-msg:${g}`;

const RESP_CHAT          = 4;
const FLAG_EPHEMERAL     = 64;
const COMPONENT_ROW      = 1;
const COMPONENT_BUTTON   = 2;
const BTN_PRIMARY        = 1;
const BTN_SECONDARY      = 2;
const BTN_SUCCESS        = 3;

// ── Embed builder ─────────────────────────────────────────────────

export async function buildHubEmbed(env, guildId) {
  const brand = await getBranding(env, guildId);
  return {
    embed: {
      title: '🎲 Community Night',
      description:
        `Saturday is **Community Night**, the community picks the game.\n\n` +
        `• **Vote for this week** opens the current poll\n` +
        `• **View standings** shows live counts\n` +
        `• **Join CN queue** locks your slot for tonight's stream\n` +
        `• **My status**, your vote + queue position`,
      color: brand.accentColor || 0x9147ff,
      footer: { text: 'Vote is one-per-user-per-week. Change it any time until the poll closes.' },
    },
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Vote for this week', custom_id: 'cnv:vote' },
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'View standings',     custom_id: 'cnv:standings' },
        { type: COMPONENT_BUTTON, style: BTN_SUCCESS,   label: 'Join CN queue',      custom_id: 'cnv:queue-join' },
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My status',          custom_id: 'cnv:status' },
      ],
    }],
  };
}

// ── Shared poster ─────────────────────────────────────────────────

export async function postCnVoteHub(env, guildId, channelId) {
  if (!channelId) return { ok: false, error: 'no-channel-id' };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  let deletedPrior = false;
  try {
    const prior = await env.LOADOUT_BOLTS.get(HUB_MSG_KEY(guildId), { type: 'json' });
    if (prior?.channelId && prior?.messageId) {
      const del = await fetch(
        `https://discord.com/api/v10/channels/${prior.channelId}/messages/${prior.messageId}`,
        {
          method: 'DELETE',
          headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord cn-vote-hub' },
        },
      );
      if (del.ok || del.status === 204 || del.status === 404) deletedPrior = true;
    }
  } catch { /* ignore */ }

  const { embed, components } = await buildHubEmbed(env, guildId);
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord cn-vote-hub',
    },
    body: JSON.stringify({ embeds: [embed], components, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: 'post-failed', status: r.status, body: t.slice(0, 200) };
  }
  const j = await r.json();
  await env.LOADOUT_BOLTS.put(HUB_MSG_KEY(guildId),
    JSON.stringify({ channelId, messageId: j.id, postedAt: Date.now() }));
  return { ok: true, channelId, messageId: j.id, deletedPrior };
}

// Admin HTTP entry, resolves channel via opts + channel-binding(poll)
// (the CN vote hub lives in the same channel as the poll). Mirrors
// postLfgHubForGuild in lfg-hub.js.
export async function postCnVoteHubForGuild(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  let pick;
  if (opts.channelId) {
    pick = { id: String(opts.channelId), name: '' };
  } else {
    // Default = the bound poll channel (community-night-queue).
    const bound = await getChannelBinding(env, guildId, 'poll');
    if (bound) {
      pick = { id: bound, name: '' };
    } else {
      return { ok: false, error: 'no-channel-match', hint: 'set the poll binding first or pass channelId in body' };
    }
  }
  const post = await postCnVoteHub(env, guildId, pick.id);
  if (!post.ok) return { ok: false, error: post.error, status: post.status, body: post.body, channelId: pick.id };
  return { ok: true, channelId: pick.id, channelName: pick.name, messageId: post.messageId, deletedPrior: !!post.deletedPrior };
}

// ── Component handlers ───────────────────────────────────────────

export async function handleCnVoteComponent(env, data) {
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) {
    return { type: RESP_CHAT, data: { content: 'Run this in a server.', flags: FLAG_EPHEMERAL } };
  }
  const cid = data.data?.custom_id || '';
  const action = cid.split(':')[1];

  if (action === 'vote')        return voteMenu(env, guildId, userId);
  if (action === 'standings')   return standingsMenu(env, guildId);
  if (action === 'queue-join') {
    // Re-emit through aquilo-queue.js, its handler is generic
    // (reads from KV state, doesn't need the queue-message context).
    const { handleQueueButton } = await import('./aquilo/aq-queue.js');
    return handleQueueButton(env, { ...data, data: { ...data.data, custom_id: 'queue:join' } }, guildId);
  }
  if (action === 'status')      return statusMenu(env, guildId, userId);
  return { type: RESP_CHAT, data: { content: 'Unknown CN-vote action: ' + cid, flags: FLAG_EPHEMERAL } };
}

// ── Vote menu (ephemeral) ────────────────────────────────────────
//
// Lists every option on the current open poll as a per-game button.
// custom_id format `vote:<pollId>:<gameId>` matches the existing
// aquilo poll vote handler, so clicking goes through THAT (upsert +
// refresh poll message) without any extra plumbing here.

async function voteMenu(env, guildId, userId) {
  const open = await env.DB.prepare(
    `SELECT id FROM polls WHERE guild_id = ? AND closed_at IS NULL
     ORDER BY posted_at DESC LIMIT 1`,
  ).bind(guildId).first();
  if (!open) {
    return {
      type: RESP_CHAT,
      data: {
        content: '🗳️ **No open vote right now.** Saturday 6 PM ET kicks off the next one.',
        flags: FLAG_EPHEMERAL,
      },
    };
  }
  const opts = await env.DB.prepare(
    `SELECT po.id, po.game_id, po.sort_order, g.name, g.art_url
       FROM poll_options po
       JOIN games g ON g.id = po.game_id
      WHERE po.poll_id = ?
      ORDER BY po.sort_order ASC`,
  ).bind(open.id).all();
  const games = opts.results || [];
  if (games.length === 0) {
    return {
      type: RESP_CHAT,
      data: { content: 'No options found for the open poll. Ping a mod.', flags: FLAG_EPHEMERAL },
    };
  }
  // Look up current vote (if any) to mark the active button.
  const cur = await env.DB.prepare(
    `SELECT game_id FROM poll_votes WHERE poll_id = ? AND user_id = ?`,
  ).bind(open.id, userId).first();
  const currentGameId = cur?.game_id || null;

  // Render up to 25 buttons across rows of 5. Discord caps a
  // message at 5 action rows × 5 components = 25. The poll cap is
  // 9 candidates, so this fits comfortably.
  const rows = [];
  let row = { type: COMPONENT_ROW, components: [] };
  for (const g of games) {
    if (row.components.length >= 5) { rows.push(row); row = { type: COMPONENT_ROW, components: [] }; }
    if (rows.length >= 5) break;
    row.components.push({
      type: COMPONENT_BUTTON,
      style: g.game_id === currentGameId ? BTN_SUCCESS : BTN_SECONDARY,
      label: (g.game_id === currentGameId ? '✅ ' : '') + (g.name || 'Game').slice(0, 70),
      custom_id: `vote:${open.id}:${g.game_id}`,
    });
  }
  if (row.components.length) rows.push(row);

  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: '🗳️ This week\'s Community Night vote',
        description: currentGameId
          ? 'Your current pick is highlighted in green. Tap a different game to change your vote.'
          : 'Pick the game you want to play. You can change your vote until the poll closes.',
        color: 0x9147ff,
      }],
      components: rows,
      flags: FLAG_EPHEMERAL,
    },
  };
}

// ── Standings (ephemeral live tally) ─────────────────────────────

async function standingsMenu(env, guildId) {
  const open = await env.DB.prepare(
    `SELECT * FROM polls WHERE guild_id = ? AND closed_at IS NULL
     ORDER BY posted_at DESC LIMIT 1`,
  ).bind(guildId).first();
  if (!open) {
    return {
      type: RESP_CHAT,
      data: { content: '🗳️ No open vote right now.', flags: FLAG_EPHEMERAL },
    };
  }
  const rows = await env.DB.prepare(
    `SELECT g.name, COUNT(pv.user_id) AS votes
       FROM poll_options po
       JOIN games g ON g.id = po.game_id
       LEFT JOIN poll_votes pv ON pv.poll_id = po.poll_id AND pv.game_id = po.game_id
      WHERE po.poll_id = ?
      GROUP BY g.id
      ORDER BY votes DESC, g.name ASC`,
  ).bind(open.id).all();
  const total = (rows.results || []).reduce((s, r) => s + (r.votes || 0), 0);
  const lines = (rows.results || []).map((r, i) => {
    const v = r.votes || 0;
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    const bar = '█'.repeat(Math.min(20, Math.round((v / Math.max(1, total)) * 20))) || '·';
    return `${i + 1}. **${v}** · ${bar} · ${r.name} _(${pct}%)_`;
  });
  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: '📊 Live standings · ' + (total === 1 ? '1 vote' : `${total} votes`),
        description: lines.length ? lines.join('\n') : '_no votes yet, be the first_',
        color: 0x9147ff,
        footer: { text: 'Refresh by tapping the button again. Voting closes Sat 9 PM ET.' },
      }],
      flags: FLAG_EPHEMERAL,
    },
  };
}

// ── Status menu (per-user) ───────────────────────────────────────

async function statusMenu(env, guildId, userId) {
  const open = await env.DB.prepare(
    `SELECT id FROM polls WHERE guild_id = ? AND closed_at IS NULL
     ORDER BY posted_at DESC LIMIT 1`,
  ).bind(guildId).first();
  const lines = [];
  if (open) {
    const v = await env.DB.prepare(
      `SELECT g.name FROM poll_votes pv
         JOIN games g ON g.id = pv.game_id
        WHERE pv.poll_id = ? AND pv.user_id = ?`,
    ).bind(open.id, userId).first();
    lines.push(v ? `🗳️ You voted: **${v.name}**` : '🗳️ You haven\'t voted yet this week');
  } else {
    lines.push('🗳️ No open vote right now');
  }
  // Queue position.
  const queue = await env.STATE.get('queue:' + guildId);
  if (queue) {
    try {
      const q = JSON.parse(queue);
      const idx = (q.entries || []).findIndex(e => e.user_id === userId);
      if (idx >= 0) lines.push(`🙋 Queue position: **${idx + 1}** of ${(q.entries || []).length}`);
      else lines.push('🙋 Not in the CN queue');
    } catch { /* swallow */ }
  } else {
    lines.push('🙋 No queue is open right now');
  }
  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: '👤 Your CN status',
        description: lines.join('\n'),
        color: 0x9147ff,
      }],
      flags: FLAG_EPHEMERAL,
    },
  };
}
