// Community-night poll v2: custom embed-based poll with cover art per
// option + button voting. Vote tracking lives in D1 (poll_votes), one row
// per (poll, user). Replacing on revote means there's no double-counting.
//
// Lifecycle:
//   - postCnPoll posts a fresh poll message in the bound poll channel
//     for a Community Votes Night (Sun/Tue/Thu/Sat, hub button or admin
//     triggered) and resets the schedule's CN winners on Sunday, the
//     first CVN of the week.
//   - Cross-week winner exclusion: this week's previous CN winners are
//     filtered out before the candidate set is built. Week boundary is
//     Sunday 00:00 ET (approximated with UTC midnight of the calendar
//     date that was Sunday in ET).
//   - At 9 PM ET on the same day, closeCnPoll computes the winner by
//     simple-majority, locks the poll buttons, updates the schedule's
//     embed for that day, and triggers queue.js to post the queue.
//   - Vote button click → handleVoteClick: upsert vote, edit poll
//     message in place, ephemeral "Voted for X".

import {
  ephemeral, postChannelMessage, editChannelMessage, weekStartET,
  btn, row, BTN_SECONDARY, COLOR_POLL, cap, steamStoreUrl
} from './util.js';
import { ensureBootstrap } from './bootstrap.js';
import { updateScheduleForWinner, resetWeeklyCnWinners } from './aq-schedule.js';
import { postQueueMessage } from './aq-queue.js';
import { notifyEligibleQueueOpen } from './notify.js';
import { deleteVotingIdle, refreshVotingIdle } from './idle-msgs.js';

// ---- D1 lookups --------------------------------------------------------

async function getOpenPoll(env, guildId) {
  return env.DB.prepare(
    'SELECT * FROM polls WHERE guild_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1'
  ).bind(guildId).first();
}

async function getThisWeekWinnerIds(env, guildId) {
  const weekStart = weekStartET();
  const { results } = await env.DB.prepare(
    `SELECT winner_game_id FROM polls
     WHERE guild_id = ? AND posted_at >= ? AND winner_game_id IS NOT NULL`
  ).bind(guildId, weekStart).all();
  return (results || []).map(r => r.winner_game_id).filter(Boolean);
}

async function getPollOptions(env, pollId) {
  const { results } = await env.DB.prepare(
    `SELECT po.poll_id, po.game_id, po.sort_order, g.name, g.art_url
     FROM poll_options po JOIN games g ON g.id = po.game_id
     WHERE po.poll_id = ?
     ORDER BY po.sort_order ASC`
  ).bind(pollId).all();
  return results || [];
}

async function getVoteTally(env, pollId) {
  const { results } = await env.DB.prepare(
    `SELECT game_id, COUNT(*) AS count FROM poll_votes WHERE poll_id = ? GROUP BY game_id`
  ).bind(pollId).all();
  const map = new Map();
  for (const r of (results || [])) map.set(r.game_id, r.count);
  return map;
}

// ---- Message rendering -------------------------------------------------

