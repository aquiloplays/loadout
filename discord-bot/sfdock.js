// Backend for the StreamFusion chat dock (aquilo.gg/dock/streamfusion-chat).
//
//   POST /api/sfdock/gate      { token }              -> { ok, tier, owner, premium }
//   POST /api/sfdock/translate { text, token }        -> { ok, translation }   (T2+)
//   POST /api/sfdock/mod       { action, platform, user, msgId, token } -> stub
//   POST /api/sfdock/clip      { token }              -> stub
//
// Premium (auto-translate, custom alert flags) gates on Patreon T2+ using the
// exact same entitlement path as the Rotation premium presets
// (widget-presets.getWidgetPresetAccess). The Patreon token is hashed for the
// KV cache key and never logged; the ANTHROPIC key stays server-side.
import { getWidgetPresetAccess } from './widget-presets.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
}

// T2+ ($5+) or owner. getWidgetPresetAccess returns { tier, owner, cents }.
async function premiumOk(env, token) {
  if (!token) return { ok: false, premium: false, tier: 'none', owner: false };
  try {
    const a = await getWidgetPresetAccess(env, token);
    const premium = !!a.owner || Number(a.cents || 0) >= 500;
    return { ok: !!a.ok, premium, tier: a.tier || 'none', owner: !!a.owner };
  } catch {
    return { ok: false, premium: false, tier: 'none', owner: false };
  }
}

async function callHaiku(env, prompt, maxTokens) {
  const key = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('translate-not-configured');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: maxTokens || 200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status);
  const j = await r.json();
  return (j.content || []).map((c) => c.text || '').join('').trim();
}

export async function handleSfDock(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  let body = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (path === '/api/sfdock/gate') {
    const p = await premiumOk(env, body.token);
    return json({ ok: true, tier: p.tier, owner: p.owner, premium: p.premium });
  }

  if (path === '/api/sfdock/translate') {
    const p = await premiumOk(env, body.token);
    if (!p.premium) return json({ ok: false, error: 'patreon-required', minTier: 't2' }, 402);
    const text = String(body.text || '').slice(0, 400).trim();
    if (!text) return json({ ok: false, error: 'empty' }, 400);
    try {
      const out = await callHaiku(env,
        'Translate this live-stream chat message to English. Reply with ONLY the translation, ' +
        'no quotes and no notes. If it is already English, reply with exactly an empty line.\n\nMessage: ' + text, 160);
      const t = out.replace(/^["']|["']$/g, '').trim();
      return json({ ok: true, translation: (t && t.toLowerCase() !== text.toLowerCase()) ? t.slice(0, 300) : '' });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e).slice(0, 60) }, 502);
    }
  }

  // Mod actions + clip require the broadcaster's Twitch OAuth (Helix moderation
  // + clips:edit) or routing through a Streamer.bot action. Not wired yet; the
  // dock surfaces this message. See the dock README for the two wiring options.
  if (path === '/api/sfdock/mod' || path === '/api/sfdock/clip') {
    return json({ ok: false, error: 'not-configured',
      message: 'Connect Twitch mod/clip auth to enable this (see the dock README).' }, 501);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
