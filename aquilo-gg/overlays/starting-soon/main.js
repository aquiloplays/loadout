/*
 * aquilo.gg — Starting Soon overlay.
 *
 * Responsibilities (no countdown, no marquee — premium polish pass):
 *   - Orientation switch. ?orientation= overrides; otherwise the
 *     viewport's aspect ratio decides.
 *   - Headline letter rendering (so an overridden title still gets
 *     the per-letter gradient + wave-free shimmer).
 *   - Demo reel: preload every iframe at boot, scale each fixed-
 *     design iframe to fit its slide screen, cycle slides on a
 *     per-slide DWELL clock with a clean cross-fade.
 *   - Drifting bolt particles with depth (smaller = slower = blurrier).
 *   - Tonight chip fed from aquilo.gg/api/schedule (`nextStream.label`).
 *   - Optional Aquilo Bus live config swap, compatible with the
 *     lobby overlay's `lobby.config` event kind.
 *
 * Vanilla JS only — runs inside OBS's CEF without a build step,
 * same convention as every other overlay in this folder.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  // ── Orientation ──────────────────────────────────────────────
  const orientParam = (params.get('orientation') || '').toLowerCase();
  let orientation = 'horizontal';
  if (orientParam === 'vertical' || orientParam === 'portrait') {
    orientation = 'vertical';
  } else if (orientParam === 'horizontal' || orientParam === 'landscape') {
    orientation = 'horizontal';
  } else if (params.get('vertical') === '1') {
    orientation = 'vertical';
  } else if (window.innerHeight > window.innerWidth) {
    orientation = 'vertical';
  }
  document.body.setAttribute('data-orientation', orientation);

  // ── Headline render ─────────────────────────────────────────
  const headlineText = $('headline-text');
  const customTitle = params.get('title');
  if (customTitle) renderHeadline(customTitle.toUpperCase());

  function renderHeadline(text) {
    headlineText.innerHTML = '';
    for (const ch of text) {
      const span = document.createElement('span');
      if (ch === ' ') {
        span.className = 'headline-gap';
        span.textContent = ' ';
      } else {
        span.textContent = ch;
      }
      headlineText.appendChild(span);
    }
  }

  // ── Kicker / tonight chip ───────────────────────────────────
  // Kicker copy is FIXED (per stream brief): "Get free streaming
  // tools at aquilo.gg, join our community!" The schedule-derived
  // show name only populates the Tonight chip below; we don't
  // touch the kicker on schedule resolution anymore.
  const KICKER_DEFAULT = 'Get free streaming tools at aquilo.gg, join our community!';
  const kickerEl       = $('kicker');
  const tonightEl      = $('tonight');
  const tonightLabelEl = $('tonight-label');
  function setKicker(text) { if (kickerEl) kickerEl.textContent = text || KICKER_DEFAULT; }
  function setTonight(label) {
    if (!tonightLabelEl || !tonightEl) return;
    if (!label) { tonightEl.hidden = true; return; }
    tonightLabelEl.textContent = label;
    tonightEl.hidden = false;
  }
  // Ensure the default kicker shows on first paint (covers the
  // case where loadSchedule's fallback path isn't taken).
  setKicker(KICKER_DEFAULT);

  // ── Schedule fetch ──────────────────────────────────────────
  const skipSchedule  = params.get('schedule') === '0';
  const demo          = params.get('demo') === '1';
  const manualSubtitle = params.get('subtitle');

  async function loadSchedule() {
    if (skipSchedule) { applyManualOrDefault(); return; }
    try {
      const res = await fetch('https://aquilo.gg/api/schedule', {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) throw new Error('schedule ' + res.status);
      const data = await res.json();
      const next = data && data.nextStream;
      const label = manualSubtitle || (next && next.label) || '';
      if (label) setTonight(label);
    } catch (err) {
      console.warn('[starting-soon] schedule fetch failed:', err);
      applyManualOrDefault();
    }
  }
  function applyManualOrDefault() {
    if (manualSubtitle) setTonight(manualSubtitle);
    else if (demo)      setTonight('Featured Run');
  }
  loadSchedule();

  // ── Drifting bolts ──────────────────────────────────────────
  // Reduced from earlier passes; depth-of-field via per-bolt
  // size/blur/alpha so the field feels layered, not noisy.
  const boltsHost = $('bolts');
  const BOLT_COUNT = orientation === 'vertical' ? 8 : 12;
  for (let i = 0; i < BOLT_COUNT; i++) {
    const b = document.createElement('span');
    b.className = 'bolt';
    // 18-58 px range, biased smaller for depth.
    const depth = Math.pow(Math.random(), 1.4);          // 0..1, weighted small
    const size  = 18 + depth * 40;
    // Smaller (farther) bolts: longer dur, softer, dimmer.
    const dur   = 22 - depth * 9;                        // 13-22s
    const delay = -Math.random() * dur;                  // start mid-cycle
    const x     = Math.random() * 100;                   // %
    const drift = (Math.random() * 80) - 40;             // -40..+40px lateral wander
    const rot   = -18 + Math.random() * 36;              // -18..+18deg
    const alpha = 0.25 + depth * 0.45;                   // 0.25-0.7
    const glow  = 6 + depth * 16;                        // 6-22px drop-shadow
    const soft  = (1 - depth) * 1.6;                     // 0-1.6px blur on far bolts
    b.style.setProperty('--size',  size + 'px');
    b.style.setProperty('--dur',   dur + 's');
    b.style.setProperty('--delay', delay + 's');
    b.style.setProperty('--x',     x + '%');
    b.style.setProperty('--drift', drift + 'px');
    b.style.setProperty('--rot',   rot + 'deg');
    b.style.setProperty('--alpha', String(alpha));
    b.style.setProperty('--glow',  glow + 'px');
    b.style.setProperty('--soft',  soft.toFixed(2) + 'px');
    boltsHost.appendChild(b);
  }

  // ════════════════════════════════════════════════════════════
  // Demo reel
  // ════════════════════════════════════════════════════════════

  const reel = $('reel');
  const slidesParam = (params.get('slides') || 'streamkey,streamfusion,rotation,loadout,patron')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Per-slide dwell. Streamkey + SF show form/chat UIs that read
  // quickly; rotation gets the longest so its popout can sub-cycle
  // through two layout variants while the SLS2 video plays; loadout
  // gets a calm read for the before/after comparison; patron leaves
  // time to scan all five perks.
  const DWELL = {
    streamkey:     9000,
    streamfusion: 10000,
    rotation:     14000,
    loadout:      11000,
    patron:       12000,
  };
  const order = slidesParam.filter(id => DWELL.hasOwnProperty(id));
  if (order.length === 0) order.push('streamkey');

  // ── Rotation widget URL + preset sub-cycle ──────────────────
  // The rotation widget reads ?sync=<key> to bind to a streamer's
  // own config + Spotify tokens. Clay's sync key is private (it
  // would let anyone tail his rotation), so the starting-soon
  // overlay accepts it as ?spotifySync= on its OWN URL and forwards
  // it here. With no sync key we fall back to ?preview=1 (mocked
  // playback that still looks polished). The popout sub-cycles
  // between layout variants every few seconds during the rotation
  // slide so viewers see the widget's range, not just one look.
  const spotifySync = params.get('spotifySync') || params.get('sync') || '';
  function rotationUrl(variantQs) {
    const base = 'https://widget.aquilo.gg/rotation/widget';
    const qs = spotifySync
      ? ('sync=' + encodeURIComponent(spotifySync) + '&' + variantQs)
      : ('preview=1&' + variantQs);
    return base + '?' + qs;
  }
  // Visible layout variants. Each one is a distinct look:
  //   square    rich card with queue + lyrics
  //   minimal   stripped card, just the now-playing track
  //   compact   queue-only horizontal sliver
  // The widget interprets ?queue= and ?lyrics= as feature toggles
  // (in preview/demo contexts), and the data-fixed-w/h on the
  // popout determines the iframe's design surface so the layout
  // reads at the intended aspect.
  const ROTATION_VARIANTS = [
    { id: 'square',  label: 'layout: square',  qs: 'queue=1&lyrics=1', fw: 540, fh: 320 },
    { id: 'minimal', label: 'layout: minimal', qs: 'queue=0&lyrics=0', fw: 480, fh: 240 },
    { id: 'compact', label: 'layout: compact', qs: 'queue=1&lyrics=0', fw: 640, fh: 200 },
  ];
  const ROTATION_SUB_MS = 5000;
  const rotationIframe   = $('rotation-iframe');
  const rotationPopout   = $('rotation-popout');
  const rotationPresetEl = $('rotation-preset-pill');
  let rotationSubIdx = 0;
  let rotationSubTimer = null;
  function applyRotationVariant(idx) {
    const v = ROTATION_VARIANTS[idx % ROTATION_VARIANTS.length];
    if (!v || !rotationIframe || !rotationPopout) return;
    rotationPopout.setAttribute('data-fixed-w', String(v.fw));
    rotationPopout.setAttribute('data-fixed-h', String(v.fh));
    const newSrc = rotationUrl(v.qs);
    // Only reload the iframe if the URL actually changed — keeps
    // the first variant from re-mounting on every active-slide swap.
    if (rotationIframe.src !== newSrc) rotationIframe.src = newSrc;
    if (rotationPresetEl) rotationPresetEl.textContent = v.label;
    // Re-fit because data-fixed-w/h changed.
    fitOne(rotationPopout);
  }
  function startRotationSub() {
    clearInterval(rotationSubTimer);
    applyRotationVariant(rotationSubIdx);
    rotationSubTimer = setInterval(() => {
      rotationSubIdx = (rotationSubIdx + 1) % ROTATION_VARIANTS.length;
      applyRotationVariant(rotationSubIdx);
    }, ROTATION_SUB_MS);
  }
  function stopRotationSub() {
    clearInterval(rotationSubTimer);
    rotationSubTimer = null;
  }

  // Preload every iframe at boot. data-src -> src so each slide is
  // already animating by the time its turn comes up — no "first
  // frame blank" tax. Same-origin iframes also get a small style
  // injection to hide their own dev/debug badges; cross-origin
  // throws on access, which we swallow (StreamFusion + rotation
  // widget don't surface dev badges anyway).
  function preloadFrames() {
    document.querySelectorAll('iframe.demo-frame[data-src]').forEach(f => {
      const src = f.getAttribute('data-src');
      if (src && !f.src) f.src = src;
      f.addEventListener('load', () => {
        try {
          const doc = f.contentDocument;
          if (!doc) return;
          const style = doc.createElement('style');
          style.textContent = '.dev-status,#devStatus,.dev{display:none!important}';
          doc.head.appendChild(style);
        } catch {
          // cross-origin frame, expected
        }
      }, { once: true });
    });
  }

  // Scale each iframe to fit its container. Container can be a
  // `.slide-screen` (full-slide iframe) or a `.slide-popout` (the
  // rotation widget over the SLS2 video). Both carry data-fixed-w
  // and data-fixed-h with the iframe's natural design size; we
  // scale via transform so the iframe always fits its box without
  // a horizontal/vertical scrollbar.
  function fitOne(el) {
    if (!el) return;
    const fw = parseInt(el.getAttribute('data-fixed-w'), 10) || 0;
    const fh = parseInt(el.getAttribute('data-fixed-h'), 10) || 0;
    const iframe = el.querySelector('iframe.demo-frame');
    if (!fw || !fh || !iframe) return;
    iframe.style.width  = fw + 'px';
    iframe.style.height = fh + 'px';
    iframe.style.transformOrigin = '0 0';
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const s = Math.min(r.width / fw, r.height / fh);
    iframe.style.left = (r.width  / 2 - (fw * s) / 2) + 'px';
    iframe.style.top  = (r.height / 2 - (fh * s) / 2) + 'px';
    iframe.style.transform = `scale(${s.toFixed(4)})`;
  }
  function fitFrames() {
    document.querySelectorAll('[data-fixed-w][data-fixed-h]').forEach(el => {
      fitOne(el);
      new ResizeObserver(() => fitOne(el)).observe(el);
    });
  }

  // Pull the live patron list from the supporter-wall endpoint. CORS
  // is enabled on the worker; if the fetch fails we just show "join
  // now and be first" as a friendly fallback. The endpoint can also
  // return `pending:true` while warming up — we treat that as empty.
  const PATRON_CAP = 12; // visible names; the count line shows the full total
  async function loadPatrons() {
    const gridEl  = $('patron-grid');
    const countEl = $('patron-count');
    if (!gridEl || !countEl) return;
    try {
      const res = await fetch('https://aquilo.gg/api/community/supporter-wall', {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) throw new Error('supporter-wall ' + res.status);
      const data = await res.json();
      const list = Array.isArray(data && data.supporters) ? data.supporters : [];
      renderPatrons(list, gridEl, countEl);
    } catch (err) {
      console.warn('[starting-soon] patron fetch failed:', err);
      renderPatrons([], gridEl, countEl);
    }
  }
  function renderPatrons(list, gridEl, countEl) {
    gridEl.innerHTML = '';
    countEl.textContent = list.length
      ? (list.length + ' patron' + (list.length === 1 ? '' : 's'))
      : 'be the first';
    if (!list.length) {
      const empty = document.createElement('span');
      empty.className = 'patron-pill patron-pill--loading';
      empty.textContent = 'be patron #1 at join.aquilo.gg';
      gridEl.appendChild(empty);
      return;
    }
    list.slice(0, PATRON_CAP).forEach((p, i) => {
      const pill = document.createElement('span');
      pill.className = 'patron-pill';
      // Stagger entrance for a polished cascade.
      pill.style.animationDelay = (i * 40) + 'ms';
      const dot = document.createElement('span');
      dot.className = 'patron-pill-dot';
      const name = document.createElement('span');
      name.textContent = p.username || ('Supporter ' + ((p.discordId || '').slice(-4) || '?'));
      pill.appendChild(dot);
      pill.appendChild(name);
      gridEl.appendChild(pill);
    });
    if (list.length > PATRON_CAP) {
      const more = document.createElement('span');
      more.className = 'patron-pill';
      more.style.animationDelay = (PATRON_CAP * 40) + 'ms';
      more.textContent = '+' + (list.length - PATRON_CAP) + ' more';
      gridEl.appendChild(more);
    }
  }

  // Rotation engine. Sets the [data-active] on the reel root; CSS
  // attribute selectors swap which slide is visible. The dots
  // morph their width via the same data-active.
  let activeIdx = 0;
  let advanceTimer = null;
  function setActive(id) {
    reel.setAttribute('data-active', id);
    if (id === 'rotation') startRotationSub();
    else                   stopRotationSub();
  }
  function advance() {
    activeIdx = (activeIdx + 1) % order.length;
    const next = order[activeIdx];
    setActive(next);
    schedule(DWELL[next] || 10000);
  }
  function schedule(ms) {
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(advance, ms);
  }

  // Click on a dot to jump and reset the dwell timer. Pointer
  // events work in the preview; OBS browser sources are
  // non-interactive by default, so this is purely a dev aid.
  document.querySelectorAll('.reel-dot[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      const idx = order.indexOf(target);
      if (idx < 0) return;
      activeIdx = idx;
      setActive(target);
      schedule(DWELL[target] || 10000);
    });
  });

  // Kick the reel.
  preloadFrames();
  // Initialise the rotation popout with its first variant BEFORE
  // fitFrames runs so the iframe already has a src + the popout
  // has correct data-fixed-w/h to scale against.
  applyRotationVariant(0);
  fitFrames();
  loadPatrons();
  setActive(order[0]);
  schedule(DWELL[order[0]] || 10000);

  // ── Optional Aquilo Bus subscription ────────────────────────
  // Reuses the existing `lobby.config` kind for live overrides
  // (title, subtitle). countdownTo is ignored — there's no
  // countdown in this overlay anymore.
  const busUrl = params.get('bus');
  const secret = params.get('secret') || '';
  if (busUrl) {
    let ws = null, backoff = 1000;
    const connect = () => {
      let url = busUrl;
      if (secret && !url.includes('secret=')) {
        url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
      }
      try { ws = new WebSocket(url); } catch { return; }
      ws.onopen = () => {
        backoff = 1000;
        ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-starting-soon' }));
        ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['lobby.*'] }));
      };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (!msg || msg.kind !== 'lobby.config') return;
        const d = msg.data || {};
        if (typeof d.title    === 'string' && d.title)    renderHeadline(d.title.toUpperCase());
        if (typeof d.subtitle === 'string')               setTonight(d.subtitle);
      };
      ws.onclose = () => {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      ws.onerror = () => {};
    };
    connect();
  }
})();
