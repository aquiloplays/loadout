// Discord-DM fan-out, INBOUND from aquilo-site.
//
// The aquilo-site batch wired the front-end notification UX (per-user
// "push and/or Discord ping" toggle) but the actual Discord delivery
// was left as a stub. This module implements it.
//
// Contract (HMAC-signed POST from aquilo-site, x-aquilo-web-ts +
// x-aquilo-web-sig headers, AQUILO_SITE_WEB_SECRET):
//
//   POST /push/dm
//     { audience: 'user' | 'all-patrons' | 'opted-in',
//       userIds?: ['<discordId>', ...],   // when audience='user'
//       title: string,
//       body:  string,
//       url?:  string,
//       kind?: string,                     // routes through pprofile.pushPrefs
//       embed?: { ... }                    // optional, replaces default formatting
//     }
//   → { sent: N, failed: M, skipped: K, perUser: [{ userId, ok, reason? }] }
//
// Per-user gating: pprofile:<userId>.pushPrefs is consulted. The
// default shape is { discordDm: true, web: true }; if `discordDm` is
// false, this user is skipped (the web-push side still fires).
//
// kind-specific gating: when `kind` is set we also consult
// pprofile.pushPrefs.kinds[<kind>] (default true); a viewer can opt
// out of specific event kinds without disabling all DMs.

import { verifyHmac } from './auth.js';
import { sendDm } from './aquilo/util.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function gateHmac(req, env) {
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return { ok: false, status: 503, error: 'AQUILO_SITE_WEB_SECRET missing' };
  }
  const bodyText = await req.text();
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'unauthorized' };
  let body;
  try { body = JSON.parse(bodyText); }
  catch { return { ok: false, status: 400, error: 'bad-json' }; }
  return { ok: true, body };
}

// Read per-user push prefs. Falls back to "DMs enabled" when no record
//, viewers haven't been migrated to the new system explicitly opt
// out yet, and silence-by-default would mean Day-1 nobody gets DMs.
async function readPushPrefs(env, userId) {
  try {
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' });
    if (p?.pushPrefs) return { ...{ discordDm: true, web: true, kinds: {} }, ...p.pushPrefs };
  } catch { /* fall through */ }
  return { discordDm: true, web: true, kinds: {} };
}

function isKindEnabled(prefs, kind) {
  if (!kind) return true;
  if (!prefs.kinds) return true;
  // If the user explicitly set this kind off, respect it. Default is on.
  return prefs.kinds[kind] !== false;
}

// Resolve `audience` → concrete userId list. 'user' uses the supplied
// userIds; 'all-patrons' is the set of patrons WITH a wallet in this
// guild; 'opted-in' is users with a wallet in this guild who haven't
// opted DMs off. For multi-tenancy, both bulk audiences are
// intersected with the calling guild's wallet:<guildId>:* membership
// so streamer-A can't DM streamer-B's audience even with a shared
// site-admin secret.
async function listGuildWalletUsers(env, guildId) {
  const prefix = `wallet:${guildId}:`;
  const users = new Set();
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys) users.add(k.name.slice(prefix.length));
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return users;
}

async function resolveAudience(env, payload) {
  if (payload.audience === 'user') {
    return Array.isArray(payload.userIds) ? payload.userIds.filter(Boolean).map(String) : [];
  }

  const guildId = String(payload.guildId || payload.guild_id || '');
  if (!guildId || !/^\d{5,25}$/.test(guildId)) {
    // Bulk audiences require a guild scope; refuse rather than fanning
    // out globally across tenants.
    return [];
  }
  const guildUsers = await listGuildWalletUsers(env, guildId);

  if (payload.audience === 'all-patrons') {
    const out = [];
    for (const userId of guildUsers) {
      const tier = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
      if (tier) out.push(userId);
    }
    return out;
  }
  if (payload.audience === 'opted-in') {
    const out = [];
    for (const userId of guildUsers) {
      const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' });
      if (!p) continue;
      if (p?.pushPrefs?.discordDm === false) continue;
      out.push(userId);
    }
    return out;
  }
  return [];
}

// Build the DM payload, uses provided embed if any, else default
// rendering with title/body/url.
function buildDmPayload(payload) {
  if (payload.embed) return { embeds: [payload.embed] };
  const lines = [];
  if (payload.title) lines.push(`**${payload.title}**`);
  if (payload.body)  lines.push(payload.body);
  if (payload.url)   lines.push(payload.url);
  return { content: lines.join('\n').slice(0, 1900) };
}

export async function handlePushDm(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const gate = await gateHmac(req, env);
  if (!gate.ok) return json({ error: gate.error }, gate.status);
  const p = gate.body || {};

  if (!env.DISCORD_BOT_TOKEN) {
    return json({ error: 'not-configured', message: 'DISCORD_BOT_TOKEN not set; DMs will fail' }, 503);
  }

  const audience = await resolveAudience(env, p);
  if (!audience.length) return json({ sent: 0, skipped: 0, failed: 0, perUser: [], reason: 'no-audience' });

  const dmPayload = buildDmPayload(p);

  const perUser = [];
  let sent = 0, skipped = 0, failed = 0;
  for (const userId of audience) {
    const prefs = await readPushPrefs(env, userId);
    if (!prefs.discordDm) { skipped++; perUser.push({ userId, ok: false, reason: 'dm-disabled' }); continue; }
    if (!isKindEnabled(prefs, p.kind)) { skipped++; perUser.push({ userId, ok: false, reason: `kind-opted-out:${p.kind}` }); continue; }
    try {
      await sendDm(env, userId, dmPayload);
      sent++;
      perUser.push({ userId, ok: true });
    } catch (e) {
      failed++;
      perUser.push({ userId, ok: false, reason: String(e && e.message || e).slice(0, 80) });
    }
  }
  return json({ sent, skipped, failed, perUser });
}
