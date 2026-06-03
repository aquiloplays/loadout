// Activity feed, community-wide ring buffer of noteworthy events.
//
// Source: the progressionEvent bus (event-bus.js calls
// `appendIfNoteworthy` as a 4th consumer). Only "highlight-worthy"
// kinds make it in, not every XP tick. Cap 200 entries.
//
// KV layout:
//   feed:community     [{ id, kind, userId, username, guildId, meta, utc }, ...]
//                       newest first, cap 200
//
// Public read endpoint: GET /community/feed?limit=50
// No auth, same shape as the public supporter wall.

const FEED_KEY = 'feed:community';
const FEED_CAP = 200;

// Which event kinds bubble up to the community feed. Tuned to be
// "interesting to scroll past", not chatty. Anything not in this
// set gets dropped on the floor.
//
// Some kinds are conditional (e.g. level.reached only at milestones,
// achievement.unlocked only for rare+). The condition lives in
// `passesNoteworthyFilter` below.
const NOTEWORTHY_KINDS = new Set([
  'streak.milestone',          // 7 / 30 / 100-day streaks
  'tourn.victory',             // tournament winner
  'tourn.runnerup',            // 2nd place
  'level.reached',             // milestone levels only
  'achievement.unlocked',      // rare+ rarity only
  'cards.pack.opened',         // legendary pulls only
  'clash.raid.won.3',          // 3-star raid wins
  'badge.earned',              // any badge
  'clash.war.won',             // guild wars
  'season.tier.reached',       // season-pass milestones (10/25/50/75)
]);

const LEVEL_MILESTONES = new Set([10, 25, 50, 75, 100, 150, 200]);
const RARE_RARITIES    = new Set(['rare', 'epic', 'legendary', 'mythic']);

function passesNoteworthyFilter(event) {
  if (!NOTEWORTHY_KINDS.has(event.kind)) return false;
  const m = event.meta || {};
  switch (event.kind) {
    case 'level.reached':
      return LEVEL_MILESTONES.has(Number(m.level));
    case 'achievement.unlocked':
      return RARE_RARITIES.has(String(m.rarity || '').toLowerCase());
    case 'cards.pack.opened':
      // The pack-open emitter (cards-packs.js) sets `m.hadLegendary`
      // when the rolled pack contained a legendary pull, that's the
      // canonical "noteworthy" signal. Earlier this filter checked
      // `m.rarity` / `m.legendary`, neither of which the emitter
      // populates, so legendary pulls never reached the feed.
      return m.hadLegendary === true
          || RARE_RARITIES.has(String(m.rarity || '').toLowerCase());
    case 'season.tier.reached':
      return [10, 25, 50, 75].includes(Number(m.tier));
    default:
      return true;
  }
}

// Best-effort username lookup, cheap because the bus already runs
// inside the request lifecycle and the call site is async.
async function usernameFor(env, userId) {
  try {
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' });
    return p?.username || p?.displayName || `Player ${String(userId).slice(-4)}`;
  } catch { return `Player ${String(userId).slice(-4)}`; }
}