async function buildPollPayload(env, poll, options) {
  const tally = await getVoteTally(env, poll.id);
  const totalVotes = [...tally.values()].reduce((a, b) => a + b, 0);
  const closed = !!poll.closed_at;

  // Find winner if closed (highest count; tie-break: lowest sort_order).
  let winnerGameId = null;
  if (closed) {
    let max = -1;
    for (const o of options) {
      const c = tally.get(o.game_id) || 0;
      if (c > max) { max = c; winnerGameId = o.game_id; }
    }
  }

  const { nextEventTimestamp } = await import('../vote-hub.js');
  const closeTs = nextEventTimestamp(Date.now(), poll.day_of_week, 21);
  const closeTag = closeTs
    ? `<t:${Math.floor(closeTs / 1000)}:F> (<t:${Math.floor(closeTs / 1000)}:R>)`
    : '**tonight at 9 PM ET**';

  const headerEmbed = {
    title: '🎮 ' + cap(poll.day_of_week) + ' Community Night · What are we playing?',
    description: closed
      ? '🔒 Voting closed. **' + totalVotes + '** vote' + (totalVotes === 1 ? '' : 's') + ' · winner highlighted below.'
      : `Voting closes ${closeTag}. Tap a button to vote, you can change your vote until the poll closes.\n\n_` + totalVotes + ' vote' + (totalVotes === 1 ? '' : 's') + ' so far._',
    color: COLOR_POLL
  };

  const gameEmbeds = options.map(o => {
    const c = tally.get(o.game_id) || 0;
    const isWinner = closed && o.game_id === winnerGameId;
    const e = {
      title: (isWinner ? '🏆 ' : '') + o.name,
      description: '**' + c + '** vote' + (c === 1 ? '' : 's'),
      color: isWinner ? 0x57F287 : COLOR_POLL
    };
    if (o.art_url) e.thumbnail = { url: o.art_url };
    const store = steamStoreUrl(o.art_url);
    if (store) e.url = store;
    return e;
  });

  // Buttons, one per game. Up to 5 per row, so 8 fits in 2 rows.
  const components = [];
  let currentRow = [];
  for (const o of options) {
    if (currentRow.length === 4) {
      components.push(row(...currentRow));
      currentRow = [];
    }
    currentRow.push(btn('vote:' + poll.id + ':' + o.game_id, o.name, {
      style: BTN_SECONDARY,
      disabled: closed
    }));
  }
  if (currentRow.length) components.push(row(...currentRow));

  return { embeds: [headerEmbed, ...gameEmbeds], components };
}

async function refreshPollMessage(env, pollId) {
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
  if (!poll || !poll.message_id) return;
  const options = await getPollOptions(env, pollId);
  const payload = await buildPollPayload(env, poll, options);
  await editChannelMessage(env, poll.channel_id, poll.message_id, payload);
}

// ---- Lifecycle ---------------------------------------------------------

