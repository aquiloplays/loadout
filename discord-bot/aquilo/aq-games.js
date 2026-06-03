// Game-pool CRUD via hub modals. Lets the streamer add/remove community-
// night games and override cover art without code changes. Backed by the
// same `games` table that bootstrap.js seeds.

import { ephemeral, modal, getModalField } from './util.js';
import { ensureBootstrap } from './bootstrap.js';

// ---- Modal payloads (returned from hub button clicks) ------------------

export function gameAddModal() {
  return modal('modal:game_add', 'Add a community-night game', [
    { custom_id: 'name',    label: 'Game name', style: 1, required: true,  max_length: 100 },
    { custom_id: 'art_url', label: 'Cover art URL (optional)', style: 1, required: false, max_length: 500, placeholder: 'https://cdn.cloudflare.steamstatic.com/...' }
  ]);
}

export function gameRemoveModal() {
  return modal('modal:game_remove', 'Remove a game from rotation', [
    { custom_id: 'name', label: 'Game name (exact match)', style: 1, required: true, max_length: 100 }
  ]);
}

export function gameSetArtModal() {
  return modal('modal:game_set_art', "Update a game's cover art", [
    { custom_id: 'name',    label: 'Game name (exact match)', style: 1, required: true, max_length: 100 },
    { custom_id: 'art_url', label: 'New cover art URL',       style: 1, required: true, max_length: 500, placeholder: 'https://...' }
  ]);
}

// ---- Modal-submit handlers --------------------------------------------

export async function handleGameAddSubmit(env, data) {
  const guildId = await ensureBootstrap(env);
  const name = (getModalField(data, 'name') || '').trim();
  const art_url = (getModalField(data, 'art_url') || '').trim() || null;
  if (!name) return ephemeral('Name required.');

  const existing = await env.DB.prepare(
    'SELECT id, active FROM games WHERE guild_id = ? AND name = ?'
  ).bind(guildId, name).first();

  if (existing && existing.active) {
    return ephemeral('**' + name + '** is already in the active pool.');
  }
  if (existing && !existing.active) {
    await env.DB.prepare(
      `UPDATE games SET active = 1, dropped_at = NULL,
       art_url = COALESCE(?, art_url) WHERE id = ?`
    ).bind(art_url, existing.id).run();
    return ephemeral('♻️ Re-activated **' + name + '** (was previously removed).');
  }

  await env.DB.prepare(
    'INSERT INTO games (guild_id, name, art_url) VALUES (?, ?, ?)'
  ).bind(guildId, name, art_url).run();
  return ephemeral('✅ Added **' + name + '** to the pool' + (art_url ? '' : ' (no art set, use 🖼️ Set Game Art to add one).'));
}

export async function handleGameRemoveSubmit(env, data) {
  const guildId = await ensureBootstrap(env);
  const name = (getModalField(data, 'name') || '').trim();
  if (!name) return ephemeral('Name required.');

  // Soft-delete (active=0) so vote history stays linkable; can re-add later.
  const r = await env.DB.prepare(
    `UPDATE games SET active = 0, dropped_at = datetime('now')
     WHERE guild_id = ? AND name = ? AND active = 1`
  ).bind(guildId, name).run();
  if ((r.meta?.changes || 0) === 0) return ephemeral('No active game named **' + name + '** found.');
  return ephemeral('🗑️ Removed **' + name + '** from rotation. (Use ➕ Add Game to bring it back.)');
}

export async function handleGameSetArtSubmit(env, data) {
  const guildId = await ensureBootstrap(env);
  const name = (getModalField(data, 'name') || '').trim();
  const art_url = (getModalField(data, 'art_url') || '').trim();
  if (!name || !art_url) return ephemeral('Name + art URL both required.');

  const r = await env.DB.prepare(
    'UPDATE games SET art_url = ? WHERE guild_id = ? AND name = ?'
  ).bind(art_url, guildId, name).run();
  if ((r.meta?.changes || 0) === 0) return ephemeral('No game named **' + name + '** found.');
  return ephemeral('🖼️ Updated cover art for **' + name + '**.');
}
