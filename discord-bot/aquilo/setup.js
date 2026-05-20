// /setup wizard. Walks the streamer through configuring a fresh Discord
// server: channel IDs, role IDs, stream time, etc. Each section is its
// own modal (Discord caps modals at 5 text inputs). Values are saved to
// KV per-guild via config.js, and read back through the envForGuild()
// proxy so handlers see them automatically without redeploying.

import {
  ephemeral, chat, modal, getModalField,
  btn, row, BTN_PRIMARY, BTN_SECONDARY, BTN_SUCCESS,
  isAdmin, COLOR_SCHEDULE
} from './util.js';
import {
  setActiveGuildId, setGuildConfigValue, getGuildConfig, SETUP_KEYS
} from './config.js';

const HUMAN = {
  SCHEDULE_CHANNEL_ID:        { label: 'Schedule channel',          help: 'Rolling weekly schedule embed lives here' },
  POLL_CHANNEL_ID:            { label: 'Poll channel',              help: 'Community-night polls post here Wed/Fri/Sat 6 PM ET' },
  QUEUE_CHANNEL_ID:           { label: 'Queue channel',             help: 'Queue post + idle CTA' },
  ENGAGEMENT_CHANNEL_ID:      { label: 'Engagement channel',        help: 'Daily prompts, this-or-that, spotlight, weekly recap' },
  COUNTDOWN_CHANNEL_ID:       { label: 'Countdown channel',         help: 'Channel-topic + embed countdown. Optional.' },
  COUNTDOWN_VC_ID:            { label: 'Countdown voice channel',   help: 'Sidebar VC whose name shows "Stream in 2h". Optional.' },
  ROLES_CHANNEL_ID:           { label: 'Self-roles channel',        help: 'Self-assign role buttons message lives here' },
  COUNTING_CHANNEL_ID:        { label: 'Counting game channel',     help: 'Where viewers type 1, 2, 3...' },
  FOURTHWALL_SALES_CHANNEL:   { label: 'Fourthwall sales channel',  help: 'Override channel for /fourthwall webhook posts' },
  ROTATION_POLL_CHANNEL_ID:   { label: 'Rotation poll channel',     help: 'Pre-stream music poll. Empty = post in invoking channel' },
  QUEUE_ELIGIBLE_ROLES_JSON:  { label: 'Eligible roles (JSON)',     help: 'JSON array of role IDs in priority order: ["123","456",…]' },
  COUNTING_FAIL_ROLE_ID:      { label: 'Counting fail role',        help: 'Temporary role given to whoever breaks the chain' },
  STAFF_ROLE_ID:              { label: 'Staff role (optional)',     help: 'Gates the /announce slash command if set' },
  STREAM_TIME_ET:             { label: 'Stream time (HH:MM ET)',    help: 'e.g. 22:30 for 10:30 PM ET' },
  PATREON_URL:                { label: 'Patreon URL',               help: 'Linked in queue idle CTA + non-eligible queue-join responses' },
  COUNTING_BASE_REWARD:       { label: 'Counting base reward',      help: 'Bolts per correct count, pre-multiplier (default 1)' },
  COUNTING_FAIL_PENALTY:      { label: 'Counting fail penalty',     help: 'Bolts deducted when someone breaks the chain (default 10)' },
  COUNTING_FAIL_DURATION_MIN: { label: 'Fail role minutes',         help: 'How long the fail role lasts (default 60)' },
  PRODUCTS:                   { label: 'Products map (JSON)',       help: '{"loadout":{"channel":"123","role_ping":"456"},...}' },
  SR_ROLE_LIMITS_JSON:        { label: 'SR role limits (JSON)',     help: 'Rotation pre-queue role caps. See README for shape.' }
};

// ---- /setup slash command -> overview ----------------------------------

export async function handleSetupCommand(data, env) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const guildId = data.guild_id;
  if (!guildId) return ephemeral('Use this command in a server, not a DM.');
  const cfg = await getGuildConfig(env, guildId);
  return ephemeral(renderOverview(env, guildId, cfg));
}

function fmtCh(id) { return id ? '<#' + id + '>' : '_unset_'; }
function fmtRole(id) { return id ? '<@&' + id + '>' : '_unset_'; }
function fmtRolesJson(s) {
  if (!s) return '_unset_';
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr) || !arr.length) return '_empty_';
    return arr.map(r => '<@&' + r + '>').join(' › ');
  } catch { return '⚠️ invalid JSON: `' + s.slice(0, 60) + '`'; }
}

