/*
 * Loadout overlays — TikTok gift rendering helper.
 *
 * TikTok doesn't publish an official icon CDN, but the gift names are
 * stable across the TikFinity → CPH path. This file maps the most
 * common gift names to a hand-picked emoji that reads well in a small
 * card. Unknown gifts fall back to 🎁 so the overlay never renders
 * a bare "tiktokGift" string.
 *
 * Streamers can extend the map by editing this file (add a row, save,
 * refresh OBS browser source). Future enhancement: surface a
 * Settings-side override map keyed by gift name.
 *
 * Usage:
 *   const label = TikTokGifts.label({ giftName: 'Rose', coins: 1 });
 *   // → "🌹 Rose"
 */
(function () {
  const map = {
    // Core / common
    'rose':                 '🌹',
    'tiktok':               '🎵',
    'heart me':             '❤️',
    'finger heart':         '💗',
    'hand hearts':          '💞',
    'doughnut':             '🍩',
    'panda':                '🐼',
    'love bang':            '💥',
    'rosa':                 '🌹',
    'lighting bolt':        '⚡',
    'lightning bolt':       '⚡',
    'gg':                   '🎮',
    'icecream cone':        '🍦',
    'ice cream cone':       '🍦',
    'football':             '⚽',
    'basketball':           '🏀',
    'mic':                  '🎤',
    'microphone':           '🎤',
    'pearl':                '🦪',
    'paper crane':          '🕊️',
    'team bracelet':        '🤝',
    'friendship necklace':  '🪢',

    // Mid-tier
    'perfume':              '🌸',
    'sunglasses':           '🕶️',
    'doughnut tower':       '🧁',
    'rainbow puke':         '🌈',
    'levitating':           '🪂',
    'bunny':                '🐇',
    'corgi':                '🐶',
    'love you':             '💌',
    'birthday cake':        '🎂',
    'cake slice':           '🍰',
    'champagne':            '🍾',
    'cool bear':            '🧸',
    'thumbs up':            '👍',

    // High-tier
    'galaxy':               '🌌',
    'tiktok universe':      '🌌',
    'lion':                 '🦁',
    'tiger':                '🐅',
    'dragon':               '🐉',
    'phoenix':              '🦅',
    'whale':                '🐋',
    'unicorn fantasy':      '🦄',
    'rocket':               '🚀',
    'falcon':               '🦉',
    'sports car':           '🏎️',
    'motorcycle':           '🏍️',
    'crown':                '👑',
    'castle':               '🏰',
    'planet':               '🪐'
  };

  function normalize(name) {
    return (name || '').toString().trim().toLowerCase()
      .replace(/[’']/g, '')          // strip apostrophes
      .replace(/\s+/g, ' ');              // collapse whitespace
  }

  function emoji(name) {
    if (!name) return '🎁';
    const k = normalize(name);
    if (map[k]) return map[k];
    // Forgive plurals / "s" suffix.
    if (k.endsWith('s') && map[k.slice(0, -1)]) return map[k.slice(0, -1)];
    return '🎁';
  }

  function label(d) {
    if (!d) return '🎁 gift';
    const e = emoji(d.giftName);
    const name = d.giftName || 'gift';
    const coins = d.coins ? ' ×' + d.coins : '';
    return e + ' ' + name + coins;
  }

  // Expose globally — overlays can include this script via <script src>
  // and read window.TikTokGifts.{emoji,label,normalize}.
  window.TikTokGifts = { emoji, label, normalize };
})();
