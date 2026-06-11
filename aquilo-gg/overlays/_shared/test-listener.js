/* Aquilo overlay test listener.
 *
 * Lets the aquilo.gg customizer ping the REAL OBS browser source so the
 * streamer can check placement on their canvas. The customizer appends
 * `pair=<token>` to the overlay URL it generates; this module polls the
 * worker for pending test events on `<token>:<slug>` and either flashes a
 * placement frame, runs the overlay's demo hook, or both.
 *
 * Zero-config integration: add the script tag and the slug is guessed from
 * the URL path. Overlays with a demo routine register it afterwards:
 *
 *   <script src="../_shared/test-listener.js"></script>
 *   <script> AquiloTest.onTest(function (evt) { demoFire(); }); </script>
 *
 * No `pair` param in the URL means the module does nothing (zero network
 * cost for sources that predate this feature).
 */
(function () {
  'use strict';

  var API = 'https://loadout-discord.aquiloplays.workers.dev/api/overlay-test';
  var FAST_MS = 4000;          /* poll interval while the streamer is actively testing */
  var SLOW_MS = 60000;         /* idle poll interval so old sources still react within ~1 min */
  var FAST_WINDOW_MS = 15 * 60 * 1000; /* stay fast for 15 min after boot or after an event */
  var FLASH_MS = 5200;

  var state = {
    ch: null,
    after: 0,
    fastUntil: 0,
    timer: null,
    handlers: [],
    slug: null,
    started: false
  };

  function qs(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }

  function guessSlug() {
    if (typeof window.AQ_TEST_SLUG === 'string' && window.AQ_TEST_SLUG) return window.AQ_TEST_SLUG;
    var parts = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    /* widget.aquilo.gg/overlays/<slug>/  */
    var i = parts.indexOf('overlays');
    if (i >= 0 && parts[i + 1]) return clean(parts[i + 1]);
    /* aquilo.gg/<product>/overlay/  */
    var j = parts.indexOf('overlay');
    if (j > 0) return clean(parts[j - 1]);
    /* aquilo.gg/sf/overlay/<name>/ handled by the branch above returning 'sf';
       prefer the variant name when present */
    return clean(parts[parts.length - 1] || 'overlay');
  }

  function clean(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'overlay';
  }

  function sfSlug() {
    /* /sf/overlay/chat/ -> sf-chat */
    var m = location.pathname.match(/\/sf\/overlay\/([a-z0-9-]+)/i);
    return m ? 'sf-' + clean(m[1]) : null;
  }

  function init() {
    if (state.started) return true;
    var pair = qs('pair') || qs('aqtest');
    if (!pair || !/^[a-z0-9]{6,32}$/i.test(pair)) return false;
    state.slug = sfSlug() || guessSlug();
    state.ch = pair.toLowerCase() + ':' + state.slug;
    state.fastUntil = Date.now() + FAST_WINDOW_MS;
    state.started = true;
    schedule(700);
    return true;
  }

  function schedule(ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(poll, ms);
  }

  function nextDelay() {
    var base = Date.now() < state.fastUntil ? FAST_MS : SLOW_MS;
    return base + Math.floor(Math.random() * base * 0.25);
  }

  function poll() {
    var url = API + '/pending?ch=' + encodeURIComponent(state.ch) + '&after=' + state.after;
    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (evt) {
        if (evt && evt.n && Number(evt.n) > state.after) {
          state.after = Number(evt.n);
          state.fastUntil = Date.now() + FAST_WINDOW_MS;
          handle(evt);
        }
      })
      .catch(function () { /* offline or worker hiccup; keep polling */ })
      .then(function () { schedule(nextDelay()); });
  }

  function handle(evt) {
    var kinds = Array.isArray(evt.kinds) && evt.kinds.length ? evt.kinds : ['flash'];
    if (kinds.indexOf('flash') >= 0) flash(evt);
    if (kinds.indexOf('demo') >= 0) {
      for (var i = 0; i < state.handlers.length; i++) {
        try { state.handlers[i](evt); } catch (e) { /* one bad hook must not kill the rest */ }
      }
      try { document.dispatchEvent(new CustomEvent('aquilo-test', { detail: evt })); } catch (e) {}
    }
  }

  /* Full-viewport placement frame: dashed bounds, corner brackets, a center
     card with the overlay name and viewport size. Self-contained styling so
     it renders identically in every overlay. */
  function flash(evt) {
    var old = document.getElementById('aq-test-flash');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var acc = '#46e0c0';
    var wrap = document.createElement('div');
    wrap.id = 'aq-test-flash';
    wrap.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483000', 'pointer-events:none',
      'font-family:Inter,system-ui,Segoe UI,sans-serif',
      'opacity:0', 'transition:opacity .35s ease'
    ].join(';'));

    var frame = document.createElement('div');
    frame.setAttribute('style', [
      'position:absolute', 'inset:6px',
      'border:3px dashed ' + acc, 'border-radius:10px',
      'box-shadow:0 0 0 2px rgba(0,0,0,.35) inset, 0 0 28px rgba(70,224,192,.45) inset'
    ].join(';'));
    wrap.appendChild(frame);

    var corners = ['left:6px;top:6px;border-width:4px 0 0 4px;border-radius:10px 0 0 0',
                   'right:6px;top:6px;border-width:4px 4px 0 0;border-radius:0 10px 0 0',
                   'left:6px;bottom:6px;border-width:0 0 4px 4px;border-radius:0 0 0 10px',
                   'right:6px;bottom:6px;border-width:0 4px 4px 0;border-radius:0 0 10px 0'];
    for (var i = 0; i < corners.length; i++) {
      var c = document.createElement('div');
      c.setAttribute('style', 'position:absolute;width:34px;height:34px;border:0 solid ' + acc + ';' + corners[i]);
      wrap.appendChild(c);
    }

    var w = Math.round(window.innerWidth);
    var h = Math.round(window.innerHeight);
    var card = document.createElement('div');
    card.setAttribute('style', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'background:rgba(10,14,18,.88)', 'border:1px solid rgba(70,224,192,.55)',
      'border-radius:12px', 'padding:14px 22px', 'text-align:center',
      'color:#eaf6f2', 'backdrop-filter:blur(4px)'
    ].join(';'));
    card.innerHTML =
      '<div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:' + acc + ';font-weight:700">Aquilo test ping</div>' +
      '<div style="font-size:22px;font-weight:800;margin-top:4px">' + esc(state.slug || 'overlay') + '</div>' +
      '<div style="font-size:13px;color:#9fb6ae;margin-top:4px">source viewport ' + w + ' x ' + h + '</div>' +
      '<div style="font-size:12px;color:#7d948c;margin-top:6px">This frame marks the edges of the browser source.</div>';
    wrap.appendChild(card);

    document.body.appendChild(wrap);
    requestAnimationFrame(function () { wrap.style.opacity = '1'; });
    setTimeout(function () {
      wrap.style.opacity = '0';
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 420);
    }, (evt && Number(evt.flashMs)) || FLASH_MS);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.AquiloTest = {
    init: init,
    flash: flash,
    onTest: function (fn) { if (typeof fn === 'function') state.handlers.push(fn); },
    get active() { return state.started; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
