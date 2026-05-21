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
// Confirmation: ✅ reaction on the user's message PLUS a reply embed
// summarising the streak + shield count. The embed is the primary UX --
// users see their day count, longest streak, and how many shields they
// hold every time they check in. Reaction stays as a fast ACK that
// works even if Discord nukes the embed for a slow region.
//
// At-risk reminders: a cron-driven sweep (runCheckinRemindersCron) DMs
// users whose streak day is ending. Twice-daily by default (dispatched
// at hours 18 and 22 ET from the shared aquilo cron tick). Reuses the
// `dm_optout` KV set so a single mute hides queue *and* streak DMs.

import { discordFetch, sendDm, sleep } from './util.js';
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
  // agree on day boundaries (America/New_York). Intl handles DST.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

function shiftDay(yyyymmdd, deltaDays) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const dd = new Date(ms);
  const pad = (n) => n < 10 ? '0' + n : '' + n;
  return dd.getUTCFullYear() + '-' + pad(dd.getUTCMonth() + 1) + '-' + pad(dd.getUTCDate());
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

  // ✅ reaction. Fast ACK that works even if the embed reply fails.
  try { await reactToMessage(env, payload.channel_id, payload.message_id, '✅'); }
  catch (e) { console.warn('[checkin] react failed', e?.message || e); }

  // Confirmation embed -- streak count + shield count + bolts payout,
  // every check-in. Replaces the old milestone-only chat narration.
  // Shields (a.k.a. "freezes" internally) are read from the wallet KV
  // via the cross-Worker /streak-freeze/get endpoint.
  let shieldCount = 0;
  try {
    const f = await readFreezeRemote(env, guildId, userId);
    shieldCount = Number(f.discord || 0);
  } catch { /* best-effort; embed still goes out without shield info */ }

  try {
    await discordFetch(env, '/channels/' + encodeURIComponent(payload.channel_id) + '/messages', {
      method: 'POST',
      body: JSON.stringify({
        embeds: [buildCheckinEmbed({
          streak: current,
          longest,
          shieldCount,
          reward,
          baseReward: REWARD_BASE,
          bonus,
          freezeUsed,
        })],
        message_reference: {
          message_id: payload.message_id,
          channel_id: payload.channel_id,
          fail_if_not_exists: false,
        },
        // Reply linkage gives the visual connection to the user's post
        // without pinging them again -- they're already in the channel.
        allowed_mentions: { parse: [], replied_user: false },
      }),
    });
  } catch (e) { console.warn('[checkin] embed post failed', e?.message || e); }

  return {
    ok: true,
    streak: current,
    longest,
    reward,
    shield_count: shieldCount,
    freeze_used: freezeUsed,
  };
}

// ---- Confirmation embed ------------------------------------------------

function buildCheckinEmbed({ streak, longest, shieldCount, reward, baseReward, bonus, freezeUsed }) {
  const fields = [
    {
      name:  '🔥 Current streak',
      value: streak + ' day' + (streak === 1 ? '' : 's'),
      inline: true,
    },
    {
      name:  '🏆 Best',
      value: longest + ' day' + (longest === 1 ? '' : 's'),
      inline: true,
    },
    {
      name:  '🛡️ Streak shields',
      value: shieldCount > 0
        ? shieldCount + ' available'
        : 'None — buy one in the shop to protect a missed day.',
      inline: true,
    },
  ];

  const descLines = ['**+' + reward + ' bolts**'];
  if (bonus > 0) {
    descLines.push('🎉 Milestone day! +' + bonus + ' on top of base ' + baseReward + '.');
  }
  if (freezeUsed) {
    descLines.push('❄ A **Streak Shield** was consumed to save your streak.');
  }

  // Color: cyan = shield saved, gold = milestone, blurple = standard.
  const color = freezeUsed ? 0x6FE0FF : (bonus > 0 ? 0xFFD86A : 0x3A86FF);

  return {
    title:       '✅ Day ' + streak + ' check-in logged',
    description: descLines.join('\n'),
    color,
    fields,
    footer: { text: 'Streak resets at midnight EST. Post once a day to keep it going.' },
  };
}

// ---- At-risk reminder cron --------------------------------------------
//
// Twice-daily DM sweep for users whose streak day is ending. Dispatched
// from the shared aquilo cron tick at hours 18 (6 PM ET) and 22 (10 PM
// ET). The :23 cron schedule means the actual DM goes out at xx:23 each
// of those hours, leaving ~5h45m and ~1h45m of grace before midnight.
//
// Folding into the existing tick was the right call -- the worker is
// already at the Cloudflare free-plan 4-cron ceiling, so a new trigger
// slot wasn't available. The aquilo tick fires hourly anyway; we just
// guard inside the cron function with an explicit hour check.
//
// Idempotency: per-(date, hour) KV marker holds the user_id set already
// DM'd in that window. A cron retry inside the same hour bucket no-ops
// for users it already DM'd.

