// Progression, HTTP surface.
//
// PROGRESSION-SYSTEM-DESIGN.md §10.2. All progression routes route
// through this module; worker.js dispatches `/p/*`, `/web/profile/*`,
// `/web/xp/*`, `/web/leaderboards/xp` here.
//
// Auth model:
//   /p/<userId>                public HTML, no auth
//   /web/profile/<userId>      public JSON, no auth (viewerUserId
//                              passed via ?viewer=<discordId> for
//                              friends-only gating)
//   /web/profile/me/bio        HMAC-gated (Discord-OAuth web client)
//   /web/xp/<userId>           public read
//   /web/xp/leaderboard        public read

import { readFullProfile, getProfile, setProfileBio, lookupByHandle } from './profile.js';
import { readXpDisplay, topXp } from './xp.js';
import { readAchievementsDisplay } from './achievements.js';
import { ACHIEVEMENTS_CATALOG } from './achievements-catalog.js';
import { readBadgesDisplay, setShowcase as setBadgeShowcase } from './badges.js';
import { BADGE_CATALOG } from './badges-catalog.js';
import { dashboardSummary } from './abuse.js';

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=30',
      ...extra,
    },
  });
}

// HTML profile page, server-rendered. The aquilo-site team will
// likely replace this with a richer client; this is the no-dependency
// shippable v1 so the URL is live the moment the worker deploys.
function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=30' },
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  })[c]);
}

const SPRITE_BASE_URL = 'https://aquilo.gg/sprites';

