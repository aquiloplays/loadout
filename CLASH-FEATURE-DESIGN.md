# Clash — Town-and-Raid feature for Loadout

> Status: **design only, not yet built.** Multi-phase plan. Phases are
> shipping units; do not start phase N+1 until N is in viewers' hands.
>
> Author: Loadout team · Date: 2026-05-20 · Owner: Clay
>
> Verbatim ask (Clay):
> *"Can we also create a new feature in Loadout that is a version of
> Clash of Clans tied to the RPG dungeon crawler? People can build
> their own towns, upgrade them, get units and raid other bases (NPC
> and other players), there are cooldowns for builds and troop
> trainings. Bolts is the economy."*

---

## 1. Guiding principles

The point of this doc is to keep Clash from turning into a parallel
universe. Loadout already has a wallet (`BoltsWallet`), a hero system
(`HeroState`), and a Worker↔DLL sync model. Clash should plug into
those — not duplicate them — for three reasons:

- **One Bolts balance, everywhere.** Viewers already feel "rich" or
  "broke" inside Loadout. Forking a second currency for clash, or
  letting clash mint Bolts from nothing, breaks the existing dungeon
  shop / training / streak-freeze pricing curve (see §4).
- **One hero.** The Clash army should *deploy* the viewer's existing
  Dungeon hero, not a separate clash-only character. Levelling their
  warrior should make them better at raids; raiding should grant
  dungeon XP. This is the integration Clay asked for.
- **Per-streamer instance.** Loadout is guild-scoped (every KV key
  prefixes `<guildId>`, see `wallet:<guildId>:<discordUserId>` in
  `discord-bot/wallet.js`). A streamer's channel is one Clash
  universe; cross-streamer raids are explicitly **out of scope** for
  the first three phases. Aquilo could light up a "Global Clash"
  later, but that's a separate product decision.

Everything below follows from those three.

---

## 2. Data model + storage

All Clash state lives in the existing `LOADOUT_BOLTS` KV namespace
(same one `wallet.js` and `dungeon.js` already use), with a new `clash:`
prefix family. Reusing the namespace means the DLL's existing
`/sync/<guildId>` snapshot pipeline (`PanelBridgeModule.cs`) can pick
up Clash state with the same HMAC + lifetime-counter merge logic that
already reconciles the Worker hero with `dungeon-heroes.json`.

### KV layout

| Key | Value | Notes |
| --- | --- | --- |
| `clash:base:<guildId>:<userId>` | `BaseState` JSON | Single source of truth for a player's village. Includes building list, TH-level, resource stores. |
| `clash:queue:<guildId>:<userId>` | `Queue` JSON | Build queue + barracks queue. Each item has `endsAt` (ISO UTC); never run a background tick — read-time check. |
| `clash:army:<guildId>:<userId>` | `Army` JSON | Trained troops sitting in barracks. Drained on attack. |
| `clash:def-snapshot:<guildId>:<userId>` | `DefenseSnapshot` JSON | Frozen copy of the base + defending army used when the player is offline. Rebuilt on every layout-edit or troop-train completion. |
| `clash:shield:<guildId>:<userId>` | `{ endsAt, reason }` | Active shield (post-raid grace period). Absent ⇒ no shield. |
| `clash:trophies:<guildId>:<userId>` | `{ trophies, tier, peak }` | Persistent. Tier derived from trophies (bronze/silver/gold/platinum/diamond). |
| `clash:mm:<guildId>:<tier>` | Sorted set of userIds | Matchmaking index. Cheap KV list rather than a full ZRANGE — N is small per channel. |
| `clash:raid:<raidId>` | `RaidReceipt` JSON | Append-only. Attacker, defender, replay log, loot, when. 30-day TTL. |
| `clash:raidlog:<guildId>:<userId>` | Array of last 20 raidIds | Both as attacker and defender. |
| `clash:leaderboard:<guildId>` | Cached top-50 | 10 min TTL like the wallet leaderboard at `worker.js:239–334`. |
| `clash:npc:<guildId>:<seed>` | Generated NPC base | Deterministic from seed so we don't store thousands of fake bases. |

### BaseState shape (sketch)

```
{
  thLevel: 1..10,          // Town Hall — gates everything else
  buildings: [
    { id, kind, level, x, y, hp, status,         // status: 'idle' | 'building' | 'damaged'
      endsAt? }                                  // present when status='building'
  ],
  resources: { bolts: 0, scrap: 0, cores: 0 },   // see §4
  defending: { troopId: count, ... },            // optional, present if armed
  layoutVersion: 7,                              // bumped on edits — invalidates snapshots
  lastActiveUtc, createdUtc
}
```

