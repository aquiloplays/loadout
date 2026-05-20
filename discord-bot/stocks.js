// Bolts-denominated stock market.
//
// Tickers are tied to real upstream signals — Twitch game viewers,
// Steam player counts, Spotify track popularity, Twitch streamer
// viewers — so prices actually move on their own. Spot trading only,
// integer shares, 1% fee on buys + sells (rounded up, min 1), no
// leverage. The 30-day "history" is sampled hourly by the
// `scheduled` cron in worker.js.
//
// KV layout (all in LOADOUT_BOLTS):
//   stocks:catalog:v1                          owner-curated catalog
//   stock:price:<TICKER>                       latest { price, raw, asOf }
//   stock:history:<TICKER>                     last 720 samples (~30 days hourly)
//   stock:holdings:<guildId>:<userId>          { TICKER: shares }
//
// Per-ticker entry in the catalog:
//   { ticker, name, source, sourceRef, coeff }
//     source: 'twitch_game' | 'steam_game' | 'spotify_track' | 'twitch_streamer'
//     sourceRef: game_id | appid | track_id | user_login (string)
//     coeff: per-ticker divisor on the raw signal — price = max(1, floor(raw / coeff))
//
// Slash command surface (registered in commands-spec.js, dispatched
// from commands.js):
//   /stocks list
//   /stocks buy <ticker> <bolts>
//   /stocks sell <ticker> <shares>
//   /stocks portfolio
//   /stocks chart <ticker>

import { getTwitchAppToken } from './ext-loadout.js';
import { spend, earn, getWallet } from './wallet.js';

const CATALOG_KEY = 'stocks:catalog:v1';
const FEE_PCT = 1;
const HISTORY_CAP = 720; // ~30 days × 24 hourly samples

const FLAG_EPHEMERAL = 1 << 6;
const RESP_CHAT = 4;

// Shipped if the KV catalog hasn't been authored yet. Spotify tracks +
// the bonus twitch-streamer category start empty — Clay seeds his own
// picks via the /admin editor. The Twitch-game IDs are public Helix
// values; the Steam appids are public Steam values.
export const DEFAULT_CATALOG = {
  tickers: [
    // Twitch games — `coeff` divides aggregate viewer_count summed
    // across the top 100 live streams of the game. Top games at peak
    // sit around 10k–60k aggregate viewers in that slice, so coeffs
    // 100–400 land prices in roughly the 50–600 range.
    { ticker: 'LOL',   name: 'League of Legends',     source: 'twitch_game', sourceRef: '21779',  coeff: 200 },
    { ticker: 'VAL',   name: 'VALORANT',              source: 'twitch_game', sourceRef: '516575', coeff: 200 },
    { ticker: 'GTAV',  name: 'Grand Theft Auto V',    source: 'twitch_game', sourceRef: '32982',  coeff: 200 },
    { ticker: 'MC',    name: 'Minecraft',             source: 'twitch_game', sourceRef: '27471',  coeff: 200 },
    { ticker: 'FN',    name: 'Fortnite',              source: 'twitch_game', sourceRef: '33214',  coeff: 200 },
    { ticker: 'JC',    name: 'Just Chatting',         source: 'twitch_game', sourceRef: '509658', coeff: 400 },
    { ticker: 'TFT',   name: 'Teamfight Tactics',     source: 'twitch_game', sourceRef: '513143', coeff: 100 },
    { ticker: 'WOW',   name: 'World of Warcraft',     source: 'twitch_game', sourceRef: '18122',  coeff: 100 },

    // Steam games — coeff divides player_count. CS2 sits ~500k mid-day,
    // so coeff 3000 → ~165 bolts/share. Smaller player bases get smaller
    // coeffs so their prices stay readable.
    { ticker: 'CS2',   name: 'Counter-Strike 2',      source: 'steam_game', sourceRef: '730',     coeff: 3000 },
    { ticker: 'DOTA',  name: 'Dota 2',                source: 'steam_game', sourceRef: '570',     coeff: 1500 },
    { ticker: 'APEX',  name: 'Apex Legends',          source: 'steam_game', sourceRef: '1172470', coeff: 500 },
    { ticker: 'PUBG',  name: 'PUBG: BATTLEGROUNDS',   source: 'steam_game', sourceRef: '578080',  coeff: 500 },
    { ticker: 'RDR2',  name: 'Red Dead Redemption 2', source: 'steam_game', sourceRef: '1174180', coeff: 50 },
    { ticker: 'CYBER', name: 'Cyberpunk 2077',        source: 'steam_game', sourceRef: '1091500', coeff: 50 },

    // Spotify tracks: empty at launch (no queryable Rotation playlist
    // exists; Clay's taste is the right curator). Add via /admin with
    // source='spotify_track', sourceRef=<spotify track id>, coeff ~0.5
    // (popularity 0–100 → ~50–200 price).

    // Twitch streamers (friends/allies — bonus category): empty at
    // launch. Add via /admin with source='twitch_streamer',
    // sourceRef=<lowercase login>, coeff tuned to the streamer's
    // average concurrent viewer count.
  ],
};

