// Daily community check-in, unified across the website and Discord.
//
// This is check-in #1, the "community daily check-in." It is DISTINCT
// from the Twitch-extension stream check-in in ext.js (which lives on
// `checkin:<g>:<u>` with `tw:<twitchId>` userIds and protects with the
// 'stream'-type freeze). The earlier Discord pic-attachment check-in
// in aquilo-bot/checkin.js was retired 2026-05, this module is the
// single Discord-side community check-in going forward.
//
// User-facing contract (per Clay):
//   • A viewer can check in from aquilo.gg OR from Discord, the two
//     dedup against ONE record per ET day. Surface doesn't matter;
//     they get one check-in per day regardless.
//   • The embed posted to the Discord check-in channel shows: their
//     avatar, their username, their chosen GIF/image, their streak.
//     NO hero, NO pet.
//   • The GIF/image and embed styling are configured on aquilo.gg and
//     stored here (KV `checkin-card:<g>:<u>`). First-time Discord
//     check-in with no card saved → default embed + a "go customize
//     your card at aquilo.gg/profile" line.
//   • Streak continues only if they check in before the midnight EST
//     cutoff. Miss → 0, unless they hold a streak shield (a
//     'discord'-type entry in streak-freeze.js), in which case the
//     shield is consumed and the streak is preserved.
//   • (Bolts economy sunset: the daily/streak bonus payout queue has
//     been removed. Check-in records the streak only, no currency.)
//
// KV layout (all on LOADOUT_BOLTS):
//   community-checkin:<g>:<u>, streak state
//     { streak, longest, lastDayEt, total, lastUtc, lastSurface }
//   checkin-card:<g>:<u>, site-controlled embed customisation
//     { imageUrl, accentColor?, headline?, subtitle?, updatedUtc }

// (Bolts economy sunset: removed wallet/economy-pace/cards-packs import)
import { consumeFreeze, getFreezes } from './streak-freeze.js';
import { getCheckinChannel } from './admin-menu.js';
import { emitProgressionEvent } from './progression/event-bus.js';
import { publishActivity } from './activity-do.js';

const STATE_KEY = (g, u) => `community-checkin:${g}:${u}`;
const CARD_KEY  = (g, u) => `checkin-card:${g}:${u}`;

// (Bolts economy sunset: removed wallet/economy-pace/cards-packs import)
// Streak milestone day-list retained for the celebratory check-in
// message + activity pulse (no currency bonus attached anymore).
export const STREAK_MILESTONES = [
  { day: 7,   label: '7-day streak!'   },
  { day: 30,  label: '30-day streak!'  },
  { day: 100, label: '100-day streak!' },
];

// Brand defaults. Per-guild overrides via branding.js (getBranding);
// per-user overrides via the saved checkin-card record (highest
// precedence). Kept here as the final fallback.
const DEFAULT_ACCENT = 0xF47FFF;
const DEFAULT_IMAGE_URL =
  'https://aquilo.gg/sprites/checkin/default-card.png';
// Where the website hosts the "customise your card" page, derived
// per-guild from branding.siteUrl at call time. The customizer is
// mounted under /profile (ProfileHub → CheckinCardCustomizer); the
// older /checkin path was a 404.
const CUSTOMISE_PATH = '/profile';

// ── ET-day plumbing ────────────────────────────────────────────────────
// Streak boundary is midnight US-Eastern, per Clay. Intl.DateTimeFormat
// honours DST automatically, so "today" rolls at 00:00 ET regardless of
// whether it's EST or EDT this week.
export function todayET(date = new Date()) {
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
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000,
  );
}

// ── Twitch sub tier + premium frames ───────────────────────────────────
// Premium check-in card frames unlock by Twitch sub tier — the SAME
// ladder PunchCard uses (gold=T1, neon/retro=T2, holo=T3) so supporting
// the channel upgrades both surfaces coherently. Tier is resolved with
// the broadcaster token (channel:read:subscriptions, same call the
// community stats panel uses) and cached 30 min; tier changes are rare
// and a stale read only delays an unlock.
export const FRAME_TIER = { none: 0, gold: 1, neon: 2, retro: 2, holo: 3 };
const SUBTIER_TTL = 1800;

export async function getSubTier(env, twitchId) {
  const id = String(twitchId || '').trim();
  if (!/^\d{1,20}$/.test(id)) return 0;
  const ck = `subtier:tw:${id}`;
  try {
    const hit = await env.LOADOUT_BOLTS.get(ck);
    if (hit != null) return Math.max(0, Math.min(3, Number(hit) || 0));
  } catch { /* cache miss */ }
  let tier = 0;
  try {
    const { helixFetch } = await import('./twitch-helix.js');
    const broadcasterId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
    if (broadcasterId) {
      const j = await helixFetch(env, '/subscriptions',
        { broadcaster_id: broadcasterId, user_id: id }, { userToken: true });
      const d = j && Array.isArray(j.data) ? j.data[0] : null;
      if (d) tier = Math.max(1, Math.min(3, Math.round(Number(d.tier) / 1000) || 1));
    }
  } catch { /* treat as not subbed */ }
  try { await env.LOADOUT_BOLTS.put(ck, String(tier), { expirationTtl: SUBTIER_TTL }); } catch { /* best-effort */ }
  return tier;
}

