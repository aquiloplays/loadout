// Self-serve setup wizard for new tenants.
//
// Replaces the "ping Clay to set up your server" pattern with an
// in-Discord wizard a streamer can run after inviting the bot. Four
// numbered steps; each one ephemeral, each one writing to KV so the
// streamer can /setup again later to resume or change settings.
//
// Steps:
//   1. INIT, register the guild as a tenant (writes guild:tenant:<g>)
//   2. CHANNELS, bind the channels Loadout needs: welcome, counting,
//                  check-in, support, voice category, join-to-create VC.
//                  Reuses any IDs already in guild:cfg:<g>.ids.
//   3. FEATURES, opt in/out of the optional surfaces (Boltbound,
//                  Clash, daily check-in, ticketing, temp VCs). Defaults
//                  to all-on for new tenants.
//   4. CONFIRM, summary + "Looks good" button writes a final tenant
//                 record with setupStep='complete'.
//
// Surface parity: every step also exposes a POST /web/setup/* route
// (HMAC-gated) so aquilo-site can render the same flow.

import {
  getTenant, registerTenant, setSetupStep,
} from './tenants.js';

const RESP_CHAT      = 4;
const RESP_UPDATE    = 7;   // edit the original ephemeral
const FLAG_EPHEMERAL = 64;

// ── Step 0: feature catalog (also used by /web/setup/features) ────────
export const FEATURE_CATALOG = [
  { id: 'counting',     label: 'Counting game',            default: true,
    note: 'Auto-react ✅/❌ in your counting channel; whole-numbers-only.' },
  { id: 'checkin',      label: 'Daily community check-in', default: true,
    note: 'One check-in per day (web + Discord), streak shields supported.' },
  { id: 'tickets',      label: 'Support tickets',           default: true,
    note: 'Per-user private channels via the support panel button.' },
  { id: 'temp-vc',      label: 'Join-to-create voice',      default: true,
    note: 'Members joining the parent VC get a fresh room they own.' },
  { id: 'welcome',      label: 'Welcome embed',             default: true,
    note: 'On-theme embed for each new member (needs gateway shim).' },
  { id: 'booster',      label: 'Booster perks',             default: true,
    note: 'Bolt multiplier + welcome pack on server boost (needs shim).' },
  { id: 'boltbound',    label: 'Boltbound card game',        default: true,
    note: '/boltbound, collectible card duel + Twitch ext integration.' },
  { id: 'clash',        label: 'Clash town builder',        default: true,
    note: '/clash, base-building + raids vs goblins.' },
  { id: 'referrals',    label: 'Referrals + onboarding',    default: true,
    note: '/referral + /quest + aquilo.gg/quest funnel.' },
];

// ── Step 0.5: channel binding catalog ──────────────────────────────────
// Each entry maps a slot in guild:cfg:<g>.ids → human-readable label +
// what feature it gates. The wizard's CHANNELS step shows the current
// binding (if any), lets the streamer paste a channel mention (#name)
// or ID, and writes back to guild:cfg:<g>.ids.
export const CHANNEL_SLOTS = [
  { id: 'ch_welcome',           label: 'Welcome channel',            type: 'text',
    note: 'Welcome embed lands here on each new member join.' },
  { id: 'ch_counting',          label: 'Counting channel',           type: 'text',
    note: 'Numbers-only, bot reacts ✅/❌ to each message.' },
  { id: 'ch_checkin',           label: 'Daily check-in channel',     type: 'text',
    note: 'Where /checkin posts the embed.' },
  { id: 'ch_support',           label: 'Support / ticket panel',      type: 'text',
    note: 'Bot posts a "Create Ticket" button here.' },
  { id: 'cat_voice',            label: 'Voice category',             type: 'category',
    note: 'Temp VCs are minted under this category.' },
  { id: 'vc_join_to_create',    label: 'Join-to-create voice',       type: 'voice',
    note: 'Members joining this VC get a fresh room.' },
  { id: 'ch_activity_feed',     label: 'Activity feed',              type: 'text',
    note: 'Achievement / win / streak / pack-pull events post here.' },
  { id: 'ch_games',             label: 'Games hub',                  type: 'text',
    note: 'Where /play, /boltbound, board-game commands belong.' },
];

