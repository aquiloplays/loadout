// Twitch event → Discord embed rendering + routing.
//
// This module owns:
//   1. Per-event-type embed builders (followEmbed, subEmbed, …) —
//      the v2 brand palette gives each event type a distinctive
//      colour stripe so a glance at the channel is informative.
//   2. resolveEventChannel() — the per-event-type → channel routing
//      that lets Clay split (say) follows into one channel and
//      redemptions into another. Defaults all to a single
//      'stream-notifications' binding; per-event overrides in KV
//      take precedence.
//   3. eventTypeEnabled() — admin toggle that lets Clay disable an
//      event type without removing the EventSub subscription.
//      Useful when a channel is rate-limited by a spike (gift bomb,
//      hype train).
//   4. handle*() — entry points the EventSub webhook dispatcher
//      calls when a notification arrives. Each fetches the routing
//      target, checks the toggle, then posts the embed.
//
// twitch-live.js handles the special-case STREAM.ONLINE / .OFFLINE
// LIFECYCLE EMBED (the edit-in-place "🔴 Streaming" card). This
// module's `handleStreamLiveAnnounce()` posts a SEPARATE, larger
// "going live" announcement to the configured live-now channel,
// with @-mention of the Stream Pings role if configured.
//
// KV keys this module reads/writes:
//   twitch-event-channel:<eventType>      → channel snowflake override.
//                                            Falls back to channel-binding
//                                            `stream-notifications`.
//   twitch-event-toggle:<eventType>       → 'off' to disable. Anything
//                                            else (including absent)
//                                            is treated as enabled.
//   twitch-event:cumulative:subs:<gid>    → running total of sub events
//                                            (counter used in footer copy).
//   twitch-event:cumulative:follows:<gid> → running total of follow events.
//
// All embed colors live in EVENT_COLORS — sourced from the v2 brand
// palette per Clay's spec. Changing a color is one place.

import { getChannelBinding } from './channel-bindings.js';

// ── Brand palette per Clay's spec ─────────────────────────────────
// Hex literals match what was sent: follow violet, sub aurora pink,
// gift sub aurora green, cheer gold, raid bright orange, stream live
// red. Hype train gets a single rainbow-suggestive colour (no native
// embed gradient — we fake with stripe label).
export const EVENT_COLORS = Object.freeze({
  follow:       0x7c5cff,  // violet
  sub:          0xff6ab5,  // aurora pink
  resub:        0xff6ab5,  // same family as sub
  gift:         0x5bff95,  // aurora green
  cheer:        0xffd166,  // gold
  raid:         0xff8c42,  // bright orange
  live:         0xff4757,  // bright red
  ended:        0x444444,  // gray (matches twitch-live.js endedEmbed)
  redemption:   0xb892ff,  // soft purple — gentler since these are high-volume
  hypeTrain:    0xff7a59,  // hype orange (fakes the rainbow with a peach-orange)
  pollOpen:     0x6BA9FF,  // azure
  pollResult:   0x6BA9FF,
  predictionOpen:   0xa78bfa,  // amethyst
  predictionResult: 0xa78bfa,
  ban:          0x9a2222,  // dark red — ban is a moderation-action stripe
  unban:        0x4caf50,  // green — restore
});

// ── Event-type catalogue ──────────────────────────────────────────
// Source of truth for which event types this module knows. The slash
// command's autocomplete + the admin toggle accept these; anything
// else is rejected. Order matters for command choices — most-common
// first.
export const EVENT_TYPES = Object.freeze([
  'follow', 'sub', 'gift', 'resub', 'cheer', 'raid',
  'live', 'ended', 'redemption',
  'hypeTrainBegin', 'hypeTrainProgress', 'hypeTrainEnd',
  'pollBegin', 'pollEnd',
  'predictionBegin', 'predictionEnd',
  'ban', 'unban',
]);

export function isValidEventType(t) {
  return EVENT_TYPES.includes(String(t));
}

// ── Routing + toggle KV helpers ───────────────────────────────────

const CHANNEL_OVERRIDE_KEY = (t) => `twitch-event-channel:${t}`;
const TOGGLE_KEY           = (t) => `twitch-event-toggle:${t}`;
const COUNTER_KEY          = (kind, gid) => `twitch-event:cumulative:${kind}:${gid}`;

