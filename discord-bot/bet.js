// Sports betting — bolts-denominated, ESPN-driven.
//
// Pulls upcoming + recent games for NFL / NBA / MLB / NHL from ESPN's
// public scoreboard endpoint (no auth, no key). The hourly cron at
// :23 past refreshes a 48-hour cache + settles every open bet whose
// game has finished.
//
// Wager rules:
//   - Stake capped at 10 % of the bettor's wallet at place-time.
//   - Even-money payout = stake × 1.95 (2 × 0.975 house edge) when
//     ESPN doesn't surface a moneyline; otherwise the American
//     moneyline drives the multiplier and the same 2.5 % edge applies.
//   - Tied / postponed games refund the stake.
//
// KV layout (all in LOADOUT_BOLTS):
//   sports:games:cache             cached upcoming + recent games, 2h-ish TTL
//   bets:user:<guildId>:<userId>   per-user history (active + last 50 settled)
//   bets:open:<gameId>             open bets on a single game (cleared on settle)
//
// Slash subcommands (in commands-spec.js):
//   /bet sports list
//   /bet sports place <game> <side> <bolts>
//   /bet sports active
//   /bet sports history

import { json } from './ext-shared.js';
import { spend, earn, getWallet } from './wallet.js';
import { noteTeamsFromGames, findSubscribersForGame, seedTeamRegistry } from './hub-menu.js';

const FLAG_EPHEMERAL = 1 << 6;
const RESP_CHAT = 4;

const HOUSE_EDGE = 0.025;
const MAX_STAKE_PCT = 10;   // 10 % of wallet per bet
const USER_HIST_CAP = 50;

const GAMES_CACHE_KEY = 'sports:games:cache';
const GAMES_CACHE_TTL = 60 * 60 * 2; // 2h
const UPCOMING_WINDOW_MS = 48 * 60 * 60 * 1000;

const LEAGUES = [
  { sport: 'football',   league: 'nfl', label: 'NFL' },
  { sport: 'basketball', league: 'nba', label: 'NBA' },
  { sport: 'baseball',   league: 'mlb', label: 'MLB' },
  { sport: 'hockey',     league: 'nhl', label: 'NHL' },
];

const ESPN_UA = 'Mozilla/5.0 (compatible; aquilo-sports/1.0)';

// ---- ESPN scoreboard ---------------------------------------------------

