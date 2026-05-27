// Community-night games roster — ONE message in #community-night-games:
//   embed (composite art + <t:> timestamps + brand color)
// + up to 5 rows of link buttons (Game Name • $price; 🔥 prefix on sale).
//
// Two flows:
//   postRoster(env, guildId, channelId, imageBase64, opts)
//     Fresh post. Uploads the composite as a Discord attachment.
//     Optional opts.purgeFirst deletes the prior message (and any
//     orphan multi-embed layout from the previous design).
//   refreshRosterIfDue(env, guildId, {force})
//     Cron-driven. PATCHes the existing message with refreshed
//     prices in the button labels. Does NOT touch the attachment
//     (Discord preserves it on edit when `attachments` is omitted).
//     Gated by a 6h KV marker.
//
// KV layout:
//   cn-roster:<g> = {
//     channelId, messageId, postedAt,
//     prices: { [appId|'epic:Name']: { final, discount, finalPretty, free } }
//   }
//   cn-roster:last-refresh:<g> = unix-seconds (cron gate)

import { nextEventTimestamp, getConfig as getVoteConfig } from './vote-hub.js';

const ROSTER_KEY         = (g) => `cn-roster:${g}`;
const REFRESH_MARKER_KEY = (g) => `cn-roster:last-refresh:${g}`;
const REFRESH_INTERVAL_S = 6 * 3600;
const COMPOSITE_FILENAME = 'cn-roster.png';

const BRAND_VIOLET = 0x7c5cff;

const STEAM_APPDETAILS = (id) =>
  `https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&filters=basic`;

// Canonical 22-game roster. Order = button order. Mirrors
// aquilo/bootstrap.js DEFAULT_GAMES (with appIds resolved for the
// three formerly-null entries: Vampire Crawlers, Baby Steps;
// Fortnite stays Epic-only).
export const ROSTER = [
  { name: 'MIMESIS',                  appId: 2827200 },
  { name: 'RV There Yet?',            appId: 3949040 },
  { name: 'Lethal Company',           appId: 1966720 },
  { name: 'R.E.P.O.',                 appId: 3241660 },
  { name: 'Pratfall',                 appId: 4244510 },
  { name: 'PEAK',                     appId: 3527290 },
  { name: 'Super Battle Golf',        appId: 4069520 },
  { name: 'Content Warning',          appId: 2881650 },
  { name: 'The Headliners',           appId: 3059070 },
  { name: 'Gamble With Your Friends', appId: 3892270 },
  { name: 'LOCKDOWN Protocol',        appId: 2780980 },
  { name: 'Dead by Daylight',         appId: 381210 },
  { name: 'Fortnite',                 appId: null,
    storeUrl: 'https://store.epicgames.com/en-US/p/fortnite', free: true },
  { name: 'Among Us',                 appId: 945360 },
  { name: 'Phasmophobia',             appId: 739630 },
  { name: 'Vampire Crawlers',         appId: 3265700 },
  { name: 'Baby Steps',               appId: 1281040 },
  { name: 'Marbles on Stream',        appId: 1170970 },
  { name: 'Pummel Party',             appId: 880940 },
  { name: 'PUBG: BATTLEGROUNDS',      appId: 578080 },
  { name: 'The Outlast Trials',       appId: 1304930 },
  { name: 'Species: Unknown',         appId: 2747330 },
];

// Legacy export — preserved for any external caller. Now derived
// from ROSTER (Steam-backed entries only).
export const DEFAULT_APPIDS = ROSTER.filter(g => g.appId).map(g => g.appId);

// ── Steam fetch ─────────────────────────────────────────────────────

