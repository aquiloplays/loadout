// Twitch event rewards, cross-credit aquilo users for Twitch activity
// (Clay 2026-05-28).
//
// When a Twitch EventSub notification fires (follow / sub / resub /
// gift / cheer / raid), this module resolves the Twitch user to an
// aquilo account via the existing `plink:twitch:<twitchUserId>` →
// aquilo Discord ID linkage, then applies the configured reward:
//
//   follow             +500 bolts (lifetime per Twitch user, no
//                                  refollow exploit)
//   sub Tier 1         +1,500 bolts + "Twitch Sub"     role 30d
//   sub Tier 2         +3,500 bolts + "Twitch Sub T2"  role 30d
//   sub Tier 3         +6,000 bolts + "Twitch Sub T3"  role 30d
//   resub              base * (1 + 0.05 * months), capped at 2× base
//                       (per-tier base; same role grant as sub)
//   gift received      recipient gets full sub-tier reward
//   gift given         giver gets 20% of recipient's bolt reward
//   cheer              floor(bits / 10) bolts
//   raid leader        +1,000 bolts (raiders' per-user rewards skipped
//, channel.raid payload doesn't carry
//                                    individual raider Twitch ids)
//
// Each reward posts a small embed to the `twitch-rewards-feed` channel
// binding so the community can see who earned what. Caller still
// owns the "fancy" gradient-banner event embed (twitch-events.js);
// the reward embed is a sibling, not a replacement.
//
// KV layout:
//   plink:twitch:<twitchUserId>       → aquilo Discord ID (READ ONLY,
//                                       owned by the OAuth linker)
//   twitch-follow-rewarded:<tid>      → '1'  (lifetime flag; no refollow
//                                       exploit)
//   twitch-rewards:role:<gid>:<tier>  → role snowflake (set by
//                                       ensureRewardRoles)
//   twitch-rewards:expiry             → JSON array [{userId, roleId,
//                                       guildId, expiresAtMs}], generic
//                                       expiry list; cron sweeps it.
//
// Anti-abuse:
//   • follow: lifetime KV flag prevents unfollow-then-refollow farming
//   • sub/cheer: no extra anti-abuse, Twitch verifies the purchase
//   • cheer cap: caller's choice; default is no cap (bits cost money,
//     a 10k-bit cheer is intended to reward 1000 bolts)

// (Bolts economy sunset 2026-06: the wallet.js applyVaultDelta import +
// the per-event bolt payouts were removed. This module now grants ONLY
// the sub-tier Discord roles (Twitch Sub / T2 / T3, 30-day expiry) and
// posts the rewards-feed celebration embeds — the non-currency half of
// the feature. grantBolts is kept as a no-op so the per-event handler
// flow is otherwise unchanged.)
import { getChannelBinding } from './channel-bindings.js';

// ── Reward catalogue ────────────────────────────────────────────

const FOLLOW_BOLTS    = 500;
const SUB_BOLTS = Object.freeze({
  '1000': 1500,
  '2000': 3500,
  '3000': 6000,
  'Prime': 1500,   // treat Prime as T1 for rewards
});
const RAID_LEADER_BOLTS = 1000;
const GIFT_GIVER_BONUS_PCT = 0.20;
const RESUB_MONTH_MULTIPLIER = 0.05;
const RESUB_MULT_CAP = 2.0;

const SUB_ROLE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const ROLE_TIER_NAME = Object.freeze({
  '1000':  'Twitch Sub',
  '2000':  'Twitch Sub T2',
  '3000':  'Twitch Sub T3',
  'Prime': 'Twitch Sub',
});
const ROLE_TIER_COLOR = Object.freeze({
  '1000':  0x7c5cff,  // violet
  '2000':  0xff6ab5,  // pink
  '3000':  0x5bff95,  // green, top tier
  'Prime': 0x7c5cff,
});

// ── KV keys ─────────────────────────────────────────────────────

const KV_FOLLOW_FLAG = (tid) => `twitch-follow-rewarded:${tid}`;
const KV_ROLE_BY_TIER = (gid, tier) => `twitch-rewards:role:${gid}:${tier}`;
const KV_EXPIRY_LIST = 'twitch-rewards:expiry';

// ── Discord REST ────────────────────────────────────────────────

async function dapi(env, method, path, body) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, status: 503 };
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord twitch-rewards',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, body: parsed };
}

// ── Resolve Twitch → aquilo ─────────────────────────────────────

async function resolveAquiloId(env, twitchUserId) {
  if (!twitchUserId) return null;
  try {
    const id = await env.LOADOUT_BOLTS.get(`plink:twitch:${twitchUserId}`, { type: 'text' });
    return id || null;
  } catch { return null; }
}

