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
import { applySnapshot, readSnapshot, getSecret, setSecret, applyVaultDelta } from './wallet.js';

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

    if (method === 'POST' && path === '/interactions') {
      return handleDiscordInteractions(req, env);
    }

    // Loadout-side endpoints
    if (method === 'POST' && path === '/claim')                      return mintClaim(req, env);
    if (method === 'GET'  && path.startsWith('/claim/') && path.endsWith('/status')) return claimStatus(req, env, path);
    if (path.startsWith('/sync/'))                                   return handleSync(req, env, path);

    // Aquilo's Vault integration: gated to the guild in env.AQUILO_VAULT_GUILD_ID
    if (method === 'POST' && path === '/credit-bolts')               return handleVaultCredit(req, env);

    return new Response('not found', { status: 404 });
  }
};

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
