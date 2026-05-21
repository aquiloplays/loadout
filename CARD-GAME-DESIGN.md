# Boltbound — Loadout's async card-battler

> Status: **LOCKED — Phase 1 building.** Name and roster are final.
> No streamer/Spotlight tier. Open questions resolved per the
> defaults already proposed in earlier drafts and locked here.
>
> Author: Loadout team · Date: 2026-05-21 · Owner: Clay
>
> **2026-05-21 expansion** — roster goes from 82 cards to **1,000+**
> via the family/archetype generator in §13, plus a card-recycling →
> pack-fragments → craftable-pack loop in §14. Sprite generator
> extended in §15 with rarity-scaled detail templates so every card
> still gets unique pixel art (no emoji).
>
> Clay's locks (verbatim):
> *"The name is BOLTBOUND. No streamer cards, no Spotlight tier —
> rare slots are legendary heroes and dungeon bosses, in-world only."*
>
> Production posture: same as Clash — multi-phase, deterministic
> server resolver, custom pixel-art only (no emoji glyphs in card
> records), Discord-first surface, web/Twitch surfaces routed
> separately on the aquilo-site repo.

---

## 1. Guiding principles

- **One game, one identity.** Boltbound is not a parallel RPG —
  it's a card-shaped expression of the Loadout world. Your
  Boltbound Champion IS your dungeon hero's class (warrior, mage,
  rogue, ranger, healer). Levelling on the dungeon side makes your
  Champion's card stronger. Boltbound wins also feed dungeon XP
  later (Phase 2 — out of Phase 1 scope, but the design must not
  block it).
- **Bolts is the only currency.** Same rule as Clash. No
  Boltbound-only premium token, no second wallet. Packs cost
  Bolts; ladder wins pay Bolts; ladder daily cap exists so this
  doesn't replace the rest of the economy.
- **Server-resolved, deterministic, replayable.** `simulate(matchState, action, seed)` is a pure
  function. Same (state, action, seed) → same outcome. Same
  posture as `clash-raid.js`. This is what lets us run the same
  match on Discord, the website, and the Twitch panel and have
  every surface tell the same story.
- **Async turn-based, not real-time.** Each turn is a single
  Discord (or web) interaction. Matches can span minutes or
  hours between turns. Both surfaces talk to the same match
  record. A turn timeout (24h) auto-passes so a stalled match
  doesn't sit forever.
- **Custom pixel art only.** Every card has a unique 64×80 PNG
  sprite at `aquilo-gg/sprites/cards/<cardId>.png`. No emoji
  glyphs in any card record (same rule we adopted for the
  lootbox catalogue 2026-05). Legendary tier gets animated APNG
  (matches the trinket/weapon legendary treatment).
- **No streamers as cards.** Locked. The "Spotlight" tier was
  considered and removed. Every legendary card is an in-world
  character — a legendary hero or a dungeon boss. This keeps
  the roster evergreen (no card has to retire when a streamer
  takes a break) and avoids the obvious favoritism / permissions
  mess of putting real people on tradable cards.
- **Discord-first surface, web fancier.** Phase 1 ships the
  Discord surface only. Web battler UI + pack-opening page +
  Twitch panel TCG view are routed to the aquilo-site repo on
  a later pass.

---

## 2. The match — battle format (LOCKED)

| Knob | Value | Why |
| --- | --- | --- |
| **Deck size** | 20 cards | Small enough to draft daily, big enough to have variety. Hearthstone is 30 — we're smaller because async pace means each turn matters more. |
| **Hand size cap** | 5 cards | Discord select-menus cap at 25 entries; we want a hand to fit comfortably in one menu with room for spells + minions on board. Burns on draw past cap (Hearthstone rule). |
| **Starting hand** | 3 cards (going first), 4 + "Bolt" token (going second) | Going-second bonus = a one-time +1 mana spell to balance the tempo gap. |
| **Player HP** | 30 | Hearthstone's number. Familiar, scales with our damage curve. |
| **Mana** | Hearthstone-style: start with 1 crystal, +1 each turn up to 10. | Familiar to anyone who's touched the genre. Caps the snowball. |
| **Turn limit** | 20 turns (10 per side) | Hard fatigue. After turn 20, both players take 2 dmg per turn until one dies — prevents griefing stalls. |
| **Win condition** | Reduce opponent HP to 0. After turn 20: higher HP at fatigue resolution wins; tie = draw. | Honest game-end, no time-based loophole. |
| **Turn timeout** | 24h per turn | Async-friendly. Past timeout, the active player's turn is auto-passed; after 3 consecutive auto-passes, they concede. |
| **Concede** | Either player may concede any time | Standard. |
| **Mulligan** | One free redraw of any subset of starting hand | One-shot, no take-backs. Discord modal. |

A complete match shape (KV value at `cards:match:<matchId>`):