// ── State / card / queue accessors ─────────────────────────────────────
async function loadState(env, guildId, userId) {
  return env.LOADOUT_BOLTS.get(STATE_KEY(guildId, userId), { type: 'json' });
}
async function saveState(env, guildId, userId, state) {
  await env.LOADOUT_BOLTS.put(STATE_KEY(guildId, userId), JSON.stringify(state));
}
export async function getCard(env, guildId, userId) {
  return env.LOADOUT_BOLTS.get(CARD_KEY(guildId, userId), { type: 'json' });
}
const AVATAR_SOURCES = new Set(['discord', 'patreon', 'custom']);

// Merge-style upsert. The site sends partial card patches (e.g. the
// avatar-source picker sends ONLY { imageUrl: "", avatarSource } so
// flipping the avatar shouldn't wipe the saved image/headline/etc).
// Each field is updated only when the caller explicitly provides a
// value for it; anything left undefined keeps the existing value.
//   - imageUrl: empty string is treated as "no change" (the picker
//     uses `""` as a no-op sentinel), since clearing the image to
//     fall back to the default is rare and can be done by setting
//     the value to null explicitly.
//   - accentColor: null → reset to default; integer → set; undefined → keep.
//   - avatarSource: one of 'discord' | 'patreon' | 'custom'.
//   - customAvatarUrl: required (and https) when avatarSource === 'custom'.
export async function putCard(env, guildId, userId, card, subTier = null) {
  const prev = (await env.LOADOUT_BOLTS.get(CARD_KEY(guildId, userId), { type: 'json' })) || {};
  const next = { ...prev };
  const inUrl = (card?.imageUrl !== undefined) ? String(card.imageUrl).trim() : undefined;
  if (inUrl !== undefined && inUrl !== '') {
    if (!/^https:\/\//i.test(inUrl)) return { ok: false, error: 'image-url-must-be-https' };
    next.imageUrl = inUrl.slice(0, 500);
  } else if (inUrl === null) {
    next.imageUrl = null;
  }
  if (card?.accentColor === null) {
    next.accentColor = null;
  } else if (Number.isInteger(card?.accentColor)) {
    next.accentColor = card.accentColor & 0xFFFFFF;
  }
  if (card?.headline !== undefined) {
    next.headline = String(card.headline || '').trim().slice(0, 100);
  }
  if (card?.subtitle !== undefined) {
    next.subtitle = String(card.subtitle || '').trim().slice(0, 240);
  }
  if (card?.avatarSource !== undefined) {
    const src = String(card.avatarSource || '').toLowerCase();
    if (!AVATAR_SOURCES.has(src)) return { ok: false, error: 'bad-avatar-source',
      message: `avatarSource must be one of: ${[...AVATAR_SOURCES].join(', ')}` };
    next.avatarSource = src;
  }
  if (card?.customAvatarUrl !== undefined) {
    const v = String(card.customAvatarUrl || '').trim();
    if (v && !/^https:\/\//i.test(v)) return { ok: false, error: 'custom-avatar-url-must-be-https' };
    next.customAvatarUrl = v.slice(0, 500) || null;
  }
  // backgroundId, the picker on aquilo.gg writes a slug ("fireflies-
  // violet", "aurora", etc.) here. The site owns the slug → CDN URL
  // mapping (GET /api/web/checkin/backgrounds returns the catalog);
  // the worker just stores the slug so the embed renderer can ask
  // the site to resolve it. Back-compat: theme/effect string fields
  // from the v1 picker stay on the card untouched. Format: lowercase
  // a-z0-9_- only, ≤60 chars.
  if (card?.backgroundId !== undefined) {
    if (card.backgroundId === null || card.backgroundId === '') {
      next.backgroundId = null;
    } else {
      const v = String(card.backgroundId).trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,60}$/.test(v)) {
        return { ok: false, error: 'bad-background-id',
          message: 'backgroundId must match /^[a-z0-9_-]{1,60}$/' };
      }
      next.backgroundId = v;
    }
  }
  // Premium frame, unlocked by Twitch sub tier (FRAME_TIER ladder).
  // Validated server-side when the caller resolved a tier (subTier
  // != null, the web path); the legacy Discord path passes null and
  // can only CLEAR a frame, never set one it can't verify.
  if (card?.frame !== undefined) {
    const f = card.frame == null || card.frame === '' ? 'none' : String(card.frame).toLowerCase();
    if (!(f in FRAME_TIER)) {
      return { ok: false, error: 'bad-frame',
        message: `frame must be one of: ${Object.keys(FRAME_TIER).join(', ')}` };
    }
    if (f !== 'none') {
      if (subTier == null) return { ok: false, error: 'frame-requires-tier-check' };
      if (FRAME_TIER[f] > subTier) {
        return { ok: false, error: 'frame-locked', needTier: FRAME_TIER[f],
          message: `The ${f} frame unlocks at sub tier ${FRAME_TIER[f]}.` };
      }
    }
    next.frame = f === 'none' ? null : f;
  }
  // Pass-through for the legacy theme/effect strings the v1 picker
  // wrote. Don't validate, they're already in the wild on saved
  // records and the site is the source of truth for shape.
  if (card?.theme !== undefined) {
    next.theme = card.theme == null ? null : String(card.theme).slice(0, 60);
  }
  if (card?.effect !== undefined) {
    next.effect = card.effect == null ? null : String(card.effect).slice(0, 60);
  }
  // Final guard: if the user picked 'custom' but no URL is on file
  // (neither this patch nor a prior save), refuse the upsert rather
  // than silently falling back to Discord at embed time.
  if (next.avatarSource === 'custom' && !next.customAvatarUrl) {
    return { ok: false, error: 'custom-avatar-url-required',
             message: "avatarSource:'custom' needs customAvatarUrl set." };
  }
  next.updatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put(CARD_KEY(guildId, userId), JSON.stringify(next));
  return { ok: true, card: next };
}

