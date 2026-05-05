/*
 * Loadout - Viewer profile overlay client.
 *
 * Subscribes to `viewer.profile.shown` from the bus. The InfoCommandsModule
 * publishes that event when a chatter runs !profile (or !profile @user).
 * The card slides in for `duration` ms, then back out.
 *
 * The server-side payload includes:
 *   { handle, platform, bolts, requester, ts }
 * Future enhancements (the overlay reads them defensively):
 *   { topChatterRank, subAnniversaryMonths, checkInStreak, links: [...] }
 */
(() => {
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const duration = parseInt(params.get('duration') || '10000', 10);
  const debug = params.get('debug') === '1';

  const align = params.get('align'); if (align) document.body.dataset.align = align;

  const card    = document.getElementById('card');
  const handle  = document.getElementById('handle');
  const initial = document.getElementById('initial');
  const avatar  = document.getElementById('avatar');
  const stats   = document.getElementById('stats');

  let hideTimer = null;

  function render(p) {
    if (!p) return;
    if (hideTimer) clearTimeout(hideTimer);

    const name = p.handle || 'viewer';
    handle.textContent = '@' + name;
    initial.textContent = (name[0] || '?').toUpperCase();
    avatar.dataset.platform = (p.platform || '').toLowerCase();

    // Build whatever stats we have. Loadout's payload is the canonical
    // snapshot; if a future enhancement enriches with more fields, the
    // overlay picks them up automatically.
    const cells = [];
    if (p.bolts != null)
      cells.push({ label: 'bolts', value: fmtNumber(p.bolts), color: 'cyan' });
    if (p.subAnniversaryMonths != null && p.subAnniversaryMonths > 0)
      cells.push({ label: 'sub mo.', value: p.subAnniversaryMonths });
    if (p.topChatterRank != null && p.topChatterRank > 0)
      cells.push({ label: 'rank', value: '#' + p.topChatterRank, color: 'gold' });
    if (p.checkInStreak != null && p.checkInStreak > 0)
      cells.push({ label: 'check-in streak', value: p.checkInStreak });
    if (Array.isArray(p.links) && p.links.length > 0)
      cells.push({ label: 'linked', value: p.links.length, color: 'azure' });
    if (cells.length === 0)
      cells.push({ label: 'platform', value: (p.platform || 'unknown') });

    stats.innerHTML = cells.map(c =>
      `<div class="stat" data-color="${c.color || ''}">
         <div class="label">${escapeHtml(c.label)}</div>
         <div class="value">${escapeHtml(String(c.value))}</div>
       </div>`).join('');

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
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-viewer' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['viewer.profile.shown'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || msg.kind !== 'viewer.profile.shown') return;
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
      handle: 'mocha', platform: 'twitch',
      bolts: 5430, subAnniversaryMonths: 12, topChatterRank: 1, checkInStreak: 7
    });
  }
  connect();
})();
