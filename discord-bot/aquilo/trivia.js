// Daily trivia. Cron at 4 PM ET posts a question to #engagement with
// 2-4 multiple-choice buttons; first correct click wins X Bolts + the
// round closes. Question pool is streamer-curated via the admin hub
// "🧠 Edit Trivia" modal.
//
// State model:
//   - trivia_questions: pool of (question, correct, wrong_1..3)
//   - trivia_rounds:    one row per cron firing (closes on first-correct)
//
// Public API:
//   runTriviaCron(env)                   -> post today's question
//   handleTriviaClick(env, data)         -> button: validate, award, close
//   triviaEditModal()                    -> hub modal to add questions
//   handleTriviaEditSubmit(env, data)    -> save submitted question

import {
  postChannelMessage, editChannelMessage, chat, ephemeral,
  modal, getModalField, btn, row, COLOR_POLL,
  BTN_SECONDARY, BTN_SUCCESS, BTN_DANGER, FLAG_EPHEMERAL
} from './util.js';
import { bump, bumpAndAnnounce } from './achievements.js';
import { tickStreak } from './streak.js';

const TRIVIA_BOLTS = 50;

export async function runTriviaCron(env) {
  if (!env?.DB || !env.ENGAGEMENT_CHANNEL_ID) return;

  // Pick a question that's been least-recently used (or never).
  const q = await env.DB.prepare(
    `SELECT * FROM trivia_questions
       WHERE active = 1
       ORDER BY (last_used IS NULL) DESC, last_used ASC, RANDOM()
       LIMIT 1`
  ).first();
  if (!q) {
    console.log('[trivia] no active questions in pool');
    return;
  }

  // Build options: correct + up to 3 wrongs, shuffled.
  const opts = [
    { label: q.correct, correct: true },
    q.wrong_1 ? { label: q.wrong_1, correct: false } : null,
    q.wrong_2 ? { label: q.wrong_2, correct: false } : null,
    q.wrong_3 ? { label: q.wrong_3, correct: false } : null,
  ].filter(Boolean);
  shuffle(opts);

  // Create round so we have an id to embed in custom_ids.
  const ins = await env.DB.prepare(
    'INSERT INTO trivia_rounds (guild_id, question_id) VALUES (?, ?) RETURNING id'
  ).bind(q.guild_id, q.id).first();
  if (!ins?.id) {
    console.error('[trivia] failed to create round');
    return;
  }
  const roundId = ins.id;

  const embed = {
    color: COLOR_POLL,
    title: '🧠 Daily Trivia',
    description: `**${q.question}**\n\nFirst correct answer wins **${TRIVIA_BOLTS} Bolts**.`,
    footer: { text: 'Round ' + roundId + ' · resets daily at 4 PM ET' }
  };
  const components = [row(...opts.map((o, i) =>
    btn('trivia:' + roundId + ':' + (o.correct ? '1' : '0') + ':' + i,
        o.label.slice(0, 80),
        { style: BTN_SECONDARY })
  ))];

  const msg = await postChannelMessage(env, env.ENGAGEMENT_CHANNEL_ID, { embeds: [embed], components });
  if (msg?.id) {
    await env.DB.prepare(
      'UPDATE trivia_rounds SET message_id = ? WHERE id = ?'
    ).bind(msg.id, roundId).run();
    await env.DB.prepare(
      'UPDATE trivia_questions SET last_used = datetime(\'now\') WHERE id = ?'
    ).bind(q.id).run();
  }
}

