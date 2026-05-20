// Ticketing system. Fully customizable per-guild:
//   - panel title/description (the public message viewers click)
//   - staff role (sees every ticket, can close)
//   - category (where ticket channels are created)
//   - log channel (close events logged here)
//   - ticket types (label + emoji + description + optional ping role)
//
// Flow:
//   admin /hub → Tickets section → Configure / Add Type / Post Panel
//   viewer clicks a panel button → bot creates a private channel
//     (only viewer + staff + bot can see it), posts a welcome message
//     with a Close button, pings staff
//   staff clicks Close → channel locks + renames to "closed-…", a
//     Delete button appears; staff Delete → channel removed, logged
//
// Bot must have **Manage Channels** to create/edit/delete ticket
// channels, and its role should sit above the channels it manages.

import {
  ephemeral, chat, postChannelMessage, discordFetch,
  modal, getModalField, btn, row, isAdmin,
  BTN_PRIMARY, BTN_SECONDARY, BTN_SUCCESS, BTN_DANGER,
  COLOR_SCHEDULE
} from './util.js';
import { ensureBootstrap } from './bootstrap.js';

// Discord permission bits
const P_VIEW_CHANNEL   = 1 << 10;  // 1024
const P_SEND_MESSAGES  = 1 << 11;  // 2048
const P_EMBED_LINKS    = 1 << 14;  // 16384
const P_ATTACH_FILES   = 1 << 15;  // 32768
const P_READ_HISTORY   = 1 << 16;  // 65536
const TICKET_ALLOW = String(P_VIEW_CHANNEL | P_SEND_MESSAGES | P_EMBED_LINKS | P_ATTACH_FILES | P_READ_HISTORY); // 117760
const VIEW_ONLY    = String(P_VIEW_CHANNEL);

// ---- D1: config --------------------------------------------------------

async function getTicketConfig(env, guildId) {
  const row = await env.DB.prepare('SELECT * FROM ticket_config WHERE guild_id = ?')
    .bind(guildId).first();
  return row || {
    guild_id: guildId,
    panel_title: 'Support Tickets',
    panel_description: 'Need help? Pick a category below to open a private ticket. Staff will be with you shortly.',
    staff_role_id: null, category_id: null, log_channel_id: null,
    panel_channel_id: null, panel_message_id: null
  };
}

async function saveTicketConfig(env, guildId, patch) {
  const cur = await getTicketConfig(env, guildId);
  const n = { ...cur, ...patch, guild_id: guildId };
  await env.DB.prepare(
    `INSERT INTO ticket_config
       (guild_id, panel_title, panel_description, staff_role_id, category_id, log_channel_id, panel_channel_id, panel_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       panel_title = excluded.panel_title,
       panel_description = excluded.panel_description,
       staff_role_id = excluded.staff_role_id,
       category_id = excluded.category_id,
       log_channel_id = excluded.log_channel_id,
       panel_channel_id = excluded.panel_channel_id,
       panel_message_id = excluded.panel_message_id`
  ).bind(n.guild_id, n.panel_title, n.panel_description, n.staff_role_id,
         n.category_id, n.log_channel_id, n.panel_channel_id, n.panel_message_id).run();
  return n;
}

async function listTicketTypes(env, guildId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY sort_order, id'
  ).bind(guildId).all();
  return results || [];
}

// ---- Admin: modals -----------------------------------------------------

