// Channel hubs, phase 1: thin menu embeds for high-traffic channels
// (#check-in, #character, #bolts, #play, #achievements).
//
// Each hub is a persistent embed with a row of buttons that
// route to existing surfaces:
//
//   • Some buttons emit a custom_id the existing dispatcher
//     handles (e.g. `aqci:search` → /checkin gif picker)
//   • Some buttons open ephemeral content rendered here
//   • Some are LINK buttons pointing at aquilo.gg
//
// The hubs are ADDITIVE, slash commands keep working. The point
// is one-tap discovery in the room people already hang out in.
//
// Hub catalogue + builders are pure data; the dispatcher routes
// `<key>:` button clicks to per-key handlers below.
//
// KV: <key>:hub-msg:<g> tracks the message id per hub (same
// convention as the LFG / onboarding hubs).
//
// Phase 2 (deferred per Clay): stocks, bets, referrals, vault.

import { getChannelBinding } from './channel-bindings.js';
import { getBranding } from './branding.js';

const HUB_MSG_KEY = (key, g) => `${key}:hub-msg:${g}`;

const RESP_CHAT          = 4;
const RESP_MODAL         = 9;
const FLAG_EPHEMERAL     = 64;
const COMPONENT_ROW      = 1;
const COMPONENT_BUTTON   = 2;
const COMPONENT_TEXT_INPUT = 4;
const TEXT_INPUT_SHORT   = 1;
const BTN_PRIMARY        = 1;
const BTN_SECONDARY      = 2;
const BTN_SUCCESS        = 3;
const BTN_DANGER         = 4;
const BTN_LINK           = 5;

