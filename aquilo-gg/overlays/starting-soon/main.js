/*
 * aquilo.gg — Starting Soon overlay.
 *
 * Responsibilities (no countdown, no marquee — premium polish pass):
 *   - Orientation switch. ?orientation= overrides; otherwise the
 *     viewport's aspect ratio decides.
 *   - Headline letter rendering (so an overridden title still gets
 *     the per-letter gradient + wave-free shimmer).
 *   - Demo reel: preload every iframe at boot, scale each fixed-
 *     design iframe to fit its slide screen, cycle slides on a
 *     per-slide DWELL clock with a clean cross-fade.
 *   - Drifting bolt particles with depth (smaller = slower = blurrier).
 *   - Tonight chip fed from aquilo.gg/api/schedule (`nextStream.label`).
 *   - Optional Aquilo Bus live config swap, compatible with the
 *     lobby overlay's `lobby.config` event kind.
 *
 * Vanilla JS only — runs inside OBS's CEF without a build step,
 * same convention as every other overlay in this folder.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  // ── Orientation ──────────────────────────────────────────────
  const orientParam = (params.get('orientation') || '').toLowerCase();
  let orientation = 'horizontal';
  if (orientParam === 'vertical' || orientParam === 'portrait') {
    orientation = 'vertical';
  } else if (orientParam === 'horizontal' || orientParam === 'landscape') {
    orientation = 'horizontal';
  } else if (params.get('vertical') === '1') {
    orientation = 'vertical';
  } else if (window.innerHeight > window.innerWidth) {
    orientation = 'vertical';
  }
  document.body.setAttribute('data-orientation', orientation);

  // ── Headline render ─────────────────────────────────────────
  const headlineText = $('headline-text');
  const customTitle = params.get('title');
  if (customTitle) renderHeadline(customTitle.toUpperCase());

  function renderHeadline(text) {
    headlineText.innerHTML = '';
    for (const ch of text) {
      const span = document.createElement('span');
      if (ch === ' ') {
        span.className = 'headline-gap';
        span.textContent = ' ';
      } else {
        span.textContent = ch;
      }
      headlineText.appendChild(span);
    }
  }

  // ── Kicker / tonight chip ───────────────────────────────────
  // Kicker copy is FIXED (per stream brief): "Get free streaming
  // tools at aquilo.gg, join our community!" The schedule-derived
  // show name only populates the Tonight chip below; we don't
  // touch the kicker on schedule resolution anymore.
  const KICKER_DEFAULT = 'Get free streaming tools at aquilo.gg, join our community!';
  const kickerEl       = $('kicker');
  const tonightEl      = $('tonight');
  const tonightLabelEl = $('tonight-label');
  function setKicker(text) { if (kickerEl) kickerEl.textContent = text || KICKER_DEFAULT; }
  function setTonight(label) {
    if (!tonightLabelEl || !tonightEl) return;
    if (!label) { tonightEl.hidden = true; return; }
    tonightLabelEl.textContent = label;
    tonightEl.hidden = false;
  }
  // Ensure the default kicker shows on first paint (covers the
  // case where loadSchedule's fallback path isn't taken).
  setKicker(KICKER_DEFAULT);

  // ── Schedule fetch ──────────────────────────────────────────
  const skipSchedule  = params.get('schedule') === '0';
  const demo          = params.get('demo') === '1';
  const manualSubtitle = params.get('subtitle');

  async function loadSchedule() {
    if (skipSchedule) { applyManualOrDefault(); return; }
    try {
      const res = await fetch('https://aquilo.gg/api/schedule', {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) throw new Error('schedule ' + res.status);
      const data = await res.json();
      const next = data && data.nextStream;
      const label = manualSubtitle || (next && next.label) || '';
      if (label) setTonight(label);
    } catch (err) {
      console.warn('[starting-soon] schedule fetch failed:', err);
      applyManualOrDefault();
    }
  }
  function applyManualOrDefault() {
    if (manualSubtitle) setTonight(manualSubtitle);
    else if (demo)      setTonight('Featured Run');
  }
  loadSchedule();

  // ════════════════════════════════════════════════════════════
  // Live chat-bubble stream
  // ════════════════════════════════════════════════════════════
  // Replaces the earlier bolt particles. Every incoming chat message
  // (from Streamer.bot, or the Aquilo Bus, or demo mode) spawns a
  // glass bubble that drifts up from the bottom with depth-of-field
  // (smaller bubbles slower + blurrier + dimmer). The visible cap
  // keeps a spam burst from carpeting the screen.

  const chatHost = $('chat-stream');
  const CHAT_MAX_VISIBLE = orientation === 'vertical' ? 8 : 12;
  const CHAT_PLATFORM_LABELS = { tw: 'T', yt: 'Y', kk: 'K', tt: '♪' };
  // De-dupe within a short window so a SB-side echo doesn't double-
  // post the same message. Keyed by `<platform>:<user>:<text>`.
  const recentChatKeys = new Map();
  const CHAT_DEDUPE_MS = 4000;

  function pruneOldBubbles() {
    // Remove any bubble that's been around longer than its animation.
    while (chatHost.children.length > CHAT_MAX_VISIBLE) {
      const old = chatHost.firstElementChild;
      if (!old) break;
      old.remove();
    }
  }

  function spawnChatBubble(payload) {
    if (!chatHost) return;
    const text = (payload && payload.message) ? String(payload.message).trim() : '';
    const user = (payload && payload.user)    ? String(payload.user).trim()    : '';
    if (!text || !user) return;
    const platform = String(payload.platform || 'tw').toLowerCase();
    const plat = ['tw','yt','kk','tt'].includes(platform) ? platform : 'tw';

    // Dedupe.
    const key = plat + ':' + user.toLowerCase() + ':' + text.toLowerCase();
    const now = Date.now();
    if (recentChatKeys.has(key) && now - recentChatKeys.get(key) < CHAT_DEDUPE_MS) return;
    recentChatKeys.set(key, now);
    if (recentChatKeys.size > 200) {
      // Sweep stale entries occasionally so the map doesn't grow forever.
      for (const [k, t] of recentChatKeys) {
        if (now - t > CHAT_DEDUPE_MS * 2) recentChatKeys.delete(k);
      }
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.setAttribute('data-plat', plat);

    // Depth-of-field. Smaller depth = farther = slower + dimmer +
    // softer. Bias toward foreground so the chat is readable.
    const depth = 0.4 + Math.random() * 0.6;       // 0.4..1.0
    const fontSize = 12 + depth * 6;               // 12..18px
    const dur   = 22 - depth * 8;                  // 14..22s rise time
    const x     = 8 + Math.random() * 84;          // 8..92% (avoid edges)
    const alpha = 0.55 + depth * 0.35;             // 0.55..0.9
    const soft  = (1 - depth) * 1.4;               // 0..1.4px blur

    bubble.style.setProperty('--font-size', fontSize.toFixed(1) + 'px');
    bubble.style.setProperty('--dur',   dur.toFixed(1) + 's');
    bubble.style.setProperty('--x',     x.toFixed(1) + '%');
    bubble.style.setProperty('--alpha', alpha.toFixed(2));
    bubble.style.setProperty('--soft',  soft.toFixed(2) + 'px');
    bubble.style.setProperty('--depth', depth.toFixed(2));
    if (payload.color) bubble.style.setProperty('--user-color', payload.color);

    const platBadge = document.createElement('span');
    platBadge.className = 'chat-bubble-plat';
    platBadge.textContent = CHAT_PLATFORM_LABELS[plat] || '?';
    bubble.appendChild(platBadge);

    const userEl = document.createElement('span');
    userEl.className = 'chat-bubble-user';
    userEl.textContent = user;
    bubble.appendChild(userEl);

    const msgEl = document.createElement('span');
    msgEl.className = 'chat-bubble-msg';
    // Trim long messages so a single 500-char message doesn't blow
    // out the bubble width. Bubble already truncates with ellipsis
    // via CSS, but a hard cap stops the JS-side text node from
    // doing real work for nothing.
    msgEl.textContent = text.length > 160 ? text.slice(0, 158) + '…' : text;
    bubble.appendChild(msgEl);

    chatHost.appendChild(bubble);
    bubble.addEventListener('animationend', () => bubble.remove(), { once: true });
    pruneOldBubbles();
  }

  // ── Streamer.bot WebSocket connection ────────────────────────
  // SB serves a WebSocket on 127.0.0.1:8080 by default. Handshake:
  //   server → Hello { authentication: { required, salt, challenge } }
  //   client → Authenticate { authentication: <sha256 hash> }  (if required)
  //   server → ok
  //   client → Subscribe { events: { Twitch:['ChatMessage'], ... } }
  // We only need ChatMessage; the dock/sf-direct.js code does the
  // full * subscription, but that's overkill for an ambient overlay.
  //
  // Streamers with non-default SB ports/passwords can override via:
  //   ?sbHost=127.0.0.1  ?sbPort=8080  ?sbPass=secret
  const sbHost = params.get('sbHost') || '127.0.0.1';
  const sbPort = params.get('sbPort') || '8080';
  const sbPass = params.get('sbPass') || '';
  let sbConnected = false;
  let sbBackoff = 1000;
  let sbWs = null;

  function sbAuthenticate(ws, auth) {
    const enc = new TextEncoder();
    const h = (s) => crypto.subtle.digest('SHA-256', enc.encode(s)).then(buf =>
      btoa(String.fromCharCode.apply(null, new Uint8Array(buf))));
    h(sbPass + auth.salt)
      .then(h1 => h(h1 + auth.challenge))
      .then(hash => {
        try { ws.send(JSON.stringify({ request: 'Authenticate', id: 'starting-soon-auth', authentication: hash })); }
        catch { sbSubscribe(ws); }
      })
      .catch(() => sbSubscribe(ws));
  }
  function sbSubscribe(ws) {
    try {
      ws.send(JSON.stringify({
        request: 'Subscribe',
        id: 'starting-soon-sub',
        events: {
          Twitch:  ['ChatMessage'],
          YouTube: ['Message'],
          Kick:    ['ChatMessage'],
        },
      }));
    } catch {}
  }
  function sbParseChat(d) {
    // SB envelope: { event: { source, type }, data: { user, message, ... } }
    if (!d || !d.event || !d.data) return null;
    const src  = String(d.event.source || '').toLowerCase();
    const type = String(d.event.type   || '').toLowerCase();
    if (type !== 'chatmessage' && type !== 'message') return null;
    const plat = src === 'twitch' ? 'tw' : src === 'youtube' ? 'yt' : src === 'kick' ? 'kk' : null;
    if (!plat) return null;
    const data = d.data;
    const u = data.user || {};
    const m = data.message || {};
    return {
      platform: plat,
      user:     u.displayName || u.name || u.login || u.username || 'viewer',
      color:    u.color || null,
      message:  m.message || m.text || data.text || data.content || '',
    };
  }
  function connectSB() {
    if (sbWs) return;
    let ws;
    try { ws = new WebSocket('ws://' + sbHost + ':' + sbPort + '/'); }
    catch { setTimeout(connectSB, sbBackoff); sbBackoff = Math.min(sbBackoff * 1.8, 20000); return; }
    sbWs = ws;
    ws.onopen = () => { sbBackoff = 1000; };
    ws.onmessage = (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      // Handshake handling.
      if (d.request === 'Hello' || (d.event === undefined && d.authentication)) {
        if (d.authentication && d.authentication.required && sbPass) sbAuthenticate(ws, d.authentication);
        else                                                          sbSubscribe(ws);
        return;
      }
      if (d.status === 'ok' && d.id === 'starting-soon-auth') { sbSubscribe(ws); return; }
      if (d.status === 'ok' && d.id === 'starting-soon-sub')  { sbConnected = true; stopDemoChat(); return; }
      // Actual events.
      const env = sbParseChat(d);
      if (env) spawnChatBubble(env);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      sbConnected = false;
      sbWs = null;
      setTimeout(connectSB, sbBackoff);
      sbBackoff = Math.min(sbBackoff * 1.8, 20000);
    };
  }

  // ── Demo chat fallback ───────────────────────────────────────
  // If SB never connects (no SB running, viewing the overlay
  // standalone, etc), synthesize chat every few seconds so the
  // ambient layer is never empty. Stops as soon as a real SB
  // subscription succeeds.
  const DEMO_USERS = [
    { name: 'pixelpaige',   plat: 'tw' },
    { name: 'KaiOnAir',     plat: 'tw' },
    { name: 'JustCallScope',plat: 'tw' },
    { name: 'NeonFalcon',   plat: 'yt' },
    { name: 'sora_42',      plat: 'yt' },
    { name: 'wraith.tv',    plat: 'kk' },
    { name: 'kelpie',       plat: 'tt' },
    { name: 'astra',        plat: 'tt' },
    { name: 'DraconicKing', plat: 'tw' },
    { name: 'forge',        plat: 'tw' },
    { name: 'lyric',        plat: 'yt' },
    { name: 'jett',         plat: 'kk' },
  ];
  const DEMO_MESSAGES = [
    'hyped for tonight',
    'let\'s gooo',
    'first time catching you live!',
    'GLHF',
    'aquilo.gg looks clean',
    'rotation widget is sick',
    'how does the loadout import work?',
    '!sr a banger pls',
    'time to lock in',
    'just got here, what we playing?',
    'loving the overlays',
    'streamfusion dock = chef\'s kiss',
    'subbed via patreon ✓',
    'PogU',
    'KEKW',
    'when does it start',
    'tea + chair, ready',
  ];
  let demoTimer = null;
  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function startDemoChat() {
    if (demoTimer || sbConnected) return;
    const fire = () => {
      if (sbConnected) { stopDemoChat(); return; }
      const u = rand(DEMO_USERS);
      spawnChatBubble({ platform: u.plat, user: u.name, message: rand(DEMO_MESSAGES) });
      demoTimer = setTimeout(fire, 1800 + Math.random() * 2600);
    };
    demoTimer = setTimeout(fire, 800);
  }
  function stopDemoChat() {
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  }

  // Kick off the SB connection. The Aquilo Bus connection at the
  // bottom of this file ALSO funnels chat into spawnChatBubble when
  // it sees `chat.message` events, so a streamer with both bus +
  // SB running gets one bubble per message either way (de-duped by
  // the spawnChatBubble keyed window).
  connectSB();
  // Demo kicks in after 4s if no SB subscription completes — long
  // enough to let a healthy SB handshake finish, short enough that
  // a streamer testing standalone sees activity quickly.
  setTimeout(() => { if (!sbConnected) startDemoChat(); }, 4000);

  // ════════════════════════════════════════════════════════════
  // Demo reel
  // ════════════════════════════════════════════════════════════

  const reel = $('reel');
  const slidesParam = (params.get('slides') || 'streamkey,streamfusion,rotation,loadout,patron')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Per-slide dwell. Streamkey + SF show form/chat UIs that read
  // quickly; rotation gets the longest so its popout can sub-cycle
  // through two layout variants while the SLS2 video plays; loadout
  // gets a calm read for the before/after comparison; patron leaves
  // time to scan all five perks.
  const DWELL = {
    streamkey:     9000,
    streamfusion: 10000,
    rotation:     14000,
    loadout:      11000,
    patron:       12000,
  };
  const order = slidesParam.filter(id => DWELL.hasOwnProperty(id));
  if (order.length === 0) order.push('streamkey');

  // ── Rotation widget URL + preset sub-cycle ──────────────────
  // The rotation widget reads ?sync=<key> to bind to a streamer's
  // own config + Spotify tokens. Clay's sync key is private (it
  // would let anyone tail his rotation), so the starting-soon
  // overlay accepts it as ?spotifySync= on its OWN URL and forwards
  // it here. With no sync key we fall back to ?preview=1 (mocked
  // playback that still looks polished). The popout sub-cycles
  // between layout variants every few seconds during the rotation
  // slide so viewers see the widget's range, not just one look.
  const spotifySync = params.get('spotifySync') || params.get('sync') || '';
  function rotationUrl(variantQs) {
    const base = 'https://widget.aquilo.gg/rotation/widget';
    const qs = spotifySync
      ? ('sync=' + encodeURIComponent(spotifySync) + '&' + variantQs)
      : ('preview=1&' + variantQs);
    return base + '?' + qs;
  }
  // Visible layout variants. Each one is a distinct look:
  //   square    rich card with queue + lyrics
  //   minimal   stripped card, just the now-playing track
  //   compact   queue-only horizontal sliver
  // The widget interprets ?queue= and ?lyrics= as feature toggles
  // (in preview/demo contexts), and the data-fixed-w/h on the
  // popout determines the iframe's design surface so the layout
  // reads at the intended aspect.
  const ROTATION_VARIANTS = [
    { id: 'square',  label: 'layout: square',  qs: 'queue=1&lyrics=1', fw: 540, fh: 320 },
    { id: 'minimal', label: 'layout: minimal', qs: 'queue=0&lyrics=0', fw: 480, fh: 240 },
    { id: 'compact', label: 'layout: compact', qs: 'queue=1&lyrics=0', fw: 640, fh: 200 },
  ];
  const ROTATION_SUB_MS = 5000;
  const rotationIframe   = $('rotation-iframe');
  const rotationPopout   = $('rotation-popout');
  const rotationPresetEl = $('rotation-preset-pill');
  let rotationSubIdx = 0;
  let rotationSubTimer = null;
  function applyRotationVariant(idx) {
    const v = ROTATION_VARIANTS[idx % ROTATION_VARIANTS.length];
    if (!v || !rotationIframe || !rotationPopout) return;
    rotationPopout.setAttribute('data-fixed-w', String(v.fw));
    rotationPopout.setAttribute('data-fixed-h', String(v.fh));
    const newSrc = rotationUrl(v.qs);
    // Only reload the iframe if the URL actually changed — keeps
    // the first variant from re-mounting on every active-slide swap.
    if (rotationIframe.src !== newSrc) rotationIframe.src = newSrc;
    if (rotationPresetEl) rotationPresetEl.textContent = v.label;
    // Re-fit because data-fixed-w/h changed.
    fitOne(rotationPopout);
  }
  function startRotationSub() {
    clearInterval(rotationSubTimer);
    applyRotationVariant(rotationSubIdx);
    rotationSubTimer = setInterval(() => {
      rotationSubIdx = (rotationSubIdx + 1) % ROTATION_VARIANTS.length;
      applyRotationVariant(rotationSubIdx);
    }, ROTATION_SUB_MS);
  }
  function stopRotationSub() {
    clearInterval(rotationSubTimer);
    rotationSubTimer = null;
  }

  // Preload every iframe at boot. data-src -> src so each slide is
  // already animating by the time its turn comes up — no "first
  // frame blank" tax. Same-origin iframes also get a small style
  // injection to hide their own dev/debug badges; cross-origin
  // throws on access, which we swallow (StreamFusion + rotation
  // widget don't surface dev badges anyway).
  function preloadFrames() {
    document.querySelectorAll('iframe.demo-frame[data-src]').forEach(f => {
      const src = f.getAttribute('data-src');
      if (src && !f.src) f.src = src;
      f.addEventListener('load', () => {
        try {
          const doc = f.contentDocument;
          if (!doc) return;
          const style = doc.createElement('style');
          style.textContent = '.dev-status,#devStatus,.dev{display:none!important}';
          doc.head.appendChild(style);
        } catch {
          // cross-origin frame, expected
        }
      }, { once: true });
    });
  }

  // Scale each iframe to fit its container. Container can be a
  // `.slide-screen` (full-slide iframe) or a `.slide-popout` (the
  // rotation widget over the SLS2 video). Both carry data-fixed-w
  // and data-fixed-h with the iframe's natural design size; we
  // scale via transform so the iframe always fits its box without
  // a horizontal/vertical scrollbar.
  function fitOne(el) {
    if (!el) return;
    const fw = parseInt(el.getAttribute('data-fixed-w'), 10) || 0;
    const fh = parseInt(el.getAttribute('data-fixed-h'), 10) || 0;
    const iframe = el.querySelector('iframe.demo-frame');
    if (!fw || !fh || !iframe) return;
    iframe.style.width  = fw + 'px';
    iframe.style.height = fh + 'px';
    iframe.style.transformOrigin = '0 0';
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const s = Math.min(r.width / fw, r.height / fh);
    iframe.style.left = (r.width  / 2 - (fw * s) / 2) + 'px';
    iframe.style.top  = (r.height / 2 - (fh * s) / 2) + 'px';
    iframe.style.transform = `scale(${s.toFixed(4)})`;
  }
  function fitFrames() {
    document.querySelectorAll('[data-fixed-w][data-fixed-h]').forEach(el => {
      fitOne(el);
      new ResizeObserver(() => fitOne(el)).observe(el);
    });
  }

  // Pull the live patron list from the supporter-wall endpoint. CORS
  // is enabled on the worker; if the fetch fails we just show "join
  // now and be first" as a friendly fallback. The endpoint can also
  // return `pending:true` while warming up — we treat that as empty.
  const PATRON_CAP = 12; // visible names; the count line shows the full total
  async function loadPatrons() {
    const gridEl  = $('patron-grid');
    const countEl = $('patron-count');
    if (!gridEl || !countEl) return;
    try {
      const res = await fetch('https://aquilo.gg/api/community/supporter-wall', {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) throw new Error('supporter-wall ' + res.status);
      const data = await res.json();
      const list = Array.isArray(data && data.supporters) ? data.supporters : [];
      renderPatrons(list, gridEl, countEl);
    } catch (err) {
      console.warn('[starting-soon] patron fetch failed:', err);
      renderPatrons([], gridEl, countEl);
    }
  }
  function renderPatrons(list, gridEl, countEl) {
    gridEl.innerHTML = '';
    countEl.textContent = list.length
      ? (list.length + ' patron' + (list.length === 1 ? '' : 's'))
      : 'be the first';
    if (!list.length) {
      const empty = document.createElement('span');
      empty.className = 'patron-pill patron-pill--loading';
      empty.textContent = 'be patron #1 at join.aquilo.gg';
      gridEl.appendChild(empty);
      return;
    }
    list.slice(0, PATRON_CAP).forEach((p, i) => {
      const pill = document.createElement('span');
      pill.className = 'patron-pill';
      // Stagger entrance for a polished cascade.
      pill.style.animationDelay = (i * 40) + 'ms';
      const dot = document.createElement('span');
      dot.className = 'patron-pill-dot';
      const name = document.createElement('span');
      name.textContent = p.username || ('Supporter ' + ((p.discordId || '').slice(-4) || '?'));
      pill.appendChild(dot);
      pill.appendChild(name);
      gridEl.appendChild(pill);
    });
    if (list.length > PATRON_CAP) {
      const more = document.createElement('span');
      more.className = 'patron-pill';
      more.style.animationDelay = (PATRON_CAP * 40) + 'ms';
      more.textContent = '+' + (list.length - PATRON_CAP) + ' more';
      gridEl.appendChild(more);
    }
  }

  // Rotation engine. Sets the [data-active] on the reel root; CSS
  // attribute selectors swap which slide is visible. The dots
  // morph their width via the same data-active.
  let activeIdx = 0;
  let advanceTimer = null;
  function setActive(id) {
    reel.setAttribute('data-active', id);
    if (id === 'rotation') startRotationSub();
    else                   stopRotationSub();
  }
  function advance() {
    activeIdx = (activeIdx + 1) % order.length;
    const next = order[activeIdx];
    setActive(next);
    schedule(DWELL[next] || 10000);
  }
  function schedule(ms) {
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(advance, ms);
  }

  // Click on a dot to jump and reset the dwell timer. Pointer
  // events work in the preview; OBS browser sources are
  // non-interactive by default, so this is purely a dev aid.
  document.querySelectorAll('.reel-dot[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      const idx = order.indexOf(target);
      if (idx < 0) return;
      activeIdx = idx;
      setActive(target);
      schedule(DWELL[target] || 10000);
    });
  });

  // Kick the reel.
  preloadFrames();
  // Initialise the rotation popout with its first variant BEFORE
  // fitFrames runs so the iframe already has a src + the popout
  // has correct data-fixed-w/h to scale against.
  applyRotationVariant(0);
  fitFrames();
  loadPatrons();
  setActive(order[0]);
  schedule(DWELL[order[0]] || 10000);

  // ── Optional Aquilo Bus subscription ────────────────────────
  // Reuses `lobby.config` for live overrides (title, subtitle) and
  // also feeds `chat.message` events into the bubble stream — so
  // streamers running the Loadout DLL get multi-platform chat
  // (TikTok included) even without direct SB / TikFinity wiring.
  // Bus de-dupes against the SB feed via spawnChatBubble's keyed
  // window, so connecting both sources doesn't double-post.
  const busUrl = params.get('bus');
  const secret = params.get('secret') || '';
  if (busUrl) {
    let ws = null, backoff = 1000;
    const connect = () => {
      let url = busUrl;
      if (secret && !url.includes('secret=')) {
        url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
      }
      try { ws = new WebSocket(url); } catch { return; }
      ws.onopen = () => {
        backoff = 1000;
        ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-starting-soon' }));
        ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['lobby.*', 'chat.message'] }));
      };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (!msg || !msg.kind) return;
        if (msg.kind === 'lobby.config') {
          const d = msg.data || {};
          if (typeof d.title    === 'string' && d.title)    renderHeadline(d.title.toUpperCase());
          if (typeof d.subtitle === 'string')               setTonight(d.subtitle);
          return;
        }
        if (msg.kind === 'chat.message') {
          const d = msg.data || {};
          // The Loadout bus normalises chat into a flat shape.
          // Platform aliases: 'twitch' → tw, etc., matching the
          // SB envelope so the bubble styling stays consistent.
          const platMap = { twitch: 'tw', youtube: 'yt', kick: 'kk', tiktok: 'tt' };
          spawnChatBubble({
            platform: platMap[String(d.platform || '').toLowerCase()] || 'tw',
            user:     d.user || d.username || '',
            color:    d.color || null,
            message:  d.text || d.message || '',
          });
          // Bus is live — stop the demo loop and treat the bus as
          // an authoritative source (same as SB).
          sbConnected = true;
          stopDemoChat();
          return;
        }
      };
      ws.onclose = () => {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      ws.onerror = () => {};
    };
    connect();
  }
})();
