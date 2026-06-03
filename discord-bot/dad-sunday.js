// Dad Game Sunday — current-game state + admin API (2026-06 schedule
// update). Sundays moved from Triple-C to "Dad Game Sunday": cozy / sim /
// management games. The Sunday game is decided by the Fri→Sun community
// vote (vote-hub kind 'dad'), but an owner can LOCK a specific game to
// override the vote (mirrors the Triple-C admin pattern).
//
// Resolution order (getCurrentDadSunday):
//   1. owner-locked game   (dad-sunday:current:<guildId>)
//   2. this week's vote winner (vote-hub:winner:<guildId>:dad)
//   3. null  → schedule renders "vote in progress" / TBA
//
// KV: dad-sunday:current:<guildId> -> { gameSlug, name, artUrl, store, setUtc, setBy }
//
// Endpoints (wired in worker/web):
//   GET  /dad-sunday/current        public — current Sunday game
//   GET  /dad-sunday/pool           public — the 10-game pool (admin dropdown)
//   POST /web/admin/dad-sunday/set  owner  — { gameSlug } -> lock it + announce

const KEY = (g) => `dad-sunday:current:${g}`;
const POOL = 'dad-sunday';

// Read the dad-sunday pool from the games:v1 catalog (same store the
// Discord /games command + site games admin write). Returns
// [{ gameSlug, name, artUrl, store }].
export async function getDadSundayPool(env, guildId) {
  const gid = guildId || String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  let cat = null;
  try { cat = await env.LOADOUT_BOLTS.get(`games:v1:${gid}`, { type: 'json' }); } catch { /* ignore */ }
  const items = (cat && Array.isArray(cat.items)) ? cat.items : [];
  return items
    .filter((g) => Array.isArray(g.pools) && g.pools.includes(POOL))
    .map((g) => ({
      gameSlug: g.id,
      name: g.name,
      artUrl: g.headerUrl || g.capsuleUrl || null,
      store: g.storeUrl || null,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function poolEntry(env, guildId, slug) {
  const pool = await getDadSundayPool(env, guildId);
  return pool.find((x) => x.gameSlug === slug) || null;
}

// Current Sunday game: owner-lock → vote winner → null.
export async function getCurrentDadSunday(env, guildId) {
  const gid = guildId || String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  // 1. Owner-locked override.
  let rec = null;
  try { rec = await env.LOADOUT_BOLTS.get(KEY(gid), { type: 'json' }); } catch { /* ignore */ }
  if (rec && rec.gameSlug && rec.name) return rec;
  // 2. This week's vote winner (set by vote-hub when the dad poll closes).
  let w = null;
  try { w = await env.LOADOUT_BOLTS.get(`vote-hub:winner:${gid}:dad`, { type: 'json' }); } catch { /* ignore */ }
  if (w && w.name) {
    return {
      gameSlug: w.gameId || null, name: w.name,
      artUrl: w.art_url || null, store: null,
      setUtc: 0, setBy: 'vote', voteWinner: true,
    };
  }
  // 3. Nothing decided yet.
  return null;
}

// Validate + persist an owner lock. Returns { ok, current } or { ok:false }.
export async function setCurrentDadSunday(env, guildId, gameSlug, setBy) {
  const gid = guildId || String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  const entry = await poolEntry(env, guildId, String(gameSlug || '').trim());
  if (!entry) {
    const pool = await getDadSundayPool(env, guildId);
    return { ok: false, error: 'unknown-game', allowed: pool.map((o) => o.gameSlug) };
  }
  const rec = { ...entry, setUtc: Date.now(), setBy: setBy || null };
  await env.LOADOUT_BOLTS.put(KEY(gid), JSON.stringify(rec));
  return { ok: true, current: rec };
}

// Post the "Dad Game Sunday is now X" announcement embed. Best-effort.
export async function announceDadSunday(env, current) {
  if (!env.DISCORD_BOT_TOKEN || !current) return { ok: false, error: 'no-bot-token' };
  // Mirror Triple-C: Dad Game Sunday lock-ins announce in the 📅
  // schedule channel alongside the pinned weekly embed (task brief #5).
  const channelId = String(env.TRIPLE_C_ANNOUNCE_CHANNEL || env.SCHEDULE_CHANNEL_ID
    || '1507973920282640485').trim();
  if (!channelId) return { ok: false, error: 'no-channel' };
  const embed = {
    title: `🛋️ Dad Game Sunday is now: ${current.name}`,
    description: 'The cozy Sunday game is locked in.\nStreams **Sunday** at **10:30 PM ET**.',
    color: 0xe6a86b,
    image: current.artUrl ? { url: current.artUrl } : undefined,
    footer: { text: 'Dad Game Sunday · cozy / sim / management' },
  };
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  return { ok: r.ok, status: r.status };
}
