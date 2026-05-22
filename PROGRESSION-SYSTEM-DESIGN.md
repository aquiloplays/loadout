# Progression System — Profile, XP, Achievements, Badges, Seasons, Tournaments

> Status: **design draft — awaiting Clay sign-off.** Multi-phase. Phases
> are shipping units; do not start phase N+1 until N is in viewers'
> hands.
>
> Author: Loadout team · Date: 2026-05-22 · Owner: Clay
>
> Companion to `CLASH-FEATURE-DESIGN.md`, `CLASH-EXPANSION-DESIGN.md`,
> and `CARD-GAME-DESIGN.md`. This doc covers the **cross-cutting
> identity + progression layer** that ties every feature together:
> a public profile per viewer, a unified account-wide XP track, a
> catalogue of achievements, cosmetic badges, a seasonal battle pass,
> and randomly-scheduled tournaments. Each feature already has its own
> per-game stats (Clash trophies, Boltbound rating, board-game W/L,
> etc.); the progression layer **aggregates** those stats into a single
> profile, not replaces them.
>
> Verbatim ask (Clay, v1):
> *"Big one: a unified profile + level + achievement + badge + season
> + tournament layer across every game in the ecosystem. A public
> profile page per community member with their character, level,
> badges, content, and stats across every game. Link Steam/Epic for
> friending. ONE account-wide XP track fed from everything — playing,
> daily check-ins, watching the stream, Discord activity. Deep
> achievements tied to games + streams + Discord. Badges from
> achievements, shown on profile. Battle pass each season. Random
> tournaments a few times a month."*

---

## 1. Guiding principles

The existing ecosystem is **federated**: Loadout has its hero + bolts +
dungeon, Clash has its towns + trophies, Boltbound has its cards +
fragments, board games have their own match log, stocks/betting/quick
games each store their own state. Each feature ships independently and
that has been the right model — it's why we can deploy nine slices of
worker code without one breaking the rest.

The progression layer cannot break that. So it follows these rules:

- **Aggregate, don't replace.** Profile + XP + achievements + battle
  pass + tournaments READ existing per-feature stats. Feature-side
  stats stay where they are, in their existing KV keys. The
  progression layer adds new keys (`pprofile:*`, `pxp:*`, `pach:*`,
  `pbadge:*`, `season:*`, `tourn:*`) prefixed with `p` so they don't
  collide with the per-guild `profile:*` cosmetic record already in
  use. No feature module imports another — the progression worker
  asks each one for stats via a shared `getStatsFor(env, userId)`
  contract (§3.4).
- **One event bus, not nine.** Every feature emits a single
  `progressionEvent({kind, userId, meta})` call. The bus routes that
  event through three independent consumers: XP grant, achievement
  check, season-pass progress (§3.3). Adding a new feature later
  means one line at the emit site, no wiring elsewhere.
- **Account-wide, not per-guild.** Today most stats are keyed by
  `<guildId>:<userId>` because servers were the unit of ownership.
  The new profile is **account-wide** — one profile per Discord user
  identity, summing contributions from every guild they play in.
  This is also where the Twitch ↔ Discord identity bridge lives
  (§2.3).
- **XP is not Bolts.** Bolts is the brand spend currency (raids,
  shops, gifts). XP is the progression currency (levels, season
  tiers). They are completely separate accounts; one cannot be
  converted to the other. This lets us tune XP for engagement (broad
  participation) without distorting Bolts (which has real economic
  weight inside Clash + Boltbound + the shop).
- **Discord stays text-first.** All the rich progression UX lives on
  the website (aquilo.gg) and the Twitch panel. Discord surfaces
  remain ephemeral menus + push notifications. No animated season
  tracks in Discord embeds.
- **Patreon is the only paywall.** No new SKUs. The battle pass has a
  free track (everyone) and a premium track (Patreon members at any
  tier, like the existing free-lootbox stipend). No "buy the season
  pass" transaction surface.

---

## 2. What's new vs. what stays