// Resolve where this event type's embed should land. Order:
//   1. Per-event override KV `twitch-event-channel:<eventType>`
//   2. Default 'stream-notifications' channel binding
//   3. (special-case for live) fall back to existing 'live' binding
//      so existing single-channel setups keep working
// Returns the resolved channel snowflake or null.
export async function resolveEventChannel(env, guildId, eventType) {
  // 1. Per-event override.
  try {
    const v = await env.LOADOUT_BOLTS.get(CHANNEL_OVERRIDE_KEY(eventType));
    if (v && /^\d{15,25}$/.test(v)) return v;
  } catch { /* fall through */ }
  // 2. Default — special routing for a few event types where Clay
  // has explicit channel keys.
  if (eventType === 'live' || eventType === 'ended') {
    // Going-live announcement; honor live-now first, then live, then default.
    const liveNow = await getChannelBinding(env, guildId, 'live-now');
    if (liveNow) return liveNow;
    const live = await getChannelBinding(env, guildId, 'live');
    if (live) return live;
  }
  if (eventType === 'redemption') {
    const feed = await getChannelBinding(env, guildId, 'redemptions-feed');
    if (feed) return feed;
  }
  // 3. Catch-all: stream-notifications binding.
  return await getChannelBinding(env, guildId, 'stream-notifications');
}

// Returns true unless the toggle KV is explicitly 'off'. Absence =
// enabled. Caller checks this BEFORE building the embed (cheap
// short-circuit when an entire event type is silenced).
export async function eventTypeEnabled(env, eventType) {
  try {
    const v = await env.LOADOUT_BOLTS.get(TOGGLE_KEY(eventType));
    return !v || String(v).toLowerCase() !== 'off';
  } catch {
    return true;
  }
}

// Cumulative counter — used by footer copy ("Total follows: 142").
// Failure-tolerant: a KV error just means the counter doesn't render
// this round.
async function incrementCounter(env, kind, guildId) {
  try {
    const cur = parseInt(await env.LOADOUT_BOLTS.get(COUNTER_KEY(kind, guildId)) || '0', 10) || 0;
    const next = cur + 1;
    await env.LOADOUT_BOLTS.put(COUNTER_KEY(kind, guildId), String(next));
    return next;
  } catch {
    return null;
  }
}

