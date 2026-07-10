// Bolts earn engine for the in-panel extension economy (multi-tenant).
//
// Before this, the ONLY Bolts faucet on a non-Clay channel was the casino
// daily claim (100/day) — every game has a house edge, so the supply only
// deflated. This adds the two earn sources that make the economy real on ANY
// channel:
//   • watch-time  — a heartbeat the panel fires while it's open; credits a
//     few Bolts/minute, server-rate-limited, daily-capped, and gated on the
//     stream actually being LIVE (cached app-token /streams check).
//   • bonuses     — one-time Follow + (monthly) Sub claims, VERIFIED against
//     the channel's own broadcaster vault token (moderator:read:followers /
//     channel:read:subscriptions, which the vault already carries). Graceful
//     no-op when the streamer hasn't connected Aquilo.
//
// Multi-tenant: `guildId`/`userId` are the per-channel namespace + viewer id
// (nsFor), used verbatim; every KV key includes guildId so it's isolated.

import { getWallet, earn } from './wallet.js';
import { walletView } from './ext-econ.js';
import { getAppAccessToken } from './twitch-helix.js';
import { vaultHelix } from './warden-twitch.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

// ── tuning ────────────────────────────────────────────────────────────
const TICK_MIN_MS = 55_000;   // min gap between credited watch ticks (panel polls ~60s)
const TICK_BOLTS = 2;         // Bolts per credited minute of watching
const WATCH_CAP_PER_DAY = 300; // daily watch-time cap (~2.5h to max)
const FOLLOW_BONUS = 250;     // one-time
const SUB_BONUS = 500;        // re-claimable monthly
const SUB_BONUS_TTL = 30 * 24 * 3600;
const LIVE_TTL = 60;          // seconds to cache a channel's live status

const tickKey = (g, u) => `earntick:${g}:${u}`;
const followKey = (g, u) => `earnfollow:${g}:${u}`;
const subKey = (g, u) => `earnsub:${g}:${u}`;
const liveKey = (ch) => `extlive:${ch}`;

const today = () => new Date().toISOString().slice(0, 10);

// ── live gate ───────────────────────────────────────────────────────────
// One cached app-token /streams check per channel per minute (independent of
// viewer count). Fail-OPEN: if we genuinely can't check (no app token / API
// down), don't silently break earning — the daily cap still bounds abuse.
async function isLive(env, channelId) {
  if (!channelId) return false;
  try {
    const cached = await env.LOADOUT_BOLTS.get(liveKey(channelId));
    if (cached != null) return cached === '1';
  } catch { /* fall through to fetch */ }
  let live = true; // fail-open default
  try {
    const tok = await getAppAccessToken(env);
    if (tok) {
      const r = await fetch('https://api.twitch.tv/helix/streams?user_id=' + encodeURIComponent(channelId), {
        headers: { Authorization: 'Bearer ' + tok, 'Client-Id': env.TWITCH_CLIENT_ID },
      });
      if (r.ok) {
        const j = await r.json();
        live = !!(j && Array.isArray(j.data) && j.data.length);
      }
    }
    await env.LOADOUT_BOLTS.put(liveKey(channelId), live ? '1' : '0', { expirationTtl: LIVE_TTL });
  } catch { /* keep fail-open live=true */ }
  return live;
}

// ── watch-time heartbeat ─────────────────────────────────────────────────
async function handleTick(env, guildId, userId, channelId) {
  const now = Date.now();
  const day = today();
  let st = null;
  try { st = await env.LOADOUT_BOLTS.get(tickKey(guildId, userId), { type: 'json' }); } catch { /* default */ }
  st = st || { ts: 0, day, earned: 0 };
  if (st.day !== day) { st.day = day; st.earned = 0; }

  const base = { ok: true, earnedToday: st.earned, cap: WATCH_CAP_PER_DAY };
  const withWallet = async (extra) => json({ ...base, ...extra, credited: extra.credited || 0, wallet: await walletView(env, guildId, userId) });

  if (st.ts && now - st.ts < TICK_MIN_MS) return withWallet({ throttled: true }); // too soon
  if (st.earned >= WATCH_CAP_PER_DAY) return withWallet({ capped: true });
  if (!(await isLive(env, channelId))) return withWallet({ offline: true });

  const credit = Math.min(TICK_BOLTS, WATCH_CAP_PER_DAY - st.earned);
  st.ts = now;
  st.earned += credit;
  try { await env.LOADOUT_BOLTS.put(tickKey(guildId, userId), JSON.stringify(st), { expirationTtl: 3 * 24 * 3600 }); } catch { /* best-effort */ }
  if (credit > 0) await earn(env, guildId, userId, credit, 'watch');
  base.earnedToday = st.earned;
  return withWallet({ credited: credit });
}

