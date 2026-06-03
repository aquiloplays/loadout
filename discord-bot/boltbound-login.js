// Boltbound — grindy daily login rewards.
//
// "Login" = opening the Boltbound hub on the site (/play/boltbound).
// Visiting aquilo.gg alone does NOT count — the site fires the claim
// only from the hub mount.
//
// Design intent (Clay, 2026-06): GRINDY. We do not give cards away
// daily. The daily grant is a small Bolts + Aether trickle; PACKS only
// drop at streak milestones. Streaks reset on ANY missed UTC day — no
// grace period. So the loop is "log in every single day or lose it".
//
//   daily            small Bolts (50-200, scales with streak) + Aether (5-10)
//   every 7th day    +500 Bolts + 50 dust
//   day 30           +1 Bolt Pack
//   day 90           +2 Voltaic Packs + a legendary crafting token (1600 dust)
//   day 365          +5 Voltaic Packs + a golden card-back cosmetic
//
// Storage (per-user, account-wide like trophies / fragments / dust):
//   cards:login:<userId> -> {
//     currentStreak,        // consecutive UTC days, resets on a miss
//     lifetimeDays,         // total days ever claimed (never resets)
//     lastClaimDate,        // "YYYY-MM-DD" UTC of the last claim
//     peakStreak,           // best run ever (for the hub badge)
//     cosmetics,            // string[] unlocked cosmetics (e.g. golden-cardback)
//   }

import { applyVaultDelta } from './wallet.js';
import { grantAether } from './aether.js';
import { addDust } from './boltbound-dust.js';
import { creditPack } from './cards-packs.js';

const LOGIN_KEY = (userId) => `cards:login:${userId}`;

// ── Date helpers (UTC; day rollover = 00:00 UTC) ────────────────────

