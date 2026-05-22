// Community-chat ringbuffer.
//
// aquilo-presence (the Railway-hosted Discord Gateway keeper) forwards
// every MESSAGE_CREATE from an allow-listed channel to POST
// /counting/message. This handler is one of the fan-out targets — it
// keeps the last N messages PER ALLOWED CHAT CHANNEL in KV so the
// public /community/chat endpoint can render a live feed on
// aquilo.gg/community/.
//
// Channels included here are read at runtime from env.COMMUNITY_CHAT_CHANNELS_JSON
// (a JSON array of channel IDs). The same array is merged into
// /forward-channels so aquilo-presence picks them up dynamically — no
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
// TTL is mostly defensive — KV would happily hold the keys forever, but
// 24h means an abandoned channel grooms itself. The active channels are
// re-written constantly so the TTL keeps refreshing.
const TTL_S = 24 * 60 * 60;

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
  // webhook author), still keep it — those are MC join/leave/chat
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

  // Dedupe — same message id arriving twice (e.g. transient redelivery)
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
 * Read the ringbuffer for a channel (public read — gates which channels
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

// ---- Normaliser ----------------------------------------------------------

// Reduce a Discord MESSAGE_CREATE payload (already partially trimmed by
// aquilo-presence — content, attachments, author basics) to the shape
// the website renders.
function normalise(p) {
  if (!p.message_id && !p.id) return null;
  const id = String(p.message_id || p.id);
  const username = (p.username || 'someone').slice(0, 32);
  const content = clip(String(p.content || ''), 600);

  // DiscordSRV bridges Minecraft chat as webhook posts where the
  // webhook username is the MC player's name. Detect by `bot=true` on
  // a message whose username doesn't match a known bot. The UI uses
  // `bridge: "mc"` to render with a Minecraft block-style nameplate
  // instead of a default avatar.
  let bridge = null;
  if (p.bot && username && !looksLikeOwnBot(username)) bridge = 'mc';

  const attachments = Array.isArray(p.attachments)
    ? p.attachments.slice(0, 4).map(a => ({
        url: String(a.url || ''),
        contentType: String(a.content_type || ''),
        filename: String(a.filename || '').slice(0, 80),
      })).filter(a => a.url)
    : [];

  return {
    id,
    ts: Date.now(),
    userId: p.user_id || null,
    username,
    content,
    attachments,
    bot: !!p.bot,
    bridge,
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
