// Game suggestion box. Users can `/suggest <game> [reason]` to suggest
// new games for the community-night rotation. Suggestions land in D1
// with status='pending'. Admin reviews via the hub "Review Suggestions"
// button — ephemeral list with Approve / Dismiss buttons per row.
// Approve inserts into `games` (active=1); Dismiss marks as dismissed.

import {
  ephemeral, chat, btn, row, BTN_SUCCESS, BTN_DANGER, BTN_SECONDARY,
  isAdmin, COLOR_SCHEDULE
} from './util.js';
import { ensureBootstrap } from './bootstrap.js';

// ---- /suggest slash command -------------------------------------------

export async function handleSuggestCommand(data, env) {
  const guildId = await ensureBootstrap(env);
  const userId = data.member?.user?.id || data.user?.id;
  if (!userId) return ephemeral('Couldn\'t identify you.');
  const opts = (data.data?.options || []).reduce((a, o) => (a[o.name] = o.value, a), {});
  const game   = (opts.game   || '').trim();
  const reason = (opts.reason || '').trim() || null;
  if (!game) return ephemeral('Game name required.');
  if (game.length > 100) return ephemeral('Game name too long (max 100).');

  // Check if game already exists in pool
  const existing = await env.DB.prepare(
    'SELECT id, active FROM games WHERE guild_id = ? AND name = ?'
  ).bind(guildId, game).first();
  if (existing && existing.active) return ephemeral('**' + game + '** is already in the pool!');
  if (existing && !existing.active) return ephemeral('**' + game + '** was removed previously. Ping the streamer to bring it back.');

  // Check for dupe pending suggestion
  const dup = await env.DB.prepare(
    `SELECT id FROM game_suggestions
     WHERE guild_id = ? AND game_name = ? AND status = 'pending'
     LIMIT 1`
  ).bind(guildId, game).first();
  if (dup) return ephemeral('**' + game + '** is already pending review. Streamer\'s on it!');

  await env.DB.prepare(
    'INSERT INTO game_suggestions (guild_id, user_id, game_name, reason) VALUES (?, ?, ?, ?)'
  ).bind(guildId, userId, game, reason).run();
  return ephemeral('💡 Thanks! Your suggestion **' + game + '** is in the queue for review.');
}

// ---- Hub button: "Review Suggestions" ---------------------------------

export async function reviewSuggestions(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const guildId = await ensureBootstrap(env);
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, game_name, reason, created_at FROM game_suggestions
     WHERE guild_id = ? AND status = 'pending'
     ORDER BY created_at ASC LIMIT 5`
  ).bind(guildId).all();
  const list = results || [];

  if (!list.length) return ephemeral('📭 No pending suggestions.');

  // Build embed listing each suggestion + a row of Approve/Dismiss buttons per id.
  // Discord limits 5 rows per message, so cap at 5 suggestions per view.
  const lines = list.map((s, i) => {
    const r = s.reason ? '\n   _' + s.reason.slice(0, 200) + '_' : '';
    return (i + 1) + '. **' + s.game_name + '** — by <@' + s.user_id + '>' + r;
  });
  const embed = {
    title: '💡 Pending Game Suggestions (' + list.length + ')',
    description: lines.join('\n\n').slice(0, 4000),
    color: COLOR_SCHEDULE,
    footer: { text: 'Tap Approve to add to pool · Dismiss to skip' }
  };

  const components = list.map((s, i) => row(
    btn('sug:approve:' + s.id, '✅ #' + (i + 1) + ' Approve', { style: BTN_SUCCESS }),
    btn('sug:dismiss:' + s.id, '❌ Dismiss',                  { style: BTN_DANGER })
  ));

  return chat({ embeds: [embed], components, flags: 64 });
}

// Component handler: sug:approve:<id> or sug:dismiss:<id>
export async function handleSuggestionAction(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const parts = (data.data?.custom_id || '').split(':');
  const action = parts[1];
  const id = parseInt(parts[2], 10);
  if (!id || !['approve', 'dismiss'].includes(action)) return ephemeral('Bad button.');
  const guildId = await ensureBootstrap(env);

  const s = await env.DB.prepare(
    `SELECT * FROM game_suggestions WHERE id = ? AND guild_id = ? AND status = 'pending'`
  ).bind(id, guildId).first();
  if (!s) return ephemeral('Suggestion not found or already reviewed.');

  if (action === 'approve') {
    // Try to insert into games (active=1). If exists inactive → re-activate.
    const existing = await env.DB.prepare(
      'SELECT id, active FROM games WHERE guild_id = ? AND name = ?'
    ).bind(guildId, s.game_name).first();
    if (existing && existing.active) {
      // already in pool, just mark approved
    } else if (existing) {
      await env.DB.prepare(
        'UPDATE games SET active = 1, dropped_at = NULL WHERE id = ?'
      ).bind(existing.id).run();
    } else {
      await env.DB.prepare(
        'INSERT INTO games (guild_id, name) VALUES (?, ?)'
      ).bind(guildId, s.game_name).run();
    }
    await env.DB.prepare(
      `UPDATE game_suggestions SET status = 'approved', reviewed_at = datetime('now') WHERE id = ?`
    ).bind(id).run();
    return ephemeral('✅ **' + s.game_name + '** approved + added to the pool. (No cover art yet — use 🖼️ Set Game Art on the hub to add one.)');
  }

  if (action === 'dismiss') {
    await env.DB.prepare(
      `UPDATE game_suggestions SET status = 'dismissed', reviewed_at = datetime('now') WHERE id = ?`
    ).bind(id).run();
    return ephemeral('❌ Dismissed **' + s.game_name + '**.');
  }
  return ephemeral('Bad button.');
}
