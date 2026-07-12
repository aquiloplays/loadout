// Stream schedule v8 (rev 2026-07-11): CROWD CONTROL + SATURDAY COMMUNITY NIGHT.
//   Sun/Mon/Wed/Fri -> Crowd Control playthrough ("Triple-C"). The
//                   current campaign game is admin-selectable on
//                   aquilo.gg/admin (KV triple-c:current:<g>); defaults to
//                   Fallout 4. One game at a time, swapped when Clay
//                   finishes it.
//   Tue/Thu -> OFF (rest days, added 2026-07-09 per Clay). kind 'off'
//                   renders a muted rest-day embed + slot 'off' publicly.
//   Sat -> COMMUNITY NIGHT (restored 2026-07-11 per Clay): the game is a
//                   weekly ROTATING pick, auto-resolved by weeklyCommunityPick
//                   from the aquilo.gg-managed community pool (games:v1) —
//                   deterministic per ET week, re-rolls every Sunday. NO vote:
//                   cnvote + the D1 poll + vote-hub stay disabled; the pick is
//                   automatic, overridable per-date on aquilo.gg/admin.
// NOTE: the site's KV cadence (schedule:v1) mirrors this via ONE-TIME manual
// KV writes (v7 rest days 2026-07-09; v8 Saturday community 2026-07-11) —
// nothing in code syncs the two; schedule.js DEFAULT_SCHEDULE carries the
// same v8 shape as the wipe fallback. Per-day games resolve DYNAMICALLY so
// the embed + site never drift. A one-shot per-date override
// (schedule:override:<ISO>, admin-set on aquilo.gg) wins over the show
// default for any single night, so any night can still be pinned.

import {
  postChannelMessage, editChannelMessage, discordFetch, COLOR_SCHEDULE, cap, getETInfo
} from './util.js';
import { broadcastOverlayUpdate } from './overlay-do.js';
import { gameSlug } from './today-game.js';

// Fixed weekly cadence, Sun -> Sat. `dow` drives per-day override +
// date resolution; `kind` drives the public slot enum + game source.
// Exported for today-game.js (follow-overlay theme) + stream-events.js.
export const WEEKLY = [
  { day: 'sunday',    dow: 0, kind: 'fo4cc' },
  { day: 'monday',    dow: 1, kind: 'fo4cc' },
  { day: 'tuesday',   dow: 2, kind: 'off' },
  { day: 'wednesday', dow: 3, kind: 'fo4cc' },
  { day: 'thursday',  dow: 4, kind: 'off' },
  { day: 'friday',    dow: 5, kind: 'fo4cc' },
  { day: 'saturday',  dow: 6, kind: 'community' },
];

