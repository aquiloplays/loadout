// Bolts-denominated stock market — real public stocks via Yahoo Finance.
//
// Single source: yahoo_stock. Cron hits Yahoo's public chart API once an
// hour per ticker (well under any sane rate limit) and writes the latest
// price + appends to history. Spot trading only, integer shares, 1% fee
// on buys + sells (rounded up, min 1 bolt). No leverage, no trade limits.
//
// Pricing model:
//   bolts price = max(1, floor(realPriceUSD * multiplier))
// Multiplier is per-ticker so AAPL at $230 and GME at $20 can both land
// in a comparable bolts-of-spending range. Calibrate at registration.
//
// Market hours: regular session is 09:30–16:00 ET on weekdays. Outside
// that, Yahoo returns the last-close as `regularMarketPrice` — fine,
// the bolts price holds steady until the market re-opens, history just
// flatlines. Bots can still trade at last-close; feels like a real
// after-hours market emulation.
//
// KV layout (all in LOADOUT_BOLTS):
//   stocks:catalog:v1                          owner-curated catalog
//   stock:price:<TICKER>                       latest { price, raw, asOf }
//   stock:history:<TICKER>                     last 720 samples (~30 days hourly)
//   stock:holdings:<guildId>:<userId>          { TICKER: shares }
//   stocks:ticker:guild:<guildId>              { channelId, messageId } — auto-update channel pin
//
// Slash command surface (registered in commands-spec.js, dispatched
// from commands.js):
//   /stocks list
//   /stocks buy <ticker> <bolts>
//   /stocks sell <ticker> <shares>
//   /stocks portfolio
//   /stocks chart <ticker>
//   /stocks ticker-setup   (admin) — bind the current channel as the auto-update ticker board
//   /stocks ticker-clear   (admin) — release the binding

import { json } from './ext-shared.js';
import { spend, earn, getWallet } from './wallet.js';

const CATALOG_KEY = 'stocks:catalog:v1';
const FEE_PCT = 1;
const HISTORY_CAP = 720; // ~30 days × 24 hourly samples

const FLAG_EPHEMERAL = 1 << 6;
const RESP_CHAT = 4;
const PERMISSION_MANAGE_GUILD = 0x20;

// User-Agent is required for Yahoo — bare-bones clients get 403.
const YAHOO_UA = 'Mozilla/5.0 (compatible; aquilo-stocks/1.0)';

// Starter catalog — 20 real public stocks across tech / gaming /
// entertainment. Multipliers target a 50–200 bolts range for typical
// market levels; tune via /admin if needed. `source: 'yahoo_stock'` is
// the only supported source — the multi-source experiment got scrapped
// in favour of real-market emulation.
export const DEFAULT_CATALOG = {
  tickers: [
    // Big tech
    { ticker: 'AAPL',  name: 'Apple',                   source: 'yahoo_stock', sourceRef: 'AAPL',  multiplier: 0.5 },
    { ticker: 'MSFT',  name: 'Microsoft',               source: 'yahoo_stock', sourceRef: 'MSFT',  multiplier: 0.3 },
    { ticker: 'GOOGL', name: 'Alphabet (Google)',       source: 'yahoo_stock', sourceRef: 'GOOGL', multiplier: 0.6 },
    { ticker: 'META',  name: 'Meta',                    source: 'yahoo_stock', sourceRef: 'META',  multiplier: 0.2 },
    { ticker: 'AMZN',  name: 'Amazon',                  source: 'yahoo_stock', sourceRef: 'AMZN',  multiplier: 0.5 },
    // Hardware / GPUs
    { ticker: 'NVDA',  name: 'NVIDIA',                  source: 'yahoo_stock', sourceRef: 'NVDA',  multiplier: 0.8 },
    { ticker: 'AMD',   name: 'Advanced Micro Devices',  source: 'yahoo_stock', sourceRef: 'AMD',   multiplier: 0.8 },
    { ticker: 'INTC',  name: 'Intel',                   source: 'yahoo_stock', sourceRef: 'INTC',  multiplier: 4 },
    // Volatile / recognizable
    { ticker: 'TSLA',  name: 'Tesla',                   source: 'yahoo_stock', sourceRef: 'TSLA',  multiplier: 0.5 },
    { ticker: 'GME',   name: 'GameStop',                source: 'yahoo_stock', sourceRef: 'GME',   multiplier: 5 },
    // Gaming publishers / platforms
    { ticker: 'EA',    name: 'Electronic Arts',         source: 'yahoo_stock', sourceRef: 'EA',    multiplier: 0.7 },
    { ticker: 'TTWO',  name: 'Take-Two Interactive',    source: 'yahoo_stock', sourceRef: 'TTWO',  multiplier: 0.6 },
    { ticker: 'RBLX',  name: 'Roblox',                  source: 'yahoo_stock', sourceRef: 'RBLX',  multiplier: 2 },
    { ticker: 'U',     name: 'Unity Software',          source: 'yahoo_stock', sourceRef: 'U',     multiplier: 5 },
    // Entertainment / streaming
    { ticker: 'NFLX',  name: 'Netflix',                 source: 'yahoo_stock', sourceRef: 'NFLX',  multiplier: 0.15 },
    { ticker: 'DIS',   name: 'Disney',                  source: 'yahoo_stock', sourceRef: 'DIS',   multiplier: 1 },
    { ticker: 'SPOT',  name: 'Spotify',                 source: 'yahoo_stock', sourceRef: 'SPOT',  multiplier: 0.25 },
    { ticker: 'ROKU',  name: 'Roku',                    source: 'yahoo_stock', sourceRef: 'ROKU',  multiplier: 1.5 },
    // Crypto-adjacent
    { ticker: 'COIN',  name: 'Coinbase',                source: 'yahoo_stock', sourceRef: 'COIN',  multiplier: 0.5 },
    { ticker: 'MSTR',  name: 'MicroStrategy',           source: 'yahoo_stock', sourceRef: 'MSTR',  multiplier: 0.4 },
  ],
};