function renderProfileHtml(full) {
  const p = full.profile;
  const x = full.xp;
  const lvBar = Math.round((x.pct || 0) * 100);
  // Badge ribbon, render the 3 showcase badges as 48×48 sprites at
  // the top of the page. If the user has no showcase set, pull up to
  // 3 most-recent earned badges.
  const showcaseIds = (p.badgesShowcase && p.badgesShowcase.length)
    ? p.badgesShowcase
    : ((full.badges?.items || []).filter(b => b.owned).slice(0, 3).map(b => b.id));
  const badgeRibbon = showcaseIds.length ? `<div class="badgeribbon">${
    showcaseIds.map(id => {
      const b = (full.badges?.items || []).find(x => x.id === id);
      if (!b) return '';
      return `<img class="badge r-${escapeHtml(b.rarity)}" src="${SPRITE_BASE_URL}/${escapeHtml(b.spritePath)}" alt="${escapeHtml(b.name)}" title="${escapeHtml(b.name)}, ${escapeHtml(b.description)}" />`;
    }).join('')
  }</div>` : '';
  const cards = (full.stats || []).filter(s => !s.error && s.primary).map(s => `
    <div class="card">
      <div class="card-feat">${escapeHtml(s.feature)}</div>
      <div class="card-primary"><span class="lbl">${escapeHtml(s.primary.label)}</span> <span class="val">${escapeHtml(String(s.primary.value))}</span></div>
      ${s.secondary ? `<div class="card-sec">${s.secondary.map(r => `<span>${escapeHtml(r.label)}: <b>${escapeHtml(String(r.value))}</b></span>`).join(' · ')}</div>` : ''}
    </div>`).join('\n');
  // Achievement strip, 12 most-recent unlocks + count summary.
  const achStripItems = (full.achievements?.items || [])
    .filter(a => a.unlocked)
    .slice(0, 12)
    .map(a => `<span class="ach r-${escapeHtml(a.rarity)}" title="${escapeHtml(a.description)}">${escapeHtml(a.title)}</span>`)
    .join('');
  const achHeader = full.achievements
    ? `${full.achievements.earned} / ${full.achievements.total} unlocked`
    : '';
  // Season pass strip, current tier / next tier / time-left.
  const sActive = full.season?.active;
  const sUser = full.season?.user;
  const seasonSection = sActive ? (() => {
    const tierPct = Math.round((sUser.tier / sActive.tierCount) * 100);
    const daysLeft = Math.max(0, Math.ceil((sActive.endUtc - Date.now()) / 86400_000));
    const premiumBlurb = sUser.premiumUnlocked
      ? `<span class="ach r-epic">Premium unlocked (Patreon)</span>`
      : `<span class="muted">Premium track locked, link Patreon to unlock.</span>`;
    return `<div class="seasonwrap">
      <h3>Season: ${escapeHtml(sActive.theme)} <span class="muted">${daysLeft}d left</span></h3>
      <div class="seasonbar"><div style="width:${tierPct}%"></div></div>
      <div class="muted">Tier ${sUser.tier} / ${sActive.tierCount} · ${sUser.xp} season XP · ${sUser.xpToNext} to next · ${premiumBlurb}</div>
    </div>`;
  })() : '';
  const achSection = full.achievements ? `
    <div class="achwrap">
      <h3>Achievements <span class="muted">${achHeader}</span></h3>
      ${achStripItems ? `<div class="achstrip">${achStripItems}</div>` : '<div class="muted">No unlocks yet, go play.</div>'}
    </div>` : '';
  const linked = Object.entries(p.linkedAccounts || {}).map(([plat, acc]) => `
    <span class="link plat-${escapeHtml(plat)}">${escapeHtml(plat)}: ${escapeHtml(acc.handle || acc.id || '-')}</span>`).join(' ');
  const recent = (full.recentActivity || []).map(r =>
    `<li><b>${escapeHtml(r.kind)}</b> · <span class="muted">${new Date(r.utc).toISOString().slice(0,19).replace('T',' ')} UTC</span></li>`
  ).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escapeHtml(p.displayName)} · aquilo.gg profile</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { background:#0a0b12; color:#e8e8f0; font:14px/1.4 system-ui, sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size:24px; margin:0 0 4px 0; }
  .sub { color:#9099b0; margin-bottom:16px; }
  .xp { background:#1c2034; border-radius:8px; padding:12px 16px; margin:16px 0; }
  .xpbar { height:8px; background:#0a0b12; border-radius:4px; overflow:hidden; margin-top:6px; }
  .xpbar > div { height:100%; background:linear-gradient(90deg, #7c5cff, #b098ff); width:${lvBar}%; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:12px; }
  .card { background:#1c2034; border-radius:8px; padding:12px 14px; }
  .card-feat { color:#9099b0; text-transform:uppercase; letter-spacing:0.6px; font-size:11px; margin-bottom:4px; }
  .card-primary { font-size:18px; margin-bottom:4px; }
  .card-primary .lbl { color:#9099b0; }
  .card-primary .val { font-weight:600; color:#fff; }
  .card-sec { color:#aab1c0; font-size:12px; }
  .links { background:#1c2034; border-radius:8px; padding:8px 12px; margin:8px 0; font-size:12px; }
  .links .link { margin-right:10px; color:#aab1c0; }
  .bio { background:#1c2034; border-radius:8px; padding:10px 14px; margin:8px 0; color:#cbd2e0; }
  .recent { margin-top:16px; }
  .recent ul { padding-left:18px; }
  .recent .muted { color:#6a7088; }
  .gated { color:#aab1c0; font-style: italic; background:#1c2034; padding:12px 14px; border-radius:8px; }
  .achwrap { margin-top:16px; background:#1c2034; border-radius:8px; padding:12px 14px; }
  .achwrap h3 { margin:0 0 8px 0; font-size:14px; }
  .achwrap .muted { color:#6a7088; font-weight:normal; }
  .achstrip { display:flex; flex-wrap:wrap; gap:6px; }
  .ach { padding:4px 10px; border-radius:12px; font-size:12px; background:#2a3050; color:#cbd2e0; }
  .ach.r-rare { background:#1f3a5a; color:#9ac7ff; }
  .ach.r-epic { background:#3a1f5a; color:#c4a0ff; }
  .ach.r-legendary { background:#5a4a0a; color:#fff0a0; }
  .badgeribbon { display:flex; gap:8px; margin:8px 0; }
  .badge { width:48px; height:48px; image-rendering: pixelated; image-rendering: crisp-edges; border-radius:6px; }
  .badge.r-rare { box-shadow: 0 0 8px #5a8af0; }
  .badge.r-epic { box-shadow: 0 0 10px #a878f0; }
  .badge.r-legendary { box-shadow: 0 0 14px #f0c050; }
  .trophyCabinet { background:#1c2034; border-radius:8px; padding:12px 14px; margin-top:12px; }
  .trophyCabinet h3 { margin:0 0 8px 0; font-size:14px; }
  .trophyCabinet .grid { display:flex; flex-wrap:wrap; gap:8px; }
  .trophyCabinet .badge { width:48px; height:48px; }
  .trophyCabinet .badge.locked { opacity:0.18; filter: grayscale(1); }
  .seasonwrap { background:#1c2034; border-radius:8px; padding:12px 14px; margin-top:12px; }
  .seasonwrap h3 { margin:0 0 8px 0; font-size:14px; }
  .seasonbar { height:10px; background:#0a0b12; border-radius:5px; overflow:hidden; margin:6px 0; }
  .seasonbar > div { height:100%; background:linear-gradient(90deg, #f0c050, #f08850); }
</style>
</head><body>
  <h1>${escapeHtml(p.displayName)}</h1>
  <div class="sub">Level <b>${x.level}</b> · ${x.xp} XP · joined ${new Date(p.createdUtc).toISOString().slice(0,10)} · ${p.friendCount} friend${p.friendCount === 1 ? '' : 's'} · ${full.badges?.earned || 0}/${full.badges?.total || 0} badges</div>
  ${badgeRibbon}
  <div class="xp">
    <div>L${x.level} · ${x.xpIntoLevel}/${x.xpForLevel} XP to L${x.nextLevel}</div>
    <div class="xpbar"><div></div></div>
  </div>
  ${p.bio ? `<div class="bio">${escapeHtml(p.bio)}</div>` : ''}
  ${linked ? `<div class="links">Linked: ${linked}</div>` : ''}
  ${seasonSection}
  ${full.gated ? `<div class="gated">This profile's stats are not public.</div>` : `<div class="grid">${cards}</div>`}
  ${achSection}
  ${full.badges && !full.gated ? `<div class="trophyCabinet">
    <h3>Trophy Cabinet <span class="muted">${full.badges.earned}/${full.badges.total}</span></h3>
    <div class="grid">${full.badges.items.slice(0, 36).map(b => `<img class="badge r-${escapeHtml(b.rarity)} ${b.owned ? '' : 'locked'}" src="${SPRITE_BASE_URL}/${escapeHtml(b.spritePath)}" alt="${escapeHtml(b.name)}" title="${escapeHtml(b.name)}, ${escapeHtml(b.description)}" />`).join('')}</div>
  </div>` : ''}
  ${recent && !full.gated ? `<div class="recent"><h3>Recent activity</h3><ul>${recent}</ul></div>` : ''}
</body></html>`;
}

// Public HTML profile (or JSON when ?format=json).
export async function handleProfilePage(req, env, path) {
  // path: /p/<userIdOrHandle>
  const m = path.match(/^\/p\/([^\/?#]+)/);
  if (!m) return new Response('not found', { status: 404 });
  let userId = decodeURIComponent(m[1]);
  // Numeric → direct lookup; else try handle index.
  if (!/^\d+$/.test(userId)) {
    const id = await lookupByHandle(env, userId);
    if (!id) return new Response('profile not found', { status: 404 });
    userId = id;
  }
  const url = new URL(req.url);
  const viewerUserId = url.searchParams.get('viewer') || null;
  const full = await readFullProfile(env, userId, { viewerUserId });
  if (url.searchParams.get('format') === 'json') {
    return json(full);
  }
  return html(renderProfileHtml(full));
}

// /web/profile/<userId>  + /web/profile/<userId>/stats
export async function handleWebProfile(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['web','profile','<userId>', ...]
  const userId = parts[2];
  if (!userId) return json({ error: 'userId required' }, 400);
  const url = new URL(req.url);
  const viewerUserId = url.searchParams.get('viewer') || null;
  // Read endpoints, public, no auth.
  if (req.method === 'GET' && parts.length === 3) {
    const full = await readFullProfile(env, userId, { viewerUserId });
    return json(full);
  }
  if (req.method === 'GET' && parts[3] === 'stats') {
    const { aggregateStats } = await import('./profile.js');
    const stats = await aggregateStats(env, userId);
    return json({ userId, stats });
  }
  if (req.method === 'GET' && parts[3] === 'xp') {
    const xp = await readXpDisplay(env, userId);
    return json({ userId, ...xp });
  }
  // Write endpoints are HMAC-gated by worker.js before reaching here
  // (we expect parts[3] === 'bio' on POST in a future P5 wiring with
  // body { bio, privacy, badgesShowcase, displayName }).
  if (req.method === 'POST' && parts[3] === 'bio') {
    let body = {};
    try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }
    const p = await setProfileBio(env, userId, body.bio || '', body);
    return json({ ok: true, profile: { bio: p.bio, privacy: p.privacy, badgesShowcase: p.badgesShowcase } });
  }
  return new Response('not found', { status: 404 });
}

// /web/progression/dashboard         → Clay-facing read-only summary
// HMAC-gated upstream in worker.js so it doesn't leak rate/flag data
// to public callers.
export async function handleWebDashboard(req, env, _path) {
  const data = await dashboardSummary(env);
  return json(data);
}

// PUBLIC season reads (no auth), mirrors the /p/<userId> profile pattern.
// Wired in worker.js under `/p/season/...`, claimed before the generic
// /web/* HMAC dispatcher.
//
//   GET /p/season/active           → active season config + tier table
//   GET /p/season/<userId>         → user's tier + xp + per-tier claim state
//
// The CLAIM POST (which mutates wallet/badge/fragment ledgers) used to
// live alongside these reads at /web/season/<userId>/claim, but that
// prefix was claimed before the generic HMAC dispatcher so the POST
// was reachable WITHOUT a signature, anyone who knew a userId could
// fire claims on someone else's account. Auth-gap fix (2026-05): the
// public read moves here, the claim moves under the HMAC path
// (routeSeasonClaim in web.js → /web/season/claim, body-bound discordId).

// /web/profile/link/start?platform=...&userId=...&returnUrl=...
// /web/profile/link/callback?platform=...&state=...&code=...
// /web/profile/link/manual         POST { userId, platform, handle }
// /web/profile/link/remove         POST { userId, platform }
export async function handleWebProfileLink(req, env, path) {
  const { startLinkFlow, completeLinkFlow, applyManualLink, removeLink, PLATFORMS } = await import('./linking.js');
  const parts = path.split('/').filter(Boolean);   // ['web','profile','link', op, ...]
  const op = parts[3];
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform');

  if (op === 'platforms') {
    return json({ platforms: Object.keys(PLATFORMS).map(k => ({ id: k, ...PLATFORMS[k] })) });
  }
  if (op === 'start' && req.method === 'GET') {
    if (!platform || !PLATFORMS[platform]) return json({ error: 'unknown-platform' }, 400);
    const userId = url.searchParams.get('userId');
    const returnUrl = url.searchParams.get('returnUrl');
    if (!userId) return json({ error: 'userId required' }, 400);
    const r = await startLinkFlow(env, platform, userId, returnUrl);
    if (r.ok && r.redirect) return Response.redirect(r.redirect, 302);
    return json(r, r.ok ? 200 : 400);
  }
  if (op === 'callback' && req.method === 'GET') {
    if (!platform || !PLATFORMS[platform]) return json({ error: 'unknown-platform' }, 400);
    const query = Object.fromEntries(url.searchParams);
    const r = await completeLinkFlow(env, platform, query);
    if (r.ok && r.returnUrl) return Response.redirect(`${r.returnUrl}?linked=${platform}`, 302);
    if (r.ok) {
      return html(`<!doctype html><body style="background:#0a0b12;color:#e8e8f0;font:14px/1.4 system-ui;padding:24px;">
        <h1>Linked!</h1><p>Your ${escapeHtml(platform)} account is now linked.</p>
        <p><a style="color:#7c5cff" href="javascript:window.close()">Close</a></p>
      </body>`, 200);
    }
    return json(r, 400);
  }
  if (op === 'manual' && req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }
    if (!body.userId || !body.platform) return json({ error: 'userId+platform required' }, 400);
    const r = await applyManualLink(env, body.userId, body.platform, body.handle);
    return json(r, r.ok ? 200 : 400);
  }
  if (op === 'remove' && req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }
    if (!body.userId || !body.platform) return json({ error: 'userId+platform required' }, 400);
    const r = await removeLink(env, body.userId, body.platform);
    return json(r, r.ok ? 200 : 400);
  }
  return json({ error: 'unknown-op' }, 404);
}

// /web/badges/<userId>     per-user owned + showcase + locked
// /web/badges/catalog      full catalogue
// POST /web/badges/me/showcase  { showcase: [badgeId, badgeId, badgeId], userId }
export async function handleWebBadges(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['web','badges',...]
  if (parts[2] === 'catalog') {
    return json({ items: BADGE_CATALOG.map(b => ({
      id: b.id, name: b.name, description: b.description, rarity: b.rarity,
      category: b.category, spritePath: b.spritePath, shape: b.shape, accent: b.accent,
    })), total: BADGE_CATALOG.length });
  }
  if (parts[2] === 'me' && parts[3] === 'showcase' && req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }
    const userId = String(body.userId || '');
    if (!userId) return json({ error: 'userId required' }, 400);
    const r = await setBadgeShowcase(env, userId, body.showcase || []);
    return json(r);
  }
  const userId = parts[2];
  if (!userId) return json({ error: 'userId required' }, 400);
  const data = await readBadgesDisplay(env, userId);
  return json({ userId, ...data });
}

// /web/achievements/<userId>        per-user display (progress + unlocks)
// /web/achievements/catalog          full catalogue (cached upstream)
export async function handleWebAchievements(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['web','achievements',...]
  if (parts[2] === 'catalog') {
    // Public catalog, strip secret achievements (visible only when earned).
    const out = ACHIEVEMENTS_CATALOG.map(a => ({
      id: a.id, category: a.category, title: a.secret ? 'Hidden Achievement' : a.title,
      description: a.secret ? 'Find me by playing.' : a.description,
      iconKind: a.iconKind, rarity: a.rarity, xpReward: a.xpReward,
      badgeId: a.badgeId || null, secret: !!a.secret,
    }));
    return json({ items: out, total: out.length });
  }
  const userId = parts[2];
  if (!userId) return json({ error: 'userId required' }, 400);
  const data = await readAchievementsDisplay(env, userId);
  return json({ userId, ...data });
}

// /web/xp/<userId> + /web/xp/leaderboard
export async function handleWebXp(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['web','xp',...]
  if (parts[2] === 'leaderboard') {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
    const rows = await topXp(env, limit);
    return json({ rows, updatedAt: Date.now() });
  }
  const userId = parts[2];
  if (!userId) return json({ error: 'userId required' }, 400);
  const xp = await readXpDisplay(env, userId);
  return json({ userId, ...xp });
}
