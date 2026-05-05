/*
 * Loadout - Commands rotator overlay client.
 *
 * Subscribes to `commands.list` from the local Aquilo Bus. Loadout publishes
 * the full list of commands viewers can use (built-ins + custom + counter
 * commands + Bolts + clip + check-in) on boot, on settings save, and on
 * any custom-command edit. We cache the latest list and rotate one entry
 * every `rotate` seconds.
 *
 * If the list hasn't arrived yet (Loadout still booting, bus offline,
 * etc.), we show a "Connecting to Loadout..." placeholder. Once we get a
 * list, we never go back to the placeholder - we just keep rotating the
 * last good list. Robust to brief disconnects.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const debug = params.get('debug') === '1';

  // Visual config from URL.
  const pos = params.get('pos');     if (pos) document.body.dataset.pos = pos;
  const theme = params.get('theme'); if (theme) document.body.dataset.theme = theme;
  const showDesc = params.get('showDesc');
  if (showDesc != null) document.body.dataset.showDesc = showDesc;

  const rotateSec = Math.max(2, parseInt(params.get('rotate') || '4', 10));

  // Category include filter. Empty / unset = include all.
  const includeRaw = (params.get('include') || '').toLowerCase();
  const includeSet = includeRaw
    ? new Set(includeRaw.split(',').map(s => s.trim()).filter(Boolean))
    : null;

  // Optional font size scaler. The card sizes are em/px in CSS so this
  // gives the streamer a quick way to fit the card to their canvas density.
  const fontPx = parseInt(params.get('fontSize') || '14', 10);
  if (fontPx >= 10 && fontPx <= 28) document.documentElement.style.fontSize = fontPx + 'px';

  const card  = document.getElementById('card');
  const nameEl = document.getElementById('name');
  const descEl = document.getElementById('desc');
  const badge = document.getElementById('badge');

  // Default fallback list - shown if Loadout never publishes a list (e.g.
  // the streamer copied the URL but hasn't booted Loadout yet). Looks
  // useful instead of broken.
  const fallback = [
    { name: '!uptime',     desc: 'how long the stream has been live',           cat: 'info'  },
    { name: '!followage',  desc: 'how long you have followed',                   cat: 'info'  },
    { name: '!commands',   desc: 'list every command available',                 cat: 'info'  },
    { name: '!so @user',   desc: 'shoutout another streamer',                    cat: 'info'  },
    { name: '!lurk',       desc: 'mark yourself as lurking',                     cat: 'info'  },
    { name: '!quote',      desc: 'pull a saved quote',                           cat: 'info'  },
    { name: '!discord',    desc: 'streamer’s Discord link',                 cat: 'info'  },
  ];

  let commands = fallback.slice();
  let idx = 0;
  let timer = null;
  let usingFallback = true;

  function categorize(c) {
    // Server should send a category, but be defensive in case the field
    // is missing (older Loadout builds, hand-crafted publish, etc.).
    const cat = (c.cat || c.category || '').toLowerCase();
    if (cat) return cat;
    const n = (c.name || '').toLowerCase();
    if (n.startsWith('!bolt') || n === '!gift' || n === '!leaderboard') return 'bolts';
    if (n === '!clip')                                                   return 'clip';
    if (n === '!checkin')                                                return 'checkin';
    return 'info';
  }

  function applyFilter(list) {
    if (!includeSet) return list;
    return list.filter(c => includeSet.has(categorize(c)));
  }

  function show(c) {
    if (!c) return;
    const cat = categorize(c);
    badge.dataset.cat = cat;
    badge.textContent = badgeLabel(cat);
    nameEl.textContent = c.name || '';
    descEl.textContent = c.desc || c.description || '';

    // Replay the swap animation on the card by toggling the class.
    card.classList.remove('swap');
    void card.offsetWidth; // force reflow so the next add re-fires the keyframe
    card.classList.add('swap');
  }

  function badgeLabel(cat) {
    switch (cat) {
      case 'custom':  return 'CMD';
      case 'counter': return '#';
      case 'bolts':   return '⚡';   // lightning
      case 'clip':    return 'CLP';
      case 'checkin': return 'CHK';
      case 'mod':     return 'MOD';
      default:        return 'CMD';
    }
  }

  function tick() {
    const visible = applyFilter(commands);
    if (visible.length === 0) {
      // Filter excluded everything - keep something on screen.
      show({ name: '!commands', desc: 'list every command available', cat: 'info' });
      return;
    }
    show(visible[idx % visible.length]);
    idx++;
  }

  function start() {
    if (timer) clearInterval(timer);
    tick();
    timer = setInterval(tick, rotateSec * 1000);
  }

  function ingestList(payload) {
    if (!payload || !Array.isArray(payload.commands)) return;
    if (payload.commands.length === 0) return; // server sent empty - keep what we have
    commands = payload.commands.map(c => ({
      name: c.name,
      desc: c.desc || c.description || '',
      cat:  (c.cat || c.category || '').toLowerCase()
    })).filter(c => c.name);
    if (commands.length === 0) return;
    usingFallback = false;
    idx = 0;
    start();
  }

  // ---------------- Bus connection ----------------
  let ws = null;
  let backoff = 1000;

  function connect() {
    let url = busUrl;
    if (secret && !url.includes('secret=')) {
      url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
    }
    setStatus('connecting...');
    try { ws = new WebSocket(url); }
    catch (e) { setStatus('bad URL: ' + e.message); return; }

    ws.onopen = () => {
      setStatus('connected');
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-commands' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['commands.list'] }));
      // Politely ask for a fresh snapshot. Server may or may not honor; if
      // it doesn't, we'll get one on the next save.
      ws.send(JSON.stringify({ v: 1, kind: 'commands.requestList' }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || msg.kind !== 'commands.list') return;
      ingestList(msg.data);
    };
    ws.onclose = () => {
      setStatus('disconnected, retrying in ' + Math.round(backoff/1000) + 's');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => setStatus('error');
  }

  function setStatus(text) {
    if (!debug) return;
    let el = document.getElementById('devStatus');
    if (!el) { el = document.createElement('div'); el.id = 'devStatus'; el.className = 'dev-status'; document.body.appendChild(el); }
    el.textContent = 'bus: ' + text + (usingFallback ? ' [fallback list]' : '');
  }

  // Kick off rotation immediately with the fallback list, replace once
  // the bus delivers a real one.
  start();
  connect();
})();