async function getCounter(env, kind, guildId) {
  try {
    return parseInt(await env.LOADOUT_BOLTS.get(COUNTER_KEY(kind, guildId)) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

// ── Generic post helper ───────────────────────────────────────────
//
// Fetches a fresh route + toggle, then posts. Honors `opts.content`
// for a leading text line (used by raid + live to @-mention pings
// role). Allowed_mentions kept tight — only the role id we explicitly
// listed gets pinged, never @everyone / @here.

async function postToChannel(env, channelId, embed, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!/^\d{15,25}$/.test(channelId)) return { ok: false, error: 'bad-channel-id' };
  const allowedMentions = { parse: [] };
  if (opts.mentionRoleId && /^\d{15,25}$/.test(opts.mentionRoleId)) {
    allowedMentions.roles = [opts.mentionRoleId];
  }
  const body = {
    embeds: [embed],
    allowed_mentions: allowedMentions,
  };
  if (opts.content) body.content = String(opts.content).slice(0, 1900);
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type':  'application/json',
        'User-Agent':    'loadout-discord twitch-events',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      return { ok: false, error: 'discord_' + r.status, body: txt.slice(0, 300) };
    }
    const j = await r.json().catch(() => null);
    return { ok: true, messageId: j?.id || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Posts an embed to the resolved channel for `eventType`. Skips
// cleanly when channel unbound or toggle off. Common entry for all
// the handle*() fns below.
async function dispatchEmbed(env, guildId, eventType, embed, opts = {}) {
  const enabled = await eventTypeEnabled(env, eventType);
  if (!enabled) return { skipped: 'toggle-off', eventType };
  const ch = await resolveEventChannel(env, guildId, eventType);
  if (!ch) return { skipped: 'no-channel', eventType };
  return await postToChannel(env, ch, embed, opts);
}

// ── Embed builders ────────────────────────────────────────────────
//
// Each builder takes the canonical EventSub payload shape (or a
// normalised subset) and returns a Discord embed object. Footer
// includes the cumulative counter where Clay asked for it.
// `<t:UNIX:R>` relative timestamps are used for "happened X ago" lines.

function asUnix(iso) {
  if (!iso) return Math.floor(Date.now() / 1000);
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Math.floor(Date.now() / 1000);
  return Math.floor(t / 1000);
}

function tierLabel(tier) {
  // Twitch tier values: '1000' / '2000' / '3000' / 'Prime'.
  switch (String(tier || '')) {
    case '1000': return 'Tier 1';
    case '2000': return 'Tier 2';
    case '3000': return 'Tier 3';
    case 'Prime': return 'Prime';
    default: return tier ? String(tier) : 'Tier 1';
  }
}

export function followEmbed({ userName, userLogin, followedAt }, totalFollows) {
  const t = asUnix(followedAt);
  return {
    color: EVENT_COLORS.follow,
    author: { name: userName || userLogin || 'New follower' },
    title:  '+ New follower',
    description: `**${userName || userLogin || 'A new follower'}** followed <t:${t}:R>`,
    timestamp: new Date((followedAt && Date.parse(followedAt)) || Date.now()).toISOString(),
    footer: totalFollows ? { text: `Total follows: ${totalFollows.toLocaleString()}` } : undefined,
  };
}

export function subEmbed({ userName, userLogin, tier, isGift }, totalSubs) {
  // For NEW (non-gift, non-resub) subscribe events. Resubs go through
  // resubEmbed; the gift-recipient path is `gift` (gifter is the
  // headline name) and we don't double-post the recipient as a fresh sub.
  const t = tierLabel(tier);
  const head = `🌟 New ${t} subscription`;
  return {
    color: EVENT_COLORS.sub,
    author: { name: userName || userLogin || 'New subscriber' },
    title: head,
    description: isGift
      ? `**${userName || userLogin}** is a new ${t} sub (gifted) 🎁`
      : `**${userName || userLogin}** just subscribed at **${t}**!`,
    timestamp: new Date().toISOString(),
    footer: totalSubs ? { text: `Total subs: ${totalSubs.toLocaleString()}` } : undefined,
  };
}

export function resubEmbed({ userName, userLogin, tier, cumulativeMonths, streakMonths, message, durationMonths }, totalSubs) {
  const t = tierLabel(tier);
  const lines = [];
  if (durationMonths && durationMonths > 1) {
    lines.push(`**${userName || userLogin}** resubscribed at **${t}** (${durationMonths}mo prepaid) 💜`);
  } else {
    lines.push(`**${userName || userLogin}** resubscribed at **${t}** 💜`);
  }
  if (cumulativeMonths) lines.push(`**${cumulativeMonths}** months total`);
  if (streakMonths && streakMonths > 1) lines.push(`🔥 **${streakMonths}** month streak`);
  if (message && message.trim()) {
    const m = message.trim().slice(0, 600);
    lines.push('', `> ${m.replace(/\n/g, '\n> ')}`);
  }
  const footerParts = [];
  if (totalSubs) footerParts.push(`Total subs: ${totalSubs.toLocaleString()}`);
  if (streakMonths) footerParts.push(`Day ${streakMonths} streak`);
  return {
    color: EVENT_COLORS.resub,
    author: { name: userName || userLogin || 'Resub' },
    title: '💜 Resubscribed',
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
    footer: footerParts.length ? { text: footerParts.join(' • ') } : undefined,
  };
}

export function giftSubEmbed({ gifterName, gifterLogin, tier, total, cumulativeTotal, isAnon }) {
  // Single OR community gift bomb — `total` is the number gifted in
  // this single event. cumulativeTotal is the gifter's lifetime gift
  // count if Twitch surfaced it.
  const t = tierLabel(tier);
  const who = isAnon ? 'An anonymous gifter' : (`**${gifterName || gifterLogin || 'A gifter'}**`);
  const head = total > 1
    ? `🎁 ${total}× ${t} GIFT BOMB!`
    : `🎁 ${t} GIFT SUB!`;
  const desc = total > 1
    ? `${who} just dropped **${total}** ${t} subs on the community! 🎉`
    : `${who} just gifted a ${t} sub!`;
  const footerParts = [];
  if (cumulativeTotal && cumulativeTotal > total) {
    footerParts.push(`Lifetime gifts from this user: ${cumulativeTotal.toLocaleString()}`);
  }
  return {
    color: EVENT_COLORS.gift,
    author: { name: isAnon ? 'Anonymous gifter' : (gifterName || gifterLogin || 'Gifter') },
    title: head,
    description: desc,
    timestamp: new Date().toISOString(),
    footer: footerParts.length ? { text: footerParts.join(' • ') } : undefined,
  };
}

// Cheer scaling — pick visual variant based on bit amount. Hue is
// constant (gold), but the title intensity escalates.
function cheerSizeLabel(bits) {
  if (bits >= 10_000) return { tag: 'MASSIVE CHEER', emoji: '💎💎💎' };
  if (bits >= 1_000)  return { tag: 'HUGE CHEER',    emoji: '💎💎' };
  if (bits >= 100)    return { tag: 'CHEER',         emoji: '💎' };
  return { tag: 'Cheer', emoji: '✨' };
}

export function cheerEmbed({ userName, userLogin, bits, message, isAnon }) {
  const size = cheerSizeLabel(Number(bits) || 0);
  const who = isAnon ? 'An anonymous cheerer' : (`**${userName || userLogin || 'A cheerer'}**`);
  const lines = [`${who} cheered **${Number(bits).toLocaleString()}** bits! ${size.emoji}`];
  if (message && message.trim()) {
    lines.push('', `> ${message.trim().slice(0, 500).replace(/\n/g, '\n> ')}`);
  }
  return {
    color: EVENT_COLORS.cheer,
    author: { name: isAnon ? 'Anonymous' : (userName || userLogin || 'Cheerer') },
    title: `${size.emoji} ${size.tag} — ${Number(bits).toLocaleString()} bits`,
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
  };
}

export function raidEmbed({ fromBroadcasterName, fromBroadcasterLogin, viewers }) {
  const v = Number(viewers) || 0;
  return {
    color: EVENT_COLORS.raid,
    author: { name: fromBroadcasterName || fromBroadcasterLogin || 'Raider' },
    title:  '⚔️ WELCOME RAIDERS!',
    description:
      `**${fromBroadcasterName || fromBroadcasterLogin}** just raided with **${v.toLocaleString()}** viewer${v === 1 ? '' : 's'}!`
      + (fromBroadcasterLogin ? `\n\nThank them at https://twitch.tv/${fromBroadcasterLogin}` : ''),
    thumbnail: fromBroadcasterLogin
      ? { url: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${fromBroadcasterLogin}-440x248.jpg?cb=${Date.now()}` }
      : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: '⚡ Raid incoming' },
  };
}

// Big "going live" announcement embed. Distinct from twitch-live.js's
// `liveEmbed` which is the rolling status card. This is the
// fanfare-y announce-once embed; the rolling card pipeline is
// untouched.
export function streamLiveAnnounceEmbed({ user, login, title, gameName, startedAt }) {
  const t = asUnix(startedAt);
  const lines = [];
  if (title) lines.push(`**${String(title).slice(0, 200)}**`);
  if (gameName) lines.push(`🎮 _${gameName}_`);
  lines.push('', `Started <t:${t}:R> — join now at https://twitch.tv/${login || 'aquilogg'}`);
  return {
    color: EVENT_COLORS.live,
    author: user?.display_name || login
      ? { name: (user?.display_name || login) + ' is LIVE',
          icon_url: user?.profile_image_url || undefined }
      : undefined,
    title: '🔴 LIVE NOW',
    description: lines.join('\n'),
    url: login ? `https://twitch.tv/${login}` : undefined,
    thumbnail: user?.profile_image_url ? { url: user.profile_image_url } : undefined,
    timestamp: new Date((startedAt && Date.parse(startedAt)) || Date.now()).toISOString(),
  };
}

// End-of-stream summary. lastTitle/lastGame/lastPeakViewers are
// the last-seen values stashed by twitch-live.js's lifecycle state;
// follow/sub/cheer totals are best-effort — Twitch doesn't expose
// per-stream aggregates, so we report the lifetime cumulative
// counters (Clay can reset via /twitch-event reset-counters).
export function streamEndedSummaryEmbed({ user, login, startedAt, lastTitle, lastGame, lastPeakViewers, totalFollows, totalSubs }) {
  const durationMs = startedAt ? (Date.now() - Date.parse(startedAt)) : 0;
  const hrs = Math.floor(durationMs / 3_600_000);
  const mins = Math.floor((durationMs % 3_600_000) / 60_000);
  const dur = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  const lines = [];
  if (lastTitle) lines.push(`**${lastTitle}**`);
  if (lastGame)  lines.push(`🎮 _${lastGame}_`);
  if (lastPeakViewers) lines.push(`👥 peak: ${lastPeakViewers.toLocaleString()}`);
  if (durationMs > 0)  lines.push(`⏱ streamed for **${dur}**`);
  lines.push('');
  if (totalFollows != null) lines.push(`📈 Total follows: ${totalFollows.toLocaleString()}`);
  if (totalSubs != null)    lines.push(`💜 Total subs: ${totalSubs.toLocaleString()}`);
  lines.push('');
  lines.push(`See you next stream at https://twitch.tv/${login || 'aquilogg'}`);
  return {
    color: EVENT_COLORS.ended,
    title: '⚫ ' + (user?.display_name || login || 'Streamer') + ' is offline',
    description: lines.join('\n'),
    thumbnail: user?.profile_image_url ? { url: user.profile_image_url } : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: 'See you next stream' },
  };
}

export function redemptionEmbed({ userName, userLogin, rewardTitle, rewardCost, userInput }) {
  const cost = Number(rewardCost) || 0;
  const lines = [`**${userName || userLogin || 'Someone'}** redeemed **${rewardTitle || '?'}** (${cost.toLocaleString()} points)`];
  if (userInput && String(userInput).trim()) {
    lines.push('', `> ${String(userInput).trim().slice(0, 400).replace(/\n/g, '\n> ')}`);
  }
  return {
    color: EVENT_COLORS.redemption,
    author: { name: userName || userLogin || 'Redemption' },
    title: '🎟️ Channel Point Redemption',
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
  };
}

// Hype train — three variants, distinct titles, same brand colour.
// progress + end carry running totals.
export function hypeTrainBeginEmbed({ goal, total, level, expiresAt }) {
  const t = expiresAt ? asUnix(expiresAt) : null;
  return {
    color: EVENT_COLORS.hypeTrain,
    title: '🚂🌈 HYPE TRAIN STARTING',
    description: [
      `Level **${level || 1}** • Goal: **${Number(goal || 0).toLocaleString()}**`,
      `Current: **${Number(total || 0).toLocaleString()}**`,
      t ? `Ends <t:${t}:R>` : null,
    ].filter(Boolean).join('\n'),
    timestamp: new Date().toISOString(),
    footer: { text: 'All aboard! Subs / bits / gifts power the train' },
  };
}

export function hypeTrainProgressEmbed({ level, total, goal, lastContribUser, lastContribType, lastContribTotal, expiresAt }) {
  const t = expiresAt ? asUnix(expiresAt) : null;
  const lines = [
    `Level **${level || 1}** • **${Number(total || 0).toLocaleString()} / ${Number(goal || 0).toLocaleString()}**`,
  ];
  if (lastContribUser) {
    lines.push(`Latest boost: **${lastContribUser}** (${lastContribType || 'bits'}, +${Number(lastContribTotal || 0).toLocaleString()})`);
  }
  if (t) lines.push(`Ends <t:${t}:R>`);
  return {
    color: EVENT_COLORS.hypeTrain,
    title: '🚂🌈 HYPE TRAIN — Level Up!',
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
    footer: { text: 'Keep going!' },
  };
}

export function hypeTrainEndEmbed({ level, total, topContributions }) {
  const lines = [
    `Reached **Level ${level || 1}**! Total: **${Number(total || 0).toLocaleString()}**`,
  ];
  if (Array.isArray(topContributions) && topContributions.length) {
    lines.push('');
    lines.push('**Top contributors:**');
    for (const c of topContributions.slice(0, 5)) {
      lines.push(`• **${c.user_name || c.user_login || '?'}** — ${Number(c.total || 0).toLocaleString()} ${c.type || ''}`);
    }
  }
  return {
    color: EVENT_COLORS.hypeTrain,
    title: '🚂🎉 HYPE TRAIN COMPLETE',
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
    footer: { text: 'Thank you all!' },
  };
}

export function pollBeginEmbed({ title, choices, endsAt }) {
  const lines = [];
  if (Array.isArray(choices)) {
    for (const c of choices) lines.push(`• ${c.title || c.id || '?'}`);
  }
  const t = endsAt ? asUnix(endsAt) : null;
  if (t) lines.push('', `Ends <t:${t}:R>`);
  return {
    color: EVENT_COLORS.pollOpen,
    title: '🗳️ Poll started — ' + (title || 'untitled'),
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
  };
}

export function pollEndEmbed({ title, status, choices }) {
  const winning = (Array.isArray(choices) ? [...choices] : [])
    .sort((a, b) => (Number(b.votes || 0) - Number(a.votes || 0)))[0] || null;
  const lines = [];
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const votes = Number(c.votes || 0);
      const marker = winning && winning.id === c.id ? '🏆' : '•';
      lines.push(`${marker} ${c.title || c.id || '?'} — ${votes.toLocaleString()} votes`);
    }
  }
  return {
    color: EVENT_COLORS.pollResult,
    title: '🗳️ Poll ended — ' + (title || 'untitled'),
    description: lines.join('\n') || '(no choices?)',
    timestamp: new Date().toISOString(),
    footer: status && status !== 'completed'
      ? { text: 'Status: ' + status }
      : undefined,
  };
}

export function predictionBeginEmbed({ title, outcomes, endsAt }) {
  const lines = [];
  if (Array.isArray(outcomes)) {
    for (const o of outcomes) lines.push(`• ${o.title || o.id || '?'}`);
  }
  const t = endsAt ? asUnix(endsAt) : null;
  if (t) lines.push('', `Locks <t:${t}:R>`);
  return {
    color: EVENT_COLORS.predictionOpen,
    title: '🔮 Prediction — ' + (title || 'untitled'),
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
    footer: { text: 'Place your channel-point bets!' },
  };
}

export function predictionEndEmbed({ title, status, outcomes, winningOutcomeId }) {
  const lines = [];
  if (Array.isArray(outcomes)) {
    for (const o of outcomes) {
      const points = Number(o.channel_points || 0);
      const users  = Number(o.users || 0);
      const marker = winningOutcomeId && o.id === winningOutcomeId ? '🏆' : '•';
      lines.push(`${marker} **${o.title || o.id || '?'}** — ${points.toLocaleString()} pts (${users} users)`);
    }
  }
  return {
    color: EVENT_COLORS.predictionResult,
    title: '🔮 Prediction ended — ' + (title || 'untitled'),
    description: lines.join('\n') || '(no outcomes?)',
    timestamp: new Date().toISOString(),
    footer: status ? { text: 'Status: ' + status } : undefined,
  };
}

export function banEmbed({ userName, userLogin, modName, reason, isPermanent, endsAt }) {
  const lines = [`**${userName || userLogin || '?'}** ${isPermanent ? 'banned' : 'timed out'} by **${modName || 'moderator'}**`];
  if (reason) lines.push(`Reason: ${String(reason).slice(0, 300)}`);
  if (!isPermanent && endsAt) lines.push(`Ends <t:${asUnix(endsAt)}:R>`);
  return {
    color: EVENT_COLORS.ban,
    title: isPermanent ? '🔨 User banned' : '⏱️ User timed out',
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
  };
}

export function unbanEmbed({ userName, userLogin, modName }) {
  return {
    color: EVENT_COLORS.unban,
    title: '✅ User unbanned',
    description: `**${userName || userLogin || '?'}** unbanned by **${modName || 'moderator'}**`,
    timestamp: new Date().toISOString(),
  };
}

// ── Notification handlers ────────────────────────────────────────
//
// Each handler is called by twitch-eventsub.js dispatch with the
// full EventSub payload + a guildId hint (we resolve to
// env.AQUILO_VAULT_GUILD_ID by default). Pure side-effect: build
// embed + post. Errors are swallowed into the return shape so the
// EventSub webhook can ack 2xx regardless.

function defaultGuildId(env) {
  return env.AQUILO_VAULT_GUILD_ID || null;
}

export async function handleFollow(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const total = await incrementCounter(env, 'follows', gid);
  const embed = followEmbed({
    userName:  ev.user_name,
    userLogin: ev.user_login,
    followedAt: ev.followed_at,
  }, total);
  return await dispatchEmbed(env, gid, 'follow', embed);
}

export async function handleSubscribe(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  // Skip gift recipient subs — those are part of the gift event's
  // headline and we don't want to double-post.
  if (ev.is_gift === true) return { skipped: 'gift-recipient' };
  const total = await incrementCounter(env, 'subs', gid);
  const embed = subEmbed({
    userName:  ev.user_name,
    userLogin: ev.user_login,
    tier:      ev.tier,
    isGift:    !!ev.is_gift,
  }, total);
  return await dispatchEmbed(env, gid, 'sub', embed);
}

export async function handleSubscriptionMessage(env, payload) {
  // The "resub with message" event — fires when an existing
  // subscriber renews + posts a chat message.
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const total = await incrementCounter(env, 'subs', gid);
  const embed = resubEmbed({
    userName:         ev.user_name,
    userLogin:        ev.user_login,
    tier:             ev.tier,
    cumulativeMonths: ev.cumulative_months,
    streakMonths:     ev.streak_months,
    durationMonths:   ev.duration_months,
    message:          ev.message?.text,
  }, total);
  return await dispatchEmbed(env, gid, 'resub', embed);
}

export async function handleSubscriptionGift(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  // Bump the sub counter by `total` for community-gift accuracy.
  let totalSubsCounter = null;
  try {
    const cur = parseInt(await env.LOADOUT_BOLTS.get(COUNTER_KEY('subs', gid)) || '0', 10) || 0;
    totalSubsCounter = cur + (Number(ev.total) || 1);
    await env.LOADOUT_BOLTS.put(COUNTER_KEY('subs', gid), String(totalSubsCounter));
  } catch { /* ignore */ }
  const embed = giftSubEmbed({
    gifterName:       ev.user_name,
    gifterLogin:      ev.user_login,
    tier:             ev.tier,
    total:            Number(ev.total) || 1,
    cumulativeTotal:  ev.cumulative_total,
    isAnon:           !!ev.is_anonymous,
  });
  return await dispatchEmbed(env, gid, 'gift', embed);
}

export async function handleCheer(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = cheerEmbed({
    userName:  ev.user_name,
    userLogin: ev.user_login,
    bits:      ev.bits,
    message:   ev.message,
    isAnon:    !!ev.is_anonymous,
  });
  return await dispatchEmbed(env, gid, 'cheer', embed);
}

export async function handleRaid(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = raidEmbed({
    fromBroadcasterName:  ev.from_broadcaster_user_name,
    fromBroadcasterLogin: ev.from_broadcaster_user_login,
    viewers:              ev.viewers,
  });
  // Mention Stream Pings role if KV-bound (twitch-event:ping-role).
  let mentionRoleId = null;
  try {
    mentionRoleId = await env.LOADOUT_BOLTS.get('twitch-event:ping-role') || null;
  } catch { /* ignore */ }
  return await dispatchEmbed(env, gid, 'raid', embed, {
    content: mentionRoleId ? `<@&${mentionRoleId}> raid incoming!` : undefined,
    mentionRoleId,
  });
}

// Posts the BIG going-live announcement to the live-now channel.
// Called from twitch-eventsub.js stream.online dispatch ALONGSIDE
// twitch-live.js's postLiveEmbed (which still owns the edit-in-place
// status card on the existing `live` binding).
export async function handleStreamLiveAnnounce(env, payload, helixFns) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const broadcasterId = ev.broadcaster_user_id;
  if (!broadcasterId) return { skipped: 'no-broadcaster-id' };
  // helixFns supplied by caller so this module stays test-friendly.
  const stream = await helixFns.getStreamInfo(env, broadcasterId).catch(() => null);
  const user   = await helixFns.getUserById(env, broadcasterId).catch(() => null);
  const login  = user?.login || stream?.user_login || ev.broadcaster_user_login || null;
  const embed = streamLiveAnnounceEmbed({
    user,
    login,
    title:     stream?.title || ev.title,
    gameName:  stream?.game_name || ev.category_name,
    startedAt: stream?.started_at || ev.started_at,
  });
  let mentionRoleId = null;
  try {
    mentionRoleId = await env.LOADOUT_BOLTS.get('twitch-event:ping-role') || null;
  } catch { /* ignore */ }
  return await dispatchEmbed(env, gid, 'live', embed, {
    content: mentionRoleId ? `<@&${mentionRoleId}> LIVE NOW!` : undefined,
    mentionRoleId,
  });
}

// End-of-stream summary embed. Reads cumulative counters for the
// summary and resets them so the next stream starts fresh.
export async function handleStreamEndedSummary(env, payload, helixFns, lifecycleState) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const broadcasterId = ev.broadcaster_user_id;
  const user  = broadcasterId ? await helixFns.getUserById(env, broadcasterId).catch(() => null) : null;
  const totalFollows = await getCounter(env, 'follows', gid);
  const totalSubs    = await getCounter(env, 'subs', gid);
  const embed = streamEndedSummaryEmbed({
    user,
    login:           user?.login || lifecycleState?.login || null,
    startedAt:       lifecycleState?.startedAt || null,
    lastTitle:       lifecycleState?.lastTitle || null,
    lastGame:        lifecycleState?.lastGame  || null,
    lastPeakViewers: lifecycleState?.lastPeakViewers || null,
    totalFollows,
    totalSubs,
  });
  const r = await dispatchEmbed(env, gid, 'ended', embed);
  // Reset counters for the next stream regardless of post result.
  try {
    await env.LOADOUT_BOLTS.delete(COUNTER_KEY('follows', gid));
    await env.LOADOUT_BOLTS.delete(COUNTER_KEY('subs', gid));
  } catch { /* ignore */ }
  return r;
}

