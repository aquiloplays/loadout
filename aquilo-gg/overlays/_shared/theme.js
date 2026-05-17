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
 *   scale       0.1-3   scales the whole overlay (body zoom). Distinct
 *                       from fontScale conceptually — scale is "make
 *                       the whole thing bigger/smaller", fontScale is
 *                       "make the text bigger" — but both land on
 *                       body zoom in CEF. When both are set, they
 *                       multiply.
 *   opacity     0-100   whole-overlay opacity (body opacity). Lets a
 *                       streamer dial an overlay back so it sits
 *                       quieter against busy gameplay.
 *   offsetX     px      nudge the overlay horizontally (+ = right).
 *   offsetY     px      nudge the overlay vertically (+ = down).
 *                       Offsets apply as a body translate — handy for
 *                       pixel-aligning against a webcam frame or HUD.
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

  // ── Layout knobs: scale / opacity / offset ──────────────────────────
  // These three are applied together in a single DOMContentLoaded pass
  // so they don't fight each other (zoom + transform + opacity are
  // independent body properties; zoom must be set before transform so
  // the translate distances read in pre-zoom px the streamer expects).
  const scale   = num(params.get('scale'));
  const opacity = num(params.get('opacity'));
  const offsetX = num(params.get('offsetX'));
  const offsetY = num(params.get('offsetY'));

  const hasLayout =
    (scale   !== null && scale   > 0 && scale   <= 3) ||
    (opacity !== null && opacity >= 0 && opacity <= 100) ||
    (offsetX !== null) || (offsetY !== null);

  if (hasLayout) {
    document.addEventListener('DOMContentLoaded', () => {
      const b = document.body;
      // scale multiplies any existing zoom from fontScale above so a
      // streamer can use both knobs without one clobbering the other.
      if (scale !== null && scale > 0 && scale <= 3) {
        const prior = parseFloat(b.style.zoom) || 1;
        b.style.zoom = String(prior * scale);
      }
      if (opacity !== null && opacity >= 0 && opacity <= 100) {
        b.style.opacity = String(opacity / 100);
      }
      if (offsetX !== null || offsetY !== null) {
        const dx = offsetX || 0;
        const dy = offsetY || 0;
        // translate3d keeps the offset on the GPU layer and never
        // re-flows the document.
        b.style.transform = 'translate3d(' + dx + 'px, ' + dy + 'px, 0)';
      }
    }, { once: true });
  }
})();