// ---- Schema migration --------------------------------------------------
//
// The previous version of this module shipped a multi-source experiment
// (twitch_game / steam_game / spotify_track). Schema v2 is the
// Yahoo-only real-stock emulation. On first encounter, wipe the old
// stock:price / stock:history / stock:holdings prefixes + the old
// catalog record so leftover ticker keys don't shadow the new ones.
// Idempotent — sentinel value is checked first.
const SCHEMA_KEY = 'stocks:schema:v';
const SCHEMA_VERSION = '2';

async function migrateIfNeeded(env) {
  try {
    const v = await env.LOADOUT_BOLTS.get(SCHEMA_KEY);
    if (v === SCHEMA_VERSION) return;
    for (const prefix of ['stock:price:', 'stock:history:', 'stock:holdings:']) {
      let cursor;
      do {
        const r = await env.LOADOUT_BOLTS.list({ prefix, cursor });
        for (const k of r.keys) {
          try { await env.LOADOUT_BOLTS.delete(k.name); } catch { /* idle */ }
        }
        cursor = r.list_complete ? null : r.cursor;
      } while (cursor);
    }
    try { await env.LOADOUT_BOLTS.delete(CATALOG_KEY); } catch { /* idle */ }
    await env.LOADOUT_BOLTS.put(SCHEMA_KEY, SCHEMA_VERSION);
  } catch { /* idle — next invocation retries */ }
}

// ---- KV access ---------------------------------------------------------

export async function getCatalog(env) {
  await migrateIfNeeded(env);
  try {
    const c = await env.LOADOUT_BOLTS.get(CATALOG_KEY, { type: 'json' });
    // Defensive migration: if the stored catalog is from the old multi-
    // source experiment, ignore it and return the new default.
    if (c && Array.isArray(c.tickers) && c.tickers.length > 0) {
      const allYahoo = c.tickers.every((t) => t && t.source === 'yahoo_stock');
      if (allYahoo) return c;
    }
  } catch { /* fall through */ }
  return DEFAULT_CATALOG;
}

function findTicker(catalog, ticker) {
  const t = String(ticker || '').toUpperCase().trim();
  return (catalog.tickers || []).find((x) => String(x.ticker).toUpperCase() === t) || null;
}

export async function getPrice(env, ticker) {
  try {
    return await env.LOADOUT_BOLTS.get('stock:price:' + ticker, { type: 'json' });
  } catch { return null; }
}

async function putPrice(env, ticker, rec) {
  await env.LOADOUT_BOLTS.put('stock:price:' + ticker, JSON.stringify(rec));
}

