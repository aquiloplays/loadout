// Unified /loadout menu — one slash command opens an ephemeral message
// (private to the caller) that exposes every other Loadout-bot action
// as buttons / select menus / modals. Replaces the old surface of 24
// granular slash commands.
//
// Routing convention: every component custom_id starts with "lo:" so
// dispatch in commands.js can hand the entire MESSAGE_COMPONENT and
// MODAL_SUBMIT traffic to one handler here.
//
//   lo:home                       — back to main
//   lo:wallet                     — balance / lifetime / streak view
//   lo:daily                      — claim daily (button → result)
//   lo:gift                       — gift flow: opens a UserSelect
//   lo:gift:user                  — UserSelect submit → opens amount modal
//   lo:leaderboard                — top 10 view
//   lo:hero                       — character sheet
//   lo:bag                        — inventory list
//   lo:equip                      — equip flow: select an item
//   lo:equip:do:<itemId>          — execute equip
//   lo:unequip                    — unequip flow: select a slot
//   lo:unequip:do:<slot>          — execute unequip
//   lo:sell                       — sell flow: select an item
//   lo:sell:do:<itemId>           — execute sell
//   lo:shop                       — shop view
//   lo:buy                        — buy flow: select an item
//   lo:buy:do:<index>             — execute buy
//   lo:train                      — pick a training focus
//   lo:train:do:<focus>           — execute training (5 rounds)
//   lo:games                      — quick games sub-menu
//   lo:coinflip                   — open coinflip modal
//   lo:dice                       — open dice modal
//   lo:link                       — open link modal
//   lo:profile                    — profile view
//   lo:profile:edit:<field>       — open edit modal for that field
//   lo:profile:clear              — wipe profile
//   lo:help                       — help view
//   lo:close                      — delete the menu (DELETE_MESSAGE response)

import { getWallet, transfer, leaderboard, applyVaultDelta } from './wallet.js';
import { coinflip, dice, daily } from './games.js';
import { recordStat } from './recap.js';
import {
  balanceEmbed, dailyEmbed, gameEmbed, heroEmbed, shopEmbed, achievementEmbed,
  COLORS, n
} from './embeds.js';
import {
  getProfile, clearProfile, setField, setSocial, setGamerTag
} from './profiles.js';

// ── Discord wire constants ─────────────────────────────────────────
const RESP_CHAT            = 4;
const RESP_DEFER_UPDATE    = 6;
const RESP_UPDATE_MESSAGE  = 7;
const RESP_MODAL           = 9;
const FLAG_EPHEMERAL       = 64;

// Component types
const COMPONENT_ROW            = 1;
const COMPONENT_BUTTON         = 2;
const COMPONENT_STRING_SELECT  = 3;
const COMPONENT_TEXT_INPUT     = 4;
const COMPONENT_USER_SELECT    = 5;

// Button styles
const BTN_PRIMARY   = 1;   // blurple
const BTN_SECONDARY = 2;   // grey
const BTN_SUCCESS   = 3;   // green
const BTN_DANGER    = 4;   // red

// Text input styles
const INPUT_SHORT     = 1;
const INPUT_PARAGRAPH = 2;

// ── Public entry points ────────────────────────────────────────────

/** Render the main menu in response to /loadout. */
export async function renderLoadoutCommand(env, guild, userId, userName) {
  const view = await mainView(env, guild, userId, userName);
  return { type: RESP_CHAT, data: { ...view, flags: FLAG_EPHEMERAL } };
}