// (Bolts economy sunset: removed bonus-queue machinery — loadQueue/
// saveQueue/bonusId/enqueueBonus. Check-in + streak persist with no
// currency payout.)

// ── Discord-side helpers ───────────────────────────────────────────────
function avatarUrl(userId, avatarHash) {
  if (!avatarHash) {
    const disc = Number(BigInt(userId) >> 22n) % 6;
    return `https://cdn.discordapp.com/embed/avatars/${disc}.png`;
  }
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=256`;
}

async function fetchMemberInfo(env, guildId, userId) {
  // Best-effort. We need username + avatar hash + global_name to
  // render the embed; if Discord refuses (member left, bot missing
  // perms), fall back to a generic display so the check-in still
  // counts.
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
    });
    if (!r.ok) return null;
    const m = await r.json();
    return {
      displayName: m?.nick || m?.user?.global_name || m?.user?.username || 'friend',
      username:    m?.user?.username || 'friend',
      avatar:      avatarUrl(userId, m?.user?.avatar),
    };
  } catch { return null; }
}

// Resolve the author avatar based on the user's saved card preference.
// Falls back to Discord on any miss so the check-in still posts:
//   discord (default) → fetched Discord member avatar (already on `member`)
//   patreon           → patreon:tier:<userId>.imageUrl (site populates
//                        this on OAuth link); fallback to Discord if
//                        missing.
//   custom            → card.customAvatarUrl (already validated as https
//                        in putCard); fallback to Discord if it's been
//                        cleared since save.
async function resolveAvatar(env, userId, card, member) {
  const fallback = member?.avatar || avatarUrl(userId, null);
  const source = card?.avatarSource || 'discord';
  if (source === 'discord') return { url: fallback, source };
  if (source === 'custom') {
    return { url: card?.customAvatarUrl || fallback,
             source: card?.customAvatarUrl ? 'custom' : 'discord-fallback' };
  }
  if (source === 'patreon') {
    // The site is expected to write the Patreon imageUrl into
    // patreon:tier:<userId> when the OAuth link completes. Until that
    // field is populated, we fall back to Discord so the embed isn't
    // blank.
    try {
      const tier = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
      const url = tier?.imageUrl || tier?.image_url || tier?.avatar || null;
      if (url) return { url, source: 'patreon' };
    } catch { /* idle */ }
    return { url: fallback, source: 'discord-fallback' };
  }
  return { url: fallback, source: 'discord' };
}

// ── Check-in embed v2, composite renderer stub ──────────────────────
//
// Variant C spec (2026-05-27, awaiting Clay's final pick):
//   * Background dimensions: 1200×675 (user-selected card image,
//     stored under the user's card record).
//   * Foreground: chosen GIF resized to ~35% canvas width, centered
//     over the background. Soft radial vignette behind for legibility.
//   * Per-frame composite, for each frame of the source GIF, paste
//     the resized frame over the bg with the vignette. Re-export as
//     a single animated GIF.
//   * Cache by sha256(bgId + '|' + gifUrl) → composite URL. KV key
//     ci-composite:<hash>. TTL ~30d.
//
// Cloudflare Workers can't run Pillow/PIL natively, so the real
// renderer lives behind one of:
//   (a) a sidecar Python service on the aquilo-gateway shim
//       (POST /image/compose-checkin → returns bytes), OR
//   (b) Cloudflare Images "drawings" overlay rules (faster but
//       per-frame compositing of animated GIFs isn't supported by
//       the public Images API today), OR
//   (c) a Worker calling Pyodide-WASM Pillow (very slow).
//
// (a) is the planned path. This function calls the site composite
// endpoint when AQUILO_SITE_WEB_SECRET is configured AND the endpoint
// is reachable. Cache lookup happens worker-side (KV), so a repeat
// (bg, gif) pair after the first render returns the cached URL with
// no site round-trip.
const CI_COMPOSITE_KV_PREFIX = 'ci-composite:';
const CI_COMPOSITE_TTL_S     = 30 * 86400;
const CI_COMPOSITE_SITE_PATH = '/api/web/checkin/compose';

async function composeCheckinCard(env, { bgUrl, gifUrl, bgId }) {
  if (!bgUrl || !gifUrl) return null;
  // Hash (bg, gif) for cache lookup. bgId is preferred when available
  // since card backgrounds get re-uploaded with new URLs but stable
  // IDs; falls back to the URL itself.
  const cacheKeyInput = (bgId || bgUrl) + '|' + gifUrl;
  const hashBytes = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(cacheKeyInput));
  const hash = Array.from(new Uint8Array(hashBytes))
    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
  const cacheKey = CI_COMPOSITE_KV_PREFIX + hash;

  // Cache hit short-circuit.
  const cached = await env.LOADOUT_BOLTS.get(cacheKey, { type: 'json' });
  if (cached?.url) return cached;

  // Need a shared secret + a site origin to call the composite
  // endpoint. Without either, fall through to the v1 image stack.
  const secret = env.AQUILO_SITE_WEB_SECRET;
  if (!secret) return null;
  const origin = (env.AQUILO_SITE_ORIGIN || 'https://aquilo.gg').replace(/\/$/, '');

  let resp;
  try {
    resp = await siteSignedPost(secret, origin + CI_COMPOSITE_SITE_PATH,
      { bgUrl, gifUrl, bgId: bgId || null, hash });
  } catch (e) {
    console.warn('[checkin-v2] compose POST failed:', e?.message || e);
    return null;
  }
  if (!resp.ok) {
    // 404 = endpoint not deployed yet (parallel site session lands
    // it). Anything else = log + skip; either way, fall through.
    if (resp.status !== 404) {
      console.warn('[checkin-v2] compose responded',
        resp.status, (await resp.text().catch(() => '')).slice(0, 200));
    }
    return null;
  }
  let data;
  try { data = await resp.json(); }
  catch { return null; }
  if (!data?.ok || !data?.url) return null;

  const record = {
    url:           String(data.url),
    contentLength: data.contentLength || null,
    composedAt:    Date.now(),
  };
  await env.LOADOUT_BOLTS.put(cacheKey, JSON.stringify(record),
    { expirationTtl: CI_COMPOSITE_TTL_S });
  return record;
}

// HMAC-signed POST helper for the site composite endpoint. Mirrors
// daily-bonus-push.js signedPost, same x-aquilo-web-ts/sig contract,
// inlined to keep this module's import surface narrow.
async function siteSignedPost(secret, url, payloadObj) {
  const body = JSON.stringify(payloadObj);
  const ts = String(Math.floor(Date.now() / 1000));
  const message = ts + '\n' + body;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const sigHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return fetch(url, {
    method:  'POST',
    headers: {
      'content-type':    'application/json',
      'x-aquilo-web-ts':  ts,
      'x-aquilo-web-sig': sigHex,
    },
    body,
  });
}

async function postCheckinEmbed(env, guildId, userId, state, card, member, isFirstTimeNoCard, opts = {}) {
  // Resolution order:
  //   1. channel-binding(checkin-results), KV-only, set by Clay
  //      to route result embeds away from the hub channel
  //   2. legacy admin-menu getCheckinChannel (KV `checkin:channel:guild:<g>`)
  //   3. null → no-op skip with reason
  let channelId = null;
  try {
    const { getChannelBinding } = await import('./channel-bindings.js');
    channelId = await getChannelBinding(env, guildId, 'checkin-results');
  } catch { /* fall through to legacy */ }
  if (!channelId) {
    const channel = await getCheckinChannel(env, guildId);
    channelId = channel?.channelId || null;
  }
  if (!channelId) return { posted: false, reason: 'channel-unbound' };

  // Per-guild branding (siteUrl, accent, defaultImage). Card-level
  // override (if the user customised) wins over branding which wins
  // over the global defaults at the top of this file.
  const { getBranding } = await import('./branding.js');
  const brand   = await getBranding(env, guildId);
  const accent  = (card?.accentColor != null ? card.accentColor : (brand.accentColor || DEFAULT_ACCENT));

  // CHECKIN_EMBED_V2 (variant C), server-side composite of the
  // user-selected card background with the chosen GIF centered over
  // it (~35% width, soft radial vignette behind for legibility),
  // exported as a fresh animated GIF and cached by
  // (background_id, gif_url) hash. The flag stays "false" until
  // Clay green-lights the mockup; until then we fall through to the
  // current rendering (gif > card > brand default). When the flag
  // flips on AND composeCheckinCard returns a URL, that URL becomes
  // embed.image and the raw gif moves to embed.thumbnail so both
  // surfaces stay visible.
  let imageOverride    = null;
  let thumbnailOverride = null;
  if (env.CHECKIN_EMBED_V2 === 'true' && opts.gifUrl) {
    try {
      const composed = await composeCheckinCard(env, {
        bgUrl: card?.imageUrl || brand.checkinDefaultImageUrl || DEFAULT_IMAGE_URL,
        gifUrl: opts.gifUrl,
        bgId: card?.imageId || null,
      });
      if (composed?.url) {
        imageOverride     = composed.url;
        thumbnailOverride = opts.gifUrl;
      }
    } catch (e) {
      // Composite failed, log and fall through to v1 image stack so
      // the check-in still posts cleanly.
      console.warn('[checkin-v2] compose failed:', e?.message || e);
    }
  }
  // Embed image comes ONLY from a genuine user source: the v2
  // composite, the GIF they chose in the compose flow, or their saved
  // custom card. Per Clay (2026-06-02): users who haven't customised no
  // longer get the "Welcome Back" default-card.png slapped on, the
  // brand/global default fallbacks are intentionally dropped here so a
  // no-card check-in posts a clean embed (author + streak + message)
  // with no image. (brand.checkinDefaultImageUrl itself defaults to that
  // same default-card.png, so it has to go too, not just DEFAULT_IMAGE_URL.)
  const image = imageOverride
    || opts.gifUrl
    || card?.imageUrl
    || null;
  const display = member?.displayName || 'friend';
  const avatarPick = await resolveAvatar(env, userId, card, member);
  const avatar     = avatarPick.url;

  // Description rules:
  //   • opts.message (user-typed message from the compose modal) wins
  //     the top slot if present.
  //   • Streak line is always present.
  //   • Headline (if set) renders above the streak in italics.
  //   • Subtitle (if set) renders below.
  //   • First-time-with-no-card adds the "customise your card" hint.
  const lines = [];
  const composedMessage = String(opts.message || '').trim();
  // Discord renders `> text` as a blockquote with a coloured left
  // rail, visually quotes the user's typed message and lifts it
  // above the streak line. Sits at the top of the
  // description (right under the author header). Per Clay's spec
  // (quote-style + italicized + near author).
  if (composedMessage) lines.push(`> _${composedMessage.slice(0, 300)}_`);
  if (card?.headline) lines.push(`_${card.headline}_`);
  // ── Punch-card row (Clay, 2026-07-02: "daily check-ins that post to
  // Discord should look like punch cards"). Each card page holds 7
  // punches like a coffee-shop card; finish a page, start the next.
  // The punch stamp upgrades with the supporter's Twitch sub tier —
  // same ladder as the PunchCard product (⚡ everyone, 🌟 T1, 💎 T2,
  // 👑 T3).
  const subTier = Math.max(0, Math.min(3, Number(opts.subTier) || 0));
  const stamp   = ['⚡', '🌟', '💎', '👑'][subTier];
  const pageNo  = Math.floor((state.streak - 1) / 7) + 1;
  const punched = ((state.streak - 1) % 7) + 1;
  const row = Array.from({ length: 7 }, (_, i) => (i < punched ? stamp : '▫️')).join(' ');
  lines.push(row);
  lines.push(
    `🔥 **${state.streak}-day streak**`
    + (state.longest > state.streak ? ` · best ${state.longest}` : '')
    + (subTier ? ` · ${stamp} T${subTier} supporter` : ''),
  );
  if (card?.subtitle) lines.push(card.subtitle);
  if (isFirstTimeNoCard) {
    lines.push('');
    lines.push(`✨ _Customise your check-in card at_ ${brand.siteUrl}${CUSTOMISE_PATH}`);
  }

  const embed = {
    author: { name: `${display} checked in`, icon_url: avatar },
    description: lines.join('\n'),
    color: accent,
    footer: { text: `🎟 PUNCH CARD #${pageNo} · ${punched}/7`
      + (card?.frame ? ` · ${String(card.frame).toUpperCase()} FRAME` : '') },
    timestamp: new Date().toISOString(),
  };
  if (image) embed.image = { url: image };
  if (thumbnailOverride) embed.thumbnail = { url: thumbnailOverride };

  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [embed],
      allowed_mentions: { parse: [] },
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    return { posted: false, reason: 'discord-' + r.status, body: txt.slice(0, 200) };
  }
  const m = await r.json();
  return { posted: true, channelId, messageId: m?.id || null,
           avatarSource: avatarPick.source };
}

