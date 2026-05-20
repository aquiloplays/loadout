// Rotation widget — pre-stream poll with live reaction tallies.
//
// Pairs with the widget-side D2 (rotation/src/discord-prestream-poll.js):
// the widget can post a poll via webhook, but webhooks can't READ
// reactions back. This bot module is the "live tallies" upgrade:
// streamer fires the poll via slash command, bot posts the message with
// pre-baked emoji reactions, then a hourly cron refresh patches the
// message with live counts pulled from Discord's reaction REST endpoint.
//
// Slash commands (registered in src/register-commands.js):
//   /rotation-poll new      <title> <message> <option1>..<option5>
//                           Posts a fresh poll. Auto-reacts with each
//                           option's emoji so viewers can just click +1
//                           on whichever they like. Stores the
//                           message + options in KV for the cron to
//                           refresh tallies against.
//   /rotation-poll close                Marks the poll closed and
//                           updates the message a final time. The
//                           buttons stay live (reactions are buttons!)
//                           but the embed now shows the winner.
//
// HTTP routes: none — this whole flow is bot-side.
//
// Cron: the existing hourly handler in worker.js calls
// runScheduledRotationPoll(env). If a poll is open, fetch every
// option's reaction count and PATCH the message embed with live counts.
//
// Storage: Workers KV under `rotation-poll:current`. Single-poll-at-a-
// time per channel (typical use: streamer fires one before each
// stream cycle). New /rotation-poll new replaces the previous poll.

import {
  ephemeral, flattenOptions, getSubcommand,
  postChannelMessage, editChannelMessage, discordFetch, COLOR_POLL,
} from './util.js';

const KEY = 'rotation-poll:current';

// ---------- Storage helpers ----------