function fmtJsonSummary(s) {
  if (!s) return '_unset_';
  try { const p = JSON.parse(s); return '`' + JSON.stringify(p).slice(0, 80) + (JSON.stringify(p).length > 80 ? '…' : '') + '`'; }
  catch { return '⚠️ invalid JSON'; }
}

function renderOverview(env, guildId, cfg) {
  const lines = [];
  lines.push('🔧 **Aquilo Bot · Setup for this server**');
  lines.push('');
  lines.push('Guild id: `' + guildId + '`');
  lines.push('');
  lines.push('**📺 Channels**');
  lines.push('• Schedule: '   + fmtCh(cfg.SCHEDULE_CHANNEL_ID));
  lines.push('• Poll: '       + fmtCh(cfg.POLL_CHANNEL_ID));
  lines.push('• Queue: '      + fmtCh(cfg.QUEUE_CHANNEL_ID));
  lines.push('• Engagement: ' + fmtCh(cfg.ENGAGEMENT_CHANNEL_ID));
  lines.push('• Countdown: '  + fmtCh(cfg.COUNTDOWN_CHANNEL_ID) + ' · VC `' + (cfg.COUNTDOWN_VC_ID || 'unset') + '`');
  lines.push('• Self-roles: ' + fmtCh(cfg.ROLES_CHANNEL_ID));
  lines.push('• Counting: '   + fmtCh(cfg.COUNTING_CHANNEL_ID));
  lines.push('• Fourthwall sales: ' + fmtCh(cfg.FOURTHWALL_SALES_CHANNEL));
  lines.push('• Rotation poll: '    + fmtCh(cfg.ROTATION_POLL_CHANNEL_ID));
  lines.push('');
  lines.push('**🎭 Roles**');
  lines.push('• Queue eligible (priority order): ' + fmtRolesJson(cfg.QUEUE_ELIGIBLE_ROLES_JSON));
  lines.push('• Counting fail role: ' + fmtRole(cfg.COUNTING_FAIL_ROLE_ID));
  lines.push('• Staff role: ' + fmtRole(cfg.STAFF_ROLE_ID));
  lines.push('');
  lines.push('**⚙️ Tuning**');
  lines.push('• Stream time (ET): `' + (cfg.STREAM_TIME_ET || env.STREAM_TIME_ET || '20:00') + '`');
  lines.push('• Patreon URL: ' + (cfg.PATREON_URL ? cfg.PATREON_URL : (env.PATREON_URL || '_unset_')));
  lines.push('• Counting reward: `' + (cfg.COUNTING_BASE_REWARD || env.COUNTING_BASE_REWARD || '1') + '` bolt/count · penalty: `' + (cfg.COUNTING_FAIL_PENALTY || env.COUNTING_FAIL_PENALTY || '10') + '` · fail role: `' + (cfg.COUNTING_FAIL_DURATION_MIN || env.COUNTING_FAIL_DURATION_MIN || '60') + '`min');
  lines.push('');
  lines.push('**🧬 Advanced**');
  lines.push('• Products map: '       + fmtJsonSummary(cfg.PRODUCTS));
  lines.push('• SR role limits: '     + fmtJsonSummary(cfg.SR_ROLE_LIMITS_JSON));
  lines.push('');
  lines.push('_Unset values fall through to the deploy-time defaults in `wrangler.toml`. Click a button to edit. After channels + roles are set, click **✅ Activate this server** to point cron at this guild._');

  const components = [
    row(
      btn('setup:channels_a', 'Channels 1', { style: BTN_PRIMARY,   emoji: '📺' }),
      btn('setup:channels_b', 'Channels 2', { style: BTN_PRIMARY,   emoji: '📺' }),
      btn('setup:roles',      'Roles',      { style: BTN_PRIMARY,   emoji: '🎭' }),
      btn('setup:tuning',     'Tuning',     { style: BTN_PRIMARY,   emoji: '⚙️' }),
      btn('setup:advanced',   'Advanced',   { style: BTN_PRIMARY,   emoji: '🧬' })
    ),
    row(
      btn('setup:activate',  'Activate this server', { style: BTN_SUCCESS,   emoji: '✅' }),
      btn('setup:refresh',   'Refresh overview',     { style: BTN_SECONDARY, emoji: '🔄' })
    )
  ];

  return { content: lines.join('\n'), components, flags: 64 };
}

// ---- Modal builders ----------------------------------------------------

function field(key, value) {
  const h = HUMAN[key] || { label: key, help: '' };
  return {
    custom_id: key,
    label: h.label.slice(0, 45),
    style: 1,
    required: false,
    max_length: 1024,
    value: value || undefined,
    placeholder: h.help.slice(0, 100)
  };
}

