# ScratchDrop : Product Spec v1

Scratch-off tickets as an on-stream game. Standalone product: no StreamFusion, no
Twitch extension, no backend. Powered entirely by Streamer.bot (Twitch, YouTube,
Kick) and TikFinity (TikTok), rendered as OBS browser sources hosted on aquilo.gg.

Locked decisions (Clay, 2026-06-10):

1. All four scratch methods ship in v1 (auto-reveal, chat-scratch, streamer-scratch,
   TikTok likes-erode).
2. Everything is free. No premium gating anywhere.
3. Brand: **ScratchDrop**, published by aquilo.gg.
4. A generic pay-what-you-want support module ships alongside it and is reusable
   across all aquilo.gg products.

Copy rule: no em or en dashes anywhere in product copy, code comments, or commits.
Use comma, colon, period, middot, or hyphen.

---

## 1. Architecture

Same proven model as the SF 1.11.0 standalone overlays: static pages + local
WebSockets. Zero hosting cost per user, zero accounts, zero server state.

```
OBS browser source                    OBS custom dock
aquilo.gg/scratchdrop/overlay/        aquilo.gg/scratchdrop/dock/
        |  ws://127.0.0.1:8080  <-----------+   (localStorage cmd bus,
        |  ws://127.0.0.1:21213             |    SB relay fallback)
        v                                   v
  Streamer.bot (Twitch/YT/Kick)       Streamer.bot
  TikFinity    (TikTok)
```

- **Inbound events**: `sd-connect.js`, a fork of
  `aquilo-site/public/sf/overlay/sf-direct.js` (Hello/Auth/Subscribe handshake,
  wildcard `{Twitch:['*'], YouTube:['*'], Kick:['*'], General:['*']}`, TikFinity
  client on port 21213 with the existing gift-streak dedup).
- **Outbound actions**: new in the fork: `DoAction` (prize fulfillment, chat
  announcements) and `GetActions` (populates the customizer's action-picker
  dropdown) with a pending-id request/response map.
- **Persistence**: localStorage only. Config, pity counters, jackpot pot, prize
  stock, ticket history. Export/import JSON from the customizer.
- **Deploy**: static files in the aquilo-site repo under `public/scratchdrop/`,
  ships with the normal aquilo-site deploy. All script/css refs carry `?v=BUILD`
  cache busters (known OBS stale-cache gotcha).

### Repo layout (aquilo-site)

```
public/scratchdrop/
  index.html                landing: pitch, 3-step setup, method demos, FAQ, PWYW footer
  scratchdrop-import.txt    Streamer.bot import bundle (versioned artifact)
  overlay/
    index.html              OBS browser source
    overlay.js              render loop, queue, announcements
    sd-connect.js           sf-direct fork + DoAction/GetActions
    sd-engine.js            ticket model, outcome engine, mechanics state
    sd-foil.js              canvas foil layer + erosion (pointer, likes, auto)
    themes/                 theme token packs (css vars + particle/sfx manifest)
    sfx/                    scratch loop, win stingers, jackpot fanfare (ogg)
  customize/
    index.html, customize.js   schema-driven controls, live iframe preview, demo mode
  dock/
    index.html, dock.js     queue manager, manual issue, test panel
public/support/
  index.html                all-products PWYW page
  thanks.html               Stripe success redirect, confetti
  products.json             product -> Stripe Payment Link map
```

URLs: `aquilo.gg/scratchdrop/` (landing), `/scratchdrop/overlay/`,
`/scratchdrop/customize/`, `/scratchdrop/dock/`, `aquilo.gg/support/`.
Add a ScratchDrop card to `/tools`.

---

## 2. Tickets

```js
{
  id, ts,
  user, platform,            // twitch | youtube | kick | tiktok | manual
  avatar,
  type: 'standard' | 'golden' | 'community',
  method: 'auto' | 'chat' | 'streamer' | 'likes',   // resolved per trigger
  trigger: 'twitch.points',
  outcome: { won, prizeId, symbols[] },  // decided at issue time, see section 4
  state: 'queued' | 'active' | 'revealed' | 'done'
}
```

Ticket types:

- **standard**: normal odds, normal animation.
- **golden**: special foil + fanfare, optional separate prize table. Hand-issued
  from the dock in v1; random drop rate arrives with the v1.1 mechanics.
- **community**: one shared ticket the whole audience scratches, likes-erode by
  default, shared prize (emote unlock, game change, marathon extension). Shows a
  contributor ticker while being scratched.

