// Boltbound, ranked ladder + monthly seasons (RET-4).
//
// Ladder: Bronze 5 → Bronze 1 → Silver 5 → … → Diamond 1 → Legend.
// Five tiers of five divisions (index 0..24) plus Legend (index 25).
// Win = +1 star, 5 stars = promote (stars reset). At 0 stars, 5 losses
// demote one division, except you can't fall below the bottom of the
// highest tier you've reached (the "floor"), and Legend never demotes
// in-season. PvP matches feed the ladder; NPC matches don't.
//
// Seasons are calendar months (UTC). On the first match of a new month
// (or the monthly cron, whichever fires first) a player's previous
// season is settled: end-of-season rewards by peak tier, then a soft
// reset two tiers down. Settlement is idempotent per (user, season).
//
// D1:
//   ranked_player, one row per user (current season + counters)
//   ranked_season, season log (for the close cron's bookkeeping)

import { applyVaultDelta } from './wallet.js';
import { creditPack } from './cards-packs.js';

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
const DIVISIONS = 5;
const LEGEND_INDEX = TIERS.length * DIVISIONS; // 25
const STARS_PER_DIVISION = 5;
const LOSSES_TO_DEMOTE = 5;
const RESET_DROP_DIVISIONS = 10; // soft reset ≈ two tiers

function db(env) {
  if (!env || !env.DB) throw new Error('ranked: no D1 binding (env.DB missing)');
  return env.DB;
}

// ── Rank naming ─────────────────────────────────────────────────────

export function rankName(index) {
  if (index >= LEGEND_INDEX) return 'Legend';
  const tier = TIERS[Math.floor(index / DIVISIONS)];
  const division = DIVISIONS - (index % DIVISIONS); // 5 (low) .. 1 (high)
  return `${tier} ${division}`;
}
function tierKey(index) {
  if (index >= LEGEND_INDEX) return 'legend';
  return TIERS[Math.floor(index / DIVISIONS)].toLowerCase();
}
function tierFloorIndex(index) {
  if (index >= LEGEND_INDEX) return LEGEND_INDEX;
  return Math.floor(index / DIVISIONS) * DIVISIONS;
}

// ── Season helpers ──────────────────────────────────────────────────

