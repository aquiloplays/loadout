// Stream schedule v3 FINAL (rev 2026-06-03 PM): three shows.
//   Sun / Tue / Thu -> Rotation slot (admin-picked, schedule-rotation.js)
//   Mon / Wed / Fri -> Fallout 4 CC: Chaos Workout Challenge (fixed)
//   Sat             -> Community Night (7-game pool, vote-hub:winner:cn)
// Variety Night, Dad Game Sunday, and the Triple-C concept are all
// removed. Per-day games resolve DYNAMICALLY so the embed + site never
// drift. A one-shot per-date override (schedule:override:<ISO>) wins over
// the show's default for any single night.

import {
  postChannelMessage, editChannelMessage, discordFetch, COLOR_SCHEDULE, cap, getETInfo
} from './util.js';
import { broadcastOverlayUpdate } from './overlay-do.js';
import { gameSlug } from './today-game.js';

// Fixed weekly rotation, Sun -> Sat. `dow` drives per-day override +
// date resolution; `kind` drives the public slot enum + game source.
const WEEKLY = [
  { day: 'sunday',    dow: 0, kind: 'rotation'  },
  { day: 'monday',    dow: 1, kind: 'fo4cc'     },
  { day: 'tuesday',   dow: 2, kind: 'rotation'  },
  { day: 'wednesday', dow: 3, kind: 'fo4cc'     },
  { day: 'thursday',  dow: 4, kind: 'rotation'  },
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

// Resolve a day's game from the authoritative source for its kind.
// Order: per-date one-shot override -> show default. Returns
// { name, artUrl, store, voteCompleted?, override? } or null.
async function resolveSlotGame(env, guildId, kind, sched, dow) {
  // 1. One-shot per-date override (any night).
  try {
    const { getDateOverride } = await import('../schedule-rotation.js');
    const ov = await getDateOverride(env, guildId, isoForDow(dow));
    if (ov && ov.name) {
      return { name: ov.name, artUrl: ov.artUrl || null, store: storeFromArtUrl(ov.artUrl), override: true };
    }
  } catch { /* optional */ }

  if (kind === 'fo4cc') {
    try {
      const { getFo4cc } = await import('../schedule-rotation.js');
      const c = await getFo4cc(env, guildId);
      return { name: c.name, artUrl: c.artUrl || null, store: c.store || storeFromArtUrl(c.artUrl) };
    } catch { return null; }
  }
  if (kind === 'rotation') {
    try {
      const { getCurrentRotation } = await import('../schedule-rotation.js');
      const c = await getCurrentRotation(env, guildId, dow);
      if (c && c.name) return { name: c.name, artUrl: c.artUrl || null, store: storeFromArtUrl(c.artUrl) };
    } catch { /* optional */ }
    return null;
  }
  if (kind === 'community') {
    let w = null;
    try { w = await env.LOADOUT_BOLTS.get(`vote-hub:winner:${guildId}:cn`, { type: 'json' }); }
    catch { /* fall through */ }
    if ((!w || !w.name) && sched.cn_winners && sched.cn_winners.saturday) {
      const legacy = sched.cn_winners.saturday;
      if (legacy && legacy.name) w = { name: legacy.name, art_url: legacy.art_url };
    }
    if (w && w.name) {
      const art = w.art_url || w.artUrl || null;
      return { name: w.name, artUrl: art, store: storeFromArtUrl(art), voteCompleted: true };
    }
    return null;
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
  'fo4cc':     { emoji: '💪', show: 'Fallout 4 CC: Chaos Workout Challenge' },
  'rotation':  { emoji: '🔁', show: 'Rotation' },
  'community': { emoji: '🏆', show: 'Community Night' },
};

async function buildSchedulePayload(env, guildId, sched) {
  const headerEmbed = {
    title: '📅 Aquilo · Weekly Stream Schedule',
    description: 'Fallout 4 CC Chaos Workout Mon/Wed/Fri, Rotation Sun/Tue/Thu, Community Night Sat. Tap **Vote** in <#' + (sched.poll_channel_id || '') + '> to pick the Community game.',
    color: COLOR_SCHEDULE,
  };

  const dayEmbeds = [];
  for (const slot of WEEKLY) {
    const meta = SLOT_META[slot.kind] || { emoji: '📺', show: cap(slot.kind) };
    const game = await resolveSlotGame(env, guildId, slot.kind, sched, slot.dow);
    const isVoted = slot.kind === 'community';
    let desc;
    if (game && game.name && game.name !== meta.show) {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}\n**${game.name}**`;
    } else if (game && game.name) {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}`;
    } else if (isVoted) {
      desc = `${meta.emoji} **${meta.show} · vote in progress** · ${TIME_LABEL}\n_Tap **Vote** in <#${sched.poll_channel_id || ''}>._`;
    } else {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}\n_Game picked weekly._`;
    }
    const embed = { title: cap(slot.day), description: desc, color: COLOR_SCHEDULE };
    const art = game && game.artUrl;
    if (art) {
      if (game.voteCompleted) embed.image = { url: art };
      else embed.thumbnail = { url: art };
    }
    dayEmbeds.push(embed);
  }

  return { embeds: [headerEmbed, ...dayEmbeds] };
}

// ── Public read, canonical schedule JSON for aquilo.gg ──────────

export async function getPublicSchedule(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  const days = [];
  for (const slot of WEEKLY) {
    const game = await resolveSlotGame(env, guildId, slot.kind, sched, slot.dow);
    const isVoted = slot.kind === 'community';
    const status = isVoted ? (game ? 'vote-completed' : 'vote-open') : 'scheduled';
    days.push({
      weekday: slot.day,
      slot:    PUBLIC_SLOT[slot.kind] || 'stream',
      game,
      status,
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
