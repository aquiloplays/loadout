/*
 * Loadout — Apex overlay client.
 *
 * Reflects the current Apex viewer's state. Subscribes to apex.* on the
 * Aquilo Bus:
 *   apex.state      full state snapshot (sent every minute + on connect)
 *   apex.crowned    a new champion took the spot — refresh card
 *   apex.damaged    HP changed — animate bar + push damage line into feed
 *   apex.dethroned  reign ended — splash, then refresh
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const card = $('card');
  const params = new URLSearchParams(location.search);

  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const debug  = params.get('debug')  === '1';
  const pos    = params.get('pos');
  const widthPx = parseInt(params.get('width') || '0', 10);
  if (pos) root.dataset.pos = pos;
  if (widthPx > 0) card.style.width = widthPx + 'px';

  let reignTimer = null;
  let reignStartTs = 0;

  // Damage feed: rolling list of last 5 hits, one shows at a time.
  const feed = $('feed');
  const feedQueue = [];
  let feedActive = false;

  function showFeedLine(text) {
    feedQueue.push(text);
    if (feedQueue.length > 8) feedQueue.shift();
    if (feedActive) return;
    pumpFeed();
  }
  function pumpFeed() {
    if (feedQueue.length === 0) { feedActive = false; return; }
    feedActive = true;
    feed.innerHTML = '';
    const html = feedQueue.shift();
    const el = document.createElement('div');
    el.className = 'damage-line active';
    el.innerHTML = html;
    feed.appendChild(el);
    setTimeout(() => {
      el.classList.remove('active');
      setTimeout(() => { el.remove(); pumpFeed(); }, 400);
    }, 2400);
  }

  function setChampion(c) {
    if (!c) {
      root.dataset.state = 'empty';
      stopReignTimer();
      return;
    }
    root.dataset.state = 'active';

    $('name').textContent     = c.handle || '?';
    const platEl = $('platform');
    platEl.textContent        = (c.platform || '').toUpperCase();
    platEl.className          = 'platform ' + (c.platform || '');

    if (c.pfp) { $('pfp').src = c.pfp; card.dataset.hasPfp = 'true'; }
    else {
      const letters = (c.handle || '?').replace(/[^\w]/g,'').slice(0,2).toUpperCase() || '?';
      $('initials').textContent = letters;
      card.dataset.hasPfp = 'false';
    }

    setHp(c.health, c.maxHealth);

    // Reign timer.
    reignStartTs = c.crownedUtc ? Date.parse(c.crownedUtc) : Date.now() - (c.reignSeconds || 0) * 1000;
    startReignTimer();
  }

  function setHp(curr, max) {
    curr = Math.max(0, curr || 0);
    max  = Math.max(1, max  || 1);
    const pct = Math.max(0, Math.min(100, (curr / max) * 100));
    $('hpFill').style.width = pct + '%';
    $('hpCurrent').textContent = curr;
    $('hpMax').textContent     = max;
    const bar = $('hpFill').parentElement;
    bar.dataset.tier = pct > 60 ? 'good' : pct > 25 ? 'warn' : 'low';
    bar.classList.add('hit');
    setTimeout(() => bar.classList.remove('hit'), 350);
  }

  function startReignTimer() {
    stopReignTimer();
    const update = () => {
      const sec = Math.max(0, Math.floor((Date.now() - reignStartTs) / 1000));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const ss = sec % 60;
      const text = (h > 0 ? h + 'h ' : '') + (m > 0 || h > 0 ? m + 'm ' : '') + ss + 's';
      $('reign').textContent = '👑 ' + text;
    };
    update();
    reignTimer = setInterval(update, 1000);
  }
  function stopReignTimer() {
    if (reignTimer) { clearInterval(reignTimer); reignTimer = null; }
    $('reign').textContent = '';
  }

  function showSplash(prev, finisher) {
    const splash = $('splash');
    $('splashSub').textContent = (finisher || '?') + ' ended ' + (prev || 'the Apex') + "'s reign";
    splash.classList.remove('hidden');
    setTimeout(() => splash.classList.add('hidden'), 2200);
  }

  // ── Bus connection ────────────────────────────────────────────────────
  let ws = null, backoff = 1000;
  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    setStatus('connecting…');
    try { ws = new WebSocket(url); } catch (e) { setStatus('bad URL'); return; }
    ws.onopen = () => {
      setStatus('connected'); backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-apex' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['apex.*'] }));
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m || !m.kind) return;
      if (m.kind === 'apex.state')      setChampion((m.data || {}).champion);
      if (m.kind === 'apex.crowned')    setChampion({
        handle: m.data.champion, platform: m.data.platform, pfp: m.data.pfp,
        health: m.data.maxHealth, maxHealth: m.data.maxHealth, crownedUtc: new Date().toISOString()
      });
      if (m.kind === 'apex.damaged') {
        setHp(m.data.health, m.data.maxHealth);
        showFeedLine(
          '<span class="who">' + escape(m.data.attacker) + '</span>' +
          '<span class="src">' + (m.data.source || '?') + '</span>' +
          '<span class="amt">−' + m.data.damage + ' HP</span>'
        );
      }
      if (m.kind === 'apex.dethroned') {
        showSplash(m.data.previous, m.data.finisher);
      }
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
  function escape(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

  if (debug) {
    setChampion({
      handle: 'tiktok_fan_42', platform: 'tiktok', pfp: '',
      health: 740, maxHealth: 1000, crownedUtc: new Date(Date.now() - 4*60*1000).toISOString()
    });
    setTimeout(() => {
      setHp(640, 1000);
      showFeedLine('<span class="who">aquilo_plays</span><span class="src">cheer</span><span class="amt">−100 HP</span>');
    }, 1500);
    setTimeout(() => {
      setHp(0, 1000);
      showSplash('tiktok_fan_42', 'big_gifter');
    }, 5000);
    setTimeout(() => {
      setChampion({
        handle: 'big_gifter', platform: 'tiktok', pfp: '',
        health: 1000, maxHealth: 1000, crownedUtc: new Date().toISOString()
      });
    }, 7500);
  }
  connect();
})();