Two non-Bolts resources are deliberate. **Scrap** is from low-level
raids and rebuilds quickly. **Cores** is rare and gates top-tier
upgrades. Pure single-currency design (just Bolts) lets a streamer with
a fat wallet skip every cooldown, which kills the meta.

### Identity & sync

Clash uses the same identity model as the wallet — `wallet:<guildId>:<discordUserId>`
is the canonical key. Twitch viewers join Clash by linking their Twitch
identity to a Discord account through the existing `links: []` array on
the wallet record (`wallet.js:217–236`). No new identity table.

The DLL-side mirror lives in `clash-bases.json` alongside
`dungeon-heroes.json`. Same merge contract as the dungeon: DLL owns the
canonical numbers (trophies, raid stats), Worker owns the live edits
the viewer makes off-stream. Last-write-wins on `lastActiveUtc`.

---

## 3. Build & troop-training cooldowns

Cooldowns are **timestamp-only**. We never run a background ticker on
the Worker (Cloudflare Workers don't have one anyway). Each queued
build / troop has an `endsAt` ISO UTC. On every read, the route handler
walks the queue and "completes" anything where `now >= endsAt`,
mutating `BaseState` in place and writing back. This is the same
pattern the wallet uses for the 23-hour daily payout (`games.js:62–93`).

Cooldown lengths are calibrated against the existing economy:

- Bolts daily floor: **100/day** base, up to **700/day** at a 7-day
  streak (`games.js:63`).
- Mid-tier dungeon training session: **1500 Bolts** for 50 rounds
  (`dungeon.js:879–887`).
- Epic shop item: **1620–2460 Bolts** (`dungeon.js`).

So a typical Clash player at a 7-day streak earns ~700/day. We pick
cooldowns + costs that turn that into ~1–2 meaningful actions per day:

| Action | Bolts | Wall-clock |
| --- | --- | --- |
| TH 1 → 2 | 400 | 15 min |
| TH 3 → 4 | 1 800 | 4 h |
| TH 6 → 7 | 12 000 | 24 h |
| TH 9 → 10 | 60 000 | 5 days |
| Common troop (Scrapper) | 8 | 30 s |
| Rare troop (Bolt Knight) | 220 | 12 min |
| Epic troop (Voltaic Mage) | 950 | 90 min |
| Skip cooldown (per minute) | 1 Bolt/min | — |

The "skip cooldown" lever is critical. It gives whales a Bolt sink
without printing power for free (the bolts spent are real Bolts that
left the supply — see §4). Hard-cap skips at 240 min/day per player to
prevent a wallet-full whale from blasting from TH1 → TH7 in an
afternoon.

Build queue is **one slot** at TH1, scales to **3 slots** at TH8.
Barracks training is **one queue per barracks**; you build more
barracks to parallelize.

---

## 4. Bolts economy — keeping the curve intact

This is the riskiest part of the whole feature. The current Bolts
economy has been tuned twice (October 2025 + May 2026); a Clash
feature that mints Bolts will undo that work.

**Rules:**

1. **No Bolts are created by Clash.** Daily payouts, channel-point
   redemptions, and the streak system are the *only* sources of Bolts
   (see `wallet.js applyVaultDelta`). Clash does not credit Bolts ever
   except as a redistribution from another player.
2. **Building & training are pure sinks.** Bolts spent on upgrades and
   troops vanish (debit via `applyVaultDelta(..., -cost, 'clash-build')`).
3. **Raid loot is a transfer.** When attacker A successfully raids
   defender D for X Bolts, A's wallet credits X *and* D's wallet
   debits X in the same handler. Sum unchanged. Loot tap is capped at
   **20% of D's stored Bolts** with a hard ceiling per raid (no
   one-shot wipes).
4. **Scrap and Cores are minted by the system** because they're not
   the brand currency. Scrap is rebalanced via raid drops + daily
   collector (a building that auto-fills slowly). Cores drop only from
   NPC fortresses + clan-objective rewards.

Net effect: a streamer's total Bolts in circulation is a slow downward
slope (sinks > zero new sources from Clash). That's healthy — it gives
the daily payout something to do besides inflate.

---

## 5. Raiding — NPC vs PvP

### Match types

| Mode | Source | Cost | Trophy delta |
| --- | --- | --- | --- |
| NPC scout | Tier-seeded NPC base | Free | ±0 (training) |
| NPC raid | Tier-seeded NPC base | 1 raid token | + small / 0 |
| PvP raid | Real player, ±150 trophies | 1 raid token | ± significant |
| Revenge | Most recent attacker | Free (1/day) | ± as PvP |

Raid tokens regen 1 every 4 h up to a cap of 4 (configurable per
streamer). This is the per-user attack cap.

### Matchmaking

