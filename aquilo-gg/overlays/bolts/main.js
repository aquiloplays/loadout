/*
 * Loadout - unified Bolts overlay client.
 *
 * Layered architecture: each "scene" registers a kind→handler dispatcher and
 * a render fn. Adding a scene later (duels, slots, lootboxes) is one entry in
 * the SCENES table — no overlay rewrite.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const busUrl   = params.get('bus')    || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret   = params.get('secret') || '';
  const debug    = params.get('debug')  === '1';
  const enabled  = (params.get('layers') || 'leaderboard,toast,rain,streak,giftburst,welcomes')
                     .split(',').map(x => x.trim()).filter(Boolean);

  // Per-layer position overrides.
  for (const [param, id] of [
    ['lbPos', 'leaderboard'], ['toastPos', 'toastTrack'],
    ['streakPos', 'streak'], ['welcomePos', 'welcomeTrack']
  ]) {
    const v = params.get(param);
    if (v) $(id).dataset.pos = v;
  }

  // ── Theme overrides via URL params ────────────────────────────────────
  // Drive per-streamer theming without forking the overlay. Settings UI
  // builds the URL with these knobs; we apply them as CSS vars (for color
  // and opacity) and JS state (for things that affect render math).
  let _lbRows = 5;
  let _toastDurationMs = 4000;
  (() => {
    const root = document.documentElement.style;
    const accent = params.get('accent');
    if (accent) root.setProperty('--accent', '#' + accent.replace(/^#/, ''));
    const goldHex = params.get('gold');
    if (goldHex) root.setProperty('--gold', '#' + goldHex.replace(/^#/, ''));
    const bgOpacity = parseFloat(params.get('bgOpacity'));
    if (!isNaN(bgOpacity) && bgOpacity >= 0 && bgOpacity <= 100) {
      root.setProperty('--bg-alpha', String(bgOpacity / 100));
    }
    const lbRows = parseInt(params.get('lbRows'), 10);
    if (!isNaN(lbRows) && lbRows >= 1 && lbRows <= 10) _lbRows = lbRows;
    const toastDurSec = parseFloat(params.get('toastDur'));
    if (!isNaN(toastDurSec) && toastDurSec > 0) {
      _toastDurationMs = toastDurSec * 1000;
      root.setProperty('--toast-dur', toastDurSec + 's');
    }
  })();

  // Hide layers the user didn't enable.
  const allLayers = ['leaderboard', 'toastTrack', 'rain', 'streak', 'giftburst', 'welcomeTrack'];
  for (const id of allLayers) {
    const el = $(id);
    if (!el) continue;
    const wantedKey = id === 'toastTrack' ? 'toast'
                    : id === 'welcomeTrack' ? 'welcomes'
                    : id;
    if (!enabled.includes(wantedKey)) el.style.display = 'none';
  }

  // ── Scene: Leaderboard ────────────────────────────────────────────────
  const leaderboard = (() => {
    const el = $('leaderboard');
    const rows = el.querySelector('.lb-rows');
    return {
      kinds: ['bolts.leaderboard'],
      onEvent: (msg) => {
        const top = (msg.data && msg.data.top) || [];
        if (top.length === 0) { el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        rows.innerHTML = '';
        top.slice(0, _lbRows).forEach((entry, i) => {
          const li = document.createElement('li');
          li.className = 'lb-row ' + (['first','second','third'][i] || '');
          li.innerHTML =
            '<span class="rank">' + (i+1) + '</span>' +
            '<span class="name"></span>' +
            '<span class="val">' + (entry.balance || 0) + '</span>';
          li.querySelector('.name').textContent = entry.handle || '?';
          rows.appendChild(li);
        });
      }
    };
  })();

  // ── Scene: Earn toasts ────────────────────────────────────────────────
  // Throttled so a sub burst doesn't avalanche the screen.
  const toast = (() => {
    const track = $('toastTrack');
    const queue = [];
    let active = 0;
    const MAX_VISIBLE = 4;

    function pump() {
      while (active < MAX_VISIBLE && queue.length > 0) {
        const item = queue.shift();
        const el = document.createElement('div');
        el.className = 'toast' + (item.amount >= 100 ? ' big' : '');
        el.innerHTML =
          '<span class="who"></span><span class="amt">+' + item.amount + ' ⚡</span>';
        el.querySelector('.who').textContent = item.user || '?';
        track.appendChild(el);
        active++;
        setTimeout(() => { el.remove(); active--; pump(); }, _toastDurationMs);
      }
    }

    return {
      kinds: ['bolts.earned'],
      onEvent: (msg) => {
        const d = msg.data || {};
        if (!d.user || !d.amount) return;
        // Coalesce: if the last queued toast is same user within 1s, merge.
        const last = queue[queue.length - 1];
        if (last && last.user === d.user && Date.now() - last.ts < 1000) {
          last.amount += d.amount;
        } else {
          queue.push({ user: d.user, amount: d.amount, ts: Date.now() });
        }
        // Cap queue length so a flood doesn't pile up forever.
        while (queue.length > 20) queue.shift();
        pump();
      }
    };
  })();

  // ── Scene: Bolt rain ──────────────────────────────────────────────────
  const rain = (() => {
    const el = $('rain');
    return {
      kinds: ['bolts.rain'],
      onEvent: (msg) => {
        const d = msg.data || {};
        const recipientCount = (d.recipients && d.recipients.length) || 20;
        el.classList.remove('hidden');
        el.classList.add('active');

        // Drop one bolt per recipient, capped at 80 so we don't melt the GPU.
        const particleCount = Math.min(80, Math.max(20, recipientCount * 2));
        for (let i = 0; i < particleCount; i++) {
          const p = document.createElement('span');
          p.className = 'bolt-particle';
          p.textContent = '⚡';
          p.style.left  = (Math.random() * 100) + 'vw';
          p.style.fontSize = (18 + Math.random() * 28) + 'px';
          p.style.animationDuration = (1.5 + Math.random() * 2.0) + 's';
          p.style.animationDelay    = (Math.random() * 0.6) + 's';
          el.appendChild(p);
          setTimeout(() => p.remove(), 4000);
        }
        setTimeout(() => { el.classList.remove('active'); el.classList.add('hidden'); }, 4500);
      }
    };
  })();

  // ── Scene: Streak banner ──────────────────────────────────────────────
  const streak = (() => {
    const el = $('streak');
    const text = el.querySelector('.streak-text');
    return {
      kinds: ['bolts.streak'],
      onEvent: (msg) => {
        const d = msg.data || {};
        if (!d.streakDays || d.streakDays < 2) return;
        text.textContent = (d.user || '?') + ' is on a ' + d.streakDays + '-day streak!';
        el.classList.remove('hidden');
        // Force animation restart by reflow.
        void el.offsetWidth;
        el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
        setTimeout(() => el.classList.add('hidden'), 5500);
      }
    };
  })();

  // ── Scene: Gift burst ─────────────────────────────────────────────────
  const giftburst = (() => {
    const el = $('giftburst');
    const text = el.querySelector('.gift-text');
    return {
      kinds: ['bolts.gifted'],
      onEvent: (msg) => {
        const d = msg.data || {};
        if (!d.amount || !d.from || !d.to) return;
        text.textContent = '💝 ' + d.from + ' → ' + d.to + ' (' + d.amount + ' ⚡)';
        el.classList.remove('hidden');
        void el.offsetWidth;
        el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
        setTimeout(() => el.classList.add('hidden'), 3500);
      }
    };
  })();

  // ── Scene: Welcomes ───────────────────────────────────────────────────
  // Renders welcome.fired events as chat-toasts on a left-edge track. Same
  // queue pattern as earn toasts so a burst at start-of-stream doesn't
  // cascade off-screen.
  const welcomes = (() => {
    const track = $('welcomeTrack');
    const queue = [];
    let active = 0;
    const MAX_VISIBLE = 3;

    function pump() {
      while (active < MAX_VISIBLE && queue.length > 0) {
        const item = queue.shift();
        const el = document.createElement('div');
        el.className = 'welcome-toast';
        const role = (item.userType || 'viewer').toString().toLowerCase();
        el.innerHTML = '<span class="role"></span><span class="body"></span>';
        el.querySelector('.role').textContent =
          role === 'firsttime' ? 'first time'
          : role === 'sub' || role === 'subscriber' ? 'sub'
          : role === 'moderator' ? 'mod'
          : role;
        el.querySelector('.body').textContent = item.text;
        track.appendChild(el);
        active++;
        setTimeout(() => { el.remove(); active--; pump(); }, _toastDurationMs);
      }
    }

    return {
      kinds: ['welcome.fired'],
      onEvent: (msg) => {
        const d = msg.data || {};
        // `rendered` already has {user} substituted by the DLL; fall back to
        // the raw template + user only if the publisher didn't pre-render.
        const text = d.rendered || (d.template || '').replace('{user}', d.user || '');
        if (!text) return;
        queue.push({ userType: d.userType, text });
        while (queue.length > 12) queue.shift();
        pump();
      }
    };
  })();

  // ── Scene table (Phase 2 features add a row here) ────────────────────
  const SCENES = {
    leaderboard, toast, rain, streak, giftburst, welcomes
  };

  // Build kind→[scene] dispatch map for fast lookups.
  const dispatch = {};
  for (const [name, scene] of Object.entries(SCENES)) {
    if (!enabled.includes(name)) continue;
    for (const k of scene.kinds) {
      (dispatch[k] = dispatch[k] || []).push(scene);
    }
  }

  // ── Bus connection ────────────────────────────────────────────────────
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
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-bolts' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['bolts.*', 'welcome.*'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      const handlers = dispatch[msg.kind];
      if (!handlers) return;
      for (const s of handlers) try { s.onEvent(msg); } catch (err) { console.error(err); }
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

  if (debug) {
    leaderboard.onEvent({ kind: 'bolts.leaderboard', data: { top: [
      { handle: 'aquilo_plays', balance: 12450 },
      { handle: 'viewer_two',   balance: 8200 },
      { handle: 'viewer_three', balance: 5410 },
      { handle: 'viewer_four',  balance: 1100 },
      { handle: 'viewer_five',  balance: 920 }
    ]}});
    setTimeout(() => toast.onEvent({ kind: 'bolts.earned', data: { user: 'aquilo_plays', amount: 50 }}), 600);
    setTimeout(() => toast.onEvent({ kind: 'bolts.earned', data: { user: 'viewer_two', amount: 250 }}), 1400);
    setTimeout(() => streak.onEvent({ kind: 'bolts.streak', data: { user: 'viewer_three', streakDays: 12 }}), 2400);
    setTimeout(() => rain.onEvent({   kind: 'bolts.rain',   data: { recipients: Array(30).fill('x') }}), 4000);
    setTimeout(() => giftburst.onEvent({ kind: 'bolts.gifted', data: { from: 'a', to: 'b', amount: 500 }}), 8000);
    setTimeout(() => welcomes.onEvent({ kind: 'welcome.fired', data: { user: 'new_friend', userType: 'firstTime', rendered: '👋 Welcome new_friend, glad you found us!' }}), 1100);
    setTimeout(() => welcomes.onEvent({ kind: 'welcome.fired', data: { user: 'sub_returner', userType: 'sub', rendered: '✨ sub_returner is back!' }}), 2200);
  }
  connect();
})();
