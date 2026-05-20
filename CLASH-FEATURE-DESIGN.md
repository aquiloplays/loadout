# Clash — Communal Town & Global Raiders for Loadout

> Status: **design signed off — Phase 1 building.** Multi-phase plan. Phases
> are shipping units; do not start phase N+1 until N is in viewers'
> hands.
>
> Author: Loadout team · Date: 2026-05-20 · Owner: Clay
>
> Verbatim ask (Clay, v1):
> *"Can we also create a new feature in Loadout that is a version of
> Clash of Clans tied to the RPG dungeon crawler? People can build
> their own towns, upgrade them, get units and raid other bases (NPC
> and other players), there are cooldowns for builds and troop
> trainings. Bolts is the economy."*
>
> Verbatim revision (Clay, v2):
> *"Let's have a per-streamer town that everyone contributes to and
> other streamers' viewers can vote to raid the other streamer's
> towns. Individual viewers will always be raiding towns globally,
> not just in one community."*
>
> Plus: cosmetic-only Patreon perks; ambient (no seasons); NPC towns
> + goblin camps as PvE; PWA push notifications wired to the existing
> aquilo.gg push pipeline; Voltaic loot set name confirmed.

---

## 1. Guiding principles

The v1 model gave every viewer their own little base. Clay's revision
flips this — and it's a better design. The new model:

- **One communal town per streamer.** Every viewer in that channel
  contributes Bolts to upgrade it, train its garrison, defend it.
  The streamer (and mods) decide *what* to build. The town is the
  shared identity of that community in the Clash world.
- **Defense is communal, offense is individual.** Each viewer keeps
  their own personal army, their own dungeon hero, their own Voltaic
  loot. When they go raiding, they raid *globally* — they can hit
  any town, anywhere, including towns in completely unrelated
  channels.
- **Two raid lanes:**
  1. **Solo raids** — a viewer attacks an NPC town, a goblin camp, or
     a real streamer's town. Always-on, individual progression.
  2. **Community-vs-community wars (Phase 2)** — Streamer A's chat
     votes to declare a war on Streamer B's town. During the war
     window, raids between the two communities are amplified and
     scored cumulatively. A way to turn rivalries between streamers
     into shared events.
- **Bolts stays Bolts.** Personal wallet still owns your spendable
  Bolts. Communal towns have a separate **town treasury**; viewers
  donate Bolts from personal → treasury. Raids redistribute Bolts
  but never mint them (same rule as v1).
- **One hero, everywhere.** A viewer's dungeon hero deploys as their
  raid Champion. Levelling the hero in dungeons makes them a better
  raider in Clash. Levelling the hero through Clash earns dungeon XP.
  Mutual reinforcement — that's the whole point of plugging this
  into the existing system.
- **Per-streamer-channel scope.** Town state, treasury, and garrison
  are scoped to one channel (one `guildId`). But the **raid graph is
  global** — a viewer in channel X can raid the town in channel Y
  freely, and the loot flows accordingly. This is the part of the v1
  doc that fundamentally changes: there's no longer a per-channel
  "Clash universe" — there's a single global Clash world where each
  channel owns one tile of the map.

Everything below follows from those.

---

## 2. The two things — town vs. raider

Two distinct game objects, deliberately separated. A viewer interacts
with both, but they're not the same record.

### The **Town** (one per streamer)

A communal structure, configured by the streamer + mods, paid for by
the community's pooled Bolts.

- **Buildings**: town hall, walls, defensive towers (cannons, archer
  towers, traps), storage buildings (treasury capacity), barracks
  (garrison training capacity).
- **Garrison army**: defending troops trained into the town. Drawn
  from the treasury, not from any individual's personal army.
- **Treasury**: pool of Bolts + Scrap + Cores held by the town.
  Bolts come from viewer donations; Scrap + Cores come from
  successful defenses, NPC raids done in the community's name, and
  goblin loot tribute.
- **Layout**: building positions on a grid (drives attack pathing).
  Streamer/mods own this.
- **Trophy / Prestige**: the town has its own prestige score; wins
  on defense earn it, losses cost it. Drives the global "Town
  Power" leaderboard.

