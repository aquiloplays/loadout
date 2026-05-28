// Daily prompt rotator. Posts a community discussion prompt to
// ENGAGEMENT_CHANNEL_ID at noon ET daily. Prompts are stored in KV
// (admin can edit via the hub modal). Cycles deterministically through
// the list so prompts don't repeat back-to-back.

import { postChannelMessage, ephemeral, modal, getModalField, COLOR_SCHEDULE } from './util.js';

const KV_LIST  = 'prompts:list';
const KV_INDEX = 'prompts:index';

const DEFAULT_PROMPTS = [
  "What's the funniest moment from this past week of streams?",
  "If you could only play ONE community-night game forever, which one?",
  "Drop a meme from your favorite stream moment lately",
  "Which game do you wish was in the rotation? Tell me with `/suggest`!",
  "Minecraft Night or Community Night — sound off",
  "What's everyone playing off-stream right now?",
  "Best snack while watching a stream?"
];

async function getPrompts(env) {
  const raw = await env.STATE.get(KV_LIST);
  if (!raw) return DEFAULT_PROMPTS.slice();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_PROMPTS.slice();
  } catch { return DEFAULT_PROMPTS.slice(); }
}

async function savePrompts(env, list) {
  await env.STATE.put(KV_LIST, JSON.stringify(list));
}

async function nextIndex(env, mod) {
  const raw = await env.STATE.get(KV_INDEX);
  const cur = raw ? parseInt(raw, 10) : 0;
  const next = (cur + 1) % mod;
  await env.STATE.put(KV_INDEX, String(next));
  return cur % mod;
}

// Cron entry: noon ET daily. Picks the next prompt, posts to the
// QotD channel. Resolution order:
//   1. env.QOTD_CHANNEL_ID  (the dedicated QotD channel, when set)
//   2. env.ENGAGEMENT_CHANNEL_ID (legacy fallback — pre-2026-05-28
//      QotD landed in #engagement alongside polls/birthdays/goals)
export async function postDailyPrompt(env) {
  const target = env.QOTD_CHANNEL_ID || env.ENGAGEMENT_CHANNEL_ID;
  if (!target) return { skipped: 'no_channel' };
  const list = await getPrompts(env);
  if (!list.length) return { skipped: 'no_prompts' };
  const idx = await nextIndex(env, list.length);
  const prompt = list[idx];

  const embed = {
    title: '💬 Question of the Day',
    description: prompt,
    color: COLOR_SCHEDULE,
    footer: { text: 'Reply in thread or this channel — no wrong answers' }
  };
  await postChannelMessage(env, target, { embeds: [embed] });
  return { posted: true, prompt, channel: target };
}

// Hub button → modal with up to 5 prompts to edit/append. Existing
// prompts beyond 5 are preserved (we splice the first 5).
export async function promptsEditModal(env) {
  const list = await getPrompts(env);
  const fields = [];
  for (let i = 0; i < 5; i++) {
    fields.push({
      custom_id: 'p' + i,
      label: 'Prompt ' + (i + 1) + (i < list.length ? '' : ' (new)'),
      style: 2,
      value: list[i] || '',
      required: i === 0,
      max_length: 400
    });
  }
  return modal('modal:prompts_edit', 'Daily prompts (first 5)', fields);
}

// Modal submit → replace the first 5 prompts with form values.
export async function handlePromptsEditSubmit(env, data) {
  const list = await getPrompts(env);
  const replacement = [];
  for (let i = 0; i < 5; i++) {
    const v = (getModalField(data, 'p' + i) || '').trim();
    if (v) replacement.push(v);
  }
  // Preserve any prompts beyond #5 in the existing list (so admin can have
  // a deeper rotation while still editing the top 5 via modal).
  const merged = replacement.concat(list.slice(5));
  await savePrompts(env, merged);
  return ephemeral('💬 Saved ' + replacement.length + ' prompt(s). Total in rotation: ' + merged.length + '.');
}
