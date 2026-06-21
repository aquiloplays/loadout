# DEADLINE, zombie siege survival for TikTok LIVE

> Status: **DESIGN, v1 scope proposed.** Working title DEADLINE
> (the defended line in-game is literally "the dead line";
> alternates if Clay vetoes: HoldOut, Last Stand).
>
> Author: Loadout team · Date: 2026-06-10 · Owner: Clay
>
> Surface: OBS browser-source overlay at
> `widget.aquilo.gg/overlays/deadline/`, powered by TikFinity
> (likes, gifts, follows, shares, TikTok chat) and Streamer.bot
> (cross-platform chat, dock bus). Landing + customizer at
> `aquilo.gg/deadline/` on the aquilo-site repo (v1.1).

---

## 1. Pitch

A 2D pixel-art zombie siege runs as a strip across the bottom of the
stream. The horde shambles in from the left. The viewers ARE the
firing line: every 100 likes a viewer sends fires one shot from THEIR
gun. Kills pay points. Between rounds a 30-second shop opens and chat
buys upgrades with commands (`!sniper`, `!shotgun`, `!barricade`,
`!beartrap`). TikTok gifts call in the heavy stuff: explosions,
airstrikes, NPC mercenaries and engineers. If the horde crosses the
dead line and the base falls, the run ends on a stats card and a new
siege begins.

The streamer never touches a controller. Their job is commander:
narrate the field, beg for taps when the line is thin, read the shop,
shout out the General who dropped the nuke.

## 2. Design pillars

- **Every mechanic is a call to action.** Likes are ammo. Comments
  are repairs and purchases. Gifts are airstrikes. Shares are a
  rally buff. Follows enlist a new soldier. There is no passive
  system; everything on screen exists so the streamer can ask for
  something and the audience can answer in one tap.
- **Personal stake.** Each viewer has their own gun, their own
  ammo accumulator, their own points and kill count. Your purchases
  are visible on your soldier sprite. The leaderboard is yours to
  climb. Communal defenses exist, but the core loop is "MY rifle,
  MY kills."
- **Difficulty scales to crowd size, never to gear.** The Director
  (section 8) budgets the horde from measured like throughput at
  pistol-baseline efficiency. Ten viewers or ten thousand, round 1
  feels winnable and round 20 feels desperate. Weapon upgrades are
  never cancelled out by scaling, so buying a sniper always feels
  like real progress.
- **Readable in one glance, on a phone.** Portrait-first. Silhouette
  rule for zombie types, big shop cards, short numbers. A viewer
  scrolling past must understand "zombies vs us, tap to shoot"
  within two seconds, that is the hook that stops the scroll.
- **Custom pixel art only.** Same rule as Boltbound and the casino:
  no emoji glyphs anywhere in game records or render. Sprites via
  the existing Replicate pixel pipeline.

## 3. The stage

Side-scroller framing, The Last Stand by way of Mario: one ground
line, every actor stands on it, and the stream itself is the sky.
The overlay is a guest on the screen; default cover budget is ~20%
of the canvas, and most of that is transparent air between sprites.

```
 PORTRAIT 1080x1920                  the lane strip, zoomed
+----------------------------+   +----------------------------------+
|                            |   | R7 [==HP==] 3.2k kills      0:22 |  chip row 28px
|                            |   |                                  |
|   stream shows through,    |   |  zz   zz ->   ||  :  @  @  [+38] |  transparent air
|   nothing rendered here    |   | ~~~~~~~~ street ribbon ~~~~~~~~~ |  ground 36px
+----------------------------+   +----------------------------------+
| chip row + ticker          |
| LANE strip (~18%),         |     zz = zombies    || = barricade
| transparent except sprites |     :  = dead line   @ = soldiers
+----------------------------+
```

- **No opaque game panel.** The lane is a transparent strip: sprites
  plus a thin tiled street ribbon (~36px at 1080 wide) that
  everything stands on. Above the ground line nothing renders but
  actors and effects, so the stream stays visible behind the fight.
- Default lane height 18% of canvas pinned to the bottom edge (22%
  in landscape). `laneH=` overrides, `laneY=` floats the strip
  higher for streamers whose cam sits low.
- HUD is one 28px chip row docked to the lane's top edge: round,
  base HP, kills, shop countdown. It dims to 40% opacity when
  nothing is changing. The kill ticker is a single line over the
  street. The shop is a horizontal 5-card strip that slides up only
  during SHOP and leaves with the bell.
