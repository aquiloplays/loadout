// Boltbound Seasonal Spire, core module.
//
// Owns the run lifecycle (start → advance/lose-life → complete/fail/
// abandon), reward grants, and leaderboard queries. The /web/play/
// spire/* endpoints in web.js are thin wrappers around these helpers.
//
// State machine:
//   active → completed   (boss-clear)
//   active → failed      (lives exhausted)
//   active → abandoned   (user /abandon)
//
// Reward gates use the spire_clears table's per-milestone flags
// (floor5_first_claimed, floor9_first_claimed, boss_first_claimed)
// so subsequent runs in the same season hit /result on floor 5/9/10
// without re-firing pack grants. Subsequent boss-clears just pay
// bolts.

import { SPIRE_THEMES, themeForMonth, monthBoundsUtc } from './spire-seasons.js';
import { generateSpireNpcDeck, tierForFloor } from './spire-deck.js';
import { SPIRE_EXCLUSIVE_BY_THEME } from './spire-cards.js';

const TOTAL_FLOORS  = 10;
const STARTING_LIVES = 3;
const RESUB_BOLTS    = 1500;   // subsequent boss-clear (paced via paceBolts at grant time)

// ── D1 helpers ─────────────────────────────────────────────────────

async function db(env) {
  if (!env.DB) throw new Error('spire: no D1 binding (env.DB missing)');
  return env.DB;
}