### The **Raider** (one per viewer)

Personal, individual progression. Owned by the Discord/Twitch user.

- **Hero**: their existing `HeroState` from the dungeon system.
  Same level, same gear, same class. Deploys as Champion when they
  raid.
- **Personal army**: troops they've trained with their own Bolts.
  Sits in their personal barracks. Consumed on raid (you train more
  to refill).
- **Personal trophies**: their position on the global raider
  ladder. Independent from the town's prestige.
- **Raid tokens**: 4 per slot, regen 1/4h. Caps how often they can
  raid (anti-spam).
- **Voltaic loot bag**: cosmetic + functional gear pieces dropped
  from raids and goblin camps. Plug into the existing hero gear
  slots.

A streamer is also a viewer of their own community — they can train
their own personal army and raid other towns. Their hero is their
own. The town they belong to is automatically their own town. So
their "raid me back" interaction is naturally implemented: you're
raiding the streamer's town, but the streamer's personal raider
identity is something else entirely.

---

## 3. Data model + storage

All Clash state lives in the existing `LOADOUT_BOLTS` KV namespace,
under a new `clash:` prefix family. Same merge contract as the
existing dungeon: DLL canonical for stats that affect on-stream UX
(prestige, trophies, recent raid log); Worker canonical for live edits
viewers make off-stream.

### KV layout

| Key | Value | Owner of writes |
| --- | --- | --- |
| `clash:town:<guildId>` | `TownState` JSON | streamer/mods via `/clash town …` |
| `clash:treasury:<guildId>` | `{ bolts, scrap, cores, capacity }` | donations + raid resolver |
| `clash:queue:<guildId>` | town build + garrison-training queue | streamer/mods |
| `clash:army:<guildId>:<userId>` | personal army troop counts | raider |
| `clash:trainq:<guildId>:<userId>` | personal training queue | raider |
| `clash:trophies:<guildId>:<userId>` | `{ trophies, tier, peak }` | raid resolver |
| `clash:prestige:<guildId>` | `{ prestige, tier, peak }` | raid resolver |
| `clash:contributions:<guildId>:<userId>` | running totals of bolts donated to home town | donation handler |
| `clash:raid:<raidId>` | `RaidReceipt` JSON (replay log, loot, when) | raid resolver |
| `clash:raidlog:<guildId>` | last 50 raid IDs against this town | raid resolver |
| `clash:raidlog:<guildId>:<userId>` | last 50 raid IDs by this raider | raid resolver |
| `clash:def-snapshot:<guildId>` | frozen town snapshot for offline raids | mutation triggers |
| `clash:shield:<guildId>` | `{ endsAt, reason }` if town is shielded | raid resolver |
| `clash:mm:tier:<tier>` | sorted set of `guildId` by prestige (global) | scheduled re-bucket |
| `clash:npc:town:<seed>` | deterministic NPC town | generator |
| `clash:npc:goblin:<seed>` | deterministic goblin camp | generator |
| `clash:war:<warId>` | community-vs-community war record (Phase 2) | war handler |
| `clash:exclude` | array of identifiers excluded from all leaderboards | static (see §10) |
| `clash:notify:<guildId>:<userId>` | per-event push-notification opt-ins | viewer toggle |

### TownState shape (sketch)

```
{
  thLevel: 1..10,                 // town hall — gates everything
  prestige: { score, tier, peak },
  buildings: [
    { id, kind, level, x, y, hp,
      status,                     // 'idle' | 'building' | 'damaged'
      endsAt? }                   // present when 'building'
  ],
  garrison: { troopId: count, ... },
  layoutVersion: 17,              // bumped on edit -> invalidates snapshots
  ownerUserId,                    // streamer's Discord ID (write-gate)
  modUserIds: [...],              // can also write
  topContributors: [              // cached, refreshed daily
    { userId, lifetimeBolts, place }
  ],
  customisation: {                // Patreon-cosmetic-only flair
    wallSkin, towerSkin, bannerEmoji
  },
  createdUtc, lastUpdatedUtc
}
```

### Resource model

