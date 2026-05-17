/*
 * Loadout - Goals overlay client.
 * Subscribes to goal.updated; renders one progress bar per goal.
 */
(() => {
  const root = document.getElementById('root');
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const filter = (params.get('goals') || '').split(',').map(s => s.trim()).filter(Boolean);
  const debug  = params.get('debug') === '1';
  const layout = params.get('layout');
  const theme  = params.get('theme');
  if (layout) document.body.dataset.layout = layout;
  if (theme)  document.body.dataset.theme  = theme;

  // Position anchor — tl | tr | bl | br | tc | bc | lc | rc. Lets the
  // all-in-one composite move the goal bars clear of other layers.
  // Default left-center keeps the historic side-of-screen placement.
  const pos = params.get('pos');
  document.body.dataset.pos = pos || 'lc';

  const cards = new Map();   // name -> { el, fillEl, valueEl, current, target }

  function ensureCard(name, kind) {
    if (cards.has(name)) return cards.get(name);
    const el = document.createElement('div');
    el.className = 'goal';
    el.dataset.kind = kind || 'custom';
    el.innerHTML =
      '<div class="head"><span class="name"></span><span class="progress"><strong></strong> / <span class="t"></span></span></div>' +
      '<div class="bar"><div class="fill"></div></div>';
    el.querySelector('.name').textContent = name;
    root.appendChild(el);
    const entry = {
      el,
      fillEl:  el.querySelector('.fill'),
      curEl:   el.querySelector('.progress strong'),
      targetEl:el.querySelector('.progress .t'),
      current: 0,
      target:  1
    };
    cards.set(name, entry);
    return entry;
  }

  function update(payload) {
    const { name, kind, current, target } = payload || {};
    if (!name) return;
    if (filter.length > 0 && !filter.includes(name)) return;
    const c = ensureCard(name, kind);
    c.current = current || 0;
    c.target  = Math.max(1, target || 1);
    c.curEl.textContent = String(c.current);
    c.targetEl.textContent = String(c.target);
    const pct = Math.max(0, Math.min(100, (c.current / c.target) * 100));
    c.fillEl.style.width = pct + '%';
    c.el.dataset.complete = c.current >= c.target ? 'true' : 'false';
    c.fillEl.classList.add('bump');
    setTimeout(() => c.fillEl.classList.remove('bump'), 600);
  }

  // ── Bus connection ────────────────────────────────────────────────────────
  let ws = null, backoff = 1000;
  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    setStatus('connecting…');
    try { ws = new WebSocket(url); } catch (e) { setStatus('bad URL'); return; }
    ws.onopen = () => {
      setStatus('connected'); backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-goals' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['goal.*'] }));
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.kind === 'goal.updated') update(m.data);
    };
    ws.onclose = () => { setStatus('reconnecting…'); setTimeout(connect, backoff); backoff = Math.min(backoff*2, 30000); };
    ws.onerror = () => setStatus('error');
  }
  function setStatus(t) {
    if (!debug) return;
    let el = document.getElementById('devStatus');
    if (!el) { el = document.createElement('div'); el.id = 'devStatus'; el.className = 'dev-status'; document.body.appendChild(el); }
    el.textContent = 'bus: ' + t;
  }

  if (debug) {
    update({ name: 'Sub goal',  kind: 'subs',      current: 47, target: 100 });
    update({ name: 'Followers', kind: 'followers', current: 712, target: 1000 });
  }
  connect();
})();
