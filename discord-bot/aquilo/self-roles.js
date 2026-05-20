// Self-assign roles via Discord BUTTONS (not reactions). Reactions need
// a gateway connection; buttons fire interactions which our HTTP-only
// worker handles natively.
//
// Lifecycle:
//   - Streamer adds a self-role via hub modal (label, emoji, role_id)
//   - Stored in D1 `self_roles`
//   - Streamer clicks "Post Self-Roles" hub button → bot posts/refreshes
//     a single message in ROLES_CHANNEL_ID with one button per role
//   - User clicks a button → bot toggles that role on/off for them
//
// Permission requirement: bot's role needs MANAGE_ROLES, AND the bot
// role must sit ABOVE every self-assignable role in the role hierarchy.
// Otherwise PUT /guilds/{id}/members/{user}/roles/{role} returns 403.

import {
  ephemeral, chat, postChannelMessage, editChannelMessage, discordFetch,
  modal, getModalField, btn, row, BTN_PRIMARY, BTN_SECONDARY, BTN_DANGER,
  isAdmin, COLOR_SCHEDULE
} from './util.js';
import { ensureBootstrap } from './bootstrap.js';

const KV_MSG_ID = 'self_roles:msg';

// ---- D1 helpers --------------------------------------------------------

async function listSelfRoles(env, guildId) {
  const { results } = await env.DB.prepare(
    'SELECT id, role_id, label, emoji FROM self_roles WHERE guild_id = ? ORDER BY sort_order, id'
  ).bind(guildId).all();
  return results || [];
}

// ---- Modals (returned from hub button clicks) -------------------------

export function selfRolesAddModal() {
  return modal('modal:self_role_add', 'Add a self-assignable role', [
    { custom_id: 'role_id', label: 'Role ID (right-click role → Copy ID)', style: 1, required: true,  max_length: 25 },
    { custom_id: 'label',   label: 'Button label',                          style: 1, required: true,  max_length: 80 },
    { custom_id: 'emoji',   label: 'Emoji (optional, e.g. 🎮)',              style: 1, required: false, max_length: 8 }
  ]);
}

export function selfRolesRemoveModal() {
  return modal('modal:self_role_remove', 'Remove a self-assignable role', [
    { custom_id: 'role_id', label: 'Role ID to remove', style: 1, required: true, max_length: 25 }
  ]);
}

// ---- Modal-submit handlers --------------------------------------------

export async function handleSelfRoleAddSubmit(env, data) {
  const guildId = await ensureBootstrap(env);
  const role_id = (getModalField(data, 'role_id') || '').trim();
  const label   = (getModalField(data, 'label')   || '').trim();
  const emoji   = (getModalField(data, 'emoji')   || '').trim() || null;
  if (!role_id || !label) return ephemeral('Role ID + label required.');
  if (!/^\d{15,25}$/.test(role_id)) return ephemeral('Role ID looks wrong — should be a long number (right-click role → Copy ID).');

  try {
    await env.DB.prepare(
      'INSERT INTO self_roles (guild_id, role_id, label, emoji) VALUES (?, ?, ?, ?)'
    ).bind(guildId, role_id, label, emoji).run();
  } catch (e) {
    return ephemeral('That role is already in the self-roles list.');
  }
  return ephemeral('✅ Added **' + label + '** → <@&' + role_id + '>. Click 📤 Post Self-Roles on the hub to refresh the public message.');
}

export async function handleSelfRoleRemoveSubmit(env, data) {
  const guildId = await ensureBootstrap(env);
  const role_id = (getModalField(data, 'role_id') || '').trim();
  if (!role_id) return ephemeral('Role ID required.');
  const r = await env.DB.prepare(
    'DELETE FROM self_roles WHERE guild_id = ? AND role_id = ?'
  ).bind(guildId, role_id).run();
  if ((r.meta?.changes || 0) === 0) return ephemeral('No matching self-role found.');
  return ephemeral('🗑️ Removed. Click 📤 Post Self-Roles to refresh.');
}

// ---- Public roles message ---------------------------------------------