## 3. Triggers (event -> ticket mapping)

Customizer maintains an ordered list of trigger rules. First matching rule wins.

```js
{
  enabled: true,
  source:  'twitch.points',         // see table
  match:   { rewardTitle: 'Scratch Ticket' },
  ticket:  { type: 'standard', method: 'auto' },   // method: auto|chat|streamer|likes|default
  limits:  { globalCooldownSec: 0, userCooldownSec: 60, maxPerStream: 0 }
}
```

| source          | match fields                          | notes |
|-----------------|---------------------------------------|-------|
| twitch.points   | rewardTitle (case-insensitive)        | SB RewardRedemption; v1 consumes only, no refund automation |
| twitch.bits     | minBits, optional perTicketBits       | perTicketBits set: floor(bits/per) tickets, capped 5 |
| twitch.sub      | tiers[]                               | includes resubs |
| twitch.giftsub  | minCount, recipientTickets bool       | giver always gets one; recipients optional, capped |
| twitch.raid     | minViewers                            | ticket goes to the raider |
| twitch.follow   |                                       | once per user (seen-set in state) |
| yt.superchat    | minAmount                             | |
| yt.member       |                                       | new + milestone |
| kick.sub        |                                       | |
| tiktok.gift     | giftNames[] OR minCoins               | tier example: rose = standard, galaxy = golden |
| tiktok.follow   |                                       | |
| tiktok.likes    | (accumulator)                         | feeds community ticket progress, not individual tickets |
| chat.command    | text, permission (anyone/sub/mod)     | overlay parses chat itself, zero SB config needed |
| chat.first      |                                       | first-time chatter this stream gets a freebie |
| manual          |                                       | dock button, any user/type |

Block list (`blockedUsers`, prefix wildcard `*` supported, same convention as the
SF overlays) is checked before any rule.

## 4. Outcome engine

Outcome is decided at issue time, then the foil reveal is staged to match. This is
how real scratch tickets work and it keeps every scratch method honest.

- Weighted prize table, `crypto.getRandomValues` RNG.
- `noWinWeight` sets the lose chance explicitly.
- **Stock**: per-prize remaining count (null = unlimited), decremented on win,
  persisted in state. Sold-out prizes drop out of the draw.
- **Near-miss staging**: on a loss, the symbol layout is biased to show two
  matching symbols (toggleable, default on, pure presentation).