export async function channelsAModal(env, guildId) {
  const cfg = await getGuildConfig(env, guildId);
  return modal('modal:setup_channels_a', 'Channels (1/2)', [
    field('SCHEDULE_CHANNEL_ID',   cfg.SCHEDULE_CHANNEL_ID),
    field('POLL_CHANNEL_ID',       cfg.POLL_CHANNEL_ID),
    field('QUEUE_CHANNEL_ID',      cfg.QUEUE_CHANNEL_ID),
    field('ENGAGEMENT_CHANNEL_ID', cfg.ENGAGEMENT_CHANNEL_ID),
    field('COUNTDOWN_CHANNEL_ID',  cfg.COUNTDOWN_CHANNEL_ID)
  ]);
}

export async function channelsBModal(env, guildId) {
  const cfg = await getGuildConfig(env, guildId);
  return modal('modal:setup_channels_b', 'Channels (2/2)', [
    field('COUNTDOWN_VC_ID',          cfg.COUNTDOWN_VC_ID),
    field('ROLES_CHANNEL_ID',         cfg.ROLES_CHANNEL_ID),
    field('COUNTING_CHANNEL_ID',      cfg.COUNTING_CHANNEL_ID),
    field('FOURTHWALL_SALES_CHANNEL', cfg.FOURTHWALL_SALES_CHANNEL),
    field('ROTATION_POLL_CHANNEL_ID', cfg.ROTATION_POLL_CHANNEL_ID)
  ]);
}

export async function rolesModal(env, guildId) {
  const cfg = await getGuildConfig(env, guildId);
  return modal('modal:setup_roles', 'Roles & gates', [
    field('QUEUE_ELIGIBLE_ROLES_JSON', cfg.QUEUE_ELIGIBLE_ROLES_JSON),
    field('COUNTING_FAIL_ROLE_ID',     cfg.COUNTING_FAIL_ROLE_ID),
    field('STAFF_ROLE_ID',             cfg.STAFF_ROLE_ID)
  ]);
}

export async function tuningModal(env, guildId) {
  const cfg = await getGuildConfig(env, guildId);
  return modal('modal:setup_tuning', 'Tuning', [
    field('STREAM_TIME_ET',             cfg.STREAM_TIME_ET),
    field('PATREON_URL',                cfg.PATREON_URL),
    field('COUNTING_BASE_REWARD',       cfg.COUNTING_BASE_REWARD),
    field('COUNTING_FAIL_PENALTY',      cfg.COUNTING_FAIL_PENALTY),
    field('COUNTING_FAIL_DURATION_MIN', cfg.COUNTING_FAIL_DURATION_MIN)
  ]);
}

export async function advancedModal(env, guildId) {
  const cfg = await getGuildConfig(env, guildId);
  // PARAGRAPH style (2) for JSON blobs since they can be long.
  return modal('modal:setup_advanced', 'Advanced JSON', [
    { custom_id: 'PRODUCTS',            label: 'Products map (JSON)', style: 2, required: false, value: cfg.PRODUCTS || undefined,           max_length: 2000, placeholder: '{"loadout":{"channel":"123","role_ping":"456"},…}' },
    { custom_id: 'SR_ROLE_LIMITS_JSON', label: 'SR role limits (JSON)', style: 2, required: false, value: cfg.SR_ROLE_LIMITS_JSON || undefined, max_length: 2000, placeholder: '[{"role_id":"…","label":"…","max":5},…]' }
  ]);
}

// ---- Section button dispatch -------------------------------------------

export async function handleSetupButton(env, data) {
  if (!isAdmin(data)) return ephemeral('Admin only.');
  const action = (data.data?.custom_id || '').split(':')[1];
  const guildId = data.guild_id;

  if (action === 'channels_a') return channelsAModal(env, guildId);
  if (action === 'channels_b') return channelsBModal(env, guildId);
  if (action === 'roles')      return rolesModal(env, guildId);
  if (action === 'tuning')     return tuningModal(env, guildId);
  if (action === 'advanced')   return advancedModal(env, guildId);

  if (action === 'activate') {
    await setActiveGuildId(env, guildId);
    // Drop any cached single-tenant guild_id from bootstrap.js so cron
    // + lookups pick up the new active id on next call.
    try { await env.STATE.delete('guild_id'); } catch {}
    try { await env.STATE.delete('bootstrapped:v3'); } catch {}
    return ephemeral('✅ This server (`' + guildId + '`) is now the active guild. Cron will operate here from the next tick. Run `/hub` to post the admin panel.');
  }

  if (action === 'refresh') {
    const cfg = await getGuildConfig(env, guildId);
    return ephemeral(renderOverview(env, guildId, cfg));
  }

  return ephemeral('Unknown setup action.');
}

