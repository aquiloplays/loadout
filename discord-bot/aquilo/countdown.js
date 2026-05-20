// Stream countdown. A single message in COUNTDOWN_CHANNEL_ID that the
// streamer pins. Cron edits it hourly with "next stream in X" relative
// to current ET time.
//
// Schedule rev 2026-05-14:
//   STREAM_TIME_ET = "22:30" (10:30 PM ET) · streams end 12:30 AM ET
//   Stream nights: Sun · Mon · Wed · Fri · Sat
//   No stream nights: Tue · Thu (intentional rest days)
//   Saturday = Community Night (CN poll runs that day)

import {
  postChannelMessage, editChannelMessage, discordFetch, ephemeral,
  COLOR_SCHEDULE, getETInfo, cap
} from './util.js';

const KV_MSG = 'countdown:msgid';
const DEFAULT_STREAM_TIME = '22:30';

const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const NO_STREAM_DAYS = new Set(['tuesday', 'thursday']);
const CN_DAYS = new Set(['saturday']);

function parseStreamTime(env) {
  const t = (env.STREAM_TIME_ET || DEFAULT_STREAM_TIME).trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 22, minute: 30 };
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

// Returns { weekday, minutesAway, isLive }. Walks forward through days
// skipping NO_STREAM_DAYS so "next stream" never points at Tue/Thu.
//
// Stream window: 22:30-00:30 ET (2 hours). The end-of-stream wraps past
// midnight, so we have to check two overlapping windows:
//   (1) Today, late evening: stream-start ≤ minutesNow < midnight
//   (2) Today, early morning: minutesNow < (minutesStart + 2h - 24h) AND
//       yesterday was a stream night
function computeNextStream(env, now = new Date()) {
  const { hour: streamH, minute: streamM } = parseStreamTime(env);
  const et = getETInfo(now);
  const minutesNow = et.hour * 60 + et.minute;
  const minutesStart = streamH * 60 + streamM;
  const streamLenMin = 2 * 60;                   // 2h streams
  const tailMin = (minutesStart + streamLenMin) - 24 * 60;
  // tailMin = how many minutes past midnight the stream runs into the next day
  // (30 for a 22:30 start). Negative ⇒ stream fully fits in one calendar day.

  const todayIdx = WEEKDAYS.indexOf(et.weekday);
  const todayIsStream = !NO_STREAM_DAYS.has(et.weekday);

  // (1) Live now — today is a stream day and we're past stream-start.
  if (todayIsStream && minutesNow >= minutesStart && minutesNow < minutesStart + streamLenMin) {
    return { weekday: et.weekday, minutesAway: 0, isLive: true };
  }

  // (2) Tail of yesterday's stream — early morning of a day after a stream night.
  if (tailMin > 0 && minutesNow < tailMin) {
    const yIdx = (todayIdx + 6) % 7;
    const yesterday = WEEKDAYS[yIdx];
    if (!NO_STREAM_DAYS.has(yesterday)) {
      return { weekday: yesterday, minutesAway: 0, isLive: true };
    }
  }

  // Walk forward day-by-day to the next stream night.
  // dayOffset=0 means "later today, before stream-start."
  let dayOffset = 0;
  if (!todayIsStream || minutesNow >= minutesStart) dayOffset = 1;
  for (let i = 0; i < 7; i++) {
    const targetIdx = (todayIdx + dayOffset) % 7;
    const targetDay = WEEKDAYS[targetIdx];
    if (!NO_STREAM_DAYS.has(targetDay)) {
      const minutesAway = minutesStart - minutesNow + dayOffset * 24 * 60;
      return { weekday: targetDay, minutesAway, isLive: false };
    }
    dayOffset += 1;
  }
  // Defensive fallback (shouldn't reach here unless every day is excluded).
  return { weekday: et.weekday, minutesAway: 0, isLive: false };
}

function relativeTimeText(minutesAway) {
  const hours = Math.floor(minutesAway / 60);
  const mins  = minutesAway % 60;
  if (hours > 0) return hours + 'h ' + (mins > 0 ? mins + 'm' : '');
  return mins + 'm';
}

function buildCountdownPayload(env) {
  const next = computeNextStream(env);
  const { hour: streamH, minute: streamM } = parseStreamTime(env);
  const startStr = String(streamH).padStart(2, '0') + ':' + String(streamM).padStart(2, '0');
  const isCn = CN_DAYS.has(next.weekday);
  const flavor = isCn
    ? '🎲 Community Night — game decided by 6 PM ET poll'
    : '⛏️ Minecraft Night (10:30 PM-12:30 AM ET)';

  let body;
  if (next.isLive) {
    body = '🔴 **LIVE NOW** — ' + cap(next.weekday) + ' · ' + flavor;
  } else {
    body = '🟢 **Next stream:** ' + cap(next.weekday) + ' · ' + startStr + ' ET\n' +
           '⏱ in ~**' + relativeTimeText(next.minutesAway) + '**\n' +
           flavor;
  }

  const embed = {
    title: '📺 Aquilo Stream',
    description: body,
    color: COLOR_SCHEDULE,
    footer: { text: 'Auto-updated hourly · channel topic above also shows the countdown' },
    timestamp: new Date().toISOString()
  };
  return { embeds: [embed] };
}

