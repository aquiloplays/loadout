/*
 * Loadout — Clash overlay client.
 *
 * Subscribes to clash.* events on the local Aquilo Bus (the DLL pulls
 * /sync/<guildId>/clash-events on a polling loop and republishes
 * each one verbatim onto the bus). Renders a stack of toasts at the
 * configured screen edge; severity drives styling and dwell time.
 *
 * Why no framework: this loads inside an OBS browser source with no
 * build pipeline. Vanilla DOM + tiny render functions is the right
 * tool — matches every other overlay in this repo.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const track = $('track');

  const params = new URLSearchParams(location.search);
  const busUrl  = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret  = params.get('secret') || '';
  const debug   = params.get('debug') === '1';
  const widthPx = parseInt(params.get('width') || '0', 10);
  const side    = (params.get('side') || 'left').toLowerCase();
  if (widthPx > 0) root.style.width = widthPx + 'px';
  if (side === 'right' || side === 'left') root.dataset.side = side;

  // Toasts older than this drop off the screen on their own via CSS.
  const TOAST_DUR_MS = 7000;
  // How many toasts to keep stacked at once before the oldest is
  // forcibly removed. Older overlays let the DOM grow unbounded
  // during a raid storm — that's a memory leak in OBS over a long
  // session.
  const MAX_TOASTS = 6;

  let ws = null;
  let backoff = 1000;

  // ── Event → toast classifier ──────────────────────────────────────
  //
  // Mapping is split out so the same renderer handles both bus events
  // (kind family matches `clash.*`) and the demo toasts triggered by
  // ?debug=1. Each entry returns the toast variant + title + body.

  // Each toast names a pixel-art icon sprite (relative paths under
  // /sprites/ui/icons/). Renderer below maps `icon: 'sword'` to
  // <img src="/sprites/ui/icons/glossy/sword.png">. No emoji.
  function classify(kind, data) {
    switch (kind) {
      case 'clash.raid.incoming':
      case 'raid.incoming':
        return {
          variant: 'incoming', icon: 'sword', meta: 'INCOMING RAID',
          title: `${data.attackerName || 'A raider'} is hitting your town`,
          body: data.war ? 'Part of an active war — defend hard.' : '',
        };
      case 'clash.raid.sacked':
      case 'raid.sacked':
        return {
          variant: 'sacked', icon: 'bomb', meta: 'TOWN SACKED',
          title: `${data.attackerName || 'A raider'} sacked your town`,
          body: starLine(data.stars) + ' — loot taken from treasury.',
        };
      case 'clash.raid.defended':
      case 'raid.defended':
        return {
          variant: 'defended', icon: 'shield', meta: 'TOWN HELD',
          title: `Held the line against ${data.attackerName || 'a raider'}`,
          body: starLine(data.stars) + ' — defenders pushed them back.',
        };
      case 'clash.raid.result':
      case 'raid.result':
        return {
          variant: 'minor', icon: 'bolt', meta: 'RAID',
          title: `You raided ${data.targetName || 'a target'}`,
          body: starLine(data.stars) + (data.voltaic ? `  · Voltaic: ${data.voltaic}` : ''),
        };
      case 'clash.war.declared':
      case 'war.declared':
        return {
          variant: 'war', icon: 'sword', meta: 'WAR DECLARED',
          title: 'Your town has been challenged',
          body: 'Vote /clash war view to accept or refuse.',
        };
      case 'clash.war.active':
      case 'war.active':
        return {
          variant: 'war', icon: 'sword', meta: 'WAR LIVE',
          title: 'War window open — 24 hours',
          body: 'Raid the opposing community for amplified rewards.',
        };
      case 'clash.war.refused':
      case 'war.refused':
        return {
          variant: 'minor', icon: 'shield', meta: 'WAR',
          title: 'Your war was refused',
          body: 'The target community voted to refuse.',
        };
      case 'clash.war.cancelled':
      case 'war.cancelled':
        return {
          variant: 'minor', icon: 'alert', meta: 'WAR',
          title: 'War declaration failed',
          body: 'Not enough Yes votes from your community.',
        };
      case 'clash.war.ended':
      case 'war.ended':
        return {
          variant: 'war', icon: 'trophy', meta: 'WAR ENDED',
          title: `War ended — ${data.scores?.attacker || 0}★ vs ${data.scores?.defender || 0}★`,
          body: data.winner ? `Winner: ${data.winner}.` : '',
        };
      case 'clash.build.complete':
      case 'build.complete':
        return {
          variant: 'minor', icon: 'construction', meta: 'BUILD',
          title: `${data.name || 'A build'} finished`,
          body: '',
        };
      case 'clash.shield.expiring':
      case 'shield.expiring':
        return {
          variant: 'minor', icon: 'shield', meta: 'SHIELD',
          title: `Shield expires in ${data.minutesLeft || '?'} min`,
          body: 'Prep your defenses.',
        };
      default:
        return null;
    }
  }

  function starLine(stars) {
    const n = Math.max(0, Math.min(3, parseInt(stars, 10) || 0));
    return '★'.repeat(n) + '☆'.repeat(3 - n);
  }

  // ── DOM rendering ─────────────────────────────────────────────────

  function renderToast(spec) {
    const el = document.createElement('div');
    el.className = 'toast toast--' + spec.variant;
    // `spec.icon` is a sprite name (no extension, no path). Whitelist
    // to alphanum+hyphen so a malicious bus payload can't path-traverse.
    const safeIcon = /^[a-z0-9-]+$/i.test(spec.icon || '') ? spec.icon : 'bolt';
    el.innerHTML = `
      <div class="icon"><img class="ico ico--xl" src="/sprites/ui/icons/${safeIcon}.png" alt=""></div>
      <div class="head">
        <span class="title">${escapeHtml(spec.title || '')}</span>
        <span class="meta">${escapeHtml(spec.meta || '')}</span>
      </div>
      <div class="body">${escapeHtml(spec.body || '')}</div>
    `;
    track.appendChild(el);
    // Drop excess toasts so the DOM doesn't grow unbounded during a raid storm.
    while (track.children.length > MAX_TOASTS) {
      track.removeChild(track.firstChild);
    }
    // Schedule DOM cleanup after the CSS exit animation completes.
    setTimeout(() => {
      if (el.parentNode === track) track.removeChild(el);
    }, TOAST_DUR_MS + 800);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Bus connection ────────────────────────────────────────────────

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
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-clash' }));
      // Subscribe to the full clash.* family — the resolver fans out
      // both clash.* prefixed kinds and the bare DLL-republished
      // shapes ("raid.incoming", "war.active" etc.).
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['clash.*', 'raid.*', 'war.*', 'build.*', 'shield.*'] }));
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      const spec = classify(msg.kind, msg.data || msg.payload || {});
      if (spec) renderToast(spec);
    };
    ws.onclose = () => {
      setStatus('disconnected, retrying in ' + Math.round(backoff / 1000) + 's');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => { setStatus('error'); };
  }

  function setStatus(text) {
    if (!debug) return;
    let el = $('devStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = 'devStatus';
      el.className = 'dev-status';
      document.body.appendChild(el);
    }
    el.textContent = 'bus: ' + text;
  }

  if (debug) {
    // Demo cards so the overlay can be visually tuned without a live bus.
    renderToast(classify('clash.raid.incoming', { attackerName: 'CloudKnight' }));
    setTimeout(() => renderToast(classify('clash.raid.defended', { attackerName: 'CloudKnight', stars: 1 })), 1100);
    setTimeout(() => renderToast(classify('clash.war.declared',  {})), 2200);
    setTimeout(() => renderToast(classify('clash.build.complete', { name: 'Cannon #6' })), 3300);
  }

  connect();
})();
