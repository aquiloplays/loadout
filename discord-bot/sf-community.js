// StreamFusion → aquilo.gg community sharing.
//
// Three endpoints power the community surface:
//
//   POST /sf/community-live    Heartbeat from a StreamFusion install whose
//                              streamer has opted in to live-status sharing.
//                              Upserts the streamer's entry in the live map
//                              and (on the first heartbeat of a new live
//                              session) posts a "X is live" embed to the
//                              configured Discord channel.
//
//   POST /sf/community-event   Event relay for streamers who have *also*
//                              opted in to community event sharing. Posts
//                              a "X got a sub on twitch.tv/Y" style embed.
//                              Embeds only, no @-pings.
//
//   GET  /community/live       Public list of currently-live community
//                              members. Backs the aquilo.gg community
//                              page. No auth. Stale entries pruned on read
//                              (default 6 min, SF heartbeats every 90s,
//                              giving us ~4 missed heartbeats of slack).
//
// Auth (POST endpoints):
//   X-SF-Community-Key header == env.SF_COMMUNITY_KEY (wrangler secret).
//   The key is embedded in the shipped StreamFusion build, same soft-spam
//   model as the X-Live-Key the retired aquilo-live worker used. Not a
//   real secret; just enough to keep casual abuse off the endpoint.
//
// Owner-only Kick supporter ingest (handleCommunityEvent):
//   The Kick gift/tip → gifter-buckets tap additionally requires
//   header `x-sf-owner-key` == env.SF_OWNER_COMMUNITY_KEY — a REAL
//   secret only Clay's own install carries, because the distributed
//   community key + a client-supplied userId can't authenticate
//   identity. ⚠ DARK until Clay runs
//   `wrangler secret put SF_OWNER_COMMUNITY_KEY` AND StreamFusion
//   ships the header on its community-event POSTs: until both land,
//   the ingest is silently skipped (embeds still post, clients still
//   get their normal ok responses) and the Kick supporter wall simply
//   stays empty — graceful degradation, no errors anywhere.
//
// Storage layout:
//   sf:community:live:all      Single KV key holding a JSON map
//                              userId → { name, platform, channel, url,
//                              title, game, viewers, startedAt, lastSeen,
//                              live }. Single-key model (matches the
//                              retired aquilo-live worker) avoids KV
//                              list() eventual-consistency lag, a
//                              streamer who just went live shows up on
//                              the public radar on the very next read.
//   sf_community:channel:guild:<gid>
//                              Channel binding written via /web/admin
//                              (admin-web.js LOADOUT_BINDINGS).
//
// Discord posting:
//   Uses env.DISCORD_BOT_TOKEN (same as sf-release.js, slash command
//   registration is broken in this deploy but channel-message POSTs
//   work fine).

import { getActiveGuildId } from './aquilo/config.js';

