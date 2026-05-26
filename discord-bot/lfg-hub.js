// LFG hub — persistent embed in the LFG channel with buttons users
// click instead of typing /lfg. Mirrors the onboarding-hub pattern:
//
//   Persistent embed   "🎮 Looking for Game"
//                       short intro + how-to-use
//                       buttons: Create / Browse / Close
//
//   Create button    → modal {game, slots(1-10), notes(paragraph)}
//                       on submit: writes through lfg.js createLfg
//                       (so the slash + hub paths share state) and
//                       enriches the post with class/level/avatar
//                       pulled from the character system.
//
//   Browse button    → ephemeral list of currently-open LFG posts,
//                       each with a Join button (custom_id
//                       `lfg:join:<lfgId>`).
//
//   Close button     → closes the caller's active LFG post if any.
//
// Component custom_ids:
//   lfg:create
//   lfg:browse
//   lfg:close
//   lfg:modal-submit   (modal: `modal:lfg-create`)
//   lfg:join:<lfgId>
//
// Persistent hub message id at KV `lfg:hub-msg:<g>` so a re-post
// cleanly relocates / replaces the prior one.

import {
  createLfg, joinLfg, closeLfg, listActiveLfgs,
} from './lfg.js';
import { getChannelBinding } from './channel-bindings.js';
import { getBranding } from './branding.js';
import { preferredHeroImageUrl } from './character.js';
import { loadHero } from './dungeon.js';
import { readXpDisplay } from './progression/xp.js';

const RESP_CHAT          = 4;
const RESP_UPDATE_MSG    = 7;
const RESP_MODAL         = 9;
const FLAG_EPHEMERAL     = 64;
const COMPONENT_ROW      = 1;
const COMPONENT_BUTTON   = 2;
const COMPONENT_SELECT   = 3;
const COMPONENT_TEXT_INPUT = 4;
const TEXT_INPUT_SHORT   = 1;
const TEXT_INPUT_PARA    = 2;
const BTN_PRIMARY        = 1;
const BTN_SECONDARY      = 2;
const BTN_SUCCESS        = 3;
const BTN_DANGER         = 4;

const HUB_MSG_KEY = (g) => `lfg:hub-msg:${g}`;

// Hint list — same shape as DEFAULT_WELCOME_CHANNEL_HINTS in
// onboarding.js. Used when /admin/lfg/post-hub gets no explicit
// channelId / channelName and the binding isn't set.
const DEFAULT_LFG_CHANNEL_HINTS = [
  'looking-for-game', 'lfg', 'looking-for', '🧩',
];

export function pickLfgChannel(channels, opts = {}) {
  const list = (Array.isArray(channels) ? channels : []).filter(c => c && c.type === 0);
  if (opts.channelId) {
    const explicit = list.find(c => String(c.id) === String(opts.channelId));
    return explicit ? { id: explicit.id, name: explicit.name || '' } : null;
  }
  if (opts.channelName) {
    const needle = String(opts.channelName).toLowerCase();
    const hit = list.find(c => String(c.name || '').toLowerCase().includes(needle));
    return hit ? { id: hit.id, name: hit.name || '' } : null;
  }
  for (const hint of DEFAULT_LFG_CHANNEL_HINTS) {
    const needle = hint.toLowerCase();
    const hit = list.find(c => String(c.name || '').toLowerCase().includes(needle));
    if (hit) return { id: hit.id, name: hit.name || '' };
  }
  return null;
}

// ── Hub embed ─────────────────────────────────────────────────────

export async function buildHubEmbed(env, guildId) {
  const brand = await getBranding(env, guildId);
  return {
    embed: {
      title: '🎮 Looking for Game',
      description:
        `Click **Create LFG post** to ping the community to play with you.\n\n` +
        `**How it works**\n` +
        `• Pick a game + slots, drop a note, optionally a voice channel\n` +
        `• Anyone can hit **Join** on your post — it auto-closes when full\n` +
        `• Use **Browse open posts** to see what's already running\n` +
        `• **Close my post** ends your active LFG early`,
      color: brand.accentColor || 0x7c5cff,
      footer: { text: '/lfg create still works if you prefer typing.' },
    },
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Create LFG post',  custom_id: 'lfg:create' },
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Browse open posts', custom_id: 'lfg:browse' },
        { type: COMPONENT_BUTTON, style: BTN_DANGER,    label: 'Close my post',    custom_id: 'lfg:close' },
      ],
    }],
  };
}

// ── Shared poster (admin route + future re-post slash) ────────────