- Mood layer optional: a low city-skyline silhouette behind the
  lane at 20% opacity (`bg=off|skyline|street`, default skyline).
  Day tint shifts toward night as rounds climb; Blood Moon tints
  red.
- Between rounds the squad advances one block: a 2s parallax scroll
  (street furniture fast, skyline slow), so a long stream reads as
  a journey through the city without changing the combat space.
- Soldiers: the top 8 most recently active shooters render as
  soldier sprites in the trench, circle-cropped TikTok avatar for a
  head, username below, current weapon in hand (gear flex is a
  retention mechanic). Everyone else is pooled into a "militia"
  cluster sprite with a live count badge; pooled shots still fire
  and still attribute kills.
- Each rendered soldier shows a thin reload ring that fills as their
  like accumulator approaches the next shot, so "how close am I" is
  always answerable.
- Sprites are authored at native pixel sizes (a walker is 40px
  tall) and drawn at integer scale (`scale=2|3`, default 3
  portrait, 2 landscape) with smoothing off, so the art stays
  crisp while the strip stays small.

## 4. Input map

| Source (TikFinity / SB) | Event | Game meaning |
|---|---|---|
| Like | `like` (likeCount delta per user) | Ammo. Every `likesPerShot` (default 100) likes from one user fires one shot from that user's weapon. Remainder banks. |
| Chat command | `chat` | Shop purchases during SHOP phase, `!repair` anytime, info commands (`!points`, `!gun`). |
| Gift | `gift` (diamondCount × repeat) | Fire support by coin tier (section 11). Gifter also earns 1 point per coin. |
| Follow | `follow` | Enlist: banner, +50 points, instant 3-shot welcome volley. |
| Share | `share` | RALLY: +30 points to sharer, everyone's likes-per-shot ×0.87 for 30s (refreshes, never stacks). |
| Subscribe | `subscribe` | Permanent (per stream) 10% like efficiency, sub badge on soldier, +200 points. |

Per-user accumulators are keyed by TikTok `uniqueId`. 137 likes is
one shot plus 37 banked, nothing is wasted, and the counter survives
OBS refresh (section 15, persistence).

## 5. Firing model

1. Like events arrive batched (TikFinity sends per-user increments).
   Add to that user's bank.
2. `bank >= likesPerShot(user)` fires immediately: tracer from their
   soldier (or the militia cluster) to the target, muzzle flash,
   shell casing. Multiple owed shots fire as a 150ms burst queue so
   a 500-like dump looks like a satisfying volley, not one frame of
   spreadsheet math.
3. Targeting is per-weapon (table below): pistols/SMGs pick the
   nearest threat, snipers pick the biggest, RPGs pick the densest
   cluster. No player aiming, the skill expression is economy
   (what you buy) and timing (when you dump likes).
4. Kill attribution: every projectile carries `ownerId`. Killer
   takes the kill points. Elites and bosses also pay per-hit so
   sniper kill-steals don't zero out the chip-damage crowd.

## 6. Arsenal

Weapons are personal, permanent for the run, and replace your current
gun on purchase. Prices in points. `likes/shot` is the upgrade axis
the prompt asked for: better guns convert the same tapping into more
output.

| Weapon | Cmd | likes/shot | Damage | Behavior | Price |
|---|---|---|---|---|---|
| Pistol | (default) | 100 | 10 | Nearest zombie | free |
| SMG | `!smg` | 60 | 7 | Nearest, fast tracer | 300 |
| Shotgun | `!shotgun` | 100 | 6 ×6 pellets | Cone, shreds packs up close | 400 |
| Sniper | `!sniper` | 200 | 80 | Highest-HP target, pierces 3 | 600 |
| Flamethrower | `!flamer` | 80 | 6 + ignite 12/4s | Hits front 3, short range | 800 |
| Minigun | `!minigun` | 30 | 5 | Nearest, constant stream | 1200 |
| RPG | `!rpg` | 250 | 60 AoE (r120) | Densest cluster | 1500 |

Effective damage per 100 likes: pistol 10, SMG 11.7, shotgun ~15
(avg pellets landed), sniper up to 40 (pierce, no overkill on
brutes), flamer 22.5, minigun 16.7, RPG 24 plus splash. Each tier is
a real bump plus a niche, not a strict ladder.

