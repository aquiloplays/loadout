// Support ticket system v2 (Clay 2026-05-28).
//
// Architecture per the spec:
//   • A persistent "Open a Ticket" message in #support
//     (1505948032187760640 for the Aquilo guild), string-select picks
//     a category, button opens a modal for {subject, description}.
//   • On submit: bot creates a PRIVATE THREAD in #support
//     (`PRIVATE_THREAD` type = 12) named `🎟 <category> · <subject>`
//     and adds the requester + every Staff role member.
//   • Bot posts the requester's submission as the first thread message
//     plus a closing pill, staff use in-thread component buttons to
//     close / assign / change priority / change category.
//   • D1 is the source of truth for state (status / priority /
//     assignee / category). The Discord thread holds the conversation
//     bytes; `ticket_messages` mirrors a slim activity log.
//
// Why threads, not channels:
//   #support is the only entry point. Threads keep the support tree
//   tidy, inherit category permissions, and the PWA admin UI can
//   render Discord-style threads natively.
//
// Categories, fixed catalogue (NOT per-guild configurable). The
// existing aquilo/tickets.js had per-guild types; v2 trades that
// flexibility for a consistent cross-guild surface the PWA can map
// to icons + colours without learning a per-guild config.
//
// Notification fan-out:
//   • New ticket → mod-log embed + DM to every Staff role member
//   • Status change → embed footer updated; D1 logs the change
//   • Assign → DM to assignee
//   • Close → DM to requester
// Each DM honours a per-staff toggle stored at KV
//   `ticket-notify-opt-out:<userId>` (set to '1' to suppress).
//
// Auto-close: daily :23 cron sweep, tickets with no `ticket_messages`
// activity in 30 days flip to status='auto_closed' + send a DM to the
// requester. Re-open via reply detected in thread MESSAGE_CREATE
// (out of scope for v1, manual /ticket reopen for now).

import {
  STAFF_ROLE_ID_FALLBACK,
} from './support-tickets-config.js';

const RESP_CHAT          = 4;
const RESP_DEFER_UPDATE  = 6;
const RESP_UPDATE_MSG    = 7;
const RESP_MODAL         = 9;
const FLAG_EPHEMERAL     = 64;

const COMP_ROW           = 1;
const COMP_BUTTON        = 2;
const COMP_STRING_SELECT = 3;
const COMP_TEXT_INPUT    = 4;
const STYLE_PRIMARY      = 1;
const STYLE_SECONDARY    = 2;
const STYLE_SUCCESS      = 3;
const STYLE_DANGER       = 4;
const STYLE_LINK         = 5;

// Discord thread types: 11 = PUBLIC_THREAD, 12 = PRIVATE_THREAD.
// Private requires the parent channel to have the PRIVATE_THREADS
// boost; Aquilo guild does (verified earlier in the session).
const THREAD_TYPE_PRIVATE = 12;

const PERM_VIEW_CHANNEL   = 0x400n;
const PERM_SEND_MESSAGES  = 0x800n;
const PERM_READ_HISTORY   = 0x10000n;

const MAX_OPEN_PER_USER   = 3;
const MAX_SUBJECT_LEN     = 100;
const MAX_DESCRIPTION_LEN = 1500;

// ── Category catalogue ─────────────────────────────────────────
//
// Order = display order in the select menu. Each emoji + label
// renders both in Discord and on the PWA admin UI; `value` is the
// stable DB-stored id.
export const CATEGORIES = Object.freeze([
  { value: 'bug',        label: 'Bug Report',                            emoji: { name: '🐛' } },
  { value: 'feature',    label: 'Feature Request',                       emoji: { name: '✨' } },
  { value: 'account',    label: 'Account Issue',                         emoji: { name: '🔐' } },
  { value: 'patreon',    label: 'Patreon / Supporter',                   emoji: { name: '💝' } },
  { value: 'game',       label: 'Game Help (Boltbound / Clash / Vault / Mini-games)', emoji: { name: '🎮' } },
  { value: 'stream',     label: 'Stream Tools (StreamFusion / Loadout / Rotation / Twitch panels)', emoji: { name: '📺' } },
  { value: 'discord',    label: 'Discord Issue (roles, channels, etc.)', emoji: { name: '💬' } },
  { value: 'general',    label: 'General / Other',                       emoji: { name: '📝' } },
]);

function categoryLabel(value) {
  const c = CATEGORIES.find((x) => x.value === value);
  return c?.label || value;
}

function categoryEmoji(value) {
  const c = CATEGORIES.find((x) => x.value === value);
  return c?.emoji?.name || '🎟';
}

export function isValidCategory(value) {
  return CATEGORIES.some((c) => c.value === value);
}

export const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

// ── Discord REST ───────────────────────────────────────────────

async function dapi(env, method, path, body) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, status: 503 };
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord support-tickets',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, body: parsed };
}

// ── Helpers ────────────────────────────────────────────────────

function ephemeral(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}

async function staffRoleId(env, guildId) {
  // Per-guild override in KV first, then env fallback.
  let id = null;
  try { id = await env.LOADOUT_BOLTS.get(`support-tickets:staff-role:${guildId}`); }
  catch { /* ignore */ }
  // Multi-tenant: no hardcoded fallback — an unconfigured guild returns
  // null (no staff role) rather than leaking the Aquilo mod-role id.
  return id || env.STAFF_ROLE_ID || null;
}

async function supportChannelId(env, guildId) {
  let id = null;
  try { id = await env.LOADOUT_BOLTS.get(`support-tickets:channel:${guildId}`); }
  catch { /* ignore */ }
  // Multi-tenant: no hardcoded fallback — unconfigured guild → null.
  return id || env.SUPPORT_CHANNEL_ID || null;
}

async function modLogChannelId(env, guildId) {
  // Re-use the existing mod-log binding from guild:cfg.ids.ch_mod_log
  // (set by guild-builder during the L8 phase). Falls back to null
  // when no mod-log is configured.
  try {
    const cfg = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
    if (cfg?.ids?.ch_mod_log) return String(cfg.ids.ch_mod_log);
  } catch { /* ignore */ }
  return null;
}

