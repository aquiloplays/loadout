// /hub — viewer-facing entry hub. Every interaction is ephemeral and
// component-driven; viewers should never need to type a slash command.
//
// Component routing prefix: "hub:" — extended paths:
//   hub:home
//   hub:loadout                       drilldown (uses lo:* for deep flows)
//   hub:stocks                        drilldown
//   hub:stocks:list:p:N               paginated ticker list
//   hub:stocks:portfolio              user portfolio
//   hub:stocks:buyprompt              -> opens hub:modal:stocks-buy
//   hub:stocks:sellprompt             -> opens hub:modal:stocks-sell
//   hub:stocks:chartprompt            -> opens hub:modal:stocks-chart
//   hub:sports                        drilldown
//   hub:sports:upcoming:p:N           paginated game list w/ inline bet buttons
//   hub:sports:active                 active bets
//   hub:sports:history                last 20 settled
//   hub:sports:bet:<side>:<gameId>    -> opens hub:modal:sports-bet:<side>:<gameId>
//   hub:sports:subs                   subscriptions view
//   hub:sports:subs:toggle:<league>   toggle league sub
//   hub:sports:subs:teamprompt        -> opens hub:modal:teamsearch
//   hub:sports:subs:teamtoggle        select-menu interaction toggle
//   hub:sports:subs:clearteams        clear all team subs
//   hub:sports:mute:<league>          quick-mute from feed embed (public source)
//   hub:profile
//   hub:help
//
// Modals (custom_id starts with "hub:modal:"):
//   hub:modal:stocks-buy
//   hub:modal:stocks-sell
//   hub:modal:stocks-chart
//   hub:modal:sports-bet:<side>:<gameId>
//   hub:modal:teamsearch

import { getWallet } from './wallet.js';
import {
  getCatalog as stocksGetCatalog,
  getPrice as stocksGetPrice,
  getHistory as stocksGetHistory,
  getHoldings as stocksGetHoldings,
  renderStocksList,
  runBuy as stocksRunBuy,
  runSell as stocksRunSell,
  renderPortfolio as stocksRenderPortfolio,
  renderChart as stocksRenderChart,
} from './stocks.js';
import {
  readGamesCache,
  refreshGamesCache,
  findGame,
  computeWinPayout,
  runPlace as betRunPlace,
  renderActive as betRenderActive,
  renderHistory as betRenderHistory,
} from './bet.js';

// ---- Discord protocol constants ----------------------------------------

const RESP_CHAT             = 4;
const RESP_DEFER_UPDATE     = 6;
const RESP_UPDATE_MESSAGE   = 7;
const RESP_MODAL            = 9;
const FLAG_EPHEMERAL        = 1 << 6;

const COMPONENT_ROW        = 1;
const COMPONENT_BUTTON     = 2;
const COMPONENT_STRING_SEL = 3;
const COMPONENT_TEXT_INPUT = 4;

const STYLE_PRIMARY    = 1;
const STYLE_SECONDARY  = 2;
const STYLE_SUCCESS    = 3;
const STYLE_DANGER     = 4;
const STYLE_LINK       = 5;

const INPUT_SHORT      = 1;

const STOCKS_PAGE_SIZE = 10;
const SPORTS_PAGE_SIZE = 4;  // 4 games × 2 buttons + pagination row fits the 5-row limit
const LEAGUES_FOR_SUBS = ['nfl', 'nba', 'mlb', 'nhl'];

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Decide between UPDATE_MESSAGE (when the source is the user's own
// ephemeral message) vs a fresh ephemeral reply (when the source is a
// public-channel post — e.g. the bet feed). Discord won't let us
// UPDATE_MESSAGE a public post into something only one user sees.
function updateOrFollowup(sourceFlags, data) {
  const isEphemeralSource = ((sourceFlags || 0) & FLAG_EPHEMERAL) !== 0;
  if (isEphemeralSource) {
    return json({ type: RESP_UPDATE_MESSAGE, data });
  }
  return json({ type: RESP_CHAT, data: { ...data, flags: FLAG_EPHEMERAL } });
}

function chatReply(content, components) {
  const data = { content, flags: FLAG_EPHEMERAL };
  if (components) data.components = components;
  return json({ type: RESP_CHAT, data });
}

function backRow(target) {
  return {
    type: COMPONENT_ROW,
    components: [
      { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back', custom_id: target || 'hub:home' },
    ],
  };
}

function fmtBolts(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ---- Root --------------------------------------------------------------

function rootView() {
  return {
    embeds: [{
      title: '🌐 Aquilo Hub',
      description:
        'Everything Aquilo, in one place. Pick a section — every flow is ephemeral so only you see it.',
      color: 0x3a86ff,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY, label: '💼 Loadout', custom_id: 'hub:loadout' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY, label: '🏈 Sports',  custom_id: 'hub:sports'  },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '👤 Profile', custom_id: 'hub:profile' },
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '❓ Help',    custom_id: 'hub:help'    },
        ],
      },
    ],
  };
}