// ── Core unified check-in ──────────────────────────────────────────────
// Returns:
//   {
//     ok, alreadyToday, streak, longest, freezeUsed,
//     embed: { posted, channelId?, messageId?, reason? },
//     firstTimeNoCard,
//   }
//
// `source` is informational only ('web' | 'discord' | 'system') and
// recorded into the state record so we can see which surface fired
// each user's last check-in.
export async function recordCheckin(env, guildId, userId, source = 'web', opts = {}) {
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };

  const now    = Date.now();
  const today  = todayET(new Date(now));
  const prev   = await loadState(env, guildId, userId);
  const card   = await getCard(env, guildId, userId);
  const firstTimeNoCard = !card && !prev;   // exactly first ever, no card

  // Same-day idempotency. Both surfaces can call freely; only the
  // first call of the ET day does work.
  if (prev?.lastDayEt === today) {
    return {
      ok: true,
      alreadyToday: true,
      streak:  prev.streak,
      longest: prev.longest,
      freezeUsed: false,
      embed: { posted: false, reason: 'already-today' },
      firstTimeNoCard: false,
    };
  }

  // Streak math.
  let freezeUsed = false;
  let nextStreak;
  if (!prev || !prev.lastDayEt) {
    // Fresh user — or a legacy/reset record whose lastDayEt is null (the
    // 2026 streak-reset wrote those), which used to crash daysBetween with
    // "Cannot read properties of null (reading 'split')". No prior day on
    // record means no continuity to judge: count today, keep any surviving
    // streak value.
    nextStreak = (prev?.streak || 0) + 1;
  } else {
    const delta = daysBetween(prev.lastDayEt, today);
    if (delta === 1) {
      nextStreak = prev.streak + 1;
    } else if (delta > 1) {
      // Missed at least one day → consume a discord-type shield.
      const r = await consumeFreeze(env, guildId, userId, 'discord');
      if (r.consumed) {
        freezeUsed = true;
        nextStreak = prev.streak + 1;   // protected, count today as continuous
      } else {
        nextStreak = 1;                  // reset
      }
    } else {
      // delta === 0 was handled above; delta < 0 only on clock skew.
      nextStreak = Math.max(1, prev.streak || 1);
    }
  }
  const nextLongest = Math.max(prev?.longest || 0, nextStreak);

  const state = {
    streak:      nextStreak,
    longest:     nextLongest,
    lastDayEt:   today,
    total:       (prev?.total || 0) + 1,
    lastUtc:     now,
    lastSurface: source,
  };
  await saveState(env, guildId, userId, state);

  // (Bolts economy sunset: removed daily + streak-milestone bonus
  // enqueue. Streak is still tracked; milestone days still drive the
  // celebratory message + XP + activity pulse below.)

  // XP grant, fire through the progression event bus so the daily
  // check-in XP (table key 'daily.claimed' = 20 XP, daily cap 20) +
  // any streak-milestone XP land on the user's XP record. Event-bus
  // dedup is keyed on meta.id so a same-day re-call doesn't double-
  // grant. Fire-and-forget; a failed grant must never roll back the
  // check-in. Streak XP is driven off the milestone days, the XP
  // table has 'daily.streak.{7,30,100}' tuned by
  // PROGRESSION-SYSTEM-DESIGN.md §4.2.
  try {
    await emitProgressionEvent(env, {
      kind: 'daily.claimed',
      userId,
      guildId,
      meta: { id: 'community-checkin:daily:' + today },
    });
    if (nextStreak === 7 || nextStreak === 30 || nextStreak === 100) {
      await emitProgressionEvent(env, {
        kind: 'daily.streak.' + nextStreak,
        userId,
        guildId,
        meta: { id: 'community-checkin:streak-' + nextStreak + ':' + today },
      });
    }
  } catch { /* non-fatal, check-in already persisted */ }

  // Live-activity overlay pulse (off by default on the overlay to avoid
  // spam). Best-effort; carries the streak + any milestone. Name resolves
  // from opts when the caller had one, else a generic actor on the overlay.
  await publishActivity(env, {
    kind: 'community.checkin', userId, guildId,
    viewer: (opts && (opts.displayName || opts.userName || opts.name)) || null,
    streak: nextStreak, longest: nextLongest,
    milestone: (nextStreak === 7 || nextStreak === 30 || nextStreak === 100) ? nextStreak : null,
  }).catch(() => {});

  // Post the embed (best-effort, a failure here doesn't roll back
  // the check-in itself; the user still got their streak).
  // opts { message, gifUrl } come from the /checkin compose flow
  // and bake the user's message + chosen GIF directly into the card.
  // opts.twitchId (web path, from the signed site session) resolves the
  // supporter's sub tier so the punch-card stamps upgrade with tier.
  if (opts.twitchId && opts.subTier == null) {
    opts.subTier = await getSubTier(env, opts.twitchId).catch(() => 0);
  }
  const member = await fetchMemberInfo(env, guildId, userId);
  const embed  = await postCheckinEmbed(env, guildId, userId, state, card, member, firstTimeNoCard, opts);

  // Referral milestone: if this user was attributed to a referrer and
  // this is their FIRST ever community check-in (state.total === 1
  // after the increment above), fire the milestone. recordMilestone is
  // a no-op for un-attributed users and for already-paid referees, so
  // this is safe to call unconditionally on every first check-in.
  if (state.total === 1) {
    try {
      const { recordMilestone } = await import('./referrals.js');
      await recordMilestone(env, guildId, userId, 'first-checkin');
    } catch { /* non-fatal */ }
  }

  // (Bolts economy sunset: removed the Voltaic lucky-pack drop roll —
  // depended on the deleted cards-packs.js module.)

  return {
    ok: true,
    alreadyToday: false,
    streak:  state.streak,
    longest: state.longest,
    freezeUsed,
    embed,
    firstTimeNoCard,
  };
}

