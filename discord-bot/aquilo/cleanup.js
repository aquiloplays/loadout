// Auto-cleanup: delete old closed CN poll messages from #poll. Runs from
// the daily 3 AM ET cron. Targets polls closed >= 7 days ago whose
// Discord message is still around. Drops the message_id afterwards so
// re-runs don't try to delete twice.
//
// We keep the D1 row (game_id, votes, etc) intact so /history + the
// weekly recap still work. Only the chat clutter goes away.

import { discordFetch } from './util.js';
import { ensureBootstrap } from './bootstrap.js';

const RETENTION_DAYS = 7;

export async function cleanupOldPollMessages(env) {
  const guildId = await ensureBootstrap(env);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000)
    .toISOString().slice(0, 19).replace('T', ' ');

  const { results: stale } = await env.DB.prepare(
    `SELECT id, channel_id, message_id FROM polls
     WHERE guild_id = ?
       AND closed_at IS NOT NULL
       AND closed_at <= ?
       AND message_id IS NOT NULL
     ORDER BY id ASC
     LIMIT 50`  // batch cap so a long backlog doesn't time out one cron tick
  ).bind(guildId, cutoff).all();

  if (!stale?.length) return { skipped: 'nothing_to_clean' };

  let deleted = 0, failed = 0;
  for (const p of stale) {
    try {
      // Delete the channel message. Discord auto-archives any thread
      // attached to it; we don't need to delete the thread separately.
      await discordFetch(env,
        '/channels/' + encodeURIComponent(p.channel_id) +
        '/messages/' + encodeURIComponent(p.message_id),
        { method: 'DELETE' });
    } catch (e) {
      // 404 = already gone manually. 403 = perm changed. Either way,
      // null out message_id so we stop retrying.
      console.warn('[cleanup] delete poll #' + p.id + ' msg failed:', e?.message || e);
      failed++;
    }
    await env.DB.prepare('UPDATE polls SET message_id = NULL WHERE id = ?')
      .bind(p.id).run();
    deleted++;
  }

  return { deleted, failed };
}
