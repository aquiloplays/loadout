// Twitch clip cross-post (Helix poll → #clips embeds).
//
// Twitch removed the clip-created webhook in 2022, Helix `clips`
// polling is the only path. Called from the :17 hourly cron:
//   • If currently live (twitch:live:state:<b> present): poll every
//     hour (still hourly because that's the cron cadence, the
//     "10 min during live, 30 min otherwise" target needs a DO
//     alarm or paid cron tier; the hourly cadence is close enough
//     to catch clips before they go stale, and dedupe means a
//     clipper's two-clip-in-an-hour burst still posts both).
//   • Otherwise: poll every 3 hourly ticks (≈ once per 3h) to keep
//     Helix call volume down when nothing's happening.
//
// Dedup: KV `clips:posted:<broadcasterId>` is a JSON set of clip
// ids that have been cross-posted. Bounded at 500 ids; FIFO trim.
//
// 2026-07 hygiene: this module's Sunday-22-ET "Clip of the Week"
// poster (postClipOfTheWeekCron) was REMOVED — it double-posted
// against aquilo/clipoftheweek.js, whose Sunday-10-ET member-clip
// top-3 is the surviving Clip of the Week. The per-clip posted-meta
// KV records + the isoWeek helper stay: the recap / "what you missed"
// features read them.

import { getRecentClips, isTwitchConfigured } from './twitch-helix.js';
import { getChannelBinding } from './channel-bindings.js';

const POSTED_KEY  = (b) => `clips:posted:${b}`;
const POSTED_CAP  = 500;
const POLL_TICK_KEY = (b) => `clips:poll-tick:${b}`;     // round-robin counter when offline

function startedAtIsoForWindow(daysBack) {
  const d = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  // Twitch wants RFC3339 (basically ISO). `.toISOString()` is fine.
  return d.toISOString();
}

async function loadPostedSet(env, broadcasterId) {
  const list = await env.LOADOUT_BOLTS.get(POSTED_KEY(broadcasterId), { type: 'json' });
  return Array.isArray(list) ? list : [];
}
async function savePostedSet(env, broadcasterId, list) {
  // FIFO trim, newest at the END.
  const trimmed = list.length > POSTED_CAP ? list.slice(-POSTED_CAP) : list;
  await env.LOADOUT_BOLTS.put(POSTED_KEY(broadcasterId), JSON.stringify(trimmed));
}

async function discordRest(env, method, path, body) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, status: 503 };
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord twitch-clips',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body: parsed };
}

function clipEmbed(clip) {
  return {
    title: clip.title || 'New clip',
    url: clip.url || `https://clips.twitch.tv/${clip.id}`,
    description: `Clipped by **${clip.creator_name || 'someone'}** · 🎮 _${clip.game_id ? '' : ''}${clip.title ? '' : ''}_`.trim(),
    color: 0x9146FF,
    image: clip.thumbnail_url ? { url: clip.thumbnail_url } : undefined,
    footer: { text: `${(clip.view_count || 0).toLocaleString()} view${clip.view_count === 1 ? '' : 's'} · twitch.tv/${clip.broadcaster_name || ''}` },
    timestamp: clip.created_at || new Date().toISOString(),
  };
}

async function reactTo(env, channelId, messageId, emoji) {
  await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    { method: 'PUT', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord twitch-clips' } },
  ).catch(() => {});
}

// ── Poll new clips ────────────────────────────────────────────────
//
// Called from the :17 hourly cron. No-ops cleanly if Twitch isn't
// configured or the clips channel isn't set. Tick gate: when offline,
// only run every 3rd hourly tick to keep Helix volume down.
//
// Tracks per-clip metadata for the later clip-of-week tally:
//   clips:posted-meta:<broadcasterId>:<clipId> →
//     { channelId, messageId, postedAt, creatorName, creatorId, url, title }

export async function pollNewClipsCron(env) {
  if (!isTwitchConfigured(env)) {
    console.warn('[twitch-clips] twitch not configured, skip');
    return { skipped: 'twitch-not-configured' };
  }
  const clipsChannelId = await getChannelBinding(env, env.AQUILO_VAULT_GUILD_ID, 'clips');
  if (!clipsChannelId) return { skipped: 'no-clips-channel' };
  const broadcasterId = env.CLAY_TWITCH_CHANNEL_ID;
  if (!broadcasterId) return { skipped: 'no-broadcaster-id' };

  // Tick gating, when offline, only poll every 3rd hourly tick.
  const liveState = await env.LOADOUT_BOLTS.get(`twitch:live:state:${broadcasterId}`);
  if (!liveState) {
    const tick = (parseInt((await env.LOADOUT_BOLTS.get(POLL_TICK_KEY(broadcasterId))) || '0', 10) || 0) + 1;
    await env.LOADOUT_BOLTS.put(POLL_TICK_KEY(broadcasterId), String(tick));
    if (tick % 3 !== 0) return { skipped: 'tick-gated', tick };
  }

  // 24h lookback window, generous enough to catch a clip that was
  // made just before the previous tick and only landed in Helix's
  // index a few minutes later. Dedup handles duplicates.
  const since = startedAtIsoForWindow(1);
  const clips = await getRecentClips(env, broadcasterId, since);
  const posted = await loadPostedSet(env, broadcasterId);
  const postedSet = new Set(posted);
  const fresh = clips.filter(c => c && c.id && !postedSet.has(c.id));
  if (fresh.length === 0) return { ok: true, polled: clips.length, posted: 0 };

  let postedCount = 0;
  for (const clip of fresh) {
    const post = await discordRest(env, 'POST',
      `/channels/${clipsChannelId}/messages`,
      { embeds: [clipEmbed(clip)], allowed_mentions: { parse: [] } });
    if (!post.ok) {
      console.warn('[twitch-clips] post failed', post.status, clip.id);
      continue;
    }
    postedCount += 1;
    posted.push(clip.id);
    await env.LOADOUT_BOLTS.put(
      `clips:posted-meta:${broadcasterId}:${clip.id}`,
      JSON.stringify({
        channelId:   clipsChannelId,
        messageId:   post.body.id,
        postedAt:    Date.now(),
        creatorName: clip.creator_name || null,
        creatorId:   clip.creator_id || null,
        url:         clip.url || null,
        title:       clip.title || null,
      }),
      { expirationTtl: 30 * 24 * 60 * 60 },   // 30-day TTL, covers the 7-day window with cushion
    );
    // Prefill 👍 / 👎 so viewers see them and can one-tap react.
    await reactTo(env, clipsChannelId, post.body.id, '👍');
    await reactTo(env, clipsChannelId, post.body.id, '👎');
  }
  await savePostedSet(env, broadcasterId, posted);
  return { ok: true, polled: clips.length, posted: postedCount };
}

// ── ISO week helper ───────────────────────────────────────────────────
//
// (The Sunday-22-ET postClipOfTheWeekCron that lived here was removed
// 2026-07 — duplicate of aquilo/clipoftheweek.js, see header. isoWeek
// stays: it is unit-tested and useful for weekly KV keying.)

function isoWeek(date = new Date()) {
  // ISO 8601 week-numbering year + week. Standard algorithm.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86_400_000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

export { isoWeek as _isoWeekForTest };
