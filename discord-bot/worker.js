// Loadout Discord bot - Cloudflare Worker entry point.
//
// Single-tenant Discord application: one bot ("Loadout"), one Public Key,
// many guilds. Streamers don't create their own Discord app anymore —
// they invite our bot and run /loadout-claim with a code minted by their
// Loadout install.
//
// Routes:
//   POST /interactions               - Discord slash command webhook
//   POST /claim                      - Loadout-side: mint a claim code (TTL 10m)
//   GET  /claim/:code/status         - Loadout-side: poll whether the code was claimed
//   POST /sync/:guildId/init         - Loadout-side: complete registration after claim
//   GET  /sync/:guildId              - Loadout-side: pull wallet snapshot (HMAC)
//   POST /sync/:guildId              - Loadout-side: push wallet snapshot (HMAC)
//   GET  /sync/:guildId/games?since= - Loadout-side: pull recent off-stream
//                                      minigame results so the DLL can
//                                      republish them on the local Aquilo
//                                      Bus and the OBS overlay can render
//                                      them (HMAC).
//   GET  /sync/:guildId/profiles?since= - Loadout-side: pull viewer profile
//                                      edits made via /profile-set-* slash
//                                      commands (HMAC).
//   GET  /health                     - liveness probe
//
// KV layout:
//   publickey                        - the (single) Loadout Discord public key (set once at deploy)
//   claim:<code>                     - { secret, mintedUtc, ttlExpiresUtc, claimedGuildId? }
//   secret:<guildId>                 - { secret, registeredUtc, ownerStreamerName }
//   wallet:<guildId>:<userId>        - per-viewer wallet (see wallet.js)
//   guildowner:<guildId>             - { discordUserId, claimedAt } - the claimer
//   games:<guildId>                  - JSON array (cap 32) of recent minigame
//                                      results, 5-min TTL. DLL polls via
//                                      /sync/:guildId/games to republish on
//                                      the local Aquilo Bus.

import { verifyDiscordSignature, verifyHmac } from './auth.js';
import { handleInteraction } from './commands.js';
import { applySnapshot, readSnapshot, getSecret, setSecret, applyVaultDelta, resetAllWallets, leaderboard } from './wallet.js';
import { readSince as readProfilesSince } from './profiles.js';
import { COMMANDS } from './commands-spec.js';