export async function postLfgHub(env, guildId, channelId) {
  if (!channelId) return { ok: false, error: 'no-channel-id' };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };

  // Delete any prior hub message tracked in KV (best-effort — gone-
  // already is fine, that's exactly what we want).
  let deletedPrior = false;
  try {
    const prior = await env.LOADOUT_BOLTS.get(HUB_MSG_KEY(guildId), { type: 'json' });
    if (prior?.channelId && prior?.messageId) {
      const del = await fetch(
        `https://discord.com/api/v10/channels/${prior.channelId}/messages/${prior.messageId}`,
        {
          method: 'DELETE',
          headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord lfg-hub' },
        },
      );
      if (del.ok || del.status === 204 || del.status === 404) deletedPrior = true;
    }
  } catch { /* ignore */ }

  const { embed, components } = await buildHubEmbed(env, guildId);
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord lfg-hub',
    },
    body: JSON.stringify({ embeds: [embed], components, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: 'post-failed', status: r.status, body: t.slice(0, 200) };
  }
  const j = await r.json();
  await env.LOADOUT_BOLTS.put(HUB_MSG_KEY(guildId),
    JSON.stringify({ channelId, messageId: j.id, postedAt: Date.now() }));
  return { ok: true, channelId, messageId: j.id, deletedPrior };
}

// Admin HTTP route entry — resolves channel via opts + channel-
// binding then defers to postLfgHub. Mirrors postWelcomeEmbedForGuild
// in onboarding.js.
export async function postLfgHubForGuild(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  let pick;
  if (opts.channelId && !opts.channelName) {
    pick = { id: String(opts.channelId), name: '' };
  } else {
    // Order:
    //   1. explicit channelName substring match (caller's request)
    //   2. channel-binding(lfg) — same source the slash/hub use at runtime
    //   3. DEFAULT_LFG_CHANNEL_HINTS via pickLfgChannel
    const chRes = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent':  'loadout-discord lfg-hub',
      },
    });
    if (!chRes.ok) {
      const t = await chRes.text();
      return { ok: false, error: 'channels-fetch-failed', status: chRes.status, body: t.slice(0, 200) };
    }
    const channels = await chRes.json();
    if (opts.channelName) {
      pick = pickLfgChannel(channels, { channelName: opts.channelName });
    } else {
      // Try the binding first.
      const bound = await getChannelBinding(env, guildId, 'lfg');
      if (bound) {
        const inGuild = channels.find(c => c && String(c.id) === String(bound) && c.type === 0);
        if (inGuild) pick = { id: String(inGuild.id), name: inGuild.name || '' };
      }
      // Fall through to hint-based pick.
      if (!pick) pick = pickLfgChannel(channels, {});
    }
    if (!pick) return { ok: false, error: 'no-channel-match', tried: opts.channelName || DEFAULT_LFG_CHANNEL_HINTS };
  }
  const post = await postLfgHub(env, guildId, pick.id);
  if (!post.ok) return { ok: false, error: post.error, status: post.status, body: post.body, channelId: pick.id, channelName: pick.name };
  return {
    ok: true,
    channelId: pick.id,
    channelName: pick.name,
    messageId: post.messageId,
    deletedPrior: !!post.deletedPrior,
  };
}

// ── Component / modal handlers ───────────────────────────────────

// Button click router — `lfg:` prefix.
export async function handleLfgHubComponent(env, data) {
  const userId = data.member?.user?.id || data.user?.id;
  const userName =
    data.member?.user?.global_name || data.member?.user?.username ||
    data.user?.global_name || data.user?.username || 'someone';
  const guildId = data.guild_id;
  if (!userId || !guildId) {
    return { type: RESP_CHAT, data: { content: 'Run this in a server.', flags: FLAG_EPHEMERAL } };
  }
  const cid = data.data?.custom_id || '';

  if (cid === 'lfg:create') {
    return openCreateModal();
  }
  if (cid === 'lfg:browse') {
    return browseView(env, guildId, userId);
  }
  if (cid === 'lfg:close') {
    return closeMine(env, guildId, userId);
  }
  if (cid.startsWith('lfg:join:')) {
    const lfgId = cid.slice('lfg:join:'.length);
    return joinByButton(env, guildId, userId, userName, lfgId);
  }
  return { type: RESP_CHAT, data: { content: 'Unknown LFG action: ' + cid, flags: FLAG_EPHEMERAL } };
}