Three resources, deliberate:

- **Bolts** — the brand currency. Sources: existing economy (daily
  payout, channel rewards). Clash never mints them. Sinks:
  personal training, town donations, skip-cooldown spends.
- **Scrap** — generated. Drops from successful raids (PvE + PvP),
  used for town buildings and personal troop unlocks. Hot resource.
- **Cores** — generated, scarce. Only from NPC fortresses, goblin
  hoards, and rare PvP raid drops. Gates top-tier buildings and
  endgame troops.

Net effect on Bolts circulation: same as v1 — Clash is a sink (via
donations + training + cooldown skips), redistribution layer for
PvP loot (transfer not mint), and Scrap/Cores are minted because
they're not the brand currency.

---

## 4. Cooldowns

Same model as v1: pure timestamp-based, no background tick. Each
queued build/troop has `endsAt`; route handlers walk the queue on
read and complete anything that's expired. This is the same pattern
the wallet's 23-hour daily payout already uses (`games.js:62–93`).

Calibrated to the existing economy (~700 Bolts/day at a 7-day
streak):

| Action | Bolts | Wall-clock |
| --- | --- | --- |
| Town: TH 1 → 2 | 1 200 (treasury) | 30 min |
| Town: TH 3 → 4 | 7 000 (treasury) | 6 h |
| Town: TH 6 → 7 | 45 000 (treasury) | 24 h |
| Town: TH 9 → 10 | 220 000 (treasury) | 5 days |
| Town garrison troop, common | 80 (treasury) | 2 min |
| Town garrison troop, epic | 4 000 (treasury) | 2 h |
| Personal troop, common (Scrapper) | 8 (personal) | 30 s |
| Personal troop, rare (Bolt Knight) | 220 (personal) | 12 min |
| Personal troop, epic (Voltaic Mage) | 950 (personal) | 90 min |
| Skip cooldown | 1 Bolt/minute | — |

Town numbers are heavier because the cost is amortized across many
viewers. A 50-viewer community at modest engagement easily clears
TH 6 in a couple weeks. A streamer with 5 active viewers will take
much longer — that's intentional; the town is the visible expression
of community size.

Personal numbers are unchanged from v1 — the same individual loop.

Build queue slots scale with TH; one slot at TH1, three at TH8.
Skip-cooldown hard-capped at 240 min/day per *town* (not per viewer),
so a single whale viewer can't blast the town through five tiers in
an afternoon.

---

## 5. Raiding — solo, NPC, and (Phase 2) wars

### 5.1 Solo raids (the always-on lane)

A viewer can raid:

- **Goblin camp** — cheap, no cooldown floor, no trophy stakes.
  Tutorial + grind target. Drops Scrap + chance of common Voltaic.
  Always generated fresh.
- **NPC town** — seeded from `clash:npc:town:<seed>`, scaled to the
  attacker's hero level. Costs 1 raid token. Drops Scrap + Cores +
  Voltaic chance. Small trophy gain on win, no loss on defeat.
- **Real player's town** — matchmaking via `clash:mm:tier:<tier>`,
  pulled within ±150 prestige of the attacker's *personal* tier
  (not their home town's tier). Costs 1 raid token. Trophy stakes
  meaningful both ways. Loot taps the defending town's treasury,
  capped at 20% with a hard ceiling.

### 5.2 Matchmaking

When a viewer attacks a real town:
- Pull `clash:mm:tier:<viewer-tier>` ± a band, exclude shielded
  towns, exclude towns in the viewer's home channel (no
  intra-community raids — those happen via Phase 2 wars).
- Exclude any guildId or userId on the `clash:exclude` list.
- If no human match available, fall back to a same-tier NPC town —
  no "no target" failure state.

### 5.3 Offline defense

Defense always uses `clash:def-snapshot:<guildId>`, refreshed when:
- A building finishes upgrading
- A garrison troop is trained
- Streamer/mods change the layout
- A new top contributor cracks the top 5 (so banner cosmetics
  refresh)

The snapshot freezes: buildings + positions + levels, garrison
troops, layout version. The attacker plays against the snapshot —
the defending streamer is never "live." Deterministic given (snapshot,
attacker army, hero loadout, RNG seed). Seed = raidId so the replay
is reproducible.

