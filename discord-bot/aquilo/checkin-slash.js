// /checkin slash command — slash-driven counterpart to the implicit
// "post an image in the checkin channel" flow in checkin.js.
//
// Shape:
//   1. /checkin           → advance streak + award bolts (if not done
//                            today) AND post a public "check-in card"
//                            embed in the bound check-in channel.
//                            Reply ephemeral with a "Pick a GIF" button.
//   2. aqci:search button → modal prompting for a search query.
//   3. modal:aqci_search  → call Giphy /v1/gifs/search and reply
//                            ephemeral with the top 5 results as
//                            embeds + a row of "Pick" buttons.
//   4. aqci:pick:<tok>:<i> → look up the cached search results +
//                            today's card, then PATCH the card's
//                            embed to set its image to the chosen
//                            gif URL.
//
// The bolts + streak update path is the SAME D1 row + freeze-consume
// flow checkin.js already implements for image posts (one check-in
// per ET day per (guild, user)). The slash command is idempotent: a
// repeat run on a day the user already checked in skips the streak
// bump and just lets them pick / re-pick a gif for today's card.

import {
  ephemeral, discordFetch, editChannelMessage,
  RESP_CHAT, FLAG_EPHEMERAL,
  C_ACTION_ROW, btn, modal, getModalField,
  BTN_PRIMARY, BTN_SECONDARY,
} from './util.js';
import { ensureBootstrap } from './bootstrap.js';
import { applyBolts } from './bolts.js';

const KV_TABLE_INIT = 'checkin:table_initialized:v1';
const KV_CARD_PREFIX = 'aqci:card:';        // aqci:card:<g>:<u>:<dateET>
const KV_RESULTS_PREFIX = 'aqci:results:';  // aqci:results:<token>
const CARD_TTL_S    = 48 * 60 * 60;         // covers ET-day rollover + grace
const RESULTS_TTL_S = 10 * 60;              // user has 10 min to pick

const REWARD_BASE = 5;
const STREAK_MILESTONES = [
  { day: 7,   bonus: 5 },
  { day: 30,  bonus: 10 },
  { day: 100, bonus: 25 },
];

function todayET(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000
  );
}

function milestoneBonus(streak) {
  for (const m of STREAK_MILESTONES) if (streak === m.day) return m.bonus;
  return 0;
}

