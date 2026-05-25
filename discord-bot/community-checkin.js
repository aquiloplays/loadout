// Daily community check-in — unified across the website and Discord.
//
// This is check-in #1, the "community daily check-in." It is DISTINCT
// from the Twitch-extension stream check-in in ext.js (which lives on
// `checkin:<g>:<u>` with `tw:<twitchId>` userIds and protects with the
// 'stream'-type freeze). The earlier Discord pic-attachment check-in
// in aquilo-bot/checkin.js was retired 2026-05 — this module is the
// single Discord-side community check-in going forward.
//
// User-facing contract (per Clay):
//   • A viewer can check in from aquilo.gg OR from Discord — the two
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
//   • Daily bonuses are made AVAILABLE TO COLLECT — not auto-granted.
//     /web/checkin/bonus/collect drains the queue.
//
// KV layout (all on LOADOUT_BOLTS):
//   community-checkin:<g>:<u>        — streak state
//     { streak, longest, lastDayEt, total, lastUtc, lastSurface }
//   checkin-card:<g>:<u>             — site-controlled embed customisation
//     { imageUrl, accentColor?, headline?, subtitle?, updatedUtc }
//   community-checkin-bonus:<g>:<u>  — queue of unclaimed bonuses
//     { pending: [{ id, kind, amount, label, grantedUtc }] }

import { earn, getWallet } from './wallet.js';
import { consumeFreeze, getFreezes } from './streak-freeze.js';
import { getCheckinChannel } from './admin-menu.js';

const STATE_KEY = (g, u) => `community-checkin:${g}:${u}`;
const CARD_KEY  = (g, u) => `checkin-card:${g}:${u}`;
const QUEUE_KEY = (g, u) => `community-checkin-bonus:${g}:${u}`;

// Daily payout — base bolts the user can claim once per day after
// checking in. Mirrors the Discord pic-checkin reward so retiring that
// surface in favour of this one doesn't change the economy.
export const DAILY_BASE_BOLTS = 5;
export const STREAK_MILESTONES = [
  { day: 7,   amount: 5,  label: '7-day streak!'   },
  { day: 30,  amount: 15, label: '30-day streak!'  },
  { day: 100, amount: 50, label: '100-day streak!' },
];

// Brand defaults. Per-guild overrides via branding.js (getBranding);
// per-user overrides via the saved checkin-card record (highest
// precedence). Kept here as the final fallback.
const DEFAULT_ACCENT = 0xF47FFF;
const DEFAULT_IMAGE_URL =
  'https://aquilo.gg/sprites/checkin/default-card.png';