// ── Role provisioning ──────────────────────────────────────────
//
// Creates "Twitch Sub" / "Twitch Sub T2" / "Twitch Sub T3" roles if
// missing, persists their IDs at `twitch-rewards:role:<gid>:<tier>`
// KV. Idempotent, re-running matches existing roles by name.

export async function ensureRewardRoles(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId) return { ok: false, error: 'no-guild-id' };
  // List current guild roles once; match by name.
  const list = await dapi(env, 'GET', `/guilds/${encodeURIComponent(guildId)}/roles`);
  if (!list.ok || !Array.isArray(list.body)) {
    return { ok: false, error: 'roles-fetch-failed', status: list.status };
  }
  const byName = new Map();
  for (const r of list.body) byName.set(String(r.name || '').toLowerCase(), r);
  const result = { ok: true, created: [], reused: [], failed: [] };
  for (const tier of ['1000', '2000', '3000']) {
    const name = ROLE_TIER_NAME[tier];
    const color = ROLE_TIER_COLOR[tier];
    let roleId = await env.LOADOUT_BOLTS.get(KV_ROLE_BY_TIER(guildId, tier)).catch(() => null);
    if (roleId) {
      result.reused.push({ tier, roleId, source: 'kv' });
      continue;
    }
    const existing = byName.get(name.toLowerCase());
    if (existing?.id) {
      await env.LOADOUT_BOLTS.put(KV_ROLE_BY_TIER(guildId, tier), String(existing.id));
      result.reused.push({ tier, roleId: String(existing.id), source: 'discord-existing' });
      continue;
    }
    const create = await dapi(env, 'POST',
      `/guilds/${encodeURIComponent(guildId)}/roles`, {
        name, color,
        mentionable: false,
        hoist: false,
        permissions: '0',
      });
    if (!create.ok || !create.body?.id) {
      result.failed.push({ tier, status: create.status, body: create.body });
      continue;
    }
    await env.LOADOUT_BOLTS.put(KV_ROLE_BY_TIER(guildId, tier), String(create.body.id));
    result.created.push({ tier, roleId: String(create.body.id), name });
  }
  return result;
}

// ── Role expiry tracking ────────────────────────────────────────

async function loadExpiryList(env) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(KV_EXPIRY_LIST, { type: 'json' });
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
async function saveExpiryList(env, list) {
  await env.LOADOUT_BOLTS.put(KV_EXPIRY_LIST, JSON.stringify(list));
}

async function scheduleRoleRemoval(env, guildId, userId, roleId, durationMs) {
  const list = await loadExpiryList(env);
  const expiresAtMs = Date.now() + durationMs;
  const i = list.findIndex(e => e.userId === userId && e.roleId === roleId && e.guildId === guildId);
  if (i >= 0) {
    // Refresh the expiry to the later of the two (re-sub during an
    // active role period extends, doesn't restart-shorter).
    if (expiresAtMs > list[i].expiresAtMs) list[i].expiresAtMs = expiresAtMs;
  } else {
    list.push({ userId, roleId, guildId, expiresAtMs });
  }
  await saveExpiryList(env, list);
}

// Cron entry, sweeps expired sub-tier roles. Same retry-on-failure
// shape as the counting.js sweep fix: 404 → drop, other → keep with
// retries counter, max 24 attempts.
const MAX_RETRIES = 24;

function isDiscord404(err) {
  return String(err?.message || '').includes('Discord 404');
}

export async function sweepExpiredRewardRoles(env) {
  const list = await loadExpiryList(env);
  if (!list.length) return { swept: 0, retried: 0, abandoned: 0 };
  const now = Date.now();
  const keep = [];
  let swept = 0, retried = 0, abandoned = 0;
  for (const e of list) {
    if (e.expiresAtMs > now) { keep.push(e); continue; }
    let success = false, err = null;
    try {
      const r = await dapi(env, 'DELETE',
        `/guilds/${encodeURIComponent(e.guildId)}/members/${encodeURIComponent(e.userId)}/roles/${encodeURIComponent(e.roleId)}`);
      if (r.ok || r.status === 204 || r.status === 404) success = true;
      else err = new Error(`Discord ${r.status}`);
    } catch (caught) { err = caught; }
    if (success || isDiscord404(err)) { swept++; continue; }
    const tries = (e.retries || 0) + 1;
    if (tries >= MAX_RETRIES) {
      console.warn('[twitch-rewards] sweep abandoning', e.userId, '@', e.guildId, 'err:', err?.message || err);
      abandoned++;
      continue;
    }
    keep.push({ ...e, retries: tries });
    retried++;
  }
  if (swept || retried || abandoned) await saveExpiryList(env, keep);
  return { swept, retried, abandoned };
}

// ── Grant primitives ────────────────────────────────────────────