export async function getHistory(env, ticker) {
  try {
    const h = await env.LOADOUT_BOLTS.get('stock:history:' + ticker, { type: 'json' });
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}

async function putHistory(env, ticker, arr) {
  if (arr.length > HISTORY_CAP) arr = arr.slice(-HISTORY_CAP);
  await env.LOADOUT_BOLTS.put('stock:history:' + ticker, JSON.stringify(arr));
}

export async function getHoldings(env, guildId, userId) {
  try {
    const h = await env.LOADOUT_BOLTS.get(`stock:holdings:${guildId}:${userId}`, { type: 'json' });
    return (h && typeof h === 'object') ? h : {};
  } catch { return {}; }
}

async function putHoldings(env, guildId, userId, h) {
  await env.LOADOUT_BOLTS.put(`stock:holdings:${guildId}:${userId}`, JSON.stringify(h));
}

// ── Per-user transaction log ────────────────────────────────────────
//
// Every successful buy/sell appends an entry. Used by the web
// portfolio view to compute:
//
//   * Average cost basis per ticker  (avg of (price + fee/share) over
//                                     all buys minus any sold)
//   * Realized P&L                   (sum of sell.proceeds - matching
//                                     buy cost-basis)
//   * Per-trade history list
//   * Trading stats (best trade, biggest loss, total invested, etc.)
//
// We keep the last 200 entries — enough for any reasonable session
// of trading, capped to keep the KV record bounded. Older entries
// roll off the front; realised-PnL summaries should be persisted
// separately if we ever need full history (not yet — 200 is plenty).
//
// Shape: [{ asOf, action: "buy"|"sell", ticker, shares, price,
//          bolts, fee, balanceAfter }]
const TXN_CAP = 200;

export async function getStocksTransactions(env, guildId, userId) {
  try {
    const t = await env.LOADOUT_BOLTS.get(`stock:txns:${guildId}:${userId}`, { type: 'json' });
    return Array.isArray(t) ? t : [];
  } catch { return []; }
}

async function appendStocksTransaction(env, guildId, userId, txn) {
  const list = await getStocksTransactions(env, guildId, userId);
  list.push(txn);
  const trimmed = list.length > TXN_CAP ? list.slice(-TXN_CAP) : list;
  await env.LOADOUT_BOLTS.put(
    `stock:txns:${guildId}:${userId}`,
    JSON.stringify(trimmed),
  );
}

// Compute per-ticker average cost basis from the transaction log.
// FIFO would give different unrealized-PnL on partial sells; we use
// AVERAGE-COST because the player doesn't pick lots — the UI shows
// "your average cost was X, current price is Y" which is intuitive
// and matches how real brokerages display unrealized gains on
// taxable accounts (HIFO/FIFO is a tax-filing concept only).
//
// Returns { [ticker]: { qty, totalCost } } where totalCost includes
// fees so the average reflects the all-in price the player paid.
// On a sell we DON'T mutate totalCost proportionally — we instead
// reduce qty by the sold amount and lower totalCost by the same
// proportion, preserving the avg-cost per remaining share.
// Build the full web-portfolio payload — every position the user
// holds (or has previously closed) plus aggregate totals, recent
// txns, and derived stats. The shape is consumed verbatim by the
// site's /play/stocks page; keeping derivation here means Discord
// + the panel can grow to use it too without re-implementing.
export async function buildStocksPortfolio(env, guildId, userId) {
  const [holdings, txns, catalog] = await Promise.all([
    getHoldings(env, guildId, userId),
    getStocksTransactions(env, guildId, userId),
    getCatalog(env),
  ]);
  const { positions, realized } = computeCostBasis(txns);
  // Resolve current price + history per ticker. Walk the union of
  // tickers in holdings + cost-basis (closed positions show 0 qty
  // but non-zero realized).
  const tickers = new Set([
    ...Object.keys(holdings || {}),
    ...Object.keys(positions || {}),
  ]);
  const out = [];
  for (const t of tickers) {
    const def = (catalog?.tickers || []).find(
      (x) => (x.ticker || '').toUpperCase() === t,
    );
    const rec = await getPrice(env, t);
    const currentPrice = (rec && rec.price) || null;
    const pos = positions[t] || { qty: 0, totalCost: 0 };
    const qtyHeld = Number(holdings[t]) || 0;
    // Holdings KV is authoritative for qty (cron-resilient); txn log
    // is authoritative for cost-basis math. Mismatch should be 0 in
    // practice but we surface whichever side knows it.
    const qty = qtyHeld;
    const avgCost = pos.qty > 0 ? pos.totalCost / pos.qty : 0;
    const value = currentPrice != null ? qty * currentPrice : null;
    const unrealizedPnl = value != null
      ? value - (avgCost * qty)
      : null;
    const realizedPnl = Math.round(realized[t] || 0);
    out.push({
      ticker: t,
      name: def?.name || t,
      qty,
      avgCost: Math.round(avgCost * 100) / 100,
      currentPrice,
      value: value != null ? Math.round(value) : null,
      unrealizedPnl: unrealizedPnl != null ? Math.round(unrealizedPnl) : null,
      realizedPnl,
    });
  }
  // Sort by current value desc — biggest positions on top, closed
  // positions with realized PnL at the bottom.
  out.sort((a, b) => (b.value || 0) - (a.value || 0));

  const totalValue = out.reduce((s, p) => s + (p.value || 0), 0);
  const totalCost = out.reduce((s, p) => s + p.avgCost * p.qty, 0);
  const totalUnrealized = out.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const totalRealized = out.reduce((s, p) => s + (p.realizedPnl || 0), 0);

  // Trading stats: best/worst realised trade by net P&L on the
  // matching buy-side avg-cost. Walk txns and pair each sell with
  // the running avg-cost at that moment. (computeCostBasis already
  // did the heavy lift in pass; we re-walk just to capture per-trade
  // P&L without changing its return shape.)
  const trades = [];
  const running = {};
  for (const t of txns) {
    if (!t || !t.ticker) continue;
    const k = t.ticker;
    if (!running[k]) running[k] = { qty: 0, totalCost: 0 };
    const shares = Math.max(0, Number(t.shares) || 0);
    if (t.action === 'buy') {
      running[k].qty += shares;
      running[k].totalCost += Math.max(0, Number(t.bolts) || 0);
    } else if (t.action === 'sell') {
      const avg = running[k].qty > 0 ? running[k].totalCost / running[k].qty : 0;
      const basis = avg * shares;
      const pnl = (Number(t.bolts) || 0) - basis;
      trades.push({ asOf: t.asOf, ticker: k, shares, price: t.price, pnl: Math.round(pnl) });
      running[k].qty = Math.max(0, running[k].qty - shares);
      running[k].totalCost = Math.max(0, running[k].totalCost - basis);
      if (running[k].qty === 0) running[k].totalCost = 0;
    }
  }
  const bestTrade = trades.reduce(
    (best, t) => (!best || t.pnl > best.pnl ? t : best),
    null,
  );
  const worstTrade = trades.reduce(
    (worst, t) => (!worst || t.pnl < worst.pnl ? t : worst),
    null,
  );

  return {
    ok: true,
    positions: out,
    totals: {
      value: Math.round(totalValue),
      cost: Math.round(totalCost),
      unrealizedPnl: Math.round(totalUnrealized),
      realizedPnl: Math.round(totalRealized),
    },
    transactions: txns.slice(-50).reverse(), // most recent first, last 50
    stats: {
      tradesCount: trades.length,
      bestTrade,
      worstTrade,
      firstTradeAt: txns[0]?.asOf || null,
    },
  };
}

export function computeCostBasis(transactions) {
  const positions = {};
  // Realised P&L per ticker — running sum of (proceeds - basisRemoved)
  // across all sells. proceeds is net (after fee); basisRemoved is
  // qtyAvg * sharesSold so realized number reflects the actual gain
  // a player would book on that sale.
  const realized = {};
  for (const t of transactions) {
    if (!t || !t.ticker) continue;
    const k = t.ticker;
    if (!positions[k]) positions[k] = { qty: 0, totalCost: 0 };
    if (!realized[k]) realized[k] = 0;
    const shares = Math.max(0, Number(t.shares) || 0);
    if (t.action === 'buy') {
      const bolts = Math.max(0, Number(t.bolts) || 0);
      positions[k].qty += shares;
      positions[k].totalCost += bolts; // bolts = price*shares + fee
    } else if (t.action === 'sell') {
      const avg = positions[k].qty > 0
        ? positions[k].totalCost / positions[k].qty
        : 0;
      const basisRemoved = avg * shares;
      const net = Math.max(0, Number(t.bolts) || 0); // sell stores NET (gross - fee)
      realized[k] += net - basisRemoved;
      positions[k].qty = Math.max(0, positions[k].qty - shares);
      positions[k].totalCost = Math.max(0, positions[k].totalCost - basisRemoved);
      if (positions[k].qty === 0) positions[k].totalCost = 0;
    }
  }
  return { positions, realized };
}

// ---- Source fetchers ---------------------------------------------------

// Yahoo Finance chart API. No auth — just needs a User-Agent. Smallest
// useful payload: ?interval=1d&range=2d. We only read meta.regularMarketPrice
// (Yahoo gives the last-close price outside regular trading hours, so
// bots can still trade weekends + after-hours at the last close).
export async function fetchYahooStockPrice(symbol) {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/' +
        encodeURIComponent(symbol) +
        '?interval=1d&range=2d',
      { headers: { 'User-Agent': YAHOO_UA } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const r = d && d.chart && d.chart.result && d.chart.result[0];
    if (!r) return null;
    const price = r.meta && r.meta.regularMarketPrice;
    if (typeof price !== 'number' || !isFinite(price)) return null;
    return price;
  } catch { return null; }
}

async function fetchSourceValue(env, t) {
  switch (String(t.source)) {
    case 'yahoo_stock': return fetchYahooStockPrice(t.sourceRef);
    default: return null;
  }
}

function priceFromRaw(t, raw) {
  if (raw == null) return null;
  const multiplier = Number(t.multiplier);
  if (!isFinite(multiplier) || multiplier <= 0) return null;
  return Math.max(1, Math.floor(raw * multiplier));
}

// ---- Cron tick ---------------------------------------------------------

// Iterate every ticker, fetch the source value, compute price, write
// the new latest + append to history. Per-ticker errors don't abort
// the rest of the tick — the next cron will retry.
export async function stocksCronTick(env) {
  await migrateIfNeeded(env);
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
  // After prices are refreshed, push the auto-update channel board for
  // every guild that has one bound. Errors here are isolated per guild.
  try { await refreshAllTickerBoards(env); } catch { /* idle */ }
  return updated;
}

// ---- Auto-update channel ticker board ---------------------------------

const TICKER_GUILD_PREFIX = 'stocks:ticker:guild:';

async function setTickerBoard(env, guildId, channelId, messageId) {
  await env.LOADOUT_BOLTS.put(
    TICKER_GUILD_PREFIX + guildId,
    JSON.stringify({ channelId, messageId, boundAt: Date.now() }),
  );
}

async function clearTickerBoard(env, guildId) {
  await env.LOADOUT_BOLTS.delete(TICKER_GUILD_PREFIX + guildId);
}

async function getTickerBoard(env, guildId) {
  try {
    return await env.LOADOUT_BOLTS.get(TICKER_GUILD_PREFIX + guildId, { type: 'json' });
  } catch { return null; }
}

// Programmatic bind/unbind for the /admin Setup & Status dashboard.
// Skips the memberPermissions check the slash-command path uses, because
// /admin is itself gated to MANAGE_GUILD via default_member_permissions.
// Returns { ok, channelId?, messageId?, reason? } so the caller can surface
// channel-perm errors in the dashboard instead of silently swallowing them.
export async function bindTickerBoard(env, guildId, channelId) {
  if (!channelId) return { ok: false, reason: 'no channel id' };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, reason: 'bot token missing' };
  const embed = await buildTickerEmbed(env);
  const posted = await discordPostMessage(env, channelId, { embeds: [embed] });
  if (!posted || !posted.id) {
    return { ok: false, reason: "can't post in that channel -- check Send Messages + Embed Links perms" };
  }
  await setTickerBoard(env, guildId, channelId, posted.id);
  return { ok: true, channelId, messageId: posted.id };
}

