// Discord embed builders — shared layout and brand language so every
// command response feels like part of the same product. We deliberately
// don't pull a chart/canvas library in; pure embed JSON is fast, cache-
// friendly on Cloudflare Workers, and renders identically across Discord
// clients (mobile / web / desktop).
//
// Brand colours (must match the overlays' --ld-* tokens):
//   accent:    #3A86FF (blue)
//   accent-2:  #6BA9FF
//   gold:      #F0B429
//   win:       #3FB950
//   lose:      #F85149
//   purple:    #B452FF
//   pink:      #FF5DAA
//   cyan:      #00F2EA

export const COLORS = {
  accent:  0x3A86FF,
  gold:    0xF0B429,
  win:     0x3FB950,
  lose:    0xF85149,
  purple:  0xB452FF,
  pink:    0xFF5DAA,
  cyan:    0x00F2EA,
  muted:   0x4A4A55,
};

// Pretty-print a number with commas. Used for bolts balances, lifetime
// counters, anything that benefits from grouping at the thousands.
export function n(x) {
  const v = Number(x) || 0;
  return v.toLocaleString('en-US');
}

// Format a date in a relative-friendly way for embed footers/timestamps.
export function dt(ms) {
  return new Date(ms || Date.now()).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

// Inline progress bar — a 12-segment block-character bar, useful in
// embed fields where chart libs aren't available. Fills proportionally
// from 0 → max with a softer character for the unfilled portion.
export function bar(value, max, len = 12) {
  const v = Math.max(0, Math.min(max || 1, Number(value) || 0));
  const filled = Math.round((v / (max || 1)) * len);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, len - filled));
}

// Compute the current daily-streak multiplier label (e.g. "×7").
export function streakLabel(days) {
  const d = Math.max(0, Math.min(10, Number(days) || 0));
  return d > 0 ? `×${d}` : '×0';
}

// Build a balance embed. Used by /balance and the menu's wallet view.
export function balanceEmbed({ userId, userName, wallet, links }) {
  const linkRows = (links || []).length === 0
    ? '_no stream identity linked yet_  ·  use **/loadout** → Link to claim your bolts'
    : links.map(l => `\`${l.platform}\` ${l.username}`).join('  ·  ');

  return {
    color: COLORS.accent,
    author: {
      name: `${userName || 'Viewer'}'s wallet`,
    },
    fields: [
      {
        name:   '⚡ Balance',
        value:  `**${n(wallet?.balance || 0)}** bolts`,
        inline: true
      },
      {
        name:   '📈 Lifetime earned',
        value:  `${n(wallet?.lifetimeEarned || 0)} bolts`,
        inline: true
      },
      {
        name:   '🔥 Daily streak',
        value:  `${streakLabel(wallet?.dailyStreak || 0)}  ·  ${wallet?.dailyStreak || 0}-day`,
        inline: true
      },
      {
        name:   '🔗 Linked accounts',
        value:  linkRows,
        inline: false
      }
    ],
    footer: { text: 'Loadout · /loadout for the full menu' },
    timestamp: new Date().toISOString()
  };
}

// /daily reward — color shifts from accent (low streak) → gold (cap)
// so the moment is visually rewarded as the streak grows.
export function dailyEmbed({ userName, payout, streak }) {
  const cappedColor = streak >= 10 ? COLORS.gold : streak >= 5 ? COLORS.purple : COLORS.accent;
  return {
    color: cappedColor,
    author: { name: `${userName || 'Viewer'}'s daily` },
    title: `🎁 +${n(payout)} bolts`,
    description: `Day **${streak}** streak  ·  ${streakLabel(streak)} multiplier  ·  next claim in 23h`,
    fields: [
      {
        name:   'Streak progress',
        value:  '`' + bar(streak, 10) + '`  ' + streak + '/10',
        inline: false
      }
    ],
    footer: { text: 'Loadout · come back tomorrow to keep the streak alive' },
    timestamp: new Date().toISOString()
  };
}

