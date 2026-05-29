// Unified voting hub — variety night + community night, separate
// events sharing ONE channel + ONE persistent embed. Replaces the
// old cn-vote-hub.js (which only handled CN and lived in the CN
// queue channel).
//
// State machine, transitioned by the existing :23 hourly cron:
//
//   closed            no active vote. Embed shows "Next vote opens
//                       at 6 PM ET on <next event date>". No buttons
//                       that take a vote action — instead a
//                       Patreon CTA + boost prompt.
//
//   variety-open      variety vote active (between 18:00 ET and
//                       21:00 ET on varietyWeekday). Game buttons
//                       active. One vote per user per event.
//
//   variety-closed    variety vote ended. Embed shows winner +
//                       hangs out until the next phase opens.
//
//   cn-open           CN vote active (between 18:00 ET and 21:00 ET
//                       on cnWeekday). Same UX as variety-open but
//                       a distinct DB poll row.
//
//   cn-closed         CN vote ended, winner announced.
//
//   cn-queue          CN queue open (post 9 PM Saturday). Same
//                       Join button as the existing queue logic
//                       (re-emits `queue:join` via aq-queue.js).
//
// KV layout:
//   vote-hub:msg:<g>     { channelId, messageId, postedAt }
//   vote-hub:state:<g>   { phase, varietyPollId?, cnPollId?,
//                          lastTransitionUtc }
//   vote-hub:config:<g>  { varietyWeekday, cnWeekday }
//                          defaults: variety=null (not scheduled),
//                          cn='saturday'

import { getChannelBinding } from './channel-bindings.js';
import { getBranding } from './branding.js';
import { getETInfo } from './aquilo/util.js';

const HUB_MSG_KEY    = (g) => `vote-hub:msg:${g}`;
const HUB_STATE_KEY  = (g) => `vote-hub:state:${g}`;
const HUB_CONFIG_KEY = (g) => `vote-hub:config:${g}`;
const HUB_VOTES_KEY  = (g, eventKey) => `vote-hub:votes:${g}:${eventKey}`;

const RESP_CHAT          = 4;
const FLAG_EPHEMERAL     = 64;
const COMPONENT_ROW      = 1;
const COMPONENT_BUTTON   = 2;
const BTN_PRIMARY        = 1;
const BTN_SECONDARY      = 2;
const BTN_SUCCESS        = 3;
const BTN_LINK           = 5;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Phase constants — exported so the cron + tests can reference them
// without string drift.
export const PHASE = Object.freeze({
  CLOSED:         'closed',
  VARIETY_OPEN:   'variety-open',
  VARIETY_CLOSED: 'variety-closed',
  CN_OPEN:        'cn-open',
  CN_CLOSED:      'cn-closed',
  CN_QUEUE:       'cn-queue',
});

// ── Config ──────────────────────────────────────────────────────

export async function getConfig(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get(HUB_CONFIG_KEY(guildId), { type: 'json' });
  // v2 schedule (May 2026): Variety is STATIC (no vote — Wed + Fri
  // are streamer's pick), CN is the only voted event. The CN vote
  // window now spans multiple days, so the open/close points are
  // each their own weekday+hour. Queue opens on its own
  // weekday+hour after the vote closes.
  return {
    // Legacy field — kept on the record but no longer drives any
    // transition (variety is static now). Setting it back to a
    // weekday is a no-op until tickPhaseTransition's variety branch
    // is reinstated.
    varietyWeekday: raw?.varietyWeekday || null,

    // CN voting window — multi-day allowed.
    cnVoteOpenWeekday:   raw?.cnVoteOpenWeekday   || 'wednesday',
    cnVoteOpenHourEt:    Number.isInteger(raw?.cnVoteOpenHourEt)
                            ? raw.cnVoteOpenHourEt : 12,
    cnVoteCloseWeekday:  raw?.cnVoteCloseWeekday  || 'friday',
    cnVoteCloseHourEt:   Number.isInteger(raw?.cnVoteCloseHourEt)
                            ? raw.cnVoteCloseHourEt : 23,
    // CN queue opens its own day/hour, separate from the vote close.
    cnQueueOpenWeekday:  raw?.cnQueueOpenWeekday  || 'saturday',
    cnQueueOpenHourEt:   Number.isInteger(raw?.cnQueueOpenHourEt)
                            ? raw.cnQueueOpenHourEt : 12,

    // Legacy single-window fields — preserved for back-compat with
    // any caller that still reads them. Default-aligned to the new
    // CN values but tickPhaseTransition no longer uses them.
    cnWeekday:      raw?.cnWeekday      || raw?.cnVoteOpenWeekday || 'wednesday',
    openHourEt:     Number.isInteger(raw?.openHourEt)  ? raw.openHourEt  : 12,
    closeHourEt:    Number.isInteger(raw?.closeHourEt) ? raw.closeHourEt : 23,
  };
}

