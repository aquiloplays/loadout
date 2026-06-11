// Cover-art finder for games with no Steam page.
//
// Some Community Votes Night pool games (Escape From Tarkov, Marathon)
// have no Steam listing, so the seeded catalog has no headerUrl and
// their schedule/vote cards render a name-on-gradient tile. Per Clay
// (2026-06-11): use Claude to find the art. For each community-pool
// game missing art, this asks Claude (with the server-side web_search
// tool) for a DIRECT image URL of the game's official cover/key art,
// verifies the URL actually serves an image, and writes it into the
// site-managed catalog at games:v1:<guildId>. The admin route that
// calls this then re-syncs D1 + the pinned embed so the art shows up
// everywhere.
//
// Mirrors the raw-fetch Anthropic pattern used by sfdock.js and
// scratch-off.js (same worker, same ANTHROPIC_API_KEY secret).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

async function askClaudeForArt(env, gameName) {
  const key = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('anthropic-not-configured');
  const prompt = [
    `Find a direct image URL for official cover art or key art of the video game "${gameName}".`,
    'Requirements:',
    '- The URL must be a DIRECT image file (jpg/jpeg/png/webp), not an HTML page.',
    "- Prefer upload.wikimedia.org file URLs or the game's official site/press CDN.",
    '- Landscape or square art beats portrait box art when available (it renders on wide 460x215 cards).',
    '- It must be hotlinkable: plain HTTPS, no auth or referer wall.',
    'Reply with ONLY a JSON object and no other text: {"url": "https://..."} or {"url": null} if nothing reliable exists.',
  ].join('\n');

  let messages = [{ role: 'user', content: prompt }];
  // web_search runs server-side; a long search can pause the turn, in
  // which case the assistant content is re-sent and the API resumes.
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages,
      }),
    });
    if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    if (j.stop_reason === 'pause_turn') {
      messages = [messages[0], { role: 'assistant', content: j.content }];
      continue;
    }
    const text = (j.content || [])
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
    const m = text.match(/\{[^{}]*"url"[^{}]*\}/);
    if (!m) return null;
    try {
      const url = JSON.parse(m[0]).url;
      return typeof url === 'string' && /^https:\/\//i.test(url) ? url.slice(0, 400) : null;
    } catch {
      return null;
    }
  }
  return null;
}

// The card <img> is only as good as the URL, so confirm it actually
// serves an image before trusting Claude's answer.
async function urlServesImage(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (aquilo.gg art check)' },
      redirect: 'follow',
    });
    const ct = String(r.headers.get('content-type') || '');
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return r.ok && ct.startsWith('image/');
  } catch {
    return false;
  }
}

export async function findMissingGameArt(env, guildId) {
  const key = `games:v1:${guildId}`;
  const cat = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  const items = (cat && Array.isArray(cat.items)) ? cat.items : [];
  const missing = items.filter((g) =>
    g && g.name && Array.isArray(g.pools) &&
    g.pools.includes('community') && !g.headerUrl);

  const results = [];
  let updated = 0;
  for (const g of missing) {
    let url = null;
    let ok = false;
    try {
      url = await askClaudeForArt(env, g.name);
    } catch (e) {
      results.push({ name: g.name, error: String(e?.message || e) });
      continue;
    }
    if (url) ok = await urlServesImage(url);
    if (ok) {
      g.headerUrl = url;
      if (!g.capsuleUrl) g.capsuleUrl = url;
      updated++;
    }
    results.push({ name: g.name, url, ok });
  }

  if (updated) {
    cat.updatedAt = Date.now();
    cat.updatedBy = 'web';
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(cat));
  }
  return { missing: missing.length, updated, results };
}
