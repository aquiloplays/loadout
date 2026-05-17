/*
 * Loadout — vertical-stream overlay client.
 *
 * Subscribes to the same bus events the compact overlay does
 * (bolts.* / welcome.* / hypetrain.* / counter.* / minigame.* /
 * heist.* / tips.* / achievements / quests). Routes each event into
 * the active mode's renderer:
 *
 *   tile   : single floating card, fade in → hold → fade out
 *   banner : single slim band, crossfade between events
 *   side   : stack of recent events, oldest fades out
 *
 * Idle behaviour:
 *   tile   : show a quiet "Loadout" pill in the corner
 *   banner : keep the last event visible until the next lands
 *   side   : just stop adding cards; existing cards age out naturally
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';

  // Resolve mode + position with sane fallbacks. If the streamer passes
  // a pos that doesn't match the mode (e.g. mode=banner pos=tl), snap
  // to the mode's default pos so the overlay still lands somewhere
  // reasonable instead of being invisible.
  const mode = (params.get('mode') || 'tile').toLowerCase();
  let pos = (params.get('pos') || '').toLowerCase();
  const defaultPos = {
    tile:   'br',
    banner: 'tc',
    side:   'rc'
  };
  const validPos = {
    tile:   ['tl', 'tr', 'bl', 'br'],
    banner: ['tc', 'bc'],
    side:   ['lc', 'rc']
  };
  if (!validPos[mode]) {
    // Unknown mode — fall back to tile so OBS still renders something.
    document.body.dataset.mode = 'tile';
  } else {
    document.body.dataset.mode = mode;
    if (!validPos[mode].includes(pos)) pos = defaultPos[mode];
    document.body.dataset.pos = pos;
  }

  const holdMs = Math.max(1500, parseInt(params.get('holdMs') || '3500', 10) || 3500);
  const showFilter = parseShowFilter(params.get('show'));

  // ── Renderers ─────────────────────────────────────────────────────
  const tileCard  = $('tileCard');
  const tileBadge = $('tileBadge');
  const tileTitle = $('tileTitle');
  const tileSub   = $('tileSub');
  const tileIdle  = $('tileIdle');
  const tileIdleText = $('tileIdleText');

  const bannerCard  = $('bannerCard');
  const bannerBadge = $('bannerBadge');
  const bannerTitle = $('bannerTitle');
  const bannerSub   = $('bannerSub');

  const sideList   = $('sideList');
  const sideCountEl = $('sideCount');

  let tileTimer = null;
  let bannerSeenAnyEvent = false;
  let sideTotalCount = 0;

  // Reset the tone-* class on a card. Idempotent — strip every tone
  // we know about then add the new one.
  const TONES = ['bolts', 'welcome', 'counter', 'streak', 'hype', 'win', 'lose'];
  function setTone(el, tone) {
    if (!el) return;
    TONES.forEach(t => el.classList.remove('tone-' + t));
    if (tone && TONES.includes(tone)) el.classList.add('tone-' + tone);
  }

  function showTile(evt) {
    if (!tileCard) return;
    setTone(tileCard, evt.tone);
    tileBadge.textContent = evt.badge || '⚡';
    tileTitle.textContent = evt.title || '';
    tileSub.textContent   = evt.sub   || '';
    tileCard.classList.remove('hidden');
    if (tileTimer) clearTimeout(tileTimer);
    tileTimer = setTimeout(() => tileCard.classList.add('hidden'), holdMs);
  }

  function showBanner(evt) {
    if (!bannerCard) return;
    setTone(bannerCard, evt.tone);
    bannerBadge.textContent = evt.badge || '⚡';
    bannerTitle.textContent = evt.title || '';
    bannerSub.textContent   = evt.sub   || '';
    // Re-trigger the pop animation so back-to-back events visibly land.
    bannerCard.classList.remove('popped');
    void bannerCard.offsetWidth;
    bannerCard.classList.add('popped');
    bannerSeenAnyEvent = true;
  }

  // Max simultaneously-visible side cards. Newer ones push older down,
  // 5+ get pruned. Aging is encoded as data-age=1..3 so the CSS
  // fade-out reads as gradual rather than abrupt.
  const SIDE_MAX = 8;
  function appendSide(evt) {
    if (!sideList) return;
    const card = document.createElement('div');
    card.className = 'side-card';
    if (evt.tone) card.classList.add('tone-' + evt.tone);

    const badge = document.createElement('span');
    badge.className = 'side-card-badge';
    badge.textContent = evt.badge || '⚡';

    const text = document.createElement('div');
    text.className = 'side-card-text';
    const title = document.createElement('span');
    title.className = 'side-card-title';
    title.textContent = evt.title || '';
    const sub = document.createElement('span');
    sub.className = 'side-card-sub';
    sub.textContent = evt.sub || '';
    text.appendChild(title);
    text.appendChild(sub);

    card.appendChild(badge);
    card.appendChild(text);
    sideList.insertBefore(card, sideList.firstChild);

    // Prune past max.
    while (sideList.children.length > SIDE_MAX) {
      sideList.removeChild(sideList.lastChild);
    }
    // Update ages so the fade-out lands cleanly. Index 0 = newest.
    Array.from(sideList.children).forEach((el, i) => {
      if (i === 0)      el.removeAttribute('data-age');
      else if (i <= 3)  el.setAttribute('data-age', String(i));
      else              el.setAttribute('data-age', '4');
    });
    sideTotalCount++;
    if (sideCountEl) sideCountEl.textContent = String(sideTotalCount);
  }

  function render(evt) {
    if (!evt) return;
    if (showFilter && !showFilter.has(evt.kind)) return;
    if (mode === 'tile')   showTile(evt);
    else if (mode === 'banner') showBanner(evt);
    else if (mode === 'side')   appendSide(evt);
  }

  // ── Event mapping ─────────────────────────────────────────────────
  // Translate bus events into the {tone, badge, title, sub, kind}
  // shape the renderers consume. Keep the title under ~20 chars when
  // possible — the tile/banner modes can clip. Side mode tolerates
  // more because the card wraps.
  function fromBus(msg) {
    if (!msg || !msg.kind) return null;
    const d = msg.data || {};
    // Loadout runs two hype trains; only surface the cross-platform
    // ("all") one here so a Twitch-only train doesn't double the
    // vertical overlay's hype cards. Events with no source = "all".
    if (msg.kind.indexOf('hypetrain.') === 0 &&
        (d.source || 'all').toLowerCase() !== 'all') return null;
    switch (msg.kind) {
      case 'bolts.earned':
        if (!d.user || !d.amount) return null;
        return { kind: 'bolts.earned',  tone: 'bolts',  badge: '⚡', title: d.user, sub: '+' + d.amount + ' bolts' };
      case 'bolts.gifted':
        if (!d.from || !d.to) return null;
        return { kind: 'bolts.gifted',  tone: 'bolts',  badge: '🎁', title: d.from + '→' + d.to, sub: '+' + (d.amount || 0) + ' bolts' };
      case 'bolts.streak':
        if (!d.user || (d.streakDays || 0) < 2) return null;
        return { kind: 'bolts.streak',  tone: 'streak', badge: '🔥', title: d.user, sub: (d.streakDays || 0) + '-day streak' };
      case 'bolts.rain':
        return { kind: 'bolts.rain',    tone: 'bolts',  badge: '💧', title: 'Bolt rain', sub: ((d.recipients && d.recipients.length) || '?') + ' showered' };
      case 'bolts.leaderboard': {
        const top = (d.top || []);
        if (top.length === 0) return null;
        return { kind: 'bolts.leaderboard', tone: 'bolts', badge: '🏆', title: 'Top: ' + (top[0].handle || '?'), sub: (top[0].balance || 0) + ' bolts' };
      }
      case 'welcome.fired':
        if (!d.user) return null;
        return { kind: 'welcome.fired', tone: 'welcome', badge: '👋', title: d.user, sub: d.rendered || 'welcome' };
      case 'counter.updated':
        if (!d.name) return null;
        return { kind: 'counter.updated', tone: 'counter', badge: '#', title: (d.display || d.name), sub: (d.value != null ? String(d.value) : '?') };
      case 'hypetrain.start':
        return { kind: 'hypetrain.start', tone: 'hype', badge: '🚂', title: 'Hype train!', sub: 'level ' + (d.level || 1) };
      case 'hypetrain.contribute':
        if (!d.user) return null;
        return { kind: 'hypetrain.contribute', tone: 'hype', badge: '🚂', title: d.user, sub: '+' + (d.fuel || 0) + ' fuel' };
      case 'hypetrain.level':
        return { kind: 'hypetrain.level', tone: 'hype', badge: '🚀', title: 'Level ' + (d.level || 0) + '!', sub: 'hype train' };
      case 'hypetrain.end':
        return { kind: 'hypetrain.end', tone: 'hype', badge: '🛑', title: 'Train ended', sub: 'final lv ' + (d.finalLevel || 0) };
      case 'bolts.minigame.coinflip':
        if (!d.user) return null;
        return { kind: 'bolts.minigame.coinflip', tone: d.won ? 'win' : 'lose', badge: '🪙', title: d.user, sub: '!coinflip ' + Math.abs(d.payout || d.wager || 0) + ' ⚡' };
      case 'bolts.minigame.dice':
        if (!d.user) return null;
        return { kind: 'bolts.minigame.dice', tone: d.won ? 'win' : 'lose', badge: '🎲', title: d.user, sub: '!dice ' + Math.abs(d.payout || d.wager || 0) + ' ⚡' };
      case 'bolts.minigame.slots':
        if (!d.user) return null;
        return { kind: 'bolts.minigame.slots', tone: d.won ? 'win' : 'lose', badge: '🎰', title: d.user, sub: '!slots ' + Math.abs(d.payout || d.wager || 0) + ' ⚡' };
      case 'bolts.minigame.rps':
        if (!d.user) return null;
        return { kind: 'bolts.minigame.rps', tone: d.outcome === 'win' ? 'win' : (d.outcome === 'loss' ? 'lose' : 'bolts'), badge: '✊', title: d.user, sub: '!rps ' + (d.outcome || '-') };
      case 'bolts.minigame.roulette':
        if (!d.user) return null;
        return { kind: 'bolts.minigame.roulette', tone: d.won ? 'win' : 'lose', badge: '🎡', title: d.user, sub: '!roulette ' + (d.resultColor || '-') };
      case 'bolts.heist.start':
        return { kind: 'bolts.heist.start', tone: 'counter', badge: '🦹', title: (d.initiator || 'someone') + ' heist', sub: 'pot ' + (d.totalPot || 0) + '/' + (d.target || 0) };
      case 'bolts.heist.success':
        return { kind: 'bolts.heist.success', tone: 'win', badge: '💰', title: 'HEIST WON', sub: '+' + (d.payout || 0) + ' ⚡ split' };
      case 'bolts.heist.failure':
        return { kind: 'bolts.heist.failure', tone: 'lose', badge: '🚨', title: 'HEIST FAILED', sub: 'pot ' + (d.totalPot || 0) };
      case 'tips.received':
        if (!(d.amount > 0)) return null;
        return { kind: 'tips.received', tone: 'streak', badge: '💖', title: d.tipper || 'anonymous', sub: '$' + (d.amount || 0).toFixed(2) + (d.bolts ? '  +' + d.bolts + ' ⚡' : '') };
      case 'achievement.unlocked':
        return { kind: 'achievement.unlocked', tone: 'counter', badge: d.glyph || '🏆', title: d.user || 'viewer', sub: '✨ ' + (d.name || 'achievement') };
      case 'quest.completed':
        return { kind: 'quest.completed', tone: 'counter', badge: d.glyph || '🎯', title: d.user || 'viewer', sub: 'quest ' + (d.questName || 'done') };
      case 'viewer.profile.shown':
        if (!d.user) return null;
        return { kind: 'viewer.profile.shown', tone: 'bolts', badge: '🪪', title: d.user, sub: (d.bolts || 0) + ' ⚡' + (d.streakDays ? '  ·  ' + d.streakDays + 'd' : '') };
    }
    return null;
  }

  // ── Idle widget ───────────────────────────────────────────────────
  // Tile mode keeps a quiet pill behind the card. We pull the latest
  // bolts leaderboard top entry as the idle headline so the corner
  // isn't blank between events. Updated whenever bolts.leaderboard
  // fires.
  function updateIdle(top) {
    if (!tileIdleText || !top || top.length === 0) return;
    tileIdleText.textContent = 'TOP ' + (top[0].handle || '?');
  }

  // ── Bus connection ────────────────────────────────────────────────
  let ws = null, backoff = 1000;
  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    try { ws = new WebSocket(url); } catch (e) { return; }

    ws.onopen = () => {
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-vertical' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: [
        'bolts.*', 'welcome.*', 'hypetrain.*', 'counter.*',
        'viewer.profile.shown', 'tips.received',
        'achievement.unlocked', 'quest.completed'
      ] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      try {
        if (msg.kind === 'bolts.leaderboard') updateIdle(msg.data && msg.data.top);
        const evt = fromBus(msg);
        if (evt) render(evt);
      } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => {};
  }

  function parseShowFilter(spec) {
    if (!spec) return null;
    const set = new Set();
    spec.split(',').map(s => s.trim()).filter(Boolean).forEach(s => set.add(s));
    return set.size > 0 ? set : null;
  }

  connect();
})();