// Posts a fresh poll for the given day. Idempotent: skips if open poll
// exists or if there aren't enough eligible games. Called from cron at
// 6 PM ET on Wed/Fri/Sat AND from the hub button.
export async function postCnPoll(env, dayOfWeek) {
  const guildId = await ensureBootstrap(env);

  // Per-guild KV binding (with POLL_CHANNEL_ID env fallback). See
  // channel-bindings.js. Lock in the resolved channel for THIS
  // poll's lifecycle by storing it on the DB row, closeCnPoll +
  // refreshPollMessage read from the row, so a mid-cycle rebind
  // won't strand an open poll.
  const { getChannelBinding } = await import('../channel-bindings.js');
  const pollChannelId = await getChannelBinding(env, guildId, 'poll');
  if (!pollChannelId) return { skipped: 'no_poll_channel' };

  const open = await getOpenPoll(env, guildId);
  if (open) return { skipped: 'open_poll_exists', pollId: open.id };

  // Sun/Tue/Thu/Sat are Community Votes Nights (schedule rev 2026-06-11).
  // Sunday opens the week, so posting Sunday's poll resets last week's
  // winners and the schedule embed shows "TBD" for the new week.
  if (dayOfWeek === 'sunday') {
    try { await resetWeeklyCnWinners(env, guildId); }
    catch (e) { console.error('[poll] reset weekly winners', e?.message || e); }
  }

  const excludeIds = await getThisWeekWinnerIds(env, guildId);
  const placeholders = excludeIds.length ? excludeIds.map(() => '?').join(',') : '';
  const sql = `SELECT * FROM games
               WHERE guild_id = ? AND active = 1
               ${excludeIds.length ? 'AND id NOT IN (' + placeholders + ')' : ''}
               ORDER BY name`;
  const { results: games } = await env.DB.prepare(sql).bind(guildId, ...excludeIds).all();

  if (!games || games.length < 2) return { skipped: 'not_enough_games', candidates: games?.length || 0 };

  // Discord caps a single message at 10 embeds. We post 1 header embed +
  // N per-game embeds, so cap candidates at 9. When the active pool is
  // larger, randomly sample 9 (different games rotate into different
  // polls each week). The chosen subset is sorted alphabetically for
  // stable display order.
  const MAX_OPTIONS = 9;
  let candidates = games;
  if (candidates.length > MAX_OPTIONS) {
    candidates = candidates.slice();
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    candidates = candidates.slice(0, MAX_OPTIONS).sort((a, b) => a.name.localeCompare(b.name));
  }

  const insRow = await env.DB.prepare(
    'INSERT INTO polls (guild_id, channel_id, day_of_week) VALUES (?, ?, ?) RETURNING id'
  ).bind(guildId, pollChannelId, dayOfWeek).first();
  const pollId = insRow.id;

  for (let i = 0; i < candidates.length; i++) {
    await env.DB.prepare(
      'INSERT INTO poll_options (poll_id, game_id, sort_order) VALUES (?, ?, ?)'
    ).bind(pollId, candidates[i].id, i).run();
  }

  // Hide the voting idle CTA before posting the live poll so the channel
  // shows only the active poll embed. It comes back in closeCnPoll.
  try { await deleteVotingIdle(env); }
  catch (e) { console.warn('[poll] idle delete', e?.message || e); }

  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
  const options = await getPollOptions(env, pollId);
  const payload = await buildPollPayload(env, poll, options);

  let msg;
  try {
    msg = await postChannelMessage(env, pollChannelId, payload);
  } catch (e) {
    // The Discord post failed but we already INSERTed the poll row. If
    // we leave it in place, future postCnPoll calls (cron or manual) see
    // an "open" poll and skip. Roll back so the next attempt can try
    // fresh.
    console.error('[poll] post failed, rolling back poll #' + pollId + ':', e?.message || e);
    try { await env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(pollId).run(); }
    catch (rb) { console.error('[poll] rollback failed:', rb?.message || rb); }
    throw e;
  }
  await env.DB.prepare('UPDATE polls SET message_id = ? WHERE id = ?').bind(msg.id, pollId).run();

  return { pollId, messageId: msg.id, count: candidates.length };
}

// Closes the open poll: computes winner, locks buttons, updates schedule,
// posts queue. Called from cron at 9 PM ET on Wed/Fri/Sat AND from hub.
//
// `ctx` is optional. When provided (cron + hub button paths via worker.js),
// the eligible-patron DM batch runs via ctx.waitUntil so the worker stays
// alive until DMs finish. Without ctx, DMs may get cut off (acceptable, // the queue post itself still succeeds).
export async function closeCnPoll(env, ctx) {
  const guildId = await ensureBootstrap(env);
  const poll = await getOpenPoll(env, guildId);
  if (!poll) return { skipped: 'no_open_poll' };

  const options = await getPollOptions(env, poll.id);
  const tally = await getVoteTally(env, poll.id);

  let winner = null;
  let max = -1;
  for (const o of options) {
    const c = tally.get(o.game_id) || 0;
    if (c > max) { max = c; winner = o; }
  }

  await env.DB.prepare(
    `UPDATE polls SET closed_at = datetime('now'), winner_game_id = ? WHERE id = ?`
  ).bind(winner?.game_id || null, poll.id).run();

  // Re-render the poll message (locks buttons, highlights winner).
  try { await refreshPollMessage(env, poll.id); }
  catch (e) { console.error('[poll] refresh on close', e?.message || e); }

  if (winner) {
    try { await updateScheduleForWinner(env, guildId, poll.day_of_week, winner.name, winner.art_url); }
    catch (e) { console.error('[poll] schedule update', e?.message || e); }

    let queuePost = null;
    try { queuePost = await postQueueMessage(env, guildId, poll.day_of_week, winner.name, winner.art_url); }
    catch (e) { console.error('[poll] queue post', e?.message || e); }

    // Async: DM eligible patrons. Requires Server Members intent in the
    // dev portal, without it the members fetch 401s and we silently bail.
    if (queuePost?.messageId) {
      const dmTask = notifyEligibleQueueOpen(
        env, guildId, poll.id, poll.day_of_week, winner.name,
        env.QUEUE_CHANNEL_ID, queuePost.messageId
      ).catch(e => console.error('[notify]', e?.message || e));
      if (ctx?.waitUntil) ctx.waitUntil(dmTask);
      // (no ctx: fire-and-forget; worker may tear down before all DMs send)
    }
  }

  // Bring the voting idle CTA back, with the new winner now reflected in
  // the "Played this week" list.
  try { await refreshVotingIdle(env); }
  catch (e) { console.warn('[poll] idle refresh', e?.message || e); }

  return { pollId: poll.id, winnerGameId: winner?.game_id || null, winnerName: winner?.name || null, voteCount: max };
}

