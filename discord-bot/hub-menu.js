// /hub — viewer-facing entry hub.
//
// Opens an interactive ephemeral embed with five category buttons:
// Loadout · Stocks · Sports · Profile · Help. Each button drills into a
// summary view; the deep flows (gear/shop/training, full ticker chart,
// place-bet, etc.) live behind the existing /loadout, /stocks, /bet
// slash commands so this file stays a thin gateway.
//
// Component routing: every custom_id starts with "hub:" — the worker's
// commands.js dispatches that prefix here.

import { getWallet } from './wallet.js';

const RESP_CHAT          = 4;
const RESP_UPDATE_MESSAGE = 7;
const RESP_DEFER_UPDATE   = 6;
const FLAG_EPHEMERAL = 1 << 6;

const COMPONENT_ROW    = 1;
const COMPONENT_BUTTON = 2;
const STYLE_PRIMARY    = 1;
const STYLE_SECONDARY  = 2;

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mainView() {
  return {
    embeds: [{
      title: '🌐 Aquilo Hub',
      description:
        'Pick a section to explore. Each one has its own slash command for the full flow:\n' +
        '• **Loadout** — wallet, hero, bag (`/loadout`)\n' +
        '• **Stocks** — bolts-denominated real market (`/stocks`)\n' +
        '• **Sports** — bolts-denominated betting (`/bet sports`)\n' +
        '• **Profile** — your stats across everything\n' +
        '• **Help** — overview + tips',
      color: 0x3a86ff,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: 'Loadout', custom_id: 'hub:loadout' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: 'Stocks',  custom_id: 'hub:stocks'  },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: 'Sports',  custom_id: 'hub:sports'  },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: 'Profile', custom_id: 'hub:profile' },
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: 'Help',    custom_id: 'hub:help'    },
        ],
      },
    ],
  };
}

function backRow() {
  return {
    type: COMPONENT_ROW,
    components: [
      { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back', custom_id: 'hub:home' },
    ],
  };
}

function info(title, description, color) {
  return {
    embeds: [{ title, description, color: color || 0x3a86ff }],
    components: [backRow()],
  };
}

async function loadoutView(env, guild, userId) {
  const w = await getWallet(env, guild, userId);
  return info(
    '🎮 Loadout',
    'Wallet: **' + (w.balance || 0) + ' bolts**\n' +
    'Daily streak: ' + (w.dailyStreak || 0) + ' day(s)\n\n' +
    'Run `/loadout` for the full menu — wallet, hero, bag, shop, daily claim, gift, profile, mini-games.',
  );
}

function stocksView() {
  return info(
    '📈 Stocks',
    'Bolts-denominated real market emulation. 20 tickers across tech, gaming, and entertainment, priced from Yahoo Finance and refreshed hourly.\n\n' +
    '• `/stocks list` — every ticker + 24h change\n' +
    '• `/stocks buy <ticker> <bolts>` — buy with bolts (1% fee)\n' +
    '• `/stocks sell <ticker> <shares>` — sell back\n' +
    '• `/stocks portfolio` — your holdings\n' +
    '• `/stocks chart <ticker>` — recent-price chart',
  );
}

function sportsView() {
  return info(
    '🏈 Sports betting',
    'Bet bolts on NFL · NBA · MLB · NHL games. Max stake 10% of wallet · 1.95× even-money or moneyline payout · refunds on ties.\n\n' +
    '• `/bet sports list` — upcoming games\n' +
    '• `/bet sports place game:<id> side:<home|away> bolts:<N>` — place a bet\n' +
    '• `/bet sports active` — your open bets\n' +
    '• `/bet sports history` — last 20 settled bets',
  );
}

async function profileView(env, guild, userId) {
  const w = await getWallet(env, guild, userId);
  // Lightweight portfolio + active-bets counts — full views live behind
  // /stocks portfolio and /bet sports active.
  let holdings = {};
  try {
    holdings = (await env.LOADOUT_BOLTS.get(`stock:holdings:${guild}:${userId}`, { type: 'json' })) || {};
  } catch { /* idle */ }
  const holdingCount = Object.keys(holdings).filter((k) => holdings[k] > 0).length;
  let bets = { active: [], history: [] };
  try {
    bets = (await env.LOADOUT_BOLTS.get(`bets:user:${guild}:${userId}`, { type: 'json' })) || bets;
  } catch { /* idle */ }
  const activeBets = (bets.active || []).length;
  const settled = (bets.history || []).length;
  return info(
    '🧑 Profile',
    'Wallet: **' + (w.balance || 0) + ' bolts** (lifetime earned ' + (w.lifetimeEarned || 0) + ')\n' +
    'Daily streak: ' + (w.dailyStreak || 0) + '\n' +
    'Stock tickers held: **' + holdingCount + '**\n' +
    'Active bets: **' + activeBets + '** · settled this run: ' + settled + '\n\n' +
    'Open the deep views with `/loadout`, `/stocks portfolio`, `/bet sports active`.',
  );
}

function helpView() {
  return info(
    '❓ Help',
    '**Slash commands**\n' +
    '`/hub` — this menu\n' +
    '`/loadout` — wallet, hero, gear, shop, mini-games\n' +
    '`/stocks list / buy / sell / portfolio / chart` — bolts stock market\n' +
    '`/bet sports list / place / active / history` — sports betting\n\n' +
    '**Tips**\n' +
    '• You earn bolts by checking in on stream, playing mini-games, and getting them gifted.\n' +
    '• Stocks update every hour — prices freeze outside market hours.\n' +
    '• Sports bets settle within an hour of the game ending.\n' +
    '• Trades have a 1% fee, bets have a 2.5% house edge — both feed the bolts economy.',
  );
}

export async function renderHubCommand(env, guild, userId) {
  return { type: RESP_CHAT, data: { ...mainView(), flags: FLAG_EPHEMERAL } };
}

export async function handleHubComponent(data, env) {
  const guild = data.guild_id;
  const user = data.member?.user || data.user;
  const userId = user?.id;
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('hub:')) {
    return json({ type: RESP_DEFER_UPDATE });
  }
  const view = customId.slice('hub:'.length);
  let payload;
  switch (view) {
    case 'home':    payload = mainView(); break;
    case 'loadout': payload = await loadoutView(env, guild, userId); break;
    case 'stocks':  payload = stocksView(); break;
    case 'sports':  payload = sportsView(); break;
    case 'profile': payload = await profileView(env, guild, userId); break;
    case 'help':    payload = helpView(); break;
    default:        return json({ type: RESP_DEFER_UPDATE });
  }
  return json({ type: RESP_UPDATE_MESSAGE, data: payload });
}
