// Twitch-panel Tier 1 engagement routes — read-only viewer surfaces:
//   GET /ext/vods           — 3 most recent channel VODs (Helix, cached)
//   GET /ext/goals          — owner-authored stream goals
//   GET /ext/patron-corner  — gated extra content for subs / patrons
//
// The goals and patron-corner CONTENT is authored by owner-gated admin
// endpoints on aquilo.gg, which write the same shared LOADOUT_BOLTS KV
// namespace (a web admin page can't mint a Twitch extension JWT, so the
// writes live site-side rather than as /ext/admin/* routes here). This
// module only reads.

import { getTwitchAppToken } from './ext-loadout.js';

import { json } from './ext-shared.js';

// ---- VODs --------------------------------------------------------------
const VODS_CACHE_KEY = 'vods:cache';
const VODS_TTL = 300; // 5 minutes

// Twitch video durations look like "1h2m3s" / "12m4s" / "45s".
function parseTwitchDuration(s) {
  const str = String(s || '');
  let sec = 0;
  const h = str.match(/(\d+)h/);
  const m = str.match(/(\d+)m/);
  const ss = str.match(/(\d+)s/);
  if (h) sec += parseInt(h[1], 10) * 3600;
  if (m) sec += parseInt(m[1], 10) * 60;
  if (ss) sec += parseInt(ss[1], 10);
  return sec;
}

async function routeVods(env) {
  const cached = await env.LOADOUT_BOLTS.get(VODS_CACHE_KEY);
  if (cached) {
    try {
      return json(JSON.parse(cached));
    } catch {
      /* fall through and refetch */
    }
  }
  const channelId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  const token = await getTwitchAppToken(env);
  if (!channelId || !token || !env.TWITCH_CLIENT_ID) return json({ vods: [] });

  async function fetchVods(type) {
    try {
      const res = await fetch(
        `https://api.twitch.tv/helix/videos?user_id=${encodeURIComponent(channelId)}` +
          `&first=3&type=${type}`,
        { headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token } },
      );
      if (!res.ok) return [];
      const d = await res.json();
      return (d && d.data) || [];
    } catch {
      return [];
    }
  }

  // Prefer highlights; fall back to past broadcasts when there are none.
  let raw = await fetchVods('highlight');
  if (!raw.length) raw = await fetchVods('archive');

  const vods = raw.slice(0, 3).map((v) => ({
    id: v.id,
    title: v.title || '',
    url: v.url || '',
    thumbnail: String(v.thumbnail_url || '')
      .replace('%{width}', '320')
      .replace('%{height}', '180'),
    durationSec: parseTwitchDuration(v.duration),
    viewCount: v.view_count || 0,
    createdAt: v.created_at || '',
  }));

  const payload = { vods };
  // Only cache a non-empty result so a transient Helix failure doesn't
  // pin an empty list for 5 minutes.
  if (vods.length) {
    try {
      await env.LOADOUT_BOLTS.put(VODS_CACHE_KEY, JSON.stringify(payload), {
        expirationTtl: VODS_TTL,
      });
    } catch {
      /* cache write is best-effort */
    }
  }
  return json(payload);
}

// ---- Goals -------------------------------------------------------------
async function routeGoals(env, guildId) {
  let goals = [];
  try {
    const raw = await env.LOADOUT_BOLTS.get(`goals:${guildId}`, { type: 'json' });
    if (Array.isArray(raw)) goals = raw;
  } catch {
    /* default to empty */
  }
  return json({ goals });
}

// ---- Patron corner -----------------------------------------------------
// Eligibility = active Twitch subscriber OR Patreon-linked (inclusive).
// The sub signal is supplied by the panel from Twitch.ext.viewer (the
// extension JWT does not carry subscription status); the Patreon signal
// is read from a `patreon` entry in the viewer's wallet links — which is
// forward-compatible but currently unpopulated, since no tw:<id> ->
// Patreon mapping exists yet. Surfaced for revisit.
async function routePatronCorner(env, guildId, userId, subscribed) {
  const isSub = !!subscribed;
  let isPatron = false;
  try {
    const w = await env.LOADOUT_BOLTS.get(`wallet:${guildId}:${userId}`, { type: 'json' });
    const links = (w && w.links) || [];
    isPatron = links.some((l) => l && String(l.platform).toLowerCase() === 'patreon');
  } catch {
    /* default to not-a-patron */
  }
  // Phase P — direct tw→Patreon mapping (panel-driven OAuth). Set by
  // aquilo-site's /api/link/callback when an extToken was supplied at
  // /api/link/start. Independent of the wallet.links list above; an
  // identity-shared viewer can light up "patron" without ever having
  // touched the Discord-anchored wallet flow.
  if (!isPatron) {
    try {
      const map = await env.LOADOUT_BOLTS.get(`tw_patreon:${userId}`, { type: 'json' });
      if (map && Number(map.tier || 0) >= 1) isPatron = true;
    } catch {
      /* leave isPatron false */
    }
  }
  const eligible = isSub || isPatron;
  let kind = null;
  if (isSub && isPatron) kind = 'both';
  else if (isPatron) kind = 'patron';
  else if (isSub) kind = 'sub';

  let content = [];
  if (eligible) {
    try {
      const raw = await env.LOADOUT_BOLTS.get('patron_corner:items', { type: 'json' });
      if (Array.isArray(raw)) content = raw;
    } catch {
      /* default to empty */
    }
  }
  return json({ eligible, kind, content });
}

// Dispatched from ext.js handleExt for the flat Tier 1 routes.
export async function handleTier1(env, guildId, userId, route, req) {
  if (req.method === 'GET' && route === 'vods') return routeVods(env);
  if (req.method === 'GET' && route === 'goals') return routeGoals(env, guildId);
  if (req.method === 'GET' && route === 'patron-corner') {
    const subscribed = new URL(req.url).searchParams.get('subscribed') === '1';
    return routePatronCorner(env, guildId, userId, subscribed);
  }
  return json({ error: 'not-found' }, 404);
}
