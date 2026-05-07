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
import {
  getProfile, clearProfile, setField, setSocial, setGamerTag
} from './profiles.js';
import {
  cmdHero, cmdInventory, cmdEquip, cmdUnequip, cmdSell,
  cmdShop, cmdShopBuy, cmdTraining,
  cmdSetAvatar, cmdSetClass, cmdSetCustom, CLASSES, CUSTOM_OPTIONS
} from './dungeon.js';

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
    case 'hero':        return updateMessage(await heroView      (env, guild, userId, userName));
    case 'character':   {
      // Character customisation sub-view. parts[2] paths:
      //   (none)               — show the Character panel
      //   avatar               — open the "set avatar URL" modal
      //   class                — show class picker
      //   class:do:<key>       — set the class
      //   customize            — show appearance customization panel
      //   customize:<attr>     — open select-menu for skinTone / hairColor / hairStyle / eyeColor / cape
      //   customize:do:<attr>  — apply selected value (from select submit)
      if (parts[2] === 'avatar')           return openModal(avatarModal());
      if (parts[2] === 'class' && parts[3] === 'do')
        return updateMessage(await classDo(env, guild, userId, parts[4]));
      if (parts[2] === 'class')            return updateMessage(classPicker());
      if (parts[2] === 'customize') {
        if (parts[3] === 'do') {
          const attr  = parts[4];
          const value = data.data?.values?.[0] || '';
          return updateMessage(await customizeApply(env, guild, userId, attr, value));
        }
        if (parts[3]) return updateMessage(customizeAttrPicker(parts[3]));
        return updateMessage(await customizeView(env, guild, userId, userName));
      }
      return updateMessage(await characterView(env, guild, userId, userName));
    }
    case 'bag':         return updateMessage(await bagView       (env, guild, userId));
    case 'equip':       return parts[2] === 'do' ? updateMessage(await equipDo  (env, guild, userId, parts[3])) : updateMessage(await equipPicker  (env, guild, userId));
    case 'unequip':     return parts[2] === 'do' ? updateMessage(await unequipDo(env, guild, userId, parts[3])) : updateMessage(await unequipPicker(env, guild, userId));
    case 'sell':        return parts[2] === 'do' ? updateMessage(await sellDo   (env, guild, userId, parts[3])) : updateMessage(await sellPicker   (env, guild, userId));
    case 'shop':        return updateMessage(await shopView      (env, guild, userId));
    case 'buy':         return parts[2] === 'do' ? updateMessage(await buyDo    (env, guild, userId, parts[3])) : updateMessage(await buyPicker    (env, guild, userId));
    case 'train':       return parts[2] === 'do' ? updateMessage(await trainDo  (env, guild, userId, parts[3])) : updateMessage(await trainPicker  ());
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
    case 'link':        return openModal(linkModal());

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
    case 'link': {
      const platform = (fields.platform || '').toLowerCase().trim();
      const username = (fields.username || '').trim();
      const r = await linkAction(env, guild, userId, platform, username, userName);
      return updateMessage({ ...r, components: [backRow()] });
    }
    case 'profile': {
      const field = parts[3];
      const r = await profileFieldAction(env, guild, userId, field, fields);
      return updateMessage({ ...r, components: [backRow('lo:profile')] });
    }
    case 'avatar': {
      const r = await cmdSetAvatar(env, guild, userId, fields.url || '');
      return updateMessage({ content: r.content, components: [backRow('lo:character')] });
    }
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
    linked
      ? '_Tap a button to do anything below — only you can see this menu._'
      : '_Linking your stream account unlocks the full menu — tap **Link account** below._'
  ];

  // Lock the locked-without-link buttons visually + functionally.
  // We render them disabled rather than hidden so newcomers learn what's
  // available. Discord buttons have a `disabled` field (true/false).
  const needLink = !linked;

  return {
    content: '⚔ **Loadout**\n' + lines.join('\n'),
    components: [
      row(
        button('💰 Wallet',         'lo:wallet',      BTN_SECONDARY, needLink),
        button('🎁 Daily',          'lo:daily',       BTN_SUCCESS,   needLink),
        button('🤝 Gift',           'lo:gift',        BTN_SECONDARY, needLink),
        button('📊 Leaderboard',    'lo:leaderboard', BTN_SECONDARY, false)
      ),
      row(
        button('🦸 Hero',           'lo:hero',        BTN_PRIMARY,   needLink),
        button('🎒 Bag',            'lo:bag',         BTN_PRIMARY,   needLink),
        button('🏪 Shop',           'lo:shop',        BTN_PRIMARY,   needLink),
        button('🥋 Train',          'lo:train',       BTN_PRIMARY,   needLink)
      ),
      row(
        button('🪪 Profile',        'lo:profile',     BTN_SECONDARY, false),
        button('🎲 Quick games',    'lo:games',       BTN_SECONDARY, needLink),
        button('🔗 Link account',   'lo:link',        linked ? BTN_SECONDARY : BTN_SUCCESS, false),
        button('❓ Help',           'lo:help',        BTN_SECONDARY, false)
      ),
      row(
        button('❌ Close',          'lo:close',       BTN_DANGER,    false)
      )
    ]
  };
}