// Read-only status for the website's "you can check in" notification.
export async function getStatus(env, guildId, userId) {
  const state = await loadState(env, guildId, userId);
  const card  = await getCard(env, guildId, userId);
  const freezes = await getFreezes(env, guildId, userId);
  const today = todayET();
  return {
    ok: true,
    checkedInToday: !!(state && state.lastDayEt === today),
    streak:  state?.streak  || 0,
    longest: state?.longest || 0,
    total:   state?.total   || 0,
    lastCheckinUtc: state?.lastUtc || 0,
    todayEt: today,
    card,                                  // null when user hasn't customised yet
    pendingBonuses: [],                    // (Bolts economy sunset: no payouts to collect)
    streakShields: freezes.discord || 0,   // 'discord'-type freezes = check-in shields
  };
}

// (Bolts economy sunset: the daily/streak bonus queue is gone, so
// there's nothing to collect. Kept as an exported no-op so callers
// (web route) keep their import + a stable response shape.)
export async function collectBonus(env, guildId, userId, claimId) {
  return { ok: true, collected: [], totalCredited: 0, remaining: 0 };
}

// ── Discord /checkin slash command ─────────────────────────────────────
// Interaction-based, so it works without the gateway shim.
//
// Consolidated 2026-05 to roll in the GIPHY gif-picker UX that used to
// live in aquilo/checkin-slash.js (the duplicate /checkin entry).
// Flow:
//   1. /checkin → runs the unified recordCheckin (streak / freeze /
//      posted embed / referral milestone).
//   2. If the embed posted to the bound channel, stash the
//      {channelId, messageId} under `aqci:card:<g>:<u>:<dateET>` so
//      the existing aqci:pick handler in aquilo/checkin-slash.js can
//      patch it.
//   3. Reply ephemeral with the streak summary AND a "🎬 Search a
//      GIF" button, same custom_id (aqci:search) the picker already
//      dispatches off, so no new component handlers needed.
//   4. The picker chain (aqci:search → modal:aqci_search →
//      aqci:pick:<tok>:<i>) runs as before; the pick handler now
//      fetches the live embed + sets `image: { url }` instead of
//      rebuilding from scratch, so it works regardless of which
//      embed shape posted the card.
const AQCI_CARD_PREFIX = 'aqci:card:';
const AQCI_CARD_TTL_S  = 48 * 60 * 60;
const GIF_PICKER_ROW = {
  type: 1, // ACTION_ROW
  components: [{
    type: 2,                  // BUTTON
    style: 1,                 // PRIMARY
    label: '🎬 Search a GIF',
    custom_id: 'aqci:search', // dispatched in aquilo/worker.js → handleCheckinSearchButton
  }],
};

