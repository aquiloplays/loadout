// /passport, unified cross-product profile card. Shows everything
// Aquilo Bot knows about the caller (or a mentioned user) on one embed:
// streak · achievements · birthday · trivia wins · suggestions · songs
// queued · counting peak · last seen.
//
// Data that lives in OTHER bots (Loadout Bolts, MC playtime, SF tier) is
// surfaced as deep-link buttons rather than fetched cross-bot, keeps the
// command snappy and avoids a tangle of bot-to-bot HTTP.
//
// Public API:
//   handlePassportCommand(data, env) -> interaction response
//   buildPassportEmbed(env, guildId, userId)   -> embed object
//
// The hub also wires a "🪪 Passport" button that opens an ephemeral card
// for the clicker (see hub.js).

import {
  ephemeral, chat, flattenOptions, FLAG_EPHEMERAL,
  btn, linkBtn, row, BTN_PRIMARY, BTN_SECONDARY, BTN_LINK,
  COLOR_SCHEDULE
} from './util.js';
import { getStreak } from './streak.js';
import { listAllForUser, CATALOG } from './achievements.js';

const PASSPORT_COLOR = 0x4DD0E1;   // patron sky

/**
 * Discord slash command dispatch. Optional `user` arg lets you view
 * someone else's passport (still ephemeral to the caller).
 */
export async function handlePassportCommand(data, env) {
  const opts = flattenOptions(data?.data?.options);
  const callerId = data?.member?.user?.id || data?.user?.id;
  const targetId = opts.user || callerId;
  if (!targetId) return ephemeral('Could not resolve user.');

  const embed = await buildPassportEmbed(env, data.guild_id, targetId);
  const components = passportComponents(targetId);
  return chat({ embeds: [embed], components, flags: FLAG_EPHEMERAL });
}

/** Build the embed payload, usable from /passport, hub button, welcome ritual. */
export async function buildPassportEmbed(env, guildId, userId) {
  const streak = await getStreak(env, guildId, userId);
  const allAch = await listAllForUser(env, guildId, userId);
  const earned = allAch.filter(a => a.earned_at);

  // Other per-user stats, best-effort lookups, all wrapped in try/catch
  // so a missing table or null env doesn't blow up the whole card.
  const stats = await collectStats(env, guildId, userId);
  const bday  = await fetchBirthday(env, guildId, userId);
  const joined = await fetchJoined(env, guildId, userId);

  const lines = [];
  lines.push(`<@${userId}>`);
  lines.push('');

  // Streak block, biggest visual.
  if (streak) {
    const streakIcon = streak.current_days >= 100 ? '🌪️'
                    : streak.current_days >= 30  ? '🌬️'
                    : streak.current_days >= 7   ? '⚡'
                    : '✨';
    lines.push(`${streakIcon} **Streak:** ${streak.current_days} day${streak.current_days === 1 ? '' : 's'} · longest ${streak.longest_days}`);
  } else {
    lines.push('✨ **Streak:** none yet, chat, count, or use the viewer hub today to start one.');
  }

  // Activity stats inline.
  const activityBits = [];
  if (stats.votes != null)         activityBits.push(`🗳️ ${stats.votes} votes`);
  if (stats.songs != null)         activityBits.push(`🎵 ${stats.songs} songs`);
  if (stats.suggestions != null)   activityBits.push(`💡 ${stats.suggestions} suggestions`);
  if (stats.encounters != null)    activityBits.push(`🎲 ${stats.encounters} encounters`);
  if (stats.trivia_wins != null)   activityBits.push(`🧠 ${stats.trivia_wins} trivia wins`);
  if (stats.clips != null)         activityBits.push(`🎬 ${stats.clips} clips`);
  if (activityBits.length) {
    lines.push('');
    lines.push('**Activity** · ' + activityBits.join(' · '));
  }

  // Achievement row.
  lines.push('');
  if (earned.length === 0) {
    lines.push(`🏆 **Achievements:** none earned yet, ${CATALOG.length} available.`);
  } else {
    const icons = earned.slice(0, 12).map(e => {
      const cat = CATALOG.find(c => c.key === e.key);
      return cat ? cat.icon : '·';
    }).join(' ');
    lines.push(`🏆 **Achievements:** ${earned.length} / ${CATALOG.length}`);
    lines.push(icons + (earned.length > 12 ? ' …' : ''));
  }

  // Footer details.
  lines.push('');
  if (bday) lines.push(`🎂 Birthday: **${formatBday(bday.month_day)}**`);
  if (joined) lines.push(`📅 Joined: **${shortDate(joined.joined_at)}**`);

  return {
    color: PASSPORT_COLOR,
    title: '🪪 Aquilo Passport',
    description: lines.join('\n').slice(0, 4096),
    footer: { text: 'Run /passport any time · /birthday set to add your date' },
    timestamp: new Date().toISOString()
  };
}

