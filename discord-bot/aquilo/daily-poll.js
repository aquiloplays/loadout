// "This or That" daily mini-poll. Two-button vote each morning at
// 10 AM ET. Closes the previous day's poll first, then posts a fresh
// one. Vote tracking is per-user (one vote each, replaceable). Hub
// modal lets the streamer edit the rotation of pairs.

import {
  postChannelMessage, editChannelMessage, ephemeral, modal, getModalField,
  btn, row, BTN_PRIMARY, BTN_SECONDARY, COLOR_POLL
} from './util.js';
import { ensureBootstrap } from './bootstrap.js';

const KV_LIST  = 'tot:list';
const KV_INDEX = 'tot:index';

const DEFAULT_PAIRS = [
  { a: '☕ Coffee',          b: '⚡ Energy Drink' },
  { a: '🌞 Day stream',      b: '🌙 Night stream' },
  { a: '🧍 Solo runs',       b: '👯 Coop madness' },
  { a: '👻 Horror games',    b: '🛋️ Comfy games' },
  { a: '🍕 Pizza',           b: '🍔 Burger' },
  { a: '🎧 Headphones',      b: '🔊 Speakers' },
  { a: '⌨️ Keyboard',         b: '🎮 Controller' }
];

async function getPairs(env) {
  const raw = await env.STATE.get(KV_LIST);
  if (!raw) return DEFAULT_PAIRS.slice();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_PAIRS.slice();
  } catch { return DEFAULT_PAIRS.slice(); }
}

async function savePairs(env, list) {
  await env.STATE.put(KV_LIST, JSON.stringify(list));
}

async function nextIndex(env, mod) {
  const raw = await env.STATE.get(KV_INDEX);
  const cur = raw ? parseInt(raw, 10) : 0;
  const next = (cur + 1) % mod;
  await env.STATE.put(KV_INDEX, String(next));
  return cur % mod;
}

async function getOpenDailyPoll(env, guildId) {
  return env.DB.prepare(
    'SELECT * FROM daily_polls WHERE guild_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1'
  ).bind(guildId).first();
}

async function getVoteCounts(env, pollId) {
  const { results } = await env.DB.prepare(
    `SELECT choice, COUNT(*) AS c FROM daily_votes WHERE poll_id = ? GROUP BY choice`
  ).bind(pollId).all();
  let a = 0, b = 0;
  for (const r of (results || [])) {
    if (r.choice === 'a') a = r.c;
    if (r.choice === 'b') b = r.c;
  }
  return { a, b };
}

function buildPollPayload(poll, counts, closed) {
  const total = counts.a + counts.b;
  const pct = (n) => total ? Math.round(100 * n / total) : 0;
  const bar = (n) => {
    const w = total ? Math.round(10 * n / total) : 0;
    return '█'.repeat(w) + '░'.repeat(10 - w);
  };
  const desc = closed
    ? '🔒 **Closed** · ' + total + ' total vote' + (total === 1 ? '' : 's')
    : 'Vote with the buttons below. Closes tomorrow morning.';
  const embed = {
    title: '🤔 This or That?',
    description: desc,
    color: COLOR_POLL,
    fields: [
      { name: poll.opt_a, value: bar(counts.a) + '  **' + counts.a + '** (' + pct(counts.a) + '%)', inline: false },
      { name: poll.opt_b, value: bar(counts.b) + '  **' + counts.b + '** (' + pct(counts.b) + '%)', inline: false }
    ],
    timestamp: new Date().toISOString()
  };
  const components = [row(
    btn('tot:vote:' + poll.id + ':a', poll.opt_a, { style: BTN_PRIMARY,   disabled: closed }),
    btn('tot:vote:' + poll.id + ':b', poll.opt_b, { style: BTN_SECONDARY, disabled: closed })
  )];
  return { embeds: [embed], components };
}

async function refreshDailyPollMessage(env, pollId) {
  const poll = await env.DB.prepare('SELECT * FROM daily_polls WHERE id = ?').bind(pollId).first();
  if (!poll || !poll.message_id) return;
  const counts = await getVoteCounts(env, pollId);
  const payload = buildPollPayload(poll, counts, !!poll.closed_at);
  try { await editChannelMessage(env, poll.channel_id, poll.message_id, payload); }
  catch (e) { console.error('[tot] refresh', e?.message || e); }
}

