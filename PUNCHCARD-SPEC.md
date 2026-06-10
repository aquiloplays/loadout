# PunchCard : Product Spec v1

Daily check-in cards for Twitch streams. A viewer redeems the streamer's
"Daily Check-In" channel point reward, a personalized card slides onto the
stream showing their avatar, their redeem message, and their streak. The cloud
tracks check-ins and streaks per viewer, and viewers customize their own card
(GIF background, colors, font, badge) at aquilo.gg, no app installs anywhere.

Sibling product to ScratchDrop, published by aquilo.gg. Free, with the shared
pay-what-you-want support hub.

Locked decisions (build session, 2026-06-10):

1. Brand: **PunchCard**, at aquilo.gg/punchcard/. Accent: pink.
2. Twitch-first. Channel points are the headline trigger; a chat command
   trigger (works on Twitch, YouTube, Kick via Streamer.bot) covers
   non-affiliates.
3. Cloud-backed by the loadout-discord worker (unlike ScratchDrop, which is
   local-only): streaks and viewer cards need a single source of truth that
   both the overlay and the aquilo.gg editor can see.
4. Two event sources, streamer picks one: Twitch EventSub WebSocket direct
   from the OBS browser source (zero extra software), or Streamer.bot direct
   (the ScratchDrop model). Plus a no-cloud local fallback mode.
5. Viewers authenticate with a scope-free Twitch login to edit their card, so
   nobody can deface someone else's card. GIFs come from the Giphy picker
   (worker proxy, GIPHY_API_KEY already provisioned); raw image URLs are off
   by default and opt-in per channel.

Copy rule: no em or en dashes anywhere in product copy, code comments, or
commits. Use comma, colon, period, middot, or hyphen.

---

## 1. Architecture

```
OBS browser source                          aquilo.gg/punchcard/card/
aquilo.gg/punchcard/overlay/?ch=&k=&cfg=    (viewer card editor, Twitch login)
   |            |                                     |
   |            | wss://eventsub.wss.twitch.tv        | fetch (Bearer session)
   |            | (streamer token minted by worker)   v
   |            +---------------------+    loadout-discord worker
   | ws://127.0.0.1:8080 (SB mode)    |    /api/punchcard/*  (KV: pc:*)
   v                                  |        ^
Streamer.bot (Twitch/YT/Kick)         +--------+  POST /checkin {ch,k,...}
```

- The **overlay** hears redemptions either straight from Twitch (EventSub
  WebSocket, token fetched from the worker) or from Streamer.bot's WebSocket
  (fork of sd-connect.js). On a matching event it POSTs the check-in to the
  worker, which computes the streak and returns the viewer's card config; the
  overlay renders the slide-in card.
- The **worker module** (discord-bot/punchcard.js) owns channel claims, per
  channel Twitch tokens, the streak engine, viewer cards, sessions, the Giphy
  proxy, the leaderboard, and moderation.
- The **customizer** (streamer) connects Twitch once: that claims the channel,
  stores the refresh token, and mints the channel key `k` baked into the
  overlay URL. It can create the channel point reward via Helix in one click.
- The **card editor** (viewer) logs in with Twitch (no scopes), shows live
  streak stats, a punch-grid calendar, the channel leaderboard, and saves the
  card look the overlay will render.

### Repo layout

```
aquilo-site/public/punchcard/
  index.html                landing page
  overlay/index.html        OBS browser source shell
  overlay/pc-engine.js      config schema + encode/decode, streak core (client
                            copy), sanitizers, demo data, local-mode store
  overlay/pc-card.js        shared card DOM renderer (overlay + editor)
  overlay/pc-connect.js     event client: Twitch EventSub direct, SB direct, demo
  overlay/overlay.js        boot, queue, check-in POST, slide lifecycle, audio
  overlay/overlay.css       card + animation styles, tier rings, themes
  customize/index.html      streamer customizer
  customize/customize.js
  card/index.html           viewer card editor
  card/card-editor.js
aquilo-site/scripts/pc-selftest.mjs
Loadout/discord-bot/punchcard.js          worker module (routes + Helix + KV)
Loadout/discord-bot/punchcard-streak.js   pure streak engine (parity-tested
                                          against the pc-engine.js copy)
```

