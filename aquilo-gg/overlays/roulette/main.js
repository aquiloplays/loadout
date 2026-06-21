/*
 * Loadout - Roulette vote overlay client.
 *
 * Subscribes to `loadout.gameactions.roulette.*` from the local Aquilo
 * Bus and renders a viewer-facing vote card:
 *   .open  -> panel slides in with numbered options + countdown
 *   .vote  -> bars animate to the live tally
 *   .close -> winner gold-flashes, losers dim, panel hides after ~6s
 *
 * Idle = fully transparent, so the source can stay loaded full-canvas.
 * ?debug=1 self-runs a demo loop for the customizer / OBS preview.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const optionsEl = $('options');
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const debug  = params.get('debug') === '1';

  const pos = params.get('pos');
  if (pos) document.body.dataset.pos = pos;
  const accent = params.get('accent');
  if (accent) document.documentElement.style.setProperty('--roulette-accent', '#' + accent.replace(/^#/, ''));
  const title = params.get('title');
  if (title) $('headline').textContent = title;

  let closesAt = 0;
  let timerInterval = null;
  let hideTimer = null;

  function open(data) {
    if (!Array.isArray(data.options) || data.options.length === 0) return;
    clearTimeout(hideTimer);
    optionsEl.innerHTML = '';
    data.options.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'option';
      row.dataset.idx = i;
      row.innerHTML = `
        <div class="option-head">
          <span class="option-name"><span class="num">${i + 1}</span>${escapeHtml(name)}</span>
          <span class="option-count" data-count>0</span>
        </div>
        <div class="option-bar"><div class="option-fill"></div></div>
      `;
      optionsEl.appendChild(row);
    });
    closesAt = data.closesAtUtc
      ? new Date(data.closesAtUtc).getTime()
      : Date.now() + ((data.windowSec | 0) || 30) * 1000;
    clearInterval(timerInterval);
    timerInterval = setInterval(tick, 250);
    tick();
    root.classList.remove('idle');
  }

  function tick() {
    const left = Math.max(0, Math.ceil((closesAt - Date.now()) / 1000));
    const t = $('timer');
    t.textContent = left;
    t.classList.toggle('urgent', left <= 5 && left > 0);
    if (left <= 0) clearInterval(timerInterval);
  }

  function vote(data) {
    if (!Array.isArray(data.tally)) return;
    const max = Math.max(1, ...data.tally);
    optionsEl.querySelectorAll('.option').forEach(row => {
      const i = parseInt(row.dataset.idx, 10);
      const n = data.tally[i] | 0;
      const count = row.querySelector('[data-count]');
      const fill  = row.querySelector('.option-fill');
      if (count) count.textContent = n;
      if (fill) fill.style.width = Math.round((n / max) * 100) + '%';
    });
  }

  function close(data) {
    clearInterval(timerInterval);
    const t = $('timer');
    t.textContent = '';
    t.classList.remove('urgent');
    if (Array.isArray(data.tally)) vote(data);
    if (typeof data.winnerIndex === 'number') {
      optionsEl.querySelectorAll('.option').forEach(row => {
        const isWinner = parseInt(row.dataset.idx, 10) === data.winnerIndex;
        row.classList.toggle('winner', isWinner);
        row.classList.toggle('loser', !isWinner);
      });
    }
    $('hint').textContent = (data.winner || '?') + ' wins';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      root.classList.add('idle');
      // Reset the hint for the next round after the fade completes.
      setTimeout(() => { $('hint').textContent = 'type the number in chat to vote'; }, 500);
    }, 6000);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
    ));
  }

  // ── Bus connection ────────────────────────────────────────────────
  let ws = null;
  let backoff = 1000;

  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    try { ws = new WebSocket(url); }
    catch { return; }

    ws.onopen = () => {
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-roulette' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['loadout.gameactions.roulette.*'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      const data = msg.data || {};
      if (msg.kind === 'loadout.gameactions.roulette.open')  open(data);
      if (msg.kind === 'loadout.gameactions.roulette.vote')  vote(data);
      if (msg.kind === 'loadout.gameactions.roulette.close') close(data);
    };
    ws.onclose = () => {
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
  }

  // ── Demo loop for preview / customizer ────────────────────────────
  if (debug) {
    const demoOptions = ['drop weapon', 'flashbang', 'crouch spam'];
    function demoRound() {
      const windowSec = 12;
      open({ options: demoOptions, windowSec });
      const tally = [0, 0, 0];
      const voteInterval = setInterval(() => {
        tally[Math.floor(Math.random() * tally.length)]++;
        vote({ tally, voters: tally.reduce((a, b) => a + b, 0) });
      }, 650);
      setTimeout(() => {
        clearInterval(voteInterval);
        let winnerIndex = 0;
        for (let i = 1; i < tally.length; i++) if (tally[i] > tally[winnerIndex]) winnerIndex = i;
        close({ winner: demoOptions[winnerIndex], winnerIndex, tally });
        setTimeout(demoRound, 9000);   // breathe, then loop
      }, windowSec * 1000);
    }
    demoRound();
  }

  connect();
})();