// ---- Component handler (vote button click) -----------------------------

// custom_id format: vote:<pollId>:<gameId>
export async function handleVoteClick(env, data) {
  const parts = (data.data?.custom_id || '').split(':');
  if (parts.length !== 3) return ephemeral('Bad vote button.');
  const pollId = parseInt(parts[1], 10);
  const gameId = parseInt(parts[2], 10);
  if (!pollId || !gameId) return ephemeral('Bad vote button.');

  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
  if (!poll) return ephemeral('Poll not found.');
  if (poll.closed_at) return ephemeral('🔒 Voting has closed for this poll.');

  const userId = data.member?.user?.id || data.user?.id;
  if (!userId) return ephemeral('Couldn\'t identify you.');

  // Upsert vote (one vote per user per poll, replaceable).
  await env.DB.prepare(
    `INSERT INTO poll_votes (poll_id, user_id, game_id) VALUES (?, ?, ?)
     ON CONFLICT (poll_id, user_id) DO UPDATE SET
       game_id = excluded.game_id,
       voted_at = datetime('now')`
  ).bind(pollId, userId, gameId).run();

  // Edit message to show the new tally. Inline (~200ms each); fits in
  // the 3-second interaction-response budget.
  try { await refreshPollMessage(env, pollId); }
  catch (e) { console.error('[vote] refresh', e?.message || e); }

  const game = await env.DB.prepare('SELECT name FROM games WHERE id = ?').bind(gameId).first();
  const { nextEventTimestamp } = await import('../vote-hub.js');
  const closeTs = nextEventTimestamp(Date.now(), poll.day_of_week, 21);
  const closeTag = closeTs
    ? `<t:${Math.floor(closeTs / 1000)}:R>`
    : 'tonight';
  return ephemeral('🗳️ Voted for **' + (game?.name || 'that game') + `**. You can change your vote until the poll closes ${closeTag}.`);
}

// ---- Cron entry --------------------------------------------------------

// Called from worker.js scheduled() at every hourly tick. Branches on
// current ET weekday + hour. Cron itself is hourly UTC ("0 * * * *");
// internal time check makes this DST-safe. ctx is forwarded so the close
// path can use ctx.waitUntil for the eligible-patron DM batch.
export async function runScheduledPoll(env, weekday, hour, ctx) {
  // Schedule rev 2026-05-14: Saturday is the only Community Night.
  // Stream nights are Sun/Mon/Wed/Fri/Sat at 10:30 PM-12:30 AM ET, off Tue/Thu.
  if (weekday !== 'saturday') return;
  if (hour === 18) {
    try { await postCnPoll(env, weekday); }
    catch (e) { console.error('[cron post]', weekday, e?.message || e); }
  } else if (hour === 21) {
    try { await closeCnPoll(env, ctx); }
    catch (e) { console.error('[cron close]', weekday, e?.message || e); }
  }
}
