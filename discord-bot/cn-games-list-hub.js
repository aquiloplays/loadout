// Community-Night games-list catalogue, pinned set of embeds in a
// dedicated channel listing every CN-eligible game with cover art
// + a "Play it" store link.
//
// Source of truth: the D1 `games` table (active=1 rows) seeded from
// aquilo/bootstrap.js DEFAULT_GAMES. So adding a new game to v6 (or
// later) of the seed → next /admin/cn-games-list/post-hub re-render
// picks it up automatically.
//
// Layout: Discord caps a single message at 10 embeds + a single
// message at ≤2000 chars. We render at most 10 game embeds per
// message and chunk across multiple messages if the catalogue
// grows beyond that. Hub-msg KV stores an ARRAY of message ids so
// a re-post can sweep the whole prior layout cleanly.
//
// KV: cn-games-list:hub-msgs:<g> → JSON [{ channelId, messageId }, ...]

import { getChannelBinding } from './channel-bindings.js';
import { getBranding } from './branding.js';

const HUB_MSGS_KEY = (g) => `cn-games-list:hub-msgs:${g}`;
const MAX_EMBEDS_PER_MESSAGE = 10;

// Default channel-name hints when no explicit channelId/binding.
export const DEFAULT_GAMES_LIST_HINTS = [
  'cn-games', 'community-night-games', 'game-options', 'cn-game',
];

export function pickGamesListChannel(channels, opts = {}) {
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
  for (const hint of DEFAULT_GAMES_LIST_HINTS) {
    const needle = hint.toLowerCase();
    const hit = list.find(c => String(c.name || '').toLowerCase().includes(needle));
    if (hit) return { id: hit.id, name: hit.name || '' };
  }
  return null;
}

// Build the per-game embed shape. Returns the array of embeds, // caller chunks into 10-per-message.
async function buildGameEmbeds(env, guildId) {
  if (!env.DB) return [];
  const { results: rows } = await env.DB.prepare(
    `SELECT id, name, art_url FROM games
     WHERE guild_id = ? AND active = 1
     ORDER BY name ASC`,
  ).bind(guildId).all();
  return (rows || []).map(g => {
    const store = storeUrlForGame(g);
    const e = {
      title: g.name,
      color: 0x9147ff,
    };
    if (g.art_url) e.image = { url: g.art_url };
    if (store)    e.url = store;
    e.description = store ? `[Play it →](${store})` : '_no store link available_';
    return e;
  });
}

// Steam header URLs follow .../steam/apps/<appid>/... so we can
// derive a store URL deterministically. Falls back to null for
// non-Steam art (Fortnite / null art_url).
function storeUrlForGame(g) {
  const art = String(g.art_url || '');
  const m = art.match(/\/steam\/apps\/(\d+)\//);
  if (m) return `https://store.steampowered.com/app/${m[1]}/`;
  return null;
}

// Build a header embed shown above the catalogue.
async function buildHeader(env, guildId, count) {
  const brand = await getBranding(env, guildId);
  return {
    title: '🎲 Community Night · Games Catalogue',
    description:
      `${count} game${count === 1 ? '' : 's'} in the rotation. The community votes one ` +
      `into Saturday's stream, tap **Vote for this week** in <#${(await getChannelBinding(env, guildId, 'poll')) || ''}>.`,
    color: brand.accentColor || 0x9147ff,
    footer: { text: 'Catalogue auto-refreshes when the rotation is updated.' },
  };
}

// ── Shared poster ────────────────────────────────────────────────

async function discordPost(env, channelId, payload) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord cn-games-list',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    return { ok: false, status: r.status, body: (await r.text()).slice(0, 200) };
  }
  const j = await r.json();
  return { ok: true, messageId: j.id };
}