async function walletView(env, guild, userId, userName) {
  const w = await getWallet(env, guild, userId);
  return {
    content:
      `💰 **Wallet**\n` +
      `Balance: **${w.balance ?? 0}** ⚡ bolts\n` +
      `Lifetime earned: ${w.lifetimeEarned ?? w.balance ?? 0}\n` +
      (w.dailyStreak ? `Daily streak: 🔥 ${w.dailyStreak} days\n` : '') +
      (w.lastDailyUtc ? `Last daily: <t:${Math.floor(new Date(w.lastDailyUtc).getTime() / 1000)}:R>\n` : '') +
      ((w.links || []).length ? `Linked: ${w.links.map(l => `\`${l.platform}:${l.username}\``).join(' · ')}` : ''),
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
  return {
    content: r.explanation || (r.won ? `🎁 +${r.delta} bolts` : 'Daily already claimed.'),
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

// ── Hero / Bag / Equip / Sell ──────────────────────────────────────

async function heroView(env, guild, userId, userName) {
  const r = await cmdHero(env, guild, userId, null, userName);
  return {
    content: r.content || '',
    embeds: r.embeds,
    components: [
      row(
        button('👤 Character', 'lo:character', BTN_SUCCESS),
        button('🎒 Bag',      'lo:bag',       BTN_PRIMARY),
        button('🥋 Train',    'lo:train',     BTN_PRIMARY),
        button('🏪 Shop',     'lo:shop',      BTN_SECONDARY)
      ),
      backRow()
    ]
  };
}

// ── Character (avatar + class) ─────────────────────────────────────

async function characterView(env, guild, userId, userName) {
  // Pull the merged hero (Worker-local + DLL push) so the panel
  // matches what the dungeon overlay would render. The avatar
  // preview rides as embed.thumbnail just like the Hero embed.
  const heroEmbed = await cmdHero(env, guild, userId, null, userName);
  const e = heroEmbed.embeds?.[0];
  return {
    content: '👤 **Your character** — visible to chat in `!dungeon` runs and on the dungeon overlay.',
    embeds: e ? [e] : undefined,
    components: [
      row(
        button('🖼 Set avatar URL',   'lo:character:avatar',    BTN_PRIMARY),
        button('🎭 Pick class',       'lo:character:class',     BTN_PRIMARY),
        button('🎨 Customize look',  'lo:character:customize', BTN_SUCCESS)
      ),
      backRow('lo:hero')
    ]
  };
}

// ── Appearance customization ────────────────────────────────────────

async function customizeView(env, guild, userId, userName) {
  // Show what's currently picked, with one button per attribute. Each
  // button opens a select-menu of options for that attribute. The
  // sprite that renders on the dungeon overlay updates as soon as the
  // viewer picks a new value — no save button.
  // (There's also no preview render here yet; for now we surface the
  // hero's full embed so the viewer can see the class glyph + class
  // colour, plus a list of their current customization values.)
  const r = await cmdHero(env, guild, userId, null, userName);
  const heroEmbed = r.embeds?.[0];
  // Read the raw hero so we can show the picked customizations. We
  // don't expose the underlying dungeon.js loadHero here so do a
  // best-effort pull from the canonical KV key via the wallet link.
  const w = await getWallet(env, guild, userId);
  const link = (w.links || [])[0];
  let hero = null;
  if (link?.platform && link?.username) {
    const raw = await env.LOADOUT_BOLTS.get(
      `d:hero-by-handle:${guild}:${link.platform.toLowerCase()}:${link.username.toLowerCase()}`);
    if (raw) { try { hero = JSON.parse(raw); } catch {} }
  }
  if (!hero) {
    const raw = await env.LOADOUT_BOLTS.get('d:hero:' + guild + ':' + userId);
    if (raw) { try { hero = JSON.parse(raw); } catch {} }
  }
  const c = hero?.custom || {};

  const summary =
    '🎨 **Customize your look** — picks render on the dungeon overlay.\n' +
    '`Skin tone:` ' + (c.skinTone  || '_default_') + '\n' +
    '`Hair color:` ' + (c.hairColor || '_default_') + '\n' +
    '`Hair style:` ' + (c.hairStyle || '_default_') + '\n' +
    '`Eye color:` '  + (c.eyeColor  || '_default_') + '\n' +
    '`Cape:` '       + (c.cape      || '_none_');

  return {
    content: summary,
    embeds: heroEmbed ? [heroEmbed] : undefined,
    components: [
      row(
        button('🧴 Skin tone',  'lo:character:customize:skinTone',  BTN_SECONDARY),
        button('💇 Hair color', 'lo:character:customize:hairColor', BTN_SECONDARY),
        button('✂ Hair style',  'lo:character:customize:hairStyle', BTN_SECONDARY),
        button('👁 Eye color',  'lo:character:customize:eyeColor',  BTN_SECONDARY),
        button('🦸 Cape',        'lo:character:customize:cape',     BTN_SECONDARY)
      ),
      backRow('lo:character')
    ]
  };
}

function customizeAttrPicker(attr) {
  const opts = CUSTOM_OPTIONS[attr];
  if (!opts) return { content: '❌ Unknown customization attribute.', components: [backRow('lo:character:customize')] };
  // Each select option's value becomes the customize:do:<attr> custom_id.
  const options = opts.map(o => ({
    label: o.charAt(0).toUpperCase() + o.slice(1),
    value: o
  }));
  // Add an explicit "default / none" option so the viewer can clear
  // the slot back to class default.
  options.push({ label: 'Default', value: 'none', description: 'Clear this slot back to class default' });
  return {
    content: '🎨 **Pick a ' + attr + '** — overlay updates immediately.',
    components: [
      selectRow('lo:character:customize:do:' + attr, 'Pick a ' + attr, options),
      backRow('lo:character:customize')
    ]
  };
}

async function customizeApply(env, guild, userId, attr, value) {
  const r = await cmdSetCustom(env, guild, userId, attr, value);
  // Bounce back into customizeView so the streamer sees the update +
  // their other picks side-by-side without an extra click.
  const back = await customizeView(env, guild, userId, '');
  return { content: (r.content || '') + '\n\n' + back.content, embeds: back.embeds, components: back.components };
}

function classPicker() {
  // One ActionRow can hold up to 5 buttons — exactly fits the 5 classes.
  // Style each button with the class glyph + display name so the picker
  // reads like a character-creation screen.
  const order = ['warrior', 'mage', 'rogue', 'ranger', 'healer'];
  return {
    content:
      '🎭 **Pick a class** — affects your avatar tint, dungeon-overlay glyph, and small stat bonuses.\n' +
      '• **Warrior** ⚔ +2 ATK\n' +
      '• **Mage** 🪄 +1 ATK · +1 DEF\n' +
      '• **Rogue** 🗡 +2 ATK · −1 DEF\n' +
      '• **Ranger** 🏹 +1 ATK\n' +
      '• **Healer** ✨ +1 DEF · +5 HP',
    components: [
      row(...order.map(k => button(CLASSES[k].glyph + ' ' + CLASSES[k].name,
                                   'lo:character:class:do:' + k,
                                   BTN_SECONDARY))),
      backRow('lo:character')
    ]
  };
}

async function classDo(env, guild, userId, key) {
  const r = await cmdSetClass(env, guild, userId, key);
  return { content: r.content, components: [backRow('lo:character')] };
}

function avatarModal() {
  return {
    custom_id: 'lo:m:avatar',
    title: 'Set your character avatar',
    components: [{ type: COMPONENT_ROW, components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'url',
      label: 'Avatar URL (https://...) — blank to clear', style: INPUT_SHORT, required: false, max_length: 400,
      placeholder: 'https://your-stream.com/avatar.png' }] }]
  };
}

async function bagView(env, guild, userId) {
  const r = await cmdInventory(env, guild, userId);
  return {
    content: r.content,
    components: [
      row(
        button('🛡 Equip…',     'lo:equip',   BTN_SUCCESS),
        button('🧤 Unequip…',   'lo:unequip', BTN_SECONDARY),
        button('💰 Sell…',      'lo:sell',    BTN_DANGER)
      ),
      backRow('lo:hero')
    ]
  };
}

// Equip / Unequip / Sell pickers all read the user's actual inventory and
// build a String Select with one option per item. Discord caps selects at
// 25 options, which matches the bag cap (50 → top 25 by rarity).

async function equipPicker(env, guild, userId) {
  const hero = await loadHeroFor(env, guild, userId);
  const options = sortBag(hero.bag).slice(0, 25).map(it => ({
    label: `${it.glyph} ${it.name}`.slice(0, 100),
    description: `${it.rarity} · ${it.slot}${it.powerBonus ? ` · +${it.powerBonus} ATK` : ''}${it.defenseBonus ? ` · +${it.defenseBonus} DEF` : ''}`.slice(0, 100),
    value: `lo:equip:do:${it.id.slice(0, 16)}`
  }));
  if (options.length === 0) {
    return { content: '🎒 Your bag is empty — nothing to equip.', components: [backRow('lo:bag')] };
  }
  return {
    content: '🛡 **Equip an item** — pick from your bag:',
    components: [
      selectRow('lo:equip:do', 'Pick an item to equip', options),
      backRow('lo:bag')
    ]
  };
}

async function equipDo(env, guild, userId, itemIdPrefix) {
  // The select-menu's value comes through as parts[3]. Defensive: support
  // both `lo:equip:do:<id>` (custom_id of select option set) and bare id.
  const id = (itemIdPrefix || '').replace(/^lo:equip:do:/, '');
  const r = await cmdEquip(env, guild, userId, id);
  return { content: r.content, components: [backRow('lo:bag')] };
}

async function unequipPicker(env, guild, userId) {
  const hero = await loadHeroFor(env, guild, userId);
  const slots = Object.keys(hero.equipped || {}).filter(k => hero.equipped[k]);
  if (slots.length === 0) {
    return { content: '🧤 Nothing equipped right now.', components: [backRow('lo:bag')] };
  }
  const options = slots.map(slot => {
    const it = (hero.bag || []).find(x => x.id === hero.equipped[slot]);
    return {
      label: `${slot} — ${it ? it.name : 'unknown'}`.slice(0, 100),
      value: `lo:unequip:do:${slot}`
    };
  });
  return {
    content: '🧤 **Unequip a slot:**',
    components: [
      selectRow('lo:unequip:do', 'Pick a slot to clear', options),
      backRow('lo:bag')
    ]
  };
}

async function unequipDo(env, guild, userId, slotKey) {
  const slot = (slotKey || '').replace(/^lo:unequip:do:/, '');
  const r = await cmdUnequip(env, guild, userId, slot);
  return { content: r.content, components: [backRow('lo:bag')] };
}

async function sellPicker(env, guild, userId) {
  const hero = await loadHeroFor(env, guild, userId);
  const options = sortBag(hero.bag).slice(0, 25).map(it => ({
    label: `${it.glyph} ${it.name}`.slice(0, 100),
    description: `Sells for ~${Math.max(1, Math.floor((it.goldValue || 1) / 2))} bolts (${it.rarity})`.slice(0, 100),
    value: `lo:sell:do:${it.id.slice(0, 16)}`
  }));
  if (options.length === 0) {
    return { content: '🎒 Your bag is empty — nothing to sell.', components: [backRow('lo:bag')] };
  }
  return {
    content: '💰 **Sell an item** (back to the shop for half value):',
    components: [
      selectRow('lo:sell:do', 'Pick an item to sell', options),
      backRow('lo:bag')
    ]
  };
}

async function sellDo(env, guild, userId, itemIdPrefix) {
  const id = (itemIdPrefix || '').replace(/^lo:sell:do:/, '');
  const r = await cmdSell(env, guild, userId, id);
  return { content: r.content, components: [backRow('lo:bag')] };
}

// ── Shop / Buy ─────────────────────────────────────────────────────

// Re-import the shop pool from dungeon.js by routing through cmdShop.
async function shopView(env, guild, userId) {
  const r = await cmdShop(env, guild, userId);
  return {
    content: r.content,
    components: [
      row(button('🛒 Buy…', 'lo:buy', BTN_SUCCESS)),
      backRow('lo:hero')
    ]
  };
}

async function buyPicker(env, guild, userId) {
  // Mirror dungeon.js's SHOP_POOL — duplicated here so the picker doesn't
  // require an extra round-trip just to enumerate. If pool changes there,
  // change here too. Same names so cmdShopBuy(name) resolves correctly.
  const pool = [
    ['Bronze Shortsword', '🗡️', 'common',    'weapon',  20 ],
    ['Steel Longsword',   '⚔️', 'uncommon',  'weapon',  60 ],
    ['Frost Hammer',      '🔨', 'rare',      'weapon', 180 ],
    ['Leather Cap',       '🧢', 'common',    'head',    18 ],
    ['Iron Helm',         '⛑️', 'uncommon',  'head',    55 ],
    ['Cloth Tunic',       '👕', 'common',    'chest',   18 ],
    ['Chainmail',         '🦺', 'uncommon',  'chest',   60 ],
    ['Worn Boots',        '🥾', 'common',    'boots',   16 ],
    ['Lucky Charm',       '🍀', 'uncommon',  'trinket', 70 ],
    ['Healing Amulet',    '📿', 'rare',      'trinket',220 ],
  ];
  const options = pool.map(([name, glyph, rarity, slot, gold]) => ({
    label: `${glyph} ${name}`.slice(0, 100),
    description: `${gold} bolts · ${rarity} ${slot}`.slice(0, 100),
    value: `lo:buy:do:${encodeURIComponent(name)}`
  }));
  return {
    content: '🛒 **Buy from the shop** — pick one:',
    components: [
      selectRow('lo:buy:do', 'Pick an item to buy', options),
      backRow('lo:shop')
    ]
  };
}

async function buyDo(env, guild, userId, encodedName) {
  const name = decodeURIComponent((encodedName || '').replace(/^lo:buy:do:/, ''));
  const r = await cmdShopBuy(env, guild, userId, name);
  return { content: r.content, components: [backRow('lo:shop')] };
}

// ── Training ───────────────────────────────────────────────────────

async function trainPicker() {
  return {
    content:
      '🥋 **Training** — spend bolts for a focused 5-round session (50 bolts).\n' +
      'Pick a focus — strength grants XP, endurance grants HP, reflexes grants XP and a full heal.',
    components: [
      row(
        button('🥊 Strength',  'lo:train:do:attack', BTN_PRIMARY),
        button('❤️ Endurance', 'lo:train:do:hp',     BTN_PRIMARY),
        button('💨 Reflexes',  'lo:train:do:dodge',  BTN_PRIMARY)
      ),
      backRow('lo:hero')
    ]
  };
}

async function trainDo(env, guild, userId, focus) {
  const r = await cmdTraining(env, guild, userId, focus, 5);
  return { content: r.content, components: [backRow('lo:hero')] };
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
  return { content: r.explanation || (r.won ? `🪙 Won ${r.delta}!` : `🪙 Lost ${Math.abs(r.delta || bet)}.`) };
}

async function cmdDiceInline(env, guild, userId, bet, target, userName) {
  if (!Number.isInteger(bet) || bet <= 0)     return { content: '❌ Wager must be a positive integer.' };
  if (!Number.isInteger(target) || target < 1 || target > 6) return { content: '❌ Target must be 1-6.' };
  const r = await dice(env, guild, userId, bet, target);
  return { content: r.explanation || (r.won ? `🎲 Won ${r.delta}!` : `🎲 Lost ${Math.abs(r.delta || bet)}.`) };
}

// ── Link ───────────────────────────────────────────────────────────

async function linkAction(env, guild, userId, platform, username, userName) {
  const allowed = new Set(['twitch', 'kick', 'youtube', 'tiktok']);
  if (!allowed.has(platform)) return { content: '❌ Platform must be one of: twitch / kick / youtube / tiktok.' };
  if (!username || username.length < 2) return { content: '❌ Username looks invalid.' };
  // Reuse the same wallet-link plumbing that /link previously hit. We
  // poke it via getWallet → mutate links → put.
  const w = await getWallet(env, guild, userId);
  w.links = w.links || [];
  // De-dupe by platform: replace any existing link for the same platform.
  w.links = w.links.filter(l => l.platform !== platform);
  w.links.push({ platform, username });
  await env.LOADOUT_BOLTS.put(`wallet:${guild}:${userId}`, JSON.stringify(w));
  return { content: `🔗 Linked **${userName}** to \`${platform}:${username}\`.` };
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
      '• **Quick games** — coinflip / dice for grinding bolts.\n' +
      '• **Link account** — connect this Discord to your stream identity (Twitch / Kick / YouTube / TikTok). Required for most commands.',
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

