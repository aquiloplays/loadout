// Channel hubs — phase 1: thin menu embeds for high-traffic channels
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
// The hubs are ADDITIVE — slash commands keep working. The point
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
      'Check in once a day for **bolts** + a streak.\n\n' +
      '• Tap **Check in now** to log today and pick a GIF for your card\n' +
      '• **My streak** shows your current run\n' +
      '• **Daily bonus** claims your bolts for the day',
    footer: '/checkin still works if you prefer typing.',
    buttons: () => [
      { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Check in now',  custom_id: 'checkin:run'    },
      { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My streak',     custom_id: 'checkin:streak' },
      { type: COMPONENT_BUTTON, style: BTN_SUCCESS,   label: 'Daily bonus',   custom_id: 'checkin:daily'  },
    ],
  },
  character: {
    title: '🧑 Your Character',
    color: 0x9b6cff,
    channelHints: ['character', 'rpg'],
    description:
      'Customise your hero — Clay scrapped the visible-character UI so the editor is now upload-based.\n\n' +
      '• **Open editor** — upload a hero pic/gif on aquilo.gg\n' +
      '• **My stats** — class, level, hp, atk, def\n' +
      '• **Pick class** — Warrior / Mage / Rogue / Ranger / Healer (one-time loadout)',
    footer: '/character + /loadout still work as fallbacks.',
    buttons: async (env, guildId) => {
      const brand = await getBranding(env, guildId);
      return [
        { type: COMPONENT_BUTTON, style: BTN_LINK,      label: 'Open editor',   url: `${brand.siteUrl}/play/character/` },
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My stats',      custom_id: 'chub:stats' },
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Pick class',    custom_id: 'chub:class' },
        { type: COMPONENT_BUTTON, style: BTN_LINK,      label: 'Upload hero pic', url: `${brand.siteUrl}/play/character/#avatar` },
      ];
    },
  },
  bolts: {
    title: '💰 Bolts',
    color: 0xe6c474,
    channelHints: ['bolts', 'economy', 'wallet'],
    description:
      'Bolts are the cross-platform currency. Earn from daily check-in, games, raids, gifting and more.\n\n' +
      '• **Check balance** — current + lifetime\n' +
      '• **Transfer bolts** — send to another viewer\n' +
      '• **Wallet history** — recent earn / spend events\n' +
      '• **Donate to Clash** — fund the community town treasury',
    footer: '/loadout has the same surface as this hub.',
    buttons: () => [
      { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Check balance',   custom_id: 'bolts:balance' },
      { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Transfer bolts',  custom_id: 'bolts:transfer' },
      { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Wallet history',  custom_id: 'bolts:history' },
      { type: COMPONENT_BUTTON, style: BTN_SUCCESS,   label: 'Donate to Clash', custom_id: 'bolts:donate' },
    ],
  },
  play: {
    title: '🎮 Play',
    color: 0x3a82ff,
    channelHints: ['play', 'games'],
    description:
      'Every gameplay surface — one hub. Tap any tile to open it.\n\n' +
      '• **Boltbound** — async card battler\n' +
      '• **Clash** — town builder + raids\n' +
      '• **Quick games** — coinflip / dice / blackjack / roulette / wheel / hilo / mines / plinko / crash\n' +
      '• **Aquilo\'s Vault** — community shared bolts treasury\n' +
      '• **Character** — open the upload-based hero editor\n' +
      '• **RPG (Loadout)** — wallet, inventory, kit, daily',
    // 6 buttons across two rows (5+1) so we stay within Discord's
    // 5-per-row component cap.
    rows: () => [
      [
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Boltbound',     custom_id: 'play:boltbound' },
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Clash',         custom_id: 'play:clash' },
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Quick games',   custom_id: 'play:quick' },
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Aquilo\'s Vault', custom_id: 'play:vault' },
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Character',     custom_id: 'play:character' },
      ],
      [
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'RPG (Loadout)', custom_id: 'play:rpg' },
      ],
    ],
  },
  achievements: {
    title: '🏆 Achievements',
    color: 0xff9d6c,
    channelHints: ['achievement', 'milestone'],
    description:
      'Climb the ladder. Achievements grant XP + the level-tier roles (Apprentice / Veteran / Elite / Mythic).\n\n' +
      '• **My achievements** — what you\'ve unlocked\n' +
      '• **Catalogue** — what\'s out there to chase\n' +
      '• **Top XP** — leaderboard',
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

// Admin HTTP entry — resolves channel via opts → KV channel-binding
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

// checkin:* — defer the actual check-in flow to the existing
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
    // Re-emit through the existing /checkin slash command — same
    // entry point the slash command uses, identical flow.
    const { handleCheckinSlashCommand } = await import('./aquilo/checkin-slash.js');
    return handleCheckinSlashCommand(env, { ...data, data: { name: 'checkin' } });
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
    return eph('Tap **Check in now** above — it covers the daily bolts grant in one shot.');
  }
  return eph('Unknown check-in action: ' + cid);
}

// character:*
export async function handleCharacterHubComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const action = cid.split(':')[1];
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return eph('Run this in a server.');

  if (action === 'stats') {
    try {
      const { loadHero, attackOf, defenseOf } = await import('./dungeon.js');
      const hero = await loadHero(env, guildId, userId);
      let levelLine = '';
      try {
        const { readXpDisplay } = await import('./progression/xp.js');
        const xp = await readXpDisplay(env, userId);
        levelLine = `**L${xp.level}** · ${xp.xp.toLocaleString()} XP\n`;
      } catch { /* idle */ }
      return ephEmbed({
        title: '📜 Your stats',
        description:
          levelLine +
          `Class: **${hero.className || hero.class || '_unset_'}**\n` +
          `HP: ${hero.hp || 0} / ${hero.maxHp || 0}\n` +
          `Attack: ${attackOf(hero)}\n` +
          `Defense: ${defenseOf(hero)}`,
        color: 0x9b6cff,
      });
    } catch (e) {
      return eph('Couldn\'t load your stats: ' + (e?.message || e));
    }
  }
  if (action === 'class') {
    return {
      type: RESP_MODAL,
      data: {
        custom_id: 'modal:chub-class',
        title: 'Pick your class',
        components: [{
          type: COMPONENT_ROW,
          components: [{
            type: COMPONENT_TEXT_INPUT,
            custom_id: 'class',
            label: 'Class (warrior / mage / rogue / ranger / healer)',
            style: TEXT_INPUT_SHORT,
            required: true,
            min_length: 4,
            max_length: 12,
            placeholder: 'rogue',
          }],
        }],
      },
    };
  }
  return eph('Unknown character action: ' + cid);
}

