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
          tier: Number(s.tier) || 1000,
        });
        if (s.is_gift) {
          const g = s.gifter_name || s.gifter_login;
          if (g && g !== 'AnAnonymousGifter') gifterCounts.set(g, (gifterCounts.get(g) || 0) + 1);
        }
      }
      cursor = j.pagination && j.pagination.cursor;
      if (!cursor) break;
    }
  } catch { /* best-effort */ }

  // Higher tier first, then alphabetical.
  subscribers.sort((a, b) => (b.tier - a.tier) || a.name.localeCompare(b.name));

  const topGifters = [...gifterCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // ── Top cheerers (bits leaderboard for the token's broadcaster; bits:read) ──
  let topCheerers = [];
  try {
    const j = await helixFetch(env, '/bits/leaderboard', { count: 10, period: 'all' }, { userToken: true });
    if (j && Array.isArray(j.data)) {
      topCheerers = j.data
        .map((e) => ({ name: e.user_name || e.user_login || 'viewer', bits: Number(e.score) || 0 }))
        .filter((e) => e.bits > 0);
    }
  } catch { /* best-effort */ }

  return json({
    ok: true,
    subCount,
    subscribers: subscribers.slice(0, MAX_SUB_NAMES),
    topCheerers,
    topGifters,
  });
}
