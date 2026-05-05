/*
 * Loadout - End-of-stream recap card.
 *
 * Subscribes to `recap.posted` from StreamRecapModule. When the stream
 * goes offline the module aggregates per-stream stats and publishes one
 * snapshot; we render the card and fade out after `duration` ms (so the
 * streamer has a window to right-click → save image, or screenshot for
 * socials).
 */
(() => {
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const duration = parseInt(params.get('duration') || '25000', 10);
  const debug = params.get('debug') === '1';

  const align = params.get('align'); if (align) document.body.dataset.align = align;

  const card     = document.getElementById('card');
  const headline = document.getElementById('headline');
  const stats    = document.getElementById('stats');
  const meta     = document.getElementById('meta');

  let hideTimer = null;

  function render(payload) {
    if (!payload) return;
    if (hideTimer) clearTimeout(hideTimer);

    headline.textContent = payload.broadcaster
      ? payload.broadcaster + " — Stream Recap"
      : "Stream Recap";

    const cells = [
      { label: 'follows',     value: payload.follows    ?? 0, color: 'cyan' },
      { label: 'subs',        value: payload.subs       ?? 0, color: 'azure' },
      { label: 'bits',        value: fmtNumber(payload.bits ?? 0), color: 'gold' },
      { label: 'super chats', value: payload.superChats ?? 0 },
    ];
    stats.innerHTML = cells.map(c =>
      `<div class="stat" data-color="${c.color || ''}">
         <div class="label">${escapeHtml(c.label)}</div>
         <div class="value">${escapeHtml(String(c.value))}</div>
       </div>`).join('');

    const parts = [];
    if (payload.duration)
      parts.push(`<span class="pair">duration <b>${escapeHtml(payload.duration)}</b></span>`);
    if (Array.isArray(payload.topChatters) && payload.topChatters.length > 0)
      parts.push(`<span class="pair">top chatter <b>${escapeHtml(payload.topChatters[0])}</b></span>`);
    if (Array.isArray(payload.raidsReceived) && payload.raidsReceived.length > 0)
      parts.push(`<span class="pair">raids <b>${escapeHtml(String(payload.raidsReceived.length))}</b></span>`);
    if (parts.length === 0) parts.push(`<span class="pair">thanks for hanging out 💜</span>`);
    meta.innerHTML = parts.join('');

    requestAnimationFrame(() => card.classList.add('show'));
    hideTimer = setTimeout(() => card.classList.remove('show'), duration);
  }

  function fmtNumber(n) {
    if (n >= 1_000_000) return (n/1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000)     return (n/1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[ch]));
  }

  // ---------------- Bus connection ----------------
  let ws = null;
  let backoff = 1000;

  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    setStatus('connecting...');
    try { ws = new WebSocket(url); }
    catch (e) { setStatus('bad URL: ' + e.message); return; }

    ws.onopen = () => {
      setStatus('connected');
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-recap' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['recap.posted'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || msg.kind !== 'recap.posted') return;
      render(msg.data);
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
    let el = document.getElementById('devStatus');
    if (!el) { el = document.createElement('div'); el.id = 'devStatus'; el.className = 'dev-status'; document.body.appendChild(el); }
    el.textContent = 'bus: ' + text;
  }

  if (debug) {
    render({
      broadcaster: 'aquilo_plays',
      duration: '03:42:18',
      follows: 47, subs: 12, bits: 5430, superChats: 3,
      topChatters: ['mocha (382)', 'pixel (271)', 'rosie (198)'],
      raidsReceived: ['ggsRunner (54)']
    });
  }
  connect();
})();
