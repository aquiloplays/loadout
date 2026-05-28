// Support ticket system v2 (Clay 2026-05-28).
//
// Architecture per the spec:
//   • A persistent "Open a Ticket" message in #support
//     (1505948032187760640 for the Aquilo guild) — string-select picks
//     a category, button opens a modal for {subject, description}.
//   • On submit: bot creates a PRIVATE THREAD in #support
//     (`PRIVATE_THREAD` type = 12) named `🎟 <category> · <subject>`
//     and adds the requester + every Staff role member.
//   • Bot posts the requester's submission as the first thread message
//     plus a closing pill — staff use in-thread component buttons to
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
// Categories — fixed catalogue (NOT per-guild configurable). The
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
// Auto-close: daily :23 cron sweep — tickets with no `ticket_messages`
// activity in 30 days flip to status='auto_closed' + send a DM to the
// requester. Re-open via reply detected in thread MESSAGE_CREATE
// (out of scope for v1 — manual /ticket reopen for now).

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
  return id || env.STAFF_ROLE_ID || STAFF_ROLE_ID_FALLBACK || null;
}

async function supportChannelId(env, guildId) {
  let id = null;
  try { id = await env.LOADOUT_BOLTS.get(`support-tickets:channel:${guildId}`); }
  catch { /* ignore */ }
  return id || env.SUPPORT_CHANNEL_ID || '1505948032187760640';
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
        '**Need help with something?** Pick a category below and click **Open Ticket** — a private thread will open here just for you and the staff team.',
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
      // Button is informational — pressing it without a category just
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

// Single entry point — routes `st:*` custom_ids. Returns a Discord
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
    return ephemeral('Pick a category from the select menu first 👆 — then the **Open Ticket** modal will appear.');
  }

  // In-thread admin component buttons (close, assign, priority, recat).
  if (customId.startsWith('st:close:')) {
    return await handleCloseComponent(data, env, customId);
  }
  if (customId.startsWith('st:reopen:')) {
    return await handleReopenComponent(data, env, customId);
  }

  return ephemeral(`Unknown ticket action: \`${customId}\``);
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
    return ephemeral(`Couldn\'t open the ticket — ${opened.error || 'unknown error'}.`);
  }
  return ephemeral(`✅ Ticket #${opened.ticketId} opened — head to <#${opened.threadId}> to follow it. Staff are pinged.`);
}

// ── Open a ticket — create thread + first message + state ─────

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

  // Add every Staff role member to the thread. Best-effort — if the
  // role isn't configured we skip; if the API fails per-user we still
  // continue (staff can self-join via the parent channel visibility).
  const staffId = await staffRoleId(env, guildId);
  let staffAdded = 0;
  if (staffId) {
    try {
      const members = await dapi(env, 'GET',
        `/guilds/${encodeURIComponent(guildId)}/roles/${encodeURIComponent(staffId)}/members?limit=100`);
      // Discord's `/roles/:r/members` is gated behind a community-tier
      // boost on some servers — fall back to a member list filter.
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
    // D1 failed but the thread exists — surface a partial-success.
    return { ok: false, error: 'd1-insert-failed', threadId };
  }

  // Post the first message in the thread — the requester's bundle +
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

  return { ok: true, ticketId, threadId, channelId: supportChId };
}

async function postFirstThreadMessage(env, { ticketId, threadId, requesterUserId, requesterName, category, subject, description, staffRoleId }) {
  const mention = staffRoleId ? `<@&${staffRoleId}> ` : '';
  const payload = {
    content: mention + `New ${categoryLabel(category)} ticket from <@${requesterUserId}>.`,
    embeds: [{
      title: `${categoryEmoji(category)} #${ticketId} — ${subject}`,
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
    components: [{
      type: COMP_ROW,
      components: [{
        type:  COMP_BUTTON,
        style: STYLE_DANGER,
        label: '🔒 Close ticket',
        custom_id: `st:close:${ticketId}`,
      }],
    }],
    allowed_mentions: {
      // Ping the requester + the staff role only — never @everyone.
      users: [String(requesterUserId)],
      roles: staffRoleId ? [String(staffRoleId)] : [],
    },
  };
  const r = await dapi(env, 'POST', `/channels/${threadId}/messages`, payload);
  return { ok: r.ok, messageId: r.body?.id || null, status: r.status };
}

// ── Close handler (component button + admin call) ─────────────

async function handleCloseComponent(data, env, customId) {
  const ticketId = parseInt(customId.slice('st:close:'.length), 10);
  if (!ticketId) return ephemeral('Bad ticket id.');
  const userId = data.member?.user?.id || data.user?.id;
  const username = data.member?.user?.global_name || data.member?.user?.username || 'staff';
  const r = await closeTicket(env, ticketId, { actorId: userId, actorName: username, reason: null });
  if (!r.ok) return ephemeral(`Couldn\'t close — ${r.error || 'unknown error'}.`);
  return ephemeral(`✅ Ticket #${ticketId} closed. Thread will archive shortly.`);
}

async function handleReopenComponent(data, env, customId) {
  const ticketId = parseInt(customId.slice('st:reopen:'.length), 10);
  if (!ticketId) return ephemeral('Bad ticket id.');
  const userId = data.member?.user?.id || data.user?.id;
  const username = data.member?.user?.global_name || data.member?.user?.username || 'staff';
  const r = await reopenTicket(env, ticketId, { actorId: userId, actorName: username });
  if (!r.ok) return ephemeral(`Couldn\'t reopen — ${r.error || 'unknown error'}.`);
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
  // PATCH the thread — archive + lock, update embed.
  await dapi(env, 'PATCH', `/channels/${t.thread_id}`, {
    archived: true, locked: true,
  }).catch(() => {});
  await dapi(env, 'POST', `/channels/${t.thread_id}/messages`, {
    content: `🔒 Ticket closed by <@${opts.actorId || 'system'}>` + (opts.reason ? ` — _${opts.reason.slice(0, 200)}_` : '.'),
    allowed_mentions: { parse: [] },
  }).catch(() => {});
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

// Convenience export so worker.js's component dispatcher can route.
export const SUPPORT_COMPONENT_PREFIX = 'st:';
