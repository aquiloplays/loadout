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