// ── Step persistence ───────────────────────────────────────────────────
async function getGuildCfg(env, guildId) {
  return (await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' })) || { ids: {} };
}
async function saveGuildCfg(env, guildId, cfg) {
  await env.LOADOUT_BOLTS.put(`guild:cfg:${guildId}`, JSON.stringify(cfg));
}
async function getFeatures(env, guildId) {
  const t = await getTenant(env, guildId);
  if (t?.features) return t.features;
  const defaults = {};
  for (const f of FEATURE_CATALOG) defaults[f.id] = f.default;
  return defaults;
}

// ── Util: parse a channel id from "#mention" / "<#id>" / "id" ─────────
function parseChannelId(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{17,21})/);
  return m ? m[1] : null;
}

// ── Step 1: INIT ───────────────────────────────────────────────────────
async function renderStepInit(env, guildId, userId) {
  const existing = await getTenant(env, guildId);
  const isResume = !!existing;
  return {
    type: RESP_CHAT,
    data: {
      flags: FLAG_EPHEMERAL,
      embeds: [{
        title: isResume ? '⚙️  Loadout setup, resume' : '✨  Loadout setup, welcome!',
        description: isResume
          ? `This server already has a Loadout tenant record (created <t:${Math.floor((existing.createdUtc || 0)/1000)}:R>).\n\nClick **Continue** to revisit the wizard, current settings are kept as defaults.`
          : 'This four-step wizard configures Loadout for your server. Each step is saved so you can `/setup` again later to change anything.\n\n**Step 1 of 4, register your server**\nLooks good? Click **Continue** to register and move to channel bindings.',
        color: 0x5fa0f8,
        footer: { text: 'Setup · step 1/4' },
      }],
      components: [{
        type: 1, components: [
          { type: 2, style: 3, label: isResume ? 'Continue' : 'Register & continue',
            custom_id: `setup:step2:${guildId}` },
        ],
      }],
    },
  };
}

async function applyStepInit(env, guildId, userId) {
  await registerTenant(env, guildId, { ownerId: userId, source: 'setup', setupStep: 'channels' });
}

// ── Step 2: CHANNELS ───────────────────────────────────────────────────
async function renderStepChannels(env, guildId) {
  const cfg = await getGuildCfg(env, guildId);
  const rows = CHANNEL_SLOTS.map(s => {
    const bound = cfg.ids?.[s.id];
    return `• **${s.label}** _(${s.type})_, ${bound ? `<#${bound}>` : '_unbound_'}\n  ${s.note}`;
  });
  return {
    type: RESP_UPDATE,
    data: {
      flags: FLAG_EPHEMERAL,
      embeds: [{
        title: '📍  Step 2 of 4, channel bindings',
        description:
          'Loadout needs to know which channel each feature should target. Open the website setup page to bind channels with dropdowns, OR run `/setup channel <slot> <channel>` to bind one at a time.\n\n'
          + rows.join('\n\n')
          + '\n\n**Either way, click _Next_ when you\'re done, unbound channels just mean that feature stays dormant.**',
        color: 0x5fa0f8,
        footer: { text: 'Setup · step 2/4' },
      }],
      components: [{
        type: 1, components: [
          { type: 2, style: 5, label: 'Bind on aquilo.gg',
            url: `https://aquilo.gg/setup?step=channels&guild=${guildId}` },
          { type: 2, style: 3, label: 'Next, features',
            custom_id: `setup:step3:${guildId}` },
        ],
      }],
    },
  };
}

// ── Step 3: FEATURES ───────────────────────────────────────────────────
async function renderStepFeatures(env, guildId) {
  const features = await getFeatures(env, guildId);
  const rows = FEATURE_CATALOG.map(f => {
    const on = features[f.id] !== false;
    return `${on ? '✅' : '◯'}  **${f.label}**, ${f.note}`;
  });
  return {
    type: RESP_UPDATE,
    data: {
      flags: FLAG_EPHEMERAL,
      embeds: [{
        title: '🎛️  Step 3 of 4, feature toggles',
        description:
          'All features default on. Toggle anything off you don\'t want for your community, you can change these any time via `/setup` or the website.\n\n'
          + rows.join('\n\n')
          + '\n\n_Click a feature on the website to toggle, or click _Next_ to accept the current state._',
        color: 0x5fa0f8,
        footer: { text: 'Setup · step 3/4' },
      }],
      components: [{
        type: 1, components: [
          { type: 2, style: 5, label: 'Toggle on aquilo.gg',
            url: `https://aquilo.gg/setup?step=features&guild=${guildId}` },
          { type: 2, style: 3, label: 'Next, review',
            custom_id: `setup:step4:${guildId}` },
        ],
      }],
    },
  };
}