// Phase-1 hub catalogue. Each entry's `channelHints` is the
// substring list `pickChannel` checks when no explicit channelId/
// channelName is passed.
const HUBS = Object.freeze({
  checkin: {
    title: '✅ Daily Check-in',
    color: 0x42c97a,
    channelHints: ['check-in', 'checkin', 'daily'],
    description:
      'Check in once a day to build a streak.\n\n' +
      '• Tap **Check in now** to log today and pick a GIF for your card\n' +
      '• **My streak** shows your current run',
    footer: '/checkin still works if you prefer typing.',
    buttons: () => [
      { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Check in now',  custom_id: 'checkin:run'    },
      { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My streak',     custom_id: 'checkin:streak' },
    ],
  },
  // (Bolts economy sunset 2026-06: the `bolts` (wallet) and `play`
  // (Boltbound + quick games) hubs were removed from the catalogue.)
  achievements: {
    title: '🏆 Achievements',
    color: 0xff9d6c,
    channelHints: ['achievement', 'milestone'],
    description:
      'Climb the ladder. Achievements grant XP.\n\n' +
      '• **My achievements**, what you\'ve unlocked\n' +
      '• **Catalogue**, what\'s out there to chase\n' +
      '• **Top XP**, leaderboard',
    footer: '/passport still shows your full profile.',
    buttons: () => [
      { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'My achievements', custom_id: 'ach:mine' },
      { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Catalogue',       custom_id: 'ach:catalog' },
      { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Top XP',          custom_id: 'ach:topxp' },
    ],
  },
});

// All accepted hub keys for the admin endpoint + dispatcher. Stable
// per BINDING_KEYS additions in channel-bindings.js (the values
// here MUST match a binding key).
export const HUB_KEYS = Object.keys(HUBS);

// Default-hint channel discovery used by the admin route when no
// explicit id/name is supplied.
export function pickHubChannel(channels, hub, opts = {}) {
  const list = (Array.isArray(channels) ? channels : []).filter(c => c && c.type === 0);
  if (opts.channelId) {
    const explicit = list.find(c => String(c.id) === String(opts.channelId));
    return explicit ? { id: explicit.id, name: explicit.name || '' } : null;
  }
  if (opts.channelName) {
    const needle = String(opts.channelName).toLowerCase();
    const hit = list.find(c => String(c.name || '').toLowerCase().includes(needle));
    return hit ? { id: hit.id, name: hit.name || '' } : null;
  }
  for (const hint of (hub.channelHints || [])) {
    const needle = hint.toLowerCase();
    const hit = list.find(c => String(c.name || '').toLowerCase().includes(needle));
    if (hit) return { id: hit.id, name: hit.name || '' };
  }
  return null;
}

// ── Embed builder ────────────────────────────────────────────────

export async function buildHubEmbed(env, guildId, key) {
  const hub = HUBS[key];
  if (!hub) return null;
  const brand = await getBranding(env, guildId);
  // Hubs may declare either `.buttons` (single row, ≤5 components)
  // OR `.rows` (multi-row, each row ≤5 components). The play hub
  // uses rows because it now carries 6 surfaces.
  let rows;
  if (typeof hub.rows === 'function') {
    rows = await hub.rows(env, guildId);
  } else if (Array.isArray(hub.rows)) {
    rows = hub.rows;
  } else {
    const buttons = await (typeof hub.buttons === 'function' ? hub.buttons(env, guildId) : hub.buttons);
    rows = [buttons];
  }
  return {
    embed: {
      title: hub.title,
      description: hub.description,
      color: hub.color || brand.accentColor || 0x9147ff,
      footer: hub.footer ? { text: hub.footer } : undefined,
    },
    components: rows.map(r => ({ type: COMPONENT_ROW, components: r })),
  };
}

// ── Shared poster ────────────────────────────────────────────────

export async function postHub(env, guildId, key, channelId) {
  if (!HUBS[key])      return { ok: false, error: 'unknown-hub-key', allowed: HUB_KEYS };
  if (!channelId)      return { ok: false, error: 'no-channel-id' };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };

  let deletedPrior = false;
  try {
    const prior = await env.LOADOUT_BOLTS.get(HUB_MSG_KEY(key, guildId), { type: 'json' });
    if (prior?.channelId && prior?.messageId) {
      const del = await fetch(
        `https://discord.com/api/v10/channels/${prior.channelId}/messages/${prior.messageId}`,
        { method: 'DELETE', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord channel-hubs' } },
      );
      if (del.ok || del.status === 204 || del.status === 404) deletedPrior = true;
    }
  } catch { /* idle */ }

  const built = await buildHubEmbed(env, guildId, key);
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord channel-hubs',
    },
    body: JSON.stringify({ embeds: [built.embed], components: built.components, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: 'post-failed', status: r.status, body: t.slice(0, 200) };
  }
  const j = await r.json();
  await env.LOADOUT_BOLTS.put(HUB_MSG_KEY(key, guildId),
    JSON.stringify({ channelId, messageId: j.id, postedAt: Date.now() }));
  return { ok: true, key, channelId, messageId: j.id, deletedPrior };
}

// Admin HTTP entry, resolves channel via opts → KV channel-binding
// (channel-bindings.js uses the same hub key as the binding key) →
// guild-channel name hints. Returns a clear "create the channel
// first" error when nothing matches.
export async function postHubForGuild(env, guildId, key, opts = {}) {
  if (!HUBS[key]) return { ok: false, error: 'unknown-hub-key', allowed: HUB_KEYS };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  let pick;
  if (opts.channelId) {
    pick = { id: String(opts.channelId), name: '' };
  } else {
    const chRes = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord channel-hubs' },
    });
    if (!chRes.ok) return { ok: false, error: 'channels-fetch-failed', status: chRes.status };
    const channels = await chRes.json();
    if (opts.channelName) {
      pick = pickHubChannel(channels, HUBS[key], { channelName: opts.channelName });
    } else {
      // Resolution: KV binding (channel-bindings) > hub.channelHints.
      const bound = await getChannelBinding(env, guildId, key);
      if (bound) {
        const inGuild = channels.find(c => c && String(c.id) === String(bound) && c.type === 0);
        if (inGuild) pick = { id: String(inGuild.id), name: inGuild.name || '' };
      }
      if (!pick) pick = pickHubChannel(channels, HUBS[key], {});
    }
    if (!pick) {
      return {
        ok: false,
        error: 'no-channel-match',
        message: `No channel matched any of: ${(HUBS[key].channelHints || []).join(', ')}. Create a text channel that matches one of those hints OR bind explicitly via /admin/channels/bind with binding="${key}".`,
        tried: HUBS[key].channelHints,
      };
    }
  }
  const post = await postHub(env, guildId, key, pick.id);
  if (!post.ok) return { ok: false, error: post.error, channelId: pick.id, channelName: pick.name, status: post.status, body: post.body };
  return { ok: true, key, channelId: pick.id, channelName: pick.name, messageId: post.messageId, deletedPrior: post.deletedPrior };
}

// ── Component dispatchers ───────────────────────────────────────
//
// Each hub-specific prefix routes through here. Most buttons just
// open ephemeral content rendered inline; a few delegate to
// existing handlers (the GIF picker for checkin:run, /loadout
// surface for bolts:*).

const eph = (content) => ({ type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } });
const ephEmbed = (embed, extra = {}) => ({
  type: RESP_CHAT,
  data: { embeds: [embed], flags: FLAG_EPHEMERAL, ...extra },
});

