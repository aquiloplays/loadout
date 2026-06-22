// Viewer-facing hub. A public message in some community channel with
// buttons that replace the previous viewer-facing slash commands:
//   /encounter  → 🎲 Encounter
//   /suggest    → 💡 Suggest a Game (modal: name + reason)
//   /sr-add     → 🎵 Add Song      (modal: song URL or "title artist")
//   /sr-list    → 📋 My Songs      (ephemeral list)
//   /sr-remove  → ❌ Remove Song   (modal: position)
//
// The slash commands themselves are dropped from register-commands.js so
// viewers see no commands at all in the picker. Admin slash commands
// stay registered but Discord hides them from non-admins via the
// setDefaultMemberPermissions on each registration.
//
// Why: cleaner viewer UX (one place for everything they can do, no
// command-name memorization) and zero risk of viewers stumbling onto
// admin commands.

import {
  ephemeral, postChannelMessage, editChannelMessage, discordFetch,
  modal, getModalField, btn, row, isAdmin,
  BTN_PRIMARY, BTN_SECONDARY, BTN_SUCCESS, BTN_DANGER,
  COLOR_SCHEDULE
} from './util.js';
import { handleEncounterCommand } from './encounter.js';
import { handleSuggestCommand } from './suggestions.js';
import { handleSrAdd, handleSrList, handleSrRemove } from './song-prequeue.js';

const KV_VIEWER_HUB = 'viewer_hub:msg';

// ---- Payload + admin "post" button -------------------------------------

function buildViewerHubPayload() {
  const embed = {
    title: '🎮 Aquilo · Viewer Commands',
    description:
      'Tap a button for what you want to do, no need to remember slash commands.\n\n' +
      '🎲 **Encounter**, roll a random event (10-min cooldown)\n' +
      '💡 **Suggest a Game**, propose a new game for community-night rotation\n' +
      '🎵 **Add Song**, drop a track in the pre-stream music queue\n' +
      '📋 **My Songs**, see your own pre-queued songs (only you can see this)\n' +
      '❌ **Remove Song**, remove one of your songs by position',
    color: COLOR_SCHEDULE,
    footer: { text: 'Buttons here mirror your old slash commands.' }
  };
  const components = [row(
    btn('vh:encounter', 'Encounter',      { style: BTN_PRIMARY,   emoji: '🎲' }),
    btn('vh:suggest',   'Suggest a Game', { style: BTN_SUCCESS,   emoji: '💡' }),
    btn('vh:sr_add',    'Add Song',       { style: BTN_PRIMARY,   emoji: '🎵' }),
    btn('vh:sr_list',   'My Songs',       { style: BTN_SECONDARY, emoji: '📋' }),
    btn('vh:sr_remove', 'Remove Song',    { style: BTN_DANGER,    emoji: '❌' })
  )];
  return { embeds: [embed], components };
}

// Hub-side admin button: post / move the viewer hub. Uses the channel
// the admin clicked in. If a previous viewer hub message exists in a
// different channel, deletes it so we don't leave a stale one behind.
export async function postOrMoveViewerHub(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const channelId = data.channel_id;
  if (!channelId) return ephemeral('Could not resolve channel id.');

  // Delete prior message if it exists in a different channel.
  const prevRaw = await env.STATE.get(KV_VIEWER_HUB);
  let prev = null;
  try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch {}
  if (prev?.channel_id && prev.channel_id !== channelId && prev.message_id) {
    try {
      await discordFetch(env,
        '/channels/' + encodeURIComponent(prev.channel_id) +
        '/messages/' + encodeURIComponent(prev.message_id),
        { method: 'DELETE' });
    } catch { /* already gone, fine */ }
  }

  // Edit in place if same channel; else post fresh.
  if (prev?.channel_id === channelId && prev.message_id) {
    try {
      await editChannelMessage(env, channelId, prev.message_id, buildViewerHubPayload());
      return ephemeral('🔄 Viewer hub refreshed in <#' + channelId + '>.');
    } catch { /* fall through to repost */ }
  }
  try {
    const msg = await postChannelMessage(env, channelId, buildViewerHubPayload());
    await env.STATE.put(KV_VIEWER_HUB, JSON.stringify({ channel_id: channelId, message_id: msg.id }));
    return ephemeral('📤 Posted viewer hub in <#' + channelId + '> (msg id: ' + msg.id + ').');
  } catch (e) {
    return ephemeral('Failed: ' + (e?.message || e));
  }
}

// ---- Modal builders (returned from button clicks) ----------------------

function suggestModal() {
  return modal('modal:vh_suggest', 'Suggest a Game', [
    { custom_id: 'game',   label: 'Game name',           style: 1, required: true,  max_length: 100, placeholder: 'e.g. Lethal Company' },
    { custom_id: 'reason', label: 'Why? (optional)',     style: 2, required: false, max_length: 300, placeholder: 'It\'s a vibe' }
  ]);
}

function srAddModal() {
  return modal('modal:vh_sr_add', 'Add a Song to the Queue', [
    { custom_id: 'song', label: 'Song (Spotify/YouTube URL or "title artist")', style: 1, required: true, max_length: 300 }
  ]);
}

function srRemoveModal() {
  return modal('modal:vh_sr_remove', 'Remove a Song', [
    { custom_id: 'position', label: 'Position from "My Songs"', style: 1, required: true, max_length: 6, placeholder: 'e.g. 1' }
  ]);
}

// ---- Button dispatch ---------------------------------------------------

export async function handleViewerHubButton(env, data) {
  const action = (data.data?.custom_id || '').split(':')[1];

  if (action === 'encounter') {
    // /encounter takes no args, reads only data.member.user.id, which
    // is the same shape in slash + button contexts. Direct call.
    return handleEncounterCommand(data, env);
  }
  if (action === 'sr_list') {
    // /sr-list also takes no args.
    return handleSrList(env, data);
  }

  if (action === 'suggest')   return suggestModal();
  if (action === 'sr_add')    return srAddModal();
  if (action === 'sr_remove') return srRemoveModal();

  return ephemeral('Unknown viewer-hub action.');
}

// ---- Modal-submit handlers ---------------------------------------------

// Construct slash-command-shaped data so the existing handlers
// (suggestions.js, song-prequeue.js) don't need to change. They read
// `data.data.options` via flattenOptions; we just hand them an
// equivalent shape sourced from the modal fields.
function shimSlash(modalData, name, options) {
  return {
    ...modalData,
    data: { name, options }
  };
}

export async function handleViewerSuggestSubmit(env, data) {
  const game   = (getModalField(data, 'game')   || '').trim();
  const reason = (getModalField(data, 'reason') || '').trim();
  if (!game) return ephemeral('Game name required.');
  return handleSuggestCommand(shimSlash(data, 'suggest', [
    { name: 'game',   type: 3, value: game },
    ...(reason ? [{ name: 'reason', type: 3, value: reason }] : [])
  ]), env);
}

export async function handleViewerSrAddSubmit(env, data) {
  const song = (getModalField(data, 'song') || '').trim();
  if (!song) return ephemeral('Song required.');
  return handleSrAdd(env, shimSlash(data, 'sr-add', [
    { name: 'song', type: 3, value: song }
  ]));
}

export async function handleViewerSrRemoveSubmit(env, data) {
  const raw = (getModalField(data, 'position') || '').trim();
  const pos = parseInt(raw, 10);
  if (!Number.isFinite(pos) || pos < 1) return ephemeral('Position must be a positive number.');
  return handleSrRemove(env, shimSlash(data, 'sr-remove', [
    { name: 'position', type: 4, value: pos }
  ]));
}
