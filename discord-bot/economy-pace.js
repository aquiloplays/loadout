// Central economy tuning — every grant + cooldown in the codebase
// reads from ECONOMY_PACE so a future retune is one edit.
//
// Direction (set by Clay 2026-05): slow everything down. Smaller
// per-action payouts, longer cooldowns, steeper level curve. Loops
// should still pay enough to feel worth doing daily — see
// docs/ECONOMY_PACE.md for the floor numbers + the rationale.
//
// Tuning helpers:
//
//   paceBolts(amount)     — scales a bolt payout by ECONOMY_PACE,
//                           floor at MIN_PAYOUT (1) so micro-rewards
//                           don't round to zero.
//   paceMilestone(amount) — same as paceBolts but used for one-time
//                           streak / milestone payouts where we want
//                           the v2 number to be a bit more
//                           ceremonial (keeps milestone moments
//                           feeling earned).
//   paceCooldown(ms)      — divides by ECONOMY_PACE — slower = longer
//                           cooldowns. paceCooldown(1000) at PACE=0.4
//                           returns 2500ms.
//   paceXp(level)         — XP curve coefficient lookup. We don't
//                           multiply existing XP grants because the
//                           curve itself was steepened (xpToReach).
//
// Funnel-boost grants (one-time per user — onboarding completion,
// referral first-milestone payout) are INTENTIONALLY left at v1
// numbers per Clay's instruction — see paceFunnel().

export const ECONOMY_PACE = 0.4;
// Reduce wallet floor risk: any positive grant pays at least 1.
const MIN_PAYOUT = 1;

export function paceBolts(amount) {
  const n = Number(amount) || 0;
  if (n <= 0) return 0;
  const scaled = Math.round(n * ECONOMY_PACE);
  return Math.max(MIN_PAYOUT, scaled);
}

// Slightly more generous than paceBolts — used for one-time streak
// milestones (7/30/100 day check-in) so the celebration moment
// doesn't feel anaemic. v2 keeps ~50% of v1 instead of 40%.
export function paceMilestone(amount) {
  const n = Number(amount) || 0;
  if (n <= 0) return 0;
  const scaled = Math.round(n * 0.5);
  return Math.max(MIN_PAYOUT, scaled);
}

// Cooldowns get LONGER as PACE shrinks. PACE=0.4 → 2.5× longer.
export function paceCooldown(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return 0;
  return Math.round(n / ECONOMY_PACE);
}

// Funnel-boost passthrough — kept at v1 because these are one-time
// per user and exist to bootstrap new viewers into the loop.
// Documented in ECONOMY_PACE.md.
export function paceFunnel(amount) {
  return Number(amount) || 0;
}

// Quick-games per-game absolute net-win cap. Wagers still play at
// real odds (so the 36× roulette number bet is still a real lottery)
// but the absolute take-home per game cannot exceed (bet + this cap).
// Stops a lucky string of 100-bolt-bet wins from minting 50k bolts
// in an evening.
export const QUICK_GAME_NET_WIN_CAP = 1000;

// Default quick-game cooldown — used by games-quick.js. paceCooldown
// applied to a 2s base.
export const QUICK_GAME_COOLDOWN_MS = paceCooldown(2000);   // → 5000 at PACE=0.4

// Pet care cooldown — feed/play/clean. paceCooldown on 30 min.
export const PET_CARE_COOLDOWN_MS = paceCooldown(30 * 60 * 1000);   // → 75 min

// Clash donation → XP ratio. v1 = 1 XP / 100 bolts; v2 = paced.
export const CLASH_DONATE_BOLTS_PER_XP = Math.round(100 / ECONOMY_PACE);   // → 250