// "Minute of week" — 0 at Sunday 00:00 ET, max 10079 at Sat 23:59 ET.
// Used by the multi-day window check below.
function minuteOfWeek(weekday, hourEt) {
  return DAY_NAMES.indexOf(String(weekday).toLowerCase()) * 1440 + hourEt * 60;
}
// Is the current ET clock within [openWd openHr, closeWd closeHr)?
// Wraps around the week boundary if needed.
function isInWindow(et, openWd, openHr, closeWd, closeHr) {
  const now   = minuteOfWeek(et.weekday, et.hour);
  const open  = minuteOfWeek(openWd, openHr);
  const close = minuteOfWeek(closeWd, closeHr);
  if (open === close) return false;
  if (open < close)  return now >= open && now < close;
  // Wrap: e.g. Sat-noon open → Tue-noon close
  return now >= open || now < close;
}

export async function setConfig(env, guildId, patch) {
  const cur = await getConfig(env, guildId);
  const next = { ...cur };
  if (patch.varietyWeekday !== undefined) {
    const v = patch.varietyWeekday;
    if (v === null || v === '') next.varietyWeekday = null;
    else if (DAY_NAMES.includes(String(v).toLowerCase())) next.varietyWeekday = String(v).toLowerCase();
    else return { ok: false, error: 'bad-varietyWeekday' };
  }
  if (patch.cnWeekday !== undefined) {
    const v = String(patch.cnWeekday).toLowerCase();
    if (!DAY_NAMES.includes(v)) return { ok: false, error: 'bad-cnWeekday' };
    next.cnWeekday = v;
  }
  if (patch.openHourEt  !== undefined) next.openHourEt  = Math.max(0, Math.min(23, Number(patch.openHourEt) || 18));
  if (patch.closeHourEt !== undefined) next.closeHourEt = Math.max(0, Math.min(23, Number(patch.closeHourEt) || 21));
  // v2 CN window fields — multi-day voting + separate queue open.
  for (const [src, dst] of [
    ['cnVoteOpenWeekday',  'cnVoteOpenWeekday'],
    ['cnVoteCloseWeekday', 'cnVoteCloseWeekday'],
    ['cnQueueOpenWeekday', 'cnQueueOpenWeekday'],
  ]) {
    if (patch[src] !== undefined) {
      const v = String(patch[src]).toLowerCase();
      if (!DAY_NAMES.includes(v)) return { ok: false, error: 'bad-' + src };
      next[dst] = v;
    }
  }
  for (const k of ['cnVoteOpenHourEt', 'cnVoteCloseHourEt', 'cnQueueOpenHourEt']) {
    if (patch[k] !== undefined) {
      next[k] = Math.max(0, Math.min(23, Number(patch[k]) || 12));
    }
  }
  await env.LOADOUT_BOLTS.put(HUB_CONFIG_KEY(guildId), JSON.stringify(next));
  return { ok: true, config: next };
}

// ── State ───────────────────────────────────────────────────────

export async function getState(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get(HUB_STATE_KEY(guildId), { type: 'json' });
  return {
    phase: raw?.phase || PHASE.CLOSED,
    varietyPollId: raw?.varietyPollId || null,
    cnPollId:      raw?.cnPollId      || null,
    lastTransitionUtc: raw?.lastTransitionUtc || 0,
  };
}

async function putState(env, guildId, state) {
  await env.LOADOUT_BOLTS.put(HUB_STATE_KEY(guildId), JSON.stringify(state));
}

