// Streak-save reminder. Nightly (~9 PM ET), DM members whose community
// check-in streak is alive but who have NOT checked in today, so they don't
// lose it at midnight ET. This is the single highest-retention nudge in the
// daily loop, and it was silent before.
//
// The roster is read straight from KV list() metadata ({ streak, lastDayEt }
// stamped by community-checkin.saveState), so a full walk costs zero per-key
// gets. Opt-out honored via pprofile.pushPrefs (opt-out model, default ON);
// one DM per member per day (dedup marker). Best-effort: a dead bot token or
// a closed-DM member fails silently and is skipped.
//
// Public API: runStreakReminderCron(env)

import { sendDm } from './util.js';
import { todayET } from '../community-checkin.js';
import { getFreezes } from '../streak-freeze.js';

const MIN_STREAK = 3;               // don't nag brand-new streaks
const DEDUP_TTL = 30 * 60 * 60;     // 30h, survives past midnight

// Difference in whole days between two "YYYY-MM-DD" ET day strings.
function dayDiff(a, b) {
  if (!a || !b) return 999;
  const da = Date.parse(a + "T00:00:00Z");
  const db = Date.parse(b + "T00:00:00Z");
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 999;
  return Math.round((db - da) / 86400000);
}

// Mirrors push-dm.js readPushPrefs/isKindEnabled (neither is exported).
// Opt-out model: absent prefs = ON.
async function wantsReminder(env, userId) {
  try {
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, "json");
    const prefs = p && p.pushPrefs;
    if (!prefs) return true;
    if (prefs.discordDm === false) return false;
    if (prefs.kinds && prefs.kinds["streak.reminder"] === false) return false;
    return true;
  } catch {
    return true;
  }
}

export async function runStreakReminderCron(env) {
  const guildId = env.AQUILO_VAULT_GUILD_ID;
  if (!guildId || !env.LOADOUT_BOLTS) return { ok: false, reason: "no-guild" };
  const today = todayET();
  const prefix = `community-checkin:${guildId}:`;

  // Walk the roster from list() metadata, no per-key gets. A member is "at
  // risk tonight" iff streak >= MIN and they checked in EXACTLY yesterday
  // (dayDiff === 1) and not today. dayDiff > 1 means the streak already
  // lapsed (nothing to save); dayDiff <= 0 means they checked in today.
  const atRisk = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys) {
      const md = k.metadata;
      if (!md || typeof md.streak !== "number") continue; // legacy metadata-less: skip (cheap-only pass)
      if (md.streak < MIN_STREAK) continue;
      if (md.lastDayEt === today) continue;
      if (dayDiff(md.lastDayEt, today) !== 1) continue;
      atRisk.push({ userId: k.name.slice(prefix.length), streak: md.streak });
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }

  let sent = 0;
  for (const c of atRisk) {
    const dedupKey = `streak-reminder:sent:${guildId}:${c.userId}:${today}`;
    if (await env.LOADOUT_BOLTS.get(dedupKey)) continue;
    if (!(await wantsReminder(env, c.userId))) continue;
    // Shield-aware copy: a member who banked a Streak Shield will not lose
    // their streak on a miss (community-checkin auto-consumes one), so the
    // "about to reset" alarm would be inaccurate and would waste the 250
    // Bolts they spent for peace of mind. Read the freeze count (cheap, the
    // at-risk list is small) and soften the message for shielded members.
    let shields = 0;
    try { shields = (await getFreezes(env, guildId, c.userId)).discord || 0; } catch { /* best-effort */ }

    const embed = shields > 0
      ? {
          title: "Keep your streak going",
          description:
            `You're on a **${c.streak}-day** streak and you haven't checked in today. ` +
            `You have **${shields}** streak shield${shields === 1 ? "" : "s"} banked, so one will save your streak automatically if you miss.\n\n` +
            `Want to keep the shields for later? [Check in now](https://aquilo.gg/checkin/).`,
          color: 0x5ee5ff,
          footer: { text: "Turn these off anytime in your notification settings." },
        }
      : {
          title: "Your check-in streak is about to reset",
          description:
            `You're on a **${c.streak}-day** streak. It resets at midnight ET if you don't check in today.\n\n` +
            `Keep it alive: [check in now](https://aquilo.gg/checkin/).`,
          color: 0xffb454,
          footer: { text: "Turn these off anytime in your notification settings." },
        };

    // Reserve before sending so a retry can never double-DM the same night.
    await env.LOADOUT_BOLTS.put(dedupKey, "1", { expirationTtl: DEDUP_TTL });
    try {
      await sendDm(env, c.userId, { embeds: [embed] });
      sent++;
    } catch {
      // Dead token or member has DMs closed (50007): already reserved, skip.
    }
  }
  return { ok: true, atRisk: atRisk.length, sent };
}