async function stashCardPointer(env, guildId, userId, today, channelId, messageId) {
  if (!channelId || !messageId) return;
  await env.LOADOUT_BOLTS.put(
    AQCI_CARD_PREFIX + guildId + ':' + userId + ':' + today,
    JSON.stringify({ channelId, messageId }),
    { expirationTtl: AQCI_CARD_TTL_S },
  );
}

async function loadCardPointer(env, guildId, userId, today) {
  return env.LOADOUT_BOLTS.get(
    AQCI_CARD_PREFIX + guildId + ':' + userId + ':' + today,
    { type: 'json' },
  );
}

// ── /checkin compose flow (gif + message before posting) ───────────────
//
// New 2026-05 flow per Clay: /checkin no longer posts the card on the
// first click. Instead it opens a modal that asks for BOTH a GIF
// search query (required) and a short message (optional). On modal
// submit, Giphy returns 5 candidates; the user picks one and THAT
// click is what actually fires recordCheckin + posts the card with
// the GIF + message baked in.
//
// Component chain, dispatched in aquilo/worker.js:
//   1. /checkin                          → opens modal:ci2_compose
//   2. modal:ci2_compose                 → handleCheckinComposeSubmit
//                                          → Giphy /v1/gifs/search,
//                                            stash {picks, message}
//                                            in KV under a token,
//                                            render ephemeral picker
//   3. ci2:pick:<token>:<i>              → handleCheckinPickSubmit
//                                          → recordCheckin with the
//                                            chosen gif + message in
//                                            opts; (or PATCH the
//                                            existing card if user
//                                            already checked in today)
//
// Backward compatibility: the OLD aqci:search → aqci:pick chain in
// aquilo/checkin-slash.js stays wired for any ephemerals already in
// chat that still carry those custom_ids; the modal-first flow is
// the new default for the slash + hub button.
const MODAL_COMPOSE_ID  = 'modal:ci2_compose';
const CI2_TOKEN_PREFIX  = 'ci2:token:';
const CI2_PICK_PREFIX   = 'ci2:pick:';
const CI2_TOKEN_TTL_S   = 10 * 60;

