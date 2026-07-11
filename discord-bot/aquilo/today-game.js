// today-game.js, Public GET endpoint that returns tonight's stream game.
//
// Consumed by the follow-stream overlay (now served from aquilo.gg), which
// polls this on load + every minute and swaps its theme to match the game
// of the night.
//
// v8 (2026-07-11): resolution now drives off aq-schedule.js WEEKLY +
// resolveSlotGame — the SAME sources as the Discord embed and the public
// schedule — instead of a stale local Minecraft-era map (which answered
// "Minecraft" on Crowd Control nights and null on Saturdays after the
// cn_winners vote model was retired):
//   - Sun / Mon / Wed / Fri → kind 'fo4cc' → the current Triple-C campaign
//     game (KV triple-c:current:<g>, default Fallout 4)
//   - Tue / Thu             → kind 'off' → is_off:true, no game
//   - Sat                   → kind 'community' → the weekly community pick
//     (deterministic per ET week from the games:v1 pool)
//   - any night             → the per-date admin override wins first
//
// No auth: the slug is a public fact (it's already announced in the
// schedule embed) and CORS is open so the OBS browser source can fetch
// it from any origin.

import { getETInfo } from './util.js';

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
    // Dynamic import: aq-schedule.js statically imports gameSlug from this
    // module, so the reverse edge stays lazy to keep the cycle harmless.
    const { WEEKLY, resolveSlotGame } = await import('./aq-schedule.js');
    const slot = WEEKLY.find((s) => s.day === weekday);

    // Rest day, overlay should show its idle/offline theme.
    if (!slot || slot.kind === 'off') {
      return jsonResp({
        weekday,
        is_cn: false,
        is_off: true,
        game: null,
        slug: null,
      });
    }

    const gid = (await env.STATE.get('guild_id')) ||
      String(env.AQUILO_VAULT_GUILD_ID || '').trim();
    if (!gid) {
      return jsonResp({
        weekday, is_cn: slot.kind === 'community', is_off: false,
        game: null, slug: null,
        note: 'guild_not_bootstrapped',
      });
    }

    const game = await resolveSlotGame(env, gid, slot.kind, null, slot.dow, slot.day);
    return jsonResp({
      weekday,
      is_cn: slot.kind === 'community',
      is_off: false,
      game: game?.name || null,
      slug: game?.name ? gameSlug(game.name) : null,
      art_url: game?.artUrl || null,
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
