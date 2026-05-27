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
    placeholder: '🔔 Choose which pings you want',
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
    placeholder: '🎨 Pick your display color',
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
    placeholder: '🌎 Set your region',
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
    placeholder: '🎮 Set your platforms',
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
    placeholder: '🪪 Set your pronouns',
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

// Interests — opt-in pings for activity sub-communities. Mirrors the
// 6-entry INTERESTS catalogue from onboarding.js. Role IDs are NOT
// stored under self-roles-hub:roles:<g>.interests — instead, they're
// resolved at render-time from the onboarding role-map at KV
// `onboard:role-map:<g>` (with env.ONBOARD_ROLE_MAP fallback) via
// onboarding.js's loadRoleMap helper, so this surface stays in sync
// with whatever the admin configured for the onboarding picker.
// Lives in its own sub-ephemeral so it doesn't steal a row from the
// main 5-row picker.
export const INTERESTS_CATEGORY = {
  key: 'interests',
  title: '⭐ Interests',
  blurb: 'Opt into pings for the activities you care about. These mirror your onboarding picks — toggle any time.',
  placeholder: '⭐ Pick your interest pings',
  multi: true,
  options: [
    { value: 'gamenight',  label: 'Game Night',     emoji: { name: '🎮' } },
    { value: 'clash',      label: 'Clash',          emoji: { name: '⚔️' } },
    { value: 'boltbound',  label: 'Boltbound',      emoji: { name: '🃏' } },
    { value: 'boardgames', label: 'Board games',    emoji: { name: '♟️' } },
    { value: 'watching',   label: 'Just watching',  emoji: { name: '👀' } },
    { value: 'art',        label: 'Art-only',       emoji: { name: '🎨' } },
  ],
};

// Map a category key → { optionValue: discordRoleId }. Most categories
// resolve from the hub's own role map (provisioned via
// /admin/self-roles-hub/provision); 'interests' is special and reads
// from the onboarding role-map so admins manage interest mappings in
// one place. Returns {} when nothing's configured.
async function resolveCategoryRoleMap(env, guildId, categoryKey, hubRoleIds) {
  if (categoryKey === 'interests') {
    try {
      const { loadRoleMap } = await import('../onboarding.js');
      const m = await loadRoleMap(env, guildId);
      return (m && typeof m === 'object') ? m : {};
    } catch {
      return {};
    }
  }
  return hubRoleIds?.[categoryKey] || {};
}

// Lookup that includes both CATEGORIES and the side categories
// (INTERESTS_CATEGORY, AGE18_CATEGORY) so handleHubSelect can resolve
// any incoming custom_id.
function findCategory(key) {
  if (key === INTERESTS_CATEGORY.key) return INTERESTS_CATEGORY;
  return CATEGORIES.find(c => c.key === key) || null;
}

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
// 2026-05-27 redesign per Clay: replaced the multi-message layout
// (one embed per category) with a SINGLE channel-side message
// carrying an intro embed + one button "🪪 Open Role Picker". The
// picker itself is an ephemeral with the actual selects.

const HUB_BTN_OPEN      = 'roles:open-picker';
const HUB_BTN_COLOR     = 'roles:open-colors';
const HUB_BTN_INTERESTS = 'roles:open-interests';

function buildHubMessage(brandAccent = 0x7c5cff) {
  return {
    embeds: [{
      title: '🪪 Pick your roles',
      description:
        'Tap **Open Role Picker** to set your pings, region, platform, pronouns, name colour, and adult-content opt-in.\n\n' +
        'Your selections are **only visible to you** — the picker pops up as an ephemeral.',
      color: brandAccent,
    }],
    components: [{
      type: COMPONENT_ROW,
      components: [{
        type: COMPONENT_BUTTON,
        style: 1, // PRIMARY
        label: 'Open Role Picker',
        emoji: { name: '🪪' },
        custom_id: HUB_BTN_OPEN,
      }],
    }],
    allowed_mentions: { parse: [] },
  };
}

