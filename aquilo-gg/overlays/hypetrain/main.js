/*
 * Loadout — Hype Train overlay client.
 *
 * Subscribes to `hypetrain.*` from the local Aquilo Bus. Loadout's
 * HypeTrainModule aggregates fuel from every supported platform and
 * publishes start / level / contribute / end events.
 *
 * Render lifecycle:
 *   start       — slide card in, run the train banner animation,
 *                 show the cross-platform "fuel the train" tip,
 *                 start the 5-min countdown
 *   contribute  — bump the fill bar, brief flash, reset countdown
 *   level       — re-run the train banner with a "LEVEL N" headline
 *   end         — final celebration, hide tip, fade out
 *
 * Train banner: 🚂🚃🚃 glides right→left, "HYPE TRAIN!" trails behind
 * staggered ~250ms. CSS owns the keyframes; JS just toggles .running
 * to (re)trigger.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const debug  = params.get('debug') === '1';

  const pos = params.get('pos');
  if (pos) document.body.dataset.pos = pos;

  // Source filter. Loadout runs two hype trains in parallel — a
  // cross-platform aggregate (source="all") and a Twitch-only one
  // (source="twitch"). Every hypetrain.* event carries a `source`
  // field; this overlay renders only the events that match. Default
  // "all" = the cross-platform train. Set ?source=twitch for a
  // dedicated Twitch-native widget. The shared theme.js doesn't know
  // about this param so we read it directly here.
  const sourceFilter = (params.get('source') || 'all').toLowerCase();
  // Tag the body so the streamer (or CSS) can tell the two apart in
  // a preview; also lets us tweak the headline copy below.
  document.body.dataset.source = sourceFilter;

  const card        = $('card');
  const lvl         = $('lvl');
  const fill        = $('fill');
  const contrib     = $('contributor');
  const fuelTxt     = $('fuelText');
  const banner      = $('banner');
  const bannerText  = $('bannerText');
  const countdown   = $('countdown');
  const tip         = $('tip');

  const HYPE_DEFAULT_MS = 5 * 60 * 1000;
  let hypeDeadline = 0;
  let tickHandle   = null;
  let pulseTimer   = null;
  let lastThreshold = 100;
  let lastFuel     = 0;
  let active       = false;

  function fmtMmSs(ms) {
    if (ms <= 0) return '0:00';
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function tickCountdown() {
    if (!active || !countdown) return;
    const remaining = hypeDeadline - Date.now();
    countdown.textContent = fmtMmSs(remaining);
    if (remaining <= 0) {
      // Train timed out without an explicit end event — clean up.
      cleanupAfterEnd(lvl ? Number(lvl.textContent) || 1 : 1);
    }
  }

  function runBanner() {
    if (!banner) return;
    banner.classList.remove('running');
    void banner.offsetWidth;          // re-trigger CSS animation
    banner.classList.add('running');
  }

  function setBar(level, fuel, threshold) {
    if (lvl) lvl.textContent = String(level);
    const t = Math.max(1, threshold);
    const pct = Math.max(0, Math.min(100, (fuel / t) * 100));
    if (fill) fill.style.width = pct.toFixed(1) + '%';
    if (fuelTxt) fuelTxt.textContent = Math.max(0, fuel) + ' / ' + t;
    lastThreshold = t;
    lastFuel = fuel;
  }

  function flashBar() {
    const bar = fill && fill.parentElement;
    if (!bar) return;
    bar.classList.remove('flash');
    void bar.offsetWidth;
    bar.classList.add('flash');
    setTimeout(() => bar && bar.classList.remove('flash'), 600);
  }

  function pulse() {
    card.classList.remove('pulse');
    void card.offsetWidth;
    card.classList.add('pulse');
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => card.classList.remove('pulse'), 800);
  }

  function setContributor(text) {
    contrib.textContent = text || '';
  }

  function setBannerText(text) {
    if (bannerText) bannerText.textContent = text;
  }

  function startCountdown() {
    if (tickHandle) clearInterval(tickHandle);
    hypeDeadline = Date.now() + HYPE_DEFAULT_MS;
    tickHandle = setInterval(tickCountdown, 1000);
    tickCountdown();
  }

  function cleanupAfterEnd(finalLevel) {
    active = false;
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
    if (tip) tip.hidden = true;
    setContributor('ended at lv ' + finalLevel);
    setTimeout(() => card.classList.add('hidden'), 2400);
  }

  function handle(msg) {
    const d = msg.data || {};
    // Source gate — drop events from the other train. A hypetrain.*
    // event with no `source` is treated as "all" for back-compat with
    // any pre-dual-train publisher.
    const evtSource = (d.source || 'all').toLowerCase();
    if (evtSource !== sourceFilter) return;
    switch (msg.kind) {
      case 'hypetrain.start':
        active = true;
        if (tip) tip.hidden = false;
        setBar(d.level || 1, d.fuel || 0, d.threshold || 100);
        setContributor(d.fromUser ? d.fromUser + ' kicked it off' : 'starting…');
        setBannerText('HYPE TRAIN!');
        card.classList.remove('hidden');
        runBanner();
        pulse();
        startCountdown();
        break;
      case 'hypetrain.contribute':
        // threshold may not be on contribute — main bus payload reuses
        // lastThreshold from the most recent event that did include it.
        setBar(d.level || (lvl ? Number(lvl.textContent) || 1 : 1),
               d.totalFuel != null ? d.totalFuel : (lastFuel + (d.fuel || 0)),
               d.threshold || lastThreshold);
        setContributor((d.user || '') + ' +' + (d.fuel || 0) + ' fuel');
        flashBar();
        // Each contribution resets the countdown — matches Twitch's
        // hype-train extension behaviour.
        hypeDeadline = Date.now() + HYPE_DEFAULT_MS;
        tickCountdown();
        break;
      case 'hypetrain.level':
        setBar(d.level || 1, d.fuel || 0, d.threshold || 100);
        setContributor((d.fromUser || '') + ' pushed it to lv ' + (d.level || 1));
        setBannerText('LEVEL ' + (d.level || 1) + '!');
        runBanner();
        pulse();
        // After the level-up banner, restore the running headline so
        // the panel reads as "still going" rather than locked on the
        // level-up moment.
        setTimeout(() => active && setBannerText('HYPE TRAIN!'), 2200);
        break;
      case 'hypetrain.end':
        setBannerText('FINAL LEVEL ' + (d.finalLevel || 1));
        runBanner();
        cleanupAfterEnd(d.finalLevel || 1);
        break;
    }
  }

  // ---- Bus connection (same shape as every other Loadout overlay) ----
  let ws = null, backoff = 1000;

  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    setStatus('connecting…');
    try { ws = new WebSocket(url); } catch (e) { setStatus('bad URL'); return; }

    ws.onopen = () => {
      setStatus('connected');
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-hypetrain' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['hypetrain.*'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      if (msg.data && msg.data.threshold) lastThreshold = msg.data.threshold;
      try { handle(msg); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      setStatus('reconnecting…');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => setStatus('error');
  }

  function setStatus(t) {
    if (!debug) return;
    let el = document.getElementById('devStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = 'devStatus';
      el.className = 'dev-status';
      document.body.appendChild(el);
    }
    el.textContent = 'bus: ' + t;
  }

  if (debug) {
    // Synthetic preview events are tagged with the active sourceFilter
    // so a ?source=twitch preview still renders (the handle() gate
    // would otherwise drop them as "all").
    const S = sourceFilter;
    setTimeout(() => handle({ kind: 'hypetrain.start',      data: { source: S, level: 1, fuel: 30,  threshold: 200, fromUser: 'aquilo_plays' }}), 600);
    setTimeout(() => handle({ kind: 'hypetrain.contribute', data: { source: S, user: 'fearless_fox', fuel: 50,  totalFuel: 80, kind: 'sub' }}), 2400);
    setTimeout(() => handle({ kind: 'hypetrain.contribute', data: { source: S, user: 'mason42',      fuel: 100, totalFuel: 180, kind: 'cheer' }}), 4400);
    setTimeout(() => handle({ kind: 'hypetrain.level',      data: { source: S, level: 2, fuel: 0,    threshold: 350, fromUser: 'mason42' }}), 6200);
    setTimeout(() => handle({ kind: 'hypetrain.contribute', data: { source: S, user: 'lume',         fuel: 75,  totalFuel: 75,  kind: 'tiktokGift' }}), 8500);
    setTimeout(() => handle({ kind: 'hypetrain.end',        data: { source: S, finalLevel: 2 }}), 12000);
  }

  connect();
})();