function utcKey(nowMs) {
  const d = new Date(nowMs == null ? Date.now() : nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Whole UTC days between two YYYY-MM-DD keys (b - a). Returns null if
// either is unparseable.
function daysBetween(a, b) {
  if (!a || !b) return null;
  const pa = Date.parse(a + 'T00:00:00Z');
  const pb = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(pa) || Number.isNaN(pb)) return null;
  return Math.round((pb - pa) / 86400000);
}

// ── Reward tables ───────────────────────────────────────────────────

// Daily Bolts: 50 at streak 1, +10 per day, capped at 200 (streak 16+).
function dailyBolts(streak) {
  return Math.min(200, 50 + Math.max(0, streak - 1) * 10);
}
// Daily Aether: 5, +1 per 10 days of streak, capped at 10.
function dailyAether(streak) {
  return Math.min(10, 5 + Math.floor(Math.max(0, streak) / 10));
}

// Streak-day milestones. Keyed by the EXACT currentStreak value reached
// that day. `every7` (weekly) is handled separately so day 14/21/28 etc
// all pay the weekly haul without needing 52 explicit rows.
const STREAK_MILESTONES = {
  30:  { kind: 'monthly',   label: 'Monthly cache',     bolts: 0,   packs: [{ type: 'bolt', n: 1 }] },
  90:  { kind: 'quarterly', label: 'Quarterly vault',   bolts: 0,   packs: [{ type: 'voltaic', n: 2 }], dust: 1600, dustLabel: 'Legendary crafting token' },
  365: { kind: 'yearly',    label: 'Anniversary vault', bolts: 0,   packs: [{ type: 'voltaic', n: 5 }], cosmetic: 'golden-cardback' },
};
const WEEKLY = { bolts: 500, dust: 50 };

// Public preview of the NEXT milestone a player is climbing toward, so
// the hub can show a "next reward in N days" countdown.
function nextMilestone(streak) {
  // Weekly first if it's the nearest.
  const toWeekly = 7 - (streak % 7 || 7);
  const weeklyAt = streak + (toWeekly === 0 ? 7 : toWeekly);
  const bigDays = [30, 90, 365].filter(d => d > streak);
  const nextBig = bigDays.length ? bigDays[0] : null;
  // Whichever lands first.
  if (nextBig != null && nextBig <= weeklyAt) {
    const m = STREAK_MILESTONES[nextBig];
    return { at: nextBig, in: nextBig - streak, label: m.label, kind: m.kind };
  }
  return { at: weeklyAt, in: weeklyAt - streak, label: 'Weekly haul', kind: 'weekly' };
}

// ── State ────────────────────────────────────────────────────────────

function blank() {
  return { currentStreak: 0, lifetimeDays: 0, lastClaimDate: null, peakStreak: 0, cosmetics: [] };
}

async function readState(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(LOGIN_KEY(userId), { type: 'json' });
  if (!raw) return blank();
  return {
    currentStreak: Number(raw.currentStreak) || 0,
    lifetimeDays:  Number(raw.lifetimeDays) || 0,
    lastClaimDate: raw.lastClaimDate || null,
    peakStreak:    Number(raw.peakStreak) || 0,
    cosmetics:     Array.isArray(raw.cosmetics) ? raw.cosmetics : [],
  };
}

async function writeState(env, userId, st) {
  await env.LOADOUT_BOLTS.put(LOGIN_KEY(userId), JSON.stringify(st));
}

// ── Public: status (read-only) ──────────────────────────────────────

// Returns the current streak + whether today is claimable + a preview
// of the next milestone. Does NOT mutate — the hub calls this on mount,
// then POSTs claim only if claimableToday.
export async function getLoginStatus(env, userId, nowMs) {
  const st = await readState(env, userId);
  const today = utcKey(nowMs);
  const claimedToday = st.lastClaimDate === today;
  // If they missed a day, the displayed streak is "about to reset" — we
  // show the live (pre-reset) value but flag it so the UI can warn.
  const gap = daysBetween(st.lastClaimDate, today);
  const willReset = gap != null && gap > 1;
  // Streak the NEXT claim will land on (for the reward preview).
  const projected = claimedToday ? st.currentStreak
    : (gap === 1 ? st.currentStreak + 1 : 1);
  return {
    ok: true,
    currentStreak: st.currentStreak,
    lifetimeDays: st.lifetimeDays,
    peakStreak: st.peakStreak,
    claimableToday: !claimedToday,
    willResetOnClaim: !claimedToday && willReset,
    cosmetics: st.cosmetics,
    // What the next claim pays out, so the banner can tease it.
    nextClaim: {
      streak: projected,
      bolts: dailyBolts(projected),
      aether: dailyAether(projected),
      weekly: projected % 7 === 0,
      milestone: STREAK_MILESTONES[projected]
        ? { label: STREAK_MILESTONES[projected].label, kind: STREAK_MILESTONES[projected].kind }
        : null,
    },
    nextMilestone: nextMilestone(claimedToday ? st.currentStreak : projected),
  };
}

// ── Public: claim (write) ───────────────────────────────────────────

// Increment the streak (resetting if a day was missed), grant the
// daily reward + any milestone reward, return a detailed receipt. Once
// per UTC day — a second call the same day is a no-op { ok:false,
// alreadyClaimed:true }.
export async function claimDailyLogin(env, guildId, userId, nowMs) {
  const st = await readState(env, userId);
  const today = utcKey(nowMs);
  if (st.lastClaimDate === today) {
    return { ok: false, alreadyClaimed: true, status: await getLoginStatus(env, userId, nowMs) };
  }

  const gap = daysBetween(st.lastClaimDate, today);
  // gap === 1 → consecutive day, extend. Otherwise (first ever, or a
  // missed day) the streak resets to 1. No grace period by design.
  const reset = !(gap === 1);
  const streak = reset ? 1 : st.currentStreak + 1;

  st.currentStreak = streak;
  st.lifetimeDays += 1;
  st.lastClaimDate = today;
  if (streak > st.peakStreak) st.peakStreak = streak;

  // Persist the streak bookkeeping BEFORE granting currency, so a grant
  // failure can't be replayed for a second day's reward (the date guard
  // above already blocks same-day re-claims once this write lands).
  // Cosmetic from a yearly milestone is added below before the write.
  const reward = {
    bolts: dailyBolts(streak),
    aether: dailyAether(streak),
    dust: 0,
    packs: [],
    cosmetic: null,
    weekly: false,
    milestone: null,
  };

  // Weekly haul (every 7th day).
  if (streak % 7 === 0) {
    reward.weekly = true;
    reward.bolts += WEEKLY.bolts;
    reward.dust += WEEKLY.dust;
  }

  // Big streak milestone (30 / 90 / 365).
  const ms = STREAK_MILESTONES[streak];
  if (ms) {
    reward.milestone = { kind: ms.kind, label: ms.label };
    if (ms.bolts) reward.bolts += ms.bolts;
    if (ms.dust) reward.dust += ms.dust;
    if (ms.dustLabel) reward.milestone.dustLabel = ms.dustLabel;
    if (Array.isArray(ms.packs)) reward.packs.push(...ms.packs);
    if (ms.cosmetic && !st.cosmetics.includes(ms.cosmetic)) {
      st.cosmetics.push(ms.cosmetic);
      reward.cosmetic = ms.cosmetic;
    }
  }

  await writeState(env, userId, st);

  // ── Grants (best-effort; streak already banked) ──
  if (reward.bolts > 0) {
    try { await applyVaultDelta(env, guildId, userId, reward.bolts, `boltbound:login-day-${streak}`); }
    catch (e) { reward.boltsError = e?.message || String(e); }
  }
  if (reward.aether > 0) {
    try { await grantAether(env, guildId, userId, reward.aether, `boltbound:login-day-${streak}`); }
    catch (e) { reward.aetherError = e?.message || String(e); }
  }
  if (reward.dust > 0) {
    try { reward.dustBalance = await addDust(env, userId, reward.dust, `login-day-${streak}`); }
    catch (e) { reward.dustError = e?.message || String(e); }
  }
  const grantedPacks = [];
  for (const p of reward.packs) {
    for (let i = 0; i < (p.n || 1); i++) {
      try {
        const r = await creditPack(env, guildId, userId, p.type, `login-day-${streak}`);
        if (r.ok && r.pack) grantedPacks.push({ packId: r.pack.id, packType: r.pack.packType });
      } catch (e) { reward.packError = e?.message || String(e); }
    }
  }
  reward.grantedPacks = grantedPacks;

  // ── Discord celebration echo on the big milestones ──
  if (ms) {
    echoMilestone(env, userId, ms, streak).catch(() => { /* best-effort */ });
  }

  return {
    ok: true,
    reward,
    status: await getLoginStatus(env, userId, nowMs),
  };
}

// Fire a celebration message to the configured channel. Best-effort and
// silent on any failure (no bot token, no channel id, send error).
async function echoMilestone(env, userId, ms, streak) {
  const channelId = env.BOLTBOUND_CELEBRATION_CHANNEL_ID
    || env.CHECKIN_CHANNEL_ID
    || env.LEADERBOARD_CHANNEL_ID;
  if (!channelId || !env.DISCORD_BOT_TOKEN) return;
  const { postChannelMessage } = await import('./aquilo/util.js');
  const blurbs = {
    monthly:   `kept the lights on for **30 straight days**. The grind respects the grind.`,
    quarterly: `hit a **90-day** Boltbound streak. Ninety days. Touch grass — after you open these packs.`,
    yearly:    `logged in **365 days in a row**. A full year. We are concerned and impressed in equal measure.`,
  };
  const blurb = blurbs[ms.kind] || `reached a ${streak}-day login streak.`;
  await postChannelMessage(env, channelId, {
    embeds: [{
      title: '⚡ Boltbound streak milestone',
      description: `<@${userId}> ${blurb}`,
      color: 0x3A86FF,
    }],
  });
}

// Exported for tests.
export const __internals = { utcKey, daysBetween, dailyBolts, dailyAether, nextMilestone, STREAK_MILESTONES, WEEKLY };
