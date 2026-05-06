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
  const gameEl   = $('game');
  const idleBadge = $('idleBadge');
  const idleName  = $('idleName');
  const idleDesc  = $('idleDesc');
  const actIcon   = $('actIcon');
  const actTitle  = $('actTitle');
  const actSub    = $('actSub');
  const gameTitle = $('gameTitle');
  const gameSub   = $('gameSub');
  const gCoin     = gameEl.querySelector('.g-coin');
  const gCoinFaceHeads = gameEl.querySelector('.g-coin-face.heads');
  const gCoinFaceTails = gameEl.querySelector('.g-coin-face.tails');
  const gDie      = gameEl.querySelector('.g-die');
  const gDiePip   = gameEl.querySelector('.g-die-pip');
  const gSlots    = gameEl.querySelector('.g-slots');
  const gReels    = [$('gReel0'), $('gReel1'), $('gReel2')];

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

  // Streamer-supplied per-category icon overrides. Set on receipt of
  // commands.icons; falls back to the hardcoded default emoji per cat.
  let iconOverrides = {};
  function defaultBadgeForCat(cat) {
    switch ((cat || 'info').toLowerCase()) {
      case 'bolts':   return '⚡';
      case 'clip':    return '🎬';
      case 'checkin': return '✅';
      case 'counter': return '🔢';
      case 'mod':     return '🛡️';
      case 'custom':  return '💬';
      case 'song':
      case 'music':   return '🎵';
      default:        return '💬';
    }
  }
  function badgeForCat(cat) {
    const v = iconOverrides[cat] || iconOverrides[(cat || '').toLowerCase()];
    if (typeof v === 'string' && v.length > 0) return v;
    return defaultBadgeForCat(cat);
  }
  function isImageBadge(s) {
    if (!s) return false;
    return /^data:image\//i.test(s) || /^https?:\/\/.+\.(png|jpe?g|gif|webp|svg)/i.test(s);
  }
  function applyBadge(el, value) {
    if (isImageBadge(value)) {
      el.innerHTML = '';
      const img = document.createElement('img');
      img.src = value;
      img.alt = '';
      img.className = 'badge-img';
      el.appendChild(img);
    } else {
      el.textContent = value;
    }
  }
  function tickIdle() {
    if (commands.length === 0) return;
    const c = commands[idleIdx % commands.length]; idleIdx++;
    applyBadge(idleBadge, badgeForCat(c.cat));
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

    // Reset every tone- class then add the right one. Keeping this
    // imperative beats juggling N CSS rules per data attribute.
    card.classList.remove('tone-bolts','tone-welcome','tone-counter','tone-streak','tone-hype','tone-win','tone-lose','tone-info');
    card.classList.add('tone-' + (next.tone || 'info'));

    if (next.game) {
      // Game events get the animated visual layer instead of the
      // emoji-badge text card. The runner schedules its own settle +
      // text reveal; pump just times the auto-hide.
      runGame(next);
    } else {
      // Update the active card's contents and tone, fade idle out, fade active in.
      // Use applyBadge so streamer-supplied photo overrides render as <img>.
      applyBadge(actIcon, next.badge || '');
      actTitle.textContent = next.title || '';
      actSub.textContent   = next.sub   || '';

      idleEl.classList.add('hidden');
      gameEl.classList.add('hidden');
      activeEl.classList.remove('hidden');
      // Restart the pop animation.
      activeEl.classList.remove('popped'); void activeEl.offsetWidth; activeEl.classList.add('popped');
    }

    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(() => {
      activeEl.classList.add('hidden');
      gameEl.classList.add('hidden');
      idleEl.classList.remove('hidden');
      // After the crossfade completes, mark idle and pump the next event.
      setTimeout(() => {
        active = false;
        pump();
      }, 320); // matches the layer transition in style.css
    }, next.ttlMs || HOLD_MS);
  }

  // ── Game runner (coin / die / slots) ─────────────────────────────────
  // Mirrors the standalone minigames overlay's animation timings but
  // compressed for the 56px-square visual slot. The settle phase
  // updates the title + sub text so chat doesn't see the result before
  // the visual lands.
  function resetGameVisuals() {
    gCoin.classList.remove('show', 'flipping', 'show-heads', 'show-tails');
    gDie.classList.remove('show', 'rolling');
    gSlots.classList.remove('show');
    gReels.forEach(r => { r.classList.remove('spinning', 'locked'); r.innerHTML = ''; });
  }
  function runGame(item) {
    resetGameVisuals();
    const d = item._data || {};
    // Title shows during animation; sub is filled at settle so the
    // payout reveal lands with the visual.
    gameTitle.textContent = item.title || (d.user || '?');
    gameSub.textContent   = item.sub   || '';

    idleEl.classList.add('hidden');
    activeEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    gameEl.classList.remove('popped'); void gameEl.offsetWidth; gameEl.classList.add('popped');

    if (item.game === 'coinflip') return runCoin(d);
    if (item.game === 'dice')     return runDie(d);
    if (item.game === 'slots')    return runSlots(d);
  }
  function runCoin(d) {
    gCoin.classList.add('show', 'flipping', d.result === 'tails' ? 'show-tails' : 'show-heads');
    setTimeout(() => {
      // Settle: keep current sub (already set with payout); just pulse.
      gameEl.classList.remove('popped'); void gameEl.offsetWidth; gameEl.classList.add('popped');
    }, 1300);
  }
  function runDie(d) {
    gDie.classList.add('show', 'rolling');
    gDiePip.textContent = String(d.rolled || '?');
    setTimeout(() => {
      gameEl.classList.remove('popped'); void gameEl.offsetWidth; gameEl.classList.add('popped');
    }, 1300);
  }
  function runSlots(d) {
    gSlots.classList.add('show');
    // Render symbols using the same isUrl heuristic the standalone
    // slots overlay uses so emoji-pool entries render as text glyphs.
    const pool = (d.pool && d.pool.length ? d.pool : null) ||
                 (d.reels && d.reels.length ? d.reels : null) ||
                 ['🍒', '🔔', '💎', '⭐', '🍇', '🍋'];
    function isUrl(s) { return /^https?:\/\//i.test(s) || /^\/\//.test(s); }
    function setSym(reel, sym) {
      if (isUrl(sym)) {
        let img = reel.firstElementChild;
        if (!img || img.tagName !== 'IMG') {
          reel.innerHTML = ''; img = document.createElement('img'); reel.appendChild(img);
        }
        img.src = sym;
      } else {
        let span = reel.firstElementChild;
        if (!span || span.tagName !== 'SPAN') {
          reel.innerHTML = ''; span = document.createElement('span');
          span.className = 'g-reel-glyph'; reel.appendChild(span);
        }
        span.textContent = sym;
      }
    }
    const cyclers = gReels.map(reel => {
      reel.classList.add('spinning');
      setSym(reel, pool[Math.floor(Math.random() * pool.length)]);
      return setInterval(() => setSym(reel, pool[Math.floor(Math.random() * pool.length)]), 90);
    });
    const match = d.reels && d.reels.length === 3;
    [700, 1000, 1300].forEach((t, i) => {
      setTimeout(() => {
        clearInterval(cyclers[i]);
        if (match) setSym(gReels[i], d.reels[i]);
        gReels[i].classList.remove('spinning');
        gReels[i].classList.add('locked');
        if (i === 2) {
          gameEl.classList.remove('popped'); void gameEl.offsetWidth; gameEl.classList.add('popped');
        }
      }, t);
    });
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
    if (k === 'commands.icons') {
      iconOverrides = (d && d.byCategory) || {};
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
        // For TikTok gifts, surface the actual gift name + emoji
        // (Rose, Lion, Galaxy, etc.) instead of the generic
        // "tiktokGift" string. TikTokGifts.label is provided by
        // _shared/tiktok-gifts.js — falls through to a 🎁 if the
        // gift isn't in the curated map.
        var contribKind = d.kind || '?';
        if (contribKind === 'tiktokGift' && window.TikTokGifts) {
          contribKind = window.TikTokGifts.label({ giftName: d.giftName, coins: d.coins });
        }
        evt = { tone: 'hype', badge: '⛽', title: d.user, sub: '+' + (d.fuel || 0) + ' fuel (' + contribKind + ')' };
        break;
      case 'hypetrain.end':
        evt = { tone: 'hype', badge: '🏁', title: 'Hype train ended', sub: 'final level ' + (d.finalLevel || '?') };
        break;
      case 'bolts.minigame.coinflip':
        if (!d.user) return;
        // Route to the game layer so the coin actually flips before
        // text reveals. The pump path special-cases evt.game and
        // animates the badge slot for HOLD_MS milliseconds.
        evt = { tone: d.won ? 'win' : 'lose', game: 'coinflip',
                title: d.user, sub: '!coinflip ' + Math.abs(d.payout || d.wager || 0) + ' ⚡',
                _data: d };
        break;
      case 'bolts.minigame.dice':
        if (!d.user) return;
        evt = { tone: d.won ? 'win' : 'lose', game: 'dice',
                title: d.user, sub: '!dice ' + Math.abs(d.payout || d.wager || 0) + ' ⚡',
                _data: d };
        break;
      case 'bolts.minigame.slots':
        if (!d.user) return;
        evt = { tone: d.won ? 'win' : 'lose', game: 'slots',
                title: d.user, sub: '!slots ' + Math.abs(d.payout || d.wager || 0) + ' ⚡',
                _data: d };
        break;
      case 'viewer.profile.shown':
        if (!d.user) return;
        evt = { tone: 'info', badge: '🪪', title: d.user, sub: (d.bolts || 0) + ' bolts' + (d.streakDays ? ' · ' + d.streakDays + 'd streak' : '') };
        break;
      case 'rotation.song.playing':
        if (!d.title) return;
        evt = { tone: 'welcome', badge: '🎵',
                title: d.title + (d.artist ? ' — ' + d.artist : ''),
                sub: (d.source || 'Spotify') + (d.requestedBy ? '  · req by ' + d.requestedBy : '') };
        break;
      case 'rotation.song.queued':
        if (!d.title) return;
        evt = { tone: 'info', badge: '➕',
                title: 'Queued: ' + d.title + (d.artist ? ' — ' + d.artist : ''),
                sub: (d.requestedBy ? 'by ' + d.requestedBy : 'priority request') };
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
        'commands.list', 'commands.icons', 'bolts.*', 'welcome.*',
        'hypetrain.*', 'counter.*', 'viewer.profile.shown',
        'rotation.song.playing', 'rotation.song.queued'
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
