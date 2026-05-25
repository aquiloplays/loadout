# Clash Expansion — Resource Economy, Goblin Raids, Animated Town

> Status: **design draft — awaiting Clay sign-off.** Multi-phase, like
> the original. Phases are shipping units; do not start phase N+1 until
> N is in viewers' hands.
>
> Author: Loadout team · Date: 2026-05-21 · Owner: Clay
>
> Companion to [`CLASH-FEATURE-DESIGN.md`](./CLASH-FEATURE-DESIGN.md).
> Everything that doc said still stands — Bolts is still the brand
> currency, towns are still communal, raids are still global, the
> hero is still the Champion. This is the **next major chapter**, not
> a rewrite.
>
> Verbatim ask (Clay, v3):
> *"Major Clash expansion. Random NPC goblin raids on towns through
> the day, with damaged buildings that need repair and a raid outcome
> determined by the defenses we've built. Town buildings should cost
> resources, not just bolts — add a resource system, players gain
> resources by initiating tasks that take real time to complete. A
> lot more defenses, building types, traps, and troops. Drag-and-drop
> layout editing with walls that snap together. Animated town —
> villagers walking around, buildings showing a construction
> animation while they're being built. Pixel-art Clash-of-Clans-style
> background. The current sprites render too small — size them up."*

---

## 1. Guiding principles for the expansion

The original Clash launch (Phases 1–4 of `CLASH-FEATURE-DESIGN.md`) put
the bones in place: communal towns, global raids, a deterministic
battle simulator, push notifications, three resources (Bolts/Scrap/
Cores), Discord + minimal web. It works, but it's spartan — a single
build button per TH, no idle hum, sprites the size of a postage stamp.

This expansion fills it out into something that **feels like a living
town between raids**, not just a button to upgrade between dungeon
runs. The principles that drove the original still apply, plus these:

- **Idle progress is the point.** Most viewers will check Clash 1–3
  times a day. The town needs to *do something* when they're not
  looking — produce resources, get raided by goblins, take damage,
  show repair states. The moment of "open the app and see what
  happened" is the loop we're optimizing for. This is the part the
  original v1 lacked.
- **Defense is no longer purely a PvP gate.** Goblin raids mean every
  town gets attacked even if no one's wars are active. So **walls
  and towers matter on day one**, not just at the tier where PvP
  opens up (hero L8). This pulls the defense fantasy forward to
  newer players.
- **Resources before bolts.** Town construction now demands gathered
  materials (Wood / Stone / Iron / Gold). Bolts stays as the
  premium / cooldown-skip / communal-pool currency, but it stops
  being the *only* axis. Multiple resources also let us calibrate
  difficulty per resource: cheap walls (lots of wood), expensive
  Mage Towers (cores + iron + gold).
