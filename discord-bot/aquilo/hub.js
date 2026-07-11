// Admin hub: a single message with action buttons that replaces the v1
// /schedule, /cn-games, /cn-poll, /queue slash commands. Posted by the
// /hub slash command into the channel where it's run. The message itself
// is stateless (the buttons just trigger actions); custom_ids namespaced
// "aquilo:" route here.

import {
  ephemeral, chat, postChannelMessage, editChannelMessage, isAdmin,
  btn, row, BTN_PRIMARY, BTN_SECONDARY, BTN_DANGER, BTN_SUCCESS,
  COLOR_SCHEDULE, COLOR_POLL, COLOR_QUEUE, cap as utilCap
} from './util.js';
import { ensureBootstrap, getEligibleRoles, getGuildId } from './bootstrap.js';
import { postOrRefreshSchedule } from './aq-schedule.js';
import { postCnPoll, closeCnPoll } from './poll.js';
import { snapshotQueue, resetQueue } from './aq-queue.js';
import { gameAddModal, gameRemoveModal, gameSetArtModal } from './aq-games.js';
import { promptsEditModal } from './prompts.js';
import { dailyPollEditModal } from './daily-poll.js';
import { reviewSuggestions } from './suggestions.js';
import { initCountdown } from './countdown.js';
import { refreshVotingIdle, refreshQueueIdle } from './idle-msgs.js';
import {
  selfRolesAddModal, selfRolesRemoveModal,
  postOrRefreshSelfRolesMessage, listSelfRolesEphemeral
} from './self-roles.js';
import { postOrMoveViewerHub } from './viewer-hub.js';
import {
  ticketConfigModal, ticketTypeAddModal, ticketTypeRemoveModal,
  listTicketTypesEphemeral, postTicketPanel
} from './tickets.js';
import { getETInfo, cap } from './util.js';

function buildHubPayload(env, statusBlock = null) {
  const eligibleCount = getEligibleRoles(env).length;
  const desc = [];
  if (statusBlock) {
    desc.push(statusBlock);
    desc.push('');
  }
  desc.push('Buttons below run privileged actions in real time.');
  desc.push('');
  desc.push(
    '**Channels:** schedule <#' + (env.SCHEDULE_CHANNEL_ID || '?') + '> · ' +
    'poll <#' + (env.POLL_CHANNEL_ID || '?') + '> · ' +
    'queue <#' + (env.QUEUE_CHANNEL_ID || '?') + '>'
  );
  desc.push('**Eligible queue roles:** ' + eligibleCount + ' (priority order, highest first)');
  desc.push('**Crons:** every 30 min UTC; acts at 6 PM + 9 PM ET on Wed/Fri/Sat');
  desc.push('');
  desc.push('_Pick a section below, each opens its action panel (only you see it). Status refreshes every 30 min; 🔄 refreshes now._');
  const embed = {
    title: '🎛️ Aquilo Bot · Admin Hub',
    description: desc.join('\n'),
    color: COLOR_SCHEDULE,
    footer: { text: 'Updated ' + new Date().toISOString().slice(11, 16) + ' UTC' },
    timestamp: new Date().toISOString()
  };
  // Section navigation (3 rows, well under Discord's 5-row cap). Each
  // section button opens an ephemeral action panel via sectionPanel().
  const components = [
    row(
      btn('aquilo:sec:schedule',   'Schedule',   { style: BTN_PRIMARY, emoji: '📅' }),
      btn('aquilo:sec:polls',      'Polls',      { style: BTN_PRIMARY, emoji: '🗳️' }),
      btn('aquilo:sec:queue',      'Queue',      { style: BTN_PRIMARY, emoji: '👥' }),
      btn('aquilo:sec:games',      'Games',      { style: BTN_PRIMARY, emoji: '🎮' })
    ),
    row(
      btn('aquilo:sec:engagement', 'Engagement', { style: BTN_PRIMARY, emoji: '💬' }),
      btn('aquilo:sec:roles',      'Self-Roles', { style: BTN_PRIMARY, emoji: '🎭' }),
      btn('aquilo:sec:tickets',    'Tickets',    { style: BTN_PRIMARY, emoji: '🎫' }),
      btn('aquilo:sec:viewer',     'Viewer Hub', { style: BTN_PRIMARY, emoji: '📤' })
    ),
    row(
      btn('aquilo:status_refresh', 'Refresh Status', { style: BTN_SECONDARY, emoji: '🔄' })
    )
  ];
  return { embeds: [embed], components };
}