export async function handleChannelPointRedemption(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = redemptionEmbed({
    userName:    ev.user_name,
    userLogin:   ev.user_login,
    rewardTitle: ev.reward?.title,
    rewardCost:  ev.reward?.cost,
    userInput:   ev.user_input,
  });
  return await dispatchEmbed(env, gid, 'redemption', embed);
}

export async function handleHypeTrainBegin(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = hypeTrainBeginEmbed({
    level:     ev.level,
    total:     ev.total,
    goal:      ev.goal,
    expiresAt: ev.expires_at,
  });
  return await dispatchEmbed(env, gid, 'hypeTrainBegin', embed);
}

export async function handleHypeTrainProgress(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const last = ev.last_contribution || {};
  const embed = hypeTrainProgressEmbed({
    level:             ev.level,
    total:             ev.total,
    goal:              ev.goal,
    lastContribUser:   last.user_name || last.user_login,
    lastContribType:   last.type,
    lastContribTotal:  last.total,
    expiresAt:         ev.expires_at,
  });
  return await dispatchEmbed(env, gid, 'hypeTrainProgress', embed);
}

export async function handleHypeTrainEnd(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = hypeTrainEndEmbed({
    level:            ev.level,
    total:            ev.total,
    topContributions: ev.top_contributions,
  });
  return await dispatchEmbed(env, gid, 'hypeTrainEnd', embed);
}

