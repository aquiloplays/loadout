// GET /community/twitch-stats
//
// The owner's Twitch subscriber list (with tenure where known), top cheerers
// (all-time + this-month), and top sub-gifters (all-time + last-30-day) for
// the aquilo.gg community page. Uses the broadcaster USER token —
// channel:read:subscriptions + bits:read are granted (twitch-oauth.js).
//
// Gifters + tenure come from twitch-stats-store.js: Twitch has no historical
// gifter API and no bulk sub-tenure field, so we seed the gifter history and
// accumulate both forward from EventSub. Never throws; degrades to empty.
//
// Response:
//   { ok, subCount, subscribers:[{name,login,tier,months?}],
//     topCheerers:[{name,login,bits}], topCheerersMonth:[...],
//     topGifters:[{name,login,count}], topGiftersMonth:[...] }

import { helixFetch, isTwitchConfigured, hasTwitchUserAuth } from './twitch-helix.js';
import { seedGiftersOnce, getGifterStats, getSubTenure } from './twitch-stats-store.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=0, s-maxage=60',
      'access-control-allow-origin': '*',
    },
  });
}

const MAX_SUB_PAGES = 30;    // up to 3000 subs @ 100/page
const MAX_SUB_NAMES = 200;   // cap the returned name list (subCount carries the total)

export async function handleTwitchStats(req, env) {
  if (!isTwitchConfigured(env)) return json({ ok: false, error: 'twitch-not-configured' });
  const broadcasterId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  if (!broadcasterId) return json({ ok: false, error: 'no-broadcaster' });
  if (!(await hasTwitchUserAuth(env))) return json({ ok: false, error: 'no-user-token' });

  // One-time seed of the historical all-time gifters (idempotent).
  await seedGiftersOnce(env).catch(() => {});

  // ── Subscribers (broadcaster user token; channel:read:subscriptions) ──
  const subscribers = [];
  let subCount = 0;
  try {
    let cursor;
    for (let page = 0; page < MAX_SUB_PAGES; page++) {
      const params = { broadcaster_id: broadcasterId, first: 100 };
      if (cursor) params.after = cursor;
      const j = await helixFetch(env, '/subscriptions', params, { userToken: true });
      if (!j || !Array.isArray(j.data)) break;
      for (const s of j.data) {
        if (String(s.user_id) === broadcasterId) continue;   // broadcaster's own auto-entry
        subCount++;
        subscribers.push({
          name: s.user_name || s.user_login || 'viewer',
          login: s.user_login || '',
          tier: Number(s.tier) || 1000,
        });
      }
      cursor = j.pagination && j.pagination.cursor;
      if (!cursor) break;
    }
  } catch { /* best-effort */ }

  // Attach sub tenure (months) where we've observed a resub. Forward-only.
  try {
    const tenure = await getSubTenure(env);
    for (const s of subscribers) {
      const m = s.login && tenure[s.login];
      if (m) s.months = Number(m) || undefined;
    }
  } catch { /* best-effort */ }

  // Higher tier first, then longest-tenured, then alphabetical.
  subscribers.sort((a, b) =>
    (b.tier - a.tier) || ((b.months || 0) - (a.months || 0)) || a.name.localeCompare(b.name));

  // ── Top cheerers (bits leaderboard; all-time + this-month for the rotation) ──
  const cheerers = async (period) => {
    try {
      const j = await helixFetch(env, '/bits/leaderboard', { count: 10, period }, { userToken: true });
      if (j && Array.isArray(j.data)) {
        return j.data
          .map((e) => ({ name: e.user_name || e.user_login || 'viewer', login: e.user_login || '', bits: Number(e.score) || 0 }))
          .filter((e) => e.bits > 0);
      }
    } catch { /* best-effort */ }
    return [];
  };
  const [topCheerers, topCheerersMonth] = await Promise.all([cheerers('all'), cheerers('month')]);

  // ── Top sub gifters (seeded history + forward accumulation) ──
  const { topGifters, topGiftersMonth } = await getGifterStats(env).catch(() => ({ topGifters: [], topGiftersMonth: [] }));

  return json({
    ok: true,
    subCount,
    subscribers: subscribers.slice(0, MAX_SUB_NAMES),
    topCheerers,
    topCheerersMonth,
    topGifters,
    topGiftersMonth,
  });
}
