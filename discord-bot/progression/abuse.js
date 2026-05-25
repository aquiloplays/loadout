// Progression — anti-abuse tightening.
//
// PROGRESSION-SYSTEM-DESIGN.md §11. Sock-puppet first-week hold,
// chat-message dedup, tournament-eligibility (Steam-link required for
// top-3 bracket placement), and dashboard helpers.
//
// New-account hold:
//   - First L10 milestone XP is HELD for 7 days after the user's
//     pprofile.createdUtc. Stops drive-by sockpuppet farms.
//   - We don't block the XP grant — we just defer the L10 *meta-
//     achievement* unlock (Top of the Class) for 7 days. The
//     achievement engine's checkAchievements consults this gate via
//     `isFirstWeekHeld`.
//
// Chat-message dedup (5-min window):
//   - Stored at `pabuse:chat:<userId>` as a rolling array of recent
//     message hashes with timestamps. Bus consumer checks the hash
//     before granting `discord.message` XP.

import { getProfile } from './profile.js';

const FIRST_WEEK_MS = 7 * 86400_000;
const CHAT_DEDUP_MS = 5 * 60 * 1000;
const CHAT_DEDUP_CAP = 50;

// Is this user inside their 7-day first-week hold?
export async function isFirstWeekHeld(env, userId) {
  const p = await getProfile(env, userId);
  return (Date.now() - (p.createdUtc || 0)) < FIRST_WEEK_MS;
}

// Filter discord.message events through a 5-min hash dedup. Returns
// true if the message is fresh (grant XP), false if it's a recent
// duplicate (skip). The hash is djb2-style over the lowercased
// message body — cheap, no crypto.subtle round-trip.
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function chatMessageIsFresh(env, userId, messageBody) {
  const hash = djb2((messageBody || '').toLowerCase().trim().slice(0, 200));
  if (!hash) return false;
  const key = `pabuse:chat:${userId}`;
  const now = Date.now();
  const rec = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || { recent: [] };
  // Drop expired entries (older than 5 min).
  rec.recent = (rec.recent || []).filter(r => (now - r.t) < CHAT_DEDUP_MS);
  if (rec.recent.find(r => r.h === hash)) return false;
  rec.recent.push({ h: hash, t: now });
  if (rec.recent.length > CHAT_DEDUP_CAP) rec.recent = rec.recent.slice(-CHAT_DEDUP_CAP);
  // Short TTL so the record self-cleans for inactive users.
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec), { expirationTtl: 600 });
  return true;
}

// Tournament eligibility: bracket placements ≥ top-3 require a
// verified Steam link to defuse sockpuppet collusion. Verified means
// linked via OAuth/OpenID, not manual entry.
export async function isEligibleForTournamentPlacement(env, userId, place) {
  if (place > 3) return true;   // top-8 and below don't need verification
  const p = await getProfile(env, userId);
  const steam = p.linkedAccounts?.steam;
  if (!steam || !steam.id || steam.source === 'manual') return false;
  return true;
}

// ── Dashboard helpers (Clay-facing) ───────────────────────────────
//
// Read-only stats: top XP earners + top XP-rate (XP/day) + flagged
// users (high daily XP + brand-new account, suspicious chat dedup
// rate, etc.). The HTTP route serves these as JSON; Clay's dashboard
// UI is built separately (aquilo-site).

export async function dashboardSummary(env) {
  // Top 20 by XP.
  const xpRows = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'pxp:', cursor, limit: 1000 });
    for (const k of r.keys) {
      if (k.name === 'pxp:table') continue;
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!rec) continue;
      const userId = k.name.slice('pxp:'.length);
      xpRows.push({
        userId,
        xp: rec.xp || 0,
        level: rec.level || 1,
        dailyXp: rec.dailyXp?.total || 0,
      });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  xpRows.sort((a, b) => b.xp - a.xp);
  const topXp = xpRows.slice(0, 20);

  // Flagged: brand-new accounts (< 7d old) with high daily XP.
  const flagged = [];
  for (const row of xpRows) {
    if (row.dailyXp < 300) continue;
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${row.userId}`, { type: 'json' });
    if (!p) continue;
    const ageMs = Date.now() - (p.createdUtc || 0);
    if (ageMs < FIRST_WEEK_MS) {
      flagged.push({ ...row, ageDays: Math.floor(ageMs / 86400_000), reason: 'first-week-high-grant' });
    }
  }

  // Active tournaments + their participant counts.
  const tourny = [];
  for (const game of ['boltbound', 'board', 'clash', 'quick']) {
    const t = await env.LOADOUT_BOLTS.get(`tourn:active:${game}`, { type: 'json' });
    if (t) tourny.push({
      tournId: t.tournId, game, format: t.format, state: t.state,
      participants: t.participants?.length || 0,
      startUtc: t.startUtc, endUtc: t.endUtc,
    });
  }

  // Active season snapshot.
  const season = await env.LOADOUT_BOLTS.get('season:active', { type: 'json' });

  return {
    asOfUtc: Date.now(),
    topXp,
    flagged,
    tournamentsActive: tourny,
    season: season ? {
      seasonId: season.seasonId, theme: season.theme,
      startUtc: season.startUtc, endUtc: season.endUtc,
      daysLeft: Math.max(0, Math.ceil((season.endUtc - Date.now()) / 86400_000)),
    } : null,
  };
}