/** Handle a button click or select-menu choice (interaction type 3). */
export async function handleComponent(data, env) {
  const guild  = data.guild_id;
  const user   = data.member?.user || data.user;
  const userId = user?.id;
  const userName = user?.global_name || user?.username || 'viewer';
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('lo:')) {
    return json({ type: RESP_DEFER_UPDATE });
  }
  const parts = customId.split(':');   // ['lo', view, ...args]
  const view  = parts[1] || 'home';

  // Components inherit the "ephemeral" flag from the source message
  // automatically when we use UPDATE_MESSAGE — the caller still sees it
  // as their own private message.

  switch (view) {
    case 'home':        return updateMessage(await mainView      (env, guild, userId, userName));
    case 'wallet':      return updateMessage(await walletView    (env, guild, userId, userName));
    case 'daily':       return updateMessage(await dailyAction   (env, guild, userId, userName));
    case 'leaderboard': return updateMessage(await leaderboardView(env, guild));
    case 'games':       return updateMessage(gamesView());
    case 'profile':     return parts[2] === 'edit'  ? openModal(profileEditModal(parts[3]))
                                : parts[2] === 'clear' ? updateMessage(await profileClearAction(env, guild, userId))
                                : updateMessage(await profileView(env, guild, userId, userName));
    case 'help':        return updateMessage(helpView());
    case 'close':       return deleteMessage();

    // Open-modal triggers
    case 'gift':
      // first click opens a User-select; selection arrives back as
      // lo:gift:user with data.values=[discordUserId].
      if (parts[2] === 'user') {
        const targetId = data.data?.values?.[0];
        if (!targetId) return updateMessage(await mainView(env, guild, userId, userName));
        return openModal(giftAmountModal(targetId));
      }
      return updateMessage(await giftPickerView());
    case 'coinflip':    return openModal(coinflipModal());
    case 'dice':        return openModal(diceModal());

    default:
      return updateMessage(await mainView(env, guild, userId, userName));
  }
}

/** Handle a modal submission (interaction type 5). */
export async function handleModal(data, env) {
  const guild  = data.guild_id;
  const user   = data.member?.user || data.user;
  const userId = user?.id;
  const userName = user?.global_name || user?.username || 'viewer';
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('lo:m:')) {
    return updateMessage(await mainView(env, guild, userId, userName));
  }
  const parts = customId.split(':');     // ['lo', 'm', kind, ...args]
  const kind = parts[2];

  // Pull modal field values keyed by their custom_id (not their label).
  const fields = {};
  for (const row of data.data?.components || []) {
    for (const c of row.components || []) fields[c.custom_id] = c.value;
  }

  switch (kind) {
    case 'gift': {
      const toId = parts[3];
      const amt = parseInt(fields.amount || '', 10);
      const result = await giftAction(env, guild, userId, toId, amt);
      return updateMessage(result);
    }
    case 'coinflip': {
      const bet = parseInt(fields.bet || '', 10);
      const r = await cmdCoinflipInline(env, guild, userId, bet, userName);
      return updateMessage({ ...r, components: [backRow()] });
    }
    case 'dice': {
      const bet = parseInt(fields.bet || '', 10);
      const target = parseInt(fields.target || '', 10);
      const r = await cmdDiceInline(env, guild, userId, bet, target, userName);
      return updateMessage({ ...r, components: [backRow()] });
    }
    case 'profile': {
      const field = parts[3];
      const r = await profileFieldAction(env, guild, userId, field, fields);
      return updateMessage({ ...r, components: [backRow('lo:profile')] });
    }
    // (Modal `avatar` removed in 2025-05 — avatars auto-resolve from
    // the viewer's Discord avatar in the menu and their stream profile
    // pic on the overlay. cmdSetAvatar stays exported in case we want
    // to re-add a custom-URL slot later.)
    default:
      return updateMessage(await mainView(env, guild, userId, userName));
  }
}

// ── Views ──────────────────────────────────────────────────────────

async function mainView(env, guild, userId, userName) {
  const w = await getWallet(env, guild, userId);
  const link = (w.links || [])[0];
  const linked = link ? `${link.platform}:${link.username}` : null;

  const lines = [
    `**${userName}** · ⚡ **${w.balance ?? 0}** bolts` +
    (w.dailyStreak ? ` · 🔥 ${w.dailyStreak}-day streak` : '') +
    (linked ? ` · 🔗 ${linked}` : ''),
    '',
    '_Tap a button to do anything below — only you can see this menu._'
  ];

  return {
    content: '⚔ **Loadout**\n' + lines.join('\n'),
    components: [
      row(
        button('💰 Wallet',         'lo:wallet',      BTN_SECONDARY),
        button('🎁 Daily',          'lo:daily',       BTN_SUCCESS),
        button('🤝 Gift',           'lo:gift',        BTN_SECONDARY),
        button('📊 Leaderboard',    'lo:leaderboard', BTN_SECONDARY)
      ),
      row(
        button('🪪 Profile',        'lo:profile',     BTN_SECONDARY),
        button('🎲 Quick games',    'lo:games',       BTN_SECONDARY),
        button('❓ Help',           'lo:help',        BTN_SECONDARY)
      ),
      row(
        button('❌ Close',          'lo:close',       BTN_DANGER),
        // Routes via the prefix dispatcher in commands.js to the hub
        // root — gives the user a one-click escape back to /hub when
        // they entered this menu through the hub Loadout drilldown.
        button('🌐 Hub',            'hub:home',       BTN_SECONDARY)
      )
    ]
  };
}

