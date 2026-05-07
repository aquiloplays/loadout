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

  // ─── Pixel-art class sprites ─────────────────────────────────────
  //
  // Each class has a 16×16 pixel sprite composed from layers at render
  // time so customization (skin tone / hair / outfit colours / cape)
  // can flow through cleanly. The composer reads hero.custom from the
  // bus payload — see HeroState.Custom on the DLL side for the canonical
  // set of keys.
  //
  // Layer z-order (bottom to top):
  //   1. Cape (behind body, visible as a triangle behind the legs)
  //   2. Legs + boots
  //   3. Body torso (class-default outfit primary, override via custom.primary)
  //   4. Arms
  //   5. Face (skin) + eyes
  //   6. Hair (only visible on classes whose headgear leaves hair showing — ranger, healer)
  //   7. Class-specific headgear (helmet / hat / hood / cap / halo)
  //   8. Held weapon (right side)
  //
  // Each sprite uses shape-rendering="crispEdges" + image-rendering:
  // pixelated so the pixels stay sharp at every avatar size.

  // ── Customization palettes ──────────────────────────────────────
  const SKIN_TONES = {
    fair:       '#F4C28A',
    tan:        '#C99064',
    olive:      '#A87850',
    deep:       '#7B4A2D',
    'pale-blue':  '#B7D4E8',  // fantasy variant
    'pale-green': '#B8DDB0'
  };
  const HAIR_COLORS = {
    black:    '#2A1A0F',
    brown:    '#5A3F1B',
    blonde:   '#E0C070',
    red:      '#B43F1F',
    white:    '#E8E8E8',
    pink:     '#FF8FB0',
    blue:     '#5A8FFF',
    green:    '#4FB05A'
  };
  const EYE_COLORS = {
    brown:  '#3A2200',
    blue:   '#3A86FF',
    green:  '#3FB950',
    amber:  '#F0B429',
    red:    '#F85149'
  };

  // Class default outfit colours — used when custom.primary / .secondary
  // are not set. Keep these in sync with DungeonContent.Classes' tint.
  const CLASS_PRIMARY = {
    warrior: '#F85149',
    mage:    '#B452FF',
    rogue:   '#1F3A2A',
    ranger:  '#F0B429',
    healer:  '#EFEFF1'
  };
  const CLASS_SECONDARY = {
    warrior: '#3A2200',
    mage:    '#00F2EA',
    rogue:   '#0A1F11',
    ranger:  '#5A3F1B',
    healer:  '#00F2EA'
  };

  // Cape options — drawn behind the body. "none" omits the layer.
  const CAPE_PRESETS = {
    none:   null,
    cloak:  { color: '#3A2200' },
    wing:   { color: '#3FB950' },
    scarf:  { color: '#F85149', short: true }
  };

  // Hair-style families that are visible. Classes that fully cover the
  // head (warrior helmet, mage hat, rogue hood) only render hair
  // peeking out below the ear line at most. Classes with a partial cap
  // (ranger) show side bangs. Healer has full hair under the halo.
  function hairLayer(style, color, classKey) {
    style = (style || 'short').toLowerCase();
    if (classKey === 'warrior' || classKey === 'mage' || classKey === 'rogue') {
      // Headgear hides hair entirely (intentional silhouette choice).
      return '';
    }
    // For ranger / healer — render visible hair under cap / halo.
    const c = HAIR_COLORS[color] || HAIR_COLORS.brown;
    if (style === 'bald') return '';
    if (style === 'long') {
      // Hair flows down past the shoulders.
      return rect(5, 4, 6, 1, c) + rect(4, 5, 1, 4, c) + rect(11, 5, 1, 4, c) + rect(4, 7, 8, 1, c);
    }
    if (style === 'spiky') {
      return rect(5, 2, 1, 2, c) + rect(7, 1, 1, 3, c) + rect(9, 2, 1, 2, c) +
             rect(11, 3, 1, 1, c) + rect(4, 3, 1, 1, c) + rect(5, 4, 6, 1, c);
    }
    if (style === 'mohawk') {
      return rect(7, 1, 2, 4, c);
    }
    if (style === 'braids') {
      return rect(5, 4, 6, 1, c) + rect(4, 5, 1, 5, c) + rect(11, 5, 1, 5, c);
    }
    // default: short
    return rect(5, 4, 6, 1, c) + rect(4, 5, 1, 1, c) + rect(11, 5, 1, 1, c);
  }

  function rect(x, y, w, h, color) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + color + '"/>';
  }

  // Cape layer — rendered before the body so it sits "behind" the
  // figure visually.
  function capeLayer(capeKey, primary) {
    const def = CAPE_PRESETS[(capeKey || 'none').toLowerCase()];
    if (!def) return '';
    if (def.short) {
      // Short scarf around the neck.
      return rect(5, 6, 6, 1, def.color);
    }
    // Long cloak / wing-cape — drawn behind body, peeks out either side.
    return rect(2, 7, 1, 7, def.color) + rect(13, 7, 1, 7, def.color) + rect(3, 13, 11, 2, def.color);
  }

  // Compose a sprite for a given class with custom layered in.
  // `custom` is the dict from the bus payload.
  function characterSprite(className, custom) {
    const c = (className || '').toLowerCase();
    if (!c || !CLASS_PRIMARY[c]) return '';
    custom = custom || {};
    const skin     = SKIN_TONES[(custom.skinTone || 'fair').toLowerCase()] || SKIN_TONES.fair;
    const eye      = EYE_COLORS[(custom.eyeColor || 'brown').toLowerCase()] || EYE_COLORS.brown;
    const primary  = (custom.primary || '').match(/^#[0-9a-f]{6}$/i) ? custom.primary : CLASS_PRIMARY[c];
    const secondary = (custom.secondary || '').match(/^#[0-9a-f]{6}$/i) ? custom.secondary : CLASS_SECONDARY[c];
    const cape     = capeLayer(custom.cape, primary);
    const hair     = hairLayer(custom.hairStyle, custom.hairColor, c);

    // Class-specific top half (headgear + held weapon) + shared body
    // template. We hand-write each class's top so the silhouette stays
    // recognisable at the 48px party-tile size.
    let top, weapon;
    switch (c) {
      case 'warrior':
        top =
          // helmet plume + dome + visor
          rect(6, 0, 4, 1, primary) +
          rect(5, 1, 6, 2, '#3F3F46') +
          rect(5, 3, 6, 1, '#1A1A22') +
          // face peek through visor
          rect(5, 4, 6, 2, skin) +
          rect(6, 4, 1, 1, eye) + rect(9, 4, 1, 1, eye);
        weapon =
          rect(13, 3, 1, 6, '#C4C4D0') +
          rect(12, 9, 3, 1, secondary) +
          rect(13, 10, 1, 1, secondary);
        break;
      case 'mage':
        top =
          // pointy hat with star tip
          rect(7, 0, 2, 1, '#F0B429') +
          rect(7, 1, 2, 1, primary) +
          rect(6, 2, 4, 1, primary) +
          rect(5, 3, 6, 1, primary) +
          rect(4, 4, 8, 1, '#3F3F46') +
          rect(6, 5, 4, 2, skin) +
          rect(6, 5, 1, 1, eye) + rect(9, 5, 1, 1, eye);
        weapon =
          rect(2, 7, 1, 6, '#3A2200') +
          rect(2, 6, 1, 1, '#3A2200') +
          rect(1, 5, 3, 1, secondary) +
          rect(2, 4, 1, 1, secondary);
        break;
      case 'rogue':
        top =
          rect(5, 1, 6, 2, primary) +
          rect(4, 3, 8, 2, primary) +
          rect(6, 4, 4, 2, secondary) +    // shadow inside hood
          rect(6, 5, 1, 1, '#3FB950') + rect(9, 5, 1, 1, '#3FB950');   // glowing eyes
        weapon =
          rect(13, 6, 1, 2, '#C4C4D0') +
          rect(12, 8, 1, 1, '#3FB950');
        break;
      case 'ranger':
        top =
          rect(5, 2, 6, 2, secondary) +
          rect(4, 4, 8, 1, secondary) +
          rect(9, 0, 1, 2, '#3FB950') +    // feather
          rect(10, 1, 1, 1, '#3FB950') +
          rect(5, 5, 6, 2, skin) +
          rect(6, 5, 1, 1, eye) + rect(9, 5, 1, 1, eye);
        weapon =
          rect(14, 6, 1, 6, '#3A2200') +
          rect(13, 6, 1, 1, '#3A2200') +
          rect(13, 11, 1, 1, '#3A2200') +
          rect(14, 9, 1, 1, '#3FB950');
        break;
      case 'healer':
        top =
          rect(5, 0, 6, 1, '#F0B429') +    // halo
          rect(4, 1, 1, 1, '#F0B429') +
          rect(11, 1, 1, 1, '#F0B429') +
          rect(5, 2, 6, 3, skin) +
          rect(6, 3, 1, 1, eye) + rect(9, 3, 1, 1, eye);
        weapon =
          rect(2, 9, 2, 2, secondary) +
          rect(1, 10, 1, 1, secondary) +
          rect(4, 10, 1, 1, secondary);
        break;
      default:
        return '';
    }

    // Shared body template — torso uses primary, belt uses a darker
    // shade derived from the class default secondary, arms are skin.
    const body =
      // Torso
      rect(4, c === 'mage' || c === 'healer' ? 7 : 6, 8, c === 'mage' || c === 'healer' ? 6 : 4, primary) +
      // Arms (skin)
      rect(3, c === 'mage' || c === 'healer' ? 6 : 6, 1, c === 'mage' || c === 'healer' ? 3 : 4, skin) +
      rect(12, c === 'mage' || c === 'healer' ? 6 : 6, 1, c === 'mage' || c === 'healer' ? 3 : 4, skin) +
      // Belt
      (c === 'mage' || c === 'healer'
        ? rect(3, 13, 10, 1, primary)
        : rect(4, 10, 8, 1, secondary)) +
      // Healer accent sash overlay
      (c === 'healer' ? rect(7, 6, 2, 6, '#00F2EA') + rect(6, 9, 4, 1, '#00F2EA') : '') +
      // Legs + boots
      (c === 'mage' || c === 'healer'
        ? rect(5, 14, 2, 2, '#1A1A22') + rect(9, 14, 2, 2, '#1A1A22')
        : rect(5, 11, 2, 3, secondary === '#3A2200' ? '#1A1A22' : '#1A1A22') +
          rect(9, 11, 2, 3, '#1A1A22') +
          rect(5, 14, 2, 2, secondary) +
          rect(9, 14, 2, 2, secondary));

    return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
      cape + body + hair + top + weapon +
      '</svg>';
  }

  // Three-way fallback renderer used by every avatar slot:
  //   1. Pixel-art class sprite if a class is set (composed from custom)
  //   2. Class glyph emoji (the previous default) if we have one
  //   3. Letter initials from the username
  // The container element gets a `.has-sprite` class added when the
  // SVG path wins, so CSS can drop padding / change background to
  // make the sprite read crisply.
  function renderClassFallback(el, className, glyph, user, custom) {
    if (!el) return;
    el.classList.remove('has-sprite');
    const svg = characterSprite(className, custom);
    if (svg) {
      el.classList.add('has-sprite');
      el.innerHTML = svg;
      return;
    }
    el.textContent = glyph || initials(user);
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
        img.remove();
        renderClassFallback(av, m.className, m.classGlyph, m.user, m.custom);
      });
      av.appendChild(img);
    } else {
      renderClassFallback(av, m.className, m.classGlyph, m.user, m.custom);
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
        renderClassFallback(avatar, o.className, o.classGlyph, o.user, o.custom);
      });
      avatar.appendChild(img);
    } else {
      renderClassFallback(avatar, o.className, o.classGlyph, o.user, o.custom);
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
    paintDuelist($('duelist-l'), { avatar: p.challengerAvatar, className: p.challengerClass, custom: p.challengerCustom, glyph: p.challengerGlyph, tint: p.challengerTint, fallback: '⚔' });
    paintDuelist($('duelist-r'), { avatar: p.defenderAvatar,   className: p.defenderClass,   custom: p.defenderCustom,   glyph: p.defenderGlyph,   tint: p.defenderTint,   fallback: '🛡' });
  }
  function paintDuelist(panelEl, src) {
    if (!panelEl) return;
    const ring = panelEl.querySelector('.d-avatar');
    if (!ring) return;
    if (src.tint) ring.style.borderColor = src.tint;
    ring.replaceChildren();
    ring.classList.remove('has-sprite');
    if (src.avatar) {
      const img = document.createElement('img');
      img.src = src.avatar;
      img.alt = '';
      img.className = 'd-avatar-img';
      img.addEventListener('error', () => {
        img.remove();
        renderClassFallback(ring, src.className, src.glyph, '', src.custom);
        if (!ring.classList.contains('has-sprite')) ring.textContent = src.glyph || src.fallback;
      });
      ring.appendChild(img);
    } else {
      renderClassFallback(ring, src.className, src.glyph, '', src.custom);
      if (!ring.classList.contains('has-sprite')) ring.textContent = src.glyph || src.fallback;
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
        // Warrior — default look, no custom (vanilla red plume).
        { user: 'aquilo_plays', platform: 'twitch', level: 5, hpMax: 35, hpCurrent: 35,
          className: 'warrior', classGlyph: '⚔', classTint: '#F85149', avatar: '',
          custom: { skinTone: 'tan', cape: 'cloak' } },
        // Rogue with cyan-ish primary override + cape.
        { user: 'fearless_fox', platform: 'twitch', level: 2, hpMax: 25, hpCurrent: 25,
          className: 'rogue',   classGlyph: '🗡', classTint: '#3FB950', avatar: '',
          custom: { skinTone: 'olive', cape: 'cloak', primary: '#1F2D3A' } }
      ]
    });
    // Late-joiners cycle through the remaining class sprites with
    // custom-variant flair so the streamer can see what changes.
    setTimeout(() => addPartyTile({ user: 'mason42',     platform: 'twitch', level: 3, hpMax: 30, hpCurrent: 30,
                                    className: 'mage',   classGlyph: '🪄', classTint: '#B452FF', avatar: '',
                                    custom: { skinTone: 'fair', primary: '#3A86FF' } }), 1500);
    setTimeout(() => addPartyTile({ user: 'pine_archer', platform: 'twitch', level: 4, hpMax: 32, hpCurrent: 32,
                                    className: 'ranger', classGlyph: '🏹', classTint: '#F0B429', avatar: '',
                                    custom: { skinTone: 'deep', hairColor: 'red', hairStyle: 'long', cape: 'wing' } }), 3000);
    setTimeout(() => addPartyTile({ user: 'lume',        platform: 'twitch', level: 6, hpMax: 40, hpCurrent: 40,
                                    className: 'healer', classGlyph: '✨', classTint: '#00F2EA', avatar: '',
                                    custom: { skinTone: 'pale-blue', hairColor: 'pink', hairStyle: 'long' } }), 4500);
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
            className: 'warrior', classGlyph: '⚔', classTint: '#F85149', avatar: '',
            loot: [{ name: 'Drakebane Sword', rarity: 'epic',     glyph: '🗡️', powerBonus: 7, defenseBonus: 1 }] },
          { user: 'fearless_fox', survived: true,  goldGained: 57, xpGained: 37,
            className: 'rogue',   classGlyph: '🗡', classTint: '#3FB950', avatar: '',
            loot: [{ name: 'Lucky Charm',     rarity: 'uncommon', glyph: '🍀', powerBonus: 1, defenseBonus: 1 }] },
          { user: 'mason42',      survived: false, goldGained: 0,  xpGained: 6,
            className: 'mage',    classGlyph: '🪄', classTint: '#B452FF', avatar: '', loot: [] }
        ]
      }), 13000);
    }, 9000);
  }
  connect();
})();
