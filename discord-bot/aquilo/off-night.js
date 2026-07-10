// Off-night programming. The stream is dark Tuesday + Thursday now
// (schedule v7), but the community's trained gather time is still ~9 PM ET,
// so those two evenings would otherwise be silent. This posts ONE warm beat
// to the community channel at ~9 PM ET on Tue + Thu:
//   Tuesday  -> a clip rewind (the week's top member clip, from the D1
//               clips table) + a conversation prompt
//   Thursday -> the weekly-challenge check-in + an evening prompt
// Idempotent per day (dedup marker). Best-effort: silent on a dead token /
// missing channel binding.
//
// Public API: runOffNightCron(env)

import { getETInfo, postChannelMessage } from "./util.js";
import { getChannelBinding } from "../channel-bindings.js";
import { todayET } from "../community-checkin.js";

const PROMPTS_TUE = [
  "Drop your favorite clip or moment from a recent stream.",
  "What made you laugh the hardest this week?",
  "If you could rewatch one stream from this week, which one?",
  "Best play you saw on stream lately? Show us.",
];
const PROMPTS_THU = [
  "What are you playing or watching tonight?",
  "Show us your setup, or the game you're grinding this week.",
  "Recommend something: a game, a show, or a song.",
  "What do you want to see on stream this weekend?",
];

function pick(arr, seed) {
  return arr[((seed % arr.length) + arr.length) % arr.length];
}

async function resolveChannel(env, guildId) {
  return (
    (await getChannelBinding(env, guildId, "checkin")) ||
    (await getChannelBinding(env, guildId, "live")) ||
    env.ENGAGEMENT_CHANNEL_ID ||
    env.CHECKIN_CHANNEL_ID ||
    null
  );
}

async function topRecentClip(env, guildId) {
  if (!env || !env.DB) return null;
  try {
    const cutoff = new Date(Date.now() - 8 * 86400000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const { results } = await env.DB.prepare(
      `SELECT url, author_id, clap_count FROM clips
         WHERE guild_id = ? AND posted_at >= ?
         ORDER BY clap_count DESC, posted_at DESC LIMIT 1`,
    )
      .bind(guildId, cutoff)
      .all();
    return (results && results[0]) || null;
  } catch {
    return null;
  }
}

export async function runOffNightCron(env) {
  const guildId = env.AQUILO_VAULT_GUILD_ID;
  if (!guildId || !env.LOADOUT_BOLTS) return { ok: false, reason: "no-guild" };

  const { weekday, day } = getETInfo();
  if (weekday !== "tuesday" && weekday !== "thursday") {
    return { ok: true, skipped: "not-off-night" };
  }

  const dayKey = `off-night:sent:${guildId}:${todayET()}`;
  if (await env.LOADOUT_BOLTS.get(dayKey)) return { ok: true, skipped: "already-sent" };

  const channelId = await resolveChannel(env, guildId);
  if (!channelId) return { ok: false, reason: "no-channel" };

  const seed = typeof day === "number" ? day : parseInt(day, 10) || 0;
  let embed;
  if (weekday === "tuesday") {
    const clip = await topRecentClip(env, guildId);
    const prompt = pick(PROMPTS_TUE, seed);
    embed = {
      title: "Off-night: Clip Rewind",
      description: clip
        ? `No stream tonight, so here's a favorite from the week. React if you remember this one.\n\n${clip.url}\n\n**${prompt}**`
        : `No stream tonight, so let's hang out here.\n\n**${prompt}**`,
      color: 0x7c5cff,
    };
  } else {
    const prompt = pick(PROMPTS_THU, seed);
    let chLine = "";
    try {
      const cur = await env.LOADOUT_BOLTS.get("challenge:current", "json");
      if (cur && cur.name && cur.target) {
        chLine = `\n\nThis week's challenge: **${cur.name}**, ${cur.progress || 0}/${cur.target}. Every check-in and stream counts.`;
      }
    } catch {
      /* best-effort */
    }
    embed = {
      title: "Off-night hangout",
      description: `No stream tonight. What's everyone up to?\n\n**${prompt}**${chLine}`,
      color: 0x5ee5ff,
    };
  }

  // Reserve before posting so a retry can't double-post.
  await env.LOADOUT_BOLTS.put(dayKey, "1", { expirationTtl: 30 * 3600 });
  try {
    await postChannelMessage(env, channelId, { embeds: [embed] });
    return { ok: true, posted: weekday };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "post-failed" };
  }
}