// Per-section action panel, returned as an ephemeral when a section
// nav button is clicked. Each section's buttons keep their original
// custom_ids so the action handlers below are unchanged.
function sectionPanel(section) {
  const S = {
    schedule: {
      title: '📅 Schedule',
      buttons: [btn('aquilo:schedule_post', 'Post / Refresh Schedule', { style: BTN_PRIMARY, emoji: '📅' })]
    },
    polls: {
      title: '🗳️ Community-Night Polls',
      buttons: [
        btn('aquilo:poll_post',  'Post Poll Now', { style: BTN_PRIMARY, emoji: '🗳️' }),
        btn('aquilo:poll_close', 'Close Poll',    { style: BTN_DANGER,  emoji: '🔒' })
      ]
    },
    queue: {
      title: '👥 Queue',
      buttons: [
        btn('aquilo:queue_view',  'View Queue',  { style: BTN_SECONDARY, emoji: '📋' }),
        btn('aquilo:queue_reset', 'Reset Queue', { style: BTN_DANGER,    emoji: '🗑️' })
      ]
    },
    games: {
      title: '🎮 Community-Night Games',
      buttons: [
        btn('aquilo:game_add',     'Add Game',     { style: BTN_SUCCESS,   emoji: '➕' }),
        btn('aquilo:game_remove',  'Remove Game',  { style: BTN_DANGER,    emoji: '➖' }),
        btn('aquilo:game_set_art', 'Set Game Art', { style: BTN_SECONDARY, emoji: '🖼️' })
      ]
    },
    engagement: {
      title: '💬 Engagement',
      buttons: [
        btn('aquilo:prompts_edit',   'Edit Prompts',   { style: BTN_SECONDARY, emoji: '📝' }),
        btn('aquilo:tot_edit',       'Edit T-or-T',    { style: BTN_SECONDARY, emoji: '🎲' }),
        btn('aquilo:sug_review',     'Review Sug.',    { style: BTN_PRIMARY,   emoji: '📩' }),
        btn('aquilo:countdown_init', 'Init Countdown', { style: BTN_SECONDARY, emoji: '📌' }),
        btn('aquilo:idles_init',     'Init Idles',     { style: BTN_SECONDARY, emoji: '♻️' })
      ]
    },
    roles: {
      title: '🎭 Self-Assign Roles',
      buttons: [
        btn('aquilo:self_role_add',    'Add',          { style: BTN_SUCCESS,   emoji: '➕' }),
        btn('aquilo:self_role_remove', 'Remove',       { style: BTN_DANGER,    emoji: '➖' }),
        btn('aquilo:self_roles_list',  'List',         { style: BTN_SECONDARY, emoji: '📋' }),
        btn('aquilo:self_roles_post',  'Post Message', { style: BTN_PRIMARY,   emoji: '📤' })
      ]
    },
    tickets: {
      title: '🎫 Ticketing',
      buttons: [
        btn('aquilo:ticket_config',      'Configure',    { style: BTN_SECONDARY, emoji: '⚙️' }),
        btn('aquilo:ticket_type_add',    'Add Type',     { style: BTN_SUCCESS,   emoji: '➕' }),
        btn('aquilo:ticket_type_remove', 'Remove Type',  { style: BTN_DANGER,    emoji: '➖' }),
        btn('aquilo:ticket_types_list',  'List Setup',   { style: BTN_SECONDARY, emoji: '📋' }),
        btn('aquilo:ticket_panel_post',  'Post Panel',   { style: BTN_PRIMARY,   emoji: '📤' })
      ]
    },
    viewer: {
      title: '📤 Viewer Hub',
      buttons: [btn('aquilo:viewer_hub_post', 'Post / Move Viewer Hub', { style: BTN_PRIMARY, emoji: '🎮' })]
    }
  };
  const s = S[section];
  if (!s) return ephemeral('Unknown section.');
  return chat({
    content: '**' + s.title + '**, pick an action _(only you see this)_:',
    components: [row(...s.buttons)],
    flags: 64
  });
}

// ---- Status panel ------------------------------------------------------
// Live state shown at the top of the hub embed. Computed fresh on each
// /hub command, each cron tick, and each manual 🔄 click.

const KV_HUB_MSG = 'aquilo:msg';  // { channel_id, message_id }

