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
    balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, lastEarnUtc: 0,
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
    balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, lastEarnUtc: 0,
    dailyStreak: 0, lastDailyUtc: 0, links: []
  };
  w.balance = Math.max(0, (w.balance || 0) + amount);
  if (amount > 0) {
    w.lifetimeEarned = (w.lifetimeEarned || 0) + amount;
    w.lastEarnUtc = Date.now();
    w.lastEarnReason = reason || 'vault';
  } else {
    // Track lifetimeSpent for sync — DLL uses the (earned, spent) pair
    // to reconcile balances across linked accounts. Without this the
    // Worker side's spends never propagate back to the DLL via Pull,
    // so the two surfaces drift after every Discord-side game.
    w.lifetimeSpent = (w.lifetimeSpent || 0) + Math.abs(amount);
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
  w.lifetimeSpent = (w.lifetimeSpent || 0) + amount;
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

// Bulk apply a snapshot from Loadout.
//
// Snapshot shape:
//   { wallets: { "<platform>:<handle>": { balance, lifetimeEarned, lifetimeSpent, lastEarnUtc, dailyStreak, links: [{platform, username}] } } }
//
// Sync model (May 2026 fix — was previously broken for linked accounts):
//   Each entry in `wallets` is keyed by the DLL's "<platform>:<handle>"
//   canonical key. To make balances visible from /balance and the menu,
//   we have to land that data on the linked Discord user's wallet
//   (`wallet:<guildId>:<discordUserId>`). The link map lives inside
//   each Discord wallet's `links: []` array, so we build a reverse
//   index (`platform:username` → discordUserId) by scanning every
//   wallet once per push. This is O(walletCount) per sync but the
//   alternative (an explicit linkidx KV) would need a backfill anyway.
//
// Merge strategy uses lifetime counters (which only grow) rather than
// the absolute balance:
//   merged.lifetimeEarned = max(local, remote)
//   merged.lifetimeSpent  = max(local, remote)
//   merged.balance        = lifetimeEarned - lifetimeSpent
// This way an off-stream spend (which only the Worker knows) and an
// on-stream earn (which only the DLL knows) compose to the right
// total without either side clobbering the other's deltas.
//
// Unlinked DLL accounts (no Discord user has them in `links`) are
// silently dropped — they only exist on stream, no syncing needed
// until the viewer runs `/loadout link`.
export async function applySnapshot(env, guildId, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const wallets = snapshot.wallets || {};
  if (Object.keys(wallets).length === 0) return 0;

  // Build the reverse-link index from existing Discord wallets.
  const linkIndex = await buildLinkIndex(env, guildId);
  let n = 0;

  for (const [streamKey, dllWallet] of Object.entries(wallets)) {
    if (!streamKey || !dllWallet) continue;

    // Find a linked Discord user via any of the wallet's link entries.
    // The DLL push includes the same platform/handle pair the
    // entry is keyed by, but we look at all links so this also picks
    // up cases where the DLL has a multi-platform-merged wallet.
    let discordUserId = null;
    const links = Array.isArray(dllWallet.links) ? dllWallet.links : [];
    for (const l of links) {
      if (!l?.platform || !l?.username) continue;
      const k = `${String(l.platform).toLowerCase()}:${String(l.username).toLowerCase()}`;
      if (linkIndex.has(k)) { discordUserId = linkIndex.get(k); break; }
    }
    if (!discordUserId) continue;  // unlinked — skip silently.

    const local = await getWallet(env, guildId, discordUserId);
    const dllEarned = Number(dllWallet.lifetimeEarned) || 0;
    const dllSpent  = Number(dllWallet.lifetimeSpent)  || 0;
    const localEarned = Number(local.lifetimeEarned)   || 0;
    const localSpent  = Number(local.lifetimeSpent)    || 0;

    const mergedEarned = Math.max(dllEarned, localEarned);
    const mergedSpent  = Math.max(dllSpent,  localSpent);
    const mergedBalance = Math.max(0, mergedEarned - mergedSpent);

    // Skip the write if nothing changed — saves KV writes (each one's
    // a billable op) for the common case where the DLL pushes the
    // same snapshot every 30s with no on-stream activity.
    if (mergedEarned === localEarned &&
        mergedSpent  === localSpent  &&
        mergedBalance === (local.balance || 0)) continue;

    local.balance        = mergedBalance;
    local.lifetimeEarned = mergedEarned;
    local.lifetimeSpent  = mergedSpent;
    if (dllWallet.lastEarnUtc && dllWallet.lastEarnUtc > (local.lastEarnUtc || 0)) {
      local.lastEarnUtc = dllWallet.lastEarnUtc;
    }
    await putWallet(env, guildId, discordUserId, local);
    n++;
  }
  return n;
}

// Reverse-lookup: scan every wallet for this guild and build a map of
// every linked stream identity → Discord user id. Only used by the
// snapshot apply path right now; if we end up needing this on hot
// paths we can promote it to a `linkidx:` KV row maintained by /link.
async function buildLinkIndex(env, guildId) {
  const prefix = `wallet:${guildId}:`;
  const idx = new Map();
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: LIST_LIMIT });
    const fetches = r.keys.map(k => env.LOADOUT_BOLTS.get(k.name, { type: 'json' })
      .then(v => [k.name.slice(prefix.length), v]));
    for (const [discordUserId, w] of await Promise.all(fetches)) {
      if (!w?.links) continue;
      for (const l of w.links) {
        if (!l?.platform || !l?.username) continue;
        idx.set(`${String(l.platform).toLowerCase()}:${String(l.username).toLowerCase()}`, discordUserId);
      }
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return idx;
}

// Streamer-facing reset: wipe every wallet in the guild back to zero.
// Returns the number of wallets cleared. Used by the /admin/reset-wallets
// HMAC-gated endpoint (which the Loadout settings UI hits behind a
// confirm dialog).
export async function resetAllWallets(env, guildId) {
  const prefix = `wallet:${guildId}:`;
  let cleared = 0;
  let cursor;
  for (let i = 0; i < 10; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: LIST_LIMIT });
    // Preserve the `links` array on each wallet so existing /link
    // pairings survive the reset — only balance / lifetime counters
    // get zeroed. Otherwise viewers would have to re-link everything.
    for (const k of r.keys) {
      const w = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!w) continue;
      const reset = {
        balance: 0,
        lifetimeEarned: 0,
        lifetimeSpent: 0,
        lastEarnUtc: 0,
        dailyStreak: 0,
        lastDailyUtc: 0,
        links: w.links || []
      };
      await env.LOADOUT_BOLTS.put(k.name, JSON.stringify(reset));
      cleared++;
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return cleared;
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