- **Animation sells the world.** Static embeds in Discord are fine
  for raids. The web and Twitch panel surfaces need to look alive —
  villagers wandering, scaffolding on builds, smoke on damaged
  buildings, clouds drifting in the background. The pixel-art
  fidelity becomes a recruitment tool ("look what's running in
  Clay's stream panel").
- **Layout edits become spatial, not textual.** Drag, drop, snap.
  Walls auto-connect like a proper tile-based game. This was always
  the Phase 4 endgame in the original doc — this expansion fully
  scopes it.
- **Bigger sprites.** Current 32 px buildings + 24 px troops were
  fine when the surface was a Discord embed at 200 px wide. The web
  and Twitch panel surfaces want 96 px+ — *3× the linear scale*. We
  rebuild the sprite pipeline once, not piecemeal.
- **Discord stays text-first.** All of the visual richness lives on
  web + Twitch panel. Discord embeds keep the simple text-tables UX
  they already have — emojis, lines, cooldown displays. We don't
  spend effort cramming animation into Discord.

---

## 2. The new shape — what changes vs. v1

| Area | Today (Phase 1–4) | After expansion |
| --- | --- | --- |
| Resources | Bolts, Scrap, Cores | + Wood, Stone, Iron, Gold |
| Building cost | Pure bolts (treasury) | Tiered mix: low-TH wood/stone, mid-TH +iron, high-TH +gold + cores. Bolts only for cooldown skips + premium. |
| Resource sources | Daily payout + raid loot | + **Gather tasks** (timed jobs) + **Collector buildings** (idle stream) + raid loot |
| Random attacks | None — town only attacked when a real player raids | **Goblin raids** 1–4×/day, automatic, scaled to TH |
| Building states | `idle / building / damaged` (field existed but unused) | All three live; **damaged** persists across raids until repaired |
| Repair | not a thing | New action: `/clash repair <buildingId>` — costs resources + real-time |
| Content | 8 buildings, 6 personal troops, 4 garrison troops, 1 trap kind | **~24 buildings, ~12 troops, ~7 trap kinds, ~8 defense kinds** (see §6) |
| Layout edit | Text-based positions only | **Drag-and-drop on web**, walls snap together, footprint-aware collisions |
| Web /play/clash | Stubs only — read endpoints; no UI | **Animated isometric town view** with editor mode |
| Twitch panel | Same — placeholder routes ready | **Animated read-only town view + raid feed + leaderboards** |
| Sprite size | 32 px building / 24 px troop | **96 px building / 64 px troop** (3× + 2.7×). Multi-cell footprints. |
| Background | None — flat tile floor | **Pixel-art scene** (parallax sky, mountains, forest, animated clouds) |

The shape of state, the simulator, and the surfaces stay the same —
this is a *fattening*, not a replacement.

---

## 3. Resource model — the new economy

### 3.1 Four new gathered resources

| Resource | Tier | Where it's spent | Gather feel |
| --- | --- | --- | --- |
| **Wood** | early | walls, low-TH buildings, troop training (common) | fast, abundant — 5 min jobs |
| **Stone** | early–mid | defensive towers, mid-TH buildings, walls L4+ | medium — 30 min jobs |
| **Iron** | mid–late | mage tower, mortar, mid-TH troops, traps | slow — 2 h jobs |
| **Gold** | late | high-TH buildings, endgame troops, war tribute boost | rare — 4–12 h jobs |

Plus the three existing resources are unchanged in role:

| Resource | Role |
| --- | --- |
| **Bolts** | Brand currency. Cooldown skips, personal troop training, premium top-up. Town donations *still* allowed but no longer required for builds. |
| **Scrap** | Raid loot. Still drops from PvE + PvP. Now also used as a secondary cost for some upgrades. |
| **Cores** | Endgame catalyst. Still rare, still drops from 3★ wins. Now required for TH7+ Mage Tower + Voltaic Coil + endgame troops. |

That's 7 resources total. Looks like a lot — in practice each viewer
interacts with 1–2 at a time depending on what they're working
toward. The town treasury UI groups them by tier so the dashboard
doesn't feel like a spreadsheet.

### 3.2 Treasury schema

Extend `clash:treasury:<guildId>` (defined in `clash-state.js`) from

```js
{ bolts, scrap, cores, capacity }
```

to

```js
{
  bolts, scrap, cores,           // existing
  wood, stone, iron, gold,       // new
  capacity: {                    // per-resource caps
    bolts, scrap, cores,
    wood, stone, iron, gold
  }
}
```

The `capacity` field becomes an object indexed by resource. Storage
buildings (see §6) each lift one or more resource caps. Treasury
overflow silently drops gathered resources on the floor — same
behavior as bolts overflow today.

Backfill on read: any old `treasury` doc gets the new fields zeroed
and capacities seeded from the storage buildings the town already
has. Same backfill pattern as the Phase 3 `defenderChampion` field
in `ensureTown`.

### 3.3 Gather tasks — the new active loop

A **gather task** is a timed, real-time job a *viewer* starts that
deposits resources into the town treasury when it completes. Same
read-time cooldown walker as builds + training — no background tick.

```
/clash gather <resource> <tier>

  resource: wood | stone | iron | gold
  tier:     short | medium | long
```

| Tier | Wall-clock | Output (Wood) | Output (Stone) | Output (Iron) | Output (Gold) |
| --- | --- | --- | --- | --- | --- |
| short | 5 min | 80 wood | 30 stone | 8 iron | 2 gold |
| medium | 30 min | 600 wood | 250 stone | 70 iron | 18 gold |
| long | 2 h | 3,000 wood | 1,400 stone | 380 iron | 100 gold |
| overnight | 8 h | 14,000 wood | 6,500 stone | 1,700 iron | 480 gold |

Per-resource yield curves are deliberately *steeper* than linear with
time (1 long ≈ 2.4× per-minute yield of 1 short). This rewards
viewers who set up an overnight gather before bed — same shape as
the daily-payout streak curve.

**Concurrency caps** to prevent grinding:

- 1 active gather task per viewer at TH1
- +1 slot per **Workshop** the town has built (capped 4)
- Each task occupies a slot until it completes or is cancelled
- Cancelling forfeits the yield (no partial credit)

**Deposit**: yields land in the *town* treasury, not the viewer's
personal stash. This is deliberate — gathering is communal labor, the
same way donating bolts is. A viewer's *personal* benefit is
trophies (small grant on completion: 5/15/40/120 by tier) + a
contribution badge on the town leaderboard.

**Discoverability**: the streamer or mods set "active resource focus"
via `/clash town focus <resource>` — viewers see this as a banner
("we need iron"). Just a hint; no enforcement. Stored in
`clash:town:<guildId>.focus`.

KV:

- `clash:gather:<guildId>:<userId>` — `{ items: [{ id, resource, tier, endsAt, yield }] }`
- Walked on every clash-state read via a new `syncGatherTasks(env, town, userId)` helper.

### 3.4 Collector buildings — passive resource stream

Idle production happens at **Sawmill** (wood), **Quarry** (stone),
**Forge** (iron), **Mint** (gold). Each is a building kind viewers
can build in the town. They generate their resource into the
treasury at a fixed rate per minute.

| Building | L1 | L3 | L5 | Storage built-in |
| --- | --- | --- | --- | --- |
| Sawmill | 12 wood/min | 45 wood/min | 110 wood/min | 800 wood |
| Quarry | 5 stone/min | 18 stone/min | 50 stone/min | 400 stone |
| Forge | 1.2 iron/min | 5 iron/min | 14 iron/min | 100 iron |
| Mint | 0.3 gold/min | 1.4 gold/min | 4 gold/min | 60 gold |

Cap-per-building is a *built-in storage component* — the collector
holds its yield until total treasury capacity is hit OR until someone
"taps" the collector to flush its buffer into the main treasury. Same
pattern as Clash of Clans gold/elixir collectors.

Auto-flush every 4 hours so passively-played communities still get
their yield even without a tap. Manual flush via `/clash tap` or by
clicking the building on the web view.

Production is **not** stopped by being damaged — damaged collectors
just produce at 50% rate until repaired. So goblin raids that smash
a quarry hurt but don't brick.

KV:

- Collector state stored per-building inside `clash:town:<guildId>.buildings[].collector = { storedYield, lastTickUtc }`
- Read-time walker: `syncCollectors(town)` updates each collector's `storedYield = min(capacity, storedYield + rate × elapsed)`. Single pass on every clash-state read; cheap.

### 3.5 What still costs bolts

Bolts didn't go away. After expansion, bolts are required for:

- All **personal troop training** (Scrapper through Voltaic Mage) — unchanged.
- All **cooldown skips** — same 1 bolt/min, same 240-min/day cap.
- **Communal donations** — the original `/clash donate` is preserved; bolts in treasury still spent on rare unlocks (e.g., 25k bolts to unlock the Mage Tower research at TH7).
- **Trap re-arms** — traps detonate once, must be re-armed for 80–200 bolts/each. Cheap, recurring sink. Garrison-style maintenance pulse.
- **Premium hurry-ups** during war.

Net: bolts circulation is *unchanged* but its share of the spend
profile drops. Viewers who care about Clash deeply use both lanes
(grind gather tasks + spend their daily-payout bolts on skips and
traps). Viewers who only run dungeons still feel the daily-payout
bolts go somewhere useful.

### 3.6 Worked example — TH3 → TH4 upgrade

For comparison, original Phase 1 cost:

> TH 3 → 4: 7,000 bolts (6 h)

After expansion:

> TH 3 → 4: **3,000 wood + 1,800 stone + 200 iron + 800 bolts**,
> still 6 h.

The community needs the wood/stone from collectors or gather tasks,
plus a *much smaller* bolts contribution. A solo viewer who runs 2
medium gathers + 1 long stone gather can pay for it in a day's
play — but they can do that fast, or wait for the collectors to
fill the treasury passively over a few days. The trade-off is
*time-vs-attention*, not just *bolts-vs-bolts*. That's the loop.

---

## 4. Random goblin raids — the always-on threat

### 4.1 What it is

NPC goblin raids that hit the town automatically, throughout the
day, regardless of whether anyone is online. They use the **same
simulator** as PvP raids (`clash-raid.js simulate()`), the same
star-rating, the same damage propagation. Outcome is determined by
the town's built defenses + garrison + (Phase 3) defender Champion.

This is the always-on PvE pressure that PvP-only Clash lacks. New
players see meaningful defensive decisions on day one — not at
hero L8 when PvP opens.

### 4.2 Frequency and intensity

Per-town schedule, weighted by TH level:

| TH | Daily raids | Intensity (goblins per raid) |
| --- | --- | --- |
| 1 | 0 (grace period) | — |
| 2 | 1 | 6 scrapper goblins |
| 3 | 1–2 | 10 scrappers + 1 archer |
| 4 | 2 | 14 mixed + 1 sapper |
| 5 | 2–3 | 20 mixed + 2 sappers + 1 chief |
| 6 | 3 | 28 mixed + 1 mage |
| 7 | 3 | 32 mixed + 1 chief + 1 mage |
| 8 | 3–4 | 40 mixed + Goblin Warband (boss raid 1×/day) |
| 9 | 4 | 50 mixed + Warband |
| 10 | 4 | 60 mixed + Warband + Skyriders |

"Warband" = a boss-tier composition with a Goblin King unit. The
King is the only goblin worth a defender-Champion engagement.

Variance: each scheduled raid picks a random time within a 4-hour
window so streamers can't predict the exact tick. Total raids per
UTC day are capped by the schedule.

### 4.3 Scheduler

Runs in `clash-cron.js` under the existing "23 hourly" slot — same
slot the trophy decay + shield nudge code already lives in. New
function `scheduleGoblinRaids(env)`:

- Walk every town in the active matchmaking buckets (`clash:mm:tier:*`).
- For each town, read `clash:goblinsched:<guildId>` → `{ nextRaidUtc, lastRaidUtc, dailyCount, dailyResetUtc }`.
- If `now > nextRaidUtc`, fire one goblin raid (see §4.4) and schedule the next one within the next 4-hour window.
- Reset `dailyCount` at each UTC midnight.

Shielded towns get a free pass: goblins respect shields. Paused
towns (`/clash town pause`) also skip goblin raids — pausing means
*pausing*, full stop.

KV:

- `clash:goblinsched:<guildId>` — `{ nextRaidUtc, lastRaidUtc, dailyCount, dailyResetUtc }`

### 4.4 Firing a goblin raid

Each goblin raid is a server-side simulation:

1. Read the live town (via `clash-state.getTown`).
2. Read or generate the goblin army for this TH using `generateGoblinArmy(thLevel, seed)` in `clash-content.js`. Seed = `guildId XOR floor(now / 60s)` so the raid is reproducible for replay.
3. Run `simulate(townSnapshot, goblinArmy, { source: 'goblin', defenderHero: <if applicable>, ...opts })`.
4. Take the receipt + **write damage back** (see §4.5).
5. Append event to `clash:events:<guildId>` ring buffer (kind: `clash.raid.goblin.incoming` → `.result`).
6. Fire push: `pushGoblinRaidIncoming` and `pushGoblinRaidResult` (new helpers in `clash-push.js`).
7. Update prestige + treasury per the loot rules in §4.6.

Receipt is stored at `clash:raid:<raidId>` with `attackerUserId:
'goblin'` so replay tooling treats it like any other raid.

### 4.5 Damage persistence — the part v1 didn't have

**This is the central mechanical change.** Today, the simulator runs
against a snapshot and the receipt records what got destroyed, but
the live town's `buildings[].hp` never reflects damage afterward.
Each raid effectively resets to full HP — there's no persistence,
because v1 had shields wrapping the loss anyway.

After expansion:

- Post-raid writeback: for each building that ended the sim below
  max HP, set the live `buildings[].hp` to the sim's final value and
  set `status: 'damaged'` if HP < 100%.
- Buildings that ended the sim at 0 HP are **destroyed** — `status:
  'destroyed'`, hp = 0. Destroyed buildings still occupy their tile
  (the rubble sprite renders), still need to be repaired or
  demolished. They do **not** defend and do **not** produce.
- Walls: HP is per-segment (each grid cell of wall is its own
  building entry in the layout). Damaged walls keep their wall
  bitmask sprite but render with a "cracked" overlay.
- Storage / Treasury cap is **not** affected by damaged storages —
  caps are calculated from `level`, not `status`. Damaged storage
  *does* leak: 2% of held resources/min lost until repaired (small
  pressure to fix it fast).

The def-snapshot (`clash:def-snapshot:<guildId>`) is regenerated
after damage writeback so subsequent raids attack the *damaged*
town. Snapshot invalidation extends to: damage event, repair start,
repair complete.

### 4.6 Loot rules — goblin raids

- **Goblins steal** a slice of treasury proportional to stars
  earned. 0★: nothing. 1★: 5% of one random non-bolt resource.
  2★: 8% of two resources. 3★: 12% of three resources.
- Goblins **never** steal bolts and **never** steal cores. (Bolts
  is brand currency, cores is endgame catalyst — neither makes
  sense as goblin plunder.)
- **Defender reward** on 0★ repel: 80 + (TH × 30) scrap + 1 prestige + a 5% chance of a small "Goblin Tooth" trinket cosmetic (Patreon-style flair, no gameplay).
- No trophy loss for losing to goblins — stakes are lower than PvP. Goblins are a *damage* threat, not a *ladder* threat.
- Hero (defender Champion, if active) gains XP same as PvP raid.

### 4.7 Repair

New action:

```
/clash repair <buildingId>
```

- Streamer/mods only.
- Cost: proportional to damage taken — `repair_cost(building) =
  build_cost(level) × (1 − hp/maxHP) × 0.5`. Half the build cost at
  worst case (fully destroyed except for the rubble). Same resource
  mix as the original build.
- Time: also proportional — `repair_time = build_time(level) × (1 −
  hp/maxHP) × 0.4`.
- Repair is queued like any build — uses a build slot, runs against
  the queue cap. Streamers can spend a Battle Plan to skip a repair
  cooldown (same as build).
- "Demolish" companion: `/clash demolish <buildingId>` clears a
  destroyed building's tile entirely without repairing (refunds 25%
  of build cost in resources). Useful if the streamer wants to
  re-layout instead of rebuilding in place.