```js
{
  matchId, createdUtc, lastTurnUtc,
  guildId,                      // home channel — used for queue scoping and exclusions
  players: { A: userId, B: userId },
  npc: false | { side: 'B', archetype: 'aggro' | 'control' | 'midrange', seed },
  decks:  { A: [cardId, ...], B: [cardId, ...] },   // pre-shuffled (deck order = draw order)
  hands:  { A: [cardId, ...], B: [cardId, ...] },
  hp:     { A: 30, B: 30 },
  mana:   { A: { cur: 0, max: 0 }, B: { cur: 0, max: 0 } },
  board:  { A: [{ uid, cardId, hp, atk, status: [...], canAttack }, ...], B: [...] },
  graveyard: { A: [cardId, ...], B: [...] },
  turn: 1,
  active: 'A',                   // whose turn it is
  goingFirst: 'A',               // for bolt-token bookkeeping
  log: [ { t, who, kind, ... }, ... ],
  status: 'mulligan' | 'active' | 'A-won' | 'B-won' | 'draw' | 'expired-A' | 'expired-B',
  seed,                          // hashStr(matchId) — drives every RNG roll inside the resolver
}
```

The receipt that lands in a player's `/boltbound log` is the same
shape, sliced to just the final `log[]`, final HP, and win/loss.

---

## 3. The roster — card tiers (LOCKED)

Four rarities. Per-rarity pull weights are tuned so a viewer who
opens roughly one Bolt Pack a day reaches a competitive deck
inside 2 weeks, sees their first legendary in ~3 weeks, and has
to choose which legendary to build around (one-per-deck rule).

| Rarity | Pull weight | Deck cap | Roster size (Phase 1) | Notes |
| --- | --- | --- | --- | --- |
| **Common** | 60 | 4 copies / deck | ~32 cards | Bread-and-butter minions and spells. |
| **Uncommon** | 30 | 3 copies / deck | ~20 cards | One simple keyword (taunt, charge, etc.) or one-line effect. |
| **Rare** | 9 | 2 copies / deck | ~14 cards | Multi-effect, conditional triggers, scaling stats. |
| **Legendary** | 1 | **1 copy / deck** | ~10 cards | Unique heroes + dungeon bosses. Animated APNG art. |

There is **no fifth tier**. The "Spotlight / streamer card" tier
that earlier drafts proposed is **removed**. The slots those
cards would have occupied are filled by the rare and legendary
rosters below — all in-world.

### 3.1. Champions (your starter card, one of)

