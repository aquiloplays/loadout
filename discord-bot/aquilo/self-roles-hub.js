// Consolidated self-assign role hub for #roles (channel
// 1507973902146732222 in Aquilo). Posts ONE message per category, so
// each section stays scannable on its own. Replaces the older
// button-grid layout in self-roles.js and the legacy "Pick your pings"
// message from guild-builder.js.
//
// Categories (in display order):
//   1. 🔔 Notification Pings   — multi-select (Stream / YouTube /
//                                Events / Game Night). Migrates the
//                                pre-existing guild:role:* IDs out of
//                                guild-builder's KV cfg.ids so users
//                                keep whatever they already toggled.
//   2. 🎨 Name Color           — single-select / mutex (11 colors).
//                                Hierarchy note: these must sit
//                                ABOVE the user's other coloured
//                                roles for Discord to render the
//                                colour. Admin reorders post-provision.
//   3. 🌎 Region               — multi-select (NA East / NA West /
//                                EU / Asia / Oceania).
//   4. 🎮 Platform             — multi-select (PC / Xbox / PS / Switch).
//   5. 🪪 Pronouns             — multi-select (He/Him / She/Her /
//                                They/Them / Other-Ask-Me).
//   6. 🔞 18+ Access           — keeps the existing two-tap warning
//                                flow from self-roles.js handle18PlusClick;
//                                this hub just re-posts the button.
//
// KV layout:
//   self-roles-hub:roles:<g>   { pings: {stream, ...}, colors: {...},
//                                regions: {...}, platforms: {...},
//                                pronouns: {...} }   role IDs by key
//   self-roles-hub:msgs:<g>    [{ category, channelId, messageId }, ...]
//                              one entry per posted category message
//
// Dispatcher (in aquilo/worker.js):
//   string-select submit with custom_id 'roles:sel:<category>' →
//     handleHubSelect(env, data)
//
// Game tags + playstyle tags are intentionally NOT included
// (Clay flagged "skip" on 2026-05-27).

import { ephemeral } from './util.js';

const ROLES_KV_KEY  = (g) => `self-roles-hub:roles:${g}`;
const MSGS_KV_KEY   = (g) => `self-roles-hub:msgs:${g}`;
const LEGACY_PINGS_MSG_KV_KEY = (g) => `self-roles-hub:legacy-pings-msg:${g}`;

// Discord component / response constants
const COMPONENT_ROW           = 1;
const COMPONENT_BUTTON        = 2;
const COMPONENT_STRING_SELECT = 3;
const BTN_SECONDARY           = 2;

const RESP_CHAT       = 4;
const RESP_UPDATE_MSG = 7;
const FLAG_EPHEMERAL  = 64;

// ── Category catalogue ────────────────────────────────────────────────
//
// `existingIdKey` on the pings options points at the field on
// guild:cfg.ids where guild-builder.js previously stored that role's
// ID. We migrate those IDs into self-roles-hub:roles on provision so
// nothing breaks for users who already have a ping role assigned.