### 5.4 Resolution

Server-side, single Worker handler, ~50 ms. Produces a `RaidReceipt`:

```
{ raidId, attackerUserId, targetGuildId, attackerHomeGuildId,
  startedUtc, durationMs, log: [...], starsEarned,
  lootBolts, lootScrap, lootCores, trophyDelta, prestigeDelta }
```

`log` is a compact event list (`("attack", troopId, buildingId, dmg, t)`)
— enough to drive a replay UI without storing physics state. Replay
is small enough (a few KB) to keep 30 days in KV.

### 5.5 Loot economics — solo raid

- **Bolts**: 100% to attacker's personal wallet. Voluntary donation
  to home town treasury via `/clash donate` after.
- **Scrap + Cores**: 100% to attacker.
- **Voltaic loot drop**: rolled per raid based on target tier and
  star count. Goes to attacker's hero inventory.

The defender's loss flows out of the town treasury, never out of
individual wallets. So the visible cost of a successful raid is
borne by the *community*, not by any single viewer. Streamers feel
this as a reason to defend, not a personal sting.

### 5.6 Community-vs-community wars (Phase 2)

Skeleton, deferred to Phase 2:

- Streamer A's chat (or Discord) votes to declare war on streamer B's
  town. Same vote pattern as the existing `dungeon.recruiting` event.
- B's community receives the declaration via PWA push + Discord ping.
  B's chat votes accept/refuse.
- On accept: 24h war window. Both communities' viewers can raid the
  *opposite* town with bonus trophies + bonus Voltaic chance. Loot
  caps are temporarily lifted to 30%. A war scoreboard tracks
  cumulative damage by each side.
- War winner: town gets a 7-day "Victorious" cosmetic banner +
  Cores tribute to the treasury.
- War loser: no shield post-war (so revenge raids are legal), no
  prestige loss beyond the regular raid-by-raid losses.

Voting + scheduling reuses the existing dungeon vote mechanic
infrastructure (`DungeonModule.cs` recruitment timer pattern). War
state lives at `clash:war:<warId>`.

---

## 6. Tie-in to the dungeon crawler

The integration that makes this one product instead of two:

- **Hero deploys as Champion.** Same `HeroState`, same level, same
  gear, same set bonuses. Class shapes role: warrior tanks, mage
  AoE, ranger picks off air defences, rogue burst-kills high-value
  buildings, healer passive party heal.
- **Defense champion (Phase 2+).** Towns can build a "War Tent"
  building that lets the streamer designate one viewer's hero as
  the town's defending Champion (rotating duty, opt-in). Adds a
  human-level fight to defense. Phase 1 ships without this — town
  defends with garrison only.
- **Cross-progression.**
  - Successful raid: dungeon XP (small) + Voltaic drop chance.
  - Dungeon completion: chance of a Clash-themed "Battle Plan" item
    that gives the town a one-time build-time skip.
- **Hero level gates.**
  - Personal raids: hero L1 unlocks goblin camps, hero L3 unlocks
    NPC towns, hero L8 unlocks PvP raids.
  - Town tiers: TH4 needs at least one community member at hero L10,
    TH7 needs L20, TH10 needs L30. Forces the community to
    collectively engage with dungeons for endgame town power.

---

## 7. Where players interact

| Surface | Audience | What | Phase |
| --- | --- | --- | --- |
| Discord `/clash` slash command | viewers + streamers | base view, raid, donate, train army, status | 1 |
| Discord `/clash town …` (admin) | streamer + mods | build, garrison-train, layout edit, war declare | 1 (war = 2) |
| Twitch panel | viewers | read-mostly: town status, recent raid feed, leaderboards | 4 |
| `loadout.aquilo.gg/clash` (web) | streamers | drag-and-drop layout editor; recommended primary edit surface for layout | 4 |
| OBS browser source overlay | stream audience | live raid alert toasts during a stream | 4 |
| **PWA push** (aquilo.gg) | opted-in viewers + streamers | see §8 | 1 |

