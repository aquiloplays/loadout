// Counting game. Players type 1, 2, 3, 4... in COUNTING_CHANNEL_ID.
// Each correct count gets a small bolt reward; the reward multiplier
// scales by floor(count / 100). Any wrong number, non-number, or same
// user counting twice in a row resets the count to 0, the offender
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

const KV_STATE          = (gid) => 'counting:' + gid;
const KV_FAIL_EXPIRY    = 'counting:fail_expiry';
// L8, not-a-number 2-strikes + 1h channel timeout.
const KV_NAN_STRIKES    = (gid, uid) => 'counting:nan_strikes:' + gid + ':' + uid;
const KV_CHAN_TIMEOUT   = 'counting:channel_timeouts';   // [{ guild_id, channel_id, user_id, expires_at_ms }]
const NAN_STRIKES_TTL_S = 24 * 60 * 60;   // strikes decay after 24h of no offences
const CHAN_TIMEOUT_MIN  = 60;

const DEFAULT_BASE_REWARD     = 1;
const DEFAULT_FAIL_PENALTY    = 10;
// 24 h default per Clay 2026-05-27, the embarrassment IS the
// punishment; long enough that the shame role visibly persists on
// their profile even if they don't visit Discord that day, short
// enough not to feel permanent.
const DEFAULT_FAIL_DURATION   = 24 * 60;  // 1440 minutes / 24 h

// Per-guild config overrides. KV-backed so admin can rotate
// without redeploying wrangler.toml. Env var stays as a
// deploy-time fallback, the constants above as the final default.
const KV_GUILD_FAIL_ROLE_ID    = (g) => `counting:fail_role_id:${g}`;
const KV_GUILD_FAIL_DURATION   = (g) => `counting:fail_duration_min:${g}`;

// L9, wrong-number per-user warning (Clay 2026-05-28).
// First wrong WHOLE number from a user in a 24h window → soft
// public callout + warning counter; chain stays intact, other users
// keep counting. Second wrong within the window → full fail (shame
// role + chain reset). A successful count from the warned user
// clears the strike.
const KV_WARNING_KEY    = (g, u) => `counting-warning:${g}:${u}`;
const WARNING_TTL_S     = 24 * 60 * 60;   // 24h sliding window

async function getFailRoleId(env, guildId) {
  const kv = await env.STATE.get(KV_GUILD_FAIL_ROLE_ID(guildId));
  if (kv) return kv;
  return env.COUNTING_FAIL_ROLE_ID || '';
}

async function getFailDurationMin(env, guildId) {
  const kv = await env.STATE.get(KV_GUILD_FAIL_DURATION(guildId));
  if (kv && Number.isFinite(parseInt(kv, 10))) return parseInt(kv, 10);
  return parseInt(env.COUNTING_FAIL_DURATION_MIN || String(DEFAULT_FAIL_DURATION), 10)
         || DEFAULT_FAIL_DURATION;
}

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

// Cron entry: every hour. Removes the fail role from users whose
// duration has elapsed.
//
// Failure handling (Clay 2026-05-28 fix): the prior loop blindly
// dropped entries on ANY removeMemberRole error, so a single
// transient blip (403 perms while the bot hierarchy was wrong, or a
// rate-limit) silently amnesiac'd the expiry and the role stuck
// forever. Now we distinguish:
//   • 404 (user/role/guild gone)        → drop, nothing to retry
//   • removeMemberRole returns success → drop, role removed cleanly
//   • Anything else (403, 429, 5xx)    → KEEP entry, retry next sweep
// Each entry gains a `retries` counter so we don't loop forever on a
// permanent permission misconfig; after 24 retries (~1 day at the
// hourly cadence) we give up + log, so the KV doesn't grow unbounded.
const MAX_SWEEP_RETRIES = 24;

function isDiscord404(err) {
  return String(err?.message || '').includes('Discord 404');
}

