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

import { spend, earn, getWallet } from './wallet.js';
import { noteTeamsFromGames, findSubscribersForGame } from './hub-menu.js';

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

async function fetchLeague(sport, league) {
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
  return {
    id: String(ev.id),
    label,
    name: ev.name || `${away.team.displayName} at ${home.team.displayName}`,
    date: ev.date,
    state: (status && status.state) || 'pre',     // pre | in | post
    completed: !!(status && status.completed),
    statusName: (status && status.name) || '',
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
    // Determine winner: highest score wins, tie = refund.
    const homeScore = g.home.score != null ? g.home.score : 0;
    const awayScore = g.away.score != null ? g.away.score : 0;
    let winnerSide = null; // 'home' | 'away' | null (tie/postponed)
    if (homeScore > awayScore) winnerSide = 'home';
    else if (awayScore > homeScore) winnerSide = 'away';

    for (const bet of bets) {
      try {
        if (winnerSide === null) {
          // Refund stake.
          await earn(env, bet.guildId, bet.userId, bet.stake, 'bet-refund:' + gid);
          await recordSettled(env, bet, 'refund', bet.stake);
        } else if (bet.side === winnerSide) {
          const payout = computeWinPayout(bet.stake, bet.lockedOdds);
          await earn(env, bet.guildId, bet.userId, payout, 'bet-win:' + gid);
          await recordSettled(env, bet, 'win', payout);
        } else {
          // Loss — stake already debited at place time.
          await recordSettled(env, bet, 'loss', 0);
        }
        settled++;
      } catch { /* skip; next tick retries */ }
    }
    await putOpenBets(env, gid, []);
  }
  return { games: games.length, settled };
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
      '**Tip-off:** ' + fmtTime(g.date) + oddsLine + '\n\n' +
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
}

// ---- Slash command dispatcher ------------------------------------------

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

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
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

export async function runPlace(env, guildId, userId, args) {
  const gameIdInput = String(args.game || '').trim();
  const side = String(args.side || '').toLowerCase().trim();
  const stake = Math.max(1, Math.floor(Number(args.bolts) || 0));
  if (side !== 'home' && side !== 'away') {
    return '`side` must be `home` or `away`.';
  }
  let games = await readGamesCache(env);
  if (games.length === 0) games = await refreshGamesCache(env);
  const g = findGame(games, gameIdInput);
  if (!g) return 'Game not found. Run `/bet sports list` to see the current IDs.';
  if (g.state !== 'pre') return 'That game is already in progress or finished.';
  const wallet = await getWallet(env, guildId, userId);
  const balance = wallet.balance || 0;
  const cap = Math.floor((balance * MAX_STAKE_PCT) / 100);
  if (cap < 1) return 'Your wallet is too low to bet. Earn some bolts first.';
  if (stake > cap) {
    return 'Max stake is ' + MAX_STAKE_PCT + '% of your wallet (' + fmtBolts(cap) + ' bolts right now).';
  }
  if (stake > balance) {
    return 'You only have ' + fmtBolts(balance) + ' bolts.';
  }
  // Debit stake up front; settlement returns either a win payout or
  // a stake refund (push). Loss = nothing returned.
  const r = await spend(env, guildId, userId, stake, 'bet-stake:' + g.id);
  if (!r || !r.ok) return "Couldn't debit stake: " + (r && r.reason || 'wallet error') + '.';
  const lockedOdds = side === 'home' ? g.home.odds : g.away.odds;
  const betId = g.id + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const bet = {
    betId,
    gameId: g.id,
    sport: g.label,
    side,
    stake,
    lockedOdds: typeof lockedOdds === 'number' ? lockedOdds : null,
    placedAt: Date.now(),
    guildId,
    userId,
  };
  // Index by user (active) + by game (open).
  const u = await getUserBets(env, guildId, userId);
  (u.active = u.active || []).push(bet);
  await putUserBets(env, guildId, userId, u);
  const open = await getOpenBets(env, g.id);
  open.push(bet);
  await putOpenBets(env, g.id, open);
  const projected = computeWinPayout(stake, bet.lockedOdds);
  const sideTeam = side === 'home' ? g.home : g.away;
  return (
    '🎲 Bet **' + fmtBolts(stake) + ' bolts** on `' + (sideTeam.abbr || '?') +
    '` (' + side + ') in ' + g.label + ' ' + g.name + '.\n' +
    'If they win you take **' + fmtBolts(projected) + ' bolts** ' +
    '(' + fmtOdds(bet.lockedOdds) + ' moneyline locked).'
  );
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