---

## 8. PWA push notifications

Wire into the existing aquilo.gg push pipeline (the one that fires
when a streamer goes live — `aquilo-site` repo, `/api/push/*` + the
push worker). Clash payloads use the same envelope, just new event
kinds.

### Event types

| Event kind | Audience | Trigger |
| --- | --- | --- |
| `clash.raid.incoming` | streamer + opted-in top-10 contributors of the town | a raid against `clash:town:<guildId>` is queued |
| `clash.raid.lost` | same | town defended, attacker scored 0–1 stars |
| `clash.raid.won` | same | town was sacked (attacker scored 2+ stars) |
| `clash.raid.result` | attacker | their solo raid resolved (win or loss) |
| `clash.build.complete` | viewer or streamer who queued it | a queued build or troop train finishes |
| `clash.war.declared` | both communities' streamers + opted-in viewers | war declared (Phase 2) |
| `clash.war.ended` | same | war window closed (Phase 2) |
| `clash.shield.expiring` | streamer | town's shield ends in 1h (so they can prep defense) |

### Subscription model

- Viewers opt in per event kind via `/clash notify`. Stored at
  `clash:notify:<guildId>:<userId>` as a bitmask.
- Streamers are auto-subscribed to every event affecting their town
  on first town-creation, with a one-click toggle to mute.
- Each notification deep-links to the relevant Clash UI surface:
  Discord ephemeral for the receipt, web for the replay, panel
  for the live raid view.

### Integration shape

The Loadout Worker calls a new internal route on the aquilo-site
push worker — `POST /api/push/clash` with HMAC-signed payload
(reusing the existing stream-online sign secret pattern). Push
worker handles the actual web-push fanout to subscribed PWA
clients.

---

## 9. Anti-abuse

- **Raid tokens** §2: 4 per viewer, regen 1/4h. Hard cap on raid
  frequency.
- **Town shields**: 12 h after a 2+ star defeat, 6 h after a 1-star
  defeat, none for a 0-star defeat. Shield breaks if any community
  member of the shielded town attacks anyone else.
- **Trophy decay**: 1 trophy/day per 100 above tier cap for
  individual raiders. Prestige decay for towns above their TH cap
  band.
- **Loot cap** §5.5: 20% of defending treasury per raid, hard
  Bolts/Scrap ceiling.
- **Rate limits**: 60 s short-TTL key `clash:rl:<userId>` caps
  scripted clients at 30 actions/min.
- **HMAC** on the DLL↔Worker sync continues — Clash payloads ride
  the existing `/sync/<guildId>` envelope.
- **Streamer kill switch**: `/clash town pause` — any streamer can
  pause their town's participation in PvP matchmaking entirely
  (still defends against in-flight raids that already started).
  Reduces churn during stream breaks.
- **Admin tools**: `/clash admin shield @guildId 24h`,
  `/clash admin reset @userId`, `/clash admin ban @userId`.
  Aquilo-side admin (not per-streamer).

---

## 10. Leaderboard exclusions

Per Clay's testing requirement, certain accounts are excluded from
**every** Clash leaderboard (global raider ladder, global town
prestige, per-community contributors).

Stored at `clash:exclude` as a single small JSON document:

```json
{
  "_comment": "Excluded from every Clash leaderboard. Easy to flip off when testing is done.",
  "patreon_emails":  ["bisherclay@gmail.com"],
  "twitch_user_ids": ["1497793223"],
  "discord_user_ids": []
}
```

Discord ID is left empty here until the build step resolves it from
Clay's linked identity in the existing `wallet:<guildId>:<userId>`
record's `links: []` array (see `discord-bot/wallet.js:217–236`). At
runtime, any identifier on any of these arrays — looked up through
the existing identity-link table — is silently filtered out of every
leaderboard query.

The exclusion is **leaderboard-only**, not gameplay-only. Clay's
account still earns trophies, still spends Bolts, still raids and
defends normally — he just doesn't appear in any ranked listing.
That keeps his testing realistic.

Flip-off is one edit to this JSON document (or removing his
identifiers from the arrays) when he's done testing. Easy to revert.