export async function fetchLeague(sport, league) {
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`,
      { headers: { 'User-Agent': ESPN_UA } },
    );
    if (!res.ok) return [];
    const d = await res.json();
    return Array.isArray(d.events) ? d.events : [];
  } catch { return []; }
}

// Normalize an ESPN event to a compact game record.
function normalizeEvent(label, ev) {
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const cmps = Array.isArray(comp.competitors) ? comp.competitors : [];
  const home = cmps.find((c) => c.homeAway === 'home') || cmps[0];
  const away = cmps.find((c) => c.homeAway === 'away') || cmps[1];
  if (!home || !away) return null;
  const status = ev.status && ev.status.type;
  const odds = comp.odds && comp.odds[0];
  // Moneyline pulled defensively — ESPN's payload shifts shape per
  // sport. We accept either a top-level number or a nested {moneyLine}.
  function pickMoneyline(o) {
    if (!o) return null;
    if (typeof o.moneyLine === 'number') return o.moneyLine;
    if (typeof o.value === 'number') return o.value;
    return null;
  }
  // Spread + total when ESPN publishes them (DraftKings / Caesars feed
  // depending on sport / time). `spread` is the line FROM HOME'S POV
  // — a negative number means home is favoured by that many. `overUnder`
  // is the combined game total.
  const spreadLine = (odds && typeof odds.spread === 'number') ? odds.spread : null;
  const overUnder  = (odds && typeof odds.overUnder === 'number') ? odds.overUnder : null;
  const oddsProvider = (odds && odds.provider && odds.provider.name) || null;
  return {
    id: String(ev.id),
    label,
    name: ev.name || `${away.team.displayName} at ${home.team.displayName}`,
    date: ev.date,
    state: (status && status.state) || 'pre',     // pre | in | post
    completed: !!(status && status.completed),
    statusName: (status && status.name) || '',
    spread: spreadLine,
    overUnder,
    oddsProvider,
    home: {
      id: String(home.id),
      abbr: home.team && (home.team.abbreviation || home.team.shortDisplayName || home.team.displayName),
      name: home.team && (home.team.displayName || home.team.shortDisplayName),
      score: home.score != null ? Number(home.score) : null,
      odds: odds ? pickMoneyline(odds.homeTeamOdds) : null,
    },
    away: {
      id: String(away.id),
      abbr: away.team && (away.team.abbreviation || away.team.shortDisplayName || away.team.displayName),
      name: away.team && (away.team.displayName || away.team.shortDisplayName),
      score: away.score != null ? Number(away.score) : null,
      odds: odds ? pickMoneyline(odds.awayTeamOdds) : null,
    },
  };
}

export async function refreshGamesCache(env) {
  const games = [];
  for (const lg of LEAGUES) {
    const evs = await fetchLeague(lg.sport, lg.league);
    for (const ev of evs) {
      const g = normalizeEvent(lg.label, ev);
      if (g) games.push(g);
    }
  }
  await env.LOADOUT_BOLTS.put(GAMES_CACHE_KEY, JSON.stringify({ games, asOf: Date.now() }), {
    expirationTtl: GAMES_CACHE_TTL,
  });
  return games;
}

export async function readGamesCache(env) {
  try {
    const d = await env.LOADOUT_BOLTS.get(GAMES_CACHE_KEY, { type: 'json' });
    if (d && Array.isArray(d.games)) return d.games;
  } catch { /* idle */ }
  return [];
}

export function findGame(games, query) {
  const q = String(query || '').toUpperCase().trim();
  if (!q) return null;
  // Match by id (exact, prefix, suffix) OR by "AWY@HOM" pair.
  return (
    games.find((g) => g.id === q) ||
    games.find((g) => g.id.endsWith(q)) ||
    games.find((g) => g.id.startsWith(q)) ||
    games.find((g) =>
      (g.away.abbr + '@' + g.home.abbr).toUpperCase() === q ||
      (g.home.abbr + 'V' + g.away.abbr).toUpperCase() === q,
    ) ||
    null
  );
}

// ---- Payout math -------------------------------------------------------

function payoutMultiplier(americanOdds) {
  if (typeof americanOdds !== 'number' || !isFinite(americanOdds) || americanOdds === 0) {
    return 2.0; // even-money fallback (before house edge)
  }
  return americanOdds >= 100
    ? 1 + americanOdds / 100
    : 1 + 100 / Math.abs(americanOdds);
}

export function computeWinPayout(stake, americanOdds) {
  const m = payoutMultiplier(americanOdds);
  return Math.max(1, Math.floor(stake * m * (1 - HOUSE_EDGE)));
}

// ---- User-bet store ----------------------------------------------------

async function getUserBets(env, guildId, userId) {
  try {
    const d = await env.LOADOUT_BOLTS.get(`bets:user:${guildId}:${userId}`, { type: 'json' });
    return (d && typeof d === 'object') ? d : { active: [], history: [] };
  } catch { return { active: [], history: [] }; }
}

// Web /web/bet/snapshot reads this. Same store, no separate copy.
export async function getUserBetsPublic(env, guildId, userId) {
  return getUserBets(env, guildId, userId);
}

async function putUserBets(env, guildId, userId, data) {
  if (Array.isArray(data.history) && data.history.length > USER_HIST_CAP) {
    data.history = data.history.slice(-USER_HIST_CAP);
  }
  await env.LOADOUT_BOLTS.put(`bets:user:${guildId}:${userId}`, JSON.stringify(data));
}

async function getOpenBets(env, gameId) {
  try {
    const d = await env.LOADOUT_BOLTS.get(`bets:open:${gameId}`, { type: 'json' });
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function putOpenBets(env, gameId, arr) {
  if (arr.length === 0) {
    try { await env.LOADOUT_BOLTS.delete(`bets:open:${gameId}`); } catch { /* idle */ }
    return;
  }
  await env.LOADOUT_BOLTS.put(`bets:open:${gameId}`, JSON.stringify(arr));
}

async function listOpenBetGameIds(env) {
  const ids = [];
  let cursor;
  do {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'bets:open:', cursor });
    for (const k of r.keys) ids.push(k.name.slice('bets:open:'.length));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return ids;
}

// ---- Cron tick: refresh + settle ---------------------------------------

export async function betCronTick(env) {
  // Refresh cache first so settle reads fresh statuses.
  let games;
  try { games = await refreshGamesCache(env); }
  catch { games = await readGamesCache(env); }

  // Keep the team registry warm for /hub team-subscription search.
  // seedTeamRegistry is idempotent + sentinel-guarded so it only hits
  // ESPN's teams endpoint once per league per deploy.
  try { await seedTeamRegistry(env); } catch { /* idle */ }
  try { await noteTeamsFromGames(env, games); } catch { /* idle */ }

  // Post newly-seen games to every guild's bound sports feed channel.
  try { await postNewGamesToFeeds(env, games); } catch { /* idle */ }

  const gamesById = {};
  for (const g of games) gamesById[g.id] = g;

  // Settle any open game that finished.
  const openIds = await listOpenBetGameIds(env);
  let settled = 0;
  for (const gid of openIds) {
    const g = gamesById[gid];
    if (!g) continue; // game not in current scoreboard window — leave for later
    if (g.state !== 'post' || !g.completed) continue;
    const bets = await getOpenBets(env, gid);
    if (bets.length === 0) {
      await putOpenBets(env, gid, []);
      continue;
    }
    for (const bet of bets) {
      try {
        const result = settleSoloBet(bet, g);
        if (result.outcome === 'refund' || result.outcome === 'push') {
          await earn(env, bet.guildId, bet.userId, result.payout, 'bet-refund:' + gid);
          await recordSettled(env, bet, result.outcome, result.payout);
        } else if (result.outcome === 'win') {
          await earn(env, bet.guildId, bet.userId, result.payout, 'bet-win:' + gid);
          await recordSettled(env, bet, 'win', result.payout);
        } else {
          // Loss — stake already debited at place time.
          await recordSettled(env, bet, 'loss', 0);
        }
        settled++;
      } catch { /* skip; next tick retries */ }
    }
    await putOpenBets(env, gid, []);
  }

  // Parlays — sweep every open ticket; settle when every leg has a
  // finished game in the cache. Each leg uses settleSoloBet against
  // its locked line/odds.
  const parlayIds = await listOpenParlayIds(env);
  let parlaysSettled = 0;
  for (const pid of parlayIds) {
    try {
      const raw = await env.LOADOUT_BOLTS.get(PARLAY_KEY(pid), { type: 'json' });
      if (!raw) { await removeOpenParlayId(env, pid); continue; }
      const parlay = raw;
      if (parlay.status !== 'open') { await removeOpenParlayId(env, pid); continue; }

      // Are all legs decided?
      let allDecided = true;
      for (const leg of parlay.legs) {
        if (leg.outcome) continue;
        const g = gamesById[leg.gameId];
        if (!g || g.state !== 'post' || !g.completed) { allDecided = false; continue; }
        // Borrow settleSoloBet by faking a bet shape.
        const fake = { kind: leg.kind, side: leg.side, lockedOdds: leg.lockedOdds, lockedLine: leg.lockedLine, stake: parlay.stake };
        const r2 = settleSoloBet(fake, g);
        leg.outcome = r2.outcome;
        leg.scoredAt = Date.now();
      }
      if (!allDecided) {
        // Persist any in-progress leg results so a later tick doesn't
        // re-do the work.
        await env.LOADOUT_BOLTS.put(PARLAY_KEY(pid), JSON.stringify(parlay));
        continue;
      }

      // Decide the ticket. Any 'loss' = the whole parlay loses.
      // 'refund' / 'push' legs DROP from the parlay rather than fail
      // it; the remaining legs' multiplier still has to clear.
      let lost = false;
      const remaining = [];
      for (const leg of parlay.legs) {
        if (leg.outcome === 'loss') { lost = true; break; }
        if (leg.outcome === 'win') remaining.push(leg);
        // refund / push → leg dropped
      }
      if (lost) {
        parlay.status = 'lost';
        parlay.settledAt = Date.now();
        parlay.payout = 0;
        await recordSettledParlay(env, parlay);
      } else if (remaining.length === 0) {
        // Every leg pushed / refunded → return stake.
        await earn(env, parlay.guildId, parlay.userId, parlay.stake, 'parlay-refund:' + pid);
        parlay.status = 'refund';
        parlay.settledAt = Date.now();
        parlay.payout = parlay.stake;
        await recordSettledParlay(env, parlay);
      } else {
        // Win — recompute payout against the SURVIVING legs only (push
        // legs don't pad the multiplier).
        const payout = parlayPayout(parlay.stake, remaining);
        await earn(env, parlay.guildId, parlay.userId, payout, 'parlay-win:' + pid);
        parlay.status = 'won';
        parlay.settledAt = Date.now();
        parlay.payout = payout;
        await recordSettledParlay(env, parlay);
        // PROGRESSION (P1) — parlay win XP.
        try {
          const { emitProgressionEvent } = await import('./progression/event-bus.js');
          await emitProgressionEvent(env, {
            kind: 'bet.won.parlay', userId: parlay.userId, guildId: parlay.guildId,
            meta: { betId: parlay.betId, payout, legs: remaining.length },
            stableKeys: ['betId'],
          });
        } catch { /* non-fatal */ }
      }
      await env.LOADOUT_BOLTS.put(PARLAY_KEY(pid), JSON.stringify(parlay));
      await removeOpenParlayId(env, pid);
      parlaysSettled++;
    } catch { /* skip; next tick retries */ }
  }

  return { games: games.length, settled, parlaysSettled };
}

async function recordSettledParlay(env, parlay) {
  const u = await getUserBets(env, parlay.guildId, parlay.userId);
  u.active = (u.active || []).filter((b) => b.betId !== parlay.betId);
  (u.history = u.history || []).push({
    betId: parlay.betId,
    kind: 'parlay',
    stake: parlay.stake,
    legs: parlay.legs.map(legSummary),
    outcome: parlay.status === 'won' ? 'win'
           : parlay.status === 'refund' ? 'refund' : 'loss',
    payout: parlay.payout || 0,
    settledAt: parlay.settledAt || Date.now(),
  });
  await putUserBets(env, parlay.guildId, parlay.userId, u);
}

// ---- Sports feed channel posting --------------------------------------
//
// Each guild can bind a "sports feed" channel via /admin. Every cron
// tick, identify games whose IDs are new to that guild's tracker and
// post each as a fresh embed (NOT edit-in-place — feed is chronological).
// Pings subscribers via allowed_mentions.users; batches at 100 mentions
// per post per Discord cap.

const KNOWN_GAMES_CAP = 200;

async function postNewGamesToFeeds(env, games) {
  let cursor;
  do {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'sports:channel:guild:', cursor });
    for (const k of r.keys) {
      const guildId = k.name.slice('sports:channel:guild:'.length);
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!rec || !rec.channelId) continue;
      const known = new Set(Array.isArray(rec.knownGameIds) ? rec.knownGameIds : []);
      const fresh = games.filter((g) => g.state === 'pre' && !known.has(g.id));
      for (const g of fresh) {
        try { await postGameAnnouncement(env, rec.channelId, g); }
        catch { /* idle */ }
        known.add(g.id);
      }
      // Trim known list to keep KV record bounded.
      const next = Array.from(known).slice(-KNOWN_GAMES_CAP);
      await env.LOADOUT_BOLTS.put(
        k.name,
        JSON.stringify({ channelId: rec.channelId, knownGameIds: next, boundAt: rec.boundAt || Date.now() }),
      );
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
}

async function postGameAnnouncement(env, channelId, g) {
  // Gather subscribers + dedupe.
  let subs = [];
  try {
    subs = await findSubscribersForGame(env, g.label, g.away.id, g.home.id);
  } catch { /* idle */ }
  const oddsLine = (g.away.odds || g.home.odds)
    ? '\nMoneyline · ' + (g.away.abbr || '?') + ' ' + fmtOddsLocal(g.away.odds) +
      ' · ' + (g.home.abbr || '?') + ' ' + fmtOddsLocal(g.home.odds)
    : '';
  const embed = {
    title: '🏈 ' + g.label + ': ' + (g.away.name || g.away.abbr) + ' @ ' + (g.home.name || g.home.abbr),
    description:
      '**Tip-off:** ' + fmtTimeDyn(g.date) + oddsLine + '\n\n' +
      'Tap a button below to bet · 10% wallet cap · 1.95× even-money payout.',
    color: 0xff6ab5,
  };
  const components = [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: '🏠 Bet ' + (g.home.abbr || 'Home'),
          custom_id: 'hub:sports:bet:home:' + g.id },
        { type: 2, style: 2, label: '✈ Bet ' + (g.away.abbr || 'Away'),
          custom_id: 'hub:sports:bet:away:' + g.id },
        { type: 2, style: 4, label: '🔕 Mute ' + g.label,
          custom_id: 'hub:sports:mute:' + g.label.toLowerCase() },
        { type: 2, style: 2, label: '◀ Open Hub', custom_id: 'hub:home' },
      ],
    },
  ];
  // Discord caps at 100 mentions per message; batch overflow into
  // additional pure-mention posts after the main embed.
  const CHUNK = 100;
  const first = subs.slice(0, CHUNK);
  const content = first.length ? first.map((u) => '<@' + u + '>').join(' ') : '';
  await discordPostMessageLocal(env, channelId, {
    content,
    embeds: [embed],
    components,
    allowed_mentions: { users: first },
  });
  for (let i = CHUNK; i < subs.length; i += CHUNK) {
    const slice = subs.slice(i, i + CHUNK);
    await discordPostMessageLocal(env, channelId, {
      content: slice.map((u) => '<@' + u + '>').join(' '),
      allowed_mentions: { users: slice },
    });
  }
}

function fmtOddsLocal(americanOdds) {
  if (typeof americanOdds !== 'number') return '—';
  return americanOdds > 0 ? '+' + americanOdds : String(americanOdds);
}

async function discordPostMessageLocal(env, channelId, body) {
  if (!env.DISCORD_BOT_TOKEN) return null;
  try {
    const res = await fetch(
      'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) + '/messages',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function recordSettled(env, bet, outcome, payout) {
  const u = await getUserBets(env, bet.guildId, bet.userId);
  u.active = (u.active || []).filter((b) => b.betId !== bet.betId);
  (u.history = u.history || []).push({
    betId: bet.betId,
    gameId: bet.gameId,
    sport: bet.sport,
    side: bet.side,
    stake: bet.stake,
    outcome,
    payout,
    settledAt: Date.now(),
  });
  await putUserBets(env, bet.guildId, bet.userId, u);
  // PROGRESSION (P1) — bet settlement XP (winning side only).
  try {
    if (outcome === 'win') {
      const { emitProgressionEvent } = await import('./progression/event-bus.js');
      await emitProgressionEvent(env, {
        kind: 'bet.won', userId: bet.userId, guildId: bet.guildId,
        meta: { betId: bet.betId, payout }, stableKeys: ['betId'],
      });
    }
  } catch { /* non-fatal */ }
}

// ---- Slash command dispatcher ------------------------------------------

// Public read-only snapshot for the aquilo.gg public page + the panel's
// Sports tab. Returns the next-48h upcoming-and-live slice. No auth, no
// user data.
export async function publicSportsSnapshot(env) {
  let games = await readGamesCache(env);
  if (games.length === 0) {
    try { games = await refreshGamesCache(env); } catch { games = []; }
  }
  const now = Date.now();
  const slice = games
    .filter((g) => {
      if (g.state === 'in') return true;
      if (g.state !== 'pre') return false;
      const ms = g.date ? new Date(g.date).getTime() : 0;
      return ms - now < UPCOMING_WINDOW_MS && ms - now > -60 * 60 * 1000;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((g) => ({
      id: g.id,
      label: g.label,
      date: g.date,
      state: g.state,
      spread: typeof g.spread === 'number' ? g.spread : null,
      overUnder: typeof g.overUnder === 'number' ? g.overUnder : null,
      oddsProvider: g.oddsProvider || null,
      home: { abbr: g.home.abbr, name: g.home.name, odds: g.home.odds },
      away: { abbr: g.away.abbr, name: g.away.name, odds: g.away.odds },
    }));
  return json({ games: slice, asOf: new Date().toISOString() });
}

// STRING_AUTOCOMPLETE handler for /bet sports place's `game` option.
// The interaction payload nests options three deep (group -> subcommand
// -> options), with one option carrying `focused: true`. We only need
// to surface the upcoming-game choices for the `game` slot.
export async function handleBetAutocomplete(env, options) {
  const grp = (options && options[0]) || {};
  const sub = (grp.options && grp.options[0]) || {};
  const focused = (sub.options || []).find((o) => o && o.focused);
  if (!focused || focused.name !== 'game') return { type: 8, data: { choices: [] } };
  const q = String(focused.value || '').toLowerCase().trim();

  let games = await readGamesCache(env);
  if (games.length === 0) {
    try { games = await refreshGamesCache(env); } catch { games = []; }
  }
  const now = Date.now();
  const filtered = games.filter((g) => {
    if (g.state === 'in') return true;
    if (g.state !== 'pre') return false;
    const ms = g.date ? new Date(g.date).getTime() : 0;
    if (ms - now > UPCOMING_WINDOW_MS) return false;
    if (ms - now < -60 * 60 * 1000) return false;
    return true;
  });
  const scored = filtered
    .map((g) => {
      const hay =
        (g.away.abbr + ' ' + g.home.abbr + ' ' +
         (g.away.name || '') + ' ' + (g.home.name || '') + ' ' +
         g.label + ' ' + g.id).toLowerCase();
      const match = q === '' || hay.includes(q);
      return { g, match, when: g.date ? new Date(g.date).getTime() : 0 };
    })
    .filter((x) => x.match)
    .sort((a, b) => a.when - b.when)
    .slice(0, 25);
  const choices = scored.map(({ g }) => {
    // Name max 100 chars; we stay well under. Time is the upstream
    // ISO with seconds trimmed — local-time formatting belongs on
    // the renderer, not on the autocomplete label.
    const live = g.state === 'in' ? '[LIVE] ' : '';
    const name = (live + g.label + ': ' + (g.away.abbr || '?') + ' @ ' +
                  (g.home.abbr || '?') + ' — ' + fmtTime(g.date)).slice(0, 100);
    return { name, value: String(g.id) };
  });
  return { type: 8, data: { choices } };
}

export async function handleBet(env, guildId, userId, userName, options) {
  // /bet has one group `sports` with subcommands beneath. Discord
  // payload shape: options[0] is the SUB_COMMAND_GROUP, its options[0]
  // is the actual SUB_COMMAND.
  const grp = (options && options[0]) || {};
  if (grp.name !== 'sports') return slashReply('Unknown bet category.');
  const sub = (grp.options && grp.options[0]) || {};
  const args = {};
  for (const o of (sub.options || [])) args[o.name] = o.value;
  switch (sub.name) {
    case 'list':    return slashReply(await renderSportsList(env));
    case 'place':   return slashReply(await runPlace(env, guildId, userId, args));
    case 'active':  return slashReply(await renderActive(env, guildId, userId));
    case 'history': return slashReply(await renderHistory(env, guildId, userId));
    default:        return slashReply('Unknown subcommand.');
  }
}

function slashReply(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}

function fmtBolts(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtOdds(americanOdds) {
  if (typeof americanOdds !== 'number') return '—';
  return americanOdds > 0 ? '+' + americanOdds : String(americanOdds);
}

// Plain ISO-ish formatting for places Discord markdown won't render
// (autocomplete choice labels, sport list code blocks).
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

// Discord dynamic timestamp — auto-localizes to the viewer's locale +
// time zone. `:F` = "Monday, May 19, 2026 7:00 PM"; `:R` = "in 3
// hours". Use this anywhere the output renders inside an embed body
// or a regular message (it doesn't render inside code blocks or
// autocomplete labels).
function fmtTimeDyn(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (!isFinite(ms)) return '';
  const u = Math.floor(ms / 1000);
  return '<t:' + u + ':F> (<t:' + u + ':R>)';
}

export async function renderSportsList(env) {
  let games = await readGamesCache(env);
  if (games.length === 0) {
    games = await refreshGamesCache(env);
  }
  const now = Date.now();
  // Upcoming + in-progress within the next 48h, plus any in-progress.
  const filtered = games.filter((g) => {
    const ms = g.date ? new Date(g.date).getTime() : 0;
    if (g.state === 'in') return true;
    if (g.state === 'pre' && ms - now < UPCOMING_WINDOW_MS && ms - now > -60 * 60 * 1000) return true;
    return false;
  });
  if (filtered.length === 0) {
    return 'No upcoming games in the next 48h across NFL / NBA / MLB / NHL.';
  }
  // Sort by date.
  filtered.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const rows = filtered.slice(0, 25).map((g) => {
    const odds = '(' + fmtOdds(g.away.odds) + ' / ' + fmtOdds(g.home.odds) + ')';
    const tag = g.state === 'in' ? 'LIVE ' : '';
    // padStart on the away abbr + padEnd on the home abbr lines the `@`
    // up flush against both team names regardless of abbreviation
    // length — much cleaner than the prior left-pad-only formatting.
    const away = (g.away.abbr || '?').padStart(4);
    const home = (g.home.abbr || '?').padEnd(4);
    return (
      '`' + g.id.padStart(9) + '` ' +
      g.label.padEnd(4) + '  ' +
      away + '@' + home +
      '  ' + odds + '  ' + tag + fmtTime(g.date)
    );
  });
  return (
    '**Upcoming sports**\n```\nID         LEAGUE AWY@HOM   (ML AWAY/HOME)   TIME\n' +
    rows.join('\n') + '\n```\n' +
    'Place a bet with `/bet sports place game:<id> side:<home|away> bolts:<N>`.\n' +
    'Max stake 10% of wallet · 1.95× even-money or moneyline payout.'
  );
}