// ── Date math ────────────────────────────────────────────────────
//
// Pure-ish — works in any timezone the cron observes. Returns the
// next event date (YYYY-MM-DD in ET) for the given weekday name.
// `nowEt` is { weekday, year, month, day, hour } from getETInfo.
//
// Examples:
//   nowEt = {weekday: 'tuesday', ...}, target = 'saturday' → 4 days out
//   nowEt = {weekday: 'saturday', hour: 12, ...}, target = 'saturday' → 0 days (today, vote opens 18:00 ET)
//   nowEt = {weekday: 'saturday', hour: 22, ...}, target = 'saturday' → 7 days (already past the close window)

function daysUntilWeekday(currentWeekday, targetWeekday) {
  const cur = DAY_NAMES.indexOf(currentWeekday);
  const tgt = DAY_NAMES.indexOf(targetWeekday);
  if (cur < 0 || tgt < 0) return null;
  let d = (tgt - cur + 7) % 7;
  return d;
}

// Build a "next event Date" Date object (UTC) for the given target
// weekday + ET hour, anchored to `nowMs`. Useful for the embed's
// "Voting opens <relative timestamp>" copy.
export function nextEventTimestamp(nowMs, targetWeekday, hourEt) {
  if (!targetWeekday) return null;
  const nowEt = getETInfo(new Date(nowMs));
  let days = daysUntilWeekday(nowEt.weekday, targetWeekday);
  if (days === null) return null;
  // If it's the target weekday but already past openHourEt + close
  // window, advance a week.
  if (days === 0 && nowEt.hour >= 22) days = 7;
  // Build a Date for (today + days) at hourEt ET. Convert ET → UTC
  // via the offset — getETInfo gives us the ET clock but not the
  // offset, so re-derive via Intl.
  const dt = new Date(nowMs + days * 86_400_000);
  // Pin the hour by ET: re-compute UTC = ET + (offset). Use a
  // formatter to confirm the resulting hour is correct.
  // Simplification: jump to dt's UTC date at hourEt + estimated
  // offset (4h EDT, 5h EST). We only need this for relative
  // timestamps in the embed, not for actual cron firing.
  const y  = dt.getUTCFullYear();
  const m  = dt.getUTCMonth();
  const dd = dt.getUTCDate();
  // Estimate ET-UTC offset by looking at nowEt vs new Date(nowMs).
  const realEtHour = nowEt.hour;
  const utcHour    = new Date(nowMs).getUTCHours();
  let etOffsetHours = utcHour - realEtHour;
  if (etOffsetHours < 0) etOffsetHours += 24;
  const targetUtc = Date.UTC(y, m, dd, hourEt + etOffsetHours, 0, 0);
  return targetUtc;
}

// ── Embed builder per phase ──────────────────────────────────────

