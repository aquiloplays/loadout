// Steam-backed community-night roster.
//
// Fetches live Steam appdetails for a list of game appIds, posts one
// embed per game in the community-night-games channel, and re-edits
// those embeds every 6 hours from the cron tick so sale prices stay
// current. KV-tracked at cn-roster:<g> so a re-run / refresh edits in
// place rather than reposting.
//
// KV layout:
//   cn-roster:<g> = {
//     channelId, headerMessageId,
//     games: [{ appId, messageId, lastDiscount, lastFinal, lastFetchUtc }, ...]
//   }
//   cn-roster:last-refresh:<g> = unix-seconds (cron gate)

const STEAM_APPDETAILS = (appId) =>
  `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&filters=basic,price_overview`;

const BRAND_VIOLET = 0x7c5cff;
const BRAND_PINK   = 0xff6ab5;
const ROSTER_KEY = (g) => `cn-roster:${g}`;
const REFRESH_MARKER_KEY = (g) => `cn-roster:last-refresh:${g}`;
const REFRESH_INTERVAL_S = 6 * 60 * 60;   // 6 hours

// Default roster — Clay can swap by passing an explicit appIds in
// the admin post call. Curated for "viewer-play, social, party-ish"
// community nights.
export const DEFAULT_APPIDS = [
  1966720,   // Lethal Company
  739630,    // Phasmophobia
  2881650,   // Content Warning
  3241660,   // R.E.P.O.
  945360,    // Among Us
  1677740,   // Stumble Guys
  880940,    // Pummel Party
  1097150,   // Fall Guys (free)
  1568590,   // Goose Goose Duck (free)
  1509960,   // Pico Park
  386940,    // Ultimate Chicken Horse
  674940,    // Stick Fight: The Game
  431240,    // Golf With Your Friends
];

// ── Steam fetch ─────────────────────────────────────────────────────
async function fetchSteamMeta(appId) {
  try {
    const r = await fetch(STEAM_APPDETAILS(appId), {
      headers: { 'User-Agent': 'aquilo-cn-games (loadout-discord)' },
    });
    if (!r.ok) return { appId, ok: false, error: 'http-' + r.status };
    const j = await r.json();
    const entry = j[String(appId)];
    if (!entry?.success || !entry.data) {
      return { appId, ok: false, error: 'steam-success-false' };
    }
    const d = entry.data;
    return {
      appId,
      ok: true,
      name:         d.name || '(unknown)',
      header:       d.header_image || null,
      shortDesc:    String(d.short_description || '').slice(0, 240),
      isFree:       !!d.is_free,
      // Strip Steam's [b]/[i] markup from short_description for cleaner
      // Discord rendering. Most appdetails responses don't carry it
      // but a handful do.
      _raw: undefined,
      price: d.price_overview ? {
        initial:        d.price_overview.initial,            // cents
        final:          d.price_overview.final,
        discount:       d.price_overview.discount_percent,
        initialPretty:  d.price_overview.initial_formatted,  // "$19.99"
        finalPretty:    d.price_overview.final_formatted,
      } : null,
    };
  } catch (e) {
    return { appId, ok: false, error: String(e?.message || e) };
  }
}

// ── Embed building ──────────────────────────────────────────────────
function priceLine(meta) {
  if (meta.isFree && !meta.price) return '💰 **Free to Play**';
  if (!meta.price) return '_(price unavailable)_';
  const p = meta.price;
  if (p.discount && p.discount > 0) {
    const initial = p.initialPretty || ('$' + (p.initial / 100).toFixed(2));
    const final   = p.finalPretty   || ('$' + (p.final   / 100).toFixed(2));
    return `🔥 ~~${initial}~~ **${final}**  *(-${p.discount}%)*`;
  }
  return `💰 **${p.finalPretty || ('$' + (p.final / 100).toFixed(2))}**`;
}

