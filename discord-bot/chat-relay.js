// PWA → Discord chat relay.
//
// A logged-in viewer can send a chat message from the PWA; the worker
// posts it into the target Discord channel via a per-channel WEBHOOK
// styled with the sender's username + avatar. In Discord it reads as
// the user (with a small "bot" tag Discord adds to webhook messages, // the closest thing Discord's API permits to a true "post-as-user"
// for third-party apps).
//
// Channel allow-list is the SAME COMMUNITY_CHAT_CHANNELS_JSON env that
// gates the inbound chat-feed forward, so the read + write paths can't
// drift: any channel the PWA can READ from is also the only set it can
// WRITE to.
//
// KV layout:
//   chat-relay:webhook:<channelId>  → { id, token, createdUtc, name }
//   chat-relay:rate:<userId>        → { recent: [ts, ts, ...],
//                                        hourStart, hourCount }
//   chat-relay:by-msg:<messageId>   → { discordId, ts }   (TTL 1h, for
//                                       PWA dedup hints on the read side)

import { parseAllowedChannels } from './aquilo/community-chat.js';

// Per-user rate limits. Burst limit prevents flooding; hourly prevents
// slow-drip spam. Both windows are sliding (recent[] is trimmed to the
// last 10s on every check; hourCount resets when hourStart rolls over).
const BURST_WINDOW_MS = 10_000;
const BURST_CAP       = 5;
const HOUR_WINDOW_MS  = 60 * 60 * 1000;
const HOUR_CAP        = 50;
const MAX_LEN         = 1500;  // Discord supports 2000, leaving room for the small "from PWA" hint we tack on bots later

const WEBHOOK_KEY     = (ch) => `chat-relay:webhook:${ch}`;
const RATE_KEY        = (uid) => `chat-relay:rate:${uid}`;
const BY_MSG_KEY      = (mid) => `chat-relay:by-msg:${mid}`;

// Webhook name shown next to the user's display name in Discord. Note:
// the message itself appears as the user (avatar + username override),
// but if a viewer hovers the bot tag they see this hint. The substring
// must NOT contain "loadout" or "aquilo" because the community-chat
// ringbuffer in aquilo/community-chat.js demotes anything matching
// those keywords to bridge=null (intentional, own-bot relay echoes
// shouldn't render as MC bridges).
const WEBHOOK_NAME = 'Chat Bridge';

// Small profanity list, same words as ext.js's stream-checkin
// masker, kept in sync intentionally so the two surfaces look the
// same to a viewer.
const PROFANITY = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'piss', 'bastard',
  'slut', 'whore', 'nigger', 'nigga', 'faggot', 'retard', 'rape',
];

function sanitiseContent(raw) {
  let s = String(raw || '');
  // Drop control characters (0x00-0x1f + DEL), Discord renders some
  // of these but they're a footgun.
  s = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  // Strip @everyone / @here at the source; we ALSO pass allowed_mentions
  // parse:[] to the webhook so even if the regex misses a variant
  // Discord won't actually ping. Belt + braces.
  s = s.replace(/@(everyone|here)/gi, '@​$1');
  // Mask the small set of obvious profanity. The replacement preserves
  // length so the message shape stays the same.
  for (const w of PROFANITY) {
    s = s.replace(new RegExp('\\b' + w + 's?\\b', 'gi'), (m) => '*'.repeat(m.length));
  }
  s = s.trim();
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN - 1) + '…';
  return s;
}

// Sliding-window rate-limit check. Returns { ok, retryAfterMs?, reason? }.
async function checkAndTouchRate(env, userId) {
  const now = Date.now();
  const raw = (await env.LOADOUT_BOLTS.get(RATE_KEY(userId), { type: 'json' })) || {};
  const recent = (raw.recent || []).filter(ts => now - ts < BURST_WINDOW_MS);
  if (recent.length >= BURST_CAP) {
    const oldest = Math.min(...recent);
    return { ok: false, reason: 'burst', retryAfterMs: BURST_WINDOW_MS - (now - oldest) };
  }
  let hourStart = raw.hourStart || 0;
  let hourCount = raw.hourCount || 0;
  if (now - hourStart > HOUR_WINDOW_MS) {
    hourStart = now;
    hourCount = 0;
  }
  if (hourCount >= HOUR_CAP) {
    return { ok: false, reason: 'hourly', retryAfterMs: HOUR_WINDOW_MS - (now - hourStart) };
  }
  recent.push(now);
  hourCount += 1;
  await env.LOADOUT_BOLTS.put(RATE_KEY(userId), JSON.stringify({
    recent, hourStart, hourCount,
  }), { expirationTtl: 7200 });
  return { ok: true };
}