// Discord call site (handleBet) takes the string form. Web /web/bet/place
// reads the structured form; both share the same code path via runPlaceJson.
export async function runPlace(env, guildId, userId, args) {
  return (await runPlaceJson(env, guildId, userId, args)).message;
}

export async function runPlaceJson(env, guildId, userId, args) {
  // Bet kind defaults to moneyline for back-compat. Spreads/totals add
  // their own validation; parlays go through runPlaceParlayJson.
  const kind = String(args.kind || 'moneyline').toLowerCase().trim();
  if (kind === 'parlay') {
    return await runPlaceParlayJson(env, guildId, userId, args);
  }
  if (kind !== 'moneyline' && kind !== 'spread' && kind !== 'total') {
    return { ok: false, error: 'bad-kind', message: '`kind` must be moneyline, spread, total, or parlay.' };
  }

  const gameIdInput = String(args.game || '').trim();
  const side = String(args.side || '').toLowerCase().trim();
  const stake = Math.max(1, Math.floor(Number(args.bolts) || 0));

  // Per-kind side validation.
  if (kind === 'moneyline' || kind === 'spread') {
    if (side !== 'home' && side !== 'away') {
      return { ok: false, error: 'bad-side', message: '`side` must be `home` or `away`.' };
    }
  } else if (kind === 'total') {
    if (side !== 'over' && side !== 'under') {
      return { ok: false, error: 'bad-side', message: '`side` must be `over` or `under`.' };
    }
  }

  let games = await readGamesCache(env);
  if (games.length === 0) games = await refreshGamesCache(env);
  const g = findGame(games, gameIdInput);
  if (!g) return { ok: false, error: 'game-not-found', message: 'Game not found. Run `/bet sports list` to see the current IDs.' };
  if (g.state !== 'pre') return { ok: false, error: 'game-locked', message: 'That game is already in progress or finished.' };

  // Spread/total need the line to exist at place time so we can lock it.
  if (kind === 'spread' && typeof g.spread !== 'number') {
    return { ok: false, error: 'no-line', message: 'No spread published for this game yet — try moneyline or wait for the line.' };
  }
  if (kind === 'total' && typeof g.overUnder !== 'number') {
    return { ok: false, error: 'no-line', message: 'No game total published for this game yet — try moneyline or wait for the line.' };
  }

  const wallet = await getWallet(env, guildId, userId);
  const balance = wallet.balance || 0;
  const cap = Math.floor((balance * MAX_STAKE_PCT) / 100);
  if (cap < 1) return { ok: false, error: 'wallet-low', balance, cap, message: 'Your wallet is too low to bet. Earn some bolts first.' };
  if (stake > cap) {
    return { ok: false, error: 'over-stake-cap', balance, cap, message: 'Max stake is ' + MAX_STAKE_PCT + '% of your wallet (' + fmtBolts(cap) + ' bolts right now).' };
  }
  if (stake > balance) {
    return { ok: false, error: 'insufficient-bolts', balance, message: 'You only have ' + fmtBolts(balance) + ' bolts.' };
  }

  const r = await spend(env, guildId, userId, stake, 'bet-stake:' + g.id);
  if (!r || !r.ok) return { ok: false, error: 'wallet-error', message: "Couldn't debit stake: " + (r && r.reason || 'wallet error') + '.' };

  // Resolve locked odds + line. Moneyline locks the team's price.
  // Spread / total are conventionally priced at -110 American (1.91×)
  // when no per-side spreadOdds are published, which is what ESPN's
  // free feed gives us.
  let lockedOdds, lockedLine = null;
  if (kind === 'moneyline') {
    lockedOdds = side === 'home' ? g.home.odds : g.away.odds;
  } else if (kind === 'spread') {
    // Lock the line FROM THIS BETTOR'S POV — for the home side we lock
    // g.spread; for the away side we flip the sign. That keeps the
    // settlement math kind-agnostic (homeScore + bet.line vs awayScore
    // → did our team cover?).
    lockedLine = side === 'home' ? g.spread : -g.spread;
    lockedOdds = -110;
  } else { // total
    lockedLine = g.overUnder;
    lockedOdds = -110;
  }

  const betId = g.id + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const bet = {
    betId,
    gameId: g.id,
    sport: g.label,
    kind,                                  // 'moneyline' | 'spread' | 'total'
    side,                                  // home/away for ml+spread, over/under for total
    stake,
    lockedOdds: typeof lockedOdds === 'number' ? lockedOdds : null,
    lockedLine,                            // null for moneyline
    placedAt: Date.now(),
    guildId,
    userId,
  };
  const u = await getUserBets(env, guildId, userId);
  (u.active = u.active || []).push(bet);
  await putUserBets(env, guildId, userId, u);
  const open = await getOpenBets(env, g.id);
  open.push(bet);
  await putOpenBets(env, g.id, open);

  // PROGRESSION (P1) — bet placed.
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    await emitProgressionEvent(env, {
      kind: 'bet.placed', userId, guildId,
      meta: { betId, stake }, stableKeys: ['betId'],
    });
  } catch { /* non-fatal */ }

  const projected = computeWinPayout(stake, bet.lockedOdds);
  const newBalance = (r.wallet && r.wallet.balance) || (balance - stake);

  const message = formatPlaceMessage(g, bet, projected);
  const sideTeam = (kind === 'moneyline' || kind === 'spread')
    ? (side === 'home' ? g.home : g.away) : null;

  return {
    ok: true,
    betId,
    gameId: g.id,
    sport: g.label,
    kind,
    side,
    sideAbbr: sideTeam ? (sideTeam.abbr || null) : null,
    stake,
    lockedOdds: bet.lockedOdds,
    lockedLine,
    projectedPayout: projected,
    balance: newBalance,
    message,
  };
}