KV: repairs share `clash:queue:<guildId>` with builds — same queue
shape, just a `kind: 'repair'` discriminator. New helper
`enqueueRepair(env, guildId, buildingId, costResolution)`.

### 4.8 Auto-defense vs. designated Champion

Goblin raids by default use **garrison + towers only** — no
defender Champion deployment, because asking a viewer to wake up at
3 AM to defend a goblin raid is hostile. The exception:

- If the town's Champion has `acceptedUtc < now < expiresUtc` AND
  the goblin raid is a "Warband" (boss tier), the Champion *is*
  deployed.
- This keeps the boss raids interesting (high stakes) but lets
  routine harassment go through automatic defenses.

Configurable: `/clash defender always | warband-only | never`
(default warband-only).

---

## 5. New content — buildings, defenses, traps, troops

Quantities are calibrated so the building/troop pickers stay
browsable (≤ ~25 building kinds, ≤ ~15 troops). Anything more and
the Discord-side `/clash town build kind:<…>` picker chokes the
choice cap (Discord allows 25 choices).

### 5.1 New buildings (production / utility)

Beyond the existing 8:

| Building | Glyph | Levels | Function |
| --- | --- | --- | --- |
| Sawmill | 🪵 | 1–5 | Wood collector + storage |
| Quarry | ⛏️ | 1–5 | Stone collector + storage |
| Forge | 🔥 | 1–5 | Iron collector + storage |
| Mint | 💰 | 1–5 | Gold collector + storage |
| Workshop | 🔧 | 1–4 | +1 gather-task slot per level (cap 4) |
| Builder's Hut | 🏠 | 1–4 | +1 concurrent town-build slot per level (cap 4) |
| Lumber Vault | 🗄️ | 1–4 | Wood capacity bonus |
| Stone Vault | 🗄️ | 1–4 | Stone capacity bonus |
| Iron Vault | 🗄️ | 1–4 | Iron capacity bonus |
| Gold Vault | 🏛️ | 1–4 | Gold capacity bonus |

That's 10 production/utility buildings. Plus the 8 existing
(Town Hall, Wall, Cannon, Archer Tower, Storage, Barracks, Trap,
War Tent) → 18 in the catalog.

### 5.2 New defenses

| Defense | Glyph | Levels | Behavior |
| --- | --- | --- | --- |
| Mortar | 💣 | 1–6 | Splash damage; very slow fire rate; min range 4 tiles (blind spot up close) |
| Mage Tower | 🔮 | 1–5 | Magic damage; ignores wall HP — hits troops behind walls; expensive (iron + cores) |
| Skyward Bow | 🏹 | 1–5 | Anti-air only; ground troops not targeted |
| Bomb Tower | 💥 | 1–4 | Close-range AoE; explodes on death (full damage burst) |
| Voltaic Coil | ⚡ | 1–5 | Cloaked until first attacker enters range — surprise opener (Voltaic-themed) |
| Heavy Cannon | 🔫 | 5–7 | High-damage single-target; only buildable at TH8+ |
| Inferno Tower | 🔥 | 6–8 | Ramps damage on a locked target; melts heroes/champions |
| Eagle Eye | 🦅 | 8–10 | Town-wide watchtower; calls in 3 reinforcement archers/raid (endgame) |