export async function renderHubCommand(env, guild, userId) {
  return { type: RESP_CHAT, data: { ...rootView(), flags: FLAG_EPHEMERAL } };
}

// ---- Loadout drilldown -------------------------------------------------
// Uses lo:* component ids for the deep flows so we reuse loadout-menu.js
// instead of duplicating its logic. Back button returns to hub root.

async function loadoutView(env, guild, userId) {
  const w = await getWallet(env, guild, userId);
  return {
    embeds: [{
      title: '💼 Loadout',
      description:
        '**Wallet:** ' + fmtBolts(w.balance || 0) + ' bolts\n' +
        '**Daily streak:** ' + (w.dailyStreak || 0) + ' day(s)\n' +
        '**Lifetime earned:** ' + fmtBolts(w.lifetimeEarned || 0) + '\n\n' +
        'Pick an action. The hero / bag / shop drill-downs use the existing menu flow.',
      color: 0x46d160,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '💰 Daily', custom_id: 'lo:daily' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '⚔ Hero',  custom_id: 'lo:hero' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '🎒 Bag',   custom_id: 'lo:inventory' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '🛒 Shop',  custom_id: 'lo:shop' },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '🎲 Play',  custom_id: 'lo:play' },
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '✉ Gift',  custom_id: 'lo:gift' },
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back',  custom_id: 'hub:home' },
        ],
      },
    ],
  };
}

// ---- Stocks ------------------------------------------------------------

async function stocksView(env, guild, userId) {
  const holdings = await stocksGetHoldings(env, guild, userId);
  const heldTickers = Object.keys(holdings).filter((k) => (Number(holdings[k]) || 0) > 0);
  let total = 0;
  const lines = [];
  // Compute total value + top-3 by value.
  const valued = [];
  for (const t of heldTickers) {
    const rec = await stocksGetPrice(env, t);
    const price = rec ? rec.price : 0;
    const shares = Number(holdings[t]) || 0;
    const value = price * shares;
    total += value;
    valued.push({ t, shares, price, value });
  }
  valued.sort((a, b) => b.value - a.value);
  for (const v of valued.slice(0, 3)) {
    lines.push('`' + v.t.padEnd(6) + '` ' + v.shares + ' @ ' + v.price + ' = ' + fmtBolts(v.value));
  }
  const desc =
    (lines.length > 0
      ? '**Top holdings**\n' + lines.join('\n') + '\n\n'
      : 'No holdings yet.\n\n') +
    '**Total portfolio:** ' + fmtBolts(total) + ' bolts';
  return {
    embeds: [{ title: '📈 Stocks', description: desc, color: 0x3a86ff }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '📋 List all',  custom_id: 'hub:stocks:list:p:1' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '📊 Portfolio', custom_id: 'hub:stocks:portfolio' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '📈 Chart',     custom_id: 'hub:stocks:chartprompt' },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SUCCESS,   label: '🛒 Buy',  custom_id: 'hub:stocks:buyprompt' },
          { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '💸 Sell', custom_id: 'hub:stocks:sellprompt' },
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back', custom_id: 'hub:home' },
        ],
      },
    ],
  };
}