// (Bolts economy sunset: this is now a no-op. The per-event handlers
// still call it so their control flow is unchanged, but no currency is
// minted — they proceed to grant the sub-tier role + post the feed
// embed regardless.)
async function grantBolts(_env, _guildId, _userId, _amount, _reason) {
  return { ok: true, amount: 0 };
}

async function grantSubRoleWithExpiry(env, guildId, userId, tier) {
  const roleId = await env.LOADOUT_BOLTS.get(KV_ROLE_BY_TIER(guildId, tier)).catch(() => null);
  if (!roleId) return { ok: false, reason: 'role-not-provisioned' };
  const add = await dapi(env, 'PUT',
    `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`);
  if (!add.ok && add.status !== 204) {
    return { ok: false, reason: 'role-add-failed', status: add.status };
  }
  await scheduleRoleRemoval(env, guildId, userId, roleId, SUB_ROLE_DURATION_MS);
  return { ok: true, roleId, expiresInDays: 30 };
}

// ── Rewards-feed embed ──────────────────────────────────────────

const EMBED_COLOR = 0x7c5cff;

async function postRewardEmbed(env, guildId, payload) {
  const channelId = await getChannelBinding(env, guildId, 'twitch-rewards-feed');
  if (!channelId) return { skipped: 'no-channel' };
  const r = await dapi(env, 'POST',
    `/channels/${channelId}/messages`, {
      embeds: [{
        color:       EMBED_COLOR,
        author:      payload.author,
        description: payload.description,
        footer:      payload.footer,
        timestamp:   new Date().toISOString(),
      }],
      allowed_mentions: { parse: [] },
    });
  return { ok: r.ok, status: r.status, messageId: r.body?.id };
}

// ── Public: per-event grant entry ───────────────────────────────
//
// Caller (twitch-events.js handle*) passes:
//   env, twitchUserId, eventType, eventData
//
// eventType: 'follow' | 'sub' | 'resub' | 'gift-received' | 'gift-given'
//          | 'cheer' | 'raid'
//
// eventData carries the per-event-shape fields the handlers already
// pulled from the EventSub payload (e.g. { tier, bits, viewers,
// streakMonths, cumulativeMonths, recipientTwitchUserId, total }).
//
// Returns { ok, action, granted: [...], skipped?, embed? }.
// Never throws, all error paths return ok:false with a `reason`.

export async function grantTwitchEventReward(env, twitchUserId, eventType, eventData = {}) {
  const guildId = env.AQUILO_VAULT_GUILD_ID;
  if (!guildId) return { ok: false, reason: 'no-guild' };
  if (!twitchUserId) return { ok: false, reason: 'no-twitch-user' };

  const aquiloId = await resolveAquiloId(env, twitchUserId);
  if (!aquiloId) return { ok: false, reason: 'not-aquilo-linked', twitchUserId };

  switch (eventType) {
    case 'follow':           return await handleFollowReward(env, guildId, aquiloId, twitchUserId, eventData);
    case 'sub':              return await handleSubReward(env, guildId, aquiloId, twitchUserId, eventData, false);
    case 'resub':            return await handleSubReward(env, guildId, aquiloId, twitchUserId, eventData, true);
    case 'gift-received':    return await handleSubReward(env, guildId, aquiloId, twitchUserId, eventData, false);
    case 'gift-given':       return await handleGiftGivenReward(env, guildId, aquiloId, twitchUserId, eventData);
    case 'cheer':            return await handleCheerReward(env, guildId, aquiloId, twitchUserId, eventData);
    case 'raid':             return await handleRaidLeaderReward(env, guildId, aquiloId, twitchUserId, eventData);
    default:
      return { ok: false, reason: 'unknown-event-type', eventType };
  }
}

// ── Per-event handlers ─────────────────────────────────────────

async function handleFollowReward(env, guildId, aquiloId, twitchUserId, ev) {
  // Lifetime anti-abuse flag.
  const flag = await env.LOADOUT_BOLTS.get(KV_FOLLOW_FLAG(twitchUserId)).catch(() => null);
  if (flag) return { ok: true, action: 'skipped-already-rewarded' };
  await grantBolts(env, guildId, aquiloId, FOLLOW_BOLTS, 'twitch:follow');
  await env.LOADOUT_BOLTS.put(KV_FOLLOW_FLAG(twitchUserId), '1');
  // Durable per-user entitlement record (stream check-in card badges).
  try {
    const { recordFollowEntitlement } = await import('./stream-checkin.js');
    await recordFollowEntitlement(env, guildId, aquiloId, Number(ev.followedAt) || Date.now());
  } catch { /* entitlement record best-effort */ }
  const embed = await postRewardEmbed(env, guildId, {
    author: { name: ev.userName || 'New follower' },
    description: `📡 <@${aquiloId}> followed on Twitch — welcome!`,
    footer: { text: 'First follow only · refollowing later doesn\'t re-trigger' },
  });
  return { ok: true, action: 'granted', granted: [], embed };
}

