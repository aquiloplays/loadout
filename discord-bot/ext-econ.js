// Shared economy helpers for the in-panel extension games (multi-tenant).
//
// `guildId` here is ALWAYS the per-channel namespace produced by nsFor() in
// ext.js — Clay's channel resolves to his existing Discord-guild id (so his
// live cross-product wallet is untouched), every other channel gets its own
// isolated `ch:<channelId>` namespace. Every game module receives that id
// pre-resolved and must never re-derive it, so wallets/leaderboards stay
// scoped to the channel the viewer is watching.

import { getWallet } from './wallet.js';

// Star-rank tiers by lifetime Bolts earned. Purely cosmetic (drives the
// rank badge in the casino card); does not affect payouts.
const TIERS = [
  { name: 'Bronze',   color: '#cd7f32', stars: 1, at: 0 },
  { name: 'Silver',   color: '#c0c0c0', stars: 2, at: 500 },
  { name: 'Gold',     color: '#ffd54a', stars: 3, at: 2500 },
  { name: 'Platinum', color: '#7ad7ff', stars: 4, at: 10000 },
  { name: 'Diamond',  color: '#b388ff', stars: 5, at: 50000 },
];

export function computeRank(lifetimeEarned) {
  const e = Number(lifetimeEarned) || 0;
  let cur = TIERS[0];
  let next = TIERS[1] || null;
  for (let i = 0; i < TIERS.length; i++) {
    if (e >= TIERS[i].at) { cur = TIERS[i]; next = TIERS[i + 1] || null; }
  }
  return { name: cur.name, color: cur.color, stars: cur.stars, nextAt: next ? next.at : null };
}

// The wallet payload every game card renders (balance + lifetime + streak +
// rank badge). Callers spread extra per-game fields on top as needed.
export async function walletView(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  return Object.assign({}, w, { rank: computeRank(w.lifetimeEarned) });
}
