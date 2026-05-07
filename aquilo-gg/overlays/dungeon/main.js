/*
 * Loadout — Dungeon Crawler overlay client.
 *
 * Subscribes to dungeon.* and duel.* on the local Aquilo Bus, then
 * orchestrates the four UI states:
 *   idle      — transparent, render nothing
 *   recruit   — !join window with countdown bar + party tiles
 *   adventure — scene log scrolling on the right
 *   loot      — final survivor cards centered
 *   duel      — 1v1 panel with HP bars + scene log between
 *
 * Why a state machine rather than panels-as-CSS-modes: scenes arrive
 * with absolute delayMs offsets from the run start (the DLL builds
 * the whole timeline up-front). We schedule each scene's render with
 * setTimeout so the streamer's chat sees the same cadence regardless
 * of network jitter on the bus.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('root');

  // Recruit panel
  const recruitName = $('recruit-name');
  const recruitCmd  = $('recruit-cmd');
  const recruitBar  = $('recruit-bar');
  const recruitTimer = $('recruit-timer');
  const partyEl = $('party');

  // Adventure panel
  const advName = $('adv-name');
  const scenesEl = $('scenes');

  // Loot panel
  const lootGrid = $('loot-grid');

  // Duel panel
  const duelLname = $('duel-l-name');
  const duelRname = $('duel-r-name');
  const duelLhp = $('duel-l-hp');
  const duelRhp = $('duel-r-hp');
  const duelLog = $('duel-log');
  const duelResult = $('duel-result');

  // ── URL params + bus connection ──────────────────────────────────
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const debug  = params.get('debug') === '1';

  // Streamer-supplied custom assets (drop-in via URL params so the
  // streamer can swap themes per-game / per-stream without restarting
  // OBS):
  //   ?bg=https://...  — background image painted behind every panel.
  //                       Image is centered + cover-fit so any aspect
  //                       ratio works; CSS handles the dim layer.
  //   ?bgOpacity=0..100 — how strong the dim layer is over the image
  //                       (defaults to 50 so panels stay readable on
  //                       a busy background).
  //   ?titleBg=#hex      — hex tint for the recruit / adventure cards
  //                       (overrides the default cyan/blue gradient).
  // Stay in sync with whatever the Settings → Overlays card writes.
  const bgUrl     = params.get('bg') || '';
  const bgOpacity = parseInt(params.get('bgOpacity') || '50', 10);
  if (bgUrl) {
    document.body.style.backgroundImage = 'url(' + JSON.stringify(bgUrl).slice(1, -1).replace(/"/g, '%22') + ')';
    document.body.classList.add('has-custom-bg');
    document.documentElement.style.setProperty('--custom-bg-dim',
      (Math.max(0, Math.min(100, isNaN(bgOpacity) ? 50 : bgOpacity)) / 100).toFixed(2));
  }

  let ws = null;
  let backoff = 1000;

  // ── State ────────────────────────────────────────────────────────
  const party = new Map();   // key -> {user, level, hpMax, hpCurrent, platform}
  let recruitDeadline = 0;
  let recruitTimerHandle = null;
  let pendingScenes = [];    // [setTimeout handle, ...] so we can cancel on reset

  // ── Helpers ──────────────────────────────────────────────────────
  function setState(s) { root.dataset.state = s; }
  function reset() {
    pendingScenes.forEach(h => clearTimeout(h));
    pendingScenes = [];
    if (recruitTimerHandle) { clearInterval(recruitTimerHandle); recruitTimerHandle = null; }
  }
  function partyKey(p) { return ((p.platform||'twitch') + ':' + (p.user||'')).toLowerCase(); }
  function safe(s) { return String(s == null ? '' : s); }
  function initials(u) {
    return (u || '?').replace(/[^\w]/g,'').slice(0,2).toUpperCase() || '?';
  }

  // ── Recruit ──────────────────────────────────────────────────────
  function showRecruit(p) {
    reset();
    party.clear();
    setState('recruit');
    recruitName.textContent = p.dungeonName || 'A dungeon opens...';
    recruitCmd.textContent  = p.joinCommand || '!join';
    partyEl.replaceChildren();
    if (Array.isArray(p.party)) {
      for (const m of p.party) addPartyTile(m);
    }
    recruitDeadline = Date.now() + (p.openSec || 30) * 1000;
    tickRecruit();
    recruitTimerHandle = setInterval(tickRecruit, 250);
  }
  function tickRecruit() {
    const remaining = Math.max(0, recruitDeadline - Date.now());
    const total = (recruitDeadline - (Date.now() - remaining));
    const seconds = Math.ceil(remaining / 1000);
    const pct = remaining / Math.max(1, (total > 0 ? total : 1));
    // Use original openSec * 1000 from the deadline when first set; fall
    // back to a reasonable max so the bar drains predictably.
    const baseTotal = parseInt(recruitTimer.dataset.baseTotalMs || '0', 10);
    const fillPct = baseTotal > 0 ? remaining / baseTotal : pct;
    recruitBar.style.setProperty('--bar-pct', Math.max(0, Math.min(1, fillPct)));
    recruitTimer.textContent = seconds;
    if (remaining <= 0) {
      clearInterval(recruitTimerHandle);
      recruitTimerHandle = null;
    }
  }
  function addPartyTile(m) {
    const key = partyKey(m);
    if (party.has(key)) return;
    party.set(key, m);
    const tile = document.createElement('div');
    tile.className = 'party-tile';
    if (m.className) tile.dataset.cls = m.className;

    // Build the avatar circle. If the viewer set an avatar URL, render
    // it as <img>; otherwise show the class glyph; otherwise fall back
    // to letter initials (the original behaviour). Class tint becomes
    // the ring colour via inline style so we don't need a class-per-
    // archetype rule.
    const av = document.createElement('div');
    av.className = 'pt-avatar';
    if (m.classTint) av.style.setProperty('--ring', m.classTint);
    if (m.avatar) {
      const img = document.createElement('img');
      img.src = m.avatar;
      img.alt = '';
      img.className = 'pt-avatar-img';
      img.addEventListener('error', () => {
        // CDN swap or 404 — drop back to a glyph/initials so the tile
        // never shows a broken-image icon next to the name.
        img.remove();
        av.textContent = m.classGlyph || initials(m.user);
      });
      av.appendChild(img);
    } else {
      av.textContent = m.classGlyph || initials(m.user);
    }

    const name = document.createElement('div');
    name.className = 'pt-name';
    name.textContent = safe(m.user);

    const meta = document.createElement('div');
    meta.className = 'pt-meta';
    const cls = m.className ? (m.className.charAt(0).toUpperCase() + m.className.slice(1) + ' · ') : '';
    meta.textContent = cls + 'Lv ' + (m.level || 1) + ' · ' + (m.hpCurrent || m.hpMax || 25) + ' HP';

    tile.append(av, name, meta);
    partyEl.appendChild(tile);
  }

  // ── Adventure ────────────────────────────────────────────────────
  function showAdventure(p) {
    setState('adventure');
    advName.textContent = p.dungeonName || 'Crypt of Whispers';
    scenesEl.replaceChildren();
  }
  function appendScene(p) {
    // Adventure log only renders 6 most-recent scenes — older ones
    // scroll out of view to keep the panel readable.
    while (scenesEl.children.length >= 6) scenesEl.removeChild(scenesEl.firstChild);
    const line = document.createElement('div');
    line.className = 'scene-line ' + (p.kind || 'story');
    const g = document.createElement('div');
    g.className = 's-glyph';
    g.textContent = p.glyph || '•';
    const t = document.createElement('div');
    t.className = 's-text';
    t.textContent = p.text || '';
    line.append(g, t);
    scenesEl.appendChild(line);
  }
  function scheduleScene(scene) {
    const h = setTimeout(() => appendScene(scene), Math.max(0, scene.delayMs || 0));
    pendingScenes.push(h);
  }

  // ── Loot ─────────────────────────────────────────────────────────
  function showLoot(p) {
    setState('loot');
    lootGrid.replaceChildren();
    const outcomes = p.outcomes || [];
    // Render outcomes in a fixed order — survivors first, fallen last.
    const ordered = [...outcomes].sort((a, b) => (b.survived ? 1 : 0) - (a.survived ? 1 : 0));
    ordered.slice(0, 8).forEach((o, i) => {
      setTimeout(() => lootGrid.appendChild(makeLootCard(o)), i * 250);
    });
    // After the loot animation finishes (cards plus a beat), drop back
    // to idle so the canvas clears and the next dungeon fires fresh.
    setTimeout(() => {
      reset();
      party.clear();
      setState('idle');
    }, 12000);
  }
  function makeLootCard(o) {
    const card = document.createElement('div');
    card.className = 'loot-card';
    const item = (o.loot && o.loot[0]) || null;
    if (item) {
      card.classList.add('rarity-' + (item.rarity || 'common'));
    }
    if (!o.survived) card.classList.add('fallen');
    if (o.classTint) card.style.setProperty('--ring', o.classTint);

    // Avatar header — viewer's character, class-tinted ring, slotted
    // above their name so the loot card reads as "this is THEIR card"
    // and not just generic loot from a generic encounter.
    const avatar = document.createElement('div');
    avatar.className = 'lc-avatar';
    if (o.avatar) {
      const img = document.createElement('img');
      img.src = o.avatar;
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        avatar.textContent = o.classGlyph || (o.user ? o.user.slice(0, 2).toUpperCase() : '?');
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = o.classGlyph || (o.user ? o.user.slice(0, 2).toUpperCase() : '?');
    }

    const name = document.createElement('div');
    name.className = 'lc-user';
    name.textContent = o.user || '?';

    const glyph = document.createElement('div');
    glyph.className = 'lc-glyph';
    glyph.textContent = o.survived ? (item ? item.glyph : '🪙') : '☠️';

    const itemName = document.createElement('div');
    itemName.className = 'lc-name';
    itemName.textContent = item ? item.name : (o.survived ? 'Survived' : 'Fell');

    const rarity = document.createElement('div');
    rarity.className = 'lc-rarity';
    rarity.textContent = item ? item.rarity : (o.survived ? 'survivor' : 'memorial');

    const stats = document.createElement('div');
    stats.className = 'lc-stats';
    if (item) {
      const parts = [];
      if (item.powerBonus)   parts.push('+' + item.powerBonus + ' ATK');
      if (item.defenseBonus) parts.push('+' + item.defenseBonus + ' DEF');
      stats.textContent = parts.join(' · ');
    }

    const bolts = document.createElement('div');
    if (o.survived && o.goldGained > 0) {
      bolts.className = 'lc-bolts';
      bolts.textContent = '+' + o.goldGained + ' bolts · +' + (o.xpGained || 0) + ' XP';
    } else if (!o.survived) {
      bolts.className = 'lc-fallen';
      bolts.textContent = 'Returned to camp';
    }

    card.append(avatar, name, glyph, itemName, rarity, stats, bolts);
    return card;
  }

  // ── Duel ─────────────────────────────────────────────────────────
  function showDuelRecruit(p) {
    reset();
    setState('duel');
    duelLname.textContent = p.challenger || '—';
    duelRname.textContent = p.target || '???';
    duelLhp.style.transform = 'scaleX(1)';
    duelRhp.style.transform = 'scaleX(1)';
    duelLog.replaceChildren();
    duelResult.textContent = 'Awaiting opponent... ' + (p.openSec || 30) + 's';
  }
  function showDuelStart(p) {
    setState('duel');
    duelLname.textContent = p.challenger || '—';
    duelRname.textContent = p.defender || '—';
    duelLhp.style.transform = 'scaleX(1)';
    duelRhp.style.transform = 'scaleX(1)';
    duelLog.replaceChildren();
    duelResult.textContent = '';
    // Render the duelists' actual characters: avatar URL or class glyph,
    // with class tint on the ring. Same pattern as party tiles — keeps
    // the visual story consistent across the overlay.
    paintDuelist($('duelist-l'), { avatar: p.challengerAvatar, glyph: p.challengerGlyph, tint: p.challengerTint, fallback: '⚔' });
    paintDuelist($('duelist-r'), { avatar: p.defenderAvatar,   glyph: p.defenderGlyph,   tint: p.defenderTint,   fallback: '🛡' });
  }
  function paintDuelist(panelEl, src) {
    if (!panelEl) return;
    const ring = panelEl.querySelector('.d-avatar');
    if (!ring) return;
    if (src.tint) ring.style.borderColor = src.tint;
    ring.replaceChildren();
    if (src.avatar) {
      const img = document.createElement('img');
      img.src = src.avatar;
      img.alt = '';
      img.className = 'd-avatar-img';
      img.addEventListener('error', () => {
        img.remove();
        ring.textContent = src.glyph || src.fallback;
      });
      ring.appendChild(img);
    } else {
      ring.textContent = src.glyph || src.fallback;
    }
  }
  function appendDuelScene(p) {
    const h = setTimeout(() => {
      while (duelLog.children.length >= 4) duelLog.removeChild(duelLog.firstChild);
      const line = document.createElement('div');
      line.className = 'scene-line ' + (p.kind || 'duel-strike');
      const g = document.createElement('div'); g.className = 's-glyph'; g.textContent = p.glyph || '⚔';
      const t = document.createElement('div'); t.className = 's-text';  t.textContent = p.text || '';
      line.append(g, t);
      duelLog.appendChild(line);
      // Cheap HP-drain animation: each strike shrinks the named victim's
      // bar by a quarter. Imprecise vs server numbers but feels right.
      const txt = (p.text || '').toLowerCase();
      if (txt.includes('strikes for')) shrinkHpBar(duelRhp, 0.25);
      else if (txt.includes('counters for')) shrinkHpBar(duelLhp, 0.25);
    }, Math.max(0, p.delayMs || 0));
    pendingScenes.push(h);
  }
  function shrinkHpBar(el, by) {
    const cur = parseFloat(el.dataset.scale || '1');
    const next = Math.max(0, cur - by);
    el.dataset.scale = next;
    el.style.transform = 'scaleX(' + next + ')';
  }
  function showDuelComplete(p) {
    if (!p.winner) {
      duelResult.textContent = 'No challenger answered the call.';
      setTimeout(() => { reset(); setState('idle'); }, 4000);
      return;
    }
    duelResult.textContent = '🏆 ' + p.winner + ' wins! +' + (p.xp || 0) + ' XP, +' + (p.gold || 0) + ' bolts';
    setTimeout(() => { reset(); setState('idle'); }, 6000);
  }

  // ── Bus connection ───────────────────────────────────────────────
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
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-dungeon' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['dungeon.*', 'duel.*'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.kind) return;
      const d = msg.data || {};
      switch (msg.kind) {
        case 'dungeon.recruiting':
          // Tag the recruit-timer node with the original openSec ms so
          // the per-tick math shrinks the bar consistently.
          if (recruitTimer) recruitTimer.dataset.baseTotalMs = String((d.openSec || 30) * 1000);
          showRecruit(d);
          break;
        case 'dungeon.joined':
          if (d.hero) addPartyTile(d.hero);
          break;
        case 'dungeon.started':
          showAdventure(d);
          break;
        case 'dungeon.scene':
          scheduleScene(d);
          break;
        case 'dungeon.completed':
          // Wait for the last scheduled scene to render before swapping
          // to the loot reveal so chat sees the conclusion before spoils.
          setTimeout(() => showLoot(d), 1500);
          break;
        case 'duel.recruiting': showDuelRecruit(d); break;
        case 'duel.started':    showDuelStart(d); break;
        case 'duel.scene':      appendDuelScene(d); break;
        case 'duel.completed':  showDuelComplete(d); break;
      }
    };
    ws.onclose = () => {
      setStatus('disconnected, retrying in ' + Math.round(backoff/1000) + 's');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => { setStatus('error'); };
  }
  function setStatus(text) {
    if (!debug) return;
    let el = $('devStatus');
    if (!el) { el = document.createElement('div'); el.id = 'devStatus'; el.className = 'dev-status'; document.body.appendChild(el); }
    el.textContent = 'bus: ' + text;
  }

  if (debug) {
    // Demo run so the streamer can preview without firing the bus.
    showRecruit({
      dungeonName: 'Crypt of Whispers',
      joinCommand: '!join',
      openSec: 8,
      party: [
        { user: 'aquilo_plays', platform: 'twitch', level: 5, hpMax: 35, hpCurrent: 35,
          className: 'warrior', classGlyph: '⚔', classTint: '#F85149',
          avatar: 'https://static-cdn.jtvnw.net/jtv_user_pictures/00bbf509-0ad7-4e72-bd5f-f2dca1d35d24-profile_image-300x300.png' },
        { user: 'fearless_fox', platform: 'twitch', level: 2, hpMax: 25, hpCurrent: 25,
          className: 'rogue',   classGlyph: '🗡', classTint: '#3FB950', avatar: '' }
      ]
    });
    setTimeout(() => addPartyTile({ user: 'mason42', platform: 'twitch', level: 3, hpMax: 30, hpCurrent: 30,
                                    className: 'mage', classGlyph: '🪄', classTint: '#B452FF', avatar: '' }), 1500);
    setTimeout(() => {
      showAdventure({ dungeonName: 'Crypt of Whispers' });
      [
        { delayMs:    0, kind: 'story',     text: 'The party enters the Crypt of Whispers...', glyph: '📜' },
        { delayMs: 1800, kind: 'encounter', text: 'A Goblin Sneak ambushes the party! It strikes mason42 for 3 damage, but falls. (+11 bolts, +9 XP each)', glyph: '👹' },
        { delayMs: 4400, kind: 'trap',      text: 'A Spike Pit! spikes pierce fearless_fox for 5 damage.', glyph: '🪤' },
        { delayMs: 7200, kind: 'treasure',  text: 'The party finds a hoard! Each survivor pockets 12 bolts.', glyph: '💰' },
        { delayMs:10000, kind: 'encounter', text: 'A Wyvern descends! aquilo_plays takes 8 damage, but the party prevails. (+34 bolts, +28 XP each)', glyph: '🐉' }
      ].forEach(scheduleScene);
      setTimeout(() => showLoot({
        dungeonName: 'Crypt of Whispers',
        outcomes: [
          { user: 'aquilo_plays', survived: true,  goldGained: 57, xpGained: 37,
            className: 'warrior', classGlyph: '⚔', classTint: '#F85149',
            avatar: 'https://static-cdn.jtvnw.net/jtv_user_pictures/00bbf509-0ad7-4e72-bd5f-f2dca1d35d24-profile_image-300x300.png',
            loot: [{ name: 'Drakebane Sword', rarity: 'epic',     glyph: '🗡️', powerBonus: 7, defenseBonus: 1 }] },
          { user: 'fearless_fox', survived: true,  goldGained: 57, xpGained: 37,
            className: 'rogue',   classGlyph: '🗡', classTint: '#3FB950',
            loot: [{ name: 'Lucky Charm',     rarity: 'uncommon', glyph: '🍀', powerBonus: 1, defenseBonus: 1 }] },
          { user: 'mason42',      survived: false, goldGained: 0,  xpGained: 6,
            className: 'mage',    classGlyph: '🪄', classTint: '#B452FF', loot: [] }
        ]
      }), 13000);
    }, 9000);
  }
  connect();
})();