async function walletView(env, guild, userId, userName) {
  const w = await getWallet(env, guild, userId);
  return {
    content: '',
    embeds: [balanceEmbed({ userId, userName, wallet: w, links: w.links || [] })],
    components: [
      row(
        button('🎁 Claim daily',   'lo:daily',       BTN_SUCCESS),
        button('🤝 Gift bolts',    'lo:gift',        BTN_SECONDARY),
        button('📊 Leaderboard',   'lo:leaderboard', BTN_SECONDARY),
      ),
      backRow()
    ]
  };
}

async function dailyAction(env, guild, userId, userName) {
  const r = await daily(env, guild, userId);
  // Cooldown / error path keeps the plain-text reply — embeds shouldn't
  // celebrate a "you already claimed" reply.
  if (!r.won) {
    return {
      content: r.explanation || 'Daily already claimed.',
      components: [backRow('lo:wallet')]
    };
  }
  return {
    content: '',
    embeds: [dailyEmbed({ userName, payout: r.payout, streak: r.streak })],
    components: [backRow('lo:wallet')]
  };
}

async function leaderboardView(env, guild) {
  const top = await leaderboard(env, guild, 10);
  if (top.length === 0) {
    return {
      content: '📊 Nobody has any bolts here yet. Run **Claim daily** to start!',
      components: [backRow()]
    };
  }
  const lines = top.map((row, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `   ${i + 1}.`;
    return `${medal}  <@${row.userId}>  —  **${row.w.balance}** bolts`;
  });
  return {
    content: '📊 **Top 10 — this server**\n' + lines.join('\n'),
    components: [backRow()]
  };
}

async function giftPickerView() {
  return {
    content: '🤝 **Gift bolts**\nPick a viewer below, then enter the amount.',
    components: [
      {
        type: COMPONENT_ROW,
        components: [{
          type: COMPONENT_USER_SELECT,
          custom_id: 'lo:gift:user',
          placeholder: 'Choose someone to gift',
          min_values: 1, max_values: 1
        }]
      },
      backRow()
    ]
  };
}

async function giftAction(env, guild, fromId, toId, amount) {
  if (!toId)                                  return { content: 'Couldn\'t resolve that user.', components: [backRow()] };
  if (toId === fromId)                        return { content: '❌ You can\'t gift yourself.', components: [backRow()] };
  if (!Number.isInteger(amount) || amount <= 0) return { content: '❌ Amount must be a positive integer.', components: [backRow()] };

  const r = await transfer(env, guild, fromId, toId, amount);
  if (!r.ok) return { content: '❌ ' + (r.reason || 'gift failed'), components: [backRow()] };
  return {
    content: `🎁 You gifted **${amount}** bolts to <@${toId}>.\nTheir balance: ${r.recipient.balance} · yours: ${r.sender.balance}.`,
    components: [backRow('lo:wallet')]
  };
}


// ── Quick games ────────────────────────────────────────────────────

function gamesView() {
  return {
    content:
      '🎲 **Quick games**\n' +
      'Use these to grind a few extra bolts between dungeons. House-edge favours the streamer (slightly).',
    components: [
      row(
        button('🪙 Coinflip', 'lo:coinflip', BTN_PRIMARY),
        button('🎲 Dice',     'lo:dice',     BTN_PRIMARY)
      ),
      backRow()
    ]
  };
}