// ── follow / sub bonuses ─────────────────────────────────────────────────
async function claimed(env, key) {
  try { return !!(await env.LOADOUT_BOLTS.get(key)); } catch { return false; }
}

async function handleBonus(env, guildId, userId, channelId, twId, body) {
  const kind = body && body.kind === 'sub' ? 'sub' : 'follow';
  if (!channelId || !twId) {
    return json({ error: 'identity-required', message: 'Share your Twitch identity to claim.' }, 400);
  }

  if (kind === 'follow') {
    if (await claimed(env, followKey(guildId, userId))) {
      return json({ error: 'claimed', message: 'Follow bonus already claimed.' }, 429);
    }
    const r = await vaultHelix(env, channelId, '/channels/followers', { params: { broadcaster_id: channelId, user_id: twId } });
    if (!r.ok) return json({ error: 'unverified', message: "Couldn't verify — the streamer needs to connect Aquilo." }, 400);
    const following = !!(r.data && Array.isArray(r.data.data) && r.data.data.length);
    if (!following) return json({ error: 'not-following', message: 'Follow the channel first, then claim!' }, 400);
    try { await env.LOADOUT_BOLTS.put(followKey(guildId, userId), '1'); } catch { /* best-effort */ }
    await earn(env, guildId, userId, FOLLOW_BONUS, 'bonus:follow');
    return json({ ok: true, kind, amount: FOLLOW_BONUS, wallet: await walletView(env, guildId, userId) });
  }

  // sub — monthly re-claimable
  if (await claimed(env, subKey(guildId, userId))) {
    return json({ error: 'claimed', message: 'Sub bonus already claimed this month.' }, 429);
  }
  const r = await vaultHelix(env, channelId, '/subscriptions/user', { params: { broadcaster_id: channelId, user_id: twId } });
  if (r.status === 404) return json({ error: 'not-sub', message: 'Subscribe to claim the sub bonus!' }, 400);
  if (!r.ok) return json({ error: 'unverified', message: "Couldn't verify — the streamer needs to connect Aquilo." }, 400);
  try { await env.LOADOUT_BOLTS.put(subKey(guildId, userId), String(Date.now()), { expirationTtl: SUB_BONUS_TTL }); } catch { /* best-effort */ }
  await earn(env, guildId, userId, SUB_BONUS, 'bonus:sub');
  return json({ ok: true, kind, amount: SUB_BONUS, wallet: await walletView(env, guildId, userId) });
}

// ── state (what the panel renders) ───────────────────────────────────────
async function handleState(env, guildId, userId) {
  const [followClaimed, subRec, tickSt] = await Promise.all([
    claimed(env, followKey(guildId, userId)),
    env.LOADOUT_BOLTS.get(subKey(guildId, userId)).catch(() => null),
    env.LOADOUT_BOLTS.get(tickKey(guildId, userId), { type: 'json' }).catch(() => null),
  ]);
  const earnedToday = (tickSt && tickSt.day === today()) ? (tickSt.earned || 0) : 0;
  return json({
    ok: true,
    watch: { earnedToday, cap: WATCH_CAP_PER_DAY, perMin: TICK_BOLTS },
    bonuses: {
      follow: { amount: FOLLOW_BONUS, claimed: !!followClaimed },
      sub: { amount: SUB_BONUS, claimed: !!subRec },
    },
  });
}

// ── entry point ──────────────────────────────────────────────────────────
// sub: 'state' (GET) | 'tick' (POST) | 'bonus' (POST {kind}).
// meta = { twId, name, isClay, channelId }.
export async function handleEarn(env, guildId, userId, sub, req, meta) {
  meta = meta || {};
  const channelId = meta.channelId ? String(meta.channelId) : '';

  if (sub === 'state') return handleState(env, guildId, userId);

  const body = await req.json().catch(() => ({}));
  if (sub === 'tick') return handleTick(env, guildId, userId, channelId);
  if (sub === 'bonus') return handleBonus(env, guildId, userId, channelId, String(meta.twId || ''), body);
  return json({ error: 'not-found' }, 404);
}