export const CATEGORIES = [
  {
    key: 'pings',
    title: '🔔 Notification Pings',
    blurb: 'Toggle the pings you want — multi-select.',
    multi: true,
    options: [
      { value: 'stream',    label: 'Stream Pings',  emoji: { name: '📺' }, color: 0xEB459E, existingIdKey: 'role_stream'    },
      { value: 'youtube',   label: 'YouTube Pings', emoji: { name: '🎬' }, color: 0xED4245, existingIdKey: 'role_youtube'   },
      { value: 'event',     label: 'Event Pings',   emoji: { name: '📅' }, color: 0xFEE75C, existingIdKey: 'role_event'     },
      { value: 'gamenight', label: 'Game Night',    emoji: { name: '🎮' }, color: 0x9147ff, existingIdKey: 'role_gamenight' },
    ],
  },
  {
    key: 'colors',
    title: '🎨 Name Color',
    blurb: 'Pick one. Choosing a new colour replaces your previous pick.',
    multi: false,
    options: [
      { value: 'aquilo_violet', label: 'Aquilo Violet', color: 0x7c5cff },
      { value: 'aurora_pink',   label: 'Aurora Pink',   color: 0xff6ab5 },
      { value: 'aurora_green',  label: 'Aurora Green',  color: 0x5bff95 },
      { value: 'red',           label: 'Red',           color: 0xED4245 },
      { value: 'orange',        label: 'Orange',        color: 0xFF8C00 },
      { value: 'yellow',        label: 'Yellow',        color: 0xFEE75C },
      { value: 'blue',          label: 'Blue',          color: 0x3498DB },
      { value: 'cyan',          label: 'Cyan',          color: 0x1ABC9C },
      { value: 'white',         label: 'White',         color: 0xFFFFFF },
      { value: 'purple',        label: 'Purple',        color: 0x9B59B6 },
      { value: 'black',         label: 'Black',         color: 0x23272A },   // near-black; pure black is unreadable on dark theme
    ],
  },
  {
    key: 'regions',
    title: '🌎 Region',
    blurb: 'Where do you mostly play from? Multi-select OK if you bounce around.',
    multi: true,
    options: [
      { value: 'na_east',  label: 'NA East',  emoji: { name: '🌅' } },
      { value: 'na_west',  label: 'NA West',  emoji: { name: '🌇' } },
      { value: 'eu',       label: 'EU',       emoji: { name: '🇪🇺' } },
      { value: 'asia',     label: 'Asia',     emoji: { name: '🌏' } },
      { value: 'oceania',  label: 'Oceania',  emoji: { name: '🦘' } },
    ],
  },
  {
    key: 'platforms',
    title: '🎮 Platform',
    blurb: 'What you play on. Multi-select if you cross-play.',
    multi: true,
    options: [
      { value: 'pc',         label: 'PC',          emoji: { name: '🖥️' } },
      { value: 'xbox',       label: 'Xbox',        emoji: { name: '🟢' } },
      { value: 'playstation',label: 'PlayStation', emoji: { name: '🔵' } },
      { value: 'switch',     label: 'Switch',      emoji: { name: '🔴' } },
    ],
  },
  {
    key: 'pronouns',
    title: '🪪 Pronouns',
    blurb: 'Pick what you go by. Visible in your profile to anyone who hovers your name.',
    multi: true,
    options: [
      { value: 'he_him',     label: 'He/Him' },
      { value: 'she_her',    label: 'She/Her' },
      { value: 'they_them',  label: 'They/Them' },
      { value: 'other_ask',  label: 'Other / Ask Me' },
    ],
  },
];

// 18+ is special — kept as a button that triggers the existing
// handle18PlusClick warning flow in self-roles.js. The hub still
// renders a dedicated message for it so it sits visually beside the
// other categories.
export const AGE18_CATEGORY = {
  key: 'age18',
  title: '🔞 18+ Access',
  blurb: 'Opt in to the adult-conversation chat. Click to read the warning and confirm.',
};

// ── Discord helpers (raw fetch — keep cross-module coupling thin) ────