function newEntryId() {
  return 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export async function appendIfNoteworthy(env, event) {
  try {
    if (!event || !event.kind || !event.userId) return { ok: false };
    if (!passesNoteworthyFilter(event)) return { ok: true, skipped: true };
    const username = await usernameFor(env, event.userId);
    const entry = {
      id: newEntryId(),
      kind: event.kind,
      userId: event.userId,
      username,
      guildId: event.guildId || null,
      meta: event.meta || {},
      utc: event.utc || Date.now(),
    };
    const raw = await env.LOADOUT_BOLTS.get(FEED_KEY, { type: 'json' });
    const arr = Array.isArray(raw) ? raw : [];
    arr.unshift(entry);
    if (arr.length > FEED_CAP) arr.length = FEED_CAP;
    await env.LOADOUT_BOLTS.put(FEED_KEY, JSON.stringify(arr));
    // Fire-and-forget Discord post into the guild's bound activity-
    // feed channel (if configured). Failure must not roll back the
    // KV write, the website feed is the authoritative surface; the
    // Discord post is a nice-to-have nudge for in-server visibility.
    if (event.guildId) {
      postActivityToDiscord(env, event.guildId, entry).catch(() => {});
    }
    return { ok: true, entry };
  } catch (e) {
    console.warn('[activity-feed] append failed:', e && e.message);
    return { ok: false, error: String(e && e.message) };
  }
}

// ── Discord-side push ─────────────────────────────────────────────
// Resolves the bound channel from guild:cfg:<g>.ids.ch_activity_feed
// (set by the new /loadout-setup channel slot, slot id 'ch_activity_feed').
// One-line content post (no embed) so the channel reads like a feed:
//
//   ⭐  **Alice** unlocked a legendary achievement!
//
// We keep the per-kind format table small + opinionated. Unknown
// kinds fall back to a generic line, better one ugly line than a
// silently-dropped event.

const KIND_FORMAT = {
  'streak.milestone':     (u, m) => `🔥  **${u}** hit a **${m.days || '?'}-day** check-in streak!`,
  'tourn.victory':        (u, m) => `🏆  **${u}** won the tournament: *${m.name || 'a tournament'}*`,
  'tourn.runnerup':       (u, m) => `🥈  **${u}** placed 2nd in *${m.name || 'a tournament'}*`,
  'level.reached':        (u, m) => `📈  **${u}** reached **level ${m.level}**!`,
  'achievement.unlocked': (u, m) => `🏅  **${u}** unlocked a **${m.rarity || 'rare'}** achievement: *${m.name || m.id || 'mystery'}*`,
  'cards.pack.opened':    (u, m) => m.hadLegendary
                                    ? `⚡  **${u}** pulled a **LEGENDARY** Boltbound card!`
                                    : `🎴  **${u}** opened a **${m.rarity || 'rare'}** pull!`,
  'clash.raid.won.3':     (u, m) => `⚔️  **${u}** smashed a **3-star** raid victory!`,
  'badge.earned':         (u, m) => `🎖️  **${u}** earned the **${m.name || m.id || 'mystery'}** badge!`,
  'clash.war.won':        (u, m) => `🛡️  **${u}**'s guild won a Clash war!`,
  'season.tier.reached':  (u, m) => `🎖️  **${u}** climbed to **Season tier ${m.tier}**!`,
};

async function postActivityToDiscord(env, guildId, entry) {
  if (!env.DISCORD_BOT_TOKEN) return;
  let cfg = null;
  try {
    cfg = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
  } catch { /* idle */ }
  const channelId = cfg?.ids?.ch_activity_feed;
  if (!channelId) return;  // no bound feed channel, silent skip
  const fmt = KIND_FORMAT[entry.kind];
  const content = fmt
    ? fmt(entry.username, entry.meta || {})
    : `📰  **${entry.username}** · _${entry.kind}_`;
  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
      }),
    });
  } catch { /* idle */ }
}

export async function readCommunityFeed(env, { limit = 50, sinceUtc = null } = {}) {
  const raw = await env.LOADOUT_BOLTS.get(FEED_KEY, { type: 'json' });
  let arr = Array.isArray(raw) ? raw : [];
  if (sinceUtc) arr = arr.filter(e => e.utc > sinceUtc);
  if (limit && arr.length > limit) arr = arr.slice(0, limit);
  return arr;
}

// ── HTTP dispatcher ──────────────────────────────────────────────
//
// Public read, no auth. Mirror of /community/supporters.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=30',
    },
  });
}

export async function handleCommunityFeedRoute(req, env) {
  if (req.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const sinceUtc = parseInt(url.searchParams.get('since') || '0', 10) || null;
  const entries = await readCommunityFeed(env, { limit, sinceUtc });
  return json({ entries, count: entries.length });
}
