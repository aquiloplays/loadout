/*
 * Loadout overlays - shared theme bridge.
 *
 * Reads accent / bgOpacity / fontScale from the URL and writes them to
 * CSS variables on :root so any overlay that uses var(--accent),
 * var(--bg-alpha), or var(--font-scale) picks them up automatically.
 *
 * Settings UI builds the URL with these knobs; this script lets every
 * overlay support per-streamer theming without forking each one.
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

  const bgOpacity = num(params.get('bgOpacity'));
  if (bgOpacity !== null && bgOpacity >= 0 && bgOpacity <= 100) {
    root.setProperty('--bg-alpha', String(bgOpacity / 100));
  }

  const fontScale = num(params.get('fontScale'));
  if (fontScale !== null && fontScale > 0 && fontScale <= 3) {
    root.setProperty('--font-scale', String(fontScale));
  }
})();