## 2. Identity, claims, and keys

- A channel is its lowercase Twitch login. Claiming happens through the
  Twitch OAuth flow only, so squatting is impossible: whoever completes OAuth
  for `login` IS that broadcaster.
- The claim mints `k` (32 hex chars), the channel write capability: check-in
  POSTs, token mints, reward management, config, and moderation all require
  it. It rides in the overlay URL (local to OBS) and the customizer's
  localStorage. Re-running Connect Twitch returns the existing `k` to the
  same browser; `?rotate=1` on the start URL mints a fresh one (lost key
  recovery; OAuth is the proof of ownership).
- Viewers get `pc:sess:<token>` sessions (30 day TTL) from the scope-free
  login. Card writes are authenticated as that login, period.

### OAuth without touching the Twitch app config

The worker reuses the already-registered redirect URI
(`<PUBLIC_WORKER_URL>/admin/twitch-oauth/callback`). PunchCard states carry
the prefix `pc1.`; worker.js routes callback hits with that prefix to the
punchcard handler BEFORE the existing admin handler runs, so Clay's
broadcaster flow is untouched and no Twitch console change is needed.

- Streamer scopes: `channel:read:redemptions channel:manage:redemptions`
  (manage enables one-click reward creation; if Twitch ever rejects manage
  the read scope still powers EventSub).
- Viewer scopes: none (identity only via /oauth2/validate).
- The callback redirects back to aquilo.gg with a one-time code in the URL
  fragment; the page exchanges it via POST /oauth/finish for the payload
  (streamer: login + k; viewer: session token). Codes are single-use, 5 min.

## 3. Streak engine

A "day" is computed in the channel's timezone with a rollover hour (default
04:00) so a stream that crosses midnight counts as one day:
`dayIdx = YYYY-MM-DD of (now - rolloverHours)` via Intl in the channel tz.

Two modes (channel cfg, default `active`):

- **active** (stream days): the channel's active-day list is every day at
  least one check-in happened (`pc:days:<ch>`, capped 400). A viewer's streak
  continues iff their previous check-in was on the channel's most recent
  active day before today. Streamer skips Tuesday: nobody breaks.
- **calendar**: strict consecutive calendar days.

Transitions (pure function, identical in punchcard-streak.js and
pc-engine.js, parity-asserted by the selftest):

```
last == today                    -> dup (no increment, surfaced on the card)
last == prevActiveDay(today)     -> streak + 1        (active mode)
last == yesterday(today)         -> streak + 1        (calendar mode)
otherwise                        -> streak = 1
best = max(best, streak); total + 1; dates ring (60)
```

Milestones at 3, 7, 14, 30, 50, 100, 180, 365 fire a celebration animation.
Permanent card ring tiers: bronze 7+, silver 30+, gold 100+, aurora 365+
(based on BEST streak, so a broken streak keeps the earned ring).

## 4. Worker API (all /api/punchcard/*, CORS open, JSON)

```
GET  /oauth/start?mode=streamer|viewer&ch=&ret=   302 to id.twitch.tv
POST /oauth/finish {code}                          one-time code -> payload
GET  /meta?ch=                 public channel info (claimed, reward title,
                               display, allowCustomImg, giphy available)
POST /checkin {ch,k,viewer,display,msg,rewardId,rewardTitle,source,platform}
                               -> {ok,streak,total,best,dup,milestone,ring,
                                   card,avatar,activeDays}
GET  /token?ch=&k=             -> {accessToken,clientId,broadcasterId,expiresIn}
                               (streamer user token for the EventSub socket)
GET  /rewards?ch=&k=           list channel point rewards (picker)
POST /reward {ch,k,title,cost,prompt}   create the reward via Helix
POST /cfg {ch,k,cfg:{tz,rollover,mode,allowCustomImg}}
GET  /recent?ch=&k=            last 30 check-ins (mod panel)
POST /mod {ch,k,action:block|unblock|resetStreak|resetCard,viewer}
GET  /me?ch=        (Bearer)   viewer stats + saved card + channel summary
POST /card {ch,card} (Bearer)  validate + save card
GET  /gif?q=                   Giphy search proxy (rating pg-13, cached)
GET  /leaderboard?ch=          top 50 current streaks (public)
```

