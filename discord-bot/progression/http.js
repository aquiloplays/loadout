// Progression — HTTP surface.
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

// HTML profile page — server-rendered. The aquilo-site team will
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

function renderProfileHtml(full) {
  const p = full.profile;
  const x = full.xp;
  const lvBar = Math.round((x.pct || 0) * 100);
  const cards = (full.stats || []).filter(s => !s.error && s.primary).map(s => `
    <div class="card">
      <div class="card-feat">${escapeHtml(s.feature)}</div>
      <div class="card-primary"><span class="lbl">${escapeHtml(s.primary.label)}</span> <span class="val">${escapeHtml(String(s.primary.value))}</span></div>
      ${s.secondary ? `<div class="card-sec">${s.secondary.map(r => `<span>${escapeHtml(r.label)}: <b>${escapeHtml(String(r.value))}</b></span>`).join(' · ')}</div>` : ''}
    </div>`).join('\n');
  // Achievement strip — 12 most-recent unlocks + count summary.
  const achStripItems = (full.achievements?.items || [])
    .filter(a => a.unlocked)
    .slice(0, 12)
    .map(a => `<span class="ach r-${escapeHtml(a.rarity)}" title="${escapeHtml(a.description)}">${escapeHtml(a.title)}</span>`)
    .join('');
  const achHeader = full.achievements
    ? `${full.achievements.earned} / ${full.achievements.total} unlocked`
    : '';
  const achSection = full.achievements ? `
    <div class="achwrap">
      <h3>Achievements <span class="muted">${achHeader}</span></h3>
      ${achStripItems ? `<div class="achstrip">${achStripItems}</div>` : '<div class="muted">No unlocks yet — go play.</div>'}
    </div>` : '';
  const linked = Object.entries(p.linkedAccounts || {}).map(([plat, acc]) => `
    <span class="link plat-${escapeHtml(plat)}">${escapeHtml(plat)}: ${escapeHtml(acc.handle || acc.id || '—')}</span>`).join(' ');
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
</style>
</head><body>
  <h1>${escapeHtml(p.displayName)}</h1>
  <div class="sub">Level <b>${x.level}</b> · ${x.xp} XP · joined ${new Date(p.createdUtc).toISOString().slice(0,10)} · ${p.friendCount} friend${p.friendCount === 1 ? '' : 's'}</div>
  <div class="xp">
    <div>L${x.level} · ${x.xpIntoLevel}/${x.xpForLevel} XP to L${x.nextLevel}</div>
    <div class="xpbar"><div></div></div>
  </div>
  ${p.bio ? `<div class="bio">${escapeHtml(p.bio)}</div>` : ''}
  ${linked ? `<div class="links">Linked: ${linked}</div>` : ''}
  ${full.gated ? `<div class="gated">This profile's stats are not public.</div>` : `<div class="grid">${cards}</div>`}
  ${achSection}
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
  // Read endpoints — public, no auth.
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

// /web/achievements/<userId>        per-user display (progress + unlocks)
// /web/achievements/catalog          full catalogue (cached upstream)
export async function handleWebAchievements(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['web','achievements',...]
  if (parts[2] === 'catalog') {
    // Public catalog — strip secret achievements (visible only when earned).
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