8 new defensive buildings. Combined with Cannon + Archer Tower:
**10 distinct defense kinds.** Big bump from 2 → 10.

### 5.3 New traps

Today: 1 generic trap (Phase 1). Expansion adds:

| Trap | Glyph | Levels | Behavior | Cost (re-arm) |
| --- | --- | --- | --- | --- |
| Bomb Trap | 💣 | 1–3 | AoE damage on first step (existing "Trap" renamed) | 80 bolts |
| Spring Trap | 🦘 | 1–3 | Flings the nearest 2 troops back 4 tiles (delays push) | 120 bolts |
| Sky Mine | ✈️💥 | 1–3 | Anti-air only; one-shots most flyers | 140 bolts |
| Static Trap | ⚡ | 1–3 | Stuns nearest 3 troops for 2 sim-ticks | 100 bolts |
| Caltrops | ❄️ | 1–2 | Slows every troop in 3-tile radius by 50% for 5 ticks | 60 bolts |
| Inferno Trap | 🔥 | 1–3 | Burn DoT — 12 dmg/tick × 8 ticks on triggering troop | 150 bolts |
| Decoy Banner | 🚩 | 1–2 | Pulls "closest" targeting from real buildings for 3 ticks (defensive feint) | 90 bolts |

7 trap kinds. Each one-shot on first trigger; viewers re-arm via
`/clash town rearm` (or via the web editor). Re-arm cost is the
"recurring bolt sink" §3.5 mentions.

### 5.4 New troops

Today: 6 personal (Scrapper, Archer, Bolt Knight, Sapper Rogue,
Healer Cleric, Voltaic Mage) + 4 garrison versions. Expansion adds:

| Troop | Tier | Role | Ground / Air |
| --- | --- | --- | --- |
| Goblin Sneak | common | fast, low HP, ignores walls (climbs over) | Ground |
| Battering Ram | rare | siege, very slow, huge HP, wall-breaker | Ground |
| Skyrider | rare | air, low HP, fast, ignores walls | **Air** |
| Plague Doctor | rare | support, debuffs target defenses (−25% DPS for 8 ticks) | Ground |
| Lightning Sapper | epic | Voltaic-themed; AoE wall break + chain shock | Ground |
| Storm Caller | epic | air, AoE rain damage on bunched troops/buildings | **Air** |
| Goblin King | legendary | NPC-only, boss for Warband raids; high HP, charge attack | Ground |
| Wyrm | legendary | NPC-only, boss air unit | **Air** |

6 new player-controllable troops (4 ground + 2 air) + 2
NPC-only bosses. Combined with existing 6 → **12 player troops**.

**Air is new.** Existing defenses can't target air; need Skyward Bow
+ Sky Mine + Mage Tower (Mage Tower defaults to "highest threat"
targeting and includes air). This creates a real defensive
investment curve — air-only PvP gets *much* nastier if the defender
doesn't build AA.

### 5.5 Content catalog source of truth

All of the above lives in `clash-content.js`. Convention from §12
of the original doc applies: each kind has a glyph, name, level
cost arrays (now per-resource), level time arrays, level HP arrays,
plus new fields:

```js
mortar: {
  name: 'Mortar', glyph: '💣',
  footprint: { w: 2, h: 2 },          // NEW — grid cells occupied
  cost: [null, { wood:500, stone:300, bolts:200 }, { ... }, ...],
  time: [null, 30*60_000, 2*60*60_000, ...],
  hp:   [null, 600, 900, 1400, 2000, 2800, 3800],
  dps:  [null, 18, 30, 48, 70, 95, 125],
  splash: true,
  minRange: 4,
  range: 12,
  targets: 'ground',                  // 'ground' | 'air' | 'both'
  produces: null,                     // NEW — only for collectors
  productionRate: null,
  capacity: null
}
```

`spriteIdForBuilding(kind, level)` already handles new kinds
automatically — the sprite pipeline does *not* need code changes,
only new image assets in the new size (§9).

---

## 6. Drag-and-drop layout editing

### 6.1 Surface

Web only. `loadout.aquilo.gg/clash` (the route stub already exists
in the Phase 4 design). Discord and Twitch panel **do not** offer
edit — they're read-mostly.

### 6.2 Grid + footprints

- Grid: 24 × 24 cells (up from the implicit 14 × 14 used in v1
  building positions). Bigger grid accommodates larger sprites + 
  multi-cell footprints + room for full perimeter walls + room for
  spaced-out collectors.
- Cell pixel size on screen: 96 px (matches the new building base
  sprite size — see §9). Total grid render: 2,304 × 2,304 px,
  scrollable / pinch-zoomable.
- Each building has `footprint: { w, h }` from the catalog:
  - Town Hall: 3 × 3
  - Mortar / Mage Tower / Inferno: 2 × 2
  - Cannon / Archer Tower / Sawmill / Quarry / Forge / Mint: 2 × 2
  - Workshop / Builder's Hut / Barracks / Storage: 2 × 2
  - Eagle Eye: 3 × 3
  - Wall segment: 1 × 1
  - Trap: 1 × 1
- Collision: no two footprints overlap. Walls + traps may share
  *adjacent* tiles with buildings (they sit on the edge), but cannot
  overlap a footprint.

### 6.3 Wall snapping

Walls auto-connect using the standard tile-bitmask technique:

- Each wall segment is one 1 × 1 building entry with `kind: 'wall'`.
- At render time (client-side, no server state needed) the sprite
  variant is chosen by a 4-bit bitmask of the segment's
  N/E/S/W neighbors:
  - `0b0000` → single post sprite
  - `0b0001` → wall-end cap (S only)
  - `0b0011` → corner (S + E)
  - `0b1111` → cross-junction
  - … 16 variants total
- 16 PNG sprites per wall level (8 levels = 128 sprites total).
  Naming: `clash/buildings/wall-L<n>-<bitmask4>.png`.
- The neighbor check is **strict 4-neighbor orthogonal** — diagonal
  walls do not auto-connect (cleaner art, simpler mental model).

The bitmask resolves client-side every render frame; the server
stores only `{ kind: 'wall', x, y, level, hp, status }` per
segment. Same shape as today.

### 6.4 Drag-and-drop UX

- Palette on the right: production / defense / traps / walls tabs.
- Drag a building card onto the grid; it shows a footprint
  silhouette while dragging.
- Drop on a free area → places at the grid-snapped position;
  highlights red over collisions; refuses drop.
- Right-click an existing building → menu: Move, Repair (if
  damaged), Demolish, Cancel Build (if `status: 'building'`).
- Walls have a **drag-paint mode** — click and drag to lay a row
  of segments in one motion. Each segment placed atomically;
  client batches them and POSTs as a single `layout` update.
- "Layout mode" gate: editing is only enabled in an explicit
  "Edit Layout" mode (top-right toggle). Outside edit mode the
  town is purely a view, so viewers can't accidentally drag a
  building during normal hover/inspect.

