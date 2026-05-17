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

  // Vertical / portrait mode for TikTok / YouTube Shorts / Reels
  // (9:16 streams). Switches the card to a much wider footprint with
  // bumped type so it reads on a phone-screen-sized canvas. CSS does
  // the actual layout via body[data-vertical="1"]; main.js is just
  // the flag setter. Defaults the position to bottom-center when the
  // streamer hasn't picked one — TikTok's UI chrome sits along the
  // right edge so a centered card reads cleaner.
  const vertical = params.get('vertical') === '1';
  if (vertical) {
    document.body.dataset.vertical = '1';
    if (!pos) document.body.dataset.pos = 'bc';
  }

  // Bare mode — drops the card's solid background entirely so the
  // overlay reads as floating text + chips against gameplay rather
  // than a panel laid on top. CSS keeps everything legible against
  // any backdrop via heavy text-shadows, outline glow on the badge,
  // and a chip background instead of a card surface. Pairs cleanly
  // with ?vertical=1 for the most minimal vertical-stream footprint.
  const bare = params.get('bare') === '1';
  if (bare) document.body.dataset.bare = '1';

  const HOLD_MS     = Math.max(1500, parseInt(params.get('holdMs')     || '4500', 10) || 4500);
  const IDLE_ROTATE = Math.max(10,   parseInt(params.get('idleRotate') || '30',   10) || 30) * 1000;

  // Per-layer allow-list. ?show=<csv> picks which event categories
  // are rendered on the card; everything else is silently ignored.
  // Default (no param, or 'all') = every category. Categories:
  //   bolts | welcome | counter | viewer | hype | minigames |
  //   rotation | commands
  // The Settings UI bakes this into the URL based on the streamer's
  // checkboxes; chat events for excluded categories don't even
  // populate the active layer.
  const SHOW_ALL = ['bolts','welcome','counter','viewer','hype','minigames','rotation','commands'];
  const showRaw = (params.get('show') || '').toLowerCase().trim();
  const showSet = (() => {
    if (!showRaw || showRaw === 'all') return new Set(SHOW_ALL);
    return new Set(showRaw.split(/[\s,]+/).filter(Boolean));
  })();
  function shows(cat) { return showSet.has(cat); }

  // Map a bus event kind to one of the SHOW_ALL category tags so the
  // ?show= filter can drop events from disabled categories early.
  // Returns '' for events that should always render (commands.list /
  // .icons control the idle ticker but are gated separately).
  function categoryOf(kind) {
    if (!kind) return '';
    if (kind.indexOf('bolts.minigame.')   === 0) return 'minigames';
    if (kind.indexOf('bolts.')             === 0) return 'bolts';
    if (kind.indexOf('welcome.')           === 0) return 'welcome';
    if (kind.indexOf('counter.')           === 0) return 'counter';
    if (kind.indexOf('viewer.profile.')    === 0) return 'viewer';
    if (kind.indexOf('hypetrain.')         === 0) return 'hype';
    if (kind.indexOf('rotation.song.')     === 0) return 'rotation';
    return '';
  }

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
  const gSlots    = gameEl.querySelector('.g-slots');
  const gLever    = gameEl.querySelector('.g-lever');
  const gReels    = [$('gReel0'), $('gReel1'), $('gReel2')];

  // Show / hide a layer by toggling the existing `.hidden` class —
  // the rest of the overlay's transitions key off it.
  function showLayer(el) {
    if (!el) return;
    [idleEl, activeEl, gameEl, hypeEl].forEach(function (l) { if (l && l !== el) l.classList.add('hidden'); });
    el.classList.remove('hidden');
  }
  function hideLayer(el) { if (el) el.classList.add('hidden'); }

  // Hype-train takeover refs.
  const hypeEl       = $('hype');
  const hypeTip      = $('hypeTip');
  const hypeBanner   = $('hypeBanner');
  const hypeBannerText = $('hypeBannerText');
  const hypeLevel    = $('hypeLevel');
  const hypeBarFill  = $('hypeBarFill');
  const hypeFuel     = $('hypeFuel');
  const hypeCountdown = $('hypeCountdown');

  // Takeover lifecycle state.
  let hypeActive    = false;
  let hypeFuelNow   = 0;
  let hypeThreshold = 100;
  let hypeLevelNow  = 1;
  // Twitch-style ~5min hype-train timer; resets on each contribution.
  // We store the deadline (ms epoch) and tick a 1Hz countdown render.
  // hypetrain.start optionally provides endsAt (ms); otherwise we
  // assume 5 minutes from now and let contribute events extend it.
  let hypeDeadline  = 0;
  let hypeTickHandle = null;
  const HYPE_DEFAULT_MS = 5 * 60 * 1000;

  function fmtMmSs(ms) {
    if (ms <= 0) return '0:00';
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function tickHypeCountdown() {
    if (!hypeActive) return;
    const remaining = hypeDeadline - Date.now();
    if (hypeCountdown) hypeCountdown.textContent = fmtMmSs(remaining);
    if (remaining <= 0) {
      // Train timed out without an explicit end event — clean up.
      hypeEnd({ finalLevel: hypeLevelNow });
    }
  }
  function runTrainAnim() {
    if (!hypeBanner) return;
    hypeBanner.classList.remove('running');
    void hypeBanner.offsetWidth;   // re-trigger CSS animation
    hypeBanner.classList.add('running');
  }
  function setHypeBar(fuel, threshold) {
    hypeFuelNow   = fuel;
    hypeThreshold = Math.max(1, threshold);
    if (hypeBarFill) hypeBarFill.style.width = Math.min(100, (fuel / hypeThreshold) * 100) + '%';
    if (hypeFuel)    hypeFuel.textContent = fuel + ' / ' + hypeThreshold + ' fuel';
  }
  function flashBar() {
    if (!hypeBarFill) return;
    var bar = hypeBarFill.parentElement;
    if (!bar) return;
    bar.classList.remove('flash');
    void bar.offsetWidth;
    bar.classList.add('flash');
    setTimeout(function () { bar && bar.classList.remove('flash'); }, 600);
  }
  function hypeStart(d) {
    if (!shows('hype')) return;
    hypeActive   = true;
    hypeLevelNow = d.level || 1;
    hypeDeadline = d.endsAt ? Number(d.endsAt) : (Date.now() + HYPE_DEFAULT_MS);
    document.body.dataset.hype = '1';
    if (hypeTip)   hypeTip.hidden = false;
    if (hypeLevel) hypeLevel.textContent = 'LEVEL ' + hypeLevelNow;
    if (hypeBannerText) hypeBannerText.textContent = 'HYPE TRAIN!';
    setHypeBar(d.fuel || 0, d.threshold || 100);
    showLayer(hypeEl);
    runTrainAnim();
    if (hypeTickHandle) clearInterval(hypeTickHandle);
    hypeTickHandle = setInterval(tickHypeCountdown, 1000);
    tickHypeCountdown();
    // Clear the queue / pending-active so other events don't slip
    // through under the takeover.
    queue.length = 0;
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
  }
  function hypeContribute(d) {
    if (!hypeActive) return;
    setHypeBar(d.totalFuel != null ? d.totalFuel : (hypeFuelNow + (d.fuel || 0)),
               d.threshold || hypeThreshold);
    flashBar();
    // Each contribution resets the timer to the default duration —
    // matches Twitch's hype-train behaviour where new fuel extends
    // the window.
    hypeDeadline = Date.now() + HYPE_DEFAULT_MS;
    tickHypeCountdown();
  }
  function hypeLevelUp(d) {
    if (!hypeActive) return;
    hypeLevelNow = d.level || hypeLevelNow + 1;
    if (hypeLevel) hypeLevel.textContent = 'LEVEL ' + hypeLevelNow + '!';
    if (hypeBannerText) hypeBannerText.textContent = 'LEVEL ' + hypeLevelNow + '!';
    setHypeBar(d.fuel || 0, d.threshold || hypeThreshold);
    runTrainAnim();
    // After 1.6s the banner text fades and we re-set it back to the
    // running headline — UX cue that the level-up moment is over.
    setTimeout(function () {
      if (hypeBannerText && hypeActive) hypeBannerText.textContent = 'HYPE TRAIN!';
    }, 1800);
  }
  function hypeEnd(d) {
    if (!hypeActive) return;
    hypeLevelNow = d.finalLevel || hypeLevelNow;
    if (hypeBannerText) hypeBannerText.textContent = 'FINAL LEVEL ' + hypeLevelNow;
    runTrainAnim();
    // Linger ~3.5s on the celebration before clearing.
    setTimeout(function () {
      hypeActive = false;
      delete document.body.dataset.hype;
      if (hypeTip) hypeTip.hidden = true;
      if (hypeTickHandle) { clearInterval(hypeTickHandle); hypeTickHandle = null; }
      hideLayer(hypeEl);
      // Resume normal idle ticker.
      showLayer(idleEl);
    }, 3500);
  }

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
    // Branded badge: real brand logo if the command has a platforms
    // array (Discord, Steam, etc.); icon strip if multiple; emoji
    // fallback otherwise.
    idleBadge.classList.remove('platforms', 'platforms-strip');
    const plats = Array.isArray(c.platforms) ? c.platforms : [];
    if (plats.length === 1 && window.PlatformIcons) {
      const url = window.PlatformIcons.iconUrl(plats[0]);
      if (url) {
        idleBadge.classList.add('platforms');
        idleBadge.innerHTML = '<img class="badge-img" src="' + url + '" alt="" loading="lazy" />';
      } else {
        applyBadge(idleBadge, badgeForCat(c.cat));
      }
    } else if (plats.length > 1 && window.PlatformIcons) {
      const html = window.PlatformIcons.renderStrip(plats, { max: 3 });
      if (html) {
        idleBadge.classList.add('platforms-strip');
        idleBadge.innerHTML = html;
      } else {
        applyBadge(idleBadge, badgeForCat(c.cat));
      }
    } else {
      applyBadge(idleBadge, badgeForCat(c.cat));
    }
    idleName.textContent  = c.name || '!commands';
    idleDesc.textContent  = c.desc || c.description || '';
  }
  function startIdle() {
    if (idleTimer) clearInterval(idleTimer);
    // Honour the ?show= filter — when 'commands' is excluded the idle
    // ticker stays hidden entirely. The card just disappears between
    // events, which is what streamers who flip it off explicitly
    // want.
    if (!shows('commands')) {
      idleEl.classList.add('hidden');
      return;
    }
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
    gDie.classList.remove('show', 'rolling',
                          'land-1', 'land-2', 'land-3', 'land-4', 'land-5', 'land-6');
    gSlots.classList.remove('show');
    gReels.forEach(r => { r.classList.remove('spinning', 'locked'); r.innerHTML = ''; });
    if (gLever) gLever.classList.remove('pulling');
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
    gCoin.classList.add('show');
    void gCoin.offsetWidth;
    gCoin.classList.add('flipping', d.result === 'tails' ? 'show-tails' : 'show-heads');
    setTimeout(() => {
      // Settle: keep current sub (already set with payout); just pulse.
      gameEl.classList.remove('popped'); void gameEl.offsetWidth; gameEl.classList.add('popped');
    }, 1300);
  }
  function runDie(d) {
    var face = parseInt(d.rolled, 10);
    if (!(face >= 1 && face <= 6)) face = 1;
    gDie.classList.add('show', 'land-' + face);
    void gDie.offsetWidth;
    gDie.classList.add('rolling');
    setTimeout(() => {
      gameEl.classList.remove('popped'); void gameEl.offsetWidth; gameEl.classList.add('popped');
    }, 1300);
  }
  function runSlots(d) {
    gSlots.classList.add('show');
    // Lever pull — fires ~240ms before reels lock so the read is
    // "pull → spin → settle". Same retrigger trick as the standalone
    // overlay: remove → reflow → add so back-to-back !slots events
    // re-run the transition.
    if (gLever) {
      gLever.classList.remove('pulling');
      void gLever.offsetWidth;
      gLever.classList.add('pulling');
      setTimeout(function () { if (gLever) gLever.classList.remove('pulling'); }, 240);
    }
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

    // Hype-train events are routed to the takeover state machine
    // BEFORE the regular event-card path, regardless of category
    // filter. (Hype's category gate runs inside hypeStart.)
    // Loadout runs two trains — only render the cross-platform one
    // ("all") here so a Twitch-only train doesn't double-fire the
    // takeover. Events with no source default to "all".
    if (k.indexOf('hypetrain.') === 0) {
      if ((d.source || 'all').toLowerCase() !== 'all') return;
    }
    if (k === 'hypetrain.start')      { hypeStart(d);      return; }
    if (k === 'hypetrain.contribute') { hypeContribute(d); return; }
    if (k === 'hypetrain.level')      { hypeLevelUp(d);    return; }
    if (k === 'hypetrain.end')        { hypeEnd(d);        return; }

    // Drop any non-hype event during the takeover so the train read
    // doesn't get interrupted by a !slots / !checkin / etc.
    if (hypeActive) return;

    // Per-category gate. The compact's Settings card lets streamers
    // pick which event types render here; everything else is silently
    // ignored. `show` tags map roughly 1:1 to event prefixes.
    const cat = categoryOf(k);
    if (cat && !shows(cat)) return;

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
      // hypetrain.* short-circuited to the takeover state machine
      // above — no event-card pump path for them anymore.
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
      case 'tips.received':
        if (!(d.amount > 0)) return;
        evt = { tone: 'streak', badge: '💖',
                title: (d.tipper || 'anonymous') + ' tipped ' + (d.currency || 'USD') + ' ' + (d.amount || 0).toFixed(2),
                sub:   d.bolts > 0
                       ? '+' + d.bolts + ' bolts' + (d.message ? '  ·  "' + d.message + '"' : '')
                       : (d.message ? '"' + d.message + '"' : 'thanks!') };
        break;
      case 'bolts.heist.start':
        if (!d.initiator) return;
        evt = { tone: 'counter', badge: '🦹',
                title: d.initiator + ' is pulling a heist',
                sub: 'pot ' + (d.totalPot || d.stake || 0) + '/' + (d.target || 0) + ' ⚡  ·  !join to chip in' };
        break;
      case 'bolts.heist.success':
        evt = { tone: 'win', badge: '💰',
                title: 'HEIST SUCCESS',
                sub: 'crew of ' + (d.contributors || 0) + ' splits ' + (d.payout || 0) + ' ⚡' };
        break;
      case 'bolts.heist.failure':
        evt = { tone: 'lose', badge: '🚨',
                title: 'HEIST FAILED',
                sub: 'pot ' + (d.totalPot || 0) + '/' + (d.target || 0) + ' ⚡  ·  crew got nothing' };
        break;
    }
    if (evt) enqueue(evt);
  }

  function ingestCommands(payload) {
    if (!payload || !Array.isArray(payload.commands) || payload.commands.length === 0) return;
    commands = payload.commands.map(c => ({
      name: c.name,
      desc: c.desc || c.description || '',
      cat:  (c.cat || c.category || '').toLowerCase(),
      // Optional platforms[] drives the brand-logo badge in tickIdle.
      platforms: Array.isArray(c.platforms) ? c.platforms : null
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
        'hypetrain.*', 'counter.*', 'viewer.profile.shown', 'tips.received',
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
