/*
 * Loadout — pre-stream lobby overlay.
 *
 * Subscribes to:
 *   lobby.config       — streamer-side override of title/subtitle/countdown
 *   welcome.fired      — adds the viewer to the arrival board
 *   chat.message       — `!ready` adds the viewer to the arrival board
 *
 * If the streamer hasn't published lobby.config yet, the URL params
 * ?title= ?subtitle= ?countdownTo= drive the same fields.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';

  // Initial config from URL params — the streamer can also publish
  // `lobby.config` on the bus to swap these live.
  let cfg = {
    title:        params.get('title')        || 'Starting soon',
    subtitle:     params.get('subtitle')     || 'loadout up',
    countdownTo:  params.get('countdownTo')  || '',
    showArrivals: params.get('showArrivals') !== '0'
  };

  const titleEl    = $('title');
  const subtitleEl = $('subtitle');
  const cdHourEl   = $('cd-h');
  const cdMinEl    = $('cd-m');
  const cdSecEl    = $('cd-s');
  const cdEl       = $('countdown');
  const arrivalsEl = $('arrivals');
  const arrivalsListEl  = $('arrivals-list');
  const arrivalsCountEl = $('arrivals-count');

  function applyConfig() {
    if (titleEl)    titleEl.textContent    = cfg.title    || 'Starting soon';
    if (subtitleEl) subtitleEl.textContent = cfg.subtitle || '';
    if (cdEl) {
      if (cfg.countdownTo) cdEl.classList.remove('hidden');
      else                 cdEl.classList.add('hidden');
    }
    if (arrivalsEl) {
      if (cfg.showArrivals) arrivalsEl.classList.remove('hidden');
      else                  arrivalsEl.classList.add('hidden');
    }
  }
  applyConfig();

  // ── Countdown ──────────────────────────────────────────────────────
  function tickCountdown() {
    if (!cfg.countdownTo) return;
    const target = new Date(cfg.countdownTo).getTime();
    if (!Number.isFinite(target)) return;
    const remaining = Math.max(0, target - Date.now());
    const total = Math.floor(remaining / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (cdHourEl) cdHourEl.textContent = String(h).padStart(2, '0');
    if (cdMinEl)  cdMinEl.textContent  = String(m).padStart(2, '0');
    if (cdSecEl)  cdSecEl.textContent  = String(s).padStart(2, '0');
  }
  setInterval(tickCountdown, 250);
  tickCountdown();

  // ── Arrival board ──────────────────────────────────────────────────
  // Cap the visible list so a packed pre-stream chat doesn't stretch
  // the card off-canvas. Once over cap, oldest pills shift out so the
  // most recent N are always visible.
  const MAX_VISIBLE = 24;
  const seen = new Set();
  function addArrival(name, platform) {
    if (!name || !arrivalsListEl) return;
    const key = (platform || 'unknown') + ':' + name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const pill = document.createElement('div');
    pill.className = 'arrival-pill';
    const plat = document.createElement('span');
    plat.className = 'arrival-platform';
    plat.dataset.p = (platform || 'unknown').toLowerCase();
    plat.textContent = platformBadge(platform);
    const lbl = document.createElement('span');
    lbl.textContent = name;
    pill.appendChild(plat);
    pill.appendChild(lbl);
    arrivalsListEl.appendChild(pill);

    // Trim oldest off the front when over cap.
    while (arrivalsListEl.children.length > MAX_VISIBLE) {
      arrivalsListEl.removeChild(arrivalsListEl.firstChild);
    }
    if (arrivalsCountEl) arrivalsCountEl.textContent = String(seen.size);
  }
  function platformBadge(p) {
    switch ((p || '').toLowerCase()) {
      case 'twitch':  return 'T';
      case 'kick':    return 'K';
      case 'tiktok':  return '♪';
      case 'youtube': return '▶';
      default:        return '·';
    }
  }

  // ── Bus connection ────────────────────────────────────────────────
  let ws = null, backoff = 1000;
  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    try { ws = new WebSocket(url); } catch (e) { return; }

    ws.onopen = () => {
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-lobby' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['lobby.*', 'welcome.*', 'chat.message'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      try { handle(msg); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => {};
  }
  function handle(msg) {
    const d = msg.data || {};
    switch (msg.kind) {
      case 'lobby.config':
        // Streamer-side override of title/subtitle/countdown. Empty
        // string clears; null/undefined keeps the current value so a
        // partial publish doesn't blank the rest.
        if (typeof d.title       === 'string') cfg.title       = d.title;
        if (typeof d.subtitle    === 'string') cfg.subtitle    = d.subtitle;
        if (typeof d.countdownTo === 'string') cfg.countdownTo = d.countdownTo;
        if (typeof d.showArrivals === 'boolean') cfg.showArrivals = d.showArrivals;
        applyConfig();
        break;
      case 'welcome.fired':
        // Treat any welcome event as an arrival. Welcomes already
        // dedupe per-stream, so we don't need a session-cap here.
        if (d.user) addArrival(d.user, d.platform || 'twitch');
        break;
      case 'chat.message':
        // !ready opt-in — the viewer marks themselves "in the crew".
        if (typeof d.text === 'string' && /^!\s*ready\b/i.test(d.text.trim()) && d.user) {
          addArrival(d.user, d.platform || 'twitch');
        }
        break;
    }
  }

  connect();
})();