function passportComponents(userId) {
  // External link buttons that route to other bots / pages.
  const buttons = [
    btn('passport:achievements:' + userId, 'Achievements', { style: BTN_PRIMARY, emoji: '🏆' }),
    btn('passport:streaks:' + userId,      'Top Streaks',  { style: BTN_SECONDARY, emoji: '⚡' }),
  ];
  // Optional public link buttons (deep-links don't need custom_id).
  buttons.push(linkBtn('https://widget.aquilo.gg', 'aquilo.gg', { emoji: '🌐' }));
  return [row(...buttons)];
}

// ---- Component / button handlers ---------------------------------------

export async function handlePassportButton(env, data) {
  const id = data?.data?.custom_id || '';
  const [, action, targetId] = id.split(':');
  const callerId = data?.member?.user?.id || data?.user?.id;

  if (action === 'achievements') {
    return chat({
      embeds: [await buildAchievementsEmbed(env, data.guild_id, targetId || callerId)],
      flags: FLAG_EPHEMERAL
    });
  }
  if (action === 'streaks') {
    return chat({
      embeds: [await buildTopStreaksEmbed(env, data.guild_id)],
      flags: FLAG_EPHEMERAL
    });
  }
  return ephemeral('Unknown passport action.');
}

async function buildAchievementsEmbed(env, guildId, userId) {
  const userRows = await listAllForUser(env, guildId, userId);
  const byKey = Object.fromEntries(userRows.map(r => [r.key, r]));

  const lines = [];
  for (const a of CATALOG) {
    if (a.secret && !byKey[a.key]?.earned_at) continue;   // hide secrets until earned
    const row = byKey[a.key];
    if (row?.earned_at) {
      lines.push(`✅ ${a.icon} **${a.name}**, ${a.tagline}`);
    } else if (a.threshold > 1) {
      const pr = Math.min(row?.progress || 0, a.threshold);
      lines.push(`⬜ ${a.icon} ${a.name}, ${pr} / ${a.threshold}`);
    } else {
      lines.push(`⬜ ${a.icon} ${a.name}`);
    }
  }
  const earnedCount = userRows.filter(r => r.earned_at).length;

  return {
    color: PASSPORT_COLOR,
    title: '🏆 Achievements',
    description: `**${earnedCount} / ${CATALOG.length}** earned for <@${userId}>\n\n` +
                 lines.join('\n').slice(0, 4000),
    footer: { text: 'Secret achievements only show after they\'re earned.' }
  };
}

async function buildTopStreaksEmbed(env, guildId) {
  const { topStreaks } = await import('./streak.js');
  const rows = await topStreaks(env, guildId, 10);
  if (rows.length === 0) {
    return {
      color: PASSPORT_COLOR,
      title: '⚡ Top Streaks',
      description: '_No streaks yet, be the first._'
    };
  }
  const lines = rows.map((r, i) =>
    `**${i + 1}.** <@${r.user_id}>, ${r.current_days}d (longest ${r.longest_days})`
  );
  return {
    color: PASSPORT_COLOR,
    title: '⚡ Top Streaks',
    description: lines.join('\n')
  };
}

// ---- Stat collectors ---------------------------------------------------

async function collectStats(env, guildId, userId) {
  const out = {};
  if (!env?.DB) return out;

  // Each stat is best-effort. Missing tables (e.g. pre-migration) just skip.
  const q = async (sql, ...binds) => {
    try {
      const r = await env.DB.prepare(sql).bind(...binds).first();
      return r;
    } catch { return null; }
  };

  const votes = await q('SELECT COUNT(*) AS n FROM poll_votes WHERE user_id = ?', userId);
  if (votes && votes.n != null) out.votes = votes.n;

  // suggestions: count where author = userId. Schema may not exist yet.
  const sug = await q(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='suggestions'"
  );
  if (sug?.n) {
    const s = await q('SELECT COUNT(*) AS n FROM suggestions WHERE author_id = ? AND guild_id = ?', userId, guildId);
    if (s) out.suggestions = s.n;
  }

  // Trivia wins.
  const tt = await q(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='trivia_rounds'"
  );
  if (tt?.n) {
    const t = await q('SELECT COUNT(*) AS n FROM trivia_rounds WHERE winner_id = ? AND guild_id = ?', userId, guildId);
    if (t) out.trivia_wins = t.n;
  }

  // Clips submitted.
  const ct = await q(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='clips'"
  );
  if (ct?.n) {
    const c = await q('SELECT COUNT(*) AS n FROM clips WHERE author_id = ? AND guild_id = ?', userId, guildId);
    if (c) out.clips = c.n;
  }

  // Song pre-queue total entries, lives in KV, not D1. Skip for now; cheap to add later.
  return out;
}

async function fetchBirthday(env, guildId, userId) {
  try {
    return await env.DB.prepare(
      'SELECT month_day FROM birthdays WHERE guild_id = ? AND user_id = ?'
    ).bind(guildId, userId).first();
  } catch { return null; }
}

async function fetchJoined(env, guildId, userId) {
  try {
    return await env.DB.prepare(
      'SELECT joined_at FROM member_joins WHERE guild_id = ? AND user_id = ?'
    ).bind(guildId, userId).first();
  } catch { return null; }
}

// ---- Format helpers ----------------------------------------------------

function formatBday(md) {
  const [m, d] = md.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}`;
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toISOString().slice(0, 10);
}
