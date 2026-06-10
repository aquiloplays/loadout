/*
 * aquilo.gg Gift Jar overlay.
 *
 * Cross-platform support jar: every sub, resub, gift sub, cheer,
 * member, super chat, tip and TikTok gift drops a token into a glass
 * jar with real rigid-body physics (Matter.js). Tokens stack, settle,
 * sleep, and persist across OBS restarts.
 *
 * Architecture:
 *   GEOMETRY    one set of jar coordinates drives BOTH the drawn SVG
 *               glass and the Matter.js static walls, so what you see
 *               is exactly what the tokens collide with.
 *   TOKENS      pre-rendered offscreen canvases per token type (coins,
 *               gems, gift boxes, hearts). TikTok gifts use the real
 *               gift PNG straight from TikFinity.
 *   FEEDS       direct WebSocket clients for Streamer.bot (Twitch /
 *               YouTube / Kick) and TikFinity (TikTok). Same event
 *               shapes and URL params as SF's sf-direct.js, so docs
 *               and muscle memory carry over.
 *
 * No StreamFusion, no Loadout DLL, no cloud account required.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
  var rand = Math.random;

  // ────────────────────────────────────────────────────────────────────
  // CONFIG
  // ────────────────────────────────────────────────────────────────────
  function num(name, dflt) {
    var v = parseFloat(params.get(name));
    return Number.isFinite(v) ? v : dflt;
  }
  function flag(name, dflt) {
    var v = params.get(name);
    if (v == null) return dflt;
    return /^(1|true|yes|on)$/i.test(v);
  }

  var cfg = {
    sbHost:    params.get('sbHost') || '127.0.0.1',
    sbPort:    num('sbPort', 8080),
    sbPass:    params.get('sbPass') || '',
    useTF:     flag('tf', true),
    tfPort:    num('tfPort', 21213),
    events:    (params.get('events') || 'subs,resubs,gifts,bits,members,superchats,tips,tiktok')
                 .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
    maxItems:  clamp(num('maxItems', 140), 20, 400),
    burst:     clamp(num('burst', 30), 5, 120),
    iconScale: clamp(num('iconScale', 1), 0.4, 3),
    jarScale:  clamp(num('jarScale', 1), 0.4, 1.6),
    gravity:   clamp(num('gravity', 1), 0.2, 3),
    bounce:    clamp(num('bounce', 1), 0, 2.5),
    label:     params.get('label') != null ? params.get('label') : 'GIFTS',
    counter:   flag('counter', true),
    status:    flag('status', true),
    persist:   flag('persist', true),
    ttlHours:  clamp(num('ttlHours', 12), 0.1, 24 * 14),
    jarKey:    params.get('jar') || 'default',
    demo:      flag('demo', false),
    testBg:    flag('bg', false),
    debug:     flag('debug', false)
  };

  if (cfg.testBg) document.body.classList.add('test-bg');
  if (cfg.demo) $('demoBadge').hidden = false;
  if (cfg.counter) $('counterChip').hidden = false;

  function catEnabled(cat) { return cfg.events.indexOf(cat) >= 0; }

  // ────────────────────────────────────────────────────────────────────
  // BRAND ART. Glyph paths come from sf-icons.js (already shipped with
  // the SF overlays), 24x24 viewbox, brand-accurate.
  // ────────────────────────────────────────────────────────────────────
  var GLYPH = {
    tw: 'M11.571 4.714h1.715v5.143h-1.715zm4.715 0h1.714v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0H6zm14.571 11.143L17.143 14.57h-3.428l-3 3v-3H6.857V1.714h13.714v9.429z',
    yt: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
    tt: 'M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.11z',
    kk: 'M3 3v18h5.4v-5.4h2.7L13.8 21h6.3l-3.6-7.2 3.6-7.2h-6.3l-2.7 5.4H8.4V3z',
    star:  'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
    heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
  };

  var BRAND = { tw: '#9146ff', yt: '#e62117', kk: '#53fc18', tt: '#16181d' };
  var GEM_COLORS = ['#9aa7b8', '#a05ef0', '#1cc8a8', '#3b9bff', '#f5494f'];

  function shade(hex, f) {
    // f > 0 lighten toward white, f < 0 darken toward black.
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var t = f < 0 ? 0 : 255, a = Math.abs(f);
    r = Math.round(r + (t - r) * a); g = Math.round(g + (t - g) * a); b = Math.round(b + (t - b) * a);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // ────────────────────────────────────────────────────────────────────
  // TOKEN FACTORY. Each key renders once into a 128px offscreen canvas
  // and is blitted scaled per frame. Keys:
  //   coin:tw|yt|kk|tt   platform sub coin
  //   box:tw|yt|kk|tt    gift-sub box in platform color
  //   gem:0..4           bits gem by tier color
  //   member             YouTube member coin (green star)
  //   sc / ss            super chat ($) / super sticker (star)
  //   tip                gold $ coin
  //   heart:tw|yt|kk|tt  follow heart (opt-in)
  // ────────────────────────────────────────────────────────────────────
  var TOKEN_PX = 128;
  var tokenCache = Object.create(null);

  function newLayer() {
    var c = document.createElement('canvas');
    c.width = TOKEN_PX; c.height = TOKEN_PX;
    return c;
  }

  function drawGlyph(ctx, d, color, cx, cy, size) {
    var s = size / 24;
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(s, s);
    ctx.fillStyle = color;
    ctx.fill(new Path2D(d));
    ctx.restore();
  }

  function drawCoin(bg, glyphKey, glyphColor, opts) {
    opts = opts || {};
    var c = newLayer(), ctx = c.getContext('2d');
    var m = TOKEN_PX / 2, R = m - 6;
    var g = ctx.createRadialGradient(m - R * 0.4, m - R * 0.45, R * 0.15, m, m, R * 1.15);
    g.addColorStop(0, shade(bg, 0.34));
    g.addColorStop(0.55, bg);
    g.addColorStop(1, shade(bg, -0.30));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(m, m, R, 0, Math.PI * 2); ctx.fill();
    // rim
    ctx.lineWidth = 7;
    ctx.strokeStyle = shade(bg, -0.42);
    ctx.beginPath(); ctx.arc(m, m, R - 3.5, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(m, m, R - 9, -Math.PI * 0.92, -Math.PI * 0.28); ctx.stroke();
    if (opts.duotone) {
      // TikTok treatment: cyan + red ghosts behind the white note.
      drawGlyph(ctx, GLYPH[glyphKey], '#25f4ee', m - 3, m - 3, TOKEN_PX * 0.56);
      drawGlyph(ctx, GLYPH[glyphKey], '#fe2c55', m + 3, m + 3, TOKEN_PX * 0.56);
      drawGlyph(ctx, GLYPH[glyphKey], '#ffffff', m, m, TOKEN_PX * 0.56);
    } else if (opts.text) {
      ctx.font = '900 ' + Math.round(TOKEN_PX * 0.6) + 'px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = glyphColor;
      ctx.fillText(opts.text, m, m + TOKEN_PX * 0.03);
    } else {
      drawGlyph(ctx, GLYPH[glyphKey], glyphColor, m, m, TOKEN_PX * 0.56);
    }
    return c;
  }

  function drawGem(color) {
    var c = newLayer(), ctx = c.getContext('2d');
    var top = [64, 14], left = [18, 52], right = [110, 52], bot = [64, 116];
    function poly(pts) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    }
    poly([top, right, bot, left]);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = shade(color, -0.38);
    ctx.lineJoin = 'round'; ctx.stroke();
    // top table facet, lighter
    poly([top, right, left]);
    ctx.fillStyle = 'rgba(255,255,255,0.26)'; ctx.fill();
    // left lower facet, darker
    poly([left, [64, 52], bot]);
    ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fill();
    // ridge lines
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.moveTo(left[0], left[1]); ctx.lineTo(64, 52); ctx.lineTo(right[0], right[1]); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(64, 52); ctx.lineTo(bot[0], bot[1]); ctx.stroke();
    // sparkle
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.arc(52, 34, 6, 0, Math.PI * 2); ctx.fill();
    return c;
  }

  function drawBox(color) {
    var c = newLayer(), ctx = c.getContext('2d');
    function rr(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    // body
    var g = ctx.createLinearGradient(0, 52, 0, 114);
    g.addColorStop(0, color);
    g.addColorStop(1, shade(color, -0.26));
    ctx.fillStyle = g; rr(24, 52, 80, 62, 10); ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = shade(color, -0.4); ctx.stroke();
    // lid
    ctx.fillStyle = shade(color, 0.18); rr(15, 34, 98, 24, 9); ctx.fill();
    ctx.strokeStyle = shade(color, -0.34); ctx.stroke();
    // ribbon
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(57, 34, 14, 80);
    // bow
    ctx.beginPath(); ctx.ellipse(48, 26, 13, 9, -0.45, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(80, 26, 13, 9, 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(64, 29, 7, 0, Math.PI * 2); ctx.fill();
    return c;
  }

  function token(key) {
    if (tokenCache[key]) return tokenCache[key];
    var c = null, p = key.split(':'), kind = p[0], arg = p[1];
    if (kind === 'coin') {
      if (arg === 'tt')      c = drawCoin(BRAND.tt, 'tt', '#fff', { duotone: true });
      else if (arg === 'kk') c = drawCoin(BRAND.kk, 'kk', '#07210a');
      else                   c = drawCoin(BRAND[arg] || '#777', arg, '#ffffff');
    }
    else if (kind === 'box')   c = drawBox(arg === 'tt' ? '#fe2c55' : (BRAND[arg] || '#e2588f'));
    else if (kind === 'img')   c = drawBox('#fe2c55'); // TikTok gift with no art URL yet
    else if (kind === 'gem')   c = drawGem(GEM_COLORS[+arg] || GEM_COLORS[0]);
    else if (kind === 'member')c = drawCoin('#2ba640', 'star', '#ffffff');
    else if (kind === 'sc')    c = drawCoin('#1565c0', null, '#ffffff', { text: '$' });
    else if (kind === 'ss')    c = drawCoin('#00bfa5', 'star', '#ffffff');
    else if (kind === 'tip')   c = drawCoin('#f0b231', null, '#5b3c05', { text: '$' });
    else if (kind === 'heart') c = drawCoin('#232a38', 'heart', BRAND[arg] === '#16181d' ? '#fe2c55' : (BRAND[arg] || '#ff5d8f'));
    else                       c = drawCoin('#777777', 'star', '#ffffff');
    tokenCache[key] = c;
    return c;
  }

  // TikTok gift PNGs. Loaded without crossOrigin so any CDN works; we
  // never read pixels back, so canvas tainting is irrelevant.
  var imgCache = Object.create(null);
  function giftImage(url) {
    if (!url) return null;
    if (imgCache[url]) return imgCache[url];
    var im = new Image();
    im.decoding = 'async';
    im.src = url;
    imgCache[url] = im;
    return im;
  }

  // ────────────────────────────────────────────────────────────────────
  // GEOMETRY + PHYSICS WORLD
  // ────────────────────────────────────────────────────────────────────
  var M = window.Matter;
  var engine = M.Engine.create({ enableSleeping: true });
  engine.gravity.y = cfg.gravity;
  // stiffer stacks: deep piles settle without sponging into the glass
  engine.positionIterations = 10;
  engine.velocityIterations = 6;

  var canvas = $('jarCanvas');
  var ctx2d = canvas.getContext('2d');
  var geo = null;          // current jar geometry
  var walls = [];          // static bodies
  var items = [];          // live tokens, oldest first
  var total = 0;           // session counter (true event counts)

  function computeGeo() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var W = clamp(Math.min(vw * 0.94, vh / 1.5), 200, 980) * cfg.jarScale;
    var H = W * 1.32;
    var cx = vw / 2;
    var bottom = vh - Math.max(8, vh * 0.015);
    var top = bottom - H;
    var mw = 0.30 * W;            // mouth half-width
    var bw = 0.455 * W;           // body half-width
    var lipW = mw + 0.052 * W;
    var glass = Math.max(5, 0.026 * W);
    // inner cavity polyline, right side, top to bottom
    var R = [
      [mw,             top + 0.075 * H],
      [bw,             top + 0.235 * H],
      [bw,             top + 0.800 * H],
      [bw - 0.030 * W, top + 0.875 * H],
      [bw - 0.095 * W, top + 0.925 * H],
      [bw - 0.165 * W, top + 0.945 * H]
    ];
    return {
      vw: vw, vh: vh, W: W, H: H, cx: cx, top: top, bottom: bottom,
      mw: mw, bw: bw, lipW: lipW, glass: glass, R: R,
      floorY: top + 0.945 * H,
      s: W / 520
    };
  }

  function segBody(x1, y1, x2, y2, t, invisible) {
    // A static rectangle whose INNER face lies on the segment, inset by
    // the glass half-thickness: the SVG stroke is centered on the same
    // polyline, so tokens must rest on the stroke's INNER edge, not its
    // centerline, or they look sunk into the glass.
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
    var nx = dy / len, ny = -dx / len;
    var refX = midX - geo.cx, refY = midY - (geo.top + 0.5 * geo.H);
    if (nx * refX + ny * refY < 0) { nx = -nx; ny = -ny; }
    var off = t / 2 - (invisible ? 0 : geo.glass);
    var body = M.Bodies.rectangle(
      midX + nx * off, midY + ny * off, len + t, t,
      { isStatic: true, angle: Math.atan2(dy, dx), friction: 0.35, restitution: 0.05 }
    );
    body._invisible = !!invisible;
    return body;
  }

  function buildWalls() {
    for (var i = 0; i < walls.length; i++) M.Composite.remove(engine.world, walls[i]);
    walls = [];
    var t = Math.max(16, 0.07 * geo.W);
    var cx = geo.cx, R = geo.R;
    function add(b) { walls.push(b); M.Composite.add(engine.world, b); }
    // jar walls, both sides
    for (var k = 0; k < R.length - 1; k++) {
      add(segBody(cx + R[k][0], R[k][1], cx + R[k + 1][0], R[k + 1][1], t));
      add(segBody(cx - R[k][0], R[k][1], cx - R[k + 1][0], R[k + 1][1], t));
    }
    // floor
    var fx = R[R.length - 1][0];
    add(segBody(cx - fx, geo.floorY, cx + fx, geo.floorY, t));
    // invisible funnel above the mouth so nothing is ever lost off-jar
    var fTopX = geo.mw + 0.45 * geo.W;
    add(segBody(cx + fTopX, -120, cx + geo.mw, R[0][1] - 4, t, true));
    add(segBody(cx - fTopX, -120, cx - geo.mw, R[0][1] - 4, t, true));
  }

  // ────────────────────────────────────────────────────────────────────
  // JAR SVG (back tint + front glass), generated from the same geometry
  // ────────────────────────────────────────────────────────────────────
  function pathFromPolyline(closeAcrossMouth) {
    var R = geo.R, cx = geo.cx;
    var d = 'M ' + (cx - R[0][0]).toFixed(1) + ' ' + R[0][1].toFixed(1);
    for (var i = 1; i < R.length; i++) d += ' L ' + (cx - R[i][0]).toFixed(1) + ' ' + R[i][1].toFixed(1);
    for (var j = R.length - 1; j >= 0; j--)  d += ' L ' + (cx + R[j][0]).toFixed(1) + ' ' + R[j][1].toFixed(1);
    if (closeAcrossMouth) d += ' Z';
    return d;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildJarSvg() {
    var g = geo, cx = g.cx;
    var vb = '0 0 ' + g.vw + ' ' + g.vh;
    var back = $('jarBack'), front = $('jarFront');
    back.setAttribute('viewBox', vb);
    front.setAttribute('viewBox', vb);

    back.innerHTML =
      '<defs>' +
        '<linearGradient id="cavGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="rgba(185,220,255,0.05)"/>' +
          '<stop offset="0.6" stop-color="rgba(150,190,235,0.09)"/>' +
          '<stop offset="1" stop-color="rgba(125,165,215,0.16)"/>' +
        '</linearGradient>' +
        '<radialGradient id="glowGrad" cx="0.5" cy="0.5" r="0.5">' +
          '<stop offset="0" style="stop-color:var(--accent)" stop-opacity="0.30"/>' +
          '<stop offset="1" style="stop-color:var(--accent)" stop-opacity="0"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<ellipse cx="' + cx + '" cy="' + (g.bottom + 4) + '" rx="' + (0.62 * g.W) + '" ry="' + (0.05 * g.H) + '" fill="url(#glowGrad)"/>' +
      '<path d="' + pathFromPolyline(true) + '" fill="url(#cavGrad)"/>' +
      '<ellipse cx="' + cx + '" cy="' + (g.floorY - 0.012 * g.H) + '" rx="' + (g.bw * 0.82) + '" ry="' + (0.030 * g.H) + '" fill="rgba(0,0,0,0.22)"/>';

    var labelSvg = '';
    if (cfg.label) {
      labelSvg =
        '<text x="' + cx + '" y="' + (g.top + 0.565 * g.H) + '" text-anchor="middle" ' +
        'font-family="var(--font)" font-weight="800" font-size="' + (0.075 * g.W) + '" ' +
        'letter-spacing="' + (0.022 * g.W) + '" fill="rgba(255,255,255,0.12)">' +
        esc(String(cfg.label).toUpperCase()) + '</text>';
    }

    front.innerHTML =
      '<defs>' +
        '<linearGradient id="glassGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="rgba(255,255,255,0.34)"/>' +
          '<stop offset="0.5" stop-color="rgba(255,255,255,0.13)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0.30)"/>' +
        '</linearGradient>' +
        '<linearGradient id="lipGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="rgba(255,255,255,0.16)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0.05)"/>' +
        '</linearGradient>' +
        '<linearGradient id="sheenGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="rgba(255,255,255,0.07)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0.015)"/>' +
        '</linearGradient>' +
      '</defs>' +
      // faint sheen over the tokens so they read as "inside the glass"
      '<path d="' + pathFromPolyline(true) + '" fill="url(#sheenGrad)"/>' +
      // glass wall
      '<path d="' + pathFromPolyline(false) + '" fill="none" stroke="url(#glassGrad)" ' +
        'stroke-width="' + (2 * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path d="' + pathFromPolyline(false) + '" fill="none" stroke="rgba(255,255,255,0.26)" stroke-width="1.6" stroke-linejoin="round"/>' +
      // specular streaks
      '<line x1="' + (cx - g.bw + 0.085 * g.W) + '" y1="' + (g.top + 0.30 * g.H) + '" x2="' + (cx - g.bw + 0.085 * g.W) + '" y2="' + (g.top + 0.70 * g.H) + '" ' +
        'stroke="rgba(255,255,255,0.09)" stroke-width="' + (0.05 * g.W) + '" stroke-linecap="round"/>' +
      '<line x1="' + (cx + g.bw - 0.085 * g.W) + '" y1="' + (g.top + 0.34 * g.H) + '" x2="' + (cx + g.bw - 0.085 * g.W) + '" y2="' + (g.top + 0.52 * g.H) + '" ' +
        'stroke="rgba(255,255,255,0.07)" stroke-width="' + (0.04 * g.W) + '" stroke-linecap="round"/>' +
      // lip band
      '<rect x="' + (cx - g.lipW) + '" y="' + g.top + '" width="' + (2 * g.lipW) + '" height="' + (0.075 * g.H) + '" rx="' + (0.028 * g.W) + '" ' +
        'fill="url(#lipGrad)" stroke="rgba(255,255,255,0.30)" stroke-width="1.6"/>' +
      '<line x1="' + (cx - g.lipW) + '" y1="' + (g.top + 0.078 * g.H) + '" x2="' + (cx + g.lipW) + '" y2="' + (g.top + 0.078 * g.H) + '" ' +
        'style="stroke:var(--accent)" stroke-opacity="0.4" stroke-width="2"/>' +
      labelSvg;

    // anchor the DOM chrome to the jar
    var chip = $('counterChip');
    chip.style.left = cx + 'px';
    chip.style.top = (g.top + 0.9725 * g.H) + 'px';
    var toast = $('bigToast');
    toast.style.left = cx + 'px';
    toast.style.top = Math.max(34, g.top - 46) + 'px';
  }

  function sizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(geo.vw * dpr);
    canvas.height = Math.round(geo.vh * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ────────────────────────────────────────────────────────────────────
  // ITEMS
  // ────────────────────────────────────────────────────────────────────
  var BODY_OPTS = {
    coin: { restitution: 0.24, shape: 'circle' },
    box:  { restitution: 0.14, shape: 'rect' },
    gem:  { restitution: 0.34, shape: 'gem' },
    img:  { restitution: 0.22, shape: 'circle' }
  };

  function shapeFor(key) {
    var kind = key.split(':')[0];
    if (kind === 'box') return BODY_OPTS.box;
    if (kind === 'gem') return BODY_OPTS.gem;
    if (kind === 'img') return BODY_OPTS.img;
    return BODY_OPTS.coin;
  }

  function makeBody(key, r, x, y) {
    var o = shapeFor(key);
    var common = {
      restitution: clamp(o.restitution * cfg.bounce, 0, 0.95),
      friction: 0.45,
      frictionStatic: 0.6,
      frictionAir: 0.012,
      density: 0.0018,
      sleepThreshold: 70
    };
    if (o.shape === 'rect') return M.Bodies.rectangle(x, y, 1.5 * r, 1.28 * r, common);
    if (o.shape === 'gem') {
      var v = [
        { x: 0, y: -0.78 * r }, { x: 0.72 * r, y: -0.19 * r },
        { x: 0, y: 0.81 * r }, { x: -0.72 * r, y: -0.19 * r }
      ];
      var b = M.Bodies.fromVertices(x, y, [v], common, true);
      if (b) return b;
    }
    return M.Bodies.circle(x, y, Math.max(7, r * 0.96), common);
  }

  function spawnItem(rec) {
    var g = geo;
    var x = g.cx + (rand() * 2 - 1) * g.mw * 0.66;
    var y = -60 - rand() * 160;
    var r = Math.max(9, rec.r);
    var body = makeBody(rec.k, r, x, y);
    M.Body.setAngularVelocity(body, (rand() * 2 - 1) * 0.16);
    M.Body.setVelocity(body, { x: (g.cx - x) * 0.002, y: 2 + rand() * 2 });
    M.Composite.add(engine.world, body);
    items.push({ body: body, k: rec.k, r: r, img: rec.i || null, dying: 0 });
    // cap enforcement, oldest first
    var live = 0;
    for (var i = 0; i < items.length; i++) if (!items[i].dying) live++;
    for (var j = 0; live > cfg.maxItems && j < items.length; j++) {
      if (!items[j].dying) { items[j].dying = performance.now(); live--; }
    }
    schedulePersist();
  }

  // queued spawning so gift bombs pour instead of teleporting in
  var queue = [];
  var drainAcc = 0;
  function drainMs() { return queue.length > 60 ? 26 : queue.length > 20 ? 48 : 88; }

  function enqueue(key, r, imgUrl, n) {
    n = n || 1;
    for (var i = 0; i < n; i++) queue.push({ k: key, r: r, i: imgUrl || null });
    // hard safety so a 10k bomb can't build an unbounded queue
    if (queue.length > 600) queue.length = 600;
  }

  // ────────────────────────────────────────────────────────────────────
  // COUNTER, TOAST, STATUS
  // ────────────────────────────────────────────────────────────────────
  var chipEl = $('counterChip'), chipNum = $('counterNum');
  function bumpCounter(n) {
    total += n;
    chipNum.textContent = total.toLocaleString();
    if (cfg.counter) {
      chipEl.classList.remove('bump');
      void chipEl.offsetWidth;
      chipEl.classList.add('bump');
    }
    schedulePersist();
  }

  var toastTimer = 0;
  function showToast(html) {
    var t = $('bigToast');
    t.innerHTML = html;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3100);
  }

  var sbConnected = false, tfConnected = false, statusFade = 0;
  function statusUpdate() {
    if (!cfg.status) return;
    var el = $('statusDot'), txt = $('statusText');
    el.hidden = false;
    el.classList.remove('faded');
    var on = [];
    if (sbConnected) on.push('Streamer.bot');
    if (tfConnected) on.push('TikFinity');
    if (on.length) {
      el.classList.add('ok');
      txt.textContent = on.join(' + ') + ' connected';
      clearTimeout(statusFade);
      statusFade = setTimeout(function () { el.classList.add('faded'); }, 6000);
    } else {
      el.classList.remove('ok');
      txt.textContent = cfg.demo ? 'demo mode' : 'waiting for Streamer.bot' + (cfg.useTF ? ' / TikFinity' : '');
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // EVENT ROUTING. All sizes scale with the jar so a 600px source and a
  // 1080px source look identical, just bigger.
  // ────────────────────────────────────────────────────────────────────
  function S(px) { return px * geo.s * cfg.iconScale; }

  function gemTier(bits) {
    return bits < 100 ? 0 : bits < 1000 ? 1 : bits < 5000 ? 2 : bits < 10000 ? 3 : 4;
  }
  function gemSize(bits) {
    return S(bits < 100 ? 13 : bits < 1000 ? 17 : bits < 5000 ? 23 : bits < 10000 ? 29 : 36);
  }
  function amtSize(a) { return S(clamp(20 + 8 * Math.log10(Math.max(a || 1, 1)), 20, 40)); }
  function ttGiftSize(perCoin) {
    return S(perCoin < 10 ? 13 : perCoin < 100 ? 19 : perCoin < 1000 ? 27 : perCoin < 10000 ? 35 : 44);
  }
  function subSize(tier) { return S(tier === 3 ? 36 : tier === 2 ? 31 : 26); }
  function parseTier(t) {
    var s = String(t || '');
    if (/3/.test(s)) return 3;
    if (/2/.test(s)) return 2;
    return 1;
  }

  // Twitch fires GiftBomb once AND GiftSub per recipient; suppress the
  // singles for a short window so a 50 bomb is 50 boxes, not 100.
  var recentBombs = Object.create(null);
  function bombGuard(gifter) {
    var k = String(gifter || 'anon').toLowerCase();
    recentBombs[k] = Date.now() + 20000;
  }
  function bombSuppressed(gifter) {
    var k = String(gifter || 'anon').toLowerCase();
    return (recentBombs[k] || 0) > Date.now();
  }

  function drop(cat, key, r, opts) {
    if (!catEnabled(cat)) return;
    opts = opts || {};
    var n = Math.max(1, Math.round(opts.count || 1));
    enqueue(key, r, opts.img, Math.min(n, cfg.burst));
    bumpCounter(n);
    if (opts.toast) showToast(opts.toast);
  }

  function onAlert(a) {
    var p = a.platform || 'tw';
    var who = '<b>' + esc(a.user || 'someone') + '</b>';
    switch (a.eventType) {
      case 'sub':
        drop('subs', 'coin:' + p, subSize(parseTier(a.tier)));
        break;
      case 'resub':
        drop('resubs', 'coin:' + p, subSize(parseTier(a.tier)));
        break;
      case 'gift': {
        if (bombSuppressed(a.gifter) && !a.isBomb) return;
        if (a.isBomb) bombGuard(a.gifter);
        var n = Math.max(1, a.amount || 1);
        drop('gifts', 'box:' + p, S(21), {
          count: n,
          toast: n >= 10 ? who + ' dropped ' + n + ' gift subs' : null
        });
        break;
      }
      case 'cheer': {
        var bits = a.amount || 0;
        if (bits <= 0) return;
        drop('bits', 'gem:' + gemTier(bits), gemSize(bits), {
          toast: bits >= 5000 ? who + ' cheered ' + bits.toLocaleString() + ' bits' : null
        });
        break;
      }
      case 'membership':
        drop('members', 'member', S(27));
        break;
      case 'superchat':
        drop('superchats', 'sc', amtSize(a.amount), {
          toast: (a.amount || 0) >= 20 ? who + ' super chatted' : null
        });
        break;
      case 'supersticker':
        drop('superchats', 'ss', S(22));
        break;
      case 'tip':
        drop('tips', 'tip', amtSize(a.amount), {
          toast: (a.amount || 0) >= 50 ? who + ' tipped' : null
        });
        break;
      case 'ttgift': {
        var per = a.perCoin || 1;
        var cnt = Math.max(1, a.amount || 1);
        var totalCoins = per * cnt;
        drop('tiktok', 'img', ttGiftSize(per), {
          count: Math.min(cnt, 20),
          img: a.giftImage || null,
          toast: totalCoins >= 1000 ? who + ' sent ' + esc(a.giftName || 'a gift') + (cnt > 1 ? ' x' + cnt : '') : null
        });
        if (cnt > 20) bumpCounter(cnt - 20);
        break;
      }
      case 'follow':
        drop('follows', 'heart:' + p, S(11));
        break;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // STREAMER.BOT FEED (Twitch / YouTube / Kick). Hello, optional Auth,
  // Subscribe handshake, exponential reconnect. Event field mapping
  // mirrors sf-direct.js, which is in production across the SF overlays.
  // ────────────────────────────────────────────────────────────────────
  function sbRoute(d) {
    if (!d || !d.event) return;
    var src = String(d.event.source || '').toLowerCase();
    var type = String(d.event.type || '').toLowerCase();
    var data = d.data || {};
    var plat = src === 'twitch' ? 'tw' : src === 'youtube' ? 'yt' : src === 'kick' ? 'kk' : null;

    // platform-less tips (StreamElements etc. routed through SB)
    if (!plat) {
      if (type === 'tip' || type === 'donation') {
        var ud = data.user || data.donor || {};
        onAlert({ platform: 'tw', eventType: 'tip', user: ud.displayName || ud.name || data.name || 'someone', amount: Number(data.amount || 0) });
      }
      return;
    }

    if (type === 'follow' || type === 'followed' || type === 'channelfollow' || type === 'newfollower') {
      var uf = data.user || data.follower || {};
      return onAlert({ platform: plat, eventType: 'follow', user: uf.displayName || data.displayName || data.user_name || 'someone' });
    }
    if (type === 'sub' || type === 'subscribe' || type === 'subscription' || type === 'newsubscriber') {
      var u1 = data.user || data.subscriber || {};
      return onAlert({ platform: plat, eventType: 'sub', user: u1.displayName || u1.name || 'someone', tier: data.subTier || data.tier || '1000' });
    }
    if (type === 'resub' || type === 'resubscribe') {
      var u2 = data.user || data.subscriber || {};
      return onAlert({ platform: plat, eventType: 'resub', user: u2.displayName || u2.name || 'someone', tier: data.subTier || data.tier || '1000' });
    }
    if (type === 'giftsub' || type === 'subgift' || type === 'giftedsub') {
      var ug = data.user || data.gifter || {};
      return onAlert({ platform: plat, eventType: 'gift', gifter: ug.displayName || ug.name || 'someone',
        user: ug.displayName || ug.name || 'someone', amount: Number(data.total || data.giftCount || data.amount || 1) });
    }
    if (type === 'giftbomb' || type === 'massgift' || type === 'communitysubgift' || type === 'masssubgift' || type === 'giftedsubscriptions') {
      var ub = data.user || data.gifter || {};
      return onAlert({ platform: plat, eventType: 'gift', isBomb: true, gifter: ub.displayName || ub.name || 'someone',
        user: ub.displayName || ub.name || 'someone', amount: Number(data.gifts || data.giftCount || data.amount || data.total || 1) });
    }
    if (type === 'cheer' || type === 'bits') {
      var uc = data.user || data.cheerer || {};
      return onAlert({ platform: plat, eventType: 'cheer', user: uc.displayName || uc.name || 'someone', amount: Number(data.bits || data.amount || 0) });
    }
    if (type === 'superchat' || type === 'newsuperchat') {
      var us = data.user || {};
      var amt = Number(data.amount || data.amountValue || 0);
      if (!amt && data.amountMicros) amt = Number(data.amountMicros) / 1e6;
      return onAlert({ platform: 'yt', eventType: 'superchat', user: us.displayName || us.name || 'someone', amount: amt });
    }
    if (type === 'supersticker' || type === 'newsupersticker') {
      var uss = data.user || {};
      return onAlert({ platform: 'yt', eventType: 'supersticker', user: uss.displayName || uss.name || 'someone' });
    }
    if (type === 'newsponsor' || type === 'membership' || type === 'member' ||
        type === 'membershipgift' || type === 'giftmembershipreceived' || type === 'membershipmilestone') {
      var um = data.user || data.gifter || {};
      return onAlert({ platform: 'yt', eventType: 'membership', user: um.displayName || um.name || 'someone' });
    }
    if (type === 'tip' || type === 'donation') {
      var ut = data.user || data.donor || {};
      return onAlert({ platform: plat, eventType: 'tip', user: ut.displayName || ut.name || 'someone', amount: Number(data.amount || 0) });
    }
  }

  var sbBackoff = 1000;
  function connectSB() {
    var ws;
    try { ws = new WebSocket('ws://' + cfg.sbHost + ':' + cfg.sbPort + '/'); }
    catch (e) { setTimeout(connectSB, sbBackoff); sbBackoff = Math.min(sbBackoff * 1.8, 20000); return; }
    var subscribed = false;
    function subscribe() {
      if (subscribed) return;
      subscribed = true;
      try {
        ws.send(JSON.stringify({
          request: 'Subscribe', id: 'jar-sub',
          events: { Twitch: ['*'], YouTube: ['*'], Kick: ['*'], General: ['*'] }
        }));
      } catch (e) {}
    }
    ws.onopen = function () {
      sbBackoff = 1000;
      // some SB builds never send a hello when auth is off
      setTimeout(function () { if (ws.readyState === 1) subscribe(); }, 1200);
    };
    ws.onmessage = function (e) {
      var d; try { d = JSON.parse(e.data); } catch (x) { return; }
      if (d.request === 'Hello' || (d.event === undefined && d.authentication)) {
        if (d.authentication && cfg.sbPass) sbAuth(ws, d.authentication, subscribe);
        else subscribe();
        return;
      }
      if (d.status === 'ok' && d.id === 'jar-sub') {
        sbConnected = true;
        statusUpdate();
        return;
      }
      if (d.event) sbRoute(d);
    };
    ws.onerror = function () {};
    ws.onclose = function () {
      var was = sbConnected;
      sbConnected = false;
      if (was) statusUpdate();
      setTimeout(connectSB, sbBackoff);
      sbBackoff = Math.min(sbBackoff * 1.8, 20000);
    };
  }
  function sbAuth(ws, auth, done) {
    var enc = new TextEncoder();
    function h(s) {
      return crypto.subtle.digest('SHA-256', enc.encode(s)).then(function (buf) {
        return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
      });
    }
    h(cfg.sbPass + auth.salt).then(function (h1) { return h(h1 + auth.challenge); })
      .then(function (hash) {
        try { ws.send(JSON.stringify({ request: 'Authenticate', id: 'jar-auth', authentication: hash })); } catch (e) {}
        setTimeout(done, 150);
      })
      .catch(done);
  }

  // ────────────────────────────────────────────────────────────────────
  // TIKFINITY FEED (TikTok). Streak-aware: only the streak-end gift
  // event fires, with the full repeat count.
  // ────────────────────────────────────────────────────────────────────
  var tfBackoff = 1000;
  function connectTF() {
    if (!cfg.useTF) return;
    var ws;
    try { ws = new WebSocket('ws://localhost:' + cfg.tfPort + '/'); }
    catch (e) { setTimeout(connectTF, tfBackoff); tfBackoff = Math.min(tfBackoff * 1.8, 20000); return; }
    ws.onopen = function () { tfBackoff = 1000; tfConnected = true; statusUpdate(); };
    ws.onmessage = function (e) {
      var d; try { d = JSON.parse(e.data); } catch (x) { return; }
      var ev = String(d.event || d.type || d.action || '').toLowerCase();
      var data = d.data || d;
      var user = data.nickname || (data.user && data.user.nickname) || data.uniqueId || 'viewer';
      if (ev === 'gift') {
        var midStreak = Number(data.giftType) === 1 &&
          (data.repeatEnd === false || data.repeatEnd === 0 || data.repeatEnd === 'false');
        if (midStreak) return;
        onAlert({
          platform: 'tt', eventType: 'ttgift', user: user,
          amount: Number(data.repeatCount || data.giftCount || 1),
          perCoin: Number(data.diamondCount || data.giftCost || 1),
          giftName: data.giftName || 'Gift',
          giftImage: data.giftPictureUrl || data.giftImage || data.pictureUrl || data.imageUrl || ''
        });
        return;
      }
      if (ev === 'subscribe' || ev === 'subscription' || ev === 'member') {
        onAlert({ platform: 'tt', eventType: 'sub', user: user });
        return;
      }
      if (ev === 'follow') onAlert({ platform: 'tt', eventType: 'follow', user: user });
    };
    ws.onerror = function () {};
    ws.onclose = function () {
      var was = tfConnected;
      tfConnected = false;
      if (was) statusUpdate();
      setTimeout(connectTF, tfBackoff);
      tfBackoff = Math.min(tfBackoff * 1.8, 20000);
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // PERSISTENCE. The jar refills itself after an OBS restart. Radii are
  // stored normalized to jar width so a resized source restores cleanly.
  // ────────────────────────────────────────────────────────────────────
  var PERSIST_KEY = 'aq-gift-jar:v1:' + cfg.jarKey;
  var persistTimer = 0;

  function schedulePersist() {
    if (!cfg.persist) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 900);
  }
  function persistNow() {
    if (!cfg.persist) return;
    try {
      var recs = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].dying) continue;
        var rec = { k: items[i].k, r: +(items[i].r / geo.W).toFixed(5) };
        if (items[i].img) rec.i = items[i].img;
        recs.push(rec);
      }
      if (recs.length > cfg.maxItems) recs = recs.slice(recs.length - cfg.maxItems);
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ at: Date.now(), total: total, items: recs }));
    } catch (e) {}
  }
  function restore() {
    if (!cfg.persist) return;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(PERSIST_KEY) || 'null'); } catch (e) {}
    if (!saved || !saved.items) return;
    if (Date.now() - (saved.at || 0) > cfg.ttlHours * 3600 * 1000) {
      try { localStorage.removeItem(PERSIST_KEY); } catch (e) {}
      return;
    }
    total = saved.total || 0;
    chipNum.textContent = total.toLocaleString();
    for (var i = 0; i < saved.items.length && i < cfg.maxItems; i++) {
      var r = saved.items[i];
      queue.push({ k: r.k, r: Math.max(9, (r.r || 0.05) * geo.W), i: r.i || null });
    }
  }

  function resetJar() {
    queue.length = 0;
    for (var i = 0; i < items.length; i++) M.Composite.remove(engine.world, items[i].body);
    items.length = 0;
    total = 0;
    chipNum.textContent = '0';
    try { localStorage.removeItem(PERSIST_KEY); } catch (e) {}
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'r' || e.key === 'R') resetJar();
  });

  // ────────────────────────────────────────────────────────────────────
  // DEMO MODE
  // ────────────────────────────────────────────────────────────────────
  var DEMO_NAMES = ['NovaByte', 'Quietfawn', 'TTV_Wren', 'mossyhollow', 'PixelPyre', 'duskrunner', 'Kestrel77', 'glimmerjack'];
  function demoName() { return DEMO_NAMES[Math.floor(rand() * DEMO_NAMES.length)]; }
  function demoFire() {
    var roll = rand();
    var user = demoName();
    if (roll < 0.22)      onAlert({ platform: ['tw', 'yt', 'kk'][Math.floor(rand() * 3)], eventType: 'sub', user: user, tier: rand() < 0.2 ? '3000' : rand() < 0.45 ? '2000' : '1000' });
    else if (roll < 0.38) onAlert({ platform: 'tw', eventType: 'cheer', user: user, amount: [100, 250, 500, 1000, 5000, 10000][Math.floor(rand() * 6)] });
    else if (roll < 0.52) onAlert({ platform: 'tw', eventType: 'gift', isBomb: true, gifter: user, user: user, amount: [1, 3, 5, 10, 20][Math.floor(rand() * 5)] });
    else if (roll < 0.64) onAlert({ platform: 'tt', eventType: 'ttgift', user: user, amount: Math.ceil(rand() * 8), perCoin: [1, 5, 99, 500, 2999][Math.floor(rand() * 5)], giftName: 'Rose' });
    else if (roll < 0.74) onAlert({ platform: 'yt', eventType: 'membership', user: user });
    else if (roll < 0.84) onAlert({ platform: 'yt', eventType: 'superchat', user: user, amount: [2, 5, 10, 50, 100][Math.floor(rand() * 5)] });
    else if (roll < 0.92) onAlert({ platform: 'tt', eventType: 'sub', user: user });
    else                  onAlert({ platform: 'tw', eventType: 'tip', user: user, amount: [3, 5, 10, 25][Math.floor(rand() * 4)] });
  }
  function demoLoop() {
    if (!cfg.demo) return;
    demoFire();
    setTimeout(demoLoop, 1300 + rand() * 1500);
  }

  // ────────────────────────────────────────────────────────────────────
  // SIM + RENDER LOOPS. Physics and spawning run off a clock that does
  // not care whether requestAnimationFrame is alive (hidden tabs and
  // some CEF states throttle rAF to zero); drawing rides rAF when it
  // is available, plus a low-rate interval fallback so the jar never
  // freezes silently.
  // ────────────────────────────────────────────────────────────────────
  var STEP = 1000 / 60;
  var MAX_FALL = 24;          // px per step terminal velocity, prevents
                              // small tokens tunneling through the floor
  var lastSim = performance.now();
  var simAcc = 0;
  var sweepCounter = 0;
  var lastDraw = 0;

  window.addEventListener('error', function (e) {
    window.__lastErr = String(e && (e.message || e.error) || 'unknown');
  });

  function simTick(now) {
    var dt = Math.min(now - lastSim, 120);
    if (dt <= 0) return;
    lastSim = now;
    simAcc += dt;
    var steps = 0;
    while (simAcc >= STEP && steps < 5) {
      M.Engine.update(engine, STEP);
      simAcc -= STEP;
      steps++;
    }
    if (simAcc > STEP * 5) simAcc = 0; // hidden-tab catchup, drop the debt

    // terminal velocity clamp
    for (var v = 0; v < items.length; v++) {
      var vb = items[v].body;
      if (vb.velocity.y > MAX_FALL) M.Body.setVelocity(vb, { x: vb.velocity.x, y: MAX_FALL });
    }

    // queued spawns
    drainAcc += dt;
    var dm = drainMs();
    while (drainAcc >= dm && queue.length) {
      drainAcc -= dm;
      spawnItem(queue.shift());
    }
    if (!queue.length) drainAcc = 0;

    // escape sweep, safety net only
    if (++sweepCounter >= 150) {
      sweepCounter = 0;
      for (var s = 0; s < items.length; s++) {
        var b = items[s].body;
        if (b.position.y > geo.vh + 500 && !items[s].dying) {
          M.Body.setPosition(b, { x: geo.cx, y: -80 });
          M.Body.setVelocity(b, { x: 0, y: 2 });
        }
      }
    }
  }

  function draw() {
    ctx2d.clearRect(0, 0, geo.vw, geo.vh);
    var nowMs = performance.now();
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      var alpha = 1;
      if (it.dying) {
        alpha = 1 - (nowMs - it.dying) / 350;
        if (alpha <= 0) {
          M.Composite.remove(engine.world, it.body);
          items.splice(i, 1);
          continue;
        }
      }
      var pos = it.body.position;
      if (pos.y < -240) continue;
      ctx2d.save();
      ctx2d.globalAlpha = Math.max(0, alpha);
      ctx2d.translate(pos.x, pos.y);
      ctx2d.rotate(it.body.angle);
      var d = it.r * 2;
      var im = it.img ? giftImage(it.img) : null;
      if (im && im.complete && im.naturalWidth > 0) {
        ctx2d.drawImage(im, -it.r, -it.r, d, d);
      } else {
        ctx2d.drawImage(token(it.img ? 'box:tt' : it.k), -it.r, -it.r, d, d);
      }
      ctx2d.restore();
    }
  }

  var debugEl = null;
  function debugHud() {
    if (!debugEl) return;
    debugEl.textContent =
      'items ' + items.length + '  queue ' + queue.length +
      '  total ' + total +
      '  raf ' + Math.round(performance.now() - lastDraw) + 'ms' +
      (window.__lastErr ? '  ERR ' + window.__lastErr : '');
  }

  function frame(now) {
    try {
      simTick(now);
      draw();
      lastDraw = now;
      debugHud();
    } catch (e) {
      window.__lastErr = String(e && e.message || e);
    }
    requestAnimationFrame(frame);
  }

  // watchdog: keeps the sim moving when rAF is throttled to nothing
  setInterval(function () {
    var now = performance.now();
    if (now - lastDraw > 350) {
      try {
        simTick(now);
        draw();
        debugHud();
      } catch (e) {
        window.__lastErr = String(e && e.message || e);
      }
    }
  }, 250);

  // ────────────────────────────────────────────────────────────────────
  // RESIZE. Rebuild geometry and walls, then re-pour the existing
  // contents so the pile always matches the new jar.
  // ────────────────────────────────────────────────────────────────────
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var keep = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].dying) continue;
        keep.push({ k: items[i].k, rn: items[i].r / geo.W, i: items[i].img });
      }
      for (var j = 0; j < items.length; j++) M.Composite.remove(engine.world, items[j].body);
      items.length = 0;
      geo = computeGeo();
      sizeCanvas();
      buildWalls();
      buildJarSvg();
      for (var k = 0; k < keep.length; k++) {
        queue.push({ k: keep[k].k, r: Math.max(9, keep[k].rn * geo.W), i: keep[k].i });
      }
    }, 180);
  });

  window.addEventListener('beforeunload', persistNow);

  // debug / Streamer.bot Execute C# hook surface
  window.GiftJar = {
    drop: function (key, n, r) { enqueue(key || 'coin:tw', S(r || 26), null, n || 1); bumpCounter(n || 1); },
    reset: resetJar,
    demoFire: demoFire,
    cfg: cfg,
    engine: engine,
    items: items,
    geo: function () { return geo; },
    // deterministic hooks for selftests: spawn without the pour queue,
    // then step the engine synchronously without waiting on wall time
    spawnNow: function (key, r, n) {
      for (var i = 0; i < (n || 1); i++) spawnItem({ k: key || 'coin:tw', r: S(r || 26), i: null });
    },
    fastForward: function (ms) {
      var t = 0;
      while (t < (ms || 1000)) {
        M.Engine.update(engine, STEP);
        for (var v = 0; v < items.length; v++) {
          var vb = items[v].body;
          if (vb.velocity.y > MAX_FALL) M.Body.setVelocity(vb, { x: vb.velocity.x, y: MAX_FALL });
        }
        t += STEP;
      }
      draw();
    }
  };

  // ────────────────────────────────────────────────────────────────────
  // BOOT
  // ────────────────────────────────────────────────────────────────────
  geo = computeGeo();
  sizeCanvas();
  buildWalls();
  buildJarSvg();
  restore();
  statusUpdate();
  if (cfg.debug) {
    debugEl = document.createElement('div');
    debugEl.style.cssText =
      'position:fixed;top:6px;left:8px;z-index:99;font:600 12px monospace;' +
      'color:#9ef7d8;background:rgba(0,0,0,0.55);padding:4px 8px;border-radius:6px;white-space:pre;';
    document.body.appendChild(debugEl);
  }
  if (cfg.demo) {
    // opening burst so the jar reads instantly, then the steady loop
    for (var di = 0; di < 10; di++) setTimeout(demoFire, 250 + di * 320);
    setTimeout(demoLoop, 3800);
  } else {
    connectSB();
    connectTF();
  }
  requestAnimationFrame(frame);
})();