async function buildPhaseEmbed(env, guildId, state, config) {
  const brand = await getBranding(env, guildId);
  const accent = brand.accentColor || 0x9147ff;

  // Schedule v2: variety is STATIC (Wed + Fri), no vote. CN is the
  // only voted event, with its own multi-day window.
  const nowMs = Date.now();
  const tsCnOpen  = nextEventTimestamp(nowMs, config.cnVoteOpenWeekday,  config.cnVoteOpenHourEt);
  const tsCnClose = nextEventTimestamp(nowMs, config.cnVoteCloseWeekday, config.cnVoteCloseHourEt);
  const tsCnQueue = nextEventTimestamp(nowMs, config.cnQueueOpenWeekday, config.cnQueueOpenHourEt);
  const tFmt = (ms, fmt) => ms ? `<t:${Math.floor(ms / 1000)}:${fmt}>` : null;

  if (state.phase === PHASE.CLOSED) {
    const lines = [];
    if (tsCnOpen)  lines.push(`🗳️ Voting opens ${tFmt(tsCnOpen, 'F')} (${tFmt(tsCnOpen, 'R')})`);
    if (tsCnClose) lines.push(`🏁 Voting closes ${tFmt(tsCnClose, 'F')} (${tFmt(tsCnClose, 'R')})`);
    if (tsCnQueue) lines.push(`🎮 Saturday Community Night queue opens ${tFmt(tsCnQueue, 'F')}`);
    if (lines.length === 0) lines.push('_No events scheduled. Ask a mod to set the weekdays via /admin/vote-hub/config._');
    return {
      embed: {
        title: '🗳️ Voting',
        description:
          lines.join('\n') +
          '\n\n_While voting is closed, support the community to unlock **priority CN queue access**:_',
        color: accent,
        footer: { text: 'One vote per user per event. Votes can be changed until the poll closes.' },
      },
      components: [{
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Become a Patron',
            url: brand.siteUrl ? `${brand.siteUrl}/patreon` : 'https://www.patreon.com/cw/aquilo/membership' },
          { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'How to boost the server',
            url: 'https://support.discord.com/hc/en-us/articles/360028038352' },
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My status', custom_id: 'vh:status' },
        ],
      }],
    };
  }

  if (state.phase === PHASE.VARIETY_OPEN || state.phase === PHASE.CN_OPEN) {
    const kind = state.phase === PHASE.VARIETY_OPEN ? 'variety' : 'cn';
    const label = kind === 'variety' ? '🎲 Variety night' : '🏆 Community night';
    const lines = [`Tap **Vote** to pick this week's game. You can change your vote until polls close.`];
    if (tsCnClose) lines.push('', `🏁 Voting closes ${tFmt(tsCnClose, 'F')} (${tFmt(tsCnClose, 'R')})`);
    if (tsCnQueue) lines.push(`🎮 Saturday queue opens ${tFmt(tsCnQueue, 'F')}`);
    return {
      embed: {
        title: `🗳️ ${label} · voting open`,
        description: lines.join('\n'),
        color: accent,
      },
      components: [{
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Vote',           custom_id: `vh:vote:${kind}` },
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Live standings', custom_id: `vh:standings:${kind}` },
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My status',      custom_id: 'vh:status' },
        ],
      }],
    };
  }

  if (state.phase === PHASE.VARIETY_CLOSED || state.phase === PHASE.CN_CLOSED) {
    const kind = state.phase === PHASE.VARIETY_CLOSED ? 'variety' : 'cn';
    const label = kind === 'variety' ? '🎲 Variety night' : '🏆 Community night';
    const winner = await getStoredWinner(env, guildId, kind);
    const lines = [
      winner
        ? `**Winner:** ${winner.name}${winner.votes ? ` (${winner.votes} vote${winner.votes === 1 ? '' : 's'})` : ''}`
        : '_Votes are in — winner being tallied._',
    ];
    if (tsCnQueue) lines.push('', `🎮 Saturday queue opens ${tFmt(tsCnQueue, 'F')} (${tFmt(tsCnQueue, 'R')})`);
    const embed = {
      title: `🗳️ ${label} · voting closed`,
      description: lines.join('\n'),
      color: accent,
    };
    if (winner?.art_url) embed.image = { url: winner.art_url };
    return {
      embed,
      components: [{
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Final standings', custom_id: `vh:standings:${kind}` },
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My status',       custom_id: 'vh:status' },
        ],
      }],
    };
  }

  if (state.phase === PHASE.CN_QUEUE) {
    const winner = await getStoredWinner(env, guildId, 'cn');
    const desc = winner
      ? `**Tonight's game:** ${winner.name}\n\nTap **Join queue** to lock your slot.`
      : 'Tap **Join queue** to lock your slot for tonight\'s stream.';
    const embed = {
      title: '🏆 Community night · queue open',
      description: desc,
      color: accent,
    };
    if (winner?.art_url) embed.image = { url: winner.art_url };
    return {
      embed,
      components: [{
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_SUCCESS,   label: 'Join queue', custom_id: 'vh:queue-join' },
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My status',  custom_id: 'vh:status' },
        ],
      }],
    };
  }

  // Defensive fallback.
  return {
    embed: { title: '🗳️ Voting', description: `_Unknown phase: ${state.phase}_`, color: accent },
    components: [],
  };
}

// ── Winners storage ──────────────────────────────────────────────
//
// When a vote closes, we store { name, art_url, votes } so the
// post-vote embed can show the winner without re-tallying.

