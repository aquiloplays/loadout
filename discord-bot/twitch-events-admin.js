// /twitch-event slash command handlers. Thin facade over
// twitch-events.js's KV helpers + a clean ephemeral table render
// for the `list` subcommand.

import {
  EVENT_TYPES,
  listEventRoutes,
  setEventChannel,
  setEventToggle,
  isValidEventType,
} from './twitch-events.js';

const FLAG_EPHEMERAL = 64;
const RESP_CHAT      = 4;

// Pretty label per event type — kept in one place so list + set
// + toggle responses use the same human-readable copy.
const PRETTY_LABEL = {
  follow:            'Follow',
  sub:               'Subscription (new)',
  gift:              'Gift sub',
  resub:             'Resub (with message)',
  cheer:             'Cheer / bits',
  raid:              'Raid (incoming)',
  live:              'Stream live (announce)',
  ended:             'Stream ended (summary)',
  redemption:        'Channel-point redemption',
  hypeTrainBegin:    'Hype train — begin',
  hypeTrainProgress: 'Hype train — progress',
  hypeTrainEnd:      'Hype train — end',
  pollBegin:         'Poll — begin',
  pollEnd:           'Poll — end',
  predictionBegin:   'Prediction — begin',
  predictionEnd:     'Prediction — end',
  ban:               'Mod: ban / timeout',
  unban:             'Mod: unban',
};

function ephemeral(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}

function ephemeralEmbed(embed) {
  return { type: RESP_CHAT, data: { embeds: [embed], flags: FLAG_EPHEMERAL } };
}

// Slash subcommand dispatch. options shape is the standard
// Discord interaction-data options array — [{name:'list'|'set'|'toggle', options?}]
export async function handleTwitchEventSlash(env, guildId, options) {
  if (!guildId) return ephemeral('No guild context.');
  const sub = options[0];
  if (!sub) return ephemeral('Pick a subcommand: list, set, or toggle.');

  if (sub.name === 'list') return await renderList(env, guildId);
  if (sub.name === 'set')  return await runSet(env, sub.options || []);
  if (sub.name === 'toggle') return await runToggle(env, sub.options || []);
  return ephemeral('Unknown subcommand.');
}

async function renderList(env, guildId) {
  const routes = await listEventRoutes(env, guildId);
  // Build a compact table. Use <#id> mentions so Discord renders them
  // as clickable channel pills.
  const lines = ['**Twitch event routing**', ''];
  for (const r of routes) {
    const label = PRETTY_LABEL[r.eventType] || r.eventType;
    const target = r.resolved
      ? `<#${r.resolved}>${r.override ? ' (override)' : ' (default)'}`
      : '_unset_';
    const onOff = r.enabled ? '✅' : '❌';
    lines.push(`${onOff} **${label}** → ${target}`);
  }
  lines.push('');
  lines.push('Default channel: bind via `/admin → channels → stream-notifications`.');
  lines.push('Set per-event override: `/twitch-event set type:<type> channel:#chan`');
  lines.push('Disable an event entirely: `/twitch-event toggle type:<type> enabled:False`');
  return ephemeralEmbed({
    title: '🟣 Twitch event routing',
    description: lines.join('\n').slice(0, 4000),
    color: 0x9146FF,
  });
}

async function runSet(env, opts) {
  const type    = opts.find(o => o.name === 'type')?.value;
  const channel = opts.find(o => o.name === 'channel')?.value || '';
  if (!isValidEventType(type)) return ephemeral(`Unknown event type: \`${type}\``);
  const r = await setEventChannel(env, type, channel);
  if (!r.ok) return ephemeral(`Failed: ${r.error}`);
  const label = PRETTY_LABEL[type] || type;
  if (r.cleared) {
    return ephemeral(`✅ Cleared override for **${label}** — will use the default \`stream-notifications\` binding now.`);
  }
  return ephemeral(`✅ **${label}** events will post to <#${r.override}>.`);
}

async function runToggle(env, opts) {
  const type    = opts.find(o => o.name === 'type')?.value;
  const enabled = opts.find(o => o.name === 'enabled')?.value;
  if (!isValidEventType(type)) return ephemeral(`Unknown event type: \`${type}\``);
  if (typeof enabled !== 'boolean') return ephemeral('`enabled` must be true or false.');
  const r = await setEventToggle(env, type, enabled);
  if (!r.ok) return ephemeral(`Failed: ${r.error}`);
  const label = PRETTY_LABEL[type] || type;
  return ephemeral(
    enabled
      ? `✅ **${label}** embeds re-enabled.`
      : `🔇 **${label}** embeds disabled — EventSub subscription still receives notifications, just no Discord post.`,
  );
}

// Test-only export.
export const _LABELS_FOR_TEST = PRETTY_LABEL;
export const _TYPES_FOR_TEST = EVENT_TYPES;