// Build a single category's select-menu component. `memberRoleIds`
// is the set of role IDs the user currently has — used to mark
// matching options as `default: true` so the picker renders with the
// current selections pre-filled.
function buildCategorySelect(category, catRoleMap, memberRoleIds) {
  const opts = category.options.map(o => {
    const rid = catRoleMap[o.value];
    return {
      label: o.label,
      value: o.value,
      description: o.color ? '#' + o.color.toString(16).padStart(6, '0') : undefined,
      emoji: o.emoji,
      default: !!(rid && memberRoleIds.has(rid)),
    };
  });
  // Category-specific placeholder makes each select self-labeling
  // — important because Discord renders the message content body
  // FIRST and all action rows beneath it, so without per-select
  // labels users see a stack of selects under the last header in
  // the body. Falls back to a generic prompt if the category
  // catalogue forgot to set one (none in core today; defensive).
  const placeholder = category.placeholder
    || (category.multi ? 'Pick any (multi-select)' : 'Pick one');
  return {
    type: COMPONENT_STRING_SELECT,
    custom_id: `roles:sel:${category.key}`,
    placeholder,
    min_values: 0,
    max_values: category.multi ? opts.length : 1,
    options: opts,
  };
}

// Build the main picker ephemeral payload. Layout (5 action rows
// max — Discord cap):
//   Row 1: 🔔 Pings select       (multi)
//   Row 2: 🌎 Region select      (multi)
//   Row 3: 🎮 Platform select    (multi)
//   Row 4: 🪪 Pronouns select    (multi)
//   Row 5: [🎨 Name Color] [🔞 18+ Access]
// Name Color and 18+ open their own sub-ephemerals because they need
// special UX (mutex + warning flow respectively) that doesn't share
// a single select cleanly with the other 4.
function buildPickerEphemeral(roleIds, memberRoleIds, banner = null) {
  // Discord ephemerals carry exactly ONE content body, so per-
  // category headers go in the body (in component order) AND each
  // select-menu's `placeholder` carries its category name inline.
  // Users see the body once at the top + the placeholder on every
  // closed select, so the categorisation reads clearly even though
  // Discord won't let us interleave text with action rows in a
  // single message.
  const lines = ['**Set your roles below.**'];
  if (banner) lines.push('', banner);
  lines.push(
    '',
    '🔔 **Pings** — what you want to be pinged for',
    '🌎 **Region** — roughly where you play from',
    '🎮 **Platform** — what you play on',
    '🪪 **Pronouns** — pick what you go by',
    '📂 **More & specials** — interests, name colour, 18+ via the buttons below',
  );

  const components = [];
  for (const key of ['pings', 'regions', 'platforms', 'pronouns']) {
    const cat = CATEGORIES.find(c => c.key === key);
    if (!cat) continue;
    components.push({
      type: COMPONENT_ROW,
      components: [buildCategorySelect(cat, roleIds[cat.key] || {}, memberRoleIds)],
    });
  }
  components.push({
    type: COMPONENT_ROW,
    components: [
      { type: COMPONENT_BUTTON, style: BTN_SECONDARY,
        label: 'More Roles', emoji: { name: '📂' }, custom_id: HUB_BTN_INTERESTS },
      { type: COMPONENT_BUTTON, style: BTN_SECONDARY,
        label: 'Name Color', emoji: { name: '🎨' }, custom_id: HUB_BTN_COLOR },
      { type: COMPONENT_BUTTON, style: BTN_SECONDARY,
        label: '18+ access', emoji: { name: '🔞' }, custom_id: 'roles:age18:start' },
    ],
  });
  return {
    content: lines.join('\n'),
    flags: FLAG_EPHEMERAL,
    components,
    allowed_mentions: { parse: [] },
  };
}