`clash:mm:<guildId>:<tier>` is a sorted list of userIds with
`lastActiveUtc` in the last 30 days. Worker picks a random target
within ±150 trophies, skipping anyone who is currently shielded
(`clash:shield:...`) or who is the attacker themselves. If no live
human matches, fall back to an NPC base of the same tier — no "no
target" failure state.

### Offline defense

Defense always uses `clash:def-snapshot:<guildId>:<userId>`, written
the moment a player edits their layout, finishes training a troop, or
logs into Clash for the first time that day. The snapshot freezes:

- Building positions + levels
- Defending troop counts + tiers
- Defender hero loadout (level + gear + class)

The attacker plays against the snapshot — *the defender is never
"live"* — so the simulation is deterministic given (snapshot, attacker
army, hero loadout, RNG seed). The seed is the raidId so the same raid
always replays the same way (matches `delayMs` replay pattern in
`PanelBridgeModule.cs`).

### Resolution

The actual battle resolves **server-side in one go** (Cloudflare
Worker handler, ~50ms). The result is a `RaidReceipt`:

```
{ raidId, attacker, defender, startedUtc, duration, log: [...],
  starsEarned, lootBolts, lootScrap, lootCores, trophyDelta }
```

The `log` is a compact event list — `("attack", troopId, buildingId, dmg, t)`
— enough to drive a replay in the panel or website without storing
full physics state. Replay format is small enough (a few KB) to keep
30 days in KV.

---

## 6. Tie-in to the dungeon crawler

This is the part Clay specifically asked for. Without it, Clash is
just a second game. The goal is mutual reinforcement: levelling the
hero helps Clash, and Clash gives the hero something to do off-stream.

**Hero deploys as the "Champion" unit.**

- Each raid army gets exactly one Champion slot, filled by the
  attacker's Dungeon hero (HeroState — `dungeon.js:391–413`).
- Champion stats = derived from the hero's level, equipped gear, class,
  and set bonuses (the same math the dungeon engine already runs).
- Class shapes the role:
  - **Warrior** — frontline tank, soaks defender turret fire while
    troops advance.
  - **Mage** — AoE clearance on packed buildings (good vs base layouts
    that cluster).
  - **Ranger** — picks off air defenses from long range.
  - **Rogue** — sappers: burst single high-value targets (TH, builders).
  - **Healer** — passive party-wide regen, weakest solo.
- Defender's hero shows up as a defending champion if they have
  trained the "War Tent" building. Otherwise the defender's base is
  unattended on the hero front.

**Cross-progression:**

- Winning a raid grants dungeon **XP** (small) + a chance at dungeon
  **loot** drops from a Clash-themed pool (set: *Voltaic*). Voltaic
  pieces only drop from Clash and are stronger in raids than in
  dungeons. This gives raiders a reason to raid even at low Bolt
  payouts.
- Hero level gates Clash content: TH3 needs hero L5, TH6 needs hero
  L15, TH9 needs hero L30. Forces players who want endgame Clash to
  engage with dungeons.
- Set bonuses already calculated in DungeonContent flow through into
  raid resolution — no separate "raid gear" tab to maintain.

---

## 7. Where players interact

Recommendation in **bold**.

- **Discord slash commands** — `/clash` top-level, with subgroups
  `base | build | troops | raid | clan | scout | log`. Modal-based
  edits where the input is short (rename clan), select menus for
  list-pickers (queue a building). This matches the existing `/loadout`
  ephemeral menu pattern (`commands-spec.js:25–242` and
  `commands.js handleInteraction`). **First-class surface.**
- **Twitch panel** — read-mostly: viewer's own base preview, recent
  raid feed, channel leaderboard, "attack queue" status. Edits are
  rare here because typing into Twitch panels is awful; the panel
  links out to Discord/web for any real action. Buffered + replayed
  through `PanelBridgeModule.cs` same as the dungeon scenes. **Second
  surface.**
- **Website (loadout.aquilo.gg/clash)** — *Recommended primary edit
  surface for the layout editor.* Drag-and-drop building placement
  in a Discord modal is hostile UX; on a real page it's the only
  sensible way. Use the existing wallet-link sign-in flow (the panel
  already does HMAC + Twitch/Discord OAuth) so the site can read +
  write a player's base. **New page; recommend Phase 4.**
- **OBS browser source (overlay)** — alert toasts when the streamer's
  base is raided live ("Aquilo's base is under attack!"). Drives
  engagement during streams without needing a dedicated scene. Uses
  the existing `aquilo-gg/overlays/_shared/loadout-design.css` brand
  tokens so it matches everything else.

---

## 8. Anti-abuse

- **Per-user attack tokens** (§5) cap raid spam at 4/4h.
- **Shields**: 12 h shield after losing 2+ stars in a raid; 6 h after
  losing 1 star; none on a 0-star defense. Shield breaks if the
  defender attacks anyone.
