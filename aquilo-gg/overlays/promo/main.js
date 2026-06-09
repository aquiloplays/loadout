/*
 * Loadout, Promo cycle overlay client.
 *
 * Drives the slide carousel, supporter board, push-up tally, and
 * slide-jack behavior. Connects to the local Aquilo Bus and listens
 * for sub / cheer / gift / tip / TikTok-gift / raid events. Works
 * standalone in demo mode with no bus running.
 *
 * Why no framework: this loads inside an OBS browser source with
 * zero build pipeline. Vanilla JS + tiny DOM updates is the right
 * tool, same convention as every other overlay in this directory.
 */
(() => {
  'use strict';

  // ── DOM helpers ───────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const stage = $('stage');
  const track = $('track');
  const tallyNumEl = $('tallyNum');
  const devEl = $('dev');

  // ── Query params ──────────────────────────────────────────────────────
  const params  = new URLSearchParams(location.search);
  const busUrl  = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret  = params.get('secret') || '';
  const demoOn  = params.get('demo') === '1' || params.get('debug') === '1';
  const widthPx  = parseInt(params.get('width')  || '0', 10);
  const heightPx = parseInt(params.get('height') || '0', 10);
  const resetTally = params.get('resetTally') === '1';
  const slidesParam = (params.get('slides') || 'hero,sf,loadout,rotation,perks')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (widthPx  > 0) root.style.setProperty('--promo-w', widthPx + 'px');
  if (heightPx > 0) root.style.setProperty('--promo-h', heightPx + 'px');

  // Per-slide dwell times. Each is a sensible default tuned to the
  // content's pace: SF needs a beat for chat to scroll, perks reads
  // fast, the Loadout slide spans its inner sub-rotation.
  const DWELL = {
    hero:     6000,
    sf:      14000,
    loadout: 22000, // covers ~3 sub-tiles at 7s each
    rotation: 11000,
    perks:    9000,
  };

  // Loadout sub-cycle interval. Each inner overlay holds for this
  // long before swapping to the next, then the master slide
  // advances when its full dwell is up.
  const LOADOUT_SUB_MS = 7000;

  // ── Iframe preload ────────────────────────────────────────────────────
  // Every iframe carries its `src` in a data-src attribute so the
  // markup is inert at parse time. We attach `src` here at boot so
  // the iframes start loading immediately. By the time their slide
  // rotates in, the content is already animating.
  function preloadFrames() {
    const frames = document.querySelectorAll('iframe.demo-frame[data-src]');
    frames.forEach(f => {
      const src = f.getAttribute('data-src');
      if (src && !f.src) f.src = src;
      // Same-origin Loadout overlays (../check-in/, ../hypetrain/,
      // ../bolts/) expose a `.dev-status` corner badge in debug mode
      // that surfaces "bus: connecting…". Useful when developing
      // the overlay standalone, distracting inside the promo tile.
      // Inject a hide rule once the iframe has loaded; the
      // try/catch swallows cross-origin frames (StreamFusion,
      // Rotation widget) where access is blocked.
      f.addEventListener('load', () => {
        try {
          const doc = f.contentDocument;
          if (!doc) return;
          const style = doc.createElement('style');
          style.textContent = '.dev-status,#devStatus{display:none!important}';
          doc.head.appendChild(style);
        } catch {
          // Cross-origin: nothing to do. The StreamFusion and
          // Rotation widget demos don't show a dev badge anyway.
        }
      }, { once: true });
    });
  }

  // Each frame stage holds a fixed-pixel iframe scaled via transform.
  // The fit math is the same pattern as LoadoutOverlayGallery on
  // aquilo.gg: fit-to-tile with `Math.min(w-ratio, h-ratio)` so the
  // iframe never overflows. Recomputes on ResizeObserver.
  function fitAllFrames() {
    document.querySelectorAll('[data-fixed-w]').forEach(el => {
      const fw = parseInt(el.getAttribute('data-fixed-w'), 10) || 0;
      const fh = parseInt(el.getAttribute('data-fixed-h'), 10) || 0;
      const iframe = el.querySelector('iframe.demo-frame');
      if (!fw || !fh || !iframe) return;
      iframe.style.width  = fw + 'px';
      iframe.style.height = fh + 'px';
      iframe.style.transformOrigin = '0 0';
      const fit = () => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const s = Math.min(r.width / fw, r.height / fh);
        // Position the iframe so its top-left lands at the
        // (parent.center - scaledHalf) point; with origin 0,0
        // the scaled iframe ends up visually centred.
        iframe.style.left = (r.width  / 2 - (fw * s) / 2) + 'px';
        iframe.style.top  = (r.height / 2 - (fh * s) / 2) + 'px';
        iframe.style.transform = `scale(${s.toFixed(4)})`;
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(el);
    });
  }

  // ── Rotation engine ───────────────────────────────────────────────────
  const order = slidesParam.filter(id => DWELL.hasOwnProperty(id));
  if (order.length === 0) order.push('hero');

  let activeIdx = 0;
  let advanceTimer = null;
  let loadoutSubIdx = 0;
  let loadoutSubTimer = null;

  function setActive(id) {
    root.dataset.active = id;
    setStatus('slide: ' + id);
    // Start / stop the Loadout sub-cycle alongside the master.
    if (id === 'loadout') startLoadoutSub();
    else stopLoadoutSub();
  }

  function advance() {
    activeIdx = (activeIdx + 1) % order.length;
    const next = order[activeIdx];
    setActive(next);
    scheduleNext(DWELL[next] || 10000);
  }

  function scheduleNext(ms) {
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(advance, ms);
  }

  // ── Loadout sub-cycle ─────────────────────────────────────────────────
  function startLoadoutSub() {
    const tiles = document.querySelectorAll('#loadoutCycle .loadout-tile');
    if (tiles.length === 0) return;
    // Reset to the first sub-tile each time the master rotates in
    // so viewers don't catch us mid-cycle on a partial.
    loadoutSubIdx = 0;
    paintLoadoutSub(tiles);
    clearInterval(loadoutSubTimer);
    loadoutSubTimer = setInterval(() => {
      loadoutSubIdx = (loadoutSubIdx + 1) % tiles.length;
      paintLoadoutSub(tiles);
    }, LOADOUT_SUB_MS);
  }
  function stopLoadoutSub() {
    clearInterval(loadoutSubTimer);
    loadoutSubTimer = null;
  }
  function paintLoadoutSub(tiles) {
    tiles.forEach((t, i) => t.classList.toggle('is-active', i === loadoutSubIdx));
  }

  // ── Push-up tally ─────────────────────────────────────────────────────
  // Lives in localStorage so an OBS reload mid-stream doesn't zero
  // the counter. ?resetTally=1 clears it on load (handy when going
  // live after a test session).
  const TALLY_KEY = 'aquilo.promo.pushupTally';
  let tally = 0;
  function loadTally() {
    if (resetTally) {
      try { localStorage.removeItem(TALLY_KEY); } catch {}
      tally = 0;
    } else {
      try {
        const raw = localStorage.getItem(TALLY_KEY);
        const n = parseFloat(raw);
        tally = Number.isFinite(n) && n >= 0 ? n : 0;
      } catch {
        tally = 0;
      }
    }
    paintTally();
  }
  function bumpTally(delta) {
    if (!Number.isFinite(delta) || delta <= 0) return;
    tally += delta;
    try { localStorage.setItem(TALLY_KEY, String(tally)); } catch {}
    paintTally(true);
  }
  function paintTally(bumped) {
    // Show whole push-ups (round up so a half-dollar tip doesn't
    // round AWAY a push-up the streamer owes).
    tallyNumEl.textContent = String(Math.ceil(tally));
    if (bumped) {
      tallyNumEl.classList.remove('bumped');
      void tallyNumEl.offsetWidth;
      tallyNumEl.classList.add('bumped');
      setTimeout(() => tallyNumEl.classList.remove('bumped'), 900);
    }
  }

  // ── Supporter board ───────────────────────────────────────────────────
  const MAX_CHIPS = 8;
  function pushChip({ kind, name, badge }) {
    const el = document.createElement('div');
    el.className = 'chip';
    el.dataset.kind = kind;
    const ico = document.createElement('span');
    ico.className = 'chip-ico';
    ico.textContent = badge || '';
    const who = document.createElement('span');
    who.className = 'chip-name';
    who.textContent = name || '?';
    el.appendChild(ico);
    el.appendChild(who);
    track.appendChild(el);
    // Cap the visible row. Oldest fade out so the entrance
    // animation isn't fighting a sudden DOM removal.
    while (track.children.length > MAX_CHIPS) {
      const old = track.firstElementChild;
      old.classList.add('fade-out');
      setTimeout(() => old.remove(), 360);
      // Bail to avoid an infinite tail of cleanups overlapping.
      break;
    }
  }

  // ── Event handling ────────────────────────────────────────────────────
  // The bus speaks several related kinds; we route them through a
  // tiny classifier that decides:
  //   (a) does this go on the board?
  //   (b) does it bump the push-up tally?
  //
  // The user's printerbot already prints hero shout-outs, so we
  // intentionally do NOT take over the carousel for big events.
  // The board is the only on-screen surface for sub/cheer/gift/tip
  // signals from this overlay.
  //
  // Thresholds match the streamer's rules from the design pass:
  //   sub (any tier)         -> board + 5 push-ups
  //   gift sub               -> board + 5 push-ups per gifted sub
  //   cheer >= 100 bits       -> board
  //   TikTok gift >= 1000     -> board
  //   tip (!tip)              -> board + 2.5 push-ups per $1 (so $10 = 25)
  function handleEvent(kind, d) {
    if (!kind) return;
    d = d || {};

    if (kind === 'checkin.shown') {
      // checkin.shown is the broadest sub-shaped event Loadout
      // publishes. It carries role, subTier, sub badge, cheer
      // total, etc., even when the trigger was the user typing
      // !checkin. We only push to the board on sub-shaped check-
      // ins; plain viewer check-ins don't qualify.
      const tier = ({'1000': 'sub', '2000': 'sub-t2', '3000': 'sub-t3'})[d.subTier];
      if (tier) {
        pushChip({ kind: tier, name: d.user, badge: tier === 'sub' ? 'T1' : tier === 'sub-t2' ? 'T2' : 'T3' });
        bumpTally(5);
      }
      return;
    }

    if (kind === 'cheer.shown' || kind === 'cheer.received') {
      const bits = Number(d.bits || d.amount || 0);
      if (bits >= 100) {
        pushChip({ kind: 'cheer', name: d.user, badge: bits.toLocaleString() + ' bits' });
      }
      return;
    }

    if (kind === 'bolts.gifted' || kind === 'gift.subs' || kind === 'sub.gift') {
      // Generic gift-sub event. `count` is number of subs in this
      // gift action; `from` is the sender. Bolts.gifted in this
      // codebase uses {from, to, amount} for Bolts-economy, but
      // the same event-name is reused upstream for sub gifting
      // (count carried in `count` or `amount`). Read both.
      const count = Number(d.count || d.subCount || d.amount || 1);
      const sender = d.from || d.user || d.sender || 'Anonymous';
      pushChip({ kind: 'gift', name: sender, badge: 'x' + count });
      bumpTally(5 * count);
      return;
    }

    if (kind === 'sub.received' || kind === 'sub.shown') {
      const tier = ({'1000': 'sub', '2000': 'sub-t2', '3000': 'sub-t3'})[d.subTier] || 'sub';
      const badge = tier === 'sub' ? 'T1' : tier === 'sub-t2' ? 'T2' : 'T3';
      pushChip({ kind: tier, name: d.user, badge });
      bumpTally(5);
      return;
    }

    if (kind === 'tip.received' || kind === 'tip.shown') {
      const dollars = Number(d.amount || d.usd || 0);
      if (dollars > 0) {
        pushChip({
          kind: 'tip',
          name: d.user || 'Anonymous',
          badge: '$' + dollars.toFixed(2).replace(/\.00$/, ''),
        });
        bumpTally(dollars * 2.5);
      }
      return;
    }

    if (kind === 'tiktok.gift' || kind === 'tiktok.gift.shown') {
      const coins = Number(d.coins || d.amount || 0);
      const giftName = d.giftName || 'gift';
      if (coins >= 1000) {
        pushChip({
          kind: 'tiktok',
          name: d.user || 'Anonymous',
          badge: giftName + ' ' + coins.toLocaleString(),
        });
      }
      return;
    }
  }

  // ── Bus connection ────────────────────────────────────────────────────
  let ws = null;
  let backoff = 1000;
  let bridged = false;

  function connect() {
    if (demoOn && bridged) return; // already running synthetic stream
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    setStatus('bus: connecting');
    try { ws = new WebSocket(url); }
    catch (e) { setStatus('bus: bad URL'); scheduleReconnect(); return; }

    ws.onopen = () => {
      setStatus('bus: connected');
      backoff = 1000;
      bridged = true;
      ws.send(JSON.stringify({ v: 1, kind: 'hello', client: 'overlay-promo' }));
      // Subscribe broadly; we self-filter. Cheaper than wiring
      // ten separate subscriptions and lets a streamer publish
      // ad-hoc events without adding a new kind here.
      ws.send(JSON.stringify({
        v: 1,
        kind: 'subscribe',
        kinds: [
          'checkin.*', 'cheer.*', 'sub.*', 'gift.*', 'tip.*',
          'tiktok.*', 'bolts.gifted',
        ],
      }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      handleEvent(msg.kind, msg.data || {});
    };
    ws.onclose = () => {
      setStatus('bus: disconnected');
      bridged = false;
      scheduleReconnect();
    };
    ws.onerror = () => { /* close will fire */ };
  }
  function scheduleReconnect() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  // ── Demo mode ─────────────────────────────────────────────────────────
  // Synthesizes events on a soft cadence so the supporter board has
  // something to show when there's no bus. Auto-engages 10 seconds
  // after a fresh load if we never managed to connect, so a streamer
  // dropping the URL into OBS doesn't see an empty strip.
  const DEMO_NAMES = [
    'Wraith', 'Kiwi', 'PixelPaige', 'Vortex', 'Nico_42', 'Halberd', 'Sora',
    'Lyric', 'Bramble', 'Jett', 'Astra', 'Forge', 'Crow', 'Kelpie',
    'NeonFalcon', 'Echo', 'Quill',
  ];
  const TT_GIFTS = ['Rose', 'Galaxy', 'Lion', 'Drama Queen', 'Universe'];
  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function startDemoLoop() {
    if (bridged) return;
    setStatus('demo: synthesizing');
    const fire = () => {
      // Random pick weighted toward common events.
      const r = Math.random();
      if (r < 0.34) {
        handleEvent('checkin.shown', { user: rand(DEMO_NAMES), role: 'sub', subTier: '1000' });
      } else if (r < 0.52) {
        handleEvent('cheer.shown', { user: rand(DEMO_NAMES), bits: 100 + Math.floor(Math.random() * 400) });
      } else if (r < 0.68) {
        handleEvent('bolts.gifted', { from: rand(DEMO_NAMES), count: 1 + Math.floor(Math.random() * 5) });
      } else if (r < 0.82) {
        handleEvent('tip.received', { user: rand(DEMO_NAMES), amount: 5 + Math.floor(Math.random() * 20) });
      } else if (r < 0.92) {
        handleEvent('tiktok.gift', { user: rand(DEMO_NAMES), giftName: rand(TT_GIFTS), coins: 1000 + Math.floor(Math.random() * 3500) });
      } else {
        handleEvent('checkin.shown', { user: rand(DEMO_NAMES), role: 'sub', subTier: '2000' });
      }
      // Next tick in 4 to 10 seconds.
      setTimeout(fire, 4000 + Math.random() * 6000);
    };
    setTimeout(fire, 1500);
  }

  // ── Dev status ────────────────────────────────────────────────────────
  function setStatus(text) {
    if (!demoOn) return;
    devEl.hidden = false;
    devEl.textContent = text;
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  preloadFrames();
  fitAllFrames();
  loadTally();

  // Kick the carousel on the first slide in `order`.
  setActive(order[0]);
  scheduleNext(DWELL[order[0]] || 10000);

  if (demoOn) {
    // Demo mode is explicit: don't even attempt the bus, just
    // start synthesizing.
    startDemoLoop();
  } else {
    connect();
    // Fallback: if we never get a connection in 10s, start the
    // demo loop so the strip isn't empty.
    setTimeout(() => { if (!bridged) startDemoLoop(); }, 10000);
  }
})();