async function stocksListPaged(env, page) {
  const catalog = await stocksGetCatalog(env);
  const tickers = catalog.tickers || [];
  const totalPages = Math.max(1, Math.ceil(tickers.length / STOCKS_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const slice = tickers.slice((p - 1) * STOCKS_PAGE_SIZE, p * STOCKS_PAGE_SIZE);
  const rows = [];
  for (const t of slice) {
    const rec = await stocksGetPrice(env, t.ticker);
    const hist = await stocksGetHistory(env, t.ticker);
    const price = rec ? rec.price : null;
    const change = pctChange(hist);
    const sign = change == null ? '' : (change >= 0 ? '+' : '');
    const cstr = change == null ? '—' : (sign + change.toFixed(1) + '%');
    rows.push(
      '`' + String(t.ticker).padEnd(6) + '` ' +
      (price == null ? '—'.padStart(6) : String(price).padStart(6)) + '  ' +
      cstr.padStart(7) + '   ' + t.name,
    );
  }
  return {
    embeds: [{
      title: '📋 All tickers — page ' + p + '/' + totalPages,
      description: '```\nTICKER PRICE   24H Δ    NAME\n' + (rows.length ? rows.join('\n') : '(no tickers)') + '\n```',
      color: 0x3a86ff,
    }],
    components: [
      paginationRow('hub:stocks:list:p:', p, totalPages),
      backRow('hub:stocks'),
    ],
  };
}

function paginationRow(prefix, page, totalPages) {
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  return {
    type: COMPONENT_ROW,
    components: [
      { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Prev', custom_id: prefix + (page - 1), disabled: prevDisabled },
      { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: page + ' / ' + totalPages, custom_id: prefix + 'noop', disabled: true },
      { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: 'Next ▶', custom_id: prefix + (page + 1), disabled: nextDisabled },
    ],
  };
}

function pctChange(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const slice = history.slice(-24);
  const first = slice[0].price;
  const last = slice[slice.length - 1].price;
  if (!first) return null;
  return ((last - first) / first) * 100;
}

async function stocksPortfolioView(env, guild, userId) {
  const content = await stocksRenderPortfolio(env, guild, userId);
  return {
    embeds: [{ title: '📊 Portfolio', description: content, color: 0x3a86ff }],
    components: [backRow('hub:stocks')],
  };
}

function buyModal() {
  return {
    type: RESP_MODAL,
    data: {
      custom_id: 'hub:modal:stocks-buy',
      title: 'Buy stock',
      components: [
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT, custom_id: 'ticker', label: 'Ticker (e.g. AAPL)',
            style: INPUT_SHORT, required: true, min_length: 1, max_length: 8,
          }],
        },
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT, custom_id: 'bolts', label: 'Bolts to spend',
            style: INPUT_SHORT, required: true, placeholder: '100',
          }],
        },
      ],
    },
  };
}

function sellModal() {
  return {
    type: RESP_MODAL,
    data: {
      custom_id: 'hub:modal:stocks-sell',
      title: 'Sell stock',
      components: [
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT, custom_id: 'ticker', label: 'Ticker',
            style: INPUT_SHORT, required: true, min_length: 1, max_length: 8,
          }],
        },
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT, custom_id: 'shares', label: 'Shares to sell',
            style: INPUT_SHORT, required: true, placeholder: '1',
          }],
        },
      ],
    },
  };
}

function chartModal() {
  return {
    type: RESP_MODAL,
    data: {
      custom_id: 'hub:modal:stocks-chart',
      title: 'Chart a ticker',
      components: [
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT, custom_id: 'ticker', label: 'Ticker',
            style: INPUT_SHORT, required: true, min_length: 1, max_length: 8,
          }],
        },
      ],
    },
  };
}

// ---- Sports ------------------------------------------------------------

async function sportsView(env) {
  let games = await readGamesCache(env);
  if (games.length === 0) {
    try { games = await refreshGamesCache(env); } catch { games = []; }
  }
  const now = Date.now();
  const upcoming = games
    .filter((g) => g.state === 'pre' && g.date && new Date(g.date).getTime() > now)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 2);
  const preview = upcoming.length
    ? upcoming
        .map((g) =>
          '• ' + g.label + ': **' + (g.away.abbr || '?') + '** @ **' +
          (g.home.abbr || '?') + '** — ' + fmtTimeShort(g.date),
        )
        .join('\n')
    : 'No upcoming games in the cache yet.';
  return {
    embeds: [{
      title: '🏈 Sports',
      description: '**Soon**\n' + preview + '\n\nBet on NFL · NBA · MLB · NHL games.',
      color: 0xff6ab5,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '📅 Upcoming',     custom_id: 'hub:sports:upcoming:p:1' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '🎯 Active bets',  custom_id: 'hub:sports:active' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '📜 History',      custom_id: 'hub:sports:history' },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '🔔 Subscriptions', custom_id: 'hub:sports:subs' },
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back',           custom_id: 'hub:home' },
        ],
      },
    ],
  };
}

// Discord dynamic timestamp — auto-localizes per viewer. `:F` is the
// full date-time, `:R` is the relative offset ("in 3 hours"). Combined
// they read well inside an embed description. Avoid putting these
// inside code blocks — they only render outside ```.
function fmtTimeShort(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (!isFinite(ms)) return '';
  const u = Math.floor(ms / 1000);
  return '<t:' + u + ':F> (<t:' + u + ':R>)';
}

