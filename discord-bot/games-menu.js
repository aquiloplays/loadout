// Games menu, the pinned message in #games (channel 1507973935973531808
// for the Aquilo guild) that surfaces every Loadout game entry point
// as buttons. Each click opens an ephemeral with the existing per-game
// menu, no logic duplication.
//
// Why this exists (Clay 2026-05-28):
//   Slash commands clutter Discord's autocomplete and force viewers to
//   memorise 15+ incantations (/boltbound, /clash, /play, /campaign,
//   …). Collapsing them into a single pinned message gives one
//   discoverable entry point. The slashes that backed these flows are
//   now `default_member_permissions: '0'`, admins can still run them
//   for testing, viewers get the menu.
//
// Routing:
//   custom_id format `gm:<key>[:…]`. handleGamesMenuComponent matches
//   the key + dispatches to the existing per-game renderer (boltbound /
//   clash / play / campaign / character / pet / loadout / hub / etc.).
//   All replies use RESP_CHAT + FLAG_EPHEMERAL so each viewer sees
//   their own private window.
//
// Admin lifecycle:
//   POST /admin/games-menu/post/:guildId, creates (or refreshes) the
//   pinned message. Idempotent: reuses the existing message id from
//   `games-menu:msg:<gid>` KV, falls back to posting fresh if the
//   message was deleted. Also pins the new message + un-pins the
//   prior pin if any.

import {
  RESP_CHAT, FLAG_EPHEMERAL,
} from './aquilo/util.js';

// Component types (Discord docs):
//   1=row 2=button 3=select 4=stringSelect
const COMP_ROW    = 1;
const COMP_BUTTON = 2;
const STYLE_PRIMARY   = 1;
const STYLE_SECONDARY = 2;
const STYLE_SUCCESS   = 3;
const STYLE_LINK      = 5;

function button(label, customId, style = STYLE_PRIMARY, emoji) {
  const b = { type: COMP_BUTTON, style, label, custom_id: customId };
  if (emoji) b.emoji = typeof emoji === 'string' ? { name: emoji } : emoji;
  return b;
}

function row(...children) {
  return { type: COMP_ROW, components: children };
}

// The pinned message payload. Keep it stable, re-posts reuse the
// same shape so subscribers/embed-cache stays consistent.
export function pinnedMessage() {
  return {
    embeds: [{
      title: '🎮 Aquilo Games',
      description: [
        'Welcome to the games hub. Each button opens its own private window, only you see it.',
        '',
        '🃏 **Boltbound**, async card battler with weekly drafts.',
        '⚔️ **Clash**, communal town builder + raids.',
        '🎲 **Quick games**, blackjack, hilo, mines, dice, bet Bolts.',
        '📜 **Campaign**, AI-DM\'d one-shot D&D with friends.',
        '🐱 **Pet**, Patreon cosmetic pet + tamagotchi care loop.',
        '',
        '🦸 **Hero / Character**, class, gear, profile.',
        '🛒 **Shop**, spend Bolts on cosmetics + buffs.',
        '🌐 **Hub**, viewer leaderboards + stocks + bets.',
      ].join('\n'),
      color: 0x7c5cff,
      footer: { text: 'Tap a button, your menu opens privately.' },
    }],
    components: [
      // Row 1, flagship games (primary style)
      row(
        button('🃏 Boltbound',      'gm:boltbound',  STYLE_PRIMARY),
        button('⚔️ Clash',          'gm:clash',      STYLE_PRIMARY),
        button('🎲 Quick games',    'gm:play',       STYLE_PRIMARY),
      ),
      // Row 2, narrative + sim
      row(
        button('📜 Campaign',       'gm:campaign',   STYLE_SUCCESS),
        button('🐱 Pet',            'gm:pet',        STYLE_SUCCESS),
      ),
      // Row 3, character + economy
      row(
        button('🦸 Hero',           'gm:hero',       STYLE_SECONDARY),
        button('👤 Character',      'gm:character',  STYLE_SECONDARY),
        button('🛒 Shop',           'gm:shop',       STYLE_SECONDARY),
      ),
      // Row 4, supporting hubs
      row(
        button('💼 Loadout',        'gm:loadout',    STYLE_SECONDARY),
        button('🌐 Hub',            'gm:hub',        STYLE_SECONDARY),
        button('🏆 Top gifters',    'gm:topgifters', STYLE_SECONDARY),
      ),
    ],
  };
}

// ── Component dispatch ──────────────────────────────────────────────
//
// Each button click ACK's as a fresh ephemeral message (RESP_CHAT +
// FLAG_EPHEMERAL), NOT an UPDATE, the pinned message stays put as
// the next viewer's entry point.
//
// We forward the click to each game's existing slash handler with a
// synthesised `data` shape: same guild_id + member + user, empty
// `options` so the handler renders its home view. The handlers
// already return a chat payload with their main menu / status card.

const FALLBACK_EPHEM = (content) => ({
  type: RESP_CHAT,
  data: { content, flags: FLAG_EPHEMERAL },
});

