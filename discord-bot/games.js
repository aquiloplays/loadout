// Off-stream minigames. Provably-random where it matters: we use
// crypto.getRandomValues() so a streamer can't tilt outcomes (and so
// viewers can trust the bot is square). Each game returns
// { won: bool, payout: number (negative on loss), explanation: string }.
//
// House edge note: by default these are FAIR (payout matches odds). Bolts
// are play money - we'd rather they feel generous than rake. A streamer
// who wants a sink can configure via slash command flags later.
//
// 2026-05 — the cooldown helper lives in games-quick.js so the seven
// new quick games share one anti-spam window with coinflip + dice.
// Routes in web.js call cooldownCheck() BEFORE the spend(), and
// cooldownTouch() AFTER. games.js itself stays cooldown-free so the
// Discord slash + Twitch panel pathways keep their existing rate
// limiters (which are different shapes than the per-play 2.5s).

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

// /daily: one claim per America/New_York calendar day. Streak
// multiplier (1d streak = 1x, capped at 10x).
//
// The reset clock used to tick over at midnight UTC, which meant an
// Eastern-time viewer (basically the whole audience) had a hard
// deadline at 8 PM their local time on day two of a streak or it
// broke. Shifted to ET day boundaries 2026-05-20 so the reset is
// "midnight, your local-ish time" for most viewers. Same rule on
// Discord, the Twitch panel, and the website — single function,
// single source of truth.
const DAILY_BASE = 100;
const DAILY_STREAK_CAP = 10;
const DAILY_TZ = 'America/New_York';

// "YYYY-MM-DD" in DAILY_TZ for the given epoch. en-CA's locale order
// happens to be ISO-shaped (YYYY-MM-DD) so we can compare as strings.
function etDateString(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

// "YYYY-MM-DD" - 1 day. Pure string math; works across month/year
// boundaries without needing TZ-aware arithmetic. DST safe because
// we're operating on calendar dates only, not wall-clock times.
function prevEtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Build a UTC date at noon (well clear of any DST edges) and step
  // back exactly 24h — the resulting UTC date's Y/M/D is still the
  // previous calendar day in ANY tz that doesn't move backwards
  // by more than a day at a transition, which is every real TZ.
  const ms = Date.UTC(y, m - 1, d, 12) - 86400_000;
  const prev = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return prev.getUTCFullYear() + '-' + pad(prev.getUTCMonth() + 1) + '-' + pad(prev.getUTCDate());
}

// Time until the next ET midnight from `now` (ms). Used to message
// "try again in 4h 17m".
function msUntilNextEtMidnight(now) {
  const today = etDateString(now);
  // Next midnight in ET = first epoch ms where etDateString(ms) > today.
  // Binary search is overkill — step forward by hours. ET day is
  // typically ~24h, never more than 25 (DST fall-back). 26 is safe.
  for (let h = 1; h <= 26; h++) {
    const probe = now + h * 3600_000;
    if (etDateString(probe) !== today) {
      // Narrow to the minute via linear scan of the last hour.
      for (let m = 1; m <= 60; m++) {
        const mProbe = now + (h - 1) * 3600_000 + m * 60_000;
        if (etDateString(mProbe) !== today) {
          return (h - 1) * 3600_000 + m * 60_000;
        }
      }
      return h * 3600_000;
    }
  }
  return 86400_000;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

export async function daily(env, guildId, userId) {
  const { getWallet, putWallet } = await import('./wallet.js');
  const w = await getWallet(env, guildId, userId);
  const now = Date.now();
  const today = etDateString(now);

  // Migrate: pre-2026-05 wallets only had lastDailyUtc (epoch ms of
  // last claim). Convert to lastDailyEtDate on first read so the
  // streak logic below has something to compare.
  if (!w.lastDailyEtDate && w.lastDailyUtc) {
    w.lastDailyEtDate = etDateString(w.lastDailyUtc);
  }

  if (w.lastDailyEtDate === today) {
    const wait = msUntilNextEtMidnight(now);
    return {
      won: false, payout: 0,
      explanation: 'Already claimed today. Next claim resets at midnight ET (' + fmtDuration(wait) + ').',
    };
  }

  // Streak increments only if the prior claim was YESTERDAY in ET.
  // Any longer gap (missed a day, brand-new claimer) resets to 1.
  const yesterday = prevEtDate(today);
  const continued = w.lastDailyEtDate === yesterday;
  w.dailyStreak = continued ? Math.min(DAILY_STREAK_CAP, (w.dailyStreak || 0) + 1) : 1;

  const payout = DAILY_BASE * w.dailyStreak;
  w.balance += payout;
  w.lifetimeEarned = (w.lifetimeEarned || 0) + payout;
  w.lastDailyUtc = now;
  w.lastDailyEtDate = today;
  w.lastEarnReason = 'daily:streak:' + w.dailyStreak;
  await putWallet(env, guildId, userId, w);
  // PROGRESSION (P1) — daily claim XP + streak milestones. Dedup keyed
  // by ET date so repeated calls in one day grant once.
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    await emitProgressionEvent(env, {
      kind: 'daily.claimed', userId, guildId,
      meta: { ymd: today, streak: w.dailyStreak }, stableKeys: ['ymd'],
    });
    if (w.dailyStreak === 7 || w.dailyStreak === 30 || w.dailyStreak === 100) {
      await emitProgressionEvent(env, {
        kind: `daily.streak.${w.dailyStreak}`, userId, guildId,
        meta: { ymd: today, streak: w.dailyStreak }, stableKeys: ['ymd'],
      });
    }
  } catch { /* non-fatal */ }
  return {
    won: true, payout,
    streak: w.dailyStreak,
    explanation: '🎁 +' + payout + ' bolts (day ' + w.dailyStreak + ' streak). Come back tomorrow (resets at midnight ET).',
  };
}