async function cmdCoinflipInline(env, guild, userId, bet, userName) {
  if (!Number.isInteger(bet) || bet <= 0) return { content: '❌ Wager must be a positive integer.' };
  const r = await coinflip(env, guild, userId, bet);
  // Failure paths (insufficient balance, etc.) return won=false with a
  // payout of 0; only render the embed when an actual flip happened.
  if (r.payout === 0 && !r.won) return { content: r.explanation || '❌ ' + (r.reason || 'flip failed') };
  // Parity with the Twitch panel + the website /play page: every
  // resolved flip bumps the recap stats so "your last session" stays
  // consistent across surfaces.
  if (r.won) await recordStat(env, guild, userId, { games_won: 1, bolts_earned: r.payout });
  else await recordStat(env, guild, userId, { games_lost: 1, bolts_spent: -r.payout });
  return {
    content: '',
    embeds: [gameEmbed({
      kind: 'coinflip', won: r.won, userName,
      wager: bet,
      payout: r.won ? r.payout : 0,
      result: r.won ? 'heads' : 'tails'
    })]
  };
}

async function cmdDiceInline(env, guild, userId, bet, target, userName) {
  if (!Number.isInteger(bet) || bet <= 0)     return { content: '❌ Wager must be a positive integer.' };
  if (!Number.isInteger(target) || target < 1 || target > 6) return { content: '❌ Target must be 1-6.' };
  const r = await dice(env, guild, userId, bet, target);
  if (r.payout === 0 && !r.won && !r.roll) return { content: r.explanation || '❌ ' + (r.reason || 'roll failed') };
  if (r.won) await recordStat(env, guild, userId, { games_won: 1, bolts_earned: r.payout });
  else await recordStat(env, guild, userId, { games_lost: 1, bolts_spent: -r.payout });
  return {
    content: '',
    embeds: [gameEmbed({
      kind: 'dice', won: r.won, userName,
      wager: bet,
      payout: r.won ? r.payout : 0,
      target, rolled: r.roll
    })]
  };
}

// ── Profile ────────────────────────────────────────────────────────