| Layer | Today | After this system |
| --- | --- | --- |
| Identity | Discord userId per guild; Twitch panel uses `tw:<twId>` | + Account-wide identity record bridging Discord + Twitch + (Steam, Epic, others via §2.3) |
| Profile | `profile:<guildId>:<userId>` — per-guild cosmetic (display name + avatar choices) | + `pprofile:<userId>` account-wide public profile (aggregates across guilds, surfaces every game's stats) |
| Leveling | None. Each game has its own rating (Clash trophies, Boltbound ladder, etc.) | + Single account-wide XP + level (1..∞ with soft cap at 100 per season) |
| Achievements | 25-entry D1 catalog tied to engagement events (first-stream, first-bolt, etc.) | + Expanded ~120-entry catalog spanning every game + stream + Discord, KV-backed for progression tracking, D1 still backs the historical "unlocked" table |
| Badges | None as a system. `clash:warbadge` is a one-off cosmetic flag | + Badge inventory `pbadge:<userId>` earned from achievements + seasons + tournaments, displayed on profile with a 3-slot showcase |
| Seasons | None. Clash trophy decay happens daily but there's no seasonal reset | + 90-day seasons with 50-tier battle pass, free + premium tracks, automatic rollover |
| Tournaments | None. Boltbound has a daily-ladder counter but no organised events | + Randomly-scheduled brackets/ladders across Boltbound, board games, Clash, and the quick games. 2–4 per month. |
| Cross-game leaderboards | Per-feature only (top raiders, top town prestige, top Boltbound ladder) | + Account-wide leaderboards: top level, top season-pass progress, top tournament-points, top achievement count |

The shape of every feature stays the same. This is a layer that sits
*above* them.

---

## 3. Architecture — the progression spine

### 3.1 Why "one event bus" is the right shape

Every existing feature has its own ad-hoc notify path:
- Clash fires `appendClashEvent()` to its own ring buffer + signed
  POST through `clash-push.js`.
- Achievements (aquilo/achievements.js) fires `bumpAndAnnounce()`
  which posts to `ENGAGEMENT_CHANNEL_ID`.
- Board games inline a Discord mention when it's your turn.
- Quick games store nothing.

Forcing every feature to learn about XP + achievements + season pass
+ tournaments + leaderboards in their own code would mean nine separate
sets of changes and nine places where the wiring can rot. So:

A single `progressionEvent(env, event)` is the **only thing every
feature has to know**. The progression layer fans the event out to
its consumers internally.

### 3.2 The event shape

```js
{
  kind: 'clash.raid.won' | 'cards.match.won' | 'board.match.won' |
        'quick.game.played' | 'stream.checkin' | 'discord.message' |
        'stocks.trade' | 'bet.settled' | 'pet.tamed' | 'hero.levelup' |
        'daily.claimed' | ... ~40 kinds total (see §6 catalog),
  userId: 'discord-numeric-id',           // canonical account id
  guildId: 'guild-id-or-null',            // where it happened (null for cross-guild events)
  meta: {                                  // kind-specific payload, kept small (<200 bytes JSON)
    stars?: 1..3,                          // for clash.raid.*
    deckArchetype?: 'aggro' | ...,         // for cards.match.*
    game?: 'chess' | 'checkers' | ...,     // for board.match.*
    kind?: 'blackjack' | ...,              // for quick.game.*
    wagerBolts?: number,
    delta?: number,                        // generic numeric (trophies gained, bolts staked, etc.)
  },
  utc: 1234567890123,                     // epoch ms of the event
  // anti-replay: identity = sha256(`${kind}:${userId}:${utc}:${stable-meta}`)
  identity?: string,
}
```

Events are **idempotent** — emitting the same event twice grants XP
once. The identity field is computed from kind + userId + utc + meta
fields the caller marks as `stable:` (e.g. `raidId` for Clash); the
bus stamps a 24h TTL deduplication marker at `pevent:dedup:<identity>`
and drops repeats silently.

### 3.3 The three consumers

`progressionEvent()` fans out to:

1. **XP grant** — looks up `kind` in the XP table (§4.2), grants XP,
   updates `pxp:<userId>` + `pseason:<userId>`. Returns the new
   total + any level-up.
2. **Achievement check** — walks the achievement catalog (§6) for
   any entry whose `triggers` array includes this kind. Bumps the
   relevant counters in `pach:<userId>:<achId>` and unlocks if
   threshold reached.
3. **Season-pass progress** — bumps the seasonal counter in
   `pseason:<userId>` (already covered by consumer #1 since XP
   feeds the pass — see §7) AND records seasonal achievement
   progress separately (§7.4 — season-specific challenges that
   aren't account-wide achievements).

Consumers run sequentially in one tick. Each is a pure function
over the event + the current state, so the bus can replay events from
the dedup buffer to rebuild state if KV corruption is ever
detected.

The bus also writes the event to a small per-user ring buffer
(`pevents:<userId>`, 32 entries) so the profile page can render
"recent activity".

### 3.4 The `getStatsFor` contract

Each feature module exports `getStatsFor(env, userId)` returning a
small JSON payload with that feature's headline numbers:

```js
// clash-state.js
export async function getStatsFor(env, userId) {
  return {
    feature: 'clash',
    primary: { label: 'Trophies', value: trophies.trophies, tier: trophies.tier },
    secondary: [
      { label: 'Raids', value: raids },
      { label: 'Wins', value: wins },
      { label: 'Town defended', value: defended },
    ],
    iconKind: 'clash-shield',
  };
}
// cards-state.js
export async function getStatsFor(env, userId) { return {
  feature: 'boltbound',
  primary: { label: 'Ladder', value: trophies, tier: ratingTier },
  secondary: [{ label: 'Wins', ... }, { label: 'Collection', ... }, { label: 'Legendaries', ... }],
  iconKind: 'boltbound-card',
}; }
// ...same for boardgames, quick, stocks, bets, pets, wallet, hero
```

The profile page calls every feature's `getStatsFor` in parallel and
renders them as cards on the profile. New features add one export, get
on the profile for free. No central registry — discovery is by
convention (modules with a `getStatsFor` export are surfaced) plus an
explicit allow-list in `progression/profile.js` to keep the order
deterministic.

---

## 4. Unified XP and leveling

### 4.1 What XP buys

- **Account level** (1..∞ practically; design assumes 100 is "endgame"
  for the first year). Level number is the **headline** on every
  profile.
- **Battle-pass tier progression** during a season (§7).
- **Tournament seeding** as a soft tiebreaker (§8).
- **Level-gated cosmetics** — profile flair (rotating frames at L10,
  L25, L50, L75, L100) and chat-name colour in Discord (via role
  grants at the same milestones).
- **Bragging rights** — leaderboards (top level, top XP this season).

XP **does not** unlock gameplay. Every feature stays open at every
level. The only gates are the existing ones (Clash hero-level gate on
TH tiers, Boltbound pity counter, etc.). Locking new players out of
content via XP would re-introduce the federation tax we're trying to
remove.

### 4.2 The grant table

Calibration target: **~150-300 XP/day for an active engaged viewer**,
~50/day for a check-in-only viewer. A first-time week of
moderate play should reach level 5 (1,200 XP total); committed daily
play hits L20 in ~30 days. Numbers are starting points; the catalog
lives in `progression/xp-table.js` and is hot-swappable without a
deploy by editing the cron-loaded JSON in KV (`pxp:table`).

| Source | Event kind | XP | Notes |
| --- | --- | --- | --- |
| **Stream — daily check-in** | `stream.checkin` | 25 | Already exists; piggybacks |
| **Stream — watched 15 min** | `stream.watched.15m` | 5 | Capped at 4/day (60 min × 1 = 20 XP) |
| **Stream — watched 1 hour** | `stream.watched.1h` | +15 bonus | On top of the 4 × 5 quarter-hour grants |
| **Stream — chat (any msg)** | `discord.message` | 2 | Capped at 25/day (50 XP cap from chat) |
| **Stream — vote/poll** | `community.vote` | 5 | |
| **Daily — claim** | `daily.claimed` | 20 | |
| **Daily — streak 7d** | `daily.streak.7` | 50 | Awarded once per streak crossing |
| **Daily — streak 30d** | `daily.streak.30` | 200 | |
| **Loadout — equip/sell/shop** | `loadout.actioned` | 1 | Capped at 10/day |
| **Loadout — dungeon win** | `dungeon.cleared` | 30 | Per dungeon clear |
| **Loadout — duel win** | `duel.won` | 15 | |
| **Loadout — minigame played** | `minigame.played` | 4 | Capped at 6/day |
| **Loadout — hero level-up** | `hero.levelup` | 25 | |
| **Clash — raid (any)** | `clash.raid.played` | 8 | Floor for participating |
| **Clash — raid 1-star** | `clash.raid.won.1` | 12 | |
| **Clash — raid 2-star** | `clash.raid.won.2` | 25 | |
| **Clash — raid 3-star** | `clash.raid.won.3` | 50 | |
| **Clash — town defended (goblin)** | `clash.defended.goblin` | 15 | |
| **Clash — town defended (PvP)** | `clash.defended.pvp` | 30 | |
| **Clash — donate bolts** | `clash.donated` | 1 per 100 bolts donated, cap 50/day | |
| **Boltbound — match played** | `cards.match.played` | 10 | Floor |
| **Boltbound — match won (PvE)** | `cards.match.won.npc` | 15 | |
| **Boltbound — match won (PvP)** | `cards.match.won.pvp` | 30 | |
| **Boltbound — pack opened** | `cards.pack.opened` | 5 | |
| **Boltbound — fragment craft** | `cards.crafted` | 20 | Per craft |
| **Board games — match played** | `board.match.played` | 12 | |
| **Board games — match won** | `board.match.won` | 25 | |
| **Quick games — played** | `quick.game.played` | 4 | Capped at 8/day across all quick games |
| **Quick games — big-win** | `quick.game.bigwin` | 15 | Bonus when payout > 5× stake |
| **Stocks — trade** | `stocks.trade` | 3 | Capped at 5/day |
| **Bets — placed** | `bet.placed` | 2 | Per bet, capped at 10/day |
| **Bets — settled (win)** | `bet.won` | 8 | |
| **Bets — settled (parlay win)** | `bet.won.parlay` | 25 | |
| **Pets — tamed** | `pet.tamed` | 40 | Once per pet kind |
| **Pets — fed (daily)** | `pet.fed` | 3 | Capped at 1/day |
| **Achievement — unlocked** | `achievement.unlocked` | varies (XP listed on the achievement) | Default: 50 for normal, 200 for legendary |
| **Tournament — entered** | `tourn.entered` | 25 | |
| **Tournament — round won** | `tourn.round.won` | 50 | |
| **Tournament — won** | `tourn.victory` | 500 | |
| **Tournament — runner-up** | `tourn.runnerup` | 250 | |

**Daily cap on grants:** there is a soft cap of **500 XP/day** from
non-tournament sources. Beyond that XP accrues at 1/3 rate. Stops
"grind for XP all day" optimisation, keeps engaged-but-not-obsessive
play feeling rewarding.

### 4.3 The level curve

XP-to-next-level uses a softly-rising polynomial:

```
xpToReach(level) = 100 × level + 30 × level^1.6
```

Sample milestones:

| Level | XP to reach | Cumulative XP | Days @150/d | Note |
| --- | --- | --- | --- | --- |
| 2 | 130 | 130 | 1 | First night of play |
| 5 | 1,200 | 1,200 | ~8 | Casual first week |
| 10 | 3,400 | 3,400 | ~23 | Engaged player month |
| 25 | ~16,000 | ~16,000 | ~107 | "Veteran" milestone |
| 50 | ~55,000 | ~55,000 | ~370 | Year-one endgame |
| 75 | ~120,000 | ~120,000 | ~800 | Multi-year |
| 100 | ~210,000 | ~210,000 | ~1400 | Soft endgame |

The level number is the **single biggest piece of social proof** on the
profile, so the curve has to feel *earnable* for a daily player (L10
month one) without being trivial at the top (L50+ implies a year of
engagement).

### 4.4 Storage

```
pxp:<userId>            { xp, level, lastLevelUtc, dailyXp: { ymd, total } }
pxp:table               (singleton — hot-swappable XP grant table cached for 1 hour)
pevent:dedup:<identity>  short TTL marker (24h)
pevents:<userId>         ring buffer of last 32 events (~3 KB)
```

`pxp:<userId>` is the hot record — read on every profile load, every
XP grant. We keep it tiny (~80 bytes) so the read-modify-write is cheap.

### 4.5 What happens at level-up

- Push notification (via Clash's signed-POST gateway, reused) to the
  viewer's Discord DM if opted in.
- Discord channel announcement at the ENGAGEMENT_CHANNEL_ID at L10,
  L25, L50, L75, L100 milestones (same pattern as the existing
  achievement engine — re-uses `bumpAndAnnounce`-style code path).
- Profile flair frame updates automatically.
- Role grant at L10/25/50/75/100 (env var `LEVEL_ROLES_JSON` maps
  level → role ID; opt-in per server admin).
- Battle-pass tier check — if a season is active, level-up usually
  also advances a tier (XP feeds the pass — see §7).

---

## 5. Player profile

### 5.1 Surface

`aquilo.gg/p/<userId>` — public, no auth needed. Twitch panel has a
"my profile" deep-link. Discord menu adds `/loadout profile` button
linking to the same URL.

The profile is a single scrollable page:

```
┌──────────────────────────────────────────────┐
│ [character render]   Displayname             │
│                     L42 · Bronze IV · 🏆⚔️🎴 │
│                     [3-slot badge showcase]   │
│                     Joined Mar 2026 · 184d   │
│  [linked accounts row: discord twitch steam] │
├──────────────────────────────────────────────┤
│ Season Pass   ▓▓▓▓▓▓░░░░  Tier 17/50         │
├──────────────────────────────────────────────┤
│ Stats across the ecosystem (one card per     │
│ feature, lazy-rendered from getStatsFor)     │
│  ┌─Clash─┐ ┌─Boltbound─┐ ┌─Board games─┐    │
│  │ 🏆 842 │ │ 🎴 1240   │ │ ♟ 18-7-3    │    │
│  │ Tier IV│ │ Plat II   │ │ ♙ 6-2       │    │
│  └────────┘ └───────────┘ └─────────────┘    │
│  ┌─Hero───┐ ┌─Pets──────┐ ┌─Stocks──────┐    │
│  │ L24 Ⓜ  │ │ 4 tamed   │ │ +14,200 ⚡  │    │
│  └────────┘ └───────────┘ └─────────────┘    │
│  ┌─Quick──┐ ┌─Betting───┐ ┌─Wallet──────┐    │
│  │ 312 won│ │ 28-19 W/L │ │ 3,450 ⚡    │    │
│  └────────┘ └───────────┘ └─────────────┘    │
├──────────────────────────────────────────────┤
│ Achievements  84 / 120 unlocked  (carousel)  │
├──────────────────────────────────────────────┤
│ Recent activity (last 10 from pevents)        │
└──────────────────────────────────────────────┘
```

### 5.2 Storage

```
pprofile:<userId>        { displayName, character: heroRef,
                           bio?: string (200 chars max, profanity-filtered),
                           badgesShowcase: [badgeId, badgeId, badgeId],
                           privacy: 'public' | 'friends' | 'private',
                           createdUtc, lastSeenUtc,
                           linkedAccounts: {
                             discord: { id, username, verifiedUtc },
                             twitch?: { id, login, verifiedUtc },
                             steam?: { id, persona, verifiedUtc, source: 'oauth'|'manual' },
                             epic?: { id, displayName, verifiedUtc, source: 'oauth'|'manual' },
                             youtube?, tiktok?, ...
                           },
                           friends: [userId, ...]  (cap 200) }
pprofile:handle:<safeKey> -> userId   (handle reservation index)
```

`pprofile:<userId>` reuses the canonical Discord userId everywhere
because that's the one identity every feature already keys on (apart
from the Twitch-panel `tw:<twId>` form, which the link table resolves —
see §5.4).

### 5.3 Privacy

Three settings:

- **Public** (default) — visible at `/p/<userId>` to anyone with the
  URL, listed in search results + leaderboards.
- **Friends-only** — profile only renders when the viewer is in the
  user's `friends` list. Leaderboards still show the displayname but
  the profile body is gated.
- **Private** — only the user themselves sees the profile. Stats
  still feed leaderboards as anonymous entries ("Player #4839"). XP
  + achievements still accrue.

### 5.4 Account linking — Steam, Epic, and others

The progression layer is *the* identity layer. Linked accounts
power three things:

- **Friending** — "find this person on Steam to add them" is the
  primary use case Clay called out.
- **Verification** for tournaments where we need to confirm the
  account isn't a sockpuppet.
- **Cosmetic flair** — show a Steam profile picture on the panel,
  link a YouTube channel for content-creator profiles.

| Platform | Linking flow | Cost |
| --- | --- | --- |
| **Discord** | Already linked — it's the canonical identity. |  free |
| **Twitch** | OAuth implicit grant against existing app. Already wired for the Twitch panel; we add a "Link Twitch" button on the profile that consumes the existing JWT or runs a fresh OAuth flow. | free |
| **Steam** | OpenID 2.0 (Steam's only public auth, but it's stable + well-supported). Standard "Sign in through Steam" → SteamID64 → fetch persona from Steam Web API. | needs `STEAM_API_KEY` env var (free, public-personal-use key from steamcommunity.com/dev) |
| **Epic Games** | OAuth via Epic Developer Portal. Requires registering Aquilo as an Epic dev app (Epic offers free dev accounts; one-time registration). Returns Epic Account ID + display name. | one-time dev-portal setup |
| **YouTube** | OAuth (Google Sign-In). Heavy — needs a Google Cloud Project + verified OAuth consent screen. Lower priority than Steam/Epic for the gaming community. | one-time GCP setup |
| **TikTok** | OAuth — needs TikTok for Developers app. Similar one-time setup. | one-time app reg |
| **PlayStation Network** | No public OAuth. Manual entry ("enter your PSN handle"), no verification. We display an unverified badge and let users dispute mismatches. | n/a |
| **Xbox** | Microsoft account OAuth (graph.microsoft.com). Same Microsoft tenant as Discord's OAuth, easy. | one-time app reg |
| **Battle.net** | OAuth via Blizzard Developer Portal. Free reg. | one-time |

Implementation pattern (uniform across all OAuth platforms):

```
GET  /web/profile/link/start?platform=steam
       -> redirects to platform's OAuth (or OpenID for Steam)
GET  /web/profile/link/callback?platform=steam&...
       -> verifies, writes pprofile:<userId>.linkedAccounts.steam,
          redirects to /p/<userId>?just-linked=steam
POST /web/profile/link/manual  body: { platform, handle, externalId? }
       -> for PSN / unsupported — stores `source: 'manual'` flag
POST /web/profile/link/remove  body: { platform }
       -> removes the link (always allowed)
```

**Storage:**

```
plink:<platform>:<externalId> -> userId    (reverse index — "is this Steam already linked?")
```

We block double-linking the same external account to two different
Aquilo profiles. Removing then relinking is allowed (anti-abuse: rate-limited to one
relink per platform per 24h).

### 5.5 Friending

Linked-account discovery is the design's "friend" surface. We
deliberately don't try to build a Twitter-style follow graph — it
would compete with Discord for messaging. Instead the friend list is
just a list of `userId`s on `pprofile.friends`. Two flows:

- **Mutual via Discord** — already a friend in Discord? Auto-suggest
  on profile open. Requires Discord OAuth on the viewer side (already
  used for the website login).
- **Via Steam/Epic/etc.** — "find this person on Steam" link lets you
  add them on the external platform; we never proxy chat.

Friend requests are POST `/web/profile/friend/request` →
`/accept|/decline`. Anti-spam: cap 20 pending outgoing requests per
user, 24h cooldown after 5 rejected requests.

---

## 6. Achievements

### 6.1 Engine

Each achievement is a JSON record in a catalog file
`progression/achievements-catalog.js`. The engine processes the
`progressionEvent` stream against each entry's trigger spec and
updates progress counters.

```js
{
  id: 'clash.first-three-star',
  category: 'clash',
  title: 'Three-Star Raider',
  description: 'Land your first 3-star raid.',
  iconKind: 'star-3',
  rarity: 'rare',                  // common | rare | epic | legendary
  triggers: [
    { kind: 'clash.raid.won.3', countAtLeast: 1 },
  ],
  xpReward: 100,
  badgeId: 'three-star-raider',    // optional — awards the badge
  secret: false,                   // if true, hidden until earned
  seasonId?: null,                 // null = always-on; non-null = season-specific
}
```

Trigger spec is a small DSL:

- `{ kind, countAtLeast: N }` — fire event N times
- `{ kind, sumAtLeast: { metaField, value } }` — sum a meta field
- `{ kind, withMeta: { field: value } }` — fire with specific meta
- `{ allOf: [...] }` / `{ anyOf: [...] }` for compound triggers
- `{ withinDays: N }` — must happen inside a rolling N-day window

The engine is pure — given the event + the user's progress record + the
catalog, it computes the new progress record. No side effects until the
result is written back.

### 6.2 Storage

```
pach:<userId>            { unlocked: { achId: utc }, progress: { achId: counter } }
pach:counts:<userId>     { total, byCategory, byRarity }   // cached aggregate, recomputed on unlock
pach:catalog             (singleton — hot-swappable catalog cache)
```

`pach:<userId>` can grow modestly (~120 ach × 30 bytes each + 8 KB
overhead = ~12 KB at full unlock). Still well under the KV value
size limit (25 MB).

### 6.3 Initial catalog (~120 entries)

Organized by category. Each has an XP reward + optional badge.

**Identity + onboarding (8)**
- First Steps — daily check-in
- Found Your Class — pick a hero class
- Linked Up — link one external account
- Verified Trio — link Discord + Twitch + Steam
- Profile Curator — set bio + badge showcase + privacy
- 7-Day Streak — daily check-in 7 days in a row
- 30-Day Streak — 30 days
- 100-Day Streak — 100 days (legendary)

**Clash (25)**
- First Raid — any kind
- First 3-Star Raider — clear with 3 stars
- Defender — defend a town successfully
- Goblin Slayer — defend 10 goblin raids
- King Slayer — kill a Goblin King (Warband boss)
- Wyrm Slayer — kill a Wyrm
- Town Builder — build the Town Hall to L5 / L10
- Master Architect — build every E1 collector
- Master of Walls — own 25 walls in one town
- Defense Specialist — build one of every defense kind
- Trapsmith — build one of every trap kind
- Resource Tycoon — accumulate 100k of any single resource
- Repair Crew — repair 10 buildings
- War Hero — win 5 community wars
- ... (more)

**Boltbound (22)**
- First Match
- First Pack — open one
- Collector — collect 100 / 500 / 1170 cards (the full set)
- Legendary Pull — get a legendary from a pack
- Crafting Master — craft 10 cards from fragments
- Deck Architect — build 5 decks
- PvP Champion — 10 / 50 / 250 PvP wins
- Archetype Master — win 10 matches with each of aggro/control/midrange/burn/swarm
- Comeback King — win a match after dropping below 5 HP
- Speedrun — win in 5 turns or fewer
- ... (more)

**Board games (12)**
- First Move — play any board game
- Chess Initiate / Grandmaster (10 / 100 wins)
- Checkers / Connect 4 milestones
- Triple Threat — win one of each of the three games
- Streak — win 5 in a row
- ... (more)

**Quick games (12)**
- Lucky Number Seven — 7 wins in any quick game
- Big Win — payout > 10× stake
- Blackjack Pro — 50 blackjack wins
- Roulette Streak — win 3 in a row
- High Roller — single bet ≥ 1,000 bolts
- ... (more)

**Stocks + Betting (15)**
- First Trade — buy any stock
- Diversified — hold 5 different tickers
- Bull Market — portfolio crosses +20% PV
- First Bet
- Parlay Champion — win a 5-leg parlay
- Underdog Story — win a bet on a +200 line
- Touchdown — win an NFL bet
- ... (more)

**Stream + community (14)**
- Watching — accumulate 24 / 100 hours of watch-time
- Loyal Viewer — present for 10 / 50 streams
- Chatty — 1,000 chat messages
- Cheer — first cheer / 100 cheers
- Subscriber (links to Twitch + Patreon)
- ... (more)

**Pets (6)**
- First Friend — tame one
- Menagerie — tame 8 different species
- Legendary Pet — tame a legendary

**Cross-cutting + meta (6)**
- Polyglot — play every game type (Clash + Boltbound + board + quick)
- Renaissance Player — win at least once in every game
- Top of the Class — reach L25
- L50 — Veteran
- L100 — Living Legend (legendary)
- Achievement Hunter — unlock 50 / 100 achievements

### 6.4 Surfaces

- **Profile page** — full grid view with progress bars per achievement;
  secret ones hidden until earned (then revealed with a "you found me"
  flair).
- **Twitch panel** — recent-unlocks list on the panel home + a "next 5
  you're close to" hint card.
- **Discord** — `/loadout achievements` button on the menu shows your
  totals + last 5 unlocked. Unlock push notifications via the existing
  bot DM channel (opt-in mask).

### 6.5 Relationship to existing `aquilo/achievements.js`

The existing D1-backed system has ~25 entries focused on
engagement (first stream, first bolt, etc.). We **don't replace it** —
we **extend it**:

- The new progression catalog is **the superset**. Existing D1 entries
  are migrated into the new catalog with their original keys preserved
  so old unlocks still surface.
- The new engine writes to KV (`pach:<userId>`) for live progress
  tracking + the historical D1 table for the legacy "unlocked"
  history + role-grant logic which is already battle-tested.
- For the first 90 days post-launch both stores stay in sync. After
  that the D1 table becomes the historical archive and live tracking
  is KV-only.

---

## 7. Badges

### 7.1 What they are

Cosmetic small icons displayed on the profile + Twitch panel + (where
opted-in) chat. Earned from achievements + season-pass milestones +
tournaments + special events (anniversary, first-100 viewer, etc.).

Each badge has:

```js
{
  id: 'three-star-raider',
  name: 'Three-Star Raider',
  description: 'For the first time you cleared with three stars.',
  spritePath: 'progression/badges/three-star-raider.png',  // 64×64 PNG
  rarity: 'rare',
  category: 'clash' | 'boltbound' | 'season-s1' | 'tournament' | 'milestone' | 'special',
  source: 'achievement:clash.first-three-star' | 'season:s1:tier-25' | 'tournament:t-2026-w-13:1st' | ...,
}
```

### 7.2 Storage

```
pbadge:<userId>           { owned: [badgeId, ...],
                            firstEarnedUtc: { badgeId: utc },
                            showcase: [badgeId, badgeId, badgeId] }   // copy of pprofile.badgesShowcase
pbadge:catalog            (singleton — hot-swappable)
```

### 7.3 Display

- **Profile** — 3-slot showcase right under the level. User picks any
  three of their owned badges. Other earned badges visible in a
  "Trophy Cabinet" carousel below.
- **Twitch panel** — top-of-panel ribbon shows the 3 showcase badges
  next to displayname.
- **Discord** — opt-in: chat-name prefix is the first showcase badge's
  emoji-style glyph (via the existing Discord-emoji infrastructure).
  Per-server opt-out for admins who don't want the visual noise.

### 7.4 Earn paths

- **Achievement-linked** — most badges are tied to an achievement
  unlock (the achievement's `badgeId` field grants the badge).
- **Season-linked** — battle-pass tiers grant season-specific badges
  (Tier 10, 25, 50 = three badges per season).
- **Tournament-linked** — placement in tournaments grants
  tournament-flavoured badges (1st / 2nd / 3rd / Top 8 / Participant).
- **Special events** — manual-grant path via the admin web endpoint
  for ad-hoc rewards (first 100 viewers, anniversary, Clay's pick of
  the month).

### 7.5 Sprite generation

Same pipeline as the rest of the ecosystem — procedural HD pixel-art
PNGs at 64×64 generated by a new `tools/build-progression-sprites.ps1`,
stored at `aquilo-gg/sprites/progression/badges/`. The badge sprite
list is locked when the catalog is locked — pure data, regenerable
from scratch.

---

## 8. Seasons / Battle pass

### 8.1 Cadence

90-day seasons. Four per year. Season ID format `s2026-q3` etc.

Each season has:

- **Theme** — a flavour name + colour palette + signature badge
  silhouette.
- **50 tiers** of rewards.
- A **free track** and a **premium track**. Premium is unlocked
  for any active Patreon link (any tier — same gate as the existing
  free-lootbox stipend).
- **One season-specific tournament series** (§9) culminating in the
  last week.
- **2 unique badges** per season minimum (one mid-tier, one max-tier).

### 8.2 Tier rewards

Tiers cost 1,000 XP each linearly (50 tiers × 1,000 = 50,000 XP =
~330 days of casual play to clear max-tier — so a committed
weekly player clears mid-tier easily, only daily-engaged players
clear max-tier; tunable).

Each tier offers reward(s):

| Tier band | Free track | Premium track |
| --- | --- | --- |
| 1–10 | Wallet bolts (small) | + bolts (2×) + 1 fragment |
| 10 | Season badge (mid) | Season badge (mid) + flair frame |
| 11–24 | More bolts | + fragments + a free Boltbound pack |
| 25 | Title unlock ("Aspirant of <Season>") | Title + premium-only badge |
| 26–49 | Bolts + fragments | Bolts (2×) + fragments + lootbox roll |
| 50 | Season badge (max) | Season badge (max) + named cosmetic frame |

Rewards are intentionally bolts/fragments-heavy because we already
have currencies for those — no new SKUs. The badges + titles +
frames are the genuinely-new earnable cosmetics.

### 8.3 Storage

```
season:active                         { seasonId, startUtc, endUtc, themeRef, rewardsTable }
season:archive:<seasonId>             same shape, historical
pseason:<userId>                      { seasonId, xp, tier, claimedFree: bitfield, claimedPrem: bitfield, premium: bool }
pseason:claim:<userId>:<seasonId>     (TTL on season-end + 30d so re-roll detection works)
```

`pseason:<userId>` resets every season. Past seasons are queryable
via `season:archive:<seasonId>` + the user's recent activity ring.

### 8.4 Rollover

Cron runs on the existing `:23 hourly` slot. At each tick:

- If `now > season:active.endUtc`, advance to next season:
  - Move `season:active` to `season:archive:<previousId>`.
  - Generate `season:active` from a planned next-season template
    (Clay locks templates ~30 days in advance).
  - Mark every `pseason:*` as expired (lazy — no fanout walk
    required; profile loads detect and migrate).
  - Fire a season-end push to every opted-in viewer.

### 8.5 Catch-up

Final 7 days of a season: XP grants get a 1.5× multiplier across the
board ("season catch-up week"). Stops the FOMO spiral for late
joiners and gives committed players a finale to push for max tier.

### 8.6 Season-specific challenges

Beyond the 50-tier XP track, each season has 10 unique
"season challenges" (e.g. "Win 25 Boltbound matches with aggro decks
this season") that grant bonus XP + the seasonal mid-tier badge fast-
path. These are achievements with `seasonId` set, expire at season
end, and re-appear if the same template runs in a future season.

---

## 9. Tournaments

### 9.1 What and which games

Cross-game competitive events. Four games are tournament-eligible:

- **Boltbound** — best-of-3 bracket with random deck constraints
  ("only standard rotation", "starter decks only", "no legendaries").
- **Board games** — single round-robin or single-elim per game; chess
  / checkers / connect 4 each get their own bracket.
- **Clash** — leaderboard ladder over a 72-hour window (most stars
  gained in raids during the window wins; goblin raids excluded so
  it's all PvP / NPC).
- **Quick games** — leaderboard over 24-72 hours; cumulative bolts won
  in a single game type (blackjack tournament, plinko tournament,
  etc.). Bolts at stake are not lost — it's a pure leaderboard.

Stocks / betting are deliberately excluded: external feeds make
deterministic competition hard, and the betting cycle is already
weekly.

### 9.2 Random scheduling

The cron tick rolls a "should we spawn a tournament" check each day:

- Base probability **15% per day** when no tournament is live.
- Floor: **at least one tournament per 14 days** (forced spawn).
- Ceiling: **at most one tournament live at a time** per game type
  (so Boltbound + board games + Clash could overlap).
- Duration: 2–4 days (length picked at spawn time from the format
  table).
- Game type: weighted by current player counts in that game — Boltbound
  gets more weight than board games early on, retuned monthly.

Result: viewers see ~2-4 tournaments per month, spread across game
types, with enough randomness that they can't be game-planned around
work schedules.

### 9.3 Sign-up

`/web/tourn/<tournId>` is the sign-up page. Available on the website
+ Twitch panel + a Discord `/loadout tournaments` menu button. Sign-ups
open 24 hours before tournament start; close at start time.

Free entry for everyone (no bolts gate — we don't want to make
tournaments a Patreon-gate). Patreon viewers get a 24h early sign-up
window for slot-limited tournaments (cap of 64 for brackets).

### 9.4 Format details

**Brackets (Boltbound + board games):**
- Single-elim, best-of-3 (Boltbound) or best-of-1 (board games).
- 64-player cap. Random seeding (no XP-based seed for the first season — we tune
  after data lands).
- Matches scheduled in 1-hour windows; if a player no-shows after
  15 minutes, opponent advances.
- Live bracket view on the profile + Twitch panel.

**Ladders (Clash + Quick games):**
- No bracket — score-based leaderboard over the duration.
- Top 10% earn the participant badge; top 3 earn placement badges.
- Anti-grind: cap on counted matches per day (e.g. 20 quick-game
  hands counted per day toward the tournament).

### 9.5 Rewards

Reward weight is proportional to the tournament difficulty:

| Format | 1st | 2nd | 3rd | Top 8/10% | Participant |
| --- | --- | --- | --- | --- | --- |
| Bracket | 500 XP + 1st badge + 5,000 bolts | 250 XP + 2nd badge + 2,500 bolts | 150 XP + 3rd badge + 1,000 bolts | 100 XP + top-8 badge + 500 bolts | 25 XP + participant badge |
| Ladder | 300 XP + 1st badge + 3,000 bolts | 150 XP + 2nd badge + 1,500 bolts | 100 XP + 3rd badge + 750 bolts | 50 XP + top-10% badge + 300 bolts | 25 XP + participant badge |

Tournament XP **doesn't** count toward the daily 500-XP soft cap (so
winning a tournament is a real bump). Badges + bolts are direct
grants.

### 9.6 Storage

```
tourn:active:<game>                   { tournId, format, startUtc, endUtc, signupEndsUtc, state, participants, brackets/scores }
tourn:archive:<tournId>               same shape, historical
ptourn:<userId>:<tournId>             { signedUpUtc, matches: [...], placement?, rewards?: {...} }
```

`tourn:active:<game>` is keyed by game so the dispatcher can answer
"is there a Boltbound tournament right now?" in O(1).

### 9.7 Surfaces

- **Website** — `/play/tournaments` index + per-tournament page
  showing bracket, ladder, sign-ups, your matches.
- **Twitch panel** — a "Tournament" tab when one's live for the game
  currently being played on stream.
- **Discord** — sign-up confirmation + match reminders via DM; a
  channel announcement at tournament start + end.

---

## 10. Cross-cutting

### 10.1 KV layout summary

| Prefix | Purpose | Approx size per key |
| --- | --- | --- |
| `pprofile:<userId>` | Profile record | ~3 KB |
| `pprofile:handle:<safeKey>` | Handle reservation | ~30 bytes |
| `plink:<platform>:<externalId>` | Reverse link index | ~30 bytes |
| `pxp:<userId>` | XP + level + daily counter | ~80 bytes |
| `pxp:table` | Hot-swappable grant table | ~5 KB (singleton) |
| `pevents:<userId>` | Last-32 event ring | ~3 KB |
| `pevent:dedup:<identity>` | 24h dedup marker | ~10 bytes (TTL) |
| `pach:<userId>` | Achievement progress + unlocks | ~12 KB at full unlock |
| `pach:counts:<userId>` | Cached aggregate counts | ~300 bytes |
| `pach:catalog` | Catalog singleton | ~50 KB (singleton) |
| `pbadge:<userId>` | Owned badges + showcase | ~2 KB |
| `pbadge:catalog` | Badge catalog | ~30 KB (singleton) |
| `season:active` | Active season config | ~20 KB |
| `season:archive:<seasonId>` | Historical season | ~20 KB |
| `pseason:<userId>` | User's season progress | ~200 bytes |
| `tourn:active:<game>` | Live tournament | varies (up to 100 KB during bracket) |
| `tourn:archive:<tournId>` | Historical tournament | ~50 KB |
| `ptourn:<userId>:<tournId>` | User's tournament participation | ~500 bytes |

Hot keys (`pxp:*`, `pprofile:*`, `pach:*`) all small + targeted to a
single userId so reads are cheap. Catalog singletons cached
per-instance for the cron interval; cold-load fetch is ~50ms each
worst case.

### 10.2 HTTP route map (new)

```
GET  /p/<userId>                         public profile page (HTML or JSON)
GET  /web/profile/<userId>               profile JSON (HMAC) — used by Discord-OAuth web client
GET  /web/profile/<userId>/stats         all-features stats aggregate
POST /web/profile/me/bio                 update bio + privacy + showcase
GET  /web/profile/link/start             begin OAuth/OpenID flow
GET  /web/profile/link/callback          OAuth callback handler
POST /web/profile/link/manual            manual platform link (PSN etc.)
POST /web/profile/link/remove            remove a link
POST /web/profile/friend/request         friend request
POST /web/profile/friend/accept          accept incoming
POST /web/profile/friend/decline         decline incoming

GET  /web/xp/<userId>                    XP + level + daily counter
GET  /web/xp/leaderboard                 top by level / top this season

GET  /web/achievements/<userId>          progress + unlocks
GET  /web/achievements/catalog           full catalog (cached)
GET  /web/badges/<userId>                owned badges
GET  /web/badges/catalog                 catalog

GET  /web/season/active                  active season config + tier table
GET  /web/season/<userId>                user's season progress
POST /web/season/<userId>/claim          claim a tier reward

GET  /web/tournaments                    index of active + recent tournaments
GET  /web/tournaments/<tournId>          full tournament state
POST /web/tournaments/<tournId>/signup   sign up (HMAC)

GET  /ext/profile, /ext/xp, /ext/season, /ext/tournaments    Twitch panel reads (JWT-gated)
```

### 10.3 Event-bus integration points

The single line each feature adds:

```js
// In clash.js after a raid resolves:
await emitProgressionEvent(env, {
  kind: sim.stars === 3 ? 'clash.raid.won.3' : sim.stars === 2 ? 'clash.raid.won.2' : sim.stars === 1 ? 'clash.raid.won.1' : 'clash.raid.played',
  userId, guildId,
  meta: { raidId, stars: sim.stars },
});
```

The emit point is **just after** the feature's own state-write
completes successfully. Failed emits never block the feature — the
bus call is fire-and-forget with a try/catch wrapper.

### 10.4 Cron use

Piggybacks on the existing `:23 hourly` slot. New work:

- Season rollover check (Os).
- Tournament spawn-check (small RNG roll).
- Tournament live-state advance (resolve no-shows, advance brackets).
- XP grant-table reload (every hour from `pxp:table` KV).
- Achievement catalog reload (every hour from `pach:catalog`).
- Daily cap reset for `pxp:<userId>.dailyXp` (handled lazily on next
  grant when `ymd` changes — no fanout).
- Ladder finalisation for ending tournaments.

Cloudflare free-plan limit (5 crons; we're at 4) keeps a slot in
reserve if any of this needs its own cadence later — but the design
explicitly fits inside `:23`.

---

## 11. Anti-abuse

### 11.1 XP grinding

- **Daily 500 XP soft cap** with diminishing returns after.
- **Per-event-kind caps** (chat capped at 25 msgs/day, equip-actions
  capped at 10/day, etc. — see §4.2).
- **Idempotency via dedup identity** — a `raidId` is the stable key for
  Clash; replaying it grants XP zero times.
- **Sock-puppet detection** — feature already has the
  `Clay-Twitch-channel-only` gate; we extend by counting Discord
  account-creation date and Twitch account-creation date when
  awarding the *first* L10 milestone XP. Brand-new accounts get a
  "verification pending" hold for 7 days before back-grant.
- **Chat XP requires unique messages** — message hash dedup within a
  rolling 5-minute window so spamming "yo" 25× doesn't farm.
- **Stream-watch XP requires real Twitch presence** — we already
  verify Twitch panel JWT for the panel surface; we check that the
  Twitch user is currently in the channel viewer list (via Helix
  API, cached 1 minute) before granting the 15-min XP tick.

### 11.2 Tournament abuse

- **Verified Steam link required** for placing in any bracket
  tournament (top 3). Removes most sockpuppets — we have the Steam
  reverse-index to enforce one-Steam-per-Aquilo and one-Aquilo-per-
  Steam.
- **Bracket integrity** — anti-collusion check on best-of-3 results:
  if both players have a Steam profile flagged friends-with-each-other
  AND one concedes <2 minutes after start, the match is reviewed.
- **No-show penalty** — 3 no-shows in 30 days = 30-day tournament ban.

### 11.3 Badge / cosmetic gaming

- **Server-side ground truth** — the showcase array is validated
  against `pbadge:<userId>.owned` on every profile save. No way to
  showcase a badge you don't own via API tampering.
- **Profanity filter** on bio (existing `maskProfanity()` in ext.js)
  + displayname (already gated at Discord).

### 11.4 Account-linking abuse

- **One external account per Aquilo profile** per platform. Reverse
  index `plink:<platform>:<externalId>` blocks duplicate linking.
- **Removal cooldown** — 24h after removing a link before relinking
  the same external id (catches "swap Steam between profiles to
  game tournament rewards").

---

## 12. Build phasing

Each phase is a shipping unit; do not start phase N+1 until N is in
viewers' hands.

### Phase P1 — XP backbone (week 1)

The smallest viable system. No surface yet — just the spine.

- `progression/event-bus.js` — `emitProgressionEvent` + dedup + ring
  buffer.
- `progression/xp-table.js` — hot-swappable grant table.
- `pxp:<userId>` storage layer.
- Wire emit calls into every feature's success path. (~10 modules,
  ~1 line each)
- Cron hot-reload of `pxp:table`.

Smoke test: emit a `clash.raid.won.3` event → verify `pxp:<userId>`
grows by 50.

### Phase P2 — Profile read surface (week 2)

- `pprofile:<userId>` data model + `getStatsFor` contract on every
  feature.
- `/web/profile/<userId>`, `/web/profile/<userId>/stats` endpoints.
- `/p/<userId>` HTML page (server-rendered, no client framework yet).
- Discord menu button → profile link.
- Twitch panel link.

Shippable: viewers can see a real profile page with their level + stats.

### Phase P3 — Achievements (week 3)

- `pach:<userId>` storage.
- Catalog of ~80 achievements (initial set; lock the catalog after
  Clay sign-off).
- Engine + trigger DSL.
- Migration of D1 achievements into the catalog with old keys
  preserved.
- Profile page achievement section.
- Push notification on unlock (via existing Clash push gateway —
  rename it to "progression push" internally).

### Phase P4 — Badges (week 3 partial)

- Badge catalog + sprite pipeline (`tools/build-progression-sprites.ps1`).
- Showcase selector on profile edit page.
- Twitch panel ribbon.
- Discord glyph prefix (opt-in).

### Phase P5 — Account linking (week 4)

- Steam OpenID flow (lowest friction; one-time API key).
- Epic OAuth flow (one-time dev portal reg).
- Manual entry for PSN / unsupported.
- `plink:*` reverse index + dedup.
- Profile linked-accounts row.

### Phase P6 — Seasons (week 5-6)

- `season:active` + tier table data model.
- Battle pass UI on profile + dedicated `/play/season` page.
- Claim mechanism.
- Cron rollover.
- Patreon-link gate for premium track.
- First season templates locked (3 of them, ~12 months ahead).

### Phase P7 — Tournaments (week 7-8)

- Brackets + ladder backends per game type.
- Random-spawn scheduler in cron.
- Sign-up surface (web + Twitch + Discord).
- Live bracket renderer.
- Reward grant flow.
- Anti-abuse plumbing (Steam-link requirement, no-show penalty).

### Phase P8 — Anti-abuse tightening + telemetry (week 9)

- Per-event-kind daily caps fully enforced.
- Sock-puppet first-week hold.
- Stream-watch XP gated on Helix presence check.
- Dashboard for Clay showing top XP earners + suspicious patterns.

Total: ~9 weeks of focused work. Ship surfaces as they're ready;
P1+P2 land in two weeks and immediately give every viewer a level +
profile, which is the moment Clay can announce the system on stream.

---

## 13. Open questions for Clay

A handful of decisions need Clay's call before P1 starts. I've
defaulted the design where I could; these are the ones that materially
change the feel of the system.

1. **XP curve calibration target.** I designed for "an engaged daily
   viewer hits L10 in month one, L50 in a year". Is that too fast?
   Too slow? If it's too fast we triple the early-level XP cost;
   if too slow we halve the late-game cost. Defaulting to the
   middle calibration above.

2. **Premium battle pass via Patreon — any tier, or tier-gated?** I
   defaulted to "any active Patreon link unlocks premium" because that's
   the existing free-lootbox gate. Clay may want premium gated to the
   $5+ tier specifically. (No transaction surface either way — but a
   tier check is one extra env var.)

3. **Cross-game leaderboard prominence.** Profile leaderboards (top
   level / top season tier / top tournament wins) are easy to add
   to the website. Worth a dedicated `/leaderboards` page or fold
   into existing `/clash` and `/play` pages?

4. **Server-scoped vs account-wide profile.** The design defaults
   account-wide (one profile across every guild). But Clay runs
   multiple servers — should there be a "this player on Clay's main
   server" view that scopes stats to just one guild, like a "career
   on this team" tab? Default: no, keep it simple. Easy to add later.

5. **Achievement secrecy.** Are secret achievements (hidden until
   earned) fun or annoying? I included a few (~5%); could go to 0%
   or to 20%. Defaulting to ~5%.

6. **Tournament prize ceiling.** Top-of-bracket reward is 5,000
   bolts. The Clash treasury caps + Boltbound pack costs are in
   the same range, so 5,000 isn't trivial but also doesn't
   destabilise the economy. Is that the right number, or do we
   want bracket rewards to feel more like "winning is its own
   reward, the bolts are token"? Default: 5,000.

7. **Friend list visibility.** Currently friend list is private to
   each user. Should viewers be able to see "your friend [X]
   reached L25 today"? Default: opt-in (off by default).

8. **Account linking — which platforms first?** I sequenced
   Steam → Epic → Xbox → others. Steam is highest-impact for
   "find this person to add as friend". Defaulting to Steam first;
   Clay may want a different order if his community plays mostly
   on a different platform.

9. **Season-end "wipe" feel.** Pure-XP track (the 50-tier battle
   pass) wipes every season — that's the point of a season. Should
   *unlocked badges* from a season stay in the cabinet forever?
   Default: yes — badges are forever, even if the season's
   currencies/titles aren't.

10. **Tournament eligibility — open to everyone or level-gated?**
    Defaulted to open to everyone (no level gate). Could gate
    bracket tournaments to L5+ to reduce sockpuppet flood. Default:
    open.

11. **Profile bio length and edit cadence.** Defaulted 200 chars
    + unlimited edits + profanity-filtered. Could lock edit cadence
    to once-per-day if abuse rises. Default: unrestricted.

12. **Initial achievement catalog size.** I sketched ~120; could
    go to ~80 for a leaner launch. Default: ship the full ~120 in P3.