**Ammo mods** (consumable, apply to your next 15 shots, stack with
any weapon):

| Mod | Cmd | Effect | Price |
|---|---|---|---|
| Silver rounds | `!silver` | +50% damage, ×2 vs elites/boss | 100 |
| AP rounds | `!ap` | Ignore armor, pierce +1 | 150 |
| Incendiary | `!fire` | Ignite 8 dmg over 3s | 150 |
| Explosive tips | `!boom` | 40% damage splash, r60 | 250 |

## 7. The horde

Silhouette-distinct, colorblind-safe accents. HP listed at baseline;
the Director never inflates per-zombie HP except via the density cap
(section 8).

| Zombie | HP | Lane crossing | Points | Gimmick |
|---|---|---|---|---|
| Walker | 10 | 28s | 10 | The meat. 1 pistol shot. |
| Runner | 8 | 14s | 15 | Sprints, jumps bear traps 50% of the time |
| Crawler | 16 | 35s | 20 | Low profile, takes half explosion damage |
| Spitter | 25 | stops at 60% | 40 | Lobs goo: 12 structure dmg / 3s at range |
| Armored | 40 | 30s | 50 | Flat -8 damage reduction (min 1); AP/sniper ignore |
| Exploder | 20 | 20s | 30 | Death blast: 50 structure dmg r80. Kill it FAR away |
| Brute (elite) | 250 | 45s | 5/hit + 100 kill | Smashes barricades at 25/s, shrugs traps |
| Abomination (boss) | Director-set (min 800) | 60s | 5/hit + 500 kill | Every 5th round. Enrages at 25% HP |

- Composition unlocks by round bracket: 1-4 walkers/runners only,
  5-9 add crawler + exploder + first brute, 10-14 add spitter +
  armored, 15+ everything plus multi-brute waves.
- **Named waves** every 5th round get a title card and a modifier:
  round 5 "FIRST BLOOD" (boss debut), 10 "BLOOD MOON" (boss +
  all-runner spawns, red tint), 15 "THE CRAWL" (crawlers + fog),
  20 "SIEGE ENGINES" (3 brutes), then the cycle repeats harder.

## 8. Rounds and the Director

State machine: `ROUND -> SHOP -> ROUND ... -> GAMEOVER -> ROUND 1`.

- **ROUND**: 75s spawn window, then up to 20s clear-out grace (ends
  early when the field is empty). Survivors banner, +25 round survival
  points to every viewer who fired or repaired that round.
- **SHOP**: 30s, sim paused, field dimmed, shop cards up (section 9).
  10s/5s countdown stingers so the streamer can hype it.
- Full cycle ~2 minutes, tuned for TikTok watch-time rhythms.

**The Director** (adaptive difficulty, the load-bearing system):

- Track likes/sec as an EWMA over 90s, `L`.
- Baseline crowd DPS assumes pistols only:
  `baseDPS = (L / likesPerShot) * 10`.
- Round N spawn budget in HP/sec:
  `budget = baseDPS * 0.65 * 1.07^(N-1)`, capped at `baseDPS * 2.6`.
- Floor: at least 1 walker per 6s so a quiet stream still has a
  game, and demo mode works with zero viewers.
- Boss HP = 45s of `baseDPS`, min 800.
- **Gear-blind on purpose**: the budget formula uses pistol baseline,
  never the actual weapon mix. Crowd growth raises pressure; gear
  raises headroom. With a geared crowd (~2.5× pistol efficiency) the
  math breaks even around round 18-20, which is the intended wall
  for a 2-3 hour stream. Gifts and NPCs push past it.
- Density cap: max 150 live zombies. Overflow budget converts to a
  "thickened horde" HP buff on new spawns (icon on the round chip)
  so render cost and readability stay bounded.
- Mercy rule: after a wipe, the first 3 rounds of the new run get a
  0.8× budget so the restart doesn't instantly re-wipe.

## 9. Economy and shop

**Earning** (points are per-viewer, the only currency):

| Action | Points |
|---|---|
| Kill (normal) | zombie's point value, to killer |
| Hit on elite/boss | 5 per landed shot |
| Elite/boss kill bonus | 100 / 500 |
| Round survived (was active) | 25 |
| Effective `!repair` tick | 2 |
| Follow / share / sub | 50 / 30 / 200 |
| TikTok gift | 1 per coin |