// kind -> the public `slot` enum the site + Discord embed consume.
const PUBLIC_SLOT = {
  'fo4cc': 'fo4cc', 'rotation': 'rotation', 'community': 'cn', 'off': 'off',
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
// Same seed, but for the ET week CONTAINING the given ET date (YYYY-MM-DD).
// Needed by consumers that resolve a FUTURE night (stream-events creates
// next Saturday's Discord event up to 7 days out — seeding that from the
// current week would title it with the outgoing week's pick).
function weekSeedForIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return weekSeedET();
  const noon = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const d = new Date(noon.getTime() - noon.getUTCDay() * 86400000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// Calendar date of `dow` (0=Sun..6=Sat) in the CURRENT ET week (anchored to
// this week's Sunday) as a short "Mon D" label. The week + the random
// community picks roll over every Sunday.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function weekDateOf(dow) {
  const et = getETInfo();
  const curDow = DOW_INDEX[et.weekday] ?? 0;
  return new Date(Date.UTC(et.year, et.month - 1, et.day, 12) - curDow * 86400000 + dow * 86400000);
}
function weekDateLabel(dow) {
  const d = weekDateOf(dow);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// This week's random community-night game for `dow`. Reads the
// aquilo.gg-managed community pool (games:v1, pool 'community'), shuffles
// it deterministically by week, and hands each community night a distinct
// game by its position in the week. Returns { gameId, name, artUrl, store }
// or null when the pool is empty. Exported so the community change-vote
// (cn-change-vote.js) can show + offer "keep the random pick".
// Optional `forIso` (YYYY-MM-DD, ET) seeds from THAT date's week instead of
// the current one — pass it when resolving a night beyond this ET week.
export async function weeklyCommunityPick(env, guildId, dow, forIso) {
  let cat = null;
  try { cat = await env.LOADOUT_BOLTS.get(`games:v1:${guildId}`, { type: 'json' }); }
  catch { /* fall through */ }
  const pool = (cat && Array.isArray(cat.items) ? cat.items : [])
    .filter((g) => g && g.name && Array.isArray(g.pools) && g.pools.includes('community'));
  if (pool.length === 0) return null;
  const communityDows = WEEKLY.filter((s) => s.kind === 'community').map((s) => s.dow);
  const idx = communityDows.indexOf(dow);
  const shuffled = seededShuffle(pool, forIso ? weekSeedForIso(forIso) : weekSeedET());
  const g = shuffled[(idx < 0 ? 0 : idx) % shuffled.length];
  const art = g.headerUrl || g.capsuleUrl || null;
  return { gameId: g.id, name: g.name, artUrl: art, store: g.storeUrl || storeFromArtUrl(art) };
}

// Resolve a day's game from the authoritative source for its kind.
// Order: per-date one-shot override -> show default. Returns
// { name, artUrl, store, override? } or null. Exported so today-game.js
// (overlay theme endpoint) resolves tonight from the SAME source.
export async function resolveSlotGame(env, guildId, kind, sched, dow, dayName) {
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
  'off':       { emoji: '😴', show: 'No Stream' },
};

// "Mon Jul 27" style label for an ISO date (vacation return copy).
function isoDateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return iso || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function dayAfterIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12) + 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function buildSchedulePayload(env, guildId, sched) {
  const { readVacation, vacationCoversIso } = await import('../schedule.js');
  const vacation = await readVacation(env, guildId);
  const backOn = vacation ? dayAfterIso(vacation.until) : null;

  const headerEmbed = {
    title: `📅 Aquilo · Weekly Stream Schedule`,
    description:
      (vacation && backOn
        ? `🌴 **On vacation through ${isoDateLabel(vacation.until)}** · back live **${isoDateLabel(backOn)}**` +
          (vacation.note ? ` · ${vacation.note}` : '') + '\n'
        : '') +
      `🗓️ **Week of ${weekDateLabel(0)} – ${weekDateLabel(6)}** · refreshes every Sunday\n` +
      'Solo **Crowd Control** Sun · Mon · Wed · Fri: chat controls the chaos. ' +
      'Saturday is **Community Night**: a rotating game from the community pool, picked fresh each week. ' +
      'Live **' + TIME_LABEL + '**. Tue + Thu are rest days.',
    color: COLOR_SCHEDULE,
  };

  const dayEmbeds = [];
  for (const slot of WEEKLY) {
    const meta = SLOT_META[slot.kind] || { emoji: '📺', show: cap(slot.kind) };
    // Vacation days: muted one-liner, no game resolution.
    if (vacation && vacationCoversIso(vacation, isoForDow(slot.dow))) {
      dayEmbeds.push({
        title: `${cap(slot.day)} · ${weekDateLabel(slot.dow)}`,
        description: `🌴 **No stream**: vacation.${backOn ? ` Back ${isoDateLabel(backOn)}.` : ''}`,
        color: COLOR_SCHEDULE,
      });
      continue;
    }
    // Rest days: muted one-liner, no game resolution, no thumbnail.
    if (slot.kind === 'off') {
      dayEmbeds.push({
        title: `${cap(slot.day)} · ${weekDateLabel(slot.dow)}`,
        description: `${meta.emoji} **No stream**: rest day. See you ${slot.dow === 2 ? 'Wednesday' : 'Friday'}!`,
        color: COLOR_SCHEDULE,
      });
      continue;
    }
    const game = await resolveSlotGame(env, guildId, slot.kind, sched, slot.dow, slot.day);
    let desc;
    if (game && game.name && game.name !== meta.show) {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}\n**${game.name}**`;
    } else if (game && game.name) {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}`;
    } else {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}\n_Game picked weekly._`;
    }
    const embed = { title: `${cap(slot.day)} · ${weekDateLabel(slot.dow)}`, description: desc, color: COLOR_SCHEDULE };
    if (game && game.artUrl) embed.thumbnail = { url: game.artUrl };
    dayEmbeds.push(embed);
  }

  return { embeds: [headerEmbed, ...dayEmbeds] };
}

// ── Public read, canonical schedule JSON for aquilo.gg ──────────

export async function getPublicSchedule(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  const { readVacation, vacationCoversIso } = await import('../schedule.js');
  const vacation = await readVacation(env, guildId);
  const days = [];
  for (const slot of WEEKLY) {
    // Vacation days publish as slot 'off' + status 'vacation' so every
    // consumer (site merge, overlay, panel) treats them as dark nights
    // while still being able to say WHY.
    if (vacation && vacationCoversIso(vacation, isoForDow(slot.dow))) {
      days.push({
        weekday: slot.day,
        slot:    'off',
        game:    null,
        status:  'vacation',
        times:   null,
      });
      continue;
    }
    // Rest days publish as slot 'off' with no game/times so consumers
    // (site merge, overlay) can't mistake them for a scheduled night.
    if (slot.kind === 'off') {
      days.push({
        weekday: slot.day,
        slot:    'off',
        game:    null,
        status:  'off',
        times:   null,
      });
      continue;
    }
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
    vacation: vacation
      ? { from: vacation.from, until: vacation.until, note: vacation.note, backOn: dayAfterIso(vacation.until) }
      : null,
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

// Wipe EVERY bot-authored schedule embed in the bound channel (old +
// current + any duplicates), drop the stale CN-winner cache, then post ONE
// fresh, pinned schedule. Use when the schedule channel changes or an old
// schedule post needs clearing out. After this, the hourly cron +
// postOrRefreshSchedule keep it edited-in-place on every change.
export async function freshRepostSchedule(env, guildId) {
  const b = await bindings(env, guildId);
  const channelId = b.schedule;
  if (!channelId) { console.warn('[aq-schedule] freshRepost: no schedule channel bound'); return null; }

  const isScheduleEmbed = (m) =>
    Array.isArray(m?.embeds) &&
    m.embeds.some((e) => typeof e?.title === 'string' && /Weekly Stream Schedule/i.test(e.title));
  try {
    const msgs = await discordFetch(env, '/channels/' + encodeURIComponent(channelId) + '/messages?limit=50');
    for (const m of (Array.isArray(msgs) ? msgs : [])) {
      if (m?.author?.bot && isScheduleEmbed(m)) {
        try {
          await discordFetch(env,
            '/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(m.id),
            { method: 'DELETE' });
        } catch (e) { console.warn('[aq-schedule] freshRepost delete', e?.message || e); }
      }
    }
  } catch (e) { console.warn('[aq-schedule] freshRepost list', e?.message || e); }

  const sched = await loadSchedule(env, guildId);
  sched.channel_id = channelId;
  sched.message_id = null;   // force a fresh post (the old ones are gone)
  sched.cn_winners = {};     // drop leftover winners from the retired vote model
  await saveSchedule(env, guildId, sched);
  return await postOrRefreshSchedule(env, guildId);
}

// Once per ET week (Sunday), re-post a FRESH pinned schedule for the new
// week — new dates + freshly re-rolled random community games. KV-marker
// gated per week-Sunday so it fires exactly once. Returns true if it reset.
// Called from the hourly cron; the rest of the week it edits in place.
export async function maybeWeeklyReset(env, guildId) {
  let et;
  try { et = getETInfo(); } catch { return false; }
  if (et.weekday !== 'sunday') return false;
  const key = `schedule:weekly-reset:${guildId}:${weekSeedET()}`;
  try { if (await env.STATE.get(key)) return false; } catch { /* proceed */ }
  await freshRepostSchedule(env, guildId);
  try { await env.STATE.put(key, String(Date.now()), { expirationTtl: 8 * 86400 }); } catch { /* best-effort */ }
  return true;
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