function linkModal() {
  return {
    custom_id: 'lo:m:link',
    title: 'Link your stream account',
    components: [
      {
        type: COMPONENT_ROW,
        components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'platform', label: 'Platform (twitch / kick / youtube / tiktok)',
                       style: INPUT_SHORT, required: true, min_length: 4, max_length: 10, placeholder: 'twitch' }]
      },
      {
        type: COMPONENT_ROW,
        components: [{ type: COMPONENT_TEXT_INPUT, custom_id: 'username', label: 'Username on that platform',
                       style: INPUT_SHORT, required: true, min_length: 2, max_length: 60, placeholder: 'your_handle' }]
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

// Hero state lookup. Two layers:
//   1. DLL-pushed hero (d:hero-by-handle:<guild>:<platform>:<handle>).
//      The DLL pushes its dungeon-heroes.json on the existing 5-minute
//      sync cadence; this is the "what stream-side play has earned"
//      surface. Looked up via wallet → first link → handle key.
//   2. Worker-local hero (d:hero:<guild>:<userId>). Per-Discord-user
//      progression for viewers who haven't linked yet, plus the place
//      Discord-side actions (/loadout shop-buy, /loadout train, equip)
//      write into. Used as fallback when no linked hero is found.
//
// The two layers diverge until a real bidirectional bridge exists
// (Phase 3) — for now off-stream and on-stream hero progression are
// separate but a linked viewer always sees their stream-earned gear
// in /loadout.
async function loadHeroFor(env, guild, userId) {
  const w = await getWallet(env, guild, userId);
  const link = (w.links || [])[0];
  if (link?.platform && link?.username) {
    const raw = await env.LOADOUT_BOLTS.get(
      `d:hero-by-handle:${guild}:${link.platform.toLowerCase()}:${link.username.toLowerCase()}`);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* fall through to local */ }
    }
  }
  const raw = await env.LOADOUT_BOLTS.get(`d:hero:${guild}:${userId}`);
  if (!raw) return { bag: [], equipped: {} };
  try { return JSON.parse(raw); } catch { return { bag: [], equipped: {} }; }
}