// Build the colour sub-picker (single-select / mutex). Lives in its
// own ephemeral spawned from the [🎨 Name Color] button so it doesn't
// eat one of the main picker's 5 rows.
function buildColorPickerEphemeral(roleIds, memberRoleIds, banner = null) {
  const cat = CATEGORIES.find(c => c.key === 'colors');
  const lines = [
    '## 🎨 Name Colour',
    '_Pick one — mutex. Choosing a new colour replaces your previous pick._',
  ];
  if (banner) lines.push('', banner);
  lines.push('', '_Mod note: colour roles must sit ABOVE other coloured roles in the hierarchy for Discord to render the colour on your name._');
  return {
    content: lines.join('\n'),
    flags: FLAG_EPHEMERAL,
    components: [{
      type: COMPONENT_ROW,
      components: [buildCategorySelect(cat, roleIds.colors || {}, memberRoleIds)],
    }],
    allowed_mentions: { parse: [] },
  };
}

// Build the More Roles sub-picker — currently just the Interests
// select. Lives in its own ephemeral spawned from the [📂 More Roles]
// button so it doesn't steal a row from the main picker. `roleMap`
// is the resolved interest-key → discordRoleId map (loaded via
// resolveCategoryRoleMap → onboarding's loadRoleMap helper).
function buildInterestsPickerEphemeral(roleMap, memberRoleIds, banner = null) {
  const lines = [
    '## ' + INTERESTS_CATEGORY.title,
    '_' + INTERESTS_CATEGORY.blurb + '_',
  ];
  if (banner) lines.push('', banner);
  // Empty mapping = admin hasn't configured the onboarding role-map
  // yet. Render a hint instead of a broken (un-grantable) select.
  if (!roleMap || Object.keys(roleMap).length === 0) {
    lines.push('', '_⚠ No interest roles configured yet — admin needs to run `/onboard role-map` (or set the `ONBOARD_ROLE_MAP` env var) before this section works._');
    return {
      content: lines.join('\n'),
      flags: FLAG_EPHEMERAL,
      allowed_mentions: { parse: [] },
    };
  }
  // Drop options whose role isn't mapped so users don't see un-grantable
  // entries. Mark currently-held mapped roles as default:true.
  const opts = INTERESTS_CATEGORY.options
    .filter(o => roleMap[o.value])
    .map(o => ({
      label: o.label,
      value: o.value,
      emoji: o.emoji,
      default: memberRoleIds.has(roleMap[o.value]),
    }));
  return {
    content: lines.join('\n'),
    flags: FLAG_EPHEMERAL,
    components: [{
      type: COMPONENT_ROW,
      components: [{
        type: COMPONENT_STRING_SELECT,
        custom_id: `roles:sel:${INTERESTS_CATEGORY.key}`,
        placeholder: 'Pick any (multi-select)',
        min_values: 0,
        max_values: opts.length,
        options: opts,
      }],
    }],
    allowed_mentions: { parse: [] },
  };
}

// ── Public post / refresh ────────────────────────────────────────────

const HUB_MSG_KV_KEY = (g) => `self-roles-hub:hub-msg:${g}`;