function formatPlaceMessage(g, bet, projected) {
  const sideTeam = (bet.kind === 'moneyline' || bet.kind === 'spread')
    ? (bet.side === 'home' ? g.home : g.away) : null;
  if (bet.kind === 'moneyline') {
    return (
      '🎲 Bet **' + fmtBolts(bet.stake) + ' bolts** on `' + (sideTeam.abbr || '?') +
      '` (' + bet.side + ') in ' + g.label + ' ' + g.name + '.\n' +
      'If they win you take **' + fmtBolts(projected) + ' bolts** ' +
      '(' + fmtOdds(bet.lockedOdds) + ' moneyline locked).'
    );
  }
  if (bet.kind === 'spread') {
    const line = bet.lockedLine;
    const lineStr = (line > 0 ? '+' : '') + line;
    return (
      '🎲 Bet **' + fmtBolts(bet.stake) + ' bolts** on `' + (sideTeam.abbr || '?') +
      '` ' + lineStr + ' in ' + g.label + ' ' + g.name + '.\n' +
      'If they cover, you take **' + fmtBolts(projected) + ' bolts** (-110 price locked).'
    );
  }
  if (bet.kind === 'total') {
    return (
      '🎲 Bet **' + fmtBolts(bet.stake) + ' bolts** on the **' + bet.side.toUpperCase() +
      ' ' + bet.lockedLine + '** in ' + g.label + ' ' + g.name + '.\n' +
      'If the total goes ' + bet.side + ' ' + bet.lockedLine + ', you take **' +
      fmtBolts(projected) + ' bolts** (-110 price locked).'
    );
  }
  return 'Bet placed.';
}