// ---- Modal submit handlers ---------------------------------------------

async function saveModalFields(env, guildId, fieldNames, data) {
  let saved = 0, cleared = 0;
  for (const f of fieldNames) {
    const v = (getModalField(data, f) || '').trim();
    if (v) { await setGuildConfigValue(env, guildId, f, v); saved++; }
    else   { await setGuildConfigValue(env, guildId, f, null); cleared++; }
  }
  return { saved, cleared };
}

export async function handleSetupChannelsASubmit(env, data) {
  const guildId = data.guild_id;
  const r = await saveModalFields(env, guildId, [
    'SCHEDULE_CHANNEL_ID', 'POLL_CHANNEL_ID', 'QUEUE_CHANNEL_ID',
    'ENGAGEMENT_CHANNEL_ID', 'COUNTDOWN_CHANNEL_ID'
  ], data);
  return ephemeral('📺 Channels (1/2) saved: ' + r.saved + ' set, ' + r.cleared + ' cleared. Run `/setup` to see the updated overview.');
}

export async function handleSetupChannelsBSubmit(env, data) {
  const guildId = data.guild_id;
  const r = await saveModalFields(env, guildId, [
    'COUNTDOWN_VC_ID', 'ROLES_CHANNEL_ID', 'COUNTING_CHANNEL_ID',
    'FOURTHWALL_SALES_CHANNEL', 'ROTATION_POLL_CHANNEL_ID'
  ], data);
  return ephemeral('📺 Channels (2/2) saved: ' + r.saved + ' set, ' + r.cleared + ' cleared.');
}

export async function handleSetupRolesSubmit(env, data) {
  const guildId = data.guild_id;
  // Validate QUEUE_ELIGIBLE_ROLES_JSON parses if present
  const rolesJson = (getModalField(data, 'QUEUE_ELIGIBLE_ROLES_JSON') || '').trim();
  if (rolesJson) {
    try {
      const arr = JSON.parse(rolesJson);
      if (!Array.isArray(arr)) return ephemeral('⚠️ Eligible roles must be a JSON **array** like `["123","456"]`.');
      if (!arr.every(r => /^\d{15,25}$/.test(r))) return ephemeral('⚠️ Each entry in eligible roles must be a Discord role ID (15-25 digit number).');
    } catch (e) {
      return ephemeral('⚠️ Eligible roles JSON didn\'t parse: ' + e.message);
    }
  }
  const r = await saveModalFields(env, guildId, [
    'QUEUE_ELIGIBLE_ROLES_JSON', 'COUNTING_FAIL_ROLE_ID', 'STAFF_ROLE_ID'
  ], data);
  return ephemeral('🎭 Roles saved: ' + r.saved + ' set, ' + r.cleared + ' cleared.');
}

export async function handleSetupTuningSubmit(env, data) {
  const guildId = data.guild_id;
  const time = (getModalField(data, 'STREAM_TIME_ET') || '').trim();
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) {
    return ephemeral('⚠️ Stream time must be HH:MM (24h), e.g. `22:30`.');
  }
  // Counting tuning values must parse as integers if provided.
  for (const k of ['COUNTING_BASE_REWARD', 'COUNTING_FAIL_PENALTY', 'COUNTING_FAIL_DURATION_MIN']) {
    const v = (getModalField(data, k) || '').trim();
    if (v && !/^\d+$/.test(v)) {
      return ephemeral('⚠️ ' + k + ' must be a positive integer.');
    }
  }
  const r = await saveModalFields(env, guildId, [
    'STREAM_TIME_ET', 'PATREON_URL',
    'COUNTING_BASE_REWARD', 'COUNTING_FAIL_PENALTY', 'COUNTING_FAIL_DURATION_MIN'
  ], data);
  return ephemeral('⚙️ Tuning saved: ' + r.saved + ' set, ' + r.cleared + ' cleared.');
}

export async function handleSetupAdvancedSubmit(env, data) {
  const guildId = data.guild_id;
  // Validate both JSON blobs parse if provided.
  for (const k of ['PRODUCTS', 'SR_ROLE_LIMITS_JSON']) {
    const v = (getModalField(data, k) || '').trim();
    if (v) {
      try { JSON.parse(v); }
      catch (e) { return ephemeral('⚠️ ' + k + ' didn\'t parse as JSON: ' + e.message); }
    }
  }
  const r = await saveModalFields(env, guildId, ['PRODUCTS', 'SR_ROLE_LIMITS_JSON'], data);
  return ephemeral('🧬 Advanced saved: ' + r.saved + ' set, ' + r.cleared + ' cleared.');
}
