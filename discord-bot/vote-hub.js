// Community-night voting hub. ONE channel + ONE persistent embed.
//
// 2026-06-03 v3 final: Variety Night + Dad Game Sunday removed. The hub
// now drives ONLY the Saturday Community Night vote:
//   . Community vote Wed 12:00 ET -> Fri 12:00 ET  (Sat = Community Night)
// Outside that window the hub sits CLOSED (Patreon CTA).
//
// KV layout:
//   vote-hub:msg:<g>     { channelId, messageId, postedAt }
//   vote-hub:state:<g>   { phase, cnPollId?, lastTransitionUtc }
//   vote-hub:config:<g>  { cn* + cnQueue* weekday+hour windows }

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

// Phase constants, exported so the cron + tests can reference them.
export const PHASE = Object.freeze({
  CLOSED:    'closed',
  CN_OPEN:   'cn-open',
  CN_CLOSED: 'cn-closed',
  CN_QUEUE:  'cn-queue',
});

// ── Config ──────────────────────────────────────────────────────

export async function getConfig(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get(HUB_CONFIG_KEY(guildId), { type: 'json' });
  // v3 final (2026-06-03): only the Community Night vote remains.
  //   . Community vote Wed 12:00 ET -> Fri 12:00 ET  (Sat = Community Night)
  //   . Community queue Sat morning -> next Wed vote-open
  return {
    // CN voting window, multi-day allowed.
    cnVoteOpenWeekday:   raw?.cnVoteOpenWeekday   || 'wednesday',
    cnVoteOpenHourEt:    Number.isInteger(raw?.cnVoteOpenHourEt)
                            ? raw.cnVoteOpenHourEt : 12,
    cnVoteCloseWeekday:  raw?.cnVoteCloseWeekday  || 'friday',
    cnVoteCloseHourEt:   Number.isInteger(raw?.cnVoteCloseHourEt)
                            ? raw.cnVoteCloseHourEt : 12,

    // CN queue opens its own day/hour, separate from the vote close.
    cnQueueOpenWeekday:  raw?.cnQueueOpenWeekday  || 'saturday',
    cnQueueOpenHourEt:   Number.isInteger(raw?.cnQueueOpenHourEt)
                            ? raw.cnQueueOpenHourEt : 10,

    // Legacy single-window fields, preserved for back-compat.
    cnWeekday:      raw?.cnWeekday      || raw?.cnVoteOpenWeekday || 'wednesday',
    openHourEt:     Number.isInteger(raw?.openHourEt)  ? raw.openHourEt  : 12,
    closeHourEt:    Number.isInteger(raw?.closeHourEt) ? raw.closeHourEt : 23,
  };
}

function minuteOfWeek(weekday, hourEt) {
  return DAY_NAMES.indexOf(String(weekday).toLowerCase()) * 1440 + hourEt * 60;
}
function isInWindow(et, openWd, openHr, closeWd, closeHr) {
  const now   = minuteOfWeek(et.weekday, et.hour);
  const open  = minuteOfWeek(openWd, openHr);
  const close = minuteOfWeek(closeWd, closeHr);
  if (open === close) return false;
  if (open < close)  return now >= open && now < close;
  return now >= open || now < close;
}

export async function setConfig(env, guildId, patch) {
  const cur = await getConfig(env, guildId);
  const next = { ...cur };
  if (patch.cnWeekday !== undefined) {
    const v = String(patch.cnWeekday).toLowerCase();
    if (!DAY_NAMES.includes(v)) return { ok: false, error: 'bad-cnWeekday' };
    next.cnWeekday = v;
  }
  if (patch.openHourEt  !== undefined) next.openHourEt  = Math.max(0, Math.min(23, Number(patch.openHourEt) || 18));
  if (patch.closeHourEt !== undefined) next.closeHourEt = Math.max(0, Math.min(23, Number(patch.closeHourEt) || 21));
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
    cnPollId:      raw?.cnPollId      || null,
    lastTransitionUtc: raw?.lastTransitionUtc || 0,
  };
}

async function putState(env, guildId, state) {
  await env.LOADOUT_BOLTS.put(HUB_STATE_KEY(guildId), JSON.stringify(state));
}

// ── Date math ────────────────────────────────────────────────────

function daysUntilWeekday(currentWeekday, targetWeekday) {
  const cur = DAY_NAMES.indexOf(currentWeekday);
  const tgt = DAY_NAMES.indexOf(targetWeekday);
  if (cur < 0 || tgt < 0) return null;
  let d = (tgt - cur + 7) % 7;
  return d;
}

export function nextEventTimestamp(nowMs, targetWeekday, hourEt) {
  if (!targetWeekday) return null;
  const nowEt = getETInfo(new Date(nowMs));
  let days = daysUntilWeekday(nowEt.weekday, targetWeekday);
  if (days === null) return null;
  if (days === 0 && nowEt.hour >= 22) days = 7;
  const dt = new Date(nowMs + days * 86_400_000);
  const y  = dt.getUTCFullYear();
  const m  = dt.getUTCMonth();
  const dd = dt.getUTCDate();
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

  const nowMs = Date.now();
  const tsCnOpen  = nextEventTimestamp(nowMs, config.cnVoteOpenWeekday,  config.cnVoteOpenHourEt);
  const tsCnClose = nextEventTimestamp(nowMs, config.cnVoteCloseWeekday, config.cnVoteCloseHourEt);
  const tsCnQueue = nextEventTimestamp(nowMs, config.cnQueueOpenWeekday, config.cnQueueOpenHourEt);
  const tFmt = (ms, fmt) => ms ? `<t:${Math.floor(ms / 1000)}:${fmt}>` : null;

  if (state.phase === PHASE.CLOSED) {
    const lines = [];
    if (tsCnOpen)  lines.push(`🏆 Community vote opens ${tFmt(tsCnOpen, 'F')} (${tFmt(tsCnOpen, 'R')})`);
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
        footer: { text: 'One vote per user. Votes can be changed until the poll closes.' },
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

  if (state.phase === PHASE.CN_OPEN) {
    const lines = [`Tap **Vote** to pick Saturday's Community Night game. You can change your vote until polls close.`];
    if (tsCnClose) lines.push('', `🏁 Voting closes ${tFmt(tsCnClose, 'F')} (${tFmt(tsCnClose, 'R')})`);
    return {
      embed: {
        title: '🗳️ 🏆 Community night · voting open',
        description: lines.join('\n'),
        color: accent,
      },
      components: [{
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Vote',           custom_id: 'vh:vote:cn' },
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Live standings', custom_id: 'vh:standings:cn' },
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My status',      custom_id: 'vh:status' },
        ],
      }],
    };
  }

  if (state.phase === PHASE.CN_CLOSED) {
    const winner = await getStoredWinner(env, guildId, 'cn');
    const lines = [
      winner
        ? `**Winner:** ${winner.name}${winner.votes ? ` (${winner.votes} vote${winner.votes === 1 ? '' : 's'})` : ''}`
        : '_Votes are in, winner being tallied._',
    ];
    if (tsCnQueue) lines.push('', `🎮 Saturday queue opens ${tFmt(tsCnQueue, 'F')} (${tFmt(tsCnQueue, 'R')})`);
    const embed = {
      title: '🗳️ 🏆 Community night · voting closed',
      description: lines.join('\n'),
      color: accent,
    };
    if (winner?.art_url) embed.image = { url: winner.art_url };
    return {
      embed,
      components: [{
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Final standings', custom_id: 'vh:standings:cn' },
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

  return {
    embed: { title: '🗳️ Voting', description: `_Unknown phase: ${state.phase}_`, color: accent },
    components: [],
  };
}

// ── Winners storage ──────────────────────────────────────────────

async function getStoredWinner(env, guildId, kind) {
  return env.LOADOUT_BOLTS.get(`vote-hub:winner:${guildId}:${kind}`, { type: 'json' });
}
async function putStoredWinner(env, guildId, kind, winner) {
  await env.LOADOUT_BOLTS.put(`vote-hub:winner:${guildId}:${kind}`, JSON.stringify(winner));
}

// ── Vote tallying ───────────────────────────────────────────────

function weekStampEt() {
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

// ── Game list (pool-eligible) ───────────────────────────────────

const poolForKind = () => 'community';
const expectedPhaseForKind = () => PHASE.CN_OPEN;

async function getEligibleGames(env, guildId, pool) {
  try {
    const cat = await env.LOADOUT_BOLTS.get(`games:v1:${guildId}`, { type: 'json' });
    if (cat && Array.isArray(cat.items) && cat.items.length) {
      const items = pool
        ? cat.items.filter((g) => Array.isArray(g.pools) && g.pools.includes(pool))
        : cat.items;
      if (items.length) {
        return items
          .map((g) => ({ id: g.id, name: g.name, art_url: g.headerUrl || g.capsuleUrl || null }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }
    }
  } catch { /* fall through to D1 */ }
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
  }
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

export async function tickPhaseTransition(env, guildId) {
  // Schedule v8 (2026-07-11): the Wed-noon -> Fri-noon Community Night vote
  // is RETIRED — Saturday's game is auto-picked weekly (weeklyCommunityPick).
  // Hard-disabled so the hourly cron can't flip phases, tally stray ballots,
  // or announce a "Community Night winner" once the bot token is reset.
  // (vote-hub:winner:* writes would also mislead stream-events.js variety
  // resolution.) Reviving votes is a deliberate rebuild.
  //
  // This tick was ALSO the only writer that ever returns the persisted
  // phase to CLOSED, and castWebVote/getVotePublic still key off it — so
  // normalize any stale CN_OPEN left in KV (phase writes kept landing while
  // the bot token was dead, since putState precedes the Discord edit).
  // Writes only when non-CLOSED, so this is a one-time KV touch.
  try {
    const state = await getState(env, guildId);
    if (state && state.phase !== PHASE.CLOSED) {
      state.phase = PHASE.CLOSED;
      state.lastTransitionUtc = Date.now();
      await putState(env, guildId, state);
    }
  } catch { /* best-effort */ }
  return { phase: PHASE.CLOSED, transitioned: false };
  // eslint-disable-next-line no-unreachable
  const config = await getConfig(env, guildId);
  const state  = await getState(env, guildId);
  const et = getETInfo(new Date());

  // v3 final: ONE voted night.
  //   . CN_OPEN  Wed 12:00 ET -> Fri 12:00 ET
  //   . CLOSED   otherwise (Patreon CTA)
  const inCnVote = isInWindow(et,
    config.cnVoteOpenWeekday,  config.cnVoteOpenHourEt,
    config.cnVoteCloseWeekday, config.cnVoteCloseHourEt);

  const desired = inCnVote ? PHASE.CN_OPEN : PHASE.CLOSED;

  if (desired === state.phase) {
    return { phase: state.phase, transitioned: false };
  }

  // Leaving CN_OPEN (Fri noon): tally + announce + (re)post lineup recap.
  let leftCn = false;
  if (state.phase === PHASE.CN_OPEN) {
    const winner = await tallyAndStoreWinner(env, guildId, 'cn');
    state.cnPollId = winner?.gameId || null;
    if (winner) await announceVoteResult(env, guildId, 'cn', winner);
    leftCn = true;
  }

  state.phase = desired;
  state.lastTransitionUtc = Date.now();
  await putState(env, guildId, state);

  const channelId = await getChannelBinding(env, guildId, 'vote');
  if (channelId) await postOrRefreshHub(env, guildId, channelId);

  if (leftCn) {
    await postLineupRecap(env, guildId).catch(() => {});
  }

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
  const games = await getEligibleGames(env, guildId, poolForKind(kind));
  const g = games.find((x) => String(x.id) === String(topId));
  const winner = {
    gameId: topId,
    name: g?.name || 'the winning game',
    art_url: g?.art_url || null,
    votes: topCount,
  };
  await putStoredWinner(env, guildId, kind, winner);
  return winner;
}

// ── Winner announce + weekly lineup recap ───────────────────────

async function announceVoteResult(env, guildId, kind, winner) {
  if (!env.DISCORD_BOT_TOKEN || !winner) return { ok: false };
  const channelId = (await getChannelBinding(env, guildId, 'vote'))
    || env.VOTE_HUB_CHANNEL || '1508318929855184987';
  const embed = {
    title: `🏆 Community Night winner: ${winner.name}`,
    description:
      `The votes are in! **${winner.name}** won` +
      (winner.votes ? ` with **${winner.votes}** vote${winner.votes === 1 ? '' : 's'}` : '') +
      `.\nCatch it **Saturday at 10:30 PM ET**.`,
    color: 0x9b6cff,
  };
  if (winner.art_url) embed.image = { url: winner.art_url };
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Build the "this week's lineup" embed: FO4 CC + Rotation + Community.
export async function buildLineupEmbed(env, guildId) {
  const brand = await getBranding(env, guildId);
  const accent = brand.accentColor || 0x9b6cff;
  let fo4cc = null, rotation = null;
  try {
    const { getFo4cc, getCurrentRotation } = await import('./schedule-rotation.js');
    fo4cc = await getFo4cc(env, guildId);
    rotation = await getCurrentRotation(env, guildId);
  } catch { /* optional */ }
  const cn = await getStoredWinner(env, guildId, 'cn');

  const fields = [
    {
      name: '💪 Fallout 4 Crowd Control Chaos · Mon · Wed · Fri',
      value: fo4cc?.name ? '**Locked in every M/W/F**' : '_TBA_',
    },
    {
      name: '🏆 Community Votes Night · Sun · Tue · Thu · Sat',
      value: cn?.name ? `**${cn.name}** won the latest vote` : '_Each night picked by community vote_',
    },
  ];
  const embed = {
    title: '📅 This week’s lineup',
    description: 'All streams start **10:30 PM ET**.',
    color: accent,
    fields,
    footer: { text: 'Community game is picked by community vote.' },
  };
  if (cn?.art_url) embed.image = { url: cn.art_url };
  else if (fo4cc?.artUrl) embed.image = { url: fo4cc.artUrl };
  return embed;
}

const LINEUP_PIN_KEY = (g) => `vote-hub:lineup-pin:${g}`;

export async function postLineupRecap(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const channelId = (await getChannelBinding(env, guildId, 'vote'))
    || env.VOTE_HUB_CHANNEL || '1508318929855184987';
  const embed = await buildLineupEmbed(env, guildId);
  const auth = { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord vote-hub' };

  const prior = await env.LOADOUT_BOLTS.get(LINEUP_PIN_KEY(guildId), { type: 'json' });
  if (prior?.channelId && prior?.messageId) {
    await fetch(`https://discord.com/api/v10/channels/${prior.channelId}/pins/${prior.messageId}`,
      { method: 'DELETE', headers: auth }).catch(() => {});
    await fetch(`https://discord.com/api/v10/channels/${prior.channelId}/messages/${prior.messageId}`,
      { method: 'DELETE', headers: auth }).catch(() => {});
  }

  const post = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!post.ok) return { ok: false, error: 'post-failed', status: post.status, body: (await post.text()).slice(0, 200) };
  const j = await post.json();
  const pin = await fetch(`https://discord.com/api/v10/channels/${channelId}/pins/${j.id}`,
    { method: 'PUT', headers: auth });
  await env.LOADOUT_BOLTS.put(LINEUP_PIN_KEY(guildId),
    JSON.stringify({ channelId, messageId: j.id, postedAt: Date.now() }));
  return { ok: true, channelId, messageId: j.id, pinned: pin.ok || pin.status === 204 };
}

// ── Web vote casting + public read (aquilo.gg /schedule/community) ──

function normalizeVoteKind(kind) {
  const v = String(kind || '').toLowerCase();
  if (v === 'cn' || v === 'community') return 'cn';
  return null;
}

export async function castWebVote(env, guildId, userId, kind, gameId) {
  const k = normalizeVoteKind(kind);
  if (!k) return { ok: false, error: 'bad-kind' };
  if (!/^\d{5,25}$/.test(String(userId || ''))) return { ok: false, error: 'bad-user' };
  const state = await getState(env, guildId);
  if (state.phase !== expectedPhaseForKind(k)) {
    return { ok: false, error: 'vote-not-open', phase: state.phase };
  }
  const games = await getEligibleGames(env, guildId, poolForKind(k));
  const chosen = games.find((g) => String(g.id) === String(gameId));
  if (!chosen) return { ok: false, error: 'unknown-game' };
  const eventKey = eventKeyFor(k);
  const ballots = await readBallots(env, guildId, eventKey);
  ballots[userId] = String(gameId);
  await writeBallots(env, guildId, eventKey, ballots);
  const counts = {};
  for (const id of Object.values(ballots)) counts[id] = (counts[id] || 0) + 1;
  return {
    ok: true,
    kind: k,
    yourVote: String(gameId),
    totalVotes: Object.values(counts).reduce((a, b) => a + b, 0),
    games: games.map((g) => ({
      id: g.id, name: g.name, artUrl: g.art_url || null, votes: counts[g.id] || 0,
    })),
  };
}

export async function getVotePublic(env, guildId) {
  const g = guildId || String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  const config = await getConfig(env, g);
  const state = await getState(env, g);
  const now = Date.now();
  const eventKey = eventKeyFor('cn');
  const ballots = await readBallots(env, g, eventKey);
  const counts = {};
  for (const id of Object.values(ballots)) counts[id] = (counts[id] || 0) + 1;
  const games = await getEligibleGames(env, g, 'community');
  const winner = await getStoredWinner(env, g, 'cn');
  const kinds = {
    cn: {
      open: state.phase === PHASE.CN_OPEN,
      opensAt: nextEventTimestamp(now, config.cnVoteOpenWeekday, config.cnVoteOpenHourEt),
      closesAt: nextEventTimestamp(now, config.cnVoteCloseWeekday, config.cnVoteCloseHourEt),
      totalVotes: Object.values(counts).reduce((a, b) => a + b, 0),
      games: games.map((x) => ({ id: x.id, name: x.name, artUrl: x.art_url || null, votes: counts[x.id] || 0 })),
      winner: winner ? { name: winner.name, artUrl: winner.art_url || null, votes: winner.votes || 0 } : null,
    },
  };
  return { ok: true, phase: state.phase, now, kinds };
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

  if (state.phase === PHASE.CLOSED && action !== 'status') {
    const nowMs = Date.now();
    const cn = nextEventTimestamp(nowMs, config.cnVoteOpenWeekday, config.cnVoteOpenHourEt);
    const nextLine = cn ? `Next Community vote <t:${Math.floor(cn / 1000)}:R>` : '_No events scheduled._';
    const brand = await getBranding(env, guildId);
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🔒 Voting is closed',
          description:
            nextLine + '\n\n' +
            `Boost the community while you wait:\n` +
            `• 💎 **Patron** , priority CN queue access + bolts perks\n` +
            `• 🚀 **Server boost** , also unlocks priority queue access`,
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
    if (kind !== 'cn') return eph('Bad event kind.');
    if (state.phase !== PHASE.CN_OPEN) {
      return eph(`That vote isn't open right now (phase: ${state.phase}).`);
    }
    return voteMenu(env, guildId, userId, 'cn');
  }
  if (action === 'cast') {
    const kind = parts[2];
    const gameId = parts[3];
    if (kind !== 'cn' || !gameId) return eph('Bad cast button.');
    if (state.phase !== PHASE.CN_OPEN) {
      return eph(`That vote just closed.`);
    }
    const eventKey = eventKeyFor('cn');
    const ballots = await readBallots(env, guildId, eventKey);
    ballots[userId] = gameId;
    await writeBallots(env, guildId, eventKey, ballots);
    return voteMenu(env, guildId, userId, 'cn');
  }
  if (action === 'standings') {
    return standingsMenu(env, guildId, 'cn');
  }
  if (action === 'queue-join') {
    if (state.phase !== PHASE.CN_QUEUE) {
      return eph('The CN queue isn\'t open right now.');
    }
    const { handleQueueButton } = await import('./aquilo/aq-queue.js');
    return handleQueueButton(env, { ...data, data: { ...data.data, custom_id: 'queue:join' } }, guildId);
  }
  if (action === 'status') {
    return statusMenu(env, guildId, userId, state);
  }
  return eph('Unknown vote-hub action: ' + cid);
}

async function voteMenu(env, guildId, userId, kind) {
  const games = await getEligibleGames(env, guildId, poolForKind(kind));
  if (games.length === 0) return eph('No active games to vote on.');
  const eventKey = eventKeyFor(kind);
  const ballots  = await readBallots(env, guildId, eventKey);
  const currentVote = ballots[userId] || null;
  const rows = [];
  let row = { type: COMPONENT_ROW, components: [] };
  for (const g of games.slice(0, 25)) {
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
        title: '🏆 Community night vote',
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
  const games = await getEligibleGames(env, guildId, poolForKind(kind));
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
        title: `📊 Community night standings · ${total === 1 ? '1 vote' : `${total} votes`}`,
        description: lines.join('\n'),
        color: 0x9147ff,
      }],
      flags: FLAG_EPHEMERAL,
    },
  };
}

async function statusMenu(env, guildId, userId, state) {
  const lines = [`Phase: **${state.phase}**`];
  const eventKey = eventKeyFor('cn');
  const ballots = await readBallots(env, guildId, eventKey);
  const myVote = ballots[userId];
  if (myVote) {
    const games = await getEligibleGames(env, guildId, 'community');
    const g = games.find(x => String(x.id) === String(myVote));
    lines.push(`🏆 Community vote: **${g?.name || 'unknown'}**`);
  }
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