// Get (or lazily create) the active season row for the current UTC
// month. The cron normally creates this on the 1st; this function is
// the safety net for runs that fire before the cron has ticked.
export async function currentSeason(env, nowMs) {
  const D = await db(env);
  const now = new Date(nowMs || Date.now());
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const theme = themeForMonth(year, month);

  const { startsAt, endsAt } = monthBoundsUtc(year, month);
  // Fast path: active row already exists.
  const existing = await D.prepare(
    'SELECT * FROM spire_seasons WHERE theme_id = ? AND starts_at = ? LIMIT 1'
  ).bind(theme.themeId, startsAt).first();
  if (existing) return existing;

  // Lazy create. Mark this as active + clear any stale is_active rows.
  await D.prepare(
    'UPDATE spire_seasons SET is_active = 0 WHERE is_active = 1'
  ).run().catch(() => {});
  const insert = await D.prepare(
    `INSERT INTO spire_seasons
      (theme_id, name, theme_data, starts_at, ends_at, seasonal_exclusive_card_id, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  ).bind(
    theme.themeId, theme.name, JSON.stringify(theme),
    startsAt, endsAt, theme.seasonalExclusiveCard || null
  ).run();
  return {
    id: insert.meta?.last_row_id || null,
    theme_id: theme.themeId,
    name:     theme.name,
    theme_data: JSON.stringify(theme),
    starts_at: startsAt,
    ends_at:   endsAt,
    seasonal_exclusive_card_id: theme.seasonalExclusiveCard || null,
    is_active: 1,
  };
}

export async function getActiveRun(env, userId, seasonId) {
  const D = await db(env);
  return await D.prepare(
    `SELECT * FROM spire_runs
     WHERE user_id = ? AND season_id = ? AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`
  ).bind(userId, seasonId).first();
}

export async function getClearRecord(env, userId, seasonId) {
  const D = await db(env);
  return await D.prepare(
    'SELECT * FROM spire_clears WHERE user_id = ? AND season_id = ? LIMIT 1'
  ).bind(userId, seasonId).first();
}

// ── Run lifecycle ─────────────────────────────────────────────────

// Snapshots the user's currently-selected deck into the run record so
// mid-run deck edits don't change the spire's deck. Falls back to a
// starter if the user has no active deck.
async function snapshotDeck(env, guildId, userId) {
  // cards-state isn't imported at the top because we don't want every
  // spire route to pull in the entire boltbound module graph until
  // they actually need it. Lazy-import.
  const { getActiveDeckId } = await import('./cards-state.js');
  const { loadDeckForMatch } = await import('./cards-match.js');
  try {
    const deckId = await getActiveDeckId(env, guildId, userId);
    if (deckId) {
      const deck = await loadDeckForMatch(env, guildId, userId, deckId);
      if (deck) return { championClass: deck.championClass, cards: deck.cards };
    }
  } catch { /* fall through to starter */ }
  // No deck, generate one from the starter builder.
  try {
    const { buildStarterDeck } = await import('./cards-decks.js');
    const collection = { cards: {} };
    const starter = buildStarterDeck(collection, 'warrior');
    return { championClass: 'warrior', cards: starter.cards };
  } catch { return { championClass: 'warrior', cards: [] }; }
}

export async function startRun(env, guildId, userId) {
  const D = await db(env);
  const season = await currentSeason(env);
  if (!season) return { ok: false, error: 'no-active-season' };

  // Reject if there's already an active run this season.
  const active = await getActiveRun(env, userId, season.id);
  if (active) return { ok: false, error: 'already-in-run', runId: active.id };

  const deck = await snapshotDeck(env, guildId, userId);
  const r = await D.prepare(
    `INSERT INTO spire_runs
      (user_id, guild_id, season_id, current_floor, lives_remaining,
       status, deck_snapshot, floor_clears, started_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 'active', ?, '[]', datetime('now'), datetime('now'))`
  ).bind(
    userId, guildId, season.id,
    STARTING_LIVES, JSON.stringify(deck)
  ).run();
  const runId = r.meta?.last_row_id;
  return {
    ok: true,
    runId,
    seasonId: season.id,
    currentFloor: 1,
    livesRemaining: STARTING_LIVES,
  };
}

// Player /result submission. won=true advances the floor (or completes
// the run on floor 10); won=false drops a life.
export async function recordResult(env, guildId, userId, opts = {}) {
  const D = await db(env);
  const season = await currentSeason(env);
  const run = await getActiveRun(env, userId, season.id);
  if (!run) return { ok: false, error: 'no-active-run' };
  const floor = parseInt(opts.floor, 10);
  if (!Number.isFinite(floor) || floor !== run.current_floor) {
    return { ok: false, error: 'floor-mismatch', expected: run.current_floor };
  }
  const won = !!opts.won;
  // Append the floor outcome to the clears timeline.
  let timeline = [];
  try { timeline = JSON.parse(run.floor_clears || '[]'); } catch { timeline = []; }
  timeline.push({ floor, wonAt: new Date().toISOString(), won, lifeLost: !won });
  const timelineJson = JSON.stringify(timeline);

  if (won) {
    if (floor >= TOTAL_FLOORS) {
      // Boss-clear → run completes. Reward path below.
      await D.prepare(
        `UPDATE spire_runs
           SET status = 'completed', completed_at = datetime('now'),
               current_floor = ?, floor_clears = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).bind(floor, timelineJson, run.id).run();
      const reward = await grantClearRewards(env, guildId, userId, season, run, floor);
      return {
        ok: true,
        outcome: 'boss-clear',
        runStatus: 'completed',
        currentFloor: floor,
        livesRemaining: run.lives_remaining,
        reward,
      };
    }
    // Mid-floor win → advance.
    const nextFloor = floor + 1;
    await D.prepare(
      `UPDATE spire_runs
         SET current_floor = ?, floor_clears = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(nextFloor, timelineJson, run.id).run();
    // Milestone-floor reward gates.
    let reward = null;
    if (floor === 5 || floor === 9) {
      reward = await grantClearRewards(env, guildId, userId, season, run, floor);
    }
    return {
      ok: true,
      outcome: 'advance',
      runStatus: 'active',
      currentFloor: nextFloor,
      livesRemaining: run.lives_remaining,
      reward,
    };
  }

  // Loss → drop a life. If lives hit 0, the run fails.
  const remaining = Math.max(0, run.lives_remaining - 1);
  if (remaining === 0) {
    await D.prepare(
      `UPDATE spire_runs
         SET status = 'failed', completed_at = datetime('now'),
             lives_remaining = 0, floor_clears = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(timelineJson, run.id).run();
    return {
      ok: true,
      outcome: 'run-failed',
      runStatus: 'failed',
      currentFloor: floor,
      livesRemaining: 0,
    };
  }
  // Lives left, retry the same floor.
  await D.prepare(
    `UPDATE spire_runs
       SET lives_remaining = ?, floor_clears = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(remaining, timelineJson, run.id).run();
  return {
    ok: true,
    outcome: 'life-lost',
    runStatus: 'active',
    currentFloor: floor,
    livesRemaining: remaining,
  };
}

export async function abandonRun(env, guildId, userId) {
  const D = await db(env);
  const season = await currentSeason(env);
  const run = await getActiveRun(env, userId, season.id);
  if (!run) return { ok: false, error: 'no-active-run' };
  await D.prepare(
    `UPDATE spire_runs
       SET status = 'abandoned', completed_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ?`
  ).bind(run.id).run();
  return { ok: true, runId: run.id };
}

// ── Reward grants ─────────────────────────────────────────────────
//
// Milestones:
//   floor 5  first-clear: Rare pack
//   floor 9  first-clear: Epic pack + Spire Badge cosmetic
//   floor 10 first-clear: Legendary pack + seasonal exclusive card + completion title
//   floor 10 subsequent : RESUB_BOLTS bolts (paced via paceBolts)

async function grantClearRewards(env, guildId, userId, season, run, floor) {
  const D = await db(env);
  const clear = await getClearRecord(env, userId, season.id);
  const isBoss = floor >= TOTAL_FLOORS;

  // First-clear gating, read the matching flag from spire_clears.
  const flagCol = floor === 5 ? 'floor5_first_claimed'
                : floor === 9 ? 'floor9_first_claimed'
                : isBoss      ? 'boss_first_claimed'
                : null;
  if (!flagCol) return { granted: [], note: 'no-milestone' };
  const isFirstTime = !clear || !clear[flagCol];

  if (!isFirstTime) {
    // Subsequent boss-clear → bolt payout; subsequent floor 5/9 is
    // intentionally rewardless (player already claimed once this
    // season). Bump attempts_count for the embed.
    if (isBoss) {
      const { earn } = await import('./wallet.js');
      const { paceBolts } = await import('./economy-pace.js');
      const amount = await paceBolts(env, RESUB_BOLTS, { source: 'spire.boss.resub' });
      await earn(env, guildId, userId, amount, 'spire.boss.resub');
      if (clear) {
        await D.prepare(
          `UPDATE spire_clears
             SET attempts_count = attempts_count + 1
           WHERE id = ?`
        ).bind(clear.id).run();
      }
      return { granted: [{ kind: 'bolts', amount }], note: 'subsequent-clear' };
    }
    return { granted: [], note: 'milestone-already-claimed' };
  }

  // First-time path, actually grant the milestone reward.
  const granted = [];
  const { creditPack } = await import('./cards-packs.js');
  if (floor === 5) {
    const pack = await creditPack(env, guildId, userId, 'rare', 'spire.floor5');
    if (pack?.ok) granted.push({ kind: 'pack', packType: 'rare', packId: pack.pack?.id });
  } else if (floor === 9) {
    const pack = await creditPack(env, guildId, userId, 'epic', 'spire.floor9');
    if (pack?.ok) granted.push({ kind: 'pack', packType: 'epic', packId: pack.pack?.id });
    granted.push({ kind: 'cosmetic', cosmeticId: 'spire-badge', note: 'cosmetics module wires this, placeholder' });
  } else if (isBoss) {
    const pack = await creditPack(env, guildId, userId, 'legendary', 'spire.boss');
    if (pack?.ok) granted.push({ kind: 'pack', packType: 'legendary', packId: pack.pack?.id });
    // Seasonal exclusive, append to the user's collection directly.
    const exclusiveId = SPIRE_EXCLUSIVE_BY_THEME[season.theme_id];
    if (exclusiveId) {
      try {
        const { addCardToCollection } = await import('./cards-state.js');
        await addCardToCollection(env, guildId, userId, exclusiveId, 1);
        granted.push({ kind: 'card', cardId: exclusiveId });
      } catch (e) {
        // Non-fatal, pack still landed, exclusive will be retried via
        // /spire/run/me reconcile path.
      }
    }
    granted.push({ kind: 'title', titleId: `spire.${season.theme_id}.clearer` });
  }

  // Persist the milestone flag in spire_clears.
  if (clear) {
    await D.prepare(
      `UPDATE spire_clears
         SET ${flagCol} = 1,
             completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END,
             run_id = CASE WHEN ? THEN ? ELSE run_id END,
             clear_time_seconds = CASE WHEN ?
               THEN CAST(strftime('%s', 'now') - strftime('%s', started_at_for_first_time(?)) AS INTEGER)
               ELSE clear_time_seconds END
       WHERE id = ?`
    ).bind(isBoss, isBoss, run.id, isBoss, userId, clear.id).run().catch(async () => {
      // Fallback: SQLite doesn't have the helper UDF; do a simple update.
      await D.prepare(
        `UPDATE spire_clears SET ${flagCol} = 1, completed_at = datetime('now'), run_id = ? WHERE id = ?`
      ).bind(run.id, clear.id).run();
    });
  } else {
    await D.prepare(
      `INSERT INTO spire_clears
        (user_id, season_id, guild_id, completed_at, attempts_count,
         run_id, ${flagCol})
       VALUES (?, ?, ?, datetime('now'), 1, ?, 1)`
    ).bind(userId, season.id, guildId, run.id).run();
  }

  // Fire-and-forget post into the #spire-clears feed (falls back to
  // twitch-rewards-feed / #rewards if unbound). Embed failure is
  // non-fatal, the player's grant already landed.
  postClearFeedEmbed(env, guildId, userId, season, floor, granted).catch(() => {});

  return { granted, note: 'first-clear' };
}

async function postClearFeedEmbed(env, guildId, userId, season, floor, granted) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const { getChannelBinding } = await import('./channel-bindings.js');
  let channelId = await getChannelBinding(env, guildId, 'spire-clears');
  if (!channelId) channelId = await getChannelBinding(env, guildId, 'twitch-rewards-feed');
  if (!channelId) return;

  const isBoss = floor >= TOTAL_FLOORS;
  const milestoneText = isBoss ? 'cleared the boss'
                      : floor === 9 ? 'reached floor 9'
                      : floor === 5 ? 'reached floor 5'
                      : `cleared floor ${floor}`;
  const themeName = season.name || season.theme_id;

  // Format the granted-rewards list, short, embed-friendly.
  const rewardLines = (granted || []).map(g => {
    if (g.kind === 'pack')     return `🎁 ${g.packType?.toUpperCase() || 'Pack'} pack`;
    if (g.kind === 'card')     return `🃏 \`${g.cardId}\` (seasonal exclusive)`;
    if (g.kind === 'cosmetic') return `🌟 Cosmetic: ${g.cosmeticId}`;
    if (g.kind === 'title')    return `🏆 Title: ${g.titleId}`;
    if (g.kind === 'bolts')    return `⚡ ${g.amount} bolts`;
    return null;
  }).filter(Boolean);

  const embed = {
    title: `🗼 Spire, ${themeName}`,
    description: `<@${userId}> **${milestoneText}** of the ${themeName} Spire.`,
    color: isBoss ? 0xfacc15 : (floor === 9 ? 0xa855f7 : 0x3b82f6),
    fields: rewardLines.length ? [{ name: 'Rewards', value: rewardLines.join('\n') }] : [],
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch { /* swallow */ }
}

