// Stream schedule v5 (rev 2026-06-24): two shows.
//   Sun / Mon / Wed / Fri -> Crowd Control playthrough ("Triple-C"). The
//                            current campaign game is admin-selectable on
//                            aquilo.gg/admin (KV triple-c:current:<g>);
//                            defaults to Fallout 4. One game at a time,
//                            swapped when Clay finishes it.
//   Tue / Thu / Sat       -> Community Night. The game is picked AT RANDOM
//                            each week from the community pool (games:v1,
//                            pool 'community', managed on aquilo.gg/admin),
//                            a different game per night, stable Sun-Sat,
//                            re-rolled weekly. No more per-night voting.
// Per-day games resolve DYNAMICALLY so the embed + site never drift. A
// one-shot per-date override (schedule:override:<ISO>, admin-set on
// aquilo.gg) wins over the show default for any single night, so any
// night can still be hand-pinned.

import {
  postChannelMessage, editChannelMessage, discordFetch, COLOR_SCHEDULE, cap, getETInfo
} from './util.js';
import { broadcastOverlayUpdate } from './overlay-do.js';
import { gameSlug } from './today-game.js';

// Fixed weekly cadence, Sun -> Sat. `dow` drives per-day override +
// date resolution; `kind` drives the public slot enum + game source.
const WEEKLY = [
  { day: 'sunday',    dow: 0, kind: 'fo4cc'     },
  { day: 'monday',    dow: 1, kind: 'fo4cc'     },
  { day: 'tuesday',   dow: 2, kind: 'community' },
  { day: 'wednesday', dow: 3, kind: 'fo4cc'     },
  { day: 'thursday',  dow: 4, kind: 'community' },
  { day: 'friday',    dow: 5, kind: 'fo4cc'     },
  { day: 'saturday',  dow: 6, kind: 'community' },
];

// kind -> the public `slot` enum the site + Discord embed consume.
const PUBLIC_SLOT = {
  'fo4cc': 'fo4cc', 'rotation': 'rotation', 'community': 'cn',
};

