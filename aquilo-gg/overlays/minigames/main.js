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
  const slots   = card.querySelector('.slots');
  const reels   = [$('reel0'), $('reel1'), $('reel2')];
  const rps     = card.querySelector('.rps');
  const roulette = card.querySelector('.roulette');
  const heist   = card.querySelector('.heist');
  const heistFill  = $('heist-fill');
  const heistText  = $('heist-text');
  const heistCount = $('heist-count');
  const heistTime  = $('heist-time');
  const userEl  = $('user');
  const wagerEl = $('wager');
  const outcome = $('outcome');

  // Default symbol pool — always-available Twitch global emotes. Used
  // when the bus payload doesn't supply a `pool` array, so the overlay
  // has visual filler during the spin animation. Streamer can override
  // by configuring Bolts → Slots image pool in Loadout settings; the
  // chosen pool ships with each event so this is just the floor.
  // Each entry can be a URL (rendered as <img>) or any text/emoji
  // (rendered as inline text). Detection is heuristic: URLs start with
  // http(s):// or contain a "/" and a known image extension.
  const defaultPool = [
    'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0',         // Kappa
    'https://static-cdn.jtvnw.net/emoticons/v2/86/default/dark/2.0',         // BibleThump
    'https://static-cdn.jtvnw.net/emoticons/v2/354/default/dark/2.0',        // 4Head
    'https://static-cdn.jtvnw.net/emoticons/v2/245/default/dark/2.0',        // ResidentSleeper
    'https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/2.0',     // LUL
    'https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/2.0'   // PogChamp
  ];

  function isUrl(s) {
    if (!s) return false;
    return /^https?:\/\//i.test(s) || /^\/\//.test(s);
  }
  function setReelSymbol(reel, sym) {
    if (isUrl(sym)) {
      // Reuse an existing <img> if present so we don't thrash the DOM
      // every spin frame; otherwise insert one.
      var img = reel.firstElementChild;
      if (!img || img.tagName !== 'IMG') {
        reel.innerHTML = '';
        img = document.createElement('img');
        img.alt = '';
        reel.appendChild(img);
      }
      img.src = sym;
    } else {
      // Text / emoji mode. Drop any image; use a span we can scale
      // independently so emojis fill the reel like images do.
      var span = reel.firstElementChild;
      if (!span || span.tagName !== 'SPAN') {
        reel.innerHTML = '';
        span = document.createElement('span');
        span.className = 'reel-glyph';
        reel.appendChild(span);
      }
      span.textContent = sym;
    }
  }

  let hideTimer  = null;
  let pulseTimer = null;
  let slotsTimer = null;
  let heistTimer = null;
  let heistDeadline = 0;
  let heistTarget   = 0;

  function resetVisuals() {
    coin.classList.remove('show');
    die.classList.remove('show');
    slots.classList.remove('show');
    if (rps)      rps.classList.remove('show');
    if (roulette) roulette.classList.remove('show', 'spinning');
    if (heist)    heist.classList.remove('show', 'spinning', 'success', 'failure');
    if (heistTimer) { clearInterval(heistTimer); heistTimer = null; }
    coin.classList.remove('flipping', 'show-heads', 'show-tails');
    // Strip every land-* class so the next roll's land-N is the only one
    // active (otherwise the previous roll's settle transform leaks in).
    die.classList.remove('rolling', 'land-1', 'land-2', 'land-3', 'land-4', 'land-5', 'land-6');
    reels.forEach(r => r.classList.remove('spinning', 'locked'));
    card.classList.remove('win', 'lose', 'pulse');
    // Clear lever state so back-to-back !slots events don't leave the
    // arm half-rotated when the previous run's spring-back hadn't
    // finished yet.
    var lever = $('lever');
    if (lever) lever.classList.remove('pulling');
    // Reset RPS sides so the previous run's win/lose tinting doesn't
    // bleed into the next match.
    if (rps) {
      rps.querySelectorAll('.rps-side').forEach(function (el) {
        el.classList.remove('shaking', 'win', 'lose');
      });
    }
    if (roulette) {
      var pocketEl = $('roulette-pocket');
      if (pocketEl) pocketEl.classList.remove('shown');
    }
    if (slotsTimer) { clearTimeout(slotsTimer); slotsTimer = null; }
  }

  function showCoin(result, won, user, wager, payout) {
    resetVisuals();
    // Two-frame swap to (re)kick the keyframe animation when this fires
    // back-to-back. Without the offsetWidth read the second add-class
    // collapses with the first remove-class and produces no flip.
    coin.classList.add('show');
    void coin.offsetWidth;
    coin.classList.add('flipping', result === 'tails' ? 'show-tails' : 'show-heads');
    fillLines(user, wager, won, payout, 'flipped ' + (result || ''));
    schedulePulse();
  }

  function showDie(rolled, target, won, user, wager, payout) {
    resetVisuals();
    // Clamp to 1..6; default to 1 if missing/invalid (the visual still
    // needs to land on a face). The result text shows whatever was
    // actually rolled even if out-of-range.
    var face = parseInt(rolled, 10);
    if (!(face >= 1 && face <= 6)) face = 1;
    die.classList.add('show', 'land-' + face);
    void die.offsetWidth;
    die.classList.add('rolling');
    fillLines(user, wager, won, payout,
      'rolled ' + (rolled || '?') + (target ? ' (target ' + target + ')' : ''));
    schedulePulse();
  }

  // Slots: 3 reels, each spins independently then locks onto its result
  // image with a staggered delay (left → middle → right). During the
  // spin we cycle a random sequence of images from the pool so it
  // *looks* like a real slot machine rather than 3 still frames.
  function showSlots(reelImgs, won, user, wager, payout, pool) {
    resetVisuals();
    slots.classList.add('show');

    var symbols = (pool && pool.length ? pool : null)
                  || (reelImgs && reelImgs.length ? reelImgs : null)
                  || defaultPool;

    // Lever pull — happens BEFORE the reels start spinning so the
    // visual reads as "pull → spin → settle" in that order. CSS
    // animation runs ~260ms down + ~350ms spring-back, but we kick
    // the spin off as soon as the down-stroke peaks (260ms) so the
    // reels are already cycling while the knob rebounds.
    var lever = $('lever');
    if (lever) {
      // Use rAF + setTimeout combo so the .pulling class re-applies
      // even if showSlots fired back-to-back (the previous pull's
      // class was just removed; without rAF the class-add would
      // collapse with the class-remove and produce no transition).
      lever.classList.remove('pulling');
      void lever.offsetWidth;
      lever.classList.add('pulling');
      setTimeout(function () { if (lever) lever.classList.remove('pulling'); }, 260);
    }

    // Defer the reel-spin start so the lever's down-stroke lands first.
    // Settle times are now relative-to-spin-start; total slots
    // sequence reads as: pull (0-260ms) → spin (260ms-1960ms) →
    // pulse (1960ms).
    var SPIN_START = 260;
    setTimeout(function () { startSlotSpin(reelImgs, won, user, wager, payout, symbols); }, SPIN_START);
    fillLines(user, wager, won, payout, won ? 'JACKPOT!' : 'spinning the reels');
    // Pulse times with the third reel landing.
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(function () {
      card.classList.remove('pulse');
      void card.offsetWidth;
      card.classList.add('pulse');
    }, SPIN_START + 1700);
  }

  // Reel-spin half of the slots sequence. Split out from showSlots so
  // the lever pull can fire first and these reels start once the lever
  // bottoms out.
  function startSlotSpin(reelImgs, won, user, wager, payout, symbols) {
    var cyclers = reels.map(function (reel) {
      reel.classList.add('spinning');
      setReelSymbol(reel, symbols[Math.floor(Math.random() * symbols.length)]);
      return setInterval(function () {
        setReelSymbol(reel, symbols[Math.floor(Math.random() * symbols.length)]);
      }, 90);
    });

    var match = (reelImgs && reelImgs.length === 3 && reelImgs[0] && reelImgs[1] && reelImgs[2]);
    var settleTimes = [900, 1300, 1700];   // staggered settle per reel

    settleTimes.forEach(function (t, i) {
      setTimeout(function () {
        clearInterval(cyclers[i]);
        if (match) setReelSymbol(reels[i], reelImgs[i]);
        reels[i].classList.remove('spinning');
        reels[i].classList.add('locked');
      }, t);
    });

    // Override the auto-hide so the streamer / viewer can savor the result.
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { card.classList.add('hidden'); }, 4500);
  }

  // Rock / paper / scissors: shake both sides for ~700ms, swap glyphs to
  // the actual picks, then tint the winning side. Tie shows a draw line.
  function showRps(viewer, bot, outcome, won, user, wager, payout) {
    resetVisuals();
    if (!rps) return;
    card.classList.remove('hidden');
    rps.classList.add('show');
    var viewerEl = $('rps-viewer');
    var botEl    = $('rps-bot');
    var sides    = rps.querySelectorAll('.rps-side');

    // Pre-shake glyph is always rock — the reveal happens after the
    // shake animation lands so the viewer "sees" the throw.
    if (viewerEl) viewerEl.textContent = '✊';
    if (botEl)    botEl.textContent    = '✊';
    sides.forEach(function (el) { el.classList.add('shaking'); });
    fillLines(user, wager, won, payout, 'rock... paper... scissors');

    setTimeout(function () {
      sides.forEach(function (el) { el.classList.remove('shaking'); });
      if (viewerEl) viewerEl.textContent = rpsGlyph(viewer);
      if (botEl)    botEl.textContent    = rpsGlyph(bot);
      if (outcome === 'win') {
        sides[0].classList.add('win');
        sides[2].classList.add('lose');
      } else if (outcome === 'loss') {
        sides[0].classList.add('lose');
        sides[2].classList.add('win');
      }
      // Update the lines now that we know the result.
      fillLines(user, wager, won, payout,
        outcome === 'win'  ? 'WINS RPS' :
        outcome === 'loss' ? 'loses RPS' :
                              'ties RPS');
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(function () {
        card.classList.remove('pulse');
        void card.offsetWidth;
        card.classList.add('pulse');
      }, 50);
    }, 700);

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { card.classList.add('hidden'); }, 4500);
  }
  function rpsGlyph(c) {
    return c === 'rock'     ? '✊' :
           c === 'paper'    ? '✋' :
           c === 'scissors' ? '✌' : '?';
  }

  // Roulette: spin the wheel + counter-rotating ball for ~2.4s, then
  // reveal the winning pocket number tinted by colour. CSS handles
  // the actual rotation; we just toggle classes + set the pocket text.
  function showRoulette(pick, pocket, resultColor, won, user, wager, payout) {
    resetVisuals();
    if (!roulette) return;
    card.classList.remove('hidden');
    roulette.classList.add('show');
    var pocketEl = $('roulette-pocket');
    if (pocketEl) {
      pocketEl.textContent = String(pocket);
      pocketEl.dataset.color = resultColor;
      pocketEl.classList.remove('shown');
    }
    // Two-frame swap to (re)kick the spin animation when this fires
    // back-to-back without a hide cycle.
    void roulette.offsetWidth;
    roulette.classList.add('spinning');

    fillLines(user, wager, won, payout, 'placing bet on ' + pick + '...');

    setTimeout(function () {
      if (pocketEl) pocketEl.classList.add('shown');
      fillLines(user, wager, won, payout, 'landed on ' + resultColor + ' ' + pocket);
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(function () {
        card.classList.remove('pulse');
        void card.offsetWidth;
        card.classList.add('pulse');
      }, 50);
    }, 2400);

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { card.classList.add('hidden'); }, 5500);
  }

  // ── Heist ──────────────────────────────────────────────────────────
  // Three states: open (joining), success, failure. The card stays open
  // for the full join window — we don't hide it until the deadline +
  // a celebration buffer. setHeistMeter is called both on `start` and
  // `contribute` to redraw the fill bar against the current target.
  function setHeistMeter(totalPot, target) {
    var pct = target > 0 ? Math.max(0, Math.min(100, (totalPot / target) * 100)) : 0;
    if (heistFill) heistFill.style.width = pct.toFixed(1) + '%';
    if (heistText) heistText.textContent = (totalPot || 0) + ' / ' + (target || 0) + ' ⚡';
    heistTarget = target;
  }
  function fmtHeistTime(ms) {
    if (ms <= 0) return '0s';
    var s = Math.ceil(ms / 1000);
    return s + 's';
  }
  function tickHeistCountdown() {
    if (!heistTime) return;
    heistTime.textContent = fmtHeistTime(heistDeadline - Date.now());
  }
  function startHeistCountdown(ms) {
    heistDeadline = Date.now() + Math.max(0, ms || 0);
    if (heistTimer) clearInterval(heistTimer);
    heistTimer = setInterval(tickHeistCountdown, 250);
    tickHeistCountdown();
  }
  function showHeistStart(d) {
    resetVisuals();
    if (!heist) return;
    card.classList.remove('hidden');
    heist.classList.add('show', 'spinning');
    setHeistMeter(d.totalPot || d.stake || 0, d.target || 0);
    if (heistCount) heistCount.textContent = '1';
    startHeistCountdown(d.deadlineMs || 60000);
    fillLines(d.initiator, d.stake, false, 0, 'pulled a heist! crew up with !join');
    // Re-style the lines bottom-row — heist starts with no win/lose so
    // we strip the loss tint that fillLines applies by default.
    outcome.classList.remove('lose');
    outcome.textContent = 'JOIN THE CREW';
    outcome.classList.remove('win');
    card.classList.remove('win', 'lose');
    if (hideTimer) clearTimeout(hideTimer);
    // Auto-hide if no settle event lands — defense in depth so a dropped
    // bus connection can't pin the overlay forever.
    hideTimer = setTimeout(function () {
      card.classList.add('hidden');
      if (heistTimer) { clearInterval(heistTimer); heistTimer = null; }
    }, (d.deadlineMs || 60000) + 8000);
  }
  function showHeistContribute(d) {
    if (!heist || !heist.classList.contains('show')) return;     // contribute without start = ignore
    setHeistMeter(d.totalPot || 0, d.target || heistTarget);
    if (heistCount) heistCount.textContent = String(d.contributors || 1);
    // Brief flash on the meter to signal an incoming contribution.
    if (heistFill) {
      heistFill.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,.4), 0 0 18px rgba(240,180,41,.85)';
      setTimeout(function () { if (heistFill) heistFill.style.boxShadow = ''; }, 260);
    }
    fillLines(d.initiator || '', '', false, 0,
      (d.user || 'someone') + ' joined +' + (d.stake || 0) + ' ⚡');
    outcome.textContent = 'POT ' + (d.totalPot || 0) + ' / ' + (d.target || heistTarget);
  }
  function showHeistSuccess(d) {
    if (!heist) return;
    if (!heist.classList.contains('show')) heist.classList.add('show');
    heist.classList.remove('spinning');
    heist.classList.add('success');
    if (heistTimer) { clearInterval(heistTimer); heistTimer = null; }
    if (heistTime) heistTime.textContent = '✓';
    setHeistMeter(d.totalPot || heistTarget, d.target || heistTarget);
    card.classList.remove('lose');
    card.classList.add('win');
    fillLines(d.initiator || '', '', true, d.payout,
      'HEIST SUCCESS! crew of ' + (d.contributors || 0) + ' splits ' + (d.payout || 0) + ' ⚡');
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(function () {
      card.classList.remove('pulse');
      void card.offsetWidth;
      card.classList.add('pulse');
    }, 50);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { card.classList.add('hidden'); }, 6500);
  }
  function showHeistFailure(d) {
    if (!heist) return;
    if (!heist.classList.contains('show')) heist.classList.add('show');
    heist.classList.remove('spinning');
    heist.classList.add('failure');
    if (heistTimer) { clearInterval(heistTimer); heistTimer = null; }
    if (heistTime) heistTime.textContent = '✗';
    setHeistMeter(d.totalPot || 0, d.target || heistTarget);
    card.classList.remove('win');
    card.classList.add('lose');
    fillLines(d.initiator || '', '', false, 0,
      'HEIST FAILED — pot ' + (d.totalPot || 0) + '/' + (d.target || heistTarget));
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(function () {
      card.classList.remove('pulse');
      void card.offsetWidth;
      card.classList.add('pulse');
    }, 50);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { card.classList.add('hidden'); }, 5500);
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
      case 'bolts.minigame.slots':
        showSlots(d.reels, !!d.won, d.user, d.wager, d.payout, d.pool);
        break;
      case 'bolts.minigame.rps':
        showRps(d.viewer, d.bot, d.outcome, d.outcome === 'win', d.user, d.wager, d.payout);
        break;
      case 'bolts.minigame.roulette':
        showRoulette(d.pick, d.pocket, d.resultColor, !!d.won, d.user, d.wager, d.payout);
        break;
      case 'bolts.heist.start':      showHeistStart(d); break;
      case 'bolts.heist.contribute': showHeistContribute(d); break;
      case 'bolts.heist.success':    showHeistSuccess(d); break;
      case 'bolts.heist.failure':    showHeistFailure(d); break;
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
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['bolts.minigame.*', 'bolts.heist.*'] }));
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