async function sportsUpcomingPaged(env, page) {
  let games = await readGamesCache(env);
  if (games.length === 0) {
    try { games = await refreshGamesCache(env); } catch { games = []; }
  }
  const now = Date.now();
  const upcoming = games
    .filter((g) => (g.state === 'pre' || g.state === 'in') &&
                   g.date && new Date(g.date).getTime() - now < 48 * 60 * 60 * 1000 &&
                   new Date(g.date).getTime() - now > -60 * 60 * 1000)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const totalPages = Math.max(1, Math.ceil(upcoming.length / SPORTS_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const slice = upcoming.slice((p - 1) * SPORTS_PAGE_SIZE, p * SPORTS_PAGE_SIZE);
  const components = [];
  const rows = [];
  for (const g of slice) {
    const awayLbl = '✈ Bet ' + (g.away.abbr || '?');
    const homeLbl = '🏠 Bet ' + (g.home.abbr || '?');
    components.push({
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: homeLbl,
          custom_id: 'hub:sports:bet:home:' + g.id },
        { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: awayLbl,
          custom_id: 'hub:sports:bet:away:' + g.id },
      ],
    });
    rows.push(
      '`' + g.id.padStart(9) + '` ' + g.label + ' · **' +
      (g.away.abbr || '?') + '** @ **' + (g.home.abbr || '?') + '** · ' +
      fmtTimeShort(g.date),
    );
  }
  components.push(paginationRow('hub:sports:upcoming:p:', p, totalPages));
  components.push(backRow('hub:sports'));
  return {
    embeds: [{
      title: '📅 Upcoming — page ' + p + '/' + totalPages,
      description: rows.length ? rows.join('\n') : 'No upcoming games in the window.',
      color: 0xff6ab5,
    }],
    components,
  };
}

function sportsBetModal(side, gameId) {
  return {
    type: RESP_MODAL,
    data: {
      custom_id: 'hub:modal:sports-bet:' + side + ':' + gameId,
      title: 'Place bet — ' + (side === 'home' ? 'Home' : 'Away'),
      components: [
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT, custom_id: 'bolts', label: 'Bolts to wager',
            style: INPUT_SHORT, required: true, placeholder: '50',
          }],
        },
      ],
    },
  };
}

async function sportsActiveView(env, guild, userId) {
  const content = await betRenderActive(env, guild, userId);
  return {
    embeds: [{ title: '🎯 Active bets', description: content, color: 0xff6ab5 }],
    components: [backRow('hub:sports')],
  };
}

async function sportsHistoryView(env, guild, userId) {
  const content = await betRenderHistory(env, guild, userId);
  return {
    embeds: [{ title: '📜 Bet history', description: content, color: 0xff6ab5 }],
    components: [backRow('hub:sports')],
  };
}

// ---- Subscriptions -----------------------------------------------------

const LEAGUES_KEY = (userId) => 'sports:subs:user:' + userId + ':leagues';
const TEAMS_KEY   = (userId) => 'sports:subs:user:' + userId + ':teams';
const LEAGUE_INDEX_KEY = (league) => 'sports:subs:league:' + league;
const TEAM_INDEX_KEY   = (league, teamId) => 'sports:subs:team:' + league + ':' + teamId;
const TEAM_REGISTRY_KEY = 'sports:teams:registry';