export function seasonKey(nowMs) {
  const d = new Date(nowMs == null ? Date.now() : nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function seasonEndsUtc(nowMs) {
  const d = new Date(nowMs == null ? Date.now() : nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

// End-of-season reward by the peak tier reached that season.
const SEASON_REWARDS = {
  bronze:   { bolts: 100,  packs: [] },
  silver:   { bolts: 250,  packs: [],                       cosmetic: 'cardback-silver' },
  gold:     { bolts: 500,  packs: [{ type: 'bolt', n: 1 }] },
  platinum: { bolts: 750,  packs: [{ type: 'bolt', n: 1 }], cosmetic: 'cardback-platinum' },
  diamond:  { bolts: 1000, packs: [{ type: 'voltaic', n: 2 }], cosmetic: 'golden-card' },
  legend:   { bolts: 2500, packs: [{ type: 'voltaic', n: 5 }], cosmetic: 'cardback-legend' },
};

// ── Row IO ──────────────────────────────────────────────────────────

function blankRow(userId, guildId, season) {
  return {
    user_id: String(userId), guild_id: guildId || null, season,
    rank_index: 0, stars: 0, losses_at_zero: 0, floor_index: 0,
    peak_index: 0, wins: 0, losses: 0,
    cosmetics: [],
  };
}

function parseRow(r) {
  if (!r) return null;
  let cosmetics = [];
  try { cosmetics = JSON.parse(r.cosmetics || '[]'); } catch { cosmetics = []; }
  return {
    user_id: r.user_id, guild_id: r.guild_id || null, season: r.season,
    rank_index: Number(r.rank_index) || 0,
    stars: Number(r.stars) || 0,
    losses_at_zero: Number(r.losses_at_zero) || 0,
    floor_index: Number(r.floor_index) || 0,
    peak_index: Number(r.peak_index) || 0,
    wins: Number(r.wins) || 0,
    losses: Number(r.losses) || 0,
    cosmetics,
  };
}

async function readRow(env, userId) {
  const r = await db(env).prepare(
    'SELECT * FROM ranked_player WHERE user_id = ? LIMIT 1'
  ).bind(String(userId)).first();
  return parseRow(r);
}

async function writeRow(env, row) {
  await db(env).prepare(
    `INSERT INTO ranked_player
       (user_id, guild_id, season, rank_index, stars, losses_at_zero,
        floor_index, peak_index, wins, losses, cosmetics, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       guild_id=excluded.guild_id, season=excluded.season,
       rank_index=excluded.rank_index, stars=excluded.stars,
       losses_at_zero=excluded.losses_at_zero, floor_index=excluded.floor_index,
       peak_index=excluded.peak_index, wins=excluded.wins, losses=excluded.losses,
       cosmetics=excluded.cosmetics, updated_at=excluded.updated_at`
  ).bind(
    row.user_id, row.guild_id, row.season, row.rank_index, row.stars,
    row.losses_at_zero, row.floor_index, row.peak_index, row.wins, row.losses,
    JSON.stringify(row.cosmetics || []), Date.now(),
  ).run();
}

// ── Rank math ───────────────────────────────────────────────────────

// Mutates `row` for a result. Returns { promotedTier } when a win
// promotes into a NEW tier (for the Discord celebration echo).
function applyResult(row, won) {
  let promotedTier = null;
  if (won) {
    row.wins += 1;
    row.losses_at_zero = 0;
    if (row.rank_index < LEGEND_INDEX) {
      const beforeTier = tierKey(row.rank_index);
      row.stars += 1;
      if (row.stars >= STARS_PER_DIVISION) {
        row.stars = 0;
        row.rank_index += 1;
        if (row.rank_index < LEGEND_INDEX && row.rank_index % DIVISIONS === 0) {
          row.floor_index = row.rank_index; // entered a new tier → new floor
        }
        if (row.rank_index >= LEGEND_INDEX) row.floor_index = LEGEND_INDEX;
        const afterTier = tierKey(row.rank_index);
        if (afterTier !== beforeTier) promotedTier = afterTier;
      }
    }
    if (row.rank_index > row.peak_index) row.peak_index = row.rank_index;
  } else {
    row.losses += 1;
    if (row.rank_index >= LEGEND_INDEX) {
      // Legend is apex, no in-season demotion.
    } else if (row.stars > 0) {
      row.stars -= 1;
    } else if (row.rank_index > row.floor_index) {
      row.losses_at_zero += 1;
      if (row.losses_at_zero >= LOSSES_TO_DEMOTE) {
        row.losses_at_zero = 0;
        row.rank_index -= 1;
        row.stars = 0;
      }
    }
    // else: at the protected floor with 0 stars → nothing happens.
  }
  return { promotedTier };
}

// ── Season settlement ───────────────────────────────────────────────

// Grant a row's end-of-season reward (by peak tier) and return a
// summary. Skips players who didn't play that season. Best-effort
// grants, a failure is logged into the summary, never thrown.
async function grantSeasonReward(env, row) {
  if ((row.wins + row.losses) === 0) return { granted: false, reason: 'inactive' };
  const tier = tierKey(row.peak_index);
  const reward = SEASON_REWARDS[tier];
  if (!reward) return { granted: false, reason: 'no-reward' };
  const guildId = row.guild_id || env.AQUILO_VAULT_GUILD_ID;
  const out = { granted: true, tier, bolts: reward.bolts || 0, packs: [], cosmetic: reward.cosmetic || null };
  if (reward.bolts && guildId) {
    try { await applyVaultDelta(env, guildId, row.user_id, reward.bolts, `ranked:season-${row.season}:${tier}`); }
    catch (e) { out.boltsError = e?.message || String(e); }
  }
  for (const p of (reward.packs || [])) {
    for (let i = 0; i < (p.n || 1); i++) {
      try {
        const r = await creditPack(env, guildId, row.user_id, p.type, `ranked:season-${row.season}`);
        if (r.ok && r.pack) out.packs.push({ packId: r.pack.id, packType: r.pack.packType });
      } catch (e) { out.packError = e?.message || String(e); }
    }
  }
  if (reward.cosmetic && !row.cosmetics.includes(reward.cosmetic)) {
    row.cosmetics.push(reward.cosmetic);
    out.cosmetic = reward.cosmetic;
  }
  return out;
}

// Soft-reset a row into `season` (rewards already granted by caller).
function softReset(row, season) {
  const newIndex = Math.max(0, row.peak_index - RESET_DROP_DIVISIONS);
  row.season = season;
  row.rank_index = newIndex;
  row.stars = 0;
  row.losses_at_zero = 0;
  row.floor_index = tierFloorIndex(newIndex);
  row.peak_index = newIndex;
  row.wins = 0;
  row.losses = 0;
}

// Ensure `row` belongs to the current season. If it's stale, settle the
// previous season (grant + soft-reset). Returns the (possibly reset)
// row. Idempotent: once row.season === current, a re-call is a no-op.
async function ensureCurrentSeason(env, row, nowMs) {
  const cur = seasonKey(nowMs);
  if (row.season === cur) return row;
  await grantSeasonReward(env, row);
  softReset(row, cur);
  return row;
}

// ── Public: match result hook ───────────────────────────────────────

// Apply a finished PvP match to both human players' ladders. Called
// from cards-match.finaliseIfEnded. NPC matches must NOT call this.
// `match` is the raw match object (has guildId, players, status).
export async function applyRankedResult(env, match) {
  if (!match || match.npc || match.private) return;
  const aWon = match.status === 'A-won';
  const bWon = match.status === 'B-won';
  if (!aWon && !bWon) return; // draws don't move the ladder
  const now = Date.now();
  const cur = seasonKey(now);

  for (const side of ['A', 'B']) {
    const userId = match.players?.[side];
    if (!userId || String(userId).startsWith('npc:')) continue;
    const won = (side === 'A' && aWon) || (side === 'B' && bWon);
    try {
      let row = await readRow(env, userId);
      if (!row) row = blankRow(userId, match.guildId, cur);
      row.guild_id = match.guildId || row.guild_id;
      await ensureCurrentSeason(env, row, now);
      const { promotedTier } = applyResult(row, won);
      await writeRow(env, row);
      if (promotedTier && ['silver', 'gold', 'diamond', 'legend'].includes(promotedTier)) {
        echoPromotion(env, userId, promotedTier, rankName(row.rank_index)).catch(() => {});
      }
    } catch (e) {
      console.warn('[ranked] applyResult', userId, e?.message || e);
    }
  }
}

async function echoPromotion(env, userId, tier, name) {
  const channelId = env.BOLTBOUND_CELEBRATION_CHANNEL_ID || env.CHECKIN_CHANNEL_ID || env.LEADERBOARD_CHANNEL_ID;
  if (!channelId || !env.DISCORD_BOT_TOKEN) return;
  const { postChannelMessage } = await import('./aquilo/util.js');
  await postChannelMessage(env, channelId, {
    embeds: [{
      title: '🏅 Ranked promotion',
      description: `<@${userId}> climbed into **${name}**. The ladder remembers.`,
      color: 0x3A86FF,
    }],
  });
}

// ── Public: reads ───────────────────────────────────────────────────

function shapeRank(row, nowMs) {
  return {
    season: row.season,
    rankIndex: row.rank_index,
    rankName: rankName(row.rank_index),
    tier: tierKey(row.rank_index),
    stars: row.stars,
    starsPerDivision: STARS_PER_DIVISION,
    floorIndex: row.floor_index,
    peakIndex: row.peak_index,
    peakName: rankName(row.peak_index),
    lossesAtZero: row.losses_at_zero,
    wins: row.wins,
    losses: row.losses,
    isLegend: row.rank_index >= LEGEND_INDEX,
    seasonEndsUtc: seasonEndsUtc(nowMs),
  };
}

export async function getRankedMe(env, userId) {
  const now = Date.now();
  let row = await readRow(env, userId);
  if (!row) {
    // Unranked, show a placeholder at Bronze 5 without writing a row
    // (so the leaderboard isn't polluted by people who never queued).
    return { ok: true, ranked: false, rank: shapeRank(blankRow(userId, null, seasonKey(now)), now) };
  }
  // Reflect a pending season rollover in the read (don't persist here;
  // the next match or the cron settles + writes).
  if (row.season !== seasonKey(now)) {
    const preview = { ...row, cosmetics: [...row.cosmetics] };
    softReset(preview, seasonKey(now));
    return { ok: true, ranked: true, pendingReset: true, rank: shapeRank(preview, now), cosmetics: row.cosmetics };
  }
  return { ok: true, ranked: true, rank: shapeRank(row, now), cosmetics: row.cosmetics };
}

export async function getRankedLeaderboard(env, limit = 100) {
  const season = seasonKey();
  const lim = Math.max(1, Math.min(100, Number(limit) || 100));
  const { results } = await db(env).prepare(
    `SELECT user_id, rank_index, stars, peak_index, wins, losses
       FROM ranked_player
      WHERE season = ?
      ORDER BY rank_index DESC, stars DESC, wins DESC
      LIMIT ?`
  ).bind(season, lim).all();
  return {
    ok: true,
    season,
    seasonEndsUtc: seasonEndsUtc(),
    leaderboard: (results || []).map((r, i) => ({
      position: i + 1,
      userId: r.user_id,
      rankIndex: Number(r.rank_index) || 0,
      rankName: rankName(Number(r.rank_index) || 0),
      stars: Number(r.stars) || 0,
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
    })),
  };
}

// ── Public: monthly cron ────────────────────────────────────────────
//
// Piggybacks on the daily 0 1 * * * cron (CF 4-cron ceiling). Self-gates
// to the 1st of the month and a per-season KV marker, then settles every
// player still on the previous season (grant + soft-reset). Players who
// log a match before the cron get settled lazily; this catches the rest.
export async function rankedSeasonCron(env, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const d = new Date(now);
  if (d.getUTCDate() !== 1) return { ok: true, skipped: 'not-first-of-month' };
  const cur = seasonKey(now);
  const marker = `ranked:closed:${cur}`;
  try {
    if (await env.LOADOUT_BOLTS.get(marker)) return { ok: true, skipped: 'already-closed' };
  } catch { /* proceed */ }

  let settled = 0, cursor = null, scanned = 0;
  try {
    // Settle in pages, D1 can hold many rows; cap iterations defensively.
    for (let i = 0; i < 50; i++) {
      const stmt = cursor
        ? db(env).prepare('SELECT * FROM ranked_player WHERE season != ? AND user_id > ? ORDER BY user_id LIMIT 200').bind(cur, cursor)
        : db(env).prepare('SELECT * FROM ranked_player WHERE season != ? ORDER BY user_id LIMIT 200').bind(cur);
      const { results } = await stmt.all();
      if (!results || !results.length) break;
      for (const raw of results) {
        const row = parseRow(raw);
        scanned++;
        await grantSeasonReward(env, row);
        softReset(row, cur);
        await writeRow(env, row);
        settled++;
        cursor = row.user_id;
      }
      if (results.length < 200) break;
    }
    // Log the season boundary.
    await db(env).prepare(
      `INSERT OR IGNORE INTO ranked_season (season_id, started_at, closed) VALUES (?, ?, 0)`
    ).bind(cur, now).run();
    try { await env.LOADOUT_BOLTS.put(marker, String(now), { expirationTtl: 60 * 60 * 24 * 40 }); } catch { /* best-effort */ }
  } catch (e) {
    return { ok: false, error: e?.message || String(e), settled };
  }
  return { ok: true, season: cur, settled, scanned };
}

export const __internals = { applyResult, softReset, rankName, tierKey, seasonKey, SEASON_REWARDS, LEGEND_INDEX };