// Coinflip / dice / minigame result embed — outcome drives the colour
// + heading. Wagers under 10 bolts skip the celebration treatment so
// chat doesn't get drowned in /coinflip 1 spam.
export function gameEmbed({ kind, won, userName, wager, payout, result, target, rolled }) {
  const color = won ? COLORS.win : COLORS.lose;
  const fields = [];
  if (kind === 'coinflip') {
    fields.push({ name: 'Result', value: `🪙 ${result || (won ? 'heads' : 'tails')}`, inline: true });
  } else if (kind === 'dice') {
    fields.push({ name: 'Rolled', value: `🎲 ${rolled || '?'}`, inline: true });
    if (target) fields.push({ name: 'Target', value: String(target), inline: true });
  }
  fields.push({ name: 'Wager', value: `${n(wager)} ⚡`, inline: true });
  fields.push({
    name:   won ? '✨ Payout' : '💸 Loss',
    value:  won ? `+${n(payout)} ⚡` : `-${n(wager)} ⚡`,
    inline: true
  });

  return {
    color,
    author: { name: `${userName || 'Viewer'}'s ${kind}` },
    title:  won ? '🎉  WIN' : '😬  LOSS',
    fields,
    footer: { text: won ? 'Loadout · ride the streak' : 'Loadout · try again' },
    timestamp: new Date().toISOString()
  };
}

// Hero / RPG embed — level + HP + class + active equipment as inline
// fields. Sized to fit Discord's 25-field limit and renders cleanly
// with or without an avatar.
export function heroEmbed({ userName, hero, equippedItems }) {
  const cls = (hero?.className || '').trim();
  const lvl = hero?.level || 1;
  const xp  = hero?.xp || 0;
  const xpMax = xpForLevelLocal(lvl);

  const fields = [
    {
      name:   '🛡 Class · Level',
      value:  cls ? `**${cls}** · Lv ${lvl}` : `Lv ${lvl}`,
      inline: true
    },
    {
      name:   '❤ HP',
      value:  `${hero?.hpCurrent || 0} / ${hero?.hpMax || 0}`,
      inline: true
    },
    {
      name:   '✨ XP',
      value:  '`' + bar(xp, xpMax, 10) + '`  ' + xp + '/' + xpMax,
      inline: true
    }
  ];

  // Equipment summary — top 3 slots only so the embed stays scannable.
  if (equippedItems && equippedItems.length > 0) {
    const lines = equippedItems.slice(0, 6).map(it =>
      `${it.glyph || '·'}  **${it.name}**  _(${it.rarity || '?'} ${it.slot})_${it.ability ? '  🔮 ' + it.ability : ''}`
    );
    fields.push({ name: '⚔ Equipped', value: lines.join('\n').slice(0, 1024), inline: false });
  }

  return {
    color: COLORS.purple,
    author: { name: `${userName || 'Viewer'}'s hero` },
    fields,
    footer: { text: 'Loadout · /loadout → Bag to manage gear' },
    timestamp: new Date().toISOString()
  };
}

// Shop preview embed — shows up to 12 items in a fenced-code list so
// alignment stays clean across mobile and desktop. Highlight items
// matching the viewer's class with a sparkle.
export function shopEmbed({ items, viewerClass, rotateInLabel }) {
  const list = (items || []).map(row => {
    const [slot, rarity, name, glyph, atk, def, gold, setName, weaponType, preferredClass, ability] = row;
    const stats = [];
    if (atk) stats.push('+' + atk + 'A');
    if (def) stats.push('+' + def + 'D');
    if (ability) stats.push('🔮 ' + ability);
    const matchedClass = viewerClass && preferredClass === viewerClass.toLowerCase();
    const flair = matchedClass ? '✨' : '  ';
    return `${flair} \`${String(gold).padStart(4)}b\` ${glyph} **${name}** _${rarity}_  ${stats.join(' ')}`;
  }).join('\n').slice(0, 4000);

  return {
    color: COLORS.gold,
    author: { name: '🏪 Daily shop' },
    description: list || '_shop is empty today_',
    footer: { text: `Loadout · stock rotates in ${rotateInLabel || 'a few hours'}` },
    timestamp: new Date().toISOString()
  };
}

// Achievement notification embed. Used when a viewer hits a milestone
// (dungeon, bolts, hype train) — posts in the streamer's notification
// channel so achievements feel earned rather than silent.
export function achievementEmbed({ userName, achievementName, description, glyph, rewardBolts }) {
  return {
    color: COLORS.gold,
    title: `${glyph || '🏆'}  Achievement unlocked`,
    description: `**${userName || 'Viewer'}** earned **${achievementName}**\n_${description || ''}_`,
    fields: rewardBolts > 0 ? [{ name: 'Reward', value: `+${n(rewardBolts)} ⚡`, inline: true }] : undefined,
    footer: { text: 'Loadout' },
    timestamp: new Date().toISOString()
  };
}

// Helper — duplicates the DLL's level curve so embeds can render the
// XP bar without a sync round-trip.
function xpForLevelLocal(level) {
  if (level <= 1) return 50;
  return 50 + (level - 1) * 35 + (level - 1) * (level - 1) * 8;
}