async function getUserLeagueSubs(env, userId) {
  try {
    const d = await env.LOADOUT_BOLTS.get(LEAGUES_KEY(userId), { type: 'json' });
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function getUserTeamSubs(env, userId) {
  try {
    const d = await env.LOADOUT_BOLTS.get(TEAMS_KEY(userId), { type: 'json' });
    return Array.isArray(d) ? d : []; // each entry: "league:teamId"
  } catch { return []; }
}

async function setUserLeagueSubs(env, userId, list) {
  await env.LOADOUT_BOLTS.put(LEAGUES_KEY(userId), JSON.stringify(list));
}

async function setUserTeamSubs(env, userId, list) {
  await env.LOADOUT_BOLTS.put(TEAMS_KEY(userId), JSON.stringify(list));
}

async function getIndex(env, key) {
  try {
    const d = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function putIndex(env, key, list) {
  if (list.length === 0) {
    try { await env.LOADOUT_BOLTS.delete(key); } catch { /* idle */ }
    return;
  }
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(list));
}

async function indexAdd(env, key, userId) {
  const list = await getIndex(env, key);
  if (!list.includes(userId)) {
    list.push(userId);
    await putIndex(env, key, list);
  }
}

async function indexRemove(env, key, userId) {
  const list = await getIndex(env, key);
  const filtered = list.filter((u) => u !== userId);
  await putIndex(env, key, filtered);
}

export async function toggleLeagueSub(env, userId, league) {
  const list = await getUserLeagueSubs(env, userId);
  let newList;
  if (list.includes(league)) {
    newList = list.filter((l) => l !== league);
    await indexRemove(env, LEAGUE_INDEX_KEY(league), userId);
  } else {
    newList = [...list, league];
    await indexAdd(env, LEAGUE_INDEX_KEY(league), userId);
  }
  await setUserLeagueSubs(env, userId, newList);
  return newList;
}

async function toggleTeamSub(env, userId, league, teamId) {
  const key = league + ':' + teamId;
  const list = await getUserTeamSubs(env, userId);
  let newList;
  if (list.includes(key)) {
    newList = list.filter((t) => t !== key);
    await indexRemove(env, TEAM_INDEX_KEY(league, teamId), userId);
  } else {
    newList = [...list, key];
    await indexAdd(env, TEAM_INDEX_KEY(league, teamId), userId);
  }
  await setUserTeamSubs(env, userId, newList);
  return newList;
}

async function clearAllTeamSubs(env, userId) {
  const list = await getUserTeamSubs(env, userId);
  for (const entry of list) {
    const [league, teamId] = entry.split(':');
    if (league && teamId) await indexRemove(env, TEAM_INDEX_KEY(league, teamId), userId);
  }
  await setUserTeamSubs(env, userId, []);
}

// Reverse-lookup: for a game, return the union of user IDs who'd want
// a ping. Caller dedupes.
export async function findSubscribersForGame(env, league, awayId, homeId) {
  const set = new Set();
  const lg = await getIndex(env, LEAGUE_INDEX_KEY(league.toLowerCase()));
  lg.forEach((u) => set.add(u));
  const tA = await getIndex(env, TEAM_INDEX_KEY(league.toLowerCase(), awayId));
  tA.forEach((u) => set.add(u));
  const tH = await getIndex(env, TEAM_INDEX_KEY(league.toLowerCase(), homeId));
  tH.forEach((u) => set.add(u));
  return Array.from(set);
}

// One-shot warm-up: pulls every team in each of the four leagues
// from ESPN's teams endpoint and populates the registry so the
// subscription search modal works the moment the cron runs, instead
// of waiting hours for games to surface teams. Idempotent + guarded
// by a sentinel so we only hit ESPN's teams endpoint once per
// league per deploy.
const TEAM_SEED_KEY = 'sports:teams:seeded';

export async function seedTeamRegistry(env) {
  let seeded;
  try { seeded = await env.LOADOUT_BOLTS.get(TEAM_SEED_KEY, { type: 'json' }); }
  catch { seeded = null; }
  if (!seeded || typeof seeded !== 'object') seeded = {};

  const sources = [
    { sport: 'football',   league: 'nfl' },
    { sport: 'basketball', league: 'nba' },
    { sport: 'baseball',   league: 'mlb' },
    { sport: 'hockey',     league: 'nhl' },
  ];

  let reg;
  try { reg = await env.LOADOUT_BOLTS.get(TEAM_REGISTRY_KEY, { type: 'json' }); }
  catch { reg = null; }
  if (!reg || typeof reg !== 'object') reg = {};

  let changed = false;
  for (const s of sources) {
    if (seeded[s.league]) continue;
    try {
      const res = await fetch(
        'https://site.api.espn.com/apis/site/v2/sports/' + s.sport + '/' + s.league + '/teams',
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aquilo-sports/1.0)' } },
      );
      if (!res.ok) continue;
      const d = await res.json();
      const teams = (d && d.sports && d.sports[0] && d.sports[0].leagues &&
                     d.sports[0].leagues[0] && d.sports[0].leagues[0].teams) || [];
      if (!Array.isArray(reg[s.league])) reg[s.league] = [];
      for (const wrap of teams) {
        const t = wrap && wrap.team;
        if (!t || !t.id) continue;
        const id = String(t.id);
        if (reg[s.league].find((x) => x.id === id)) continue;
        reg[s.league].push({
          id,
          abbr: t.abbreviation || '',
          name: t.displayName || t.shortDisplayName || t.abbreviation || id,
        });
        changed = true;
      }
      seeded[s.league] = Date.now();
    } catch { /* skip — next cron retries */ }
  }
  if (changed) {
    await env.LOADOUT_BOLTS.put(TEAM_REGISTRY_KEY, JSON.stringify(reg));
  }
  await env.LOADOUT_BOLTS.put(TEAM_SEED_KEY, JSON.stringify(seeded));
}

// Cron-time helper: capture every team we see, so the team-search
// modal has something to match against.
export async function noteTeamsFromGames(env, games) {
  let reg;
  try { reg = await env.LOADOUT_BOLTS.get(TEAM_REGISTRY_KEY, { type: 'json' }); }
  catch { reg = null; }
  if (!reg || typeof reg !== 'object') reg = {};
  let changed = false;
  for (const g of games) {
    const lg = g.label.toLowerCase();
    if (!Array.isArray(reg[lg])) reg[lg] = [];
    for (const side of [g.away, g.home]) {
      if (!side || !side.id) continue;
      const exists = reg[lg].find((t) => t.id === side.id);
      if (!exists) {
        reg[lg].push({ id: side.id, abbr: side.abbr || '', name: side.name || side.abbr || '' });
        changed = true;
      }
    }
  }
  if (changed) {
    await env.LOADOUT_BOLTS.put(TEAM_REGISTRY_KEY, JSON.stringify(reg));
  }
}

async function getTeamRegistry(env) {
  try {
    const r = await env.LOADOUT_BOLTS.get(TEAM_REGISTRY_KEY, { type: 'json' });
    return (r && typeof r === 'object') ? r : {};
  } catch { return {}; }
}

async function subsView(env, userId) {
  const subbedLeagues = await getUserLeagueSubs(env, userId);
  const subbedTeams = await getUserTeamSubs(env, userId);
  const reg = await getTeamRegistry(env);
  const teamLines = subbedTeams.length
    ? subbedTeams.slice(0, 12).map((entry) => {
        const [lg, tid] = entry.split(':');
        const team = (reg[lg] || []).find((t) => t.id === tid);
        return '• ' + (lg.toUpperCase()) + ' — ' + (team ? team.name : tid);
      }).join('\n')
    : '_no teams subscribed_';
  const desc =
    '**Leagues** — toggle below\n' +
    LEAGUES_FOR_SUBS.map((l) =>
      '• ' + l.toUpperCase() + ' ' + (subbedLeagues.includes(l) ? '✓' : '✗'),
    ).join('\n') +
    '\n\n**Teams** (' + subbedTeams.length + ' subscribed)\n' + teamLines;
  return {
    embeds: [{ title: '🔔 Subscriptions', description: desc, color: 0xff6ab5 }],
    components: [
      {
        type: COMPONENT_ROW,
        components: LEAGUES_FOR_SUBS.map((l) => ({
          type: COMPONENT_BUTTON,
          style: subbedLeagues.includes(l) ? STYLE_SUCCESS : STYLE_SECONDARY,
          label: l.toUpperCase() + (subbedLeagues.includes(l) ? ' ✓' : ''),
          custom_id: 'hub:sports:subs:toggle:' + l,
        })),
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '🔎 Manage teams',  custom_id: 'hub:sports:subs:teamprompt' },
          { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '🗑 Clear teams',  custom_id: 'hub:sports:subs:clearteams' },
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back',           custom_id: 'hub:sports' },
        ],
      },
    ],
  };
}

