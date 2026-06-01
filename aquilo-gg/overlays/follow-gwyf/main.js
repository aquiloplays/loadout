/*
 * GWYF Follow Overlay client.
 *
 * - Idle: every 8-12s a random casino sprite pops up above the bar, holds
 *   ~2s, fades. The "FOLLOW = RANDOM GAME EFFECT" hero bar is always shown.
 * - Follow: a TikFinity `follow` event triggers a bigger celebration (slots /
 *   royal flush / coin rain, rotated) plus a "thanks for following @user"
 *   card with the follower's avatar, then returns to idle.
 *
 * TikFinity exposes a local WebSocket at ws://localhost:21213/ that streams
 * TikTok LIVE events as JSON. We reconnect with exponential backoff.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const TIKFINITY_URL = params.get('tikfinity') || 'ws://localhost:21213/';
  let   ASSET_BASE    = params.get('assets') || './assets/';
  if (!ASSET_BASE.endsWith('/')) ASSET_BASE += '/';
  const DEMO  = params.get('demo')  === '1';
  const DEBUG = params.get('debug') === '1';

  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Sprite catalog -------------------------------------------------
  // `motion` selects the CSS pop-up animation layered on the sprite.
  const IDLE_SPRITES = [
    { file: 'slot-machine.png', motion: 'burst'  },
    { file: 'chips-stack.png',  motion: 'tumble' },
    { file: 'dice-pair.png',    motion: 'tumble' },
    { file: 'cards-fan.png',    motion: 'fan'    },
    { file: 'gold-coin.png',    motion: 'spin'   },
    { file: 'jackpot-text.png', motion: 'burst'  },
    { file: 'royal-flush.png',  motion: 'fan'    },
    { file: 'die-six.png',      motion: 'tumble' },
    { file: 'crown-chip.png',   motion: 'spin'   },
  ];

  // Follow celebrations — rotated at random. `coins` controls how many
  // coin-rain particles spawn behind the hero sprite.
  const CELEBRATIONS = [
    { variant: 'slots', file: 'slot-machine.png', coins: 8  },
    { variant: 'cards', file: 'royal-flush.png',  coins: 6  },
    { variant: 'coins', file: 'jackpot-text.png', coins: 18 },
  ];

  // ---- DOM ------------------------------------------------------------
  const popup        = $('popup');
  const popupImg     = $('popupImg');
  const celebrate    = $('celebrate');
  const celebrateImg = $('celebrateImg');
  const coinrain     = $('coinrain');
  const thanksUser   = $('thanksUser');
  const thanksAvatar = $('thanksAvatar');
  const thanksInitial= $('thanksInitial');

  // Preload sprites so the first pop-up/celebration doesn't flash empty.
  [...new Set([...IDLE_SPRITES, ...CELEBRATIONS].map(s => s.file))].forEach(f => {
    const im = new Image(); im.src = ASSET_BASE + f;
  });

  let idleTimer = null;
  let celebrating = false;
  let lastIdleIdx = -1;

  // ---- Idle pop-up loop ----------------------------------------------
  function scheduleIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    const delay = 8000 + Math.random() * 4000;   // 8–12s
    idleTimer = setTimeout(runIdlePop, delay);
  }

  function runIdlePop() {
    if (reduceMotion) { scheduleIdle(); return; }   // static hero only
    if (celebrating) { scheduleIdle(); return; }     // never collide with a follow

    let idx = Math.floor(Math.random() * IDLE_SPRITES.length);
    if (idx === lastIdleIdx) idx = (idx + 1) % IDLE_SPRITES.length;  // avoid repeats
    lastIdleIdx = idx;
    const sprite = IDLE_SPRITES[idx];

    popupImg.src = ASSET_BASE + sprite.file;
    popup.className = 'popup';            // reset
    void popup.offsetWidth;              // reflow so the animation re-kicks
    popup.classList.add('show', sprite.motion);

    // popRise runs 2.8s; clear the classes after so it's idle again.
    setTimeout(() => { popup.className = 'popup'; }, 2900);
    scheduleIdle();
  }

  // ---- Follow celebration --------------------------------------------
  let celebIdx = -1;
  function spawnCoins(n) {
    coinrain.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const c = document.createElement('div');
      c.className = 'coin';
      c.style.left = (Math.random() * 100) + '%';
      c.style.setProperty('--dur', (1.2 + Math.random() * 1.1).toFixed(2) + 's');
      c.style.setProperty('--delay', (Math.random() * 1.2).toFixed(2) + 's');
      const sc = (0.7 + Math.random() * 0.7).toFixed(2);
      c.style.transform = `scale(${sc})`;
      coinrain.appendChild(c);
    }
  }

  function celebrateFollow(info, forceIdx) {
    celebrating = true;
    // Hide any in-flight idle pop-up so it doesn't overlap.
    popup.className = 'popup';

    if (typeof forceIdx === 'number') celebIdx = forceIdx;
    else celebIdx = (celebIdx + 1) % CELEBRATIONS.length;
    const c = CELEBRATIONS[celebIdx];

    // Follower identity
    const handle = info.username ? '@' + String(info.username).replace(/^@/, '') : '@friend';
    thanksUser.textContent = handle;
    const initial = (info.nickname || info.username || '?').trim().charAt(0).toUpperCase() || '?';
    thanksInitial.textContent = initial;
    if (info.avatar) {
      thanksAvatar.style.backgroundImage = `url("${info.avatar}")`;
      thanksInitial.style.opacity = '0';
      // If the avatar fails to load, fall back to the initial.
      const probe = new Image();
      probe.onerror = () => { thanksAvatar.style.backgroundImage = 'none'; thanksInitial.style.opacity = '1'; };
      probe.src = info.avatar;
    } else {
      thanksAvatar.style.backgroundImage = 'none';
      thanksInitial.style.opacity = '1';
    }

    celebrateImg.src = ASSET_BASE + c.file;
    spawnCoins(reduceMotion ? 0 : c.coins);

    celebrate.className = 'celebrate';
    void celebrate.offsetWidth;
    celebrate.classList.add('show', 'var-' + c.variant);

    // celebPop / thanksIn run 4.6s; dismiss + resume idle just after.
    setTimeout(() => {
      celebrate.className = 'celebrate';
      coinrain.innerHTML = '';
      celebrating = false;
    }, 4800);
  }

  // ---- Normalize a TikFinity event payload ---------------------------
  // TikFinity wraps TikTok-Live-Connector events. Field names vary a little
  // across versions, so we read several aliases defensively.
  function extractFollow(msg) {
    const ev = (msg.event || msg.eventType || msg.type || '').toLowerCase();
    const isFollow = ev === 'follow' || ev === 'social' && /follow/i.test(JSON.stringify(msg.data || {}));
    if (!isFollow) return null;
    const d = msg.data || msg.payload || msg;
    return {
      username: d.uniqueId || d.unique_id || d.username || d.user || d.nickname || '',
      nickname: d.nickname || d.displayName || d.uniqueId || '',
      avatar:   d.profilePictureUrl || d.profilePicture || d.avatar ||
                (d.user && (d.user.profilePictureUrl || d.user.avatarThumb)) || '',
    };
  }

  function handle(msg) {
    const follow = extractFollow(msg);
    if (follow) celebrateFollow(follow);
  }

  // ---- TikFinity WebSocket (exponential backoff) ---------------------
  let ws = null, backoff = 1000;
  function connect() {
    setStatus('connecting…');
    try { ws = new WebSocket(TIKFINITY_URL); }
    catch (e) { setStatus('bad URL'); return; }

    ws.onopen = () => { setStatus('connected'); backoff = 1000; };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg) return;
      try { handle(msg); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      setStatus('reconnecting…');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => { setStatus('error'); try { ws.close(); } catch {} };
  }

  // ---- Debug / status -------------------------------------------------
  function setStatus(t) {
    if (!DEBUG) return;
    let el = $('devStatus');
    if (!el) { el = document.createElement('div'); el.id = 'devStatus'; el.className = 'dev-status'; document.body.appendChild(el); }
    el.textContent = 'tikfinity: ' + t;
  }

  const SAMPLE_FOLLOWERS = [
    { username: 'aceofspades', nickname: 'Ace', avatar: '' },
    { username: 'luckylucy',   nickname: 'Lucy', avatar: '' },
    { username: 'highroller22', nickname: 'High Roller', avatar: '' },
  ];
  let sampleIdx = 0;
  function fireSample() {
    celebrateFollow(SAMPLE_FOLLOWERS[sampleIdx++ % SAMPLE_FOLLOWERS.length]);
  }

  if (DEBUG) {
    const btn = document.createElement('button');
    btn.className = 'dev-btn'; btn.textContent = 'simulate follow';
    btn.onclick = fireSample;
    document.body.appendChild(btn);
  }

  // ---- Boot -----------------------------------------------------------
  connect();
  scheduleIdle();

  if (DEMO) {
    // Auto-fire a sample follow every ~10s for testing / screenshots.
    setInterval(fireSample, 10000);
    setTimeout(fireSample, 2500);
  }

  // ?shot=idle|follow — QA / screenshot staging. Drops a dark "gameplay"
  // backdrop behind the (otherwise transparent) overlay and immediately
  // stages one state so a headless capture lands on it deterministically.
  const SHOT = params.get('shot');
  if (SHOT) {
    document.body.style.background =
      'linear-gradient(150deg,#2e7d54 0%,#1f6f8b 38%,#6b4ea8 72%,#a8466e 100%)';
    // Hold every element in its fully-visible state (no timed entrance/exit)
    // so a still capture always lands on the complete composition.
    const hold = document.createElement('style');
    hold.textContent = `
      .popup.show, .celebrate.show .celebrate-tile, .celebrate.show .celebrate-img,
      .celebrate.show .thanks, .popup-img, .coinrain .coin {
        animation: none !important; opacity: 1 !important;
      }
      .popup.show { transform: translate(-50%,-2px) scale(1) !important; }
      .celebrate.show .celebrate-tile { transform: translateX(-50%) scale(1) !important; }
      .celebrate.show .thanks { transform: translate(-50%,0) scale(1) !important; }
    `;
    document.head.appendChild(hold);

    if (SHOT === 'idle') {
      const s = IDLE_SPRITES.find(x => x.file === 'slot-machine.png') || IDLE_SPRITES[0];
      popupImg.src = ASSET_BASE + s.file;
      popup.className = 'popup show ' + s.motion;
    } else if (SHOT === 'follow') {
      // index 2 = coin-rain celebration (the richest for a still).
      celebrateFollow({ username: 'luckylucy', nickname: 'Lucy', avatar: '' }, 2);
      // Scatter the coins to static mid-air positions for the still.
      requestAnimationFrame(() => {
        [...coinrain.children].forEach((c) => {
          c.style.top = (10 + Math.random() * 150) + 'px';
          c.style.opacity = '1';
        });
      });
    }
  }

  // Expose for manual testing from the console / preview harness.
  window.gwyfSimulateFollow = celebrateFollow;
})();
