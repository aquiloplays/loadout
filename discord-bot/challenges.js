// Weekly community challenges, a shared community-wide goal that
// rotates every Monday at 00:00 UTC. Players contribute through
// normal play; the bus calls contributeToChallenge() as a 5th consumer.
//
// State (KV):
//   challenge:current        { id, templateId, kind, name, description,
//                              target, progress, startedUtc, expiresUtc,
//                              completedUtc?, contributors:{userId:count} }
//   challenge:archive:<id>   completed/expired challenges (TTL 60 days)
//   challenge:list           [{ id, templateId, completedUtc?, target,
//                               progress }, ...] newest first, cap 20
//
// Cron rotation: piggybacks on the :23 hourly tick. KV marker
// `challenge:rotation:lastIsoWeek` ensures we only rotate once per
// ISO week even though the cron fires hourly.
//
// Endpoints:
//   GET  /community/challenge          current + progress + leaderboard
//   GET  /community/challenge/history  last 20 archives
//
// On completion: Discord celebratory embed posted to the community
// channel (resolved via sf-community.js binding), naming the top
// contributors (5 by count).
// (Bolts economy sunset: the small bolts reward to the top
// contributors has been removed; the challenge is now a shared
// community goal + leaderboard with no currency payout.)

import { getActiveGuildId } from './aquilo/config.js';

const CURRENT_KEY  = 'challenge:current';
const ARCHIVE_KEY  = (id) => `challenge:archive:${id}`;
const LIST_KEY     = 'challenge:list';
const ROTATION_MARKER = 'challenge:rotation:lastIsoWeek';

// ── Catalog of rotating challenge templates ───────────────────────
//
// `kinds` is the set of progressionEvent kinds that contribute (with
// optional `units(event)` to derive the contribution magnitude from
// the event meta).
//
// Reseeded 2026-07-09 (community roadmap item 9). Two rules applied:
//   1. Every `kinds` entry is verified to ACTUALLY FIRE on the sunset
//      line today: daily.claimed + stream.checkin (check-ins),
//      cards.match.played / .won.* / .pack.opened / .crafted
//      (Boltbound web), achievement.unlocked (achievement engine),
//      quest.claimed (daily-quests claim route, producer added in the
//      same slate), star.received (starboard, producer added in the
//      same slate). The old catalog was mostly dead kinds
//      (bet.won, minigame.played, cards.deck.built, board.match.played
//      have no emitters on this line, so those weeks could never move).
//   2. Targets are sized for the actual community (tens of actives,
//      not hundreds), per the roadmap's example sizes, a week should
//      be winnable but not trivial.
//
// (Bolts economy sunset: `reward` omitted, the site's WeeklyChallenge
// card hides its reward chips when the field is absent, and the
// worker-side payout has been a no-op since the sunset.)

const TEMPLATES = [
  {
    id: 'roll-call-week',
    name: 'Roll Call',
    description: 'The community logs {target} daily check-ins this week.',
    kinds: ['daily.claimed', 'stream.checkin'],
    units: () => 1,
    target: 150,
    icon: '📅',
  },
  {
    id: 'game-night-week',
    name: 'Game Night',
    description: 'The community plays {target} Boltbound matches this week.',
    kinds: ['cards.match.played'],
    units: () => 1,
    target: 40,
    icon: '🎮',
  },
  {
    id: 'star-search-week',
    name: 'Star Search',
    description: 'Collect {target} ⭐ stars on community messages this week.',
    kinds: ['star.received'],
    units: (e) => Math.max(1, Number(e?.meta?.stars) || 1),
    target: 30,
    icon: '⭐',
  },
  {
    id: 'quest-crushers-week',
    name: 'Quest Crushers',
    description: 'The community claims {target} daily quests this week.',
    kinds: ['quest.claimed'],
    units: () => 1,
    target: 40,
    icon: '🗺️',
  },
  {
    id: 'booster-frenzy-week',
    name: 'Booster Frenzy',
    description: 'The community opens {target} Boltbound packs this week.',
    kinds: ['cards.pack.opened'],
    units: () => 1,
    target: 30,
    icon: '📦',
  },
  {
    id: 'trophy-hunt-week',
    name: 'Trophy Hunt',
    description: 'The community unlocks {target} achievements this week.',
    kinds: ['achievement.unlocked'],
    units: () => 1,
    target: 25,
    icon: '🏆',
  },
  {
    id: 'victory-lap-week',
    name: 'Victory Lap',
    description: 'The community wins {target} Boltbound matches this week.',
    kinds: ['cards.match.won.pvp', 'cards.match.won.npc'],
    units: () => 1,
    target: 25,
    icon: '🥇',
  },
  {
    id: 'workshop-week',
    name: 'Workshop Week',
    description: 'The community crafts {target} Boltbound cards this week.',
    kinds: ['cards.crafted'],
    units: () => 1,
    target: 15,
    icon: '🛠️',
  },
];