// Mirror of checkin.js's ensureTable — lazy CREATE so the slash path
// doesn't depend on the image-post path having run first.
async function ensureTable(env) {
  const done = await env.STATE.get(KV_TABLE_INIT);
  if (done) return;
  if (!env.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS discord_checkins (
       guild_id        TEXT NOT NULL,
       user_id         TEXT NOT NULL,
       current_days    INTEGER NOT NULL DEFAULT 0,
       longest_days    INTEGER NOT NULL DEFAULT 0,
       last_day_et     TEXT NOT NULL,
       total_checkins  INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (guild_id, user_id)
     )`
  ).run();
  await env.STATE.put(KV_TABLE_INIT, '1');
}

// Same freeze-consume the implicit checkin flow uses. Returns
// { consumed, remaining } — never throws.
async function consumeFreezeRemote(env, guildId, userId) {
  if (!env.LOADOUT_BOLT_API || !env.LOADOUT_BOLT_API_SECRET) {
    return { consumed: false, remaining: 0, reason: 'unconfigured' };
  }
  let base;
  try { base = new URL(env.LOADOUT_BOLT_API).origin; }
  catch { return { consumed: false, remaining: 0, reason: 'bad_api_url' }; }
  try {
    const resp = await fetch(base + '/streak-freeze/consume', {
      method: 'POST',
      headers: {
        'content-type':     'application/json',
        'x-counting-secret': env.LOADOUT_BOLT_API_SECRET,
      },
      body: JSON.stringify({ guildId, userId, type: 'discord' }),
    });
    if (!resp.ok) return { consumed: false, remaining: 0, reason: 'http_' + resp.status };
    const r = await resp.json();
    return { consumed: !!r.consumed, remaining: Number(r.remaining || 0) };
  } catch { return { consumed: false, remaining: 0, reason: 'throw' }; }
}

async function getBoundCheckinChannel(env, guildId) {
  if (env.LOADOUT_BOLT_API) {
    try {
      const base = new URL(env.LOADOUT_BOLT_API).origin;
      const resp = await fetch(base + '/checkin-channel/' + encodeURIComponent(guildId));
      if (resp.ok) {
        const r = await resp.json();
        if (r && typeof r.channelId === 'string' && r.channelId) return r.channelId;
      }
    } catch { /* fall through */ }
  }
  return env.CHECKIN_CHANNEL_ID || null;
}

// Build the public "check-in card" embed. Image is filled in only
// after the user picks a gif (PATCH from handleCheckinPickButton).
function buildCardEmbed({ username, streak, longest, total, reward, freezeUsed, gifUrl }) {
  const fields = [
    { name: 'Streak', value: '🔥 ' + streak + (streak === 1 ? ' day' : ' days'), inline: true },
    { name: 'Longest', value: String(longest), inline: true },
    { name: 'Total', value: String(total), inline: true },
  ];
  let description = 'Earned **' + reward + '** bolts today.';
  if (freezeUsed) description += '\n❄ A Streak Freeze saved your run.';
  if (!gifUrl)    description += '\n_Pick a GIF in the prompt to add it here._';
  const embed = {
    title: '✅ ' + username + ' checked in',
    description,
    color: freezeUsed ? 0x6cb9ff : 0x42c97a,
    fields,
    timestamp: new Date().toISOString(),
  };
  if (gifUrl) embed.image = { url: gifUrl };
  return embed;
}

// ---- Step 1: /checkin slash command --------------------------------------

export async function handleCheckinSlashCommand(env, data) {
  const userId = data?.member?.user?.id || data?.user?.id;
  const username =
    data?.member?.user?.global_name ||
    data?.member?.user?.username ||
    data?.user?.global_name ||
    data?.user?.username ||
    'someone';

  const guildId = await ensureBootstrap(env);
  const channelId = await getBoundCheckinChannel(env, guildId);
  if (!channelId) {
    return ephemeral('⚠️ The check-in channel isn\'t configured yet. Ask a mod to set it via /admin.');
  }
  if (!env.DB) return ephemeral('⚠️ Check-in storage isn\'t available right now. Try again later.');
  await ensureTable(env);

  const today = todayET();
  const row = await env.DB.prepare(
    'SELECT current_days, longest_days, last_day_et, total_checkins FROM discord_checkins WHERE guild_id = ? AND user_id = ?'
  ).bind(guildId, userId).first();

  // Already checked in today? Skip the streak/bolts/card creation
  // and just let them pick or re-pick a gif for today's card.
  if (row && row.last_day_et === today) {
    const existing = await env.LOADOUT_BOLTS.get(KV_CARD_PREFIX + guildId + ':' + userId + ':' + today, { type: 'json' });
    const tail = existing
      ? 'Pick a GIF to add to your card:'
      : 'Pick a GIF — I\'ll post a card with it:';
    return {
      type: RESP_CHAT,
      data: {
        content: '✅ Already checked in today (day **' + row.current_days + '**). ' + tail,
        flags: FLAG_EPHEMERAL,
        components: [searchRow()],
      },
    };
  }

  // Advance the streak + award bolts (mirrors checkin.js).
  let current, longest, total, freezeUsed = false;
  if (!row) {
    current = 1; longest = 1; total = 1;
  } else {
    const delta = daysBetween(row.last_day_et, today);
    if (delta === 1) {
      current = row.current_days + 1;
    } else if (delta > 1) {
      const r = await consumeFreezeRemote(env, guildId, userId);
      if (r.consumed) { freezeUsed = true; current = row.current_days + 1; }
      else current = 1;
    } else {
      current = row.current_days || 1;
    }
    longest = Math.max(row.longest_days, current);
    total = row.total_checkins + 1;
  }

  if (!row) {
    await env.DB.prepare(
      'INSERT INTO discord_checkins (guild_id, user_id, current_days, longest_days, last_day_et, total_checkins) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(guildId, userId, current, longest, today, total).run();
  } else {
    await env.DB.prepare(
      'UPDATE discord_checkins SET current_days = ?, longest_days = ?, last_day_et = ?, total_checkins = ? WHERE guild_id = ? AND user_id = ?'
    ).bind(current, longest, today, total, guildId, userId).run();
  }

  const bonus = milestoneBonus(current);
  const reward = REWARD_BASE + bonus;
  await applyBolts(env, guildId, userId, reward, 'discord-checkin:slash:streak-' + current);

  // Post the public card embed (no image yet — fills in after pick).
  const embed = buildCardEmbed({ username, streak: current, longest, total, reward, freezeUsed, gifUrl: null });
  let posted;
  try {
    posted = await discordFetch(env, '/channels/' + encodeURIComponent(channelId) + '/messages', {
      method: 'POST',
      body: JSON.stringify({
        content: '<@' + userId + '>',
        embeds: [embed],
        allowed_mentions: { parse: [] },
      }),
    });
  } catch (e) {
    console.warn('[checkin-slash] card post failed', e?.message || e);
    return ephemeral(
      '✅ Checked in (day **' + current + '**, +' + reward + ' bolts) — but I couldn\'t post the public card. Try /checkin again to pick a GIF.'
    );
  }

  // Remember where the card lives so the pick handler can edit it.
  await env.LOADOUT_BOLTS.put(
    KV_CARD_PREFIX + guildId + ':' + userId + ':' + today,
    JSON.stringify({
      channelId,
      messageId: posted.id,
      streak: current,
      longest,
      total,
      reward,
      freezeUsed,
      username,
    }),
    { expirationTtl: CARD_TTL_S },
  );

  return {
    type: RESP_CHAT,
    data: {
      content:
        '✅ Day **' + current + '** check-in logged — **+' + reward + '** bolts' +
        (bonus > 0 ? ' (base ' + REWARD_BASE + ' + milestone ' + bonus + ')' : '') +
        (freezeUsed ? '\n❄ A Streak Freeze saved your run.' : '') +
        '\nPick a GIF to add to your card:',
      flags: FLAG_EPHEMERAL,
      components: [searchRow()],
    },
  };
}

function searchRow() {
  return {
    type: C_ACTION_ROW,
    components: [
      btn('aqci:search', '🎬 Search a GIF', { style: BTN_PRIMARY }),
    ],
  };
}

// ---- Step 2: "Search a GIF" button → modal -------------------------------

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

// ---- Step 4: "Pick #N" button → patch the card --------------------------

export async function handleCheckinPickButton(env, data) {
  const userId = data?.member?.user?.id || data?.user?.id;
  const guildId = await ensureBootstrap(env);
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
    // No card yet — post one now (covers the "already checked in via
    // image-post" path). Streak fields aren't readily available here,
    // so we render a slim card with just the GIF.
    let posted;
    try {
      posted = await discordFetch(env, '/channels/' + encodeURIComponent(
        await getBoundCheckinChannel(env, guildId) || ''
      ) + '/messages', {
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
      JSON.stringify({ channelId: posted?.channel_id || null, messageId: posted?.id || null, gifUrl: pick.url }),
      { expirationTtl: CARD_TTL_S },
    );
    return ephemeral('✅ Added [' + pick.title + '](' + pick.url + ') to your card.');
  }

  // Patch the existing card embed with the chosen image. Re-build
  // from the saved fields so the rest of the card stays intact.
  const newEmbed = buildCardEmbed({
    username: card.username || 'someone',
    streak: card.streak || 1,
    longest: card.longest || 1,
    total: card.total || 1,
    reward: card.reward || REWARD_BASE,
    freezeUsed: !!card.freezeUsed,
    gifUrl: pick.url,
  });
  try {
    await editChannelMessage(env, card.channelId, card.messageId, {
      embeds: [newEmbed],
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