const KV_REMINDER_SENT = (dateEt, hour) =>
  'checkin:reminder_sent:' + dateEt + ':' + hour;

// Hours (ET) when the reminder sweep fires. 6 PM = early warning,
// 10 PM = last call (~2h before midnight). Both fall on the :23 hourly
// cron tick so no new wrangler.toml slot needed.
export const REMINDER_HOURS_ET = [18, 22];

export async function runCheckinRemindersCron(env, etInfo) {
  if (!etInfo || !REMINDER_HOURS_ET.includes(etInfo.hour)) {
    return { skipped: 'wrong_hour' };
  }
  if (!env.DB) return { skipped: 'no_db' };
  if (!env.STATE) return { skipped: 'no_state' };

  await ensureTable(env);
  let guildId;
  try { guildId = await ensureBootstrap(env); }
  catch (e) { return { skipped: 'bootstrap_failed', error: String(e?.message || e) }; }

  const today = todayET();
  const yesterday = shiftDay(today, -1);
  const hour = etInfo.hour;

  // At-risk = active streak (current_days > 0) AND last check-in was
  // YESTERDAY (not today). Users with last_day_et < yesterday have
  // already cosmetically lost their streak (it will reset to 1 on
  // their next post unless they have shields); they aren't the target
  // of a "before midnight" reminder.
  const { results } = await env.DB.prepare(
    'SELECT user_id, current_days FROM discord_checkins WHERE guild_id = ? AND current_days > 0 AND last_day_et = ?'
  ).bind(guildId, yesterday).all();
  const atRisk = results || [];
  if (!atRisk.length) return { ok: true, dispatched: 0, total: 0 };

  // Per-window dedupe so cron retries inside the same hour bucket
  // don't double-DM. TTL 2 days -- plenty of time for the next window
  // to run, then GC.
  const key = KV_REMINDER_SENT(today, hour);
  const sentRaw = await env.STATE.get(key);
  let sent;
  try { sent = new Set(sentRaw ? JSON.parse(sentRaw) : []); }
  catch { sent = new Set(); }

  // Shared opt-out -- one toggle for all bot DMs (queue + streak).
  const optOutRaw = await env.STATE.get('dm_optout');
  let optOut;
  try { optOut = new Set(optOutRaw ? JSON.parse(optOutRaw) : []); }
  catch { optOut = new Set(); }

  // Deep-link button to the check-in channel so users can act in one
  // tap. Falls back to text-only if no channel is bound (admin hasn't
  // run setup yet).
  const boundChannelId = await getBoundCheckinChannel(env, guildId);
  const channelUrl = boundChannelId
    ? 'https://discord.com/channels/' + guildId + '/' + boundChannelId
    : null;

  let dispatched = 0;
  for (const row of atRisk) {
    const uid = String(row.user_id || '');
    if (!uid) continue;
    if (sent.has(uid) || optOut.has(uid)) continue;

    // Per-user shield read so the copy can be tuned ("you're protected
    // anyway" vs "no safety net").
    let shieldCount = 0;
    try {
      const f = await readFreezeRemote(env, guildId, uid);
      shieldCount = Number(f.discord || 0);
    } catch { /* idle */ }

    const streak = Number(row.current_days || 0);
    const isLastCall = (hour === REMINDER_HOURS_ET[REMINDER_HOURS_ET.length - 1]);
    const header = isLastCall
      ? '⏰ **Last call** — your **' + streak + '-day** check-in streak ends at midnight EST.'
      : '⏰ Your **' + streak + '-day** check-in streak is at risk!';
    const lines = [
      header,
      'Post an image in the check-in channel before **midnight EST** to keep it alive.',
    ];
    if (shieldCount > 0) {
      lines.push('');
      lines.push('🛡️ You have **' + shieldCount + '** Streak Shield' +
                 (shieldCount === 1 ? '' : 's') +
                 ' — your streak survives if you miss tonight, but a quick post is safer.');
    }
    const content = lines.join('\n');

    const buttons = [];
    if (channelUrl) {
      buttons.push({ type: 2, style: 5, label: 'Open check-in channel', url: channelUrl, emoji: { name: '📸' } });
    }
    buttons.push({ type: 2, style: 2, label: 'Mute these DMs', custom_id: 'notify:optout', emoji: { name: '🔕' } });
    const components = [{ type: 1, components: buttons }];

    try {
      await sendDm(env, uid, { content, components });
      sent.add(uid);
      dispatched++;
    } catch (e) {
      // 50007 = "Cannot send messages to this user" (DMs off / not in a
      // mutual guild). Log + skip; the streak DM is best-effort.
      console.warn('[checkin-reminder] DM ' + uid + ' failed: ' + (e?.message || e));
    }
    // Stay under Discord's per-bot DM rate. Matches notify.js pacing.
    await sleep(250);
  }

  await env.STATE.put(key, JSON.stringify([...sent]), { expirationTtl: 86400 * 2 });
  return { ok: true, dispatched, total: atRisk.length, hour, date: today };
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
