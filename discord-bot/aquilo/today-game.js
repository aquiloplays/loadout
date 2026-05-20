// today-game.js — Public GET endpoint that returns tonight's stream game.
//
// Consumed by widget.aquilo.gg/overlays/follow-stream/ — the multi-theme
// follow overlay polls this on load + every minute and swaps its theme
// to match the game of the night.
//
// Schedule logic mirrors schedule.js (rev 2026-05-14):
//   - Sun / Mon / Wed / Fri → Minecraft (fixed, 10:30 PM-12:30 AM ET)
//   - Tue / Thu             → Rest day (no stream)
//   - Sat                   → Community Night (poll winner pulled from
//                              `schedule:<guildId>` KV → cn_winners.saturday)
//
// No auth: the slug is a public fact (it's already announced in the
// schedule embed) and CORS is open so the OBS browser source can fetch
// it from any origin.

import { getETInfo } from './util.js';

// `null` slots are split into two kinds:
//   - CN day: returned with is_cn:true and the slug from KV
//   - REST day: returned with is_off:true, game=null
const WEEKLY = {
  sunday:    'Minecraft',
  monday:    'Minecraft',
  tuesday:   null, // REST
  wednesday: 'Minecraft',
  thursday:  null, // REST
  friday:    'Minecraft',
  saturday:  null, // CN
};
const REST_DAYS = new Set(['tuesday', 'thursday']);
const CN_DAYS   = new Set(['saturday']);

// Map official game name → slug used as the overlay theme key.
// Examples: "R.E.P.O." → "repo", "Ale & Tale Tavern" → "ale_and_tale_tavern".
export function gameSlug(name) {
  if (!name) return null;
  return String(name)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/&/g, 'and')
    .replace(/[?!,'":;()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export async function handleTodayGame(env, req) {
  try {
    const { weekday } = getETInfo(new Date());
    const fixed = WEEKLY[weekday];

    // Rest day — overlay should show its idle/offline theme.
    if (REST_DAYS.has(weekday)) {
      return jsonResp({
        weekday,
        is_cn: false,
        is_off: true,
        game: null,
        slug: null,
      });
    }

    // Fixed game day (Sun/Mon/Wed/Fri = Minecraft).
    if (fixed) {
      return jsonResp({
        weekday,
        is_cn: false,
        is_off: false,
        game: fixed,
        slug: gameSlug(fixed),
      });
    }

    // Community Night day (Saturday) — pull the poll winner from KV.
    const gid = await env.STATE.get('guild_id');
    if (!gid) {
      return jsonResp({
        weekday, is_cn: true, is_off: false,
        game: null, slug: null,
        note: 'guild_not_bootstrapped',
      });
    }
    const raw = await env.STATE.get('schedule:' + gid);
    let sched = null;
    try { sched = raw ? JSON.parse(raw) : null; } catch {}
    const winner = sched?.cn_winners?.[weekday];

    return jsonResp({
      weekday,
      is_cn: true,
      is_off: false,
      game: winner?.name || null,
      slug: winner?.name ? gameSlug(winner.name) : null,
      art_url: winner?.art_url || null,
    });
  } catch (e) {
    return jsonResp({ error: 'today-game failed', message: String(e?.message || e) }, 500);
  }
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
