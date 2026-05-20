// Discord pic/gif check-in. A user posts a message with an image
// attachment to CHECKIN_CHANNEL_ID = their daily check-in.
//
// Trigger: first MESSAGE_CREATE in CHECKIN_CHANNEL_ID, per ET day, per
// user, with at least one attachment whose content_type starts with
// "image/" (covers png/jpg/gif/webp). v1 does attachment-only; embedded
// Tenor/Giphy GIFs that arrive as embed links (not attachments) are
// NOT counted — the user has to actually post an image. Easy to extend
// later by also inspecting `embeds[].type === 'gifv'`.
//
// Storage: D1 `discord_checkins` table, one row per (guild, user). Same
// schema shape as `streaks`: current_days, longest_days, last_day_et,
// total_checkins. Lazy table creation -- the first handler invocation
// runs CREATE TABLE IF NOT EXISTS, KV-flagged so it's a one-time cost.
//
// Streak break protection: if `delta` > 1 day, we call the
// loadout-discord Worker's POST /streak-freeze/consume (HMAC-gated by
// LOADOUT_BOLT_API_SECRET — the same secret aquilo-bot already uses to
// credit bolts) with type='discord'. If a freeze is consumed, the
// streak is preserved as if no miss occurred.
//
// Reward: base 5 bolts per check-in + tiered streak-milestone bonuses
// (+5 at day 7, +10 at day 30, +25 at day 100). Calibrated to be
// noticeable but not abusable — a daily picture post should feel
// rewarded, not lucrative.
//
// Confirmation: ✅ reaction on the user's message. Mirrors counting.js
// (no chat spam in a busy channel).

import { discordFetch } from './util.js';
import { ensureBootstrap } from './bootstrap.js';
import { applyBolts } from './bolts.js';

const KV_TABLE_INIT = 'checkin:table_initialized:v1';
const REWARD_BASE = 5;
const STREAK_MILESTONES = [
  { day: 7,   bonus: 5 },
  { day: 30,  bonus: 10 },
  { day: 100, bonus: 25 },
];

function todayET(date = new Date()) {
  // Same shape as streak.js's todayET so the two daily-streak systems
  // agree on day boundaries (America/New_York).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000
  );
}

function hasImageAttachment(attachments) {
  if (!Array.isArray(attachments)) return false;
  for (const a of attachments) {
    const ct = String(a?.content_type || '').toLowerCase();
    if (ct.startsWith('image/')) return true;
  }
  return false;
}

