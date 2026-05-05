// KV-backed wallet operations.
//
// Storage layout (per-guild namespace):
//   wallet:<guildId>:<discordUserId>     -> { balance, lifetimeEarned, lastEarnUtc, dailyStreak, lastDailyUtc, links: [...] }
//   secret:<guildId>                     -> { secret, registeredUtc, ownerStreamerName }
//   leaderboard:<guildId>                -> cached top-N list (stale-OK, regenerated lazily)
//
// We deliberately do NOT use a per-guild list to avoid blowing CF KV's 1MB
// per value cap on big servers. Leaderboard is rebuilt by listing keys with
// the wallet:<guildId>: prefix and sorting client-side. With CF KV's list
// pagination, that's fine up to ~10k accounts.

const LIST_LIMIT = 1000;

export async function getWallet(env, guildId, userId) {
  const key = `wallet:${guildId}:${userId}`;
  const raw = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  return raw || {
    balance: 0, lifetimeEarned: 0, lastEarnUtc: 0,
    dailyStreak: 0, lastDailyUtc: 0, links: []
  };
}

export async function putWallet(env, guildId, userId, w) {
  const key = `wallet:${guildId}:${userId}`;
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(w));
}

export async function earn(env, guildId, userId, amount, reason) {
  if (!amount || amount <= 0) return null;
  const w = await getWallet(env, guildId, userId);
  w.balance += amount;
  w.lifetimeEarned += amount;
  w.lastEarnUtc = Date.now();
  w.lastEarnReason = reason || '';
  await putWallet(env, guildId, userId, w);
  return w;
}

// Vault → Loadout integration: signed credit/debit from Aquilo's Vault bot.
// Accepts a signed amount (positive credits, negative debits) and clamps the
// resulting balance at 0. Returns {wallet, was_new} so the caller can decide
// whether to nudge first-time recipients.
export async function applyVaultDelta(env, guildId, userId, amount, reason) {
  if (!Number.isFinite(amount) || amount === 0) {
    return { wallet: await getWallet(env, guildId, userId), was_new: false };
  }
  const key = `wallet:${guildId}:${userId}`;
  const existing = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  const w = existing || {
    balance: 0, lifetimeEarned: 0, lastEarnUtc: 0,
    dailyStreak: 0, lastDailyUtc: 0, links: []
  };
  w.balance = Math.max(0, (w.balance || 0) + amount);
  if (amount > 0) {
    w.lifetimeEarned = (w.lifetimeEarned || 0) + amount;
    w.lastEarnUtc = Date.now();
    w.lastEarnReason = reason || 'vault';
  } else {
    w.lastSpendUtc = Date.now();
    w.lastSpendReason = reason || 'vault';
  }
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(w));
  return { wallet: w, was_new: !existing };
}

export async function spend(env, guildId, userId, amount, reason) {
  if (!amount || amount <= 0) return { ok: false, reason: 'amount must be positive' };
  const w = await getWallet(env, guildId, userId);
  if (w.balance < amount) return { ok: false, reason: 'insufficient balance', balance: w.balance };
  w.balance -= amount;
  w.lastSpendUtc = Date.now();
  w.lastSpendReason = reason || '';
  await putWallet(env, guildId, userId, w);
  return { ok: true, wallet: w };
}

export async function transfer(env, guildId, fromId, toId, amount) {
  if (fromId === toId) return { ok: false, reason: "can't gift yourself" };
  if (!amount || amount <= 0) return { ok: false, reason: 'amount must be positive' };
  const r = await spend(env, guildId, fromId, amount, 'gift:' + toId);
  if (!r.ok) return r;
  const credited = await earn(env, guildId, toId, amount, 'gift:from:' + fromId);
  return { ok: true, sender: r.wallet, recipient: credited };
}

export async function leaderboard(env, guildId, limit = 10) {
  // List all wallet keys for this guild, fetch values, sort, slice.
  // CF KV list returns paginated keys (max 1000 per call). We cap iterations.
  const prefix = `wallet:${guildId}:`;
  let cursor = undefined;
  const all = [];
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: LIST_LIMIT });
    for (const k of r.keys) {
      const userId = k.name.slice(prefix.length);
      // Pull wallets in parallel — list doesn't include values.
      all.push(env.LOADOUT_BOLTS.get(k.name, { type: 'json' }).then(v => ({ userId, w: v })));
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  const resolved = (await Promise.all(all)).filter(x => x.w);
  resolved.sort((a, b) => (b.w.balance || 0) - (a.w.balance || 0));
  return resolved.slice(0, limit);
}

export async function setSecret(env, guildId, secret, ownerName) {
  const key = `secret:${guildId}`;
  const existing = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  // First-time registration is free. Re-registration requires the existing
  // secret to be presented in HMAC, validated by the route handler.
  const payload = {
    secret,
    ownerStreamerName: ownerName || (existing?.ownerStreamerName ?? ''),
    registeredUtc: existing?.registeredUtc || Date.now()
  };
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(payload));
}

export async function getSecret(env, guildId) {
  const key = `secret:${guildId}`;
  return await env.LOADOUT_BOLTS.get(key, { type: 'json' });
}

// Bulk apply a snapshot from Loadout. Snapshot is { wallets: { userId: { ... } } }.
// We take Loadout's values verbatim - Loadout is the source of truth for
// on-stream activity, the worker is the source of truth for off-stream.
// The merge happens on the LOADOUT side before the push (last-write-wins by
// kind: on-stream earns OR off-stream earns are merged, never blindly stomped).
export async function applySnapshot(env, guildId, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const wallets = snapshot.wallets || {};
  let n = 0;
  for (const [userId, w] of Object.entries(wallets)) {
    if (!userId || !w) continue;
    await putWallet(env, guildId, userId, w);
    n++;
  }
  return n;
}

export async function readSnapshot(env, guildId) {
  const prefix = `wallet:${guildId}:`;
  const wallets = {};
  let cursor = undefined;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: LIST_LIMIT });
    const fetches = r.keys.map(k => env.LOADOUT_BOLTS.get(k.name, { type: 'json' }).then(v => [k.name.slice(prefix.length), v]));
    for (const [userId, w] of await Promise.all(fetches)) {
      if (w) wallets[userId] = w;
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return { wallets, ts: Date.now() };
}