// Discord interaction "claim" command custom handler — defined here rather
// than commands.js because it touches the claim KV and cross-cuts the
// invite flow's state. Returns a Discord interaction response object.
async function handleClaimCommand(env, data) {
  const code = (data?.data?.options?.find(o => o.name === 'code')?.value || '').toUpperCase().trim();
  const guildId = data?.guild_id;
  const member = data?.member;
  const userId = member?.user?.id;

  if (!guildId)
    return { type: 4, data: { content: 'This command must be run in a server.', flags: 64 } };
  if (!code || !/^[A-Z0-9]{4,12}$/.test(code))
    return { type: 4, data: { content: 'Code must be 4-12 alphanumeric characters.', flags: 64 } };

  // Permission check: only members with MANAGE_GUILD (0x20 = 32) can claim.
  // member.permissions is a string of the bitfield in Discord's payload.
  const perms = BigInt(member?.permissions || '0');
  const MANAGE_GUILD = 1n << 5n;
  if ((perms & MANAGE_GUILD) === 0n)
    return { type: 4, data: { content: '🔒 Only server admins (with **Manage Server**) can claim a code.', flags: 64 } };

  // Look up the code. Pop-on-claim: once claimed, the entry is replaced
  // with a usedAt marker and the secret is moved to secret:<guildId>.
  const key = 'claim:' + code;
  const raw = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  if (!raw)
    return { type: 4, data: { content: '❌ That code doesn\'t exist or has expired. Generate a new one in Loadout.', flags: 64 } };
  if (raw.claimedGuildId)
    return { type: 4, data: { content: '⚠️ That code was already claimed.', flags: 64 } };
  if (raw.ttlExpiresUtc && Date.now() > raw.ttlExpiresUtc)
    return { type: 4, data: { content: '⏰ That code expired. Generate a fresh one in Loadout (codes are valid for 10 minutes).', flags: 64 } };

  // Reject if this guild is already claimed (stops a streamer from accidentally
  // overwriting). Re-claiming requires the streamer to first hit "Unlink"
  // in Loadout, which talks to /sync/:guildId/init with the existing secret.
  const existing = await getSecret(env, guildId);
  if (existing?.secret)
    return { type: 4, data: { content: '⚠️ This server is already claimed by another Loadout install. Unlink first if you\'re moving rigs.', flags: 64 } };

  // Bind the code to this guild + persist the secret as the guild's
  // sync key. The Loadout install will poll /claim/:code/status and
  // see the claimedGuildId field flip; that's its signal to mark
  // setup complete.
  const claimed = { ...raw, claimedGuildId: guildId, claimedUtc: Date.now(), claimedByDiscordUserId: userId };
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(claimed), { expirationTtl: 3600 });   // keep 1h for status polls
  await setSecret(env, guildId, raw.secret, raw.ownerName || 'streamer');
  await env.LOADOUT_BOLTS.put('guildowner:' + guildId, JSON.stringify({
    discordUserId: userId,
    claimedAt: Date.now()
  }));

  return {
    type: 4,
    data: {
      content: '✅ **Loadout claimed for this server.**\n' +
               'The streamer can finish setup back in their Loadout window now. Try `/help` to see available commands.'
    }
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && (path === '/' || path === '/health')) {
      return new Response('loadout-discord ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // Public leaderboard for a guild — read-only, no auth. Filters out
    // wallets with no linked public platform so Discord-only users
    // don't get surfaced on the open web.
    if (method === 'GET' && path.startsWith('/leaderboard/')) {
      return handlePublicLeaderboard(req, env, path);
    }

    if (method === 'POST' && path === '/interactions') {
      return handleDiscordInteractions(req, env);
    }

    // Loadout-side endpoints
    if (method === 'POST' && path === '/claim')                      return mintClaim(req, env);
    if (method === 'GET'  && path.startsWith('/claim/') && path.endsWith('/status')) return claimStatus(req, env, path);
    if (path.startsWith('/sync/'))                                   return handleSync(req, env, path);
    if (path.startsWith('/tips/'))                                   return handleTip(req, env, path);

    // Aquilo's Vault integration: gated to the guild in env.AQUILO_VAULT_GUILD_ID
    if (method === 'POST' && path === '/credit-bolts')               return handleVaultCredit(req, env);

    // aquilo-bot counting game integration. Awards/deducts bolts when a
    // viewer correctly counts (or breaks the chain) in the counting
    // channel. Auth: shared secret in X-Counting-Secret header
    // (set as LOADOUT_BOLT_API_SECRET on both workers).
    if (method === 'POST' && path === '/counting/award-bolts')       return handleCountingAward(req, env);

    // Self-register Loadout slash commands using the Worker's bot
    // token secret. HMAC-gated (same scheme as wallet sync). Lets a
    // Loadout install push the latest commands.spec without the
    // streamer needing to paste the bot token into a shell.
    if (method === 'POST' && path.startsWith('/admin/register-commands/')) {
      return handleRegisterCommands(req, env, path);
    }

    return new Response('not found', { status: 404 });
  }
};

// ---- /leaderboard/:guildId (public, read-only) ---------------------------
// Returns the top-N wallets for a guild, filtered to viewers who have
// linked at least one public platform handle (twitch/youtube/etc). The
// goal is community-facing "top contributors" surfaces — Discord-only
// users haven't opted in to public identification, so we omit them.
//
// Response shape:
//   {
//     guildId: "1504103035951906883",
//     updatedAt: 1700000000000,
//     entries: [
//       { rank: 1, display: "MidnightWolf", platform: "twitch", balance: 12450, lifetimeEarned: 25000 },
//       ...
//     ]
//   }
//
// Cached server-side in KV for 60s so a busy homepage doesn't churn
// the wallet:* list-and-fetch on every page view.