// ── Tuning constants ──────────────────────────────────────────────
const STALE_MS         = 6 * 60 * 1000;  // 6 min, drop from /community/live if no heartbeat
const KV_LIVE_KEY      = 'sf:community:live:all';
const SF_COMMUNITY_BINDING_KEY = (gid) => 'sf_community:channel:guild:' + gid;
// Optional separate route for SF "going live" embeds. When bound,
// the leading-edge live embed posts here instead of the community
// channel. Falls back to sf_community when unset, so existing
// single-channel setups keep working. Set via:
//   wrangler kv key put --binding=LOADOUT_BOLTS --remote \
//     'sf_golive:channel:guild:<gid>' '{"channelId":"…"}'
const SF_GOLIVE_BINDING_KEY    = (gid) => 'sf_golive:channel:guild:' + gid;
// Discord channel-id sanity (shared with admin-web validation).
const SNOWFLAKE_RE     = /^\d{15,25}$/;
// Per-event-type embed colours. Picked from embeds.js COLORS so the
// community channel reads like the rest of the bot's surface.
const EMBED_COLORS = {
  live:   0x7C5CFF, // aquilo violet, "now live" announcement
  follow: 0x6BA9FF, // accent-2, follows
  sub:    0x3FB950, // win green, subs / resubs
  gift:   0xF0B429, // gold, gift subs / bombs
  cheer:  0xB452FF, // purple, bits / cheers
  raid:   0xFF5DAA, // pink, raids
  tip:    0x00F2EA, // cyan, tips
  default: 0x3A86FF,
};
// Platforms we render labels for. Map matches what SF sends.
const PLATFORM_LABELS = {
  tw: 'Twitch', twitch: 'Twitch',
  yt: 'YouTube', youtube: 'YouTube',
  tt: 'TikTok', tiktok: 'TikTok',
  kk: 'Kick', kick: 'Kick',
};
// Canonical platform slugs (2026-07-09, community roadmap item 13).
// StreamFusion sends SHORT codes ('tw'/'yt'/'tt'/'kk') but every
// downstream consumer — the public /community/live contract
// ("twitch"|"youtube"|"kick"|"tiktok"), the golive Twitch-skip gate
// below, and the gifter-roles supporter ingest — expects the LONG
// form. Normalise once at ingest AND once at read (for entries that
// were stored before this fix), so 'kk' heartbeats stop leaking short
// codes to the site and Kick supporters actually reach the wall/roles.
const PLATFORM_CANON = {
  tw: 'twitch',  twitch: 'twitch',
  yt: 'youtube', youtube: 'youtube',
  tt: 'tiktok',  tiktok: 'tiktok',
  kk: 'kick',    kick: 'kick',
};
function canonPlatform(p) {
  const key = String(p || '').toLowerCase();
  return PLATFORM_CANON[key] || key;
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

// Sanitize one heartbeat / event payload field. Strings get trimmed +
// length-capped; URLs are tightened to http(s) only.
function s(v, max) {
  if (v == null) return '';
  const str = String(v).trim();
  return str.length > max ? str.slice(0, max) : str;
}
function safeUrl(v) {
  const str = s(v, 512);
  if (!/^https?:\/\//i.test(str)) return '';
  return str;
}

function authOk(req, env) {
  const got = req.headers.get('x-sf-community-key') || '';
  return !!env.SF_COMMUNITY_KEY && got === env.SF_COMMUNITY_KEY;
}

// ── Live-status KV: read, prune stale, write ───────────────────────
async function readLiveMap(env) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(KV_LIVE_KEY, { type: 'json' });
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch { /* fall through */ }
  return {};
}
async function writeLiveMap(env, map) {
  // No expirationTtl, entries are pruned by lastSeen on read. KV writes
  // are eventually-consistent globally; that's fine here because we
  // only ever read-modify-write from a single Worker isolate per
  // request, and the public radar is allowed to be a few seconds behind.
  await env.LOADOUT_BOLTS.put(KV_LIVE_KEY, JSON.stringify(map));
}
function pruneStale(map, now) {
  let dirty = false;
  for (const id of Object.keys(map)) {
    const entry = map[id];
    if (!entry || entry.lastSeen == null || (now - entry.lastSeen) > STALE_MS || entry.live === false) {
      delete map[id];
      dirty = true;
    }
  }
  return dirty;
}

// ── Discord channel resolver ───────────────────────────────────────
async function resolveCommunityChannel(env) {
  // Fall back to the bot's operating guild (same one postLiveEmbed uses)
  // when the active-guild pointer hasn't been set, so community + go-live
  // announcements work without a separate /setup step.
  const gid = (await getActiveGuildId(env)) || env.AQUILO_VAULT_GUILD_ID;
  if (!gid) return null;
  try {
    const binding = await env.LOADOUT_BOLTS.get(SF_COMMUNITY_BINDING_KEY(gid), { type: 'json' });
    if (binding && SNOWFLAKE_RE.test(String(binding.channelId || ''))) {
      return { guildId: gid, channelId: String(binding.channelId) };
    }
  } catch { /* fall through */ }
  return null;
}

// Resolve the channel for the SF "going live" embed. Prefers
// sf_golive:channel:guild:<gid> when bound; falls back to
// sf_community so single-channel installs keep working unchanged.
export async function resolveGoLiveChannel(env) {
  // Fall back to the bot's operating guild (same one postLiveEmbed uses)
  // when the active-guild pointer hasn't been set, so community + go-live
  // announcements work without a separate /setup step.
  const gid = (await getActiveGuildId(env)) || env.AQUILO_VAULT_GUILD_ID;
  if (!gid) return null;
  try {
    const b = await env.LOADOUT_BOLTS.get(SF_GOLIVE_BINDING_KEY(gid), { type: 'json' });
    if (b && SNOWFLAKE_RE.test(String(b.channelId || ''))) {
      return { guildId: gid, channelId: String(b.channelId) };
    }
  } catch { /* fall through */ }
  return resolveCommunityChannel(env);
}

async function postEmbed(env, channelId, embed) {
  if (!env.DISCORD_BOT_TOKEN || !SNOWFLAKE_RE.test(channelId)) return { ok: false, error: 'no-token-or-channel' };
  const payload = {
    embeds: [embed],
    // Belt-and-braces, server never wants pings from these embeds even
    // if a malicious payload sneaked an @everyone token into the
    // description string.
    allowed_mentions: { parse: [] },
  };
  try {
    const r = await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type':  'application/json',
        'User-Agent':    'Loadout-Worker/1.0 (sf-community)',
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: 'discord_' + r.status, body: body.slice(0, 300) };
    }
    const msg = await r.json().catch(() => null);
    return { ok: true, messageId: msg?.id || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── Embed builders ─────────────────────────────────────────────────
function platformLabel(p) {
  return PLATFORM_LABELS[String(p || '').toLowerCase()] || 'Stream';
}

export function liveEmbed(entry) {
  const platLabel = platformLabel(entry.platform);
  const titlePart = entry.title ? `\n*${entry.title}*` : '';
  const fields = [];
  if (entry.game)    fields.push({ name: 'Playing', value: entry.game, inline: true });
  if (entry.viewers != null) fields.push({ name: 'Viewers', value: String(entry.viewers), inline: true });
  return {
    color:       EMBED_COLORS.live,
    title:       '🔴 ' + entry.name + ' is live on ' + platLabel,
    url:         entry.url || undefined,
    description: titlePart || undefined,
    fields:      fields.length ? fields : undefined,
    timestamp:   new Date().toISOString(),
    footer:      { text: 'aquilo.gg community' },
  };
}

function eventEmbed(ev) {
  const platLabel = platformLabel(ev.platform);
  const color = EMBED_COLORS[ev.eventType] || EMBED_COLORS.default;
  const action = describeEvent(ev);
  const channelLine = ev.url ? `[${ev.name}](${ev.url})` : ev.name;
  // We always include the streamer name in the title so a member glancing
  // at the channel can tell whose chat the event happened in without
  // hovering for the URL preview.
  return {
    color,
    author: { name: ev.name + ' · ' + platLabel },
    title:  action.title,
    description: action.description + '\n' + channelLine,
    timestamp: new Date().toISOString(),
    footer:    { text: 'aquilo.gg community' },
  };
}

// Render an event into an embed title + description pair. Falls back to
// a generic phrasing if the event-type is unknown (the worker is
// permissive, SF is the source of truth for what counts as a
// shareable event, the worker just renders).
function describeEvent(ev) {
  const user = ev.user || 'Someone';
  const amount = (ev.amount != null && Number.isFinite(Number(ev.amount))) ? Number(ev.amount) : null;
  switch (String(ev.eventType || '').toLowerCase()) {
    case 'follow':
      return { title: '+ Follow',
               description: `**${user}** followed.` };
    case 'sub':
      return { title: 'New sub',
               description: `**${user}** subscribed.` };
    case 'resub':
      return { title: 'Resub',
               description: `**${user}** resubscribed.` };
    case 'gift':
      return { title: amount && amount > 1 ? 'Gift sub bomb' : 'Gift sub',
               description: amount && amount > 1
                 ? `**${user}** gifted **${amount}** subs.`
                 : `**${user}** gifted a sub.` };
    case 'cheer':
      return { title: 'Cheer',
               description: amount
                 ? `**${user}** cheered **${amount}** bits.`
                 : `**${user}** cheered.` };
    case 'raid':
      return { title: 'Raid',
               description: amount
                 ? `**${user}** raided with **${amount}** viewers.`
                 : `**${user}** raided.` };
    case 'tip':
      return { title: 'Tip',
               description: amount
                 ? `**${user}** tipped **$${amount}**.`
                 : `**${user}** tipped.` };
    default:
      return { title: 'Event',
               description: `**${user}**, ${s(ev.eventType, 64)}` };
  }
}

// ── Handlers ───────────────────────────────────────────────────────

export async function handleCommunityLive(req, env) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!authOk(req, env))      return json({ ok: false, error: 'unauthorized' }, 401);

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const userId = s(body.userId, 64);
  if (!userId) return json({ ok: false, error: 'missing_userId' }, 400);

  const live = !!body.live;
  const now  = Date.now();

  const map = await readLiveMap(env);
  pruneStale(map, now);
  const prev = map[userId];

  if (!live) {
    // Going-offline heartbeat, drop the entry. We don't post a Discord
    // embed for going offline; the live announcement is one-shot per
    // session, the radar just stops showing them.
    if (prev) {
      delete map[userId];
      await writeLiveMap(env, map);
    }
    return json({ ok: true, action: 'offline' });
  }

  const entry = {
    userId,
    name:      s(body.name, 64) || 'streamer',
    platform:  canonPlatform(s(body.platform, 16)) || 'twitch',
    channel:   s(body.channel, 64),
    url:       safeUrl(body.url),
    title:     s(body.title, 200),
    game:      s(body.game, 120),
    viewers:   (body.viewers != null && Number.isFinite(Number(body.viewers)))
                 ? Math.max(0, Math.floor(Number(body.viewers)))
                 : null,
    startedAt: prev && prev.live ? (prev.startedAt || now) : now,
    lastSeen:  now,
    live:      true,
  };
  map[userId] = entry;
  await writeLiveMap(env, map);

  // Fire Discord embed only on the leading edge, first heartbeat of a
  // new live session, or first heartbeat after a stale gap. Subsequent
  // 90s heartbeats while live get NO embed.
  const isNewSession = !prev || prev.live !== true;
  let posted = null;
  let fanout = null;
  if (isNewSession) {
    // Twitch go-lives are announced by golive-twitch-poll.js (a Helix poll
    // of every aquilo.gg-Twitch-linked streamer), so skip Twitch here to
    // avoid a double-post. SF still announces non-Twitch platforms
    // (YouTube/Kick/TikTok) via the go-live / community binding.
    if (String(entry.platform || '').toLowerCase() !== 'twitch') {
      const channel = await resolveGoLiveChannel(env);
      if (channel) {
        const r = await postEmbed(env, channel.channelId, liveEmbed(entry));
        posted = r.ok ? { channelId: channel.channelId, messageId: r.messageId } : { error: r.error };
      }
    }
    // G1, fan out 'friend.live' to the streamer's aquilo friends. The
    // SF userId is whatever StreamFusion sends (typically a Twitch
    // numeric id for tw streamers). notifyFriendsOfGoLive resolves
    // via plink:twitch:<id> → aquilo userId. No-op if the streamer
    // hasn't linked an aquilo account.
    try {
      const { notifyFriendsOfGoLive } = await import('./friends.js');
      fanout = await notifyFriendsOfGoLive(env, {
        aquiloUserId: null,
        twitchUserId: userId,
        streamerName: entry.name,
        platform:     PLATFORM_LABELS[entry.platform] || 'Twitch',
        url:          entry.url,
        title:        entry.title,
        game:         entry.game,
      });
    } catch (e) {
      console.warn('[sf-community] friend.live fan-out failed:', e && e.message);
    }
  }
  return json({ ok: true, action: 'live', newSession: isNewSession, posted, fanout });
}

