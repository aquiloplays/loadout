/*
 * aquilo.gg Hangman overlay.
 *
 * A viewer redeems a channel point reward (or types !hangman) and goes
 * on the gallows: their Twitch profile picture is the head, and every
 * wrong guess draws another body part. Guess the word in time or eat a
 * chat timeout, delivered through the "Hangman · Timeout" Streamer.bot
 * action from the import bundle at aquilo.gg/hangman.
 *
 * Game rules live in hangman-core.js (pure, selftested); this file is
 * wiring: Streamer.bot WebSocket, rendering, sounds, persistence.
 */
(function () {
  'use strict';

  var Core = window.HangmanCore;
  var Words = window.HangmanWords;
  var params = new URLSearchParams(location.search);

  function num(name, dflt) {
    var v = parseFloat(params.get(name));
    return Number.isFinite(v) ? v : dflt;
  }
  function flag(name, dflt) {
    var v = params.get(name);
    if (v == null) return dflt;
    return /^(1|true|yes|on)$/i.test(v);
  }
  function str(name, dflt) {
    var v = params.get(name);
    return v == null || v === '' ? dflt : v;
  }
  function pick(name, dflt, allowed) {
    var v = (params.get(name) || '').toLowerCase();
    return allowed.indexOf(v) >= 0 ? v : dflt;
  }

  var cfg = {
    sbHost: str('sbHost', '127.0.0.1'),
    sbPort: num('sbPort', 8080),
    sbPass: str('sbPass', ''),
    reward: str('reward', 'hangman'),       // reward title substring; 0 disables
    cmd: str('cmd', '!hangman'),            // chat command; 0 disables
    who: pick('who', 'everyone', ['everyone', 'subs', 'vips', 'mods']),
    lives: num('lives', 6),
    secs: num('secs', 120),
    cd: num('cd', 30),
    to: num('to', 60),                      // timeout seconds on loss; 0 disables
    reason: str('reason', 'Lost a game of Hangman'),
    say: str('say', 'start,win,lose'),      // chat announcements; 0 silences
    cats: str('cats', '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    words: str('words', '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    customOnly: flag('customOnly', false),
    reveal: flag('reveal', true),
    sound: flag('sound', true),
    vol: Math.max(0, Math.min(100, num('vol', 60))),
    status: flag('status', true),
    actTimeout: str('actTimeout', 'Hangman · Timeout'),
    actSay: str('actSay', 'Hangman · Announce'),
    key: str('key', 'default'),
    demo: flag('demo', false),
    bg: flag('bg', false)
  };
  if (cfg.reward === '0') cfg.reward = '';
  if (cfg.cmd === '0') cfg.cmd = '';
  var sayFams = cfg.say === '0' ? [] : cfg.say.toLowerCase().split(',').map(function (s) { return s.trim(); });

  if (cfg.bg) document.body.classList.add('test-bg');
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── dom ─────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var card = $('card'), wordEl = $('word'), missEl = $('missLetters'), pipsEl = $('pips');
  var pAva = $('pAva'), pInit = $('pInit'), pName = $('pName'), pSub = $('pSub');
  var catChip = $('catChip'), timeChip = $('timeChip'), timeFill = $('timefill');
  var banner = $('banner'), bannerTitle = $('bannerTitle'), bannerSub = $('bannerSub');
  var avaImg = $('avaImg'), avaText = $('avaText'), deadFace = $('deadFace');
  var fig = $('fig'), toastEl = $('toast'), statusEl = $('statusDot'), statusText = $('statusText');
  var hintLine = $('hintLine');
  var PART_IDS = ['part-head', 'part-torso', 'part-armL', 'part-armR', 'part-legL', 'part-legR'];

  // ── state ───────────────────────────────────────────────────────────
  var game = null;          // Core game state (+ .test flag for local tests)
  var cooldownUntil = 0;
  var lastWord = '';
  var hideTimer = 0;
  var shownParts = 0;

  // ── sounds ──────────────────────────────────────────────────────────
  var actx = null;
  function audio() {
    if (!cfg.sound || cfg.vol <= 0) return null;
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (actx.state === 'suspended') { try { actx.resume(); } catch (e) {} }
    return actx;
  }
  function tone(f0, f1, dur, type, peak, delay) {
    var ac = audio();
    if (!ac) return;
    var t0 = ac.currentTime + (delay || 0);
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    var v = (peak || 0.1) * (cfg.vol / 100);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  var sfx = {
    start: function () { tone(300, 640, 0.2, 'sine', 0.09); },
    ding: function () { tone(880, 880, 0.07, 'sine', 0.1); tone(1318, 1318, 0.1, 'sine', 0.1, 0.07); },
    thud: function () { tone(160, 62, 0.24, 'triangle', 0.17); },
    tick: function () { tone(1250, 1250, 0.045, 'sine', 0.05); },
    win: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, f, 0.1, 'sine', 0.11, i * 0.085); }); },
    lose: function () { [392, 330, 262].forEach(function (f, i) { tone(f, f * 0.97, 0.24, 'triangle', 0.13, i * 0.22); }); }
  };

  // ── floating ui ─────────────────────────────────────────────────────
  var toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  var statusTimer = 0;
  function setStatus(text, cls, autohideMs) {
    if (!cfg.status) return;
    statusEl.hidden = false;
    statusEl.className = cls || '';
    statusEl.classList.add('show');
    statusText.textContent = text;
    clearTimeout(statusTimer);
    if (autohideMs) statusTimer = setTimeout(function () { statusEl.classList.remove('show'); }, autohideMs);
  }

  // ── avatars ─────────────────────────────────────────────────────────
  var avatarCache = {};
  function applyAvatar(url, player) {
    var initial = (player.name || '?').charAt(0).toUpperCase();
    if (url) {
      pAva.src = url;
      pAva.parentElement.classList.add('has-img');
      avaImg.setAttribute('href', url);
      avaImg.style.display = '';
      avaText.style.display = 'none';
    } else {
      pAva.removeAttribute('src');
      pAva.parentElement.classList.remove('has-img');
      pInit.textContent = initial;
      avaImg.removeAttribute('href');
      avaImg.style.display = 'none';
      avaText.style.display = '';
      avaText.textContent = initial;
    }
  }
  function preload(url) {
    return new Promise(function (resolve) {
      if (!url) return resolve(null);
      var im = new Image();
      im.onload = function () { resolve(url); };
      im.onerror = function () { resolve(null); };
      im.src = url;
    });
  }
  function loadAvatar(player, given) {
    applyAvatar(null, player);
    var key = player.login || player.id || player.name;
    if (avatarCache[key]) { applyAvatar(avatarCache[key], player); return; }
    var chain = [];
    if (given) chain.push(given);
    if (player.login) chain.push('https://unavatar.io/twitch/' + encodeURIComponent(player.login) + '?fallback=false');
    var step = function (i) {
      if (i >= chain.length) return decapi();
      preload(chain[i]).then(function (ok) {
        if (!ok) return step(i + 1);
        avatarCache[key] = ok;
        if (game && game.player && (game.player.login || game.player.id || game.player.name) === key) applyAvatar(ok, player);
      });
    };
    var decapi = function () {
      if (!player.login) return;
      fetch('https://decapi.me/twitch/avatar/' + encodeURIComponent(player.login))
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (t) {
          t = (t || '').trim();
          if (!/^https?:\/\//.test(t)) return;
          return preload(t).then(function (ok) {
            if (!ok) return;
            avatarCache[key] = ok;
            if (game && game.player && (game.player.login || game.player.id || game.player.name) === key) applyAvatar(ok, player);
          });
        })
        .catch(function () {});
    };
    step(0);
  }

  // ── rendering ───────────────────────────────────────────────────────
  function tileSize(word) {
    var n = word.length;
    if (n <= 9) return 40;
    if (n <= 13) return 34;
    if (n <= 17) return 29;
    return 25;
  }

  function buildWord() {
    wordEl.innerHTML = '';
    wordEl.style.setProperty('--tile', tileSize(game.word) + 'px');
    var sl = Core.slots(game);
    for (var i = 0; i < sl.length; i++) {
      var t = document.createElement('div');
      var s = document.createElement('span');
      if (sl[i].ch === ' ') t.className = 'tile space';
      else if (sl[i].ch === '-') { t.className = 'tile hyph'; s.textContent = '-'; }
      else t.className = 'tile';
      t.appendChild(s);
      wordEl.appendChild(t);
    }
  }

  function renderWord(lateReveal) {
    var sl = Core.slots(game);
    var tiles = wordEl.children;
    for (var i = 0; i < sl.length; i++) {
      var t = tiles[i];
      if (!t || sl[i].gap) continue;
      var hit = game.hits.indexOf(sl[i].ch) >= 0;
      if (sl[i].shown && !t.classList.contains('show')) {
        t.classList.add('show');
        if (!hit && lateReveal) t.classList.add('late');
        t.firstChild.textContent = sl[i].ch;
      }
    }
  }

  function renderMisses() {
    missEl.innerHTML = '';
    game.wrong.forEach(function (L) {
      var d = document.createElement('span');
      d.className = 'missL';
      d.textContent = L;
      missEl.appendChild(d);
    });
    pipsEl.innerHTML = '';
    var wrong = Core.wrongCount(game);
    for (var i = 0; i < game.lives; i++) {
      var p = document.createElement('span');
      p.className = 'pip' + (i < wrong ? ' hit' : '');
      pipsEl.appendChild(p);
    }
  }

  function renderParts() {
    var n = Core.partsShown(game);
    for (var i = 0; i < PART_IDS.length; i++) {
      var el = $(PART_IDS[i]);
      if (i < n) el.classList.add('on');
      else el.classList.remove('on');
    }
    deadFace.style.display = game.status === 'lost' ? '' : 'none';
    if (!reducedMotion && n > 0 && game.status === 'playing') fig.classList.add('swinging');
    else fig.classList.remove('swinging');
    shownParts = n;
  }

  function renderTimer(now) {
    if (!game || game.status !== 'playing') return;
    var left = Math.max(0, game.endsAt - now);
    var total = game.endsAt - game.startedAt;
    var pct = total > 0 ? (left / total) * 100 : 0;
    timeFill.style.width = pct + '%';
    var s = Math.ceil(left / 1000);
    timeChip.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    var low = pct <= 33, critical = s <= 10;
    timeFill.classList.toggle('low', low && !critical);
    timeFill.classList.toggle('critical', critical);
    timeChip.classList.toggle('low', low && !critical);
    timeChip.classList.toggle('critical', critical);
  }

  function renderHeader() {
    pName.textContent = game.player.name;
    pSub.textContent = game.test && !cfg.demo ? 'test run, nothing fires' : 'is on the gallows';
    catChip.textContent = game.category || 'mystery';
    catChip.className = 'chip cat';
  }

  function renderAll() {
    buildWord();
    renderWord(false);
    renderMisses();
    renderParts();
    renderHeader();
    renderTimer(Date.now());
    hintLine.innerHTML = 'type a letter in chat &middot; <b>!solve word</b> to go for it';
    banner.classList.remove('show', 'win', 'lose');
    card.dataset.state = game.status === 'playing' ? 'playing' : (game.status === 'won' ? 'win' : 'lose');
  }

  // ── confetti ────────────────────────────────────────────────────────
  var fxCanvas = $('fx'), fxCtx = fxCanvas.getContext('2d'), fxParts = [], fxRunning = false;
  function confetti() {
    if (reducedMotion) return;
    fxCanvas.width = innerWidth; fxCanvas.height = innerHeight;
    var colors = ['#2dd4bf', '#9a82ff', '#6ff18b', '#f0b429', '#ffffff'];
    var r = card.getBoundingClientRect();
    for (var i = 0; i < 130; i++) {
      fxParts.push({
        x: r.left + r.width * Math.random(),
        y: r.top + 10,
        vx: (Math.random() - 0.5) * 7,
        vy: -(2 + Math.random() * 7),
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        w: 5 + Math.random() * 5,
        h: 3 + Math.random() * 4,
        c: colors[(Math.random() * colors.length) | 0],
        life: 1
      });
    }
    if (!fxRunning) { fxRunning = true; requestAnimationFrame(fxStep); }
  }
  function fxStep() {
    fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    fxParts = fxParts.filter(function (p) { return p.life > 0; });
    fxParts.forEach(function (p) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.18; p.rot += p.vr; p.life -= 0.008;
      fxCtx.save();
      fxCtx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.6));
      fxCtx.translate(p.x, p.y); fxCtx.rotate(p.rot);
      fxCtx.fillStyle = p.c;
      fxCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      fxCtx.restore();
    });
    if (fxParts.length) requestAnimationFrame(fxStep);
    else { fxRunning = false; fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height); }
  }

  // ── persistence ─────────────────────────────────────────────────────
  var PERSIST_KEY = 'aq-hangman:v1:' + cfg.key;
  function persist() {
    if (cfg.demo) return;
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        v: 1,
        game: game && game.status === 'playing' ? JSON.parse(Core.serialize(game)) : null,
        cooldownUntil: cooldownUntil,
        lastWord: lastWord
      }));
    } catch (e) {}
  }
  function restore() {
    if (cfg.demo) return;
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(PERSIST_KEY) || 'null'); } catch (e) {}
    if (!raw) return;
    cooldownUntil = raw.cooldownUntil || 0;
    lastWord = raw.lastWord || '';
    if (raw.game) {
      var g = Core.deserialize(JSON.stringify(raw.game), Date.now());
      if (g) {
        game = g;
        renderAll();
        loadAvatar(game.player, null);
      }
    }
  }

  // ── chat templates ──────────────────────────────────────────────────
  function fmtWordForChat() {
    return game.word;
  }
  function sayStart() {
    if (sayFams.indexOf('start') < 0 || game.test) return;
    var letters = Core.letterCount(game.word);
    sbSay('🪢 Hangman! ' + game.player.name + ' is on the gallows: ' + letters +
      ' letters, category ' + (game.category || 'mystery') +
      '. Type single letters in chat, or !solve the word. ' + game.lives + ' misses and it is lights out.');
  }
  function sayWin() {
    if (sayFams.indexOf('win') < 0 || game.test) return;
    sbSay('🎉 ' + game.player.name + ' escaped the gallows! The word was ' + fmtWordForChat() +
      ', with ' + Core.livesLeft(game) + (Core.livesLeft(game) === 1 ? ' life' : ' lives') + ' to spare.');
  }
  function sayLose() {
    if (sayFams.indexOf('lose') < 0 || game.test) return;
    var why = game.loseReason === 'time' ? '⏰ ' + game.player.name + ' ran out of time!'
      : '💀 ' + game.player.name + ' ran out of luck.';
    var msg = why + (cfg.reveal ? ' The word was ' + fmtWordForChat() + '.' : '');
    if (cfg.to > 0) msg += ' Enjoy the ' + cfg.to + 's timeout.';
    sbSay(msg);
  }

  // ── game lifecycle ──────────────────────────────────────────────────
  function startGame(player, opts) {
    opts = opts || {};
    clearTimeout(hideTimer);
    var picked = opts.word
      ? { word: opts.word, category: opts.category || 'Streamer pick' }
      : Core.pickWord({
          bank: Words,
          categories: cfg.cats,
          customWords: cfg.words,
          customOnly: cfg.customOnly,
          avoid: lastWord
        });
    if (!picked) { toast('no playable words configured'); return false; }
    game = Core.newGame({
      word: picked.word,
      category: picked.category,
      player: player,
      lives: cfg.lives,
      secs: cfg.secs
    });
    if (!game) { toast('word rejected: ' + picked.word); return false; }
    if (opts.test) game.test = true;
    lastWord = game.word;
    renderAll();
    loadAvatar(player, opts.pfp || null);
    sfx.start();
    sayStart();
    persist();
    return true;
  }

  function finishGame(won) {
    if (!game.test) cooldownUntil = Date.now() + cfg.cd * 1000;
    renderWord(true);
    renderMisses();
    renderParts();
    card.dataset.state = won ? 'win' : 'lose';
    banner.classList.add('show', won ? 'win' : 'lose');
    if (won) {
      bannerTitle.textContent = 'ESCAPED!';
      bannerSub.innerHTML = '';
      var b = document.createElement('span');
      b.className = 'wordReveal';
      b.textContent = game.word;
      bannerSub.appendChild(b);
      confetti();
      sfx.win();
      sayWin();
    } else {
      bannerTitle.textContent = 'GAME OVER';
      bannerSub.innerHTML = '';
      if (cfg.reveal) {
        var w = document.createElement('span');
        w.className = 'wordReveal';
        w.textContent = 'the word was ' + game.word;
        bannerSub.appendChild(w);
      }
      if (cfg.to > 0 && (cfg.demo || !game.test)) {
        var c = document.createElement('span');
        c.className = 'toChip';
        c.textContent = '+' + cfg.to + 's timeout';
        bannerSub.appendChild(c);
      }
      sfx.lose();
      sayLose();
      punish();
    }
    persist();
    hideTimer = setTimeout(function () {
      card.dataset.state = 'idle';
      game = null;
      persist();
    }, won ? 8000 : 9500);
  }

  function cancelGame(silent) {
    if (!game) return;
    clearTimeout(hideTimer);
    game = null;
    card.dataset.state = 'idle';
    persist();
    if (!silent) toast('game cancelled');
  }

  function punish() {
    if (cfg.to <= 0 || cfg.demo || game.test) return;
    if (!game.player.login && !game.player.id) return;
    sbDo(cfg.actTimeout, {
      user: game.player.login || game.player.name,
      userId: game.player.id,
      duration: String(cfg.to),
      reason: cfg.reason
    });
  }

  function applyResult(res) {
    if (!res) return;
    switch (res.kind) {
      case 'hit':
        renderWord(false); renderMisses(); sfx.ding(); persist();
        break;
      case 'miss':
        renderMisses(); renderParts(); sfx.thud(); persist();
        break;
      case 'dup':
        wordEl.classList.remove('shake');
        void wordEl.offsetWidth;
        wordEl.classList.add('shake');
        toast('already tried ' + res.letter);
        break;
      case 'solve-miss':
        renderMisses(); renderParts(); sfx.thud(); toast('not the word'); persist();
        break;
      case 'win':
        finishGame(true);
        break;
      case 'solve-win':
        finishGame(true);
        break;
      case 'lose':
        finishGame(false);
        break;
    }
  }

  function feedChat(text) {
    if (!game || game.status !== 'playing') return;
    var parsed = Core.parseChat(text, game);
    if (!parsed) return;
    if (parsed.type === 'letter') applyResult(Core.guessLetter(game, parsed.letter));
    else applyResult(Core.guessWord(game, parsed.word));
  }

  // ── start gating ────────────────────────────────────────────────────
  function gateOk(role) {
    if (role.isB || role.isM) return true;
    if (cfg.who === 'everyone') return true;
    if (cfg.who === 'subs') return role.isS || role.isV;
    if (cfg.who === 'vips') return role.isV;
    return false; // mods only
  }

  function tryStart(player, role, source, pfp) {
    if (game && game.status === 'playing') {
      toast(player.name + ' wants in, but a game is live');
      return;
    }
    var now = Date.now();
    if (now < cooldownUntil && !(role && role.isB)) {
      toast('hangman is on cooldown, ' + Math.ceil((cooldownUntil - now) / 1000) + 's');
      return;
    }
    if (source === 'command' && !gateOk(role || {})) {
      toast(player.name + ' cannot start games (' + cfg.who + ' only)');
      return;
    }
    startGame(player, { pfp: pfp });
  }

  // ── Streamer.bot events ─────────────────────────────────────────────
  function onChat(data) {
    var m = data && typeof data.message === 'object' ? data.message : (data || {});
    var text = typeof m.message === 'string' ? m.message : '';
    if (!text) return;
    var uid = m.userId != null ? String(m.userId) : (m.user && m.user.id != null ? String(m.user.id) : '');
    var login = (m.username || (m.user && m.user.login) || '').toLowerCase();
    var name = m.displayName || (m.user && m.user.name) || login || 'someone';
    var roleN = Number(m.role || 0);
    var role = {
      isB: roleN === 4 || !!m.isBroadcaster,
      isM: roleN >= 3 || !!m.isModerator,
      isV: roleN === 2 || !!m.isVip,
      isS: !!(m.subscriber || m.isSubscribed)
    };
    var player = { id: uid, login: login, name: name };

    // start command
    if (cfg.cmd) {
      var t = text.trim().toLowerCase();
      if (t === cfg.cmd.toLowerCase() || t.indexOf(cfg.cmd.toLowerCase() + ' ') === 0) {
        tryStart(player, role, 'command', null);
        return;
      }
    }
    // guesses: only the player who owns the game
    if (game && game.status === 'playing' && uid && uid === game.player.id) feedChat(text);
  }

  function onReward(data) {
    if (!cfg.reward) return;
    var d = data || {};
    var u = d.user || {};
    var title = (d.reward && (d.reward.title || d.reward.name)) || d.title || '';
    if (String(title).toLowerCase().indexOf(cfg.reward.toLowerCase()) < 0) return;
    var player = {
      id: u.id != null ? String(u.id) : (d.user_id != null ? String(d.user_id) : ''),
      login: (u.login || d.user_login || u.name || d.user_name || '').toLowerCase(),
      name: u.display_name || u.name || d.user_name || d.user_login || 'someone'
    };
    if (!player.id && !player.login) return;
    tryStart(player, { isB: false, isM: false, isV: false, isS: true }, 'reward', null);
  }

  // ── Streamer.bot websocket ──────────────────────────────────────────
  var ws = null, sbBackoff = 1000, subscribed = false, doSeq = 0, actionsChecked = false;

  function connectSB() {
    subscribed = false;
    setStatus('connecting to Streamer.bot', '', 0);
    try { ws = new WebSocket('ws://' + cfg.sbHost + ':' + cfg.sbPort + '/'); }
    catch (e) { return retry(); }
    ws.onopen = function () {
      sbBackoff = 1000;
      setTimeout(function () { if (ws && ws.readyState === 1) subscribe(); }, 1200);
    };
    ws.onmessage = function (e) {
      var d; try { d = JSON.parse(e.data); } catch (x) { return; }
      if (d.request === 'Hello' || (d.event === undefined && d.authentication)) {
        if (d.authentication && cfg.sbPass) sbAuth(d.authentication, subscribe);
        else subscribe();
        return;
      }
      if (d.status === 'ok' && d.id === 'hm-sub') {
        setStatus('Streamer.bot connected', 'ok', 3500);
        if (!actionsChecked) checkActions();
        return;
      }
      if (d.id === 'hm-actions') { onActionsList(d); return; }
      if (d.event && d.event.source && String(d.event.source).toLowerCase() === 'twitch') {
        var type = String(d.event.type || '').toLowerCase();
        if (type === 'chatmessage' || type === 'message') onChat(d.data);
        else if (type === 'rewardredemption' || type === 'channelpointreward' || type === 'redemption') onReward(d.data);
      }
    };
    ws.onclose = function () { setStatus('Streamer.bot reconnecting', 'warn', 0); retry(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function retry() {
    setTimeout(connectSB, sbBackoff);
    sbBackoff = Math.min(sbBackoff * 1.8, 20000);
  }
  function subscribe() {
    if (subscribed || !ws || ws.readyState !== 1) return;
    subscribed = true;
    try {
      ws.send(JSON.stringify({ request: 'Subscribe', id: 'hm-sub', events: { Twitch: ['*'] } }));
    } catch (e) {}
  }
  function sbAuth(auth, done) {
    var enc = new TextEncoder();
    function h(s) {
      return crypto.subtle.digest('SHA-256', enc.encode(s)).then(function (buf) {
        return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
      });
    }
    h(cfg.sbPass + auth.salt).then(function (h1) { return h(h1 + auth.challenge); })
      .then(function (hash) {
        try { ws.send(JSON.stringify({ request: 'Authenticate', id: 'hm-auth', authentication: hash })); } catch (e) {}
        setTimeout(done, 150);
      })
      .catch(done);
  }
  function sbDo(actionName, args) {
    if (cfg.demo || !ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({
        request: 'DoAction',
        id: 'hm-do-' + (++doSeq),
        action: { name: actionName },
        args: args || {}
      }));
    } catch (e) {}
  }
  function sbSay(message) {
    sbDo(cfg.actSay, { message: message });
  }
  function checkActions() {
    if (!ws || ws.readyState !== 1) return;
    if (cfg.to <= 0 && !sayFams.length) { actionsChecked = true; return; }
    try { ws.send(JSON.stringify({ request: 'GetActions', id: 'hm-actions' })); } catch (e) {}
  }
  function onActionsList(d) {
    actionsChecked = true;
    var names = [];
    try { names = (d.actions || []).map(function (a) { return a.name; }); } catch (e) { return; }
    if (!names.length) return;
    var missing = [];
    if (cfg.to > 0 && names.indexOf(cfg.actTimeout) < 0) missing.push('timeouts');
    if (sayFams.length && names.indexOf(cfg.actSay) < 0) missing.push('chat replies');
    if (missing.length) {
      setStatus('import the Hangman actions for ' + missing.join(' + ') + ' (aquilo.gg/hangman)', 'warn', 12000);
    }
  }

  // ── ticker ──────────────────────────────────────────────────────────
  var lastTickSecond = -1;
  setInterval(function () {
    if (!game || game.status !== 'playing') return;
    var now = Date.now();
    renderTimer(now);
    var s = Math.ceil(Math.max(0, game.endsAt - now) / 1000);
    if (s <= 10 && s > 0 && s !== lastTickSecond) { lastTickSecond = s; sfx.tick(); }
    var e = Core.expire(game, now);
    if (e) applyResult(e);
  }, 250);

  // ── demo mode ───────────────────────────────────────────────────────
  var demoSeedN = 1337;
  function demoRand() {
    demoSeedN = (demoSeedN * 1664525 + 1013904223) >>> 0;
    return demoSeedN / 4294967296;
  }
  var DEMO_PLAYERS = [
    { name: 'NovaByte', login: '', img: 12 },
    { name: 'Quietfawn', login: '', img: 32 },
    { name: 'duskrunner', login: '', img: 59 },
    { name: 'PixelPyre', login: '', img: 25 },
    { name: 'Kestrel77', login: '', img: 47 }
  ];
  var demoN = 0, demoTimer = 0, demoStepTimer = 0;
  function demoStart() {
    if (game && game.status === 'playing') return;
    var p = DEMO_PLAYERS[demoN % DEMO_PLAYERS.length];
    var wantWin = demoN % 2 === 0;
    demoN++;
    var player = { id: 'demo', login: '', name: p.name };
    if (!startGame(player, { test: true })) return;
    applyAvatar('https://i.pravatar.cc/100?img=' + p.img, player);
    // plan the letters: word letters shuffled, misses sprinkled in
    var uniq = [];
    game.word.split('').forEach(function (c) {
      if (c >= 'A' && c <= 'Z' && uniq.indexOf(c) < 0) uniq.push(c);
    });
    var decoys = 'QXZJKWVFYPB'.split('').filter(function (c) { return game.word.indexOf(c) < 0; });
    var plan = [];
    if (wantWin) {
      plan = uniq.slice();
      plan.splice(1, 0, decoys[0]);
      plan.splice(4, 0, decoys[1]);
    } else {
      plan = decoys.slice(0, 6);
      plan.splice(1, 0, uniq[0]);
      plan.splice(3, 0, uniq[1] || uniq[0]);
    }
    var i = 0;
    var step = function () {
      if (!game || game.status !== 'playing') { demoTimer = setTimeout(demoStart, 5200); return; }
      if (i >= plan.length) { applyResult(Core.guessWord(game, game.word)); demoTimer = setTimeout(demoStart, 5200); return; }
      applyResult(Core.guessLetter(game, plan[i++]));
      if (game && game.status === 'playing') demoStepTimer = setTimeout(step, 1100 + demoRand() * 900);
      else demoTimer = setTimeout(demoStart, 5200);
    };
    demoStepTimer = setTimeout(step, 1400);
  }

  // ── customizer bridge + OBS Interact keys ───────────────────────────
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || typeof d !== 'object' || !d.hm) return;
    clearTimeout(demoTimer); clearTimeout(demoStepTimer);
    var unrevealed = function () {
      if (!game) return null;
      for (var i = 0; i < game.word.length; i++) {
        var c = game.word.charAt(i);
        if (c >= 'A' && c <= 'Z' && game.hits.indexOf(c) < 0) return c;
      }
      return null;
    };
    var unusedMiss = function () {
      if (!game) return null;
      var pool = 'QXZJKWVFYPBM'.split('');
      for (var i = 0; i < pool.length; i++) {
        if (game.word.indexOf(pool[i]) < 0 && game.wrong.indexOf(pool[i]) < 0) return pool[i];
      }
      return null;
    };
    switch (d.hm) {
      case 'start': {
        cancelGame(true);
        var p = DEMO_PLAYERS[demoN % DEMO_PLAYERS.length]; demoN++;
        var player = { id: 'demo', login: '', name: p.name };
        if (startGame(player, { word: d.word ? Core.normalizeWord(d.word) : null, test: true })) {
          applyAvatar('https://i.pravatar.cc/100?img=' + p.img, player);
        }
        break;
      }
      case 'hit': { var L = unrevealed(); if (L && game.status === 'playing') applyResult(Core.guessLetter(game, L)); break; }
      case 'miss': { var M = unusedMiss(); if (M && game.status === 'playing') applyResult(Core.guessLetter(game, M)); break; }
      case 'solve': if (game && game.status === 'playing') applyResult(Core.guessWord(game, game.word)); break;
      case 'fail': {
        if (!game || game.status !== 'playing') break;
        while (game.status === 'playing') {
          var X = unusedMiss();
          if (!X) { game.solveMisses = game.lives; applyResult({ kind: 'lose', reason: 'letters' }); break; }
          applyResult(Core.guessLetter(game, X));
        }
        break;
      }
      case 'cancel': cancelGame(); break;
    }
    if (cfg.demo && (!game || game.status !== 'playing')) demoTimer = setTimeout(demoStart, 6000);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 't' || e.key === 'T') {
      if (!game || game.status !== 'playing') {
        startGame({ id: 'test', login: '', name: 'Test Run' }, { test: true });
      }
    } else if (e.key === 'x' || e.key === 'X') {
      cancelGame();
    }
  });

  // ── boot ────────────────────────────────────────────────────────────
  card.dataset.state = 'idle';
  if (cfg.demo) {
    $('demoBadge').hidden = false;
    demoTimer = setTimeout(demoStart, 700);
  } else {
    restore();
    connectSB();
  }

  // Customizer "Send test to OBS" ping (placement check on the live
  // source): one-shot test vignette, never interrupts a real game and
  // never fires SB actions (test:true games are inert by design).
  if (window.AquiloTest) {
    window.AquiloTest.onTest(function () {
      if (cfg.demo) return;
      if (game && game.status === 'playing' && !game.test) return;
      cancelGame(true);
      var p = DEMO_PLAYERS[demoN % DEMO_PLAYERS.length]; demoN++;
      var player = { id: 'demo', login: '', name: p.name };
      if (!startGame(player, { test: true })) return;
      applyAvatar('https://i.pravatar.cc/100?img=' + p.img, player);
      var hit = function () {
        if (!game || game.status !== 'playing') return;
        for (var i = 0; i < game.word.length; i++) {
          var c = game.word.charAt(i);
          if (c >= 'A' && c <= 'Z' && game.hits.indexOf(c) < 0) { applyResult(Core.guessLetter(game, c)); return; }
        }
      };
      setTimeout(hit, 1600);
      setTimeout(hit, 3200);
      setTimeout(function () {
        if (game && game.test && game.status === 'playing') applyResult(Core.guessWord(game, game.word));
      }, 4800);
    });
  }
})();