async function getStoredWinner(env, guildId, kind) {
  return env.LOADOUT_BOLTS.get(`vote-hub:winner:${guildId}:${kind}`, { type: 'json' });
}
async function putStoredWinner(env, guildId, kind, winner) {
  await env.LOADOUT_BOLTS.put(`vote-hub:winner:${guildId}:${kind}`, JSON.stringify(winner));
}

// ── Vote tallying ───────────────────────────────────────────────
//
// Per-event votes live in KV at vote-hub:votes:<g>:<eventKey>. One
// JSON object: { [userId]: gameId }. Eventkey is "variety:<week>"
// or "cn:<week>" so a fresh week always starts a fresh ballot.

function weekStampEt() {
  // Calendar week stamp in ET — used as the eventKey suffix so a
  // new week's vote doesn't carry over the previous week's ballots.
  const et = getETInfo(new Date());
  return `${et.year}-${String(et.month).padStart(2, '0')}-${String(et.day).padStart(2, '0')}`;
}

function eventKeyFor(kind) {
  return `${kind}:${weekStampEt()}`;
}

async function readBallots(env, guildId, eventKey) {
  const raw = await env.LOADOUT_BOLTS.get(HUB_VOTES_KEY(guildId, eventKey), { type: 'json' });
  return raw && typeof raw === 'object' ? raw : {};
}
async function writeBallots(env, guildId, eventKey, ballots) {
  await env.LOADOUT_BOLTS.put(HUB_VOTES_KEY(guildId, eventKey), JSON.stringify(ballots));
}

// ── Game list (CN-eligible pool) ────────────────────────────────

async function getEligibleGames(env, guildId) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, name, art_url FROM games WHERE guild_id = ? AND active = 1 ORDER BY name ASC`,
  ).bind(guildId).all();
  return results || [];
}

// ── Public lifecycle ────────────────────────────────────────────

export async function postOrRefreshHub(env, guildId, channelId) {
  if (!channelId) return { ok: false, error: 'no-channel-id' };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const state = await getState(env, guildId);
  const config = await getConfig(env, guildId);
  const built = await buildPhaseEmbed(env, guildId, state, config);

  // Try edit-in-place first if a prior hub message exists.
  const prior = await env.LOADOUT_BOLTS.get(HUB_MSG_KEY(guildId), { type: 'json' });
  if (prior?.channelId === channelId && prior?.messageId) {
    const r = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${prior.messageId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
          'User-Agent':   'loadout-discord vote-hub',
        },
        body: JSON.stringify({ embeds: [built.embed], components: built.components }),
      },
    );
    if (r.ok) return { ok: true, channelId, messageId: prior.messageId, action: 'edited' };
    // Message gone — fall through to fresh post.
  }
  // Delete any prior in a different channel.
  if (prior?.channelId && prior?.messageId && prior.channelId !== channelId) {
    try {
      await fetch(`https://discord.com/api/v10/channels/${prior.channelId}/messages/${prior.messageId}`,
        { method: 'DELETE', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord vote-hub' } });
    } catch { /* idle */ }
  }
  const post = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord vote-hub',
    },
    body: JSON.stringify({ embeds: [built.embed], components: built.components, allowed_mentions: { parse: [] } }),
  });
  if (!post.ok) return { ok: false, error: 'post-failed', status: post.status, body: (await post.text()).slice(0, 200) };
  const j = await post.json();
  await env.LOADOUT_BOLTS.put(HUB_MSG_KEY(guildId),
    JSON.stringify({ channelId, messageId: j.id, postedAt: Date.now() }));
  return { ok: true, channelId, messageId: j.id, action: 'posted' };
}

// Admin HTTP entry — resolves channel via opts → vote binding.
export async function postVoteHubForGuild(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  let channelId = opts.channelId;
  if (!channelId) {
    channelId = await getChannelBinding(env, guildId, 'vote');
    if (!channelId) {
      return { ok: false, error: 'no-vote-channel', message: 'Set the vote binding first via /admin/channels/bind { binding: "vote", channelId: "..." }.' };
    }
  }
  return postOrRefreshHub(env, guildId, channelId);
}

