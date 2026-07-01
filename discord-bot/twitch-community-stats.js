// GET /community/twitch-stats
//
// The owner's Twitch subscriber list, top cheerers, and top sub-gifters for
// the aquilo.gg community page (replaces the old Patron wall). Uses the
// broadcaster USER token — channel:read:subscriptions + bits:read are both
// granted (see twitch-oauth.js REQUIRED_SCOPES). Never throws; degrades to
// empty lists when the token/scope isn't available so the page stays calm.
//
// Response:
//   { ok, subCount, subscribers:[{name,tier}], topCheerers:[{name,bits}],
//     topGifters:[{name,count}] }

import { helixFetch, isTwitchConfigured, hasTwitchUserAuth } from './twitch-helix.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      // The Pages proxy edge-caches; keep the worker response fresh-ish.
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

  // ── Subscribers (broadcaster user token; channel:read:subscriptions) ──
  const subscribers = [];
  const gifterCounts = new Map();
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
        if (s.is_gift) {
          const gName = s.gifter_name || s.gifter_login;
          if (gName && gName !== 'AnAnonymousGifter') {
            const key = s.gifter_id || gName;
            const cur = gifterCounts.get(key) || { name: gName, login: s.gifter_login || '', count: 0 };
            cur.count += 1;
            gifterCounts.set(key, cur);
          }
        }
      }
      cursor = j.pagination && j.pagination.cursor;
      if (!cursor) break;
    }
  } catch { /* best-effort */ }

  // Higher tier first, then alphabetical.
  subscribers.sort((a, b) => (b.tier - a.tier) || a.name.localeCompare(b.name));

  const topGifters = [...gifterCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // ── Top cheerers (bits leaderboard for the token's broadcaster; bits:read).
  // Two periods so the site can rotate all-time ↔ this-month ("last 30 days";
  // Twitch's leaderboard periods are day/week/month/year/all, so 'month' is
  // the closest 30-day window). ──
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

  return json({
    ok: true,
    subCount,
    subscribers: subscribers.slice(0, MAX_SUB_NAMES),
    topCheerers,        // all time
    topCheerersMonth,   // this month (~last 30 days)
    topGifters,         // active gifted subs (snapshot; not time-windowed)
  });
}
