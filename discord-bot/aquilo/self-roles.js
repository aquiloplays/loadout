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

// Reserve the bottom row for the 18+ self-claim button. Lives outside
// the D1 self_roles table on purpose — it carries a warning + audit
// flow the other toggles don't need.
const AGE18_BUTTON = {
  custom_id: 'roles:age18:start',
  label: '18+ access',
  emoji: { name: '🔞' },
  style: 2, // BTN_SECONDARY — matches the other toggle buttons visually
  type: 2,  // COMPONENT_BUTTON
};

function buildSelfRolesPayload(roles) {
  const embed = {
    title: '🪪 Self-Assign Roles',
    description:
      (roles.length
        ? 'Click a button to give yourself that role. Click again to remove it.'
        : '_No self-assign roles configured yet — admin: use the hub to add some._') +
      '\n\n**🔞 18+ access** opts you into the adult-conversation chat area. ' +
      'Tap below to read the warning and confirm.',
    color: COLOR_SCHEDULE
  };

  // Up to 24 D1 buttons (5 rows × 5, minus 1 slot kept for the 18+
  // button on its own row). Beyond that, extra roles are silently
  // dropped from the public message but still in DB.
  const components = [];
  let curRow = [];
  const cap = 24;
  for (let i = 0; i < Math.min(roles.length, cap); i++) {
    if (curRow.length === 5) { components.push(row(...curRow)); curRow = []; }
    if (components.length >= 4) break; // leave the last row free for 18+
    const r = roles[i];
    curRow.push(btn('roles:toggle:' + r.role_id, r.label, {
      style: BTN_SECONDARY,
      emoji: r.emoji || undefined
    }));
  }
  if (curRow.length) components.push(row(...curRow));

  // 18+ button on its own row at the bottom.
  components.push({ type: 1, components: [AGE18_BUTTON] });

  return { embeds: [embed], components };
}