export async function handlePollBegin(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = pollBeginEmbed({
    title:   ev.title,
    choices: ev.choices,
    endsAt:  ev.ends_at,
  });
  return await dispatchEmbed(env, gid, 'pollBegin', embed);
}

export async function handlePollEnd(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = pollEndEmbed({
    title:   ev.title,
    status:  ev.status,
    choices: ev.choices,
  });
  return await dispatchEmbed(env, gid, 'pollEnd', embed);
}

export async function handlePredictionBegin(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = predictionBeginEmbed({
    title:    ev.title,
    outcomes: ev.outcomes,
    endsAt:   ev.locks_at,
  });
  return await dispatchEmbed(env, gid, 'predictionBegin', embed);
}

export async function handlePredictionEnd(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = predictionEndEmbed({
    title:             ev.title,
    status:            ev.status,
    outcomes:          ev.outcomes,
    winningOutcomeId:  ev.winning_outcome_id,
  });
  return await dispatchEmbed(env, gid, 'predictionEnd', embed);
}

export async function handleBan(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = banEmbed({
    userName:    ev.user_name,
    userLogin:   ev.user_login,
    modName:     ev.moderator_user_name,
    reason:      ev.reason,
    isPermanent: !!ev.is_permanent,
    endsAt:      ev.ends_at,
  });
  return await dispatchEmbed(env, gid, 'ban', embed);
}