export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

// ── ISO week + rotation ───────────────────────────────────────────

// Returns "YYYY-Www" for ISO-week-based dedup.
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Picks the next template, round-robins through the catalog by index
// of last template + 1, with a deterministic seed so retries land on
// the same choice within an ISO week.
function pickNextTemplate(prevTemplateId) {
  if (!prevTemplateId) return TEMPLATES[0];
  const i = TEMPLATES.findIndex(t => t.id === prevTemplateId);
  return TEMPLATES[(i + 1) % TEMPLATES.length] || TEMPLATES[0];
}

function newChallengeId() {
  return 'cc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// Compute the end-of-current-ISO-week (next Monday 00:00 UTC).
function endOfIsoWeekUtc(now = Date.now()) {
  const d = new Date(now);
  const dow = d.getUTCDay() || 7;     // 1..7 (Mon..Sun)
  const daysUntilNextMonday = (8 - dow) % 7 || 7;
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilNextMonday, 0, 0, 0, 0));
  return next.getTime();
}

// ── Read / write helpers ──────────────────────────────────────────

export async function readCurrent(env) {
  return await env.LOADOUT_BOLTS.get(CURRENT_KEY, { type: 'json' });
}
async function writeCurrent(env, rec) {
  await env.LOADOUT_BOLTS.put(CURRENT_KEY, JSON.stringify(rec));
}

async function pushToList(env, entry) {
  const arr = (await env.LOADOUT_BOLTS.get(LIST_KEY, { type: 'json' })) || [];
  arr.unshift(entry);
  if (arr.length > 20) arr.length = 20;
  await env.LOADOUT_BOLTS.put(LIST_KEY, JSON.stringify(arr));
}

// ── Rotation ──────────────────────────────────────────────────────
//
// Called from the cron tick. Idempotent, uses the ISO-week marker so
// only one rotation fires per week even if the cron is invoked
// hourly. Also runs on cold start if there's no current challenge
// yet (first-deploy bootstrap).

export async function rotateIfDue(env) {
  const thisWeek = isoWeekKey(new Date());
  const lastWeek = await env.LOADOUT_BOLTS.get(ROTATION_MARKER, { type: 'text' });
  const current = await readCurrent(env);
  if (current && lastWeek === thisWeek) return { ok: true, action: 'no-op' };

  // Close out the existing one (if any), archive + final embed.
  if (current) {
    // Snapshot BOTH guards BEFORE the backfills below mutate the
    // record:
    //   • alreadyAnnounced — contributeToChallenge posted the
    //     celebration embed mid-week when it stamped completedUtc, so
    //     the close-out must not post it a second time. (The
    //     completedUtc BACKFILL two lines down is a legitimately
    //     un-announced completion and keeps its embed.)
    //   • staleMs — a challenge dead for >8 days (e.g. the expired
    //     June challenge on the first post-deploy tick, or any future
    //     long outage) archives silently; a weeks-late eulogy is
    //     noise. Computed before the expiresUtc backfill, which would
    //     otherwise pin staleMs to ~0.
    const alreadyAnnounced = !!current.completedUtc;
    const staleMs = Date.now() - (current.expiresUtc || current.startedUtc || 0);
    current.expiresUtc = current.expiresUtc || Date.now();
    if (!current.completedUtc && current.progress >= current.target) {
      current.completedUtc = Date.now();
    }
    await env.LOADOUT_BOLTS.put(ARCHIVE_KEY(current.id), JSON.stringify(current), {
      expirationTtl: 60 * 24 * 60 * 60,
    });
    await pushToList(env, {
      id: current.id,
      templateId: current.templateId,
      name: current.name,
      target: current.target,
      progress: current.progress,
      completedUtc: current.completedUtc || null,
      expiresUtc: current.expiresUtc,
    });
    if (!alreadyAnnounced && staleMs < 8 * 24 * 60 * 60 * 1000) {
      try { await postCompletionEmbed(env, current); } catch (e) {
        console.warn('[challenges] completion embed failed:', e && e.message);
      }
    }
    // Top-contributor rewards, fire on completion only, not on
    // expiry without completion.
    if (current.completedUtc) {
      try { await rewardTopContributors(env, current); } catch (e) {
        console.warn('[challenges] reward failed:', e && e.message);
      }
    }
  }

  // Mint the next challenge.
  const template = pickNextTemplate(current?.templateId || null);
  const now = Date.now();
  const next = {
    id: newChallengeId(),
    templateId: template.id,
    kinds: template.kinds,
    name: template.name,
    description: template.description.replace('{target}', template.target.toLocaleString()),
    target: template.target,
    progress: 0,
    startedUtc: now,
    expiresUtc: endOfIsoWeekUtc(now),
    contributors: {},
    reward: template.reward,
    icon: template.icon,
  };
  await writeCurrent(env, next);
  await env.LOADOUT_BOLTS.put(ROTATION_MARKER, thisWeek);
  try { await postNewChallengeEmbed(env, next); } catch (e) {
    console.warn('[challenges] new-challenge embed failed:', e && e.message);
  }
  return { ok: true, action: 'rotated', from: current?.templateId || null, to: template.id };
}