---

## 11. Phased build plan

### Phase 1 — Foundation (NPC + goblin + global PvP, Discord-only)
- KV schema for `clash:town`, `clash:treasury`, `clash:queue`,
  `clash:army`, `clash:trainq`, `clash:trophies`, `clash:prestige`,
  `clash:contributions`, `clash:raid`, `clash:raidlog`,
  `clash:def-snapshot`, `clash:shield`, `clash:mm:tier`,
  `clash:npc:*`, `clash:exclude`, `clash:notify`.
- Town: `/clash town view`, `/clash town build`, `/clash town garrison`,
  `/clash town layout` (text-based for v1 — real drag-and-drop is
  Phase 4).
- Raider: `/clash status`, `/clash army`, `/clash train`, `/clash donate`,
  `/clash raid goblin|npc|player`, `/clash log`.
- Notification opt-ins: `/clash notify`.
- Building & troop catalogues v1 (10 buildings, 6 personal troops,
  4 garrison troops).
- NPC town + goblin camp generation (deterministic from seed).
- Global PvP matchmaking with shields + trophy decay.
- Cosmetic Patreon flairs hooked into the existing Patreon link.
- Voltaic loot pool added to dungeon shop drop tables.
- PWA push notification wiring through aquilo-site push pipeline.
- Excluded-accounts filter on every leaderboard query.

### Phase 2 — Community wars
- `clash:war:<warId>` storage + war handler.
- War declare / accept / refuse vote flow (reusing dungeon recruit
  pattern).
- War scoring, war windows, victorious banner.
- War-specific push notifications.

### Phase 3 — Hero defense + clan polish
- "War Tent" building → designate community Champion for defense.
- Set-bonus interactions in raid resolver fully wired.
- Hero level gates enforced.
- Battle Plan dungeon drop (one-time build-time skip).

### Phase 4 — Surfaces beyond Discord
- Twitch panel "My town" + raid feed + leaderboard view.
- OBS overlay live raid-alert toast.
- `loadout.aquilo.gg/clash` drag-and-drop layout editor.

---

## 12. Resolved sub-questions (defaults applied)

Listed for the record so we don't relitigate. Anything here can still
be tuned later, but these are the v1 defaults baked into the doc:

- **Who can build the town**: streamer + mods (write-gate on `ownerUserId`
  + `modUserIds` in TownState). Viewers donate but don't vote on builds.
- **Solo raid loot split**: 100% to attacker. Voluntary donation back.
- **War spoils split (Phase 2)**: 30% of war-window loot auto-tributed
  to attacker's home town treasury.
- **Hero defends a town**: only via "War Tent" (Phase 3+). v1 town
  defends with garrison only.
- **Cross-channel intra-community raids**: blocked. Members of channel
  X cannot raid channel X's town. War is the only mechanism for
  same-community-internal action.
- **Matchmaking tier**: by *personal* trophies, not town prestige.
  Raider's ladder is independent.
- **NPC scaling**: scales to the *attacker's* hero level, not town
  prestige.
- **NPC + goblin generation**: deterministic from seed (cheap, infinite).
- **First-time UX**: new streamer's town autocreates at TH1 the
  first time anyone in that channel runs `/clash`. Goblin camps
  available immediately; NPC raids at hero L3; PvP at hero L8.
- **Loot set name**: Voltaic.
- **Patreon perks**: cosmetics only (badges, wall/tower skins,
  banner emoji). No gameplay impact.
- **Seasons**: none. Ambient ladder, peak trophies tracked.
- **Voice / live-stream context**: no special interaction in v1;
  Clash is independent of stream state.
- **Excluded leaderboard accounts**: see §10. Clay's accounts only.

---

## 13. Phase 1 build notes (shipped 2026-05-20)

### Files added (Loadout repo)
- `discord-bot/clash-state.js` — KV schema, town/treasury/army/trophy
  helpers, matchmaking buckets, shield/queue/notify helpers, exclude
  resolver (`isExcluded`, `isTownExcluded`) that walks the wallet
  `links: []` array.