export async function handleCommunityEvent(req, env) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!authOk(req, env))      return json({ ok: false, error: 'unauthorized' }, 401);

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const ev = {
    userId:    s(body.userId, 64),
    name:      s(body.name, 64) || 'streamer',
    platform:  canonPlatform(s(body.platform, 16)),
    url:       safeUrl(body.url),
    eventType: s(body.eventType, 32).toLowerCase(),
    user:      s(body.user, 64),
    amount:    body.amount,
    tier:      s(body.tier, 16),
    message:   s(body.message, 280),
  };
  if (!ev.eventType) return json({ ok: false, error: 'missing_eventType' }, 400);

  // Kick supporter ingest (2026-07-09, community roadmap item 13).
  // When the event comes from CLAY'S OWN StreamFusion install and
  // it's a Kick GIFT-SUB event, record it into the same rolling-30d
  // gifter buckets that drive /community/top-supporters + the Top
  // Gifter roles. Gift subs ONLY — tips are dollar amounts, and
  // summing them with gift-sub counts made the bucket total a
  // unit-incoherent number (the wall's "gifted" label and the 'Top
  // Kick Gifter' role name both mean gift subs). Scoped to Kick only:
  // Twitch already ingests via EventSub, TikTok via TikFinity
  // (recording SF's TikTok relay too would double-count under a
  // second identity key). Best-effort, never blocks the embed.
  //
  // Identity binding (2026-07-10 review): the community key is a
  // distributed soft-secret baked into every shipped SF build, so the
  // client-supplied userId can never authenticate "Clay's own
  // install" — any install could forge it and poison the public wall
  // / Top Kick Gifter role. This path therefore requires a DEDICATED
  // owner secret: header `x-sf-owner-key` must equal
  // env.SF_OWNER_COMMUNITY_KEY. On any mismatch (secret unset, header
  // missing/wrong) the recordGifterEvent is skipped SILENTLY and the
  // response stays the normal ok/posted shape, so old clients never
  // error and forgers learn nothing.
  try {
    const clayId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
    const ownerKey = String(env.SF_OWNER_COMMUNITY_KEY || '');
    const ownerBound = !!ownerKey
      && String(req.headers.get('x-sf-owner-key') || '') === ownerKey;
    if (ownerBound && clayId && String(ev.userId) === clayId
        && ev.platform === 'kick'
        && ev.eventType === 'gift'
        && ev.user) {
      const gid = (await getActiveGuildId(env)) || env.AQUILO_VAULT_GUILD_ID;
      if (gid) {
        const { recordGifterEvent } = await import('./gifter-roles.js');
        let amount = (ev.amount != null && Number.isFinite(Number(ev.amount)) && Number(ev.amount) > 0)
          ? Number(ev.amount) : 1;
        // Defense-in-depth: cap a single event's magnitude so even an
        // authenticated-but-buggy client can't nuke the leaderboard.
        if (amount > 500) {
          console.warn('[sf-community] kick gifter amount clamped:',
            amount, '→ 500 (user:', ev.user + ')');
          amount = 500;
        }
        await recordGifterEvent(env, gid, ev.eventType, 'kick', ev.user, amount, Date.now());
      }
    }
  } catch (e) {
    console.warn('[sf-community] kick gifter ingest failed:', e && e.message);
  }

  const channel = await resolveCommunityChannel(env);
  if (!channel) {
    // No binding configured yet, ack so the client doesn't retry
    // forever, but signal in the response that the embed was dropped.
    return json({ ok: true, action: 'no-binding' });
  }
  const r = await postEmbed(env, channel.channelId, eventEmbed(ev));
  if (!r.ok) return json({ ok: false, error: r.error }, 502);
  return json({ ok: true, action: 'posted', messageId: r.messageId });
}