export async function ticketConfigModal(env, guildId) {
  const c = await getTicketConfig(env, guildId);
  return modal('modal:ticket_config', 'Ticket Panel Config', [
    { custom_id: 'panel_title',       label: 'Panel title',                style: 1, required: true,  max_length: 100, value: c.panel_title || undefined },
    { custom_id: 'panel_description', label: 'Panel description',          style: 2, required: true,  max_length: 1000, value: c.panel_description || undefined },
    { custom_id: 'staff_role_id',     label: 'Staff role ID',              style: 1, required: true,  max_length: 25, value: c.staff_role_id || undefined, placeholder: 'Sees every ticket + can close' },
    { custom_id: 'category_id',       label: 'Ticket category ID',         style: 1, required: false, max_length: 25, value: c.category_id || undefined, placeholder: 'Channel category new tickets go under' },
    { custom_id: 'log_channel_id',    label: 'Log channel ID (optional)',  style: 1, required: false, max_length: 25, value: c.log_channel_id || undefined, placeholder: 'Close events logged here' }
  ]);
}

export function ticketTypeAddModal() {
  return modal('modal:ticket_type_add', 'Add a Ticket Type', [
    { custom_id: 'label',        label: 'Label (button text)',       style: 1, required: true,  max_length: 60, placeholder: 'e.g. General Support' },
    { custom_id: 'emoji',        label: 'Emoji (optional)',          style: 1, required: false, max_length: 8,  placeholder: '🆘' },
    { custom_id: 'description',  label: 'Short description',         style: 1, required: false, max_length: 100, placeholder: 'Shown under the panel' },
    { custom_id: 'ping_role_id', label: 'Ping role ID (optional)',   style: 1, required: false, max_length: 25, placeholder: 'Pinged when this ticket opens' }
  ]);
}

export function ticketTypeRemoveModal() {
  return modal('modal:ticket_type_remove', 'Remove a Ticket Type', [
    { custom_id: 'label', label: 'Label (exact match)', style: 1, required: true, max_length: 60 }
  ]);
}

// ---- Admin: modal submit handlers --------------------------------------

export async function handleTicketConfigSubmit(env, data) {
  const guildId = await ensureBootstrap(env);
  const staffRole = (getModalField(data, 'staff_role_id') || '').trim();
  if (!/^\d{15,25}$/.test(staffRole)) {
    return ephemeral('⚠️ Staff role ID must be a Discord role ID (15-25 digit number).');
  }
  await saveTicketConfig(env, guildId, {
    panel_title:       (getModalField(data, 'panel_title') || '').trim() || 'Support Tickets',
    panel_description: (getModalField(data, 'panel_description') || '').trim(),
    staff_role_id:     staffRole,
    category_id:       (getModalField(data, 'category_id') || '').trim() || null,
    log_channel_id:    (getModalField(data, 'log_channel_id') || '').trim() || null
  });
  return ephemeral('🎫 Ticket config saved. Add types with **➕ Add Type**, then **📤 Post Panel**.');
}

export async function handleTicketTypeAddSubmit(env, data) {
  const guildId = await ensureBootstrap(env);
  const label = (getModalField(data, 'label') || '').trim();
  if (!label) return ephemeral('Label required.');
  const types = await listTicketTypes(env, guildId);
  if (types.length >= 20) return ephemeral('Max 20 ticket types.');
  if (types.some(t => t.label.toLowerCase() === label.toLowerCase())) {
    return ephemeral('A type called **' + label + '** already exists.');
  }
  await env.DB.prepare(
    'INSERT INTO ticket_types (guild_id, label, emoji, description, ping_role_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    guildId, label,
    (getModalField(data, 'emoji') || '').trim() || null,
    (getModalField(data, 'description') || '').trim() || null,
    (getModalField(data, 'ping_role_id') || '').trim() || null,
    types.length
  ).run();
  return ephemeral('✅ Added ticket type **' + label + '**. Re-post the panel (**📤 Post Panel**) to show it.');
}

export async function handleTicketTypeRemoveSubmit(env, data) {
  const guildId = await ensureBootstrap(env);
  const label = (getModalField(data, 'label') || '').trim();
  const r = await env.DB.prepare(
    'DELETE FROM ticket_types WHERE guild_id = ? AND label = ?'
  ).bind(guildId, label).run();
  if ((r.meta?.changes || 0) === 0) return ephemeral('No ticket type called **' + label + '**.');
  return ephemeral('🗑️ Removed **' + label + '**. Re-post the panel to update it.');
}

