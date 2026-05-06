/*
 * Loadout — Bolts minigames overlay client.
 *
 * Subscribes to bolts.minigame.* on the Aquilo Bus. Each event spawns a
 * brief animated card showing the visual (coin or die), the user, the
 * wager, and the outcome (won / lost + payout). Card slides in, animates
 * ~1.4s, reveals the result with a colour beat, slides out after ~3s.
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
  const coin    = card.querySelector('.coin');
  const die     = card.querySelector('.die');
  const diePip  = card.querySelector('.die-pip');
  const userEl  = $('user');
  const wagerEl = $('wager');
  const outcome = $('outcome');

  let hideTimer = null;
  let pulseTimer = null;

  function resetVisuals() {
    coin.style.display = 'none';
    die.style.display  = 'none';
    coin.classList.remove('flipping', 'show-heads', 'show-tails');
    die.classList.remove('rolling');
    card.classList.remove('win', 'lose', 'pulse');
  }

  function showCoin(result, won, user, wager, payout) {
    resetVisuals();
    coin.style.display = 'block';
    coin.classList.add('flipping', result === 'heads' ? 'show-heads' : 'show-tails');
    fillLines(user, wager, won, payout, 'flipped ' + (result || ''));
    schedulePulse();
  }

  function showDie(rolled, target, won, user, wager, payout) {
    resetVisuals();
    die.style.display = 'flex';
    die.classList.add('rolling');
    diePip.textContent = String(rolled || '?');
    fillLines(user, wager, won, payout,
      'rolled ' + (rolled || '?') + (target ? ' (target ' + target + ')' : ''));
    schedulePulse();
  }

  function fillLines(user, wager, won, payout, mid) {
    userEl.textContent = (user || '?') + ' — ' + mid;
    wagerEl.textContent = 'wagered ' + (wager || 0) + ' ⚡';
    outcome.classList.remove('win', 'lose');
    if (won) {
      outcome.textContent = '+' + (payout || 0) + ' ⚡  WON';
      outcome.classList.add('win');
      card.classList.add('win');
    } else {
      outcome.textContent = '-' + (wager || 0) + ' ⚡  LOST';
      outcome.classList.add('lose');
      card.classList.add('lose');
    }

    card.classList.remove('hidden');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => card.classList.add('hidden'), 3200);
  }

  function schedulePulse() {
    if (pulseTimer) clearTimeout(pulseTimer);
    // Pulse fires after the spin/roll animation lands (~1.4s) so the
    // outcome chip punches with the reveal.
    pulseTimer = setTimeout(() => {
      card.classList.remove('pulse');
      void card.offsetWidth;
      card.classList.add('pulse');
    }, 1300);
  }

  function handle(msg) {
    const d = msg.data || {};
    switch (msg.kind) {
      case 'bolts.minigame.coinflip':
        showCoin(d.result, !!d.won, d.user, d.wager, d.payout);
        break;
      case 'bolts.minigame.dice':
        showDie(d.rolled, d.target, !!d.won, d.user, d.wager, d.payout);
        break;
    }
  }

  // ---- Bus connection ----
  let ws = null, backoff = 1000;
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
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-minigames' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['bolts.minigame.*'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
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