// ── Leaderboard + read APIs ───────────────────────────────────────

export async function getSeasonView(env) {
  const season = await currentSeason(env);
  let theme;
  try { theme = JSON.parse(season.theme_data); }
  catch { theme = SPIRE_THEMES.find(t => t.themeId === season.theme_id) || null; }
  return {
    seasonId:        season.id,
    themeId:         season.theme_id,
    name:            season.name,
    startsAt:        season.starts_at,
    endsAt:          season.ends_at,
    seasonalExclusiveCardId: season.seasonal_exclusive_card_id,
    theme,
    rewardPreview: {
      floor5:  { kind: 'pack', packType: 'rare' },
      floor9:  { kind: 'pack', packType: 'epic', cosmetic: 'spire-badge' },
      boss:    {
        firstClear:  { kind: 'pack', packType: 'legendary',
                       exclusiveCardId: season.seasonal_exclusive_card_id,
                       title: `spire.${season.theme_id}.clearer` },
        subsequent: { kind: 'bolts', amount: RESUB_BOLTS, paced: true },
      },
    },
  };
}

export async function getRunView(env, userId) {
  const season = await currentSeason(env);
  const run = await getActiveRun(env, userId, season.id);
  if (!run) return { active: null };
  let timeline = [];
  try { timeline = JSON.parse(run.floor_clears || '[]'); } catch { timeline = []; }
  let deck = null;
  try { deck = JSON.parse(run.deck_snapshot); } catch { /* idle */ }
  return {
    active: {
      runId:          run.id,
      seasonId:       season.id,
      currentFloor:   run.current_floor,
      livesRemaining: run.lives_remaining,
      tierForCurrent: tierForFloor(run.current_floor),
      timeline,
      deckSnapshot:   deck,
      startedAt:      run.started_at,
    },
  };
}

