/*
 * Loadout — Daily Check-In overlay client.
 *
 * Connects to the local Aquilo Bus, listens for `checkin.shown` /
 * `checkin.enriched`, renders the card, rotates stats, and auto-hides after
 * 12 seconds. Falls back to a reconnecting loop if the bus is unreachable.
 *
 * Why no framework: this needs to load instantly inside an OBS browser source
 * with zero build pipeline. Vanilla JS + tiny DOM updates is the right tool.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const card = $('card');
  const userEl = $('user');
  const flairsEl = $('flairs');
  const pfpEl = $('pfp');
  const initialsEl = $('initials');
  const statsEl = $('stats');

  // ── Query params ──────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const debug  = params.get('debug') === '1';
  const widthPx = parseInt(params.get('width') || '0', 10);
  if (widthPx > 0) card.style.width = widthPx + 'px';

  // ── State ─────────────────────────────────────────────────────────────────
  let hideTimer = null;
  let rotateTimer = null;
  let currentEvent = null;
  let activeStatIdx = 0;
  let ws = null;
  let backoff = 1000;

  // ── Render helpers ────────────────────────────────────────────────────────
  function show(ev) {
    currentEvent = ev;
    activeStatIdx = 0;

    root.dataset.theme = ev.animationTheme || 'shimmer';
    userEl.textContent = ev.user || 'Anonymous';

    // Avatar / initials fallback
    if (ev.pfp) {
      pfpEl.src = ev.pfp;
      card.dataset.hasPfp = 'true';
    } else {
      const letters = (ev.user || '?').replace(/[^\w]/g,'').slice(0,2).toUpperCase() || '?';
      initialsEl.textContent = letters;
      card.dataset.hasPfp = 'false';
    }

    // Flairs
    flairsEl.innerHTML = '';
    const flairs = computeFlairs(ev);
    for (const f of flairs) {
      const el = document.createElement('span');
      el.className = 'flair ' + f.cls;
      el.textContent = f.text;
      flairsEl.appendChild(el);
    }

    // Stats — render every entry, then animate one at a time.
    statsEl.innerHTML = '';
    const stats = ev.stats || [];
    for (let i = 0; i < stats.length; i++) {
      const s = stats[i];
      if (!s) continue;
      const wrap = document.createElement('div');
      wrap.className = 'stat';
      if (i === 0) wrap.classList.add('active');
      wrap.innerHTML = '<span class="label">' + safe(s.label) + '</span><span class="value">' + safe(s.value) + '</span>';
      statsEl.appendChild(wrap);
    }

    // Show + auto-hide
    root.dataset.state = 'visible';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 12000);

    // Stat rotation
    clearInterval(rotateTimer);
    if (stats.length > 1) {
      const rotateMs = Math.max(1500, (ev.rotateSeconds || 4) * 1000);
      rotateTimer = setInterval(() => {
        const els = statsEl.querySelectorAll('.stat');
        if (els.length === 0) return;
        els[activeStatIdx % els.length].classList.remove('active');
        activeStatIdx = (activeStatIdx + 1) % els.length;
        els[activeStatIdx].classList.add('active');
      }, rotateMs);
    }
  }

  function hide() {
    root.dataset.state = 'hidden';
    clearInterval(rotateTimer);
    rotateTimer = null;
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function enrich(ev) {
    // Apply enriched fields onto the currently displayed card.
    if (!currentEvent || !ev) return;
    if (ev.user !== currentEvent.user) return;     // wrong target — different check-in already shown
    if (ev.pfp && !pfpEl.src) {
      pfpEl.src = ev.pfp;
      card.dataset.hasPfp = 'true';
    }
  }

  function computeFlairs(ev) {
    const out = [];
    const showFlairs = ev.showFlairs || {};
    if (ev.role === 'broadcaster') out.push({ cls: 'broadcaster', text: '⭐ Broadcaster' });
    else if (showFlairs.vipMod !== false) {
      if (ev.role === 'mod') out.push({ cls: 'mod', text: '🛡 Mod' });
      else if (ev.role === 'vip') out.push({ cls: 'vip', text: '💎 VIP' });
    }
    if (showFlairs.sub !== false && (ev.role === 'sub' || ev.subTier)) {
      const tier = ({'1000':1,'2000':2,'3000':3})[ev.subTier] || 1;
      out.push({ cls: 'sub-' + tier, text: 'Sub T' + tier });
    }
    if (showFlairs.patreon !== false && ev.patreonTier) {
      out.push({ cls: 'patreon-' + ev.patreonTier, text: 'Patreon ' + ev.patreonTier.replace('tier','T') });
    }
    return out;
  }

  function safe(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

  // ── Bus connection ────────────────────────────────────────────────────────
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
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-checkin' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['checkin.*'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      if (msg.kind === 'checkin.shown')    show(msg.data);
      if (msg.kind === 'checkin.enriched') enrich(msg.data);
    };
    ws.onclose = () => {
      setStatus('disconnected, retrying in ' + Math.round(backoff/1000) + 's');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => { setStatus('error'); /* close handler will reconnect */ };
  }

  function setStatus(text) {
    if (!debug) return;
    let el = $('devStatus');
    if (!el) { el = document.createElement('div'); el.id = 'devStatus'; el.className = 'dev-status'; document.body.appendChild(el); }
    el.textContent = 'bus: ' + text;
  }

  if (debug) {
    // Demo card so you can preview without the bus running.
    show({
      user: 'aquilo_plays', role: 'broadcaster',
      pfp: '', subTier: '',
      patreonTier: 'tier3',
      showFlairs: { sub: true, vipMod: true, patreon: true },
      animationTheme: 'shimmer',
      stats: [
        { kind: 'uptime', label: 'Uptime', value: '1:23:45' },
        { kind: 'viewers', label: 'Viewers', value: '127' },
        { kind: 'counter', label: 'Deaths', value: '12' }
      ],
      rotateSeconds: 3
    });
  }
  connect();
})();