// Modal submit for class picker — re-uses applyClassWeb so the
// outcome matches what the website's /web/character/class route
// would produce.
export async function handleCharacterClassModal(env, data) {
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return eph('Run this in a server.');
  let cls = '';
  for (const row of (data.data?.components || [])) {
    for (const c of (row.components || [])) if (c.custom_id === 'class') cls = String(c.value || '').toLowerCase().trim();
  }
  if (!cls) return eph('Class name required.');
  try {
    const { applyClassWeb } = await import('./character.js');
    const r = await applyClassWeb(env, guildId, userId, cls);
    if (!r.ok) return eph(`❌ ${r.error || 'class-apply-failed'} — try warrior / mage / rogue / ranger / healer.`);
    return eph(`✅ Class set to **${r.className}**.${r.starterGranted ? ` Starter gear granted (${(r.granted || []).length} items).` : ''}`);
  } catch (e) {
    return eph('❌ ' + (e?.message || e));
  }
}

// bolts:*
export async function handleBoltsHubComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const action = cid.split(':')[1];
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return eph('Run this in a server.');
  const { getWallet } = await import('./wallet.js');

  if (action === 'balance') {
    const w = await getWallet(env, guildId, userId);
    return ephEmbed({
      title: '💰 Wallet',
      description:
        `Balance: **${(w.balance || 0).toLocaleString()}** bolts\n` +
        `Lifetime earned: ${(w.lifetimeEarned || 0).toLocaleString()}\n` +
        `Lifetime spent: ${(w.lifetimeSpent || 0).toLocaleString()}\n` +
        (w.dailyStreak ? `Daily streak: **${w.dailyStreak}**` : ''),
      color: 0xe6c474,
    });
  }
  if (action === 'transfer') {
    return {
      type: RESP_MODAL,
      data: {
        custom_id: 'modal:bolts-transfer',
        title: 'Transfer bolts',
        components: [
          {
            type: COMPONENT_ROW,
            components: [{
              type: COMPONENT_TEXT_INPUT, custom_id: 'recipient',
              label: 'Recipient (Discord ID or @mention)',
              style: TEXT_INPUT_SHORT, required: true,
              min_length: 5, max_length: 50,
              placeholder: 'e.g. 209640265063006208',
            }],
          },
          {
            type: COMPONENT_ROW,
            components: [{
              type: COMPONENT_TEXT_INPUT, custom_id: 'amount',
              label: 'Amount',
              style: TEXT_INPUT_SHORT, required: true,
              min_length: 1, max_length: 9,
              placeholder: '100',
            }],
          },
        ],
      },
    };
  }
  if (action === 'history') {
    const w = await getWallet(env, guildId, userId);
    return ephEmbed({
      title: '📜 Wallet history',
      description:
        (w.lastEarnUtc ? `Last earn: <t:${Math.floor(w.lastEarnUtc / 1000)}:R> · ${w.lastEarnReason || ''}\n` : '') +
        '_(Full history coming in a follow-up — use the website for now.)_',
      color: 0xe6c474,
    });
  }
  if (action === 'donate') {
    // Quick donate flow — same pattern as play:vault-donate, but
    // surfaced from the bolts hub for users who landed here first.
    let treasuryLine = '';
    try {
      const { getTreasury } = await import('./clash-state.js');
      const t = await getTreasury(env, guildId).catch(() => 0);
      treasuryLine = `\n🏰 Current town treasury: **${(t || 0).toLocaleString()}** bolts`;
    } catch { /* idle */ }
    const brand = await getBranding(env, guildId);
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🏛️ Donate to Clash treasury',
          description: 'Bolts donated fund the community town\'s upgrades + garrison.' + treasuryLine,
          color: 0xe6c474,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Donate 100',  custom_id: 'play:vault-donate:100' },
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Donate 500',  custom_id: 'play:vault-donate:500' },
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Donate 1000', custom_id: 'play:vault-donate:1000' },
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Custom amount on aquilo.gg', url: `${brand.siteUrl || 'https://aquilo.gg'}/clash/town/${guildId}/` },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }
  return eph('Unknown bolts action: ' + cid);
}