// Internal — used by both the hub button (admin click) and the HMAC
// admin endpoint. No auth check inside; callers gate.
async function _postOrRefreshInternal(env, guildId) {
  if (!env.ROLES_CHANNEL_ID) return { ok: false, error: 'roles-channel-not-set' };
  const roles = await listSelfRoles(env, guildId);
  const payload = buildSelfRolesPayload(roles);
  const oldId = await env.STATE.get(KV_MSG_ID);
  if (oldId) {
    try {
      await editChannelMessage(env, env.ROLES_CHANNEL_ID, oldId, payload);
      return { ok: true, messageId: oldId, action: 'edited', rolesCount: roles.length };
    } catch { /* fall through to repost */ }
  }
  try {
    const msg = await postChannelMessage(env, env.ROLES_CHANNEL_ID, payload);
    await env.STATE.put(KV_MSG_ID, msg.id);
    return { ok: true, messageId: msg.id, action: 'posted', rolesCount: roles.length };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Hub button: post (or edit-in-place) the public roles message.
export async function postOrRefreshSelfRolesMessage(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const guildId = await ensureBootstrap(env);
  const r = await _postOrRefreshInternal(env, guildId);
  if (!r.ok) {
    if (r.error === 'roles-channel-not-set') return ephemeral('Set ROLES_CHANNEL_ID in wrangler.toml first.');
    return ephemeral('Failed: ' + r.error);
  }
  const verb = r.action === 'edited' ? 'Refreshed' : 'Posted';
  return ephemeral(`🪪 ${verb} self-roles message in <#${env.ROLES_CHANNEL_ID}> (${r.rolesCount} role${r.rolesCount === 1 ? '' : 's'})${r.action === 'posted' ? '. Message id: ' + r.messageId : ''}.`);
}

// HMAC-admin entry — called from worker.js handleSelfRolesPost.
export async function postSelfRolesAdmin(env, guildId) {
  return _postOrRefreshInternal(env, guildId);
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

// custom_id formats:
//   roles:toggle:<roleId>         → existing self-role toggle (D1-backed)
//   roles:age18:start             → open the age-gate warning/remove view
//   roles:age18:confirm           → grant the 18+ role (with mod-log)
//   roles:age18:remove            → revoke the 18+ role
//   roles:age18:cancel            → dismiss the ephemeral view
export async function handleRoleToggle(env, data) {
  const parts = (data.data?.custom_id || '').split(':');
  if (parts[1] === 'age18') return handle18PlusClick(env, data, parts[2] || '');
  if (parts.length !== 3 || parts[1] !== 'toggle') return ephemeral('Bad button.');
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

// ---- 18+ self-claim flow ----------------------------------------------
//
// Mirrors discord-bot/onboarding.js viewAge18 + age18 handlers. Two-tap
// flow: the public button opens an ephemeral confirm (warning copy for
// grant, plain confirm for remove). The Yes button does the actual role
// PUT/DELETE + mod-log entry. Cancel just edits the ephemeral to a
// neutral "no changes made" notice.

const RESP_CHAT_NEW   = 4; // CHANNEL_MESSAGE_WITH_SOURCE
const RESP_UPDATE_MSG = 7; // UPDATE_MESSAGE
const FLAG_EPHEMERAL  = 64;

async function handle18PlusClick(env, data, action) {
  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Couldn\'t identify you.');

  const cfg    = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
  const roleId = cfg?.ids?.role_age18;
  const modLog = cfg?.ids?.ch_mod_log;
  if (!roleId) return ephemeral('18+ role not configured yet — ask a mod to run `/admin/discord/setup-18plus`.');

  const has = (data.member?.roles || []).includes(roleId);

  if (action === 'start') {
    if (has) {
      return {
        type: RESP_CHAT_NEW,
        data: {
          flags: FLAG_EPHEMERAL,
          embeds: [{
            title: '🔞 Remove 18+ access?',
            description: 'You\'ll lose visibility into the 18+ chat area. You can re-claim any time from this channel.',
            color: 0xff6ab5,
          }],
          components: [{
            type: 1,
            components: [
              { type: 2, style: 4, label: 'Remove access', custom_id: 'roles:age18:remove' },
              { type: 2, style: 2, label: 'Cancel',        custom_id: 'roles:age18:cancel' },
            ],
          }],
        },
      };
    }
    return {
      type: RESP_CHAT_NEW,
      data: {
        flags: FLAG_EPHEMERAL,
        embeds: [{
          title: '🔞 Are you 18 or older?',
          description:
            `Aquilo has a small **18+** chat area for adult conversations.\n` +
            `It's tucked away in its own category — you won't see it unless ` +
            `you opt in here.\n\n` +
            `**⚠ Critical:** By claiming the 18+ role while under 18, you will be ` +
            `**permanently banned** from the server. This is non-negotiable — ` +
            `Discord's Terms of Service require us to enforce it.\n\n` +
            `Cancel if you'd rather not opt in.`,
          color: 0xff6ab5,
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: "Yes, I'm 18+", custom_id: 'roles:age18:confirm' },
            { type: 2, style: 2, label: 'Cancel',       custom_id: 'roles:age18:cancel' },
          ],
        }],
      },
    };
  }

  if (action === 'cancel') {
    return {
      type: RESP_UPDATE_MSG,
      data: {
        embeds: [{ title: '↩️ Cancelled', description: 'No changes made.', color: 0x808080 }],
        components: [],
      },
    };
  }

  if (action === 'confirm' || action === 'remove') {
    const method = action === 'confirm' ? 'PUT' : 'DELETE';
    const reason = action === 'confirm'
      ? 'Aquilo 18+ self-grant via roles channel'
      : 'Aquilo 18+ self-remove via roles channel';
    const r = await fetch(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      { method,
        headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
                   'X-Audit-Log-Reason': reason } });
    if (!r.ok && r.status !== 204) {
      return ephemeral(`Couldn't ${action === 'confirm' ? 'grant' : 'remove'} the 18+ role (${r.status}). Ping a mod.`);
    }
    // Audit log — only on grant (matches the onboarding pattern;
    // removal is captured natively by Discord's audit log).
    if (action === 'confirm' && modLog) {
      const username = data?.member?.user?.username || data?.user?.username || 'unknown';
      const ts = Math.floor(Date.now() / 1000);
      fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(modLog)}/messages`,
        { method: 'POST',
          headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
                     'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🔞 **18+ self-grant via roles channel** — <@${userId}> (${username}, id \`${userId}\`) claimed the 18+ role at <t:${ts}:F>.\n` +
                     `If their account looks under 18, ban per the onboarding warning copy.`,
            allowed_mentions: { parse: [] },
          }),
        }).catch(() => {});
    }
    return {
      type: RESP_UPDATE_MSG,
      data: {
        embeds: [{
          title: action === 'confirm' ? '✅ 18+ access granted' : '🗑️ 18+ access removed',
          description: action === 'confirm'
            ? 'You can now see the 18+ chat area. Welcome.'
            : 'You no longer have access to the 18+ chat area. You can re-claim any time from this channel.',
          color: action === 'confirm' ? 0x5bff95 : 0x808080,
        }],
        components: [],
      },
    };
  }

  return ephemeral('Unknown 18+ action.');
}
