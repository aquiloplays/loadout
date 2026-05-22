// Clash — daily cron tasks.
//
// Wired into worker.js scheduled() under the "13 9 * * *" trigger.
// Two responsibilities:
//   1. Trophy + prestige decay for anyone camped above their tier cap.
//      Keeps the top of the ladder honest — a player who quits doesn't
//      keep their crown forever.
//   2. "Shield expiring soon" push nudge for any town whose shield
//      ends within the next hour. Gives streamers a chance to log in
//      and shore up garrison before raids unlock.
//
// Cron triggers are batched per Worker; both walks are cheap (KV list
// pagination, no fan-out per-row) so the whole pass fits well inside
// the 30s cron CPU budget at expected community sizes (<10k towns).

import { tierForPrestige } from './clash-state.js';
import { pushShieldExpiring, pushWarEnded } from './clash-push.js';
import { sweepActiveWars } from './clash-war.js';
import { scheduleGoblinRaids } from './clash-goblins.js';

// Trophies above this floor (per tier) trigger a 1/day decay tick.
const TIER_CAPS = { bronze: 200, silver: 600, gold: 1500, platinum: 3500, diamond: 8000 };
const DECAY_RATE = 1;   // trophies / 100 above cap / day (rounded up)

// CF Pages' free plan caps a Worker at 5 cron triggers; ours were
// already at 4 (stocks/sports/queue×2) so Clash piggybacks on :23
// hourly instead of taking its own slot. Daily-only work (trophy +
// prestige decay) is gated through a KV marker so it runs once per
// UTC day, while the shield-nudge + war-sweep run every hour.
const DECAY_MARKER_KEY = 'clash:cron:last-decay';
export async function clashDailyCronTick(env, cronExpr) {
  const today = new Date().toISOString().slice(0, 10);    // YYYY-MM-DD UTC
  const lastDecay = (await env.LOADOUT_BOLTS.get(DECAY_MARKER_KEY, { type: 'json' }))?.date;
  if (lastDecay !== today) {
    await runTrophyDecay(env);
    await env.LOADOUT_BOLTS.put(DECAY_MARKER_KEY, JSON.stringify({ date: today, ranAtUtc: Date.now() }));
  }
  await runShieldNudges(env);
  // CLASH EXPANSION E2: walk every town and fire any goblin raids
  // whose scheduled slot has come due. Bounded — caps at ~10k towns,
  // single sim/town, runs inside the hourly 30s CPU budget.
  try {
    const summary = await scheduleGoblinRaids(env);
    const fired = summary.filter(s => s.fired).length;
    if (fired) console.log('[clash-cron] fired', fired, 'goblin raids');
  } catch (e) {
    console.warn('[clash-cron] goblin raid scheduler failed:', e && e.message);
  }
  // Wars: sweep ACTIVE wars and resolve any whose 24h window has
  // expired. Cheap — only walks the small clash:waractive:* index.
  const endedWars = await sweepActiveWars(env);
  for (const w of endedWars) {
    if (!w.rewards) continue;
    await pushWarEnded(env, {
      winnerGuildId: w.rewards.winnerGuildId,
      loserGuildId: w.rewards.winnerGuildId === w.attackerGuildId ? w.defenderGuildId : w.attackerGuildId,
      scores: w.scores,
      coresTribute: w.rewards.coresTribute || 0,
    });
  }
}

async function runTrophyDecay(env) {
  // Walk every clash:trophies:* key, apply decay to anyone over cap.
  let cursor;
  let touched = 0;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'clash:trophies:', cursor, limit: 1000 });
    for (const k of r.keys) {
      const t = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!t || !t.trophies) continue;
      const cap = TIER_CAPS[t.tier] || 8000;
      if (t.trophies <= cap) continue;
      const decay = Math.ceil((t.trophies - cap) / 100 * DECAY_RATE);
      t.trophies = Math.max(cap, t.trophies - decay);
      t.tier = tierForPrestige(t.trophies);
      await env.LOADOUT_BOLTS.put(k.name, JSON.stringify(t));
      touched++;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  // Same for towns.
  cursor = undefined;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'clash:prestige:', cursor, limit: 1000 });
    for (const k of r.keys) {
      const p = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!p || !p.score) continue;
      const cap = TIER_CAPS[p.tier] || 8000;
      if (p.score <= cap) continue;
      const decay = Math.ceil((p.score - cap) / 100 * DECAY_RATE);
      p.score = Math.max(cap, p.score - decay);
      p.tier = tierForPrestige(p.score);
      await env.LOADOUT_BOLTS.put(k.name, JSON.stringify(p));
      touched++;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  if (touched) console.log('[clash-cron] decay applied to', touched, 'records');
}

async function runShieldNudges(env) {
  const now = Date.now();
  const HOUR = 3_600_000;
  let cursor;
  for (let i = 0; i < 3; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'clash:shield:', cursor, limit: 1000 });
    for (const k of r.keys) {
      const s = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!s?.endsAt) continue;
      const timeLeft = s.endsAt - now;
      // Fire the nudge only in the last hour, and dedupe via a
      // marker on the shield record itself.
      if (timeLeft > 0 && timeLeft <= HOUR && !s.nudgedExpiring) {
        const guildId = k.name.split(':')[2];
        await pushShieldExpiring(env, {
          guildId,
          minutesLeft: Math.max(1, Math.round(timeLeft / 60_000)),
        });
        s.nudgedExpiring = true;
        await env.LOADOUT_BOLTS.put(k.name, JSON.stringify(s), {
          expirationTtl: Math.ceil(timeLeft / 1000) + 60,
        });
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
}