// Modal submit — `modal:lfg-create`.
export async function handleLfgModalSubmit(env, data) {
  const userId = data.member?.user?.id || data.user?.id;
  const userName =
    data.member?.user?.global_name || data.member?.user?.username ||
    data.user?.global_name || data.user?.username || 'someone';
  const guildId = data.guild_id;
  if (!userId || !guildId) {
    return { type: RESP_CHAT, data: { content: 'Run this in a server.', flags: FLAG_EPHEMERAL } };
  }

  const fields = {};
  for (const row of (data.data?.components || [])) {
    for (const c of (row.components || [])) fields[c.custom_id] = c.value || '';
  }
  const game = String(fields.game || '').trim().slice(0, 80);
  const slotsRaw = String(fields.slots || '').trim();
  const slots = Math.max(1, Math.min(10, parseInt(slotsRaw, 10) || 0));
  const notes = String(fields.notes || '').trim().slice(0, 500);
  if (!game) {
    return { type: RESP_CHAT, data: { content: '❌ Game name is required.', flags: FLAG_EPHEMERAL } };
  }
  if (!slots) {
    return { type: RESP_CHAT, data: { content: '❌ Slots must be a number 1-10.', flags: FLAG_EPHEMERAL } };
  }

  const r = await createLfg(env, { userId, hostName: userName, game, slots, guildId });
  if (!r.ok) {
    if (r.error === 'too-many-active') {
      return { type: RESP_CHAT, data: {
        content: '❌ You already have 3 active LFG posts — close one first.',
        flags: FLAG_EPHEMERAL,
      } };
    }
    return { type: RESP_CHAT, data: { content: '❌ ' + (r.error || 'create-failed'), flags: FLAG_EPHEMERAL } };
  }

  // Enrich the post with the host's character info + a Join button.
  // The Discord embed for the LFG record itself was already posted by
  // createLfg via postOrEditEmbed; THIS post is a separate richer
  // "you've been pinged to play" companion message with the host's
  // class/level/avatar + a tappable join button. Both live in the
  // same channel; users see the rich one first.
  await postEnrichedLfgPing(env, guildId, userId, userName, r.lfg, notes).catch(e =>
    console.warn('[lfg-hub] enriched ping failed', e?.message || e));

  return {
    type: RESP_CHAT,
    data: {
      content: `✅ Posted LFG for **${game}** — ${slots} slot${slots === 1 ? '' : 's'}.\n` +
        `id: \`${r.lfg.id}\``,
      flags: FLAG_EPHEMERAL,
    },
  };
}

// ── Internals ────────────────────────────────────────────────────

function openCreateModal() {
  return {
    type: RESP_MODAL,
    data: {
      custom_id: 'modal:lfg-create',
      title: 'Create LFG post',
      components: [
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT,
            custom_id: 'game',
            label: 'Game',
            style: TEXT_INPUT_SHORT,
            required: true,
            min_length: 1,
            max_length: 80,
            placeholder: 'e.g. Cult of the Lamb, Among Us, Chess',
          }],
        },
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT,
            custom_id: 'slots',
            label: 'Slots needed (1-10)',
            style: TEXT_INPUT_SHORT,
            required: true,
            min_length: 1,
            max_length: 2,
            placeholder: '4',
          }],
        },
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT,
            custom_id: 'notes',
            label: 'Notes (optional)',
            style: TEXT_INPUT_PARA,
            required: false,
            max_length: 500,
            placeholder: 'voice channel preferences, time, vibe, etc.',
          }],
        },
      ],
    },
  };
}

async function browseView(env, guildId, userId) {
  const all = await listActiveLfgs(env, { limit: 25 });
  // Filter to this guild (createLfg stores guildId on the record).
  const inGuild = all.filter(l => !l.guildId || String(l.guildId) === String(guildId));
  if (inGuild.length === 0) {
    return {
      type: RESP_CHAT,
      data: { content: 'No open LFG posts right now. Hit **Create LFG post** to start one.', flags: FLAG_EPHEMERAL },
    };
  }
  // Embed listing each + a row of Join buttons (max 5 per row, max
  // 5 rows → 25 buttons, matches our limit on inGuild above).
  const fields = inGuild.map(l => ({
    name: `${l.game} · ${l.players.length}/${l.slots}`,
    value: `host: <@${l.hostUserId}> · id: \`${l.id}\``,
    inline: false,
  }));
  const rows = [];
  let row = { type: COMPONENT_ROW, components: [] };
  for (const l of inGuild) {
    if (row.components.length >= 5) { rows.push(row); row = { type: COMPONENT_ROW, components: [] }; }
    if (rows.length >= 5) break;
    row.components.push({
      type: COMPONENT_BUTTON,
      style: l.players.find(p => p.userId === userId) ? BTN_SECONDARY : BTN_SUCCESS,
      label: `Join ${l.game.slice(0, 20)}`,
      custom_id: `lfg:join:${l.id}`,
      disabled: l.players.find(p => p.userId === userId) ? true : (l.players.length >= l.slots),
    });
  }
  if (row.components.length) rows.push(row);

  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: '🔎 Open LFG posts',
        description: 'Tap a button to join. The host gets a ping when you do.',
        color: 0x7c5cff,
        fields,
      }],
      components: rows,
      flags: FLAG_EPHEMERAL,
    },
  };
}