export async function sweepFailRoles(env) {
  const list = await loadFailExpiry(env);
  if (!list.length) return { swept: 0, retried: 0, abandoned: 0 };
  const now = Date.now();
  const keep = [];
  let swept = 0, retried = 0, abandoned = 0;
  for (const e of list) {
    if (e.expires_at_ms > now) {
      keep.push(e);
      continue;
    }
    let success = false;
    let err = null;
    try { await removeMemberRole(env, e.guild_id, e.user_id, e.role_id); success = true; }
    catch (caught) { err = caught; }
    if (success || isDiscord404(err)) {
      swept++;
      continue;   // drop from keep, role removed or already gone
    }
    // Retryable failure (403/429/5xx/network). Keep with a retry
    // counter so we don't lose track.
    const tries = (e.retries || 0) + 1;
    if (tries >= MAX_SWEEP_RETRIES) {
      console.warn('[counting] sweep abandoning entry after',
        tries, 'retries:', e.user_id, '@', e.guild_id,
        'last-err:', err?.message || err);
      abandoned++;
      continue;   // drop from keep, permanent failure, no infinite loop
    }
    console.warn('[counting] sweep retrying entry:',
      e.user_id, '@', e.guild_id, 'try', tries, '/', MAX_SWEEP_RETRIES,
      'err:', err?.message || err);
    keep.push({ ...e, retries: tries });
    retried++;
  }
  if (swept > 0 || retried > 0 || abandoned > 0) {
    await saveFailExpiry(env, keep);
  }
  return { swept, retried, abandoned };
}

// Admin-side: scan the guild for members currently holding the
// shame role + remove it. One-shot cleanup for users whose expiry
// was lost by the prior silent-drop sweep bug. Honors the bot's
// existing role hierarchy, if the bot can't remove the role, the
// failure is surfaced in the response so the operator knows the
// hierarchy needs fixing first.
//
// Returns: { ok, roleId, scanned, removed, failed: [{ userId, error }] }
export async function clearStuckShameRoles(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId) return { ok: false, error: 'no-guild-id' };
  const roleId = await getFailRoleId(env, guildId);
  if (!roleId) return { ok: false, error: 'no-role-configured' };

  let scanned = 0;
  let removed = 0;
  const failed = [];
  let after = '0';
  // Paginate /guilds/:g/members?limit=1000&after=:lastId. Discord
  // returns up to 1000 per page; we cap the total scan at 50k so
  // a misconfigured loop can't spin forever.
  for (let page = 0; page < 50; page++) {
    let batch;
    try {
      batch = await discordFetch(env,
        `/guilds/${encodeURIComponent(guildId)}/members?limit=1000&after=${encodeURIComponent(after)}`);
    } catch (e) {
      return { ok: false, error: 'fetch-members-failed', detail: e?.message || String(e), scanned, removed, failed };
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    scanned += batch.length;
    for (const m of batch) {
      if (!Array.isArray(m.roles) || !m.roles.includes(roleId)) continue;
      const uid = m.user?.id;
      if (!uid) continue;
      try {
        await removeMemberRole(env, guildId, uid, roleId);
        removed++;
      } catch (e) {
        // Don't abort on per-user failure, surface in `failed` so
        // the operator can spot a hierarchy or rate-limit issue.
        failed.push({ userId: uid, error: e?.message || String(e) });
      }
    }
    after = batch[batch.length - 1].user?.id || after;
    if (batch.length < 1000) break;
  }
  return { ok: true, roleId, scanned, removed, failed };
}

// ---- L8: not-a-number, 1st warn, 2nd → 1h channel SEND-deny -----------