// ── Cron transitions ────────────────────────────────────────────
//
// Called from the existing :23 hourly tick. Computes the right
// phase for "now" given the config, transitions if changed, and
// re-renders the hub embed via postOrRefreshHub.
//
// Transitions:
//   On varietyWeekday at openHourEt ET  → variety-open
//   On varietyWeekday at closeHourEt ET → variety-closed (tally winner)
//   On varietyWeekday at closeHourEt+3 → closed
//   On cnWeekday at openHourEt ET       → cn-open
//   On cnWeekday at closeHourEt ET      → cn-closed (tally winner) → cn-queue
//   On cnWeekday at closeHourEt+3 → closed (queue stays open via the
//                                              existing queue mechanism)

export async function tickPhaseTransition(env, guildId) {
  const config = await getConfig(env, guildId);
  const state  = await getState(env, guildId);
  const et = getETInfo(new Date());

  // v2 schedule (May 2026):
  //   • Variety Night = static (Wed + Fri) — no vote, no phase
  //   • CN voting window = cnVoteOpen → cnVoteClose (Wed noon ET
  //     → Fri 23:00 ET in current config)
  //   • CN_CLOSED = 1-hour announce window right at vote close
  //   • CN_QUEUE  = from cnQueueOpen onwards (Sat noon ET) until
  //     the next CN vote-open boundary wraps around
  let desired = PHASE.CLOSED;
  const inVote = isInWindow(et,
    config.cnVoteOpenWeekday,  config.cnVoteOpenHourEt,
    config.cnVoteCloseWeekday, config.cnVoteCloseHourEt);
  // 1-hour close window right after the vote closes.
  const inClose = isInWindow(et,
    config.cnVoteCloseWeekday, config.cnVoteCloseHourEt,
    config.cnVoteCloseWeekday, (config.cnVoteCloseHourEt + 1) % 24);
  // Queue window: from queue-open until the next vote-open wraps.
  const inQueue = isInWindow(et,
    config.cnQueueOpenWeekday, config.cnQueueOpenHourEt,
    config.cnVoteOpenWeekday,  config.cnVoteOpenHourEt);

  if (inVote)        desired = PHASE.CN_OPEN;
  else if (inClose)  desired = PHASE.CN_CLOSED;
  else if (inQueue)  desired = PHASE.CN_QUEUE;
  if (desired === state.phase) {
    // Same phase — no-op (saves a Discord edit).
    return { phase: state.phase, transitioned: false };
  }
  // Phase changing — tally winner on close transitions.
  if (desired === PHASE.CN_CLOSED && state.phase === PHASE.CN_OPEN) {
    const winner = await tallyAndStoreWinner(env, guildId, 'cn');
    state.cnPollId = winner?.gameId || null;
  }
  state.phase = desired;
  state.lastTransitionUtc = Date.now();
  await putState(env, guildId, state);
  // Re-render the hub.
  const channelId = await getChannelBinding(env, guildId, 'vote');
  if (channelId) await postOrRefreshHub(env, guildId, channelId);
  return { phase: desired, transitioned: true };
}