async function dapi(env, method, path, body) {
  const init = {
    method,
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch('https://discord.com/api/v10' + path, init);
  return {
    ok: r.ok || r.status === 204,
    status: r.status,
    body: await r.text().catch(() => ''),
  };
}

async function listGuildRoles(env, guildId) {
  const r = await dapi(env, 'GET', `/guilds/${encodeURIComponent(guildId)}/roles`);
  if (!r.ok) return [];
  try { return JSON.parse(r.body); } catch { return []; }
}

// ── Role provisioning ────────────────────────────────────────────────
//
// Creates a Discord role per option in each category. Idempotent —
// reuses any existing role with the same name (case-insensitive).
// Pings migrate from guild-builder.js cfg.ids when present so users
// keep whatever pings they already opted into. Returns the full
// {category: {option: roleId}} map written to KV.

export async function provisionHubRoles(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };

  const existing = await listGuildRoles(env, guildId);
  const byName = new Map();
  for (const r of existing) byName.set(String(r.name || '').toLowerCase(), r);

  // Pull guild-builder's cfg.ids for the pings migration.
  let cfg = null;
  try {
    cfg = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
  } catch { /* ignore */ }

  const stored = (await env.LOADOUT_BOLTS.get(ROLES_KV_KEY(guildId), { type: 'json' })) || {};
  const created = [];
  const reused  = [];
  const errors  = [];

  for (const cat of CATEGORIES) {
    stored[cat.key] = stored[cat.key] || {};
    for (const opt of cat.options) {
      // Resolution order:
      //   1. Existing entry in self-roles-hub:roles KV
      //   2. (pings only) guild-builder cfg.ids legacy field
      //   3. Discord role with the same name already in the guild
      //   4. Create a new role
      if (stored[cat.key][opt.value]) continue;

      if (cat.key === 'pings' && opt.existingIdKey && cfg?.ids?.[opt.existingIdKey]) {
        stored[cat.key][opt.value] = String(cfg.ids[opt.existingIdKey]);
        reused.push({ category: cat.key, option: opt.value, via: 'legacy-cfg' });
        continue;
      }

      const nameLower = String(opt.label).toLowerCase();
      const found = byName.get(nameLower);
      if (found) {
        stored[cat.key][opt.value] = String(found.id);
        reused.push({ category: cat.key, option: opt.value, via: 'existing-role' });
        continue;
      }

      // Create a new role. Color-category roles set the colour; other
      // categories are colour-neutral. mentionable:true for pings so
      // they actually ping when used; everyone else false.
      const create = await dapi(env, 'POST',
        `/guilds/${encodeURIComponent(guildId)}/roles`, {
          name: opt.label,
          color: opt.color || 0,
          mentionable: cat.key === 'pings',
          hoist: false,
          permissions: '0',
        });
      if (!create.ok) {
        errors.push({ category: cat.key, option: opt.value, status: create.status,
                      body: create.body.slice(0, 200) });
        continue;
      }
      let parsed = null;
      try { parsed = JSON.parse(create.body); } catch { /* ignore */ }
      if (parsed?.id) {
        stored[cat.key][opt.value] = String(parsed.id);
        created.push({ category: cat.key, option: opt.value, roleId: parsed.id, name: opt.label });
      }
    }
  }

  await env.LOADOUT_BOLTS.put(ROLES_KV_KEY(guildId), JSON.stringify(stored));

  return {
    ok: errors.length === 0,
    created, reused, errors,
    roles: stored,
    note: 'Name-Color roles must be moved ABOVE other coloured roles in Server Settings → Roles for the colour to render on names. Provisioning leaves them at the bottom of the hierarchy by default.',
  };
}

// ── Message rendering ────────────────────────────────────────────────
//
// One Discord message per category. Each carries an embed (title +
// blurb) and either a string-select menu (for the role-toggle
// categories) or a button (for 18+).

function buildCategoryMessage(category, roleIds, brandAccent = 0x7c5cff) {
  const opts = category.options.map(o => ({
    label: o.label,
    value: o.value,
    description: o.color ? '#' + o.color.toString(16).padStart(6, '0') : undefined,
    emoji: o.emoji,
  }));
  return {
    embeds: [{
      title: category.title,
      description: category.blurb,
      color: brandAccent,
    }],
    components: [{
      type: COMPONENT_ROW,
      components: [{
        type: COMPONENT_STRING_SELECT,
        custom_id: `roles:sel:${category.key}`,
        placeholder: category.multi
          ? 'Pick any (multi-select)'
          : 'Pick one',
        min_values: 0,
        max_values: category.multi ? opts.length : 1,
        options: opts,
      }],
    }],
    allowed_mentions: { parse: [] },
  };
}

function buildAge18Message(brandAccent = 0xff6ab5) {
  return {
    embeds: [{
      title: AGE18_CATEGORY.title,
      description: AGE18_CATEGORY.blurb,
      color: brandAccent,
    }],
    components: [{
      type: COMPONENT_ROW,
      components: [{
        type: COMPONENT_BUTTON,
        style: BTN_SECONDARY,
        label: '18+ access',
        emoji: { name: '🔞' },
        custom_id: 'roles:age18:start',   // handled by self-roles.js handle18PlusClick
      }],
    }],
    allowed_mentions: { parse: [] },
  };
}

