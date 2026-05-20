// Stream schedule v3 (rev 2026-05-14): fixed weekly rotation with Saturday
// as the single Community Night and Tue/Thu as intentional rest days.
//   Sun/Mon/Wed/Fri → Minecraft (10:30 PM-12:30 AM ET)
//   Tue/Thu         → REST (no stream)
//   Sat             → Community Night (game decided by 6 PM ET poll)
// Single rolling embed in SCHEDULE_CHANNEL_ID. The CN slot shows
// "TBD - vote at 6 PM ET" until Saturday's poll closes, then updates
// in place to the winning game + cover art.

import {
  postChannelMessage, editChannelMessage, COLOR_SCHEDULE, cap, getETInfo
} from './util.js';
import { MINECRAFT_ART } from './bootstrap.js';
import { broadcastOverlayUpdate } from './overlay-do.js';
import { gameSlug } from './today-game.js';

// Fixed weekly rotation, Sun -> Sat order.
// `is_off:true` = rest day (no stream); displayed as "💤 Rest" in the embed.
const WEEKLY = [
  { day: 'sunday',    game: 'Minecraft', is_cn: false, is_off: false },
  { day: 'monday',    game: 'Minecraft', is_cn: false, is_off: false },
  { day: 'tuesday',   game: null,        is_cn: false, is_off: true  },
  { day: 'wednesday', game: 'Minecraft', is_cn: false, is_off: false },
  { day: 'thursday',  game: null,        is_cn: false, is_off: true  },
  { day: 'friday',    game: 'Minecraft', is_cn: false, is_off: false },
  { day: 'saturday',  game: null,        is_cn: true,  is_off: false }
];

const KEY = (gid) => 'schedule:' + gid;

async function loadSchedule(env, guildId) {
  const raw = await env.STATE.get(KEY(guildId));
  if (!raw) return { channel_id: env.SCHEDULE_CHANNEL_ID || null, message_id: null, cn_winners: {} };
  try { return JSON.parse(raw); }
  catch { return { channel_id: env.SCHEDULE_CHANNEL_ID || null, message_id: null, cn_winners: {} }; }
}

async function saveSchedule(env, guildId, sched) {
  sched.updated_at = new Date().toISOString();
  await env.STATE.put(KEY(guildId), JSON.stringify(sched));
}

function buildSchedulePayload(sched) {
  const headerEmbed = {
    title: '📅 Aquilo · Weekly Stream Schedule',
    description: 'Hop in any night. **Community Night** games are decided by the poll posted at 6 PM ET that day — vote in <#' + (sched.poll_channel_id || '') + '>.',
    color: COLOR_SCHEDULE
  };

  const dayEmbeds = WEEKLY.map(slot => {
    let game = slot.game;
    let art  = null;
    let desc;
    if (slot.is_off) {
      desc = '💤 **Rest day** — no stream';
    } else if (slot.is_cn) {
      const winner = sched.cn_winners?.[slot.day];
      if (winner) { game = winner.name; art = winner.art_url; }
      desc = game
        ? '🎲 **Community Night** · 10:30 PM-12:30 AM ET\n**' + game + '**'
        : '🎲 **Community Night** · 10:30 PM-12:30 AM ET\n_Vote at 6 PM ET Saturday_';
    } else {
      art  = MINECRAFT_ART;
      desc = '⛏️ **' + game + '** · 10:30 PM-12:30 AM ET';
    }
    const embed = {
      title: cap(slot.day),
      description: desc,
      color: COLOR_SCHEDULE
    };
    if (art) embed.thumbnail = { url: art };
    return embed;
  });

  return { embeds: [headerEmbed, ...dayEmbeds] };
}

// Post a fresh schedule embed (or edit the existing one in place). Stores
// the message_id so future updates edit instead of spamming new embeds.
export async function postOrRefreshSchedule(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  if (!sched.channel_id) sched.channel_id = env.SCHEDULE_CHANNEL_ID;
  sched.poll_channel_id = env.POLL_CHANNEL_ID || sched.poll_channel_id;
  const payload = buildSchedulePayload(sched);

  if (sched.message_id) {
    try {
      await editChannelMessage(env, sched.channel_id, sched.message_id, payload);
      await saveSchedule(env, guildId, sched);
      return sched.message_id;
    } catch { /* fall through to repost (message deleted, perms changed, etc) */ }
  }

  const msg = await postChannelMessage(env, sched.channel_id, payload);
  sched.message_id = msg.id;
  await saveSchedule(env, guildId, sched);
  return msg.id;
}

// Called from poll.js when a CN poll closes. Updates that day's slot
// AND pushes the new game out to any connected overlay WebSocket
// clients (skipped silently if OVERLAY_DO binding isn't configured).
export async function updateScheduleForWinner(env, guildId, dayOfWeek, winnerName, winnerArtUrl) {
  const sched = await loadSchedule(env, guildId);
  if (!sched.cn_winners) sched.cn_winners = {};
  sched.cn_winners[dayOfWeek] = { name: winnerName, art_url: winnerArtUrl };
  await saveSchedule(env, guildId, sched);
  await postOrRefreshSchedule(env, guildId);

  // Push to overlay clients (instant theme switch). Mirrors today-game.js
  // payload shape so the overlay code is the same regardless of source.
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

// Called when posting Wednesday's poll (first CN of the week): clears all
// three CN slots so the embed shows "TBD - vote at 6 PM" again.
export async function resetWeeklyCnWinners(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  sched.cn_winners = {};
  await saveSchedule(env, guildId, sched);
  await postOrRefreshSchedule(env, guildId);
}