// Modal submit for transfer.
export async function handleBoltsTransferModal(env, data) {
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return eph('Run this in a server.');
  let recipient = '', amount = '';
  for (const row of (data.data?.components || [])) {
    for (const c of (row.components || [])) {
      if (c.custom_id === 'recipient') recipient = String(c.value || '').trim();
      if (c.custom_id === 'amount')    amount    = String(c.value || '').trim();
    }
  }
  // Accept either bare snowflake or <@id>/<@!id> mention.
  const m = recipient.match(/^<@!?(\d{5,25})>$|^(\d{5,25})$/);
  const toId = m ? (m[1] || m[2]) : null;
  if (!toId) return eph('❌ Recipient must be a Discord ID or @mention.');
  const n = parseInt(amount, 10);
  if (!Number.isFinite(n) || n <= 0) return eph('❌ Amount must be a positive integer.');
  if (toId === userId) return eph('❌ Can\'t transfer to yourself.');
  try {
    const { transfer } = await import('./wallet.js');
    const r = await transfer(env, guildId, userId, toId, n);
    if (!r.ok) return eph('❌ ' + (r.error || 'transfer-failed'));
    return eph(`✅ Sent **${n}** bolts to <@${toId}>. New balance: **${r.fromBalance}**.`);
  } catch (e) {
    return eph('❌ ' + (e?.message || e));
  }
}