// ── Public post / refresh ────────────────────────────────────────────

export async function postOrRefreshHub(env, guildId, channelId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!channelId)              return { ok: false, error: 'no-channel' };

  // Load (or seed) the roles map. Provision MUST run first.
  const roleIds = await env.LOADOUT_BOLTS.get(ROLES_KV_KEY(guildId), { type: 'json' });
  if (!roleIds) {
    return { ok: false, error: 'roles-not-provisioned',
             message: 'Run POST /admin/self-roles-hub/provision/:guildId first.' };
  }

  // Sweep the legacy single-message self-roles post (KV key
  // self_roles:msg under STATE namespace, written by self-roles.js).
  // Best-effort delete; ignore failures.
  try {
    const legacyMsgId = await env.STATE.get('self_roles:msg');
    if (legacyMsgId) {
      await dapi(env, 'DELETE',
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(legacyMsgId)}`)
        .catch(() => {});
      await env.STATE.delete('self_roles:msg');
    }
  } catch { /* non-fatal */ }

  // Sweep the legacy guild-builder pings message (cfg.ids tracks it
  // only via the message report, not a stored ID — we can't auto-
  // delete it without a scan, so leave a one-time notice for Clay
  // in the report).
  const legacyPingsMsgId = await env.LOADOUT_BOLTS.get(LEGACY_PINGS_MSG_KV_KEY(guildId));
  if (legacyPingsMsgId) {
    await dapi(env, 'DELETE',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(legacyPingsMsgId)}`)
      .catch(() => {});
    await env.LOADOUT_BOLTS.delete(LEGACY_PINGS_MSG_KV_KEY(guildId));
  }

  // Read prior hub messages to edit-in-place when possible. If the
  // channel changed (or the prior msg is gone), POST a fresh one.
  const priorMsgs = (await env.LOADOUT_BOLTS.get(MSGS_KV_KEY(guildId), { type: 'json' })) || [];
  const priorByCategory = new Map();
  for (const m of priorMsgs) priorByCategory.set(m.category, m);

  const newMsgs = [];
  const errors = [];

  // Order: pings → colors → regions → platforms → pronouns → 18+.
  for (const cat of CATEGORIES) {
    const payload = buildCategoryMessage(cat, roleIds);
    const prior = priorByCategory.get(cat.key);
    const sameChannel = prior?.channelId === channelId;

    if (prior && sameChannel) {
      const r = await dapi(env, 'PATCH',
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(prior.messageId)}`,
        payload);
      if (r.ok) {
        newMsgs.push({ category: cat.key, channelId, messageId: prior.messageId });
        continue;
      }
      // PATCH failed — fall through to POST a fresh one.
    } else if (prior?.channelId && prior?.messageId) {
      // Channel changed — best-effort delete the old message.
      await dapi(env, 'DELETE',
        `/channels/${encodeURIComponent(prior.channelId)}/messages/${encodeURIComponent(prior.messageId)}`)
        .catch(() => {});
    }

    const post = await dapi(env, 'POST',
      `/channels/${encodeURIComponent(channelId)}/messages`, payload);
    if (post.ok) {
      let parsed = null;
      try { parsed = JSON.parse(post.body); } catch {}
      if (parsed?.id) newMsgs.push({ category: cat.key, channelId, messageId: parsed.id });
    } else {
      errors.push({ category: cat.key, phase: 'post', status: post.status,
                    body: post.body.slice(0, 200) });
    }
  }

  // 18+ section.
  {
    const payload = buildAge18Message();
    const prior = priorByCategory.get(AGE18_CATEGORY.key);
    const sameChannel = prior?.channelId === channelId;

    if (prior && sameChannel) {
      const r = await dapi(env, 'PATCH',
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(prior.messageId)}`,
        payload);
      if (r.ok) {
        newMsgs.push({ category: AGE18_CATEGORY.key, channelId, messageId: prior.messageId });
      }
    }
    if (!newMsgs.some(m => m.category === AGE18_CATEGORY.key)) {
      const post = await dapi(env, 'POST',
        `/channels/${encodeURIComponent(channelId)}/messages`, payload);
      if (post.ok) {
        let parsed = null;
        try { parsed = JSON.parse(post.body); } catch {}
        if (parsed?.id) newMsgs.push({ category: AGE18_CATEGORY.key, channelId, messageId: parsed.id });
      } else {
        errors.push({ category: AGE18_CATEGORY.key, phase: 'post', status: post.status,
                      body: post.body.slice(0, 200) });
      }
    }
  }

  await env.LOADOUT_BOLTS.put(MSGS_KV_KEY(guildId), JSON.stringify(newMsgs));

  return {
    ok: errors.length === 0,
    channelId,
    posted: newMsgs.length,
    messages: newMsgs,
    errors,
  };
}