export async function listTicketTypesEphemeral(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const guildId = await ensureBootstrap(env);
  const c = await getTicketConfig(env, guildId);
  const types = await listTicketTypes(env, guildId);
  const lines = [];
  lines.push('**🎫 Ticket setup**');
  lines.push('• Staff role: ' + (c.staff_role_id ? '<@&' + c.staff_role_id + '>' : '_unset — Configure first_'));
  lines.push('• Category: ' + (c.category_id ? '`' + c.category_id + '`' : '_unset (tickets created at top level)_'));
  lines.push('• Log channel: ' + (c.log_channel_id ? '<#' + c.log_channel_id + '>' : '_unset_'));
  lines.push('');
  lines.push('**Types (' + types.length + '):**');
  if (!types.length) lines.push('_none — add some with ➕ Add Type_');
  else for (const t of types) {
    lines.push('• ' + (t.emoji ? t.emoji + ' ' : '') + '**' + t.label + '**' +
      (t.description ? ' — ' + t.description : '') +
      (t.ping_role_id ? ' _(pings <@&' + t.ping_role_id + '>)_' : ''));
  }
  return ephemeral(lines.join('\n'));
}

// ---- Admin: post the panel ---------------------------------------------

function buildPanelPayload(config, types) {
  const embed = {
    title: '🎫 ' + (config.panel_title || 'Support Tickets'),
    description: config.panel_description || 'Pick a category below to open a ticket.',
    color: COLOR_SCHEDULE
  };
  if (!types.length) {
    embed.description += '\n\n_No ticket types configured yet._';
    return { embeds: [embed], components: [] };
  }
  // One button per type, custom_id ticket:open:<typeId>. 5 per row.
  const components = [];
  let cur = [];
  for (const t of types) {
    if (cur.length === 5) { components.push(row(...cur)); cur = []; }
    cur.push(btn('ticket:open:' + t.id, t.label, {
      style: BTN_PRIMARY,
      emoji: t.emoji || undefined
    }));
  }
  if (cur.length) components.push(row(...cur));
  return { embeds: [embed], components };
}

export async function postTicketPanel(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const guildId = await ensureBootstrap(env);
  const config = await getTicketConfig(env, guildId);
  if (!config.staff_role_id) {
    return ephemeral('⚠️ Configure the ticket system first (**⚙️ Configure** — staff role is required).');
  }
  const types = await listTicketTypes(env, guildId);
  if (!types.length) {
    return ephemeral('⚠️ Add at least one ticket type first (**➕ Add Type**).');
  }
  const channelId = data.channel_id;
  const payload = buildPanelPayload(config, types);
  try {
    const msg = await postChannelMessage(env, channelId, payload);
    await saveTicketConfig(env, guildId, {
      panel_channel_id: channelId,
      panel_message_id: msg.id
    });
    return ephemeral('🎫 Ticket panel posted in <#' + channelId + '> with ' + types.length + ' type(s).');
  } catch (e) {
    return ephemeral('Failed: ' + (e?.message || e));
  }
}

// ---- Viewer/staff: component dispatch ----------------------------------

// custom_ids: ticket:open:<typeId> · ticket:close · ticket:delete
export async function handleTicketComponent(env, data) {
  const parts = (data.data?.custom_id || '').split(':');
  const action = parts[1];
  if (action === 'open')   return openTicket(env, data, parts[2]);
  if (action === 'close')  return closeTicket(env, data);
  if (action === 'delete') return deleteTicket(env, data);
  return ephemeral('Unknown ticket action.');
}

function sanitizeChannelName(s) {
  return (s || 'user').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'user';
}