async function closeMine(env, guildId, userId) {
  const all = await listActiveLfgs(env, { limit: 50 });
  const mine = all.find(l => l.hostUserId === userId);
  if (!mine) {
    return {
      type: RESP_CHAT,
      data: { content: 'You don\'t have an active LFG post to close.', flags: FLAG_EPHEMERAL },
    };
  }
  const r = await closeLfg(env, mine.id, userId);
  if (!r.ok) {
    return { type: RESP_CHAT, data: { content: '❌ ' + (r.error || 'close-failed'), flags: FLAG_EPHEMERAL } };
  }
  return { type: RESP_CHAT, data: { content: `🔒 Closed your LFG \`${mine.id}\` (${mine.game}).`, flags: FLAG_EPHEMERAL } };
}

async function joinByButton(env, guildId, userId, userName, lfgId) {
  const r = await joinLfg(env, lfgId, { userId, name: userName });
  if (!r.ok) {
    const map = {
      'not-found':     'That post is gone.',
      'already-closed':'That post is already closed.',
      'already-joined':'You\'ve already joined that post.',
      'full':          'That post is full.',
    };
    return {
      type: RESP_CHAT,
      data: { content: '❌ ' + (map[r.error] || r.error || 'join-failed'), flags: FLAG_EPHEMERAL },
    };
  }
  let extra = '';
  if (r.autoClosed) extra = '\n🟢 That filled the post — game on!';
  return {
    type: RESP_CHAT,
    data: { content: `✅ Joined **${r.lfg.game}** (${r.lfg.players.length}/${r.lfg.slots}).${extra}`, flags: FLAG_EPHEMERAL },
  };
}

// Companion "rich ping" — separate message, NOT the lfg.js status
// embed. Includes the host's character avatar, class, level, notes,
// + a Join button. Posts in the LFG channel.
async function postEnrichedLfgPing(env, guildId, userId, userName, lfg, notes) {
  const channelId = await getChannelBinding(env, guildId, 'lfg')
    || env.LFG_CHANNEL_ID
    || env.ENGAGEMENT_CHANNEL_ID;
  if (!channelId || !env.DISCORD_BOT_TOKEN) return;
  // Hero + level lookups are best-effort — if any one fails we still
  // post the ping with reduced detail.
  let hero = null;
  let xp = null;
  let avatarUrl = null;
  try { hero = await loadHero(env, guildId, userId); } catch { /* idle */ }
  try { xp = await readXpDisplay(env, userId); } catch { /* idle */ }
  try { avatarUrl = await preferredHeroImageUrl(env, guildId, userId, hero?.lookVersion || 0); }
  catch { /* idle */ }

  const cls = hero?.className || hero?.class || null;
  const lv  = xp?.level || hero?.level || null;
  const subline = [
    cls ? `🧑 ${cls.charAt(0).toUpperCase() + cls.slice(1)}` : null,
    lv  ? `L${lv}` : null,
  ].filter(Boolean).join(' · ');

  const embed = {
    title: `🎮 ${userName} is looking to play ${lfg.game}`,
    description:
      (subline ? `_${subline}_\n\n` : '') +
      `**Slots:** ${lfg.players.length}/${lfg.slots}\n` +
      (notes ? `\n**Notes**\n${notes}\n` : '') +
      `\nid: \`${lfg.id}\``,
    color: 0x7c5cff,
    thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
    footer: { text: 'Tap Join below or run /lfg join id:' + lfg.id },
    timestamp: new Date(lfg.createdUtc).toISOString(),
  };

  await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord lfg-hub',
    },
    body: JSON.stringify({
      content: `<@${userId}>`,
      embeds: [embed],
      components: [{
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_SUCCESS, label: `Join (${lfg.players.length}/${lfg.slots})`, custom_id: `lfg:join:${lfg.id}` },
        ],
      }],
      allowed_mentions: { users: [userId] },
    }),
  });
}

export const _DEFAULT_LFG_CHANNEL_HINTS_FOR_TEST = DEFAULT_LFG_CHANNEL_HINTS;