function buildGameEmbed(meta) {
  const onSale = !!(meta.price && meta.price.discount > 0);
  return {
    title: meta.name,
    url:   `https://store.steampowered.com/app/${meta.appId}/`,
    description: meta.shortDesc || '_(no description)_',
    color: onSale ? BRAND_PINK : BRAND_VIOLET,
    image: meta.header ? { url: meta.header } : undefined,
    fields: [
      { name: 'Price', value: priceLine(meta), inline: false },
    ],
    footer: { text: `Steam · App ${meta.appId}` },
  };
}

// ── Discord helpers ─────────────────────────────────────────────────
async function dapi(env, method, path, body) {
  const init = {
    method,
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'User-Agent':  'aquilo-cn-roster (1.0)',
    },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch('https://discord.com/api/v10' + path, init);
  return { ok: r.ok || r.status === 204, status: r.status,
           body: await r.text().catch(() => '') };
}

// ── Post / refresh ──────────────────────────────────────────────────

/**
 * Initial post: header + one embed per game. Pins the header.
 * Edits in place if cn-roster:<g> already has records (and the
 * channel is the same).
 */
export async function postRoster(env, guildId, channelId, appIds) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const ids = (Array.isArray(appIds) && appIds.length > 0 ? appIds : DEFAULT_APPIDS)
                .map(Number).filter(Number.isFinite);
  const metas = await Promise.all(ids.map(fetchSteamMeta));

  // Existing roster — if same channel, EDIT each tracked embed; else
  // wipe + re-post.
  const stored = await env.LOADOUT_BOLTS.get(ROSTER_KEY(guildId), { type: 'json' });
  const sameChannel = stored && stored.channelId === channelId;

  const newRecord = { channelId, headerMessageId: null, games: [] };
  const headerContent =
    `🎮  **Community Night — Game Roster**\n` +
    `Vote for these in this channel **Wednesday at 12:00 PM EST** — winner streams **Saturday night**.\n` +
    `Queue opens here Saturday at noon EST.\n\n` +
    `_Prices auto-refresh every 6 hours from Steam._`;

  // Header — edit if we have one in this channel, else post + pin.
  if (sameChannel && stored.headerMessageId) {
    await dapi(env, 'PATCH',
      `/channels/${channelId}/messages/${stored.headerMessageId}`,
      { content: headerContent, allowed_mentions: { parse: [] } });
    newRecord.headerMessageId = stored.headerMessageId;
  } else {
    const hp = await dapi(env, 'POST', `/channels/${channelId}/messages`,
      { content: headerContent, allowed_mentions: { parse: [] } });
    if (!hp.ok) return { ok: false, error: 'header-post-failed',
      status: hp.status, body: hp.body.slice(0, 200) };
    const headerMsg = JSON.parse(hp.body);
    newRecord.headerMessageId = headerMsg.id;
    // Pin (best-effort)
    const pin = await dapi(env, 'PUT', `/channels/${channelId}/pins/${headerMsg.id}`);
    newRecord.headerPinned = pin.ok;
  }

  // Game embeds — edit existing if found, else post new.
  const existingByApp = new Map(
    sameChannel ? (stored.games || []).map(g => [g.appId, g]) : []);
  const errors = [];
  for (const meta of metas) {
    if (!meta.ok) {
      errors.push({ appId: meta.appId, error: meta.error });
      continue;
    }
    const embed = buildGameEmbed(meta);
    const prior = existingByApp.get(meta.appId);
    let msgId = null;
    if (prior?.messageId) {
      const ed = await dapi(env, 'PATCH',
        `/channels/${channelId}/messages/${prior.messageId}`,
        { embeds: [embed] });
      if (ed.ok) msgId = prior.messageId;
      else errors.push({ appId: meta.appId, phase: 'edit', status: ed.status });
    }
    if (!msgId) {
      const po = await dapi(env, 'POST', `/channels/${channelId}/messages`,
        { embeds: [embed], allowed_mentions: { parse: [] } });
      if (!po.ok) {
        errors.push({ appId: meta.appId, phase: 'post', status: po.status,
                      body: po.body.slice(0, 150) });
        continue;
      }
      const m = JSON.parse(po.body);
      msgId = m.id;
    }
    newRecord.games.push({
      appId:        meta.appId,
      messageId:    msgId,
      lastDiscount: meta.price?.discount || 0,
      lastFinal:    meta.price?.final || (meta.isFree ? 0 : null),
      lastFetchUtc: Date.now(),
    });
  }

  // If we re-posted (i.e. swapped channels), best-effort delete any
  // stale embeds from the prior channel — but only if we had records.
  if (!sameChannel && stored?.channelId && Array.isArray(stored.games)) {
    for (const g of stored.games) {
      await dapi(env, 'DELETE',
        `/channels/${stored.channelId}/messages/${g.messageId}`).catch(() => {});
    }
    if (stored.headerMessageId) {
      await dapi(env, 'DELETE',
        `/channels/${stored.channelId}/messages/${stored.headerMessageId}`)
        .catch(() => {});
    }
  }

  await env.LOADOUT_BOLTS.put(ROSTER_KEY(guildId), JSON.stringify(newRecord));
  return {
    ok: true,
    channelId,
    headerMessageId: newRecord.headerMessageId,
    headerPinned: newRecord.headerPinned ?? (sameChannel ? 'kept' : false),
    games: newRecord.games.length,
    errors,
  };
}

