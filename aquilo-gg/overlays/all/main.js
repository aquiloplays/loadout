/*
 * Loadout — All-in-one overlay router.
 *
 * Composites every enabled standalone overlay into ONE OBS browser
 * source. Each layer is an <iframe> pointing at the standalone
 * overlay path, with bus + secret + per-layer position / scale /
 * opacity forwarded on the iframe URL so the inner overlay's own
 * main.js + theme.js handle rendering. Layers not enabled never get
 * an iframe — no wasted WebSocket per disabled layer.
 *
 * ── Per-layer config ──────────────────────────────────────────────
 * The `layers` URL param is a CSV of entries. Each entry is:
 *
 *     name[@pos][*scale][~opacity]
 *
 *   name     overlay folder name (bolts, counters, goals, …)
 *   @pos     position anchor passed to the overlay's ?pos= param
 *            (tl tr bl br tc bc lc rc — overlay-dependent)
 *   *scale   0.1–3 multiplier, forwarded as ?scale=
 *   ~opacity 0–100, forwarded as ?opacity=
 *
 * Examples:
 *     ?layers=bolts@tr,counters@tl*0.9,commands@bl~70
 *     ?layers=bolts,goals          (bare names = overlay defaults)
 *
 * Legacy `?layers=bolts,counters` (names only) still works — entries
 * without an @pos fall back to the NON_OVERLAP_DEFAULTS map below so
 * a fresh composite never stacks two panels in the same corner.
 *
 * ── Why defaults matter ───────────────────────────────────────────
 * Standalone overlays each anchor to their own preferred corner. Drop
 * eight of them into one canvas with no positioning and three will
 * pile into the top-left. NON_OVERLAP_DEFAULTS hands each persistent
 * overlay its own zone; the transient takeovers (check-in / recap /
 * lobby) are full-canvas by nature so they're left alone.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const bus    = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';

  // Sensible non-overlapping home for each layer. Persistent panels
  // get a dedicated corner / edge; transient full-canvas takeovers
  // (check-in, recap) get no pos — they own the whole screen for
  // their brief animation and self-dismiss.
  const NON_OVERLAP_DEFAULTS = {
    bolts:     'tr',   // leaderboard panel — top-right
    counters:  'tl',   // counter row — top-left
    goals:     'lc',   // goal bars — left-center, below counters
    apex:      'tc',   // top-viewer status bar — top-center
    commands:  'bl',   // command ticker — bottom-left
    viewer:    'br',   // viewer profile card — bottom-right
    hypetrain: 'tc',   // hype train — top-center (transient; shares
                       // with apex, but a train is a takeover moment)
    minigames: 'bc',   // minigame card — bottom-center (transient)
    'check-in': '',    // full-canvas takeover
    recap:      '',    // full-canvas takeover
    lobby:      ''     // full-canvas takeover
  };

  // Parse one `name[@pos][*scale][~opacity]` entry into a config obj.
  function parseEntry(raw) {
    const s = (raw || '').trim();
    if (!s) return null;
    // Split off ~opacity, then *scale, then @pos — order-independent
    // because each marker is unique.
    let name = s, pos = null, scale = null, opacity = null;
    const op = name.split('~'); if (op.length === 2) { name = op[0]; opacity = op[1]; }
    const sc = name.split('*'); if (sc.length === 2) { name = sc[0]; scale   = sc[1]; }
    const ps = name.split('@'); if (ps.length === 2) { name = ps[0]; pos     = ps[1]; }
    name = name.trim();
    if (!name) return null;
    return {
      name,
      pos:     pos     ? pos.trim() : null,
      scale:   scale   ? parseFloat(scale)   : null,
      opacity: opacity ? parseInt(opacity, 10) : null
    };
  }

  const layersParam = params.get('layers') ||
    'bolts,counters,goals,apex,commands,recap,viewer,hypetrain';
  const entries = layersParam.split(',')
    .map(parseEntry)
    .filter(Boolean);
  // Index by name so we can look up each .layer div's config.
  const byName = new Map();
  for (const e of entries) byName.set(e.name, e);

  document.querySelectorAll('.layer').forEach(el => {
    const name = el.dataset.name;
    const cfg  = byName.get(name);
    if (!cfg) {
      // Not enabled — never create the iframe.
      el.classList.add('hidden');
      return;
    }

    const baseSrc = el.dataset.src;
    const url = new URL(baseSrc, location.href);
    url.searchParams.set('bus', bus);
    if (secret) url.searchParams.set('secret', secret);

    // Position: explicit @pos wins, else the non-overlap default.
    // Empty string = a full-canvas takeover; don't set ?pos at all.
    const pos = cfg.pos != null ? cfg.pos
              : (name in NON_OVERLAP_DEFAULTS ? NON_OVERLAP_DEFAULTS[name] : null);
    if (pos) url.searchParams.set('pos', pos);

    // Scale + opacity are handled by the inner overlay's theme.js.
    if (cfg.scale != null && cfg.scale > 0 && cfg.scale <= 3)
      url.searchParams.set('scale', String(cfg.scale));
    if (cfg.opacity != null && cfg.opacity >= 0 && cfg.opacity <= 100)
      url.searchParams.set('opacity', String(cfg.opacity));

    const iframe = document.createElement('iframe');
    iframe.src = url.toString();
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('scrolling', 'no');
    iframe.title = 'Loadout ' + name + ' overlay';
    el.appendChild(iframe);
  });
})();
