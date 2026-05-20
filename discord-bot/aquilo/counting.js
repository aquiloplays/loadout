// Counting game. Players type 1, 2, 3, 4... in COUNTING_CHANNEL_ID.
// Each correct count gets a small bolt reward; the reward multiplier
// scales by floor(count / 100). Any wrong number, non-number, or same
// user counting twice in a row resets the count to 0 — the offender
// gets a temporary "fail" role + a bolt deduction.
//
// Discord MESSAGE_CREATE events arrive here from aquilo-presence (the
// gateway keeper), forwarded as POST /counting/message with the shared
// COUNTING_WEBHOOK_SECRET in the x-counting-secret header.
//
// Bolts are awarded/deducted via the Loadout discord-bot worker's
// /counting/award-bolts endpoint, auth'd by LOADOUT_BOLT_API_SECRET.

import { discordFetch } from './util.js';
import { ensureBootstrap } from './bootstrap.js';
import { applyBolts } from './bolts.js';

const KV_STATE         = (gid) => 'counting:' + gid;
const KV_FAIL_EXPIRY   = 'counting:fail_expiry';

const DEFAULT_BASE_REWARD     = 1;
const DEFAULT_FAIL_PENALTY    = 10;
const DEFAULT_FAIL_DURATION   = 60;  // minutes

// ---- KV state ----------------------------------------------------------

async function loadState(env, guildId) {
  const raw = await env.STATE.get(KV_STATE(guildId));
  if (!raw) return blankState();
  try { return Object.assign(blankState(), JSON.parse(raw)); }
  catch { return blankState(); }
}

function blankState() {
  return {
    current: 0,
    last_user_id: null,
    high_score: 0,
    high_score_user_id: null,
    successes: 0,
    fails: 0,
    started_at: null,
    updated_at: null
  };
}

async function saveState(env, guildId, s) {
  s.updated_at = new Date().toISOString();
  await env.STATE.put(KV_STATE(guildId), JSON.stringify(s));
}

// ---- Discord helpers ---------------------------------------------------

async function reactToMessage(env, channelId, messageId, emoji) {
  // Discord encodes Unicode reactions URL-form (the raw codepoint chars).
  // encodeURIComponent handles the multi-byte case.
  return discordFetch(env,
    '/channels/' + encodeURIComponent(channelId) +
    '/messages/' + encodeURIComponent(messageId) +
    '/reactions/' + encodeURIComponent(emoji) + '/@me',
    { method: 'PUT', body: '' });
}

async function postChat(env, channelId, payload) {
  return discordFetch(env,
    '/channels/' + encodeURIComponent(channelId) + '/messages',
    { method: 'POST', body: JSON.stringify(payload) });
}

async function addMemberRole(env, guildId, userId, roleId) {
  return discordFetch(env,
    '/guilds/'   + encodeURIComponent(guildId) +
    '/members/'  + encodeURIComponent(userId) +
    '/roles/'    + encodeURIComponent(roleId),
    { method: 'PUT', body: '' });
}

async function removeMemberRole(env, guildId, userId, roleId) {
  return discordFetch(env,
    '/guilds/'   + encodeURIComponent(guildId) +
    '/members/'  + encodeURIComponent(userId) +
    '/roles/'    + encodeURIComponent(roleId),
    { method: 'DELETE' });
}

// ---- Fail-role expiry tracking -----------------------------------------