// Where the website hosts the "customise your card" page — derived
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
export async function putCard(env, guildId, userId, card) {
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

async function loadQueue(env, guildId, userId) {
  return (await env.LOADOUT_BOLTS.get(QUEUE_KEY(guildId, userId), { type: 'json' }))
    || { pending: [] };
}
async function saveQueue(env, guildId, userId, q) {
  await env.LOADOUT_BOLTS.put(QUEUE_KEY(guildId, userId), JSON.stringify(q));
}

function bonusId(kind, day, salt) {
  return kind + '-' + day + (salt ? '-' + salt : '');
}

async function enqueueBonus(env, guildId, userId, bonus) {
  const q = await loadQueue(env, guildId, userId);
  // De-dup by id — re-firing the same bonus on a same-day retry
  // shouldn't double-pay.
  if (q.pending.some(b => b.id === bonus.id)) return q;
  q.pending.push(bonus);
  await saveQueue(env, guildId, userId, q);
  return q;
}

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

async function postCheckinEmbed(env, guildId, userId, state, card, member, isFirstTimeNoCard) {
  const channel = await getCheckinChannel(env, guildId);
  if (!channel?.channelId) return { posted: false, reason: 'channel-unbound' };

  // Per-guild branding (siteUrl, accent, defaultImage). Card-level
  // override (if the user customised) wins over branding which wins
  // over the global defaults at the top of this file.
  const { getBranding } = await import('./branding.js');
  const brand   = await getBranding(env, guildId);
  const accent  = (card?.accentColor != null ? card.accentColor : (brand.accentColor || DEFAULT_ACCENT));
  const image   = card?.imageUrl || brand.checkinDefaultImageUrl || DEFAULT_IMAGE_URL;
  const display = member?.displayName || 'friend';
  const avatarPick = await resolveAvatar(env, userId, card, member);
  const avatar     = avatarPick.url;

  // Description rules:
  //   • Streak line is always present.
  //   • Headline (if set) renders above the streak in italics.
  //   • Subtitle (if set) renders below.
  //   • First-time-with-no-card adds the "customise your card" hint.
  const lines = [];
  if (card?.headline) lines.push(`_${card.headline}_`);
  lines.push(`🔥 **${state.streak}-day streak**` + (state.longest > state.streak ? `  · best ${state.longest}` : ''));
  if (card?.subtitle) lines.push(card.subtitle);
  if (isFirstTimeNoCard) {
    lines.push('');
    lines.push(`✨ _Customise your check-in card at_ ${brand.siteUrl}${CUSTOMISE_PATH}`);
  }

  const embed = {
    author: { name: `${display} checked in`, icon_url: avatar },
    description: lines.join('\n'),
    color: accent,
    image: { url: image },
    timestamp: new Date().toISOString(),
  };

  const r = await fetch(`https://discord.com/api/v10/channels/${channel.channelId}/messages`, {
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
  return { posted: true, channelId: channel.channelId, messageId: m?.id || null,
           avatarSource: avatarPick.source };
}

// ── Core unified check-in ──────────────────────────────────────────────
// Returns:
//   {
//     ok, alreadyToday, streak, longest, freezeUsed,
//     pendingBonusCount, embed: { posted, channelId?, messageId?, reason? },
//     firstTimeNoCard,
//   }
//
// `source` is informational only ('web' | 'discord' | 'system') and
// recorded into the state record so we can see which surface fired
// each user's last check-in.
export async function recordCheckin(env, guildId, userId, source = 'web') {
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };

  const now    = Date.now();
  const today  = todayET(new Date(now));
  const prev   = await loadState(env, guildId, userId);
  const card   = await getCard(env, guildId, userId);
  const firstTimeNoCard = !card && !prev;   // exactly first ever, no card

  // Same-day idempotency. Both surfaces can call freely; only the
  // first call of the ET day does work.
  if (prev?.lastDayEt === today) {
    const q = await loadQueue(env, guildId, userId);
    return {
      ok: true,
      alreadyToday: true,
      streak:  prev.streak,
      longest: prev.longest,
      freezeUsed: false,
      pendingBonusCount: q.pending.length,
      embed: { posted: false, reason: 'already-today' },
      firstTimeNoCard: false,
    };
  }

  // Streak math.
  let freezeUsed = false;
  let nextStreak;
  if (!prev) {
    nextStreak = 1;
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

  // Enqueue the daily bonus + any milestone hit today. The user
  // collects these from the website via /web/checkin/bonus/collect.
  await enqueueBonus(env, guildId, userId, {
    id:         bonusId('daily', today),
    kind:       'daily',
    amount:     DAILY_BASE_BOLTS,
    label:      'Daily check-in bolts',
    grantedUtc: now,
  });
  for (const m of STREAK_MILESTONES) {
    if (nextStreak === m.day) {
      await enqueueBonus(env, guildId, userId, {
        id:         bonusId('streak-' + m.day, today),
        kind:       'milestone',
        amount:     m.amount,
        label:      m.label,
        grantedUtc: now,
      });
    }
  }

  // Post the embed (best-effort — a failure here doesn't roll back
  // the check-in itself; the user still got their streak + bonuses).
  const member = await fetchMemberInfo(env, guildId, userId);
  const embed  = await postCheckinEmbed(env, guildId, userId, state, card, member, firstTimeNoCard);

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

  // ✨ Very-rare Voltaic lucky-drop on each successful daily check-in
  // (seeded on the ET-day so a user can't re-roll within the same
  // day). When it hits, the pack lands in their pending-packs queue
  // — opened the next time they play Boltbound. Non-fatal: any
  // failure here doesn't roll back the check-in itself.
  let luckyVoltaic = null;
  try {
    const { rollVoltaicLuckyDrop } = await import('./cards-packs.js');
    luckyVoltaic = await rollVoltaicLuckyDrop(
      env, guildId, userId, 'checkin', `checkin:${today}`
    );
  } catch { /* non-fatal */ }

  const q = await loadQueue(env, guildId, userId);
  return {
    ok: true,
    alreadyToday: false,
    streak:  state.streak,
    longest: state.longest,
    freezeUsed,
    pendingBonusCount: q.pending.length,
    embed,
    firstTimeNoCard,
    // Present only on the rare lottery win. Site/Discord reply can
    // surface a "you got a Voltaic pack!" celebration — the pack is
    // already in their pending queue and opens via the existing
    // Boltbound pack-open flow.
    luckyVoltaic: luckyVoltaic ? { id: luckyVoltaic.id, packType: 'voltaic' } : null,
  };
}

// Read-only status for the website's "you can check in" / "X bonuses
// to collect" notifications.
export async function getStatus(env, guildId, userId) {
  const state = await loadState(env, guildId, userId);
  const card  = await getCard(env, guildId, userId);
  const queue = await loadQueue(env, guildId, userId);
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
    pendingBonuses: queue.pending,         // full list (id+kind+amount+label+grantedUtc)
    streakShields: freezes.discord || 0,   // 'discord'-type freezes = check-in shields
  };
}

// Collect one bonus by id, or all if bonusId === 'all'. Credits the
// wallet and removes from the queue. Idempotent — collecting an
// already-collected id returns { ok:true, alreadyCollected:true }.
export async function collectBonus(env, guildId, userId, claimId) {
  const queue = await loadQueue(env, guildId, userId);
  if (!queue.pending.length) {
    return { ok: true, collected: [], balance: (await getWallet(env, guildId, userId)).balance };
  }

  const toCollect = (claimId === 'all')
    ? queue.pending.slice()
    : queue.pending.filter(b => b.id === claimId);
  if (toCollect.length === 0) {
    return { ok: true, alreadyCollected: true, balance: (await getWallet(env, guildId, userId)).balance };
  }

  let totalCredited = 0;
  for (const b of toCollect) {
    await earn(env, guildId, userId, b.amount, 'community-checkin:' + b.id);
    totalCredited += b.amount;
  }
  // Drop collected items from the queue.
  queue.pending = queue.pending.filter(b => !toCollect.some(c => c.id === b.id));
  await saveQueue(env, guildId, userId, queue);

  const w = await getWallet(env, guildId, userId);
  return {
    ok: true,
    collected: toCollect.map(b => ({ id: b.id, kind: b.kind, amount: b.amount, label: b.label })),
    totalCredited,
    balance: w.balance || 0,
    remaining: queue.pending.length,
  };
}

// ── Discord /checkin slash command ─────────────────────────────────────
// Interaction-based, so it works without the gateway shim.
export async function handleCheckinCommand(env, data) {
  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  if (!guildId || !userId) {
    return { type: 4, data: { content: 'Run this in a server.', flags: 64 } };
  }
  const r = await recordCheckin(env, guildId, userId, 'discord');

  if (r.alreadyToday) {
    return {
      type: 4,
      data: {
        content: `✅ You've already checked in today. **${r.streak}-day** streak going strong.`
          + (r.pendingBonusCount ? `\n🎁 You have **${r.pendingBonusCount}** unclaimed bonus${r.pendingBonusCount > 1 ? 'es' : ''} — collect on aquilo.gg/profile.` : ''),
        flags: 64,
      },
    };
  }

  const lines = [`✅ Checked in! **${r.streak}-day** streak.`];
  if (r.freezeUsed) lines.push('❄ A **Streak Shield** saved your streak — one shield consumed.');
  if (r.luckyVoltaic) lines.push('⚡ **JACKPOT** — a **Voltaic pack** dropped! Open it via `/boltbound`.');
  if (r.pendingBonusCount) {
    lines.push(`🎁 **${r.pendingBonusCount}** bonus${r.pendingBonusCount > 1 ? 'es' : ''} ready to collect on aquilo.gg/profile.`);
  }
  if (r.firstTimeNoCard) {
    lines.push(`✨ First time? Customise your check-in card at aquilo.gg${CUSTOMISE_PATH}.`);
  }
  if (!r.embed.posted && r.embed.reason !== 'already-today') {
    lines.push(`_(couldn't post the embed: ${r.embed.reason} — your check-in still counted.)_`);
  }
  return { type: 4, data: { content: lines.join('\n'), flags: 64 } };
}