- **Trophy decay**: lose 1 trophy/day per 100 above your TH level's
  cap — prevents top-band players from quitting with their crown.
- **Loot caps** §4 prevent farm-bombing the same target.
- **Rate-limit Discord interactions** at the Worker level: existing
  pattern in `wallet.js leaderboard()` cache + the `commands.js`
  router. Add a `clash:rl:<userId>` short-TTL key (60 s, max 30 calls)
  to block scripted clients.
- **HMAC** on the DLL↔Worker sync continues to apply (the existing
  `PanelBridgeModule.cs` sign/verify path); Clash payloads ride the
  same `/sync/<guildId>` envelope.
- **Admin tools**: `/clash admin reset @user`, `/clash admin shield
  @user 24h`, `/clash admin ban @user`. Streamer-scoped.

---

## 9. Phased build plan

Each phase ships and we collect feedback before starting the next.
Don't bundle.

### Phase 1 — Foundation (NPC-only, Discord-only)
- KV schema for `clash:base`, `clash:queue`, `clash:army`, `clash:trophies`.
- `/clash base` (view), `/clash build`, `/clash troops` (train).
- Building & troop catalogues v1 (10 buildings, 6 troops).
- NPC raid scaffolding (`clash:npc:<seed>` deterministic generation).
- Bolts integration via `applyVaultDelta` — no Bolts minting.
- Estimated scope: ~2 weeks. Goal: a viewer can build a base and
  raid an NPC fortress, all from Discord, by end of phase.

### Phase 2 — PvP (real-player raids)
- Matchmaking index `clash:mm:<guildId>:<tier>`.
- `clash:def-snapshot` writer + reader.
- `clash:shield` + revenge token.
- Battle log replay format frozen here.
- Trophy ladder + decay.
- `/clash raid` (auto-matchmake), `/clash scout`, `/clash log`.
- Goal: two real viewers can raid each other end-to-end.

### Phase 3 — Hero & depth
- Champion deploy from `HeroState` — class roles wired in.
- Voltaic loot pool added to the Dungeon shop drop tables.
- Hero level gates on TH.
- Optional **clans** (multiple players share a clan but each owns
  their own base — no shared base). Clan war = best-of-3 raids over
  a 24h window.
- Goal: dungeon and clash feel like one product, not two.

### Phase 4 — Surfaces
- Twitch panel "My base" view + raid feed.
- OBS overlay raid-alert toast.
- loadout.aquilo.gg/clash drag-and-drop layout editor.
- Public leaderboard endpoint.

---

## 10. Open questions for Clay

1. **Cross-streamer raids — ever?** This doc explicitly scopes them
   out. Do you want a "Global Clash" lane long-term, or is per-channel
   the permanent design?
2. **Patreon gating.** Loadout already has a Patreon tier system. Do
   Clash features get gated by tier (e.g., 3rd builder requires
   tier 3), or is Clash entirely Bolts-gated and Patreon stays
   feature-only?
3. **Bolts costs in §3 are first-draft.** Want them tuned before
   Phase 1 starts, or fine to ship + retune from telemetry?
4. **Hero in defense** — is it cool that the defender's hero only
   shows up if they've built the "War Tent" building, or should the
   hero always defend automatically? (Auto-defend feels less
   strategic but is more "fair" for casuals.)
5. **NPC base generation** — generated from seed (cheap, repeats over
   time) vs hand-authored "campaign" map (more memorable, scopes
   bigger). Recommend **seeded** for Phase 1, hand-author a campaign
   layer in Phase 3+.
6. **Clan model** — full SC-style clans with shared chat and war
   tournaments is a *huge* feature. Phase 3 sketches a minimal
   version (best-of-3 raids). Is that enough for v1 or do you want
   richer clan mechanics?
7. **Win-condition for streamers.** Should there be a per-stream
   season (e.g., a 4-week "Conquest" where top trophies wins
   something), or is Clash purely ambient meta?
8. **Defensive depth at TH1–3.** With only a few buildings and 1
   defender troop type, every early-game raid is a guaranteed
   3-star. Do we accept that "early game is a tutorial" or do we
   front-load more defensive variety?
9. **Bolts inflation over time.** §4 makes Clash a net-zero or
   slightly-deflationary force. If the dungeon/shop balance ever
   shifts back to net-positive Bolts minting, Clash is a useful
   sink to lean on. Worth designing a "Clash absorption rate"
   telemetry from day one?
10. **Voltaic loot set name + visual.** Sets in Loadout matter
    (already a thing in the dungeon shop). A new Clash-tied set
    needs naming + a brand-aligned visual. Default name *Voltaic*
    is a placeholder.
