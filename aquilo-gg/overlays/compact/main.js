/*
 * Loadout — compact unified overlay client.
 *
 * Single 400x120 card. Two layers (idle + active) crossfade based on
 * whether anything's happening on the bus. Idle layer is a slow
 * commands ticker. Active layer renders one event at a time; events
 * that arrive while another is on screen queue up so nothing gets
 * dropped. Each event maps to a "tone" class on the card so its
 * accent stripe matches the type of event.
 *
 * Why only one card visible at a time: streamers using this overlay
 * typically REPLACE the multi-overlay layout with this single source,
 * so jumbling 3 toasts on top of each other defeats the point.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const busUrl  = params.get('bus')    || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret  = params.get('secret') || '';
  const debug   = params.get('debug')  === '1';

  const pos = params.get('pos');
  if (pos) document.body.dataset.pos = pos;

  const HOLD_MS     = Math.max(1500, parseInt(params.get('holdMs')     || '4500', 10) || 4500);
  const IDLE_ROTATE = Math.max(10,   parseInt(params.get('idleRotate') || '30',   10) || 30) * 1000;

  const card     = $('card');
  const idleEl   = $('idle');
  const activeEl = $('active');
  const idleBadge = $('idleBadge');
  const idleName  = $('idleName');
  const idleDesc  = $('idleDesc');
  const actIcon   = $('actIcon');
  const actTitle  = $('actTitle');
  const actSub    = $('actSub');

  // ── Idle: commands ticker ────────────────────────────────────────────
  const fallbackCommands = [
    { name: '!uptime',     desc: 'how long the stream has been live', cat: 'info'  },
    { name: '!followage',  desc: 'how long you have followed',         cat: 'info'  },
    { name: '!commands',   desc: 'list every command available',       cat: 'info'  },
    { name: '!so @user',   desc: 'shoutout another streamer',          cat: 'info'  },
    { name: '!balance',    desc: 'check your bolts balance',           cat: 'bolts' },
    { name: '!leaderboard',desc: 'top bolts holders',                  cat: 'bolts' },
    { name: '!clip',       desc: 'clip the last moment',               cat: 'clip'  },
    { name: '!checkin',    desc: 'daily check-in',                     cat: 'checkin' }
  ];
  let commands = fallbackCommands.slice();
  let idleIdx = 0;
  let idleTimer = null;

  function badgeForCat(cat) {
    switch ((cat || 'info').toLowerCase()) {
      case 'bolts':   return '⚡';
      case 'clip':    return 'CLP';
      case 'checkin': return 'CHK';
      case 'counter': return '#';
      case 'mod':     return 'MOD';
      case 'custom':  return 'CMD';
      default:        return 'CMD';
    }
  }
  function tickIdle() {
    if (commands.length === 0) return;
    const c = commands[idleIdx % commands.length]; idleIdx++;
    idleBadge.textContent = badgeForCat(c.cat);
    idleName.textContent  = c.name || '!commands';
    idleDesc.textContent  = c.desc || c.description || '';
  }
  function startIdle() {
    if (idleTimer) clearInterval(idleTimer);
    tickIdle();
    idleTimer = setInterval(tickIdle, IDLE_ROTATE);
  }

  // ── Active: queued event cards ───────────────────────────────────────
  // Each entry: { tone, badge, title, sub, ttlMs }
  const queue = [];
  let active = false;
  let activeTimer = null;

  function enqueue(evt) {
    if (!evt) return;
    queue.push(evt);
    // Cap so a flood (gift sub burst) doesn't pile up forever.
    while (queue.length > 12) queue.shift();
    pump();
  }
  function pump() {
    if (active) return;
    const next = queue.shift();
    if (!next) return;
    active = true;

    // Update the active card's contents and tone, fade idle out, fade active in.
    actIcon.textContent  = next.badge || '';
    actTitle.textContent = next.title || '';
    actSub.textContent   = next.sub   || '';

    // Reset every tone- class then add the right one. Keeping this
    // imperative beats juggling N CSS rules per data attribute.
    card.classList.remove('tone-bolts','tone-welcome','tone-counter','tone-streak','tone-hype','tone-win','tone-lose','tone-info');
    card.classList.add('tone-' + (next.tone || 'info'));

    idleEl.classList.add('hidden');
    activeEl.classList.remove('hidden');
    // Restart the pop animation.
    activeEl.classList.remove('popped'); void activeEl.offsetWidth; activeEl.classList.add('popped');

    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(() => {
      activeEl.classList.add('hidden');
      idleEl.classList.remove('hidden');
      // After the crossfade completes, mark idle and pump the next event.
      setTimeout(() => {
        active = false;
        pump();
      }, 320); // matches the layer transition in style.css
    }, next.ttlMs || HOLD_MS);
  }

  // ── Bus event → active-card mapping ──────────────────────────────────
  function onMsg(msg) {
    if (!msg || !msg.kind) return;
    const k = msg.kind;
    const d = msg.data || {};
    if (k === 'commands.list') {
      ingestCommands(d);
      return;
    }

    let evt = null;
    switch (k) {
      case 'bolts.earned':
        if (!d.user || !d.amount) return;
        evt = { tone: 'bolts',  badge: '⚡', title: d.user, sub: '+' + d.amount + ' bolts' };
        break;
      case 'bolts.gifted':
        if (!d.from || !d.to) return;
        evt = { tone: 'bolts',  badge: '🎁', title: d.from + ' → ' + d.to, sub: '+' + (d.amount || 0) + ' bolts gifted' };
        break;
      case 'bolts.streak':
        if (!d.user || (d.streakDays || 0) < 2) return;
        evt = { tone: 'streak', badge: '🔥', title: d.user, sub: (d.streakDays || 0) + '-day streak' };
        break;
      case 'bolts.rain':
        evt = { tone: 'bolts',  badge: '💧', title: 'Bolt rain', sub: ((d.recipients && d.recipients.length) || '?') + ' viewers showered' };
        break;
      case 'bolts.leaderboard': {
        const top = (d.top || []);
        if (top.length === 0) return;
        evt = { tone: 'bolts', badge: '🏆', title: 'Top: ' + (top[0].handle || '?'), sub: (top[0].balance || 0) + ' bolts' };
        break;
      }
      case 'welcome.fired':
        if (!d.rendered && !d.user) return;
        evt = { tone: 'welcome', badge: '👋', title: d.user || 'viewer', sub: d.rendered || 'welcome' };
        break;
      case 'counter.updated':
        if (!d.name) return;
        evt = { tone: 'counter', badge: '#', title: (d.display || d.name), sub: (d.value != null ? String(d.value) : '?') };
        break;
      case 'hypetrain.start':
        evt = { tone: 'hype', badge: '🚂', title: 'Hype train started!', sub: 'level ' + (d.level || 1) + (d.fromUser ? ' — ' + d.fromUser : '') };
        break;
      case 'hypetrain.level':
        evt = { tone: 'hype', badge: '🚂', title: 'Train hit level ' + (d.level || '?'), sub: (d.fuel || 0) + ' / ' + (d.threshold || 0) + ' fuel' };
        break;
      case 'hypetrain.contribute':
        if (!d.user) return;
        evt = { tone: 'hype', badge: '⛽', title: d.user, sub: '+' + (d.fuel || 0) + ' fuel (' + (d.kind || '?') + ')' };
        break;
      case 'hypetrain.end':
        evt = { tone: 'hype', badge: '🏁', title: 'Hype train ended', sub: 'final level ' + (d.finalLevel || '?') };
        break;
      case 'bolts.minigame.coinflip':
        if (!d.user) return;
        evt = { tone: d.won ? 'win' : 'lose', badge: '🪙', title: d.user + (d.won ? ' won' : ' lost'),
                sub: 'coinflip ' + (d.result || '?') + '  ' + (d.won ? '+' : '-') + Math.abs(d.payout || d.wager || 0) + ' bolts' };
        break;
      case 'bolts.minigame.dice':
        if (!d.user) return;
        evt = { tone: d.won ? 'win' : 'lose', badge: '🎲', title: d.user + (d.won ? ' won' : ' lost'),
                sub: 'rolled ' + (d.rolled || '?') + (d.target ? ' / target ' + d.target : '') + '  ' + (d.won ? '+' : '-') + Math.abs(d.payout || d.wager || 0) + ' bolts' };
        break;
      case 'bolts.minigame.slots':
        if (!d.user) return;
        evt = { tone: d.won ? 'win' : 'lose', badge: '🎰', title: d.user + (d.won ? ' jackpot!' : ' spun the slots'),
                sub: (d.won ? '+' : '-') + Math.abs(d.payout || d.wager || 0) + ' bolts' };
        break;
      case 'viewer.profile.shown':
        if (!d.user) return;
        evt = { tone: 'info', badge: '🪪', title: d.user, sub: (d.bolts || 0) + ' bolts' + (d.streakDays ? ' · ' + d.streakDays + 'd streak' : '') };
        break;
    }
    if (evt) enqueue(evt);
  }

  function ingestCommands(payload) {
    if (!payload || !Array.isArray(payload.commands) || payload.commands.length === 0) return;
    commands = payload.commands.map(c => ({
      name: c.name,
      desc: c.desc || c.description || '',
      cat:  (c.cat || c.category || '').toLowerCase()
    })).filter(c => c.name);
    idleIdx = 0;
    if (idleTimer) clearInterval(idleTimer);
    startIdle();
  }

  // ── Bus connection ───────────────────────────────────────────────────
  let ws = null;
  let backoff = 1000;

  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    setStatus('connecting…');
    try { ws = new WebSocket(url); } catch (e) { setStatus('bad URL: ' + e.message); return; }

    ws.onopen = () => {
      setStatus('connected');
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-compact' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: [
        'commands.list', 'bolts.*', 'welcome.*', 'hypetrain.*',
        'counter.*', 'viewer.profile.shown'
      ]}));
      ws.send(JSON.stringify({ v: 1, kind: 'commands.requestList' }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      try { onMsg(msg); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      setStatus('disconnected, retrying in ' + Math.round(backoff/1000) + 's');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => setStatus('error');
  }

  function setStatus(t) {
    if (!debug) return;
    let el = document.getElementById('devStatus');
    if (!el) { el = document.createElement('div'); el.id = 'devStatus'; el.className = 'dev-status'; document.body.appendChild(el); }
    el.textContent = 'bus: ' + t;
  }

  // Boot the idle ticker immediately so the OBS source is never empty;
  // a real list arrives once the bus is connected and replaces this.
  startIdle();
  connect();

  if (debug) {
    setTimeout(() => onMsg({ kind: 'bolts.earned',   data: { user: 'aquilo_plays', amount: 50 }}), 1500);
    setTimeout(() => onMsg({ kind: 'welcome.fired',  data: { user: 'new_friend', rendered: '👋 Welcome new_friend, glad you found us!' }}), 7000);
    setTimeout(() => onMsg({ kind: 'counter.updated',data: { name: 'deaths', display: 'Deaths', value: 12 }}), 12500);
    setTimeout(() => onMsg({ kind: 'hypetrain.start',data: { level: 1, fuel: 60, threshold: 100, fromUser: 'kind_viewer' }}), 18000);
    setTimeout(() => onMsg({ kind: 'bolts.minigame.coinflip', data: { user: 'gambler', wager: 50, result: 'heads', won: true, payout: 50 }}), 23500);
  }
})();