async function openTicket(env, data, typeId) {
  const guildId = data.guild_id;
  const userId = data.member?.user?.id;
  const username = data.member?.user?.username || 'user';
  if (!guildId || !userId) return ephemeral('Couldn\'t identify you.');

  const config = await getTicketConfig(env, guildId);
  if (!config.staff_role_id) return ephemeral('Ticket system isn\'t configured yet — ping an admin.');

  const type = await env.DB.prepare(
    'SELECT * FROM ticket_types WHERE id = ? AND guild_id = ?'
  ).bind(parseInt(typeId, 10), guildId).first();
  if (!type) return ephemeral('That ticket type no longer exists.');

  // One open ticket of this type per user.
  const existing = await env.DB.prepare(
    `SELECT channel_id FROM tickets
     WHERE guild_id = ? AND opener_user_id = ? AND type_label = ? AND status = 'open'
     LIMIT 1`
  ).bind(guildId, userId, type.label).first();
  if (existing) {
    return ephemeral('You already have an open **' + type.label + '** ticket: <#' + existing.channel_id + '>.');
  }

  // Build permission overwrites: hide from @everyone, allow opener +
  // staff role + the bot itself.
  const overwrites = [
    { id: guildId, type: 0, deny: VIEW_ONLY },
    { id: userId,  type: 1, allow: TICKET_ALLOW }
  ];
  if (config.staff_role_id) overwrites.push({ id: config.staff_role_id, type: 0, allow: TICKET_ALLOW });
  if (env.DISCORD_APP_ID)   overwrites.push({ id: env.DISCORD_APP_ID, type: 1, allow: TICKET_ALLOW });

  const chName = 'ticket-' + sanitizeChannelName(username) + '-' + userId.slice(-4);

  let channel;
  try {
    channel = await discordFetch(env, '/guilds/' + encodeURIComponent(guildId) + '/channels', {
      method: 'POST',
      body: JSON.stringify({
        name: chName,
        type: 0,
        parent_id: config.category_id || undefined,
        topic: 'Ticket · ' + type.label + ' · opened by ' + username + ' (' + userId + ')',
        permission_overwrites: overwrites
      })
    });
  } catch (e) {
    return ephemeral('Couldn\'t create the ticket channel: ' + (e?.message || e) +
      '\n\n_(Bot needs **Manage Channels**.)_');
  }

  await env.DB.prepare(
    'INSERT INTO tickets (guild_id, channel_id, opener_user_id, type_label) VALUES (?, ?, ?, ?)'
  ).bind(guildId, channel.id, userId, type.label).run();

  // Welcome message inside the new channel.
  const pingBits = ['<@' + userId + '>'];
  if (type.ping_role_id) pingBits.push('<@&' + type.ping_role_id + '>');
  else if (config.staff_role_id) pingBits.push('<@&' + config.staff_role_id + '>');

  try {
    await postChannelMessage(env, channel.id, {
      content: pingBits.join(' '),
      embeds: [{
        title: '🎫 ' + type.label,
        description: (type.description ? type.description + '\n\n' : '') +
          'Thanks for opening a ticket, <@' + userId + '>. Describe what you need and staff will respond here.\n\n' +
          'When the issue is resolved, staff can close this ticket with the button below.',
        color: COLOR_SCHEDULE,
        timestamp: new Date().toISOString()
      }],
      components: [row(
        btn('ticket:close', 'Close Ticket', { style: BTN_DANGER, emoji: '🔒' })
      )],
      allowed_mentions: { parse: ['roles'], users: [userId] }
    });
  } catch (e) { console.warn('[ticket] welcome post', e?.message || e); }

  return ephemeral('🎫 Opened your **' + type.label + '** ticket: <#' + channel.id + '>');
}

async function findTicketByChannel(env, channelId) {
  return env.DB.prepare('SELECT * FROM tickets WHERE channel_id = ? ORDER BY id DESC LIMIT 1')
    .bind(channelId).first();
}

