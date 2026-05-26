// Stream schedule v3 (rev 2026-05-14): fixed weekly rotation with Saturday
// as the single Community Night and Tue/Thu as intentional rest days.
//   Sun/Mon/Wed/Fri → Minecraft (10:30 PM-12:30 AM ET)
//   Tue/Thu         → REST (no stream)
//   Sat             → Community Night (game decided by 6 PM ET poll)
// Single rolling embed in SCHEDULE_CHANNEL_ID. The CN slot shows
// "TBD - vote at 6 PM ET" until Saturday's poll closes, then updates
// in place to the winning game + cover art.

import {
  postChannelMessage, editChannelMessage, discordFetch, COLOR_SCHEDULE, cap, getETInfo
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

// Schedule + poll channels both go through channel-bindings.js now —
// KV per-guild override with the wrangler.toml [vars] entry as
// fallback. Imported async per-call so the module load stays cheap.
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

function buildSchedulePayload(sched) {
  const headerEmbed = {
    title: '📅 Aquilo · Weekly Stream Schedule',
    description: 'Hop in any night. **Community Night** games are decided by the poll — tap **Vote for this week** in <#' + (sched.poll_channel_id || '') + '>.',
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
        : '🎲 **Community Night · vote in progress** · 10:30 PM-12:30 AM ET\n_Polls open at 6 PM ET Saturday — tap **Vote for this week** in <#' + (sched.poll_channel_id || '') + '>_';
    } else {
      art  = MINECRAFT_ART;
      desc = '⛏️ **' + game + '** · 10:30 PM-12:30 AM ET';
    }
    const embed = {
      title: cap(slot.day),
      description: desc,
      color: COLOR_SCHEDULE
    };
    // Use `image` (large) for CN winner art so the schedule looks
    // rich once a vote closes; non-CN days keep the smaller
    // `thumbnail` so Minecraft's logo doesn't dominate every row.
    if (art) {
      if (slot.is_cn && sched.cn_winners?.[slot.day]) embed.image = { url: art };
      else embed.thumbnail = { url: art };
    }
    return embed;
  });

  return { embeds: [headerEmbed, ...dayEmbeds] };
}

// ── Public read — canonical schedule JSON for aquilo.gg ──────────
//
// Stable shape (aquilo-site parallel session is building the public
// /schedule page against this):
//   {
//     ok: true,
//     guildId,
//     nowUtc,
//     poll_channel_id, schedule_channel_id,
//     days: [
//       { weekday, slot: "stream"|"cn"|"off",
//         game: { name, artUrl, store }?,
//         status: "scheduled"|"vote-open"|"vote-completed"|"off",
//         times: { startEt, endEt } }
//     ]
//   }
//
// CN slot semantics:
//   • status = "vote-completed" when sched.cn_winners[day] is set
//   • status = "vote-open" otherwise (placeholder render on the site)
// Non-CN slots are always "scheduled".

export async function getPublicSchedule(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  const days = WEEKLY.map(slot => {
    let game = null;
    let status = slot.is_off ? 'off' : 'scheduled';
    if (slot.is_cn) {
      const winner = sched.cn_winners?.[slot.day];
      if (winner && winner.name) {
        game = { name: winner.name, artUrl: winner.art_url || null, store: storeFromArtUrl(winner.art_url) };
        status = 'vote-completed';
      } else {
        status = 'vote-open';
      }
    } else if (!slot.is_off) {
      game = { name: slot.game, artUrl: slot.game === 'Minecraft' ? MINECRAFT_ART : null, store: 'mojang' };
    }
    return {
      weekday: slot.day,
      slot:    slot.is_off ? 'off' : (slot.is_cn ? 'cn' : 'stream'),
      game,
      status,
      times:   slot.is_off ? null : { startEt: '22:30', endEt: '00:30' },
    };
  });
  return {
    ok: true,
    guildId,
    nowUtc: Date.now(),
    poll_channel_id: sched.poll_channel_id || null,
    schedule_channel_id: sched.channel_id || null,
    days,
  };
}

// Extract the store identifier from an art_url. Steam header URLs
// follow `…/steam/apps/<appid>/…` so we can fingerprint deterministically.
function storeFromArtUrl(artUrl) {
  if (!artUrl) return null;
  const s = String(artUrl);
  if (/\/steam\/apps\/\d+\//.test(s)) return 'steam';
  if (/upload\.wikimedia\.org/.test(s)) return 'mojang';     // Minecraft fallback
  return null;
}

// Post a fresh schedule embed (or edit the existing one in place). Stores
// the message_id so future updates edit instead of spamming new embeds.
//
// Channel-binding migration: if the resolved schedule channel
// changed since the last save (admin set a new binding), delete the
// prior embed in the OLD channel and post fresh in the new one.
// Best-effort delete — if the old message is gone or the bot can't
// see the old channel, we just leave the orphan and proceed.
export async function postOrRefreshSchedule(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  const b = await bindings(env, guildId);
  const resolvedChannel = b.schedule;
  if (!resolvedChannel) {
    // Nothing bound + no env fallback — no-op rather than crash.
    console.warn('[aq-schedule] no schedule channel bound, skipping post');
    return null;
  }
  // Detect channel migration. The stored `sched.channel_id` is where
  // the LAST post lives; if the binding has flipped, sweep the old
  // message and post fresh in the new channel.
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