const LEADERBOARD_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'public, max-age=60',
};

async function handlePublicLeaderboard(req, env, path) {
  // path = /leaderboard/<guildId>
  const guildId = path.split('/')[2] || '';
  if (!/^\d{5,25}$/.test(guildId)) {
    return jsonCors({ error: 'guildId must be a numeric Discord snowflake' }, 400);
  }

  const url = new URL(req.url);
  const limit = Math.min(
    25,
    Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10) || 10)
  );

  // Server-side cache — leaderboard is the same for everyone, no point
  // recomputing per request.
  const cacheKey = `leaderboard-cache:${guildId}`;
  try {
    const cached = await env.LOADOUT_BOLTS.get(cacheKey, { type: 'json' });
    if (cached && cached.updatedAt && Date.now() - cached.updatedAt < 60_000) {
      // Trim to the requested limit even if the cache holds more.
      const out = { ...cached, entries: cached.entries.slice(0, limit) };
      return jsonCors(out, 200);
    }
  } catch {
    /* fall through to recompute */
  }

  try {
    // Fetch up to top 50 by raw balance, then filter and trim.
    const top = await leaderboard(env, guildId, 50);
    const filtered = top.filter(
      ({ w }) =>
        w &&
        Array.isArray(w.links) &&
        w.links.some(l => l && l.platform && l.username)
    );
    const entries = filtered.slice(0, limit).map(({ w }, i) => {
      const primary =
        (w.links || []).find(l => l && l.platform === 'twitch') ||
        (w.links || []).find(l => l && l.platform && l.username) ||
        null;
      return {
        rank: i + 1,
        display: primary?.username || 'Viewer',
        platform: primary?.platform || null,
        balance: Number(w.balance || 0),
        lifetimeEarned: Number(w.lifetimeEarned || 0),
      };
    });

    const payload = {
      guildId,
      updatedAt: Date.now(),
      entries,
    };

    // Cache for 2x the freshness window so a stampede doesn't all
    // recompute at exactly 60s. Lazy refresh — first request after
    // expiry rebuilds and overwrites.
    try {
      await env.LOADOUT_BOLTS.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: 300,
      });
    } catch {
      /* non-fatal */
    }

    return jsonCors(payload, 200);
  } catch (err) {
    return jsonCors({ error: 'leaderboard failed', detail: String(err) }, 500);
  }
}

function jsonCors(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...LEADERBOARD_CORS },
  });
}

// ---- /credit-bolts (Aquilo's Vault → Loadout Bolts) ---------------------
// Vault bot calls here to mirror cap activity into off-stream Bolts.
// Auth: shared secret in X-Aquilo-Vault-Bolts-Secret header.
// Allow-list: env.AQUILO_VAULT_GUILD_ID restricts which guild can be credited
// (so a leaked secret can only target the configured Vault server, not any
// random Loadout-using server).