export async function handleGamesMenuComponent(data, env, ctx) {
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('gm:')) {
    return FALLBACK_EPHEM('Unknown menu action.');
  }
  const key = customId.slice('gm:'.length).split(':')[0];

  const user = data.member?.user || data.user;
  const userId = user?.id;
  const userName = user?.global_name || user?.username || 'viewer';
  const guildId = data.guild_id;

  // Each game's slash handler reads data.data.options for sub-routing.
  // We supply an EMPTY options array so they fall through to the
  // home view (status / status-card / picker).
  const blankData = { ...data, data: { ...(data.data || {}), options: [] } };

  try {
    switch (key) {
      case 'boltbound': {
        const { handleBoltboundCommand } = await import('./cards.js');
        const r = await handleBoltboundCommand(env, blankData, userId, userName);
        return forceEphemeral(r);
      }
      case 'play': {
        const { handlePlayCommand } = await import('./quickgames-command.js');
        const r = await handlePlayCommand(env, blankData, guildId, userId, userName);
        return forceEphemeral(r);
      }
      case 'loadout': {
        // Loadout's home menu, wallet / daily / games / profile.
        // Viewers navigate inside via lo:* buttons.
        const { renderLoadoutCommand } = await import('./loadout-menu.js');
        const r = await renderLoadoutCommand(env, guildId, userId, userName);
        return forceEphemeral(r);
      }
      case 'hub': {
        const { renderHubCommand } = await import('./hub.js');
        const r = await renderHubCommand(env, guildId, userId);
        return forceEphemeral(r);
      }
      case 'topgifters': {
        const { handleTopGiftersCommand } = await import('./gifter-roles.js');
        const r = await handleTopGiftersCommand(env, guildId);
        return forceEphemeral(r);
      }
      default:
        return FALLBACK_EPHEM(`Unknown game key: \`${key}\``);
    }
  } catch (e) {
    console.warn('[games-menu]', key, e?.message || e);
    return FALLBACK_EPHEM(
      `Sorry, \`${key}\` errored. Try again in a moment, or ping a mod.`,
    );
  }
}

// Force an existing slash-style RESP_CHAT response to be ephemeral.
// The per-game handlers usually already return ephemeral, but some
// flows (e.g. /clash leaderboard) return public messages. The pinned
// menu lives in a public channel; defending against accidental
// public spam from a button click is cheap.
function forceEphemeral(resp) {
  if (!resp || typeof resp !== 'object') return FALLBACK_EPHEM('No response.');
  if (resp.type === RESP_CHAT && resp.data) {
    return {
      ...resp,
      data: { ...resp.data, flags: (resp.data.flags || 0) | FLAG_EPHEMERAL },
    };
  }
  return resp;
}

// ── Admin: post / refresh the pinned menu ──────────────────────────
//
// KV keys:
//   games-menu:msg:<gid>  → { channelId, messageId } of the pinned
//                            message. Looked up on refresh so we PATCH
//                            instead of double-posting.
//
// Idempotent. Safe to re-run after a deploy that changed the menu
// shape, the PATCH lands the new embed + components.

const KV_PIN = (gid) => `games-menu:msg:${gid}`;
const DEFAULT_CHANNEL_ID = '1507973935973531808';   // #games in the Aquilo guild

async function discordREST(env, method, path, body) {
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord games-menu',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, body: json };
}

// Returns { ok, action: 'patched' | 'posted-new' | 'refreshed', channelId, messageId }.
// `opts.channelId` overrides the default; useful for staging tests.
export async function postOrRefreshGamesMenu(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId) return { ok: false, error: 'no-guild-id' };
  const channelId = String(opts.channelId || DEFAULT_CHANNEL_ID);
  const payload = pinnedMessage();

  // Try to PATCH the existing pinned message first.
  let prior = null;
  try {
    prior = await env.LOADOUT_BOLTS.get(KV_PIN(guildId), { type: 'json' });
  } catch { /* fall through */ }
  if (prior?.channelId === channelId && prior?.messageId) {
    const upd = await discordREST(env, 'PATCH',
      `/channels/${channelId}/messages/${prior.messageId}`, payload);
    if (upd.ok) {
      return { ok: true, action: 'patched', channelId, messageId: prior.messageId };
    }
    // 404 means the user deleted it, fall through to fresh post.
    if (upd.status !== 404) {
      return { ok: false, error: 'patch-failed', status: upd.status, body: upd.body };
    }
  }

  // Post fresh.
  const post = await discordREST(env, 'POST',
    `/channels/${channelId}/messages`, payload);
  if (!post.ok) {
    return { ok: false, error: 'post-failed', status: post.status, body: post.body };
  }
  const messageId = post.body?.id;
  await env.LOADOUT_BOLTS.put(KV_PIN(guildId), JSON.stringify({ channelId, messageId }));

  // Pin it (best-effort, pinning fails silently if Discord caps the
  // channel's pin list at 50). un-pin the prior one first so we don't
  // accumulate stale pins.
  if (prior?.channelId === channelId && prior?.messageId) {
    await discordREST(env, 'DELETE',
      `/channels/${channelId}/pins/${prior.messageId}`).catch(() => {});
  }
  const pin = await discordREST(env, 'PUT',
    `/channels/${channelId}/pins/${messageId}`);

  return {
    ok: true,
    action: 'posted-new',
    channelId,
    messageId,
    pinned: pin.ok,
    pinStatus: pin.status,
  };
}
