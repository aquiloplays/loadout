// Channel-point reward creator — creates a reward on Twitch and/or Kick on
// the streamer's behalf, called by StreamFusion's Printer pane so the app can
// spin up (e.g.) the "Cards Against Humanity" print reward without the
// streamer hand-building it in each dashboard.
//
// Auth: x-aquilo-print-key == KV printflair:postkey — the machine key SF
// already holds as galleryKey (same as warden-ingest / the receipt gallery).
//
//   POST /api/rewards/create
//   body: { title, cost, prompt?, requiresInput?, color?,
//           platforms:['tw','kk'], streamerId }
//   → { ok, tw:{ ok, rewardId?, existed?, needsReauth?, reauthUrl?, error? }|null,
//            kk:{ ok, rewardId?, needsReconnect?, reconnectUrl?, error? }|null }
//
// Twitch: reuses the streamer's connected PunchCard token — the one
// broadcaster token in this worker that carries channel:manage:redemptions
// (see punchcard.js STREAMER_SCOPES) — via createChannelPointReward: Helix
// POST /channel_points/custom_rewards on the streamer's own channel, keyed by
// login. Missing scope / no connection → needsReauth (reconnect through
// PunchCard's streamer Connect). Duplicate title = the reward already exists.
//
// Kick: POST api.kick.com/public/v1/channels/rewards via the auth broker's
// vault token (role broadcaster), the same flow warden-kick uses. Requires
// Kick's channel:rewards:write scope — surfaced as needsReconnect when absent.
// ⚠ Kick's reward contract (endpoint/body) is drawn from Kick's now-GA
// channel-points API + community docs; the first live create is the real
// verification. Any non-2xx is returned verbatim so the pane can show it.
//
// Keyed per-streamer by login (PunchCard's chan record) so it's multi-tenant
// ready. A reward created by this app is still redeemable by viewers and its
// redemption fires to any read:redemptions listener (i.e. the streamer's
// Streamer.bot), so SF's title-match print path works regardless of which app
// created the reward.

import { createChannelPointReward } from './punchcard.js';

const BROKER = 'https://auth.aquilo.gg';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

async function keyOk(req, env) {
  const key = await env.LOADOUT_BOLTS.get('printflair:postkey').catch(() => null);
  return key && req.headers.get('x-aquilo-print-key') === key;
}

// Re-connect entry points the streamer visits to (re-)grant the manage-reward
// scopes. Twitch reuses PunchCard's streamer Connect (its OAuth requests
// channel:manage:redemptions); Kick uses the auth broker. Env overrides keep
// them deploy-configurable without a code change.
function twitchReauthUrl(env) { return env.TWITCH_OAUTH_START_URL || 'https://aquilo.gg/punchcard/customize/'; }
function kickReconnectUrl(env) { return env.KICK_OAUTH_START_URL || 'https://auth.aquilo.gg/kick/connect'; }

export async function handleRewards(req, env, path) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-aquilo-print-key',
      },
    });
  }
  if (path === '/api/rewards/create' && req.method === 'POST') return createReward(req, env);
  return json({ ok: false, error: 'not-found' }, 404);
}

async function createReward(req, env) {
  if (!(await keyOk(req, env))) return json({ ok: false, error: 'bad-key' }, 403);
  let body = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }

  const title = String(body.title || '').trim().slice(0, 45);   // Twitch title cap = 45
  const rawCost = parseInt(body.cost, 10);
  const prompt = String(body.prompt || '').slice(0, 200);
  const requiresInput = !!body.requiresInput;
  const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? body.color : '#1b1b1b';
  const platforms = Array.isArray(body.platforms) ? body.platforms : ['tw'];
  const streamerId = String(body.streamerId || '').replace(/[^0-9]/g, '');
  const channel = String(body.channel || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25);
  if (!title) return json({ ok: false, error: 'no-title' }, 400);
  // Validate BEFORE clamping so a missing/zero/negative cost is rejected
  // rather than silently floored to a 1-point reward.
  if (!Number.isFinite(rawCost) || rawCost < 1) return json({ ok: false, error: 'no-cost' }, 400);
  const cost = Math.min(1000000, rawCost);

  const spec = { title, cost, prompt, requiresInput, color };
  const out = { ok: true, tw: null, kk: null };
  if (platforms.includes('tw')) out.tw = await createTwitch(env, channel, spec);
  if (platforms.includes('kk')) out.kk = await createKick(env, streamerId, spec);
  // Overall ok only if every requested platform succeeded.
  out.ok = (!out.tw || out.tw.ok) && (!out.kk || out.kk.ok);
  return json(out);
}

async function createTwitch(env, channel, spec) {
  if (!channel) {
    return { ok: false, platform: 'tw', error: 'no-channel', needsReauth: true, reauthUrl: twitchReauthUrl(env) };
  }
  const r = await createChannelPointReward(env, channel, spec);
  if (r && r.ok) {
    return { ok: true, platform: 'tw', rewardId: r.rewardId || null, existed: !!r.existed, title: r.title };
  }
  const out = { ok: false, platform: 'tw', error: (r && r.error) || 'failed' };
  if (r && r.needsReauth) { out.needsReauth = true; out.reauthUrl = twitchReauthUrl(env); }
  if (r && r.status) out.status = r.status;
  if (r && r.detail) out.detail = r.detail;
  return out;
}

async function kickToken(env, streamerId) {
  if (!env.VAULT_SERVICE_SECRET || !streamerId) return null;
  try {
    const r = await fetch(BROKER + '/kick/vault/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: env.VAULT_SERVICE_SECRET, twitchId: streamerId, role: 'broadcaster' }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.access_token) ? j.access_token : null;
  } catch { return null; }
}

async function createKick(env, streamerId, spec) {
  const token = await kickToken(env, streamerId);
  if (!token) return { ok: false, platform: 'kk', error: 'kick-not-connected', needsReconnect: true, reconnectUrl: kickReconnectUrl(env) };
  const bid = await env.LOADOUT_BOLTS.get('link:tw2kick:' + streamerId).catch(() => null);
  const payload = {
    title: spec.title,
    cost: spec.cost,
    description: spec.prompt || '',
    is_enabled: true,
    is_user_input_required: spec.requiresInput,
    should_redemptions_skip_request_queue: !spec.requiresInput,
    background_color: spec.color,
  };
  if (bid) payload.broadcaster_user_id = Number(bid);
  try {
    const r = await fetch('https://api.kick.com/public/v1/channels/rewards', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, platform: 'kk', error: 'kick-scope', needsReconnect: true, reconnectUrl: kickReconnectUrl(env) };
    }
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) return { ok: false, platform: 'kk', error: 'kick-' + r.status, detail: j ? JSON.stringify(j).slice(0, 200) : '' };
    const rewardId = j && j.data && (j.data.id || (Array.isArray(j.data) && j.data[0] && j.data[0].id)) || null;
    return { ok: true, platform: 'kk', rewardId, title: spec.title };
  } catch {
    return { ok: false, platform: 'kk', error: 'kick-unreachable' };
  }
}