async function isTicketStaff(env, data, ticket) {
  // The opener can close their own ticket; staff can close any.
  const userId = data.member?.user?.id;
  if (ticket && userId === ticket.opener_user_id) return true;
  const config = await getTicketConfig(env, ticket?.guild_id || data.guild_id);
  const roles = data.member?.roles || [];
  return !!config.staff_role_id && roles.includes(config.staff_role_id);
}

async function closeTicket(env, data) {
  const channelId = data.channel_id;
  const ticket = await findTicketByChannel(env, channelId);
  if (!ticket) return ephemeral('This doesn\'t look like a tracked ticket channel.');
  if (ticket.status !== 'open') return ephemeral('This ticket is already closed.');
  if (!(await isTicketStaff(env, data, ticket))) {
    return ephemeral('Only staff or the ticket opener can close this.');
  }

  const closerId = data.member?.user?.id;
  await env.DB.prepare(
    `UPDATE tickets SET status = 'closed', closed_at = datetime('now'), closed_by = ? WHERE id = ?`
  ).bind(closerId, ticket.id).run();

  // Lock the channel: remove the opener's view access, rename to closed-…
  try {
    await discordFetch(env, '/channels/' + encodeURIComponent(channelId), {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'closed-' + ticket.id,
        permission_overwrites: [
          { id: ticket.guild_id, type: 0, deny: VIEW_ONLY },
          ...(env.DISCORD_APP_ID ? [{ id: env.DISCORD_APP_ID, type: 1, allow: TICKET_ALLOW }] : [])
        ].concat(await staffOverwrite(env, ticket.guild_id))
      })
    });
  } catch (e) { console.warn('[ticket] lock', e?.message || e); }

  // Log it.
  const config = await getTicketConfig(env, ticket.guild_id);
  if (config.log_channel_id) {
    try {
      await postChannelMessage(env, config.log_channel_id, {
        embeds: [{
          title: '🎫 Ticket closed · #' + ticket.id,
          description:
            '**Type:** ' + (ticket.type_label || '?') + '\n' +
            '**Opened by:** <@' + ticket.opener_user_id + '>\n' +
            '**Closed by:** <@' + closerId + '>\n' +
            '**Opened:** ' + (ticket.created_at || '?'),
          color: 0xED4245,
          timestamp: new Date().toISOString()
        }]
      });
    } catch (e) { console.warn('[ticket] log', e?.message || e); }
  }

  // Post the closed notice + a Delete button for staff.
  try {
    await postChannelMessage(env, channelId, {
      embeds: [{
        title: '🔒 Ticket closed',
        description: 'Closed by <@' + closerId + '>. Staff can delete this channel when done reviewing.',
        color: 0xED4245
      }],
      components: [row(
        btn('ticket:delete', 'Delete Channel', { style: BTN_DANGER, emoji: '🗑️' })
      )]
    });
  } catch {}

  return ephemeral('🔒 Ticket closed.');
}

async function staffOverwrite(env, guildId) {
  const config = await getTicketConfig(env, guildId);
  return config.staff_role_id
    ? [{ id: config.staff_role_id, type: 0, allow: TICKET_ALLOW }]
    : [];
}

async function deleteTicket(env, data) {
  const channelId = data.channel_id;
  const ticket = await findTicketByChannel(env, channelId);
  if (ticket && !(await isTicketStaff(env, data, ticket))) {
    return ephemeral('Only staff can delete a ticket channel.');
  }
  if (ticket) {
    await env.DB.prepare(`UPDATE tickets SET status = 'deleted' WHERE id = ?`).bind(ticket.id).run();
  }
  try {
    await discordFetch(env, '/channels/' + encodeURIComponent(channelId), { method: 'DELETE' });
  } catch (e) {
    return ephemeral('Couldn\'t delete the channel: ' + (e?.message || e));
  }
  // No further response needed — the channel is gone.
  return ephemeral('🗑️ Deleted.');
}