- `discord-bot/clash-content.js` — buildings (8 kinds, 1–10
  upgrade tracks), 6 personal troops, 4 garrison troops, Voltaic
  loot drop table, deterministic NPC town + goblin camp
  generators.
- `discord-bot/clash-raid.js` — pure-function turn-based battle
  simulator (`simulate`) + loot economics (`computeLoot`) + trophy
  delta (`computeTrophyDelta`). Seeded RNG for replayable raids.
- `discord-bot/clash.js` — `/clash` slash command dispatch:
  `status / army / train / donate / raid / log / leaderboard /
  notify / town view / town build / town garrison / town pause`.
  Cooldown-walker `syncCooldowns` runs at the head of every
  invocation so build/troop completion is honest without a tick.
- `discord-bot/clash-push.js` — outbound HMAC POST to
  aquilo-site `/api/push/external` for the seven Phase 1 event
  kinds. Helpers `pushRaidIncoming / pushRaidDefended /
  pushRaidSacked / pushRaidResult / pushBuildComplete /
  pushShieldExpiring`.
- `discord-bot/clash-cron.js` — daily trophy/prestige decay walk
  + shield-expiring nudges, dispatched from `worker.js scheduled()`
  under the new `13 9 * * *` trigger.

### Files modified
- `discord-bot/commands.js` — added `case 'clash':` in the
  dispatcher.
- `discord-bot/commands-spec.js` — added the full `/clash`
  command tree (subgroup + 10 leaf subcommands).
- `discord-bot/worker.js` — added the `13 9 * * *` cron branch.
- `discord-bot/wrangler.toml` — added the daily cron trigger.

### Files added (aquilo-site repo)
- `functions/api/push/external.js` — HMAC-verified external push
  trigger. Verifies `x-aquilo-ts` + `x-aquilo-sig` against the new
  `CLASH_PUSH_SECRET` Pages secret, then fans out via the existing
  `pushToAll()` to every stored web-push subscription. Same posture
  as the Twitch eventsub handler.

### Secrets to set (deploy step)

Loadout worker (`wrangler secret put`):
- `CLASH_PUSH_SECRET` — shared with aquilo-site (any 32+ byte
  random hex). Optional; if unset, Clash pushes silently no-op so
  /clash still works without push wired.

aquilo-site Pages secret (Dashboard → Settings → Functions):
- `CLASH_PUSH_SECRET` — same value as above.

Optional Loadout worker env override:
- `AQUILO_PUSH_URL` — defaults to `https://aquilo.gg/api/push/external`.
  Override for a staging push host if you ever stand one up.

### Deploy

1. **Loadout worker**: `cd discord-bot && wrangler deploy`. The new
   `/clash` command takes effect immediately; players just need to
   run `/clash status` once to autocreate the town.
2. **aquilo-site**: standard Pages deploy via the mirror repo.
3. **Register `/clash`**: run `node register-commands.js` (the
   existing one-shot CLI) to publish the new command tree to
   Discord — global commands take ~1 h to propagate, dev-guild
   commands are instant.

### Exclude list (Clay's testing account)

Stored at KV key `clash:exclude` in `LOADOUT_BOLTS`. Default seeded
on first read with `bisherclay@gmail.com` (Patreon) and `1497793223`
(Twitch). Clay's Discord ID resolves at runtime via the wallet
`links: []` array — if Clay's Discord account is wallet-linked to
either his Twitch ID or Patreon email, the resolver pins his Discord
ID automatically across every leaderboard query. Flip-off paths:
edit the JSON doc, or set `CLASH_EXCLUDE_DISABLED=1` env var on the
worker.

### What Phase 1 deliberately does not ship
- Drag-and-drop layout editor (Phase 4 / web).
- Twitch panel surfaces (Phase 4).
- OBS overlay raid-alert toast (Phase 4).
- Community-vs-community wars (Phase 2).
- War Tent / hero-defends-town (Phase 3).
- Per-user push-notification filtering — opt-in mask is *recorded*
  but every push subscriber still sees every Clash push, matching
  how stream.online already behaves. Identity-linking subscriptions
  to Discord users is a Phase 2 plumbing job.