// ── Event-bus contribution ────────────────────────────────────────
//
// Called from progression/event-bus.js as a 5th consumer. No-op if no
// active challenge or the event's kind isn't in the template.

export async function contributeToChallenge(env, event) {
  try {
    if (!event?.userId || !event?.kind) return { ok: false };
    const current = await readCurrent(env);
    if (!current || current.completedUtc) return { ok: true, skipped: true };
    const kinds = Array.isArray(current.kinds) ? current.kinds : [];
    if (!kinds.includes(event.kind)) return { ok: true, skipped: true };
    const template = getTemplate(current.templateId);
    const delta = template?.units ? Math.max(0, template.units(event) | 0) : 1;
    if (!delta) return { ok: true, skipped: true };

    // KV is eventually consistent, concurrent contributions can race.
    // The single-isolate write here is fine because the bus is the
    // only writer and emits are serialized per request. A lost update
    // across regions is acceptable here (community goal, not a wallet).
    const prevProgress = current.progress | 0;
    current.progress = Math.min(current.target * 2, (current.progress | 0) + delta);
    current.contributors = current.contributors || {};
    current.contributors[event.userId] = (current.contributors[event.userId] || 0) + delta;
    const justCompleted = !current.completedUtc && current.progress >= current.target;
    if (justCompleted) current.completedUtc = Date.now();
    await writeCurrent(env, current);

    if (justCompleted) {
      try { await postCompletionEmbed(env, current); } catch { /* non-fatal */ }
      try { await rewardTopContributors(env, current); } catch { /* non-fatal */ }
    }

    // Community-feed producer (roadmap item 10): surface the moments
    // that matter, the contribution that pushed the bar past 25/50/75%
    // and the one that completed the challenge. Every individual tick
    // would drown the feed; the quarter-marks keep it a story. Wrapped
    // so a feed failure can never break the contribution itself.
    try {
      let crossedPct = null;
      for (const mark of [0.25, 0.5, 0.75]) {
        const at = Math.ceil(current.target * mark);
        if (prevProgress < at && current.progress >= at) crossedPct = Math.round(mark * 100);
      }
      if (justCompleted || crossedPct) {
        const { appendFeedEvent } = await import('./activity-feed.js');
        await appendFeedEvent(env, {
          kind: justCompleted ? 'challenge.completed' : 'challenge.progress',
          userId: event.userId,
          guildId: event.guildId || null,
          meta: {
            challengeId: current.id,
            name: current.name,
            pct: justCompleted ? 100 : crossedPct,
            progress: current.progress,
            target: current.target,
          },
        });
      }
    } catch { /* non-fatal */ }
    return { ok: true, delta, progress: current.progress, target: current.target, justCompleted };
  } catch (e) {
    console.warn('[challenges] contribute failed:', e && e.message);
    return { ok: false, error: String(e && e.message) };
  }
}

// ── Discord embeds ────────────────────────────────────────────────