async function ensureTable(env) {
  // First-call-wins idempotent CREATE. KV flag avoids the round-trip on
  // every message after the first successful invocation. We deliberately
  // don't ship this in a migration file because the table is owned by
  // this single module — co-locating the schema with its handler keeps
  // the surface obvious.
  const done = await env.STATE.get(KV_TABLE_INIT);
  if (done) return;
  if (!env.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS discord_checkins (
       guild_id        TEXT NOT NULL,
       user_id         TEXT NOT NULL,
       current_days    INTEGER NOT NULL DEFAULT 0,
       longest_days    INTEGER NOT NULL DEFAULT 0,
       last_day_et     TEXT NOT NULL,
       total_checkins  INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (guild_id, user_id)
     )`
  ).run();
  await env.STATE.put(KV_TABLE_INIT, '1');
}

async function reactToMessage(env, channelId, messageId, emoji) {
  // Same encoding as counting.js -- raw codepoint chars URL-encoded.
  return discordFetch(env,
    '/channels/' + encodeURIComponent(channelId) +
    '/messages/' + encodeURIComponent(messageId) +
    '/reactions/' + encodeURIComponent(emoji) + '/@me',
    { method: 'PUT', body: '' });
}

// Cross-Worker freeze consume. The freeze for the Discord streak is
// keyed by Discord user id in the loadout-discord Worker's KV (same
// namespace the bolts wallet lives in). Returns { consumed, remaining }
// or { consumed: false, remaining: 0 } on any error -- never throws.
async function consumeFreezeRemote(env, guildId, userId) {
  if (!env.LOADOUT_BOLT_API || !env.LOADOUT_BOLT_API_SECRET) {
    return { consumed: false, remaining: 0, reason: 'unconfigured' };
  }
  // LOADOUT_BOLT_API is configured as the full /counting/award-bolts
  // URL. Derive the freeze endpoint from the same origin so we don't
  // need a separate env var.
  let base;
  try { base = new URL(env.LOADOUT_BOLT_API).origin; }
  catch { return { consumed: false, remaining: 0, reason: 'bad_api_url' }; }
  try {
    const resp = await fetch(base + '/streak-freeze/consume', {
      method: 'POST',
      headers: {
        'content-type':     'application/json',
        'x-counting-secret': env.LOADOUT_BOLT_API_SECRET,
      },
      body: JSON.stringify({ guildId, userId, type: 'discord' }),
    });
    if (!resp.ok) {
      return { consumed: false, remaining: 0, reason: 'http_' + resp.status };
    }
    const r = await resp.json();
    return {
      consumed:  !!r.consumed,
      remaining: Number(r.remaining || 0),
    };
  } catch (e) {
    return { consumed: false, remaining: 0, reason: 'throw' };
  }
}

async function readFreezeRemote(env, guildId, userId) {
  if (!env.LOADOUT_BOLT_API || !env.LOADOUT_BOLT_API_SECRET) {
    return { stream: 0, discord: 0 };
  }
  let base;
  try { base = new URL(env.LOADOUT_BOLT_API).origin; }
  catch { return { stream: 0, discord: 0 }; }
  try {
    const u = new URL(base + '/streak-freeze/get');
    u.searchParams.set('guildId', guildId);
    u.searchParams.set('userId', userId);
    const resp = await fetch(u.toString(), {
      headers: { 'x-counting-secret': env.LOADOUT_BOLT_API_SECRET },
    });
    if (!resp.ok) return { stream: 0, discord: 0 };
    const r = await resp.json();
    return { stream: Number(r.stream || 0), discord: Number(r.discord || 0) };
  } catch { return { stream: 0, discord: 0 }; }
}

// Cross-Worker fetch of the bound check-in channel. Source of truth is
// the loadout-discord LOADOUT_BOLTS KV (where the /admin Setup & Status
// dashboard writes it via setCheckinChannel). We cache the lookup
// briefly in-memory because the same channel binding is hit on every
// MESSAGE_CREATE forwarded into this guild.
const _checkinChannelCache = { value: undefined, fetchedAt: 0 };
const CHECKIN_CHANNEL_CACHE_TTL_MS = 60_000;

async function getBoundCheckinChannel(env, guildId) {
  // Env-var fallback is honored so existing deployments that set
  // CHECKIN_CHANNEL_ID in wrangler.toml keep working. The KV binding
  // wins when set -- /admin is the new source of truth.
  const now = Date.now();
  if (_checkinChannelCache.value !== undefined &&
      (now - _checkinChannelCache.fetchedAt) < CHECKIN_CHANNEL_CACHE_TTL_MS) {
    return _checkinChannelCache.value;
  }
  let channelId = null;
  if (env.LOADOUT_BOLT_API) {
    try {
      const base = new URL(env.LOADOUT_BOLT_API).origin;
      const resp = await fetch(base + '/checkin-channel/' + encodeURIComponent(guildId));
      if (resp.ok) {
        const r = await resp.json();
        if (r && typeof r.channelId === 'string' && r.channelId) channelId = r.channelId;
      }
    } catch { /* fall through to env */ }
  }
  if (!channelId && env.CHECKIN_CHANNEL_ID) channelId = env.CHECKIN_CHANNEL_ID;
  _checkinChannelCache.value = channelId;
  _checkinChannelCache.fetchedAt = now;
  return channelId;
}

function milestoneBonus(streak) {
  // Award the highest milestone bonus whose day-target == today's
  // streak (so a user hits the bonus exactly once per milestone, not
  // every day past it).
  for (const m of STREAK_MILESTONES) {
    if (streak === m.day) return m.bonus;
  }
  return 0;
}

// ---- Message handler (called from POST /counting/message fan-out) ------
//
// Forwarded payload shape:
//   { guild_id, channel_id, message_id, user_id, username, content, bot,
//     attachments: [{ id, filename, content_type, size, url }] }
export async function handleCheckinMessage(env, payload) {
  if (!payload || payload.bot) return { skipped: 'bot_message' };

  // Resolve the bound channel first (KV via loadout-discord poll;
  // CHECKIN_CHANNEL_ID env var is the fallback). Skip cleanly if
  // nothing is bound yet -- the fan-out caller still gets a structured
  // {skipped: ...} response.
  const guildId = await ensureBootstrap(env);
  const boundChannelId = await getBoundCheckinChannel(env, guildId);
  if (!boundChannelId) return { skipped: 'channel_unconfigured' };
  if (payload.channel_id !== boundChannelId) return { skipped: 'wrong_channel' };
  if (!hasImageAttachment(payload.attachments)) return { skipped: 'no_image_attachment' };

  await ensureTable(env);
  const userId = String(payload.user_id || '');
  if (!userId) return { skipped: 'no_user_id' };

  const today = todayET();
  const row = await env.DB.prepare(
    'SELECT current_days, longest_days, last_day_et, total_checkins FROM discord_checkins WHERE guild_id = ? AND user_id = ?'
  ).bind(guildId, userId).first();

  // Idempotent within an ET day: a user posting 5 pics today still
  // only counts as 1 check-in. They get the ✅ on EACH post though so
  // they know the post was acknowledged (counting also reacts on each
  // valid count -- consistent UX).
  if (row && row.last_day_et === today) {
    try { await reactToMessage(env, payload.channel_id, payload.message_id, '✅'); }
    catch { /* idle */ }
    return { ok: true, already: true, streak: row.current_days };
  }

  let current, longest, total, freezeUsed = false;
  if (!row) {
    current = 1;
    longest = 1;
    total = 1;
  } else {
    const delta = daysBetween(row.last_day_et, today);
    if (delta === 1) {
      current = row.current_days + 1;
    } else if (delta > 1) {
      // Streak break attempted -- try a freeze first.
      const r = await consumeFreezeRemote(env, guildId, userId);
      if (r.consumed) {
        freezeUsed = true;
        current = row.current_days + 1; // protected, count today as continuous
      } else {
        current = 1; // reset
      }
    } else {
      // delta === 0 was handled above; negative deltas shouldn't happen
      // (clock skew?) -- treat as no-op increment.
      current = row.current_days || 1;
    }
    longest = Math.max(row.longest_days, current);
    total = row.total_checkins + 1;
  }

  // Persist.
  if (!row) {
    await env.DB.prepare(
      'INSERT INTO discord_checkins (guild_id, user_id, current_days, longest_days, last_day_et, total_checkins) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(guildId, userId, current, longest, today, total).run();
  } else {
    await env.DB.prepare(
      'UPDATE discord_checkins SET current_days = ?, longest_days = ?, last_day_et = ?, total_checkins = ? WHERE guild_id = ? AND user_id = ?'
    ).bind(current, longest, today, total, guildId, userId).run();
  }

  // Bolts payout: base + any streak milestone bonus this day.
  const bonus = milestoneBonus(current);
  const reward = REWARD_BASE + bonus;
  await applyBolts(env, guildId, userId, reward, 'discord-checkin:streak-' + current);

  // ✅ reaction.
  try { await reactToMessage(env, payload.channel_id, payload.message_id, '✅'); }
  catch (e) { console.warn('[checkin] react failed', e?.message || e); }

  // Milestone DM-able callout. Reaction is the silent default; we only
  // surface a chat message on milestone days or when a freeze just
  // saved the streak (those are events the user should actually see).
  if (bonus > 0 || freezeUsed) {
    let msg;
    if (freezeUsed) {
      msg = '❄ <@' + userId + '> a **Streak Freeze** saved your **' + current + '-day** Discord check-in streak! ' +
            '+' + reward + ' bolts.';
    } else {
      msg = '🎉 <@' + userId + '> hit **day ' + current + '** of your Discord check-in streak! ' +
            '+' + reward + ' bolts (base ' + REWARD_BASE + ' + milestone ' + bonus + ').';
    }
    try {
      await discordFetch(env, '/channels/' + encodeURIComponent(payload.channel_id) + '/messages', {
        method: 'POST',
        body: JSON.stringify({
          content: msg,
          // Avoid pinging the user every time -- the reaction is the
          // canonical "you're seen" signal; this is just narration.
          allowed_mentions: { parse: [] },
        }),
      });
    } catch (e) { console.warn('[checkin] milestone post failed', e?.message || e); }
  }

  return {
    ok: true,
    streak: current,
    longest,
    reward,
    freeze_used: freezeUsed,
  };
}

// Test-mode harness — called by an admin-only Worker route so we can
// poke the handler end-to-end without spamming Discord. Exposed but the
// auth lives at the route level in worker.js.
export async function pipeCheckinTestProbe(env, opts = {}) {
  // Probe: does the freeze read endpoint respond?
  const fresh = await readFreezeRemote(env, opts.guildId || 'TEST', opts.userId || 'TEST');
  return {
    channel_configured: !!env.CHECKIN_CHANNEL_ID,
    freeze_api_reachable: !!fresh,
    sample_freeze_read: fresh,
  };
}
