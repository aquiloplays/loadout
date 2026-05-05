/*
 * Loadout — Hype Train overlay client.
 *
 * Subscribes to `hypetrain.*` from the local Aquilo Bus. Loadout's
 * HypeTrainModule aggregates fuel from every supported platform and
 * publishes start / level / contribute / end events. We render the
 * train (slide in), bump the level on level-ups, animate the fill bar
 * on every contribution, and slide out on end.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const debug  = params.get('debug') === '1';

  const pos = params.get('pos');
  if (pos) document.body.dataset.pos = pos;

  const card    = $('card');
  const lvl     = $('lvl');
  const fill    = $('fill');
  const contrib = $('contributor');
  const fuelTxt = $('fuelText');

  let pulseTimer = null;

  function show(level, fuel, threshold) {
    lvl.textContent = String(level);
    const pct = Math.max(0, Math.min(100, (fuel / threshold) * 100));
    fill.style.width = pct.toFixed(1) + '%';
    fuelTxt.textContent = Math.max(0, fuel) + ' / ' + threshold;
    card.classList.remove('hidden');
  }

  function hide() {
    card.classList.add('hidden');
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

  function handle(msg) {
    const d = msg.data || {};
    switch (msg.kind) {
      case 'hypetrain.start':
        show(d.level || 1, d.fuel || 0, d.threshold || 100);
        setContributor(d.fromUser ? d.fromUser + ' kicked it off' : 'starting…');
        pulse();
        break;
      case 'hypetrain.contribute':
        show(d.level || 1, d.totalFuel || 0,
             (msg.threshold || 100));   // threshold may not be on contribute
        setContributor((d.user || '') + ' +' + (d.fuel || 0) + ' fuel');
        break;
      case 'hypetrain.level':
        show(d.level || 1, d.fuel || 0, d.threshold || 100);
        setContributor((d.fromUser || '') + ' pushed it to lv ' + (d.level || 1));
        pulse();
        break;
      case 'hypetrain.end':
        setContributor('ended at lv ' + (d.finalLevel || 1));
        // Hold visibility for a beat, then slide out.
        setTimeout(hide, 2400);
        break;
    }
  }

  // ---- Bus connection (same shape as every other Loadout overlay) ----
  let ws = null, backoff = 1000;
  let lastThreshold = 100;

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
      // Carry the most recent threshold onto contribute messages that
      // omit it, so the bar stays accurate between level-ups.
      if (msg.kind === 'hypetrain.contribute' && !msg.data.threshold) {
        msg.threshold = lastThreshold;
      }
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

  connect();
})();
