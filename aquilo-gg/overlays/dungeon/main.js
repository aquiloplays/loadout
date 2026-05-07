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

  // ─── Medieval pixel-art class sprites ───────────────────────────
  //
  // 16×24 viewBox so the figure has proper full-body proportions —
  // head, torso, legs, feet all visible. Composed from layers at
  // render time:
  //
  //   1. Cape (behind everything, peeks out by hips)
  //   2. Legs (pants OR equipped leg armour)
  //   3. Boots (default OR equipped boots)
  //   4. Torso (class-default outfit OR equipped chest armour)
  //   5. Arms (skin)
  //   6. Face (skin + eyes)
  //   7. Hair (visible only on classes without full headgear)
  //   8. Head (class hat OR equipped helm)
  //   9. Held weapon (class default OR equipped weapon)
  //   10. Trinket accent
  //
  // Armour SETS — when an equipped piece's setName matches one of
  // SET_PALETTES, that slot's render uses the set palette instead
  // of the class default. Four sets coexist with mixed pieces:
  //   ironclad     — silver plate, riveted look
  //   dragonscale  — olive scales with gold trim
  //   shadow       — deep purple cuirass with red trim
  //   arcane       — violet robes with cyan runes
  //
  // shape-rendering="crispEdges" + image-rendering: pixelated keep
  // pixels sharp at every avatar size.

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

  // SVG primitive — every layer below builds out of these calls.
  function rect(x, y, w, h, color) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + color + '"/>';
  }

  // Per-armour-set palettes — when an equipped piece carries one of
  // these set names, the slot's render switches to its colours and
  // pattern. Mixed sets coexist (e.g. Ironclad helm + Dragonscale
  // chest is fine — each slot renders independently). Keep these in
  // sync with DungeonContent.Sets on the DLL side.
  const SET_PALETTES = {
    ironclad:    { primary: '#8B8B96', secondary: '#5A5A66', accent: '#C4C4D0' },
    dragonscale: { primary: '#5A6B3F', secondary: '#3A4A26', accent: '#C7A14A' },
    shadow:      { primary: '#2A1F3A', secondary: '#0F0A1F', accent: '#B452FF' },
    arcane:      { primary: '#3A1F5A', secondary: '#5A2A7F', accent: '#00F2EA' }
  };

  // Hair styles — rendered behind the head layer. Classes with full
  // headgear (warrior helmet, mage hat, rogue hood) hide hair on
  // purpose; classes with partial hats (ranger, healer) leave hair
  // visible. The y/height offsets below assume 16×24 viewBox.
  function hairLayer(style, color, classKey) {
    style = (style || 'short').toLowerCase();
    if (classKey === 'warrior' || classKey === 'mage' || classKey === 'rogue') return '';
    const c = HAIR_COLORS[color] || HAIR_COLORS.brown;
    if (style === 'bald') return '';
    if (style === 'long')   return rect(4, 3, 8, 1, c) + rect(3, 4, 1, 5, c) + rect(12, 4, 1, 5, c) + rect(3, 8, 10, 1, c);
    if (style === 'spiky')  return rect(4, 1, 1, 2, c) + rect(6, 0, 1, 3, c) + rect(8, 0, 1, 3, c) + rect(10, 1, 1, 2, c) + rect(4, 3, 8, 1, c);
    if (style === 'mohawk') return rect(7, 0, 2, 4, c);
    if (style === 'braids') return rect(4, 3, 8, 1, c) + rect(3, 4, 1, 7, c) + rect(12, 4, 1, 7, c);
    return                   rect(4, 3, 8, 1, c) + rect(3, 4, 1, 1, c) + rect(12, 4, 1, 1, c);
  }

  // Cape — rendered first so it sits behind the body. Peeks out at
  // the shoulders + below the legs to read as a long flowing cloak.
  function capeLayer(capeKey) {
    const def = CAPE_PRESETS[(capeKey || 'none').toLowerCase()];
    if (!def) return '';
    if (def.short) return rect(5, 7, 6, 1, def.color);   // scarf at neckline
    // Long cloak — covers shoulders down to the boots.
    return rect(2, 8, 1, 12, def.color) +
           rect(13, 8, 1, 12, def.color) +
           rect(3, 19, 10, 2, def.color);
  }

  // ── Slot layers ─────────────────────────────────────────────────
  // Each slot has TWO render paths: the class default (when nothing's
  // equipped or the equipped item has no setName) and a set-themed
  // override (when an equipped item carries a known setName). Every
  // function returns SVG-rect string fragments.

  // Boots: rows 21-23 (3 px tall feet).
  function bootsLayer(eq, classKey) {
    const set = eq && eq.boots && SET_PALETTES[(eq.boots.setName || '').toLowerCase()];
    if (set) {
      // Ironclad sabatons — silver, with metal sheen highlight on top
      return rect(5, 21, 2, 3, set.secondary) + rect(9, 21, 2, 3, set.secondary) +
             rect(5, 21, 2, 1, set.accent)    + rect(9, 21, 2, 1, set.accent);
    }
    // Class default — leather boots for most, sandals for healer
    if (classKey === 'healer') {
      return rect(5, 22, 2, 2, '#5A3F1B') + rect(9, 22, 2, 2, '#5A3F1B');
    }
    return rect(5, 21, 2, 3, '#3A2200') + rect(9, 21, 2, 3, '#3A2200');
  }

  // Legs/pants: rows 16-20 (5 px tall — calves through to ankles).
  function legsLayer(eq, classKey) {
    const set = eq && eq.legs && SET_PALETTES[(eq.legs.setName || '').toLowerCase()];
    if (set) {
      // Plate greaves — vertical seam line down each leg
      return rect(5, 16, 2, 5, set.primary) + rect(9, 16, 2, 5, set.primary) +
             rect(5, 16, 1, 5, set.accent)  + rect(9, 16, 1, 5, set.accent);
    }
    if (classKey === 'mage' || classKey === 'healer') {
      // Robe extends down here — handled by torsoLayer; this layer
      // returns nothing so the robe is unbroken.
      return '';
    }
    if (classKey === 'rogue') {
      return rect(5, 16, 2, 5, '#0A1F11') + rect(9, 16, 2, 5, '#0A1F11');
    }
    if (classKey === 'ranger') {
      return rect(5, 16, 2, 5, '#5A3F1B') + rect(9, 16, 2, 5, '#5A3F1B');
    }
    // warrior default trousers
    return rect(5, 16, 2, 5, '#1A1A22') + rect(9, 16, 2, 5, '#1A1A22');
  }

  // Torso: rows 8-13 (6 px tall — chest down to hip). Belt sits at
  // row 14 and is part of this layer because belts always render.
  function torsoLayer(eq, classKey, primaryOverride) {
    const set = eq && eq.chest && SET_PALETTES[(eq.chest.setName || '').toLowerCase()];
    if (set) {
      // Plate chest with shoulder pauldrons + central rivet line
      let s = rect(4, 8, 8, 6, set.primary) +
              rect(3, 8, 1, 4, set.secondary) + rect(12, 8, 1, 4, set.secondary) +    // pauldrons
              rect(3, 8, 1, 1, set.accent)    + rect(12, 8, 1, 1, set.accent) +       // pauldron rivets
              rect(7, 9, 2, 4, set.secondary) +                                       // central seam
              rect(7, 10, 2, 1, set.accent);                                          // rivet
      // Dragonscale: add scale chevron pattern across the chest
      if ((eq.chest.setName || '').toLowerCase() === 'dragonscale') {
        s += rect(5, 9,  1, 1, set.accent) + rect(9, 9,  1, 1, set.accent) +
             rect(4, 11, 1, 1, set.accent) + rect(8, 11, 1, 1, set.accent) + rect(11, 11, 1, 1, set.accent) +
             rect(5, 13, 1, 1, set.accent) + rect(9, 13, 1, 1, set.accent);
      }
      // Shadow: red trim on the lapels
      if ((eq.chest.setName || '').toLowerCase() === 'shadow') {
        s += rect(5, 8, 1, 6, '#F85149') + rect(10, 8, 1, 6, '#F85149');
      }
      // Arcane: glowing rune on the chest
      if ((eq.chest.setName || '').toLowerCase() === 'arcane') {
        s += rect(7, 10, 2, 1, set.accent) + rect(8, 9, 1, 3, set.accent);
      }
      // Belt
      s += rect(4, 14, 8, 1, '#3A2200');
      return s;
    }

    // Class defaults — distinctive silhouettes per class.
    const primary = primaryOverride || CLASS_PRIMARY[classKey] || '#3A86FF';
    const secondary = CLASS_SECONDARY[classKey] || '#3A2200';

    if (classKey === 'mage') {
      // Long robe — covers torso AND legs, cinched at the waist
      let s = rect(4, 8, 8, 12, primary) +                       // robe top→bottom
              rect(3, 19, 10, 1, primary) +                      // hem flares out
              rect(4, 14, 8, 1, secondary) +                     // sash
              rect(7, 9, 2, 4, secondary);                       // center stripe
      return s;
    }
    if (classKey === 'healer') {
      // White flowing robe with cyan cross-sash
      let s = rect(4, 8, 8, 12, '#EFEFF1') +
              rect(3, 19, 10, 1, '#EFEFF1') +
              rect(4, 14, 8, 1, '#C4C4D0') +
              rect(7, 9, 2, 6, '#00F2EA') +     // vertical sash
              rect(6, 11, 4, 1, '#00F2EA');     // horizontal cross
      return s;
    }
    if (classKey === 'rogue') {
      // Leather jerkin with crossed straps
      return rect(4, 8, 8, 6, '#1F3A2A') +
             rect(6, 8, 1, 6, '#0A1F11') +    // crossing strap
             rect(4, 14, 8, 1, '#3A2200');    // belt
    }
    if (classKey === 'ranger') {
      // Tunic with quiver-strap diagonal
      return rect(4, 8, 8, 6, '#5A3F1B') +
             rect(4, 8, 8, 1, '#3FB950') +    // green collar
             rect(8, 8, 1, 6, '#3A2200') +    // quiver strap
             rect(4, 14, 8, 1, '#3A2200');
    }
    // warrior — gambeson + chest plate
    return rect(4, 8, 8, 6, primary) +
           rect(7, 9, 2, 4, secondary) +      // central seam
           rect(7, 10, 2, 1, '#C4C4D0') +     // metal rivet
           rect(4, 14, 8, 1, '#3A2200');      // belt
  }

  // Arms — skin coloured strips on either side of the torso. Lengths
  // depend on the class robe coverage.
  function armsLayer(skin, classKey) {
    if (classKey === 'mage' || classKey === 'healer') {
      // Robed arms only show forearms peeking out
      return rect(2, 9,  1, 4, skin) + rect(13, 9,  1, 4, skin);
    }
    return rect(3, 8, 1, 6, skin) + rect(12, 8, 1, 6, skin);
  }

  // Face — skin patch + eyes. Always renders the same shape; class
  // headgear may obscure parts of it.
  function faceLayer(skin, eye, classKey) {
    if (classKey === 'rogue') {
      // Hood casts shadow over face — only glowing eyes visible
      return rect(5, 4, 6, 4, '#0A1F11') +
             rect(6, 6, 1, 1, '#3FB950') + rect(9, 6, 1, 1, '#3FB950');
    }
    return rect(5, 4, 6, 4, skin) +
           rect(6, 6, 1, 1, eye) + rect(9, 6, 1, 1, eye);
  }

  // Headgear — class default OR equipped helm/hood/circlet.
  function headLayer(eq, classKey) {
    const set = eq && eq.head && SET_PALETTES[(eq.head.setName || '').toLowerCase()];
    if (set) {
      const setKey = (eq.head.setName || '').toLowerCase();
      if (setKey === 'ironclad') {
        // Iron helm — silver dome, horizontal visor slit, side flaps
        return rect(4, 1, 8, 3, set.primary) +
               rect(4, 4, 8, 1, set.secondary) +    // visor slit
               rect(4, 5, 1, 3, set.primary)  + rect(11, 5, 1, 3, set.primary) +   // cheek guards
               rect(5, 1, 1, 1, set.accent);        // top highlight
      }
      if (setKey === 'dragonscale') {
        // Dragon-themed helm with horns
        return rect(4, 2, 8, 3, set.primary) +
               rect(3, 1, 1, 2, set.accent)   + rect(12, 1, 1, 2, set.accent) +    // horns
               rect(5, 5, 6, 1, set.secondary) +    // brow ridge
               rect(6, 6, 1, 1, '#F0B429')    + rect(9, 6, 1, 1, '#F0B429');       // glowing eyes
      }
      if (setKey === 'shadow') {
        // Shadow cowl — extended hood
        return rect(4, 1, 8, 4, set.primary) +
               rect(3, 4, 10, 3, set.primary) +
               rect(5, 5, 6, 2, set.secondary) +    // shadow inside cowl
               rect(6, 6, 1, 1, set.accent) + rect(9, 6, 1, 1, set.accent);
      }
      if (setKey === 'arcane') {
        // Arcane circlet with glowing centre stone
        return rect(4, 4, 8, 1, set.accent) +
               rect(7, 3, 2, 1, set.accent) +       // centre stone
               rect(7, 4, 2, 1, '#FFFFFF');         // gleam
      }
      // Generic plate helm fallback
      return rect(4, 2, 8, 4, set.primary) + rect(4, 5, 8, 1, set.secondary);
    }

    // Class defaults
    if (classKey === 'warrior') {
      // Steel helm with red plume and visor slit
      return rect(7, 0, 2, 1, '#F85149') +              // plume
             rect(4, 1, 8, 3, '#3F3F46') +              // helmet dome
             rect(4, 4, 8, 1, '#1A1A22') +              // visor slit
             rect(4, 5, 1, 3, '#3F3F46') + rect(11, 5, 1, 3, '#3F3F46');   // cheek guards
    }
    if (classKey === 'mage') {
      // Tall pointy hat with star tip + brim
      return rect(7, 0, 2, 1, '#F0B429') +
             rect(7, 1, 2, 1, CLASS_PRIMARY.mage) +
             rect(6, 2, 4, 1, CLASS_PRIMARY.mage) +
             rect(5, 3, 6, 1, CLASS_PRIMARY.mage) +
             rect(4, 4, 8, 1, '#3F3F46');               // hat brim
    }
    if (classKey === 'rogue') {
      // Hood (covers head + shoulders)
      return rect(5, 1, 6, 2, CLASS_PRIMARY.rogue) +
             rect(4, 3, 8, 4, CLASS_PRIMARY.rogue);
    }
    if (classKey === 'ranger') {
      // Forest cap with feather + visible hair underneath
      return rect(9, 0, 1, 2, '#3FB950') + rect(10, 1, 1, 1, '#3FB950') +   // feather
             rect(5, 2, 6, 2, '#5A3F1B') +                                  // cap
             rect(4, 4, 8, 1, '#3A2200');                                   // brim
    }
    if (classKey === 'healer') {
      // Halo above the head
      return rect(5, 0, 6, 1, '#F0B429') +
             rect(4, 1, 1, 1, '#F0B429') + rect(11, 1, 1, 1, '#F0B429');
    }
    return '';
  }

  // Per-weapon-type SVG renderers. Each function returns a fragment
  // for a 16×24 viewBox. The held weapon picks a type either from
  // the equipped weapon's `weaponType` (DLL emits it from the
  // LootDef catalog) or from a class-default fallback when nothing
  // is equipped. Rarity drives a subtle glow halo around the weapon.
  const WEAPON_RENDERERS = {
    // ── Right-side weapons ──
    sword: function () {
      return rect(13, 5, 1, 9, '#C4C4D0') +    // blade
             rect(13, 13, 1, 1, '#3A2200') +   // grip top
             rect(12, 13, 3, 1, '#3A2200') +   // crossguard
             rect(13, 14, 1, 2, '#3A2200');    // hilt
    },
    axe: function () {
      return rect(13, 5, 1, 11, '#3A2200') +   // haft
             rect(12, 6, 3, 2, '#C4C4D0') +    // axe head outline
             rect(11, 7, 1, 1, '#C4C4D0') +
             rect(15, 7, 1, 1, '#C4C4D0');
    },
    hammer: function () {
      return rect(13, 5, 1, 11, '#3A2200') +   // haft
             rect(11, 5, 5, 3, '#8B8B96') +    // head block
             rect(11, 5, 1, 1, '#C4C4D0') +    // highlight
             rect(15, 5, 1, 1, '#C4C4D0');
    },
    polearm: function () {
      return rect(13, 4, 1, 14, '#3A2200') +   // long haft
             rect(12, 3, 3, 2, '#C4C4D0') +    // halberd head
             rect(11, 4, 1, 1, '#C4C4D0');
    },
    dagger: function () {
      return rect(13, 8, 1, 4, '#C4C4D0') +    // short blade
             rect(12, 12, 3, 1, '#3A2200') +   // crossguard
             rect(13, 13, 1, 1, '#3A2200');    // hilt
    },
    bow: function () {
      return rect(14, 4, 1, 14, '#3A2200') +   // limb
             rect(13, 4, 1, 1, '#3A2200') +
             rect(13, 17, 1, 1, '#3A2200') +
             rect(15, 11, 1, 1, '#3FB950');    // bowstring tension
    },
    crossbow: function () {
      return rect(13, 9, 1, 4, '#3A2200') +    // stock
             rect(12, 8, 3, 1, '#5A3F1B') +    // bow body
             rect(11, 9, 1, 1, '#3A2200') + rect(15, 9, 1, 1, '#3A2200') +   // limbs
             rect(13, 7, 1, 1, '#C4C4D0');     // bolt tip
    },
    sling: function () {
      return rect(13, 9, 1, 4, '#5A3F1B') +    // strap
             rect(12, 13, 3, 1, '#5A3F1B');    // pouch
    },
    // ── Left-side caster weapons ──
    staff: function () {
      return rect(2, 8,  1, 11, '#3A2200') +    // shaft
             rect(2, 7,  1, 1, '#3A2200') +
             rect(1, 5,  3, 2, '#00F2EA') +     // glowing orb
             rect(2, 4,  1, 1, '#00F2EA');      // gleam
    },
    wand: function () {
      return rect(2, 9,  1, 6, '#3A2200') +
             rect(1, 7,  3, 2, '#B452FF');     // pommel gem
    },
    tome: function () {
      return rect(1, 9,  4, 5, '#3A2200') +    // book cover
             rect(2, 10, 2, 3, '#B452FF') +    // glowing rune
             rect(3, 10, 1, 3, '#F0B429');     // spine inlay
    },
    orb: function () {
      return rect(1, 9, 3, 3, '#00F2EA') +     // floating orb
             rect(2, 8, 1, 1, '#00F2EA');      // sparkle
    },
    holy: function () {
      return rect(2, 9, 1, 5, '#F0B429') +     // shaft
             rect(1, 10, 3, 1, '#F0B429') +    // crossbar
             rect(1, 8, 3, 2, '#FFFFFF');      // glow
    }
  };

  function weaponLayer(eq, classKey) {
    const w = eq && eq.weapon;
    // Resolve weapon type — equipped item wins, otherwise class default.
    const wtype = (w && w.weaponType) ||
                  (classKey === 'warrior' ? 'sword'  :
                   classKey === 'mage'    ? 'staff'  :
                   classKey === 'rogue'   ? 'dagger' :
                   classKey === 'ranger'  ? 'bow'    :
                   classKey === 'healer'  ? 'holy'   : '');
    let svg = WEAPON_RENDERERS[wtype] ? WEAPON_RENDERERS[wtype]() : '';

    // Set-themed weapon: tint the silver/wood colours with the set's
    // accent so a Shadow dagger reads purple, etc.
    const setKey = (w && w.setName || '').toLowerCase();
    const set = SET_PALETTES[setKey];
    if (set) {
      svg = svg.replace(/#C4C4D0/g, set.accent)
               .replace(/#8B8B96/g, set.primary);
    }

    // Rarity halo — epic / legendary / mythic gets an accent glow rect
    // beneath the weapon. The halo colour matches the rarity tier.
    if (w && (w.rarity === 'epic' || w.rarity === 'legendary' || w.rarity === 'mythic')) {
      const halo = w.rarity === 'mythic'   ? '#FF8FB0' :
                   w.rarity === 'legendary' ? '#F0B429' :
                                              '#B452FF';
      // For left-side casters draw the halo on the left, otherwise right.
      const leftSide = (wtype === 'staff' || wtype === 'wand' || wtype === 'tome' || wtype === 'orb' || wtype === 'holy');
      const halox = leftSide ? 0 : 11;
      const haloy = leftSide ? 4 : 4;
      svg = rect(halox, haloy, 5, 14, halo) +
            rect(halox, haloy, 5, 14, '#0F0F14') +    // dim overlay so the weapon stays legible
            svg;
    }
    return svg;
  }

  // Trinket — small accent on the chest when equipped. Doesn't have
  // a set palette of its own; just shows the item's glyph.
  function trinketLayer(eq) {
    const t = eq && eq.trinket;
    if (!t) return '';
    // Tiny chest pin / amulet
    return rect(7, 11, 2, 1, '#F0B429') + rect(7, 12, 2, 1, '#C4C4D0');
  }

  // ── Sprite composer ────────────────────────────────────────────
  // characterSprite(className, custom, equipped) returns the full
  // composed SVG. equipped is { slot: { rarity, setName, glyph,
  // name, slot } } — see DungeonModule.HeroToPayload.
  function characterSprite(className, custom, equipped) {
    const c = (className || '').toLowerCase();
    if (!c || !CLASS_PRIMARY[c]) return '';
    custom = custom || {};
    equipped = equipped || {};

    const skin     = SKIN_TONES[(custom.skinTone || 'fair').toLowerCase()] || SKIN_TONES.fair;
    const eye      = EYE_COLORS[(custom.eyeColor || 'brown').toLowerCase()] || EYE_COLORS.brown;
    const primary  = (custom.primary || '').match(/^#[0-9a-f]{6}$/i) ? custom.primary : null;

    const cape    = capeLayer(custom.cape);
    const legs    = legsLayer(equipped, c);
    const boots   = bootsLayer(equipped, c);
    const torso   = torsoLayer(equipped, c, primary);
    const arms    = armsLayer(skin, c);
    const face    = faceLayer(skin, eye, c);
    const hair    = hairLayer(custom.hairStyle, custom.hairColor, c);
    const head    = headLayer(equipped, c);
    const weapon  = weaponLayer(equipped, c);
    const trinket = trinketLayer(equipped);

    // Z-order: cape (back) → legs → boots → torso → arms → face → hair → head → weapon → trinket
    return '<svg viewBox="0 0 16 24" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
      cape + legs + boots + torso + arms + face + hair + head + weapon + trinket +
      '</svg>';
  }

  // Three-way fallback renderer used by every avatar slot:
  //   1. Pixel-art class sprite if a class is set (composed from custom)
  //   2. Class glyph emoji (the previous default) if we have one
  //   3. Letter initials from the username
  // The container element gets a `.has-sprite` class added when the
  // SVG path wins, so CSS can drop padding / change background to
  // make the sprite read crisply.
  function renderClassFallback(el, className, glyph, user, custom, equipped) {
    if (!el) return;
    el.classList.remove('has-sprite');
    const svg = characterSprite(className, custom, equipped);
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
        renderClassFallback(av, m.className, m.classGlyph, m.user, m.custom, m.equipped);
      });
      av.appendChild(img);
    } else {
      renderClassFallback(av, m.className, m.classGlyph, m.user, m.custom, m.equipped);
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
        renderClassFallback(avatar, o.className, o.classGlyph, o.user, o.custom, o.equipped);
      });
      avatar.appendChild(img);
    } else {
      renderClassFallback(avatar, o.className, o.classGlyph, o.user, o.custom, o.equipped);
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
    paintDuelist($('duelist-l'), { avatar: p.challengerAvatar, className: p.challengerClass, custom: p.challengerCustom, equipped: p.challengerEquipped, glyph: p.challengerGlyph, tint: p.challengerTint, fallback: '⚔' });
    paintDuelist($('duelist-r'), { avatar: p.defenderAvatar,   className: p.defenderClass,   custom: p.defenderCustom,   equipped: p.defenderEquipped,   glyph: p.defenderGlyph,   tint: p.defenderTint,   fallback: '🛡' });
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
        renderClassFallback(ring, src.className, src.glyph, '', src.custom, src.equipped);
        if (!ring.classList.contains('has-sprite')) ring.textContent = src.glyph || src.fallback;
      });
      ring.appendChild(img);
    } else {
      renderClassFallback(ring, src.className, src.glyph, '', src.custom, src.equipped);
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
        // Warrior in full Ironclad set (every armour slot ironclad-themed)
        { user: 'aquilo_plays', platform: 'twitch', level: 5, hpMax: 35, hpCurrent: 35,
          className: 'warrior', classGlyph: '⚔', classTint: '#F85149', avatar: '',
          custom: { skinTone: 'tan', cape: 'cloak' },
          equipped: {
            head:  { slot: 'head',  rarity: 'uncommon', name: 'Iron Helm',     glyph: '⛑', setName: 'ironclad' },
            chest: { slot: 'chest', rarity: 'uncommon', name: 'Chainmail',      glyph: '🦺', setName: 'ironclad' },
            legs:  { slot: 'legs',  rarity: 'uncommon', name: 'Iron Greaves',   glyph: '🦿', setName: 'ironclad' },
            boots: { slot: 'boots', rarity: 'uncommon', name: 'Iron Sabatons',  glyph: '👢', setName: 'ironclad' },
            weapon:{ slot: 'weapon',rarity: 'rare',     name: 'Frost Hammer',   glyph: '🔨', setName: '' }
          }
        },
        // Rogue in Shadow set
        { user: 'fearless_fox', platform: 'twitch', level: 2, hpMax: 25, hpCurrent: 25,
          className: 'rogue',   classGlyph: '🗡', classTint: '#3FB950', avatar: '',
          custom: { skinTone: 'olive', cape: 'cloak' },
          equipped: {
            head:  { slot: 'head',  rarity: 'epic', name: 'Shadow Cowl',    glyph: '🥷', setName: 'shadow' },
            chest: { slot: 'chest', rarity: 'epic', name: 'Shadow Cuirass', glyph: '🌙', setName: 'shadow' },
            weapon:{ slot: 'weapon',rarity: 'rare', name: 'Wraithblade',    glyph: '🗡', setName: '' }
          }
        }
      ]
    });
    // Late-joiners cycle through the remaining classes with assorted
    // armour mixes so the streamer sees how every set + class combines.
    setTimeout(() => addPartyTile({ user: 'mason42',     platform: 'twitch', level: 3, hpMax: 30, hpCurrent: 30,
                                    className: 'mage',   classGlyph: '🪄', classTint: '#B452FF', avatar: '',
                                    custom: { skinTone: 'fair' },
                                    equipped: {
                                      head:  { slot: 'head',  rarity: 'uncommon', name: "Mage's Circlet", glyph: '🔮', setName: 'arcane' },
                                      chest: { slot: 'chest', rarity: 'uncommon', name: 'Arcane Robes',   glyph: '🥋', setName: 'arcane' },
                                      weapon:{ slot: 'weapon',rarity: 'epic',     name: 'Stormcaller Staff', glyph: '⚡', setName: '' }
                                    } }), 1500);
    setTimeout(() => addPartyTile({ user: 'pine_archer', platform: 'twitch', level: 4, hpMax: 32, hpCurrent: 32,
                                    className: 'ranger', classGlyph: '🏹', classTint: '#F0B429', avatar: '',
                                    custom: { skinTone: 'deep', hairColor: 'red', hairStyle: 'long', cape: 'wing' },
                                    equipped: {
                                      chest: { slot: 'chest', rarity: 'rare',      name: 'Dragonscale Plate',   glyph: '🐲', setName: 'dragonscale' },
                                      legs:  { slot: 'legs',  rarity: 'rare',      name: 'Dragonscale Tassets', glyph: '🐲', setName: 'dragonscale' },
                                      weapon:{ slot: 'weapon',rarity: 'legendary', name: 'Bow of the North Star', glyph: '🌟', setName: '' }
                                    } }), 3000);
    setTimeout(() => addPartyTile({ user: 'lume',        platform: 'twitch', level: 6, hpMax: 40, hpCurrent: 40,
                                    className: 'healer', classGlyph: '✨', classTint: '#00F2EA', avatar: '',
                                    custom: { skinTone: 'pale-blue', hairColor: 'pink', hairStyle: 'long' },
                                    equipped: {} }), 4500);
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
            custom: { skinTone: 'tan' },
            equipped: {
              head:  { slot: 'head',  rarity: 'uncommon', name: 'Iron Helm', setName: 'ironclad' },
              chest: { slot: 'chest', rarity: 'uncommon', name: 'Chainmail',  setName: 'ironclad' }
            },
            loot: [{ name: 'Drakebane Sword', rarity: 'epic',     glyph: '🗡️', powerBonus: 7, defenseBonus: 1 }] },
          { user: 'fearless_fox', survived: true,  goldGained: 57, xpGained: 37,
            className: 'rogue',   classGlyph: '🗡', classTint: '#3FB950', avatar: '',
            custom: { skinTone: 'olive' },
            equipped: {
              chest: { slot: 'chest', rarity: 'epic', name: 'Shadow Cuirass', setName: 'shadow' }
            },
            loot: [{ name: 'Lucky Charm',     rarity: 'uncommon', glyph: '🍀', powerBonus: 1, defenseBonus: 1 }] },
          { user: 'mason42',      survived: false, goldGained: 0,  xpGained: 6,
            className: 'mage',    classGlyph: '🪄', classTint: '#B452FF', avatar: '',
            equipped: {}, loot: [] }
        ]
      }), 13000);
    }, 9000);
  }
  connect();
})();
