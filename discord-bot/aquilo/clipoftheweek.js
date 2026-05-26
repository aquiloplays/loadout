// Clip-of-the-week tracker. Members post Twitch/Kick clip URLs in #clips;
// the bot detects clip-shaped URLs in MESSAGE_CREATE events (via the same
// aquilo-presence webhook that powers counting), records the message in
// `clips`, and tallies :clap: reactions weekly via cron.
//
// Public API:
//   trackClipMessage(env, payload)       -> webhook from aquilo-presence
//   refreshClipReactions(env)            -> cron: sync clap counts for active clips
//   postClipOfTheWeek(env)               -> cron (Sunday): top-3 in #clips pinned
//
// Why we sync reactions rather than listening live: persistent gateway is
// expensive; clap counts only need eventual consistency. Refresh hourly.

import {
  postChannelMessage, editChannelMessage, discordFetch,
  COLOR_SCHEDULE, weekStartET
} from './util.js';
import { bump } from './achievements.js';
import { getChannelBinding } from '../channel-bindings.js';

// Resolve the clips channel via the per-guild binding (KV) with
// CLIPS_CHANNEL_ID env fallback. See channel-bindings.js.
async function resolveClipsChannel(env) {
  return getChannelBinding(env, env.AQUILO_VAULT_GUILD_ID, 'clips');
}

const CLIP_URL_RE = /\b(?:https?:\/\/)?(?:clips\.twitch\.tv\/|www\.twitch\.tv\/[^/\s]+\/clip\/|kick\.com\/[^/\s]+\/clips?\/)[A-Za-z0-9_-]+/i;
const CLAP_EMOJI = '👏';

/** Called from the aquilo-presence MESSAGE_CREATE webhook (same plumbing as counting). */
export async function trackClipMessage(env, payload) {
  if (!env?.DB) return { tracked: false };
  // Drop bot-authored messages. The gateway shim forwards every
  // MESSAGE_CREATE including our own bot's outgoing relays — without
  // this guard we'd seed a 👏 reaction on the bot's own posts AND
  // bump clip_curator achievements against undefined author ids.
  // Bot flag is at payload.author.bot / payload.isBot (shim shape).
  if (payload?.bot === true || payload?.isBot === true || payload?.author?.bot === true) {
    return { tracked: false, skipped: 'bot' };
  }
  const clipsChannelId = await resolveClipsChannel(env);
  if (!clipsChannelId) return { tracked: false };
  if (payload.channel_id !== clipsChannelId) return { tracked: false };
  const content = String(payload.content || '');
  const m = content.match(CLIP_URL_RE);
  if (!m) return { tracked: false };

  const url = m[0].startsWith('http') ? m[0] : 'https://' + m[0];
  // Shim sends author id at payload.author.id (Discord-slim) AND
  // payload.userId (camelCase mirror). The legacy payload.author_id
  // doesn't exist in the forwarded shape.
  const authorId = payload.author_id || payload.userId || payload.author?.id || null;

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO clips (message_id, guild_id, channel_id, author_id, url)
         VALUES (?, ?, ?, ?, ?)`
    ).bind(payload.id, payload.guild_id, payload.channel_id, authorId, url).run();

    // Seed a clap reaction so viewers know what to react with.
    try {
      await discordFetch(env,
        `/channels/${payload.channel_id}/messages/${payload.id}/reactions/${encodeURIComponent(CLAP_EMOJI)}/@me`,
        { method: 'PUT' });
    } catch { /* non-critical */ }

    // Achievement: clip_curator
    if (authorId) {
      try { await bump(env, payload.guild_id, authorId, 'clip_curator'); } catch {}
    }

    return { tracked: true };
  } catch (e) {
    console.error('[clipoftheweek] insert failed', e?.message || e);
    return { tracked: false };
  }
}

/** Cron: sync clap counts for clips posted in the current week. */
export async function refreshClipReactions(env) {
  if (!env?.DB) return;
  const since = weekStartET();
  const { results } = await env.DB.prepare(
    'SELECT message_id, channel_id FROM clips WHERE posted_at >= ? ORDER BY posted_at DESC LIMIT 50'
  ).bind(since).all();
  if (!results || results.length === 0) return;

  for (const c of results) {
    try {
      // Discord Reactions endpoint returns the users who reacted; we count them.
      const users = await discordFetch(env,
        `/channels/${c.channel_id}/messages/${c.message_id}/reactions/${encodeURIComponent(CLAP_EMOJI)}?limit=100`,
        { method: 'GET' });
      const count = Array.isArray(users) ? users.length : 0;
      await env.DB.prepare(
        'UPDATE clips SET clap_count = ?, last_synced = datetime(\'now\') WHERE message_id = ?'
      ).bind(count, c.message_id).run();
    } catch (e) {
      // Likely deleted or perms changed — soft-skip.
    }
  }
}

/** Cron: Sunday 10 AM ET → post top-3 of the past week. */
export async function postClipOfTheWeek(env) {
  if (!env?.DB) return;
  const clipsChannelId = await resolveClipsChannel(env);
  if (!clipsChannelId) return;
  const since = weekStartET();
  const { results } = await env.DB.prepare(
    `SELECT message_id, author_id, url, clap_count
       FROM clips
       WHERE posted_at >= ? AND clap_count > 0
       ORDER BY clap_count DESC, posted_at ASC
       LIMIT 3`
  ).bind(since).all();
  if (!results || results.length === 0) return;

  const medals = ['🥇', '🥈', '🥉'];
  const lines = results.map((c, i) =>
    `${medals[i]} <@${c.author_id}> · 👏 **${c.clap_count}**\n${c.url}`
  );
  await postChannelMessage(env, clipsChannelId, {
    embeds: [{
      color: COLOR_SCHEDULE,
      title: '🎬 Clip of the Week',
      description: lines.join('\n\n'),
      footer: { text: 'React 👏 on clips this week to vote.' },
      timestamp: new Date().toISOString()
    }]
  });
}