// ── Public listing ────────────────────────────────────────────────
// GET /community/live  →  the aquilo.gg community page consumes this.
//
// Response contract (stable):
//   {
//     ok:        true,
//     fetchedAt: <epoch ms>,
//     count:     <int>,
//     staleMs:   <int>          // staleness threshold the worker applies
//     live: [
//       {
//         name:      "displayName",
//         platform:  "twitch" | "youtube" | "kick" | "tiktok",
//         channel:   "channel handle (lowercased)",
//         url:       "https://twitch.tv/foo",
//         title:     "stream title or ''",
//         game:      "category or ''",
//         viewers:   <int|null>,
//         startedAt: <epoch ms>,
//         lastSeen:  <epoch ms>
//       },
//       ...
//     ]
//   }
//
// Sort: viewers desc, with no-viewer entries last; tie-break by startedAt
// asc (earlier-live first). The userId field is INTERNAL, never returned
// on the public surface so an opted-in streamer can't be re-identified
// across name changes.
export async function handlePublicCommunityLive(req, env) {
  const now = Date.now();
  const map = await readLiveMap(env);
  const dirty = pruneStale(map, now);
  if (dirty) {
    // Write back the pruned map so we don't redo this work on every
    // hit. Don't block on it, the response is what matters.
    await writeLiveMap(env, map).catch(() => {});
  }
  // Merge in aquilo.gg-Twitch-linked live streamers published by
  // golive-twitch-poll.js (Helix poll — shows live streamers on the site
  // even when nobody runs StreamFusion). In-memory prune only; the poller
  // owns 'golive:tw:livemap', we never write it back here.
  let twMap = {};
  try {
    const raw = await env.LOADOUT_BOLTS.get('golive:tw:livemap', { type: 'json' });
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) twMap = raw;
  } catch { /* ignore */ }
  pruneStale(twMap, now);
  // StreamFusion entries win over the poll for the same streamer id.
  const merged = { ...twMap, ...map };
  const list = Object.values(merged).map((e) => ({
    name:         e.name,
    // Read-side canonicalisation covers entries stored before the
    // 2026-07-09 ingest fix ('yt'/'kk' short codes in old heartbeats).
    platform:     canonPlatform(e.platform),
    channel:      e.channel,
    url:          e.url,
    title:        e.title,
    game:         e.game,
    viewers:      e.viewers != null ? e.viewers : null,
    thumbnailUrl: e.thumbnailUrl || null,
    startedAt:    e.startedAt,
    lastSeen:     e.lastSeen,
  }));
  list.sort((a, b) => {
    const av = a.viewers == null ? -1 : a.viewers;
    const bv = b.viewers == null ? -1 : b.viewers;
    if (av !== bv) return bv - av;
    return (a.startedAt || 0) - (b.startedAt || 0);
  });
  return json({
    ok: true,
    fetchedAt: now,
    count: list.length,
    staleMs: STALE_MS,
    live: list,
  }, 200, {
    // Public consumers can cache lightly, aquilo.gg's community page
    // is fine refreshing every 30s; we don't want every page load
    // hitting KV.
    'cache-control': 'public, max-age=0, s-maxage=20',
    'access-control-allow-origin': '*',
  });
}
