/*
 * Loadout - Counters overlay client.
 *
 * Subscribes to `counter.*` from the local Aquilo Bus and renders one card
 * per configured counter. Counters listed in ?counters= but not yet seen on
 * the bus render at value 0 - the first update from Loadout fills them in.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const counters = (params.get('counters') || '').split(',').map(s => s.trim()).filter(Boolean);
  const debug = params.get('debug') === '1';
  const bumpMs = parseInt(params.get('bumpMs') || '600', 10);

  const layout = params.get('layout');
  const theme  = params.get('theme');
  if (layout) document.body.dataset.layout = layout;
  if (theme)  document.body.dataset.theme  = theme;

  // Position anchor — tl | tr | bl | br | tc | bc | lc | rc. Lets the
  // all-in-one composite move the counter row out of another layer's
  // way. Defaults to top-left when unset (matches the historic
  // fixed-corner layout). CSS keys off body[data-pos].
  const pos = params.get('pos');
  document.body.dataset.pos = pos || 'tl';

  // Overlay-behavior params (mirrored from CountersConfig in the DLL):
  //   opacity        0..100      — overlay-wide alpha. 100 = fully opaque.
  //   showOnTrigger  1/0         — when 1, hide root by default and reveal
  //                                only briefly after each counter update.
  //   hideAfter      seconds     — auto-hide delay used with showOnTrigger.
  const opacityPct  = parseInt(params.get('opacity'), 10);
  if (Number.isFinite(opacityPct) && opacityPct >= 0 && opacityPct <= 100) {
    root.style.opacity = String(opacityPct / 100);
  }
  const showOnTrigger = params.get('showOnTrigger') === '1';
  const hideAfterSec  = Math.max(1, parseInt(params.get('hideAfter') || '6', 10) || 6);
  if (showOnTrigger) root.classList.add('trigger-hidden');
  let hideTimer = null;
  function pulseVisible() {
    if (!showOnTrigger) return;
    root.classList.remove('trigger-hidden');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => root.classList.add('trigger-hidden'), hideAfterSec * 1000);
  }

  // name -> { el, valueEl, display }
  const cards = new Map();
  // If user listed counters explicitly, prerender them at 0 so the layout doesn't pop in later.
  for (const name of counters) ensureCard(name, name, 0);

  function ensureCard(name, display, value) {
    if (cards.has(name)) return cards.get(name);
    const el = document.createElement('div');
    el.className = 'counter';
    el.dataset.name = name;
    el.innerHTML = '<span class="label"></span><span class="value"></span>';
    el.querySelector('.label').textContent = display || name;
    el.querySelector('.value').textContent = String(value ?? 0);
    root.appendChild(el);
    const entry = { el, valueEl: el.querySelector('.value'), labelEl: el.querySelector('.label'), value: value ?? 0 };
    cards.set(name, entry);
    return entry;
  }

  function update(payload) {
    const { name, display, value } = payload || {};
    if (!name) return;
    // Filter out counters the user didn't ask for.
    if (counters.length > 0 && !counters.includes(name)) return;

    const card = ensureCard(name, display, value);
    if (display) card.labelEl.textContent = display;
    const v = (value == null) ? 0 : Number(value);
    if (card.value === v) return;
    card.value = v;
    card.valueEl.textContent = String(v);

    card.el.classList.add('bump');
    setTimeout(() => card.el.classList.remove('bump'), bumpMs);
    pulseVisible();
  }

  // ── Bus connection ────────────────────────────────────────────────────────
  let ws = null;
  let backoff = 1000;

  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    setStatus('connecting…');
    try { ws = new WebSocket(url); }
    catch (e) { setStatus('bad URL: ' + e.message); return; }

    ws.onopen = () => {
      setStatus('connected');
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-counters' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['counter.*'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || msg.kind !== 'counter.updated') return;
      update(msg.data);
    };
    ws.onclose = () => {
      setStatus('disconnected, retrying in ' + Math.round(backoff/1000) + 's');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => setStatus('error');
  }

  function setStatus(text) {
    if (!debug) return;
    let el = $('devStatus');
    if (!el) { el = document.createElement('div'); el.id = 'devStatus'; el.className = 'dev-status'; document.body.appendChild(el); }
    el.textContent = 'bus: ' + text;
  }

  if (debug) {
    // demo
    update({ name: 'deaths', display: 'Deaths', value: 12 });
    update({ name: 'wins',   display: 'Wins',   value: 7 });
  }
  connect();
})();