async function profileView(env, guild, userId, userName) {
  const p = await getProfile(env, guild, userId);
  const lines = [
    `🪪 **Profile** — ${userName}`,
    p?.bio       ? `> _${truncate(p.bio, 280)}_` : '_(no bio set)_',
    '',
    p?.pronouns  ? `**Pronouns:** ${p.pronouns}` : '',
    p?.pfp       ? `**Pic:** [link](${p.pfp})`   : '',
    Object.keys(p?.socials   || {}).length ? `**Socials:** ${Object.entries(p.socials).map(([k, v]) => `\`${k}:${v}\``).join(' · ')}` : '',
    Object.keys(p?.gamerTags || {}).length ? `**Gamer tags:** ${Object.entries(p.gamerTags).map(([k, v]) => `\`${k}:${v}\``).join(' · ')}` : ''
  ].filter(Boolean);
  return {
    content: lines.join('\n'),
    components: [
      row(
        button('Edit bio',       'lo:profile:edit:bio',      BTN_SECONDARY),
        button('Edit pic',       'lo:profile:edit:pfp',      BTN_SECONDARY),
        button('Edit pronouns',  'lo:profile:edit:pronouns', BTN_SECONDARY)
      ),
      row(
        button('Add social',     'lo:profile:edit:social',   BTN_SECONDARY),
        button('Add gamer tag',  'lo:profile:edit:gamertag', BTN_SECONDARY),
        button('Wipe profile',   'lo:profile:clear',         BTN_DANGER)
      ),
      backRow()
    ]
  };
}

async function profileFieldAction(env, guild, userId, field, fields) {
  switch (field) {
    case 'bio':      await setField(env, guild, userId, 'bio',      (fields.bio || '').trim());       return { content: '🪪 Bio saved.' };
    case 'pfp':      await setField(env, guild, userId, 'pfp',      (fields.url || '').trim());       return { content: '🪪 Pic URL saved.' };
    case 'pronouns': await setField(env, guild, userId, 'pronouns', (fields.pronouns || '').trim()); return { content: '🪪 Pronouns saved.' };
    case 'social':   await setSocial  (env, guild, userId, (fields.platform || '').trim().toLowerCase(), (fields.handle || '').trim()); return { content: '🪪 Social saved.' };
    case 'gamertag': await setGamerTag(env, guild, userId, (fields.platform || '').trim().toLowerCase(), (fields.tag    || '').trim()); return { content: '🪪 Gamer tag saved.' };
    default:         return { content: 'Unknown field.' };
  }
}

async function profileClearAction(env, guild, userId) {
  await clearProfile(env, guild, userId);
  return { content: '🪪 Profile wiped.', components: [backRow()] };
}

// ── Help ───────────────────────────────────────────────────────────

function helpView() {
  return {
    content:
      '❓ **Loadout — what every button does**\n' +
      '• **Wallet / Daily / Gift / Leaderboard** — your bolts (the cross-platform currency).\n' +
      '• **Hero** — your dungeon character (level, HP, attack, defense, equipped gear).\n' +
      '• **Bag** — items you found in `!dungeon` runs or bought from the shop. Equip / unequip / sell from here.\n' +
      '• **Shop** — buy gear off-stream with bolts.\n' +
      '• **Train** — spend bolts to grind XP / HP between streams.\n' +
      '• **Profile** — !profile bio, pronouns, social handles, gamer tags. Same data the chat command + viewer overlay show.\n' +
      '• **Quick games** — coinflip / dice for grinding bolts.',
    components: [backRow()]
  };
}

// ── Modals ─────────────────────────────────────────────────────────

function giftAmountModal(toId) {
  return {
    custom_id: `lo:m:gift:${toId}`,
    title: 'Gift bolts',
    components: [
      {
        type: COMPONENT_ROW,
        components: [{
          type: COMPONENT_TEXT_INPUT,
          custom_id: 'amount',
          label: 'How many bolts?',
          style: INPUT_SHORT,
          required: true,
          min_length: 1, max_length: 6,
          placeholder: 'e.g. 50'
        }]
      }
    ]
  };
}

function coinflipModal() {
  return {
    custom_id: 'lo:m:coinflip',
    title: 'Coinflip — wager bolts',
    components: [{
      type: COMPONENT_ROW,
      components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'bet', label: 'Wager (bolts)', style: INPUT_SHORT,
                     required: true, min_length: 1, max_length: 6, placeholder: 'e.g. 25' }]
    }]
  };
}

function diceModal() {
  return {
    custom_id: 'lo:m:dice',
    title: 'Dice — wager + target',
    components: [
      {
        type: COMPONENT_ROW,
        components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'bet', label: 'Wager (bolts)', style: INPUT_SHORT,
                       required: true, min_length: 1, max_length: 6, placeholder: 'e.g. 25' }]
      },
      {
        type: COMPONENT_ROW,
        components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'target', label: 'Target face (1-6)', style: INPUT_SHORT,
                       required: true, min_length: 1, max_length: 1, placeholder: '1-6' }]
      }
    ]
  };
}

function profileEditModal(field) {
  switch (field) {
    case 'bio':
      return {
        custom_id: 'lo:m:profile:bio',
        title: 'Edit bio',
        components: [{ type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'bio',
          label: 'Bio (up to 200 chars)', style: INPUT_PARAGRAPH, required: false, max_length: 200 }] }]
      };
    case 'pfp':
      return {
        custom_id: 'lo:m:profile:pfp',
        title: 'Edit profile pic URL',
        components: [{ type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'url',
          label: 'PNG / JPG / WebP URL', style: INPUT_SHORT, required: false, max_length: 400 }] }]
      };
    case 'pronouns':
      return {
        custom_id: 'lo:m:profile:pronouns',
        title: 'Edit pronouns',
        components: [{ type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'pronouns',
          label: 'Pronouns (e.g. they/them)', style: INPUT_SHORT, required: false, max_length: 24 }] }]
      };
    case 'social':
      return {
        custom_id: 'lo:m:profile:social',
        title: 'Add a social handle',
        components: [
          { type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'platform',
            label: 'Platform (twitter / instagram / etc.)', style: INPUT_SHORT, required: true, max_length: 24 }] },
          { type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'handle',
            label: 'Your handle (blank to remove)',         style: INPUT_SHORT, required: false, max_length: 80 }] }
        ]
      };
    case 'gamertag':
      return {
        custom_id: 'lo:m:profile:gamertag',
        title: 'Add a gamer tag',
        components: [
          { type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'platform',
            label: 'Platform (psn / xbox / steam / etc.)',  style: INPUT_SHORT, required: true, max_length: 24 }] },
          { type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'tag',
            label: 'Your tag on that platform (blank=remove)', style: INPUT_SHORT, required: false, max_length: 60 }] }
        ]
      };
    default:
      return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function row(...children) { return { type: COMPONENT_ROW, components: children.filter(Boolean) }; }
function button(label, customId, style = BTN_SECONDARY, disabled = false) {
  return { type: COMPONENT_BUTTON, label, custom_id: customId, style, disabled };
}
function selectRow(customId, placeholder, options) {
  return {
    type: COMPONENT_ROW,
    components: [{ type: COMPONENT_STRING_SELECT, custom_id: customId, placeholder, options, min_values: 1, max_values: 1 }]
  };
}
// Returns a single ActionRow (not wrapped in an array). The earlier
// shape returned [ROW] which made `components: [row(...), backRow()]`
// produce `[ROW, [ROW]]` — Discord rejected that as "interaction
// failed". Callers now use `components: [backRow()]` for a single row
// or `[row(...), backRow()]` for a top + bottom-row layout.
function backRow(target = 'lo:home') {
  return { type: COMPONENT_ROW, components: [
    button('← Back to menu', target, BTN_SECONDARY),
    button('❌ Close',        'lo:close', BTN_DANGER)
  ]};
}

function updateMessage(view) {
  return json({
    type: RESP_UPDATE_MESSAGE,
    data: { content: view.content || '', embeds: view.embeds, components: Array.isArray(view.components) ? view.components : [] }
  });
}
function openModal(modal) {
  return json({ type: RESP_MODAL, data: modal });
}
function deleteMessage() {
  // Discord doesn't have a native "delete the source message" response
  // type for ephemeral interactions, but UPDATE_MESSAGE with empty
  // content + components effectively dismisses it.
  return json({ type: RESP_UPDATE_MESSAGE, data: { content: '👋 Closed.', embeds: [], components: [] } });
}
function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function sortBag(bag) {
  const order = { legendary: 4, epic: 3, rare: 2, uncommon: 1, common: 0 };
  return [...(bag || [])].sort((a, b) => (order[b.rarity] || 0) - (order[a.rarity] || 0));
}

// Hero state lookup for the picker views (equip / unequip / sell).
// Two storage layers, merged on read so Discord-set fields (avatar /
// className / custom) survive the DLL's 5-minute hero snapshot push:
//
//   1. d:hero-by-handle:<guild>:<platform>:<handle> — DLL push. Holds
//      progression stats from on-stream play.
//   2. d:hero:<guild>:<userId>                       — Worker-local,
//      where /loadout writes Discord-side mutations.
//
// Bag is unioned across both; equipped slots merged. Earlier this
// returned the DLL hero outright when present — local was ignored
// entirely, so any /loadout-set avatar / class / custom was invisible.
async function loadHeroFor(env, guild, userId) {
  const w = await getWallet(env, guild, userId);
  const link = (w.links || [])[0];
  let dllHero = null;
  if (link?.platform && link?.username) {
    const raw = await env.LOADOUT_BOLTS.get(
      `d:hero-by-handle:${guild}:${link.platform.toLowerCase()}:${link.username.toLowerCase()}`);
    if (raw) { try { dllHero = JSON.parse(raw); } catch {} }
  }
  const raw = await env.LOADOUT_BOLTS.get(`d:hero:${guild}:${userId}`);
  let local = null;
  if (raw) { try { local = JSON.parse(raw); } catch {} }

  if (!dllHero && !local) return { bag: [], equipped: {} };
  if (!dllHero) return local;
  if (!local)   return dllHero;
  // Merge with the same rules dungeon.js's loadHero uses — keep them
  // in sync. Discord-set fields prefer local; progression stats prefer
  // DLL; bag is unioned; equipped merged with DLL winning on conflict.
  const merged = Object.assign({}, dllHero);
  if (local.avatar)    merged.avatar    = local.avatar;
  if (local.className) merged.className = local.className;
  if (local.custom && Object.keys(local.custom).length > 0) {
    merged.custom = Object.assign({}, dllHero.custom || {}, local.custom);
  }
  const ids = new Set((dllHero.bag || []).map(it => it.id));
  merged.bag = [...(dllHero.bag || []), ...((local.bag || []).filter(it => !ids.has(it.id)))];
  merged.equipped = Object.assign({}, local.equipped || {}, dllHero.equipped || {});
  return merged;
}