async function deletePriorMessages(env, guildId) {
  const prior = await env.LOADOUT_BOLTS.get(HUB_MSGS_KEY(guildId), { type: 'json' });
  if (!Array.isArray(prior)) return 0;
  let deleted = 0;
  for (const m of prior) {
    if (!m?.channelId || !m?.messageId) continue;
    try {
      const r = await fetch(
        `https://discord.com/api/v10/channels/${m.channelId}/messages/${m.messageId}`,
        {
          method: 'DELETE',
          headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord cn-games-list' },
        },
      );
      if (r.ok || r.status === 204 || r.status === 404) deleted += 1;
    } catch { /* idle */ }
  }
  return deleted;
}

export async function postGamesListHub(env, guildId, channelId) {
  if (!channelId) return { ok: false, error: 'no-channel-id' };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };

  const embeds = await buildGameEmbeds(env, guildId);
  if (embeds.length === 0) {
    return { ok: false, error: 'no-games', message: 'D1 games table is empty, run bootstrap first' };
  }
  const header = await buildHeader(env, guildId, embeds.length);

  // Sweep prior layout first.
  const deletedPrior = await deletePriorMessages(env, guildId);

  // Post the header alone (so it always renders first), then one
  // message per chunk of up to 10 game embeds.
  const posted = [];
  const headerPost = await discordPost(env, channelId, { embeds: [header], allowed_mentions: { parse: [] } });
  if (!headerPost.ok) return { ok: false, error: 'post-failed', status: headerPost.status, body: headerPost.body };
  posted.push({ channelId, messageId: headerPost.messageId });

  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const chunk = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    const r = await discordPost(env, channelId, { embeds: chunk, allowed_mentions: { parse: [] } });
    if (!r.ok) {
      console.warn('[cn-games-list] chunk post failed', r.status, r.body);
      continue;
    }
    posted.push({ channelId, messageId: r.messageId });
  }

  await env.LOADOUT_BOLTS.put(HUB_MSGS_KEY(guildId), JSON.stringify(posted));
  return { ok: true, channelId, messageIds: posted.map(p => p.messageId), gamesCount: embeds.length, deletedPrior };
}

// Admin HTTP entry, discovers channel via opts → KV binding → name
// hints. If nothing matches, returns a clear "create the channel
// first" error so Clay knows what to do.
export async function postGamesListHubForGuild(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  let pick;
  if (opts.channelId) {
    pick = { id: String(opts.channelId), name: '' };
  } else {
    const chRes = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord cn-games-list' },
    });
    if (!chRes.ok) {
      return { ok: false, error: 'channels-fetch-failed', status: chRes.status };
    }
    const channels = await chRes.json();
    if (opts.channelName) {
      pick = pickGamesListChannel(channels, { channelName: opts.channelName });
    } else {
      const bound = await getChannelBinding(env, guildId, 'games-list');
      if (bound) {
        const inGuild = channels.find(c => c && String(c.id) === String(bound) && c.type === 0);
        if (inGuild) pick = { id: String(inGuild.id), name: inGuild.name || '' };
      }
      if (!pick) pick = pickGamesListChannel(channels, {});
    }
    if (!pick) {
      return {
        ok: false,
        error: 'no-channel-match',
        message: 'No channel matched any of: ' + DEFAULT_GAMES_LIST_HINTS.join(', ') + '. Create a text channel (e.g. #cn-games), then re-run /admin/cn-games-list/post-hub, or bind explicitly via /admin/channels/bind with binding="games-list".',
        tried: DEFAULT_GAMES_LIST_HINTS,
      };
    }
  }
  const post = await postGamesListHub(env, guildId, pick.id);
  if (!post.ok) return { ok: false, error: post.error, channelId: pick.id, channelName: pick.name, message: post.message, status: post.status, body: post.body };
  return {
    ok: true,
    channelId: pick.id,
    channelName: pick.name,
    messageIds: post.messageIds,
    gamesCount: post.gamesCount,
    deletedPrior: post.deletedPrior,
  };
}

export const _DEFAULT_GAMES_LIST_HINTS_FOR_TEST = DEFAULT_GAMES_LIST_HINTS;
export { storeUrlForGame as _storeUrlForGameForTest };
