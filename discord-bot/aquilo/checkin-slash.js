// GIPHY gif-picker for /checkin — consolidated 2026-05.
//
// Originally this module shipped its OWN /checkin slash command (D1-
// backed streak, auto-credit bolts, slim embed). That handler was
// retired when the duplicate /checkin spec was de-duped; the canonical
// /checkin now lives in community-checkin.js (KV-backed streak, queued
// bonuses, rich per-user card). The picker flow below (button → modal
// → search → pick) is preserved verbatim except that handleCheckinPick
// no longer rebuilds the embed from saved fields — it fetches the live
// message, mutates `image`, and PATCHes back, so it works against
// whatever embed shape community-checkin posted.
//
// Component chain (dispatched in aquilo/worker.js):
//   1. aqci:search button          → modal prompting for a search query
//   2. modal:aqci_search           → Giphy /v1/gifs/search → ephemeral
//                                    with top 5 results as embeds + a
//                                    row of "Pick #N" buttons
//   3. aqci:pick:<tok>:<i> button  → load cached results + today's
//                                    card pointer (KV `aqci:card:`),
//                                    PATCH the message to add the
//                                    chosen gif as embeds[0].image

import {
  ephemeral, discordFetch, editChannelMessage,
  RESP_CHAT, FLAG_EPHEMERAL,
  C_ACTION_ROW, btn, modal, getModalField,
  BTN_SECONDARY,
} from './util.js';
import { ensureBootstrap } from './bootstrap.js';

const KV_CARD_PREFIX = 'aqci:card:';        // aqci:card:<g>:<u>:<dateET>
const KV_RESULTS_PREFIX = 'aqci:results:';  // aqci:results:<token>
const CARD_TTL_S    = 48 * 60 * 60;         // covers ET-day rollover + grace
const RESULTS_TTL_S = 10 * 60;              // user has 10 min to pick

function todayET(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

// ---- Step 1: "Search a GIF" button → modal -------------------------------

export function handleCheckinSearchButton() {
  return modal('modal:aqci_search', 'Pick a GIF for your check-in', [
    {
      custom_id: 'q',
      label: 'Search GIPHY',
      style: 1,
      required: true,
      min_length: 1,
      max_length: 80,
      placeholder: 'e.g. coffee, monday, victory dance',
    },
  ]);
}

// ---- Step 3: modal submit → Giphy search + ephemeral picker --------------

export async function handleCheckinSearchSubmit(env, data) {
  const userId = data?.member?.user?.id || data?.user?.id;
  if (!userId) return ephemeral('Couldn\'t identify you. Try /checkin again.');
  if (!env.GIPHY_API_KEY) {
    return ephemeral('⚠️ GIF search isn\'t available — `GIPHY_API_KEY` isn\'t set on the worker.');
  }
  const q = (getModalField(data, 'q') || '').trim();
  if (!q) return ephemeral('Empty search.');

  // Giphy /v1/gifs/search — request 5 results, fixed_height for the
  // ephemeral preview embeds. Rating g/pg keeps the picker safe for
  // a general-audience channel.
  let results;
  try {
    const url = new URL('https://api.giphy.com/v1/gifs/search');
    url.searchParams.set('api_key', env.GIPHY_API_KEY);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '5');
    url.searchParams.set('rating', 'pg');
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      return ephemeral('Giphy search failed (' + resp.status + '). Try again.');
    }
    const j = await resp.json();
    results = Array.isArray(j?.data) ? j.data : [];
  } catch (e) {
    return ephemeral('Giphy search failed: ' + String(e?.message || e));
  }
  if (results.length === 0) {
    return ephemeral('No GIFs found for `' + q.slice(0, 40) + '`. Try a different search.');
  }

  // Pack the results — title + the display URL we'll set on the
  // card. images.original gives us a non-resized full GIF; embed
  // will render it at a sensible size.
  const picks = results.slice(0, 5).map((g, i) => ({
    i,
    id: String(g.id || ''),
    title: String(g.title || '').slice(0, 80) || 'GIF #' + (i + 1),
    url: String(g.images?.original?.url || g.images?.fixed_height?.url || g.url || ''),
  })).filter(p => p.url);
  if (picks.length === 0) {
    return ephemeral('Giphy returned no usable GIFs. Try a different search.');
  }

  // Stash the result set in KV under a random token. Buttons carry
  // the token + index — Discord's 100-char custom_id ceiling means
  // we can't pack the URL directly.
  const token = (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2);
  await env.LOADOUT_BOLTS.put(
    KV_RESULTS_PREFIX + token,
    JSON.stringify(picks),
    { expirationTtl: RESULTS_TTL_S },
  );

  // Render: one embed per result (so the user sees the GIF inline),
  // one button per result (one row, 5 buttons max — Discord's row
  // cap is exactly what we need).
  const embeds = picks.map((p, i) => ({
    title: '#' + (i + 1) + ' · ' + p.title,
    image: { url: p.url },
    color: 0x9147ff,
  }));
  const buttons = picks.map((p, i) =>
    btn('aqci:pick:' + token + ':' + i, '#' + (i + 1), { style: BTN_SECONDARY }),
  );

  return {
    type: RESP_CHAT,
    data: {
      content: 'Tap one to add it to your check-in card:',
      flags: FLAG_EPHEMERAL,
      embeds,
      components: [{ type: C_ACTION_ROW, components: buttons }],
    },
  };
}