export async function postOrRefreshHub(env, guildId, channelId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!channelId)              return { ok: false, error: 'no-channel' };

  // Provision MUST have run first so the role IDs are stashed.
  const roleIds = await env.LOADOUT_BOLTS.get(ROLES_KV_KEY(guildId), { type: 'json' });
  if (!roleIds) {
    return { ok: false, error: 'roles-not-provisioned',
             message: 'Run POST /admin/self-roles-hub/provision/:guildId first.' };
  }

  // Sweep legacy artefacts so the channel only carries the new
  // single-message hub:
  //   • The very-old single-message self-roles post from self-roles.js
  //     (KV `self_roles:msg` under env.STATE).
  //   • Last turn's 6-message-per-category layout (KV
  //     `self-roles-hub:msgs:<g>` under env.LOADOUT_BOLTS).
  //   • The legacy guild-builder "Pick your pings" message if its
  //     id was previously stashed.
  try {
    const legacyMsgId = await env.STATE.get('self_roles:msg');
    if (legacyMsgId) {
      await dapi(env, 'DELETE',
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(legacyMsgId)}`)
        .catch(() => {});
      await env.STATE.delete('self_roles:msg');
    }
  } catch { /* non-fatal */ }

  const oldCategoryMsgs = (await env.LOADOUT_BOLTS.get(MSGS_KV_KEY(guildId), { type: 'json' })) || [];
  for (const m of oldCategoryMsgs) {
    if (m?.channelId && m?.messageId) {
      await dapi(env, 'DELETE',
        `/channels/${encodeURIComponent(m.channelId)}/messages/${encodeURIComponent(m.messageId)}`)
        .catch(() => {});
    }
  }
  if (oldCategoryMsgs.length) await env.LOADOUT_BOLTS.delete(MSGS_KV_KEY(guildId));

  const legacyPingsMsgId = await env.LOADOUT_BOLTS.get(LEGACY_PINGS_MSG_KV_KEY(guildId));
  if (legacyPingsMsgId) {
    await dapi(env, 'DELETE',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(legacyPingsMsgId)}`)
      .catch(() => {});
    await env.LOADOUT_BOLTS.delete(LEGACY_PINGS_MSG_KV_KEY(guildId));
  }

  // Post (or edit-in-place) the single hub message.
  const payload = buildHubMessage();
  const prior = await env.LOADOUT_BOLTS.get(HUB_MSG_KV_KEY(guildId), { type: 'json' });
  let messageId = null;

  if (prior?.channelId === channelId && prior?.messageId) {
    const r = await dapi(env, 'PATCH',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(prior.messageId)}`,
      payload);
    if (r.ok) messageId = prior.messageId;
  } else if (prior?.channelId && prior?.messageId) {
    // Channel changed — best-effort delete the old message before re-posting.
    await dapi(env, 'DELETE',
      `/channels/${encodeURIComponent(prior.channelId)}/messages/${encodeURIComponent(prior.messageId)}`)
      .catch(() => {});
  }

  if (!messageId) {
    const post = await dapi(env, 'POST',
      `/channels/${encodeURIComponent(channelId)}/messages`, payload);
    if (!post.ok) {
      return { ok: false, error: 'post-failed', status: post.status,
               body: post.body.slice(0, 200) };
    }
    let parsed = null;
    try { parsed = JSON.parse(post.body); } catch {}
    messageId = parsed?.id || null;
  }

  if (messageId) {
    await env.LOADOUT_BOLTS.put(HUB_MSG_KV_KEY(guildId),
      JSON.stringify({ channelId, messageId, postedAt: Date.now() }));
  }

  return {
    ok: true,
    channelId,
    messageId,
    swept: {
      legacyCategoryMsgs: oldCategoryMsgs.length,
      legacySelfRolesMsg: true,
    },
  };
}

// ── Picker openers ───────────────────────────────────────────────────
//
// Channel-side button → ephemeral picker. Reads the user's current
// member.roles so the selects render with current selections marked
// `default: true`.

export async function handleOpenPicker(env, data) {
  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');

  const roleIds = await env.LOADOUT_BOLTS.get(ROLES_KV_KEY(guildId), { type: 'json' });
  if (!roleIds) {
    return ephemeral('Role picker not configured yet — ask a mod to run `/admin/self-roles-hub/provision`.');
  }
  const memberRoleIds = new Set(data.member?.roles || []);
  return {
    type: RESP_CHAT,
    data: buildPickerEphemeral(roleIds, memberRoleIds),
  };
}

export async function handleOpenColorPicker(env, data) {
  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');

  const roleIds = await env.LOADOUT_BOLTS.get(ROLES_KV_KEY(guildId), { type: 'json' });
  if (!roleIds) return ephemeral('Role picker not configured yet — ask a mod to run provision.');
  const memberRoleIds = new Set(data.member?.roles || []);
  return {
    type: RESP_CHAT,
    data: buildColorPickerEphemeral(roleIds, memberRoleIds),
  };
}

export async function handleOpenInterestsPicker(env, data) {
  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');
  const interestRoleMap = await resolveCategoryRoleMap(env, guildId, 'interests', null);
  const memberRoleIds = new Set(data.member?.roles || []);
  return {
    type: RESP_CHAT,
    data: buildInterestsPickerEphemeral(interestRoleMap, memberRoleIds),
  };
}

// ── Select-menu submit handler ───────────────────────────────────────
//
// Multi-select diff:
//   adds    = (selected) − (current ∩ category_roles)
//   removes = (current ∩ category_roles) − selected
//
// Mutex (color category): same diff but selected has at most 1 entry.
//
// Response: RESP_UPDATE_MSG (type 7) so the picker ephemeral
// re-renders with the new defaults reflecting the just-applied
// change. The user can keep adjusting other categories without
// re-opening the picker. The colours sub-ephemeral re-renders its
// own dedicated single-select.

export async function handleHubSelect(env, data) {
  const cid = data?.data?.custom_id || '';
  const m = cid.match(/^roles:sel:([a-z0-9_]+)$/);
  if (!m) return ephemeral('Bad selector ID.');
  const categoryKey = m[1];
  const category = findCategory(categoryKey);
  if (!category) return ephemeral('Unknown category: ' + categoryKey);

  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Couldn\'t identify you.');

  // hubRoleIds is the self-roles-hub:roles:<g> map (provisioned via
  // the admin endpoint). Used as-is for pings/colors/regions/etc.;
  // 'interests' dispatches through resolveCategoryRoleMap to read
  // the onboarding role-map instead.
  const hubRoleIds = await env.LOADOUT_BOLTS.get(ROLES_KV_KEY(guildId), { type: 'json' });
  const catRoleMap = await resolveCategoryRoleMap(env, guildId, categoryKey, hubRoleIds);
  const validOptionValues = new Set(category.options.map(o => o.value));

  const selectedValues = (data.data?.values || [])
    .filter(v => validOptionValues.has(v));
  if (!category.multi && selectedValues.length > 1) {
    selectedValues.splice(1);
  }

  const desiredRoleIds = new Set(
    selectedValues.map(v => catRoleMap[v]).filter(Boolean));
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
    if (r.ok || r.status === 204) {
      removedLabels.push(labelForRoleId(rid));
      memberRoles.delete(rid);   // keep our in-memory snapshot honest for the re-render
    } else {
      failures.push({ op: 'remove', roleId: rid, status: r.status });
    }
  }
  for (const rid of toAdd) {
    const r = await dapi(env, 'PUT',
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(rid)}`);
    if (r.ok || r.status === 204) {
      addedLabels.push(labelForRoleId(rid));
      memberRoles.add(rid);
    } else {
      failures.push({ op: 'add', roleId: rid, status: r.status });
    }
  }

  // Build a one-line banner summarising what changed, prepended to
  // the re-rendered picker.
  const bannerParts = [];
  if (addedLabels.length)   bannerParts.push('➕ Added: ' + addedLabels.join(', '));
  if (removedLabels.length) bannerParts.push('➖ Removed: ' + removedLabels.join(', '));
  if (failures.length) {
    bannerParts.push(`⚠ ${failures.length} op(s) failed — bot role may sit BELOW these roles in the hierarchy.`);
  }
  const banner = bannerParts.length ? '✅ ' + bannerParts.join(' · ') : null;

  // Colors + Interests each live in their own sub-ephemeral spawned
  // from a button on the main picker. Re-render whichever one the
  // user is currently in so they keep adjusting without re-opening.
  let newData;
  if (categoryKey === 'colors') {
    newData = buildColorPickerEphemeral(hubRoleIds, memberRoles, banner);
  } else if (categoryKey === 'interests') {
    newData = buildInterestsPickerEphemeral(catRoleMap, memberRoles, banner);
  } else {
    newData = buildPickerEphemeral(hubRoleIds, memberRoles, banner);
  }
  return { type: RESP_UPDATE_MSG, data: newData };
}