async function resolveChallengeChannel(env) {
  const gid = await getActiveGuildId(env);
  if (!gid) return null;
  // Reuse the sf-community channel binding for posts.
  try {
    const binding = await env.LOADOUT_BOLTS.get(`sf_community:channel:guild:${gid}`, { type: 'json' });
    if (binding?.channelId) return { guildId: gid, channelId: String(binding.channelId) };
  } catch { /* fall through */ }
  // Fallback to engagement channel.
  if (env.ENGAGEMENT_CHANNEL_ID) return { guildId: gid, channelId: env.ENGAGEMENT_CHANNEL_ID };
  return null;
}

async function postEmbed(env, channelId, embed) {
  if (!env.DISCORD_BOT_TOKEN || !channelId) return { ok: false };
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    });
    if (!r.ok) return { ok: false };
    return { ok: true };
  } catch { return { ok: false }; }
}

async function postNewChallengeEmbed(env, challenge) {
  const ch = await resolveChallengeChannel(env);
  if (!ch) return;
  const embed = {
    color: 0x7C5CFF,
    title: `${challenge.icon || '🎯'} New community challenge, ${challenge.name}`,
    description: challenge.description,
    // (Bolts economy sunset: dropped the bolt-reward field; the
    // challenge is now a shared community goal with a leaderboard,
    // no currency payout.)
    fields: [
      { name: 'Goal', value: `0 / ${challenge.target.toLocaleString()}`, inline: true },
      { name: 'Ends', value: `<t:${Math.floor(challenge.expiresUtc / 1000)}:R>`, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'aquilo.gg, community challenge' },
  };
  await postEmbed(env, ch.channelId, embed);
}

async function postCompletionEmbed(env, challenge) {
  const ch = await resolveChallengeChannel(env);
  if (!ch) return;
  const top = topContributors(challenge, 5);
  const lines = top.length
    ? await Promise.all(top.map(async (c, i) => {
        const name = await usernameFor(env, c.userId);
        return `${i + 1}. **${name}**, ${c.count.toLocaleString()} contributions`;
      }))
    : ['_no recorded contributions_'];
  const wonIt = challenge.completedUtc && challenge.progress >= challenge.target;
  const embed = {
    color: wonIt ? 0x3FB950 : 0xF0B429,
    title: wonIt
      ? `🎉 Community challenge complete, ${challenge.name}`
      : `⏰ Community challenge ended, ${challenge.name}`,
    description: wonIt
      ? `The community hit **${challenge.progress.toLocaleString()} / ${challenge.target.toLocaleString()}**. Shout-out to the top contributors below!`
      : `Final tally: **${challenge.progress.toLocaleString()} / ${challenge.target.toLocaleString()}**. New challenge starting now.`,
    fields: [
      { name: 'Top contributors', value: lines.join('\n') },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'aquilo.gg, community challenge' },
  };
  await postEmbed(env, ch.channelId, embed);
}

function topContributors(challenge, n = 5) {
  const entries = Object.entries(challenge.contributors || {})
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
  return entries;
}

async function usernameFor(env, userId) {
  try {
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' });
    return p?.username || p?.displayName || `Player ${String(userId).slice(-4)}`;
  } catch { return `Player ${String(userId).slice(-4)}`; }
}

// (Bolts economy sunset: the top-contributor payout — template bolts
// split evenly across the top finishers via wallet.js earn — has been
// removed. Kept as a no-op so the completion call sites stay intact;
// the challenge still tracks contributions + posts the celebratory
// embed naming the top contributors, just with no currency reward.)
async function rewardTopContributors(env, challenge) {
  return;
}

// ── HTTP dispatcher ───────────────────────────────────────────────

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

export async function handleChallengeRoute(req, env, path) {
  if (req.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
  if (path === '/community/challenge/history') {
    const list = (await env.LOADOUT_BOLTS.get(LIST_KEY, { type: 'json' })) || [];
    return json({ history: list });
  }
  // Default, current challenge + progress + top-10 contributors.
  const current = await readCurrent(env);
  if (!current) return json({ current: null });
  const top = topContributors(current, 10);
  const topEnriched = await Promise.all(top.map(async (c) => ({
    userId: c.userId,
    username: await usernameFor(env, c.userId),
    count: c.count,
  })));
  return json({
    current: {
      id: current.id,
      templateId: current.templateId,
      name: current.name,
      description: current.description,
      target: current.target,
      progress: current.progress,
      startedUtc: current.startedUtc,
      expiresUtc: current.expiresUtc,
      completedUtc: current.completedUtc || null,
      icon: current.icon,
      reward: current.reward,
      contributorsCount: Object.keys(current.contributors || {}).length,
    },
    topContributors: topEnriched,
  });
}