// Discord avatar URL (same algorithm as welcome.js / community-checkin.js).
function avatarUrl(userId, avatarHash) {
  if (!avatarHash) {
    const disc = Number(BigInt(userId) >> 22n) % 6;
    return `https://cdn.discordapp.com/embed/avatars/${disc}.png`;
  }
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=128`;
}

async function fetchMember(env, guildId, userId) {
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
    });
    if (!r.ok) return null;
    const m = await r.json();
    return {
      displayName: (m?.nick || m?.user?.global_name || m?.user?.username || 'friend').slice(0, 32),
      avatar: avatarUrl(userId, m?.user?.avatar),
    };
  } catch { return null; }
}

// ── Webhook lifecycle ─────────────────────────────────────────────────
// One webhook per relay channel. KV cache so we don't pay the GET
// /channels/{id}/webhooks list cost on every send. If the webhook has
// been deleted out from under us by a server admin, the POST returns
// 404; we delete the KV entry and re-mint on the next call.

async function getOrCreateWebhook(env, channelId) {
  const cached = await env.LOADOUT_BOLTS.get(WEBHOOK_KEY(channelId), { type: 'json' });
  if (cached?.id && cached?.token) return cached;

  // No cache → list existing webhooks on the channel. If one of ours
  // already exists (named `WEBHOOK_NAME`) we adopt it; otherwise mint
  // a new one.
  const H = { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN };
  const list = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, { headers: H });
  if (!list.ok) {
    return { _err: 'webhook-list-failed', status: list.status, body: (await list.text()).slice(0, 200) };
  }
  const arr = await list.json();
  let hook = Array.isArray(arr) ? arr.find(w => w?.name === WEBHOOK_NAME) : null;
  if (!hook) {
    const create = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: WEBHOOK_NAME }),
    });
    if (!create.ok) {
      return { _err: 'webhook-create-failed', status: create.status, body: (await create.text()).slice(0, 200) };
    }
    hook = await create.json();
  }
  const rec = {
    id:         hook.id,
    token:      hook.token,
    name:       hook.name,
    createdUtc: Date.now(),
  };
  await env.LOADOUT_BOLTS.put(WEBHOOK_KEY(channelId), JSON.stringify(rec));
  return rec;
}

// ── Core: PWA → Discord ────────────────────────────────────────────────
export async function sendFromPwa(env, { discordId, guildId, channelId, content }) {
  if (!discordId || !guildId || !channelId) {
    return { ok: false, error: 'discordId, guildId, channelId required' };
  }
  if (!env.DISCORD_BOT_TOKEN) {
    return { ok: false, error: 'bot-not-provisioned' };
  }

  // Allow-list: only channels enabled for community chat can be
  // written to. Reuses the SAME env var as the read-side feed so the
  // two directions can't drift.
  const allowed = parseAllowedChannels(env);
  if (!allowed.includes(String(channelId))) {
    return { ok: false, error: 'channel-not-allowed' };
  }

  // Content sanity first, refusing very short or empty messages
  // saves the rate-limit token for real sends.
  const clean = sanitiseContent(content);
  if (!clean) return { ok: false, error: 'empty-after-sanitise' };

  // Rate limit.
  const rate = await checkAndTouchRate(env, discordId);
  if (!rate.ok) {
    return { ok: false, error: 'rate-limited', reason: rate.reason, retryAfterMs: rate.retryAfterMs };
  }

  // Resolve the user's current display name + avatar so the webhook
  // post looks like them. Fallbacks if Discord refuses (not in guild,
  // bot missing perms): generic friend + default avatar so the
  // message still lands.
  const member = await fetchMember(env, guildId, discordId)
    || { displayName: 'PWA user', avatar: avatarUrl(discordId, null) };

  // Webhook for this channel, create on first use, cache the token.
  const hook = await getOrCreateWebhook(env, channelId);
  if (hook?._err) {
    return { ok: false, error: hook._err, status: hook.status, detail: hook.body };
  }

  // POST to the webhook with the user's identity overrides. The
  // ?wait=true query makes Discord return the created message so we
  // can stash its id for PWA dedup hints + roundtrip telemetry.
  const url = `https://discord.com/api/v10/webhooks/${hook.id}/${hook.token}?wait=true`;
  const wr = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content:           clean,
      username:          member.displayName,
      avatar_url:        member.avatar,
      // Belt + braces on @everyone/@here etc., the sanitiser already
      // zero-width-spaces them but allowed_mentions parse:[] makes
      // Discord refuse to ping no matter what content survives.
      allowed_mentions:  { parse: [] },
    }),
  });
  if (!wr.ok) {
    // 404 means the webhook was deleted; invalidate the KV cache so
    // the next call re-mints, but surface the error to this call.
    if (wr.status === 404) {
      try { await env.LOADOUT_BOLTS.delete(WEBHOOK_KEY(channelId)); } catch { /* idle */ }
    }
    const body = (await wr.text()).slice(0, 200);
    return { ok: false, error: 'webhook-post-failed', status: wr.status, detail: body };
  }
  const m = await wr.json();

  // Stash a tiny lookup so the read endpoint can decorate messages
  // with `sentViaPwa:true` (and the original discordId, in case the
  // PWA wants to confirm "this is mine"). 1h TTL, older messages
  // are still rendered, just without the via-PWA hint.
  try {
    await env.LOADOUT_BOLTS.put(BY_MSG_KEY(String(m.id)), JSON.stringify({
      discordId, channelId, ts: Date.now(),
    }), { expirationTtl: 3600 });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    messageId:   m.id,
    channelId,
    displayName: member.displayName,
    contentLength: clean.length,
    rate: { burstUsed: (rate.burstUsed || 0) + 1, hourUsed: rate.hourUsed || 0 },
  };
}

// ── Decorated read for the PWA ────────────────────────────────────────
// Thin wrapper over the existing readCommunityChat() that tags each
// message with `sentViaPwa: bool` + `mineDiscordId` (so the PWA can
// dim its own optimistic-render copy once the server echo arrives).
// The PWA could also poll GET /community/chat directly, this exists
// for the symmetric /web/chat/* contract and the dedup hint.
export async function recentForPwa(env, { channelId, limit, discordId }) {
  const { readCommunityChat } = await import('./aquilo/community-chat.js');
  const r = await readCommunityChat(env, channelId, limit);
  if (!r.ok) return r;
  const decorated = [];
  for (const m of r.messages) {
    const hint = await env.LOADOUT_BOLTS.get(BY_MSG_KEY(String(m.id)), { type: 'json' });
    decorated.push({
      ...m,
      sentViaPwa: !!hint,
      mine:       !!(hint && discordId && String(hint.discordId) === String(discordId)),
    });
  }
  return { ok: true, channelId: String(channelId), messages: decorated };
}