function buildSelfRolesPayload(roles) {
  const embed = {
    title: '🪪 Self-Assign Roles',
    description: roles.length
      ? 'Click a button to give yourself that role. Click again to remove it.'
      : '_No self-assign roles configured yet — admin: use the hub to add some._',
    color: COLOR_SCHEDULE
  };

  // Up to 25 buttons (5 rows × 5 each). Beyond that, additional roles
  // are silently dropped from the public message but still in DB.
  const components = [];
  let curRow = [];
  for (let i = 0; i < Math.min(roles.length, 25); i++) {
    if (curRow.length === 5) { components.push(row(...curRow)); curRow = []; }
    const r = roles[i];
    curRow.push(btn('roles:toggle:' + r.role_id, r.label, {
      style: BTN_SECONDARY,
      emoji: r.emoji || undefined
    }));
  }
  if (curRow.length) components.push(row(...curRow));

  return { embeds: [embed], components };
}

// Hub button: post (or edit-in-place) the public roles message.
export async function postOrRefreshSelfRolesMessage(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  if (!env.ROLES_CHANNEL_ID) return ephemeral('Set ROLES_CHANNEL_ID in wrangler.toml first.');

  const guildId = await ensureBootstrap(env);
  const roles = await listSelfRoles(env, guildId);
  const payload = buildSelfRolesPayload(roles);

  const oldId = await env.STATE.get(KV_MSG_ID);
  if (oldId) {
    try {
      await editChannelMessage(env, env.ROLES_CHANNEL_ID, oldId, payload);
      return ephemeral('🪪 Refreshed self-roles message in <#' + env.ROLES_CHANNEL_ID + '> (' + roles.length + ' role' + (roles.length === 1 ? '' : 's') + ').');
    } catch { /* fall through to repost */ }
  }
  try {
    const msg = await postChannelMessage(env, env.ROLES_CHANNEL_ID, payload);
    await env.STATE.put(KV_MSG_ID, msg.id);
    return ephemeral('🪪 Posted self-roles message in <#' + env.ROLES_CHANNEL_ID + '> (' + roles.length + ' role' + (roles.length === 1 ? '' : 's') + '). Message id: ' + msg.id);
  } catch (e) {
    return ephemeral('Failed: ' + (e?.message || e));
  }
}

// Hub button: ephemeral list of currently-configured self-roles.
export async function listSelfRolesEphemeral(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const guildId = await ensureBootstrap(env);
  const roles = await listSelfRoles(env, guildId);
  if (!roles.length) return ephemeral('No self-roles configured yet.');
  const lines = roles.map(r => '• ' + (r.emoji || '·') + ' **' + r.label + '** → <@&' + r.role_id + '> _(role id `' + r.role_id + '`)_');
  return ephemeral('**Self-roles (' + roles.length + '):**\n' + lines.join('\n'));
}

// ---- Component handler: toggle a role ---------------------------------

// custom_id format: roles:toggle:<roleId>
export async function handleRoleToggle(env, data) {
  const parts = (data.data?.custom_id || '').split(':');
  if (parts.length !== 3) return ephemeral('Bad button.');
  const roleId = parts[2];
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Couldn\'t identify you.');

  // Verify the role is in our configured self-roles list (don't let
  // someone craft a custom_id to grab arbitrary roles).
  const allowed = await env.DB.prepare(
    'SELECT label FROM self_roles WHERE guild_id = ? AND role_id = ?'
  ).bind(guildId, roleId).first();
  if (!allowed) return ephemeral('That role isn\'t available for self-assign.');

  const memberRoles = data.member?.roles || [];
  const has = memberRoles.includes(roleId);

  try {
    if (has) {
      await discordFetch(env,
        '/guilds/' + encodeURIComponent(guildId) +
        '/members/' + encodeURIComponent(userId) +
        '/roles/'   + encodeURIComponent(roleId),
        { method: 'DELETE' });
      return ephemeral('🗑️ Removed **' + allowed.label + '** from you.');
    } else {
      await discordFetch(env,
        '/guilds/' + encodeURIComponent(guildId) +
        '/members/' + encodeURIComponent(userId) +
        '/roles/'   + encodeURIComponent(roleId),
        { method: 'PUT', body: '' });
      return ephemeral('✅ Gave you **' + allowed.label + '**.');
    }
  } catch (e) {
    // 403 typically = bot role lower than target role in hierarchy
    return ephemeral('Failed: ' + (e?.message || e) + '\n\n_(Bot role needs **Manage Roles** AND must be above this role in Server Settings → Roles.)_');
  }
}