// checkin:*, defer the actual check-in flow to the existing
// aqci:* dispatcher already wired up. checkin:run kicks off the
// gif picker by re-emitting the search button click; the other
// two render ephemeral content here.
export async function handleCheckinHubComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const action = cid.split(':')[1];
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return eph('Run this in a server.');

  if (action === 'run') {
    // Re-emit through the canonical /checkin slash handler. The
    // older alias `handleCheckinSlashCommand` in aquilo/checkin-slash.js
    // was retired during the May 2026 consolidation, calling it
    // crashed with "interaction failed" because the import resolved
    // to undefined. handleCheckinCommand in community-checkin.js
    // reads only data.guild_id + data.member.user.id so it's
    // happy with a button-interaction shape (no .options needed).
    const { handleCheckinCommand } = await import('./community-checkin.js');
    return handleCheckinCommand(env, data);
  }
  if (action === 'streak') {
    try {
      const { getStatus } = await import('./community-checkin.js');
      const s = await getStatus(env, guildId, userId);
      return ephEmbed({
        title: '🔥 Your check-in streak',
        description: `Current: **${s.current || 0}** · Best: **${s.longest || 0}** · Total: **${s.total || 0}**`,
        color: 0x42c97a,
      });
    } catch {
      return eph('Streak data isn\'t available yet.');
    }
  }
  if (action === 'daily') {
    return eph('Tap **Check in now** above to log today\'s check-in.');
  }
  return eph('Unknown check-in action: ' + cid);
}

// (Bolts economy sunset 2026-06: handleBoltsHubComponent,
// handleBoltsTransferModal and handlePlayHubComponent were removed —
// they fronted the wallet, Boltbound, and quick-games surfaces that
// imported wallet.js / cards-*.js / games*.js.)

// ach:*
export async function handleAchievementsHubComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const action = cid.split(':')[1];
  const userId = data.member?.user?.id || data.user?.id;
  if (!userId) return eph('Run this in a server.');

  if (action === 'mine') {
    // Pull live data inline instead of punting to /passport.
    let xpLine = '_no XP yet_';
    let tierLine = '';
    let achLine = '';
    try {
      const { readXpDisplay } = await import('./progression/xp.js');
      const x = await readXpDisplay(env, userId);
      xpLine = `**L${x.level}** · ${x.xp.toLocaleString()} XP · ${x.pct}% to L${x.nextLevel}`;
    } catch { /* idle */ }
    // (Bolts economy sunset: the level-tier-roles lookup was removed.)
    try {
      const { readAchievementsDisplay } = await import('./progression/achievements.js');
      const ach = await readAchievementsDisplay(env, userId).catch(() => null);
      const unlocked = ach && (ach.unlocked || ach.completed || []);
      if (Array.isArray(unlocked) && unlocked.length > 0) {
        const recent = unlocked.slice(-5).reverse();
        achLine = '\n\n**Recent unlocks**\n' + recent.map(a => `• ${a.id || a.key || a.name || a}`).join('\n');
      }
    } catch { /* idle */ }
    const brand = await getBranding(env, guildId);
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🏆 Your achievements',
          description: xpLine + tierLine + achLine,
          color: 0xff9d6c,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Full passport',  url: `${brand.siteUrl || 'https://aquilo.gg'}/passport` },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Quest checklist', url: `${brand.siteUrl || 'https://aquilo.gg'}/quest` },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }
  if (action === 'catalog') {
    const brand = await getBranding(env, guildId);
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '📚 Achievement catalogue',
          description:
            'Categories:\n' +
            '• 🔢 Counting, streaks + perfect runs in #counting\n' +
            '• ✅ Check-in, daily / milestone\n' +
            '• 🃏 Boltbound, collection / battle / win streak\n' +
            '• 🎮 Quick games, variety + win streaks\n' +
            '• 🏆 Tier, level milestones (5/25/50/100)',
          color: 0xff9d6c,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Browse on aquilo.gg', url: `${brand.siteUrl || 'https://aquilo.gg'}/achievements` },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Quest checklist',     url: `${brand.siteUrl || 'https://aquilo.gg'}/quest` },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }
  if (action === 'topxp') {
    try {
      const { topXp } = await import('./progression/xp.js');
      const rows = await topXp(env, 10);
      if (!rows || rows.length === 0) {
        return ephEmbed({
          title: '🏆 Top XP',
          description: '_No XP records yet._',
          color: 0xff9d6c,
        });
      }
      const lines = rows.map((r, i) => `${i + 1}. <@${r.userId}>, **${(r.xp || 0).toLocaleString()}** XP (L${r.level || 1})`);
      return ephEmbed({
        title: '🏆 Top XP · all-time',
        description: lines.join('\n'),
        color: 0xff9d6c,
      });
    } catch (e) {
      return eph('Couldn\'t load the leaderboard: ' + (e?.message || e));
    }
  }
  return eph('Unknown achievements action: ' + cid);
}

// ── Export the catalogue for the test harness ────────────────────

export const _HUBS_FOR_TEST = HUBS;
