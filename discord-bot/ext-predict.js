// ── Bolts prediction market + Pick'em ────────────────────────────────────────
// A parimutuel wager market run by the broadcaster from the panel. Viewers
// stake Bolts on an outcome; when the streamer resolves, the whole pot is
// split among the winners in proportion to their stake. Every correct call
// also scores a season Pick'em point → a standings leaderboard.
//
//   GET  /ext/predict/state                 → current market + my bet + balance
//   POST /ext/predict/bet    {o, a}         → stake `a` Bolts on option `o`
//   GET  /ext/predict/standings             → Pick'em season standings
//   POST /ext/predict/open   {q, opts[]}    → broadcaster: open a market
//   POST /ext/predict/lock                  → broadcaster: stop new bets
//   POST /ext/predict/resolve {winner}      → broadcaster: pay out + score
//   POST /ext/predict/reset                 → broadcaster: clear the season
//
// Multi-tenant: everything is keyed by the per-channel `guildId`. Bolts moves
// through wallet.js (getWallet/spend); payouts credit the EXACT parimutuel
// amount directly (bypassing earn()'s booster multiplier so the pot balances).

import { getWallet, putWallet, spend, leaderboard } from './wallet.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json', 'cache-control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

const CUR = (g) => 'predict:' + g + ':cur';
const PICKEM = (g) => 'predict:' + g + ':pickem';
const MIN_BET = 10, MAX_BET = 100000, MAX_OPTS = 4;