/**
 * Cron-driven refresh — re-fetch Steam, edit each tracked embed.
 * Gated by the 6-hour KV marker so the hourly tick can call this
 * unconditionally without thrashing Steam.
 */
export async function refreshRosterIfDue(env, guildId, { force = false } = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { skipped: 'no-bot-token' };
  if (!force) {
    const last = parseInt(await env.LOADOUT_BOLTS.get(REFRESH_MARKER_KEY(guildId)) || '0', 10);
    if (last && (Date.now() / 1000 - last) < REFRESH_INTERVAL_S) {
      return { skipped: 'too-soon', secondsSince: Math.floor(Date.now() / 1000 - last) };
    }
  }
  const stored = await env.LOADOUT_BOLTS.get(ROSTER_KEY(guildId), { type: 'json' });
  if (!stored || !stored.channelId || !Array.isArray(stored.games) || stored.games.length === 0) {
    return { skipped: 'no-roster' };
  }
  const appIds = stored.games.map(g => g.appId);
  const metas = await Promise.all(appIds.map(fetchSteamMeta));
  const newGames = [];
  const changes = [];
  for (let i = 0; i < stored.games.length; i++) {
    const tracked = stored.games[i];
    const meta    = metas[i];
    if (!meta?.ok) { newGames.push(tracked); continue; }
    const embed = buildGameEmbed(meta);
    const ed = await dapi(env, 'PATCH',
      `/channels/${stored.channelId}/messages/${tracked.messageId}`,
      { embeds: [embed] });
    if (!ed.ok) { newGames.push(tracked); continue; }
    const newDiscount = meta.price?.discount || 0;
    const newFinal    = meta.price?.final || (meta.isFree ? 0 : null);
    if (newDiscount !== tracked.lastDiscount || newFinal !== tracked.lastFinal) {
      changes.push({ appId: meta.appId, was: tracked.lastDiscount, now: newDiscount });
    }
    newGames.push({
      appId: meta.appId,
      messageId: tracked.messageId,
      lastDiscount: newDiscount,
      lastFinal:    newFinal,
      lastFetchUtc: Date.now(),
    });
  }
  await env.LOADOUT_BOLTS.put(ROSTER_KEY(guildId), JSON.stringify({
    ...stored, games: newGames,
  }));
  await env.LOADOUT_BOLTS.put(REFRESH_MARKER_KEY(guildId),
    String(Math.floor(Date.now() / 1000)));
  return { ok: true, edited: newGames.length, changes };
}