async function tallyAndStoreWinner(env, guildId, kind) {
  const eventKey = eventKeyFor(kind);
  const ballots = await readBallots(env, guildId, eventKey);
  if (!ballots || Object.keys(ballots).length === 0) {
    return null;
  }
  const counts = {};
  for (const gid of Object.values(ballots)) counts[gid] = (counts[gid] || 0) + 1;
  let topId = null, topCount = 0;
  for (const [gid, c] of Object.entries(counts)) {
    if (c > topCount) { topId = gid; topCount = c; }
  }
  if (!topId) return null;
  // Look up the game's name + art.
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT id, name, art_url FROM games WHERE id = ?`,
  ).bind(topId).first();
  if (!row) return null;
  const winner = { gameId: row.id, name: row.name, art_url: row.art_url, votes: topCount };
  await putStoredWinner(env, guildId, kind, winner);
  return winner;
}

// ── Component handlers (vh:*) ───────────────────────────────────

const eph = (content) => ({ type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } });

export async function handleVoteHubComponent(env, data) {
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return eph('Run this in a server.');
  const cid = data.data?.custom_id || '';
  const parts = cid.split(':');
  const action = parts[1];

  const state = await getState(env, guildId);
  const config = await getConfig(env, guildId);

  // Patreon-CTA in closed phase intercept ANY action that's not status
  // (so a stray click on a stale button doesn't accidentally re-enable
  // voting). 'vh:status' is always allowed.
  if (state.phase === PHASE.CLOSED && action !== 'status') {
    const nowMs = Date.now();
    const variety = config.varietyWeekday
      ? nextEventTimestamp(nowMs, config.varietyWeekday, config.openHourEt) : null;
    const cn = config.cnWeekday
      ? nextEventTimestamp(nowMs, config.cnWeekday, config.openHourEt) : null;
    const nextLine =
      (variety && cn) ? `Next vote: ${variety < cn ? 'variety' : 'cn'} <t:${Math.floor(Math.min(variety, cn) / 1000)}:R>`
      : (variety) ? `Next variety vote <t:${Math.floor(variety / 1000)}:R>`
      : (cn)      ? `Next CN vote <t:${Math.floor(cn / 1000)}:R>`
      : '_No events scheduled._';
    const brand = await getBranding(env, guildId);
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🔒 Voting is closed',
          description:
            nextLine + '\n\n' +
            `Boost the community while you wait:\n` +
            `• 💎 **Patron** — priority CN queue access + bolts perks\n` +
            `• 🚀 **Server boost** — also unlocks priority queue access`,
          color: 0xe6c474,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Become a Patron',
              url: env.PATREON_URL || (brand.siteUrl ? `${brand.siteUrl}/patreon` : 'https://www.patreon.com/cw/aquilo/membership') },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'How to boost the server',
              url: 'https://support.discord.com/hc/en-us/articles/360028038352' },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }

  if (action === 'vote') {
    const kind = parts[2];
    if (kind !== 'variety' && kind !== 'cn') return eph('Bad event kind.');
    const expectedPhase = kind === 'variety' ? PHASE.VARIETY_OPEN : PHASE.CN_OPEN;
    if (state.phase !== expectedPhase) {
      return eph(`That vote isn't open right now (phase: ${state.phase}).`);
    }
    return voteMenu(env, guildId, userId, kind);
  }
  if (action === 'cast') {
    const kind = parts[2];
    const gameId = parts[3];
    if (!gameId) return eph('Bad cast button.');
    const expectedPhase = kind === 'variety' ? PHASE.VARIETY_OPEN : PHASE.CN_OPEN;
    if (state.phase !== expectedPhase) {
      return eph(`That vote just closed.`);
    }
    const eventKey = eventKeyFor(kind);
    const ballots = await readBallots(env, guildId, eventKey);
    ballots[userId] = gameId;
    await writeBallots(env, guildId, eventKey, ballots);
    // Re-render the picker so the button shows the new selection.
    return voteMenu(env, guildId, userId, kind);
  }
  if (action === 'standings') {
    const kind = parts[2];
    return standingsMenu(env, guildId, kind);
  }
  if (action === 'queue-join') {
    if (state.phase !== PHASE.CN_QUEUE) {
      return eph('The CN queue isn\'t open right now.');
    }
    const { handleQueueButton } = await import('./aquilo/aq-queue.js');
    return handleQueueButton(env, { ...data, data: { ...data.data, custom_id: 'queue:join' } }, guildId);
  }
  if (action === 'status') {
    return statusMenu(env, guildId, userId, state, config);
  }
  return eph('Unknown vote-hub action: ' + cid);
}

async function voteMenu(env, guildId, userId, kind) {
  const games = await getEligibleGames(env, guildId);
  if (games.length === 0) return eph('No active games to vote on.');
  const eventKey = eventKeyFor(kind);
  const ballots  = await readBallots(env, guildId, eventKey);
  const currentVote = ballots[userId] || null;
  const rows = [];
  let row = { type: COMPONENT_ROW, components: [] };
  for (const g of games.slice(0, 25)) {  // 5 rows × 5 buttons cap
    if (row.components.length >= 5) { rows.push(row); row = { type: COMPONENT_ROW, components: [] }; }
    if (rows.length >= 5) break;
    row.components.push({
      type: COMPONENT_BUTTON,
      style: String(g.id) === String(currentVote) ? BTN_SUCCESS : BTN_SECONDARY,
      label: (String(g.id) === String(currentVote) ? '✅ ' : '') + (g.name || 'Game').slice(0, 70),
      custom_id: `vh:cast:${kind}:${g.id}`,
    });
  }
  if (row.components.length) rows.push(row);
  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: kind === 'variety' ? '🎲 Variety night vote' : '🏆 Community night vote',
        description: currentVote
          ? 'Your pick is highlighted in green. Tap a different game to change your vote.'
          : 'Pick the game you want to play. You can change your vote until the poll closes.',
        color: 0x9147ff,
      }],
      components: rows,
      flags: FLAG_EPHEMERAL,
    },
  };
}