// ISO date (YYYY-MM-DD, ET) of the next occurrence of `targetDow`,
// anchored at noon UTC so whole-day arithmetic is DST-safe.
const DOW_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
function isoForDow(targetDow) {
  const et = getETInfo();
  const curDow = DOW_INDEX[et.weekday] ?? 0;
  const ahead = (targetDow - curDow + 7) % 7;
  const d = new Date(Date.UTC(et.year, et.month - 1, et.day, 12) + ahead * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Default Crowd Control campaign game, used until an owner picks one on
// aquilo.gg/admin. Self-contained (no triple-c.js / pool dependency) so a
// missing pool can never break the schedule embed.
const FO4_APPID = 377160;
const CC_DEFAULT = {
  name: 'Fallout 4',
  artUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${FO4_APPID}/header.jpg`,
  store: `https://store.steampowered.com/app/${FO4_APPID}/`,
};

// Deterministic per-week PRNG so the random community pick is stable
// Sun-Sat (the embed + site + overlay all compute the SAME game for a
// given night) yet re-rolls automatically every week.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const rng = mulberry32(seed >>> 0);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}
// YYYYMMDD (int) of this ET week's Sunday — the per-week shuffle seed.
function weekSeedET() {
  const et = getETInfo();
  const curDow = DOW_INDEX[et.weekday] ?? 0;
  const d = new Date(Date.UTC(et.year, et.month - 1, et.day, 12) - curDow * 86400000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// This week's random community-night game for `dow`. Reads the
// aquilo.gg-managed community pool (games:v1, pool 'community'), shuffles
// it deterministically by week, and hands each community night a distinct
// game by its position in the week. Returns { gameId, name, artUrl, store }
// or null when the pool is empty. Exported so the community change-vote
// (cn-change-vote.js) can show + offer "keep the random pick".
export async function weeklyCommunityPick(env, guildId, dow) {
  let cat = null;
  try { cat = await env.LOADOUT_BOLTS.get(`games:v1:${guildId}`, { type: 'json' }); }
  catch { /* fall through */ }
  const pool = (cat && Array.isArray(cat.items) ? cat.items : [])
    .filter((g) => g && g.name && Array.isArray(g.pools) && g.pools.includes('community'));
  if (pool.length === 0) return null;
  const communityDows = WEEKLY.filter((s) => s.kind === 'community').map((s) => s.dow);
  const idx = communityDows.indexOf(dow);
  const shuffled = seededShuffle(pool, weekSeedET());
  const g = shuffled[(idx < 0 ? 0 : idx) % shuffled.length];
  const art = g.headerUrl || g.capsuleUrl || null;
  return { gameId: g.id, name: g.name, artUrl: art, store: g.storeUrl || storeFromArtUrl(art) };
}

// Resolve a day's game from the authoritative source for its kind.
// Order: per-date one-shot override -> show default. Returns
// { name, artUrl, store, override? } or null.
async function resolveSlotGame(env, guildId, kind, sched, dow, dayName) {
  // 1. One-shot per-date override (any night, admin-set on aquilo.gg).
  try {
    const { getDateOverride } = await import('../schedule-rotation.js');
    const ov = await getDateOverride(env, guildId, isoForDow(dow));
    if (ov && ov.name) {
      return { name: ov.name, artUrl: ov.artUrl || null, store: ov.store || storeFromArtUrl(ov.artUrl), override: true };
    }
  } catch { /* optional */ }

  if (kind === 'fo4cc') {
    // Triple-C: the current Crowd Control campaign game, admin-swappable
    // on aquilo.gg/admin (KV triple-c:current:<g>). Defaults to Fallout 4.
    try {
      const cur = await env.LOADOUT_BOLTS.get(`triple-c:current:${guildId}`, { type: 'json' });
      if (cur && cur.name) {
        return { name: cur.name, artUrl: cur.artUrl || null, store: cur.store || storeFromArtUrl(cur.artUrl) };
      }
    } catch { /* fall through to default */ }
    return { ...CC_DEFAULT };
  }
  if (kind === 'rotation') {
    // Retired slot; keep the old resolution so a stray payload still renders.
    try {
      const { getCurrentRotation } = await import('../schedule-rotation.js');
      const c = await getCurrentRotation(env, guildId, dow);
      if (c && c.name) return { name: c.name, artUrl: c.artUrl || null, store: storeFromArtUrl(c.artUrl) };
    } catch { /* optional */ }
    return null;
  }
  if (kind === 'community') {
    // Random weekly pick from the community pool (per-night distinct,
    // stable Sun-Sat, auto re-rolls weekly). A per-date override above wins.
    return await weeklyCommunityPick(env, guildId, dow);
  }
  return null;
}

const KEY = (gid) => 'schedule:' + gid;

async function bindings(env, guildId) {
  const { getChannelBinding } = await import('../channel-bindings.js');
  return {
    schedule: await getChannelBinding(env, guildId, 'schedule'),
    poll:     await getChannelBinding(env, guildId, 'poll'),
  };
}

async function loadSchedule(env, guildId) {
  const b = await bindings(env, guildId);
  const empty = () => ({ channel_id: b.schedule || null, message_id: null, cn_winners: {} });
  const raw = await env.STATE.get(KEY(guildId));
  if (!raw) return empty();
  try { return JSON.parse(raw); }
  catch { return empty(); }
}

async function saveSchedule(env, guildId, sched) {
  sched.updated_at = new Date().toISOString();
  await env.STATE.put(KEY(guildId), JSON.stringify(sched));
}

const TIME_LABEL = '10:30 PM-12:30 AM ET';
const SLOT_META = {
  'fo4cc':     { emoji: '🎮', show: 'Crowd Control' },
  // Retired slot; kept so an old payload or override can still render.
  'rotation':  { emoji: '🔁', show: 'Featured Run' },
  'community': { emoji: '🎲', show: 'Community Night' },
};

async function buildSchedulePayload(env, guildId, sched) {
  const headerEmbed = {
    title: '📅 Aquilo · Weekly Stream Schedule',
    description: 'Crowd Control playthrough **Sun / Mon / Wed / Fri**, Community Night **Tue / Thu / Sat**. The community game is picked at random each week. All shows **' + TIME_LABEL + '**.',
    color: COLOR_SCHEDULE,
  };

  const dayEmbeds = [];
  for (const slot of WEEKLY) {
    const meta = SLOT_META[slot.kind] || { emoji: '📺', show: cap(slot.kind) };
    const game = await resolveSlotGame(env, guildId, slot.kind, sched, slot.dow, slot.day);
    let desc;
    if (game && game.name && game.name !== meta.show) {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}\n**${game.name}**`;
    } else if (game && game.name) {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}`;
    } else {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}\n_Game picked weekly._`;
    }
    const embed = { title: cap(slot.day), description: desc, color: COLOR_SCHEDULE };
    if (game && game.artUrl) embed.thumbnail = { url: game.artUrl };
    dayEmbeds.push(embed);
  }

  return { embeds: [headerEmbed, ...dayEmbeds] };
}

// ── Public read, canonical schedule JSON for aquilo.gg ──────────

export async function getPublicSchedule(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  const days = [];
  for (const slot of WEEKLY) {
    const game = await resolveSlotGame(env, guildId, slot.kind, sched, slot.dow, slot.day);
    days.push({
      weekday: slot.day,
      slot:    PUBLIC_SLOT[slot.kind] || 'stream',
      game,
      status:  'scheduled',
      times:   { startEt: '22:30', endEt: '00:30' },
    });
  }
  return {
    ok: true,
    guildId,
    nowUtc: Date.now(),
    poll_channel_id: sched.poll_channel_id || null,
    schedule_channel_id: sched.channel_id || null,
    days,
  };
}

function storeFromArtUrl(artUrl) {
  if (!artUrl) return null;
  const s = String(artUrl);
  if (/\/steam\/apps\/\d+\//.test(s)) return 'steam';
  if (/upload\.wikimedia\.org/.test(s)) return 'mojang';
  return null;
}

export async function postOrRefreshSchedule(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  const b = await bindings(env, guildId);
  const resolvedChannel = b.schedule;
  if (!resolvedChannel) {
    console.warn('[aq-schedule] no schedule channel bound, skipping post');
    return null;
  }
  if (sched.channel_id && sched.channel_id !== resolvedChannel && sched.message_id) {
    try {
      await discordFetch(env,
        '/channels/' + encodeURIComponent(sched.channel_id) +
        '/messages/' + encodeURIComponent(sched.message_id),
        { method: 'DELETE' });
    } catch (e) {
      console.warn('[aq-schedule] migration delete failed', e?.message || e);
    }
    sched.message_id = null;
  }
  sched.channel_id = resolvedChannel;
  sched.poll_channel_id = b.poll || sched.poll_channel_id;
  const payload = await buildSchedulePayload(env, guildId, sched);

  if (sched.message_id) {
    try {
      await editChannelMessage(env, sched.channel_id, sched.message_id, payload);
      await saveSchedule(env, guildId, sched);
      return sched.message_id;
    } catch { /* fall through to repost */ }
  }

  const msg = await postChannelMessage(env, sched.channel_id, payload);
  sched.message_id = msg.id;
  await saveSchedule(env, guildId, sched);
  try {
    await discordFetch(env,
      '/channels/' + encodeURIComponent(sched.channel_id) + '/pins/' + encodeURIComponent(msg.id),
      { method: 'PUT' });
  } catch (e) {
    console.warn('[aq-schedule] pin failed', e?.message || e);
  }
  return msg.id;
}

// Called from poll.js when a CN poll closes.
export async function updateScheduleForWinner(env, guildId, dayOfWeek, winnerName, winnerArtUrl) {
  const sched = await loadSchedule(env, guildId);
  if (!sched.cn_winners) sched.cn_winners = {};
  sched.cn_winners[dayOfWeek] = { name: winnerName, art_url: winnerArtUrl };
  await saveSchedule(env, guildId, sched);
  await postOrRefreshSchedule(env, guildId);

  const { weekday: today } = getETInfo();
  if (today === dayOfWeek) {
    await broadcastOverlayUpdate(env, {
      weekday: dayOfWeek,
      is_cn: true,
      game: winnerName,
      slug: gameSlug(winnerName),
      art_url: winnerArtUrl,
      source: 'overlay-do'
    });
  }
}

export async function resetWeeklyCnWinners(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  sched.cn_winners = {};
  await saveSchedule(env, guildId, sched);
  await postOrRefreshSchedule(env, guildId);
}