export async function handleUnban(env, payload) {
  const ev = payload?.event || {};
  const gid = defaultGuildId(env);
  if (!gid) return { skipped: 'no-guild' };
  const embed = unbanEmbed({
    userName:  ev.user_name,
    userLogin: ev.user_login,
    modName:   ev.moderator_user_name,
  });
  return await dispatchEmbed(env, gid, 'unban', embed);
}

// Convenience export — dispatch table keyed by Twitch subscription.type
// value. twitch-eventsub.js uses this to route incoming notifications
// without one giant switch.
export const EVENT_TYPE_HANDLERS = Object.freeze({
  'channel.follow':                                           handleFollow,
  'channel.subscribe':                                        handleSubscribe,
  'channel.subscription.message':                             handleSubscriptionMessage,
  'channel.subscription.gift':                                handleSubscriptionGift,
  'channel.cheer':                                            handleCheer,
  'channel.raid':                                             handleRaid,
  // stream.online/.offline are dispatched specially in eventsub.js
  // because they also drive the twitch-live.js lifecycle. The
  // big announce embed is appended after the lifecycle call.
  'channel.channel_points_custom_reward_redemption.add':      handleChannelPointRedemption,
  'channel.hype_train.begin':                                 handleHypeTrainBegin,
  'channel.hype_train.progress':                              handleHypeTrainProgress,
  'channel.hype_train.end':                                   handleHypeTrainEnd,
  'channel.poll.begin':                                       handlePollBegin,
  'channel.poll.end':                                         handlePollEnd,
  'channel.prediction.begin':                                 handlePredictionBegin,
  'channel.prediction.end':                                   handlePredictionEnd,
  'channel.ban':                                              handleBan,
  'channel.unban':                                            handleUnban,
});