function teamSearchModal() {
  return {
    type: RESP_MODAL,
    data: {
      custom_id: 'hub:modal:teamsearch',
      title: 'Search for a team',
      components: [
        {
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT, custom_id: 'q', label: 'Team name or abbr (e.g. Lakers, BOS)',
            style: INPUT_SHORT, required: true, min_length: 2, max_length: 30,
          }],
        },
      ],
    },
  };
}

async function teamSearchResults(env, userId, q) {
  const reg = await getTeamRegistry(env);
  const subs = new Set(await getUserTeamSubs(env, userId));
  const needle = q.toLowerCase().trim();
  const matches = [];
  for (const lg of Object.keys(reg)) {
    for (const t of reg[lg]) {
      const hay = ((t.name || '') + ' ' + (t.abbr || '')).toLowerCase();
      if (hay.includes(needle)) {
        const value = lg + ':' + t.id;
        matches.push({
          label: lg.toUpperCase() + ' · ' + (t.name || t.abbr) + (subs.has(value) ? ' ✓' : ''),
          value,
        });
      }
      if (matches.length >= 25) break;
    }
    if (matches.length >= 25) break;
  }
  if (matches.length === 0) {
    return {
      embeds: [{
        title: '🔎 Team search',
        description: 'No teams found matching "' + q + '". The registry grows as games are seen by the cron — give it a few hours after a fresh deploy.',
        color: 0xff6ab5,
      }],
      components: [backRow('hub:sports:subs')],
    };
  }
  return {
    embeds: [{
      title: '🔎 Team search — "' + q + '"',
      description: 'Pick a team to toggle its subscription.',
      color: 0xff6ab5,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [{
          type: COMPONENT_STRING_SEL,
          custom_id: 'hub:sports:subs:teamtoggle',
          placeholder: 'Toggle a team subscription',
          min_values: 1,
          max_values: 1,
          options: matches,
        }],
      },
      backRow('hub:sports:subs'),
    ],
  };
}

// ---- Profile + Help ----------------------------------------------------

