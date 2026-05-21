/*
 * Loadout overlays — TikTok gift rendering helper.
 *
 * TikTok doesn't publish an official icon CDN, but the gift names
 * come through stable from the TikFinity → CPH path. This helper
 * surfaces a (sprite, label) pair per gift so overlays can render
 * `[gift icon] Rose ×2` without each overlay duplicating the formatting.
 *
 * No emoji — pixel-art only. We don't ship a per-gift sprite roster
 * (TikTok's gift catalogue is too big to maintain in-repo), so every
 * gift currently renders with the shared /sprites/ui/icons/gift.png
 * icon. If a streamer wants per-gift artwork, override the icon
 * lookup at render time (or extend this map with sprite paths once
 * the per-gift sprites land).
 *
 * Usage:
 *   const { icon, label } = TikTokGifts.render({ giftName: 'Rose', coins: 1 });
 *   //   icon  = '/sprites/ui/icons/gift.png'
 *   //   label = 'Rose ×1'
 *
 * Streamer override (future):
 *   TikTokGifts.setIconFor('rose', '/sprites/tiktok/rose.png');
 */
(function () {
  // Per-gift icon overrides. Empty by default; populated at runtime
  // if a streamer ships a custom sprite. Keys are normalised gift names.
  const customIcons = Object.create(null);

  function normalize(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[._\-]+/g, ' ')
      .replace(/\s+/g, ' ');
  }

  function icon(giftName) {
    const k = normalize(giftName);
    if (customIcons[k]) return customIcons[k];
    return '/sprites/ui/icons/gift.png';
  }

  function setIconFor(giftName, spritePath) {
    customIcons[normalize(giftName)] = String(spritePath || '');
  }

  function label(d) {
    if (!d) return 'gift';
    const name = d.giftName || 'gift';
    const coins = d.coins ? ' ×' + d.coins : '';
    return name + coins;
  }

  function render(d) {
    return { icon: icon(d && d.giftName), label: label(d) };
  }

  // Expose globally — overlays include this via <script src> and
  // read window.TikTokGifts.{icon, label, render, setIconFor, normalize}.
  window.TikTokGifts = { icon, label, render, setIconFor, normalize };
})();