async function standingsMenu(env, guildId, kind) {
  const eventKey = eventKeyFor(kind);
  const ballots  = await readBallots(env, guildId, eventKey);
  const counts   = {};
  for (const gid of Object.values(ballots)) counts[gid] = (counts[gid] || 0) + 1;
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  if (total === 0) {
    return {
      type: RESP_CHAT,
      data: { content: 'No votes yet.', flags: FLAG_EPHEMERAL },
    };
  }
  // Resolve names.
  const games = await getEligibleGames(env, guildId);
  const byId = new Map(games.map(g => [String(g.id), g]));
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const lines = rows.map(([gid, c], i) => {
    const g = byId.get(String(gid));
    const pct = Math.round((c / total) * 100);
    const bar = '█'.repeat(Math.min(20, Math.round((c / Math.max(1, total)) * 20))) || '·';
    return `${i + 1}. **${c}** · ${bar} · ${g?.name || 'Game'} _(${pct}%)_`;
  });
  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: `📊 ${kind === 'variety' ? 'Variety' : 'Community'} night standings · ${total === 1 ? '1 vote' : `${total} votes`}`,
        description: lines.join('\n'),
        color: 0x9147ff,
      }],
      flags: FLAG_EPHEMERAL,
    },
  };
}

async function statusMenu(env, guildId, userId, state, config) {
  const lines = [`Phase: **${state.phase}**`];
  for (const kind of ['variety', 'cn']) {
    const eventKey = eventKeyFor(kind);
    const ballots = await readBallots(env, guildId, eventKey);
    const myVote = ballots[userId];
    if (myVote) {
      const games = await getEligibleGames(env, guildId);
      const g = games.find(x => String(x.id) === String(myVote));
      lines.push(`${kind === 'variety' ? '🎲' : '🏆'} ${kind} vote: **${g?.name || 'unknown'}**`);
    }
  }
  // Queue position when applicable.
  if (state.phase === PHASE.CN_QUEUE) {
    try {
      const queue = await env.STATE.get('queue:' + guildId);
      if (queue) {
        const q = JSON.parse(queue);
        const idx = (q.entries || []).findIndex(e => e.user_id === userId);
        if (idx >= 0) lines.push(`🙋 Queue position: **${idx + 1}** of ${(q.entries || []).length}`);
        else lines.push('🙋 Not in the CN queue');
      }
    } catch { /* idle */ }
  }
  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: '👤 Your voting status',
        description: lines.join('\n'),
        color: 0x9147ff,
      }],
      flags: FLAG_EPHEMERAL,
    },
  };
}

// ── Retirement helper (sweep the old cn-vote-hub message) ───────

export async function retireOldCnVoteHub(env, guildId) {
  const prior = await env.LOADOUT_BOLTS.get(`cn-vote:hub-msg:${guildId}`, { type: 'json' });
  let deleted = false;
  if (prior?.channelId && prior?.messageId && env.DISCORD_BOT_TOKEN) {
    try {
      const r = await fetch(
        `https://discord.com/api/v10/channels/${prior.channelId}/messages/${prior.messageId}`,
        { method: 'DELETE',
          headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord vote-hub' } },
      );
      deleted = r.ok || r.status === 204 || r.status === 404;
    } catch { /* idle */ }
  }
  await env.LOADOUT_BOLTS.delete(`cn-vote:hub-msg:${guildId}`).catch(() => {});
  return { ok: true, deleted, priorChannelId: prior?.channelId || null, priorMessageId: prior?.messageId || null };
}

// ── Test exports ────────────────────────────────────────────────

export {
  daysUntilWeekday as _daysUntilWeekdayForTest,
  eventKeyFor      as _eventKeyForForTest,
};