**The shop** stocks a random 5 of the full catalog each intermission
(weighted: always at least 1 weapon, 1 defense, 1 ammo mod). Scarcity
makes `!sniper` showing up an event, and keeps long sessions varied.
Out-of-stock commands get a polite toast and no charge.

- Syntax: bare command, first come first served. 1.5s per-user
  command cooldown. Buying a weapon you already own: toast, no
  charge. Insufficient points: small "need 240 more" ticker entry,
  never a modal.
- Weapons/ammo: unlimited stock. Defenses: shared field caps
  (section 10), shop shows `2/3 slots` style counts.
- `!points` and `!gun` answer in the overlay ticker anytime (rate
  limited) so viewers can check their wallet without spamming.

## 10. Defenses and repair

Defenses are communal, deploy instantly at smart anchor points, and
persist until destroyed (no decay). Field caps prevent turtling.

| Defense | Cmd | Effect | HP | Cap | Price |
|---|---|---|---|---|---|
| Barricade segment | `!barricade` | Wall at the 70% mark, zombies stop and chew (10 dmg/s each) | 300 | 3 stacked | 150 |
| Bear trap | `!beartrap` | Roots 3s + 30 dmg, single use | n/a | 6 | 75 |
| Barbed wire | `!wire` | 25% slow strip, 45s lifetime | n/a | 2 | 100 |
| Landmine | `!mine` | 80 dmg AoE r80, single use | n/a | 4 | 125 |
| Sentry gun | `!sentry` | Auto-shot every 2s, 8 dmg, 90s lifetime | 60 | 2 | 500 |
| Sandbag kit | `!sandbags` | Instantly +150 base HP (to cap) | n/a | n/a | 200 |

**Repair, the comment engine.** `!repair` is free, works any time:

- Each valid tick heals the most-damaged structure +4 HP (base wall
  if no structures are damaged), pays the repairer 2 points, 2s
  per-user cooldown.
- No-op when nothing is damaged (silently, no spam reward).
- A cracked barricade with the horde chewing on it generates a wall
  of `!repair` spam in chat, which is exactly the point: comments
  are a TikTok ranking signal, and the game manufactures comment
  storms on demand.
- The Engineer NPC (gift tier, section 11) auto-repairs 6 HP/s for
  3 minutes, "normally you have to type !repair a lot, the Engineer
  does it for you" is the upsell line.

## 11. TikTok gifts, fire support

Mapped by coin value tier so the entire gift catalog works without
per-gift maintenance, reusing `_shared/tiktok-gifts.js` for naming
and a `giftName -> effect` override map for signature moments
(e.g. force Rose to always be the Pipe Bomb regardless of tier).
Gift streaks resolve on `repeatEnd` with the final count (same
handling the gift-jar overlay ships).

| Coins | Effect |
|---|---|
| 1-4 | **Pipe Bomb**: 30 dmg AoE at the horde front |
| 5-29 | **Molotov**: fire patch, 10 dmg/s for 5s |
| 30-99 | **Grenade Volley**: 3 × 40 AoE across the pack |
| 100-499 | **Mortar Barrage**: 6 shells walk the lane, 60 each |
| 500-999 | **ENGINEER NPC**: 3 min, auto-repair 6 HP/s, builds 1 free barricade if none stand |
| 1000-4999 | **MERC SQUAD**: napalm run on entry (80 dmg full lane), then 2 NPC gunners auto-fire for 3 min |
| 5000+ | **TACTICAL NUKE**: clears the field (bosses take 1000), full base + structure repair, +100 points to every active viewer, gifter is crowned **General** (badge + their avatar on the base flag until stream end) |

- Every gift also pays the gifter 1 point per coin, so a Galaxy is
  both an airstrike and a shopping spree. Gifts are the revenue
  line; they should always feel like the best button on screen.
- NPC characters render as named soldier sprites (gifter's avatar +
  "Engineer" / "Gunner" role tag) in the trench, so the gifter sees
  themselves working on the wall.
- All gift effects queue; nukes interrupt. Nothing is lost when two
  gifts land in the same second.

## 12. Failure and meta