export async function buildStatusBlock(env) {
  const lines = [];
  // Lazy imports, used here so the modules' deps don't leak elsewhere.
  let live = null, openPoll = null, queueSize = 0, countingState = null;

  // Live state via countdown.computeNextStream (re-derived inline to
  // avoid an import cycle, same parse-stream-time logic).
  try {
    const { computeNextStream, relativeTimeText } = await import('./countdown.js');
    const next = computeNextStream(env);
    live = next.isLive
      ? '🔴 **LIVE NOW** · ' + utilCap(next.weekday)
      : '📺 Next stream in **' + relativeTimeText(next.minutesAway) + '** · ' + utilCap(next.weekday);
  } catch { live = '📺 Stream status unavailable'; }

  // Open CN poll status
  try {
    const guildId = await getGuildId(env);
    const op = await env.DB.prepare(
      'SELECT id, day_of_week, posted_at FROM polls WHERE guild_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1'
    ).bind(guildId).first();
    if (op) openPoll = '🗳️ **' + utilCap(op.day_of_week) + '** poll #' + op.id + ' open';
    else    openPoll = '_no open poll_';

    // Queue size
    const qRaw = await env.STATE.get('queue:' + guildId);
    if (qRaw) {
      try { queueSize = (JSON.parse(qRaw).entries || []).length; } catch {}
    }

    // Counting state
    const cRaw = await env.STATE.get('counting:' + guildId);
    if (cRaw) {
      try { countingState = JSON.parse(cRaw); } catch {}
    }
  } catch (e) { /* guildless or no DB, silent */ }

  lines.push('**📊 Status**');
  lines.push(live);
  const queueLine = queueSize > 0 ? '👥 **' + queueSize + '** in queue' : '_queue empty_';
  const countLine = countingState?.current > 0
    ? '🔢 count at **' + countingState.current + '** (high score **' + (countingState.high_score || 0) + '**)'
    : '_count idle_';
  lines.push(openPoll + ' · ' + queueLine + ' · ' + countLine);
  return lines.join('\n');
}

// Edit the previously-posted hub message in place with refreshed status.
// No-op if /hub hasn't been run in this guild yet. Called from cron + the
// 🔄 button. Failures get logged but don't propagate.
export async function refreshHubMessage(env) {
  const raw = await env.STATE.get(KV_HUB_MSG);
  if (!raw) return { skipped: 'no_hub_message' };
  let stored;
  try { stored = JSON.parse(raw); } catch { return { skipped: 'bad_kv' }; }
  if (!stored?.channel_id || !stored?.message_id) return { skipped: 'incomplete' };

  let statusBlock = null;
  try { statusBlock = await buildStatusBlock(env); }
  catch (e) { console.warn('[hub] status block failed:', e?.message || e); }

  const payload = buildHubPayload(env, statusBlock);
  try {
    await editChannelMessage(env, stored.channel_id, stored.message_id, payload);
    return { ok: true };
  } catch (e) {
    // 404 = message deleted manually. Drop the KV pointer so the next
    // /hub starts fresh.
    if (String(e?.message || '').includes('404')) {
      await env.STATE.delete(KV_HUB_MSG);
    }
    return { skipped: 'edit_failed', error: e?.message };
  }
}

// /hub slash command handler, posts the hub message in the current
// channel. Also stashes the new message_id in KV so cron + the 🔄
// button can edit it in place going forward (status panel auto-refresh).
export async function handleHubCommand(data, env) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const channelId = data.channel_id;
  if (!channelId) return ephemeral('Could not resolve channel id.');

  let statusBlock = null;
  try { statusBlock = await buildStatusBlock(env); }
  catch (e) { console.warn('[hub] initial status block:', e?.message || e); }

  const payload = buildHubPayload(env, statusBlock);
  try {
    const msg = await postChannelMessage(env, channelId, payload);
    await env.STATE.put(KV_HUB_MSG, JSON.stringify({ channel_id: channelId, message_id: msg.id }));
    return ephemeral('Posted hub. Message id: ' + msg.id + '\nStatus panel will auto-refresh every 30 min, or click 🔄 to refresh on demand.');
  } catch (e) {
    return ephemeral('Failed: ' + (e?.message || e));
  }
}