### KV (LOADOUT_BOLTS, prefix pc:)

```
pc:chan:<ch>      {v,k,login,display,userId,createdAt,
                   cfg:{tz,rollover,mode,allowCustomImg},
                   tw:{rt,at,atExp},rewardId,rewardTitle,blocked:[]}
pc:u:<ch>:<vw>    {t,s,b,l,d:[..60],display,card,lastTs}
pc:days:<ch>      [dayIdx.. 400]
pc:lb:<ch>        {updated,top:[{v,display,s,t}..50]}
pc:recent:<ch>    [{v,display,msg,day,ts,s,dup}..30]
pc:sess:<tok>     {login,display,avatar,iat}        TTL 30d
pc:code:<code>    {kind,payload}                    TTL 5m
pc:oauth:<state>  {mode,ch,ret,rotate}              TTL 10m
pc:av:<login>     avatar url                        TTL 24h
pc:gif:<sha>      cached search                     TTL 30m
```

Known soft spots, accepted for v1: KV read-modify-write on pc:days / pc:lb
can drop one concurrent update (per-viewer records are per-key and safe);
concurrent token refresh from two overlay instances can race the rotated
refresh token (recovery: reconnect Twitch in the customizer).

## 5. Viewer cards

Card schema (validated server-side):

```
{ bg: { kind: preset|solid|gradient|gif|img, preset, c1, c2, url },
  accent: #hex, font: inter|bangers|pressstart|pacifico|oswald|caveat,
  emoji: <= 4 chars }
```

- GIF/img URLs must be https on an allow-listed host (giphy, tenor, imgur);
  arbitrary https hosts only when the channel sets allowCustomImg.
- The redeem message renders on the card: control chars stripped always,
  URLs stripped and profanity masked per overlay cfg (defaults on), clamped
  to 140 chars (200 server-side).
- Blocked viewers: check-ins are dropped server-side (204-style ok:false),
  and the overlay also filters its local blocked list.
- "Powered by GIPHY" attribution on the picker (TOS).

## 6. Overlay behavior

- URL: `/punchcard/overlay/?ch=<login>&k=<key>&src=twitch|sb&cfg=<b64url>`.
  No ch/k: local mode (SB events only, streaks in localStorage, default card
  styling, editor link hidden). `?demo=1`: scripted fake check-ins, no
  sockets, no POSTs (customizer preview + landing hero).
- Queue: one card at a time, configurable hold (default 7s), gap, max queue
  12 with overflow compression (oldest collapse to a quick toast).
- Slide-in from the configured anchor (bottom-right default), avatar, name,
  message, flame + streak count, total punches, milestone confetti burst,
  tier ring. Dup shows "already punched today".
- Audio: synthesized WebAudio chime (no asset), volume cfg, default on 0.7.
- Live cfg push from customizer preview via postMessage {pc:'cfg',cfg}.
- EventSub client: welcome/keepalive watchdog (1.5x timeout), reconnect with
  backoff honoring session_reconnect, token refetch + resubscribe on 401.
- SB client: Hello/Auth/Subscribe Twitch+YouTube+Kick wildcard, normalizes
  RewardRedemption (title or id match, trimmed case-insensitive) and chat
  command (cfg.trigger.command, default off, per-viewer 60s client cooldown).

## 7. Customizer (streamer)

Sections: Connection (Connect Twitch button + status, source picker, SB
host/port/password when src=sb), Reward (create with cost/prompt or pick
from the list, title match fallback), Behavior (command trigger, dup
visibility, message show/strip/filter, audio), Look (anchor, offsets, scale,
hold, theme accents), Moderation (blocked users, allowCustomImg, recent
check-ins with one-click block/reset), Viewer link (copyable
/punchcard/card/?ch= URL for chat/panels). Right column: 16:9 demo preview
iframe + fire buttons + the overlay URL box, exactly the ScratchDrop layout.

## 8. Viewer editor

Login gate, then: live card preview (pc-card.js, same DOM as the overlay),
controls (bg presets, solid/gradient pickers, Giphy search grid, custom URL
when allowed, accent, font, emoji), save; stats row (streak, best, total);
punch calendar (last 8 weeks of dates ring); channel leaderboard top 10.
Logged-out visitors get a demo playground + login CTA.