// ── Step 4: CONFIRM ────────────────────────────────────────────────────
async function renderStepConfirm(env, guildId) {
  const cfg = await getGuildCfg(env, guildId);
  const features = await getFeatures(env, guildId);
  const bound   = CHANNEL_SLOTS.filter(s => cfg.ids?.[s.id]);
  const unbound = CHANNEL_SLOTS.filter(s => !cfg.ids?.[s.id]);
  const featuresOn  = FEATURE_CATALOG.filter(f => features[f.id] !== false).map(f => f.label);
  const featuresOff = FEATURE_CATALOG.filter(f => features[f.id] === false).map(f => f.label);

  const lines = [
    `**Channels bound (${bound.length}/${CHANNEL_SLOTS.length}):**`,
    bound.length ? bound.map(s => `• ${s.label} → <#${cfg.ids[s.id]}>`).join('\n') : '_(none yet, features needing channels stay dormant)_',
    '',
    `**Features enabled (${featuresOn.length}/${FEATURE_CATALOG.length}):**`,
    featuresOn.length ? featuresOn.map(l => `• ${l}`).join('\n') : '_(none)_',
  ];
  if (unbound.length) {
    lines.push('', `_Unbound channels:_  ${unbound.map(s => s.label).join(', ')}`);
  }
  if (featuresOff.length) {
    lines.push(`_Features off:_  ${featuresOff.join(', ')}`);
  }

  return {
    type: RESP_UPDATE,
    data: {
      flags: FLAG_EPHEMERAL,
      embeds: [{
        title: '🏁  Step 4 of 4, review & finish',
        description: lines.join('\n'),
        color: 0x5fa0f8,
        footer: { text: 'Setup · step 4/4 · click Finish to complete' },
      }],
      components: [{
        type: 1, components: [
          { type: 2, style: 2, label: '← Back to channels',
            custom_id: `setup:step2:${guildId}` },
          { type: 2, style: 3, label: '🏁  Finish setup',
            custom_id: `setup:finish:${guildId}` },
        ],
      }],
    },
  };
}

async function applyStepFinish(env, guildId, userId) {
  await registerTenant(env, guildId, { ownerId: userId, setupStep: 'complete' });
}

// ── Slash command entry: /setup ────────────────────────────────────────
// Subcommands:
//   /setup           → opens the wizard at step 1
//   /setup channel <slot> <channel>  → bind one channel (used between steps)
//   /setup feature <id> <on|off>     → toggle one feature
//   /setup status                    → quick snapshot of current state
export async function handleSetupCommand(env, data) {
  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  if (!guildId) return { type: RESP_CHAT, data: { content: 'Run this in a server.', flags: FLAG_EPHEMERAL } };

  const sub = (data.data?.options || [])[0];
  const subName = sub?.name || null;

  if (subName === 'channel') {
    return slashChannel(env, guildId, sub.options || []);
  }
  if (subName === 'feature') {
    return slashFeature(env, guildId, sub.options || []);
  }
  if (subName === 'status') {
    return slashStatus(env, guildId);
  }
  if (subName === 'bind') {
    return slashBind(env, guildId, sub.options || []);
  }
  if (subName === 'unbind') {
    return slashUnbind(env, guildId, sub.options || []);
  }
  if (subName === 'bindings') {
    return slashBindings(env, guildId);
  }
  // Default: open wizard at step 1.
  return renderStepInit(env, guildId, userId);
}

async function slashBind(env, guildId, options) {
  const cmd = String(options.find(o => o.name === 'command')?.value || '').toLowerCase().trim();
  const channelId = String(options.find(o => o.name === 'channel')?.value || '');
  if (!cmd) return { type: RESP_CHAT, data: { content: 'Command name required.', flags: FLAG_EPHEMERAL } };
  if (!/^\d{17,21}$/.test(channelId)) return { type: RESP_CHAT, data: { content: 'Bad channel id.', flags: FLAG_EPHEMERAL } };
  const { addCommandChannel } = await import('./command-bindings.js');
  const r = await addCommandChannel(env, guildId, cmd, channelId);
  return { type: RESP_CHAT, data: {
    content: `✅ \`/${cmd}\` is now allowed in: ${r.channels.map(c => `<#${c}>`).join(', ')}`,
    flags: FLAG_EPHEMERAL,
  } };
}

