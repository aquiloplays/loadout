/*
 * aquilo.gg — Starting Soon overlay.
 *
 * Responsibilities:
 *   - Orientation switch. ?orientation=vertical|horizontal overrides;
 *     otherwise auto-detect from the viewport (portrait → vertical).
 *   - Headline / kicker / countdown / tonight chip population.
 *   - Schedule fetch from aquilo.gg/api/schedule (uses `nextStream`
 *     for label + startsAt; no auth, public endpoint). Falls back to
 *     ?countdownTo= + ?subtitle= if the fetch errors.
 *   - Drifting bolt particle injection.
 *   - Marquee track build + doubling (so the scroll never seams).
 *   - Optional Aquilo Bus live config swap, compatible with the
 *     existing lobby.config kind so a streamer can reuse their
 *     existing Streamer.bot publish action.
 *
 * No external libraries; CEF on Windows is the deployment target so
 * we stay vanilla and small.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  // ── Orientation ──────────────────────────────────────────────
  // Param wins; otherwise: ?vertical=1, then aspect-ratio detect.
  // OBS sizes the canvas before paint, so window.inner* is reliable.
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

  // ── Headline ─────────────────────────────────────────────────
  // Per-letter wave staggers via --i so the animation reads as a
  // wave even when the title has been overridden to something other
  // than "STARTING SOON".
  const headlineText = $('headline-text');
  const customTitle = params.get('title');
  if (customTitle) renderHeadline(customTitle.toUpperCase());
  else staggerExistingLetters();

  function renderHeadline(text) {
    headlineText.innerHTML = '';
    let i = 0;
    for (const ch of text) {
      const span = document.createElement('span');
      if (ch === ' ') {
        span.className = 'headline-gap';
        span.textContent = ' ';
      } else {
        span.textContent = ch;
        span.style.setProperty('--i', String(i++));
      }
      headlineText.appendChild(span);
    }
  }
  function staggerExistingLetters() {
    let i = 0;
    for (const span of headlineText.children) {
      if (span.classList.contains('headline-gap')) continue;
      span.style.setProperty('--i', String(i++));
    }
  }

  // ── Kicker / tonight chip ───────────────────────────────────
  const kickerEl       = $('kicker');
  const tonightEl      = $('tonight');
  const tonightLabelEl = $('tonight-label');
  function setKicker(text) {
    if (!kickerEl) return;
    kickerEl.textContent = text;
  }
  function setTonight(label) {
    if (!tonightLabelEl || !tonightEl) return;
    if (!label) { tonightEl.hidden = true; return; }
    tonightLabelEl.textContent = label;
    tonightEl.hidden = false;
  }

  // ── Countdown ───────────────────────────────────────────────
  const cdEl    = $('countdown');
  const cdHourEl = $('cd-h');
  const cdMinEl  = $('cd-m');
  const cdSecEl  = $('cd-s');
  let countdownTarget = null;

  function setCountdown(target) {
    countdownTarget = Number.isFinite(target) ? target : null;
    if (cdEl) cdEl.hidden = countdownTarget === null;
    tickCountdown();
  }
  function tickCountdown() {
    if (countdownTarget === null) return;
    const remaining = Math.max(0, countdownTarget - Date.now());
    const total = Math.floor(remaining / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (cdHourEl) cdHourEl.textContent = String(h).padStart(2, '0');
    if (cdMinEl)  cdMinEl.textContent  = String(m).padStart(2, '0');
    if (cdSecEl)  cdSecEl.textContent  = String(s).padStart(2, '0');
  }
  setInterval(tickCountdown, 250);

  // ── Schedule fetch ──────────────────────────────────────────
  // The widget runs from widget.aquilo.gg, so api.aquilo.gg is a
  // cross-origin fetch — CORS is enabled on the worker public API.
  const skipSchedule = params.get('schedule') === '0';
  const demo = params.get('demo') === '1';
  const manualCountdownTo = params.get('countdownTo');
  const manualSubtitle    = params.get('subtitle');

  async function loadSchedule() {
    if (skipSchedule) {
      applyManualOrDefault();
      return;
    }
    try {
      const res = await fetch('https://aquilo.gg/api/schedule', {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) throw new Error('schedule ' + res.status);
      const data = await res.json();
      const next = data && data.nextStream;
      if (!next || typeof next.startsAt !== 'number') {
        applyManualOrDefault();
        return;
      }
      const target = manualCountdownTo
        ? Date.parse(manualCountdownTo)
        : next.startsAt;
      setCountdown(Number.isFinite(target) ? target : next.startsAt);
      const label = manualSubtitle || next.label || '';
      setKicker(label ? 'tonight on aquilo.gg' : 'starting up the loadout');
      setTonight(label);
    } catch (err) {
      console.warn('[starting-soon] schedule fetch failed:', err);
      applyManualOrDefault();
    }
  }
  function applyManualOrDefault() {
    if (manualCountdownTo) {
      const t = Date.parse(manualCountdownTo);
      if (Number.isFinite(t)) setCountdown(t);
    } else if (demo) {
      // 7-minute fake countdown for local previews.
      setCountdown(Date.now() + 7 * 60 * 1000);
    }
    if (manualSubtitle) {
      setKicker('tonight on aquilo.gg');
      setTonight(manualSubtitle);
    } else if (demo) {
      setKicker('tonight on aquilo.gg');
      setTonight('Featured Run');
    } else {
      setKicker('loadout up, stream starts shortly');
    }
  }
  loadSchedule();

  // ── Drifting bolts ──────────────────────────────────────────
  // Fewer on vertical (narrower viewport) so they don't crowd. JS
  // builds them once at load; per-bolt CSS vars handle variety.
  const boltsHost = $('bolts');
  const BOLT_COUNT = orientation === 'vertical' ? 14 : 22;
  for (let i = 0; i < BOLT_COUNT; i++) {
    const b = document.createElement('span');
    b.className = 'bolt';
    const size  = 18 + Math.random() * 36;        // 18–54px
    const dur   = 11 + Math.random() * 9;         // 11–20s
    const delay = -Math.random() * dur;           // start mid-cycle
    const x     = Math.random() * 100;            // %
    const rot   = -20 + Math.random() * 40;       // -20…+20deg
    const alpha = 0.35 + Math.random() * 0.45;    // 0.35–0.8
    b.style.setProperty('--size',  size + 'px');
    b.style.setProperty('--dur',   dur + 's');
    b.style.setProperty('--delay', delay + 's');
    b.style.setProperty('--x',     x + '%');
    b.style.setProperty('--rot',   rot + 'deg');
    b.style.setProperty('--alpha', String(alpha));
    boltsHost.appendChild(b);
  }

  // ── Marquee ─────────────────────────────────────────────────
  // The track is doubled (...items, ...items) and translated -50%
  // so the loop seam is invisible. Streamers can override via
  // ?marquee=A,B,C — empty entries are dropped.
  const marqueeTrack = $('marquee-track');
  const customMarquee = (params.get('marquee') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const defaultMarquee = [
    'aquilo.gg',
    '!ready to mark yourself in the crew',
    'subs = 5 push-ups',
    '!sr from T2/T3 subs',
    '!tip $10 = 25 push-ups',
    'TikTok 1k+ hits the supporter board',
    'cheers 100+ count too',
    'follow / sub for the next loadout',
    'aquilo.gg/loadout, OBS overlays + economy',
    'aquilo.gg/streamfusion, one window for all your chats',
    'aquilo.gg/rotation, Spotify on stream',
  ];
  const items = customMarquee.length ? customMarquee : defaultMarquee;

  function renderMarqueeItem(text) {
    // Treat "key: rest" as a kbd-styled chip + label.
    const wrap = document.createElement('span');
    wrap.className = 'marquee-item';
    const dot = document.createElement('span');
    dot.className = 'marquee-dot';
    wrap.appendChild(dot);
    const colonIdx = text.indexOf(':');
    if (colonIdx > 0 && colonIdx < 24) {
      const key = document.createElement('span');
      key.className = 'marquee-key';
      key.textContent = text.slice(0, colonIdx).trim();
      const rest = document.createElement('span');
      rest.textContent = text.slice(colonIdx + 1).trim();
      wrap.appendChild(key);
      wrap.appendChild(rest);
    } else {
      const span = document.createElement('span');
      span.textContent = text;
      wrap.appendChild(span);
    }
    return wrap;
  }
  function buildMarquee() {
    marqueeTrack.innerHTML = '';
    // Double the items so the -50% scroll keyframe lands on a copy.
    for (const t of items) marqueeTrack.appendChild(renderMarqueeItem(t));
    for (const t of items) marqueeTrack.appendChild(renderMarqueeItem(t));
  }
  buildMarquee();

  // ── Optional Aquilo Bus subscription ────────────────────────
  // Reuses the existing `lobby.config` event kind from the lobby
  // overlay so a streamer can drive both with one publisher.
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
        if (typeof d.title       === 'string' && d.title)       renderHeadline(d.title.toUpperCase());
        if (typeof d.subtitle    === 'string')                  setTonight(d.subtitle);
        if (typeof d.countdownTo === 'string' && d.countdownTo) {
          const t = Date.parse(d.countdownTo);
          if (Number.isFinite(t)) setCountdown(t);
        }
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