- **Base wall**: 1000 HP behind the dead line. Zombies that cross
  chew it (and survivors duck per hit, edge-of-screen red pulse at
  <30%, klaxon at <15%, streamer CTA moment by design).
- **Game over** at 0 HP: 8s breach cinematic (horde floods, screen
  tears to static), then a 45s stats card: rounds survived, total
  kills, MVP, top gifter, biggest single save, all-time best round.
  Auto-restart at round 1.
- **What persists through a wipe** (same stream): viewer weapons,
  ammo mods, and points (they are personal property). Lost: all
  structures, base damage, round number. The sting is communal,
  the progress is personal, so regulars never feel robbed.
- **What persists across streams**: all-time leaderboard (kills,
  best round, generals) in localStorage; run state itself resets
  per stream (`?fresh=1` forces it). Cross-stream wallets are a v2
  question (section 18).
- Milestones at rounds 10/20/30: confetti, base flag upgrades,
  all-time banner if beaten.

## 13. Streamer controls

- **Mod/broadcaster chat commands**: `!zpause`, `!zresume`,
  `!zreset` (new run), `!zboss` (force boss round next),
  `!zshop` (open shop early), `!zintensity 80` (Director % nudge),
  `!zgift <tier>` (rehearse a gift effect).
- **URL params**: `likes` (per shot, default 100), `laneH` (default
  18), `laneY`, `bg=off|skyline|street`, `scale=2|3`, `hud=min|full`,
  `theme`, `audio=0|1`, `volume`, `fps=60|30`, `maxz`, `demo=1`,
  `demoRate=slow|normal|fast`, `fresh=1`, `sb=host:port`,
  `tf=host:port`.
- **Demo mode** (`?demo=1`): synthesizes fake users, likes, chat
  purchases and gifts at a chosen pace. Used for OBS setup, the
  landing-page live demo iframe (same pattern as the SF customizer
  and `?demo=1` bridge mode on /overlays/), and selftests.
- **Dock** (v1.1): OBS custom dock page with pause/skip/reset/boss/
  intensity buttons riding the existing dock-bus pattern (SB custom
  event broadcast, BroadcastChannel fallback for same-origin
  sources).
- **Audio**: off by default. Pooled gunshots with pitch jitter,
  groans, boss siren, shop bell, nuke. All behind `?audio=1`.

## 14. Retention design notes (why each piece exists)

- Likes->ammo turns passive watching into combat participation with
  zero literacy required, and the reload ring gives every tap a
  visible consequence.
- The 30s shop is an appointment mechanic: leaving mid-round means
  missing the sniper restock.
- `!repair` storms manufacture comment velocity (algorithm food)
  during the exact moments the stream is most dramatic.
- Gift tiers ladder from 1 coin to 5000+ with a visible spectacle
  gap between tiers, and the General crown is status that lasts the
  whole stream.
- Personal weapons + leaderboard give regulars a reason to return
  the next stream even if wallets reset: gun knowledge and bragging
  rights carry.