## 9. Build order (all v1)

1. PUNCHCARD-SPEC.md (this file)
2. punchcard-streak.js + punchcard.js + worker.js wiring
3. overlay (engine, card, connect, overlay.js, css)
4. customizer
5. card editor
6. landing + products.ts + support/products.json entries
7. pc-selftest.mjs green
8. commit both repos, push site, deploy worker

## 10. Shipped after v1 (same day)

- Viewer GIF/image placement: card.bg gains posX/posY (focal point), zoom
  (100-220, transform-scale from the focal origin), dim (0-100 scrim
  opacity), layout (full | left | right mask fade). Old cards render with
  v1 defaults.
- Emote badges + inline message emotes: viewer OAuth scope is now
  user:read:emotes; the worker snapshots the viewer's full usable emote
  set at login (pc:emotes:<login>, token never stored), the editor offers
  it as a searchable badge picker, and check-ins match message words
  against the set so cards render the viewer's own emotes inline.
- Sub tier card effects: streamer scope now includes
  channel:read:subscriptions; check-ins resolve the viewer's tier
  (pc:sub:<ch>:<v>, 8h cache) and cards layer T1 silver / T2 gold /
  T3 iridescent sheens (streamer toggle look.subFx). Claims made before
  the scope was added degrade to tier 0 until reconnect.
- Multi-platform: TikFinity leg in pc-connect (comments feed the chat
  command, named streak-end gifts can count as the daily punch via
  trigger.tiktokGift); platform-prefixed identities (yt:/kk:/tt:);
  platform chips via the shared sf-icons.js sprite; non-Twitch avatars
  ride the event and merge client-side. Card customization remains
  Twitch-login only.

Retention pack (same day, round 4):

- Redemption lifecycle: points-sourced check-ins carry the redemption id;
  the worker FULFILLs on success (clears the streamer's queue) and
  CANCELs on a duplicate (auto-refunds the points). Only legal on the
  reward PunchCard created; channel cfg toggles autoFulfill + refundDup
  (both default on). Card chip reads "already punched, points refunded".
- Streak freezes: one earned per milestone, hold up to FREEZE_CAP (3),
  auto-spent to bridge EXACTLY one missed day (active mode: the viewer's
  last check-in equals the active day before prevActive; calendar mode:
  two days ago). Lives in the parity-locked streak core (advance gained
  a prev2Active arg + f/freezeUsed fields); editor shows the count.
- Milestone chat announcements: streamer scope now includes
  user:write:chat; when cfg.announceMilestones is on (default off) the
  worker posts the milestone to chat as the broadcaster.
- Leaderboard overlay widget at /punchcard/leaderboard/?ch= (public
  read, no key): top streaks, 340px, refreshes every minute, params
  max/title/accent, demo=1 for previews.
- First-punch-of-day flair: the check-in that opens a new channel-active
  day gets a "today's first punch!" chip.

Round 5 (same day): shareable streak card PNG export (pc-share.js, 1200x400
banner, editor download button, CORS-safe CDNs, taint-rejecting fallback).

Round 6 (same day), discovery + cosmetics:

- Editor discovery: opt-in first-check-in chat welcome with the editor
  link (cfg.announceWelcome), "make yours · aquilo.gg/punchcard" brand
  hint on uncustomized cards (look.editorHint, streamer toggle), and a
  downloadable 320x100 Twitch About-panel image (PCShare.panel) in the
  customizer.
- Reward hardening: created rewards set max_per_user_per_stream = 1 so
  Twitch itself blocks live double-redeems; the worker refund stays as
  the backstop for offline redeems and stream restarts.
- Card cosmetics (all whitelisted server-side): nameFx (accent /
  gradient / animated rainbow), texture (dots / scanlines / sparkle),
  entrance animation (slide / pop / flip / drop, viewer-picked, plays
  on the overlay), avatarShape (circle / squircle / hex), custom streak
  icon emoji, and a holo foil sweep that saves any time but only
  RENDERS once the gold ring (100 day best) is earned.

Deferred to v1.1: Streamer.bot announce action on milestones (the Helix
chat announce covers Twitch; an SB action would cover YT/Kick), Discord
webhook digest, a dock page (moderation lives in the customizer for now).