function getModalFieldValue(data, customId) {
  const rows = data?.data?.components || [];
  for (const r of rows) {
    for (const c of (r.components || [])) {
      if (c?.custom_id === customId) return c.value;
    }
  }
  return null;
}

export function handleCheckinCommand(env, data) {
  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  if (!guildId || !userId) {
    return { type: 4, data: { content: 'Run this in a server.', flags: 64 } };
  }
  // Daily check-in moved to the website (2026-07). Discord no longer
  // records check-ins; the same streak (POST /web/checkin →
  // recordCheckin, source 'web') is credited on aquilo.gg. Both the
  // /checkin slash command and the #check-in hub "run" button funnel
  // through here, so this single redirect neutralises both.
  return {
    type: 4,
    data: {
      content:
        '✅ **Daily check-in is on the website now.**\n' +
        'Check in at https://aquilo.gg/checkin — sign in with Twitch and tap **Check in**. ' +
        'Your streak carries over (same account, one check-in per day).',
      flags: 64,
    },
  };
}

export async function handleCheckinComposeSubmit(env, data) {
  const userId  = data?.member?.user?.id || data?.user?.id;
  const guildId = data?.guild_id;
  if (!userId || !guildId) {
    return { type: 4, data: { content: 'Run this in a server.', flags: 64 } };
  }
  if (!env.GIPHY_API_KEY) {
    return { type: 4, data: {
      content: '⚠️ GIF search isn\'t available, `GIPHY_API_KEY` is not set on the worker.',
      flags: 64,
    } };
  }
  const q       = (getModalFieldValue(data, 'q') || '').trim();
  const message = (getModalFieldValue(data, 'message') || '').trim();
  if (!q) return { type: 4, data: { content: 'Empty GIF search.', flags: 64 } };

  // Giphy search, same shape as aquilo/checkin-slash.js, kept local
  // here to avoid cross-module coupling.
  let results;
  try {
    const url = new URL('https://api.giphy.com/v1/gifs/search');
    url.searchParams.set('api_key', env.GIPHY_API_KEY);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '5');
    url.searchParams.set('rating', 'pg');
    const r = await fetch(url.toString());
    if (!r.ok) {
      return { type: 4, data: {
        content: 'GIPHY search failed (' + r.status + '). Try again.', flags: 64,
      } };
    }
    const j = await r.json();
    results = Array.isArray(j?.data) ? j.data : [];
  } catch (e) {
    return { type: 4, data: {
      content: 'GIPHY search threw: ' + String(e?.message || e), flags: 64,
    } };
  }
  if (!results.length) {
    return { type: 4, data: {
      content: 'No GIFs found for `' + q.slice(0, 40) + '`. Try a different search.',
      flags: 64,
    } };
  }

  const picks = results.slice(0, 5).map((g, i) => ({
    i,
    title: String(g.title || '').slice(0, 80) || 'GIF #' + (i + 1),
    url:   String(g.images?.original?.url
                 || g.images?.fixed_height?.url
                 || g.url || ''),
  })).filter(p => p.url);
  if (picks.length === 0) {
    return { type: 4, data: {
      content: 'GIPHY returned no usable GIFs. Try a different search.',
      flags: 64,
    } };
  }

  const token = (crypto.randomUUID && crypto.randomUUID())
                || Math.random().toString(36).slice(2);
  await env.LOADOUT_BOLTS.put(
    CI2_TOKEN_PREFIX + token,
    JSON.stringify({ picks, message }),
    { expirationTtl: CI2_TOKEN_TTL_S },
  );

  // One embed per GIF + a row of Pick buttons.
  const embeds = picks.map((p, i) => ({
    title: '#' + (i + 1) + ' · ' + p.title,
    image: { url: p.url },
    color: 0x9147ff,
  }));
  const buttons = picks.map((p, i) => ({
    type: 2, style: 2, label: '#' + (i + 1),
    custom_id: CI2_PICK_PREFIX + token + ':' + i,
  }));

  const lines = ['Tap one to post your check-in:'];
  if (message) lines.push(`Your message: _${message.slice(0, 300)}_`);

  return {
    type: 4,
    data: {
      content: lines.join('\n'),
      flags: 64,
      embeds,
      components: [{ type: 1, components: buttons }],
    },
  };
}