// ── Admin: list + set + toggle ────────────────────────────────────
//
// Used by both the slash command handlers AND the optional HMAC
// /admin/twitch-event/* HTTP routes (if Clay wires those — slash is
// the primary surface).
export async function listEventRoutes(env, guildId) {
  const out = [];
  for (const t of EVENT_TYPES) {
    const override = await env.LOADOUT_BOLTS.get(CHANNEL_OVERRIDE_KEY(t)).catch(() => null);
    const resolved = await resolveEventChannel(env, guildId, t);
    const toggle   = await env.LOADOUT_BOLTS.get(TOGGLE_KEY(t)).catch(() => null);
    out.push({
      eventType: t,
      override:  override || null,
      resolved:  resolved || null,
      enabled:   !toggle || String(toggle).toLowerCase() !== 'off',
    });
  }
  return out;
}

export async function setEventChannel(env, eventType, channelId) {
  if (!isValidEventType(eventType)) return { ok: false, error: 'unknown-event-type' };
  const raw = String(channelId || '').trim();
  if (raw === '') {
    await env.LOADOUT_BOLTS.delete(CHANNEL_OVERRIDE_KEY(eventType)).catch(() => {});
    return { ok: true, eventType, override: null, cleared: true };
  }
  if (!/^\d{15,25}$/.test(raw)) return { ok: false, error: 'bad-channel-id' };
  await env.LOADOUT_BOLTS.put(CHANNEL_OVERRIDE_KEY(eventType), raw);
  return { ok: true, eventType, override: raw };
}

export async function setEventToggle(env, eventType, enabled) {
  if (!isValidEventType(eventType)) return { ok: false, error: 'unknown-event-type' };
  if (enabled) {
    await env.LOADOUT_BOLTS.delete(TOGGLE_KEY(eventType)).catch(() => {});
  } else {
    await env.LOADOUT_BOLTS.put(TOGGLE_KEY(eventType), 'off');
  }
  return { ok: true, eventType, enabled };
}

// Test-only exports for the harness.
export const _testHelpers = {
  CHANNEL_OVERRIDE_KEY,
  TOGGLE_KEY,
  COUNTER_KEY,
};
