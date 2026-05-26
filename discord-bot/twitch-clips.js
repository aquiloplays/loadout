// Twitch clip cross-post + "Clip of the Week".
//
// Twitch removed the clip-created webhook in 2022 — Helix `clips`
// polling is the only path. Called from the :17 hourly cron:
//   • If currently live (twitch:live:state:<b> present): poll every
//     hour (still hourly because that's the cron cadence — the
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
// Clip-of-the-week (Sunday 22 ET): tallies 👍 minus 👎 reaction
// counts for every clip posted in the last 7 days, picks the top
// one, posts an announcement embed + awards 250 bolts to the
// clip creator (resolved by linking Twitch username → Discord id
// via the existing wallet `links` array; falls back to a clipper
// shout-out with no payout if not linked).

import { getRecentClips, isTwitchConfigured } from './twitch-helix.js';
import { earn } from './wallet.js';

const POSTED_KEY  = (b) => `clips:posted:${b}`;
const POSTED_CAP  = 500;
const POLL_TICK_KEY = (b) => `clips:poll-tick:${b}`;     // round-robin counter when offline
const LAST_WEEKLY_KEY = (b) => `clips:weekly:last-week:${b}`;
const CLIP_REWARD_BOLTS = 250;

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
  // FIFO trim — newest at the END.
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
    console.warn('[twitch-clips] twitch not configured — skip');
    return { skipped: 'twitch-not-configured' };
  }
  if (!env.CLIPS_CHANNEL_ID) return { skipped: 'no-clips-channel' };
  const broadcasterId = env.CLAY_TWITCH_CHANNEL_ID;
  if (!broadcasterId) return { skipped: 'no-broadcaster-id' };

  // Tick gating — when offline, only poll every 3rd hourly tick.
  const liveState = await env.LOADOUT_BOLTS.get(`twitch:live:state:${broadcasterId}`);
  if (!liveState) {
    const tick = (parseInt((await env.LOADOUT_BOLTS.get(POLL_TICK_KEY(broadcasterId))) || '0', 10) || 0) + 1;
    await env.LOADOUT_BOLTS.put(POLL_TICK_KEY(broadcasterId), String(tick));
    if (tick % 3 !== 0) return { skipped: 'tick-gated', tick };
  }

  // 24h lookback window — generous enough to catch a clip that was
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
      `/channels/${env.CLIPS_CHANNEL_ID}/messages`,
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
        channelId:   env.CLIPS_CHANNEL_ID,
        messageId:   post.body.id,
        postedAt:    Date.now(),
        creatorName: clip.creator_name || null,
        creatorId:   clip.creator_id || null,
        url:         clip.url || null,
        title:       clip.title || null,
      }),
      { expirationTtl: 30 * 24 * 60 * 60 },   // 30-day TTL — covers the 7-day window with cushion
    );
    // Prefill 👍 / 👎 so viewers see them and can one-tap react.
    await reactTo(env, env.CLIPS_CHANNEL_ID, post.body.id, '👍');
    await reactTo(env, env.CLIPS_CHANNEL_ID, post.body.id, '👎');
  }
  await savePostedSet(env, broadcasterId, posted);
  return { ok: true, polled: clips.length, posted: postedCount };
}

// ── Clip of the Week ──────────────────────────────────────────────
//
// Sunday 22 ET (= Monday 02:17 or 03:17 UTC depending on DST) fires
// once per ISO week. Tallies 👍 - 👎 net score on every clip whose
// posted-meta record falls inside the last 7 days, picks the top
// one, edits the message with a 🏆 reaction + posts a separate
// "Clip of the Week" announcement embed in CLIPS_CHANNEL_ID.
//
// 250-bolt reward goes to the clip creator IF we can resolve their
// Twitch username → Discord id via the wallet `links` array — that's
// the same lookup the bolts-feed digest uses. Otherwise a shout-out
// with no payout (still publicly recognised).
//
// Idempotency via clips:weekly:last-week:<b> = ISO week string.
// Re-running the same week is a no-op.

