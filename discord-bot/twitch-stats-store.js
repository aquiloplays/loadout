// Persistent Twitch community stats that Helix can't give us:
//   • all-time + last-30-day top sub GIFTERS — Twitch has no historical
//     gifter API, so we seed the channel's history (from the dashboard) and
//     accumulate forward from channel.subscription.gift EventSub.
//   • sub TENURE (months) per subscriber — accumulated from
//     channel.subscription.message (resub) EventSub. Forward-only: it fills
//     in as people resub, so it's incomplete until then.
//
// All in LOADOUT_BOLTS KV. Writers are EventSub-driven (rare enough that a
// single-key read-modify-write is fine).

const GIFT_ALLTIME_KEY = 'twstats:gifters:alltime';   // { login: { name, count } }
const GIFT_EVENTS_KEY  = 'twstats:gifters:events';    // [ { login, name, count, ts } ] (30d window)
const TENURE_KEY       = 'twstats:subtenure';         // { login: months }
const SEED_MARKER_KEY  = 'twstats:gifters:seeded:v1';
const THIRTY_DAYS_MS   = 30 * 24 * 60 * 60 * 1000;
const EVENTS_CAP       = 3000;

// Historical all-time gifters, from Clay's Twitch dashboard (2026-07-01).
// Keyed by login (lowercased display name). Applied once as a baseline; new
// gifts accumulate on top.
const GIFTER_SEED = {
  mousetheonly:     { name: 'MouseTheOnly',     count: 167 },
  draconicking_og:  { name: 'draconicking_og',  count: 135 },
  nebs420:          { name: 'nebs420',          count: 55 },
  thawaxshop_:      { name: 'ThaWaxShop_',      count: 29 },
  curi0cat:         { name: 'Curi0Cat',         count: 29 },
  nukaaacola_plays: { name: 'nukaaacola_plays', count: 22 },
  justcallmescope:  { name: 'JustCallMeScope',  count: 14 },
  xboredjord:       { name: 'xBoredJord',       count: 12 },
  chaithelatte:     { name: 'chaithelatte',     count: 10 },
  yournarrator:     { name: 'YourNarrator',     count: 10 },
};

export async function seedGiftersOnce(env) {
  if (!env.LOADOUT_BOLTS) return;
  if (await env.LOADOUT_BOLTS.get(SEED_MARKER_KEY)) return;   // already seeded
  const cur = (await env.LOADOUT_BOLTS.get(GIFT_ALLTIME_KEY, { type: 'json' })) || {};
  for (const [login, v] of Object.entries(GIFTER_SEED)) {
    // Baseline: keep the larger of seed vs any forward count so a re-seed
    // (or a gift that landed before seeding) never double-counts.
    const existing = cur[login];
    if (!existing || (existing.count || 0) < v.count) cur[login] = { name: v.name, count: v.count };
  }
  await env.LOADOUT_BOLTS.put(GIFT_ALLTIME_KEY, JSON.stringify(cur));
  await env.LOADOUT_BOLTS.put(SEED_MARKER_KEY, '1');
}

export async function recordGift(env, { login, name, count }) {
  if (!env.LOADOUT_BOLTS || !login) return;   // anonymous gifters (no login) are skipped
  const n = Math.max(1, Number(count) || 1);

  const all = (await env.LOADOUT_BOLTS.get(GIFT_ALLTIME_KEY, { type: 'json' })) || {};
  const cur = all[login] || { name: name || login, count: 0 };
  cur.count += n;
  if (name) cur.name = name;
  all[login] = cur;
  await env.LOADOUT_BOLTS.put(GIFT_ALLTIME_KEY, JSON.stringify(all));

  const events = (await env.LOADOUT_BOLTS.get(GIFT_EVENTS_KEY, { type: 'json' })) || [];
  const now = Date.now();
  events.push({ login, name: name || login, count: n, ts: now });
  const pruned = events.filter((e) => now - (e.ts || 0) <= THIRTY_DAYS_MS).slice(-EVENTS_CAP);
  await env.LOADOUT_BOLTS.put(GIFT_EVENTS_KEY, JSON.stringify(pruned));
}

export async function recordSubTenure(env, { login, months }) {
  if (!env.LOADOUT_BOLTS || !login || !months) return;
  const map = (await env.LOADOUT_BOLTS.get(TENURE_KEY, { type: 'json' })) || {};
  map[login] = Math.max(Number(map[login]) || 0, Number(months) || 0);
  await env.LOADOUT_BOLTS.put(TENURE_KEY, JSON.stringify(map));
}

export async function getGifterStats(env) {
  if (!env.LOADOUT_BOLTS) return { topGifters: [], topGiftersMonth: [] };
  const all = (await env.LOADOUT_BOLTS.get(GIFT_ALLTIME_KEY, { type: 'json' })) || {};
  const topGifters = Object.entries(all)
    .map(([login, v]) => ({ login, name: (v && v.name) || login, count: (v && v.count) || 0 }))
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const events = (await env.LOADOUT_BOLTS.get(GIFT_EVENTS_KEY, { type: 'json' })) || [];
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const monthMap = {};
  for (const e of events) {
    if (!e || !e.login || (e.ts || 0) < cutoff) continue;
    const m = monthMap[e.login] || { name: e.name || e.login, count: 0 };
    m.count += Number(e.count) || 1;
    if (e.name) m.name = e.name;
    monthMap[e.login] = m;
  }
  const topGiftersMonth = Object.entries(monthMap)
    .map(([login, v]) => ({ login, name: v.name, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { topGifters, topGiftersMonth };
}

export async function getSubTenure(env) {
  if (!env.LOADOUT_BOLTS) return {};
  return (await env.LOADOUT_BOLTS.get(TENURE_KEY, { type: 'json' })) || {};
}