async function profileView(env, guild, userId) {
  const w = await getWallet(env, guild, userId);
  let holdings = {};
  try { holdings = (await env.LOADOUT_BOLTS.get(`stock:holdings:${guild}:${userId}`, { type: 'json' })) || {}; }
  catch { /* idle */ }
  const holdingCount = Object.keys(holdings).filter((k) => holdings[k] > 0).length;
  let bets = { active: [], history: [] };
  try { bets = (await env.LOADOUT_BOLTS.get(`bets:user:${guild}:${userId}`, { type: 'json' })) || bets; }
  catch { /* idle */ }
  const subbedLeagues = await getUserLeagueSubs(env, userId);
  const subbedTeams = await getUserTeamSubs(env, userId);
  // Freeze inventory — lazy import so hub-menu has no module-load
  // dependency on streak-freeze (keeps the import graph flat).
  let freezes = { stream: 0, discord: 0 };
  try {
    const { getFreezes } = await import('./streak-freeze.js');
    freezes = await getFreezes(env, guild, userId);
  } catch { /* idle */ }
  const desc =
    '**Wallet:** ' + fmtBolts(w.balance || 0) + ' bolts\n' +
    '**Lifetime earned:** ' + fmtBolts(w.lifetimeEarned || 0) + '\n' +
    '**Daily streak:** ' + (w.dailyStreak || 0) + '\n' +
    '**Stock tickers held:** ' + holdingCount + '\n' +
    '**Active bets:** ' + ((bets.active || []).length) + ' · settled: ' + ((bets.history || []).length) + '\n' +
    '**Subscriptions:** ' + subbedLeagues.length + ' league(s), ' + subbedTeams.length + ' team(s)\n' +
    '**❄ Streak Freezes:** stream ' + freezes.stream + ' · discord ' + freezes.discord;
  return {
    embeds: [{ title: '👤 Profile', description: desc, color: 0x9a82ff }],
    components: [backRow('hub:home')],
  };
}

function helpView() {
  return {
    embeds: [{
      title: '❓ Help',
      description:
        '**Hub** — `/hub` opens this menu. Every flow is ephemeral.\n\n' +
        '**Loadout** — bolts wallet, hero, bag, shop, daily claim, gift, coin-flip / dice / training mini-games.\n\n' +
        '**Stocks** — bolts-priced real-stock emulation. 20 tickers refreshed hourly from Yahoo Finance. 1% trade fee.\n\n' +
        '**Sports** — bet on NFL · NBA · MLB · NHL games. Stake capped at 10% of wallet. 1.95× even-money (or moneyline) payouts. Tied games refund.\n\n' +
        '**Subscriptions** — pick leagues and teams to get pinged in the sports feed channel whenever a new game appears.\n\n' +
        'Earn bolts by checking in on stream, mini-game wins, or gifts. Spend them anywhere in the hub.',
      color: 0x9a82ff,
    }],
    components: [backRow('hub:home')],
  };
}

// ---- Component dispatcher ----------------------------------------------