// Component dispatcher for any button starting "aquilo:". `ctx` is forwarded
// from worker.js so closeCnPoll can use ctx.waitUntil for the patron DM batch.
export async function handleHubButton(env, data, ctx) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const parts = (data.data?.custom_id || '').split(':');
  const action = parts[1];

  // Section navigation, "aquilo:sec:<section>" → ephemeral action panel.
  if (action === 'sec') return sectionPanel(parts[2]);

  const guildId = await ensureBootstrap(env);

  if (action === 'schedule_post') {
    try {
      const id = await postOrRefreshSchedule(env, guildId);
      return ephemeral('📅 Schedule posted/refreshed in <#' + env.SCHEDULE_CHANNEL_ID + '>. Message id: ' + id);
    } catch (e) { return ephemeral('Failed: ' + (e?.message || e)); }
  }

  if (action === 'poll_post') {
    // Schedule v8 (2026-07-11): the D1 Saturday poll is RETIRED — Community
    // Night's game is auto-picked weekly (aq-schedule weeklyCommunityPick),
    // and with runScheduledPoll hard-disabled a posted poll would NEVER
    // auto-close (live buttons forever + weekly reminder-DM blasts). Reply
    // with tonight's/next Saturday's auto-pick instead of posting a vote.
    try {
      const { weeklyCommunityPick } = await import('./aq-schedule.js');
      const pick = await weeklyCommunityPick(env, guildId, 6);
      return ephemeral(
        '🗳️ The Community Night poll is retired — Saturday\'s game is auto-picked weekly.\n' +
        (pick?.name
          ? '🎲 This week\'s pick: **' + pick.name + '**. Pin a different game on aquilo.gg/admin → Stream Events.'
          : '🎲 No pick yet (community pool is empty) — manage the pool on aquilo.gg/admin.'),
      );
    } catch (e) { return ephemeral('Failed: ' + (e?.message || e)); }
  }

  if (action === 'poll_close') {
    // Kept ONLY as a cleanup path for a stray still-open D1 poll from the
    // retired vote era; new polls can no longer be posted. NOTE: the winner
    // is written to cn_winners, which v8 resolution deliberately ignores.
    try {
      const r = await closeCnPoll(env, ctx);
      if (r?.skipped) return ephemeral('Skipped: ' + r.skipped);
      return ephemeral('🔒 Closed stray poll #' + r.pollId + (r.winnerName ? ' · winner **' + r.winnerName + '** (' + r.voteCount + ' votes)' : ' · no winner') + '. (Winner does NOT change the schedule — Saturday\'s game is the weekly auto-pick.)');
    } catch (e) { return ephemeral('Failed: ' + (e?.message || e)); }
  }

  if (action === 'queue_view') {
    const q = await snapshotQueue(env, guildId);
    if (!q.entries?.length) return ephemeral('Queue is empty.');
    const lines = q.entries.map((e, i) =>
      (i + 1) + '. <@' + e.user_id + '> _(p' + e.priority + ', joined ' + (e.joined_at || '?').slice(11, 16) + ')_'
    ).join('\n');
    return ephemeral('**' + (q.day_of_week ? cap(q.day_of_week) + ' ' : '') + 'Queue (' + q.entries.length + '):**\n' + lines);
  }

  if (action === 'queue_reset') {
    try {
      await resetQueue(env, guildId);
      return ephemeral('🗑️ Queue cleared.');
    } catch (e) { return ephemeral('Failed: ' + (e?.message || e)); }
  }

  // Game-pool management buttons → return a modal (interaction response
  // type 9). The modal-submit handler is in worker.js → games.js.
  if (action === 'game_add')     return gameAddModal();
  if (action === 'game_remove')  return gameRemoveModal();
  if (action === 'game_set_art') return gameSetArtModal();

  // Engagement management
  if (action === 'prompts_edit')   return promptsEditModal(env);
  if (action === 'tot_edit')       return dailyPollEditModal(env);
  if (action === 'sug_review')     return reviewSuggestions(env, data);
  if (action === 'countdown_init') return initCountdown(env);

  if (action === 'idles_init') {
    try {
      const v = await refreshVotingIdle(env);
      const q = await refreshQueueIdle(env);
      return ephemeral('♻️ Idle CTAs posted/refreshed.\n• Voting idle: ' + (v?.messageId ? '<#' + env.POLL_CHANNEL_ID + '> id `' + v.messageId + '`' : '(skipped, POLL_CHANNEL_ID unset)') + '\n• Queue idle: ' + (q?.messageId ? '<#' + env.QUEUE_CHANNEL_ID + '> id `' + q.messageId + '`' : '(skipped, QUEUE_CHANNEL_ID unset)'));
    } catch (e) { return ephemeral('Failed: ' + (e?.message || e)); }
  }

  // Self-roles management
  if (action === 'self_role_add')    return selfRolesAddModal();
  if (action === 'self_role_remove') return selfRolesRemoveModal();
  if (action === 'self_roles_list')  return listSelfRolesEphemeral(env, data);
  if (action === 'self_roles_post')  return postOrRefreshSelfRolesMessage(env, data);

  if (action === 'status_refresh') {
    const r = await refreshHubMessage(env);
    if (r.skipped) return ephemeral('No hub message tracked yet, re-run /hub. (' + r.skipped + ')');
    return ephemeral('🔄 Status panel refreshed.');
  }

  if (action === 'viewer_hub_post') {
    return postOrMoveViewerHub(env, data);
  }

  // Ticketing admin actions
  if (action === 'ticket_config')      return ticketConfigModal(env, guildId);
  if (action === 'ticket_type_add')    return ticketTypeAddModal();
  if (action === 'ticket_type_remove') return ticketTypeRemoveModal();
  if (action === 'ticket_types_list')  return listTicketTypesEphemeral(env, data);
  if (action === 'ticket_panel_post')  return postTicketPanel(env, data);

  return ephemeral('Unknown hub action.');
}
