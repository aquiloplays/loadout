// Unified /loadout menu — slimmed to a profile-only surface after the
// Bolts economy was sunset (2026-06).
//
// Originally /loadout opened an ephemeral menu fronting the whole Bolts
// economy (wallet, daily, gift, leaderboard, hero, bag, shop, quick
// games). With the currency removed, the only surviving surface is the
// viewer profile editor — bio / pic / pronouns / socials / gamer tags —
// which is the same data the chat command + viewer overlay render. The
// richer cross-product profile lives at /passport; /loadout stays as a
// fast in-Discord editor for these fields.
//
// Routing convention: every component custom_id starts with "lo:" so
// dispatch in commands.js can hand the entire MESSAGE_COMPONENT and
// MODAL_SUBMIT traffic to one handler here.
//
//   lo:home, profile view
//   lo:profile, profile view
//   lo:profile:edit:<field>, open edit modal for that field
//   lo:profile:clear, wipe profile
//   lo:help, help view
//   lo:close, dismiss the menu

import {
  getProfile, clearProfile, setField, setSocial, setGamerTag
} from './profiles.js';

// ── Discord wire constants ─────────────────────────────────────────
const RESP_CHAT            = 4;
const RESP_DEFER_UPDATE    = 6;
const RESP_UPDATE_MESSAGE  = 7;
const RESP_MODAL           = 9;
const FLAG_EPHEMERAL       = 64;

// Component types
const COMPONENT_ROW            = 1;
const COMPONENT_BUTTON         = 2;
const COMPONENT_STRING_SELECT  = 3;
const COMPONENT_TEXT_INPUT     = 4;

// Button styles
const BTN_PRIMARY   = 1;   // blurple
const BTN_SECONDARY = 2;   // grey
const BTN_SUCCESS   = 3;   // green
const BTN_DANGER    = 4;   // red

// Text input styles
const INPUT_SHORT     = 1;
const INPUT_PARAGRAPH = 2;

// ── Public entry points ────────────────────────────────────────────

/** Render the main (profile) menu in response to /loadout. */
export async function renderLoadoutCommand(env, guild, userId, userName) {
  const view = await mainView(env, guild, userId, userName);
  return { type: RESP_CHAT, data: { ...view, flags: FLAG_EPHEMERAL } };
}

/** Handle a button click or select-menu choice (interaction type 3). */
export async function handleComponent(data, env) {
  const guild  = data.guild_id;
  const user   = data.member?.user || data.user;
  const userId = user?.id;
  const userName = user?.global_name || user?.username || 'viewer';
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('lo:')) {
    return json({ type: RESP_DEFER_UPDATE });
  }
  const parts = customId.split(':');   // ['lo', view, ...args]
  const view  = parts[1] || 'home';

  switch (view) {
    case 'home':
    case 'profile':
      if (parts[2] === 'edit')  return openModal(profileEditModal(parts[3]));
      if (parts[2] === 'clear') return updateMessage(await profileClearAction(env, guild, userId));
      return updateMessage(await mainView(env, guild, userId, userName));
    case 'help':        return updateMessage(helpView());
    case 'close':       return deleteMessage();
    default:
      return updateMessage(await mainView(env, guild, userId, userName));
  }
}

/** Handle a modal submission (interaction type 5). */
export async function handleModal(data, env) {
  const guild  = data.guild_id;
  const user   = data.member?.user || data.user;
  const userId = user?.id;
  const userName = user?.global_name || user?.username || 'viewer';
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('lo:m:')) {
    return updateMessage(await mainView(env, guild, userId, userName));
  }
  const parts = customId.split(':');     // ['lo', 'm', kind, ...args]
  const kind = parts[2];

  // Pull modal field values keyed by their custom_id (not their label).
  const fields = {};
  for (const row of data.data?.components || []) {
    for (const c of row.components || []) fields[c.custom_id] = c.value;
  }

  switch (kind) {
    case 'profile': {
      const field = parts[3];
      const r = await profileFieldAction(env, guild, userId, field, fields);
      return updateMessage({ ...r, components: [backRow('lo:profile')] });
    }
    default:
      return updateMessage(await mainView(env, guild, userId, userName));
  }
}

// ── Views ──────────────────────────────────────────────────────────

async function mainView(env, guild, userId, userName) {
  return profileView(env, guild, userId, userName);
}