async function loadPoll(env) {
  if (!env.STATE) return null;
  const raw = await env.STATE.get(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}
async function savePoll(env, poll) {
  if (!env.STATE) throw new Error('STATE KV not bound');
  await env.STATE.put(KEY, JSON.stringify(poll));
}
async function clearPoll(env) {
  if (!env.STATE) return;
  await env.STATE.delete(KEY);
}

// ---------- Embed rendering ----------

function buildPollEmbed(poll) {
  // Build the option list with current tallies. When the poll's open,
  // counts come from poll.tallies (refreshed by cron). When closed,
  // mark the highest-vote option with a 🏆.
  const totalVotes = (poll.options || []).reduce((sum, o) => sum + (poll.tallies?.[o.emoji] || 0), 0);
  const closed = !!poll.closedAt;

  let winnerEmoji = null;
  if (closed) {
    let max = -1;
    for (const o of poll.options) {
      const c = poll.tallies?.[o.emoji] || 0;
      if (c > max) { max = c; winnerEmoji = o.emoji; }
    }
  }

  const lines = poll.options.map(o => {
    const c = poll.tallies?.[o.emoji] || 0;
    const isWinner = closed && o.emoji === winnerEmoji;
    return `${isWinner ? '🏆 ' : ''}${o.emoji}  **${o.label}** — ${c} vote${c === 1 ? '' : 's'}`;
  });

  return {
    author:      { name: 'Rotation pre-stream poll', url: 'https://widget.aquilo.gg/' },
    title:       poll.title || '🎶 Pre-stream vibe check',
    description: `${poll.message || ''}\n\n${lines.join('\n')}`,
    color:       closed ? 0x57F287 : COLOR_POLL,
    footer: {
      text: closed
        ? `🔒 Poll closed · ${totalVotes} total vote${totalVotes === 1 ? '' : 's'}`
        : `🗳️ Reactions are the vote · refreshed hourly · ${totalVotes} so far`,
    },
    timestamp:   new Date().toISOString(),
  };
}

// ---------- Slash command handlers ----------

export async function handleRotationPoll(env, data) {
  const sub = getSubcommand(data);
  if (sub.name === 'new')   return handleRotationPollNew(env, data, sub.options);
  if (sub.name === 'close') return handleRotationPollClose(env, data);
  return ephemeral('Unknown subcommand. Use `/rotation-poll new` or `/rotation-poll close`.');
}

async function handleRotationPollNew(env, data, opts) {
  // Channel resolution: post in the channel the slash command was used
  // in (Discord exposes that as data.channel_id). Override via env var
  // ROTATION_POLL_CHANNEL_ID if the streamer wants polls always in a
  // specific announcements channel.
  const channelId = env.ROTATION_POLL_CHANNEL_ID || data.channel_id;
  if (!channelId) return ephemeral('Couldn\'t resolve a channel to post in.');

  const title   = String(opts.title || '').trim() || '🎶 Pre-stream vibe check';
  const message = String(opts.message || '').trim() || 'React with the matching emoji to vote — I\'ll factor it in when queuing music.';
  // Up to 5 options — gathered as option1..option5 each in form
  // "<emoji> <label>" (single space separator).
  const options = [];
  for (const k of ['option1', 'option2', 'option3', 'option4', 'option5']) {
    const v = String(opts[k] || '').trim();
    if (!v) continue;
    const m = v.match(/^(\S+)\s+(.+)$/);
    if (!m) {
      return ephemeral(
        `Option "${v}" is malformed — use \`<emoji> <label>\` (e.g. \`🔥 Hype / energy\`). The first whitespace-separated token is the emoji.`
      );
    }
    options.push({ emoji: m[1], label: m[2].slice(0, 80) });
  }
  if (options.length < 2) return ephemeral('Pass at least 2 options (`option1` + `option2`).');

  // Replace any open poll. The previous poll's message in Discord is
  // left alone — its reactions still work but the cron refresh stops
  // touching it (KV only tracks the current one).
  const poll = {
    title,
    message,
    options,
    tallies:    Object.fromEntries(options.map(o => [o.emoji, 0])),
    channelId,
    messageId:  null,
    postedAt:   new Date().toISOString(),
    closedAt:   null,
  };

  let posted;
  try {
    posted = await postChannelMessage(env, channelId, { embeds: [buildPollEmbed(poll)] });
  } catch (e) {
    return ephemeral(`Couldn't post: ${e.message}`);
  }
  poll.messageId = posted.id;

  // Pre-react with each option's emoji so viewers see the buttons
  // already there. Bot's own reactions are filtered out of the tally.
  for (const o of options) {
    try { await reactToMessage(env, channelId, posted.id, o.emoji); }
    catch (e) { console.warn('[rotation-poll] pre-react failed for', o.emoji, ':', e?.message); }
  }

  await savePoll(env, poll);
  return ephemeral(`✓ Poll posted in <#${channelId}>. Reactions tally up hourly via cron.`);
}

async function handleRotationPollClose(env, data) {
  const poll = await loadPoll(env);
  if (!poll) return ephemeral('No open poll to close.');
  if (poll.closedAt) return ephemeral('Poll is already closed.');
  // Final tally + message refresh.
  await refreshTallies(env, poll);
  poll.closedAt = new Date().toISOString();
  try { await editChannelMessage(env, poll.channelId, poll.messageId, { embeds: [buildPollEmbed(poll)] }); }
  catch (e) { console.warn('[rotation-poll] close-edit failed:', e?.message); }
  await savePoll(env, poll);
  return ephemeral('🔒 Poll closed and final tallies posted.');
}

// ---------- Cron entry — refresh tallies hourly ----------

export async function runScheduledRotationPoll(env) {
  const poll = await loadPoll(env);
  if (!poll || poll.closedAt) return;   // nothing to refresh
  try {
    const changed = await refreshTallies(env, poll);
    if (!changed) return;   // no new votes since last refresh — skip the PATCH
    await editChannelMessage(env, poll.channelId, poll.messageId, { embeds: [buildPollEmbed(poll)] });
    await savePoll(env, poll);
  } catch (e) {
    console.error('[rotation-poll] cron refresh failed:', e?.message || e);
  }
}

// Pulls the current reaction count for each option from Discord's REST
// API and updates poll.tallies in place. Returns true if any tally
// changed (so the caller knows whether a PATCH is worth firing).
async function refreshTallies(env, poll) {
  let changed = false;
  for (const o of poll.options) {
    let count;
    try { count = await getReactionCount(env, poll.channelId, poll.messageId, o.emoji); }
    catch (e) {
      console.warn('[rotation-poll] reaction fetch failed for', o.emoji, ':', e?.message);
      continue;
    }
    // Subtract 1 for the bot's own pre-reaction so users see only the
    // human votes. Floor at 0 so a deleted bot reaction can't go
    // negative.
    const adjusted = Math.max(0, count - 1);
    if (poll.tallies[o.emoji] !== adjusted) {
      poll.tallies[o.emoji] = adjusted;
      changed = true;
    }
  }
  return changed;
}

// ---------- Discord REST: reaction add + reaction count ----------

// PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me
function reactToMessage(env, channelId, messageId, emoji) {
  return discordFetch(env,
    '/channels/' + encodeURIComponent(channelId) +
    '/messages/' + encodeURIComponent(messageId) +
    '/reactions/' + encodeURIComponent(emoji) +
    '/@me', {
    method: 'PUT',
  });
}

// GET /channels/{id}/messages/{id} returns the message with a
// `reactions` array, each entry { emoji: { name }, count }. Cheaper
// than paginating the per-emoji users endpoint when we only need
// counts. count INCLUDES the bot's own reaction; subtract 1 in
// the caller.
async function getReactionCount(env, channelId, messageId, emoji) {
  const msg = await discordFetch(env,
    '/channels/' + encodeURIComponent(channelId) +
    '/messages/' + encodeURIComponent(messageId), {
    method: 'GET',
  });
  const entry = (msg.reactions || []).find(r => r.emoji?.name === emoji);
  return entry?.count || 0;
}