async function handleVaultCredit(req, env) {
  const expected = env.AQUILO_VAULT_BOLTS_SECRET;
  if (!expected) return new Response('credit endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-aquilo-vault-bolts-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const guildId = String(body.guild_id || '');
  const userId  = String(body.user_id  || '');
  const amount  = Number(body.amount);
  const reason  = String(body.reason || 'vault');

  if (!guildId || !userId || !Number.isFinite(amount)) {
    return new Response('guild_id, user_id, integer amount required', { status: 400 });
  }
  const allowed = env.AQUILO_VAULT_GUILD_ID;
  if (allowed && guildId !== String(allowed)) {
    return new Response('guild not allowed', { status: 403 });
  }

  const { wallet, was_new } = await applyVaultDelta(env, guildId, userId, Math.trunc(amount), reason);
  return json({ ok: true, balance: wallet.balance, was_new });
}

// ---- /counting/award-bolts (aquilo-bot → Loadout) ----------------------
// Counting-game integration. aquilo-bot calls here on each successful
// count (positive amount) or fail (negative amount). Same wallet
// primitive as the Vault integration — applyVaultDelta handles the
// balance clamp at 0 and tracks lifetimeEarned/Spent correctly.
//
// Auth: shared secret in X-Counting-Secret header, set as
// LOADOUT_BOLT_API_SECRET on this worker (and the same value on
// aquilo-bot's wrangler secret of the same name).
async function handleCountingAward(req, env) {
  const expected = env.LOADOUT_BOLT_API_SECRET;
  if (!expected) return new Response('counting endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-counting-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const guildId = String(body.guildId || body.guild_id || '');
  const userId  = String(body.userId  || body.user_id  || '');
  const amount  = Number(body.amount);
  const reason  = String(body.reason || 'counting');

  if (!guildId || !userId || !Number.isFinite(amount)) {
    return new Response('guildId, userId, integer amount required', { status: 400 });
  }

  const { wallet, was_new } = await applyVaultDelta(env, guildId, userId, Math.trunc(amount), reason);
  return json({ ok: true, balance: wallet.balance, was_new });
}

// ---- /interactions ------------------------------------------------------

async function handleDiscordInteractions(req, env) {
  // Single-tenant: one public key. Set it once via:
  //   wrangler kv:key put --binding=LOADOUT_BOLTS publickey <hex>
  const publicKey = await env.LOADOUT_BOLTS.get('publickey');
  if (!publicKey) return new Response('worker not provisioned', { status: 500 });

  const body = await req.text();
  const reReq = new Request(req.url, { method: 'POST', headers: req.headers, body });
  const v = await verifyDiscordSignature(reReq, publicKey);
  if (!v.ok) return new Response('bad signature', { status: 401 });

  let data;
  try { data = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }

  // PING
  if (data.type === 1) return json({ type: 1 });

  // /loadout-claim is special-cased — handled inline because it touches
  // the claim KV. Everything else flows through handleInteraction.
  if (data.type === 2 && data?.data?.name === 'loadout-claim') {
    const resp = await handleClaimCommand(env, data);
    return json(resp);
  }

  return handleInteraction(req, env, body);
}

// ---- /claim (Loadout mints a code) --------------------------------------

async function mintClaim(req, env) {
  // Loadout-side bootstrap: a streamer hits "Get my code" in Settings;
  // Loadout calls this with no auth (well, just the worker URL the user
  // configured). We mint a short alphanumeric code, generate a fresh
  // HMAC secret, and store both with a 10-min TTL. The streamer types
  // the code in their Discord server; that POSTs through /interactions
  // and gets bound to a guild id.
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const ownerName = (body.ownerName || '').slice(0, 64);

  const code = randomCode(8);
  const secret = randomSecret();
  const ttlMs = 10 * 60 * 1000;

  await env.LOADOUT_BOLTS.put('claim:' + code, JSON.stringify({
    secret,
    ownerName,
    mintedUtc: Date.now(),
    ttlExpiresUtc: Date.now() + ttlMs
  }), { expirationTtl: 600 });

  return json({
    code,
    secret,
    expiresInSec: 600,
    invite: 'https://discord.com/oauth2/authorize?client_id=' + (env.DISCORD_APP_ID || 'CLIENT_ID') +
            '&permissions=2147485696&scope=bot+applications.commands'
  });
}

// ---- /claim/:code/status (Loadout polls until claimed) ------------------

async function claimStatus(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['claim', '<code>', 'status']
  const code = (parts[1] || '').toUpperCase();
  if (!code) return new Response('code required', { status: 400 });
  const raw = await env.LOADOUT_BOLTS.get('claim:' + code, { type: 'json' });
  if (!raw) return json({ status: 'expired' });
  if (raw.claimedGuildId) return json({ status: 'claimed', guildId: raw.claimedGuildId });
  return json({ status: 'pending' });
}

// ---- /tips/:guildId/:secret --------------------------------------------
// Streamer's tip-provider (Streamlabs / StreamElements / Ko-fi / etc.)
// posts a normalized donation here. We append it to a rolling per-guild
// log; the DLL polls /sync/<guild>/tips?since=<ms> to pick them up,
// award bolts, and republish on the local Aquilo Bus so overlays light
// up. We deliberately don't accept upstream webhook formats directly —
// the streamer wires their provider to this endpoint via a Streamer.bot
// HTTP request action that posts the normalized shape:
//
//   POST /tips/<guildId>/<secret>
//   {
//     "tipper": "rosie",                // display name
//     "tipperPlatform": "twitch",       // optional, lowercase
//     "tipperHandle": "rosie_91",       // optional, the actual handle on the platform
//     "amount": 5.00,
//     "currency": "USD",
//     "message": "love the stream",
//     "source": "streamlabs",           // audit only
//     "tipId": "sl-12345"               // dedup key (optional)
//   }
//
// Why a path-segment secret: tip providers tend to be picky about
// custom headers but happy to take an arbitrary URL. Easier wire-up
// for streamers, comparable security to a header-bearing token.
async function handleTip(req, env, path) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const parts = path.split('/').filter(Boolean);   // ['tips', '<guildId>', '<secret>']
  if (parts.length < 3) return new Response('guildId and secret required', { status: 400 });
  const guildId = parts[1];
  const presented = parts[2];
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('guild not registered', { status: 404 });
  // Constant-time-ish compare. Worker timing isn't a great side-channel
  // anyway, but no reason to leak more than necessary.
  if (presented.length !== stored.secret.length) return new Response('bad secret', { status: 401 });
  let acc = 0;
  for (let i = 0; i < presented.length; i++) acc |= presented.charCodeAt(i) ^ stored.secret.charCodeAt(i);
  if (acc !== 0) return new Response('bad secret', { status: 401 });

  let payload;
  try { payload = await req.json(); }
  catch { return new Response('bad json', { status: 400 }); }
  const amount = Number(payload?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return new Response('amount required', { status: 400 });

  const tip = {
    tipper:         String(payload.tipper        || 'anonymous').slice(0, 64),
    tipperPlatform: String(payload.tipperPlatform || '').toLowerCase().slice(0, 16),
    tipperHandle:   String(payload.tipperHandle  || '').slice(0, 64),
    amount,
    currency:       String(payload.currency || 'USD').toUpperCase().slice(0, 8),
    message:        String(payload.message  || '').slice(0, 240),
    source:         String(payload.source   || 'unknown').toLowerCase().slice(0, 32),
    tipId:          String(payload.tipId    || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
    ts:             Date.now()
  };

  // Append to the rolling tip log. Capped at 200 entries — the DLL
  // polls every minute and clears its cursor, so even an active
  // multi-day-offline backlog stays well under cap.
  const key = 'tips:' + guildId;
  const existing = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
  // Dedup by tipId — re-deliveries from the streamer's tip provider
  // would otherwise double-credit the viewer.
  if (existing.some(e => e.tipId === tip.tipId)) {
    return new Response(JSON.stringify({ ok: true, dedup: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  existing.push(tip);
  while (existing.length > 200) existing.shift();
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(existing));

  return new Response(JSON.stringify({ ok: true, tipId: tip.tipId }),
                      { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /sync/:guildId... --------------------------------------------------

async function handleSync(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['sync', ':guildId', maybe 'init'|'games']
  const guildId = parts[1];
  const sub = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  if (sub === 'init' && req.method === 'POST') return handleSyncInit(req, env, guildId);

  const ts  = req.headers.get('x-loadout-ts');
  const sig = req.headers.get('x-loadout-sig');
  const body = req.method === 'POST' ? await req.text() : '';
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('guild not registered', { status: 404 });

  const ok = await verifyHmac(stored.secret, ts || '', body, sig || '');
  if (!ok) return new Response('bad signature', { status: 401 });

  // /sync/:guildId/games?since=<ms> — DLL pulls recent minigame results so
  // they can be republished on the local Aquilo Bus. Same HMAC scheme as
  // the wallet endpoints; ts+\n is the signed payload for GETs.
  if (sub === 'games' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const all = (await env.LOADOUT_BOLTS.get('games:' + guildId, { type: 'json' })) || [];
    const fresh = all.filter(e => (e.ts || 0) > sinceMs);
    const latest = fresh.length > 0 ? fresh[fresh.length - 1].ts : (all.length > 0 ? all[all.length - 1].ts : sinceMs);
    return new Response(JSON.stringify({ events: fresh, ts: latest }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/tips?since=<ms> — DLL pulls recent tip events to award
  // bolts locally and republish on the Aquilo Bus. Same HMAC scheme as
  // the wallet endpoints; ts+\n is the signed payload for GETs. Returns
  // { tips: [...], ts } so the DLL can advance its cursor.
  if (sub === 'tips' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const all = (await env.LOADOUT_BOLTS.get('tips:' + guildId, { type: 'json' })) || [];
    const fresh = all.filter(e => (e.ts || 0) > sinceMs);
    const latest = fresh.length > 0 ? fresh[fresh.length - 1].ts : (all.length > 0 ? all[all.length - 1].ts : sinceMs);
    return new Response(JSON.stringify({ tips: fresh, ts: latest }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/profiles?since=<ms> — DLL pulls Discord-side profile
  // edits (/profile-set-bio, etc.) and merges them into its local
  // ViewerProfileStore via the wallet's identity links. Returns
  // { profiles: [{userId, profile, deleted, ts}], ts } so the DLL can
  // advance its cursor to the latest seen.
  if (sub === 'profiles' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const page = await readProfilesSince(env, guildId, sinceMs);
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/heroes — DLL pushes the dungeon hero registry
  // (DungeonGameStore) so the /loadout menu can render stream-earned
  // gear without polling the DLL on every Hero / Bag click. Body:
  //   { ts: <ms>, heroes: { "twitch:bish":  {level,xp,bag,equipped,...}, ... } }
  // Stored under d:hero-by-handle:<guild>:<platform>:<handle> so the
  // /loadout menu can resolve a Discord user → wallet → first link →
  // hero in two KV reads. The Worker's own per-Discord-user hero
  // (d:hero:<guild>:<userId>) stays as fallback for users who haven't
  // linked yet — it's the off-stream-only progression path.
  if (sub === 'heroes' && req.method === 'POST') {
    let payload; try { payload = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const heroes = payload?.heroes || {};
    let count = 0;
    for (const key of Object.keys(heroes)) {
      // key is "platform:handle" lowercase. Mirror that into the KV key.
      const safeKey = key.replace(/[^a-z0-9_:.-]/gi, '');
      if (!safeKey.includes(':')) continue;
      await env.LOADOUT_BOLTS.put('d:hero-by-handle:' + guildId + ':' + safeKey,
                                  JSON.stringify(heroes[key]));
      count++;
    }
    return new Response(JSON.stringify({ ok: true, applied: count }),
                        { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/digest — DLL posts a weekly stats snapshot here once
  // a week. We format it as a rich Discord embed and POST to the
  // configured channel via the bot token. The DLL only retries on
  // failure, so a Discord 5xx self-heals next minute.
  if (sub === 'digest' && req.method === 'POST') {
    let payload; try { payload = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const channelId = String(payload?.channelId || '').trim();
    if (!channelId) return new Response('channelId required', { status: 400 });
    const token = env.DISCORD_BOT_TOKEN;
    if (!token) return new Response('bot token not set', { status: 500 });
    const embed = buildDigestEmbed(payload);
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bot ' + token,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ embeds: [embed] })
      });
      if (!resp.ok) {
        const txt = await resp.text();
        return new Response(JSON.stringify({ ok: false, status: resp.status, body: txt.slice(0, 400) }),
                            { status: 502, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }),
                          { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
                          { status: 500, headers: { 'content-type': 'application/json' } });
    }
  }

  // /sync/:guildId/reset-wallets — streamer-initiated wipe of every
  // wallet balance + lifetime counter for the guild. Links and the
  // streamer's bot config are preserved so viewers don't need to
  // re-link after a reset. HMAC-gated by the same scheme as push/pull.
  if (sub === 'reset-wallets' && req.method === 'POST') {
    const cleared = await resetAllWallets(env, guildId);
    return new Response(JSON.stringify({ ok: true, cleared }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (req.method === 'GET') {
    const snap = await readSnapshot(env, guildId);
    return new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (req.method === 'POST') {
    let snap; try { snap = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const n = await applySnapshot(env, guildId, snap);
    return new Response(JSON.stringify({ ok: true, applied: n }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('method not allowed', { status: 405 });
}

async function handleSyncInit(req, env, guildId) {
  // After a successful claim the guild's secret is already in KV from the
  // /interactions handler. Init now is just a no-op confirmation OR
  // unlink (if body says so). Loadout calls this to confirm the binding
  // is intact, or to clear it.
  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  if (body.action === 'unlink') {
    if (body.existingSecret !== (await getSecret(env, guildId))?.secret)
      return new Response('existingSecret required', { status: 401 });
    await env.LOADOUT_BOLTS.delete('secret:' + guildId);
    await env.LOADOUT_BOLTS.delete('guildowner:' + guildId);
    return json({ ok: true, unlinked: true });
  }
  // Default: confirm.
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('not registered', { status: 404 });
  return json({ ok: true, registeredUtc: stored.registeredUtc });
}

// ---- /admin/register-commands/:guildId (HMAC) ---------------------------
// POST body: optional. Empty body is fine — the commands list is baked
// into the deployed Worker. Returns Discord's response so the caller can
// confirm the new command count.

async function handleRegisterCommands(req, env, path) {
  // Parse guildId out of /admin/register-commands/:guildId so we can
  // verify the HMAC against THAT guild's secret.
  const parts = path.split('/').filter(Boolean);   // ['admin', 'register-commands', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const ts  = req.headers.get('x-loadout-ts');
  const sig = req.headers.get('x-loadout-sig');
  const body = await req.text();
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('guild not registered', { status: 404 });
  const ok = await verifyHmac(stored.secret, ts || '', body, sig || '');
  if (!ok) return new Response('bad signature', { status: 401 });

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token)
    return new Response('worker not provisioned (DISCORD_APP_ID + DISCORD_BOT_TOKEN required)', { status: 503 });

  // Discord's PUT /applications/:id/commands replaces the entire global
  // command set with the body, which is exactly what we want — push
  // commands-spec.js as the canonical list.
  const url = `https://discord.com/api/v10/applications/${appId}/commands`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS)
  });
  const text = await r.text();
  if (!r.ok)
    return new Response(JSON.stringify({ ok: false, status: r.status, body: text.slice(0, 800) }),
                        { status: 502, headers: { 'content-type': 'application/json' } });

  return new Response(JSON.stringify({ ok: true, registered: COMMANDS.length, status: r.status }),
                      { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- helpers ------------------------------------------------------------

function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function randomCode(len) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I/L/O/0/1 to avoid OCR confusion
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
function randomSecret() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

// Build the weekly-digest Discord embed from the DLL's stats snapshot.
// Discord embed reference: https://discord.com/developers/docs/resources/channel#embed-object
function buildDigestEmbed(p) {
  const emoji = p.boltsEmoji || '⚡';
  const name  = p.boltsName  || 'Bolts';
  const fmtNum = (n) => {
    const x = Number(n) || 0;
    return x.toLocaleString('en-US');
  };
  const fmtUsd = (n) => '$' + (Number(n) || 0).toFixed(2);
  const safeStreamer = (p.streamerName || '').trim() || 'this stream';
  const accentInt = parseInt((p.accent || '#3A86FF').replace('#', ''), 16) || 0x3A86FF;

  // Top earners: fenced-code list so handles align cleanly even with
  // wide names. Markdown won't help much in Discord embeds — the
  // monospace block is the most legible option.
  const top = Array.isArray(p.topEarners) ? p.topEarners : [];
  let topField;
  if (top.length === 0) {
    topField = '_no activity this week_';
  } else {
    const maxName = top.reduce((m, e) => Math.max(m, (e.user || '').length), 0);
    const lines = top.map((e, i) => {
      const medal = ['🥇', '🥈', '🥉', '4.', '5.'][i] || ((i + 1) + '.');
      const handle = (e.user || '?').padEnd(Math.min(maxName, 16), ' ');
      return `${medal}  \`${handle}\`  ${fmtNum(e.bolts)} ${emoji}`;
    });
    topField = lines.join('\n');
  }

  // Highlights field — auto-pruned to skip rows that didn't happen.
  const highlights = [];
  if (p.hypeTrains > 0) highlights.push(`🚂  **${p.hypeTrains}** hype train${p.hypeTrains === 1 ? '' : 's'} (peak Lv ${p.hypeTrainMaxLevel || 0})`);
  if (p.heistsSucceeded > 0) {
    const crew = p.biggestHeistCrew > 0 ? ` — biggest pulled with ${p.biggestHeistCrew} crewmates for ${fmtNum(p.biggestHeistPot)} ${emoji}` : '';
    highlights.push(`🦹  **${p.heistsSucceeded}** heist${p.heistsSucceeded === 1 ? '' : 's'} pulled${crew}`);
  }
  if (p.minigamesPlayed > 0) highlights.push(`🎰  **${fmtNum(p.minigamesPlayed)}** minigames played`);
  if (p.tipsCount > 0) {
    const big = p.biggestTipUsd > 0 ? ` — biggest from **${p.biggestTipper || 'anonymous'}** at ${fmtUsd(p.biggestTipUsd)}` : '';
    highlights.push(`💖  **${p.tipsCount}** tip${p.tipsCount === 1 ? '' : 's'} totalling ${fmtUsd(p.tipsTotalUsd)}${big}`);
  }
  if (p.welcomesShown > 0) highlights.push(`👋  **${fmtNum(p.welcomesShown)}** welcome${p.welcomesShown === 1 ? '' : 's'} delivered`);
  const highlightsField = highlights.length > 0 ? highlights.join('\n') : '_quiet week — try a hype train next stream._';

  return {
    title:       `📊 Weekly digest — ${safeStreamer}`,
    description: `Here's what went down this week.`,
    color:       accentInt,
    timestamp:   new Date().toISOString(),
    fields: [
      {
        name:   `${emoji} ${name} earned`,
        value:  `**${fmtNum(p.boltsEarned)}** ${name.toLowerCase()}`,
        inline: true
      },
      {
        name:   '🎯 Activity',
        value:  `${fmtNum(p.minigamesPlayed)} games · ${fmtNum(p.heistsSucceeded)} heists · ${fmtNum(p.hypeTrains)} trains`,
        inline: true
      },
      {
        name:   '​',                        // zero-width spacer — keeps layout stable
        value:  '​',
        inline: true
      },
      {
        name:   '🏆 Top 5 earners',
        value:  topField.slice(0, 1024),         // Discord field cap
        inline: false
      },
      {
        name:   '✨ Highlights',
        value:  highlightsField.slice(0, 1024),
        inline: false
      }
    ],
    footer: {
      text: `Loadout · ${new Date(p.weekStartedUtc || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${new Date(p.weekEndedUtc || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    }
  };
}