async function fetchSteamPrice(appId) {
  try {
    const r = await fetch(STEAM_APPDETAILS(appId), {
      headers: { 'User-Agent': 'aquilo-cn-games (loadout-discord)' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const entry = j[String(appId)];
    if (!entry?.success || !entry.data) return null;
    const d = entry.data;
    if (d.is_free) return { free: true };
    const p = d.price_overview;
    if (!p) return null;
    return {
      final:         p.final,
      finalPretty:   p.final_formatted || ('$' + (p.final / 100).toFixed(2)),
      initialPretty: p.initial_formatted || null,
      discount:      p.discount_percent || 0,
    };
  } catch {
    return null;
  }
}

async function fetchAllPrices() {
  // 21 Steam fetches in parallel. Fortnite skipped (no Steam page).
  return Promise.all(ROSTER.map(g =>
    g.appId ? fetchSteamPrice(g.appId) : Promise.resolve(g.free ? { free: true } : null),
  ));
}

// ── Discord helpers ─────────────────────────────────────────────────

async function dapi(env, method, path, body) {
  const init = {
    method,
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch('https://discord.com/api/v10' + path, init);
  return { ok: r.ok || r.status === 204, status: r.status,
           body: await r.text().catch(() => '') };
}

// ── Embed + components ──────────────────────────────────────────────

function priceFragment(meta) {
  if (!meta) return null;
  if (meta.free) return 'Free';
  if (meta.discount > 0) return `${meta.finalPretty} (-${meta.discount}%)`;
  return meta.finalPretty || null;
}

function buildButton(game, meta) {
  const onSale = !!(meta && !meta.free && meta.discount > 0);
  const price  = priceFragment(meta);
  const prefix = onSale ? '🔥 ' : '';
  const label  = price
    ? `${prefix}${game.name} • ${price}`
    : `${prefix}${game.name}`;
  return {
    type: 2, // BUTTON
    style: 5, // LINK
    label: label.slice(0, 80),
    url: game.storeUrl || `https://store.steampowered.com/app/${game.appId}/`,
  };
}

function buildComponents(metas) {
  const rows = [];
  for (let i = 0; i < ROSTER.length; i += 5) {
    rows.push({
      type: 1, // ACTION_ROW
      components: ROSTER.slice(i, i + 5).map((g, j) => buildButton(g, metas[i + j])),
    });
    if (rows.length >= 5) break;
  }
  return rows;
}

async function buildEmbed(env, guildId) {
  let cfg;
  try { cfg = await getVoteConfig(env, guildId); }
  catch { cfg = null; }

  const lines = ['Tap a game to open its store page.'];
  if (cfg) {
    const now = Date.now();
    const tsOpen  = nextEventTimestamp(now, cfg.cnVoteOpenWeekday,  cfg.cnVoteOpenHourEt);
    const tsClose = nextEventTimestamp(now, cfg.cnVoteCloseWeekday, cfg.cnVoteCloseHourEt);
    const tsQueue = nextEventTimestamp(now, cfg.cnQueueOpenWeekday, cfg.cnQueueOpenHourEt);
    lines.push('');
    if (tsOpen)  lines.push(`Voting opens <t:${Math.floor(tsOpen  / 1000)}:F> (<t:${Math.floor(tsOpen  / 1000)}:R>)`);
    if (tsClose) lines.push(`Voting closes <t:${Math.floor(tsClose / 1000)}:F> (<t:${Math.floor(tsClose / 1000)}:R>)`);
    if (tsQueue) lines.push(`Saturday Community Night queue opens <t:${Math.floor(tsQueue / 1000)}:F>`);
  }

  return {
    title: '🎮 Community Night Games',
    description: lines.join('\n'),
    color: BRAND_VIOLET,
    image: { url: `attachment://${COMPOSITE_FILENAME}` },
    footer: { text: 'Prices auto-refresh every 6 hours from Steam.' },
  };
}

// ── Cleanup of prior layouts ────────────────────────────────────────

async function purgePrior(env, stored) {
  if (!stored) return;
  // New shape: single message
  if (stored.messageId && stored.channelId) {
    await dapi(env, 'DELETE',
      `/channels/${stored.channelId}/messages/${stored.messageId}`).catch(() => {});
  }
  // Old shape (per-game embeds + header): delete each
  if (stored.headerMessageId && stored.channelId) {
    await dapi(env, 'DELETE',
      `/channels/${stored.channelId}/messages/${stored.headerMessageId}`).catch(() => {});
  }
  for (const g of (stored.games || [])) {
    if (g.messageId) {
      await dapi(env, 'DELETE',
        `/channels/${stored.channelId}/messages/${g.messageId}`).catch(() => {});
    }
  }
}

// ── Public: full post ───────────────────────────────────────────────

export async function postRoster(env, guildId, channelId, imageBase64, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN)   return { ok: false, error: 'no-bot-token' };
  if (!channelId)               return { ok: false, error: 'no-channel' };
  if (!imageBase64)             return { ok: false, error: 'image-required' };

  let bytes;
  try {
    const bin = atob(imageBase64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { ok: false, error: 'bad-base64' };
  }

  const stored = await env.LOADOUT_BOLTS.get(ROSTER_KEY(guildId), { type: 'json' });
  if (opts.purgeFirst) await purgePrior(env, stored);

  const metas      = await fetchAllPrices();
  const embed      = await buildEmbed(env, guildId);
  const components = buildComponents(metas);

  const form = new FormData();
  form.append('files[0]', new Blob([bytes], { type: 'image/png' }), COMPOSITE_FILENAME);
  form.append('payload_json', JSON.stringify({
    embeds: [embed],
    components,
    allowed_mentions: { parse: [] },
  }));

  const res = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
      body: form },
  );
  if (!res.ok) {
    return { ok: false, error: 'post-failed', status: res.status,
             body: (await res.text()).slice(0, 300) };
  }
  const msg = await res.json();
  const messageId = String(msg.id);

  const priceMap = Object.fromEntries(ROSTER.map((g, i) =>
    [g.appId ? String(g.appId) : `epic:${g.name}`, metas[i]]));
  await env.LOADOUT_BOLTS.put(ROSTER_KEY(guildId), JSON.stringify({
    channelId, messageId, postedAt: Date.now(), prices: priceMap,
  }));
  await env.LOADOUT_BOLTS.put(REFRESH_MARKER_KEY(guildId),
    String(Math.floor(Date.now() / 1000)));

  return { ok: true, channelId, messageId, games: ROSTER.length };
}

// ── Public: cron refresh (edit components only) ─────────────────────

export async function refreshRosterIfDue(env, guildId, { force = false } = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { skipped: 'no-bot-token' };
  if (!force) {
    const last = parseInt(await env.LOADOUT_BOLTS.get(REFRESH_MARKER_KEY(guildId)) || '0', 10);
    if (last && (Date.now() / 1000 - last) < REFRESH_INTERVAL_S) {
      return { skipped: 'too-soon', secondsSince: Math.floor(Date.now() / 1000 - last) };
    }
  }
  const stored = await env.LOADOUT_BOLTS.get(ROSTER_KEY(guildId), { type: 'json' });
  if (!stored?.messageId || !stored?.channelId) return { skipped: 'no-roster' };

  const metas      = await fetchAllPrices();
  const embed      = await buildEmbed(env, guildId);
  const components = buildComponents(metas);

  // PATCH without an `attachments` field preserves the existing
  // attachment that the original POST uploaded.
  const r = await dapi(env, 'PATCH',
    `/channels/${stored.channelId}/messages/${stored.messageId}`,
    { embeds: [embed], components });
  if (!r.ok) {
    return { ok: false, error: 'patch-failed', status: r.status,
             body: r.body.slice(0, 200) };
  }

  const priceMap = Object.fromEntries(ROSTER.map((g, i) =>
    [g.appId ? String(g.appId) : `epic:${g.name}`, metas[i]]));
  await env.LOADOUT_BOLTS.put(ROSTER_KEY(guildId), JSON.stringify({
    ...stored, prices: priceMap,
  }));
  await env.LOADOUT_BOLTS.put(REFRESH_MARKER_KEY(guildId),
    String(Math.floor(Date.now() / 1000)));

  return { ok: true, edited: true, games: ROSTER.length };
}