async function loadChannelTimeouts(env) {
  const raw = await env.STATE.get(KV_CHAN_TIMEOUT);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
async function saveChannelTimeouts(env, list) {
  await env.STATE.put(KV_CHAN_TIMEOUT, JSON.stringify(list));
}

// Apply a per-user channel-level SEND_MESSAGES deny on the counting
// channel. Discord member-channel overwrites work the same as role
// overwrites, pass type=1 for member. The lift happens via
// sweepCountingChannelTimeouts on the existing 1-minute cron.
async function applyChannelTimeout(env, guildId, channelId, userId, durationMin) {
  const VIEW = 0x400, SEND = 0x800, HISTORY = 0x10000;
  const allow = String(VIEW | HISTORY);   // can still READ the channel
  const deny  = String(SEND);
  try {
    await discordFetch(env,
      '/channels/' + encodeURIComponent(channelId) +
      '/permissions/' + encodeURIComponent(userId),
      { method: 'PUT', body: JSON.stringify({ type: 1, allow, deny }) });
  } catch (e) { console.warn('[counting] timeout-apply failed', e?.message || e); }
  const list = await loadChannelTimeouts(env);
  const expiresAtMs = Date.now() + durationMin * 60 * 1000;
  const i = list.findIndex(x => x.user_id === userId && x.channel_id === channelId);
  if (i >= 0) list[i].expires_at_ms = expiresAtMs;
  else list.push({ guild_id: guildId, channel_id: channelId, user_id: userId, expires_at_ms: expiresAtMs });
  await saveChannelTimeouts(env, list);
}

// Cron entry: sweeps expired channel-timeout overwrites.
export async function sweepCountingChannelTimeouts(env) {
  const list = await loadChannelTimeouts(env);
  if (!list.length) return { swept: 0 };
  const now = Date.now();
  const keep = [];
  let swept = 0;
  for (const t of list) {
    if (t.expires_at_ms > now) { keep.push(t); continue; }
    try {
      await discordFetch(env,
        '/channels/' + encodeURIComponent(t.channel_id) +
        '/permissions/' + encodeURIComponent(t.user_id),
        { method: 'DELETE' });
    } catch (e) { console.warn('[counting] timeout-lift failed', e?.message || e); }
    swept++;
  }
  if (swept > 0) await saveChannelTimeouts(env, keep);
  return { swept };
}

async function handleNotANumberOffense(env, guildId, payload, userId, content) {
  // React ⚠️ on the offending message (and delete it after a moment so
  // it doesn't pollute the counting flow).
  try { await reactToMessage(env, payload.channel_id, _msgIdOf(payload), '⚠️'); }
  catch (e) { console.warn('[counting] react warn failed', e?.message || e); }
  try {
    await discordFetch(env,
      '/channels/' + encodeURIComponent(payload.channel_id) +
      '/messages/' + encodeURIComponent(_msgIdOf(payload)),
      { method: 'DELETE' });
  } catch { /* not authorized to delete the message, leave it */ }

  // Increment per-user strike count with a 24h TTL refresh so a single
  // accidental typo months apart doesn't escalate.
  const key = KV_NAN_STRIKES(guildId, userId);
  const prevRaw = await env.STATE.get(key);
  const prev = parseInt(prevRaw || '0', 10) || 0;
  const strikes = prev + 1;
  await env.STATE.put(key, String(strikes), { expirationTtl: NAN_STRIKES_TTL_S });

  if (strikes === 1) {
    // First offense: warn + bail.
    try {
      await postChat(env, payload.channel_id, {
        content: '⚠️ <@' + userId + '>, counting channel is **whole numbers only**. ' +
                 'No decimals, no text, no symbols. Next non-number gets you a 1-hour timeout.'
      });
    } catch {}
    return { offense: 'not-a-number', strikes, action: 'warned', content };
  }

  // 2nd+ offense: apply channel timeout, post a louder callout, reset strikes.
  await applyChannelTimeout(env, guildId, payload.channel_id, userId, CHAN_TIMEOUT_MIN);
  await env.STATE.delete(key);
  try {
    await postChat(env, payload.channel_id, {
      content: '🔇 <@' + userId + '>, second non-number offence. **Timed out from this channel for ' +
               CHAN_TIMEOUT_MIN + ' minutes.** Read-only until then.'
    });
  } catch {}
  return { offense: 'not-a-number', strikes, action: 'channel-timeout', timeoutMin: CHAN_TIMEOUT_MIN, content };
}

// ---- Shame-role provisioning (admin) -----------------------------------
//
// Creates (or reuses) the "I CAN'T COUNT" role, optionally applies a
// SEND_MESSAGES deny on the counting channel for that role, and
// stamps the role ID into KV so the fail-handler grabs it. Idempotent
//, re-running matches by exact role name and reuses the existing ID.

export async function provisionShameRole(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const name             = String(opts.name || "I CAN'T COUNT");
  const color            = Number.isFinite(opts.color) ? opts.color : 0xff6ab5;   // aurora pink
  const applyChannelDeny = opts.applyChannelDeny !== false;   // default ON

  // Reuse-or-create.
  let roleId = null;
  try {
    const list = await discordFetch(env,
      `/guilds/${encodeURIComponent(guildId)}/roles`);
    if (Array.isArray(list)) {
      const found = list.find(r => String(r?.name || '').toLowerCase() === name.toLowerCase());
      if (found?.id) roleId = String(found.id);
    }
  } catch (e) { console.warn('[counting] role list failed', e?.message || e); }

  let created = false;
  if (!roleId) {
    try {
      const r = await discordFetch(env,
        `/guilds/${encodeURIComponent(guildId)}/roles`,
        { method: 'POST',
          body: JSON.stringify({
            name,
            color,
            hoist: true,            // shows in own group → visibly shamed
            mentionable: false,
            permissions: '0',       // no extra perms, cosmetic only
          }) });
      if (r?.id) {
        roleId = String(r.id);
        created = true;
      }
    } catch (e) {
      return { ok: false, error: 'role-create-failed', detail: e?.message || String(e) };
    }
  }
  if (!roleId) return { ok: false, error: 'role-id-unresolved' };

  // Optional: deny SEND_MESSAGES on the counting channel for this
  // role. Embarrassment + a soft channel mute pair well; ADD_REACTIONS
  // stays allowed so the offender can still react with 🤡 etc.
  const countingChannelId = env.COUNTING_CHANNEL_ID;
  let channelDenyApplied = false;
  if (applyChannelDeny && countingChannelId) {
    const VIEW = 0x400, SEND = 0x800, HISTORY = 0x10000, ADD_REACT = 0x40;
    try {
      await discordFetch(env,
        `/channels/${encodeURIComponent(countingChannelId)}/permissions/${encodeURIComponent(roleId)}`,
        { method: 'PUT',
          body: JSON.stringify({
            type: 0,                                     // role overwrite
            allow: String(VIEW | HISTORY | ADD_REACT),   // can read + react
            deny:  String(SEND),                         // cannot send messages
          }) });
      channelDenyApplied = true;
    } catch (e) {
      console.warn('[counting] channel deny failed', e?.message || e);
    }
  }

  await env.STATE.put(KV_GUILD_FAIL_ROLE_ID(guildId), roleId);

  return {
    ok: true,
    roleId,
    name,
    color,
    created,
    reused: !created,
    channelDenyApplied,
    countingChannelId: countingChannelId || null,
    note: 'Role created at bottom of hierarchy by default. Bot role must sit ABOVE this role for grant/revoke to work, drag in Server Settings → Roles if needed.',
  };
}

// ---- Message handler (called from POST /counting/message) --------------

// Forwarded payload shape (from aquilo-gateway shim, see
// aquilo-gateway/aquilo_gateway.py on_message). Bot-author flag lives
// at payload.author.bot (Discord-slim) AND payload.isBot (camelCase
// mirror); user id lives at payload.author.id (Discord-slim) AND
// payload.userId (camelCase mirror). The legacy `payload.bot` /
// `payload.user_id` top-level fields are NOT in the forwarded shape
//, checking those silently let bot messages through and the bot's
// own ✓/❌ replies looped the handler back into itself. Check every
// known field name we might receive so the guard is robust to shim
// payload shape drift.
export async function handleCountingMessage(env, payload) {
  if (!payload) return { skipped: 'bot_message' };
  const { isBotPayload, messageIdOf: _msgIdOf } = await import('../bot-guard.js');
  if (isBotPayload(payload)) return { skipped: 'bot_message' };
  // Shim's MESSAGE_CREATE uses payload.id / payload.messageId; alias
  // _msgIdOf locally so the replace-all rewrite below stays a single
  // identifier without exploding the diff.
  void _msgIdOf;
  if (!env.COUNTING_CHANNEL_ID) return { skipped: 'channel_unconfigured' };
  if (payload.channel_id !== env.COUNTING_CHANNEL_ID) return { skipped: 'wrong_channel' };

  const guildId = await ensureBootstrap(env);
  const state = await loadState(env, guildId);

  const userId = payload.user_id || payload.userId || payload.author?.id;
  const content = (payload.content || '').trim();

  // ── L8 split: distinguish "not a whole number" (warn/timeout, no
  //   chain break) from "wrong whole number" (chain break + penalty).
  //   • !isWholeNumber → just-not-a-number; warn 1st, timeout 2nd
  //   • isWholeNumber + (wrong value || same user) → real chain break
  const isWholeNumber = /^[0-9]+$/.test(content) && !/^0[0-9]+/.test(content);
  const num = isWholeNumber ? parseInt(content, 10) : NaN;
  const expected = state.current + 1;
  const sameUser = state.last_user_id && state.last_user_id === userId;

  // ── Not-a-number branch ──────────────────────────────────────────
  if (!isWholeNumber) {
    return handleNotANumberOffense(env, guildId, payload, userId, content);
  }

  const ok = num === expected && !sameUser;

  if (ok) {
    // SUCCESS: react, reward, update state.
    try { await reactToMessage(env, payload.channel_id, _msgIdOf(payload), '✅'); }
    catch (e) { console.warn('[counting] react ok failed', e?.message || e); }

    // v2 economy rebalance (2026-05): drip semantic instead of
    // per-count. Old: 1 bolt per count × floor(num/100)+1 multiplier
    //, so 100 counts could mint 100+ bolts. New: 1 bolt at every
    // multiple of 5, +1 extra at multiples of 25, +5 extra at
    // multiples of 100 (the 100-celebrate milestone). A 100-count
    // run now mints ~30 bolts instead of ~150. The reward variable
    // is reported in the response, so 0 is a valid "right number,
    // no drip" outcome the UI still shows.
    let reward = 0;
    if (num % 5 === 0)   reward += 1;
    if (num % 25 === 0)  reward += 1;
    if (num % 100 === 0) reward += 5;
    if (reward > 0) await applyBolts(env, guildId, userId, reward, 'counting:' + num);

    state.current = num;
    state.last_user_id = userId;
    state.successes++;
    if (!state.started_at) state.started_at = new Date().toISOString();
    if (num > state.high_score) {
      state.high_score = num;
      state.high_score_user_id = userId;
    }

    // Clear any pending warning strike for this user, getting back
    // on track means they don't carry yesterday's "one strike" into
    // tomorrow's miscount.
    try { await env.STATE.delete(KV_WARNING_KEY(guildId, userId)); } catch { /* ignore */ }

    // Celebrate every 100. Don't repeat at the same milestone.
    if (num % 100 === 0) {
      try {
        await postChat(env, payload.channel_id, {
          content: '🎉 **' + num + '!** +' + reward + ' bolts, keep the chain going.'
        });
      } catch {}
    }

    await saveState(env, guildId, state);
    return { ok: true, count: num, reward };
  }

  // ── Per-user warning gate (Clay 2026-05-28) ──────────────────────
  // First wrong WHOLE number in a 24h window → soft callout, chain
  // stays at state.current, NO role + NO bolt penalty. Other users
  // can keep counting from where it was. The warned user's strike
  // is tracked in KV with a 24h TTL; second wrong within the window
  // falls through to the full fail flow below.
  const warnKey = KV_WARNING_KEY(guildId, userId);
  let prevWarn = 0;
  try { prevWarn = parseInt((await env.STATE.get(warnKey)) || '0', 10) || 0; }
  catch { /* tolerate KV read failure, fall through to full fail */ }
  if (prevWarn === 0) {
    // ⚠️ react on the offending message + a single short channel
    // callout. We do NOT delete the message, leaving it in chat
    // makes it obvious what was wrong so the next correct counter
    // can see the intended target. Reset to 24h sliding window.
    try { await env.STATE.put(warnKey, '1', { expirationTtl: WARNING_TTL_S }); }
    catch (e) { console.warn('[counting] warn KV put', e?.message || e); }
    try { await reactToMessage(env, payload.channel_id, _msgIdOf(payload), '⚠️'); }
    catch (e) { console.warn('[counting] react warn', e?.message || e); }
    const warnReason = sameUser
      ? "two in a row from you, let someone else take the next one"
      : `that's not the next number (expected **${expected}**), one more strike in 24h and the count resets`;
    try {
      await postChat(env, payload.channel_id, {
        content: `⚠ <@${userId}>, ${warnReason}.`,
      });
    } catch { /* ignore, channel locked? */ }
    return { ok: false, warned: true, expected, actual: num, reason: 'first-strike' };
  }
  // 2nd strike within the window → clear counter (they're about to
  // be punished by the full flow; restart fresh after) and fall
  // through to the existing chain-break path.
  try { await env.STATE.delete(warnKey); } catch { /* ignore */ }

  // FAIL: react, penalize, assign fail role, reset.
  try { await reactToMessage(env, payload.channel_id, _msgIdOf(payload), '❌'); }
  catch (e) { console.warn('[counting] react fail failed', e?.message || e); }

  const failPenalty = parseInt(env.COUNTING_FAIL_PENALTY || String(DEFAULT_FAIL_PENALTY), 10) || DEFAULT_FAIL_PENALTY;
  const failDuration = await getFailDurationMin(env, guildId);
  const failRoleId   = await getFailRoleId(env, guildId);

  // Negative amount → applyVaultDelta clamps balance at 0, so this is safe.
  await applyBolts(env, guildId, userId, -failPenalty, 'counting:fail_at:' + state.current);

  // Assign the fail role (e.g. "I CAN'T COUNT") for failDuration
  // minutes. addMemberRole is idempotent (Discord PUT) and
  // scheduleFailRoleRemoval refreshes the expiry on repeat fails
  // rather than double-stamping.
  if (failRoleId) {
    try { await addMemberRole(env, guildId, userId, failRoleId); }
    catch (e) { console.warn('[counting] fail role add', e?.message || e); }
    await scheduleFailRoleRemoval(env, guildId, userId, failRoleId, failDuration);
  }

  // Reason for the public callout (chain-break only, not-a-number
  // cases are handled separately above and don't break the chain).
  let reasonText;
  if (sameUser) reasonText = "you can't count two in a row";
  else if (num !== expected) reasonText = 'expected **' + expected + '**';
  else reasonText = 'something went wrong';

  // Format duration as h/min for the public callout so a 24h default
  // doesn't read as "1440 min".
  const durationLabel = failDuration >= 60
    ? `${Math.round(failDuration / 60)}h`
    : `${failDuration} min`;
  try {
    await postChat(env, payload.channel_id, {
      content: '💥 <@' + userId + '> broke the chain at **' + state.current + '**, ' + reasonText + '.\n' +
               '🪙 −' + failPenalty + ' bolts · ⏳ ' +
               (failRoleId ? `**I CAN'T COUNT** role for ${durationLabel}` : `fail cooldown ${durationLabel}`) +
               ' · count resets to **1**.'
    });
  } catch {}

  const reachedHigh = state.current === state.high_score && state.current > 0;
  state.current = 0;
  state.last_user_id = null;
  state.fails++;
  await saveState(env, guildId, state);

  return { ok: false, reason: reasonText, reset_from: state.high_score, was_record: reachedHigh };
}
