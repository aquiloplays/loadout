// Off-stream minigames. Provably-random where it matters: we use
// crypto.getRandomValues() so a streamer can't tilt outcomes (and so
// viewers can trust the bot is square). Each game returns
// { won: bool, payout: number (negative on loss), explanation: string }.
//
// House edge note: by default these are FAIR (payout matches odds). Bolts
// are play money - we'd rather they feel generous than rake. A streamer
// who wants a sink can configure via slash command flags later.

import { earn, spend } from './wallet.js';

function rng(maxExclusive) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Avoid modulo bias by rejecting the top of the uint32 range that doesn't
  // divide evenly. With small max values the rejection rate is negligible.
  const cap = Math.floor(0xFFFFFFFF / maxExclusive) * maxExclusive;
  let v = buf[0];
  while (v >= cap) {
    crypto.getRandomValues(buf);
    v = buf[0];
  }
  return v % maxExclusive;
}

export async function coinflip(env, guildId, userId, bet) {
  if (!Number.isFinite(bet) || bet <= 0)
    return { won: false, payout: 0, explanation: 'bet must be a positive number' };
  const r = await spend(env, guildId, userId, bet, 'coinflip:wager');
  if (!r.ok) return { won: false, payout: 0, explanation: r.reason };

  // Fair 50/50. Heads = win 2x bet (wager already deducted, so net +bet).
  const heads = rng(2) === 0;
  if (heads) {
    await earn(env, guildId, userId, bet * 2, 'coinflip:win');
    return { won: true, payout: bet, explanation: '🪙 Heads! You won ' + bet + ' bolts.' };
  }
  return { won: false, payout: -bet, explanation: '🪙 Tails. You lost ' + bet + '.' };
}

export async function dice(env, guildId, userId, bet, target) {
  if (!Number.isFinite(bet) || bet <= 0)
    return { won: false, payout: 0, explanation: 'bet must be a positive number' };
  if (!Number.isInteger(target) || target < 1 || target > 6)
    return { won: false, payout: 0, explanation: 'target must be 1-6' };

  const r = await spend(env, guildId, userId, bet, 'dice:wager');
  if (!r.ok) return { won: false, payout: 0, explanation: r.reason };

  // Fair 1/6. Hit your target → 5x payout (so the GROSS payout = 5*bet
  // minus the already-deducted bet = net +5bet ... wait no. We deducted
  // bet already. If we credit 6*bet on win, net is +5bet. That matches
  // "5x payout" parlance and is house-fair for a 1/6 chance.
  const roll = rng(6) + 1;
  if (roll === target) {
    await earn(env, guildId, userId, bet * 6, 'dice:win:' + roll);
    return { won: true, roll, payout: bet * 5, explanation: '🎲 Rolled ' + roll + '! You won ' + (bet * 5) + ' bolts.' };
  }
  return { won: false, roll, payout: -bet, explanation: '🎲 Rolled ' + roll + '. You needed ' + target + '. Better luck next time.' };
}

// /daily: 24h cooldown, streak multiplier (1d streak = 1x, 7d = 7x, capped at 10x).
const DAILY_BASE = 100;
const DAILY_STREAK_CAP = 10;
const DAILY_COOLDOWN_MS = 23 * 60 * 60 * 1000;   // 23h not 24, so claim time can drift

export async function daily(env, guildId, userId) {
  const { getWallet, putWallet } = await import('./wallet.js');
  const w = await getWallet(env, guildId, userId);
  const now = Date.now();
  if (w.lastDailyUtc && (now - w.lastDailyUtc) < DAILY_COOLDOWN_MS) {
    const wait = DAILY_COOLDOWN_MS - (now - w.lastDailyUtc);
    return {
      won: false, payout: 0,
      explanation: 'Already claimed. Try again in ' + fmtDuration(wait) + '.'
    };
  }

  // Streak: incremented if last claim was within 48h, otherwise reset to 1.
  const within48h = w.lastDailyUtc && (now - w.lastDailyUtc) < (48 * 60 * 60 * 1000);
  w.dailyStreak = within48h ? Math.min(DAILY_STREAK_CAP, (w.dailyStreak || 0) + 1) : 1;
  const payout = DAILY_BASE * w.dailyStreak;
  w.balance += payout;
  w.lifetimeEarned += payout;
  w.lastDailyUtc = now;
  w.lastEarnReason = 'daily:streak:' + w.dailyStreak;
  await putWallet(env, guildId, userId, w);
  return {
    won: true, payout,
    streak: w.dailyStreak,
    explanation: '🎁 +' + payout + ' bolts (day ' + w.dailyStreak + ' streak). Come back tomorrow.'
  };
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