// ── Parlays ──────────────────────────────────────────────────────────
//
// Multi-leg ticket. All legs must hit (or push — push legs are dropped
// from the parlay rather than refunded; remaining legs still must hit).
// Combined payout is the product of each leg's decimal-odds multiplier
// minus the house-edge cut, all applied to the stake.
//
// Storage layout:
//   bets:parlay:<betId>  -> the parlay record
//   bets:parlay:active   -> list of open parlay betIds (for the cron tick)
//   bets:user:<g>:<u>    -> the user's active[] now includes parlay tickets
//                            distinguished by kind:'parlay'
//
// Legs are validated against the games cache at place time; each leg
// locks its own (odds, line) just like a solo bet would.

const PARLAY_ACTIVE_KEY = 'bets:parlay:active';
const PARLAY_MIN_LEGS = 2;
const PARLAY_MAX_LEGS = 10;
const PARLAY_KEY = (betId) => 'bets:parlay:' + betId;

async function listOpenParlayIds(env) {
  try {
    const d = await env.LOADOUT_BOLTS.get(PARLAY_ACTIVE_KEY, { type: 'json' });
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
async function addOpenParlayId(env, betId) {
  const cur = await listOpenParlayIds(env);
  if (cur.includes(betId)) return;
  cur.push(betId);
  await env.LOADOUT_BOLTS.put(PARLAY_ACTIVE_KEY, JSON.stringify(cur));
}
async function removeOpenParlayId(env, betId) {
  const cur = await listOpenParlayIds(env);
  const next = cur.filter((id) => id !== betId);
  if (next.length === cur.length) return;
  await env.LOADOUT_BOLTS.put(PARLAY_ACTIVE_KEY, JSON.stringify(next));
}

export function decimalOdds(americanOdds) {
  if (typeof americanOdds !== 'number' || !isFinite(americanOdds) || americanOdds === 0) {
    return 2.0;
  }
  return americanOdds >= 100
    ? 1 + americanOdds / 100
    : 1 + 100 / Math.abs(americanOdds);
}

export function parlayMultiplier(legs) {
  // Combined decimal odds = product of per-leg decimal odds.
  let m = 1;
  for (const leg of legs) m *= decimalOdds(leg.lockedOdds);
  return m;
}

export function parlayPayout(stake, legs) {
  const m = parlayMultiplier(legs);
  return Math.max(1, Math.floor(stake * m * (1 - HOUSE_EDGE)));
}

export async function runPlaceParlayJson(env, guildId, userId, args) {
  const stake = Math.max(1, Math.floor(Number(args.bolts) || 0));
  const rawLegs = Array.isArray(args.legs) ? args.legs : [];
  if (rawLegs.length < PARLAY_MIN_LEGS) {
    return { ok: false, error: 'too-few-legs', message: 'A parlay needs at least ' + PARLAY_MIN_LEGS + ' legs.' };
  }
  if (rawLegs.length > PARLAY_MAX_LEGS) {
    return { ok: false, error: 'too-many-legs', message: 'Max ' + PARLAY_MAX_LEGS + ' legs per parlay.' };
  }

  let games = await readGamesCache(env);
  if (games.length === 0) games = await refreshGamesCache(env);

  // Validate every leg + lock its line/odds. One failed leg rejects
  // the whole ticket (no partial debit).
  const legs = [];
  const usedGameIds = new Set();
  for (let i = 0; i < rawLegs.length; i++) {
    const raw = rawLegs[i];
    const kind = String(raw.kind || 'moneyline').toLowerCase();
    const side = String(raw.side || '').toLowerCase();
    const g = findGame(games, String(raw.game || '').trim());
    if (!g) return { ok: false, error: 'leg-game-not-found', leg: i, message: 'Leg ' + (i + 1) + ': game not found.' };
    if (g.state !== 'pre') return { ok: false, error: 'leg-game-locked', leg: i, message: 'Leg ' + (i + 1) + ': game already in progress / finished.' };
    if (usedGameIds.has(g.id)) {
      // Same game twice in one parlay = correlated legs, banned by every
      // book and us too.
      return { ok: false, error: 'duplicate-game', leg: i, message: 'Leg ' + (i + 1) + ': you already have another leg on this game.' };
    }
    usedGameIds.add(g.id);

    let lockedOdds, lockedLine = null;
    if (kind === 'moneyline') {
      if (side !== 'home' && side !== 'away') {
        return { ok: false, error: 'bad-side', leg: i, message: 'Leg ' + (i + 1) + ': side must be home/away.' };
      }
      lockedOdds = side === 'home' ? g.home.odds : g.away.odds;
      if (typeof lockedOdds !== 'number') {
        return { ok: false, error: 'no-moneyline', leg: i, message: 'Leg ' + (i + 1) + ': no moneyline published.' };
      }
    } else if (kind === 'spread') {
      if (side !== 'home' && side !== 'away') {
        return { ok: false, error: 'bad-side', leg: i, message: 'Leg ' + (i + 1) + ': side must be home/away.' };
      }
      if (typeof g.spread !== 'number') {
        return { ok: false, error: 'no-line', leg: i, message: 'Leg ' + (i + 1) + ': no spread published.' };
      }
      lockedLine = side === 'home' ? g.spread : -g.spread;
      lockedOdds = -110;
    } else if (kind === 'total') {
      if (side !== 'over' && side !== 'under') {
        return { ok: false, error: 'bad-side', leg: i, message: 'Leg ' + (i + 1) + ': side must be over/under.' };
      }
      if (typeof g.overUnder !== 'number') {
        return { ok: false, error: 'no-line', leg: i, message: 'Leg ' + (i + 1) + ': no game total published.' };
      }
      lockedLine = g.overUnder;
      lockedOdds = -110;
    } else {
      return { ok: false, error: 'bad-kind', leg: i, message: 'Leg ' + (i + 1) + ': kind must be moneyline/spread/total.' };
    }

    legs.push({
      gameId: g.id,
      sport: g.label,
      kind,
      side,
      lockedOdds,
      lockedLine,
      // Cosmetic snapshot — what the bettor saw at place time. Read-only
      // for the renderer.
      awayAbbr: g.away.abbr || null,
      homeAbbr: g.home.abbr || null,
      gameName: g.name || null,
      gameDate: g.date || null,
      // Resolved on settle: 'win' | 'loss' | 'push' | null.
      outcome: null,
      scoredAt: null,
    });
  }

  // Wallet checks against the SAME caps as a solo bet — parlays should
  // not give a way around them.
  const wallet = await getWallet(env, guildId, userId);
  const balance = wallet.balance || 0;
  const cap = Math.floor((balance * MAX_STAKE_PCT) / 100);
  if (cap < 1) return { ok: false, error: 'wallet-low', balance, cap, message: 'Your wallet is too low to bet.' };
  if (stake > cap) return { ok: false, error: 'over-stake-cap', balance, cap, message: 'Max stake is ' + MAX_STAKE_PCT + '% of your wallet (' + fmtBolts(cap) + ' right now).' };
  if (stake > balance) return { ok: false, error: 'insufficient-bolts', balance, message: 'You only have ' + fmtBolts(balance) + ' bolts.' };

  const r = await spend(env, guildId, userId, stake, 'parlay-stake');
  if (!r || !r.ok) return { ok: false, error: 'wallet-error', message: "Couldn't debit stake: " + (r && r.reason || 'wallet error') + '.' };

  const projected = parlayPayout(stake, legs);
  const betId = 'plr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const parlay = {
    betId,
    kind: 'parlay',
    stake,
    legs,
    projectedPayout: projected,
    placedAt: Date.now(),
    guildId,
    userId,
    status: 'open',         // 'open' | 'won' | 'lost' | 'refund'
    settledAt: null,
    payout: 0,
  };

  await env.LOADOUT_BOLTS.put(PARLAY_KEY(betId), JSON.stringify(parlay));
  await addOpenParlayId(env, betId);

  // Add to user's active[] with the same shape the renderer expects.
  const u = await getUserBets(env, guildId, userId);
  (u.active = u.active || []).push({
    betId, kind: 'parlay',
    stake, legs: legs.map(legSummary),
    projectedPayout: projected,
    placedAt: parlay.placedAt,
    guildId, userId,
  });
  await putUserBets(env, guildId, userId, u);

  const newBalance = (r.wallet && r.wallet.balance) || (balance - stake);
  const mult = parlayMultiplier(legs);
  return {
    ok: true,
    betId,
    kind: 'parlay',
    stake,
    legs: parlay.legs,
    combinedMultiplier: mult,
    projectedPayout: projected,
    balance: newBalance,
    message:
      '🎟 **' + legs.length + '-leg parlay** for ' + fmtBolts(stake) + ' bolts — ' +
      mult.toFixed(2) + '× combined. If all legs hit you take **' + fmtBolts(projected) + ' bolts**.',
  };
}

function legSummary(leg) {
  return {
    gameId: leg.gameId,
    sport: leg.sport,
    kind: leg.kind,
    side: leg.side,
    lockedOdds: leg.lockedOdds,
    lockedLine: leg.lockedLine,
    awayAbbr: leg.awayAbbr,
    homeAbbr: leg.homeAbbr,
    gameName: leg.gameName,
    gameDate: leg.gameDate,
    outcome: leg.outcome,
  };
}

// Settle a single non-parlay bet against the finished game `g`.
// Returns { outcome: 'win'|'loss'|'push'|'refund', payout }.
export function settleSoloBet(bet, g) {
  const homeScore = g.home.score != null ? Number(g.home.score) : 0;
  const awayScore = g.away.score != null ? Number(g.away.score) : 0;

  if (bet.kind === 'spread') {
    // Apply the bet's locked line to ITS team's score. For home-side
    // bettors the locked line is g.spread; for away-side it's -g.spread
    // (set at place time). A bet "covers" if their adjusted score is
    // strictly greater than the opponent's.
    const myScore = bet.side === 'home' ? homeScore : awayScore;
    const oppScore = bet.side === 'home' ? awayScore : homeScore;
    const adjusted = myScore + (bet.lockedLine || 0);
    if (adjusted > oppScore) return { outcome: 'win', payout: computeWinPayout(bet.stake, bet.lockedOdds) };
    if (adjusted < oppScore) return { outcome: 'loss', payout: 0 };
    return { outcome: 'push', payout: bet.stake };   // refund stake
  }

  if (bet.kind === 'total') {
    const total = homeScore + awayScore;
    if (typeof bet.lockedLine !== 'number') return { outcome: 'refund', payout: bet.stake };
    if (total > bet.lockedLine) {
      return bet.side === 'over'
        ? { outcome: 'win', payout: computeWinPayout(bet.stake, bet.lockedOdds) }
        : { outcome: 'loss', payout: 0 };
    }
    if (total < bet.lockedLine) {
      return bet.side === 'under'
        ? { outcome: 'win', payout: computeWinPayout(bet.stake, bet.lockedOdds) }
        : { outcome: 'loss', payout: 0 };
    }
    return { outcome: 'push', payout: bet.stake };
  }

  // moneyline (default + legacy)
  let winnerSide = null;
  if (homeScore > awayScore) winnerSide = 'home';
  else if (awayScore > homeScore) winnerSide = 'away';
  if (winnerSide === null) return { outcome: 'refund', payout: bet.stake };
  if (bet.side === winnerSide) return { outcome: 'win', payout: computeWinPayout(bet.stake, bet.lockedOdds) };
  return { outcome: 'loss', payout: 0 };
}

export async function renderActive(env, guildId, userId) {
  const u = await getUserBets(env, guildId, userId);
  const active = u.active || [];
  if (active.length === 0) return 'No active bets. Run `/bet sports list` to find a game.';
  const rows = active.map((b) => {
    const projected = computeWinPayout(b.stake, b.lockedOdds);
    return (
      '`' + b.gameId.padStart(9) + '` ' + b.sport.padEnd(4) + ' ' +
      b.side.padEnd(5) + '  stake ' + fmtBolts(b.stake) +
      '  to win ' + fmtBolts(projected) + '  ' + fmtOdds(b.lockedOdds)
    );
  });
  return '**Active bets**\n```\n' + rows.join('\n') + '\n```';
}

export async function renderHistory(env, guildId, userId) {
  const u = await getUserBets(env, guildId, userId);
  const hist = (u.history || []).slice(-20).reverse();
  if (hist.length === 0) return 'No settled bets yet.';
  const rows = hist.map((b) => {
    const outcome = b.outcome === 'win' ? '✅ +' + fmtBolts(b.payout)
                  : b.outcome === 'refund' ? '↩ refund'
                  : '❌ -' + fmtBolts(b.stake);
    return (
      '`' + b.gameId.padStart(9) + '` ' + b.sport.padEnd(4) + ' ' +
      b.side.padEnd(5) + '  ' + outcome
    );
  });
  return '**Last ' + hist.length + ' settled bets**\n```\n' + rows.join('\n') + '\n```';
}

// PROGRESSION (P2) — betting headline. Account-wide.
export async function getStatsFor(env, userId, _guildId = null) {
  let active = 0, settled = 0, wins = 0, losses = 0, totalStaked = 0, totalWon = 0;
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'bets:user:', cursor, limit: 1000 });
    for (const k of r.keys) {
      if (!k.name.endsWith(':' + userId)) continue;
      const u = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!u) continue;
      active += (u.active || []).length;
      for (const h of (u.history || [])) {
        settled++;
        totalStaked += h.stake || 0;
        if (h.outcome === 'win') { wins++; totalWon += h.payout || 0; }
        else if (h.outcome === 'lose') losses++;
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  const winRate = settled > 0 ? Math.round((wins / settled) * 100) : 0;
  return {
    primary: { label: 'W/L', value: `${wins}-${losses}` },
    secondary: [
      { label: 'Active', value: active },
      { label: 'Win rate', value: winRate + '%' },
      { label: 'Net', value: totalWon - totalStaked },
    ],
    iconKind: 'bet-ticket',
  };
}
