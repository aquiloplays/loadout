/*
 * Loadout overlays - shared theme bridge.
 *
 * Reads theming knobs from the URL and writes them to CSS variables on
 * :root (and a couple of body styles) so any overlay that uses
 * var(--accent), var(--accent2), var(--bg-alpha), var(--font-scale),
 * or var(--text) picks them up automatically. Also applies font-family
 * directly to body so overlays without a `--font` var still update.
 *
 * Settings UI builds the URL with these knobs; this script lets every
 * overlay support per-streamer theming without forking each one.
 *
 * Recognized params:
 *   accent      hex     primary accent color (no leading # needed)
 *   accent2     hex     secondary accent (gradients, sub-emphasis)
 *   text        hex     foreground / body text color
 *   bgOpacity   0-100   surface alpha (writes --bg-alpha)
 *   fontScale   0.1-3   multiplies overlay font sizes (writes --font-scale)
 *   font        family  CSS font-family stack, URL-encoded.
 *                       e.g. font=Inter%2Csans-serif
 */
(() => {
  const params = new URLSearchParams(location.search);
  const root = document.documentElement.style;

  const hex = (s) => (s ? '#' + s.replace(/^#/, '') : null);
  const num = (s) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  };

  const accent = hex(params.get('accent'));
  if (accent) root.setProperty('--accent', accent);

  const accent2 = hex(params.get('accent2'));
  if (accent2) root.setProperty('--accent2', accent2);

  const text = hex(params.get('text'));
  if (text) {
    root.setProperty('--text', text);
    // body overrides if the overlay's CSS hardcoded `color: ...` on body.
    document.addEventListener('DOMContentLoaded', () => {
      document.body.style.color = text;
    }, { once: true });
  }

  const bgOpacity = num(params.get('bgOpacity'));
  if (bgOpacity !== null && bgOpacity >= 0 && bgOpacity <= 100) {
    root.setProperty('--bg-alpha', String(bgOpacity / 100));
  }

  const fontScale = num(params.get('fontScale'));
  if (fontScale !== null && fontScale > 0 && fontScale <= 3) {
    root.setProperty('--font-scale', String(fontScale));
    // Most overlays ignore --font-scale because their sizes are absolute;
    // applying it as a `zoom` on body gives the streamer a working knob
    // until each overlay's CSS opts into the var explicitly. CEF (Chromium
    // in OBS) supports `zoom` reliably.
    document.addEventListener('DOMContentLoaded', () => {
      document.body.style.zoom = String(fontScale);
    }, { once: true });
  }

  const font = params.get('font');
  if (font) {
    root.setProperty('--font', font);
    document.addEventListener('DOMContentLoaded', () => {
      document.body.style.fontFamily = font;
    }, { once: true });
  }
})();