function isoWeek(date = new Date()) {
  // ISO 8601 week-numbering year + week. Standard algorithm.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86_400_000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

export async function postClipOfTheWeekCron(env) {
  if (!isTwitchConfigured(env)) return { skipped: 'twitch-not-configured' };
  if (!env.CLIPS_CHANNEL_ID)    return { skipped: 'no-clips-channel' };
  const broadcasterId = env.CLAY_TWITCH_CHANNEL_ID;
  if (!broadcasterId) return { skipped: 'no-broadcaster-id' };

  const week = isoWeek(new Date());
  const lastWeek = await env.LOADOUT_BOLTS.get(LAST_WEEKLY_KEY(broadcasterId));
  if (lastWeek === week) return { skipped: 'already-fired-this-week', week };

  // Scan posted clips. We don't keep a separate "last week's" list —
  // list the posted set then filter each meta record by postedAt.
  const posted = await loadPostedSet(env, broadcasterId);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const clipId of posted) {
    const meta = await env.LOADOUT_BOLTS.get(
      `clips:posted-meta:${broadcasterId}:${clipId}`, { type: 'json' });
    if (!meta) continue;
    if (meta.postedAt < sevenDaysAgo) continue;
    candidates.push({ clipId, ...meta });
  }
  if (candidates.length === 0) {
    // Nothing to tally — still stamp the week so we don't keep
    // looking. Avoids the worst case of re-scanning the meta records
    // on every hourly tick after Sunday until we move past 22 ET.
    await env.LOADOUT_BOLTS.put(LAST_WEEKLY_KEY(broadcasterId), week);
    return { skipped: 'no-clips-in-window', week };
  }

  // Fetch reactions for each candidate. We GET the Discord message
  // and read `reactions[]` which already has aggregate counts.
  let best = null;
  for (const c of candidates) {
    const msg = await discordRest(env, 'GET',
      `/channels/${c.channelId}/messages/${c.messageId}`);
    if (!msg.ok || !msg.body) continue;
    const ups   = (msg.body.reactions || []).find(r => r.emoji?.name === '👍')?.count || 0;
    const downs = (msg.body.reactions || []).find(r => r.emoji?.name === '👎')?.count || 0;
    // -1 each (subtract the bot's own pre-reaction).
    const net = Math.max(0, ups - 1) - Math.max(0, downs - 1);
    if (!best || net > best.net) {
      best = { ...c, net, ups, downs };
    }
  }
  if (!best || best.net <= 0) {
    await env.LOADOUT_BOLTS.put(LAST_WEEKLY_KEY(broadcasterId), week);
    return { skipped: 'no-net-positive-clip', week };
  }

  // Reward the creator if we can resolve their wallet via the
  // twitch link record. Best-effort; failing to resolve isn't a
  // hard error — the embed still posts.
  let rewardedDiscordId = null;
  let rewardedBolts = 0;
  if (best.creatorName) {
    try {
      const resolved = await resolveTwitchLinkToDiscord(env, best.creatorName);
      if (resolved) {
        await earn(env, env.AQUILO_VAULT_GUILD_ID, resolved, CLIP_REWARD_BOLTS, 'clip-of-the-week');
        rewardedDiscordId = resolved;
        rewardedBolts = CLIP_REWARD_BOLTS;
      }
    } catch (e) {
      console.warn('[twitch-clips] reward failed', e?.message || e);
    }
  }

  // Post the announcement.
  const lines = [
    `🏆  **Clip of the Week** 🏆`,
    `_${best.title || 'Untitled clip'}_`,
    `Clipped by **${best.creatorName || 'someone'}** — ${best.ups} 👍 / ${best.downs} 👎 (net ${best.net})`,
    `${best.url || ''}`,
    '',
    rewardedDiscordId
      ? `🎁 <@${rewardedDiscordId}> earned **${rewardedBolts}** bolts for this clip!`
      : `(Link your Twitch account on aquilo.gg to claim future Clip-of-the-Week rewards.)`,
  ];
  await discordRest(env, 'POST', `/channels/${env.CLIPS_CHANNEL_ID}/messages`, {
    content: lines.join('\n'),
    allowed_mentions: rewardedDiscordId ? { users: [rewardedDiscordId] } : { parse: [] },
  });
  // Add a 🏆 reaction to the original clip message so it stands out.
  await reactTo(env, best.channelId, best.messageId, '🏆');

  await env.LOADOUT_BOLTS.put(LAST_WEEKLY_KEY(broadcasterId), week);
  return {
    ok: true, week, clipId: best.clipId,
    creator: best.creatorName, net: best.net,
    rewardedDiscordId, rewardedBolts,
  };
}

// Resolve a Twitch login name to a Discord user id by scanning
// wallet records' `links` array. Bounded scan (first 1000 keys
// matching wallet:<g>:*). Returns null if not found.
async function resolveTwitchLinkToDiscord(env, twitchLogin) {
  const guildId = env.AQUILO_VAULT_GUILD_ID;
  if (!guildId) return null;
  const target = String(twitchLogin).toLowerCase();
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await env.LOADOUT_BOLTS.list({
      prefix: `wallet:${guildId}:`, cursor, limit: 1000,
    });
    for (const k of r.keys) {
      const w = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      const link = (w?.links || []).find(l =>
        l && String(l.platform || '').toLowerCase() === 'twitch'
        && String(l.username || '').toLowerCase() === target);
      if (link) return k.name.split(':').pop();
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return null;
}

export { isoWeek as _isoWeekForTest };