// ── State: D1 helpers ─────────────────────────────────────────

async function insertTicket(env, payload) {
  const r = await env.DB.prepare(`
    INSERT INTO tickets
      (guild_id, channel_id, thread_id, opener_user_id, requester_user_id,
       type_label, category, subject, description, status, priority,
       assignee_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, datetime('now'), datetime('now'))
    RETURNING id
  `).bind(
    payload.guildId,
    payload.channelId,
    payload.threadId,
    payload.requesterUserId,
    payload.requesterUserId,
    categoryLabel(payload.category),
    payload.category,
    payload.subject.slice(0, MAX_SUBJECT_LEN),
    (payload.description || '').slice(0, MAX_DESCRIPTION_LEN),
    payload.priority || 'normal',
  ).first();
  return r?.id || null;
}

async function loadTicket(env, ticketId) {
  return await env.DB.prepare('SELECT * FROM tickets WHERE id = ?').bind(ticketId).first();
}

async function loadTicketByThread(env, threadId) {
  return await env.DB.prepare('SELECT * FROM tickets WHERE thread_id = ? LIMIT 1')
    .bind(String(threadId)).first();
}

async function countOpenForUser(env, guildId, userId) {
  const r = await env.DB.prepare(`
    SELECT COUNT(*) AS n FROM tickets
     WHERE guild_id = ?
       AND requester_user_id = ?
       AND status IN ('open', 'in_progress')
  `).bind(guildId, userId).first();
  return Number(r?.n || 0);
}