// Short, glanceable text for the channel topic — always visible at the top
// of the channel regardless of scroll. Discord caps topic at 1024 chars.
function buildTopicText(env) {
  const next = computeNextStream(env);
  const { hour: streamH, minute: streamM } = parseStreamTime(env);
  const startStr = String(streamH).padStart(2, '0') + ':' + String(streamM).padStart(2, '0');
  const isCn = CN_DAYS.has(next.weekday);
  const flavor = isCn ? 'Community Night 🎲' : 'Minecraft ⛏️';
  if (next.isLive) {
    return '🔴 LIVE NOW · ' + cap(next.weekday) + ' · ' + flavor;
  }
  return '📺 Next: ' + cap(next.weekday) + ' ' + startStr + ' ET · in ~' + relativeTimeText(next.minutesAway) + ' · ' + flavor;
}

async function setChannelTopic(env, channelId, topic) {
  return discordFetch(env, '/channels/' + encodeURIComponent(channelId), {
    method: 'PATCH',
    body: JSON.stringify({ topic: (topic || '').slice(0, 1024) })
  });
}

async function setChannelName(env, channelId, name) {
  return discordFetch(env, '/channels/' + encodeURIComponent(channelId), {
    method: 'PATCH',
    body: JSON.stringify({ name: (name || '').slice(0, 100) })
  });
}

// Short text for the voice-channel sidebar slot. Discord caps channel
// names at 100 chars; keep it well under for sidebar legibility.
function buildVcName(env) {
  const next = computeNextStream(env);
  if (next.isLive) {
    const isCn = CN_DAYS.has(next.weekday);
    return '🔴 LIVE · ' + (isCn ? 'Community Night' : 'Minecraft');
  }
  return '📺 Stream in ' + relativeTimeText(next.minutesAway);
}

// Cron entry: every hour. Drives THREE surfaces, each independent (any
// of them can be unconfigured / failing without breaking the others):
//
//   1. COUNTDOWN_VC_ID name — most visible, lives in the sidebar
//   2. COUNTDOWN_CHANNEL_ID topic — visible at top of that channel
//   3. KV_MSG embed — rich detail, click-through, pinnable
//
// Surfaces 1 + 2 need MANAGE_CHANNEL on the respective channels. Without
// it those updates fail silently and the embed-edit path still works.
export async function refreshCountdown(env) {
  // Bail entirely only if all three surfaces are unconfigured.
  if (!env.COUNTDOWN_VC_ID && !env.COUNTDOWN_CHANNEL_ID) return { skipped: 'no_channel' };

  let vcOk = false, topicOk = false;

  if (env.COUNTDOWN_VC_ID) {
    try {
      await setChannelName(env, env.COUNTDOWN_VC_ID, buildVcName(env));
      vcOk = true;
    } catch (e) {
      console.warn('[countdown] VC name update (needs MANAGE_CHANNEL):', e?.message || e);
    }
  }

  if (env.COUNTDOWN_CHANNEL_ID) {
    try {
      await setChannelTopic(env, env.COUNTDOWN_CHANNEL_ID, buildTopicText(env));
      topicOk = true;
    } catch (e) {
      console.warn('[countdown] topic update (needs MANAGE_CHANNEL):', e?.message || e);
    }

    const msgId = await env.STATE.get(KV_MSG);
    if (msgId) {
      try {
        await editChannelMessage(env, env.COUNTDOWN_CHANNEL_ID, msgId, buildCountdownPayload(env));
      } catch (e) {
        if (String(e?.message || '').includes('404')) {
          await env.STATE.delete(KV_MSG);
        }
      }
    }
  }

  return { ok: true, vcUpdated: vcOk, topicUpdated: topicOk };
}

// Hub button: prime all configured surfaces (VC name, channel topic,
// rich embed). Each is independent — partial success is fine.
export async function initCountdown(env) {
  if (!env.COUNTDOWN_VC_ID && !env.COUNTDOWN_CHANNEL_ID) {
    return ephemeral('Set at least one of COUNTDOWN_VC_ID or COUNTDOWN_CHANNEL_ID in wrangler.toml first.');
  }

  const lines = [];

  if (env.COUNTDOWN_VC_ID) {
    try {
      await setChannelName(env, env.COUNTDOWN_VC_ID, buildVcName(env));
      lines.push('✅ Voice-channel name updated (visible in the sidebar).');
    } catch (e) {
      lines.push('⚠️ VC name update failed — bot role needs **Manage Channel** on that voice channel. (' + (e?.message || e) + ')');
    }
  } else {
    lines.push('ℹ️ COUNTDOWN_VC_ID unset — sidebar countdown disabled.');
  }

  if (env.COUNTDOWN_CHANNEL_ID) {
    try {
      await setChannelTopic(env, env.COUNTDOWN_CHANNEL_ID, buildTopicText(env));
      lines.push('✅ Channel topic updated (visible at the top of <#' + env.COUNTDOWN_CHANNEL_ID + '>).');
    } catch (e) {
      lines.push('⚠️ Topic update failed — bot role needs **Manage Channel** in <#' + env.COUNTDOWN_CHANNEL_ID + '>. (' + (e?.message || e) + ')');
    }

    try {
      const msg = await postChannelMessage(env, env.COUNTDOWN_CHANNEL_ID, buildCountdownPayload(env));
      await env.STATE.put(KV_MSG, msg.id);
      lines.push('📌 Rich-embed posted (id: ' + msg.id + ') — pin it if you want.');
    } catch (e) {
      lines.push('⚠️ Embed post failed: ' + (e?.message || e));
    }
  } else {
    lines.push('ℹ️ COUNTDOWN_CHANNEL_ID unset — channel topic + rich embed disabled.');
  }

  return ephemeral(lines.join('\n'));
}
