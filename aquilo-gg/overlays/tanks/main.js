/*
 * aquilo.gg Tank Battle overlay.
 *
 * Chat-played artillery: a channel point redemption opens the lobby,
 * viewers grab seats with !join, then take turns firing with
 * !shoot <angle 0-180> [power 10-100]. Real projectile physics with
 * per-turn wind, pixel-destructible terrain (canvas + solid mask),
 * knockback, fall damage, sudden death, last tank standing wins.
 *
 * Inputs arrive straight from Streamer.bot's WebSocket (Twitch chat +
 * RewardRedemption, plus YouTube/Kick chat if connected) and from
 * TikFinity's local WebSocket (TikTok chat). No middleware.
 *
 * Debug/test hooks (DevTools console, or driven by the selftest):
 *   TB.redeem('Clay')                   open the lobby as Clay
 *   TB.chat('bob', '!join')             fake a chat line
 *   TB.chat('bob', '!shoot 60 80')
 *   TB.snap()                           game state snapshot
 *   TB.end()                            force-end the battle
 */
(() => {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // CONFIG
  // ──────────────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const num  = (k, d) => { const v = parseFloat(params.get(k)); return Number.isFinite(v) ? v : d; };
  const flag = (k, d) => { const v = params.get(k); if (v == null) return d; return !(v === '0' || v === 'false' || v === 'off'); };
  const pick = (k, d, list) => { const v = (params.get(k) || '').toLowerCase(); return list.indexOf(v) >= 0 ? v : d; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const cfg = {
    sbHost:    params.get('sbHost') || '127.0.0.1',
    sbPort:    num('sbPort', 8080),
    sbPass:    params.get('sbPass') || '',
    useTF:     flag('tf', true),
    tfPort:    num('tfPort', 21213),
    reward:    (params.get('reward') || '').trim(),
    lobbySecs: clamp(num('lobby', 60), 5, 600),
    turnSecs:  clamp(num('turn', 45), 8, 300),
    maxPlayers: clamp(Math.round(num('players', 4)), 2, 4),
    hp:        clamp(Math.round(num('hp', 100)), 20, 999),
    windMax:   clamp(num('wind', 28), 0, 100),
    cpuFill:   flag('cpu', true),
    theme:     pick('theme', 'grass', ['grass', 'desert', 'snow', 'void']),
    vol:       clamp(num('vol', 55), 0, 100),
    announce:  flag('announce', false),
    demo:      flag('demo', false),
    test:      flag('test', false),
    sky:       flag('sky', flag('demo', false)),
    dot:       flag('dot', true),
    hint:      flag('hint', true)
  };
  // OBS / Streamlabs browser sources identify themselves in the UA. The
  // idle hint card only ever shows in a real browser tab, so the overlay
  // stays perfectly invisible between battles on stream.
  const IN_OBS = /OBS|Streamlabs|SLOBS/i.test(navigator.userAgent);
  if (cfg.demo && params.get('lobby') == null) cfg.lobbySecs = 7;

  // ──────────────────────────────────────────────────────────────────
  // CONSTANTS + UTILS
  // ──────────────────────────────────────────────────────────────────
  const W = 1920, H = 1080;          // fixed sim space, CSS scales it
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const G = 540;                     // gravity px/s^2
  const BEDROCK = 10;                // indestructible bottom rows
  const SHELL_R = 46;                // crater radius
  const MAX_DMG = 55;                // direct hit damage (pre multiplier)
  const SUDDEN_ROUND = 9;            // round when sudden death starts

  const COLORS = [
    { main: '#2de2c5', dark: '#0d8f7c', glow: 'rgba(45,226,197,.5)'  },
    { main: '#ff5ca8', dark: '#b1216a', glow: 'rgba(255,92,168,.5)'  },
    { main: '#ffb02e', dark: '#b26f0e', glow: 'rgba(255,176,46,.5)'  },
    { main: '#9d7bff', dark: '#5b36c9', glow: 'rgba(157,123,255,.5)' }
  ];
  const THEMES = {
    grass:  { dirtTop: '#6b4a2e', dirtBot: '#332012', cap: '#54c14e', capHi: '#8fe06a', bedrock: '#1b1410', chunk: ['#6b4a2e', '#4a3220', '#54c14e'] },
    desert: { dirtTop: '#cda35f', dirtBot: '#7a5a2c', cap: '#e9cd86', capHi: '#f7e3ad', bedrock: '#4a3a1d', chunk: ['#cda35f', '#a37c3f', '#e9cd86'] },
    snow:   { dirtTop: '#aebed2', dirtBot: '#5d6f8a', cap: '#ffffff', capHi: '#ffffff', bedrock: '#3a4456', chunk: ['#dfe8f2', '#aebed2', '#ffffff'] },
    void:   { dirtTop: '#3b2f6e', dirtBot: '#171228', cap: '#2de2c5', capHi: '#9af3e3', bedrock: '#0d0a18', chunk: ['#3b2f6e', '#272050', '#2de2c5'] }
  };
  const TH = THEMES[cfg.theme];
  const CPU_NAMES = ['RUSTY', 'VOLT', 'SPROCKET', 'PISTON'];

  const rand  = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.round(rand(a, b));
  const lerp  = (a, b, t) => a + (b - a) * t;
  const dist  = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
  const esc   = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowMs = () => performance.now();
  const capName = (s) => { s = String(s || 'viewer'); return s.length > 14 ? s.slice(0, 13) + '…' : s; };

  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ──────────────────────────────────────────────────────────────────
  // DOM
  // ──────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const elHud = $('hud'), elBanner = $('banner'), elBMain = $('bannerMain'), elBSub = $('bannerSub');
  const elTurnBar = $('turnBar'), elTurnWrap = $('turnBarWrap');
  const elWindChip = $('windChip'), elWindArrow = $('windArrow'), elWindText = $('windText');
  const elLobby = $('lobby'), elSlots = $('slots'), elLobbySub = $('lobbySub'), elLobbyFoot = $('lobbyFoot');
  const elRing = $('lobbyRingFill'), elCount = $('lobbyCount');
  const elVic = $('victory'), elVicName = $('vicName'), elVicSub = $('vicSub'), elVicLabel = $('vicLabel'), elVicCrown = $('vicCrown');
  const elToast = $('toast'), elStatus = $('statusDot'), elStatusText = $('statusText');
  const elIdleCard = $('idleCard'), elIdleConn = $('idleConn');
  if (cfg.demo) $('demoBadge').hidden = false;
  if (cfg.test) $('testBadge').hidden = false;

  let toastTimer = 0;
  function toast(html) {
    elToast.innerHTML = html;
    elToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elToast.classList.remove('show'), 3400);
  }
  function setBanner(main, sub, danger) {
    elBMain.innerHTML = main || '';
    elBSub.innerHTML = sub || '';
    elBSub.style.display = sub ? '' : 'none';
    elBanner.classList.toggle('danger', !!danger);
    elBanner.classList.remove('pulse');
    void elBanner.offsetWidth;
    elBanner.classList.add('pulse');
  }

  // Platform icons (simpleicons CDN, same source as the rest of the
  // overlay family). Drawn onto the canvas nameplates.
  const ICONS = {};
  [['tw', 'twitch'], ['yt', 'youtube'], ['kk', 'kick'], ['tt', 'tiktok']].forEach(([k, slug]) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = (window.PlatformIcons && window.PlatformIcons.iconUrl(slug)) || ('https://cdn.simpleicons.org/' + slug + '/ffffff');
    img.onload = () => { ICONS[k] = img; };
  });

  // ──────────────────────────────────────────────────────────────────
  // AUDIO (tiny WebAudio synth, no assets)
  // ──────────────────────────────────────────────────────────────────
  const AU = (() => {
    let ctx = null, master = null;
    function ensure() {
      if (cfg.vol <= 0) return null;
      if (!ctx) {
        try {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          master = ctx.createGain();
          master.gain.value = (cfg.vol / 100) * 0.55;
          master.connect(ctx.destination);
        } catch (e) { ctx = null; }
      }
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    window.addEventListener('click', ensure, { once: true });
    function tone(freq, dur, type, vol, slideTo, delay) {
      const c = ensure(); if (!c) return;
      const t0 = c.currentTime + (delay || 0);
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }
    function noise(dur, vol, fromHz, toHz) {
      const c = ensure(); if (!c) return;
      const t0 = c.currentTime;
      const len = Math.max(1, (dur * c.sampleRate) | 0);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(fromHz || 1000, t0);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, toHz || fromHz || 1000), t0 + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + dur + 0.05);
    }
    return {
      ensure,
      fire()      { noise(0.14, 0.5, 1500, 300); tone(150, 0.2, 'triangle', 0.5, 55); },
      boom(big)   { noise(big ? 0.95 : 0.6, big ? 0.95 : 0.72, 1100, 70); tone(60, big ? 0.65 : 0.45, 'sine', 0.85, 36); },
      pop()       { tone(540, 0.07, 'triangle', 0.32, 860); tone(860, 0.09, 'triangle', 0.22, 1080, 0.06); },
      tick()      { tone(1180, 0.045, 'square', 0.1); },
      dud()       { tone(220, 0.18, 'sawtooth', 0.2, 110); },
      sting()     { tone(196, 0.3, 'sawtooth', 0.4, 98); tone(98, 0.5, 'sawtooth', 0.4, 49, 0.18); },
      fanfare()   { [523, 659, 784, 1047].forEach((f, i) => { tone(f, 0.38, 'triangle', 0.4, null, i * 0.13); tone(f / 2, 0.38, 'sine', 0.25, null, i * 0.13); }); }
    };
  })();

  // ──────────────────────────────────────────────────────────────────
  // CANVAS + TERRAIN
  // ──────────────────────────────────────────────────────────────────
  const cv = $('game');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');

  const T = document.createElement('canvas');
  T.width = W; T.height = H;
  const Tx = T.getContext('2d');

  const mask = new Uint8Array(W * H);
  let carveCount = 0;

  const solidAt = (x, y) => {
    x |= 0; y |= 0;
    if (x < 0 || x >= W || y < 0) return false;
    if (y >= H - BEDROCK) return true;
    return mask[y * W + x] === 1;
  };
  function surfaceTopAt(x) {
    x = clamp(x | 0, 0, W - 1);
    for (let y = 0; y < H; y++) if (solidAt(x, y)) return y;
    return H - BEDROCK;
  }

  function genTerrain() {
    const hm = new Float32Array(W);
    let h = H * rand(0.58, 0.70), slope = 0;
    const layers = [];
    for (let i = 0; i < 3; i++) layers.push({ amp: rand(30, 90), wl: rand(300, 820), ph: rand(0, TAU) });
    for (let x = 0; x < W; x++) {
      slope += rand(-0.16, 0.16);
      slope *= 0.985;
      slope = clamp(slope, -1.25, 1.25);
      h += slope;
      if (h < H * 0.42) { h = H * 0.42; slope = Math.abs(slope) * 0.4; }
      if (h > H * 0.86) { h = H * 0.86; slope = -Math.abs(slope) * 0.4; }
      let y = h;
      for (const L of layers) y += Math.sin(x / L.wl * TAU + L.ph) * L.amp * 0.22;
      hm[x] = clamp(y, H * 0.34, H * 0.9);
    }
    // two smoothing passes so tanks sit nicely
    for (let pass = 0; pass < 2; pass++) {
      const cp = hm.slice();
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let k = -6; k <= 6; k++) { const xx = clamp(x + k, 0, W - 1); s += cp[xx]; n++; }
        hm[x] = s / n;
      }
    }
    // mask
    mask.fill(0);
    for (let x = 0; x < W; x++) {
      const top = clamp(hm[x] | 0, 0, H - 1);
      for (let y = top; y < H; y++) mask[y * W + x] = 1;
    }
    // paint
    Tx.clearRect(0, 0, W, H);
    const grad = Tx.createLinearGradient(0, H * 0.34, 0, H);
    grad.addColorStop(0, TH.dirtTop);
    grad.addColorStop(1, TH.dirtBot);
    Tx.fillStyle = grad;
    Tx.beginPath();
    Tx.moveTo(-4, H + 4);
    for (let x = 0; x < W; x += 3) Tx.lineTo(x, hm[x]);
    Tx.lineTo(W + 4, hm[W - 1]);
    Tx.lineTo(W + 4, H + 4);
    Tx.closePath();
    Tx.fill();
    // strata speckle, clipped to the dirt
    Tx.save();
    Tx.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 1100; i++) {
      const x = rand(0, W), y = rand(H * 0.4, H);
      Tx.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,.10)' : 'rgba(255,255,255,.05)';
      Tx.fillRect(x, y, rand(2, 9), rand(1.5, 3.5));
    }
    Tx.restore();
    // grass cap
    Tx.lineJoin = 'round';
    Tx.lineCap = 'round';
    Tx.strokeStyle = TH.cap;
    Tx.lineWidth = 9;
    Tx.beginPath();
    for (let x = 0; x <= W; x += 3) { const y = hm[clamp(x, 0, W - 1)]; x === 0 ? Tx.moveTo(x, y) : Tx.lineTo(x, y); }
    Tx.stroke();
    Tx.strokeStyle = TH.capHi;
    Tx.lineWidth = 3;
    Tx.beginPath();
    for (let x = 0; x <= W; x += 3) { const y = hm[clamp(x, 0, W - 1)] - 3; x === 0 ? Tx.moveTo(x, y) : Tx.lineTo(x, y); }
    Tx.stroke();
    // bedrock strip
    Tx.fillStyle = TH.bedrock;
    Tx.fillRect(0, H - BEDROCK, W, BEDROCK);
    carveCount = 0;
  }

  function carve(ex, ey, r) {
    Tx.save();
    Tx.beginPath();
    Tx.rect(0, 0, W, H - BEDROCK);            // bedrock is indestructible
    Tx.clip();
    Tx.globalCompositeOperation = 'destination-out';
    Tx.beginPath(); Tx.arc(ex, ey, r, 0, TAU); Tx.fill();
    Tx.restore();
    // scorch the crater rim (only where dirt remains)
    Tx.save();
    Tx.globalCompositeOperation = 'source-atop';
    const g = Tx.createRadialGradient(ex, ey, r * 0.5, ex, ey, r * 1.45);
    g.addColorStop(0, 'rgba(16,10,7,.8)');
    g.addColorStop(1, 'rgba(16,10,7,0)');
    Tx.fillStyle = g;
    Tx.beginPath(); Tx.arc(ex, ey, r * 1.5, 0, TAU); Tx.fill();
    Tx.restore();
    const x0 = Math.max(0, (ex - r) | 0), x1 = Math.min(W - 1, (ex + r) | 0);
    const y0 = Math.max(0, (ey - r) | 0), y1 = Math.min(H - 1 - BEDROCK, (ey + r) | 0);
    const r2 = r * r;
    for (let yy = y0; yy <= y1; yy++) {
      const dy = yy - ey, row = yy * W;
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx - ex;
        if (dx * dx + dy * dy <= r2) mask[row + xx] = 0;
      }
    }
    carveCount++;
  }

  // ──────────────────────────────────────────────────────────────────
  // GAME STATE
  // ──────────────────────────────────────────────────────────────────
  let players = [];                 // tank objects, join order
  let wrecks = [];                  // dead husks
  let particles = [];               // dirt/spark/smoke/confetti
  let rings = [];                   // explosion shockwave rings
  let floaters = [];                // damage numbers
  let projectile = null;
  let deathQueue = [];              // tanks waiting for their death boom

  const st = {
    phase: 'idle',                  // idle lobby starting aim windup flight settle between victory cancel
    deadline: 0,                    // ms timestamp for the current phase
    turn: -1, round: 1, wind: 0,
    sudden: false, dmgMult: 1,
    shot: null,                     // {angle, power}
    windupAt: 0, cpuAt: 0,
    settleClear: 0, lastTickSec: -1,
    fade: 0, fadeT: 0,
    shake: 0,
    slotX: [], activator: null,
    winner: null, result: '',
    demoNext: cfg.demo ? nowMs() + 1200 : 0,
    demoJoins: []
  };
  const cur = () => players[st.turn] || null;

  // ──────────────────────────────────────────────────────────────────
  // EFFECTS
  // ──────────────────────────────────────────────────────────────────
  function burst(x, y, big) {
    const n = big ? 34 : 26;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), sp = rand(60, big ? 520 : 420);
      particles.push({ type: 'dirt', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(80, 260), g: 760, age: 0, life: rand(0.7, 1.5), size: rand(2.5, 6.5), color: TH.chunk[randi(0, TH.chunk.length - 1)], rot: rand(0, TAU), vr: rand(-7, 7) });
    }
    for (let i = 0; i < 16; i++) {
      const a = rand(0, TAU), sp = rand(120, 640);
      particles.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 240, age: 0, life: rand(0.18, 0.45), size: rand(1.5, 3), color: Math.random() < 0.5 ? '#ffd27d' : '#ff9b4a' });
    }
    for (let i = 0; i < (big ? 10 : 7); i++) {
      particles.push({ type: 'smoke', x: x + rand(-14, 14), y: y + rand(-10, 6), vx: rand(-26, 26), vy: rand(-70, -20), g: 0, age: 0, life: rand(0.9, 1.9), size: rand(9, 18), color: 'rgba(60,58,55,' });
    }
    rings.push({ x, y, r: 6, vr: big ? 720 : 560, age: 0, life: 0.42 });
  }
  function muzzleFx(x, y, dx, dy) {
    for (let i = 0; i < 8; i++) {
      const sp = rand(140, 320), j = rand(-0.35, 0.35);
      const ca = Math.cos(j), sa = Math.sin(j);
      particles.push({ type: 'spark', x, y, vx: (dx * ca - dy * sa) * sp, vy: (dx * sa + dy * ca) * sp, g: 300, age: 0, life: rand(0.12, 0.3), size: rand(1.5, 2.6), color: '#ffe1a0' });
    }
    rings.push({ x, y, r: 2, vr: 260, age: 0, life: 0.18 });
  }
  function poofFx(x, y) {
    for (let i = 0; i < 14; i++) particles.push({ type: 'smoke', x: x + rand(-12, 12), y: y - rand(0, 26), vx: rand(-40, 40), vy: rand(-60, -10), g: 0, age: 0, life: rand(0.5, 1.1), size: rand(7, 13), color: 'rgba(150,150,160,' });
  }
  function dustFx(x, y) {
    for (let i = 0; i < 8; i++) particles.push({ type: 'dirt', x: x + rand(-12, 12), y, vx: rand(-90, 90), vy: rand(-150, -40), g: 700, age: 0, life: rand(0.4, 0.8), size: rand(1.8, 3.6), color: TH.chunk[randi(0, TH.chunk.length - 1)], rot: 0, vr: rand(-5, 5) });
  }
  function confettiFx() {
    const cols = ['#2de2c5', '#ff5ca8', '#ffb02e', '#9d7bff', '#ffffff'];
    for (let i = 0; i < 9; i++) particles.push({ type: 'confetti', x: rand(W * 0.15, W * 0.85), y: -12, vx: rand(-40, 40), vy: rand(30, 110), g: 150, age: 0, life: rand(2.2, 3.6), size: rand(4, 8), color: cols[randi(0, cols.length - 1)], rot: rand(0, TAU), vr: rand(-9, 9), seed: rand(0, TAU) });
  }
  function floater(x, y, text, color, big) {
    floaters.push({ x, y, text, color, age: 0, life: 1.15, size: big ? 30 : 22 });
  }

  // ──────────────────────────────────────────────────────────────────
  // LOBBY + MATCH FLOW
  // ──────────────────────────────────────────────────────────────────
  function slotPositions(n) {
    const m = 230, span = (W - 2 * m) / (n - 1);
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(clamp(m + span * i + rand(-55, 55), 60, W - 60));
    for (let i = xs.length - 1; i > 0; i--) { const j = randi(0, i); const t = xs[i]; xs[i] = xs[j]; xs[j] = t; }
    return xs;
  }

  function openLobby(env) {
    if (st.phase !== 'idle') { toast('<b>' + esc(env.name) + '</b> a battle is already running'); return false; }
    genTerrain();
    players = []; wrecks = []; particles = []; rings = []; floaters = []; deathQueue = [];
    projectile = null;
    st.phase = 'lobby';
    st.turn = -1; st.round = 1; st.sudden = false; st.dmgMult = 1;
    st.winner = null; st.fadeT = 1; st.lastTickSec = -1;
    st.activator = env;
    st.slotX = slotPositions(cfg.maxPlayers);
    st.deadline = nowMs() + cfg.lobbySecs * 1000;
    elLobbySub.innerHTML = 'redeemed by <b>' + esc(env.name) + '</b>';
    elLobbyFoot.innerHTML = 'type <b>!join</b> to enter · battle starts when full';
    elHud.classList.remove('show');
    elLobby.classList.add('show');
    refreshIdleCard();
    addPlayer(env, false);
    AU.pop();
    say('TANK BATTLE is live! Type !join to grab a seat (' + (cfg.maxPlayers - 1) + ' open)');
    return true;
  }

  function addPlayer(env, isCpu) {
    if (st.phase !== 'lobby') return false;
    if (players.length >= cfg.maxPlayers) return false;
    if (players.some(p => p.key === env.key)) return false;
    const i = players.length;
    const x = st.slotX[i];
    players.push({
      key: env.key, name: capName(env.name), plat: env.plat, cpu: !!isCpu,
      col: COLORS[i], x, y: -50, vx: 0, vy: 130,
      hp: cfg.hp, alive: true, airborne: true, chute: true,
      fallFrom: -50, barrel: x < W / 2 ? 60 : 120, targetBarrel: x < W / 2 ? 60 : 120,
      skips: 0, flash: 0, tilt: 0
    });
    AU.pop();
    renderSlots(i);
    if (players.length >= cfg.maxPlayers) toStarting('ALL TANKS DEPLOYED', 'battle begins…', 2600);
    return true;
  }

  function addCpu() {
    const name = CPU_NAMES[randi(0, CPU_NAMES.length - 1)];
    return addPlayer({ key: 'cpu:' + name.toLowerCase() + ':' + players.length, name, plat: 'cpu' }, true);
  }

  function renderSlots(popIdx) {
    elSlots.innerHTML = '';
    for (let i = 0; i < cfg.maxPlayers; i++) {
      const p = players[i];
      const div = document.createElement('div');
      div.className = 'slot ' + (p ? 'filled' : 'empty') + (p && i === popIdx ? ' pop' : '');
      const numEl = document.createElement('div');
      numEl.className = 'pnum';
      numEl.style.background = p ? COLORS[i].main : 'rgba(255,255,255,.13)';
      numEl.textContent = 'P' + (i + 1);
      div.appendChild(numEl);
      const nameEl = document.createElement('div');
      nameEl.className = 'pname';
      nameEl.textContent = p ? p.name : 'type !join';
      div.appendChild(nameEl);
      if (p) {
        if (p.cpu) {
          const tag = document.createElement('span');
          tag.className = 'cpuTag';
          tag.textContent = 'CPU';
          div.appendChild(tag);
        } else if (ICONS[p.plat]) {
          const ic = document.createElement('img');
          ic.className = 'picon';
          ic.src = ICONS[p.plat].src;
          div.appendChild(ic);
        }
      }
      elSlots.appendChild(div);
    }
  }

  function toStarting(main, sub, ms) {
    st.phase = 'starting';
    st.deadline = nowMs() + (ms || 2200);
    elHud.classList.add('show');
    setBanner(main, sub);
  }

  function lobbyExpired() {
    if (players.length >= 2) {
      toStarting('HATCHES DOWN', players.length + ' tanks ready');
    } else if (cfg.cpuFill) {
      addCpu();
      toStarting('A CHALLENGER ROLLS IN', 'CPU joins the fight');
    } else {
      st.phase = 'cancel';
      st.deadline = nowMs() + 2600;
      elLobby.classList.remove('show');
      elHud.classList.add('show');
      setBanner('NOT ENOUGH TANKS', 'battle cancelled', true);
      AU.dud();
    }
  }

  function startMatch() {
    elLobby.classList.remove('show');
    elHud.classList.add('show');
    nextTurn();
  }

  function aliveTanks() { return players.filter(p => p.alive); }

  function nextTurn() {
    const alive = aliveTanks();
    if (alive.length <= 1) { endMatch(alive[0] || null); return; }
    let idx = st.turn;
    for (let i = 0; i < players.length; i++) {
      idx = (idx + 1) % players.length;
      if (players[idx].alive) break;
    }
    if (idx <= st.turn) {
      st.round++;
      if (st.round >= SUDDEN_ROUND && !st.sudden) {
        st.sudden = true;
        st.dmgMult = 2;
        AU.sting();
        toast('<b>SUDDEN DEATH</b> · double damage');
      }
    }
    st.turn = idx;
    st.wind = cfg.windMax > 0 ? Math.round(rand(-cfg.windMax, cfg.windMax)) : 0;
    updateWind();
    beginAim();
  }

  function beginAim() {
    const p = cur();
    st.phase = 'aim';
    st.deadline = nowMs() + cfg.turnSecs * 1000;
    st.lastTickSec = -1;
    st.shot = null;
    elTurnWrap.style.opacity = 1;
    const nm = '<span class="pname" style="color:' + p.col.main + '">' + esc(p.name) + '</span>';
    setBanner(nm + (st.sudden ? ' · SUDDEN DEATH' : "'S TURN"),
      p.cpu ? 'computing trajectory…' : 'type <b>!shoot 45</b> · with power: <b>!shoot 45 80</b>', st.sudden);
    if (p.cpu) st.cpuAt = nowMs() + rand(1400, 2900);
    else say('@' + p.name + ' you are up! !shoot <angle 0-180>, optional power: !shoot 60 85');
  }

  function handleShoot(p, angle, power) {
    if (st.phase !== 'aim' || !p || p !== cur() || !p.alive) return;
    angle = clamp(Math.round(angle), 0, 180);
    power = clamp(Math.round(power == null || isNaN(power) ? 70 : power), 10, 100);
    p.skips = 0;
    st.shot = { angle, power };
    p.targetBarrel = angle;
    st.phase = 'windup';
    st.windupAt = nowMs();
    elTurnWrap.style.opacity = 0;
    const nm = '<span class="pname" style="color:' + p.col.main + '">' + esc(p.name) + '</span>';
    setBanner(nm + ' FIRES', 'angle <b>' + angle + '°</b> · power <b>' + power + '</b>');
  }

  function spawnProjectile() {
    const p = cur(), s = st.shot;
    const rad = s.angle * DEG;
    const dx = Math.cos(rad), dy = -Math.sin(rad);
    const bx = p.x + dx * 34, by = p.y - 27 + dy * 34;
    const v = 240 + 9.2 * s.power;
    projectile = { x: bx, y: by, vx: dx * v, vy: dy * v, born: nowMs(), trail: [], cleared: false, shooter: p };
    muzzleFx(bx, by, dx, dy);
    st.shake = Math.max(st.shake, 5);
    AU.fire();
    st.phase = 'flight';
  }

  function explode(ex, ey, r, maxDmg, directTank) {
    carve(ex, ey, r);
    burst(ex, ey, r > 50);
    st.shake = Math.max(st.shake, r > 50 ? 22 : 15);
    AU.boom(r > 50);
    const dmgR = r * 1.65;
    let report = [];
    for (const t of players) {
      if (!t.alive) continue;
      const d = dist(ex, ey, t.x, t.y - 16);
      if (d > dmgR && t !== directTank) continue;
      let dmg = Math.round(Math.max(0, 1 - d / dmgR) * maxDmg * st.dmgMult);
      if (t === directTank) dmg = Math.round(maxDmg * st.dmgMult);
      if (dmg <= 0) continue;
      t.hp -= dmg;
      t.flash = 1;
      floater(t.x, t.y - 78, '-' + dmg, '#ff7d6e', dmg >= 40);
      report.push({ t, dmg });
      // knockback + unseat
      const ka = Math.atan2(t.y - 16 - ey, t.x - ex);
      const imp = Math.max(0, 1 - d / dmgR) * 260;
      t.vx += Math.cos(ka) * imp;
      t.vy -= Math.abs(Math.sin(ka)) * imp * 0.4 + imp * 0.35;
      if (!t.airborne) { t.airborne = true; t.fallFrom = t.y; }
      if (t.hp <= 0) {
        t.hp = 0;
        t.alive = false;
        deathQueue.push(t);
      }
    }
    return report;
  }

  function describeShot(report, lost) {
    if (lost) return 'the shell sails into the void';
    if (!report || !report.length) return 'crater made · nobody hurt';
    const big = report.reduce((a, b) => (b.dmg > a.dmg ? b : a));
    const self = big.t === cur();
    return (self ? 'self-inflicted!' : '<b>' + esc(big.t.name) + '</b> takes') + ' ' + big.dmg + ' damage' + (report.length > 1 ? ' (+' + (report.length - 1) + ' splashed)' : '');
  }

  function endMatch(winner) {
    st.phase = 'victory';
    st.deadline = nowMs() + 12000;
    st.winner = winner;
    elHud.classList.remove('show');
    elVicName.innerHTML = '';
    if (winner) {
      elVicCrown.textContent = '👑';
      elVicLabel.textContent = 'WINNER';
      const span = document.createElement('span');
      span.textContent = winner.name;
      span.style.color = winner.col.main;
      if (winner.cpu) span.textContent += ' (CPU)';
      else if (ICONS[winner.plat]) {
        const ic = document.createElement('img');
        ic.src = ICONS[winner.plat].src;
        elVicName.appendChild(ic);
      }
      elVicName.appendChild(span);
      elVicSub.textContent = 'last tank standing · gg';
      AU.fanfare();
      say('@' + winner.name + ' wins the TANK BATTLE! gg');
    } else {
      elVicCrown.textContent = '💥';
      elVicLabel.textContent = 'DRAW';
      const span = document.createElement('span');
      span.textContent = 'no survivors';
      elVicName.appendChild(span);
      elVicSub.textContent = 'mutually assured destruction';
      AU.boom(true);
    }
    elVic.classList.add('show');
  }

  function resetIdle() {
    st.phase = 'idle';
    st.fadeT = 0;
    elVic.classList.remove('show');
    elLobby.classList.remove('show');
    elHud.classList.remove('show');
    projectile = null;
    deathQueue = [];
    if (cfg.demo) st.demoNext = nowMs() + 5200;
    refreshIdleCard();
  }

  function forceEnd(byName) {
    if (st.phase === 'idle') return;
    toast('battle ended' + (byName ? ' by <b>' + esc(byName) + '</b>' : ''));
    resetIdle();
  }

  function forceStart() {
    if (st.phase !== 'lobby') return;
    if (players.length < 2 && cfg.cpuFill) addCpu();
    if (players.length < 2) { toast('need at least 2 tanks'); return; }
    if (st.phase === 'lobby') toStarting('HATCHES DOWN', players.length + ' tanks ready', 1800);
  }

  // ──────────────────────────────────────────────────────────────────
  // CPU GUNNER
  // ──────────────────────────────────────────────────────────────────
  function cpuFire(p) {
    const foes = players.filter(t => t.alive && t !== p);
    if (!foes.length) return;
    const t = foes.reduce((a, b) => (Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a));
    const d = Math.max(40, Math.abs(t.x - p.x));
    let power = randi(58, 96);
    let v = 240 + 9.2 * power;
    let s = d * G / (v * v);
    if (s > 0.98) { power = 100; v = 240 + 920; s = Math.min(0.98, d * G / (v * v)); }
    const lowArc = Math.asin(s) / 2;
    const arc = Math.random() < 0.74 ? (Math.PI / 2 - lowArc) : lowArc;   // prefer the mortar arc
    let aDeg = arc / DEG;
    // lead against the wind a touch, then wobble
    aDeg += (t.x > p.x ? -1 : 1) * st.wind * 0.06;
    let angle = t.x > p.x ? aDeg : 180 - aDeg;
    angle += rand(-6, 6);
    handleShoot(p, clamp(angle, 4, 176), power);
  }

  // ──────────────────────────────────────────────────────────────────
  // CHAT + REDEMPTION ROUTING
  // ──────────────────────────────────────────────────────────────────
  function rewardMatches(title) {
    const t = String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t) return false;
    if (cfg.reward) return t === cfg.reward.toLowerCase().replace(/\s+/g, ' ');
    return t.indexOf('tank') >= 0;
  }

  function onRedeem(env) {
    if (!rewardMatches(env.title)) return;
    AU.ensure();
    openLobby(env);
  }

  function onChat(env) {
    const text = String(env.text || '').trim();
    if (!text.startsWith('!')) return;
    const m = text.match(/^!(join|shoot|fire|tank)/i);
    if (!m) return;
    const cmdWord = m[1].toLowerCase();
    const rest = text.slice(m[0].length);

    if (cmdWord === 'join') {
      if (st.phase === 'lobby') {
        if (addPlayer(env, false)) say('@' + env.name + ' is in! seat ' + players.length + '/' + cfg.maxPlayers);
      }
      return;
    }

    if (cmdWord === 'shoot' || cmdWord === 'fire') {
      const p = players.find(q => q.key === env.key);
      if (!p) return;
      const nums = rest.match(/-?\d+/g);
      if (st.phase === 'aim' && p === cur()) {
        if (!nums) { toast('<b>' + esc(p.name) + '</b> add an angle: <b>!shoot 45</b>'); return; }
        handleShoot(p, parseInt(nums[0], 10), nums[1] != null ? parseInt(nums[1], 10) : null);
      }
      return;
    }

    if (cmdWord === 'tank') {
      const sub = rest.trim().toLowerCase().split(/\s+/)[0] || '';
      const privileged = env.role >= 3 || cfg.test;
      if (!privileged) return;
      if (sub === 'end' || sub === 'stop' || sub === 'cancel') forceEnd(env.name);
      else if (sub === 'start' || sub === 'go') forceStart();
      else if (sub === '' || sub === 'open' || sub === 'battle') { if (st.phase === 'idle') openLobby(env); }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // STREAMER.BOT (Twitch chat + channel points, YouTube/Kick chat)
  // ──────────────────────────────────────────────────────────────────
  let sbWS = null, sbConnected = false, sbBackoff = 1000;
  let sayN = 0;
  const pendingSay = {};

  function say(text) {
    if (!cfg.announce || !sbWS || sbWS.readyState !== 1) return;
    const id = 'tb-say-' + (++sayN);
    pendingSay[id] = text;
    try { sbWS.send(JSON.stringify({ request: 'TwitchSendMessage', id, message: text, bot: false })); } catch (e) {}
  }

  function sbAuth(ws, auth, done) {
    const enc = new TextEncoder();
    const h = (s) => crypto.subtle.digest('SHA-256', enc.encode(s)).then(buf =>
      btoa(String.fromCharCode.apply(null, new Uint8Array(buf))));
    h(cfg.sbPass + auth.salt)
      .then(h1 => h(h1 + auth.challenge))
      .then(hash => {
        try { ws.send(JSON.stringify({ request: 'Authenticate', id: 'tanks-auth', authentication: hash })); } catch (e) {}
        setTimeout(done, 150);
      })
      .catch(done);
  }

  function sbRoute(d) {
    if (!d || !d.event) return;
    const src = String(d.event.source || '').toLowerCase();
    const type = String(d.event.type || '').toLowerCase();
    const data = d.data || {};

    if (src === 'twitch' && (type === 'rewardredemption' || type === 'channelpointsused' || type === 'channelpointredemption')) {
      const r = data.reward || {};
      const u = data.user || {};
      const name = u.display_name || u.displayName || u.name || data.user_name || data.userName || data.displayName || 'viewer';
      const login = String(u.login || u.username || data.user_login || name).toLowerCase();
      onRedeem({ plat: 'tw', name, key: 'tw:' + login, title: r.title || r.name || data.rewardTitle || data.title || '' });
      return;
    }

    if (type !== 'chatmessage' && type !== 'message') return;
    const plat = src === 'twitch' ? 'tw' : src === 'youtube' ? 'yt' : src === 'kick' ? 'kk' : null;
    if (!plat) return;
    const u = data.user || {};
    const msg = data.message || {};
    const text = typeof msg === 'string' ? msg : (msg.message || msg.text || data.text || data.content || '');
    const name = u.displayName || u.display_name || u.name || msg.displayName || msg.username || u.login || u.username || 'viewer';
    const login = String(u.login || u.username || msg.username || name).toLowerCase();
    let role = Number(msg.role || data.role || u.role || 1) || 1;
    const badges = msg.badges || data.badges || [];
    if (Array.isArray(badges)) {
      for (const b of badges) {
        const bn = String((b && (b.name || b.type)) || b || '').toLowerCase();
        if (bn === 'broadcaster') role = 4;
        else if (bn === 'moderator' && role < 3) role = 3;
      }
    }
    onChat({ plat, name, key: plat + ':' + login, role, text: String(text) });
  }

  function connectSB() {
    let ws;
    try { ws = new WebSocket('ws://' + cfg.sbHost + ':' + cfg.sbPort + '/'); }
    catch (e) { setTimeout(connectSB, sbBackoff); sbBackoff = Math.min(sbBackoff * 1.8, 20000); return; }
    sbWS = ws;
    let subscribed = false;
    function subscribe() {
      if (subscribed) return;
      subscribed = true;
      try {
        ws.send(JSON.stringify({
          request: 'Subscribe', id: 'tanks-sub',
          events: {
            Twitch:  ['ChatMessage', 'RewardRedemption'],
            YouTube: ['Message'],
            Kick:    ['ChatMessage']
          }
        }));
      } catch (e) {}
    }
    ws.onopen = () => {
      sbBackoff = 1000;
      // older SB builds never send Hello; subscribe after a grace period
      setTimeout(() => { if (ws.readyState === 1) subscribe(); }, 1200);
    };
    ws.onmessage = (e) => {
      let d; try { d = JSON.parse(e.data); } catch (x) { return; }
      if (d.request === 'Hello' || (d.event === undefined && d.authentication)) {
        if (d.authentication && cfg.sbPass) sbAuth(ws, d.authentication, subscribe);
        else subscribe();
        return;
      }
      if (d.id && pendingSay[d.id] !== undefined) {
        // SB build without TwitchSendMessage: retry once via SendMessage
        if (d.status === 'error' && !String(d.id).endsWith('-alt')) {
          try { ws.send(JSON.stringify({ request: 'SendMessage', id: d.id + '-alt', platform: 'Twitch', message: pendingSay[d.id], bot: false })); } catch (e2) {}
          pendingSay[d.id + '-alt'] = pendingSay[d.id];
        }
        delete pendingSay[d.id];
        return;
      }
      if (d.status === 'ok' && d.id === 'tanks-sub') { sbConnected = true; statusUpdate(); return; }
      sbRoute(d);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      sbConnected = false; sbWS = null; statusUpdate();
      setTimeout(connectSB, sbBackoff);
      sbBackoff = Math.min(sbBackoff * 1.8, 20000);
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // TIKFINITY (TikTok chat)
  // ──────────────────────────────────────────────────────────────────
  let tfConnected = false, tfBackoff = 1000;
  function connectTF() {
    if (!cfg.useTF) return;
    let ws;
    try { ws = new WebSocket('ws://localhost:' + cfg.tfPort + '/'); }
    catch (e) { setTimeout(connectTF, tfBackoff); tfBackoff = Math.min(tfBackoff * 1.8, 20000); return; }
    ws.onopen = () => { tfBackoff = 1000; tfConnected = true; statusUpdate(); };
    ws.onmessage = (e) => {
      let d; try { d = JSON.parse(e.data); } catch (x) { return; }
      const ev = String(d.event || d.type || '').toLowerCase();
      if (ev !== 'chat') return;
      const data = d.data || {};
      const name = data.nickname || data.uniqueId || 'viewer';
      const key = 'tt:' + String(data.uniqueId || name).toLowerCase();
      onChat({ plat: 'tt', name, key, role: 1, text: String(data.comment || '') });
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      tfConnected = false; statusUpdate();
      setTimeout(connectTF, tfBackoff);
      tfBackoff = Math.min(tfBackoff * 1.8, 20000);
    };
  }

  const bootAt = nowMs();
  function refreshIdleCard() {
    const show = cfg.hint && !IN_OBS && !cfg.demo && st.phase === 'idle';
    elIdleCard.classList.toggle('show', show);
    if (show) {
      elIdleConn.textContent = sbConnected
        ? 'Streamer.bot connected · channel points armed'
        : 'Streamer.bot not detected · start its WebSocket server (127.0.0.1:' + cfg.sbPort + ')';
    }
  }
  function statusUpdate() {
    refreshIdleCard();
    if (!cfg.dot || cfg.demo) { elStatus.hidden = true; return; }
    if (sbConnected) { elStatus.hidden = true; return; }
    if (nowMs() - bootAt < 6000) { elStatus.hidden = true; return; }
    elStatus.hidden = false;
    elStatusText.textContent = tfConnected
      ? 'Streamer.bot offline · TikTok ok'
      : 'waiting for Streamer.bot (ws://' + cfg.sbHost + ':' + cfg.sbPort + ')';
  }
  setInterval(statusUpdate, 3000);

  // ──────────────────────────────────────────────────────────────────
  // WIND + HUD HELPERS
  // ──────────────────────────────────────────────────────────────────
  function updateWind() {
    const w = st.wind;
    if (cfg.windMax <= 0) { elWindChip.style.display = 'none'; return; }
    elWindChip.style.display = '';
    elWindArrow.textContent = w === 0 ? '·' : '→';
    elWindArrow.style.transform = w < 0 ? 'scaleX(-1)' : '';
    elWindText.textContent = w === 0 ? 'CALM' : 'WIND ' + Math.abs(w);
  }

  // ──────────────────────────────────────────────────────────────────
  // PHYSICS
  // ──────────────────────────────────────────────────────────────────
  function tankPhysics(dt) {
    for (const t of players) {
      if (!t.alive && !deathQueue.includes(t)) continue;
      t.flash = Math.max(0, t.flash - dt * 2.6);
      if (t.chute) {
        t.y += 135 * dt;
        const ground = surfaceTopAt(t.x);
        if (t.y >= ground) {
          t.y = ground; t.chute = false; t.airborne = false; t.vy = 0;
          dustFx(t.x, t.y);
          AU.pop();
        }
        continue;
      }
      if (!t.airborne) {
        // did the ground under us vanish?
        if (!solidAt(t.x - 8, t.y + 2) && !solidAt(t.x, t.y + 2) && !solidAt(t.x + 8, t.y + 2)) {
          t.airborne = true;
          t.fallFrom = t.y;
          t.vy = 0;
        } else continue;
      }
      // airborne integration in small steps so we never tunnel ledges
      const steps = Math.max(1, Math.ceil((Math.abs(t.vy) + Math.abs(t.vx)) * dt / 4));
      const sdt = dt / steps;
      for (let i = 0; i < steps; i++) {
        t.vy += G * sdt;
        t.x += t.vx * sdt;
        t.y += t.vy * sdt;
        if (t.y < t.fallFrom) t.fallFrom = t.y;
        if (t.x < 30) { t.x = 30; t.vx = Math.abs(t.vx) * 0.3; }
        if (t.x > W - 30) { t.x = W - 30; t.vx = -Math.abs(t.vx) * 0.3; }
        if (t.vy >= 0 && solidAt(t.x, t.y)) {
          while (t.y > 0 && solidAt(t.x, t.y)) t.y -= 1;
          const drop = t.y - t.fallFrom;
          t.airborne = false; t.vy = 0; t.vx = 0;
          if (drop > 95 && t.alive) {
            const dmg = Math.min(26, Math.round((drop - 95) * 0.16));
            if (dmg > 0) {
              t.hp -= dmg; t.flash = 1;
              floater(t.x, t.y - 78, '-' + dmg, '#ffc66e', false);
              if (t.hp <= 0) { t.hp = 0; t.alive = false; deathQueue.push(t); }
            }
          }
          dustFx(t.x, t.y);
          break;
        }
        if (t.y > H) { t.y = H - BEDROCK; t.airborne = false; t.vy = 0; t.vx = 0; break; }
      }
    }
  }

  function projectilePhysics(dt) {
    const pr = projectile;
    if (!pr) return;
    if (nowMs() - pr.born > 14000) { loseShell(); return; }
    const ax = st.wind * 2.2;
    const speed = Math.hypot(pr.vx, pr.vy);
    const steps = Math.max(1, Math.ceil(speed * dt / 2.2));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      pr.vx += ax * sdt;
      pr.vy += G * sdt;
      pr.x += pr.vx * sdt;
      pr.y += pr.vy * sdt;
      if (pr.x < -90 || pr.x > W + 90 || pr.y > H + 60) { loseShell(); return; }
      if (!pr.cleared && dist(pr.x, pr.y, pr.shooter.x, pr.shooter.y - 27) > 46) pr.cleared = true;
      // direct hit on a tank
      let hitTank = null;
      for (const t of players) {
        if (!t.alive) continue;
        if (t === pr.shooter && !pr.cleared) continue;
        if (dist(pr.x, pr.y, t.x, t.y - 16) < 23) { hitTank = t; break; }
      }
      if (hitTank || solidAt(pr.x, pr.y)) {
        const report = explode(pr.x, pr.y, SHELL_R, MAX_DMG, hitTank);
        st.result = describeShot(report, false);
        projectile = null;
        st.phase = 'settle';
        st.settleClear = 0;
        return;
      }
    }
    pr.trail.unshift({ x: pr.x, y: pr.y });
    if (pr.trail.length > 22) pr.trail.pop();
  }

  function loseShell() {
    projectile = null;
    st.result = describeShot(null, true);
    AU.dud();
    st.phase = 'settle';
    st.settleClear = 0;
  }

  // ──────────────────────────────────────────────────────────────────
  // UPDATE (state machine)
  // ──────────────────────────────────────────────────────────────────
  function update(dt) {
    const t = nowMs();
    st.fade += clamp(st.fadeT - st.fade, -dt * 1.6, dt * 1.6);
    st.shake = Math.max(0, st.shake - st.shake * 6 * dt);

    if (st.phase !== 'idle') tankPhysics(dt);

    switch (st.phase) {
      case 'lobby': {
        const remain = Math.max(0, (st.deadline - t) / 1000);
        const total = cfg.lobbySecs;
        elRing.style.strokeDashoffset = (169.6 * (1 - remain / total)).toFixed(1);
        const sec = Math.ceil(remain);
        elCount.textContent = sec;
        if (sec !== st.lastTickSec) { st.lastTickSec = sec; if (sec <= 5 && sec > 0) AU.tick(); }
        if (remain <= 0) lobbyExpired();
        break;
      }
      case 'starting':
        // hold until every tank has finished its paradrop
        if (t >= st.deadline && players.every(p => !p.chute && !p.airborne)) startMatch();
        break;
      case 'aim': {
        const remain = Math.max(0, st.deadline - t);
        elTurnBar.style.width = (remain / (cfg.turnSecs * 1000) * 100).toFixed(1) + '%';
        const sec = Math.ceil(remain / 1000);
        if (sec !== st.lastTickSec) { st.lastTickSec = sec; if (sec <= 5 && sec > 0) AU.tick(); }
        const p = cur();
        if (!p) break;
        if (p.cpu && t >= st.cpuAt) { cpuFire(p); break; }
        if (remain <= 0) {
          p.skips++;
          elTurnWrap.style.opacity = 0;
          if (p.skips >= 2) {
            p.alive = false;
            poofFx(p.x, p.y - 14);
            st.result = '<b>' + esc(p.name) + '</b> eliminated · afk';
            AU.dud();
          } else {
            st.result = '<b>' + esc(p.name) + '</b> hesitated · turn skipped';
          }
          st.phase = 'between';
          st.deadline = t + 1700;
          setBanner('TIME UP', st.result, false);
        }
        break;
      }
      case 'windup': {
        const p = cur();
        if (Math.abs(p.barrel - p.targetBarrel) < 1.2 && t - st.windupAt > 420) spawnProjectile();
        break;
      }
      case 'flight':
        projectilePhysics(dt);
        break;
      case 'settle': {
        const busy = players.some(q => (q.alive || deathQueue.includes(q)) && (q.airborne || q.chute)) || projectile;
        if (busy) { st.settleClear = 0; break; }
        if (deathQueue.length) {
          if (!st.settleClear) st.settleClear = t + 420;
          if (t >= st.settleClear) {
            const dead = deathQueue.shift();
            wrecks.push({ x: dead.x, y: dead.y, col: dead.col, tilt: dead.tilt });
            explode(dead.x, dead.y - 10, 58, 34, null);
            floater(dead.x, dead.y - 92, 'KO', dead.col.main, true);
            st.settleClear = 0;
          }
          break;
        }
        if (!st.settleClear) st.settleClear = t + 600;
        if (t >= st.settleClear) {
          st.settleClear = 0;
          const alive = aliveTanks();
          if (alive.length <= 1) { endMatch(alive[0] || null); break; }
          st.phase = 'between';
          st.deadline = t + 1700;
          setBanner('IMPACT', st.result, false);
        }
        break;
      }
      case 'between':
        if (t >= st.deadline) nextTurn();
        break;
      case 'victory':
        if (t < st.deadline - 9800) confettiFx();
        if (t >= st.deadline) resetIdle();
        break;
      case 'cancel':
        if (t >= st.deadline) resetIdle();
        break;
      case 'idle':
        if (cfg.demo && st.demoNext && t >= st.demoNext) startDemoMatch();
        break;
    }

    if (cfg.demo && st.phase === 'lobby') {
      while (st.demoJoins.length && t >= st.demoJoins[0].at) {
        const j = st.demoJoins.shift();
        addPlayer(j.env, true);
      }
    }

    // barrels ease toward their target angle
    for (const p of players) p.barrel += (p.targetBarrel - p.barrel) * Math.min(1, 10 * dt);

    // particles / rings / floaters
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.age += dt;
      if (q.age >= q.life) { particles.splice(i, 1); continue; }
      q.vy += (q.g || 0) * dt;
      if (q.type === 'smoke') { q.vy -= 26 * dt; q.size += 7 * dt; }
      if (q.type === 'confetti') q.x += Math.sin(q.age * 7 + q.seed) * 36 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.vr) q.rot += q.vr * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const q = rings[i];
      q.age += dt; q.r += q.vr * dt;
      if (q.age >= q.life) rings.splice(i, 1);
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const q = floaters[i];
      q.age += dt; q.y -= 44 * dt;
      if (q.age >= q.life) floaters.splice(i, 1);
    }
  }

  function startDemoMatch() {
    st.demoNext = 0;
    const names = ['PixelPaige', 'KaiOnAir', 'NeonFalcon', 'wraith_tv', 'sora42', 'DriftQueen', 'TorqueLord', 'MapleSyrupp'];
    const shuffled = names.slice().sort(() => Math.random() - 0.5);
    openLobby({ plat: 'tw', name: shuffled[0], key: 'demo:' + shuffled[0].toLowerCase() });
    players[0].cpu = true;
    const plats = ['tt', 'yt', 'tw'];
    st.demoJoins = [];
    const joins = randi(1, 3);
    for (let i = 0; i < joins; i++) {
      st.demoJoins.push({
        at: nowMs() + 1100 + i * rand(800, 1500),
        env: { plat: plats[i % 3], name: shuffled[i + 1], key: 'demo:' + shuffled[i + 1].toLowerCase() }
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────
  function drawTank(p, husk) {
    const c = p.col;
    cx.save();
    cx.translate(p.x, p.y);
    // ground tilt
    if (!p.airborne && !p.chute && !husk) {
      const yl = surfaceTopAt(p.x - 12), yr = surfaceTopAt(p.x + 12);
      p.tilt = clamp(Math.atan2(yr - yl, 24), -0.45, 0.45);
    }
    cx.rotate(p.tilt || 0);
    if (husk) cx.globalAlpha *= 0.55;

    // barrel (drawn first so it sits behind the dome)
    const rad = (p.barrel || 90) * DEG;
    const bx = Math.cos(rad), by = -Math.sin(rad);
    cx.strokeStyle = husk ? '#333' : '#222831';
    cx.lineWidth = 6;
    cx.lineCap = 'round';
    cx.beginPath();
    cx.moveTo(0, -27);
    cx.lineTo(bx * 32, -27 + by * 32);
    cx.stroke();
    cx.strokeStyle = husk ? '#444' : c.dark;
    cx.lineWidth = 3;
    cx.beginPath();
    cx.moveTo(bx * 6, -27 + by * 6);
    cx.lineTo(bx * 30, -27 + by * 30);
    cx.stroke();

    // tracks
    cx.fillStyle = husk ? '#23262d' : '#2a2f3a';
    rr(cx, -28, -11, 56, 12, 6); cx.fill();
    cx.fillStyle = husk ? '#15171c' : '#1a1e26';
    for (let i = -1; i <= 1; i++) { cx.beginPath(); cx.arc(i * 16, -5, 3.6, 0, TAU); cx.fill(); }

    // hull
    const hullGrad = cx.createLinearGradient(0, -26, 0, -10);
    hullGrad.addColorStop(0, husk ? '#3a3f48' : c.main);
    hullGrad.addColorStop(1, husk ? '#23262d' : c.dark);
    cx.fillStyle = hullGrad;
    rr(cx, -24, -25, 48, 15, 5); cx.fill();
    cx.strokeStyle = 'rgba(0,0,0,.4)';
    cx.lineWidth = 1.5;
    rr(cx, -24, -25, 48, 15, 5); cx.stroke();

    // turret dome
    cx.fillStyle = husk ? '#2e323a' : c.dark;
    cx.beginPath();
    cx.arc(0, -25, 10, Math.PI, 0);
    cx.closePath();
    cx.fill();
    cx.strokeStyle = 'rgba(0,0,0,.35)';
    cx.stroke();

    // hit flash
    if (p.flash > 0 && !husk) {
      cx.globalAlpha *= Math.min(1, p.flash);
      cx.fillStyle = '#ffffff';
      rr(cx, -24, -25, 48, 15, 5); cx.fill();
      cx.beginPath(); cx.arc(0, -25, 10, Math.PI, 0); cx.fill();
    }
    cx.restore();

    // parachute
    if (p.chute) {
      cx.save();
      cx.translate(p.x, p.y);
      cx.strokeStyle = 'rgba(255,255,255,.65)';
      cx.lineWidth = 1.6;
      cx.beginPath();
      cx.moveTo(-20, -20); cx.lineTo(-26, -66);
      cx.moveTo(20, -20); cx.lineTo(26, -66);
      cx.moveTo(0, -25); cx.lineTo(0, -70);
      cx.stroke();
      const cg = cx.createLinearGradient(-34, -100, 34, -64);
      cg.addColorStop(0, c.main); cg.addColorStop(1, c.dark);
      cx.fillStyle = cg;
      cx.beginPath();
      cx.moveTo(-34, -66);
      cx.quadraticCurveTo(0, -112, 34, -66);
      cx.quadraticCurveTo(0, -78, -34, -66);
      cx.closePath();
      cx.fill();
      cx.restore();
    }
  }

  function drawPlate(p) {
    const label = p.name;
    cx.save();
    cx.font = '800 15px Inter, system-ui, sans-serif';
    const icon = !p.cpu && ICONS[p.plat];
    const cpuW = p.cpu ? 30 : 0;
    const tw = cx.measureText(label).width;
    const w = tw + (icon ? 21 : 0) + cpuW + 18, h = 24;
    const px = p.x - w / 2, py = p.y - 70;
    cx.fillStyle = 'rgba(8,10,16,.74)';
    rr(cx, px, py, w, h, 8); cx.fill();
    cx.strokeStyle = p.col.main;
    cx.globalAlpha *= 0.85;
    cx.lineWidth = 1.4;
    rr(cx, px, py, w, h, 8); cx.stroke();
    cx.globalAlpha /= 0.85;
    let tx0 = px + 9;
    if (icon) { try { cx.drawImage(icon, tx0, py + 4.5, 15, 15); } catch (e) {} tx0 += 21; }
    cx.fillStyle = '#fff';
    cx.textBaseline = 'middle';
    cx.fillText(label, tx0, py + h / 2 + 1);
    if (p.cpu) {
      cx.font = '900 10px Inter, system-ui, sans-serif';
      cx.fillStyle = 'rgba(255,255,255,.75)';
      cx.fillText('CPU', tx0 + tw + 6, py + h / 2 + 1);
    }
    // hp bar
    const bw = 48, bx0 = p.x - bw / 2, by0 = py + h + 4;
    cx.fillStyle = 'rgba(8,10,16,.65)';
    rr(cx, bx0 - 1.5, by0 - 1.5, bw + 3, 9, 4.5); cx.fill();
    const frac = clamp(p.hp / cfg.hp, 0, 1);
    if (frac > 0) {
      cx.fillStyle = 'hsl(' + Math.round(frac * 128) + ',72%,52%)';
      rr(cx, bx0, by0, bw * frac, 6, 3); cx.fill();
    }
    cx.restore();
  }

  function drawProtractor(p) {
    const cxp = p.x, cyp = p.y - 27;
    const pulse = 0.4 + 0.14 * Math.sin(nowMs() / 280);
    cx.save();
    cx.globalAlpha *= pulse;
    cx.strokeStyle = p.col.main;
    cx.lineWidth = 1.6;
    cx.setLineDash([5, 6]);
    cx.beginPath();
    cx.arc(cxp, cyp, 48, Math.PI, TAU);
    cx.stroke();
    cx.setLineDash([]);
    cx.font = '700 12px Inter, system-ui, sans-serif';
    cx.fillStyle = p.col.main;
    cx.textAlign = 'center';
    for (const a of [0, 45, 90, 135, 180]) {
      const r1 = 48, r2 = 56;
      const dx = Math.cos(a * DEG), dy = -Math.sin(a * DEG);
      cx.beginPath();
      cx.moveTo(cxp + dx * (r1 - 4), cyp + dy * (r1 - 4));
      cx.lineTo(cxp + dx * r1, cyp + dy * r1);
      cx.stroke();
      cx.fillText(String(a), cxp + dx * (r2 + 6), cyp + dy * (r2 + 6) + 4);
    }
    cx.restore();
    // glow pad under the active tank
    cx.save();
    cx.globalAlpha *= 0.3 + 0.12 * Math.sin(nowMs() / 300);
    cx.fillStyle = p.col.glow;
    cx.beginPath();
    cx.ellipse(p.x, p.y + 4, 44, 10, 0, 0, TAU);
    cx.fill();
    cx.restore();
  }

  function draw() {
    cx.clearRect(0, 0, W, H);
    if (st.fade <= 0.004 && st.phase === 'idle') return;

    cx.save();
    cx.globalAlpha = st.fade;
    if (st.shake > 0.4) cx.translate(rand(-st.shake, st.shake), rand(-st.shake, st.shake));

    if (cfg.sky) {
      const sg = cx.createLinearGradient(0, 0, 0, H);
      sg.addColorStop(0, '#101a2e');
      sg.addColorStop(0.7, '#1d2c4a');
      sg.addColorStop(1, '#2a3c5e');
      cx.fillStyle = sg;
      cx.fillRect(0, 0, W, H);
    }

    cx.drawImage(T, 0, 0);

    for (const wk of wrecks) drawTank({ ...wk, barrel: 90, flash: 0, airborne: false, chute: false, plat: 'tw', cpu: false, name: '', col: wk.col }, true);

    const active = cur();
    if ((st.phase === 'aim' || st.phase === 'windup') && active && !active.cpu) drawProtractor(active);
    else if (st.phase === 'aim' && active && active.cpu) drawProtractor(active);

    for (const p of players) {
      if (!p.alive && !deathQueue.includes(p) && !p.chute) continue;
      drawTank(p, false);
    }
    for (const p of players) {
      if (!p.alive && !deathQueue.includes(p)) continue;
      drawPlate(p);
    }

    // projectile + trail
    if (projectile) {
      const pr = projectile;
      for (let i = 0; i < pr.trail.length; i++) {
        const q = pr.trail[i], f = 1 - i / pr.trail.length;
        cx.globalAlpha = st.fade * f * 0.5;
        cx.fillStyle = '#ffd27d';
        cx.beginPath(); cx.arc(q.x, q.y, 3.4 * f + 0.8, 0, TAU); cx.fill();
      }
      cx.globalAlpha = st.fade;
      const grd = cx.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, 11);
      grd.addColorStop(0, '#fff7df');
      grd.addColorStop(0.45, '#ffc44d');
      grd.addColorStop(1, 'rgba(255,150,40,0)');
      cx.fillStyle = grd;
      cx.beginPath(); cx.arc(pr.x, pr.y, 11, 0, TAU); cx.fill();
      cx.fillStyle = '#3a3325';
      cx.beginPath(); cx.arc(pr.x, pr.y, 4.4, 0, TAU); cx.fill();
    }

    // particles
    for (const q of particles) {
      const f = 1 - q.age / q.life;
      if (q.type === 'dirt') {
        cx.globalAlpha = st.fade * Math.min(1, f * 1.6);
        cx.fillStyle = q.color;
        cx.save(); cx.translate(q.x, q.y); cx.rotate(q.rot || 0);
        cx.fillRect(-q.size / 2, -q.size / 2, q.size, q.size);
        cx.restore();
      } else if (q.type === 'spark') {
        cx.globalAlpha = st.fade * f;
        cx.fillStyle = q.color;
        cx.beginPath(); cx.arc(q.x, q.y, q.size * f + 0.4, 0, TAU); cx.fill();
      } else if (q.type === 'smoke') {
        cx.globalAlpha = st.fade * f * 0.34;
        cx.fillStyle = q.color + '1)';
        cx.beginPath(); cx.arc(q.x, q.y, q.size, 0, TAU); cx.fill();
      } else if (q.type === 'confetti') {
        cx.globalAlpha = st.fade * Math.min(1, f * 2);
        cx.fillStyle = q.color;
        cx.save(); cx.translate(q.x, q.y); cx.rotate(q.rot);
        cx.fillRect(-q.size / 2, -q.size / 4, q.size, q.size / 2);
        cx.restore();
      }
    }
    // shockwave rings
    for (const q of rings) {
      const f = 1 - q.age / q.life;
      cx.globalAlpha = st.fade * f * 0.7;
      cx.strokeStyle = '#ffd9a0';
      cx.lineWidth = 3 * f + 0.6;
      cx.beginPath(); cx.arc(q.x, q.y, q.r, 0, TAU); cx.stroke();
    }
    // damage floaters
    for (const q of floaters) {
      const f = 1 - q.age / q.life;
      cx.globalAlpha = st.fade * Math.min(1, f * 1.8);
      cx.font = '900 ' + q.size + 'px Inter, system-ui, sans-serif';
      cx.textAlign = 'center';
      cx.lineWidth = 4;
      cx.strokeStyle = 'rgba(0,0,0,.55)';
      cx.strokeText(q.text, q.x, q.y);
      cx.fillStyle = q.color;
      cx.fillText(q.text, q.x, q.y);
      cx.textAlign = 'left';
    }

    cx.restore();
  }

  // ──────────────────────────────────────────────────────────────────
  // MAIN LOOP
  // ──────────────────────────────────────────────────────────────────
  let last = nowMs();
  let lastFrameAt = nowMs();
  function frame(t) {
    lastFrameAt = nowMs();
    const dt = Math.min(0.05, (t - last) / 1000) || 0.016;
    last = t;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  // Hidden tabs (and some embedded webviews) pause rAF entirely, and after
  // five hidden minutes Chrome throttles main-thread timers to one wake a
  // minute. Tick from a dedicated Worker (exempt from both) so a
  // backgrounded overlay never freezes a battle; rAF takes over again the
  // moment the page is visible.
  function catchUp() {
    const t = nowMs();
    if (t - lastFrameAt < 400) return;
    let elapsed = Math.min(1.5, (t - last) / 1000);
    last = t;
    while (elapsed > 0) {
      const s = Math.min(0.033, elapsed);
      update(s);
      elapsed -= s;
    }
    draw();
  }
  try {
    const wsrc = URL.createObjectURL(new Blob(['setInterval(function(){postMessage(1)},250);'], { type: 'text/javascript' }));
    const ticker = new Worker(wsrc);
    ticker.onmessage = catchUp;
  } catch (e) {
    setInterval(catchUp, 250);
  }

  // ──────────────────────────────────────────────────────────────────
  // DEBUG / SELFTEST HOOKS
  // ──────────────────────────────────────────────────────────────────
  window.TB = {
    redeem(name) {
      name = name || 'TestRedeemer';
      onRedeem({ plat: 'tw', name, key: 'tw:' + name.toLowerCase(), title: cfg.reward || 'tank battle' });
    },
    chat(name, text, plat, role) {
      onChat({ plat: plat || 'tw', name, key: (plat || 'tw') + ':' + String(name).toLowerCase(), role: role || 1, text });
    },
    snap() {
      return {
        phase: st.phase, round: st.round, wind: st.wind, sudden: st.sudden,
        current: cur() ? cur().name : null,
        players: players.map(p => ({ name: p.name, hp: p.hp, alive: p.alive, x: Math.round(p.x), y: Math.round(p.y), cpu: !!p.cpu, airborne: p.airborne || p.chute })),
        carves: carveCount, projectile: !!projectile,
        sb: sbConnected, tf: tfConnected
      };
    },
    solid(x, y) { return solidAt(x, y); },
    end() { forceEnd(); }
  };

  // ──────────────────────────────────────────────────────────────────
  // BOOT
  // ──────────────────────────────────────────────────────────────────
  connectSB();
  connectTF();
  updateWind();
  refreshIdleCard();
  requestAnimationFrame(frame);
})();