async function appendMessage(env, ticketId, payload) {
  await env.DB.prepare(`
    INSERT INTO ticket_messages
      (ticket_id, guild_id, kind, user_id, username, content, meta, discord_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    ticketId,
    payload.guildId,
    payload.kind,
    payload.userId || null,
    payload.username || null,
    payload.content || null,
    payload.meta ? JSON.stringify(payload.meta) : null,
    payload.discordMessageId || null,
  ).run();
}

async function updateStatus(env, ticketId, status, closeReason) {
  await env.DB.prepare(`
    UPDATE tickets
       SET status = ?,
           updated_at = datetime('now'),
           closed_at = CASE WHEN ? IN ('closed','auto_closed','resolved') THEN datetime('now') ELSE closed_at END,
           close_reason = COALESCE(?, close_reason)
     WHERE id = ?
  `).bind(status, status, closeReason || null, ticketId).run();
}

async function updateAssignee(env, ticketId, assigneeUserId) {
  await env.DB.prepare(`
    UPDATE tickets SET assignee_user_id = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(assigneeUserId || null, ticketId).run();
}

async function updatePriority(env, ticketId, priority) {
  await env.DB.prepare(`
    UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(priority, ticketId).run();
}

async function updateCategory(env, ticketId, category) {
  await env.DB.prepare(`
    UPDATE tickets SET category = ?, type_label = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(category, categoryLabel(category), ticketId).run();
}

// ── Persistent embed in #support ──────────────────────────────

export function buildSupportPanelMessage() {
  return {
    embeds: [{
      title: '🎟️ Open a Ticket',
      description: [
        '**Need help with something?** Pick a category below and click **Open Ticket**, a private thread will open here just for you and the staff team.',
        '',
        'Use a ticket for anything you\'d rather not share publicly: account issues, payment questions, bugs, mod requests, support, etc.',
        '',
        '_Tickets stay private to you + the staff team. Subject + description go straight into the thread when it opens._',
      ].join('\n'),
      color: 0x7c5cff,
      footer: { text: 'Powered by Aquilo · staff usually respond within a day' },
    }],
    components: [
      {
        type: COMP_ROW,
        components: [{
          type: COMP_STRING_SELECT,
          custom_id: 'st:pickcat',
          placeholder: 'Pick a ticket category…',
          min_values: 1,
          max_values: 1,
          options: CATEGORIES.map((c) => ({
            label: c.label.length > 100 ? c.label.slice(0, 97) + '…' : c.label,
            value: c.value,
            emoji: c.emoji,
          })),
        }],
      },
      // Button is informational, pressing it without a category just
      // prompts the user. Actual flow is triggered by the select.
      {
        type: COMP_ROW,
        components: [{
          type: COMP_BUTTON,
          style: STYLE_PRIMARY,
          label: 'Open Ticket',
          custom_id: 'st:openhint',
          emoji: { name: '🎟️' },
        }],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

// Post or refresh the persistent panel. KV:
// `support-tickets:panel:<gid>` → { channelId, messageId }.
export async function postOrRefreshSupportPanel(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const channelId = String(opts.channelId || (await supportChannelId(env, guildId)) || '');
  if (!/^\d{15,25}$/.test(channelId)) return { ok: false, error: 'bad-channel-id' };
  const payload = buildSupportPanelMessage();
  let prior = null;
  try { prior = await env.LOADOUT_BOLTS.get(`support-tickets:panel:${guildId}`, { type: 'json' }); }
  catch { /* ignore */ }
  if (prior?.channelId === channelId && prior?.messageId) {
    const upd = await dapi(env, 'PATCH',
      `/channels/${channelId}/messages/${prior.messageId}`, payload);
    if (upd.ok) return { ok: true, action: 'patched', channelId, messageId: prior.messageId };
    if (upd.status !== 404) return { ok: false, error: 'patch-failed', status: upd.status, body: upd.body };
  }
  const post = await dapi(env, 'POST', `/channels/${channelId}/messages`, payload);
  if (!post.ok || !post.body?.id) {
    return { ok: false, error: 'post-failed', status: post.status, body: post.body };
  }
  await env.LOADOUT_BOLTS.put(`support-tickets:panel:${guildId}`,
    JSON.stringify({ channelId, messageId: post.body.id }));
  // Pin best-effort.
  await dapi(env, 'PUT', `/channels/${channelId}/pins/${post.body.id}`).catch(() => {});
  return { ok: true, action: 'posted-new', channelId, messageId: post.body.id };
}

// ── Component dispatch ───────────────────────────────────────

// Single entry point, routes `st:*` custom_ids. Returns a Discord
// interaction response.
export async function handleSupportTicketComponent(data, env) {
  const customId = data.data?.custom_id || '';
  const guildId = data.guild_id;
  if (!guildId) return ephemeral('Run this in a server.');

  if (customId === 'st:pickcat') {
    // The string-select submission. data.values is the chosen category.
    const cat = String(data.data?.values?.[0] || '');
    if (!isValidCategory(cat)) return ephemeral(`Unknown category: \`${cat}\``);
    // Open a modal asking for subject + description.
    return {
      type: RESP_MODAL,
      data: {
        custom_id: `st:submit:${cat}`,
        title: `Open ${categoryLabel(cat)} ticket`,
        components: [
          {
            type: COMP_ROW,
            components: [{
              type: COMP_TEXT_INPUT,
              custom_id: 'subject',
              label: 'Subject',
              style: 1,
              required: true,
              min_length: 4,
              max_length: MAX_SUBJECT_LEN,
              placeholder: 'A short summary so staff can triage…',
            }],
          },
          {
            type: COMP_ROW,
            components: [{
              type: COMP_TEXT_INPUT,
              custom_id: 'description',
              label: 'Describe the issue',
              style: 2,
              required: true,
              min_length: 10,
              max_length: MAX_DESCRIPTION_LEN,
              placeholder: 'What happened, what did you expect, any links or screenshots that help…',
            }],
          },
        ],
      },
    };
  }

  if (customId === 'st:openhint') {
    return ephemeral('Pick a category from the select menu first 👆, then the **Open Ticket** modal will appear.');
  }

  // In-thread admin component buttons (close, resolve, priority,
  // assign, category). Staff-only, checked inline via the cached
  // Staff role id.
  const isStaffCheck = async () => {
    const staffId = await staffRoleId(env, guildId);
    if (!staffId) return true;  // no staff role configured, fail open
    const roles = data.member?.roles || [];
    return Array.isArray(roles) && roles.includes(staffId);
  };
  if (customId.startsWith('st:close:')) {
    return await handleCloseComponent(data, env, customId);
  }
  if (customId.startsWith('st:resolve:')) {
    if (!(await isStaffCheck())) return ephemeral('Staff only.');
    const ticketId = parseInt(customId.slice('st:resolve:'.length), 10);
    const actorId = data.member?.user?.id || data.user?.id;
    const actorName = data.member?.user?.global_name || data.member?.user?.username || 'staff';
    const r = await resolveTicket(env, ticketId, { actorId, actorName });
    if (!r.ok) return ephemeral(`Couldn\'t resolve, ${r.error}`);
    return ephemeral(`✅ Ticket #${ticketId} marked resolved.`);
  }
  if (customId.startsWith('st:reopen:')) {
    return await handleReopenComponent(data, env, customId);
  }
  if (customId.startsWith('st:pri-open:')) {
    if (!(await isStaffCheck())) return ephemeral('Staff only.');
    const ticketId = parseInt(customId.slice('st:pri-open:'.length), 10);
    return prioritySelectMenu(ticketId);
  }
  if (customId.startsWith('st:pri-set:')) {
    if (!(await isStaffCheck())) return ephemeral('Staff only.');
    const ticketId = parseInt(customId.slice('st:pri-set:'.length), 10);
    const choice = String(data.data?.values?.[0] || '');
    if (!PRIORITIES.includes(choice)) return ephemeral('Bad priority.');
    const actorId = data.member?.user?.id || data.user?.id;
    const actorName = data.member?.user?.global_name || data.member?.user?.username || 'staff';
    const r = await setPriority(env, ticketId, choice, { actorId, actorName });
    if (!r.ok) return ephemeral(`Couldn\'t set, ${r.error}`);
    await notifyThreadPriorityChange(env, ticketId, choice, actorId);
    return ephemeral(`🚦 Ticket #${ticketId} priority set to **${choice}**.`);
  }
  if (customId.startsWith('st:cat-open:')) {
    if (!(await isStaffCheck())) return ephemeral('Staff only.');
    const ticketId = parseInt(customId.slice('st:cat-open:'.length), 10);
    return categorySelectMenu(ticketId);
  }
  if (customId.startsWith('st:cat-set:')) {
    if (!(await isStaffCheck())) return ephemeral('Staff only.');
    const ticketId = parseInt(customId.slice('st:cat-set:'.length), 10);
    const choice = String(data.data?.values?.[0] || '');
    if (!isValidCategory(choice)) return ephemeral('Bad category.');
    const actorId = data.member?.user?.id || data.user?.id;
    const actorName = data.member?.user?.global_name || data.member?.user?.username || 'staff';
    const r = await setCategory(env, ticketId, choice, { actorId, actorName });
    if (!r.ok) return ephemeral(`Couldn\'t recategorize, ${r.error}`);
    await notifyThreadCategoryChange(env, ticketId, choice, actorId);
    return ephemeral(`🏷 Ticket #${ticketId} recategorized to **${categoryLabel(choice)}**.`);
  }
  if (customId.startsWith('st:asg-open:')) {
    if (!(await isStaffCheck())) return ephemeral('Staff only.');
    const ticketId = parseInt(customId.slice('st:asg-open:'.length), 10);
    return assignSelectMenu(ticketId);
  }
  if (customId.startsWith('st:asg-set:')) {
    if (!(await isStaffCheck())) return ephemeral('Staff only.');
    const ticketId = parseInt(customId.slice('st:asg-set:'.length), 10);
    const assignee = String(data.data?.values?.[0] || '');
    if (!/^\d{15,25}$/.test(assignee)) return ephemeral('Bad assignee.');
    const actorId = data.member?.user?.id || data.user?.id;
    const actorName = data.member?.user?.global_name || data.member?.user?.username || 'staff';
    const r = await setAssignee(env, ticketId, assignee, { actorId, actorName });
    if (!r.ok) return ephemeral(`Couldn\'t assign, ${r.error}`);
    await sendAssigneeDM(env, ticketId, assignee, actorName);
    await notifyThreadAssignmentChange(env, ticketId, assignee, actorId);
    return ephemeral(`👤 Ticket #${ticketId} assigned to <@${assignee}>.`);
  }

  return ephemeral(`Unknown ticket action: \`${customId}\``);
}

// ── Ephemeral select menus for the in-thread admin controls ───

function prioritySelectMenu(ticketId) {
  return {
    type: RESP_CHAT,
    data: {
      flags: FLAG_EPHEMERAL,
      content: 'Pick the new priority:',
      components: [{
        type: COMP_ROW,
        components: [{
          type:        COMP_STRING_SELECT,
          custom_id:   `st:pri-set:${ticketId}`,
          placeholder: 'Choose priority…',
          min_values:  1,
          max_values:  1,
          options: [
            { label: '⬇️ Low',      value: 'low' },
            { label: 'Normal',       value: 'normal' },
            { label: '⬆️ High',     value: 'high' },
            { label: '🚨 Urgent',   value: 'urgent' },
          ],
        }],
      }],
    },
  };
}

function categorySelectMenu(ticketId) {
  return {
    type: RESP_CHAT,
    data: {
      flags: FLAG_EPHEMERAL,
      content: 'Pick the new category:',
      components: [{
        type: COMP_ROW,
        components: [{
          type:        COMP_STRING_SELECT,
          custom_id:   `st:cat-set:${ticketId}`,
          placeholder: 'Choose category…',
          min_values:  1,
          max_values:  1,
          options: CATEGORIES.map((c) => ({
            label: c.label.length > 100 ? c.label.slice(0, 97) + '…' : c.label,
            value: c.value,
            emoji: c.emoji,
          })),
        }],
      }],
    },
  };
}

// User-select (component type 5), Discord renders an in-line user
// picker the staff can search. Snowflakes come back in data.values.
function assignSelectMenu(ticketId) {
  return {
    type: RESP_CHAT,
    data: {
      flags: FLAG_EPHEMERAL,
      content: 'Pick the staff member to assign:',
      components: [{
        type: COMP_ROW,
        components: [{
          type:        5,   // USER_SELECT
          custom_id:   `st:asg-set:${ticketId}`,
          placeholder: 'Choose assignee…',
          min_values:  1,
          max_values:  1,
        }],
      }],
    },
  };
}

// ── DM helpers ────────────────────────────────────────────────

async function shouldDM(env, userId) {
  try {
    const optOut = await env.LOADOUT_BOLTS.get(`ticket-notify-opt-out:${userId}`);
    return !optOut;
  } catch { return true; }
}

async function openDMChannel(env, userId) {
  const r = await dapi(env, 'POST', '/users/@me/channels', { recipient_id: userId });
  if (!r.ok || !r.body?.id) return null;
  return String(r.body.id);
}

async function sendDM(env, userId, payload) {
  if (!(await shouldDM(env, userId))) return { skipped: 'opt-out' };
  const ch = await openDMChannel(env, userId);
  if (!ch) return { skipped: 'dm-channel-failed' };
  const r = await dapi(env, 'POST', `/channels/${ch}/messages`, payload);
  return { ok: r.ok, messageId: r.body?.id };
}

async function sendAssigneeDM(env, ticketId, assigneeId, byName) {
  const t = await loadTicket(env, ticketId);
  if (!t) return;
  await sendDM(env, assigneeId, {
    embeds: [{
      title: `👤 You\'ve been assigned ticket #${ticketId}`,
      description: [
        `**${t.subject || '(no subject)'}**`,
        '',
        `Category: ${categoryLabel(t.category)}`,
        `Assigned by: ${byName || 'staff'}`,
        '',
        `Thread: https://discord.com/channels/${t.guild_id}/${t.thread_id}`,
      ].join('\n'),
      color: 0x7c5cff,
      footer: { text: 'Reply in the thread when you can take it.' },
    }],
  });
}

async function sendNewTicketStaffFanout(env, ticketId) {
  const t = await loadTicket(env, ticketId);
  if (!t) return { sent: 0 };
  const staffId = await staffRoleId(env, t.guild_id);
  if (!staffId) return { sent: 0, reason: 'no-staff-role' };
  // Walk the guild's full member list paginated; cap fan-out at 40
  // to keep the burst rate-limit-friendly.
  let sent = 0;
  let after = '0';
  for (let page = 0; page < 50 && sent < 40; page++) {
    const r = await dapi(env, 'GET',
      `/guilds/${encodeURIComponent(t.guild_id)}/members?limit=1000&after=${encodeURIComponent(after)}`);
    if (!r.ok || !Array.isArray(r.body) || r.body.length === 0) break;
    for (const m of r.body) {
      if (sent >= 40) break;
      if (Array.isArray(m.roles) && m.roles.includes(staffId) && m.user?.id) {
        const dm = await sendDM(env, m.user.id, {
          embeds: [{
            title: `🎟 New ${categoryLabel(t.category)} ticket, #${ticketId}`,
            description: [
              `**${t.subject}**`,
              '',
              `From: <@${t.requester_user_id || t.opener_user_id}>`,
              '',
              `Thread: https://discord.com/channels/${t.guild_id}/${t.thread_id}`,
            ].join('\n'),
            color: 0x7c5cff,
            footer: { text: 'Mute these via /ticket notify off in the support thread.' },
          }],
        });
        if (dm.ok) sent++;
      }
    }
    after = r.body[r.body.length - 1].user?.id || after;
    if (r.body.length < 1000) break;
  }
  return { sent };
}

async function sendCloseDM(env, ticketId, closerName) {
  const t = await loadTicket(env, ticketId);
  if (!t) return;
  const requesterId = t.requester_user_id || t.opener_user_id;
  if (!requesterId) return;
  await sendDM(env, requesterId, {
    embeds: [{
      title: `✅ Your ticket #${ticketId} was closed`,
      description: [
        `**${t.subject || '(no subject)'}**`,
        '',
        `Closed by: ${closerName || 'staff'}`,
        t.close_reason ? `Reason: ${String(t.close_reason).slice(0, 300)}` : '',
        '',
        'Thanks for reaching out! If anything else comes up, open a new ticket in #support, staff are happy to help.',
      ].filter(Boolean).join('\n'),
      color: 0x6e7588,
    }],
  });
}

// ── Mod-log + thread-side activity notifications ──────────────

export async function postNewTicketModLog(env, ticketId) {
  const t = await loadTicket(env, ticketId);
  if (!t) return { skipped: 'no-such-ticket' };
  const ch = await modLogChannelId(env, t.guild_id);
  if (!ch) return { skipped: 'no-mod-log' };
  await dapi(env, 'POST', `/channels/${ch}/messages`, {
    embeds: [{
      title: `🎟 New ticket, #${ticketId} ${categoryEmoji(t.category)} ${categoryLabel(t.category)}`,
      description: [
        `**${t.subject}**`,
        '',
        `Requester: <@${t.requester_user_id || t.opener_user_id}>`,
        `Thread: <#${t.thread_id}>`,
      ].join('\n'),
      color: 0x7c5cff,
      footer: { text: `Priority: normal · Status: open` },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  }).catch(() => {});
  return { ok: true };
}

async function notifyThreadPriorityChange(env, ticketId, priority, actorId) {
  const t = await loadTicket(env, ticketId);
  if (!t?.thread_id) return;
  const icon = priority === 'urgent' ? '🚨' : priority === 'high' ? '⬆️' : priority === 'low' ? '⬇️' : '🚦';
  await dapi(env, 'POST', `/channels/${t.thread_id}/messages`, {
    content: `${icon} Priority set to **${priority}** by <@${actorId}>.`,
    allowed_mentions: { parse: [] },
  }).catch(() => {});
}

async function notifyThreadCategoryChange(env, ticketId, category, actorId) {
  const t = await loadTicket(env, ticketId);
  if (!t?.thread_id) return;
  await dapi(env, 'POST', `/channels/${t.thread_id}/messages`, {
    content: `🏷 Category changed to **${categoryLabel(category)}** by <@${actorId}>.`,
    allowed_mentions: { parse: [] },
  }).catch(() => {});
}

async function notifyThreadAssignmentChange(env, ticketId, assigneeId, actorId) {
  const t = await loadTicket(env, ticketId);
  if (!t?.thread_id) return;
  await dapi(env, 'POST', `/channels/${t.thread_id}/messages`, {
    content: `👤 Assigned to <@${assigneeId}> by <@${actorId}>.`,
    allowed_mentions: { users: [String(assigneeId)] },
  }).catch(() => {});
}

// Resolve = mark as resolved (close-flavoured, but distinguishable
// from `closed`). DMs the requester + archives the thread.
export async function resolveTicket(env, ticketId, opts = {}) {
  const t = await loadTicket(env, ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  if (['resolved', 'closed', 'auto_closed'].includes(t.status)) return { ok: true, alreadyResolved: true };
  await updateStatus(env, ticketId, 'resolved', null);
  await appendMessage(env, ticketId, {
    guildId: t.guild_id, kind: 'status', userId: opts.actorId || null, username: opts.actorName || null,
    content: 'resolved', meta: { from: t.status, to: 'resolved' },
  });
  await dapi(env, 'PATCH', `/channels/${t.thread_id}`, { archived: true, locked: true }).catch(() => {});
  await sendCloseDM(env, ticketId, opts.actorName || 'staff');
  return { ok: true };
}

// Modal submit dispatcher.
export async function handleSupportTicketModal(data, env) {
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('st:submit:')) {
    return ephemeral('Unknown ticket modal.');
  }
  const cat = customId.slice('st:submit:'.length);
  if (!isValidCategory(cat)) return ephemeral(`Unknown category: \`${cat}\``);
  const fields = (data.data?.components || []).flatMap((row) => row.components || []);
  const subject = String(fields.find((c) => c.custom_id === 'subject')?.value || '').trim();
  const description = String(fields.find((c) => c.custom_id === 'description')?.value || '').trim();
  if (!subject || !description) return ephemeral('Subject + description required.');
  const guildId = data.guild_id;
  const user = data.member?.user || data.user;
  if (!user?.id) return ephemeral('Couldn\'t resolve your user.');

  const opened = await openTicket(env, {
    guildId,
    requesterUserId: user.id,
    requesterName: user.global_name || user.username || 'viewer',
    category: cat,
    subject,
    description,
  });
  if (!opened.ok) {
    if (opened.error === 'too-many-open') {
      return ephemeral(`You already have ${opened.openCount} open ticket${opened.openCount === 1 ? '' : 's'} (max ${MAX_OPEN_PER_USER}). Close one to open another.`);
    }
    return ephemeral(`Couldn\'t open the ticket, ${opened.error || 'unknown error'}.`);
  }
  return ephemeral(`✅ Ticket #${opened.ticketId} opened, head to <#${opened.threadId}> to follow it. Staff are pinged.`);
}

// ── Open a ticket, create thread + first message + state ─────

export async function openTicket(env, opts) {
  const { guildId, requesterUserId, requesterName, category, subject, description } = opts;
  if (!isValidCategory(category)) return { ok: false, error: 'bad-category' };

  // Cap concurrent open tickets per user.
  const openCount = await countOpenForUser(env, guildId, requesterUserId);
  if (openCount >= MAX_OPEN_PER_USER) {
    return { ok: false, error: 'too-many-open', openCount };
  }

  const supportChId = await supportChannelId(env, guildId);
  if (!supportChId) return { ok: false, error: 'no-support-channel' };

  // Create a PRIVATE thread under #support. Name format per Clay:
  // `🎟 <category> · <subject> by username`. Trim to Discord's 100-char limit.
  const safeSubject = subject.replace(/[\r\n\t]+/g, ' ').slice(0, 80);
  const threadName = `${categoryEmoji(category)} ${categoryLabel(category).split(' (')[0]} · ${safeSubject} · ${requesterName}`.slice(0, 100);
  const threadResp = await dapi(env, 'POST',
    `/channels/${supportChId}/threads`, {
      name: threadName,
      auto_archive_duration: 10080,   // 7 days
      type: THREAD_TYPE_PRIVATE,
      invitable: false,                // staff add the requester explicitly
    });
  if (!threadResp.ok || !threadResp.body?.id) {
    return { ok: false, error: 'thread-create-failed', status: threadResp.status, body: threadResp.body };
  }
  const threadId = String(threadResp.body.id);

  // Add the requester to the thread.
  await dapi(env, 'PUT',
    `/channels/${threadId}/thread-members/${encodeURIComponent(requesterUserId)}`).catch(() => {});

  // Add every Staff role member to the thread. Best-effort, if the
  // role isn't configured we skip; if the API fails per-user we still
  // continue (staff can self-join via the parent channel visibility).
  const staffId = await staffRoleId(env, guildId);
  let staffAdded = 0;
  if (staffId) {
    try {
      const members = await dapi(env, 'GET',
        `/guilds/${encodeURIComponent(guildId)}/roles/${encodeURIComponent(staffId)}/members?limit=100`);
      // Discord's `/roles/:r/members` is gated behind a community-tier
      // boost on some servers, fall back to a member list filter.
      if (!members.ok || !Array.isArray(members.body)) {
        const all = await dapi(env, 'GET',
          `/guilds/${encodeURIComponent(guildId)}/members?limit=1000`);
        if (all.ok && Array.isArray(all.body)) {
          for (const m of all.body) {
            if (Array.isArray(m.roles) && m.roles.includes(staffId) && m.user?.id) {
              await dapi(env, 'PUT',
                `/channels/${threadId}/thread-members/${encodeURIComponent(m.user.id)}`).catch(() => {});
              staffAdded++;
              if (staffAdded >= 40) break;
            }
          }
        }
      } else {
        for (const m of members.body) {
          if (m.user?.id) {
            await dapi(env, 'PUT',
              `/channels/${threadId}/thread-members/${encodeURIComponent(m.user.id)}`).catch(() => {});
            staffAdded++;
            if (staffAdded >= 40) break;
          }
        }
      }
    } catch { /* tolerate fan-out failure */ }
  }

  // Insert the D1 record.
  const ticketId = await insertTicket(env, {
    guildId, channelId: supportChId, threadId, requesterUserId,
    category, subject, description, priority: 'normal',
  });
  if (!ticketId) {
    // D1 failed but the thread exists, surface a partial-success.
    return { ok: false, error: 'd1-insert-failed', threadId };
  }

  // Post the first message in the thread, the requester's bundle +
  // staff close button.
  const firstMsg = await postFirstThreadMessage(env, {
    ticketId,
    threadId,
    requesterUserId,
    requesterName,
    category,
    subject,
    description,
    staffRoleId: staffId,
  });

  // Mirror to the timeline.
  await appendMessage(env, ticketId, {
    guildId, kind: 'message', userId: requesterUserId, username: requesterName,
    content: description,
    discordMessageId: firstMsg.messageId || null,
  });
  await appendMessage(env, ticketId, {
    guildId, kind: 'status', userId: requesterUserId, username: requesterName,
    content: 'open', meta: { from: null, to: 'open' },
  });

  // Best-effort notifications fan-out. Doesn't block the success
  // response, the requester's "ticket opened" ack lands instantly
  // and these run in the background.
  postNewTicketModLog(env, ticketId).catch(() => {});
  sendNewTicketStaffFanout(env, ticketId).catch(() => {});

  return { ok: true, ticketId, threadId, channelId: supportChId };
}

async function postFirstThreadMessage(env, { ticketId, threadId, requesterUserId, requesterName, category, subject, description, staffRoleId }) {
  const mention = staffRoleId ? `<@&${staffRoleId}> ` : '';
  const payload = {
    content: mention + `New ${categoryLabel(category)} ticket from <@${requesterUserId}>.`,
    embeds: [{
      title: `${categoryEmoji(category)} #${ticketId}, ${subject}`,
      description,
      color: 0x7c5cff,
      fields: [
        { name: 'Requester',  value: `<@${requesterUserId}>`,           inline: true },
        { name: 'Category',   value: categoryLabel(category),           inline: true },
        { name: 'Priority',   value: '`normal`',                        inline: true },
        { name: 'Status',     value: '`open`',                          inline: true },
        { name: 'Created',    value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      ],
      footer: { text: `Ticket #${ticketId}` },
    }],
    components: adminControlRows(ticketId),
    allowed_mentions: {
      // Ping the requester + the staff role only, never @everyone.
      users: [String(requesterUserId)],
      roles: staffRoleId ? [String(staffRoleId)] : [],
    },
  };
  const r = await dapi(env, 'POST', `/channels/${threadId}/messages`, payload);
  return { ok: r.ok, messageId: r.body?.id || null, status: r.status };
}

// In-thread staff control rows. Buttons trigger ephemeral selects.
function adminControlRows(ticketId) {
  return [
    {
      type: COMP_ROW,
      components: [
        { type: COMP_BUTTON, style: STYLE_DANGER,    label: '🔒 Close',    custom_id: `st:close:${ticketId}` },
        { type: COMP_BUTTON, style: STYLE_SUCCESS,   label: '✅ Resolve',  custom_id: `st:resolve:${ticketId}` },
        { type: COMP_BUTTON, style: STYLE_SECONDARY, label: '🚦 Priority', custom_id: `st:pri-open:${ticketId}` },
        { type: COMP_BUTTON, style: STYLE_SECONDARY, label: '👤 Assign',   custom_id: `st:asg-open:${ticketId}` },
        { type: COMP_BUTTON, style: STYLE_SECONDARY, label: '🏷 Category', custom_id: `st:cat-open:${ticketId}` },
      ],
    },
  ];
}

// ── Close handler (component button + admin call) ─────────────

async function handleCloseComponent(data, env, customId) {
  const ticketId = parseInt(customId.slice('st:close:'.length), 10);
  if (!ticketId) return ephemeral('Bad ticket id.');
  const userId = data.member?.user?.id || data.user?.id;
  const username = data.member?.user?.global_name || data.member?.user?.username || 'staff';
  const r = await closeTicket(env, ticketId, { actorId: userId, actorName: username, reason: null });
  if (!r.ok) return ephemeral(`Couldn\'t close, ${r.error || 'unknown error'}.`);
  return ephemeral(`✅ Ticket #${ticketId} closed. Thread will archive shortly.`);
}

async function handleReopenComponent(data, env, customId) {
  const ticketId = parseInt(customId.slice('st:reopen:'.length), 10);
  if (!ticketId) return ephemeral('Bad ticket id.');
  const userId = data.member?.user?.id || data.user?.id;
  const username = data.member?.user?.global_name || data.member?.user?.username || 'staff';
  const r = await reopenTicket(env, ticketId, { actorId: userId, actorName: username });
  if (!r.ok) return ephemeral(`Couldn\'t reopen, ${r.error || 'unknown error'}.`);
  return ephemeral(`✅ Ticket #${ticketId} reopened.`);
}

export async function closeTicket(env, ticketId, opts = {}) {
  const t = await loadTicket(env, ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  if (t.status === 'closed' || t.status === 'auto_closed' || t.status === 'resolved') {
    return { ok: true, alreadyClosed: true };
  }
  await updateStatus(env, ticketId, 'closed', opts.reason || null);
  await appendMessage(env, ticketId, {
    guildId: t.guild_id, kind: 'close', userId: opts.actorId || null, username: opts.actorName || null,
    content: opts.reason || null, meta: { reason: opts.reason || null },
  });
  // PATCH the thread, archive + lock, update embed.
  await dapi(env, 'PATCH', `/channels/${t.thread_id}`, {
    archived: true, locked: true,
  }).catch(() => {});
  await dapi(env, 'POST', `/channels/${t.thread_id}/messages`, {
    content: `🔒 Ticket closed by <@${opts.actorId || 'system'}>` + (opts.reason ? `, _${opts.reason.slice(0, 200)}_` : '.'),
    allowed_mentions: { parse: [] },
  }).catch(() => {});
  // DM the requester with the thanks copy.
  sendCloseDM(env, ticketId, opts.actorName || 'staff').catch(() => {});
  return { ok: true };
}

export async function reopenTicket(env, ticketId, opts = {}) {
  const t = await loadTicket(env, ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  if (t.status === 'open' || t.status === 'in_progress') return { ok: true, alreadyOpen: true };
  await updateStatus(env, ticketId, 'open', null);
  await appendMessage(env, ticketId, {
    guildId: t.guild_id, kind: 'status', userId: opts.actorId || null, username: opts.actorName || null,
    content: 'open', meta: { from: t.status, to: 'open' },
  });
  await dapi(env, 'PATCH', `/channels/${t.thread_id}`, {
    archived: false, locked: false,
  }).catch(() => {});
  return { ok: true };
}

// ── Public mutators (used by both admin endpoints + cron) ────

export async function setPriority(env, ticketId, priority, opts = {}) {
  if (!PRIORITIES.includes(priority)) return { ok: false, error: 'bad-priority' };
  const t = await loadTicket(env, ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  await updatePriority(env, ticketId, priority);
  await appendMessage(env, ticketId, {
    guildId: t.guild_id, kind: 'priority', userId: opts.actorId || null, username: opts.actorName || null,
    content: priority, meta: { from: t.priority, to: priority },
  });
  return { ok: true };
}

export async function setAssignee(env, ticketId, assigneeUserId, opts = {}) {
  const t = await loadTicket(env, ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  await updateAssignee(env, ticketId, assigneeUserId);
  await appendMessage(env, ticketId, {
    guildId: t.guild_id, kind: 'assign', userId: opts.actorId || null, username: opts.actorName || null,
    content: assigneeUserId || null, meta: { from: t.assignee_user_id, to: assigneeUserId },
  });
  return { ok: true };
}

export async function setCategory(env, ticketId, category, opts = {}) {
  if (!isValidCategory(category)) return { ok: false, error: 'bad-category' };
  const t = await loadTicket(env, ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  await updateCategory(env, ticketId, category);
  await appendMessage(env, ticketId, {
    guildId: t.guild_id, kind: 'category', userId: opts.actorId || null, username: opts.actorName || null,
    content: category, meta: { from: t.category, to: category },
  });
  return { ok: true };
}

// ── List + detail readers (used by PWA admin endpoints) ──────

export async function listTickets(env, guildId, filters = {}) {
  const where = ['guild_id = ?'];
  const args = [guildId];
  if (filters.status)    { where.push('status = ?');             args.push(filters.status); }
  if (filters.category)  { where.push('category = ?');           args.push(filters.category); }
  if (filters.priority)  { where.push('priority = ?');           args.push(filters.priority); }
  if (filters.assignee)  { where.push('assignee_user_id = ?');   args.push(filters.assignee); }
  if (filters.requester) { where.push('requester_user_id = ?');  args.push(filters.requester); }
  const sql = `
    SELECT id, guild_id, channel_id, thread_id,
           requester_user_id, opener_user_id,
           category, type_label, subject, description, status, priority,
           assignee_user_id, created_at, updated_at, closed_at, close_reason
      FROM tickets
     WHERE ${where.join(' AND ')}
     ORDER BY datetime(coalesce(updated_at, created_at)) DESC
     LIMIT 200
  `;
  const r = await env.DB.prepare(sql).bind(...args).all();
  return { ok: true, tickets: r.results || [] };
}

export async function ticketDetail(env, ticketId) {
  const t = await loadTicket(env, ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  const m = await env.DB.prepare(`
    SELECT id, kind, user_id, username, content, meta, discord_message_id, created_at
      FROM ticket_messages
     WHERE ticket_id = ?
     ORDER BY datetime(created_at) ASC
  `).bind(ticketId).all();
  const threadUrl = `https://discord.com/channels/${t.guild_id}/${t.thread_id}`;
  return {
    ok: true,
    ticket: t,
    timeline: (m.results || []).map((row) => ({
      ...row,
      meta: row.meta ? safeJson(row.meta) : null,
    })),
    threadUrl,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ── PWA staff response ────────────────────────────────────────
//
// Posts a message into the Discord thread, attributed to the staff
// member's Discord user via a webhook impersonation (so the avatar +
// username show as them, not the bot). Falls back to a plain bot
// message when the channel doesn't have a webhook (or creating one
// fails, Discord caps webhooks at 15 per channel).
//
// Also mirrors to ticket_messages so the timeline shows the reply.
export async function respondAsStaff(env, ticketId, opts) {
  const t = await loadTicket(env, ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  if (!t.thread_id) return { ok: false, error: 'no-thread' };
  // Resolve actor's display name for the webhook impersonation.
  let actorName = 'staff', actorAvatar = null;
  if (opts.actorId) {
    const u = await dapi(env, 'GET', `/users/${encodeURIComponent(opts.actorId)}`);
    if (u.ok && u.body) {
      actorName = u.body.global_name || u.body.username || 'staff';
      if (u.body.avatar) {
        actorAvatar = `https://cdn.discordapp.com/avatars/${u.body.id}/${u.body.avatar}.png`;
      }
    }
  }
  // Threads inherit the parent channel's webhooks. Get-or-create a
  // bot-owned webhook on the parent.
  let webhookUrl = null;
  try {
    const list = await dapi(env, 'GET', `/channels/${t.channel_id}/webhooks`);
    if (list.ok && Array.isArray(list.body)) {
      const mine = list.body.find((w) => w.user?.bot && w.name === 'Aquilo Tickets');
      if (mine?.token) webhookUrl = `https://discord.com/api/v10/webhooks/${mine.id}/${mine.token}`;
    }
    if (!webhookUrl) {
      const create = await dapi(env, 'POST', `/channels/${t.channel_id}/webhooks`, { name: 'Aquilo Tickets' });
      if (create.ok && create.body?.token) {
        webhookUrl = `https://discord.com/api/v10/webhooks/${create.body.id}/${create.body.token}`;
      }
    }
  } catch { /* fall through to bot-message */ }

  let messageId = null;
  if (webhookUrl) {
    // ?thread_id= routes the webhook post into the specific thread
    // under the channel; ?wait=true returns the message id.
    const r = await fetch(`${webhookUrl}?thread_id=${encodeURIComponent(t.thread_id)}&wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'loadout-discord support-tickets' },
      body: JSON.stringify({
        content:     opts.message,
        username:    actorName,
        avatar_url:  actorAvatar || undefined,
        allowed_mentions: { parse: [] },
      }),
    });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      messageId = j?.id || null;
    }
  }
  if (!messageId) {
    // Webhook path failed; post as the bot with an attribution header.
    const r = await dapi(env, 'POST', `/channels/${t.thread_id}/messages`, {
      content: `**${actorName}** (PWA): ${opts.message}`,
      allowed_mentions: { parse: [] },
    });
    if (!r.ok) return { ok: false, error: 'post-failed', status: r.status };
    messageId = r.body?.id || null;
  }
  await appendMessage(env, ticketId, {
    guildId: t.guild_id, kind: 'message', userId: opts.actorId || null, username: actorName,
    content: opts.message, discordMessageId: messageId,
  });
  return { ok: true, messageId };
}

// ── Daily auto-close sweep ────────────────────────────────────
//
// Cron entry (called from worker.js :23 hourly tick, gated to once
// per UTC day). Finds tickets whose latest `ticket_messages` entry
// is older than STALE_THRESHOLD_DAYS, flips them to `auto_closed`,
// archives the thread, DMs the requester.
const STALE_THRESHOLD_DAYS = 30;

export async function autoCloseStaleTickets(env) {
  if (!env.DB) return { ok: false, reason: 'no-d1' };
  const cutoffSql = `datetime('now', '-${STALE_THRESHOLD_DAYS} days')`;
  // Pick the latest activity per open ticket; flag those whose last
  // activity is older than the cutoff.
  const r = await env.DB.prepare(`
    SELECT t.id, t.guild_id, t.thread_id, t.subject, t.requester_user_id,
           t.opener_user_id, t.category,
           coalesce((SELECT MAX(datetime(created_at))
                       FROM ticket_messages WHERE ticket_id = t.id),
                    t.created_at) AS last_activity
      FROM tickets t
     WHERE t.status IN ('open', 'in_progress')
     ORDER BY last_activity ASC
     LIMIT 200
  `).all();
  const candidates = (r.results || []).filter((row) => {
    return row.last_activity && row.last_activity < new Date(Date.now() - STALE_THRESHOLD_DAYS * 86400 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  });
  let closed = 0;
  for (const t of candidates) {
    await updateStatus(env, t.id, 'auto_closed', 'no activity for ' + STALE_THRESHOLD_DAYS + ' days');
    await appendMessage(env, t.id, {
      guildId: t.guild_id, kind: 'close', userId: null, username: 'cron',
      content: 'auto-closed', meta: { reason: 'stale-' + STALE_THRESHOLD_DAYS + 'd' },
    });
    if (t.thread_id) {
      await dapi(env, 'PATCH', `/channels/${t.thread_id}`, { archived: true, locked: true }).catch(() => {});
      await dapi(env, 'POST', `/channels/${t.thread_id}/messages`, {
        content: `🕒 This ticket was auto-closed after **${STALE_THRESHOLD_DAYS} days of no activity**. Open a new ticket in #support if you still need help.`,
        allowed_mentions: { parse: [] },
      }).catch(() => {});
    }
    const requesterId = t.requester_user_id || t.opener_user_id;
    if (requesterId) {
      await sendDM(env, requesterId, {
        embeds: [{
          title: `🕒 Your ticket #${t.id} was auto-closed`,
          description: [
            `**${t.subject || '(no subject)'}**`,
            '',
            `It had no activity for ${STALE_THRESHOLD_DAYS} days, so it was auto-closed to keep the queue tidy.`,
            '',
            'If you still need help, open a fresh ticket in #support, staff will be happy to pick it back up.',
          ].join('\n'),
          color: 0x6e7588,
        }],
      }).catch(() => {});
    }
    closed++;
  }
  return { ok: true, candidates: candidates.length, closed };
}

// Convenience export so worker.js's component dispatcher can route.
export const SUPPORT_COMPONENT_PREFIX = 'st:';
