/*
 * aquilo.gg Gift Jar overlay, v2.
 *
 * Cross-platform support jar: every sub, resub, gift sub, cheer,
 * member, super chat, tip and TikTok gift drops a token into a glass
 * jar with real rigid-body physics (Matter.js). Tokens stack, settle,
 * sleep, and persist across OBS restarts.
 *
 * v2 additions:
 *   JAR STYLES   photoreal glass renders (mason / bowl / cookie / hex,
 *                luma-alpha PNGs generated offline) drawn IN FRONT of
 *                the tokens so the glass wraps them, plus the original
 *                procedural "classic" SVG jar. Physics walls come from
 *                per-style polylines calibrated to the art.
 *   REAL BITS    Twitch's official animated cheermote GIFs, frame-
 *                decoded via ImageDecoder and played in-canvas, exactly
 *                the gems chat sees. Static frame and drawn-gem
 *                fallbacks keep old CEF builds working.
 *   REAL LOGOS   official brand marks fetched from simpleicons at
 *                runtime (embedded path fallback if the CDN is down).
 *   FULL MODES   recycle (default) / stop / spill / pop behavior when
 *                the pile reaches the jar neck.
 *   CONTAINMENT  velocity + spin clamps, thicker walls, and an
 *                out-of-bounds sweep that quietly reinserts strays so
 *                tokens can never glitch outside the glass.
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
  function pick(name, dflt, allowed) {
    var v = (params.get(name) || '').toLowerCase();
    return allowed.indexOf(v) >= 0 ? v : dflt;
  }

  var cfg = {
    sbHost:    params.get('sbHost') || '127.0.0.1',
    sbPort:    num('sbPort', 8080),
    sbPass:    params.get('sbPass') || '',
    useTF:     flag('tf', true),
    tfPort:    num('tfPort', 21213),
    events:    (params.get('events') || 'subs,resubs,gifts,bits,members,superchats,tips,tiktok')
                 .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
    jarStyle:  pick('jarStyle', 'classic', ['classic', 'bowl', 'hex', 'potion', 'vase']),
    wall:      pick('wall', 'glass', ['glass', 'frosted', 'crystal', 'glow']),
    slide:     pick('slide', 'off', ['off', 'down', 'left', 'right']),
    idleSecs:  clamp(num('idleSecs', 30), 3, 3600),
    discord:   params.get('discord') || '',
    recap:     flag('recap', !!params.get('discord')),
    full:      pick('full', 'recycle', ['recycle', 'stop', 'spill', 'pop']),
    bitsAnim:  flag('bitsAnim', true),
    maxItems:  clamp(num('maxItems', 140), 20, 400),
    burst:     clamp(num('burst', 30), 5, 120),
    iconScale: clamp(num('iconScale', 1), 0.4, 3),
    jarScale:  clamp(num('jarScale', 1), 0.4, 1.6),
    gravity:   clamp(num('gravity', 1), 0.2, 3),
    bounce:    clamp(num('bounce', 1), 0, 2.5),
    label:     params.get('label') != null ? params.get('label') : 'GIFTS',
    title:     params.get('title') || '',
    goal:      clamp(num('goal', 0), 0, 100000000),
    counter:   flag('counter', true),
    status:    flag('status', true),
    persist:   flag('persist', true),
    ttlHours:  clamp(num('ttlHours', 12), 0.1, 24 * 14),
    jarKey:    params.get('jar') || 'default',
    demo:      flag('demo', false),
    testBg:    flag('bg', false),
    debug:     clamp(num('debug', 0), 0, 2)
  };

  if (cfg.testBg) document.body.classList.add('test-bg');
  if (cfg.demo) $('demoBadge').hidden = false;
  if (cfg.counter) $('counterChip').hidden = false;

  function catEnabled(cat) { return cfg.events.indexOf(cat) >= 0; }

  // ────────────────────────────────────────────────────────────────────
  // BRAND ART. Embedded 24x24 paths (from sf-icons.js) are the instant
  // fallback; the official simpleicons marks stream in over them.
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
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var t = f < 0 ? 0 : 255, a = Math.abs(f);
    r = Math.round(r + (t - r) * a); g = Math.round(g + (t - g) * a); b = Math.round(b + (t - b) * a);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // Official simpleicons marks, fetched as SVG text so we control the
  // raster size (the CDN's SVGs carry no intrinsic width/height).
  var logoImgs = Object.create(null);
  function loadBrandLogos() {
    var want = { tw: ['twitch', 'ffffff'], yt: ['youtube', 'ffffff'], kk: ['kick', '07210a'], tt: ['tiktok', 'ffffff'] };
    Object.keys(want).forEach(function (p) {
      fetch('https://cdn.simpleicons.org/' + want[p][0] + '/' + want[p][1])
        .then(function (r) { if (!r.ok) throw 0; return r.text(); })
        .then(function (svg) {
          svg = svg.replace('<svg ', '<svg width="96" height="96" ');
          var im = new Image();
          im.onload = function () {
            logoImgs[p] = im;
            delete tokenCache['coin:' + p];
            delete tokenCache['heart:' + p];
          };
          im.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        })
        .catch(function () {});
    });
  }

  function tinted(img, color, size) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var x = c.getContext('2d');
    x.drawImage(img, 0, 0, size, size);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, size, size);
    return c;
  }

  // ────────────────────────────────────────────────────────────────────
  // TWITCH CHEERMOTES. The official animated gems, frame-decoded once
  // per tier and played in-canvas. Chain of fallbacks: animated frames
  // -> static first frame <img> -> drawn gem.
  // ────────────────────────────────────────────────────────────────────
  var CHEER_BASE = 'https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/';
  var CHEER_TIERS = [1, 100, 1000, 5000, 10000];
  var cheerAnims = Object.create(null);

  function loadCheer(tier) {
    if (cheerAnims[tier]) return cheerAnims[tier];
    var A = cheerAnims[tier] = { frames: [], total: 0, ready: false, img: null };
    var url = CHEER_BASE + tier + '/4.gif';
    var im = new Image();
    im.src = url;
    A.img = im;
    if (!window.ImageDecoder || !cfg.bitsAnim) return A;
    fetch(url)
      .then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); })
      .then(function (buf) {
        var dec = new ImageDecoder({ data: buf, type: 'image/gif' });
        return dec.tracks.ready.then(function () {
          var n = dec.tracks.selectedTrack.frameCount;
          var chain = Promise.resolve();
          for (var i = 0; i < n; i++) {
            (function (idx) {
              chain = chain.then(function () { return dec.decode({ frameIndex: idx }); })
                .then(function (res) {
                  var vf = res.image;
                  var dur = Math.max(20, (vf.duration || 80000) / 1000);
                  return createImageBitmap(vf).then(function (bmp) {
                    try { vf.close(); } catch (e) {}
                    A.total += dur;
                    A.frames.push({ bmp: bmp, until: A.total });
                  });
                });
            })(i);
          }
          return chain;
        });
      })
      .then(function () { if (A.frames.length > 1) A.ready = true; })
      .catch(function () {});
    return A;
  }

  function cheerFrame(A, t) {
    var m = t % A.total;
    for (var i = 0; i < A.frames.length; i++) {
      if (m < A.frames[i].until) return A.frames[i].bmp;
    }
    return A.frames[A.frames.length - 1].bmp;
  }

  function cheerTierFor(bits) {
    return bits >= 10000 ? 10000 : bits >= 5000 ? 5000 : bits >= 1000 ? 1000 : bits >= 100 ? 100 : 1;
  }

  // ────────────────────────────────────────────────────────────────────
  // TOKEN FACTORY. Pre-rendered offscreen canvases per key.
  //   coin:tw|yt|kk|tt    platform sub coin (official mark when loaded)
  //   box:tw|yt|kk|tt     gift-sub box in platform color
  //   cheer:<tier>        bits, drawn-gem fallback under the cheermote
  //   member / sc / ss    YouTube member, super chat, super sticker
  //   tip                 gold $ coin
  //   heart:<plat>        follow heart (opt-in)
  //   img                 TikTok gift artwork placeholder box
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
    ctx.lineWidth = 7;
    ctx.strokeStyle = shade(bg, -0.42);
    ctx.beginPath(); ctx.arc(m, m, R - 3.5, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(m, m, R - 9, -Math.PI * 0.92, -Math.PI * 0.28); ctx.stroke();

    var gs = TOKEN_PX * 0.56;
    var logo = opts.logoP ? logoImgs[opts.logoP] : null;
    if (opts.duotone) {
      if (logo) {
        ctx.drawImage(tinted(logo, '#25f4ee', 96), m - 3 - gs / 2, m - 3 - gs / 2, gs, gs);
        ctx.drawImage(tinted(logo, '#fe2c55', 96), m + 3 - gs / 2, m + 3 - gs / 2, gs, gs);
        ctx.drawImage(logo, m - gs / 2, m - gs / 2, gs, gs);
      } else {
        drawGlyph(ctx, GLYPH[glyphKey], '#25f4ee', m - 3, m - 3, gs);
        drawGlyph(ctx, GLYPH[glyphKey], '#fe2c55', m + 3, m + 3, gs);
        drawGlyph(ctx, GLYPH[glyphKey], '#ffffff', m, m, gs);
      }
    } else if (opts.text) {
      ctx.font = '900 ' + Math.round(TOKEN_PX * 0.6) + 'px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = glyphColor;
      ctx.fillText(opts.text, m, m + TOKEN_PX * 0.03);
    } else if (logo) {
      ctx.drawImage(logo, m - gs / 2, m - gs / 2, gs, gs);
    } else if (glyphKey) {
      drawGlyph(ctx, GLYPH[glyphKey], glyphColor, m, m, gs);
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
    poly([top, right, left]);
    ctx.fillStyle = 'rgba(255,255,255,0.26)'; ctx.fill();
    poly([left, [64, 52], bot]);
    ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.moveTo(left[0], left[1]); ctx.lineTo(64, 52); ctx.lineTo(right[0], right[1]); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(64, 52); ctx.lineTo(bot[0], bot[1]); ctx.stroke();
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
    var g = ctx.createLinearGradient(0, 52, 0, 114);
    g.addColorStop(0, color);
    g.addColorStop(1, shade(color, -0.26));
    ctx.fillStyle = g; rr(24, 52, 80, 62, 10); ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = shade(color, -0.4); ctx.stroke();
    ctx.fillStyle = shade(color, 0.18); rr(15, 34, 98, 24, 9); ctx.fill();
    ctx.strokeStyle = shade(color, -0.34); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(57, 34, 14, 80);
    ctx.beginPath(); ctx.ellipse(48, 26, 13, 9, -0.45, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(80, 26, 13, 9, 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(64, 29, 7, 0, Math.PI * 2); ctx.fill();
    return c;
  }

  function token(key) {
    if (tokenCache[key]) return tokenCache[key];
    var c = null, p = key.split(':'), kind = p[0], arg = p[1];
    if (kind === 'coin') {
      if (arg === 'tt')      c = drawCoin(BRAND.tt, 'tt', '#fff', { duotone: true, logoP: 'tt' });
      else if (arg === 'kk') c = drawCoin(BRAND.kk, 'kk', '#07210a', { logoP: 'kk' });
      else                   c = drawCoin(BRAND[arg] || '#777', arg, '#ffffff', { logoP: arg });
    }
    else if (kind === 'box')   c = drawBox(arg === 'tt' ? '#fe2c55' : (BRAND[arg] || '#e2588f'));
    else if (kind === 'img')   c = drawBox('#fe2c55');
    else if (kind === 'cheer') c = drawGem(GEM_COLORS[gemTier(+arg || 1)]);
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

  // TikTok gift PNGs straight from TikFinity. Loaded WITH crossOrigin
  // (their CDN sends ACAO *) so the canvas stays readable for the
  // stream recap GIF; if a regional CDN refuses CORS we retry plain
  // and quietly give up on recap capture instead of breaking the art.
  var imgCache = Object.create(null);
  function giftImage(url) {
    if (!url) return null;
    if (imgCache[url]) return imgCache[url];
    var im = new Image();
    im.decoding = 'async';
    im.crossOrigin = 'anonymous';
    im.onerror = function () {
      if (im._retried) return;
      im._retried = true;
      var plain = new Image();
      plain.decoding = 'async';
      plain.src = url;
      imgCache[url] = plain;
      rec.tainted = true;
    };
    im.src = url;
    imgCache[url] = im;
    return im;
  }

  // Real TikTok gift artwork for demo mode and for live events that
  // arrive without a picture URL. Canonical webcast CDN paths, each
  // verified serving image/webp at build time (2026-06). w = demo
  // pick weight, c = coin value.
  var TT_CDN = 'https://p16-webcast.tiktokcdn.com/img/';
  var DEMO_GIFTS = [
    { n: 'Rose',           c: 1,     w: 26, i: TT_CDN + 'maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp' },
    { n: 'TikTok',         c: 1,     w: 12, i: TT_CDN + 'maliva/webcast-va/802a21ae29f9fae5abe3693de9f874bd~tplv-obj.webp' },
    { n: 'Heart Me',       c: 1,     w: 8,  i: TT_CDN + 'maliva/webcast-va/d56945782445b0b8c8658ed44f894c7b~tplv-obj.webp' },
    { n: 'Ice Cream Cone', c: 1,     w: 8,  i: TT_CDN + 'maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.webp' },
    { n: 'GG',             c: 1,     w: 10, i: TT_CDN + 'maliva/webcast-va/3f02fa9594bd1495ff4e8aa5ae265eef~tplv-obj.webp' },
    { n: 'Finger Heart',   c: 5,     w: 12, i: TT_CDN + 'maliva/webcast-va/a4c4dc437fd3a6632aba149769491f49.png~tplv-obj.webp' },
    { n: 'Perfume',        c: 20,    w: 7,  i: TT_CDN + 'maliva/webcast-va/20b8f61246c7b6032777bb81bf4ee055~tplv-obj.webp' },
    { n: 'Doughnut',       c: 30,    w: 7,  i: TT_CDN + 'maliva/webcast-va/4e7ad6bdf0a1d860c538f38026d4e812~tplv-obj.webp' },
    { n: 'Hand Hearts',    c: 100,   w: 5,  i: TT_CDN + 'maliva/webcast-va/6cd022271dc4669d182cad856384870f~tplv-obj.webp' },
    { n: 'Confetti',       c: 100,   w: 5,  i: TT_CDN + 'maliva/webcast-va/cb4e11b3834e149f08e1cdcc93870b26~tplv-obj.webp' },
    { n: 'Corgi',          c: 299,   w: 4,  i: TT_CDN + 'maliva/webcast-va/148eef0884fdb12058d1c6897d1e02b9~tplv-obj.webp' },
    { n: 'Swan',           c: 699,   w: 3,  i: TT_CDN + 'maliva/webcast-va/97a26919dbf6afe262c97e22a83f4bf1~tplv-obj.webp' },
    { n: 'Galaxy',         c: 1000,  w: 3,  i: TT_CDN + 'alisg/webcast-sg/resource/823002ec1a76a2fd10c52c08943793e9.png~tplv-obj.webp' },
    { n: 'Fireworks',      c: 1088,  w: 2,  i: TT_CDN + 'alisg/webcast-sg/resource/2b36de0ed2fc89c41fcc2d48309b1808.png~tplv-obj.webp' },
    { n: 'Lion',           c: 29999, w: 1,  i: TT_CDN + 'maliva/webcast-va/resource/44818035acbbe673514caa600755268c.png~tplv-obj.webp' },
    { n: 'Universe',       c: 44999, w: 1,  i: TT_CDN + 'maliva/webcast-va/b13105782e8bf8fbefaa83b7af413cee~tplv-obj.webp' }
  ];
  var giftIndex = Object.create(null);
  (function () {
    for (var i = 0; i < DEMO_GIFTS.length; i++) {
      giftIndex[DEMO_GIFTS[i].n.toLowerCase().replace(/[^a-z0-9]+/g, '')] = DEMO_GIFTS[i];
    }
  })();
  function giftByName(name) {
    return giftIndex[String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '')] || null;
  }
  function pickDemoGift() {
    var sum = 0, i;
    for (i = 0; i < DEMO_GIFTS.length; i++) sum += DEMO_GIFTS[i].w;
    var roll = rand() * sum;
    for (i = 0; i < DEMO_GIFTS.length; i++) {
      roll -= DEMO_GIFTS[i].w;
      if (roll <= 0) return DEMO_GIFTS[i];
    }
    return DEMO_GIFTS[0];
  }

  // ────────────────────────────────────────────────────────────────────
  // JAR SHAPES. Five vessels, all drawn by the same vector glass
  // renderer. poly = RIGHT-side inner-cavity polyline, top to bottom,
  // [x in W units from center, y in H units from jar top]; arc shapes
  // (bowl) generate their polyline from an ellipse with a flat base.
  // One set of coordinates drives both the drawn glass and the physics
  // walls. cornerR controls how blown vs crisp the outline reads; lip
  // is 'band' (canning jar collar) or 'ring' (bare rolled rim).
  // ────────────────────────────────────────────────────────────────────
  var JARS = {
    classic: {
      aspect: 1.34, mouth: 0.295, inset: 0.026, fullY: 0.26,
      labelY: 0.56, chipY: 0.9725, cornerR: 0.055, lip: 'band',
      poly: [[0.295, 0.06], [0.315, 0.10], [0.45, 0.225], [0.46, 0.31], [0.46, 0.775],
             [0.432, 0.862], [0.368, 0.917], [0.295, 0.942]]
    },
    bowl: {
      aspect: 1.0, mouth: 0.23, inset: 0.022, fullY: 0.26,
      labelY: 0.52, chipY: 0.945, cornerR: 0.03, lip: 'ring',
      arc: { cy: 0.50, rx: 0.455, ry: 0.42, mouthY: 0.14, baseY: 0.87 }
    },
    hex: {
      aspect: 1.42, mouth: 0.27, inset: 0.026, fullY: 0.22,
      labelY: 0.55, chipY: 0.9725, cornerR: 0.015, lip: 'band', facets: true,
      poly: [[0.27, 0.05], [0.295, 0.09], [0.435, 0.185], [0.45, 0.34], [0.45, 0.70],
             [0.435, 0.82], [0.30, 0.92], [0.22, 0.935]]
    },
    potion: {
      aspect: 1.32, mouth: 0.18, inset: 0.022, fullY: 0.34,
      labelY: 0.62, chipY: 0.955, cornerR: 0.065, lip: 'ring',
      poly: [[0.18, 0.045], [0.185, 0.20], [0.30, 0.30], [0.41, 0.42], [0.455, 0.56],
             [0.44, 0.70], [0.37, 0.83], [0.27, 0.90], [0.16, 0.925]]
    },
    vase: {
      aspect: 1.52, mouth: 0.24, inset: 0.022, fullY: 0.24,
      labelY: 0.58, chipY: 0.94, cornerR: 0.07, lip: 'ring',
      poly: [[0.24, 0.04], [0.205, 0.12], [0.195, 0.21], [0.27, 0.33], [0.36, 0.45],
             [0.41, 0.56], [0.405, 0.66], [0.355, 0.78], [0.27, 0.86], [0.15, 0.895]]
    }
  };

  function styleDef() { return JARS[cfg.jarStyle] || JARS.classic; }

  function stylePoly(def, W, H) {
    if (def.poly) {
      return def.poly.map(function (p) { return [p[0] * W, p[1] * H]; });
    }
    // ellipse interior from the mouth edge down to a flat base chord
    var cy = def.arc.cy * H, rx = def.arc.rx * W, ry = def.arc.ry * H;
    var mouthY = def.arc.mouthY * H, baseY = def.arc.baseY * H;
    var t0 = Math.acos(clamp((cy - mouthY) / ry, -1, 1));
    var t1 = Math.acos(clamp((cy - baseY) / ry, -1, 1));
    var pts = [];
    var steps = 14;
    for (var i = 0; i <= steps; i++) {
      var t = t0 + (t1 - t0) * (i / steps);
      pts.push([rx * Math.sin(t), cy - ry * Math.cos(t)]);
    }
    pts.push([pts[pts.length - 1][0] * 0.45, baseY]);
    return pts;
  }

  // ────────────────────────────────────────────────────────────────────
  // GEOMETRY + PHYSICS WORLD
  // ────────────────────────────────────────────────────────────────────
  var M = window.Matter;
  var engine = M.Engine.create({ enableSleeping: true });
  engine.gravity.y = cfg.gravity;
  engine.positionIterations = 10;
  engine.velocityIterations = 6;

  var canvas = $('jarCanvas');
  var ctx2d = canvas.getContext('2d');
  var geo = null;
  var walls = [];
  var funnels = [];
  var items = [];
  var total = 0;
  var jarsFilled = 0;
  var jarFull = false;
  var popping = false;

  function computeGeo() {
    var def = styleDef();
    var vw = window.innerWidth, vh = window.innerHeight;
    // reserve headroom for the title pill + toast lane and footroom for
    // the goal bar so the chrome never collides with the glass
    var headroom = cfg.title ? 100 : 50;
    var footroom = cfg.goal > 0 ? 24 : 10;
    var budget = Math.max(120, vh - headroom - footroom - 12);
    var W = clamp(Math.min(vw * 0.94, budget / def.aspect), 200, 1100) * cfg.jarScale;
    var H = W * def.aspect;
    var cx = vw / 2;
    var bottom = vh - Math.max(8, vh * 0.015) - footroom;
    var top = bottom - H;
    var R = stylePoly(def, W, H).map(function (p) { return [p[0], top + p[1]]; });
    return {
      vw: vw, vh: vh, W: W, H: H, cx: cx, top: top, bottom: bottom,
      mw: def.mouth * W, bw: Math.max.apply(null, R.map(function (p) { return p[0]; })),
      glass: Math.max(5, def.inset * W), R: R,
      floorY: R[R.length - 1][1],
      fullYabs: top + def.fullY * H,
      s: W / 520
    };
  }

  function segBody(x1, y1, x2, y2, t, opts) {
    // Static rectangle whose INNER face sits on the segment inset by the
    // glass thickness, so tokens rest on the VISIBLE inner glass edge.
    // Funnels take the same inset so they land flush with the wall face:
    // any ledge at the mouth becomes a perch for small tokens.
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
    var nx = dy / len, ny = -dx / len;
    var refX = midX - geo.cx, refY = midY - (geo.top + 0.5 * geo.H);
    if (nx * refX + ny * refY < 0) { nx = -nx; ny = -ny; }
    var off = t / 2 - geo.glass;
    var body = M.Bodies.rectangle(
      midX + nx * off, midY + ny * off, len + t, t,
      {
        isStatic: true,
        angle: Math.atan2(dy, dx),
        friction: (opts && opts.friction != null) ? opts.friction : 0.35,
        restitution: 0.05,
        chamfer: (opts && opts.chamfer) ? { radius: Math.min(10, t * 0.22) } : null
      }
    );
    return body;
  }

  function buildWalls() {
    walls.concat(funnels).forEach(function (b) { M.Composite.remove(engine.world, b); });
    walls = []; funnels = [];
    var t = Math.max(18, 0.075 * geo.W);
    var cx = geo.cx, R = geo.R;
    function add(arr, b) { arr.push(b); M.Composite.add(engine.world, b); }
    for (var k = 0; k < R.length - 1; k++) {
      var ax = R[k][0], ay = R[k][1];
      if (k === 0) {
        // segBody overhangs both ends by t/2 to seal joints; above the
        // mouth there is no joint, only a shelf for tokens to perch on,
        // so pull the top of the first segment in by exactly that much
        var ddx = R[1][0] - R[0][0], ddy = R[1][1] - R[0][1];
        var dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        ax += ddx / dl * (t / 2);
        ay += ddy / dl * (t / 2);
      }
      add(walls, segBody(cx + ax, ay, cx + R[k + 1][0], R[k + 1][1], t));
      add(walls, segBody(cx - ax, ay, cx - R[k + 1][0], R[k + 1][1], t));
    }
    var last = R[R.length - 1];
    if (last[0] > 0.02 * geo.W) {
      add(walls, segBody(cx - last[0], last[1], cx + last[0], last[1], t * 1.4));
    }
    // invisible funnel above the mouth: guides every drop in (removed
    // in spill mode once the jar fills, and during a pop blast). The
    // lower end continues a short way ALONG the wall's first segment,
    // so funnel face and wall face form one continuous chute whatever
    // the jar shape (bowls widen right below the mouth), and the funnel
    // is near-frictionless so nothing can perch on it.
    var d0x = R[1][0] - R[0][0], d0y = R[1][1] - R[0][1];
    var d0l = Math.sqrt(d0x * d0x + d0y * d0y) || 1;
    var fTopX = R[0][0] + 0.45 * geo.W;
    var fEndX = R[0][0] + d0x / d0l * t * 0.6;
    var fEndY = R[0][1] + d0y / d0l * t * 0.6;
    add(funnels, segBody(cx + fTopX, -140, cx + fEndX, fEndY, t, { friction: 0.02, chamfer: true }));
    add(funnels, segBody(cx - fTopX, -140, cx - fEndX, fEndY, t, { friction: 0.02, chamfer: true }));
  }

  function funnelsOn(on) {
    funnels.forEach(function (b) { M.Composite.remove(engine.world, b); });
    if (on) funnels.forEach(function (b) { M.Composite.add(engine.world, b); });
  }

  // ────────────────────────────────────────────────────────────────────
  // JAR LAYERS. classic: fully procedural SVG glass. Art styles: a soft
  // interior tint behind the tokens + the photoreal PNG in front + the
  // etched label.
  // ────────────────────────────────────────────────────────────────────
  // Quadratic corner rounding over an arbitrary point chain. The drawn
  // outline uses it so the glass reads as blown, not welded; rounding
  // stays inside the glass stroke, so the physics polyline still
  // matches what you see.
  function roundPath(pts, rBase, close) {
    var d = 'M ' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (var k = 1; k < pts.length - 1; k++) {
      var P = pts[k], A = pts[k - 1], B = pts[k + 1];
      var d1x = P[0] - A[0], d1y = P[1] - A[1];
      var l1 = Math.sqrt(d1x * d1x + d1y * d1y) || 1;
      var d2x = B[0] - P[0], d2y = B[1] - P[1];
      var l2 = Math.sqrt(d2x * d2x + d2y * d2y) || 1;
      var r = Math.min(rBase, l1 * 0.42, l2 * 0.42);
      d += ' L ' + (P[0] - d1x / l1 * r).toFixed(1) + ' ' + (P[1] - d1y / l1 * r).toFixed(1) +
           ' Q ' + P[0].toFixed(1) + ' ' + P[1].toFixed(1) +
           ' '   + (P[0] + d2x / l2 * r).toFixed(1) + ' ' + (P[1] + d2y / l2 * r).toFixed(1);
    }
    d += ' L ' + pts[pts.length - 1][0].toFixed(1) + ' ' + pts[pts.length - 1][1].toFixed(1);
    if (close) d += ' Z';
    return d;
  }

  function roundedOutline(closeAcrossMouth) {
    var R = geo.R, cx = geo.cx;
    var pts = [];
    for (var i = 0; i < R.length; i++) pts.push([cx - R[i][0], R[i][1]]);
    for (var j = R.length - 1; j >= 0; j--) pts.push([cx + R[j][0], R[j][1]]);
    var cr = styleDef().cornerR || 0.055;
    if (cfg.wall === 'crystal') cr = Math.min(cr, 0.02);   // cut, not blown
    return roundPath(pts, cr * geo.W, closeAcrossMouth);
  }

  // A specular streak that FOLLOWS the wall instead of cutting straight
  // through it: wall polyline points inside [y0..y1], pulled inward.
  function wallStreak(side, y0, y1, inset) {
    var R = geo.R, cx = geo.cx, pts = [];
    var ya = geo.top + y0 * geo.H, yb = geo.top + y1 * geo.H;
    for (var i = 0; i < R.length; i++) {
      if (R[i][1] < ya || R[i][1] > yb) continue;
      pts.push([cx + side * (R[i][0] - inset * geo.W), R[i][1]]);
    }
    if (pts.length < 2) {
      var x = cx + side * (wallXAt((y0 + y1) / 2) - inset * geo.W);
      pts = [[x, ya], [x, yb]];
    }
    return roundPath(pts, 0.09 * geo.W, false);
  }

  // inner-wall x (in W units from center) at a given height fraction,
  // linearly interpolated along the polyline; keeps decorations ON the
  // glass instead of floating beside narrow necks
  function wallXAt(yFrac) {
    var R = geo.R;
    var y = geo.top + yFrac * geo.H;
    if (y <= R[0][1]) return R[0][0];
    for (var i = 0; i < R.length - 1; i++) {
      if (y >= R[i][1] && y <= R[i + 1][1]) {
        var t = (y - R[i][1]) / Math.max(1, R[i + 1][1] - R[i][1]);
        return R[i][0] + (R[i + 1][0] - R[i][0]) * t;
      }
    }
    return R[R.length - 1][0];
  }

  // a point sitting just inside the wall at height fraction yFrac, on
  // side -1 (left) / +1 (right), pulled in by insetFrac of W. Every
  // glint/seam rides this so nothing floats beside a narrow neck.
  function innerPt(yFrac, side, insetFrac) {
    return [
      geo.cx + side * Math.max(6, wallXAt(yFrac) - insetFrac * geo.W),
      geo.top + yFrac * geo.H
    ];
  }

  // a small four-point sparkle centered at x,y with radius s
  function fourStar(x, y, s, fill) {
    return '<path d="M ' + x + ' ' + (y - s) +
      ' Q ' + x + ' ' + y + ' ' + (x + s) + ' ' + y +
      ' Q ' + x + ' ' + y + ' ' + x + ' ' + (y + s) +
      ' Q ' + x + ' ' + y + ' ' + (x - s) + ' ' + y +
      ' Q ' + x + ' ' + y + ' ' + x + ' ' + (y - s) + ' Z" fill="' + fill + '"/>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildJarLayers() {
    var g = geo, cx = g.cx, def = styleDef();
    var vb = '0 0 ' + g.vw + ' ' + g.vh;
    var back = $('jarBack'), front = $('jarFront');
    back.setAttribute('viewBox', vb);
    front.setAttribute('viewBox', vb);
    var isGlow = cfg.wall === 'glow';
    var isCrystal = cfg.wall === 'crystal';
    var isFrosted = cfg.wall === 'frosted';
    var mouthAbsY = g.R[0][1];
    var mouthHW = g.R[0][0];
    var mouthRy = clamp(mouthHW * 0.17, 6, 0.026 * g.H);

    var glowDefs =
      '<radialGradient id="glowGrad" cx="0.5" cy="0.5" r="0.5">' +
        '<stop offset="0" style="stop-color:var(--accent)" stop-opacity="' + (isGlow ? '0.45' : '0.30') + '"/>' +
        '<stop offset="1" style="stop-color:var(--accent)" stop-opacity="0"/>' +
      '</radialGradient>';

    // ── BACK: interior tint, depth shading, caustic, far rim, motes ──
    var motes = '';
    var motePos = [[-0.22, 0.30, 2.0], [0.12, 0.44, 1.5], [-0.32, 0.56, 1.7], [0.30, 0.63, 1.4]];
    for (var mi = 0; mi < motePos.length; mi++) {
      motes +=
        '<circle class="gj-mote" style="animation-delay:' + (mi * 2.7) + 's" ' +
        'cx="' + (cx + motePos[mi][0] * g.bw) + '" cy="' + (g.top + motePos[mi][1] * g.H) + '" r="' + motePos[mi][2] + '" ' +
        'fill="' + (isGlow ? 'var(--accent)' : 'rgba(255,255,255,1)') + '" opacity="' + (isGlow ? '0.30' : '0.13') + '"/>';
    }

    back.innerHTML =
      '<defs>' +
        '<linearGradient id="cavGrad" x1="0" y1="0" x2="0" y2="1">' +
          (isGlow
            ? '<stop offset="0" stop-color="rgba(10,14,24,0.30)"/>' +
              '<stop offset="0.85" stop-color="rgba(8,12,22,0.46)"/>' +
              '<stop offset="1" stop-color="rgba(8,12,22,0.55)"/>'
            : '<stop offset="0" stop-color="rgba(190,224,255,0.045)"/>' +
              '<stop offset="0.55" stop-color="rgba(152,194,238,0.085)"/>' +
              '<stop offset="0.86" stop-color="rgba(128,170,222,0.15)"/>' +
              '<stop offset="1" stop-color="rgba(120,164,218,0.19)"/>') +
        '</linearGradient>' +
        '<linearGradient id="cavSide" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0" stop-color="rgba(8,12,22,0.10)"/>' +
          '<stop offset="0.18" stop-color="rgba(8,12,22,0)"/>' +
          '<stop offset="0.82" stop-color="rgba(8,12,22,0)"/>' +
          '<stop offset="1" stop-color="rgba(8,12,22,0.10)"/>' +
        '</linearGradient>' +
        '<radialGradient id="causticGrad" cx="0.5" cy="0.5" r="0.5">' +
          '<stop offset="0" style="stop-color:var(--accent)" stop-opacity="' + (isGlow ? '0.24' : '0.13') + '"/>' +
          '<stop offset="1" style="stop-color:var(--accent)" stop-opacity="0"/>' +
        '</radialGradient>' + glowDefs +
      '</defs>' +
      '<g id="gjGlowGrp" opacity="0.55">' +
        '<ellipse class="jar-breathe" cx="' + cx + '" cy="' + (g.bottom + 4) + '" rx="' + (0.62 * g.W) + '" ry="' + (0.05 * g.H) + '" fill="url(#glowGrad)"/>' +
      '</g>' +
      '<path d="' + roundedOutline(true) + '" fill="url(#cavGrad)"/>' +
      '<path d="' + roundedOutline(true) + '" fill="url(#cavSide)"/>' +
      // soft light falling in through the mouth
      (isGlow ? '' :
        '<defs><clipPath id="rayClip"><path d="' + roundedOutline(true) + '"/></clipPath>' +
        '<linearGradient id="rayGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="rgba(255,255,255,0.06)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0)"/>' +
        '</linearGradient></defs>' +
        '<g clip-path="url(#rayClip)">' +
          '<path d="M ' + (cx - mouthHW) + ' ' + mouthAbsY + ' L ' + (cx + mouthHW) + ' ' + mouthAbsY +
          ' L ' + (cx + mouthHW * 1.55) + ' ' + (mouthAbsY + 0.42 * g.H) +
          ' L ' + (cx - mouthHW * 1.55) + ' ' + (mouthAbsY + 0.42 * g.H) + ' Z" fill="url(#rayGrad)"/>' +
        '</g>') +
      '<ellipse id="gjCaustic" opacity="0.55" cx="' + cx + '" cy="' + (g.floorY - 0.05 * g.H) + '" rx="' + (g.bw * 0.74) + '" ry="' + (0.085 * g.H) + '" fill="url(#causticGrad)"/>' +
      // the far rim of the opening, seen through the mouth: instant depth
      '<ellipse cx="' + cx + '" cy="' + (mouthAbsY + mouthRy * 0.55) + '" rx="' + (mouthHW * 0.96) + '" ry="' + mouthRy + '" ' +
        'fill="rgba(140,180,230,0.05)" stroke="' + (isGlow ? 'var(--accent)' : 'rgba(255,255,255,1)') + '" ' +
        'stroke-opacity="' + (isGlow ? '0.30' : '0.11') + '" stroke-width="1.4"/>' +
      motes +
      '<ellipse cx="' + cx + '" cy="' + (g.floorY - 0.012 * g.H) + '" rx="' + (g.bw * 0.82) + '" ry="' + (0.030 * g.H) + '" fill="rgba(0,0,0,0.22)"/>';

    // ── FRONT ────────────────────────────────────────────────────────
    var lipW = g.mw + 0.055 * g.W;
    var labelSvg = '';
    if (cfg.label) {
      var ly = g.top + def.labelY * g.H;
      var lcommon = 'x="' + cx + '" text-anchor="middle" font-family="var(--font)" font-weight="800" ' +
        'font-size="' + (0.075 * g.W) + '" letter-spacing="' + (0.022 * g.W) + '"';
      if (isGlow) {
        labelSvg = '<text ' + lcommon + ' y="' + ly + '" style="fill:var(--accent)" fill-opacity="0.26">' +
          esc(String(cfg.label).toUpperCase()) + '</text>';
      } else {
        // engraved: a dark pass a hair low, a light pass on top
        labelSvg =
          '<text ' + lcommon + ' y="' + (ly + 1.4) + '" fill="rgba(6,9,16,0.38)">' + esc(String(cfg.label).toUpperCase()) + '</text>' +
          '<text ' + lcommon + ' y="' + ly + '" fill="rgba(255,255,255,0.14)">' + esc(String(cfg.label).toUpperCase()) + '</text>';
      }
    }

    var frontDefs =
      '<defs>' +
        '<linearGradient id="glassGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="rgba(255,255,255,0.40)"/>' +
          '<stop offset="0.45" stop-color="rgba(228,240,255,0.13)"/>' +
          '<stop offset="0.8" stop-color="rgba(244,250,255,0.21)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0.35)"/>' +
        '</linearGradient>' +
        '<linearGradient id="lipGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="rgba(255,255,255,0.20)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0.05)"/>' +
        '</linearGradient>' +
        '<linearGradient id="sheenGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="rgba(255,255,255,0.065)"/>' +
          '<stop offset="0.5" stop-color="rgba(255,255,255,0.02)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0.04)"/>' +
        '</linearGradient>' +
        '<linearGradient id="shimmerGrad" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0" stop-color="rgba(255,255,255,0)"/>' +
          '<stop offset="0.5" stop-color="rgba(255,255,255,0.055)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0)"/>' +
        '</linearGradient>' +
        '<clipPath id="cavClip"><path d="' + roundedOutline(true) + '"/></clipPath>' +
        (isGlow ? '<filter id="gjBlur" x="-40%" y="-40%" width="180%" height="180%">' +
          '<feGaussianBlur stdDeviation="' + Math.max(4, g.glass * 0.9) + '"/></filter>' : '') +
        (isCrystal ?
          '<linearGradient id="irisGrad" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="rgba(124,232,255,0.85)"/>' +
            '<stop offset="0.35" stop-color="rgba(184,156,255,0.85)"/>' +
            '<stop offset="0.7" stop-color="rgba(255,154,213,0.85)"/>' +
            '<stop offset="1" stop-color="rgba(124,232,255,0.85)"/>' +
          '</linearGradient>' : '') +
        (isFrosted ?
          '<filter id="gjFrostN"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch"/>' +
          '<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.22 0.22 0.22 0 0"/></filter>' : '') +
      '</defs>';

    var html = frontDefs;

    if (isGlow) {
      // ── neon energy walls: layered accent strokes, pulsing halo ───
      var oPath = roundedOutline(false);
      html +=
        '<g class="gj-pulse" filter="url(#gjBlur)">' +
          '<path d="' + oPath + '" fill="none" style="stroke:var(--accent)" stroke-opacity="0.55" ' +
            'stroke-width="' + (2.6 * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</g>' +
        '<path d="' + oPath + '" fill="none" style="stroke:var(--accent)" stroke-opacity="0.95" ' +
          'stroke-width="' + Math.max(3, 0.9 * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="' + oPath + '" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="1.6" stroke-linejoin="round"/>' +
        // mouth ring in the same energy treatment
        '<g class="gj-pulse" filter="url(#gjBlur)">' +
          '<ellipse cx="' + cx + '" cy="' + mouthAbsY + '" rx="' + (mouthHW * 1.08) + '" ry="' + mouthRy + '" ' +
            'fill="none" style="stroke:var(--accent)" stroke-opacity="0.5" stroke-width="' + (2.0 * g.glass) + '"/>' +
        '</g>' +
        '<ellipse cx="' + cx + '" cy="' + mouthAbsY + '" rx="' + (mouthHW * 1.08) + '" ry="' + mouthRy + '" ' +
          'fill="none" style="stroke:var(--accent)" stroke-opacity="0.9" stroke-width="' + Math.max(2.5, 0.7 * g.glass) + '"/>' +
        '<ellipse cx="' + cx + '" cy="' + mouthAbsY + '" rx="' + (mouthHW * 1.08) + '" ry="' + mouthRy + '" ' +
          'fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="1.2"/>';
      if (def.facets) {
        html +=
          '<line class="gj-pulse2" x1="' + (cx - g.bw * 0.5) + '" y1="' + (g.top + 0.20 * g.H) + '" x2="' + (cx - g.bw * 0.5) + '" y2="' + (g.top + 0.80 * g.H) + '" ' +
            'style="stroke:var(--accent)" stroke-opacity="0.16" stroke-width="1.5"/>' +
          '<line class="gj-pulse2" x1="' + (cx + g.bw * 0.5) + '" y1="' + (g.top + 0.20 * g.H) + '" x2="' + (cx + g.bw * 0.5) + '" y2="' + (g.top + 0.80 * g.H) + '" ' +
            'style="stroke:var(--accent)" stroke-opacity="0.16" stroke-width="1.5"/>';
      }
      var glowDotA = innerPt(0.185, -1, 0.05);
      var glowDotB = innerPt(0.245, 1, 0.05);
      html +=
        // a spark circulating the outline
        '<path class="gj-dash" d="' + oPath + '" pathLength="100" fill="none" stroke="rgba(255,255,255,0.9)" ' +
          'stroke-width="2.4" stroke-linecap="round" stroke-dasharray="9 91"/>' +
        '<circle class="gj-pulse2" cx="' + glowDotA[0] + '" cy="' + glowDotA[1] + '" r="2.4" style="fill:var(--accent)" fill-opacity="0.8"/>' +
        '<circle class="gj-pulse2" cx="' + glowDotB[0] + '" cy="' + glowDotB[1] + '" r="1.8" style="fill:var(--accent);animation-delay:1.1s" fill-opacity="0.6"/>' +
        labelSvg;
    } else if (isCrystal) {
      // ── cut crystal: iridescent edges, facet shards, prism glints ──
      var oP3 = roundedOutline(false);
      // facet seams that run WITH the wall contour at fixed insets, a
      // clean cut-glass read, never random diagonals
      var shards =
        '<path d="' + wallStreak(-1, 0.30, 0.80, 0.13) + '" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="' + wallStreak( 1, 0.30, 0.80, 0.13) + '" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="' + wallStreak(-1, 0.36, 0.72, 0.26) + '" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="' + wallStreak( 1, 0.36, 0.72, 0.26) + '" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
      var pa = innerPt(0.205, 1, 0.055), pb = innerPt(0.50, -1, 0.06), pStar = innerPt(0.31, -1, 0.05);
      html +=
        '<path d="' + roundedOutline(true) + '" fill="url(#sheenGrad)"/>' +
        shards +
        '<path d="' + oP3 + '" fill="none" stroke="rgba(184,156,255,0.10)" ' +
          'stroke-width="' + (3.6 * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="' + oP3 + '" fill="none" stroke="url(#irisGrad)" ' +
          'stroke-width="' + (1.7 * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="' + oP3 + '" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="1.4" stroke-linejoin="round"/>' +
        '<ellipse cx="' + cx + '" cy="' + mouthAbsY + '" rx="' + (mouthHW * 1.1) + '" ry="' + mouthRy + '" ' +
          'fill="none" stroke="url(#irisGrad)" stroke-width="' + Math.max(3, 0.8 * g.glass) + '"/>' +
        '<ellipse cx="' + cx + '" cy="' + mouthAbsY + '" rx="' + (mouthHW * 1.1) + '" ry="' + mouthRy + '" ' +
          'fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.2"/>' +
        // prism glints, anchored on the wall
        '<path d="M ' + pa[0] + ' ' + pa[1] + ' l 9 4 l -7 7 Z" fill="rgba(124,232,255,0.5)"/>' +
        '<path d="M ' + pb[0] + ' ' + pb[1] + ' l -8 3 l 6 6 Z" fill="rgba(255,154,213,0.45)"/>' +
        fourStar(pStar[0], pStar[1], 0.018 * g.W, 'rgba(255,255,255,0.55)') +
        labelSvg;
    } else {
      // ── pushed glass: halo, body, inner thickness, crisp edge, wall-
      // following streaks, drifting shimmer, per-shape jewelry ────────
      var oPath2 = roundedOutline(false);
      html +=
        '<path d="' + roundedOutline(true) + '" fill="url(#sheenGrad)"/>' +
        (isFrosted ?
          // grain etched into the frost
          '<g clip-path="url(#cavClip)" opacity="0.5">' +
            '<rect x="' + (cx - g.bw) + '" y="' + g.top + '" width="' + (2 * g.bw) + '" height="' + g.H + '" filter="url(#gjFrostN)"/>' +
          '</g>' : '') +
        '<g clip-path="url(#cavClip)">' +
          '<rect class="gj-shimmer" x="' + (-0.6 * g.W) + '" y="' + (g.top - 0.05 * g.H) + '" width="' + (0.55 * g.W) + '" height="' + (1.1 * g.H) + '" ' +
            'fill="url(#shimmerGrad)" transform="skewX(-14)"/>' +
        '</g>' +
        '<path d="' + oPath2 + '" fill="none" stroke="rgba(255,255,255,' + (isFrosted ? '0.09' : '0.05') + ')" ' +
          'stroke-width="' + (4.2 * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="' + oPath2 + '" fill="none" stroke="url(#glassGrad)" ' +
          'stroke-width="' + ((isFrosted ? 2.4 : 2) * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="' + oPath2 + '" fill="none" stroke="rgba(235,245,255,' + (isFrosted ? '0.12' : '0.07') + ')" ' +
          'stroke-width="' + (0.9 * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="' + oPath2 + '" fill="none" stroke="rgba(255,255,255,' + (isFrosted ? '0.36' : '0.28') + ')" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<path d="' + wallStreak(-1, 0.26, 0.72, 0.075) + '" fill="none" stroke="rgba(255,255,255,0.10)" ' +
          'stroke-width="' + (0.046 * g.W) + '" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="' + wallStreak(-1, 0.76, 0.85, 0.075) + '" fill="none" stroke="rgba(255,255,255,0.08)" ' +
          'stroke-width="' + (0.032 * g.W) + '" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="' + wallStreak(1, 0.30, 0.52, 0.075) + '" fill="none" stroke="rgba(255,255,255,0.07)" ' +
          'stroke-width="' + (0.034 * g.W) + '" stroke-linecap="round" stroke-linejoin="round"/>';

      if (def.lip === 'ring') {
        var rrx = mouthHW * 1.14 + g.glass;
        var rry = Math.max(7, 0.020 * g.H);
        html +=
          '<ellipse cx="' + cx + '" cy="' + mouthAbsY + '" rx="' + rrx + '" ry="' + rry + '" ' +
            'fill="none" stroke="url(#glassGrad)" stroke-width="' + (1.5 * g.glass) + '"/>' +
          '<ellipse cx="' + cx + '" cy="' + mouthAbsY + '" rx="' + rrx + '" ry="' + rry + '" ' +
            'fill="none" stroke="rgba(255,255,255,0.30)" stroke-width="1.4"/>' +
          '<path d="M ' + (cx - rrx) + ' ' + mouthAbsY + ' A ' + rrx + ' ' + rry + ' 0 0 0 ' + (cx + rrx) + ' ' + mouthAbsY + '" ' +
            'fill="none" style="stroke:var(--accent)" stroke-opacity="0.45" stroke-width="2"/>';
      } else {
        html +=
          '<rect x="' + (cx - lipW * 0.94) + '" y="' + (g.top - 0.006 * g.H) + '" width="' + (2 * lipW * 0.94) + '" height="' + (0.022 * g.H) + '" rx="' + (0.011 * g.H) + '" ' +
            'fill="rgba(255,255,255,0.13)" stroke="rgba(255,255,255,0.30)" stroke-width="1.4"/>' +
          '<rect x="' + (cx - lipW) + '" y="' + (g.top + 0.018 * g.H) + '" width="' + (2 * lipW) + '" height="' + (0.054 * g.H) + '" rx="' + (0.022 * g.W) + '" ' +
            'fill="url(#lipGrad)" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>' +
          '<line x1="' + (cx - lipW) + '" y1="' + (g.top + 0.074 * g.H) + '" x2="' + (cx + lipW) + '" y2="' + (g.top + 0.074 * g.H) + '" ' +
            'style="stroke:var(--accent)" stroke-opacity="0.45" stroke-width="2"/>';
      }

      // per-shape jewelry
      if (def.facets) {
        html +=
          '<line x1="' + (cx - g.bw * 0.5) + '" y1="' + (g.top + 0.20 * g.H) + '" x2="' + (cx - g.bw * 0.5) + '" y2="' + (g.top + 0.80 * g.H) + '" ' +
            'stroke="rgba(255,255,255,0.05)" stroke-width="1.5"/>' +
          '<line x1="' + (cx + g.bw * 0.5) + '" y1="' + (g.top + 0.20 * g.H) + '" x2="' + (cx + g.bw * 0.5) + '" y2="' + (g.top + 0.80 * g.H) + '" ' +
            'stroke="rgba(255,255,255,0.05)" stroke-width="1.5"/>';
      }
      if (cfg.jarStyle === 'bowl') {
        // equator reflection arc at the widest point
        html += '<path d="M ' + (cx - g.bw * 0.92) + ' ' + (g.top + 0.50 * g.H) + ' A ' + (g.bw * 0.92) + ' ' + (0.07 * g.H) + ' 0 0 0 ' + (cx + g.bw * 0.92) + ' ' + (g.top + 0.50 * g.H) + '" ' +
          'fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="2"/>';
      }
      if (cfg.jarStyle === 'potion') {
        // collar ring where the neck meets the bulb
        html += '<ellipse cx="' + cx + '" cy="' + (g.top + 0.215 * g.H) + '" rx="' + (0.20 * g.W) + '" ry="' + (0.012 * g.H) + '" ' +
          'fill="none" stroke="rgba(255,255,255,0.13)" stroke-width="1.6"/>';
      }
      if (cfg.jarStyle === 'vase') {
        // foot ring
        html += '<ellipse cx="' + cx + '" cy="' + (g.floorY + 0.012 * g.H) + '" rx="' + (0.17 * g.W) + '" ry="' + (0.011 * g.H) + '" ' +
          'fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.6"/>';
      }

      // glints riding the actual wall, never floating beside a neck
      var gStar = innerPt(0.185, -1, 0.05);
      var gDotA = innerPt(0.245, 1, 0.05);
      var gDotB = innerPt(0.66, -1, 0.05);
      html +=
        '<circle cx="' + gDotA[0] + '" cy="' + gDotA[1] + '" r="1.8" fill="rgba(255,255,255,0.38)"/>' +
        '<circle cx="' + gDotB[0] + '" cy="' + gDotB[1] + '" r="1.5" fill="rgba(255,255,255,0.30)"/>' +
        fourStar(gStar[0], gStar[1], 0.018 * g.W, 'rgba(255,255,255,0.5)') +
        labelSvg;
    }

    // rim flash overlay: invisible until a drop lands
    html += '<path id="gjFlash" d="' + roundedOutline(false) + '" fill="none" style="stroke:var(--accent)" ' +
      'stroke-width="' + (1.7 * g.glass) + '" stroke-linejoin="round" stroke-linecap="round"/>';

    front.innerHTML = html;

    // frosted mode diffuses everything behind the wall with a real
    // backdrop blur, clipped to the vessel silhouette
    var fd = $('frostGlass');
    if (isFrosted) {
      fd.hidden = false;
      fd.style.clipPath = 'path("' + roundedOutline(true) + '")';
    } else {
      fd.hidden = true;
    }

    buildLayerCache();
  }

  function placeChrome() {
    var def = styleDef();
    var chip = $('counterChip');
    chip.style.left = geo.cx + 'px';
    chip.style.top = (geo.top + def.chipY * geo.H) + 'px';
    // chrome lives in reserved lanes (see computeGeo headroom/footroom):
    // toast on top, then the title pill, then the jar; goal bar below.
    var title = $('jarTitle');
    if (cfg.title) {
      title.hidden = false;
      title.textContent = cfg.title;
      title.style.left = geo.cx + 'px';
      title.style.top = Math.max(22, geo.top - 32) + 'px';
    } else {
      title.hidden = true;
    }
    var bar = $('goalBar');
    if (cfg.goal > 0) {
      bar.hidden = false;
      bar.style.left = geo.cx + 'px';
      bar.style.width = (0.56 * geo.W) + 'px';
      bar.style.top = Math.min(geo.vh - 13, geo.bottom + 9) + 'px';
    } else {
      bar.hidden = true;
    }
    var toast = $('bigToast');
    toast.style.left = geo.cx + 'px';
    toast.style.top = Math.max(20, geo.top - (cfg.title ? 76 : 40)) + 'px';
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
    coin:  { restitution: 0.24, shape: 'circle' },
    box:   { restitution: 0.14, shape: 'rect' },
    gem:   { restitution: 0.34, shape: 'gem' },
    cheer: { restitution: 0.34, shape: 'gem' },
    img:   { restitution: 0.22, shape: 'circle' }
  };

  function shapeFor(key) {
    return BODY_OPTS[key.split(':')[0]] || BODY_OPTS.coin;
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
    lastActivity = performance.now();
    var live = 0;
    for (var i = 0; i < items.length; i++) if (!items[i].dying) live++;
    for (var j = 0; live > cfg.maxItems && j < items.length; j++) {
      if (!items[j].dying) { items[j].dying = performance.now(); live--; }
    }
    schedulePersist();
  }

  var queue = [];
  var drainAcc = 0;
  function drainMs() { return queue.length > 60 ? 26 : queue.length > 20 ? 48 : 88; }

  function enqueue(key, r, imgUrl, n) {
    n = n || 1;
    for (var i = 0; i < n; i++) queue.push({ k: key, r: r, i: imgUrl || null });
    if (queue.length > 600) queue.length = 600;
  }

  // ────────────────────────────────────────────────────────────────────
  // COUNTER, TOAST, STATUS
  // ────────────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────
  // SLIDE-AWAY. With ?slide=down|left|right the whole jar glides off
  // screen after idleSecs without a drop and glides back the moment
  // something lands. The physics never moves, only the painted stage,
  // so a gift arriving mid-slide still falls exactly into the jar.
  // ────────────────────────────────────────────────────────────────────
  var stageEl = $('stage');
  var jarHidden = false;
  var lastActivity = performance.now();
  var wakeHoldUntil = 0;

  function slideVector() {
    if (cfg.slide === 'left')  return 'translateX(' + (-(geo.cx + geo.W / 2 + 90)) + 'px)';
    if (cfg.slide === 'right') return 'translateX(' + (geo.vw - geo.cx + geo.W / 2 + 90) + 'px)';
    return 'translateY(' + (geo.vh - geo.top + 70) + 'px)';
  }

  function jarWake() {
    lastActivity = performance.now();
    if (cfg.slide === 'off' || !jarHidden) return;
    jarHidden = false;
    stageEl.style.transform = '';
    // hold the pour until the jar is back on screen
    wakeHoldUntil = performance.now() + 500;
  }

  function jarSleep() {
    if (cfg.slide === 'off' || jarHidden) return;
    jarHidden = true;
    stageEl.style.transform = slideVector();
  }

  var chipEl = $('counterChip'), chipNum = $('counterNum');

  function updateChip() {
    chipNum.textContent = total.toLocaleString();
    var old = chipEl.querySelectorAll('.jars-badge, .full-tag, .goal-part');
    for (var i = 0; i < old.length; i++) old[i].remove();
    if (cfg.goal > 0) {
      var gp = document.createElement('span');
      gp.className = 'goal-part';
      gp.textContent = '/ ' + cfg.goal.toLocaleString();
      chipEl.appendChild(gp);
      var fill = $('goalFill');
      var pct = clamp((total / cfg.goal) * 100, 0, 100);
      fill.style.width = pct + '%';
      fill.classList.toggle('done', total >= cfg.goal);
    }
    if (jarsFilled > 0) {
      var b = document.createElement('span');
      b.className = 'jars-badge';
      b.textContent = 'x' + (jarsFilled + 1);
      b.title = 'jar number ' + (jarsFilled + 1);
      chipEl.appendChild(b);
    }
    if (jarFull && cfg.full === 'stop') {
      var f = document.createElement('span');
      f.className = 'full-tag';
      f.textContent = 'FULL';
      chipEl.appendChild(f);
    }
  }

  var lastFlash = 0;
  function rimFlash() {
    var f = document.getElementById('gjFlash');
    if (!f) return;
    var now = performance.now();
    if (now - lastFlash < 260) return;
    lastFlash = now;
    f.classList.remove('hit');
    void f.getBoundingClientRect();
    f.classList.add('hit');
  }

  function bumpCounter(n) {
    var before = total;
    total += n;
    updateChip();
    jarWake();
    rimFlash();
    burst(5);
    if (cfg.goal > 0 && before < cfg.goal && total >= cfg.goal) {
      showToast('<b>GOAL REACHED!</b>');
      burst(44);
    }
    if (cfg.counter) {
      chipEl.classList.remove('bump');
      void chipEl.offsetWidth;
      chipEl.classList.add('bump');
    }
    schedulePersist();
    scheduleCapture();
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
    burst(16);
  }

  // celebration sparks rising out of the mouth, drawn over the tokens
  var sparks = [];
  function burst(n) {
    var my = geo.R[0][1];
    for (var i = 0; i < n; i++) {
      sparks.push({
        x: geo.cx + (rand() * 2 - 1) * geo.mw * 0.9,
        y: my - 4 - rand() * 12,
        vx: (rand() * 2 - 1) * 6.5,
        vy: -(2.5 + rand() * 6.5),
        r: 1.4 + rand() * 2.2,
        life: 1,
        white: rand() < 0.45
      });
    }
    if (sparks.length > 220) sparks.splice(0, sparks.length - 220);
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
  // FULL-JAR BEHAVIOR. A sensor watches the settled pile height; when
  // it crosses the style's fill line the chosen mode kicks in:
  //   recycle  oldest tokens fade out as new ones land (the maxItems
  //            cap, always active anyway)
  //   stop     the jar keeps its pile; new events count but no longer
  //            spawn tokens until the jar is reset
  //   spill    the funnel disappears; new tokens bounce off the pile
  //            and tumble out over the rim, despawning off-screen
  //   pop      the jar erupts, tokens blast out of the mouth, the jar
  //            count ticks up and a fresh jar starts filling
  // ────────────────────────────────────────────────────────────────────
  var fullStreak = 0;

  function pileTopY() {
    // 4th-highest settled token, not the single highest: one or two
    // strays perched on a rim must never read as a full jar
    var tops = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.dying) continue;
      var b = it.body;
      if (b.speed > 1.2) continue;
      var p = b.position;
      if (p.y < geo.top - 20 || Math.abs(p.x - geo.cx) > geo.bw) continue;
      tops.push(p.y - it.r);
    }
    if (tops.length < 12) return Infinity;
    tops.sort(function (a, b2) { return a - b2; });
    return tops[3];
  }

  function fillCheck() {
    if (popping) return;
    var top = pileTopY();

    // the under-glow and floor caustic breathe brighter as the jar
    // fills, so a busy night visibly charges the vessel up
    var frac = 0;
    if (top !== Infinity) {
      frac = clamp((geo.floorY - top) / Math.max(1, geo.floorY - geo.fullYabs), 0, 1);
    }
    var gg = $('gjGlowGrp');
    if (gg) gg.setAttribute('opacity', (0.55 + 0.45 * frac).toFixed(2));
    var gc = $('gjCaustic');
    if (gc) gc.setAttribute('opacity', (0.55 + 0.45 * frac).toFixed(2));

    var isFull = top <= geo.fullYabs;
    if (isFull) {
      fullStreak++;
      if (fullStreak >= 2 && !jarFull) {
        jarFull = true;
        updateChip();
        onJarFull();
      }
    } else {
      fullStreak = 0;
      if (jarFull && top > geo.fullYabs + 0.08 * geo.H) {
        jarFull = false;
        if (cfg.full === 'spill') funnelsOn(true);
        updateChip();
      }
    }
  }

  function onJarFull() {
    if (cfg.full === 'stop') {
      showToast('<b>JAR FULL</b>');
    } else if (cfg.full === 'spill') {
      funnelsOn(false);
      showToast('<b>JAR FULL</b>, overflowing');
    } else if (cfg.full === 'pop') {
      popJar();
    }
  }

  function popJar() {
    if (popping) return;
    popping = true;
    jarWake();
    funnelsOn(false);
    for (var i = 0; i < items.length; i++) {
      var b = items[i].body;
      M.Sleeping.set(b, false);
      M.Body.setVelocity(b, {
        x: (b.position.x - geo.cx) * 0.06 + (rand() * 2 - 1) * 6,
        y: -(15 + rand() * 14)
      });
      M.Body.setAngularVelocity(b, (rand() * 2 - 1) * 0.6);
    }
    jarsFilled++;
    showToast('<b>JAR FILLED!</b> starting jar ' + (jarsFilled + 1));
    setTimeout(function () {
      var now = performance.now();
      for (var i = 0; i < items.length; i++) {
        if (!items[i].dying) items[i].dying = now;
      }
    }, 1700);
    setTimeout(function () {
      funnelsOn(true);
      popping = false;
      jarFull = false;
      fullStreak = 0;
      updateChip();
      schedulePersist();
    }, 2300);
  }

  // ────────────────────────────────────────────────────────────────────
  // EVENT ROUTING
  // ────────────────────────────────────────────────────────────────────
  function S(px) { return px * geo.s * cfg.iconScale; }

  function gemTier(bits) {
    return bits < 100 ? 0 : bits < 1000 ? 1 : bits < 5000 ? 2 : bits < 10000 ? 3 : 4;
  }
  function gemSize(bits) {
    return S(bits < 100 ? 14 : bits < 1000 ? 18 : bits < 5000 ? 24 : bits < 10000 ? 30 : 37);
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

  var recentBombs = Object.create(null);
  function bombGuard(gifter) {
    recentBombs[String(gifter || 'anon').toLowerCase()] = Date.now() + 20000;
  }
  function bombSuppressed(gifter) {
    return (recentBombs[String(gifter || 'anon').toLowerCase()] || 0) > Date.now();
  }

  function drop(cat, key, r, opts) {
    if (!catEnabled(cat)) return;
    opts = opts || {};
    var n = Math.max(1, Math.round(opts.count || 1));
    bumpCounter(n);
    if (opts.toast) showToast(opts.toast);
    // stop mode: a full jar stays exactly as it is, but keeps counting
    if (jarFull && cfg.full === 'stop') return;
    enqueue(key, r, opts.img, Math.min(n, cfg.burst));
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
        var tier = cheerTierFor(bits);
        loadCheer(tier);
        drop('bits', 'cheer:' + tier, gemSize(bits), {
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
        drop('tiktok', 'img', ttGiftSize(per), {
          count: cnt,
          img: a.giftImage || null,
          toast: per * cnt >= 1000 ? who + ' sent ' + esc(a.giftName || 'a gift') + (cnt > 1 ? ' x' + cnt : '') : null
        });
        break;
      }
      case 'follow':
        drop('follows', 'heart:' + p, S(11));
        break;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // STREAMER.BOT FEED (Twitch / YouTube / Kick)
  // ────────────────────────────────────────────────────────────────────
  function sbRoute(d) {
    if (!d || !d.event) return;
    var src = String(d.event.source || '').toLowerCase();
    var type = String(d.event.type || '').toLowerCase();
    var data = d.data || {};
    var plat = src === 'twitch' ? 'tw' : src === 'youtube' ? 'yt' : src === 'kick' ? 'kk' : null;

    if (!plat) {
      if (type === 'tip' || type === 'donation') {
        var ud = data.user || data.donor || {};
        onAlert({ platform: 'tw', eventType: 'tip', user: ud.displayName || ud.name || data.name || 'someone', amount: Number(data.amount || 0) });
      }
      return;
    }

    if (type === 'streamoffline') { finishRecap('offline'); return; }
    if (type === 'streamonline') { recapReset(); return; }
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
  // TIKFINITY FEED (TikTok)
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

      // Noisy TikFinity events that must NEVER drop a token. 'member' in
      // TikFinity-speak is the viewer JOIN event (someone entered the
      // stream), not a TikTok subscription, the v2 routing folded it in
      // with 'subscribe' and any busy live stream overflowed the jar from
      // joins alone. Likes, chat, shares and social pings get the same
      // explicit early-return so future TikFinity event renames cannot
      // creep back in through the catch-all paths.
      if (ev === 'member' || ev === 'join' || ev === 'roomuser' ||
          ev === 'viewerjoin' || ev === 'roomenter' || ev === 'enter' ||
          ev === 'like' || ev === 'likes' ||
          ev === 'chat' || ev === 'comment' || ev === 'message' ||
          ev === 'share' || ev === 'social' || ev === 'streamend' ||
          ev === 'connect' || ev === 'disconnect') {
        return;
      }

      if (ev === 'gift') {
        var midStreak = Number(data.giftType) === 1 &&
          (data.repeatEnd === false || data.repeatEnd === 0 || data.repeatEnd === 'false');
        if (midStreak) return;
        var liveArt = data.giftPictureUrl || data.giftImage || data.pictureUrl || data.imageUrl || '';
        if (!liveArt) {
          var known = giftByName(data.giftName);
          if (known) liveArt = known.i;
        }
        onAlert({
          platform: 'tt', eventType: 'ttgift', user: user,
          amount: Number(data.repeatCount || data.giftCount || 1),
          perCoin: Number(data.diamondCount || data.giftCost || 1),
          giftName: data.giftName || 'Gift',
          giftImage: liveArt
        });
        return;
      }
      if (ev === 'subscribe' || ev === 'subscription') {
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
  // PERSISTENCE
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
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ at: Date.now(), total: total, jf: jarsFilled, items: recs }));
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
    jarsFilled = saved.jf || 0;
    updateChip();
    for (var i = 0; i < saved.items.length && i < cfg.maxItems; i++) {
      var r = saved.items[i];
      queue.push({ k: r.k, r: Math.max(9, (r.r || 0.05) * geo.W), i: r.i || null });
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // STREAM RECAP. With a Discord webhook configured (?discord=, URL
  // encoded) the overlay snapshots the jar as it fills (settled, at
  // most one frame per 30s, only when the total changed). On stream
  // end (Streamer.bot StreamOffline, the customizer test button, or G
  // in OBS Interact) the session renders into a looping timelapse GIF
  // and posts to the webhook; with ?recap=1 and no webhook it downloads
  // instead.
  // ────────────────────────────────────────────────────────────────────
  var rec = {
    frames: [], w: 0, h: 0, lastCap: 0, lastTotal: -1, start: 0,
    minGap: cfg.demo ? 9000 : 30000, busy: false, posting: false, tainted: false
  };
  var layerCache = { back: null, front: null, stamp: 0 };
  var recCanvas = document.createElement('canvas');

  function accentVal() {
    return (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#35e0c2').trim();
  }

  function svgLayerImg(el, cb) {
    var s = new XMLSerializer().serializeToString(el);
    s = s.replace(/var\(--accent\)/g, accentVal()).replace(/var\(--font\)/g, 'Inter, sans-serif');
    s = s.replace('<svg', '<svg width="' + geo.vw + '" height="' + geo.vh + '"');
    var url = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
    var im = new Image();
    im.onload = function () { URL.revokeObjectURL(url); cb(im); };
    im.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    im.src = url;
  }

  function buildLayerCache() {
    if (!cfg.recap) return;
    var stamp = ++layerCache.stamp;
    svgLayerImg($('jarBack'), function (im) { if (stamp === layerCache.stamp) layerCache.back = im; });
    svgLayerImg($('jarFront'), function (im) { if (stamp === layerCache.stamp) layerCache.front = im; });
  }

  function captureFrame(delay) {
    if (!cfg.recap || rec.tainted || !window.__gifenc) return;
    if (!layerCache.back || !layerCache.front) return;
    if (!rec.w) {
      rec.w = 240;
      rec.h = Math.min(420, Math.round(240 * geo.vh / geo.vw));
    }
    recCanvas.width = rec.w; recCanvas.height = rec.h;
    var c = recCanvas.getContext('2d');
    var grd = c.createLinearGradient(0, 0, 0, rec.h);
    grd.addColorStop(0, '#131826');
    grd.addColorStop(1, '#070a12');
    c.fillStyle = grd;
    c.fillRect(0, 0, rec.w, rec.h);
    var sc = rec.w / geo.vw;
    var dh = geo.vh * sc;
    var dy = rec.h - dh;
    c.drawImage(layerCache.back, 0, dy, rec.w, dh);
    c.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, dy, rec.w, dh);
    c.drawImage(layerCache.front, 0, dy, rec.w, dh);
    c.font = '800 13px Inter, sans-serif';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(244,247,250,0.92)';
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 4;
    c.fillText(total.toLocaleString(), rec.w / 2, rec.h - 8);
    c.shadowBlur = 0;
    var px;
    try { px = c.getImageData(0, 0, rec.w, rec.h); }
    catch (e) { rec.tainted = true; return; }
    var G = window.__gifenc;
    var palette = G.quantize(px.data, 128);
    rec.frames.push({ index: G.applyPalette(px.data, palette), palette: palette, delay: delay || 220 });
    if (!rec.start) rec.start = Date.now();
    rec.lastCap = performance.now();
    rec.lastTotal = total;
    if (rec.frames.length > 150) {
      // long stream: thin to every other frame and slow the cadence
      rec.frames = rec.frames.filter(function (_, i) { return i % 2 === 0; });
      rec.minGap = Math.min(rec.minGap * 2, 480000);
    }
  }

  var capTimer = 0;
  function scheduleCapture() {
    if (!cfg.recap || rec.busy || rec.posting) return;
    if (total === rec.lastTotal) return;
    if (performance.now() - rec.lastCap < rec.minGap) return;
    rec.busy = true;
    clearTimeout(capTimer);
    capTimer = setTimeout(function () {
      rec.busy = false;
      captureFrame();
    }, 2400);
  }

  function fmtDur(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function endCardFrame() {
    captureFrame(1600);
    if (!rec.frames.length) return;
    var c = recCanvas.getContext('2d');
    c.fillStyle = 'rgba(7,10,18,0.55)';
    c.fillRect(0, 0, rec.w, rec.h);
    c.textAlign = 'center';
    c.fillStyle = '#f4f7fa';
    c.font = '800 26px Inter, sans-serif';
    c.fillText(total.toLocaleString(), rec.w / 2, rec.h / 2 - 14);
    c.font = '700 12px Inter, sans-serif';
    c.fillStyle = 'rgba(244,247,250,0.85)';
    c.fillText('drops this stream', rec.w / 2, rec.h / 2 + 6);
    if (rec.start) {
      c.fillStyle = 'rgba(244,247,250,0.6)';
      c.font = '600 11px Inter, sans-serif';
      c.fillText(fmtDur(Date.now() - rec.start), rec.w / 2, rec.h / 2 + 24);
    }
    c.fillStyle = accentVal();
    c.font = '700 10px Inter, sans-serif';
    c.fillText('aquilo.gg/gift-jar', rec.w / 2, rec.h - 10);
    var px = c.getImageData(0, 0, rec.w, rec.h);
    var G = window.__gifenc;
    var palette = G.quantize(px.data, 128);
    rec.frames.push({ index: G.applyPalette(px.data, palette), palette: palette, delay: 2600 });
  }

  function recapReset() {
    rec.frames = [];
    rec.w = 0; rec.h = 0;
    rec.lastCap = 0; rec.lastTotal = -1; rec.start = 0;
    rec.minGap = 30000; rec.posting = false; rec.busy = false;
  }

  function finishRecap(reason) {
    if (!cfg.recap || rec.posting || !window.__gifenc) return;
    endCardFrame();
    if (rec.frames.length < 4) return;
    rec.posting = true;
    rec.frames[0].delay = 700;
    var G = window.__gifenc;
    var gif = G.GIFEncoder();
    for (var i = 0; i < rec.frames.length; i++) {
      var f = rec.frames[i];
      gif.writeFrame(f.index, rec.w, rec.h, { palette: f.palette, delay: f.delay });
    }
    gif.finish();
    var blob = new Blob([gif.bytes()], { type: 'image/gif' });
    if (cfg.discord) {
      var fd = new FormData();
      fd.append('payload_json', JSON.stringify({
        username: 'Gift Jar',
        content: '**' + total.toLocaleString() + ' drops** landed in the jar this stream' +
          (rec.start ? ' (' + fmtDur(Date.now() - rec.start) + ')' : '') + '.'
      }));
      fd.append('files[0]', blob, 'gift-jar-recap.gif');
      fetch(cfg.discord, { method: 'POST', body: fd })
        .then(function (r) {
          if (r.ok) { showToast('recap posted to Discord'); recapReset(); }
          else { rec.posting = false; showToast('Discord rejected the recap (' + r.status + ')'); }
        })
        .catch(function () { rec.posting = false; showToast('recap post failed'); });
    } else {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'gift-jar-recap.gif';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      recapReset();
    }
  }

  function resetJar() {
    jarWake();
    queue.length = 0;
    for (var i = 0; i < items.length; i++) M.Composite.remove(engine.world, items[i].body);
    items.length = 0;
    total = 0;
    jarsFilled = 0;
    jarFull = false;
    fullStreak = 0;
    popping = false;
    if (cfg.full === 'spill') funnelsOn(true);
    updateChip();
    try { localStorage.removeItem(PERSIST_KEY); } catch (e) {}
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'r' || e.key === 'R') resetJar();
    if (e.key === 'g' || e.key === 'G') finishRecap('manual');
  });

  // ────────────────────────────────────────────────────────────────────
  // DEMO MODE + CUSTOMIZER BRIDGE
  // ────────────────────────────────────────────────────────────────────
  var DEMO_NAMES = ['NovaByte', 'Quietfawn', 'TTV_Wren', 'mossyhollow', 'PixelPyre', 'duskrunner', 'Kestrel77', 'glimmerjack'];
  function demoName() { return DEMO_NAMES[Math.floor(rand() * DEMO_NAMES.length)]; }
  function demoFire() {
    var roll = rand();
    var user = demoName();
    if (roll < 0.22)      onAlert({ platform: ['tw', 'yt', 'kk'][Math.floor(rand() * 3)], eventType: 'sub', user: user, tier: rand() < 0.2 ? '3000' : rand() < 0.45 ? '2000' : '1000' });
    else if (roll < 0.38) onAlert({ platform: 'tw', eventType: 'cheer', user: user, amount: [100, 250, 500, 1000, 5000, 10000][Math.floor(rand() * 6)] });
    else if (roll < 0.52) onAlert({ platform: 'tw', eventType: 'gift', isBomb: true, gifter: user, user: user, amount: [1, 3, 5, 10, 20][Math.floor(rand() * 5)] });
    else if (roll < 0.64) {
      var g = pickDemoGift();
      var cnt = g.c <= 5 ? Math.ceil(rand() * 10) : g.c <= 100 ? Math.ceil(rand() * 3) : 1;
      onAlert({ platform: 'tt', eventType: 'ttgift', user: user, amount: cnt, perCoin: g.c, giftName: g.n, giftImage: g.i });
    }
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

  // Customizer bridge: the aquilo.gg/gift-jar/customize/ preview embeds
  // this overlay and posts fire commands into it. Cosmetic-only drops.
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || typeof d !== 'object') return;
    if (d.gj === 'reset') { resetJar(); return; }
    if (d.gj === 'recap') { finishRecap('manual'); return; }
    if (d.gj !== 'fire' || typeof d.kind !== 'string') return;
    var user = demoName();
    var p = d.platform || ['tw', 'yt', 'kk'][Math.floor(rand() * 3)];
    var amt = Number(d.amount);
    switch (d.kind) {
      case 'sub':       onAlert({ platform: p, eventType: 'sub', user: user, tier: d.tier || '1000' }); break;
      case 'resub':     onAlert({ platform: p, eventType: 'resub', user: user, tier: d.tier || '1000' }); break;
      case 'bomb':      onAlert({ platform: 'tw', eventType: 'gift', isBomb: true, gifter: user, user: user, amount: amt || 10 }); break;
      case 'bits':      onAlert({ platform: 'tw', eventType: 'cheer', user: user, amount: amt || 1000 }); break;
      case 'member':    onAlert({ platform: 'yt', eventType: 'membership', user: user }); break;
      case 'superchat': onAlert({ platform: 'yt', eventType: 'superchat', user: user, amount: amt || 20 }); break;
      case 'tip':       onAlert({ platform: p, eventType: 'tip', user: user, amount: amt || 10 }); break;
      case 'ttgift': {
        var bg = d.giftName ? giftByName(d.giftName) : pickDemoGift();
        onAlert({ platform: 'tt', eventType: 'ttgift', user: user, amount: amt || 5,
          perCoin: Number(d.perCoin) || (bg ? bg.c : 99),
          giftName: d.giftName || (bg ? bg.n : 'Rose'),
          giftImage: d.img || (bg ? bg.i : '') });
        break;
      }
      case 'ttsub':     onAlert({ platform: 'tt', eventType: 'sub', user: user }); break;
      case 'follow':    onAlert({ platform: p, eventType: 'follow', user: user }); break;
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // SIM + RENDER LOOPS. Physics off a clock that survives rAF
  // throttling; drawing rides rAF with an interval fallback.
  // ────────────────────────────────────────────────────────────────────
  var STEP = 1000 / 60;
  var MAX_FALL = 24;
  var MAX_SIDE = 20;
  var MAX_SPIN = 0.55;
  var lastSim = performance.now();
  var simAcc = 0;
  var sweepCounter = 0;
  var lastDraw = 0;

  window.addEventListener('error', function (e) {
    window.__lastErr = String(e && (e.message || e.error) || 'unknown');
  });

  function insideJar(x, y, r) {
    if (y > geo.floorY + r) return false;
    if (y > geo.top + 0.2 * geo.H && Math.abs(x - geo.cx) > geo.bw * 1.06 + r) return false;
    return true;
  }

  function reinsert(it) {
    M.Body.setPosition(it.body, { x: geo.cx + (rand() * 2 - 1) * geo.mw * 0.4, y: geo.top - 60 });
    M.Body.setVelocity(it.body, { x: 0, y: 2 });
    M.Body.setAngularVelocity(it.body, 0);
    M.Sleeping.set(it.body, false);
  }

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
    if (simAcc > STEP * 5) simAcc = 0;

    clampAll();

    // pour pauses while the jar slides back on screen
    if (now >= wakeHoldUntil) {
      drainAcc += dt;
      var dm = drainMs();
      while (drainAcc >= dm && queue.length) {
        drainAcc -= dm;
        spawnItem(queue.shift());
      }
      if (!queue.length) drainAcc = 0;
    }

    // slide away once nothing has happened for a while
    if (cfg.slide !== 'off' && !jarHidden && !popping && !queue.length &&
        now - lastActivity > cfg.idleSecs * 1000) {
      jarSleep();
    }

    if (++sweepCounter >= 90) {
      sweepCounter = 0;
      sweepNow();
    }

    // fill sensor rides the sim clock, immune to timer throttling
    fillAcc += dt;
    if (fillAcc >= 700) {
      fillAcc = 0;
      fillCheck();
    }
  }
  var fillAcc = 0;

  // hard velocity + spin clamps: fast small bodies are what tunnel
  function clampAll() {
    for (var v = 0; v < items.length; v++) {
      var vb = items[v].body;
      var vx = clamp(vb.velocity.x, -MAX_SIDE, MAX_SIDE);
      var vy = Math.min(vb.velocity.y, MAX_FALL);
      if (vx !== vb.velocity.x || vy !== vb.velocity.y) M.Body.setVelocity(vb, { x: vx, y: vy });
      if (Math.abs(vb.angularVelocity) > MAX_SPIN) {
        M.Body.setAngularVelocity(vb, clamp(vb.angularVelocity, -MAX_SPIN, MAX_SPIN));
      }
    }
  }

  // containment sweep: anything outside the glass goes quietly back in
  // through the mouth (or despawns mid-flight in spill/pop modes), and
  // tokens arching across the mouth get a jostle so bridges collapse
  function sweepNow() {
    var flying = popping || (jarFull && cfg.full === 'spill');
    var mouthY = geo.R[0][1];
    for (var s = items.length - 1; s >= 0; s--) {
      var it = items[s];
      if (it.dying) continue;
      var b = it.body;
      var p = b.position;
      if (p.y > geo.vh + 280) {
        if (flying) {
          M.Composite.remove(engine.world, b);
          items.splice(s, 1);
        } else {
          reinsert(it);
        }
        continue;
      }
      if (!flying && p.y > geo.top + 40 && !insideJar(p.x, p.y, it.r)) {
        reinsert(it);
        continue;
      }
      // arch breaker: settled at or above the mouth line two sweeps in
      // a row means a token bridge formed across the opening; shake it
      // loose (two strikes so a token mid-roll is left alone)
      if (!flying && p.y - it.r < mouthY && b.speed < 0.5) {
        if (it._arch) {
          it._arch = 0;
          M.Sleeping.set(b, false);
          M.Body.setVelocity(b, { x: (rand() * 2 - 1) * 2.5, y: 3 + rand() * 2 });
        } else {
          it._arch = 1;
        }
      } else {
        it._arch = 0;
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
      var drawn = false;
      if (it.k.indexOf('cheer:') === 0) {
        var A = cheerAnims[+it.k.slice(6)];
        if (A && A.ready && cfg.bitsAnim) {
          var bmp = cheerFrame(A, nowMs);
          ctx2d.drawImage(bmp, -it.r * 1.1, -it.r * 1.1, d * 1.1, d * 1.1);
          drawn = true;
        } else if (A && A.img && A.img.complete && A.img.naturalWidth > 0) {
          ctx2d.drawImage(A.img, -it.r * 1.1, -it.r * 1.1, d * 1.1, d * 1.1);
          drawn = true;
        }
      } else if (it.img) {
        var im = giftImage(it.img);
        if (im && im.complete && im.naturalWidth > 0) {
          ctx2d.drawImage(im, -it.r, -it.r, d, d);
          drawn = true;
        }
      }
      if (!drawn) {
        ctx2d.drawImage(token(it.img ? 'box:tt' : it.k), -it.r, -it.r, d, d);
      }
      ctx2d.restore();
    }

    if (sparks.length) {
      var ac = accentVal();
      for (var sp = sparks.length - 1; sp >= 0; sp--) {
        var s = sparks[sp];
        s.vy += 0.22; s.x += s.vx; s.y += s.vy; s.life -= 0.028;
        if (s.life <= 0) { sparks.splice(sp, 1); continue; }
        ctx2d.globalAlpha = Math.max(0, s.life);
        ctx2d.fillStyle = s.white ? '#ffffff' : ac;
        ctx2d.beginPath();
        ctx2d.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx2d.fill();
      }
      ctx2d.globalAlpha = 1;
    }

    if (cfg.debug >= 2) drawDebugWalls();
  }

  function drawDebugWalls() {
    ctx2d.save();
    ctx2d.lineWidth = 1.5;
    walls.concat(funnels).forEach(function (b, idx) {
      var vts = b.vertices;
      ctx2d.strokeStyle = idx >= walls.length ? 'rgba(255,180,60,0.9)' : 'rgba(255,70,70,0.9)';
      ctx2d.beginPath();
      ctx2d.moveTo(vts[0].x, vts[0].y);
      for (var i = 1; i < vts.length; i++) ctx2d.lineTo(vts[i].x, vts[i].y);
      ctx2d.closePath();
      ctx2d.stroke();
    });
    ctx2d.strokeStyle = 'rgba(80,255,160,0.9)';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    var R = geo.R;
    ctx2d.moveTo(geo.cx - R[0][0], R[0][1]);
    for (var i2 = 1; i2 < R.length; i2++) ctx2d.lineTo(geo.cx - R[i2][0], R[i2][1]);
    for (var j = R.length - 1; j >= 0; j--) ctx2d.lineTo(geo.cx + R[j][0], R[j][1]);
    ctx2d.stroke();
    // fill line
    ctx2d.strokeStyle = 'rgba(120,200,255,0.8)';
    ctx2d.setLineDash([6, 5]);
    ctx2d.beginPath();
    ctx2d.moveTo(geo.cx - geo.bw, geo.fullYabs);
    ctx2d.lineTo(geo.cx + geo.bw, geo.fullYabs);
    ctx2d.stroke();
    ctx2d.restore();
  }

  var debugEl = null;
  function debugHud() {
    if (!debugEl) return;
    debugEl.textContent =
      'items ' + items.length + '  queue ' + queue.length +
      '  total ' + total +
      (jarFull ? '  FULL(' + cfg.full + ')' : '') +
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
  // REBUILD + RESIZE
  // ────────────────────────────────────────────────────────────────────
  function rebuildAndRepour() {
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
    buildJarLayers();
    placeChrome();
    if (jarFull && cfg.full === 'spill') funnelsOn(false);
    // dimensions changed: re-park with the new geometry if hidden
    if (jarHidden) stageEl.style.transform = slideVector();
    for (var k = 0; k < keep.length; k++) {
      queue.push({ k: keep[k].k, r: Math.max(9, keep[k].rn * geo.W), i: keep[k].i });
    }
  }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuildAndRepour, 180);
  });

  window.addEventListener('beforeunload', persistNow);

  // debug / selftest surface
  window.GiftJar = {
    drop: function (key, n, r) { enqueue(key || 'coin:tw', S(r || 26), null, n || 1); bumpCounter(n || 1); },
    reset: resetJar,
    demoFire: demoFire,
    pop: popJar,
    cfg: cfg,
    engine: engine,
    items: items,
    geo: function () { return geo; },
    setStyle: function (s) { if (JARS[s]) { cfg.jarStyle = s; rebuildAndRepour(); } },
    recap: finishRecap,
    captureNow: function () { captureFrame(); return rec.frames.length; },
    rec: rec,
    state: function () {
      var inWorld = 0;
      var all = M.Composite.allBodies(engine.world);
      for (var i = 0; i < funnels.length; i++) if (all.indexOf(funnels[i]) >= 0) inWorld++;
      return { jarFull: jarFull, popping: popping, jarsFilled: jarsFilled, total: total,
               funnelsActive: inWorld, items: items.length, queue: queue.length };
    },
    spawnNow: function (key, r, n) {
      for (var i = 0; i < (n || 1); i++) spawnItem({ k: key || 'coin:tw', r: S(r || 26), i: null });
    },
    fastForward: function (ms) {
      var t = 0, steps = 0;
      while (t < (ms || 1000)) {
        M.Engine.update(engine, STEP);
        clampAll();
        if (++steps % 90 === 0) sweepNow();
        t += STEP;
      }
      sweepNow();
      draw();
    }
  };

  // ────────────────────────────────────────────────────────────────────
  // BOOT
  // ────────────────────────────────────────────────────────────────────
  geo = computeGeo();
  sizeCanvas();
  buildWalls();
  buildJarLayers();
  placeChrome();
  loadBrandLogos();
  if (catEnabled('bits')) CHEER_TIERS.forEach(loadCheer);
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
    for (var di = 0; di < 10; di++) setTimeout(demoFire, 250 + di * 320);
    setTimeout(demoLoop, 3800);
  } else {
    connectSB();
    connectTF();
  }
  // Customizer "Send test to OBS" ping (placement check on the live source):
  // the shared listener flashes the frame; we add a short burst of demo drops.
  if (window.AquiloTest) {
    window.AquiloTest.onTest(function () {
      for (var ti = 0; ti < 6; ti++) setTimeout(demoFire, 200 + ti * 300);
    });
  }
  requestAnimationFrame(frame);
})();
