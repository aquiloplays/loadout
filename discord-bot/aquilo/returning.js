// Returning-member re-engagement. Records "last seen" timestamps from
// any interaction the bot handles; once-per-user welcome-back DM after
// 30+ days of absence, with a 50 Bolts gift.
//
// Public API:
//   touchSeen(env, guildId, userId)     -> update last_seen (fire and forget)
//   runReturningCron(env)               -> cron: scan for returns + send DMs

import { getETInfo, discordFetch } from './util.js';

const RETURN_THRESHOLD_DAYS = 30;
const RETURN_BOLTS = 50;

/** Bump the last_seen timestamp for this user. Cheap upsert. */
export async function touchSeen(env, guildId, userId) {
  if (!env?.DB || !guildId || !userId) return;
  try {
    await env.DB.prepare(
      `INSERT INTO last_seen (guild_id, user_id, last_ts) VALUES (?, ?, datetime('now'))
         ON CONFLICT(guild_id, user_id) DO UPDATE SET last_ts = datetime('now')`
    ).bind(guildId, userId).run();
  } catch (e) { /* non-critical */ }
}

/**
 * Cron: scan for users we haven't seen in 30+ days and (if they've sent a
 * message in the last hour) DM them a welcome-back. Driven by the seen
 * timestamp jumping forward.
 *
 * Strategy: scan rows where last_ts in (now - 1h, now) AND dm_sent_at is
 * NULL AND previous_last_ts (before this touch) was > 30 days ago.
 *
 * Simplification: we don't track previous timestamps; instead we run this
 * cron RIGHT AFTER touchSeen, comparing the current last_ts to a 30-day
 * cutoff. So this only matters if a user was inactive long enough — once
 * dm_sent_at is set, we won't DM them again until manually cleared.
 *
 * To avoid notifying people who've never been here long enough, we also
 * require that the row was created > 30 days ago.
 */
export async function runReturningCron(env) {
  if (!env?.DB) return;
  // Anyone whose last_seen was bumped in the last hour, hasn't been DM'd,
  // and whose row predates today by > 30 days.
  const cutoff = new Date(Date.now() - RETURN_THRESHOLD_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  // Note: last_seen.last_ts = now, but we want previous value > 30 days
  // ago. We approximate by tracking "first_seen" separately — simplest:
  // if `welcomed.welcomed_at` is older than 30 days OR `member_joins.joined_at`
  // is older than 30 days, we count them.
  const { results } = await env.DB.prepare(
    `SELECT ls.guild_id, ls.user_id, ls.last_ts
       FROM last_seen ls
       LEFT JOIN welcomed w ON w.guild_id = ls.guild_id AND w.user_id = ls.user_id
       LEFT JOIN member_joins mj ON mj.guild_id = ls.guild_id AND mj.user_id = ls.user_id
       WHERE ls.dm_sent_at IS NULL
         AND ls.last_ts >= datetime('now', '-1 hour')
         AND (w.welcomed_at IS NULL OR w.welcomed_at < ?)
         AND (mj.joined_at IS NULL OR mj.joined_at < ?)
       LIMIT 20`
  ).bind(cutoff, cutoff).all();

  for (const r of (results || [])) {
    await sendReturnDM(env, r.user_id);
    await env.DB.prepare(
      'UPDATE last_seen SET dm_sent_at = datetime(\'now\') WHERE guild_id = ? AND user_id = ?'
    ).bind(r.guild_id, r.user_id).run();

    // Credit Bolts.
    if (env.LOADOUT_BOLT_API && env.LOADOUT_BOLT_API_SECRET) {
      try {
        await fetch(env.LOADOUT_BOLT_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-loadout-bolt-secret': env.LOADOUT_BOLT_API_SECRET },
          body: JSON.stringify({ user_id: r.user_id, amount: RETURN_BOLTS, reason: 'return' }),
        });
      } catch (e) { console.error('[returning] bolts grant failed', e?.message || e); }
    }
  }
}

async function sendReturnDM(env, userId) {
  try {
    // Open a DM channel.
    const ch = await discordFetch(env, '/users/@me/channels', {
      method: 'POST',
      body: JSON.stringify({ recipient_id: userId })
    });
    if (!ch?.id) return;
    await discordFetch(env, `/channels/${ch.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content:
          '🌩️ **Welcome back to Aquilo!**\n\n' +
          `It's been a while — here's a returning-storm bonus of **${RETURN_BOLTS} Bolts**.\n` +
          'Catch up: run `/passport` for your streak, `/loadout` for your wallet, and the viewer hub for what to do next.'
      })
    });
  } catch (e) {
    console.error('[returning] DM failed for', userId, e?.message || e);
  }
}