export async function handleCheckinPickSubmit(env, data) {
  const userId  = data?.member?.user?.id || data?.user?.id;
  const guildId = data?.guild_id;
  if (!userId || !guildId) {
    return { type: 4, data: { content: 'Run this in a server.', flags: 64 } };
  }
  // Daily check-in moved to the website (2026-07). This is the only
  // place the Discord compose flow commits a check-in (recordCheckin
  // below). The compose modal is disabled (handleCheckinCommand now
  // redirects), so users can't reach here normally — but a GIF-picker
  // ephemeral opened just before deploy could still fire. Refuse to
  // commit and point at aquilo.gg instead.
  return {
    type: 4,
    data: {
      content: '✅ Daily check-in has moved to https://aquilo.gg/checkin — check in there instead.',
      flags: 64,
    },
  };
  // eslint-disable-next-line no-unreachable -- legacy compose-commit path retained for reference / possible re-enable
  const cid = data?.data?.custom_id || '';
  const m = cid.match(/^ci2:pick:([A-Za-z0-9-]+):(\d+)$/);
  if (!m) return { type: 4, data: { content: 'Bad pick ID.', flags: 64 } };
  const token = m[1];
  const idx   = parseInt(m[2], 10);

  const stashed = await env.LOADOUT_BOLTS.get(CI2_TOKEN_PREFIX + token, { type: 'json' });
  if (!stashed?.picks?.[idx]) {
    return { type: 4, data: {
      content: 'That picker expired. Run /checkin again.', flags: 64,
    } };
  }
  const pick    = stashed.picks[idx];
  const message = stashed.message || '';
  const today   = todayET();

  // recordCheckin runs the unified flow: streak / freeze /
  // XP grants / referral milestone / embed post.
  // opts { message, gifUrl } get baked into the embed by
  // postCheckinEmbed (image + first description line).
  const r = await recordCheckin(env, guildId, userId, 'discord', {
    message, gifUrl: pick.url,
  });

  if (r.embed?.posted) {
    // Stash for the OLD aqci:pick PATCH path too, so any stale
    // ephemerals in chat keep working.
    await stashCardPointer(env, guildId, userId, today,
      r.embed.channelId, r.embed.messageId);
  } else if (r.alreadyToday) {
    // Same-day re-pick: PATCH the existing card with the new GIF +
    // (replace) the message line. No streak double-credit
    // because recordCheckin's alreadyToday branch already returned
    // without re-running the streak path.
    const existing = await loadCardPointer(env, guildId, userId, today);
    if (existing?.channelId && existing?.messageId) {
      try {
        const liveRes = await fetch(
          `https://discord.com/api/v10/channels/${existing.channelId}/messages/${existing.messageId}`,
          { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } },
        );
        if (liveRes.ok) {
          const live = await liveRes.json();
          const liveEmbeds = Array.isArray(live?.embeds) ? live.embeds : [];
          if (liveEmbeds[0]) {
            const head = { ...liveEmbeds[0] };
            head.image = { url: pick.url };
            if (message) {
              const desc = String(head.description || '');
              const lines = desc.split('\n');
              // First italic line was the prior message, replace it.
              // Otherwise prepend a fresh one.
              // Blockquote-style replacement (matches the post-time
              // format above). Detects either the legacy `💬 _msg_`
              // prefix OR the new `> _msg_` prefix so re-saves on
              // a pre-existing same-day card don't double-line.
              const blockquoteLike = (s) => /^> _.+_$/.test(s) || /^💬 _.+_$/.test(s);
              if (lines[0] && blockquoteLike(lines[0])) {
                lines[0] = `> _${message.slice(0, 300)}_`;
              } else {
                lines.unshift(`> _${message.slice(0, 300)}_`);
              }
              head.description = lines.join('\n');
            }
            await fetch(
              `https://discord.com/api/v10/channels/${existing.channelId}/messages/${existing.messageId}`,
              { method: 'PATCH',
                headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
                           'Content-Type': 'application/json' },
                body: JSON.stringify({
                  embeds: [head, ...liveEmbeds.slice(1)],
                  allowed_mentions: { parse: [] },
                }) },
            );
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  const lines = [];
  if (r.alreadyToday) {
    lines.push(`✅ Already checked in today. Card updated with the new GIF${message ? ' + message' : ''}. **${r.streak}-day** streak going strong.`);
  } else {
    lines.push(`✅ Checked in! **${r.streak}-day** streak.`);
    if (r.freezeUsed)    lines.push('❄ A **Streak Shield** saved your streak, one shield consumed.');
    if (r.firstTimeNoCard) {
      lines.push(`✨ First time? Customise your check-in card at aquilo.gg${CUSTOMISE_PATH}.`);
    }
    if (!r.embed?.posted && r.embed?.reason !== 'already-today') {
      lines.push(`_(couldn't post the embed: ${r.embed?.reason || 'unknown'}, your check-in still counted.)_`);
    }
  }

  return { type: 7, data: { content: lines.join('\n'), flags: 64,
                            embeds: [], components: [] } };
}