### 6.5 Persisting layout

New HTTP endpoint:

```
POST /sync/<guildId>/clash/layout                HMAC-gated
     body: { userId, layout: [
       { id, kind, x, y, level },              // for existing buildings
       { kind, x, y, level: 1 }                // for new placements
     ] }
     → { result: '<message>', layoutVersion }
```

Atomic replace. Server validates:
- Every existing building.id in the payload exists in the live town
- No footprint collisions
- No `kind` mismatch (you can't reskin a Mage Tower into a Cannon)
- New placements must be affordable in resources + queue capacity

On success: bumps `layoutVersion`, invalidates `clash:def-snapshot:<guildId>`, fires push to relevant audience.

Implementation in `clash-http.js` next to the existing `_editorTownBuild` etc. New adapter `_editorTownLayout(env, ctx, ...)` in `clash.js`.

### 6.6 Layout-edit conflict semantics

Streamer + mod is the write-gate for layout (same as builds, per
v1 §12). If two mods open the editor and both submit a layout
update, last-write-wins on `layoutVersion`. Clients optimistically
display their pending edit but recompute on the response. Same
contract the wallet/town existing edit flow already uses.

---

## 7. Animated town

Pure client-side, on the web `/clash` page and the Twitch panel.
No new server state. The animation system has three layers:

### 7.1 Villagers

- 1 villager rendered per active viewer in the channel (i.e., the
  number of distinct `clash:contributions:<guildId>:<userId>`
  records updated in the last 7 days). Cap 12 — beyond that the
  village reads as "swarming," not "lively."
- Each villager has a randomized sprite (8 variants — different
  hats / clothes / hair colors).
- Pathing: 4-direction grid movement. Tile-cost: walkable on
  empty tiles + on the "grass" border around the town. Buildings
  are obstacles; villagers route around them.
- AI: each villager picks a random walkable target tile, walks to
  it (BFS pathfind on the 24×24 grid), idles 1–4 seconds, picks
  new target. Idle animations: dig, hammer, sit, wave.
- During construction (a building is `status: 'building'`), the
  villager nearest the building biases its target choice toward
  the build site — looks like they're working on it. Cosmetic
  only; no effect on build time.

### 7.2 Construction states

Each building has 4 visual states:

| Status | Sprite | Overlay |
| --- | --- | --- |
| `idle` | base sprite for `kind`+`level` | — |
| `building` | scaffolded variant of the *target* level | 2-frame hammer animation cycling on top |
| `damaged` | base sprite | smoke particle emitter + cracked overlay; lighter shade |
| `destroyed` | rubble sprite | — |

Sprite variants live alongside the base sprites:
`clash/buildings/<kind>-L<level>.png`,
`clash/buildings/<kind>-L<level>-scaffold.png`,
`clash/buildings/<kind>-L<level>-damaged.png`,
`clash/buildings/<kind>-rubble.png`.

The `damaged` overlay is rendered as a particle system in the
client (a few smoke puffs every ~0.5s). No per-frame sprite — the
particle emitter is procedural.

### 7.3 Idle building animations

A few buildings have subtle 2–4 frame loops to add life:
- Sawmill: saw spinning
- Forge: chimney smoke + brief glow
- Mint: coin sparkle every ~3s
- Mage Tower: orb rotating slowly
- Voltaic Coil: occasional zap arc (cloaked rendering is "dimmer," not invisible)
- Eagle Eye: bird circling overhead

Built into the sprite file naming as `-anim<n>.png` frames.

### 7.4 Rendering technology

The web client is whatever the existing `/clash` route uses (a
Next.js page, going by the project structure). Recommendation:

- Use **Pixi.js** for the WebGL canvas — proven, lightweight,
  good pixel-art support, easy sprite-sheet animations.
- Single sprite atlas per surface (web vs. panel) — 1 PNG + 1
  JSON manifest. Fits 100+ sprites at the new sizes in <2 MB.
- Animation driven by `requestAnimationFrame`; 60 fps target on
  desktop, capped to 30 fps on the Twitch panel (panel is
  embedded and constrained).
- All state polled from `GET /sync/<guildId>/clash` every 10–30
  seconds; town state is small (a few KB), polling is cheap. Live
  updates (raid started, build complete) come over the Aquilo
  Bus WebSocket the OBS overlay already uses — the web client
  subscribes to the same bus when authenticated.

Twitch panel uses the **same Pixi scene**, just zoom-clamped (no
edit mode, no scrolling beyond town bounds), with a "raid feed"
sidebar overlay.

---

## 8. Pixel-art background

### 8.1 Composition

Single full-frame pixel-art scene, parallax-layered:

| Layer | Z | Content | Animation |
| --- | --- | --- | --- |
| 0 | back | sky + sun/moon | none for v1 |
| 1 | mid-back | distant mountains | none |
| 2 | mid | tree line / forest edge | gentle sway (2-frame) |
| 3 | mid-front | grass field with the town's tile floor | none |
| 4 | front | town (buildings + walls + traps + villagers) | full animation |
| 5 | overlay | clouds drifting (2 cloud layers) | parallax scroll, slow |

Total scene: 2,304 × 1,296 px at 1× zoom. Pixi handles the parallax
trivially — separate sprite layers with different scroll speeds.

### 8.2 Style guide

Reference: Clash of Clans village backdrop — saturated daylight
greens + browns, soft pixel cluster style (no harsh outlines).
But Loadout's existing dungeon palette skews darker, so we
**bridge**: warm midday tones for the village ground, with a
distant horizon that matches dungeon environs (forest in front of
darker mountains).

Same artist that produced the existing card sprites (see recent
commit `e752017 cards: common + token sprites`) should produce
the backdrop — keep visual coherence with the rest of the game.

### 8.3 Variants

- v1 of the backdrop: **single daytime scene**, static cloud
  parallax. Cheap to ship.
- v2 (Phase E6 polish): day / night cycle keyed to UTC time at the
  town's owner timezone (or just to UTC if owner timezone unknown).
  Sunset transition, lanterns at night, sleepy villagers.

v1 only for the expansion; v2 is a stretch goal.

### 8.4 Asset delivery

Backdrop layers live at `aquilo-gg/sprites/clash/backdrop/*.png`.
Pixi loads them in the initial atlas. Single zip drop, no
per-building/per-troop CDN paths involved.

---

## 9. Sprite asset sizing — the fix

### 9.1 The current sizes

From the existing implementation:
- `clash/buildings/<kind>-L<level>.png` → 32 × 32
- `clash/troops/<troopId>.png` → 24 × 24

That was fine for a Discord embed at 200 px wide. At full-screen
web + Twitch panel, they render at ~5 logical pixels per source
pixel — pixel art doesn't scale that hard cleanly. They look like
postage stamps under glass.

### 9.2 The new sizes

- **Buildings**: 96 × 96 *per grid cell*. Multi-cell buildings (footprint w × h) get a 96·w × 96·h sprite. E.g., Town Hall (3×3) → 288 × 288 source PNG.
- **Troops**: 64 × 64 per troop. Big enough to read at a glance on the panel; small enough that a 50-troop raid doesn't tank framerate.
- **Walls**: 96 × 96 per segment, 16 bitmask variants per level (per §6.3).
- **Backdrop layers**: rendered native at their authoring resolution; scaled to fit the scene canvas.

Choosing 96 vs 64 vs 128 per cell: 96 px is the sweet spot. 64
loses detail on a 4K Twitch monitor; 128 makes the grid too big
for sub-1080p viewers. 96 hits both. (We're not designing for
mobile-Twitch-app viewers; that path is a known limitation.)

### 9.3 Asset pipeline change

- New sprite path: `aquilo-gg/sprites/clash-v2/...`. Decoupled
  from the existing path so we can roll forward without breaking
  any embed that still pulls v1.
- `spriteIdForBuilding(kind, level)` (`clash-content.js:353–388`)
  is parameterized: `spriteIdForBuilding(kind, level, { surface:
  'discord' | 'web' | 'panel' })`. Discord stays on v1 (the small
  size renders fine in embeds). Web + panel hit v2.
- `clash-state.js` enrichers (`withBuildingSprites`,
  `withGarrisonSprites`) take an optional surface arg and
  enrich accordingly.
- Migration story: ship v2 sprites with the same `kind` keys as
  v1. No code path breaks if a v2 asset is missing — the loader
  falls back to v1. Lets us ship building art incrementally.

### 9.4 Authoring spec

For the contributing artist: each new building kind needs:
- Base sprite at L1, L2, …, L<max> (1 per level)
- Scaffold variant per level (used during construction)
- Damaged variant per level (used at hp < 100% < 100%)
- Rubble variant (single sprite, used at hp = 0)
- Optional: 2–4 frame animation cycle for the level the building
  spends most of its time at (typically max level)

For walls: 16 bitmask variants per level (8 levels = 128 sprites).
Walls don't have damaged variants; we tint at render-time instead.

For troops: idle sprite + 2-frame walk + 2-frame attack cycle.

Total new asset count, roughly:
- Buildings: 24 kinds × ~6 levels × ~3 variants ≈ 432 sprites
- Walls: 8 levels × 16 variants ≈ 128 sprites
- Traps: 7 kinds × ~3 levels ≈ 21 sprites
- Troops: 12 player + 2 NPC × ~6 frames ≈ 84 sprites
- Backdrop layers: ~6 PNGs
- Villager variants: 8 × ~6 frames ≈ 48 sprites

→ ~720 sprites for the full v2 pack. Phased across builds.

---

## 10. Storage / KV — extension summary

### 10.1 Extended keys

| Key | What changes | Backfill |
| --- | --- | --- |
| `clash:treasury:<guildId>` | + wood, stone, iron, gold; capacity becomes per-resource object | first read injects zeros + caps from existing storages |
| `clash:town:<guildId>` | + `focus`, `buildings[].collector`, `buildings[].footprint`, `buildings[].status='destroyed'` | first read inserts defaults via `ensureTown` |
| `clash:queue:<guildId>` | items support `kind: 'repair'` | none — old items keep their `kind: 'build'` |
| `BUILDINGS` (in `clash-content.js`) | + `footprint`, + `produces`, + `productionRate`, + `targets` (air/ground), + 18 new kinds | static |

### 10.2 New keys

| Key | Value |
| --- | --- |
| `clash:gather:<guildId>:<userId>` | `{ items: [{ id, resource, tier, endsAt, yield }] }` |
| `clash:goblinsched:<guildId>` | `{ nextRaidUtc, lastRaidUtc, dailyCount, dailyResetUtc }` |
| `clash:repair:<guildId>` | (in practice merged into `clash:queue:<guildId>` — see above) |

Net new keys: 2.

### 10.3 Migration risk

- Existing v1 + v2 towns coexist. A v1 town that was last touched
  before the expansion still loads — `ensureTown` adds the new
  fields, treasury auto-backfills, def-snapshot regenerates on
  next mutation.
- No KV writes happen until a viewer triggers a read on an
  upgraded town. Cold towns stay v1 in KV forever until first
  read after the expansion ships.
- No mass-migration job needed. (Mirrors the v1 Phase 3 backfill
  approach for `defenderChampion`.)

---

## 11. HTTP / cross-surface contract

### 11.1 New endpoints

```
POST /sync/<guildId>/clash/gather               HMAC-gated
     body: { userId, resource, tier }
     → { result, gatherTask }

POST /sync/<guildId>/clash/repair               HMAC-gated
     body: { userId, buildingId }
     → { result, repair }

POST /sync/<guildId>/clash/layout               HMAC-gated
     body: { userId, layout: [...] }
     → { result, layoutVersion }

POST /sync/<guildId>/clash/tap                  HMAC-gated
     body: { userId, buildingId? }              // omit to tap all
     → { result, collected: { wood, stone, ... } }

POST /sync/<guildId>/clash/rearm                HMAC-gated
     body: { userId, trapIds: [...] }
     → { result, rearmed: [...] }
```

All five live in `clash-http.js` with adapters in `clash.js`
(`_editorGather`, `_editorRepair`, `_editorLayout`, `_editorTap`,
`_editorRearm`).

### 11.2 Extended endpoints

- `GET /sync/<guildId>/clash` returns the extended treasury + the
  gather queue + the goblin schedule.
- `GET /clash/town/<guildId>` (public, panel) returns the same
  shape minus secrets (no HMAC). Gathers + repair queue are
  visible — the panel shows them.

### 11.3 Events ring buffer additions

New event kinds appended to `clash:events:<guildId>`:

- `clash.raid.goblin.incoming` — goblin raid queued
- `clash.raid.goblin.result` — goblin raid resolved
- `clash.building.damaged` — building moved to `damaged` status
- `clash.building.destroyed` — building moved to `destroyed` status
- `clash.repair.started` / `clash.repair.complete`
- `clash.gather.started` / `clash.gather.complete`
- `clash.collector.flushed` — collector tap fired

All sub-32 bytes (the kind string + the building/raid id). Buffer
size stays at 32; oldest evicts as always.

### 11.4 Push notifications

New push event kinds (extend the 8-bit mask in
`clash-state.js:445–449` to 16 bits — there's plenty of room):

| Event kind | Bit | Audience |
| --- | --- | --- |
| `clash.raid.goblin.incoming` | 8 | streamer + opted-in contributors |
| `clash.raid.goblin.result` | 9 | same |
| `clash.gather.complete` | 10 | the viewer who started the task |
| `clash.repair.complete` | 11 | streamer + the user who queued it |
| `clash.building.destroyed` | 12 | streamer |

5 new event kinds. Templates in `clash-push.js`:
- `pushGoblinRaidIncoming` / `pushGoblinRaidResult` (3 sub-variants for 0★ / 1★ / 2★+)
- `pushGatherComplete`
- `pushRepairComplete`
- `pushBuildingDestroyed`

---

## 12. Discord / Web / Twitch surface table

| Surface | Audience | What it gains in this expansion |
| --- | --- | --- |
| Discord `/clash` | viewers + streamers | `/clash gather`, `/clash repair`, `/clash tap`, `/clash rearm`, `/clash town focus`, `/clash defender always/warband-only/never` |
| Discord `/clash town` | streamer + mods | builds now show resource cost breakdown; layout editing still text-only here (the web is the real surface) |
| **Web** `loadout.aquilo.gg/clash` | viewers (read) + streamers/mods (edit) | the new headline surface: animated isometric town, drag-and-drop editor, gather queue dashboard, repair queue, leaderboard |
| **Twitch panel** | viewers (read-only) | animated read-only town view + raid feed + leaderboard + goblin-raid alerts |
| OBS overlay | stream audience | extra toast kinds: goblin raid incoming/result, building destroyed |
| PWA push | opted-in viewers + streamers | 5 new event kinds (§11.4) |

Discord stays the **transactional** surface (gather, donate, repair).
Web stays the **strategic / visual** surface (layout, status). Panel
stays the **passive / spectator** surface (look at the cool town).
Mirror of how the original surfaces split.

---

## 13. Phased build plan

Each phase is independent and shippable. Order matters — earlier
phases unblock later — but each lands in viewers' hands before the
next starts.

### Phase E1 — Resource economy backbone (2 wks)
- Treasury schema extension; backfill in `ensureTown`.
- BUILDINGS catalog: add `footprint`, `produces`, `productionRate` fields. Recalibrate existing 8 buildings to mixed-resource costs.
- New buildings: Sawmill, Quarry, Forge, Mint, Workshop, Builder's Hut, 4 Reserves (per-resource Lumber/Stone/Iron/Gold; KV slug `xVault` kept for back-compat). Catalog entries only — sprites are placeholders at v1 sizes.
- `/clash gather <resource> <tier>` Discord command.
- `syncCollectors` walker; `syncGatherTasks` walker.
- New HTTP: `POST .../clash/gather`, `POST .../clash/tap`.
- Push: `clash.gather.complete`.
- Cooldown skip rates recalibrated for the new resources.

**Definition of done**: a viewer can start a 5-min wood gather in Discord, see "+80 wood" in the treasury via `/clash status` 5 minutes later. A streamer can build a Sawmill that drips wood passively.

### Phase E2 — Goblin raids + damage / repair (2 wks)
- `clash:goblinsched:<guildId>` + scheduler in `clash-cron.js`.
- `generateGoblinArmy(thLevel, seed)` in `clash-content.js`.
- Damage writeback in raid resolver (`clash.js handleRaid` + new goblin handler) — applies to PvP raids *and* goblin raids. The same code path. PvP raids now persist damage too.
- `/clash repair <buildingId>` + `/clash demolish <buildingId>` Discord commands.
- New HTTP: `POST .../clash/repair`.
- Push: `clash.raid.goblin.incoming` / `clash.raid.goblin.result` / `clash.building.destroyed` / `clash.repair.complete`.
- Goblin raid receipts stored at `clash:raid:<raidId>` like any other raid.
- Storage-leak rule for damaged storages (§4.5).

**Definition of done**: a TH3 town sees 1–2 goblin raids per UTC day. After a 2★ goblin loss, 2–3 buildings are damaged in `/clash town view`. `/clash repair <id>` queues a repair that completes in proportion to damage.

### Phase E3 — Content expansion (2 wks)
- All new defenses, traps, and troops added to `clash-content.js` catalogs.
- Trap re-arm command + endpoint.
- Air/ground targeting in `simulate()` — units with `air: true`, defenses with `targets: 'air' | 'ground' | 'both'`. Hard-coded behavior for the new defenses (Mortar splash, Mage Tower wall-ignore, Inferno ramp, etc.).
- Sprite assets remain v1-sized placeholders for these new kinds until Phase E4.

**Definition of done**: a streamer can build a Mortar at TH4 and a Mage Tower at TH7. Battering Rams break walls 3× faster than Sapper Rogues. Skyriders bypass Cannons but die to Skyward Bows.

### Phase E4 — Bigger sprites + pixel-art background (3 wks; gated by art)
- New 96 × 96 building sprites, 64 × 64 troops, 16-variant wall bitmask per level, scaffold + damaged + rubble variants.
- `spriteIdForBuilding(kind, level, { surface })` parameterization.
- `aquilo-gg/sprites/clash-v2/` directory drops.
- Backdrop layers (6 PNGs).
- Web `/clash` route swaps to Pixi.js renderer at v2 sizes with the new backdrop.
- Twitch panel does the same swap.
- Discord embeds stay on v1 sprite path (no change needed).

**Definition of done**: open the web `/clash` page on a Phase E1+E2+E3 town and it renders at full size with a pixel-art backdrop. Buildings show construction states. Damaged buildings smoke.

### Phase E5 — Drag-and-drop editor + wall snapping (2 wks)
- Grid expansion 14×14 → 24×24 (`layoutVersion` bump invalidates snapshots).
- Footprint-aware collision validation in `_editorTownLayout`.
- New HTTP: `POST .../clash/layout`.
- Web editor mode: palette, drag-to-place, wall paint mode, right-click menu (Move / Repair / Demolish), validation feedback.
- Wall bitmask rendering (16-variant per-level lookup).
- Optimistic UI w/ server-authoritative reconciliation on `layoutVersion`.

**Definition of done**: a streamer logged into the web editor can drag a Mortar onto the grid, paint a wall along the south perimeter, and see the snapped sprite junctions update live.

### Phase E6 — Animated town (2 wks)
- Villager system on web + panel: spawn 1 per recent contributor (capped 12), random sprite, BFS pathfinding, idle animations.
- Construction overlay: scaffold sprite + 2-frame hammer animation on `building` status.
- Damage particle emitter on `damaged` status.
- Building idle animations (sawmill spin, forge smoke, voltaic arc, mint sparkle, eagle eye bird).
- Backdrop parallax: 2 cloud layers drifting.
- Phase E6.5 (stretch): day/night cycle keyed to UTC.

**Definition of done**: the web `/clash` page is visibly alive — at any second something is moving (villager, cloud, scaffold hammer, smoke, forge glow). The same alive feel renders on the Twitch panel.

### Phase E7 — Twitch panel parity + polish (1 wk)
- Twitch panel reads from `GET /clash/town/<guildId>` and `GET /clash-leaderboard`.
- Same Pixi scene as web but locked to read-only.
- Raid feed sidebar (event ring buffer poll, 10 s cadence).
- Leaderboard tab (top raiders + top towns).
- Goblin raid alert toast on the panel when a raid hits the streamer's town.

**Definition of done**: viewers visiting any streamer's Twitch channel see a live animated town in the panel, with a real-time raid feed sidebar.

---

## 14. Anti-abuse — what changes

The existing controls from v1 §9 stand. Additions:

- **Gather task spam**: hard cap of 8 gathers/day per viewer per resource (resets at UTC midnight). Concurrency cap from §3.3 prevents trivial scripting. Trophy reward per gather is small enough that grinding doesn't dominate the leaderboard.
- **Repair griefing**: only streamer + mods can queue repair. Viewers can't queue (so no malicious viewer can lock build slots with junk repair jobs).
- **Goblin raid amplification by tier**: avoid the bug where a low-TH town gets nuked by accidentally over-scaled goblins. Schedule + intensity tables in §4.2 are hand-tuned per TH and reviewed before each phase.
- **Layout-edit spam**: rate-limit `POST .../clash/layout` to 1 update per 2 seconds per guild (via the existing `clash:rl:<userId>` short-TTL key pattern).
- **Re-arm cost**: trap re-arm uses bolts so it remains a real sink, not free. Removes the "infinite traps" exploit that would exist if re-arm were free.
- **Storage leak**: damaged storages lose 2%/min until repaired. Keeps "do nothing" defensive strategies costly without making damage punitive.

---

## 15. Resolved sub-questions (defaults applied)

Same convention as the v1 doc §12 — anything here can still be
tuned, but these are the defaults baked into the design:

- **Number of new resources**: 4 (wood/stone/iron/gold). Three felt too few; five was menu fatigue.
- **Gather scope**: per-viewer task → deposit to town treasury. Communal gain, individual labor.
- **Goblin raid frequency**: tier-scaled (§4.2), capped per-day, jittered within a 4-hour window. Shielded towns are spared. Paused towns are spared.
- **Damage persistence**: yes — applies to *all* raids, PvP and goblin alike, after this expansion.
- **Damaged building defense**: damaged towers still fire at full DPS until destroyed; only collectors take a 50% production penalty. (Considered scaling defense by HP %; rejected as too punishing.)
- **Repair gate**: streamer/mods only. Viewers can't queue repair.
- **Wall snapping**: 4-neighbor orthogonal only; no diagonal auto-connect.
- **Grid size**: 24 × 24 (up from 14 × 14 implied in v1).
- **Building footprints**: declared in `clash-content.js`. Layout validator enforces no-overlap.
- **Sprite size**: 96 × 96 building base, 64 × 64 troop, surfaces opt in by argument.
- **Air units**: introduced. Skyrider (rare) + Storm Caller (epic) + NPC-only Wyrm. AA defenses (Skyward Bow, Sky Mine, Mage Tower) gate them.
- **Layout edit surface**: web only. Discord stays text. Panel stays read-only.
- **Animation surface**: web + Twitch panel. Discord stays static embed.
- **Background style**: Clash-of-Clans-style pixel art, parallax. v1 = static day scene; v2 = day/night cycle.
- **Villagers**: 1 per active contributor, cap 12, random sprite variants, BFS pathing.
- **Defender Champion vs. goblins**: warband-only by default. `/clash defender always | warband-only | never` toggle.
- **Trap re-arm**: bolts only. Recurring sink replacing some of the bolts-as-build-cost circulation we removed.
- **Discord parity**: every new action has a Discord command equivalent. Viewers in chat-only channels lose none of the gameplay loop — just the visual richness.

---

## 16. Open questions for Clay

These need an opinion before Phase E1 starts. They affect calibration
or scope, not architecture — i.e., none of them invalidate the
design above, but each shifts the dials.

1. **Daily gather caps.** §3.3 proposes 8 gathers/day per resource. Too few (gameplay-starved on slow days)? Too many (grindy)? Recommend pilot at 8 and tune week 1.

2. **Should bolts ever appear in goblin loot?** §4.6 says no — bolts is brand currency. But a tiny bolts grant on a *defended* repel (currently scrap-only) would feel rewarding. Add 20–50 bolts to the repel grant?

3. **How aggressive is the daily goblin schedule at TH 8–10?** §4.2 proposes 3–4 raids/day with one Warband. For Clay's own stream this is probably exciting; for less-active streamers, it might be too much damage to repair. We could ship an opt-in difficulty `/clash town goblin easy|normal|hard`.

4. **Layout grid 24×24 vs. larger.** Current proposal: 24×24. Clash of Clans is closer to 44×44. Going to 32×32 or 40×40 gives more spacing room but means more KV bytes, slower validations, and bigger sprite scene on the panel. Recommend 24×24 for v1 and revisit if streamers complain about cramping.

5. **Sprite size 96 vs. 128.** §9.2 picks 96 px. If we expect the panel to render at a relatively small width (Twitch panel is ~318 px wide), even 96 may be too big for the panel; we'd render at 32–48 px on-panel. If we go 128 source for max fidelity, the web view is gorgeous but the panel re-scales aggressively. Want one canonical answer for both surfaces.

6. **Villagers per active viewer (1) vs. fixed cap (e.g., 6).** §7.1 ties villager count to community size — recruitment-marketing-positive for big communities, but a 2-viewer streamer's town feels emptier than a 12-viewer streamer's. Is that the right signal, or do we want every town to feel equally "alive"?

7. **Animated villagers on the Twitch panel — performance.** Twitch panels are embedded with constrained CPU/GPU. We can ship Phase E6 with animation always-on, or with a "low motion" panel mode that turns off villagers and animations for browsers that hint reduced motion. Recommend the latter for accessibility regardless; the question is just whether to default to low-motion on panels (safer) or full motion (cooler).

8. **Day/night cycle (E6 stretch goal).** Worth shipping for the original expansion, or save for a later polish pass? Adds ~1 wk and ~30 sprites (lantern variants for each building at night).

9. **Goblin loot stealing — silent or surfaced?** §4.6 has goblins steal 5–12% of one or more resources on a successful raid. Do we *highlight* what was stolen in the post-raid embed ("Goblins stole 240 stone!") or quietly deduct it? Surfacing is more engaging; silent is less rage-inducing.

10. **Battering Ram availability.** §5.4 lists it as `rare`. The original Sapper Rogue (also rare) already fills the wall-breaker role. Two wall-breakers at the same tier might over-pressure walls. Want to gate Battering Ram behind hero L20 / TH7 to keep it endgame?

11. **Are we committing to the four-resource model long-term**, or do we want to leave the door open for a fifth (e.g., Mana / Aether for high-end magic units)? The schema in §3.2 makes adding a fifth resource trivial (one new field, one new collector kind) — but the cost calibration work is per-resource and not free.

12. **Discord vs. web for the layout editor — is text-mode layout going away?** Today `/clash town layout` is text-only. After Phase E5, the web has full drag-and-drop. Do we retire the Discord text layout (force web for layout edits) or keep both? Keeping both means two write paths to maintain. Retiring it means streamers without a web browser handy can't reshuffle. Recommend keeping a *read-only* `/clash town view` in Discord and dropping the text-edit command — the web is mandatory for spatial edits.

---

## 17. References + integration points

Files this expansion extends (vs. forks). Citing the originals so
the build team knows where to graft:

- `discord-bot/clash-content.js` — extend BUILDINGS, TROOPS_PERSONAL, TROOPS_GARRISON catalogs; add `generateGoblinArmy(thLevel, seed)`; add `footprint`, `produces`, `productionRate`, `targets` fields.
- `discord-bot/clash-state.js` — extend treasury shape (backfill in `ensureTown`); add `syncCollectors`, `syncGatherTasks`; add `clash:gather:*` and `clash:goblinsched:*` helpers.
- `discord-bot/clash-raid.js` — extend `simulate()` for air/ground targeting; extend the resolver to emit damage-writeback receipts.
- `discord-bot/clash.js` — new handlers: `handleGather`, `handleRepair`, `handleDemolish`, `handleTap`, `handleRearm`, `handleGoblinRaid`; new `_editor*` adapters.
- `discord-bot/clash-cron.js` — add `scheduleGoblinRaids` + collector flushing pass.
- `discord-bot/clash-http.js` — new endpoints (§11.1); extend `handleClashSync` GET to return new fields.
- `discord-bot/clash-push.js` — 5 new push templates (§11.4); extend the bitmask to 16 bits.
- `discord-bot/commands.js` + `discord-bot/commands-spec.js` — new slash subcommands.
- `aquilo-gg/sprites/clash-v2/...` — new sprite asset tree.
- `aquilo-site` (separate repo): new `/clash` Next.js page with Pixi.js scene; Twitch panel update; PWA push template wiring for the new event kinds.

---

*End of design draft. Awaiting Clay's pass on §16 before kicking off Phase E1.*
