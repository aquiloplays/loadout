// Multi-tenant gate. Replaces the legacy AQUILO_VAULT_GUILD_ID
// single-guild allow-list with a per-guild "is this guild a registered
// tenant?" lookup.
//
// A guild becomes a tenant by completing /setup (or by being grandfathered
// in via env.AQUILO_VAULT_GUILD_ID — the existing Aquilo deployment).
// /web/* and /credit-bolts and /wallet-balance and other surface routes
// check isRegisteredTenant() before serving so a forged-cookie request
// for an un-onboarded guild still 403s.
//
// KV layout:
//   guild:tenant:<g>  →  { ownerId, createdUtc, status: 'active' | 'suspended',
//                           features: { ... }, source: 'setup' | 'env' }
//
// Caller pattern:
//   const t = await isRegisteredTenant(env, guildId);
//   if (!t) return new Response('guild not registered — run /setup', { status: 403 });

const TENANT_KEY = (g) => `guild:tenant:${g}`;

export async function getTenant(env, guildId) {
  if (!guildId) return null;
  return env.LOADOUT_BOLTS.get(TENANT_KEY(guildId), { type: 'json' });
}

// Cheap predicate for gates. Returns true if:
//   - the guild has a stored tenant record AND it's not suspended, OR
//   - the guild is the Aquilo grandfather (env.AQUILO_VAULT_GUILD_ID).
// Either path admits the guild; the second is a transitional safeguard
// so the existing Aquilo deployment never breaks while we migrate
// /setup-based registration.
export async function isRegisteredTenant(env, guildId) {
  if (!guildId) return false;
  const t = await getTenant(env, guildId);
  if (t && t.status !== 'suspended') return true;
  if (env.AQUILO_VAULT_GUILD_ID && String(guildId) === String(env.AQUILO_VAULT_GUILD_ID)) {
    // Auto-grandfather: if the legacy env var names this guild and no
    // tenant record exists yet, treat it as active. /setup will write a
    // real record later and this branch becomes the no-op fallback.
    return true;
  }
  return false;
}

// Create/upsert a tenant record. Called from /setup (slash + web).
// Idempotent — re-running /setup just bumps updatedUtc and keeps
// ownerId. Status defaults to 'active'.
export async function registerTenant(env, guildId, opts = {}) {
  if (!guildId) return { ok: false, error: 'no-guild' };
  const existing = await getTenant(env, guildId);
  const rec = {
    ownerId:    opts.ownerId || existing?.ownerId || null,
    createdUtc: existing?.createdUtc || Date.now(),
    updatedUtc: Date.now(),
    status:     opts.status || existing?.status || 'active',
    source:     existing?.source || opts.source || 'setup',
    setupStep:  opts.setupStep || existing?.setupStep || 'init',
    features:   { ...(existing?.features || {}), ...(opts.features || {}) },
  };
  await env.LOADOUT_BOLTS.put(TENANT_KEY(guildId), JSON.stringify(rec));
  return { ok: true, tenant: rec };
}

// Mark setup progress. Setup wizard calls this between steps so a
// resumed wizard knows where to pick up.
export async function setSetupStep(env, guildId, step) {
  const t = await getTenant(env, guildId);
  if (!t) return { ok: false, error: 'no-tenant' };
  t.setupStep = step;
  t.updatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put(TENANT_KEY(guildId), JSON.stringify(t));
  return { ok: true, tenant: t };
}

// Suspend / unsuspend (admin tooling — not exposed to streamers).
export async function setTenantStatus(env, guildId, status) {
  const t = await getTenant(env, guildId);
  if (!t) return { ok: false, error: 'no-tenant' };
  t.status = status;
  t.updatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put(TENANT_KEY(guildId), JSON.stringify(t));
  return { ok: true, tenant: t };
}