Mirror `CLASSES` in `discord-bot/dungeon.js` 1:1. Each viewer's
deck starts with the Champion of their dungeon class as a
**non-removable** card (the deck's anchor). Re-classing in the
dungeon swaps the Champion in every deck the viewer owns.

| Champion | Mana | HP | ATK | Ability |
| --- | --- | --- | --- | --- |
| **Warrior — Champion of Steel** | 4 | 6 | 4 | *Charge.* (Can attack the turn it's played.) |
| **Mage — Champion of Arcana** | 4 | 4 | 3 | *On play: deal 2 damage to any target.* |
| **Rogue — Champion of Shadows** | 3 | 5 | 4 | *Stealth on play (cannot be targeted next turn).* |
| **Ranger — Champion of the Wilds** | 4 | 5 | 3 | *Reach (can attack opponent HP directly even when taunts are present).* |
| **Healer — Champion of Light** | 4 | 5 | 2 | *On play: heal you for 4. End of your turn: heal you for 1.* |

### 3.2. Legendary roster — heroes (5)

In-world archetypal heroes. Same legendary set across all
viewers; one copy / deck. Animated APNG sprite at the legendary
tier (same treatment as Excalibur in the dungeon catalogue).

| Card | Mana | HP | ATK | Ability |
| --- | --- | --- | --- | --- |
| **Solara, the Sunblade** | 7 | 7 | 5 | *On play: deal 3 damage to all enemy minions.* |
| **Korrik the Bonecrusher** | 6 | 8 | 6 | *Taunt. Cannot be targeted by spells.* |
| **Mireth, Vault Whisperer** | 5 | 4 | 3 | *On play: copy a random card in your opponent's hand into your hand.* |
| **Thalor, the Stormwarden** | 8 | 6 | 6 | *On play: deal 2 damage to every enemy minion AND the enemy hero.* |
| **Nyx, Pact-Bound** | 5 | 5 | 4 | *On death: return to your hand with +1/+1.* |

### 3.3. Legendary roster — dungeon bosses (5)

The five major bosses from the Loadout world. Mechanically distinct,
flavor-tied to the dungeon side. Animated APNG.

| Card | Mana | HP | ATK | Ability |
| --- | --- | --- | --- | --- |
| **The Bone Tyrant** | 9 | 10 | 8 | *Taunt. On death: summon two 3/3 Bone Knights.* |
| **Voltaic Wyrm** | 8 | 7 | 7 | *Charge. On attack: deal 1 damage to all other minions.* |
| **The Vault Lich** | 7 | 5 | 4 | *On play: draw 3 cards.* |
| **Goblin Warchief** | 6 | 6 | 5 | *On play: summon three 1/1 Goblin Scrappers with Charge.* |
| **The Hollow King** | 10 | 12 | 10 | *Cannot attack unless you played at least 3 spells this match.* |

### 3.4. Rare roster (14)

The roster Spotlight cards would have occupied is now filled by
mid-tier in-world cards. Mix of minions and spells; each rare has
one unique mechanic.

(Names + numbers are in `cards-content.js`; this doc is the
intent, not the implementation source.)

- **Voltaic Mage** (4 mana, 3/4, *Spell damage +1*)
- **Sapper Rogue** (3 mana, 4/2, *On play: destroy a 1-cost enemy minion*)
- **Bolt Knight** (4 mana, 4/5, *Taunt*)
- **Healer Cleric** (2 mana, 1/3, *End of turn: heal a friendly minion for 2*)
- **Archer Twin** (3 mana, 2/3, *On play: deal 1 damage twice (any target)*)
- **Bolt Engineer** (2 mana, 2/2, *On play: gain +1 mana this turn*)
- **Vault Sniffer** (1 mana, 1/2, *On play: look at the top card of your deck*)
- **Forge Brand (spell)** (2 mana, *Give a friendly minion +2/+2 this turn*)
- **Goblin Powder (spell)** (1 mana, *Deal 2 damage to any minion*)
- **Voltaic Surge (spell)** (4 mana, *Deal 4 damage split between any two targets*)
- **Vault Seal (spell)** (3 mana, *Counter the next spell your opponent plays*)
- **Bolt Storm (spell)** (5 mana, *Deal 1 damage to all enemy minions twice*)
- **Mend (spell)** (1 mana, *Heal a hero for 4*)
- **Resurrect (spell)** (4 mana, *Return the last friendly minion that died to your hand*)

### 3.5. Uncommon + Common rosters (~52 cards)

Catalogue lives in `cards-content.js`. The mix:

- ~20 uncommon minions across mana 1-6, each with one keyword
  (taunt / charge / shield / lifesteal / poison) or one tiny
  effect (deal 1 dmg on play, +1 health on a friend, etc.).
- ~22 common minions covering the mana curve 1-7. Vanilla
  stats (no ability) — these are the deck-glue.
- ~10 common spells (1-3 mana): damage 1-2, heal 2, draw 1, etc.

Exact numbers and abilities are in `cards-content.js`. The doc
locks the *shape* (mana 1-10, ~70 unique cards Phase 1) and
trusts the content module for the dial.

---

## 4. The pack system (LOCKED)

Three pack SKUs. Bolts is the only currency. Drop sources:

| Pack | Contents | Source | Notes |
| --- | --- | --- | --- |
| **Common Pack** | 5 cards, 100 % common | Free 1/day per viewer, OR loot-box drop, OR Clash 1★ raid drop (30%) | The reliable trickle. Resets at 00:00 UTC. |
| **Bolt Pack** | 5 cards: 60 c / 30 u / 9 r / 1 l | 250 Bolts (purchase) OR Clash 2★ raid drop (50%) OR Clash 3★ raid drop (always) | The main grind pack. |
| **Voltaic Pack** | 5 cards: 30 c / 40 u / 25 r / 5 l | Not directly purchasable. Drops only from Clash 3★ raids (10%), loot-box premium hits, Patreon monthly pack. | The premium drop. Same flavor-tier as the Voltaic gear set in Clash. |

**Pull mechanics:**

- Every pack guarantees its rarity floor by tier weighting per
  slot. Pulls within a tier are uniform across that tier's roster.
- **Duplicate protection / dust:** if you pull a card you already
  own at the deck cap (4 commons, 3 uncommons, 2 rares, 1
  legendary), it credits as **Bolts back** instead of a card:
  common → 5 Bolts, uncommon → 20, rare → 100, legendary → 500.
  No separate "dust" currency; we keep Bolts as the only thing.
- **Bad luck pity for legendaries:** every 30 Bolt or Voltaic
  packs opened without a legendary, the next one's legendary slot
  is guaranteed. Per-viewer counter, never decays.
- **Pack opening is on the server** — the website pack-opening
  page (later, on aquilo-site) reads pre-rolled pulls so the
  reveal is animation-only; the server already wrote the
  cards into the collection.

### 4.1. The `creditPack` hook (the lootbox + Clash integration point)

```js
// cards-packs.js
export async function creditPack(env, guildId, userId, packType, source) {
  // packType: 'common' | 'bolt' | 'voltaic'
  // source: 'free-daily' | 'purchase' | 'clash-raid' | 'lootbox' | 'patreon-monthly' | 'admin-grant'
  //
  // Mints a pending-pack record under cards:pending:<g>:<u>:<id>.
  // Player redeems by opening it — at redeem time, server rolls the
  // contents deterministically (rng seeded with the pack id) and
  // writes cards to their collection. The reveal can happen on
  // Discord (one embed listing all 5 cards) or on the web pack
  // opener (later). Both surfaces see the same pre-rolled pulls.
  ...
}
```

`ext-lootbox.js`'s `DEFAULT_CATALOG` gets three new entries with a
new pseudo-slot `pack`:

```js
{ slot: 'pack', rarity: 'common',    name: 'Boltbound Common Pack',  packType: 'common',  weight: 25 }
{ slot: 'pack', rarity: 'rare',      name: 'Boltbound Bolt Pack',    packType: 'bolt',    weight: 8 }
{ slot: 'pack', rarity: 'epic',      name: 'Boltbound Voltaic Pack', packType: 'voltaic', weight: 3 }
```

The loot-box roller checks `slot === 'pack'`; if so, it calls
`creditPack(env, guildId, userId, packType, 'lootbox')` and skips
the normal "append to hero bag" path. Bag stays gear-only; packs
have their own redemption flow.

### 4.2. Clash-raid hook

`clash.js handleRaid` already returns a raid receipt with a star
count. After loot is awarded, we call:

```js
import { rollClashPackDrop, creditPack } from './cards-packs.js';

const packDrop = rollClashPackDrop(sim.stars, raidId);
if (packDrop) {
  await creditPack(env, guildId, userId, packDrop, 'clash-raid');
  receipt.boltboundPack = packDrop;
}
```

Roll table (seeded by raidId for replay-determinism):
- 0 stars: no pack
- 1 star: 30% Common Pack
- 2 stars: 50% Bolt Pack
- 3 stars: 100% Bolt Pack, then independent 10% upgrade-to-Voltaic roll

### 4.3. Daily free Common Pack

`cards:freepack:<guildId>:<userId>:<YYYYMMDD>` is the gate; TTL
26h. Eligible viewers: anyone who has ever run `/boltbound` (i.e.
their `cards:col:<g>:<u>` row exists). First-time `/boltbound`
opens the collection AND credits a Common Pack immediately as
the welcome gift, then the daily cycle kicks in tomorrow.

---

## 5. The Discord battle surface (Phase 1)

One top-level command, `/boltbound`. Pattern matches `/clash`.

```
/boltbound status                — overview: collection size, deck, trophies, daily-pack status
/boltbound packs                 — list pending packs + open one
/boltbound deck list             — your saved decks
/boltbound deck active <id>      — switch your active deck
/boltbound deck builder          — opens an ephemeral deck-builder embed (select-menus)
/boltbound play npc              — start a match vs an NPC opponent (instant)
/boltbound play queue            — drop into the PvP queue (channel-scoped)
/boltbound play challenge user:<@u> — direct-challenge another viewer
/boltbound match                 — your turn — view + play
/boltbound concede               — concede the current match
/boltbound log                   — last 10 matches (yours)
/boltbound leaderboard           — top trophies (channel + global)
/boltbound collection            — paginated view of your cards
```

A turn in Discord:
1. Active player runs `/boltbound match`. Gets an ephemeral embed
   showing: your HP / opponent HP / mana / board (yours + theirs) /
   your hand. Select-menu lists playable cards (only the ones whose
   mana cost ≤ your current mana). A second select-menu lists your
   own minions that can still attack. Buttons: **End turn**, **Concede**.
2. They pick a card from the hand select → server validates → if
   the card needs a target, a follow-up modal asks for the target
   ID (a number 0-5 mapping to: opp hero, opp minions, your minions).
   For Phase 1 we cap target complexity here; web surface gets a
   click-to-target UI.
3. Server resolves the action, updates the match record, returns
   an updated embed via `UPDATE_MESSAGE`. Player can keep playing
   cards until they hit End turn or run out of mana / cards.
4. On End turn, opponent (human or NPC) is notified. NPC turns
   run immediately on the server. Human opponent gets a Discord
   DM (best-effort — DMs may be blocked, in which case the prompt
   shows up next time they run `/boltbound match`).

The push-notification surface (Phase 2) wires the Loadout PWA push
pipe the same way Clash does — `boltbound:your-turn`,
`boltbound:match-ended`. Not Phase 1.

### 5.1. The NPC opponent

Three archetypes, picked at match creation:

- **Aggro Bot** — greedy. Always plays the cheapest minion that
  hits face. Attacks face every turn it can.
- **Control Bot** — patient. Holds removal for high-cost threats.
  Heroes-only attacks against minions; face only when lethal or
  empty board.
- **Midrange Bot** — balanced. Plays the highest-cost card it can
  afford each turn, attacks minions before face.

Each archetype is a deterministic decision function:
`pickAction(matchState, side, seed) → action`. Server resolves the
NPC turn end-to-end in one tick (no Discord round-trips for the
bot). Same pattern as the Clash sim's deterministic ticks.

NPC deck rosters are pre-built (not drawn from a random pull) —
one deck per archetype, balanced by hand to give a fair fight
across all five Champions.

---

## 6. Storage — the `cards:` KV prefix (LOCKED)

Single KV namespace (the shared `LOADOUT_BOLTS` binding, same as
every other module). All keys live under `cards:`:

| Key | Value | Notes |
| --- | --- | --- |
| `cards:col:<guildId>:<userId>` | `{ cards: { cardId: count }, ts }` | The viewer's collection. |
| `cards:deck:<guildId>:<userId>:<deckId>` | `{ name, cards: [cardId,...], champion, ts }` | One saved deck. Up to 6 saved per viewer. |
| `cards:active:<guildId>:<userId>` | `deckId` (string) | Pointer to active deck. |
| `cards:pending:<guildId>:<userId>:<packId>` | `{ packType, source, rolled?: [cardId,...] | null, mintedUtc }` | Pending packs. `rolled` null until opened, then frozen. |
| `cards:freepack:<guildId>:<userId>:<YYYYMMDD>` | `1` | Daily-claim gate. TTL 26 h. |
| `cards:pity:<userId>` | `{ packs: n, lastLegendaryUtc }` | Bad-luck-pity counter. Per-user, NOT per-guild (the viewer is the same person across channels). |
| `cards:match:<matchId>` | the full match shape from §2 | Single source of truth for a match. |
| `cards:queue:<guildId>` | `[{ userId, queuedUtc, deckId }]` | PvP wait queue. 30-min entry TTL inside the array; cleaned on read. |
| `cards:matchref:<guildId>:<userId>` | `matchId` | Index — "what's this viewer's active match?" |
| `cards:log:<guildId>:<userId>` | `[receipt, receipt, ...]` (cap 10) | Recent match receipts. |
| `cards:trophies:<userId>` | `{ trophies, peak, season }` | Per-user (not per-guild) ladder rank. |
| `cards:ladder:<userId>:<YYYYMMDD>` | `bolts` (integer) | Today's earned-from-ladder counter, for the daily cap. TTL 26h. |

KV write discipline (same as Clash): each module owns its key
family and exports typed helpers. Other modules go through the
helpers, never raw `env.LOADOUT_BOLTS.get()`.

---

## 7. Ladder, trophies, Bolts cap (LOCKED)

- **Trophies:** per-user, not per-channel. A win against a human
  is +12 trophies (±3 swing on opponent's trophy delta). A win
  against an NPC is +3. A loss is -10 vs human, -1 vs NPC. Floor 0.
- **Tiers:** bronze (0+), silver (200+), gold (500+), platinum
  (1000+), diamond (2000+). Match-making prefers same-tier
  opponents but doesn't require it (queue is small).
- **Bolts payout:** win against a human pays 50 Bolts; win
  against an NPC pays 10 Bolts; loss pays 0. Capped at **500
  Bolts/day** per viewer (`cards:ladder:<userId>:<YYYYMMDD>`)
  — this is the locked cap that earlier drafts left open. The
  500-cap is one Bolt Pack's worth + change, so a heavy day's
  ladder grind converts to two Bolt Packs and stops.
- **Season:** Phase 1 has no seasons — trophies persist forever
  until we explicitly add a reset. (When seasons land, the
  `season` field on the trophies record advances; old peak is
  preserved.)

---

## 8. Anti-grief / exclusions

Reuse `isExcluded` from `clash-state.js`. Same rule: Clay's
testing accounts don't show on the public leaderboard. The card
game itself is unaffected.

Concede penalty: conceding mid-match counts as a loss for trophy
math. Auto-pass (timeout) past 3 turns: same. No "rage-quit
without a hit" loophole.

Direct-challenge spam: a direct challenge sits in the recipient's
`cards:matchref:` slot only after they accept. The pending
challenge record (`cards:challenge:<guildId>:<recipientId>`) caps
at 3 outstanding per recipient and TTLs after 24h, so a viewer
can't spam a hundred matches into someone's inbox.

---

## 9. Surfaces NOT shipping in Phase 1

These are deliberately deferred to the aquilo-site repo:

- **Web battler UI** (loadout.aquilo.gg/boltbound) — fancy
  click-to-target turn UI, animated board state, etc. Phase 1
  is Discord-only. The web reads the same `cards:match:<id>`
  record when it lands.
- **Pack-opening page** — the "pulls reveal one by one" animation
  surface. Phase 1's Discord opener returns all 5 cards in one
  embed. The pre-rolled pulls live in `cards:pending:.rolled[]`
  so the web page is just an animation-only consumer.
- **Twitch panel TCG view** — read-only "this viewer is in a
  match" badge + last-match-receipt summary in the Twitch
  extension panel. Same backend.

All three of these will sit on the same `cards:` KV prefix and
the same server-resolved logic — no parallel client-side game
state. Phase 2 work, separate repo.

---

## 10. Roadmap after Phase 1

For context — not committed scope, just the next-pass shape:

- **Phase 2: aquilo-site surfaces** — web battler, pack opener,
  Twitch panel. Same backend.
- **Phase 3: cross-game flow** — Boltbound wins feed dungeon XP,
  dungeon kills feed Boltbound XP. Voltaic-tier card art reflects
  the dungeon's Voltaic set.
- **Phase 4: events + tournaments** — seasonal ladders, streamer-
  hosted brackets ("Vault Open"), event-only card backs.
- **Phase 5: trading / gifting** — opt-in pack-gifting and card
  trading between linked viewers. Tightly bolted to the Patreon
  link for fraud control.

None of this is committed. Phase 1 ships first.

---

## 11. File layout (Phase 1)

```
discord-bot/
  cards-content.js   - static catalogue, abilities, champions, NPC decks
  cards-state.js     - all reads/writes against cards:* KV
  cards-packs.js     - pack opening, pull rates, creditPack, free-daily
  cards-battle.js    - simulate() + ability resolver, pure
  cards-decks.js     - deck CRUD + validation
  cards-match.js     - match orchestrator + PvP queue + NPC turn driver
  cards.js           - slash-command dispatch + Discord embed renderers
```

Plus four integration edits:

- `clash.js handleRaid` → call `creditPack` on raid receipt
- `ext-lootbox.js DEFAULT_CATALOG` → three pack entries with the
  pack-slot dispatch
- `commands-spec.js` → publish `/boltbound`
- `commands.js` → route the slash command + components

`CARD-ART-PIPELINE` lives on its own pass — sprite generator
add-ons go into `tools/build-sprites.ps1`. Out of Phase 1 worker
scope; tracked separately.

---

## 12. Open questions

None. Doc is LOCKED. If something needs to change post-lock, file
it as a Phase 2 change request — don't edit this doc in place.

---

## 13. Roster expansion — 1,000+ cards via family generator

This is the **2026-05-21 expansion** — the catalogue grows from 82 to
~1,000+ cards. Hand-curating that many would balloon the file and
introduce silent balance drift; instead `cards-content.js` keeps the
hand-curated champions / legendaries / signature rares as-is and
imports a *programmatic* block from `cards-catalog-gen.js`.

### 13.1. Goal

Clay wants **a ton of options**, kept balanced and not power-crept.
That means:

- Every card sits on a deterministic stat curve (see §13.4).
- Variety comes from **archetype × family × keyword × ability**
  combinations, not from stat inflation.
- Rare ≠ "common +2/+2". Rares earn their slot via abilities, not raw
  numbers. Legendaries earn theirs via unique mechanics.
- One pack of any tier still drops a usable card — no commons are
  vendor-trash filler.

### 13.2. Catalogue composition (LOCKED)

| Source | Count (target) | How it's authored |
| --- | --- | --- |
| Champions | 5 | Hand-curated in `cards-content.js` (unchanged). |
| Legendary heroes | 12 | 5 originals + 7 new flagship heroes. Hand-curated. |
| Legendary bosses | 18 | 5 originals + 13 new family flagships (one per major family). Hand-curated. |
| Signature rares | 30 | 14 originals + 16 new hand-curated rares with bespoke mechanics. |
| Programmatic rares | ~120 | Family × mana × variant grid, generated. |
| Programmatic uncommons | ~270 | Family × mana × variant grid, generated. |
| Programmatic commons | ~480 | Family × mana × variant grid, generated. |
| Spell schools | ~70 | 7 schools × ~10 effects × mana, generated. |
| Tokens | ~15 | Hand-curated (summoned by other cards). |
| **Total** | **~1,020** | |

The exact final count is what the generator emits at module load —
the `npcDeckCheck` and `dedupeCheck` IIFEs that already guard the
hand-curated set extend to the generated cards too, so a duplicate
id or unknown reference crashes at deploy time.

### 13.3. Families

A family is a flavor + palette + signature-keyword bundle. Every
programmatic card belongs to exactly one family. Sprites paint the
family's character archetype (skin, gear, weapon class), so a
viewer reading the board can tell at a glance that a Voltaic Adept,
Voltaic Wyrm-Cub, and Voltaic Surge spell are all the same family.

Families (~36) are defined in `cards-catalog-gen.js` and grouped here
for documentation purposes:

```
Aggro / swarm:        goblin, vermin, scrapper, pirate, bandit
Tank / taunt:         knight, vault-guard, paladin, treant, construct
Caster:               mage, voltaic, sorcerer, oracle, mystic
Stealth / utility:    rogue, ninja, bounty, phantom, shadow-blade
Beast / wild:         beast, ranger, druid, wolf-pack, hunter
Undead / death:       skeleton, necromancer, ghoul, lich-kin, wraith
Demon / sacrifice:    demon, warlock, cultist, hellspawn
Holy / heal:          priest, spirit, cleric, paladin*, oracle*
Elemental:            elem-fire, elem-frost, elem-storm, elem-earth
Misc flagships:       dragon, witch, berserker, shaman, bardic
```

`*` = family appears in multiple groups; archetype overlap is fine.

Each family declares:

```js
{
  key: 'goblin',                              // stable id prefix
  archetype: 'aggro-swarm',                   // stat-curve template
  flavor: { skin: 'green', body: 'leather' }, // sprite hints
  palette: 'leather',                         // material ramp key
  signatureKeyword: 'charge',                 // applied to roster
  signatureEffect: null,                      // optional onPlay/etc.
  manaCurve: [1, 1, 2, 2, 3, 4],              // distribution
  legendaryName: 'Goblin Warchief',           // hand-curated flagship
}
```

### 13.4. Stat curve (deterministic, no power creep)

The generator's stat formula keeps the catalogue inside a tight band
no matter how many cards we add. Per card:

```
baselineTotal = mana * 2 + 1           // 1m=3, 2m=5, 3m=7, …, 10m=21
atk           = round(baselineTotal * archetype.atkBias)
hp            = baselineTotal - atk
```

Per-rarity adjustment (the "stat tax" you pay for the keyword/effect
slot — the design rule is **keywords cost stats, not the other way
around**):

```
common:    stats *= 1.00   no keyword, no ability  (vanilla glue)
uncommon:  stats *= 0.85   ONE keyword OR one tiny effect
rare:      stats *= 0.80   one ability + scaling/condition
legendary: stats *= 1.00   one unique mechanic
```

The archetype bias table (lives in `cards-catalog-gen.js`):

| Archetype | atkBias | hpBias | Bias rationale |
| --- | --- | --- | --- |
| aggro-swarm | 0.60 | 0.40 | front-loaded ATK, small HP |
| balanced | 0.50 | 0.50 | vanilla glue, no swing |
| taunt-tank | 0.35 | 0.65 | mostly HP, low ATK |
| caster | 0.55 | 0.45 | trades a hair of HP for ATK |
| stealth-utility | 0.60 | 0.40 | hits-and-runs |
| undead | 0.45 | 0.55 | sticky, dies twice |
| holy | 0.40 | 0.60 | HP heavy, heal hero |
| elemental | 0.50 | 0.50 | balanced with effect |
| dragon | 0.55 | 0.55 | flat 10% above curve (flagship) |

The curve enforces that a 4-mana rare can't be a 5/5 with a free
keyword. The generator rounds atk/hp so the **sum** stays on the
curve; either stat may end up at 0 (e.g. a 1-mana taunt-tank ends up
1/2 not 0/3).

### 13.5. Variant slots

For each (family, mana, rarity) cell the generator emits **multiple
variants** so the catalogue isn't just one common Goblin per mana.
Variant differs by:

- one-word name flavor ("Runt", "Brute", "Tracker", "Whelp", …)
- minor stat shuffle inside the curve ATK/HP split (±1, sum-preserving)
- secondary keyword for uncommons (one of the family's allowed list)
- secondary effect for rares (one of the family's allowed effect set)

The name pool + variant table lives in the generator. A family with
6 manas × 3 rarities × 2 variants/cell = 36 cards; ~30 families ×
~10 = ~300+ minion cards. Spell schools fill the rest.

### 13.6. Spell schools

Seven schools, each with ~10 effects across mana:

| School | Theme | Sample effects |
| --- | --- | --- |
| fire | damage | bolt 1→6, AOE, burn-line |
| frost | freeze + control | freeze, slow, dmg+freeze |
| holy | heal + protect | heal, shield, bless |
| shadow | drain + debuff | drain, weaken, discard |
| nature | buff + summon | buff, summon, regrowth |
| arcane | utility + counter | counter, draw, peek, shuffle |
| storm | chain + burst | chain dmg, burst, surge |

Each effect-mana combo emits one common, one uncommon, one rare
variant — that's where the spell-card count comes from.

### 13.7. Determinism + balance enforcement

The generator is fully **deterministic** — same code in = same card
ids and stats out. That means:

- `cards-content.js` exports the same catalogue on every deploy
- collections referencing card ids stay stable
- a rebalance is a code edit + a new commit, with a clear diff

A module-load-time IIFE re-runs the cap checks: per-rarity card
counts in `RARITY_POOLS`, stat-curve compliance, unique ids, valid
keyword references. Fails fast at deploy time, not at runtime.

---

## 14. Recycle → Fragments → Craft Pack

The grind-it-out loop that complements the bolts-purchase loop.

### 14.1. Rationale

Some viewers will play hundreds of matches and end up sitting on
piles of duplicate commons they can't use (deck cap is 4). Today
those past-cap pulls already convert to bolts via `DUPE_BOLTS`. But
that only catches *future* pulls — it doesn't help a viewer who
already has 4 copies of a card they'll never play. Fragments fix
that:

- Recycling a card the viewer **owns** yields **Pack Fragments**
  (a soft currency, scaled by rarity).
- Fragments craft new packs. Fragment-to-pack rate is set **above**
  the bolt-equivalent cost of the same pack — bolts are still the
  faster path. Fragments are the slow grinder's safety net.

### 14.2. Fragment yield (LOCKED)

| Rarity | Fragments per card recycled |
| --- | --- |
| common | 1 |
| uncommon | 4 |
| rare | 20 |
| legendary | 100 |

Champions and tokens cannot be recycled (not in collection anyway).

### 14.3. Craft prices (LOCKED — costs MORE than bolts)

The Bolt Pack costs 250 bolts. Recycling enough commons to clear a
deck cap from a viewer's pulls yields roughly 1 fragment per common
opened. We set the fragment price *above* the bolt-equivalent:

| Pack | Fragments cost | Bolts equivalent | Premium |
| --- | --- | --- | --- |
| Boltbound Common Pack | 50 | n/a (free daily) | — |
| Boltbound Bolt Pack | 400 | 250 bolts (~ 250 frag if 1c=1f) | 60% premium |
| Boltbound Voltaic Pack | 1200 | drop-only (no purchase) | — |

The "premium" enforces Clay's rule: **fragments cost MORE than
bolts**. A viewer is never better off recycling and crafting than
just buying the pack directly. Crafting is the route for viewers
who farm matches but have run out of useful cards to keep, or who
want to convert a *specific* card they don't want into pack equity.

### 14.4. KV schema (extends §6)

| Key | Value | Notes |
| --- | --- | --- |
| `cards:frag:<userId>` | `{ frag, ts, recycled, crafted }` | Per-user fragment balance + stats. Per-user (not per-guild) — fragments travel across channels. |

### 14.5. Public API (`cards-fragments.js`)

```js
export async function getFragments(env, userId)
  // → { frag, recycled, crafted, ts }

export async function recycleCards(env, guildId, userId, items)
  // items: [{ cardId, count }]   // count clamped to owned past… wait, no
  // — recycling can take cards you currently own. Each removed copy
  // yields RECYCLE_YIELD[rarity] fragments. Cannot recycle champions
  // or tokens. Active deck's cards CAN be recycled (the deck flagging
  // its missing card on next /boltbound match is the punishment).
  // → { ok, removed: [{cardId, count, fragYield}], fragTotal, balance }

export async function craftPackFromFragments(env, guildId, userId, packType)
  // Debits CRAFT_COST_FRAG[packType] from balance, then calls
  // creditPack(... source:'crafted-frag'). Errors if balance < cost.
  // → { ok, pack, balance } | { ok:false, error:'insufficient-frag', need, have }
```

The `source` enum already used by `creditPack` gets a new value:
`'crafted-frag'`. Receipts in `/boltbound log` flag fragment-crafted
packs distinctly so the grind feels rewarded.

### 14.6. Surface hooks

**Discord (cards.js)** — adds two subcommands:

```
/boltbound recycle             — paginated picker UI (select-menu) to
                                  choose duplicates to recycle. Defaults
                                  to "recycle everything past deck cap".
/boltbound craft pack:<type>   — craft a pack from fragments.
/boltbound status              — already exists; gains a "Fragments: N"
                                  row above the pack list.
```

**Web (aquilo-site, later)** — adds:

- `/boltbound/collection` shows a "Recycle" button per card with the
  per-card fragment yield as the tooltip.
- `/boltbound/craft` is a dedicated page with a fragment counter, a
  pack-type picker, and a "craft" button.

**Twitch panel** — a small fragment counter chip next to the bolt
counter, read-only.

The web + panel surfaces hit `cards-web.js`'s existing JSON endpoints
(see §9). New endpoints documented in `cards-web.js`:
- `GET  /api/boltbound/fragments` → balance
- `POST /api/boltbound/recycle`  → recycle the listed cards
- `POST /api/boltbound/craft`    → craft a pack

All three go through the same `cards-fragments.js` module the Discord
surface uses; no parallel server-side logic.

---

## 15. Sprite generator — 1,000+ unique pixel-art cards

The current `tools/build-card-sprites.ps1` has a hand-written `Draw-Card-*`
function for each of the 82 cards. That doesn't scale to 1,000+, and
Clay wants the new bar to be **cooler and more detailed** than the
existing set, not flatter.

### 15.1. Strategy

Two-tier render:

1. **Hand-tuned draws** — champions (5), legendaries (~30), and
   the signature rares (~30) keep their bespoke `Draw-Card-*`
   functions. These are the cards a viewer sees often and recognises
   by silhouette; they earn the bespoke treatment.
2. **Template draws** — every programmatic card dispatches into a
   **family template** (e.g. `Draw-Family-Goblin`) with per-card
   parameters (size, pose variant, weapon variant, accent gem). The
   template produces a unique-looking sprite from the same primitives
   `lib-pixel.ps1` already exposes (Draw-Humanoid, Draw-Blade, Gem-Palette,
   etc.) — no two cards share an identical pixel layout because the
   variant params shift weapon/pose/accent slot.

### 15.2. Rarity-scaled detail

The `Rarity-Detail` ramp (already in `lib-pixel.ps1`) now drives
extra adornments:

| Rarity | Detail tier | Adornments added |
| --- | --- | --- |
| common | 0 | base figure + ground shadow only |
| uncommon | 1 | + faction sigil pip + simple weapon trim |
| rare | 2 | + accent gem + emblem stripe + rim light |
| legendary | 4 | + APNG halo pulse + sigil aura + double rim |

Legendaries remain **APNG-animated** (already in pipeline via
`build-card-apng.mjs`). The halo radius/alpha pulse stays; the
silhouette is more detailed than the current Phase-1 set thanks to
extra accent slots (gem, sigil, plume).

### 15.3. Family palette → material ramp

Each family declares a palette key (e.g. `leather`, `steel`, `voltaic`).
The sprite generator resolves it to a 5-tone material ramp from
`lib-pixel.ps1` (MAT_STEEL, MAT_LEATHER_BLACK, …). Skin tones come
from the family's `flavor.skin` field (green, bone, pale, etc.).
This means a 200-card family generates 200 visually-coherent sprites
without any per-card colour authoring.

### 15.4. Deterministic variation

The per-card RNG (Rng-Init, Rng-Pick) is seeded by the card id.
That seed drives:

- weapon variant pick (axe vs sword vs spear for warrior-flavor)
- pose tilt (head left / right / forward)
- accent gem slot fill (or skip)
- background flourish (none / faint / strong)

Same card id → same sprite, every time. Same machinery as the
character + clash generators.

### 15.5. Performance

GDI+ `SetPixel` averages ~5K pixels per card on a 64×80 canvas with
the current density. 1,000 cards × 5K = 5M pixels. Hand-timing the
existing run is ~5 min for 82 → ~60 min for 1,020 cards. Acceptable
for a once-per-deploy regen; the script writes incrementally so a
restart resumes mid-set if needed.

### 15.6. Outputs

Same path convention as Phase 1:
```
aquilo-gg/sprites/cards/<cardId>.png             64×80 PNG (animated for legendary)
aquilo-gg/sprites/_card-legendary-frames/...     per-frame frames for APNG stitch
```

No emoji glyphs anywhere — the existing rule (CARD-GAME-DESIGN.md §1)
holds across the expansion.

---
