# PowerDeck: bits power-up challenge card packs

Viewers redeem a custom Twitch bits power-up and rip open a pack of 3
challenge cards live on stream. The cards match the game the streamer is
playing ("No-reload run", "Melee only next fight", "Talk in rhymes for
2 minutes"). Viewers hold cards in an inventory, then play them from
chat to put a challenge on the streamer's screen. The streamer controls
pacing with cooldowns and a pause switch, live from an OBS dock.

Family: sibling of ScratchDrop (architecture twin) and PunchCard.
Static-first product: the overlay + customizer + dock are static pages
on aquilo.gg, all state local to the streamer's machine. The only
backend is the Pack Workshop (community pack registry) on the
loadout-discord worker.

## URLs

| Page        | URL                                | Purpose |
|-------------|------------------------------------|---------|
| Landing     | aquilo.gg/powerdeck/               | pitch, live demo loop, setup steps |
| Overlay     | aquilo.gg/powerdeck/overlay/       | OBS browser source |
| Customizer  | aquilo.gg/powerdeck/customize/     | schema-driven controls + live preview |
| Dock        | aquilo.gg/powerdeck/dock/          | OBS custom browser dock |
| Workshop    | aquilo.gg/powerdeck/workshop/      | browse + build community packs |

## Purchase flow (how a pack gets bought)

Primary: the streamer creates a **custom bits Power-up** in their Twitch
dashboard (Points and Channel Rewards) named e.g. "Card Pack". Twitch
emits EventSub `channel.custom_power_up_redemption.add` v1 (also visible
through `channel.bits.use` v1 with a `custom_power_up` object; scope
`bits:read`). Streamer.bot forwards these on its WebSocket; the overlay
is subscribed with wildcards and normalizes them to a `powerup` event.

The overlay connects straight to Streamer.bot (ws://127.0.0.1:8080,
Hello/Authenticate/Subscribe), same client pattern as ScratchDrop's
sd-connect.js. No Loadout DLL required; PowerDeck is standalone.

Configurable purchase triggers (cfg.triggers, first match wins):

1. `twitch.powerup`: custom power-up redemption, matched by power-up
   title (contains, case-insensitive) or id. THE flagship path.
2. `twitch.points`: channel point reward, matched by reward title.
   Fallback for channels without power-up access.
3. `twitch.bits`: plain cheer at/above a minimum. Off by default to
   avoid double-granting next to the power-up trigger.
4. `twitch.giftsub`: gift subs earn the gifter a pack.
5. `tiktok.gift`: TikFinity (ws 21213) gift by min coins or gift name.
6. `chat.command`: `!buypack`, permission-gated (mods/test by default).
7. Dock manual grant (test or real).

Bits-family dedup: one cheer can surface through multiple SB event
types (legacy Cheer + newer BitsUsed; a power-up may arrive both as
CustomPowerUpRedemption and BitsUsed with a power_up object). The
envelope layer classifies power-up frames as `powerup` (never `bits`)
and the engine dedupes identical bits-family purchases inside an 8s
window keyed on redemption id when present, else user+amount.

Paused behavior: bits are already spent and cannot be refunded, so
pausing NEVER discards purchases. Pause (packs) queues the pack
animation and still grants cards. Pause (plays) rejects `!play` with a
chat reply. Both toggles live on the dock.

## Cards and packs

Pack content shape (built-in and workshop share it):

```js
{
  id: 'fortnite',            // workshop packs: 'w:<12 hex>'
  game: 'Fortnite',
  name: 'Fortnite Challenge Pack',
  by: 'aquilo.gg',
  emoji: '🪂',               // pack emblem on the pack art
  cards: [
    { id: 'fn01', name: 'Grounded', text: 'Win your next fight without building.',
      rarity: 'common', emoji: '🏗️', timed: 0 },
    ...
  ]
}
```

Rarities: common / rare / epic / legendary. Draw weights are
channel-configurable (defaults 60/27/10/3), cards-per-pack default 3
(1-5), no duplicate cards within one pack, optional pity (guaranteed
epic-or-better after N packs without one, default 10, 0 disables).

Built-in packs ship client-side in `pd-packs.js` (no worker dependency):
Any Game (generic), Fortnite, Minecraft, Apex Legends, Call of Duty,
Valorant, League of Legends, Rocket League, GTA Online, Among Us,
Lethal Company, Phasmophobia, Dead by Daylight, Elden Ring / Souls,
Stardew Valley, Fall Guys, Golf With Your Friends. 12+ cards each,
written to be game-accurate and safe (no self-harm, no slurs, no
"drink" mechanics).

The streamer enables any set of packs and picks the **current game**
(dock can switch it live). Purchases draw from the current pack; if
none selected, from all enabled packs.

## Inventory and chat commands

Inventory persists in overlay localStorage (`pd-inv-v1`), keyed
`user -> { '<packId>/<cardId>': count }`, capped (50 distinct cards per
user, 400 users, oldest-touched pruned). Same persistence model as
ScratchDrop state: survives OBS restarts, lives on the streamer's
machine, zero accounts.

Chat commands (all renameable, each with its own cooldown + toggle):

| Command  | Who      | Effect |
|----------|----------|--------|
| `!cards` | anyone   | overlay replies with that viewer's hand, numbered |
| `!play <n or name>` | anyone | plays a held card: starts a challenge |
| `!packs` | anyone   | how to buy + what game is live |
| `!carddone` | mods | complete the active challenge |
| `!cardskip` | mods | skip the active challenge |

Replies go out through the bundled **PowerDeck · Announce**
Streamer.bot action (CPH chat send), throttled to one message per 1.4s.
The overlay never needs Twitch credentials.

## Challenges

`!play` validates ownership, cooldowns (per-viewer play cooldown,
channel-wide gap, max active + queue caps), pause state, then either
activates the challenge or queues it. Active challenges render as a
banner card on the overlay: card art, challenge text, who played it,
countdown ring when the card is timed. Completion paths: dock buttons,
mod chat commands, or timer expiry (configurable to auto-complete or
auto-expire). Completions announce to chat and log to history
(`pd-history-v1`, ring 500).

## Pack-open animation (the premium moment)

Fully procedural (CSS/SVG/canvas + WebAudio synth, zero asset files):

1. **Drop-in**: the pack (theme gradient + game emblem + foil sheen)
   swings in with a glow ring, header "PixelPirate ripped a Card Pack".
2. **Rip**: the top tears (clip-path), particle burst (canvas), flash.
3. **Reveal**: cards fan out one at a time, each 3D-flips from card
   back to face with a rarity glow: common slate, rare blue, epic
   violet, legendary gold with animated holo shimmer + extra particles
   + fanfare stinger.
4. **Hold + exit**: hand lingers (configurable), then flies out.

Queue with flood handling (gap halves when 8+ packs queue). Anchor +
offset + scale configurable like ScratchDrop's queue block.

## Configuration

Same config plumbing as ScratchDrop: `PDEngine.DEFAULTS`, deep merge,
localStorage `pd-cfg-v1`, `?cfg=<base64url diff>` baked URLs,
`?profile=` suffix for multi-channel, postMessage `{pd:'cfg'}` live
preview, `?demo=1` socket-free mode, `?demo=1&loop=1` self-driving
landing hero. Deploy watcher (`pd-watch.js`) reloads on new deploys,
never mid-pack (gated on `PDBusy()`).

Customizer sections: Connection, Purchases (trigger list), Packs
(built-ins + workshop by id + current game), Pack opening (count,
rarity weights, pity, queue, animation intensity, sounds), Commands +
cooldowns, Challenges (max active, queue, timer behavior), Announce
templates, Appearance (6 theme presets, accents, scale, anchor),
Moderation (block list with `*` wildcards).

## Dock integrations

**PowerDeck dock** (aquilo.gg/powerdeck/dock/): status (overlay live,
SB connected), pause packs / pause plays, current game switcher, active
challenge complete/skip, queued packs + challenges, manual grant + test
fire, quick cooldown edit, history + CSV export.

Transport, ScratchDrop-proven: every command writes localStorage
`pd-cmd-v1` (instant when the dock runs inside OBS next to the overlay,
same CEF profile + same origin) AND fires the bundled **PowerDeck ·
Relay** SB action which `WebsocketBroadcastJson`s
`{"powerdeck":{...}}` to all SB websocket clients. Sequence numbers
dedupe double delivery. Status flows back via the overlay's
`pd-status-v1` heartbeat (localStorage, 2.5s).

**Loadout dock panel**: aquilo.gg/dock/loadout/ gains a PowerDeck card
(pause/resume both switches, game switcher, complete/skip, open-full-
dock link). It is its own IIFE + script, fully independent of the
Aquilo Bus secret gate, so it works even when the Loadout DLL is not
running. Same origin = same localStorage bus; SB relay as fallback.
Zero C# changes.

## Pack Workshop (the one server piece)

Streamers build custom packs in the browser and publish them for other
streamers. Worker module `discord-bot/powerdeck.js` on loadout-discord,
KV LOADOUT_BOLTS, keys prefixed `pd:`:

```
pd:pack:<id>      pack JSON + editKeyHash + visibility + uses + reports
pd:gallery        public gallery index (summaries, cap 500)
pd:rl:<ip>:<op>   rate-limit markers (TTL)
```

Routes (CORS open, no accounts; capability model = unguessable id +
edit key, the sfdock profile pattern):

```
POST /api/powerdeck/pack          create (returns id + editKey) or update (id + editKey)
GET  /api/powerdeck/pack?id=      fetch one pack (public or unlisted)
POST /api/powerdeck/pack/delete   { id, editKey }
GET  /api/powerdeck/gallery?game=&q=&sort=   public packs only
POST /api/powerdeck/use           { id } bump uses counter (gallery sort signal)
POST /api/powerdeck/report        { id, reason } 5 distinct-IP reports auto-hide
```

Validation server-side: 3-24 cards, name/text length caps, rarity enum,
emoji length, total JSON <= 24KB, html stripped. Create rate limit
10/day/IP. Published packs are fetched by id from the customizer
(`?addPack=<id>`), cached in `pd-packs-cache-v1`, and embedded in the
overlay's enabled-pack set; the overlay refetches on boot with cache
fallback so a workshop outage never kills a stream.

Visibility: `public` (in gallery) or `unlisted` (only by id). The
customizer's own "make a pack" flow saves unlisted by default.

## Streamer.bot import bundle

`tools/build-powerdeck-import.ps1` (SBAE gzip+base64, version-stamped
manifest, ScratchDrop builder pattern) producing
`streamerbot/powerdeck-import.sb.txt` + a copy in
`aquilo-site/public/powerdeck/`. Three actions:

1. **PowerDeck · Announce**: sends `{message}` to Twitch/YouTube/Kick
   chat via CPH (reflection-guarded).
2. **PowerDeck · Relay**: rebroadcasts `pdRelay` JSON as
   `{"powerdeck":{...}}` via WebsocketBroadcastJson (dock transport).
3. **PowerDeck · Play Sound**: optional sound hook for pack opens.

No triggers needed for purchases: the overlay listens to raw SB events.

## Selftest

`scripts/pd-selftest.mjs` (puppeteer-core + headless Chrome, file://):
boot globals, engine invariants (rarity distribution inside band, no
dupes in a pack, pity forces epic+, cooldown + pause + queue caps,
command parsing incl. permissions, block list, powerup envelope
classification + bits dedup), e2e demo pack reveal to result, ?cfg=
round trip, loop mode, landing hero embed, customizer boot, dock boot,
zero page errors.

## Deploy

1. aquilo-site: commit public/powerdeck/* + dock/loadout panel +
   products.ts + support/products.json, push master (Pages auto).
2. Worker: `npx wrangler deploy` in Loadout/discord-bot (clean worktree
   if parallel sessions are dirty).
3. Loadout repo: spec + builder + bundle artifacts via _commit_mine.py.

## v1.1 (shipped same day)

- **Realistic booster wrapper**: crimped heat-seal strips, vertical foil
  banding, side-curvature shading, embossed brand, specular sweep, and
  the game's Steam library portrait on the pack face (public Steam CDN
  by app id, emoji emblem fallback for non-Steam games). Built-ins
  carry `steam` ids; workshop packs accept a validated numeric `steam`
  field (never a URL) and the gallery shows capsule art.
- **Physics-based opening**: tension shake, the foil top tears off as a
  tumbling rigid body (gravity + spin + drag), metallic scraps flutter
  down, the spent wrapper drops away, and cards eject from the pack on
  springs with overshoot before their 3D flip.
- **Golden packs**: `pack.goldenChance` (default 5%) upgrades a
  purchase to a gold-foil wrapper with boosted weights and a guaranteed
  epic+. Demo loop and customizer have golden test fires.
- **Pity meter pill** on the overlay when the epic+ guarantee is within
  3 packs; `!packs` reply now includes pull odds percentages.
- Countdown rings pulse in the final 10 seconds; timed-card audit
  (every `timed` is a real duration).

## v1.2 (collection economy, same day)

- **Crafting**: `!craft <card>` melts N copies (default 3, configurable)
  of one card into a random card of the next rarity up from the same
  pack. Engine-local, no backend.
- **Gifting**: `!giftcard <viewer> <card>` transfers a card. Recipients
  resolve through an in-memory seen-in-chat map (plus inventory display
  names), so typos and never-seen names fail politely instead of
  stranding cards.
- **Welcome pack**: optional `chat.first` trigger (off by default)
  grants a free pack on a viewer's first-ever message, once ever.
- **`!toppulls`**: stream leaderboard of legendary/epic pulls from
  history.
- Landing hero bakes a multi-pack config and the demo loop rotates
  through enabled packs, showing off the Steam art wrappers.
- `prefers-reduced-motion` now forces calm fx automatically.
- Customizer grafts newly added default triggers into saved configs
  (arrays replace on merge, so old saves would otherwise never see
  new trigger types).

## v1.3 (the physical update)

- **Cellophane rip**: the pack now wears a transparent plastic skin
  (light streaks, wrinkle creases, a loose pull tab). Ripping tears it
  into 3 irregular shreds that flutter and ball up as they fall
  (flutter + crumple physics), with plastic crinkle SFX during the
  grip and tear. The foil top tears along a randomized jagged line and
  the body keeps the complementary bite marks.
- **TCG card faces**: cards are layered like physical cards: rarity
  metal frame with bevels, name plate with emoji badge, framed art
  window with glass highlight, type line with a rarity gem, text box,
  and footer (timer / brand). Print grain over everything.
- **Real game art**: the art window shows the game's artwork: Steam
  header for Steam games, plus verified stable URLs for Fortnite
  (fortnite-api), Minecraft (minecraft.net key art), VALORANT
  (valorant-api map splash) and League (Data Dragon splash). Emblems
  remain the graceful fallback (Steam's CDN blocks scripted UAs, so
  art always preloads through Image() before swapping in).
- **Workshop card art picker**: every card row has an art button
  opening a picker with three sources: Giphy search (via the existing
  worker proxy), 7TV + BTTV global emotes, or an uploaded photo
  (cover-cropped to 128px webp and inlined into the pack as a data
  URL, no hosting). Worker validates art against a strict CDN host
  allowlist or a 20KB inline cap; pack size limit raised to 560KB.

## Out of scope for v1 (roadmap)

- Cloud inventory sync + viewer-facing "my cards" page.
- EventSub-direct mode (PunchCard-style channel claim) for SB-free use.
- Twitch Extension panel storefront.
- Pack cover art uploads (procedural art only in v1).
- Bolts integration (earn packs with Loadout's Bolts wallet).
