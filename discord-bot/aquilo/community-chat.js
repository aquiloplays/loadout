// Community-chat ringbuffer.
//
// aquilo-presence (the Railway-hosted Discord Gateway keeper) forwards
// every MESSAGE_CREATE from an allow-listed channel to POST
// /counting/message. This handler is one of the fan-out targets, it
// keeps the last N messages PER ALLOWED CHAT CHANNEL in KV so the
// public /community/chat endpoint can render a live feed on
// aquilo.gg/community/.
//
// Channels included here are read at runtime from env.COMMUNITY_CHAT_CHANNELS_JSON
// (a JSON array of channel IDs). The same array is merged into
// /forward-channels so aquilo-presence picks them up dynamically, no
// Railway redeploy needed to add a channel.
//
// KV layout:
//   community-chat:<channelId>  -> JSON array of recent {id, ts, user, content, attachments, bot}
//
// Each message is normalised down to fields the website needs; we
// don't store raw Discord payloads. The bot/system messages get a
// `kind` field so the UI can render them (joins, embeds) differently
// from regular chat.

const CHAT_PREFIX = 'community-chat:';
const MAX_MESSAGES_PER_CHANNEL = 50;
// TTL is mostly defensive, KV would happily hold the keys forever, but
// 24h means an abandoned channel grooms itself. The active channels are
// re-written constantly so the TTL keeps refreshing.
const TTL_S = 24 * 60 * 60;

// Per-message web-reaction state (aquilo PWA users who toggled an emoji
// on a Discord chat message). Keyed by channel + message; value is
// { [emojiKey]: [aquiloDiscordId, ...] }. emojiKey is either a unicode
// glyph (e.g. "🔥") or "name:id" for a custom emoji. TTL trails the
// message ringbuffer with a small cushion.
const REACT_PREFIX = 'community-chat-react:';
const REACT_TTL_S = 7 * 24 * 60 * 60;

export function reactKey(channelId, messageId) {
  return REACT_PREFIX + String(channelId) + ':' + String(messageId);
}

// Map a client-supplied emoji string to a stable storage key and the
// Discord REST path component. Returns null for anything malformed.
//
// Unicode glyphs pass through as-is; custom emoji must be "name:id".
// Discord's REST path uses the same "name:id" form for customs; we
// URL-encode unicode glyphs.
export function parseEmoji(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 100) return null;
  // Custom emoji: name:id (name is alnum+_-, id is snowflake digits)
  const cm = s.match(/^([A-Za-z0-9_-]{1,32}):(\d{5,25})$/);
  if (cm) {
    return {
      kind: 'custom',
      key: s,
      restPath: encodeURIComponent(cm[1] + ':' + cm[2]),
      name: cm[1],
      id: cm[2],
      animated: false,
    };
  }
  // Unicode glyph, reject if it contains characters that look like
  // injection (colons / digits-only / whitespace-only). Keep it
  // permissive otherwise: Discord accepts a wide range of glyphs.
  if (/[:<>@/\\]/.test(s)) return null;
  if (/^\s*$/.test(s)) return null;
  if (/^\d+$/.test(s)) return null;
  return {
    kind: 'unicode',
    key: s,
    restPath: encodeURIComponent(s),
    name: s,
    id: null,
    animated: false,
  };
}

// Channel-allow-list shape. Accepts EITHER:
//   ["1234...", "5678..."]                                    (back-compat)
//   [{ "id": "1234...", "label": "Discord general", "kind": "discord" }, ...]
//
// `kind` is "discord" or "mc" (the DiscordSRV-bridged Minecraft channel).
// The website renders kind:"mc" with a block-style nameplate.
export function parseChannelConfigs(env) {
  const raw = String(env.COMMUNITY_CHAT_CHANNELS_JSON || '').trim();
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const e of v) {
      if (typeof e === 'string') {
        if (/^\d{5,25}$/.test(e)) {
          out.push({ id: e, label: 'Discord chat', kind: 'discord' });
        }
      } else if (e && typeof e === 'object' && /^\d{5,25}$/.test(String(e.id))) {
        out.push({
          id: String(e.id),
          label: String(e.label || 'Chat').slice(0, 40),
          kind: e.kind === 'mc' ? 'mc' : 'discord',
        });
      }
    }
    return out;
  } catch { return []; }
}