async function profileView(env, guild, userId, userName) {
  const p = await getProfile(env, guild, userId);
  const lines = [
    `🪪 **Profile**, ${userName}`,
    p?.bio       ? `> _${truncate(p.bio, 280)}_` : '_(no bio set)_',
    '',
    p?.pronouns  ? `**Pronouns:** ${p.pronouns}` : '',
    p?.pfp       ? `**Pic:** [link](${p.pfp})`   : '',
    Object.keys(p?.socials   || {}).length ? `**Socials:** ${Object.entries(p.socials).map(([k, v]) => `\`${k}:${v}\``).join(' · ')}` : '',
    Object.keys(p?.gamerTags || {}).length ? `**Gamer tags:** ${Object.entries(p.gamerTags).map(([k, v]) => `\`${k}:${v}\``).join(' · ')}` : ''
  ].filter(Boolean);
  return {
    content: lines.join('\n'),
    components: [
      row(
        button('Edit bio',       'lo:profile:edit:bio',      BTN_SECONDARY),
        button('Edit pic',       'lo:profile:edit:pfp',      BTN_SECONDARY),
        button('Edit pronouns',  'lo:profile:edit:pronouns', BTN_SECONDARY)
      ),
      row(
        button('Add social',     'lo:profile:edit:social',   BTN_SECONDARY),
        button('Add gamer tag',  'lo:profile:edit:gamertag', BTN_SECONDARY),
        button('Wipe profile',   'lo:profile:clear',         BTN_DANGER)
      ),
      row(
        button('❓ Help',        'lo:help',  BTN_SECONDARY),
        button('❌ Close',       'lo:close', BTN_DANGER)
      )
    ]
  };
}

async function profileFieldAction(env, guild, userId, field, fields) {
  switch (field) {
    case 'bio':      await setField(env, guild, userId, 'bio',      (fields.bio || '').trim());       return { content: '🪪 Bio saved.' };
    case 'pfp':      await setField(env, guild, userId, 'pfp',      (fields.url || '').trim());       return { content: '🪪 Pic URL saved.' };
    case 'pronouns': await setField(env, guild, userId, 'pronouns', (fields.pronouns || '').trim()); return { content: '🪪 Pronouns saved.' };
    case 'social':   await setSocial  (env, guild, userId, (fields.platform || '').trim().toLowerCase(), (fields.handle || '').trim()); return { content: '🪪 Social saved.' };
    case 'gamertag': await setGamerTag(env, guild, userId, (fields.platform || '').trim().toLowerCase(), (fields.tag    || '').trim()); return { content: '🪪 Gamer tag saved.' };
    default:         return { content: 'Unknown field.' };
  }
}

async function profileClearAction(env, guild, userId) {
  await clearProfile(env, guild, userId);
  return { content: '🪪 Profile wiped.', components: [backRow()] };
}

// ── Help ───────────────────────────────────────────────────────────

function helpView() {
  return {
    content:
      '❓ **Loadout profile**\n' +
      '• **Bio / Pic / Pronouns**, the basics shown on your profile + the viewer overlay.\n' +
      '• **Socials**, link your handles (twitter / instagram / etc.).\n' +
      '• **Gamer tags**, your handle on psn / xbox / steam / etc.\n' +
      '• **Wipe profile**, clears everything above.\n\n' +
      'Looking for the fuller cross-product profile? Run **/passport**.',
    components: [backRow()]
  };
}

// ── Modals ─────────────────────────────────────────────────────────

function profileEditModal(field) {
  switch (field) {
    case 'bio':
      return {
        custom_id: 'lo:m:profile:bio',
        title: 'Edit bio',
        components: [{ type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'bio',
          label: 'Bio (up to 200 chars)', style: INPUT_PARAGRAPH, required: false, max_length: 200 }] }]
      };
    case 'pfp':
      return {
        custom_id: 'lo:m:profile:pfp',
        title: 'Edit profile pic URL',
        components: [{ type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'url',
          label: 'PNG / JPG / WebP URL', style: INPUT_SHORT, required: false, max_length: 400 }] }]
      };
    case 'pronouns':
      return {
        custom_id: 'lo:m:profile:pronouns',
        title: 'Edit pronouns',
        components: [{ type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'pronouns',
          label: 'Pronouns (e.g. they/them)', style: INPUT_SHORT, required: false, max_length: 24 }] }]
      };
    case 'social':
      return {
        custom_id: 'lo:m:profile:social',
        title: 'Add a social handle',
        components: [
          { type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'platform',
            label: 'Platform (twitter / instagram / etc.)', style: INPUT_SHORT, required: true, max_length: 24 }] },
          { type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'handle',
            label: 'Your handle (blank to remove)',         style: INPUT_SHORT, required: false, max_length: 80 }] }
        ]
      };
    case 'gamertag':
      return {
        custom_id: 'lo:m:profile:gamertag',
        title: 'Add a gamer tag',
        components: [
          { type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'platform',
            label: 'Platform (psn / xbox / steam / etc.)',  style: INPUT_SHORT, required: true, max_length: 24 }] },
          { type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'tag',
            label: 'Your tag on that platform (blank=remove)', style: INPUT_SHORT, required: false, max_length: 60 }] }
        ]
      };
    default:
      return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function row(...children) { return { type: COMPONENT_ROW, components: children.filter(Boolean) }; }
function button(label, customId, style = BTN_SECONDARY, disabled = false) {
  return { type: COMPONENT_BUTTON, label, custom_id: customId, style, disabled };
}
function backRow(target = 'lo:home') {
  return { type: COMPONENT_ROW, components: [
    button('← Back to menu', target, BTN_SECONDARY),
    button('❌ Close',        'lo:close', BTN_DANGER)
  ]};
}

function updateMessage(view) {
  return json({
    type: RESP_UPDATE_MESSAGE,
    data: { content: view.content || '', embeds: view.embeds, components: Array.isArray(view.components) ? view.components : [] }
  });
}
function openModal(modal) {
  return json({ type: RESP_MODAL, data: modal });
}
function deleteMessage() {
  // Discord doesn't have a native "delete the source message" response
  // type for ephemeral interactions, but UPDATE_MESSAGE with empty
  // content + components effectively dismisses it.
  return json({ type: RESP_UPDATE_MESSAGE, data: { content: '👋 Closed.', embeds: [], components: [] } });
}
function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }
