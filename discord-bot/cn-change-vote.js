// Community-night "change the game" vote (2026-06-24).
//
// Community Night's game (Saturday only, v8) is auto-picked at random each
// week (see aquilo/aq-schedule.js). This module lets the Discord community
// OPTIONALLY override a night's game via a two-phase, auto-posted vote:
//
//   1. NOMINATE (noon ET default) — post a 21-game dropdown; members pick
//      up to 3 each. Tally = distinct nominators per game.
//   2. VOTE (6 PM ET default) — close nominations, take the top N, add a
//      "keep the random pick" option, open a NATIVE Discord poll.
//   3. RESOLVE (10 PM ET default) — read the poll. If a game beats "keep"
//      AND total votes >= minVotes, write a per-date override
//      (schedule:override:<g>:<ISO>, 8-day TTL — the SAME key the worker's
//      resolveSlotGame reads first), announce it, and refresh the embed.
//      Otherwise the random pick stands.
//
// Cron-driven + idempotent via the per-date state's `phase`. Ships DISABLED
// (config.enabled=false) so nothing posts until Clay flips it on. Reuses the
// override mechanism so a vote winner behaves exactly like an admin pin and
// auto-expires next week.
//
// KV:
//   cnvote:config:<g>          { enabled, minVotes, nominateHourEt, voteHourEt, resolveHourEt, maxBallot }
//   cnvote:state:<g>:<ISO>     { phase, dow, autoGameId, autoGameName, channelId, nominateMsgId, voteMsgId, ballot[] }
//   cnvote:noms:<g>:<ISO>      { <userId>: [gameId, ...] }
//   schedule:override:<g>:<ISO>  (winner; written for the worker to read)

import { getETInfo } from './aquilo/util.js';

const DOW_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const COMMUNITY_DOWS = [6]; // Saturday (v8) — keep in lockstep with aq-schedule WEEKLY
const KEEP = '__keep__';

const CONFIG_KEY = (g) => `cnvote:config:${g}`;
const STATE_KEY  = (g, iso) => `cnvote:state:${g}:${iso}`;
const NOMS_KEY   = (g, iso) => `cnvote:noms:${g}:${iso}`;
const OVERRIDE_KEY = (g, iso) => `schedule:override:${g}:${iso}`;

const DEFAULT_CONFIG = {
  enabled: false,
  minVotes: 3,
  nominateHourEt: 12,
  voteHourEt: 18,
  resolveHourEt: 22,
  maxBallot: 8,
  channelId: null,   // override: post the vote here instead of the bound poll/vote channel
  pingRoleId: null,  // optional: role to @mention when nominations open
};

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (et) => `${et.year}-${pad(et.month)}-${pad(et.day)}`;
const gid = (env) => String(env.AQUILO_VAULT_GUILD_ID || '').trim();

export async function getConfig(env, guildId) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(CONFIG_KEY(guildId), { type: 'json' });
    if (raw && typeof raw === 'object') return { ...DEFAULT_CONFIG, ...raw };
  } catch { /* defaults */ }
  return { ...DEFAULT_CONFIG };
}
export async function setConfig(env, guildId, patch) {
  const cur = await getConfig(env, guildId);
  const next = { ...cur, ...patch };
  await env.LOADOUT_BOLTS.put(CONFIG_KEY(guildId), JSON.stringify(next));
  return next;
}

async function getState(env, guildId, iso) {
  try { return await env.LOADOUT_BOLTS.get(STATE_KEY(guildId, iso), { type: 'json' }); }
  catch { return null; }
}
async function setState(env, guildId, iso, state) {
  // 9-day TTL: outlives the night, self-cleans.
  await env.LOADOUT_BOLTS.put(STATE_KEY(guildId, iso), JSON.stringify(state), { expirationTtl: 9 * 86400 });
}

// ── Discord REST (direct, bot-token) ────────────────────────────
async function dFetch(env, path, init = {}) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  return r;
}
async function postMessage(env, channelId, payload) {
  const r = await dFetch(env, `/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
  if (!r.ok) { console.warn('[cnvote] postMessage', r.status, (await r.text()).slice(0, 200)); return null; }
  return r.json();
}
async function patchMessage(env, channelId, msgId, payload) {
  const r = await dFetch(env, `/channels/${channelId}/messages/${msgId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  if (!r.ok) console.warn('[cnvote] patchMessage', r.status);
  return r.ok;
}

async function readPool(env, guildId) {
  let cat = null;
  try { cat = await env.LOADOUT_BOLTS.get(`games:v1:${guildId}`, { type: 'json' }); }
  catch { /* empty */ }
  return (cat && Array.isArray(cat.items) ? cat.items : [])
    .filter((g) => g && g.id && g.name && Array.isArray(g.pools) && g.pools.includes('community'));
}

async function resolveChannel(env, guildId) {
  try {
    const { getChannelBinding } = await import('./channel-bindings.js');
    return (
      (await getChannelBinding(env, guildId, 'poll')) ||
      (await getChannelBinding(env, guildId, 'vote')) ||
      (await getChannelBinding(env, guildId, 'schedule')) ||
      null
    );
  } catch { return null; }
}

// ── Cron entry ──────────────────────────────────────────────────
export async function tickCnVote(env) {
  // Schedule v8 (2026-07-11): HARD-disabled alongside the other two vote
  // machines (poll.js runScheduledPoll, vote-hub.js tickPhaseTransition).
  // The KV flag (cnvote:config.enabled) alone is not a safe gate for the
  // dead-token wake-up: a stale enabled:true from the feature's live window
  // would auto-post a Saturday nominate/vote cycle the moment the bot token
  // is reset. This module was DESIGNED for the auto-pick model, so if Clay
  // wants the override vote back it's a deliberate re-enable: delete this
  // return AND set cnvote:config.enabled=true.
  return;
  // eslint-disable-next-line no-unreachable
  const guildId = gid(env);
  if (!guildId || !env.LOADOUT_BOLTS || !env.DISCORD_BOT_TOKEN) return;
  const cfg = await getConfig(env, guildId);
  if (!cfg.enabled) return; // ships off; cheap early-out

  const et = getETInfo();
  const dow = DOW_INDEX[et.weekday];
  if (!COMMUNITY_DOWS.includes(dow)) return; // only community nights

  const iso = isoOf(et);
  const state = await getState(env, guildId, iso);
  const phase = state?.phase || 'idle';
  const hour = et.hour;

  try {
    if (phase === 'idle' && hour >= cfg.nominateHourEt && hour < cfg.voteHourEt) {
      await openNominations(env, guildId, iso, dow, cfg);
    } else if (phase === 'nominate' && hour >= cfg.voteHourEt && hour < cfg.resolveHourEt) {
      await openVote(env, guildId, iso, cfg);
    } else if (phase === 'vote' && hour >= cfg.resolveHourEt) {
      await resolveVote(env, guildId, iso, cfg);
    }
  } catch (e) {
    console.warn('[cnvote] tick', phase, e?.message || e);
  }
}

// ── Phase 1: nominations ────────────────────────────────────────
async function openNominations(env, guildId, iso, dow, cfg) {
  // Respect an existing admin pin: if this night is already overridden on
  // aquilo.gg, don't run a vote.
  try {
    const ov = await env.LOADOUT_BOLTS.get(OVERRIDE_KEY(guildId, iso), { type: 'json' });
    if (ov && ov.name) { await setState(env, guildId, iso, { phase: 'skipped', dow, reason: 'admin-pinned' }); return; }
  } catch { /* continue */ }

  const { weeklyCommunityPick } = await import('./aquilo/aq-schedule.js');
  const auto = await weeklyCommunityPick(env, guildId, dow);
  const pool = await readPool(env, guildId);
  const channelId = cfg.channelId || await resolveChannel(env, guildId);
  if (!auto || pool.length === 0 || !channelId) {
    await setState(env, guildId, iso, { phase: 'skipped', dow, reason: 'no-auto-or-channel' });
    return;
  }

  const ping = cfg.pingRoleId ? `<@&${cfg.pingRoleId}> ` : '';
  const options = pool.slice(0, 25).map((g) => ({ label: g.name.slice(0, 100), value: g.id }));
  const payload = {
    content:
      `${ping}🎲 **Community Night**: tonight's random pick is **${auto.name}**.\n` +
      `Want something else? Nominate up to **3** games below. The top picks go to a vote at ` +
      `${fmtHour(cfg.voteHourEt)}, and if one wins (≥ ${cfg.minVotes} votes) it replaces tonight's game.`,
    allowed_mentions: cfg.pingRoleId ? { parse: [], roles: [String(cfg.pingRoleId)] } : { parse: [] },
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: `cnvote:nom:${iso}`,
        placeholder: 'Nominate up to 3 games…',
        min_values: 1,
        max_values: 3,
        options,
      }],
    }],
  };
  const msg = await postMessage(env, channelId, payload);
  await setState(env, guildId, iso, {
    phase: 'nominate', dow, channelId,
    autoGameId: auto.gameId, autoGameName: auto.name,
    nominateMsgId: msg?.id || null,
  });
}

// Component handler: record a member's nominations. Returns a Discord
// interaction response object (ephemeral confirmation).
export async function handleCnVoteComponent(env, interaction) {
  const guildId = gid(env);
  const customId = interaction?.data?.custom_id || '';
  const iso = customId.split(':')[2] || '';
  const values = Array.isArray(interaction?.data?.values) ? interaction.data.values : [];
  const userId = interaction?.member?.user?.id || interaction?.user?.id;
  if (!guildId || !iso || !userId) {
    return ephemeral('Could not record that. Try again.');
  }
  const state = await getState(env, guildId, iso);
  if (!state || state.phase !== 'nominate') {
    return ephemeral('Nominations for this night are closed.');
  }
  let noms = {};
  try { noms = (await env.LOADOUT_BOLTS.get(NOMS_KEY(guildId, iso), { type: 'json' })) || {}; } catch { /* fresh */ }
  noms[userId] = values.slice(0, 3);
  await env.LOADOUT_BOLTS.put(NOMS_KEY(guildId, iso), JSON.stringify(noms), { expirationTtl: 9 * 86400 });

  const pool = await readPool(env, guildId);
  const names = values.map((v) => pool.find((g) => g.id === v)?.name || v).join(', ');
  return ephemeral(`✅ Nominated: **${names}**. Voting opens at ${fmtHour((await getConfig(env, guildId)).voteHourEt)}.`);
}

// ── Phase 2: vote ───────────────────────────────────────────────
async function openVote(env, guildId, iso, cfg) {
  const state = await getState(env, guildId, iso);
  if (!state || state.phase !== 'nominate') return;
  const channelId = state.channelId;

  let noms = {};
  try { noms = (await env.LOADOUT_BOLTS.get(NOMS_KEY(guildId, iso), { type: 'json' })) || {}; } catch { /* none */ }
  // Tally distinct nominators per game, excluding the current auto pick
  // (the "keep" option already covers it).
  const counts = new Map();
  for (const picks of Object.values(noms)) {
    for (const gameId of (Array.isArray(picks) ? picks : [])) {
      if (gameId === state.autoGameId) continue;
      counts.set(gameId, (counts.get(gameId) || 0) + 1);
    }
  }
  // Disable the nomination dropdown regardless.
  if (state.nominateMsgId) {
    await patchMessage(env, channelId, state.nominateMsgId, { components: [] }).catch(() => {});
  }

  if (counts.size === 0) {
    if (channelId) {
      await postMessage(env, channelId, {
        content: `🎲 No nominations came in, so Community Night stays on tonight's random pick, **${state.autoGameName}**.`,
        allowed_mentions: { parse: [] },
      });
    }
    await setState(env, guildId, iso, { ...state, phase: 'skipped', reason: 'no-noms' });
    return;
  }

  const pool = await readPool(env, guildId);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Math.min(9, cfg.maxBallot)))
    .map(([gameId]) => ({ gameId, name: pool.find((g) => g.id === gameId)?.name || gameId }));

  // Ballot: "keep the random pick" first, then the top nominees.
  const ballot = [
    { gameId: KEEP, text: trunc(`🎲 Keep ${state.autoGameName}`, 55) },
    ...top.map((t) => ({ gameId: t.gameId, text: trunc(t.name, 55) })),
  ];
  const durationHours = Math.max(1, cfg.resolveHourEt - cfg.voteHourEt);
  const pollMsg = await postMessage(env, channelId, {
    allowed_mentions: { parse: [] },
    poll: {
      question: { text: '🎮 What are we playing for Community Night?' },
      answers: ballot.map((b) => ({ poll_media: { text: b.text } })),
      duration: durationHours,
      allow_multiselect: false,
    },
  });
  // Capture Discord's answer_ids (returned in send order) so resolve can
  // map results back to games without fuzzy text matching.
  const answerIds = (pollMsg?.poll?.answers || []).map((a) => a.answer_id);
  const ballotWithIds = ballot.map((b, i) => ({ ...b, answerId: answerIds[i] ?? i + 1 }));
  await setState(env, guildId, iso, {
    ...state, phase: 'vote', voteMsgId: pollMsg?.id || null, ballot: ballotWithIds,
  });
}

// ── Phase 3: resolve ────────────────────────────────────────────
async function resolveVote(env, guildId, iso, cfg) {
  const state = await getState(env, guildId, iso);
  if (!state || state.phase !== 'vote') return;
  const channelId = state.channelId;

  if (!state.voteMsgId) { await setState(env, guildId, iso, { ...state, phase: 'resolved' }); return; }

  // End the poll so results finalize, then read them. Expire is a no-op if
  // the poll already ended on its own.
  await dFetch(env, `/channels/${channelId}/polls/${state.voteMsgId}/expire`, { method: 'POST' }).catch(() => {});
  const r = await dFetch(env, `/channels/${channelId}/messages/${state.voteMsgId}`);
  if (!r.ok) { await setState(env, guildId, iso, { ...state, phase: 'resolved', reason: 'fetch-failed' }); return; }
  const msg = await r.json();
  const tallies = msg?.poll?.results?.answer_counts || [];
  const countFor = (answerId) => (tallies.find((t) => t.id === answerId)?.count || 0);

  // Tally each ballot entry by its captured answer_id; winner = most votes
  // (ties fall to the earlier entry, i.e. "keep").
  let total = 0, best = null, bestCount = -1;
  for (const entry of (state.ballot || [])) {
    const c = countFor(entry.answerId);
    total += c;
    if (c > bestCount) { best = entry; bestCount = c; }
  }

  const keptOrTooFew = !best || best.gameId === KEEP || total < cfg.minVotes;
  if (keptOrTooFew) {
    if (channelId) {
      const why = total < cfg.minVotes ? `only ${total} vote${total === 1 ? '' : 's'}` : 'the community voted to keep it';
      await postMessage(env, channelId, {
        content: `🗳️ Community Night stays on **${state.autoGameName}** (${why}).`,
        allowed_mentions: { parse: [] },
      });
    }
    await setState(env, guildId, iso, { ...state, phase: 'resolved', winner: KEEP, total });
    return;
  }

  // Winner: write the per-date override the worker reads first.
  const pool = await readPool(env, guildId);
  const g = pool.find((x) => x.id === best.gameId);
  if (!g) { await setState(env, guildId, iso, { ...state, phase: 'resolved', reason: 'winner-gone' }); return; }
  const art = g.headerUrl || g.capsuleUrl || null;
  const rec = { gameSlug: g.id, name: g.name, artUrl: art, store: g.storeUrl || null };
  await env.LOADOUT_BOLTS.put(OVERRIDE_KEY(guildId, iso), JSON.stringify(rec), { expirationTtl: 8 * 86400 });

  if (channelId) {
    await postMessage(env, channelId, {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: `🏆 Community vote: tonight is now ${g.name}!`,
        description: `**${g.name}** won with **${bestCount}** of **${total}** vote${total === 1 ? '' : 's'}, replacing the random pick (${state.autoGameName}).`,
        color: 0x5ad1ff,
        image: art ? { url: art } : undefined,
      }],
    });
  }
  // Refresh the pinned schedule embed (best-effort).
  try {
    const { postOrRefreshSchedule } = await import('./aquilo/aq-schedule.js');
    await postOrRefreshSchedule(env, guildId);
  } catch (e) { console.warn('[cnvote] embed refresh', e?.message || e); }

  await setState(env, guildId, iso, { ...state, phase: 'resolved', winner: g.id, winnerName: g.name, total });
}

// ── helpers ─────────────────────────────────────────────────────
function ephemeral(content) {
  return { type: 4, data: { flags: 64, content } };
}
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function fmtHour(h) {
  const p = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12} ${p} ET`;
}