// Convenience helper retained for callers that just need the ID list.
export function parseAllowedChannels(env) {
  return parseChannelConfigs(env).map(c => c.id);
}

/**
 * Append one Discord MESSAGE_CREATE-shaped payload to the channel's
 * ringbuffer. Caller (aquilo/worker.js POST /counting/message) has
 * already verified the HMAC and that the channel is allowed.
 *
 * Returns { stored: boolean } so the fan-out caller can include it in
 * the response for debugging.
 */
export async function handleCommunityChatMessage(env, payload) {
  if (!env.LOADOUT_BOLTS) return { stored: false, reason: 'no-kv' };
  if (!payload || !payload.channel_id) return { stored: false, reason: 'no-channel' };

  const allowed = parseAllowedChannels(env);
  if (!allowed.includes(String(payload.channel_id))) {
    return { stored: false, reason: 'channel-not-allowed' };
  }

  // Drop the very common "bot relay echo" loop: if the message author
  // is a bot AND a webhook-style embed message (DiscordSRV joins use
  // webhook author), still keep it, those are MC join/leave/chat
  // events bridged through. Only drop our own bot's outgoing relays
  // (which never carry useful chat).
  const norm = normalise(payload);
  if (!norm) return { stored: false, reason: 'unparseable' };

  const key = CHAT_PREFIX + String(payload.channel_id);
  let list = [];
  try {
    const existing = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (Array.isArray(existing)) list = existing;
  } catch { /* fall through to empty */ }

  // Dedupe, same message id arriving twice (e.g. transient redelivery)
  // shouldn't double-render.
  if (list.find(m => m.id === norm.id)) {
    return { stored: false, reason: 'duplicate' };
  }

  list.push(norm);
  if (list.length > MAX_MESSAGES_PER_CHANNEL) {
    list = list.slice(-MAX_MESSAGES_PER_CHANNEL);
  }

  try {
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(list), { expirationTtl: TTL_S });
  } catch {
    return { stored: false, reason: 'kv-write-failed' };
  }
  return { stored: true, count: list.length };
}

/**
 * Read the ringbuffer for a channel (public read, gates which channels
 * are exposed via the COMMUNITY_CHAT_CHANNELS_JSON allow-list; no
 * additional auth).
 */
export async function readCommunityChat(env, channelId, limit) {
  if (!env.LOADOUT_BOLTS) return { ok: false, messages: [] };
  const allowed = parseAllowedChannels(env);
  if (!allowed.includes(String(channelId))) {
    return { ok: false, error: 'channel-not-allowed', messages: [] };
  }
  const key = CHAT_PREFIX + String(channelId);
  let list = [];
  try {
    const raw = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (Array.isArray(raw)) list = raw;
  } catch { /* keep empty */ }
  const n = Math.max(1, Math.min(50, Number(limit) || 25));
  return { ok: true, messages: list.slice(-n) };
}

/**
 * Remove a single message from a channel ringbuffer. Called from the
 * gateway-forwarded MESSAGE_DELETE handler (POST /message/deleted) so a
 * message deleted in Discord stops showing on aquilo.gg/community. No-op
 * if the channel isn't tracked or the id isn't in the buffer.
 */
export async function pruneDeletedMessage(env, channelId, messageId) {
  if (!env.LOADOUT_BOLTS || !channelId || !messageId) return { pruned: false };
  const key = CHAT_PREFIX + String(channelId);
  let list;
  try {
    list = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  } catch { return { pruned: false }; }
  if (!Array.isArray(list)) return { pruned: false };
  const next = list.filter((m) => String(m.id) !== String(messageId));
  if (next.length === list.length) return { pruned: false };
  try {
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(next), { expirationTtl: TTL_S });
  } catch { return { pruned: false }; }
  return { pruned: true, remaining: next.length };
}

/**
 * Purge community-chat ringbuffers. Pass a channelId to clear one, or
 * omit it to clear every `community-chat:*` key. Used to flush messages
 * that were deleted in Discord before MESSAGE_DELETE forwarding existed
 * (e.g. after a bulk moderation cleanup). Active channels refill from
 * live forwarding within minutes. Returns the count of keys deleted.
 */