// Cron entry: 10 AM ET daily. Closes any open poll, posts a fresh one.
//
// Channel resolution: DAILY_POLL_CHANNEL_ID (dedicated channel) →
// ENGAGEMENT_CHANNEL_ID (legacy). Pre-2026-05-28 the polls landed
// in #engagement; they now live in their own channel so the
// engagement feed isn't a wall of polls.
export async function runDailyPoll(env) {
  const target = env.DAILY_POLL_CHANNEL_ID || env.ENGAGEMENT_CHANNEL_ID;
  if (!target) return { skipped: 'no_channel' };
  const guildId = await ensureBootstrap(env);

  // Close any open poll
  const open = await getOpenDailyPoll(env, guildId);
  if (open) {
    await env.DB.prepare(`UPDATE daily_polls SET closed_at = datetime('now') WHERE id = ?`)
      .bind(open.id).run();
    await refreshDailyPollMessage(env, open.id);
  }

  // Post new
  const pairs = await getPairs(env);
  if (!pairs.length) return { skipped: 'no_pairs' };
  const idx = await nextIndex(env, pairs.length);
  const pair = pairs[idx];

  const ins = await env.DB.prepare(
    'INSERT INTO daily_polls (guild_id, channel_id, opt_a, opt_b) VALUES (?, ?, ?, ?) RETURNING id'
  ).bind(guildId, target, pair.a, pair.b).first();
  const pollId = ins.id;

  const poll = await env.DB.prepare('SELECT * FROM daily_polls WHERE id = ?').bind(pollId).first();
  const payload = buildPollPayload(poll, { a: 0, b: 0 }, false);
  const msg = await postChannelMessage(env, target, payload);
  await env.DB.prepare('UPDATE daily_polls SET message_id = ? WHERE id = ?')
    .bind(msg.id, pollId).run();

  return { posted: true, pollId, pair, channel: target };
}

// Vote button click. custom_id format: tot:vote:<pollId>:<a|b>
export async function handleDailyPollVote(env, data) {
  const parts = (data.data?.custom_id || '').split(':');
  if (parts.length !== 4) return ephemeral('That vote button expired. Hit the latest poll.');
  const pollId = parseInt(parts[2], 10);
  const choice = parts[3];
  if (!pollId || !['a','b'].includes(choice)) return ephemeral('That vote button expired. Hit the latest poll.');

  const poll = await env.DB.prepare('SELECT * FROM daily_polls WHERE id = ?').bind(pollId).first();
  if (!poll) return ephemeral('Looks like that poll has closed. Check the latest one.');
  if (poll.closed_at) return ephemeral('🔒 Voting closed for this one.');

  const userId = data.member?.user?.id || data.user?.id;
  if (!userId) return ephemeral('Couldn\'t identify you.');

  await env.DB.prepare(
    `INSERT INTO daily_votes (poll_id, user_id, choice) VALUES (?, ?, ?)
     ON CONFLICT (poll_id, user_id) DO UPDATE SET
       choice = excluded.choice, voted_at = datetime('now')`
  ).bind(pollId, userId, choice).run();

  try { await refreshDailyPollMessage(env, pollId); }
  catch (e) { console.error('[tot] refresh after vote', e?.message || e); }

  const label = choice === 'a' ? poll.opt_a : poll.opt_b;
  return ephemeral('🗳️ Voted: **' + label + '**. (You can change before tomorrow.)');
}

// Hub button → modal to edit the first 5 pairs. Existing pairs beyond 5 preserved.
export async function dailyPollEditModal(env) {
  const pairs = await getPairs(env);
  const fields = [];
  for (let i = 0; i < 5; i++) {
    const cur = pairs[i] || { a: '', b: '' };
    fields.push({
      custom_id: 'p' + i,
      label: 'Pair ' + (i + 1) + ' (format: A | B)',
      style: 1,
      value: cur.a ? cur.a + ' | ' + cur.b : '',
      required: i === 0,
      max_length: 200,
      placeholder: 'e.g. ☕ Coffee | ⚡ Energy Drink'
    });
  }
  return modal('modal:tot_edit', 'This-or-That pairs (first 5)', fields);
}

export async function handleDailyPollEditSubmit(env, data) {
  const pairs = await getPairs(env);
  const replacement = [];
  for (let i = 0; i < 5; i++) {
    const v = (getModalField(data, 'p' + i) || '').trim();
    if (!v) continue;
    const m = v.split('|');
    if (m.length < 2) continue;  // skip malformed
    const a = m[0].trim();
    const b = m.slice(1).join('|').trim();
    if (a && b) replacement.push({ a, b });
  }
  if (!replacement.length) return ephemeral('No valid pairs (format: `A | B`). No changes saved.');
  const merged = replacement.concat(pairs.slice(5));
  await savePairs(env, merged);
  return ephemeral('🎲 Saved ' + replacement.length + ' pair(s). Total in rotation: ' + merged.length + '.');
}
