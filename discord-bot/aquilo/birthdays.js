// Birthday tracker. `/birthday set MM-DD` saves a date (no year — privacy);
// daily cron at 10 AM ET posts a callout in #engagement and drops 100
// Bolts for everyone whose birthday is today.
//
// Public API:
//   handleBirthdayCommand(data, env)   -> /birthday set | clear | show
//   runBirthdayCron(env)               -> cron: post today's birthdays

import {
  ephemeral, chat, flattenOptions, getSubcommand, FLAG_EPHEMERAL,
  postChannelMessage, getETInfo, COLOR_SCHEDULE
} from './util.js';
import { bumpAndAnnounce } from './achievements.js';

const BDAY_BONUS_BOLTS = 100;

export async function handleBirthdayCommand(data, env) {
  const sub = getSubcommand(data);
  const userId = data?.member?.user?.id || data?.user?.id;
  if (!env?.DB) return ephemeral('Database not configured.');
  if (!data.guild_id || !userId) return ephemeral('Run this in a server.');

  if (sub.name === 'set') {
    const raw = String(sub.options.date || '').trim();
    const m = raw.match(/^(\d{1,2})[-\/](\d{1,2})$/);
    if (!m) return ephemeral('Format: `MM-DD` (e.g. `03-14`). Year is intentionally not stored.');
    const month = parseInt(m[1], 10);
    const day   = parseInt(m[2], 10);
    if (!isValidMD(month, day)) return ephemeral('That doesn\'t look like a real date.');
    const md = pad(month) + '-' + pad(day);
    await env.DB.prepare(
      `INSERT INTO birthdays (guild_id, user_id, month_day)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET month_day = excluded.month_day`
    ).bind(data.guild_id, userId, md).run();

    // First-set achievement.
    try { await bumpAndAnnounce(env, data.guild_id, userId, 'birthday_bash'); } catch {}

    return ephemeral(`🎂 Set! I'll wish you happy birthday on **${formatMD(md)}**. Use \`/birthday clear\` to remove.`);
  }

  if (sub.name === 'clear') {
    await env.DB.prepare(
      'DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?'
    ).bind(data.guild_id, userId).run();
    return ephemeral('🗑️ Birthday cleared.');
  }

  if (sub.name === 'show') {
    const target = sub.options.user || userId;
    const row = await env.DB.prepare(
      'SELECT month_day FROM birthdays WHERE guild_id = ? AND user_id = ?'
    ).bind(data.guild_id, target).first();
    if (!row) return ephemeral(target === userId ? 'You haven\'t set a birthday yet — `/birthday set MM-DD`.' : '_That user hasn\'t set a birthday._');
    return ephemeral(`🎂 ${target === userId ? 'You' : `<@${target}>`} → **${formatMD(row.month_day)}**`);
  }

  return ephemeral('Unknown birthday subcommand.');
}

/** Cron: 10 AM ET. Post a callout for everyone whose birthday is today. */
export async function runBirthdayCron(env) {
  if (!env?.DB || !env.ENGAGEMENT_CHANNEL_ID) return;

  const { month, day } = getETInfo();
  const md = pad(month) + '-' + pad(day);

  const { results } = await env.DB.prepare(
    'SELECT user_id FROM birthdays WHERE month_day = ?'
  ).bind(md).all();
  if (!results || results.length === 0) return;

  // Build a single message that pings everyone — Discord caps at 100 users.
  const mentions = results.slice(0, 50).map(r => `<@${r.user_id}>`).join(' ');
  const lines = [
    `🎂 **It's a storm-day!**`,
    '',
    `Today's birthdays: ${mentions}`,
    '',
    `Everyone celebrated gets **${BDAY_BONUS_BOLTS} Bolts** on the house — check your wallet with \`/loadout\`.`,
  ];

  try {
    await postChannelMessage(env, env.ENGAGEMENT_CHANNEL_ID, {
      content: lines.join('\n'),
      allowed_mentions: { users: results.map(r => r.user_id) }
    });
  } catch (e) {
    console.error('[birthdays] post failed', e?.message || e);
    return;
  }

  // Credit Bolts via Loadout's cross-bot endpoint.
  if (env.LOADOUT_BOLT_API && env.LOADOUT_BOLT_API_SECRET) {
    for (const r of results) {
      try {
        await fetch(env.LOADOUT_BOLT_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-loadout-bolt-secret': env.LOADOUT_BOLT_API_SECRET,
          },
          body: JSON.stringify({
            user_id: r.user_id,
            amount: BDAY_BONUS_BOLTS,
            reason: 'birthday',
          }),
        });
      } catch (e) {
        console.error('[birthdays] bolts grant failed for', r.user_id, e?.message || e);
      }
    }
  }
}

// ---- helpers -----------------------------------------------------------

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function isValidMD(m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= max;
}

function formatMD(md) {
  const [m, d] = md.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}`;
}