export async function purgeCommunityChat(env, channelId) {
  if (!env.LOADOUT_BOLTS) return { ok: false, deleted: 0 };
  if (channelId) {
    try { await env.LOADOUT_BOLTS.delete(CHAT_PREFIX + String(channelId)); } catch { /* idle */ }
    return { ok: true, deleted: 1 };
  }
  let deleted = 0;
  let cursor;
  for (let i = 0; i < 20; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: CHAT_PREFIX, cursor, limit: 1000 });
    for (const k of r.keys) {
      try { await env.LOADOUT_BOLTS.delete(k.name); deleted++; } catch { /* idle */ }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return { ok: true, deleted };
}

// ---- Reactions -----------------------------------------------------------
//
// Web users (aquilo.gg PWA / desktop) don't have a Discord identity of
// their own. When a web user reacts, the BOT adds the reaction to the
// Discord message on their behalf, so a reaction visible in Discord
// is the bot's reaction, regardless of how many web users actually
// reacted. To make per-user reaction state meaningful on the web side
// we mirror it in KV:
//
//   community-chat-react:<channelId>:<messageId>  -> { [emojiKey]: [aquiloDiscordId, ...] }
//
// On read we merge that with the native Discord reactions on the
// message:
//
//   count = nativeCount + max(0, webUsers.length - 1)
//                          ^^^^^^^^^^^^^^^^^^^^^^^^^^
//                          the bot's single reaction already counts
//                          once in nativeCount; each additional web
//                          user contributes another +1 on the website
//   me    = webUsers includes requestingUserId
//
// `me` is never derivable from Discord-native reactions alone (we'd
// have no way to attribute them per-aquilo-user), so KV is the only
// source of truth for that flag.