// ---- Step 3: "Pick #N" button → patch the card --------------------------
//
// Consolidated 2026-05: the picker now FETCHES the live card embed and
// mutates just `image: { url }` instead of rebuilding the embed from
// stashed fields. This way the patch works against whatever embed shape
// posted the card — community-checkin.js's rich avatar / streak / brand
// embed, the slim fallback below, or anything a future surface posts.
// The KV card stash needs only the (channelId, messageId) pointer.

export async function handleCheckinPickButton(env, data) {
  const userId = data?.member?.user?.id || data?.user?.id;
  const guildId = data?.guild_id || await ensureBootstrap(env);
  if (!userId) return ephemeral('Couldn\'t identify you.');
  const cid = data?.data?.custom_id || '';
  // aqci:pick:<token>:<idx>
  const m = cid.match(/^aqci:pick:([A-Za-z0-9-]+):(\d+)$/);
  if (!m) return ephemeral('Bad picker reference.');
  const token = m[1];
  const idx = parseInt(m[2], 10);

  const picks = await env.LOADOUT_BOLTS.get(KV_RESULTS_PREFIX + token, { type: 'json' });
  if (!Array.isArray(picks) || !picks[idx]) {
    return ephemeral('That GIF picker expired. Run /checkin again to pick a fresh one.');
  }
  const pick = picks[idx];

  const today = todayET();
  const card = await env.LOADOUT_BOLTS.get(KV_CARD_PREFIX + guildId + ':' + userId + ':' + today, { type: 'json' });
  if (!card || !card.channelId || !card.messageId) {
    // No card pointer — community-checkin's embed post must have
    // failed (channel-unbound, Discord error). Post a slim
    // standalone GIF card so the user still gets the share.
    const fallbackChannel = env.CHECKIN_CHANNEL_ID || null;
    if (!fallbackChannel) {
      return ephemeral('Couldn\'t find your check-in card or a fallback channel to post the GIF.');
    }
    let posted;
    try {
      posted = await discordFetch(env, '/channels/' + encodeURIComponent(fallbackChannel) + '/messages', {
        method: 'POST',
        body: JSON.stringify({
          content: '<@' + userId + '>',
          embeds: [{
            title: '✅ Check-in GIF',
            image: { url: pick.url },
            color: 0x42c97a,
            timestamp: new Date().toISOString(),
          }],
          allowed_mentions: { parse: [] },
        }),
      });
    } catch (e) {
      return ephemeral('Couldn\'t post the GIF — ' + String(e?.message || e));
    }
    await env.LOADOUT_BOLTS.put(
      KV_CARD_PREFIX + guildId + ':' + userId + ':' + today,
      JSON.stringify({ channelId: posted?.channel_id || null, messageId: posted?.id || null }),
      { expirationTtl: CARD_TTL_S },
    );
    return ephemeral('✅ Added [' + pick.title + '](' + pick.url + ') to your card.');
  }

  // Fetch-mutate-PATCH: read the live message, swap embeds[0].image,
  // PATCH back. Preserves community-checkin's rich author/avatar/
  // accent/headline/subtitle shape without needing to know its
  // schema here.
  let live;
  try {
    live = await discordFetch(env,
      '/channels/' + encodeURIComponent(card.channelId) +
      '/messages/'  + encodeURIComponent(card.messageId),
    );
  } catch (e) {
    return ephemeral('Couldn\'t fetch your check-in card — ' + String(e?.message || e));
  }
  const liveEmbeds = Array.isArray(live?.embeds) ? live.embeds : [];
  const head = liveEmbeds[0] ? { ...liveEmbeds[0] } : {
    title: '✅ Check-in', color: 0x42c97a, timestamp: new Date().toISOString(),
  };
  head.image = { url: pick.url };
  const newEmbeds = [head, ...liveEmbeds.slice(1)];
  try {
    await editChannelMessage(env, card.channelId, card.messageId, {
      embeds: newEmbeds,
      allowed_mentions: { parse: [] },
    });
  } catch (e) {
    return ephemeral('Couldn\'t update your card — ' + String(e?.message || e));
  }

  // Persist the chosen GIF in the card record so a follow-up pick
  // can replace it without re-deriving state.
  card.gifUrl = pick.url;
  await env.LOADOUT_BOLTS.put(
    KV_CARD_PREFIX + guildId + ':' + userId + ':' + today,
    JSON.stringify(card),
    { expirationTtl: CARD_TTL_S },
  );

  return ephemeral('✅ Added [' + pick.title + '](' + pick.url + ') to your card.');
}