- The Director guarantees the game is dramatic at any audience size,
  which protects small streamers (the overlay's actual customers).

## 15. Tech architecture

- **Form**: static overlay, `index.html` + `main.js` + `engine.js` +
  sprite atlases, no build step, same as every aquilo overlay.
  Game entities on a single `<canvas>` (fixed-timestep 60Hz sim,
  decoupled render, sprite/projectile/particle pools). HUD, shop
  cards, ticker and banners in DOM on top.
- **Connections**:
  - TikFinity `ws://localhost:21213/` (the in-repo standard, see
    follow-* overlays and gift-jar): `like`, `gift`, `follow`,
    `share`, `subscribe`, `chat` events with `uniqueId`, `nickname`,
    `profilePictureUrl`, `likeCount`, `giftName`, `diamondCount`,
    `repeatCount`, `repeatEnd`. 5s reconnect backoff, status pip.
  - Streamer.bot `ws://127.0.0.1:8080/` optional (sf-direct.js
    handshake pattern): cross-platform chat commands for Twitch/YT
    simulcasts, dock bus, future bits mapping.
  - Matrix: TikFinity only = full game (TikTok chat covers
    commands). TF + SB = multi-platform shoppers. SB only = no
    likes, overlay shows a "connect TikFinity" banner and runs
    Director floor only.
- **Persistence**: snapshot to localStorage every 5s
  (`dl:run`, `dl:users`, `dl:alltime`), resume on OBS refresh
  mid-round. Avatars circle-cropped to 32px offscreen canvases,
  LRU-capped at 300.
- **Hygiene**: sanitize all user-supplied strings (nickname, gift
  names) before DOM insertion, same XSS posture as the SF overlay
  pass. No remote calls except avatar images. Like/gift dedupe via
  per-event ids where TikFinity provides them.
- **Perf budget**: 150 zombies, 80 live projectiles, 200 particles,
  <2.5MB total assets, 60fps in OBS CEF on a mid PC, `fps=30`
  fallback param.
- **Art**: generated sprite sheets with animation frames baked into
  every texture and true transparent backgrounds, section 16.
- **Deploy** (memory gotcha, do not skip): build in
  `Loadout/aquilo-gg/overlays/deadline/` (dev mirror), copy into
  sibling `aquilo-widget/overlays/deadline/` and push THAT repo,
  or OBS sees 404. Landing/customizer/tools-card on aquilo-site.
- **Selftest**: `tools/dl-selftest.mjs` headless run: feed a
  scripted event tape (likes/gifts/chat), assert shots fired,
  kills attributed, shop transactions, director budget bounds,
  snapshot/restore round-trip. Same posture as pd/pc/sd selftests.

## 16. Art and animation pipeline (Replicate)

> Status 2026-06-11: **RUN AND STAGED.** 61 generations (~$2.44)
> through probe -> bulk -> 2 reroll rounds; all 47 assets QA'd on
> the contact sheet (`_deadline_art/contact-sheet.png`) and
> installed to `aquilo-gg/overlays/deadline/art/` (47 strips +
> atlas.json, 496 KB). Known soft spots, fine to ship: muzzle-flash
> is weak (engine may draw a procedural flash instead), sentry
> frames are uneven (v1.1 content), abomination-death keeps a small
> pink pool that reads as blood.

Style lock: **16-bit pixel art game assets**, chunky single-pixel
outlines, limited palettes, readable silhouettes. Video-game
quality on purpose, never photoreal (same call the Gift Jar art
pass landed on: stylized beats realistic for overlay legibility).
Animations are baked into the generated textures as sprite-sheet
frames, and every sprite ships with a true alpha channel.

**Generator**: `tools/deadline-art-gen.py`, same Replicate REST
pattern as `tools/gift-jar-art-gen.py` (flux-1.1-pro via the
models endpoint, REPLICATE_API_TOKEN from the user env).

1. **Generate**: one prediction per animation, prompted as a
   single horizontal sprite-sheet row ("exactly 4 animation frames
   of the same character, side view, clear gaps between frames,
   solid magenta background, no text, no labels, no grid").
   Zombies face right, defenders face left. Aspect ratio is picked
   from the frame count.
2. **Key out**: chroma removal flood-filled from the image border
   (corner-sampled background color + distance tolerance), then
   hard alpha (0 or 255). Pixel edges survive chroma keying;
   photo segmentation models chew them, so rembg is only a
   `--rembg` per-asset fallback here. Full-bleed tiles (street
   ribbon, skyline) skip keying entirely (house rule: never
   background-remove full-bleed tiles).
3. **Slice**: split the row on fully-transparent column gaps, fall
   back to an even grid when detection disagrees with the
   requested frame count. Each frame is content-cropped and
   re-anchored bottom-center so feet stay planted across the
   cycle (effects anchor center).
4. **Pixel-snap**: nearest-neighbor downscale to the asset's
   native height (walker 40px, brute 64, boss 96, soldier 44,
   explosion 64), one shared adaptive palette per animation
   across all frames (kills frame-to-frame color flicker), alpha
   hardened at 128.
5. **Pack**: one horizontal strip PNG per animation plus
   `art/atlas.json`: frames, cell size, fps, loop, anchor. The
   engine plays strips with `imageSmoothingEnabled = false` at
   integer scale and layers procedural juice on top (hit flash,
   walk bob, screen shake, death fade), so baked frames stay few
   and cheap.
6. **Gate**: `probe` renders 4 test sheets and a contact sheet;
   contact-sheet GO before the bulk run (house pattern). Bulk is
   ~47 predictions, ≈ $2-4 with rerolls at flux-1.1-pro pricing.
   Working dir `_deadline_art/` is gitignored; `install` copies
   approved strips into `aquilo-gg/overlays/deadline/art/`.

**Asset manifest** (one generation per animation):

| Group | Assets | Anims (frames) |
|---|---|---|
| Zombies (8) | walker, runner, crawler, spitter, armored, exploder, brute, abomination | walk 4 · attack 3 · death 5 |
| Defenders | soldier, engineer, merc gunner | idle 2 · fire 2 · work 4 |
| Weapons | 7 guns in one row | static |
| Effects | explosion S/L, fire patch, muzzle flash, blood puff, trap snap, goo, nuke ring | 2-6 each |
| Structures | barricade (3 damage states), sentry, wire, mine, sandbags, base wall, flag | 1-4 each |
| Backdrop | street tile, skyline silhouette, midground ruins | full-bleed, no keying |

Timing reference: walk 8 fps loop, attack 6 fps loop, death 10 fps
one-shot, explosions 14 fps one-shot, flag 6 fps loop. Damage
states (barricade) and weapon swaps are frame-select, not time
animation.

## 17. Tunables (ship as `config.js`, all overridable)

```json
{
  "likesPerShot": 100,
  "subEfficiency": 0.90,
  "rallyMultiplier": 0.87,
  "rallyDurationS": 30,
  "roundSpawnS": 75,
  "clearGraceS": 20,
  "shopS": 30,
  "shopStock": 5,
  "laneHeightPct": 18,
  "spriteScale": 3,
  "bg": { "layer": "skyline", "opacity": 0.2 },
  "hudIdleFade": 0.4,
  "director": {
    "ewmaWindowS": 90,
    "basePressure": 0.65,
    "roundGrowth": 1.07,
    "pressureCap": 2.6,
    "floorWalkerEveryS": 6,
    "bossDpsSeconds": 45,
    "bossMinHP": 800,
    "mercyRounds": 3,
    "mercyFactor": 0.8,
    "maxZombies": 150
  },
  "base": { "hp": 1000, "sandbagHeal": 150 },
  "repair": { "hp": 4, "cooldownS": 2, "points": 2 },
  "roundSurvivalPoints": 25,
  "social": { "follow": 50, "share": 30, "subscribe": 200 },
  "giftPointsPerCoin": 1,
  "giftTiers": [
    { "min": 1, "effect": "pipebomb" },
    { "min": 5, "effect": "molotov" },
    { "min": 30, "effect": "grenades" },
    { "min": 100, "effect": "mortar" },
    { "min": 500, "effect": "engineer" },
    { "min": 1000, "effect": "mercsquad" },
    { "min": 5000, "effect": "nuke" }
  ],
  "giftOverrides": { "rose": "pipebomb" },
  "commandCooldownS": 1.5
}
```

## 18. Build plan

**v1 cutline** (playable product, one overlay URL):

- Compact transparent lane strip, base, dead line, portrait +
  landscape layouts
- Sprite probe -> contact-sheet GO -> bulk art run
  (`tools/deadline-art-gen.py`)
- Pistol + SMG + Shotgun + Sniper; Silver + AP ammo
- Barricade + bear trap + sandbags + `!repair`
- Walker, runner, armored, exploder + Brute on round 5s
- Director, round/shop state machine, random stock
- Gift tiers (all 7), follow/share, soldier avatars + militia pool
- localStorage resume, demo mode, selftest, deploy to widget repo

**v1.1**: customizer + landing on aquilo.gg/deadline/ (+ /tools
card, support-hub entry), OBS dock, flamethrower/minigun/RPG,
incendiary/explosive ammo, wire/mine/sentry, spitter/crawler,
Abomination boss art pass, named waves, subscriber perks, audio.

**v2 candidates**: premium themes behind the $5 Patreon tier
(winter siege, mall, cabin), Twitch bits->shots mapping via SB for
simulcasters, cross-stream persistent wallets, seasonal leaderboard
on the site, co-op events (two streamers, shared horde).

## 19. Open questions for Clay

1. Name: DEADLINE lock, or HoldOut / Last Stand?
2. Wallets across streams: reset per stream (proposed) or persist?
3. Gift points at 1/coin makes a Galaxy = instant sniper + change.
   Feels right for revenue; bump to 2/coin or leave?
4. Compact strip is 18% lane + 28px chip row: clear of your cam?
5. Sound default off in OBS (proposed), or on at low volume?