// Fetch the current Discord message via REST so we can read its
// reactions[] field. Returns the raw Discord message object or null.
// The caller is responsible for falling back to a no-reactions render
// when this returns null (e.g. on 404, message deleted).
async function fetchDiscordMessage(env, channelId, messageId) {
  if (!env.DISCORD_BOT_TOKEN) return null;
  try {
    const resp = await fetch(
      'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) +
      '/messages/' + encodeURIComponent(messageId),
      {
        headers: {
          'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
          'User-Agent':    'aquilo-bot-worker (1.0)',
        },
      },
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// Add or remove the bot's reaction. Discord's URL grammar wants the
// emoji as either the URL-encoded unicode glyph (e.g. "%F0%9F%94%A5"
// for 🔥) or "name:id" for a custom emoji. parseEmoji() already gave
// us the right restPath.
export async function botPutReaction(env, channelId, messageId, emoji) {
  if (!env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not configured');
  const resp = await fetch(
    'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) +
    '/messages/' + encodeURIComponent(messageId) +
    '/reactions/' + emoji.restPath + '/@me',
    {
      method: 'PUT',
      headers: {
        'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent':    'aquilo-bot-worker (1.0)',
      },
    },
  );
  if (!resp.ok && resp.status !== 204) {
    const t = await resp.text();
    throw new Error('Discord ' + resp.status + ' react: ' + t.slice(0, 200));
  }
}

export async function botDeleteReaction(env, channelId, messageId, emoji) {
  if (!env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not configured');
  const resp = await fetch(
    'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) +
    '/messages/' + encodeURIComponent(messageId) +
    '/reactions/' + emoji.restPath + '/@me',
    {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent':    'aquilo-bot-worker (1.0)',
      },
    },
  );
  if (!resp.ok && resp.status !== 204 && resp.status !== 404) {
    const t = await resp.text();
    throw new Error('Discord ' + resp.status + ' unreact: ' + t.slice(0, 200));
  }
}

// Merge a Discord-native reactions array (from a fetched message) with
// the web-user KV map for that message, and stamp `me` per the
// requesting aquilo user. Returns the array shape the website renders.
function mergeReactions(discordReactions, webMap, asUserId) {
  const out = [];
  const seen = new Set();
  const arr = Array.isArray(discordReactions) ? discordReactions : [];
  for (const r of arr) {
    const e = r && r.emoji;
    if (!e) continue;
    const key = e.id ? (e.name + ':' + e.id) : e.name;
    seen.add(key);
    const webUsers = Array.isArray(webMap[key]) ? webMap[key] : [];
    out.push({
      emoji: {
        name: e.name || '',
        id: e.id || null,
        animated: !!e.animated,
      },
      count: (Number(r.count) || 0) + Math.max(0, webUsers.length - 1),
      me: !!(asUserId && webUsers.includes(asUserId)),
    });
  }
  // Web-only reactions: the bot tried to react but Discord doesn't
  // know about it (e.g. message deleted, custom emoji unavailable),
  // OR the per-message GET races behind a fresh add. Surface them so
  // the UI stays consistent, count starts at the web user list size.
  for (const [key, webUsers] of Object.entries(webMap)) {
    if (seen.has(key)) continue;
    if (!Array.isArray(webUsers) || webUsers.length === 0) continue;
    const m = String(key).match(/^([^:]+):(\d{5,25})$/);
    out.push({
      emoji: {
        name: m ? m[1] : key,
        id: m ? m[2] : null,
        animated: false,
      },
      count: webUsers.length,
      me: !!(asUserId && webUsers.includes(asUserId)),
    });
  }
  return out;
}

// Read the ringbuffer AND enrich each message with its current
// Discord-native reactions + web-side KV state. The `asUserId` is the
// aquilo Discord ID of the requesting PWA user (used to stamp `me` on
// each reaction). Fans out one Discord REST GET per message in
// parallel, at ringbuffer cap (50) that's 50 concurrent requests
// inside a single Worker invocation, well below CF/Discord rate
// thresholds.
export async function readCommunityChatWithReactions(env, channelId, limit, asUserId) {
  const base = await readCommunityChat(env, channelId, limit);
  if (!base.ok || base.messages.length === 0) return base;

  const enriched = await Promise.all(base.messages.map(async (msg) => {
    const [discordMsg, webMap] = await Promise.all([
      fetchDiscordMessage(env, channelId, msg.id),
      env.LOADOUT_BOLTS
        ? env.LOADOUT_BOLTS.get(reactKey(channelId, msg.id), { type: 'json' }).catch(() => null)
        : null,
    ]);
    const reactions = mergeReactions(
      discordMsg && discordMsg.reactions,
      webMap || {},
      asUserId,
    );
    return { ...msg, reactions };
  }));

  return { ...base, messages: enriched };
}

// Toggle helpers used by the /web/chat/react + /web/chat/unreact
// routes. Returns { added|removed, botActed, webUsers } so the route
// can report a structured response without re-fetching.

export async function addWebReaction(env, channelId, messageId, emoji, asUserId) {
  const key = reactKey(channelId, messageId);
  const existing = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {};
  const list = Array.isArray(existing[emoji.key]) ? existing[emoji.key].slice() : [];
  const already = list.includes(asUserId);
  if (!already) list.push(asUserId);
  existing[emoji.key] = list;
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(existing), { expirationTtl: REACT_TTL_S });

  // First web reactor for this emoji ⇒ the bot needs to actually add
  // its reaction on Discord so the chat thread shows the pill. Repeat
  // adds are no-ops on Discord (already reacted).
  let botActed = false;
  if (list.length === 1 && !already) {
    await botPutReaction(env, channelId, messageId, emoji);
    botActed = true;
  }
  return { added: !already, botActed, webUsers: list };
}

export async function removeWebReaction(env, channelId, messageId, emoji, asUserId) {
  const key = reactKey(channelId, messageId);
  const existing = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {};
  const list = Array.isArray(existing[emoji.key]) ? existing[emoji.key].slice() : [];
  const idx = list.indexOf(asUserId);
  const removed = idx >= 0;
  if (removed) list.splice(idx, 1);
  if (list.length > 0) {
    existing[emoji.key] = list;
  } else {
    delete existing[emoji.key];
  }
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(existing), { expirationTtl: REACT_TTL_S });

  // Last web reactor leaving ⇒ pull the bot's reaction off Discord so
  // the pill disappears for everyone in the channel.
  let botActed = false;
  if (removed && list.length === 0) {
    try { await botDeleteReaction(env, channelId, messageId, emoji); botActed = true; }
    catch (e) {
      // 404s are fine (message gone); surface other failures.
      console.warn('[chat-react] delete failed', e?.message || e);
    }
  }
  return { removed, botActed, webUsers: list };
}

// ---- Normaliser ----------------------------------------------------------

// Reduce a Discord MESSAGE_CREATE payload (already partially trimmed by
// aquilo-presence, content, attachments, author basics) to the shape
// the website renders.
function normalise(p) {
  if (!p.message_id && !p.id && !p.messageId) return null;
  const id = String(p.message_id || p.id || p.messageId);
  // Shim sends author as a nested object (Discord-slim subset):
  //   p.author.{id, username, global_name, bot}
  // Fall through to the flat fields older payloads may carry, the
  // PWA was rendering "someone" for every chat message because we
  // were only reading the flat fields, which the shim doesn't emit.
  const authorObj = p.author && typeof p.author === 'object' ? p.author : null;
  const username = (
    (authorObj && (authorObj.global_name || authorObj.username)) ||
    p.username ||
    'someone'
  ).toString().slice(0, 32);
  const userId = String((authorObj && authorObj.id) || p.user_id || p.userId || '') || null;
  const isBot  = !!((authorObj && authorObj.bot) || p.bot || p.isBot);
  const content = clip(String(p.content || ''), 600);

  // DiscordSRV bridges Minecraft chat as webhook posts where the
  // webhook username is the MC player's name. Detect by `bot=true` on
  // a message whose username doesn't match a known bot. The UI uses
  // `bridge: "mc"` to render with a Minecraft block-style nameplate
  // instead of a default avatar.
  let bridge = null;
  if (isBot && username && !looksLikeOwnBot(username)) bridge = 'mc';

  const attachments = Array.isArray(p.attachments)
    ? p.attachments.slice(0, 4).map(a => ({
        url: String(a.url || ''),
        contentType: String(a.content_type || ''),
        filename: String(a.filename || '').slice(0, 80),
      })).filter(a => a.url)
    : [];

  // L9, PWA chat improvements (Clay 2026-05-28):
  // (a) Avatar URL. The gateway shim now sends `author.avatar_url`
  //     as a full CDN URL; fall back to deriving from author.avatar
  //     (hash) when only the hash arrived from an older shim build.
  let avatar = null;
  if (authorObj?.avatar_url && /^https?:\/\//.test(authorObj.avatar_url)) {
    avatar = String(authorObj.avatar_url).slice(0, 256);
  } else if (authorObj?.avatar && userId) {
    const hash = String(authorObj.avatar);
    const ext = hash.startsWith('a_') ? 'gif' : 'png';
    avatar = `https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}?size=64`;
  } else if (userId) {
    // Default avatar, Discord rotates 6 default colors keyed off userId.
    const idx = Number(BigInt(userId) % 6n);
    avatar = `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }
  // (b) Embeds, keep a slim subset the PWA cares about so KV writes
  //     don't bloat. Per-embed cap: 4 (Discord lets up to 10).
  const embeds = Array.isArray(p.embeds)
    ? p.embeds.slice(0, 4).map(e => ({
        title:       e?.title       ? String(e.title).slice(0, 200) : null,
        description: e?.description ? String(e.description).slice(0, 600) : null,
        url:         e?.url         ? String(e.url).slice(0, 512) : null,
        color:       Number.isFinite(e?.color) ? Number(e.color) : null,
        image:       e?.image?.url       ? { url: String(e.image.url).slice(0, 512) } : null,
        thumbnail:   e?.thumbnail?.url   ? { url: String(e.thumbnail.url).slice(0, 512) } : null,
        footer:      e?.footer?.text     ? { text: String(e.footer.text).slice(0, 200) } : null,
        author:      e?.author?.name     ? { name: String(e.author.name).slice(0, 80) } : null,
      }))
    : [];

  return {
    id,
    ts: Date.now(),
    userId,
    username,
    // Emit BOTH camelCase keys for backward compat, older PWA
    // builds may read `avatar`; the canonical key is `avatarUrl`
    // (matches the chat.ts ChatMessage type).
    avatar,
    avatarUrl: avatar,
    content,
    attachments,
    embeds,
    bot: isBot,
    bridge,
    // Reactions are populated incrementally by the bot, see
    // readCommunityChatWithReactions() below. New messages have no
    // reactions yet, so the field starts empty.
    reactions: [],
  };
}

function clip(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

const OWN_BOTS = new Set(['loadout', 'aquilo']);
function looksLikeOwnBot(name) {
  const lo = name.toLowerCase();
  for (const b of OWN_BOTS) if (lo.includes(b)) return true;
  return false;
}