async function handleSubReward(env, guildId, aquiloId, twitchUserId, ev, isResub) {
  const tier = String(ev.tier || '1000');
  // (Bolts economy sunset: the resub bolt multiplier math was dropped;
  // `months` is kept only for the celebration message.)
  let months = 0;
  if (isResub) {
    months = Number(ev.cumulativeMonths || ev.streakMonths || 0);
  }
  // (Bolts payout removed; the sub-tier role grant below is the
  // surviving reward.)
  await grantBolts(env, guildId, aquiloId, 0, isResub ? 'twitch:resub' : 'twitch:sub');
  try {
    const { recordSubEntitlement } = await import('./stream-checkin.js');
    await recordSubEntitlement(env, guildId, aquiloId, tier);
  } catch { /* entitlement record best-effort */ }
  const role = await grantSubRoleWithExpiry(env, guildId, aquiloId, tier);
  const tierLabel = tier === '2000' ? 'Tier 2' : tier === '3000' ? 'Tier 3' : 'Tier 1';
  const desc = isResub
    ? `💜 **Resub at ${tierLabel}** (${months} months) → <@${aquiloId}> keeps the **${ROLE_TIER_NAME[tier]}** role for 30 days.`
    : `🌟 **New ${tierLabel} sub** → <@${aquiloId}> gets the **${ROLE_TIER_NAME[tier]}** role for 30 days.`;
  const embed = await postRewardEmbed(env, guildId, {
    author: { name: ev.userName || 'Subscriber' },
    description: desc,
  });
  return { ok: true, action: 'granted', granted: [{ role: role.ok ? role.roleId : null }], embed };
}

async function handleGiftGivenReward(env, guildId, aquiloId, twitchUserId, ev) {
  // (Bolts payout removed; the gift-entitlement record — which drives
  // stream check-in card badges — and the feed shout-out stay.)
  const tier = String(ev.tier || '1000');
  const count = Math.max(1, Number(ev.total) || 1);
  await grantBolts(env, guildId, aquiloId, 0, 'twitch:gift-given');
  try {
    const { addGiftEntitlement } = await import('./stream-checkin.js');
    await addGiftEntitlement(env, guildId, aquiloId, count);
  } catch { /* entitlement record best-effort */ }
  const desc = count > 1
    ? `🎁 <@${aquiloId}> **gifted ${count} ${tier === '3000' ? 'Tier 3' : tier === '2000' ? 'Tier 2' : 'Tier 1'} subs** — thank you!`
    : `🎁 <@${aquiloId}> **gifted a ${tier === '3000' ? 'Tier 3' : tier === '2000' ? 'Tier 2' : 'Tier 1'} sub** — thank you!`;
  const embed = await postRewardEmbed(env, guildId, {
    author: { name: ev.userName || 'Gifter' },
    description: desc,
  });
  return { ok: true, action: 'granted', granted: [], embed };
}

async function handleCheerReward(env, guildId, aquiloId, twitchUserId, ev) {
  const bits = Math.max(0, Number(ev.bits) || 0);
  if (bits <= 0) return { ok: true, action: 'skipped-zero' };
  // (Bolts payout removed; the cheer-entitlement record + shout-out stay.)
  await grantBolts(env, guildId, aquiloId, 0, 'twitch:cheer');
  try {
    const { addCheerEntitlement } = await import('./stream-checkin.js');
    await addCheerEntitlement(env, guildId, aquiloId, bits);
  } catch { /* entitlement record best-effort */ }
  const embed = await postRewardEmbed(env, guildId, {
    author: { name: ev.userName || 'Cheerer' },
    description: `💎 <@${aquiloId}> **cheered ${bits.toLocaleString()} bits** — thank you!`,
  });
  return { ok: true, action: 'granted', granted: [], embed };
}

async function handleRaidLeaderReward(env, guildId, aquiloId, twitchUserId, ev) {
  // (Bolts payout removed; the raid shout-out stays.)
  await grantBolts(env, guildId, aquiloId, 0, 'twitch:raid-leader');
  const viewers = Number(ev.viewers || 0);
  const embed = await postRewardEmbed(env, guildId, {
    author: { name: ev.fromBroadcasterName || 'Raider' },
    description: `⚔️ <@${aquiloId}> **raided with ${viewers.toLocaleString()} viewer${viewers === 1 ? '' : 's'}** — thanks for the raid!`,
  });
  return { ok: true, action: 'granted', granted: [], embed };
}