- Grid modes: `single` (one panel), `strip5` (five cells, any winning symbol pays),
  `grid9` (3x3, match three symbols to win that symbol's prize).
- v1.1 mechanics (fully specced, build later, no design work left):
  - **Jackpot**: seed amount + increment per losing ticket, pot rendered on the
    overlay frame, jackpot symbol in the draw, winner takes pot (pot is a label,
    prizes stay streamer-defined, e.g. "jackpot = 50k points payout").
  - Pity timer: shipped in the QoL round, then REMOVED 2026-06-10 at Clay's call (not necessary). Do not rebuild.
  - **Golden drop rate**: chance any standard ticket upgrades at issue.

```js
prize = {
  id, label, weight,
  stock: null,
  sbAction: 'ScratchDrop · Award VIP',   // '' = announce only
  announce: '{user} scratched a {prize}!',
  icon: { kind: 'emoji'|'emote'|'image', value: '💎' },
  color: '#facc15'
}
```

## 5. The four scratch methods

All four ship in v1. Method is resolved per ticket from its trigger rule.

**Auto-reveal** (default). Ticket slides in, foil strips itself with particles and
sfx. Config: speed, order (`ltr | random | dramatic`). Dramatic order slows the
final cell when two matching symbols are already showing.

**Chat-scratch.** Overlay announces via SB chat: "@user your ticket is live, type
B2 to scratch". Coordinate grammar: `grid9` accepts `A1..C3`, `strip5` accepts
`1..5`, `single` accepts the word `scratch`. Config: window seconds (default 45),
who may scratch (`owner | anyone | subsVips`), cells per user per window.
Unscratched cells auto-finish at window end. Each accepted message erodes that
cell with the same canvas effect.

**Streamer-scratch.** Pointer events on the foil canvas, scratched live through
OBS Interact (documented clearly: browser sources only receive mouse input in the
Interact window). Number keys 1 to 9 also reveal cells for keyboard use. Intended
for golden/community tickets where the streamer performs the reveal.

**TikTok likes-erode.** TikFinity like batches convert to erosion budget:
`budget += likeCount * pxPerLike`, spent as random arc strokes across the foil,
erosion capped per frame so a like flood animates smoothly instead of popping.
Config: `likesPerCell` (default 100). TikTok gifts accelerate it:
`coinsPerCell` (default 10) finishes whole cells instantly. Default method for
community tickets; the contributor ticker credits recent scratchers.

## 6. Queue and pacing

- One active ticket at a time, FIFO queue, configurable min gap (default 4s).
- Overflow pill: "+12 tickets queued".
- Flood mode when queue depth passes a threshold: `compress` (2x animation speed,
  shortened stingers) or `batch` ("5 tickets for {user}" collapses into one card
  with N reveals). Hype trains and gift bombs must not produce a 40-minute backlog.
- Queue, current ticket, pity/jackpot/stock state all mirrored to
  `sd-status-v1` in localStorage for the dock.

## 7. Prize fulfillment: Streamer.bot contract

On reveal completion the overlay fires:

```js
DoAction({ name: cfg.prize.sbAction }, {
  ticketId, user, platform, ticketType,
  won, prizeId, prizeLabel,
  message   // announce template already rendered by the overlay
})
```

Plus `DoAction('ScratchDrop · Announce', { message })` for issue, scratch-prompt,
and result lines (each toggleable, templates support `{user} {prize} {cell}
{queue}` placeholders). TikTok cannot receive sends; announcements go to
Twitch/YouTube/Kick only.

**Import bundle** (`scratchdrop-import.txt`, authored in SB once, exported,
committed, version-stamped "ScratchDrop v1.0.0", same release convention as the
Loadout bundle):

- `ScratchDrop · Announce` : sends `%message%` to all connected chat platforms
- `ScratchDrop · Award VIP` : Twitch AddVip `%user%`
- `ScratchDrop · Play Sound` : placeholder sound path the streamer edits
- `ScratchDrop · Discord Webhook` : posts `%message%`, URL edited by streamer
- `ScratchDrop · Relay` : WebSocket-broadcasts its args back out as a General
  custom event. Lets the dock drive the overlay through SB when localStorage
  is not shared (verify exact sub-action name in current SB during build).

Customizer's prize editor populates its action dropdown from `GetActions`, so
streamers pick any of their own actions, not just bundle ones.

## 8. Customizer

Same architecture as `/sf/customize/`: schema-driven controls, tabbed sections,
live iframe preview, presets, copy-URL button. Sections and rough control count:

1. **Connection** (5): sbHost/sbPort/sbPass, tfPort, TikFinity toggle. Offers
   one-click import from `sf-direct-cfg-v1` when present.
2. **Card** (12): grid mode, scale, corner radius, foil texture
   (foil/frost/dust/gold), background image (URL or upload to dataURL), symbol
   set (classic icons, the channel's own emotes via the existing
   native/7TV/BTTV/FFZ pipeline, or custom uploads), font, accent colors.
3. **Methods** (10): default method, auto speed/order, near-miss toggle, chat
   window/permission, likesPerCell, coinsPerCell, keyboard reveal toggle.
4. **Triggers** (list editor): the section 3 rule list.
5. **Prizes** (list editor): the section 4 table + noWinWeight slider + stock.
6. **Queue** (6): gap, flood threshold + mode, position anchor + offsets,
   enter/exit animation.
7. **Audio** (6): master volume, per-moment sounds on/off + custom URLs.
8. **Announcements** (8): toggles + templates.
9. **Appearance** (8): particles style/density, screen shake, confetti, vertical
   layout toggle, theme picker.
10. **Moderation** (2): blockedUsers, per-user max tickets per stream.

**Demo mode**: Off/Slow/Normal/Fast auto-firing plus buttons (Points, Bits, Gift,
Raid, TikTok gift, Like flood x500, Community ticket), postMessage into the
preview iframe, accepted only with `?demo=1`. Identical pattern to the SF
customizer.

**Presets** (6): Casino Neon, Gold Rush, Arcade Pixel, Frostbite, Midnight
Minimal, TikTok Glow (portrait-tuned). Presets set theme + foil + particles +
sfx, never touch triggers/prizes.

**Vertical mode**: `?layout=portrait` or the Appearance toggle. Sized for TikTok
Live Studio, ticket centered low, queue pill top. TikTok Glow preset defaults it.

## 9. Dock

OBS custom dock at `/scratchdrop/dock/`:

- Live queue with skip / replay / cancel per ticket, pause-all.
- Manual issue: user + platform + type + method, comp golden tickets.
- Community ticket: start / cancel, progress bar.
- State panel: pity counter, jackpot pot (v1.1), per-prize stock with restock.
- Test panel: fire any trigger as a real ticket flagged `test`.
- History: last 500 tickets (ring buffer), CSV export, reset-state buttons.

Dock to overlay transport: localStorage command key `sd-cmd-v1` with `storage`
events (OBS docks and browser sources share one CEF profile, proven by the
rotation widget's token handoff). When the dock runs outside OBS the commands
route through `ScratchDrop · Relay` instead (dock DoAction -> SB broadcast ->
overlay's General subscription). Dock prefers localStorage, falls back to relay
when no `sd-status-v1` heartbeat is observed.

## 10. Pay-what-you-want module (all aquilo.gg products)

Everything is free; PWYW is the only money path. Zero backend:

- **Stripe Payment Links** with "customers choose what they pay" (supports
  suggested + minimum amounts). One link per product so Stripe's dashboard shows
  which product earns. Success URL: `aquilo.gg/support/thanks.html?p=<product>`.
- `public/support/products.json`: `{ id, name, blurb, stripeUrl, icon, url }[]`.
  Adding a product to the support page = one JSON entry.
- `aquilo.gg/support/`: card grid of all products from products.json, each with
  a PWYW button + "free forever" copy. ScratchDrop, StreamFusion, chat dock,
  rotation widget, Loadout bundle all listed from day one.
- Reusable footer snippet (copy-paste include, no framework): "ScratchDrop is
  free forever. If it earned a spot in your scenes, pay what you want." Lives on
  the landing page and customizer footer. Never on the overlay itself: broadcast
  surfaces stay clean.
- `thanks.html`: confetti + "you kept a tool free" copy.
- Clay setup: create the Payment Links in the Stripe dashboard, paste URLs into
  products.json. Ko-fi remains the zero-setup alternative if Stripe onboarding
  stalls; the JSON shape does not care which.

## 11. Persistence and profiles

| key             | contents |
|-----------------|----------|
| `sd-conn-v1`    | SB/TF connection config (shared by overlay/customizer/dock) |
| `sd-cfg-v1`     | full customizer config |
| `sd-state-v1`   | pity counter, jackpot pot, stock remaining, seen-user sets |
| `sd-history-v1` | last 500 tickets |
| `sd-cmd-v1` / `sd-status-v1` | dock command bus / overlay heartbeat+state mirror |

`?profile=<name>` prefixes every key for multi-channel setups on one machine.
Customizer exports/imports the whole bundle as JSON.

## 12. Gotchas to honor during build

- OBS Interact is required for streamer-scratch; landing page and customizer both
  say so explicitly.
- TikFinity double-emits gift events (mid-streak + streak-end); the sf-direct
  dedup carries over in the fork.
- TikTok features require TikFinity running locally; everything else degrades
  gracefully when port 21213 is absent.
- Channel point refunds need rewards owned by the app that created them; v1 only
  consumes redemption events. Document "make the reward auto-fulfill or manage
  refunds manually" in the FAQ.
- `?v=` cache busters on every module + css (OBS serves stale aggressively).
  Port the rotation widget's 60s deploy watcher as a fast-follow.
- ES module + linked CSS both need busting, `hidden` attribute beats media-query
  display rules unless `!important` (rotation widget lessons).
- No em or en dashes in any copy or code.

## 13. Build order (all v1 unless marked)

- **A. Core**: sd-connect fork (+DoAction/GetActions), engine, foil canvas,
  auto-reveal, 3 grid modes, triggers (points/bits/subs/gifts/raid/command),
  prize table + stock, queue + flood mode, announcements, 3 themes, landing page.
- **B. Methods**: chat-scratch, streamer-scratch, likes-erode, community ticket,
  contributor ticker, vertical layout, TikTok Glow preset.
- **C. Product**: customizer (all sections + demo mode + presets + export),
  dock (queue/manual/test/history), SB import bundle, remaining themes, emote
  symbol sets, /support PWYW module + products.json + thanks page, /tools card.
- **v1.1 fast-follow**: jackpot meter, pity timer, golden drop rate, prize
  schedules (day/hour windows), deploy watcher, profile UI polish.
- **v2 (not designed yet)**: viewer phone-scratch page (needs identity +
  backend), cloud config sync, theme marketplace, Trovo.

Out of scope permanently unless revisited: paid tiers, accounts, analytics
telemetry (privacy is a marketing feature: "everything stays on your PC").