/** Button click — validate answer, award Bolts on first-correct. */
export async function handleTriviaClick(env, data) {
  const id = data?.data?.custom_id || '';
  const [, roundIdStr, correctFlag] = id.split(':');
  const roundId = parseInt(roundIdStr, 10);
  if (!roundId) return ephemeral('Bad round id.');
  const userId = data?.member?.user?.id || data?.user?.id;

  const round = await env.DB.prepare(
    'SELECT id, closed_at, winner_id, message_id, guild_id FROM trivia_rounds WHERE id = ?'
  ).bind(roundId).first();
  if (!round) return ephemeral('Round not found.');

  if (round.closed_at) {
    return ephemeral(round.winner_id === userId
      ? '✅ You already won this round.'
      : `Too late — <@${round.winner_id}> got there first.`);
  }
  if (correctFlag !== '1') {
    return ephemeral('❌ Wrong answer.');
  }

  // Atomic claim: close the round only if it's still open.
  const upd = await env.DB.prepare(
    'UPDATE trivia_rounds SET closed_at = datetime(\'now\'), winner_id = ? WHERE id = ? AND closed_at IS NULL'
  ).bind(userId, roundId).run();

  if (!upd.meta?.changes) {
    return ephemeral('Beaten to it — someone else just answered.');
  }

  // Award Bolts via Loadout cross-bot endpoint.
  if (env.LOADOUT_BOLT_API && env.LOADOUT_BOLT_API_SECRET) {
    try {
      await fetch(env.LOADOUT_BOLT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-loadout-bolt-secret': env.LOADOUT_BOLT_API_SECRET },
        body: JSON.stringify({ user_id: userId, amount: TRIVIA_BOLTS, reason: 'trivia' }),
      });
    } catch (e) { console.error('[trivia] bolts grant failed', e?.message || e); }
  }

  // Streak + achievements.
  try { await tickStreak(env, round.guild_id, userId); } catch {}
  try { await bumpAndAnnounce(env, round.guild_id, userId, 'trivia_master'); } catch {}

  // Edit the original message to disable buttons + show winner.
  if (round.message_id && env.ENGAGEMENT_CHANNEL_ID) {
    try {
      await editChannelMessage(env, env.ENGAGEMENT_CHANNEL_ID, round.message_id, {
        embeds: [{
          color: 0x43A047,
          title: '🧠 Daily Trivia — solved',
          description: `<@${userId}> got it. +${TRIVIA_BOLTS} Bolts.\n\nNew round tomorrow at 4 PM ET.`,
          timestamp: new Date().toISOString()
        }],
        components: []
      });
    } catch (e) { console.error('[trivia] edit failed', e?.message || e); }
  }

  return ephemeral(`✅ Correct! +${TRIVIA_BOLTS} Bolts.`);
}

// ---- Hub modal: add a trivia question -------------------------------

export function triviaEditModal() {
  return modal('modal:trivia_edit', 'Add a trivia question', [
    { custom_id: 'question', label: 'Question', style: 2, required: true,  max_length: 300 },
    { custom_id: 'correct',  label: 'Correct answer',          style: 1, required: true,  max_length: 80 },
    { custom_id: 'wrong_1',  label: 'Wrong option 1',          style: 1, required: false, max_length: 80 },
    { custom_id: 'wrong_2',  label: 'Wrong option 2',          style: 1, required: false, max_length: 80 },
    { custom_id: 'wrong_3',  label: 'Wrong option 3 (optional)', style: 1, required: false, max_length: 80 },
  ]);
}

export async function handleTriviaEditSubmit(env, data) {
  const question = (getModalField(data, 'question') || '').trim();
  const correct  = (getModalField(data, 'correct')  || '').trim();
  const w1 = (getModalField(data, 'wrong_1') || '').trim() || null;
  const w2 = (getModalField(data, 'wrong_2') || '').trim() || null;
  const w3 = (getModalField(data, 'wrong_3') || '').trim() || null;
  if (!question || !correct) return ephemeral('Question and correct answer are required.');

  await env.DB.prepare(
    'INSERT INTO trivia_questions (guild_id, question, correct, wrong_1, wrong_2, wrong_3) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(data.guild_id, question, correct, w1, w2, w3).run();

  const total = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM trivia_questions WHERE guild_id = ? AND active = 1'
  ).bind(data.guild_id).first();
  return ephemeral(`📚 Added — pool now has **${total?.n || 0}** active questions.`);
}

// ---- helpers -----------------------------------------------------------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
