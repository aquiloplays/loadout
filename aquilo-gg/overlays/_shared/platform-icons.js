/*
 * Loadout overlays — shared platform icon registry.
 *
 * Maps streamer-friendly platform tokens (twitter, ig, psn, etc.) to
 * canonical simpleicons.org slugs, plus exposes helpers to build the
 * CDN URL and to render either a single big logo or a strip of small
 * ones (for multi-platform aggregator commands like !socials and
 * !gamertags).
 *
 * Source: https://github.com/simple-icons/simple-icons-cdn
 *   Single logo:    https://cdn.simpleicons.org/<slug>/<hex-color>
 *   No api key, no rate limit, just SVG bytes.
 */
(function () {
  const CDN = 'https://cdn.simpleicons.org/';
  const COLOR = 'ffffff';

  // Streamer-friendly token → simpleicons slug. Plurals + common
  // aliases all collapse onto the canonical row so callers don't
  // have to remember the exact slug.
  const SOCIALS = {
    twitter:    'x',
    x:          'x',
    instagram:  'instagram',
    ig:         'instagram',
    insta:      'instagram',
    tiktok:     'tiktok',
    tt:         'tiktok',
    youtube:    'youtube',
    yt:         'youtube',
    twitch:     'twitch',
    kick:       'kick',
    bluesky:    'bluesky',
    bsky:       'bluesky',
    threads:    'threads',
    linkedin:   'linkedin',
    github:     'github',
    gh:         'github',
    discord:    'discord',
    facebook:   'facebook',
    fb:         'facebook',
    mastodon:   'mastodon',
    reddit:     'reddit',
    snapchat:   'snapchat',
    snap:       'snapchat',
    spotify:    'spotify',
    soundcloud: 'soundcloud',
    patreon:    'patreon',
    kofi:       'kofi',
    'ko-fi':    'kofi',
    throne:     'throne',
    paypal:     'paypal',
    cashapp:    'cashapp',
    venmo:      'venmo'
  };

  // Game platforms. Some don't exist on simpleicons (e.g. PSN's slug
  // is "playstation"); aliases collapse them.
  const GAMES = {
    psn:             'playstation',
    playstation:     'playstation',
    ps5:             'playstation',
    ps4:             'playstation',
    xbox:            'xbox',
    xbl:             'xbox',
    steam:           'steam',
    riot:            'riotgames',
    riotgames:       'riotgames',
    valorant:        'valorant',
    leagueoflegends: 'leagueoflegends',
    lol:             'leagueoflegends',
    minecraft:       'minecraft',
    fortnite:        'epicgames',
    nintendo:        'nintendoswitch',
    switch:          'nintendoswitch',
    activision:      'activision',
    epic:            'epicgames',
    epicgames:       'epicgames',
    blizzard:        'battledotnet',
    battlenet:       'battledotnet',
    'battle.net':    'battledotnet',
    ubisoft:         'ubisoft',
    ea:              'ea',
    rockstar:        'rockstargames',
    bethesda:        'bethesda',
    gog:             'gogdotcom',
    itch:            'itchdotio',
    'itch.io':       'itchdotio'
  };

  function norm(s) { return (s || '').toString().trim().toLowerCase(); }

  function slug(token) {
    const k = norm(token);
    return SOCIALS[k] || GAMES[k] || null;
  }
  function iconUrl(token) {
    const s = slug(token);
    return s ? (CDN + s + '/' + COLOR) : null;
  }
  function isSocial(token) { return SOCIALS[norm(token)] != null; }
  function isGame(token)   { return GAMES[norm(token)]   != null; }

  // Render an HTML string for a strip of brand icons. Used by the
  // commands ticker badge slot when a command represents multiple
  // platforms (!socials, !gamertags). Caller controls the box size
  // via CSS (.icon-strip on the container).
  function renderStrip(platforms, opts) {
    if (!Array.isArray(platforms) || platforms.length === 0) return '';
    const limit = (opts && opts.max) || 4;
    const list = platforms.slice(0, limit);
    const overflow = Math.max(0, platforms.length - limit);
    const parts = list.map(p => {
      const url = iconUrl(p);
      if (!url) return '';
      return '<img class="icon-strip-item" src="' + url + '" alt="" loading="lazy" />';
    }).filter(Boolean);
    if (overflow > 0) parts.push('<span class="icon-strip-more">+' + overflow + '</span>');
    return '<span class="icon-strip" data-count="' + list.length + '">' + parts.join('') + '</span>';
  }

  window.PlatformIcons = { slug, iconUrl, isSocial, isGame, renderStrip, SOCIALS, GAMES };
})();