// play:* — six surfaces, each opens a real ephemeral submenu
// (deep web links + in-Discord actions where they make sense).
// No "use /<command>" punts.
export async function handlePlayHubComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const action = cid.split(':')[1];
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  const brand = await getBranding(env, guildId);
  const site = brand.siteUrl || 'https://aquilo.gg';

  if (action === 'boltbound') {
    // Pull a tiny inline read so the menu shows real per-user state.
    let collectionLine = '';
    let activeLine = '';
    try {
      const { getCollection } = await import('./cards-state.js');
      const col = await getCollection(env, guildId, userId).catch(() => null);
      if (col && Array.isArray(col.cards)) {
        collectionLine = `\n📚 Collection: **${col.cards.length}** card${col.cards.length === 1 ? '' : 's'}`;
      }
    } catch { /* idle */ }
    try {
      const { getActiveMatch } = await import('./cards-state.js');
      const m = await getActiveMatch(env, guildId, userId).catch(() => null);
      if (m?.matchId || m?.id) {
        const matchId = String(m.matchId || m.id);
        activeLine = `\n⚔ Active match: \`${matchId.slice(0, 8)}\``;
      }
    } catch { /* idle */ }
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🃏 Boltbound',
          description:
            'Async card battler — collect cards, build decks, battle other viewers.' +
            collectionLine + activeLine,
          color: 0x3a82ff,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK,      label: 'Play on aquilo.gg', url: `${site}/play/boltbound/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,      label: 'My collection',     url: `${site}/play/boltbound/collection/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,      label: 'Daily challenge',   url: `${site}/play/boltbound/daily/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,      label: 'Leaderboard',       url: `${site}/play/boltbound/leaderboard/` },
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Claim daily pack',  custom_id: 'play:boltbound-daily' },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }
  if (action === 'boltbound-daily') {
    // Wire straight into the existing daily-pack flow (slash command
    // /boltbound daily). No slash round-trip — call the underlying
    // function directly.
    try {
      const { claimDailyFreePack } = await import('./cards-packs.js');
      const r = await claimDailyFreePack(env, guildId, userId);
      if (!r || !r.ok) {
        return eph(`❌ ${r?.error === 'already-claimed' ? 'Already claimed today — come back tomorrow.' : (r?.error || 'daily-claim-failed')}`);
      }
      return eph(`🎁 Claimed today's free **Common Pack**. Open via aquilo.gg/play/boltbound/.`);
    } catch (e) {
      return eph('❌ ' + (e?.message || e));
    }
  }

  if (action === 'clash') {
    // Quick town snapshot if available.
    let townLine = '';
    try {
      const { getTown, getTreasury } = await import('./clash-state.js');
      const town = await getTown(env, guildId).catch(() => null);
      if (town) {
        const treasury = await getTreasury(env, guildId).catch(() => 0);
        townLine = `\n🏰 Town hall L${town.thLevel || 1} · treasury **${(treasury || 0).toLocaleString()}** bolts`;
      }
    } catch { /* idle */ }
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '⚔️ Clash',
          description: 'Build the community town. Raid for loot. Defend against attackers.' + townLine,
          color: 0x3a82ff,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Town manager',      url: `${site}/clash/town/${guildId}/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Raid (goblins)',    url: `${site}/clash/?action=raid&kind=goblin` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Raid (player)',     url: `${site}/clash/?action=raid&kind=player` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Global leaderboard', url: `${site}/clash/leaderboard/` },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }

  if (action === 'quick') {
    // Quick-games panel lives on the Twitch extension + aquilo.gg
    // /play surface. Surface direct links to each game type so users
    // can one-tap-launch.
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🎰 Quick games',
          description: '9 games sharing one bolts ledger. Tap any to launch on aquilo.gg.',
          color: 0x3a82ff,
        }],
        components: [
          { type: COMPONENT_ROW, components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Coinflip',  url: `${site}/play/coinflip/`  },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Dice',      url: `${site}/play/dice/`      },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Blackjack', url: `${site}/play/blackjack/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Roulette',  url: `${site}/play/roulette/`  },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Wheel',     url: `${site}/play/wheel/`     },
          ]},
          { type: COMPONENT_ROW, components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Hilo',      url: `${site}/play/hilo/`      },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Mines',     url: `${site}/play/mines/`     },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Plinko',    url: `${site}/play/plinko/`    },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Crash',     url: `${site}/play/crash/`     },
            { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'All quick games', url: `${site}/play/`     },
          ]},
        ],
        flags: FLAG_EPHEMERAL,
      },
    };
  }

  if (action === 'vault') {
    // Aquilo's Vault — community shared treasury. The actual
    // page may not exist yet on the site; pointing at the
    // clash treasury manager which is the closest extant surface.
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🏛️ Aquilo\'s Vault',
          description:
            'The community treasury. Bolts deposited fund the Clash town + community events.\n\n' +
            'Manage on aquilo.gg or use the buttons below.',
          color: 0xe6c474,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Open Vault',     url: `${site}/vault/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Town treasury',  url: `${site}/clash/town/${guildId}/` },
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Donate 100',     custom_id: 'play:vault-donate:100' },
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Donate 500',     custom_id: 'play:vault-donate:500' },
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Donate 1000',    custom_id: 'play:vault-donate:1000' },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }
  if (action === 'vault-donate') {
    const amount = parseInt((cid.split(':')[2] || ''), 10);
    if (!Number.isFinite(amount) || amount <= 0) return eph('❌ Bad donate amount.');
    try {
      const { addTreasury } = await import('./clash-state.js');
      const { spend, getWallet } = await import('./wallet.js');
      const w = await getWallet(env, guildId, userId);
      if ((w.balance || 0) < amount) {
        return eph(`❌ You only have ${(w.balance || 0).toLocaleString()} bolts.`);
      }
      const r = await spend(env, guildId, userId, amount, 'vault-donate');
      if (!r || r.balance < 0) return eph('❌ Could not deduct bolts.');
      await addTreasury(env, guildId, amount);
      return eph(`🏛️ Donated **${amount}** bolts to the town treasury. New balance: **${r.balance.toLocaleString()}**.`);
    } catch (e) {
      return eph('❌ ' + (e?.message || e));
    }
  }

  if (action === 'character') {
    // Same as the standalone character-hub: open the upload-based
    // editor on the site + inline stats button.
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🧑 Character',
          description: 'Upload a hero pic or GIF on the editor. Or pick a class inline.',
          color: 0x9b6cff,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK,      label: 'Open editor',    url: `${site}/play/character/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,      label: 'Upload hero pic', url: `${site}/play/character/#avatar` },
            { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My stats',       custom_id: 'chub:stats' },
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Pick class',     custom_id: 'chub:class' },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }

  if (action === 'rpg') {
    // The Loadout RPG surface — wallet / inventory / kit / daily.
    // These all live in the existing /loadout slash command's
    // menu. Surface their web equivalents directly + inline
    // wallet snapshot.
    let walletLine = '';
    try {
      const { getWallet } = await import('./wallet.js');
      const w = await getWallet(env, guildId, userId);
      walletLine = `\n💰 **${(w.balance || 0).toLocaleString()}** bolts · daily streak **${w.dailyStreak || 0}**`;
    } catch { /* idle */ }
    return {
      type: RESP_CHAT,
      data: {
        embeds: [{
          title: '🎲 RPG · Loadout',
          description: 'Wallet · inventory · kit · daily.' + walletLine,
          color: 0xe6c474,
        }],
        components: [{
          type: COMPONENT_ROW,
          components: [
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Open Loadout',  url: `${site}/play/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Inventory',     url: `${site}/play/inventory/` },
            { type: COMPONENT_BUTTON, style: BTN_LINK,    label: 'Shop',          url: `${site}/play/shop/` },
            { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Claim daily',   custom_id: 'play:rpg-daily' },
          ],
        }],
        flags: FLAG_EPHEMERAL,
      },
    };
  }
  if (action === 'rpg-daily') {
    try {
      const { daily } = await import('./games.js');
      const r = await daily(env, guildId, userId);
      if (!r.won) {
        return eph(`❌ ${r.explanation || 'Already claimed today.'}`);
      }
      const { getWallet } = await import('./wallet.js');
      const w = await getWallet(env, guildId, userId);
      return eph(`💰 Daily claimed — **+${r.payout}** bolts (streak ${r.streak}). Balance: **${(w.balance || 0).toLocaleString()}**.`);
    } catch (e) {
      return eph('❌ ' + (e?.message || e));
    }
  }

  return eph('Unknown play action: ' + cid);
}

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
    try {
      const { tiersForLevel } = await import('./level-tier-roles.js');
      const { readXpDisplay } = await import('./progression/xp.js');
      const x = await readXpDisplay(env, userId).catch(() => null);
      const tiers = x ? tiersForLevel(x.level) : [];
      tierLine = tiers.length ? `\n🏅 Tiers: ${tiers.join(' · ')}` : '\n🏅 Tiers: _none yet (L5 unlocks Apprentice)_';
    } catch { /* idle */ }
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
            '• 🔢 Counting — streaks + perfect runs in #counting\n' +
            '• ✅ Check-in — daily / milestone\n' +
            '• 🃏 Boltbound — collection / battle / win streak\n' +
            '• ⚔️ Clash — raid wins / town upgrades\n' +
            '• 🎮 Quick games — variety + win streaks\n' +
            '• 🏆 Tier — level milestones (5/25/50/100)',
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
      const lines = rows.map((r, i) => `${i + 1}. <@${r.userId}> — **${(r.xp || 0).toLocaleString()}** XP (L${r.level || 1})`);
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