export async function handleHubComponent(data, env) {
  const guild = data.guild_id;
  const user = data.member?.user || data.user;
  const userId = user?.id;
  const customId = data.data?.custom_id || '';
  const sourceFlags = (data.message && data.message.flags) || 0;
  if (!customId.startsWith('hub:')) {
    return json({ type: RESP_DEFER_UPDATE });
  }
  const path = customId.slice('hub:'.length);
  const segs = path.split(':');

  // hub:home, hub:loadout, hub:stocks, hub:sports, hub:profile, hub:help
  if (segs[0] === 'home')    return updateOrFollowup(sourceFlags, rootView());
  if (segs[0] === 'loadout') return updateOrFollowup(sourceFlags, await loadoutView(env, guild, userId));
  if (segs[0] === 'sports'  && segs.length === 1)
    return updateOrFollowup(sourceFlags, await sportsView(env));
  if (segs[0] === 'profile') return updateOrFollowup(sourceFlags, await profileView(env, guild, userId));
  if (segs[0] === 'help')    return updateOrFollowup(sourceFlags, helpView());

  // Sports paths
  if (segs[0] === 'sports' && segs[1] === 'upcoming' && segs[2] === 'p') {
    const p = parseInt(segs[3], 10) || 1;
    return updateOrFollowup(sourceFlags, await sportsUpcomingPaged(env, p));
  }
  if (segs[0] === 'sports' && segs[1] === 'bet') {
    const side = segs[2];
    const gid = segs.slice(3).join(':');
    if ((side === 'home' || side === 'away') && gid) {
      return json(sportsBetModal(side, gid));
    }
  }
  if (segs[0] === 'sports' && segs[1] === 'active') {
    return updateOrFollowup(sourceFlags, await sportsActiveView(env, guild, userId));
  }
  if (segs[0] === 'sports' && segs[1] === 'history') {
    return updateOrFollowup(sourceFlags, await sportsHistoryView(env, guild, userId));
  }
  if (segs[0] === 'sports' && segs[1] === 'subs' && segs.length === 2) {
    return updateOrFollowup(sourceFlags, await subsView(env, userId));
  }
  if (segs[0] === 'sports' && segs[1] === 'subs' && segs[2] === 'toggle') {
    await toggleLeagueSub(env, userId, segs[3]);
    return updateOrFollowup(sourceFlags, await subsView(env, userId));
  }
  if (segs[0] === 'sports' && segs[1] === 'subs' && segs[2] === 'teamprompt') {
    return json(teamSearchModal());
  }
  if (segs[0] === 'sports' && segs[1] === 'subs' && segs[2] === 'teamtoggle') {
    // String select — value is "<league>:<teamId>".
    const v = (data.data?.values || [])[0] || '';
    const [lg, tid] = v.split(':');
    if (lg && tid) await toggleTeamSub(env, userId, lg, tid);
    return updateOrFollowup(sourceFlags, await subsView(env, userId));
  }
  if (segs[0] === 'sports' && segs[1] === 'subs' && segs[2] === 'clearteams') {
    await clearAllTeamSubs(env, userId);
    return updateOrFollowup(sourceFlags, await subsView(env, userId));
  }
  // Quick mute from the public feed embed.
  if (segs[0] === 'sports' && segs[1] === 'mute') {
    const league = segs[2];
    if (LEAGUES_FOR_SUBS.includes(league)) {
      const before = await getUserLeagueSubs(env, userId);
      if (before.includes(league)) {
        await toggleLeagueSub(env, userId, league);
        return chatReply('🔕 Muted **' + league.toUpperCase() + '** notifications.');
      }
      return chatReply('You weren\'t subscribed to **' + league.toUpperCase() + '** in the first place.');
    }
  }

  return json({ type: RESP_DEFER_UPDATE });
}

// ---- Modal dispatcher --------------------------------------------------

export async function handleHubModal(data, env) {
  const guild = data.guild_id;
  const user = data.member?.user || data.user;
  const userId = user?.id;
  const customId = data.data?.custom_id || '';
  const sourceFlags = (data.message && data.message.flags) || 0;

  // Collect text-input values keyed by custom_id.
  const fields = {};
  for (const row of (data.data?.components || [])) {
    for (const c of (row.components || [])) fields[c.custom_id] = c.value;
  }

  if (customId === 'hub:modal:stocks-buy') {
    const result = await stocksRunBuy(env, guild, userId, { ticker: fields.ticker, bolts: parseInt(fields.bolts, 10) });
    return updateOrFollowup(sourceFlags, {
      embeds: [{ title: '🛒 Buy', description: result, color: 0x46d160 }],
      components: [backRow('hub:stocks')],
    });
  }
  if (customId === 'hub:modal:stocks-sell') {
    const result = await stocksRunSell(env, guild, userId, { ticker: fields.ticker, shares: parseInt(fields.shares, 10) });
    return updateOrFollowup(sourceFlags, {
      embeds: [{ title: '💸 Sell', description: result, color: 0xff5c5c }],
      components: [backRow('hub:stocks')],
    });
  }
  if (customId === 'hub:modal:stocks-chart') {
    const result = await stocksRenderChart(env, { ticker: fields.ticker });
    return updateOrFollowup(sourceFlags, {
      embeds: [{ title: '📈 Chart', description: result, color: 0x3a86ff }],
      components: [backRow('hub:stocks')],
    });
  }
  if (customId.startsWith('hub:modal:sports-bet:')) {
    const rest = customId.slice('hub:modal:sports-bet:'.length);
    const colon = rest.indexOf(':');
    const side = colon > 0 ? rest.slice(0, colon) : '';
    const gameId = colon > 0 ? rest.slice(colon + 1) : '';
    const bolts = parseInt(fields.bolts, 10) || 0;
    const result = await betRunPlace(env, guild, userId, { game: gameId, side, bolts });
    return updateOrFollowup(sourceFlags, {
      embeds: [{ title: '🎲 Bet', description: result, color: 0xff6ab5 }],
      components: [backRow('hub:sports')],
    });
  }
  if (customId === 'hub:modal:teamsearch') {
    const q = String(fields.q || '').trim();
    return updateOrFollowup(sourceFlags, await teamSearchResults(env, userId, q));
  }

  return json({ type: RESP_DEFER_UPDATE });
}