function newId() {
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readMarket(env, g) {
  const m = await env.LOADOUT_BOLTS.get(CUR(g), 'json').catch(() => null);
  return (m && typeof m === 'object') ? m : null;
}
// Credit an exact amount (no booster multiplier — keeps the pot balanced).
async function credit(env, g, uid, amount) {
  if (!(amount > 0)) return;
  const w = await getWallet(env, g, uid);
  w.balance += amount;
  w.lifetimeEarned = (w.lifetimeEarned || 0) + amount;
  await putWallet(env, g, uid, w);
}

// Public view of a market: pools + backer counts per option, plus this
// viewer's own stake. Never leaks other viewers' individual bets.
function view(m, userId) {
  if (!m) return null;
  const opts = m.opts.map((o) => ({ label: o.label, pool: 0, backers: 0 }));
  let total = 0;
  const bets = m.bets || {};
  for (const uid in bets) {
    const b = bets[uid];
    if (opts[b.o]) { opts[b.o].pool += b.a; opts[b.o].backers += 1; }
    total += b.a;
  }
  const mine = bets[userId] ? { o: bets[userId].o, a: bets[userId].a } : null;
  return { id: m.id, q: m.q, status: m.status, winner: (m.winner != null ? m.winner : -1), opts, total, mine };
}

export async function handlePredict(env, guildId, userId, sub, req, gameMeta) {
  if (req.method === 'OPTIONS') return json({ ok: true });
  const isClay = !!(gameMeta && gameMeta.isClay);
  const g = guildId;

  // ── Public reads ──
  if (sub === 'state' || sub === '') {
    const m = await readMarket(env, g);
    const bal = (await getWallet(env, g, userId)).balance || 0;
    return json({ ok: true, market: view(m, userId), balance: bal, isClay });
  }
  if (sub === 'standings') {
    const t = (await env.LOADOUT_BOLTS.get(PICKEM(g), 'json').catch(() => null)) || {};
    const rows = Object.keys(t).map((uid) => ({ name: t[uid].name || 'someone', pts: t[uid].pts || 0, wins: t[uid].wins || 0 }))
      .sort((a, b) => b.pts - a.pts).slice(0, 15);
    return json({ ok: true, standings: rows });
  }

  // ── Viewer: place a stake ──
  if (sub === 'bet' && req.method === 'POST') {
    const m = await readMarket(env, g);
    if (!m || m.status !== 'open') return json({ ok: false, error: 'no-open-market' }, 409);
    let body = {}; try { body = await req.json(); } catch (e) {}
    const o = parseInt(body.o, 10);
    const a = Math.floor(Number(body.a));
    if (!(o >= 0 && o < m.opts.length)) return json({ ok: false, error: 'bad-option' }, 400);
    if (!(a >= MIN_BET && a <= MAX_BET)) return json({ ok: false, error: 'bad-amount', min: MIN_BET, max: MAX_BET }, 400);
    m.bets = m.bets || {};
    const prior = m.bets[userId];
    // One outcome per viewer per market — extra stakes add to the same side.
    if (prior && prior.o !== o) return json({ ok: false, error: 'already-backed-other', backed: prior.o }, 409);
    const sp = await spend(env, g, userId, a, 'prediction');
    if (!sp.ok) return json({ ok: false, error: 'insufficient', balance: sp.balance || 0 }, 402);
    m.bets[userId] = { o, a: (prior ? prior.a : 0) + a, n: (gameMeta && gameMeta.name) || (prior && prior.n) || '' };
    await env.LOADOUT_BOLTS.put(CUR(g), JSON.stringify(m));
    return json({ ok: true, market: view(m, userId), balance: (sp.wallet && sp.wallet.balance) || 0 });
  }

  // ── Broadcaster controls ──
  if (!isClay) return json({ ok: false, error: 'not-broadcaster' }, 403);

  if (sub === 'open' && req.method === 'POST') {
    let body = {}; try { body = await req.json(); } catch (e) {}
    const q = String(body.q || '').trim().slice(0, 120);
    const rawOpts = Array.isArray(body.opts) ? body.opts : [];
    const opts = rawOpts.map((s) => String(s || '').trim().slice(0, 40)).filter(Boolean).slice(0, MAX_OPTS);
    if (!q || opts.length < 2) return json({ ok: false, error: 'need-question-and-2-options' }, 400);
    const m = { id: newId(), q, opts: opts.map((label) => ({ label })), status: 'open', winner: -1, bets: {}, at: Date.now() };
    await env.LOADOUT_BOLTS.put(CUR(g), JSON.stringify(m));
    return json({ ok: true, market: view(m, userId) });
  }
  if (sub === 'lock' && req.method === 'POST') {
    const m = await readMarket(env, g);
    if (!m) return json({ ok: false, error: 'no-market' }, 409);
    m.status = 'locked';
    await env.LOADOUT_BOLTS.put(CUR(g), JSON.stringify(m));
    return json({ ok: true, market: view(m, userId) });
  }
  if (sub === 'resolve' && req.method === 'POST') {
    const m = await readMarket(env, g);
    if (!m) return json({ ok: false, error: 'no-market' }, 409);
    if (m.status === 'resolved') return json({ ok: false, error: 'already-resolved' }, 409);
    let body = {}; try { body = await req.json(); } catch (e) {}
    const winner = parseInt(body.winner, 10);
    if (!(winner >= 0 && winner < m.opts.length)) return json({ ok: false, error: 'bad-winner' }, 400);
    const bets = m.bets || {};
    let total = 0, winPool = 0;
    for (const uid in bets) { total += bets[uid].a; if (bets[uid].o === winner) winPool += bets[uid].a; }
    let paid = 0, winners = 0;
    if (winPool > 0) {
      // Parimutuel: winners split the WHOLE pot in proportion to their stake.
      const pickem = (await env.LOADOUT_BOLTS.get(PICKEM(g), 'json').catch(() => null)) || {};
      for (const uid in bets) {
        if (bets[uid].o !== winner) continue;
        const payout = Math.floor(bets[uid].a / winPool * total);
        if (payout > 0) { await credit(env, g, uid, payout); paid += payout; }
        winners++;
        pickem[uid] = { pts: ((pickem[uid] && pickem[uid].pts) || 0) + 1, wins: ((pickem[uid] && pickem[uid].wins) || 0) + 1, name: bets[uid].n || (pickem[uid] && pickem[uid].name) || '' };
      }
      // Cap the map so it can't grow unbounded.
      const keys = Object.keys(pickem);
      if (keys.length > 500) { const trimmed = {}; keys.sort((a, b) => (pickem[b].pts || 0) - (pickem[a].pts || 0)).slice(0, 500).forEach((k) => { trimmed[k] = pickem[k]; }); await env.LOADOUT_BOLTS.put(PICKEM(g), JSON.stringify(trimmed)); }
      else await env.LOADOUT_BOLTS.put(PICKEM(g), JSON.stringify(pickem));
    } else {
      // No one called it right → refund every stake.
      for (const uid in bets) { await credit(env, g, uid, bets[uid].a); paid += bets[uid].a; }
    }
    m.status = 'resolved'; m.winner = winner;
    await env.LOADOUT_BOLTS.put(CUR(g), JSON.stringify(m));
    return json({ ok: true, market: view(m, userId), winners, refunded: winPool === 0, paid });
  }
  if (sub === 'reset' && req.method === 'POST') {
    await env.LOADOUT_BOLTS.delete(PICKEM(g)).catch(() => {});
    return json({ ok: true });
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