// ── Select-menu submit handler ───────────────────────────────────────
//
// Multi-select diff:
//   adds    = (selected) − (current ∩ category_roles)
//   removes = (current ∩ category_roles) − selected
//
// Mutex (color category): same diff but selected has at most 1 entry.

export async function handleHubSelect(env, data) {
  const cid = data?.data?.custom_id || '';
  const m = cid.match(/^roles:sel:([a-z0-9_]+)$/);
  if (!m) return ephemeral('Bad selector ID.');
  const categoryKey = m[1];
  const category = CATEGORIES.find(c => c.key === categoryKey);
  if (!category) return ephemeral('Unknown category: ' + categoryKey);

  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Couldn\'t identify you.');

  const roleIds = await env.LOADOUT_BOLTS.get(ROLES_KV_KEY(guildId), { type: 'json' });
  const catRoleMap = roleIds?.[categoryKey] || {};
  const validOptionValues = new Set(category.options.map(o => o.value));

  // Selected option values from the interaction.
  const selectedValues = (data.data?.values || [])
    .filter(v => validOptionValues.has(v));

  // Mutex: cap at 1 (Discord enforces this via max_values:1 anyway).
  if (!category.multi && selectedValues.length > 1) {
    selectedValues.splice(1);
  }

  // Map values → Discord role IDs.
  const desiredRoleIds = new Set(
    selectedValues.map(v => catRoleMap[v]).filter(Boolean));

  // Category role-id universe (so we don't touch unrelated roles).
  const categoryRoleIds = new Set(Object.values(catRoleMap));

  const memberRoles = new Set(data.member?.roles || []);
  const memberCategoryRoles = new Set(
    [...memberRoles].filter(id => categoryRoleIds.has(id)));

  const toAdd    = [...desiredRoleIds].filter(id => !memberCategoryRoles.has(id));
  const toRemove = [...memberCategoryRoles].filter(id => !desiredRoleIds.has(id));

  const addedLabels = [];
  const removedLabels = [];
  const failures = [];

  const labelForRoleId = (rid) => {
    for (const [val, id] of Object.entries(catRoleMap)) {
      if (id === rid) {
        const opt = category.options.find(o => o.value === val);
        if (opt) return opt.label;
      }
    }
    return rid;
  };

  for (const rid of toRemove) {
    const r = await dapi(env, 'DELETE',
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(rid)}`);
    if (r.ok || r.status === 204) removedLabels.push(labelForRoleId(rid));
    else failures.push({ op: 'remove', roleId: rid, status: r.status });
  }
  for (const rid of toAdd) {
    const r = await dapi(env, 'PUT',
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(rid)}`);
    if (r.ok || r.status === 204) addedLabels.push(labelForRoleId(rid));
    else failures.push({ op: 'add', roleId: rid, status: r.status });
  }

  // Build the ephemeral confirmation. If nothing changed, say so.
  const lines = [];
  if (addedLabels.length)   lines.push('➕ Added: ' + addedLabels.join(', '));
  if (removedLabels.length) lines.push('➖ Removed: ' + removedLabels.join(', '));
  if (!lines.length) lines.push('_No changes._');
  if (failures.length) {
    lines.push(`\n⚠ ${failures.length} role op(s) failed — bot may need to be moved ABOVE these roles in Server Settings → Roles.`);
  }
  return {
    type: RESP_CHAT,
    data: { content: lines.join('\n'), flags: FLAG_EPHEMERAL },
  };
}