async function slashUnbind(env, guildId, options) {
  const cmd = String(options.find(o => o.name === 'command')?.value || '').toLowerCase().trim();
  if (!cmd) return { type: RESP_CHAT, data: { content: 'Command name required.', flags: FLAG_EPHEMERAL } };
  const { unbindCommand } = await import('./command-bindings.js');
  await unbindCommand(env, guildId, cmd);
  return { type: RESP_CHAT, data: {
    content: `🔓 \`/${cmd}\` is now allowed in any channel.`,
    flags: FLAG_EPHEMERAL,
  } };
}

async function slashBindings(env, guildId) {
  const { loadBindings } = await import('./command-bindings.js');
  const b = await loadBindings(env, guildId);
  const entries = Object.entries(b).filter(([_, v]) => Array.isArray(v) && v.length);
  if (entries.length === 0) {
    return { type: RESP_CHAT, data: { content: '_No command bindings set, every command works in every channel._', flags: FLAG_EPHEMERAL } };
  }
  const lines = ['🔗  **Command bindings**', ''];
  for (const [cmd, channels] of entries.sort()) {
    lines.push(`• \`/${cmd}\` → ${channels.map(c => `<#${c}>`).join(', ')}`);
  }
  return { type: RESP_CHAT, data: { content: lines.join('\n'), flags: FLAG_EPHEMERAL } };
}

async function slashChannel(env, guildId, options) {
  const slotId   = options.find(o => o.name === 'slot')?.value;
  // Discord sends TYPE_CHANNEL (type 7) options as the channel ID
  // string directly in `value`, no parsing needed.
  const channelId = String(options.find(o => o.name === 'channel')?.value || '');
  const slot = CHANNEL_SLOTS.find(s => s.id === slotId);
  if (!slot) {
    return { type: RESP_CHAT, data: { content: `Unknown slot \`${slotId}\`. Valid: ${CHANNEL_SLOTS.map(s=>s.id).join(', ')}`, flags: FLAG_EPHEMERAL } };
  }
  if (!/^\d{17,21}$/.test(channelId)) {
    return { type: RESP_CHAT, data: { content: 'Bad channel id.', flags: FLAG_EPHEMERAL } };
  }
  const cfg = await getGuildCfg(env, guildId);
  cfg.ids = cfg.ids || {};
  cfg.ids[slotId] = channelId;
  await saveGuildCfg(env, guildId, cfg);
  return { type: RESP_CHAT, data: { content: `✅ Bound **${slot.label}** → <#${channelId}>`, flags: FLAG_EPHEMERAL } };
}

async function slashFeature(env, guildId, options) {
  const id    = options.find(o => o.name === 'id')?.value;
  const state = String(options.find(o => o.name === 'state')?.value || '').toLowerCase();
  const f = FEATURE_CATALOG.find(x => x.id === id);
  if (!f) {
    return { type: RESP_CHAT, data: { content: `Unknown feature \`${id}\`. Valid: ${FEATURE_CATALOG.map(f=>f.id).join(', ')}`, flags: FLAG_EPHEMERAL } };
  }
  const on = state === 'on' || state === 'true' || state === '1' || state === 'enabled';
  const features = await getFeatures(env, guildId);
  features[id] = on;
  await registerTenant(env, guildId, { features });
  return { type: RESP_CHAT, data: { content: `${on ? '✅' : '◯'} Feature **${f.label}** → ${on ? 'on' : 'off'}`, flags: FLAG_EPHEMERAL } };
}

async function slashStatus(env, guildId) {
  const t = await getTenant(env, guildId);
  if (!t) {
    return { type: RESP_CHAT, data: { content: 'This server has not run `/setup` yet. Run `/setup` to start.', flags: FLAG_EPHEMERAL } };
  }
  const cfg = await getGuildCfg(env, guildId);
  const features = await getFeatures(env, guildId);
  const bound   = CHANNEL_SLOTS.filter(s => cfg.ids?.[s.id]).length;
  const enabled = FEATURE_CATALOG.filter(f => features[f.id] !== false).length;
  const lines = [
    `📊  **Loadout setup status**`,
    `Status: \`${t.status}\` · Step: \`${t.setupStep}\``,
    `Channels bound: **${bound}/${CHANNEL_SLOTS.length}**`,
    `Features enabled: **${enabled}/${FEATURE_CATALOG.length}**`,
    `Last updated: <t:${Math.floor((t.updatedUtc || 0)/1000)}:R>`,
  ];
  return { type: RESP_CHAT, data: { content: lines.join('\n'), flags: FLAG_EPHEMERAL } };
}

// ── Component handler: setup:step2/3/4/finish ──────────────────────────
export async function handleSetupComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  const [, action] = cid.split(':');
  if (!guildId) return { type: RESP_CHAT, data: { content: 'Run this in a server.', flags: FLAG_EPHEMERAL } };

  if (action === 'step2') {
    await applyStepInit(env, guildId, userId);
    return renderStepChannels(env, guildId);
  }
  if (action === 'step3') {
    await setSetupStep(env, guildId, 'features');
    return renderStepFeatures(env, guildId);
  }
  if (action === 'step4') {
    await setSetupStep(env, guildId, 'confirm');
    return renderStepConfirm(env, guildId);
  }
  if (action === 'finish') {
    await applyStepFinish(env, guildId, userId);
    return {
      type: RESP_UPDATE,
      data: {
        flags: FLAG_EPHEMERAL,
        embeds: [{
          title: '🎉  Setup complete!',
          description:
            'Loadout is now active on this server. You can re-run `/setup` any time to update channels, toggle features, or check status.\n\n'
            + 'Quick links:\n'
            + `• \`/setup channel <slot> <#channel>\` to bind a channel\n`
            + `• \`/setup feature <id> on|off\` to toggle a feature\n`
            + `• \`/setup status\` for a quick snapshot\n`
            + `• Setup page: https://aquilo.gg/setup?guild=${guildId}`,
          color: 0x9eff66,
          footer: { text: 'Welcome to Loadout!' },
        }],
        components: [],
      },
    };
  }
  return { type: RESP_CHAT, data: { content: `Unknown setup action \`${action}\`.`, flags: FLAG_EPHEMERAL } };
}