export async function getLeaderboard(env, opts = {}) {
  const D = await db(env);
  const limit = clamp(parseInt(opts.limit, 10) || 20, 1, 100);
  const season = await currentSeason(env);
  const rows = await D.prepare(
    `SELECT user_id, completed_at, attempts_count, clear_time_seconds
       FROM spire_clears
      WHERE season_id = ? AND boss_first_claimed = 1
      ORDER BY (clear_time_seconds IS NULL), clear_time_seconds ASC, completed_at ASC
      LIMIT ?`
  ).bind(season.id, limit).all();
  const totalRow = await D.prepare(
    `SELECT COUNT(*) AS total FROM spire_clears WHERE season_id = ? AND boss_first_claimed = 1`
  ).bind(season.id).first();
  return {
    seasonId: season.id,
    themeId:  season.theme_id,
    totalClears: totalRow?.total || 0,
    top: rows?.results || [],
  };
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

// ── NPC fetch (used by /run/start once the player starts a fight) ─

export async function getNpcForFloor(env, seasonId, floor) {
  const D = await db(env);
  const row = await D.prepare(
    `SELECT * FROM spire_npcs
      WHERE season_id = ? AND floor_min <= ? AND floor_max >= ?
      ORDER BY RANDOM() LIMIT 1`
  ).bind(seasonId, floor, floor).first();
  return row || null;
}

// Build a runnable Boltbound match against the floor's NPC. Returns the
// match record + the deck used. Caller can persist the match via the
// existing cards-state model.
export async function buildSpireFloorMatch(env, userId, run) {
  const season = await currentSeason(env);
  const npc = await getNpcForFloor(env, season.id, run.current_floor);
  const seed = `spire:${run.id}:f${run.current_floor}`;
  const npcDeck = generateSpireNpcDeck(season.theme_id, npc, seed);
  let playerDeck = null;
  try { playerDeck = JSON.parse(run.deck_snapshot); } catch { /* idle */ }
  return {
    seasonId:   season.id,
    floor:      run.current_floor,
    tier:       tierForFloor(run.current_floor),
    npc: npc ? {
      key:        npc.npc_key,
      name:       npc.name,
      portrait:   npc.portrait,
      flavorText: npc.flavor_text,
      bossMechanic: npc.boss_mechanic ? safeJson(npc.boss_mechanic) : null,
    } : null,
    npcDeck,
    playerDeck,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export const SPIRE_INTERNAL = {
  TOTAL_FLOORS, STARTING_LIVES, RESUB_BOLTS,
  grantClearRewards,
};

// ── Monthly rotation cron ─────────────────────────────────────────
//
// Piggybacks on the :23 hourly tick. Once per UTC day, checks whether
// the active season's theme matches the current month's expected theme.
// If not, the rotation runs:
//   1. Archive the outgoing season's leaderboard into
//      spire_leaderboards_archive
//   2. Mark the outgoing row's is_active = 0
//   3. INSERT (or fetch) the new month's spire_seasons row + flag it
//      active. (lazyCreate via currentSeason() handles INSERT.)
//
// Idempotent, gated by KV marker `spire:rotate:last-month` (value =
// 'YYYY-MM'). Re-running the cron mid-month is a no-op.
export async function rotateSeasonIfNeeded(env, nowMs) {
  const now = new Date(nowMs || Date.now());
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const markerKey = 'spire:rotate:last-month';
  const lastRotated = await env.LOADOUT_BOLTS.get(markerKey).catch(() => null);
  if (lastRotated === monthKey) return { rotated: false, reason: 'already-rotated-this-month' };

  const D = await db(env);
  const expectedTheme = themeForMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);

  // What's the currently-active row?
  const active = await D.prepare(
    'SELECT * FROM spire_seasons WHERE is_active = 1 LIMIT 1'
  ).first();

  // If the active row's theme already matches, just stamp the marker
  // and exit, the season is fresh, nothing to rotate.
  if (active && active.theme_id === expectedTheme.themeId) {
    await env.LOADOUT_BOLTS.put(markerKey, monthKey);
    return { rotated: false, reason: 'theme-already-active' };
  }

  // Archive the outgoing season's leaderboard before clearing.
  if (active) {
    const top = await D.prepare(
      `SELECT user_id, clear_time_seconds, attempts_count, completed_at
         FROM spire_clears
        WHERE season_id = ? AND boss_first_claimed = 1
        ORDER BY (clear_time_seconds IS NULL), clear_time_seconds ASC
        LIMIT 20`
    ).bind(active.id).all().catch(() => ({ results: [] }));
    const totalRow = await D.prepare(
      `SELECT COUNT(*) AS total FROM spire_clears WHERE season_id = ? AND boss_first_claimed = 1`
    ).bind(active.id).first().catch(() => null);
    const fastest = (top?.results?.[0]?.clear_time_seconds) || null;
    await D.prepare(
      `INSERT INTO spire_leaderboards_archive
         (season_id, theme_id, total_clears, fastest_time_seconds, top_clears, archived_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      active.id, active.theme_id,
      totalRow?.total || 0, fastest,
      JSON.stringify(top?.results || [])
    ).run().catch(() => {});

    // Clear active flag on outgoing.
    await D.prepare('UPDATE spire_seasons SET is_active = 0 WHERE id = ?')
      .bind(active.id).run().catch(() => {});
  }

  // Ensure the new month's row exists + is active.
  const newSeason = await currentSeason(env, nowMs);
  await env.LOADOUT_BOLTS.put(markerKey, monthKey);

  return {
    rotated: true,
    fromTheme: active?.theme_id || null,
    toTheme:   newSeason.theme_id,
    toSeasonId: newSeason.id,
  };
}
