// Stream schedule v3.1 (rev 2026-06-03): simplified to 4 streamed days.
// Dad Game Sunday REMOVED entirely (Sunday is Triple-C now).
//   Sun + Fri    -> Triple-C campaign game (triple-c:current, e.g.
//                   Fallout 4), set via /web/admin/triple-c/set
//   Wed          -> Variety Night winner (vote-hub:winner:variety)
//   Sat          -> Community Night winner (vote-hub:winner:cn)
//   Mon/Tue/Thu  -> no scheduled stream (off)
// Per-day games are resolved DYNAMICALLY at render time so the embed +
// site never drift from the locked-in campaign / vote winners. Off days
// are skipped in the embed and surface as slot 'off' (filtered out) on
// the public feed.

import {
  postChannelMessage, editChannelMessage, discordFetch, COLOR_SCHEDULE, cap, getETInfo
} from './util.js';
import { broadcastOverlayUpdate } from './overlay-do.js';
import { gameSlug } from './today-game.js';

// Fixed weekly rotation, Sun -> Sat order. `kind` drives both the public
// slot enum and dynamic game resolution (see resolveSlotGame):
//   triple-c -> fixed campaign   variety -> Wed vote   community -> Sat vote
//   off -> no scheduled stream
const WEEKLY = [
  { day: 'sunday',    kind: 'triple-c' },   // 2026-06-03: Sunday is Triple-C (Dad Game Sunday removed)
  { day: 'monday',    kind: 'off'      },
  { day: 'tuesday',   kind: 'off'      },
  { day: 'wednesday', kind: 'variety'  },
  { day: 'thursday',  kind: 'off'      },
  { day: 'friday',    kind: 'triple-c' },   // 2026-06-03: Friday back to Triple-C
  { day: 'saturday',  kind: 'community' },
];

// kind -> the public `slot` enum the site + Discord embed consume.
const PUBLIC_SLOT = {
  'triple-c': 'stream', 'variety': 'variety', 'community': 'cn', 'off': 'off',
};

// Resolve a day's game from the authoritative source for its kind.
// Returns { name, artUrl, store, voteCompleted? } or null (vote not yet
// decided / nothing locked in / off day -> caller renders a placeholder).
async function resolveSlotGame(env, guildId, kind, sched) {
  if (kind === 'triple-c') {
    try {
      const { getCurrentTripleC } = await import('../triple-c.js');
      const c = await getCurrentTripleC(env, guildId);
      if (c && c.name) {
        return { name: c.name, artUrl: c.artUrl || null, store: storeFromArtUrl(c.artUrl) };
      }
    } catch { /* optional */ }
    return null;
  }
  if (kind === 'variety' || kind === 'community') {
    const voteKind = kind === 'variety' ? 'variety' : 'cn';
    let w = null;
    try { w = await env.LOADOUT_BOLTS.get(`vote-hub:winner:${guildId}:${voteKind}`, { type: 'json' }); }
    catch { /* fall through */ }
    // Legacy CN winner store (aq-schedule's own cn_winners), kept as a
    // fallback so a winner recorded by the old poll path still shows.
    if ((!w || !w.name) && kind === 'community') {
      const legacy = sched.cn_winners && sched.cn_winners.saturday;
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

// Schedule + poll channels both go through channel-bindings.js now, KV
// per-guild override with the wrangler.toml [vars] entry as fallback.
// Imported async per-call so the module load stays cheap.
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

// 2026-06: async, each day resolves its real game (Triple-C campaign /
// vote winner) via resolveSlotGame. `image` (large) for decided vote
// winners so a closed vote reads rich; `thumbnail` for the fixed
// Triple-C campaign art so it doesn't dominate every row. Off days are
// skipped so the embed only lists the streamed nights.
const TIME_LABEL = '10:30 PM-12:30 AM ET';
const SLOT_META = {
  'triple-c':   { emoji: '📺', show: 'Triple-C' },
  'variety':    { emoji: '🎲', show: 'Variety Night' },
  'community':  { emoji: '🏆', show: 'Community Night' },
};

async function buildSchedulePayload(env, guildId, sched) {
  const headerEmbed = {
    title: '📅 Aquilo · Weekly Stream Schedule',
    description: 'Streaming **Sun · Wed · Fri · Sat**. **Variety** + **Community Night** games are decided by the poll. Tap **Vote** in <#' + (sched.poll_channel_id || '') + '>.',
    color: COLOR_SCHEDULE,
  };

  const dayEmbeds = [];
  for (const slot of WEEKLY) {
    if (slot.kind === 'off') continue;   // off days are not listed
    const meta = SLOT_META[slot.kind] || { emoji: '📺', show: cap(slot.kind) };
    const game = await resolveSlotGame(env, guildId, slot.kind, sched);
    const isVoted = slot.kind === 'variety' || slot.kind === 'community';
    let desc;
    if (game && game.name) {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}\n**${game.name}**`;
    } else if (isVoted) {
      desc = `${meta.emoji} **${meta.show} · vote in progress** · ${TIME_LABEL}\n_Tap **Vote** in <#${sched.poll_channel_id || ''}>. Timing is shown in the voting embed._`;
    } else {
      desc = `${meta.emoji} **${meta.show}** · ${TIME_LABEL}\n_TBA_`;
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
//
// Stable shape (the aquilo-site /schedule surfaces read this):
//   { ok, guildId, nowUtc, poll_channel_id, schedule_channel_id,
//     days: [ { weekday, slot, game?, status, times } ] }
// Off days surface as slot 'off' / status 'off' (the site proxy filters
// them out of the per-slot overlay). Non-voted streamed days are always
// "scheduled".

export async function getPublicSchedule(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  const days = [];
  for (const slot of WEEKLY) {
    if (slot.kind === 'off') {
      days.push({
        weekday: slot.day, slot: 'off', game: null, status: 'off',
        times: { startEt: null, endEt: null },
      });
      continue;
    }
    const game = await resolveSlotGame(env, guildId, slot.kind, sched);
    const isVoted = slot.kind === 'variety' || slot.kind === 'community';
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
    } catch { /* fall through to repost (message deleted, perms changed, etc) */ }
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

// Called from poll.js when a CN poll closes. Updates that day's slot
// AND pushes the new game out to any connected overlay WebSocket
// clients (skipped silently if OVERLAY_DO binding isn't configured).
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

// Called when posting Wednesday's poll (first CN of the week): clears all
// CN slots so the embed shows "vote in progress" again.
export async function resetWeeklyCnWinners(env, guildId) {
  const sched = await loadSchedule(env, guildId);
  sched.cn_winners = {};
  await saveSchedule(env, guildId, sched);
  await postOrRefreshSchedule(env, guildId);
}