// ── Web endpoints, POST /web/setup/* ──────────────────────────────────
//
// The site mirrors the same flow with richer UI (channel pickers from
// /web/guild/<g>/channels, role pickers, etc.). All HMAC-gated via
// web.js's standard guard.

// POST /web/setup/snapshot   { discordId, guildId }
//   → full state: tenant + cfg + features + per-slot binding + per-feature toggle
export async function webSnapshot(env, guildId, _discordId) {
  const tenant   = await getTenant(env, guildId);
  const cfg      = await getGuildCfg(env, guildId);
  const features = await getFeatures(env, guildId);
  return {
    ok:       true,
    tenant:   tenant || null,
    slots:    CHANNEL_SLOTS.map(s => ({
      ...s, channelId: cfg.ids?.[s.id] || null,
    })),
    features: FEATURE_CATALOG.map(f => ({
      ...f, enabled: features[f.id] !== false,
    })),
  };
}

// POST /web/setup/init       { discordId, guildId }
export async function webInit(env, guildId, discordId) {
  const r = await registerTenant(env, guildId, {
    ownerId: discordId, source: 'web', setupStep: 'channels',
  });
  return r;
}

// POST /web/setup/channel    { discordId, guildId, slot, channelId }
export async function webBindChannel(env, guildId, body) {
  const slot = CHANNEL_SLOTS.find(s => s.id === body?.slot);
  const channelId = parseChannelId(body?.channelId);
  if (!slot) return { ok: false, error: 'unknown-slot' };
  if (!channelId) return { ok: false, error: 'bad-channel-id' };
  const cfg = await getGuildCfg(env, guildId);
  cfg.ids = cfg.ids || {};
  cfg.ids[slot.id] = channelId;
  await saveGuildCfg(env, guildId, cfg);
  return { ok: true, slot: slot.id, channelId };
}

// POST /web/setup/feature    { discordId, guildId, id, enabled }
export async function webToggleFeature(env, guildId, body) {
  const f = FEATURE_CATALOG.find(x => x.id === body?.id);
  if (!f) return { ok: false, error: 'unknown-feature' };
  const features = await getFeatures(env, guildId);
  features[f.id] = !!body.enabled;
  await registerTenant(env, guildId, { features });
  return { ok: true, id: f.id, enabled: features[f.id] };
}

// POST /web/setup/finish     { discordId, guildId }
export async function webFinish(env, guildId, discordId) {
  return registerTenant(env, guildId, { ownerId: discordId, setupStep: 'complete' });
}