async function loadFailExpiry(env) {
  const raw = await env.STATE.get(KV_FAIL_EXPIRY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveFailExpiry(env, list) {
  await env.STATE.put(KV_FAIL_EXPIRY, JSON.stringify(list));
}

async function scheduleFailRoleRemoval(env, guildId, userId, roleId, durationMin) {
  const list = await loadFailExpiry(env);
  const expiresAtMs = Date.now() + durationMin * 60 * 1000;
  // De-dup: if user already has a pending expiry for this role, refresh it.
  const existing = list.findIndex(e => e.user_id === userId && e.role_id === roleId);
  if (existing >= 0) {
    list[existing].expires_at_ms = expiresAtMs;
  } else {
    list.push({ user_id: userId, role_id: roleId, guild_id: guildId, expires_at_ms: expiresAtMs });
  }
  await saveFailExpiry(env, list);
}

// Cron entry: every minute. Removes the fail role from users whose
// duration has elapsed.
export async function sweepFailRoles(env) {
  const list = await loadFailExpiry(env);
  if (!list.length) return { swept: 0 };
  const now = Date.now();
  const keep = [];
  let swept = 0;
  for (const e of list) {
    if (e.expires_at_ms > now) {
      keep.push(e);
      continue;
    }
    try { await removeMemberRole(env, e.guild_id, e.user_id, e.role_id); }
    catch (err) { /* role already removed or perms changed — ignore */ }
    swept++;
  }
  if (swept > 0) await saveFailExpiry(env, keep);
  return { swept };
}

// ---- Message handler (called from POST /counting/message) --------------

// Forwarded payload shape: { guild_id, channel_id, message_id, user_id, username, content, bot }
export async function handleCountingMessage(env, payload) {
  if (!payload || payload.bot) return { skipped: 'bot_message' };
  if (!env.COUNTING_CHANNEL_ID) return { skipped: 'channel_unconfigured' };
  if (payload.channel_id !== env.COUNTING_CHANNEL_ID) return { skipped: 'wrong_channel' };

  const guildId = await ensureBootstrap(env);
  const state = await loadState(env, guildId);

  const userId = payload.user_id;
  const content = (payload.content || '').trim();

  // Validation: content must be ONLY digits (no leading zeros except for
  // "0" itself, no commas, no whitespace, no words). Then must match the
  // expected next number. And the same user can't count twice in a row.
  const isPureDigits = /^[1-9][0-9]*$/.test(content);
  const num = isPureDigits ? parseInt(content, 10) : NaN;
  const expected = state.current + 1;
  const sameUser = state.last_user_id && state.last_user_id === userId;

  const ok = isPureDigits && num === expected && !sameUser;

  if (ok) {
    // SUCCESS: react, reward, update state.
    try { await reactToMessage(env, payload.channel_id, payload.message_id, '✅'); }
    catch (e) { console.warn('[counting] react ok failed', e?.message || e); }

    const baseReward = parseInt(env.COUNTING_BASE_REWARD || String(DEFAULT_BASE_REWARD), 10) || DEFAULT_BASE_REWARD;
    const multiplier = 1 + Math.floor(num / 100);
    const reward = baseReward * multiplier;
    await applyBolts(env, guildId, userId, reward, 'counting:' + num);

    state.current = num;
    state.last_user_id = userId;
    state.successes++;
    if (!state.started_at) state.started_at = new Date().toISOString();
    if (num > state.high_score) {
      state.high_score = num;
      state.high_score_user_id = userId;
    }

    // Celebrate every 100. Don't repeat at the same milestone.
    if (num % 100 === 0) {
      try {
        await postChat(env, payload.channel_id, {
          content: '🎉 **' + num + '!** Bolt reward is now ×' + (multiplier + (num % 100 === 0 ? 1 : 0)) + ' for the next stretch — keep it going.'
        });
      } catch {}
    }

    await saveState(env, guildId, state);
    return { ok: true, count: num, reward };
  }

  // FAIL: react, penalize, assign fail role, reset.
  try { await reactToMessage(env, payload.channel_id, payload.message_id, '❌'); }
  catch (e) { console.warn('[counting] react fail failed', e?.message || e); }

  const failPenalty = parseInt(env.COUNTING_FAIL_PENALTY || String(DEFAULT_FAIL_PENALTY), 10) || DEFAULT_FAIL_PENALTY;
  const failDuration = parseInt(env.COUNTING_FAIL_DURATION_MIN || String(DEFAULT_FAIL_DURATION), 10) || DEFAULT_FAIL_DURATION;

  // Negative amount → applyVaultDelta clamps balance at 0, so this is safe.
  await applyBolts(env, guildId, userId, -failPenalty, 'counting:fail_at:' + state.current);

  // Assign the fail role for `failDuration` minutes (if configured).
  if (env.COUNTING_FAIL_ROLE_ID) {
    try { await addMemberRole(env, guildId, userId, env.COUNTING_FAIL_ROLE_ID); }
    catch (e) { console.warn('[counting] fail role add', e?.message || e); }
    await scheduleFailRoleRemoval(env, guildId, userId, env.COUNTING_FAIL_ROLE_ID, failDuration);
  }

  // Reason for the public callout:
  let reasonText;
  if (sameUser) reasonText = "you can't count two in a row";
  else if (!isPureDigits) reasonText = 'that wasn\'t a number';
  else if (num !== expected) reasonText = 'expected **' + expected + '**';
  else reasonText = 'something went wrong';

  try {
    await postChat(env, payload.channel_id, {
      content: '💥 <@' + userId + '> broke the chain at **' + state.current + '** — ' + reasonText + '.\n' +
               '🪙 −' + failPenalty + ' bolts · ⏳ fail role for ' + failDuration + ' min · count resets to **1**.'
    });
  } catch {}

  const reachedHigh = state.current === state.high_score && state.current > 0;
  state.current = 0;
  state.last_user_id = null;
  state.fails++;
  await saveState(env, guildId, state);

  return { ok: false, reason: reasonText, reset_from: state.high_score, was_record: reachedHigh };
}