// ---- KV access ---------------------------------------------------------

export async function getCatalog(env) {
  try {
    const c = await env.LOADOUT_BOLTS.get(CATALOG_KEY, { type: 'json' });
    if (c && Array.isArray(c.tickers)) return c;
  } catch { /* fall through */ }
  return DEFAULT_CATALOG;
}

function findTicker(catalog, ticker) {
  const t = String(ticker || '').toUpperCase().trim();
  return (catalog.tickers || []).find((x) => String(x.ticker).toUpperCase() === t) || null;
}

async function getPrice(env, ticker) {
  try {
    return await env.LOADOUT_BOLTS.get('stock:price:' + ticker, { type: 'json' });
  } catch { return null; }
}

async function putPrice(env, ticker, rec) {
  await env.LOADOUT_BOLTS.put('stock:price:' + ticker, JSON.stringify(rec));
}

async function getHistory(env, ticker) {
  try {
    const h = await env.LOADOUT_BOLTS.get('stock:history:' + ticker, { type: 'json' });
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}

async function putHistory(env, ticker, arr) {
  if (arr.length > HISTORY_CAP) arr = arr.slice(-HISTORY_CAP);
  await env.LOADOUT_BOLTS.put('stock:history:' + ticker, JSON.stringify(arr));
}

async function getHoldings(env, guildId, userId) {
  try {
    const h = await env.LOADOUT_BOLTS.get(`stock:holdings:${guildId}:${userId}`, { type: 'json' });
    return (h && typeof h === 'object') ? h : {};
  } catch { return {}; }
}

async function putHoldings(env, guildId, userId, h) {
  await env.LOADOUT_BOLTS.put(`stock:holdings:${guildId}:${userId}`, JSON.stringify(h));
}

// ---- Source fetchers ---------------------------------------------------

// Sum of viewer_count across the top 100 live streams of a Twitch
// game — a deterministic proxy for "total live viewers right now."
// Helix `streams?game_id=` doesn't return per-game aggregates so this
// is the standard workaround.
async function fetchTwitchGameViewers(env, gameId) {
  const token = await getTwitchAppToken(env);
  if (!token || !env.TWITCH_CLIENT_ID) return null;
  try {
    const res = await fetch(
      'https://api.twitch.tv/helix/streams?first=100&game_id=' + encodeURIComponent(gameId),
      { headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    let total = 0;
    for (const s of (d.data || [])) total += Number(s.viewer_count) || 0;
    return total;
  } catch { return null; }
}

// Current player_count for a Steam app. Public, no auth needed.
async function fetchSteamPlayerCount(appId) {
  try {
    const res = await fetch(
      'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=' +
        encodeURIComponent(appId),
      { headers: { 'User-Agent': 'aquilo-stocks/1.0 (+https://aquilo.gg)' } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const r = d && d.response;
    if (!r || r.result !== 1) return null;
    return Number(r.player_count) || 0;
  } catch { return null; }
}

// Spotify track popularity (0–100). Uses the same client-credentials
// app token rotation.js caches under `spotify:apptoken`.
async function fetchSpotifyTrackPopularity(env, trackId) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;
  let token = await env.LOADOUT_BOLTS.get('spotify:apptoken');
  if (!token) {
    try {
      const basic = btoa(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET);
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + basic,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      if (!res.ok) return null;
      const d = await res.json();
      if (!d || !d.access_token) return null;
      token = d.access_token;
      await env.LOADOUT_BOLTS.put('spotify:apptoken', token, { expirationTtl: 3000 });
    } catch { return null; }
  }
  try {
    const res = await fetch(
      'https://api.spotify.com/v1/tracks/' + encodeURIComponent(trackId),
      { headers: { Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    return Number(d && d.popularity) || 0;
  } catch { return null; }
}

// viewer_count of a single Twitch streamer's current stream (0 if offline).
async function fetchTwitchStreamerViewers(env, login) {
  const token = await getTwitchAppToken(env);
  if (!token || !env.TWITCH_CLIENT_ID) return null;
  try {
    const res = await fetch(
      'https://api.twitch.tv/helix/streams?user_login=' + encodeURIComponent(login),
      { headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const s = d.data && d.data[0];
    return s ? (Number(s.viewer_count) || 0) : 0;
  } catch { return null; }
}

async function fetchSourceValue(env, t) {
  switch (String(t.source)) {
    case 'twitch_game':     return fetchTwitchGameViewers(env, t.sourceRef);
    case 'steam_game':      return fetchSteamPlayerCount(t.sourceRef);
    case 'spotify_track':   return fetchSpotifyTrackPopularity(env, t.sourceRef);
    case 'twitch_streamer': return fetchTwitchStreamerViewers(env, t.sourceRef);
    default: return null;
  }
}

function priceFromRaw(t, raw) {
  if (raw == null) return null;
  const divisor = Number(t.coeff);
  if (!isFinite(divisor) || divisor <= 0) return null;
  return Math.max(1, Math.floor(raw / divisor));
}

// ---- Cron tick ---------------------------------------------------------

// Iterate every ticker, fetch the source value, compute price, write
// the new latest + append to history. Per-ticker errors don't abort
// the rest of the tick — the next cron will retry.
export async function stocksCronTick(env) {
  const catalog = await getCatalog(env);
  const tickers = catalog.tickers || [];
  const asOf = new Date().toISOString();
  let updated = 0;
  for (const t of tickers) {
    try {
      const raw = await fetchSourceValue(env, t);
      const price = priceFromRaw(t, raw);
      if (price == null) continue;
      await putPrice(env, t.ticker, { price, raw, asOf });
      const hist = await getHistory(env, t.ticker);
      hist.push({ price, asOf });
      await putHistory(env, t.ticker, hist);
      updated++;
    } catch { /* skip — next tick will retry */ }
  }
  return updated;
}

// ---- Slash command dispatcher ------------------------------------------

export async function handleStocks(env, guildId, userId, userName, options) {
  const sub = (options && options[0]) || {};
  const args = {};
  for (const o of (sub.options || [])) args[o.name] = o.value;
  switch (sub.name) {
    case 'list':      return slashReply(await renderStocksList(env));
    case 'buy':       return slashReply(await runBuy(env, guildId, userId, args));
    case 'sell':      return slashReply(await runSell(env, guildId, userId, args));
    case 'portfolio': return slashReply(await renderPortfolio(env, guildId, userId));
    case 'chart':     return slashReply(await renderChart(env, args));
    default:          return slashReply('Unknown subcommand.');
  }
}

function slashReply(content) {
  return {
    type: RESP_CHAT,
    data: { content, flags: FLAG_EPHEMERAL },
  };
}

function fmtNum(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// 1% rounded up, min 1 bolt — applies to both buy cost and sell gross.
function calcFee(amount) {
  return Math.max(1, Math.ceil((amount * FEE_PCT) / 100));
}

// 24h % change. Hourly cron means the last 24 samples cover ~24 hours;
// if we have fewer, use what's there. Null when there's no usable base.
function pctChange(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const slice = history.slice(-24);
  const first = slice[0].price;
  const last = slice[slice.length - 1].price;
  if (!first) return null;
  return ((last - first) / first) * 100;
}

async function renderStocksList(env) {
  const catalog = await getCatalog(env);
  const tickers = catalog.tickers || [];
  if (tickers.length === 0) {
    return 'No tickers in the catalog yet. The owner can add some at https://aquilo.gg/admin .';
  }
  const rows = [];
  for (const t of tickers) {
    const rec = await getPrice(env, t.ticker);
    const hist = await getHistory(env, t.ticker);
    const price = rec ? rec.price : null;
    const change = pctChange(hist);
    const sign = change == null ? '' : (change >= 0 ? '+' : '');
    const changeStr = change == null ? '—' : (sign + change.toFixed(1) + '%');
    rows.push(
      '`' + String(t.ticker).padEnd(6) + '` ' +
      (price == null ? '—'.padStart(6) : String(price).padStart(6)) + '  ' +
      changeStr.padStart(7) + '   ' +
      t.name,
    );
  }
  return (
    '**Stocks** — bolts-denominated\n```\nTICKER PRICE   24H Δ    NAME\n' +
    rows.join('\n') +
    '\n```\nBuy with `/stocks buy <ticker> <bolts>` · 1% fee on every trade.'
  );
}

async function runBuy(env, guildId, userId, args) {
  const ticker = String(args.ticker || '').toUpperCase();
  const bolts = Math.max(1, Math.floor(Number(args.bolts) || 0));
  const catalog = await getCatalog(env);
  const def = findTicker(catalog, ticker);
  if (!def) return 'Unknown ticker: `' + ticker + '`.';
  const rec = await getPrice(env, def.ticker);
  if (!rec || !rec.price) {
    return 'No price yet for `' + def.ticker + '` — try again after the next cron tick.';
  }
  const price = rec.price;
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < bolts) {
    return 'You have ' + fmtNum(wallet.balance || 0) + ' bolts; need ' + fmtNum(bolts) + '.';
  }
  // Buy as many whole shares as the (price + 1% fee) cost lets us
  // fit under the requested bolts budget.
  const grossPerShare = price * (1 + FEE_PCT / 100);
  const shares = Math.floor(bolts / grossPerShare);
  if (shares <= 0) {
    return (
      'At ' + price + ' bolts/share + ' + FEE_PCT + '% fee you need at least ' +
      Math.ceil(grossPerShare) + ' bolts for one share.'
    );
  }
  const cost = shares * price;
  const fee = calcFee(cost);
  const total = cost + fee;
  const r = await spend(env, guildId, userId, total, 'stocks-buy:' + def.ticker);
  if (!r || !r.ok) {
    return "Couldn't debit " + fmtNum(total) + ' bolts: ' + (r && r.reason || 'wallet error') + '.';
  }
  const holdings = await getHoldings(env, guildId, userId);
  holdings[def.ticker] = (Number(holdings[def.ticker]) || 0) + shares;
  await putHoldings(env, guildId, userId, holdings);
  return (
    '📈 Bought **' + shares + '** share' + (shares === 1 ? '' : 's') +
    ' of `' + def.ticker + '` at ' + price + ' bolts each.\n' +
    'Cost ' + fmtNum(cost) + ' + ' + fmtNum(fee) + ' fee = ' + fmtNum(total) +
    ' bolts · Balance ' + fmtNum(r.wallet && r.wallet.balance) + '.'
  );
}

async function runSell(env, guildId, userId, args) {
  const ticker = String(args.ticker || '').toUpperCase();
  const shares = Math.max(1, Math.floor(Number(args.shares) || 0));
  const catalog = await getCatalog(env);
  const def = findTicker(catalog, ticker);
  if (!def) return 'Unknown ticker: `' + ticker + '`.';
  const rec = await getPrice(env, def.ticker);
  if (!rec || !rec.price) {
    return 'No price yet for `' + def.ticker + '`.';
  }
  const holdings = await getHoldings(env, guildId, userId);
  const held = Number(holdings[def.ticker]) || 0;
  if (held < shares) {
    return 'You only hold ' + held + ' share' + (held === 1 ? '' : 's') + ' of `' + def.ticker + '`.';
  }
  const price = rec.price;
  const gross = shares * price;
  const fee = calcFee(gross);
  const net = Math.max(0, gross - fee);
  holdings[def.ticker] = held - shares;
  if (holdings[def.ticker] <= 0) delete holdings[def.ticker];
  await putHoldings(env, guildId, userId, holdings);
  const credited = await earn(env, guildId, userId, net, 'stocks-sell:' + def.ticker);
  return (
    '📉 Sold **' + shares + '** share' + (shares === 1 ? '' : 's') +
    ' of `' + def.ticker + '` at ' + price + ' bolts each.\n' +
    'Gross ' + fmtNum(gross) + ' − ' + fmtNum(fee) + ' fee = ' + fmtNum(net) +
    ' bolts · Balance ' + fmtNum(credited.balance) + '.'
  );
}

async function renderPortfolio(env, guildId, userId) {
  const holdings = await getHoldings(env, guildId, userId);
  const tickers = Object.keys(holdings)
    .filter((k) => (Number(holdings[k]) || 0) > 0)
    .sort();
  if (tickers.length === 0) {
    return 'No holdings yet. Try `/stocks list` then `/stocks buy <ticker> <bolts>`.';
  }
  const rows = [];
  let totalValue = 0;
  for (const t of tickers) {
    const rec = await getPrice(env, t);
    const price = rec ? rec.price : null;
    const shares = Number(holdings[t]) || 0;
    const value = price != null ? price * shares : 0;
    totalValue += value;
    rows.push(
      '`' + t.padEnd(6) + '` ' +
      String(shares).padStart(5) + ' @ ' +
      String(price != null ? price : '—').padStart(5) +
      '  = ' + (price != null ? fmtNum(value) : '—'),
    );
  }
  const wallet = await getWallet(env, guildId, userId);
  return (
    '**Portfolio**\n```\nTICKER SHARES @ PRICE  VALUE\n' +
    rows.join('\n') + '\n```\n' +
    'Total stock value ' + fmtNum(totalValue) + ' bolts · Wallet ' +
    fmtNum(wallet.balance || 0) + ' bolts.'
  );
}

async function renderChart(env, args) {
  const ticker = String(args.ticker || '').toUpperCase();
  const catalog = await getCatalog(env);
  const def = findTicker(catalog, ticker);
  if (!def) return 'Unknown ticker: `' + ticker + '`.';
  const history = await getHistory(env, def.ticker);
  if (history.length < 2) {
    return 'Not enough history yet for `' + ticker + '` (need 2+ cron ticks).';
  }
  // Downsample to 24 buckets — a compact sparkline that reads well in
  // a Discord code block regardless of history depth.
  const N = Math.min(24, history.length);
  const step = history.length / N;
  const samples = [];
  for (let i = 0; i < N; i++) {
    const idx = Math.min(history.length - 1, Math.floor(i * step));
    samples.push(history[idx].price);
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = Math.max(1, max - min);
  const bars = '▁▂▃▄▅▆▇█';
  const sparkline = samples
    .map((p) => {
      const idx = Math.min(7, Math.floor(((p - min) / range) * bars.length));
      return bars[idx];
    })
    .join('');
  const first = samples[0];
  const last = samples[samples.length - 1];
  const change = first ? ((last - first) / first) * 100 : 0;
  const sign = change >= 0 ? '+' : '';
  return (
    '**' + def.ticker + '** — ' + def.name + '\n```\n' + sparkline + '\n```\n' +
    'Min ' + min + ' · Max ' + max + ' · Now ' + last + ' bolts · ' +
    sign + change.toFixed(1) + '% over the window.'
  );
}