export async function unbindTickerBoard(env, guildId) {
  await clearTickerBoard(env, guildId);
  return { ok: true };
}

// Read-only helper for the admin dashboard.
export async function getTickerBoardForGuild(env, guildId) {
  return getTickerBoard(env, guildId);
}

async function listTickerBoards(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.LOADOUT_BOLTS.list({ prefix: TICKER_GUILD_PREFIX, cursor });
    for (const k of r.keys) {
      const guildId = k.name.slice(TICKER_GUILD_PREFIX.length);
      const v = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (v && v.channelId && v.messageId) out.push({ guildId, ...v });
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

// Renders the embed payload for the ticker board. One embed with a
// monospace table of every ticker's price + 24h change.
async function buildTickerEmbed(env) {
  const catalog = await getCatalog(env);
  const tickers = catalog.tickers || [];
  const rows = [];
  for (const t of tickers) {
    const rec = await getPrice(env, t.ticker);
    const hist = await getHistory(env, t.ticker);
    const price = rec ? rec.price : null;
    const change = pctChange(hist);
    const sign = change == null ? '' : (change >= 0 ? '+' : '');
    const changeStr = change == null ? '—' : (sign + change.toFixed(1) + '%');
    rows.push(
      String(t.ticker).padEnd(6) +
      (price == null ? '—'.padStart(7) : String(price).padStart(7)) + '  ' +
      changeStr.padStart(7) + '   ' +
      t.name,
    );
  }
  const table = 'TICKER  PRICE   24H Δ    NAME\n' + rows.join('\n');
  return {
    title: '📈 Aquilo Stocks',
    description: '```\n' + table + '\n```',
    color: 0x3a86ff,
    footer: { text: 'Bolts-denominated · updated hourly · use /stocks for details' },
    timestamp: new Date().toISOString(),
  };
}

// PATCH a channel message in place via the Discord REST API. Returns
// true on success, false on any failure (404 = message deleted, etc.).
async function discordPatchMessage(env, channelId, messageId, body) {
  if (!env.DISCORD_BOT_TOKEN) return false;
  try {
    const res = await fetch(
      'https://discord.com/api/v10/channels/' +
        encodeURIComponent(channelId) +
        '/messages/' +
        encodeURIComponent(messageId),
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function discordPostMessage(env, channelId, body) {
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

async function refreshAllTickerBoards(env) {
  const boards = await listTickerBoards(env);
  if (boards.length === 0) return;
  const embed = await buildTickerEmbed(env);
  for (const b of boards) {
    const ok = await discordPatchMessage(env, b.channelId, b.messageId, { embeds: [embed] });
    if (!ok) {
      // Message deleted or channel gone — release the binding so we
      // don't keep retrying every hour.
      await clearTickerBoard(env, b.guildId);
    }
  }
}

// ---- Slash command dispatcher ------------------------------------------

export async function handleStocks(env, guildId, userId, userName, options, memberPermissions, channelId) {
  const sub = (options && options[0]) || {};
  const args = {};
  for (const o of (sub.options || [])) args[o.name] = o.value;
  switch (sub.name) {
    case 'list':          return slashReply(await renderStocksList(env));
    case 'buy':           return slashReply(await runBuy(env, guildId, userId, args));
    case 'sell':          return slashReply(await runSell(env, guildId, userId, args));
    case 'portfolio':     return slashReply(await renderPortfolio(env, guildId, userId));
    case 'chart':         return slashReply(await renderChart(env, args));
    case 'ticker-setup':  return slashReply(await setupTickerBoard(env, guildId, channelId, memberPermissions));
    case 'ticker-clear':  return slashReply(await clearTickerBoardCmd(env, guildId, memberPermissions));
    default:              return slashReply('Unknown subcommand.');
  }
}

function slashReply(content) {
  return {
    type: RESP_CHAT,
    data: { content, flags: FLAG_EPHEMERAL },
  };
}

function isAdmin(memberPermissions) {
  if (!memberPermissions) return false;
  try {
    const p = typeof memberPermissions === 'bigint'
      ? memberPermissions
      : BigInt(String(memberPermissions));
    return (p & BigInt(PERMISSION_MANAGE_GUILD)) !== 0n;
  } catch { return false; }
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
// fewer is fine, just a shorter window. Null when there's no usable base.
function pctChange(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const slice = history.slice(-24);
  const first = slice[0].price;
  const last = slice[slice.length - 1].price;
  if (!first) return null;
  return ((last - first) / first) * 100;
}

export async function renderStocksList(env) {
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

// Discord call site (handleStocks) takes the string form. Web /web/stocks/buy
// reads the structured form; both share the same code path via runBuyJson.
export async function runBuy(env, guildId, userId, args) {
  return (await runBuyJson(env, guildId, userId, args)).message;
}

export async function runBuyJson(env, guildId, userId, args) {
  const ticker = String(args.ticker || '').toUpperCase();
  const bolts = Math.max(1, Math.floor(Number(args.bolts) || 0));
  const catalog = await getCatalog(env);
  const def = findTicker(catalog, ticker);
  if (!def) return { ok: false, error: 'unknown-ticker', message: 'Unknown ticker: `' + ticker + '`.' };
  const rec = await getPrice(env, def.ticker);
  if (!rec || !rec.price) {
    return { ok: false, error: 'no-price', message: 'No price yet for `' + def.ticker + '` — try again after the next cron tick.' };
  }
  const price = rec.price;
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < bolts) {
    return { ok: false, error: 'insufficient-bolts', balance: wallet.balance || 0, message: 'You have ' + fmtNum(wallet.balance || 0) + ' bolts; need ' + fmtNum(bolts) + '.' };
  }
  const grossPerShare = price * (1 + FEE_PCT / 100);
  const shares = Math.floor(bolts / grossPerShare);
  if (shares <= 0) {
    return {
      ok: false,
      error: 'too-small',
      message: 'At ' + price + ' bolts/share + ' + FEE_PCT + '% fee you need at least ' + Math.ceil(grossPerShare) + ' bolts for one share.',
    };
  }
  const cost = shares * price;
  const fee = calcFee(cost);
  const total = cost + fee;
  const r = await spend(env, guildId, userId, total, 'stocks-buy:' + def.ticker);
  if (!r || !r.ok) {
    return { ok: false, error: 'wallet-error', message: "Couldn't debit " + fmtNum(total) + ' bolts: ' + (r && r.reason || 'wallet error') + '.' };
  }
  const holdings = await getHoldings(env, guildId, userId);
  holdings[def.ticker] = (Number(holdings[def.ticker]) || 0) + shares;
  await putHoldings(env, guildId, userId, holdings);
  const balance = (r.wallet && r.wallet.balance) || 0;
  // Append to the per-user transaction log. `bolts` here is the
  // all-in cost (price*shares + fee) so cost-basis averaging stays
  // accurate. Wrap in a swallow so a KV failure can't roll back the
  // successful trade — worst case the txn doesn't appear in history.
  try {
    await appendStocksTransaction(env, guildId, userId, {
      asOf: new Date().toISOString(),
      action: 'buy',
      ticker: def.ticker,
      shares,
      price,
      bolts: total,
      fee,
      balanceAfter: balance,
    });
  } catch { /* non-fatal */ }
  return {
    ok: true,
    ticker: def.ticker,
    shares,
    price,
    cost,
    fee,
    total,
    balance,
    holdings: holdings[def.ticker],
    message:
      '📈 Bought **' + shares + '** share' + (shares === 1 ? '' : 's') +
      ' of `' + def.ticker + '` at ' + price + ' bolts each.\n' +
      'Cost ' + fmtNum(cost) + ' + ' + fmtNum(fee) + ' fee = ' + fmtNum(total) +
      ' bolts · Balance ' + fmtNum(balance) + '.',
  };
}

export async function runSell(env, guildId, userId, args) {
  return (await runSellJson(env, guildId, userId, args)).message;
}

export async function runSellJson(env, guildId, userId, args) {
  const ticker = String(args.ticker || '').toUpperCase();
  const shares = Math.max(1, Math.floor(Number(args.shares) || 0));
  const catalog = await getCatalog(env);
  const def = findTicker(catalog, ticker);
  if (!def) return { ok: false, error: 'unknown-ticker', message: 'Unknown ticker: `' + ticker + '`.' };
  const rec = await getPrice(env, def.ticker);
  if (!rec || !rec.price) {
    return { ok: false, error: 'no-price', message: 'No price yet for `' + def.ticker + '`.' };
  }
  const holdings = await getHoldings(env, guildId, userId);
  const held = Number(holdings[def.ticker]) || 0;
  if (held < shares) {
    return { ok: false, error: 'insufficient-shares', held, message: 'You only hold ' + held + ' share' + (held === 1 ? '' : 's') + ' of `' + def.ticker + '`.' };
  }
  const price = rec.price;
  const gross = shares * price;
  const fee = calcFee(gross);
  const net = Math.max(0, gross - fee);
  holdings[def.ticker] = held - shares;
  if (holdings[def.ticker] <= 0) delete holdings[def.ticker];
  await putHoldings(env, guildId, userId, holdings);
  const credited = await earn(env, guildId, userId, net, 'stocks-sell:' + def.ticker);
  const balance = (credited && credited.balance) || 0;
  // `bolts` for a sell is the NET proceeds credited to the wallet
  // (gross - fee). computeCostBasis() interprets it that way.
  try {
    await appendStocksTransaction(env, guildId, userId, {
      asOf: new Date().toISOString(),
      action: 'sell',
      ticker: def.ticker,
      shares,
      price,
      bolts: net,
      fee,
      balanceAfter: balance,
    });
  } catch { /* non-fatal */ }
  return {
    ok: true,
    ticker: def.ticker,
    shares,
    price,
    gross,
    fee,
    net,
    balance,
    holdings: holdings[def.ticker] || 0,
    message:
      '📉 Sold **' + shares + '** share' + (shares === 1 ? '' : 's') +
      ' of `' + def.ticker + '` at ' + price + ' bolts each.\n' +
      'Gross ' + fmtNum(gross) + ' − ' + fmtNum(fee) + ' fee = ' + fmtNum(net) +
      ' bolts · Balance ' + fmtNum(balance) + '.',
  };
}

export async function renderPortfolio(env, guildId, userId) {
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

export async function renderChart(env, args) {
  const ticker = String(args.ticker || '').toUpperCase();
  const catalog = await getCatalog(env);
  const def = findTicker(catalog, ticker);
  if (!def) return 'Unknown ticker: `' + ticker + '`.';
  const history = await getHistory(env, def.ticker);
  if (history.length < 2) {
    return 'Not enough history yet for `' + ticker + '` (need 2+ cron ticks).';
  }
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

// Public read-only snapshot for the aquilo.gg /stocks page + the Twitch
// panel's read-only Stocks tab. Returns the catalog + every ticker's
// current price + a downsampled history slice for sparklines. No auth
// gate, no user data — viewers can browse without signing in.
export async function publicStocksSnapshot(env) {
  const catalog = await getCatalog(env);
  const prices = {};
  const history = {};
  for (const t of (catalog.tickers || [])) {
    const rec = await getPrice(env, t.ticker);
    if (rec) prices[t.ticker] = { price: rec.price, raw: rec.raw, asOf: rec.asOf };
    const h = await getHistory(env, t.ticker);
    // Downsample to ~30 points so the response stays small + the
    // sparkline reads cleanly without resampling client-side.
    if (h.length === 0) { history[t.ticker] = []; continue; }
    const N = Math.min(30, h.length);
    const step = h.length / N;
    const slice = [];
    for (let i = 0; i < N; i++) {
      const idx = Math.min(h.length - 1, Math.floor(i * step));
      slice.push({ price: h[idx].price, asOf: h[idx].asOf });
    }
    history[t.ticker] = slice;
  }
  return json({
    catalog: (catalog.tickers || []).map((t) => ({
      ticker: t.ticker, name: t.name, source: t.source, sourceRef: t.sourceRef,
    })),
    prices,
    history,
    asOf: new Date().toISOString(),
  });
}

async function setupTickerBoard(env, guildId, channelId, memberPermissions) {
  if (!isAdmin(memberPermissions)) {
    return 'Manage Server permission required for `/stocks ticker-setup`.';
  }
  if (!channelId) return "Couldn't read the current channel.";
  // Post a fresh placeholder, store its id, then patch it with the
  // real embed straight away so the channel sees prices immediately.
  const embed = await buildTickerEmbed(env);
  const posted = await discordPostMessage(env, channelId, { embeds: [embed] });
  if (!posted || !posted.id) {
    return "Couldn't post in this channel — make sure the bot can Send Messages and Embed Links here.";
  }
  await setTickerBoard(env, guildId, channelId, posted.id);
  return '📌 This channel is now the auto-updating stocks ticker. The board refreshes every hour.';
}

async function clearTickerBoardCmd(env, guildId, memberPermissions) {
  if (!isAdmin(memberPermissions)) {
    return 'Manage Server permission required for `/stocks ticker-clear`.';
  }
  const cur = await getTickerBoard(env, guildId);
  if (!cur) return 'No ticker board is bound for this server.';
  await clearTickerBoard(env, guildId);
  return '✅ Ticker board released. The previous message stays in the channel; the bot just stops updating it.';
}
