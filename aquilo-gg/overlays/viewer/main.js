/*
 * Loadout - Viewer profile overlay client.
 *
 * Subscribes to `viewer.profile.shown` from the bus. The InfoCommandsModule
 * publishes that event when a chatter runs !profile (or !profile @user).
 * The card slides in for `duration` ms, then back out.
 *
 * The server-side payload includes:
 *   { handle, platform, bolts, requester, ts }
 * Future enhancements (the overlay reads them defensively):
 *   { topChatterRank, subAnniversaryMonths, checkInStreak, links: [...] }
 */
(() => {
  const params = new URLSearchParams(location.search);
  const busUrl = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const duration = parseInt(params.get('duration') || '10000', 10);
  const debug = params.get('debug') === '1';

  const align = params.get('align'); if (align) document.body.dataset.align = align;

  const card      = document.getElementById('card');
  const handle    = document.getElementById('handle');
  const initial   = document.getElementById('initial');
  const avatar    = document.getElementById('avatar');
  const avatarImg = document.getElementById('avatarImg');
  const stats     = document.getElementById('stats');
  const bioEl     = document.getElementById('bio');
  const pronEl    = document.getElementById('pronouns');
  const linksEl   = document.getElementById('links');

  let hideTimer = null;

  // Real brand logos via the simpleicons.org CDN — every chip pulls a
  // proper SVG (Twitter's bird, Bluesky's butterfly, Steam's gear, etc.)
  // rendered in white so it sits cleanly on the dark chip background.
  // Slug map below normalizes streamer-friendly tokens onto simpleicons
  // canonical slugs; unknown tokens fall back to a plain "@" pill.
  //
  // CDN docs: https://github.com/simple-icons/simple-icons-cdn
  // Format:   https://cdn.simpleicons.org/<slug>/<hex-color>
  const SIMPLEICONS = 'https://cdn.simpleicons.org/';
  const ICON_COLOR  = 'ffffff';
  const SOCIAL_SLUGS = {
    twitter:   'x',          // X (formerly Twitter) → simpleicons "x"
    x:         'x',
    instagram: 'instagram',
    ig:        'instagram',
    tiktok:    'tiktok',
    youtube:   'youtube',
    twitch:    'twitch',
    kick:      'kick',
    bluesky:   'bluesky',
    bsky:      'bluesky',
    threads:   'threads',
    linkedin:  'linkedin',
    github:    'github',
    discord:   'discord',
    facebook:  'facebook',
    mastodon:  'mastodon',
    reddit:    'reddit',
    snapchat:  'snapchat',
    spotify:   'spotify',
    soundcloud:'soundcloud'
  };
  const GAME_SLUGS = {
    psn:             'playstation',
    playstation:     'playstation',
    xbox:            'xbox',
    steam:           'steam',
    riot:            'riotgames',
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
    ubisoft:         'ubisoft',
    ea:              'ea'
  };
  function iconUrl(slug) { return SIMPLEICONS + slug + '/' + ICON_COLOR; }
  function socialIcon(platform) {
    const slug = SOCIAL_SLUGS[(platform || '').toLowerCase()];
    return slug ? iconUrl(slug) : null;
  }
  function gameIcon(platform) {
    const slug = GAME_SLUGS[(platform || '').toLowerCase()];
    return slug ? iconUrl(slug) : null;
  }

  function render(p) {
    if (!p) return;
    if (hideTimer) clearTimeout(hideTimer);

    const name = p.handle || 'viewer';
    handle.textContent = '@' + name;
    initial.textContent = (name[0] || '?').toUpperCase();
    avatar.dataset.platform = (p.platform || '').toLowerCase();

    // Avatar: when the viewer set a !setpfp URL, show it; else fall
    // back to the initial-letter circle.
    if (p.pfp && /^https?:\/\//i.test(p.pfp)) {
      avatarImg.src = p.pfp;
      avatar.classList.add('has-img');
    } else {
      avatarImg.removeAttribute('src');
      avatar.classList.remove('has-img');
    }

    // Pronouns line (small, under handle).
    if (p.pronouns) { pronEl.textContent = p.pronouns; pronEl.style.display = ''; }
    else            { pronEl.textContent = ''; pronEl.style.display = 'none'; }

    // Bio. Empty bio collapses the slot so the card shrinks.
    if (p.bio) { bioEl.textContent = p.bio; bioEl.style.display = ''; }
    else       { bioEl.textContent = ''; bioEl.style.display = 'none'; }

    // Stats: bolts + streak + sub anniversary + rank + checkin streak.
    const cells = [];
    if (p.bolts != null)
      cells.push({ label: 'bolts', value: fmtNumber(p.bolts), color: 'cyan' });
    if (p.streakDays != null && p.streakDays > 1)
      cells.push({ label: 'streak', value: p.streakDays + 'd', color: 'gold' });
    if (p.subAnniversaryMonths != null && p.subAnniversaryMonths > 0)
      cells.push({ label: 'sub mo.', value: p.subAnniversaryMonths });
    if (p.topChatterRank != null && p.topChatterRank > 0)
      cells.push({ label: 'rank', value: '#' + p.topChatterRank, color: 'gold' });
    if (p.checkInStreak != null && p.checkInStreak > 0)
      cells.push({ label: 'check-in streak', value: p.checkInStreak });
    if (Array.isArray(p.links) && p.links.length > 0)
      cells.push({ label: 'linked', value: p.links.length, color: 'azure' });
    if (cells.length === 0)
      cells.push({ label: 'platform', value: (p.platform || 'unknown') });

    stats.innerHTML = cells.map(c =>
      `<div class="stat" data-color="${c.color || ''}">
         <div class="label">${escapeHtml(c.label)}</div>
         <div class="value">${escapeHtml(String(c.value))}</div>
       </div>`).join('');

    // Socials + gamer tags chips. Each chip renders the real brand
    // SVG from simpleicons.org rather than an emoji approximation —
    // a Twitter chip shows the X bird, a PSN chip shows the Sony
    // PlayStation logo, etc. Falls back to a plain "@" pill if the
    // platform isn't in the slug map (rare; whitelist covers the
    // common cases).
    const chips = [];
    const socials = (p.socials && typeof p.socials === 'object') ? p.socials : {};
    for (const [k, v] of Object.entries(socials)) {
      if (!v) continue;
      chips.push({ icon: socialIcon(k), label: v, kind: 'social', platform: k });
    }
    const tags = (p.gamerTags && typeof p.gamerTags === 'object') ? p.gamerTags : {};
    for (const [k, v] of Object.entries(tags)) {
      if (!v) continue;
      chips.push({ icon: gameIcon(k), label: v, kind: 'game', platform: k });
    }
    if (chips.length > 0) {
      linksEl.innerHTML = chips.map(c => {
        const visual = c.icon
          ? `<img class="g brand" src="${escapeHtml(c.icon)}" alt="" loading="lazy" />`
          : `<span class="g fallback">@</span>`;
        return `<div class="chip" data-kind="${c.kind}" title="${escapeHtml(c.platform + ': ' + c.label)}">
                  ${visual}
                  <span class="lab">${escapeHtml(c.label)}</span>
                </div>`;
      }).join('');
      linksEl.style.display = '';
    } else {
      linksEl.innerHTML = '';
      linksEl.style.display = 'none';
    }

    requestAnimationFrame(() => card.classList.add('show'));
    hideTimer = setTimeout(() => card.classList.remove('show'), duration);
  }

  function fmtNumber(n) {
    if (n >= 1_000_000) return (n/1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000)     return (n/1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[ch]));
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
      ws.send(JSON.stringify({ v: 1, kind: 'hello',     client: 'overlay-viewer' }));
      ws.send(JSON.stringify({ v: 1, kind: 'subscribe', kinds: ['viewer.profile.shown', 'viewer.profile.updated'] }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg) return;
      // .updated fires when a viewer runs !setbio / !setpfp / etc. so
      // we can preview the change live during a !profile session.
      if (msg.kind === 'viewer.profile.shown' || msg.kind === 'viewer.profile.updated') {
        render(msg.data);
      }
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
    el.textContent = 'bus: ' + text;
  }

  if (debug) {
    render({
      handle: 'mocha', platform: 'twitch',
      bolts: 5430, streakDays: 7,
      pronouns: 'they/them',
      bio: 'caffeine-powered VTuber, gremlin energy. ily all 💖',
      pfp: 'https://i.pravatar.cc/150?img=12',
      socials:   { twitter: 'mocha', bluesky: 'mocha.bsky.social', tiktok: 'mocha' },
      gamerTags: { steam: 'mocha-irl', psn: 'MochaIRL' }
    });
  }
  connect();
})();
