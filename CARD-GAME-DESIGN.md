# Boltbound — Loadout's async card-battler

> Status: **LOCKED — Phase 1 building.** Name and roster are final.
> No streamer/Spotlight tier. Open questions resolved per the
> defaults already proposed in earlier drafts and locked here.
>
> Author: Loadout team · Date: 2026-05-21 · Owner: Clay
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

# Expansion (post-lock change request CR-1)

> Status: **LOCKED — building.** Clay 2026-05-something:
> *"Expand to 1,000+ cards for deep combat and deck-building. Add a
> recycle → fragments → craft-pack loop so collecting is easier.
> Make card art cooler."*
>
> The original 82-card roster ships unchanged. CR-1 ADDS new cards
> with a new ID scheme (`<family>.<rarity-letter><nnn>`) so existing
> collections continue to validate. The locked §2 battle format is
> unchanged. New ability keys + keywords may be added; existing ones
> are preserved.

---

## 13. Expansion roster — 1,000+ cards (LOCKED)

### 13.1. Why a generator, not 1,000 hand-author lines

Hand-authoring a thousand card records is achievable but expensive in
maintenance: every balance pass touches a thousand rows. We
generate the expansion catalogue from a small **family declaration**
file: each family supplies its name list, palette tint, visual
archetype hint, and an effect-weight table; the generator stamps out
the matching minions and spells. The output is a JS object literal
checked into git — generation happens at *authoring* time, not at
runtime, so the deployed worker still reads a static catalogue and
nothing about determinism, replays, or pack pulls changes.

A balance edit (e.g. "Beast common minions cost 1 mana more for the
same statline") changes one declaration row and re-runs the
generator. The diff is one line.

### 13.2. Families (15) and roster targets

15 families, themed for both flavour and synergy. Synergy keywords
(`tribe:beast`, `tribe:undead`, etc.) get stamped on each card and
unlock the next phase's "tribe-payoff" rare/legendary cards — out of
CR-1 scope mechanically, but the tag is reserved on every card so a
future pass can light them up without re-IDing the roster.

| Family | Tribe tag | Vibe | Stats lean |
| --- | --- | --- | --- |
| **beast**  | beast      | Forest predators, packs, wild | balanced |
| **undead** | undead     | Skeletons, zombies, ghouls, lich-aligned | aggressive, deathrattle-heavy |
| **fire**   | elemental  | Salamanders, flame imps, fire spells | spell-heavy, direct dmg |
| **frost**  | elemental  | Ice golems, frost wisps, freeze | stall + control |
| **storm**  | elemental  | Lightning, voltaic-aligned | burst dmg + AoE |
| **shadow** | shadow     | Shades, assassins, hexes | stealth + poison |
| **light**  | light      | Priests, paladins, holy | heal + buff |
| **arcane** | arcane     | Mages, scribes, arcane | draw + utility |
| **wild**   | beast      | Rangers, druids, nature (synergises beasts) | mid-curve, ramp |
| **forge**  | construct  | Engineers, golems, mechs | buff + scaling |
| **goblin** | goblin     | Goblin scrappers, sappers (extends warchief lineage) | swarm + cheap minions |
| **dragon** | dragon     | Dragons, dragonkin | high-mana, big stats |
| **demon**  | demon      | Demons, fiends, pacts | self-damage for value |
| **fae**    | fae        | Sprites, fairies, charm | bounce + buff |
| **vault**  | vault      | Treasure hunters, runesmiths | dig + draw |

Per-family card counts:

| Rarity | Per family | × 15 families | Total |
| --- | --- | --- | --- |
| Common | 36 | 540 | **540** |
| Uncommon | 18 | 270 | **270** |
| Rare | 8 | 120 | **120** |
| Legendary | 2 | 30 | **30** |

**Expansion total: 960 new cards.** Combined with the original 82
(5 champs + 10 legends + 14 rares + 20 uncommons + 31 commons + 2
tokens), the live roster is **1,042 cards**.

### 13.3. Stat-cost formula (the dial)

Vanilla baseline: `(atk + hp) ≈ 2 × mana + 1`. So a 3-mana vanilla
common is a 3/4 or 4/3 or 2/5. Abilities cost stat points off the
vanilla baseline:

| Ability | Stat cost |
| --- | --- |
| `taunt` keyword | 0 (free defensive lockdown) |
| `charge` keyword | -2 stats (offence — strong) |
| `shield` keyword | -1 stats |
| `stealth` keyword | -1 stats |
| `lifesteal` keyword | -2 stats |
| `poison` keyword | -2 stats |
| `reach` keyword | -1 stats |
| `onPlay: damage N (picked)` | -N stats |
| `onPlay: damage N (allEnemy)` | -2N stats |
| `onPlay: heal N` | -N/2 stats (rounded up) |
| `onPlay: draw N` | -2N stats |
| `onDeath: summon (1/1)` | -1 stats |
| `onDeath: summon (3/3)` | -3 stats |
| `endOfTurn: heal 2 (friend)` | -2 stats |
| `spellDamageBonus +1` | -1 stats |

Rarity inflates the stat budget on top of vanilla:

| Rarity | Stat budget vs vanilla |
| --- | --- |
| common    | +0 |
| uncommon  | +1 |
| rare      | +2 |
| legendary | +3 to +4 + unique mechanic |

That gives commons honest "deck glue" feel, uncommons feel slightly
more efficient, rares are the swing cards, legendaries are
must-build-around.

### 13.4. Mana curve (per family)

Each family's commons distribute across the curve:

| Mana | Commons / family |
| --- | --- |
| 1 | 4 |
| 2 | 6 |
| 3 | 6 |
| 4 | 6 |
| 5 | 5 |
| 6 | 4 |
| 7 | 3 |
| 8 | 2 |

Uncommons + rares lean mid-to-high (3-7). Legendaries are
strictly 5-10.

About 20% of each family's commons + uncommons are spells (mostly
1-3 mana). Rares and legendaries are predominantly minions.

### 13.5. New ability keys + keywords (extending §3)

CR-1 adds these to the locked ability dictionary:

**Effects (new):**
- `freeze` — target minion has `frozen` status; can't attack for 1 turn.
- `selfDamage` — value: N. Demon family — self-hero takes N to gain value elsewhere.
- `peekDeck` — already in §3, formalised here. Show top N cards of own deck.
- `boostCost` — value: N. Target card in hand gets +N mana cost next turn.
- `discountCost` — value: N. Target card in hand gets -N mana cost (clamped at 0).
- `transform` — replace target with `cardId` token.

**Keywords (new):**
- `frozen` (status, not on-card) — minion cannot attack this turn.
- `rush` — can attack minions on play-turn but not hero (between charge and vanilla).
- `divine-light` — first damage instance is halved (rounded up).
- `regen` — heals 1 HP at end of each owner turn.
- `wisp` — bounces back to hand on death instead of graveyard.

Resolver work: 5 new effects + 5 new keywords. Out of doc scope —
see `cards-battle.js` extension in cards-content-expansion.js.

### 13.6. The new ID scheme

Existing 82 cards keep their IDs (`c.gobrunt`, `u.scrapper`,
`r.boltknight`, `leg.solara`, `champ.warrior`, `tok.boneknight`).

New cards use **`<family>.<rarity-letter><nnn>`**:

- `beast.c001` — first beast common
- `beast.u004` — fourth beast uncommon
- `beast.r002` — second beast rare
- `beast.l001` — first beast legendary

Why a new scheme: avoids collision with existing single-prefix IDs
on every front (collection records, deck records, sprite paths,
pack pulls). Lets the catalogue grow further (CR-2 etc.) without
running out of namespace.

---

## 14. Recycle → Fragments → Craft (LOCKED)

### 14.1. The collecting loop, expanded

Pre-CR-1 loop: open packs → cards land in collection → past
deck-cap dupes refund Bolts. The Bolts refund stays. CR-1 adds a
**player-initiated** path:

> **Recycle owned cards → Fragments → Craft packs.**

Different from the dupe refund: dupes only fire on *new* pulls
that exceed cap. Recycling consumes cards you ALREADY own and
willingly destroy. The two paths coexist — they reward different
behaviours.

### 14.2. Recycle yields (LOCKED)

| Rarity | Fragments per card recycled |
| --- | --- |
| common    | 5 |
| uncommon  | 20 |
| rare      | 100 |
| legendary | 500 |
| champion  | NOT recyclable |
| token     | NOT in collection — not applicable |

Symmetric with the dupe-Bolts refund table (also `5 / 20 / 100 /
500`). One unit of fragment ≈ one Bolt in raw value; the craft
prices below introduce the friction.

### 14.3. Craft costs (LOCKED)

| Pack | Bolts price | Fragment craft | Multiplier |
| --- | --- | --- | --- |
| **Common Pack**   | n/a (1/day free, lootbox, Clash 1★) | **100 frags** | — |
| **Bolt Pack**     | 250 Bolts | **400 frags** | **1.60× the Bolts cost** |
| **Voltaic Pack**  | drop-only | **1500 frags** | only craftable path |

Crafting a Bolt Pack costs **60% more** raw value than buying one.
Fragments are the SLOW path: pure Bolts is faster. Recycling is
about "I have these I'll never play, give me a way to convert
them into rolls" — not about beating the Bolts economy.

Voltaic Packs were drop-only pre-CR-1. CR-1 adds a craft path so a
diligent fragment grinder can earn them too — at the cost of 1500
frags (≈ 300 common recycles, or 15 rares).

### 14.4. Recycle gating

- Cannot recycle a card if recycling it would leave you below the
  count present in any of your saved decks. The recycle helper
  returns a clear error pointing at the offending deck.
- Cannot recycle the active deck's full count of a card — same
  rule applied to the active deck specifically.
- Cannot recycle a Champion (any `champ.*` card).
- Hard floor at 1 per recycle action — no "recycle 0 to inspect" hack.

### 14.5. KV layout

New key family:
- `cards:frags:<userId>` → integer balance. Per-user (not per-guild)
  — same scope as trophies. TTL: none.

(Per-guild scoping would force re-grinding when a viewer plays in a
new channel; per-user matches the "your collection is yours
forever" feel.)

### 14.6. Module surface

`cards-fragments.js` (new):
- `getFragments(env, userId)` → integer
- `addFragments(env, userId, delta, reason)` → integer
- `recycleCard(env, guildId, userId, cardId, count)` → result
- `craftPack(env, guildId, userId, packType)` → result

Bolts purchase path stays in `cards-packs.js`. The craft path
shares `creditPack` to mint the pending pack — same downstream
flow as a Bolts buy or a Clash drop.

### 14.7. Discord surface

New slash subcommands on `/boltbound`:

- `/boltbound recycle card:<id> count:<n>` — recycle owned cards
- `/boltbound craft pack:<bolt|voltaic|common>` — craft from fragments
- `/boltbound fragments` — show fragment balance + craft prices

`/boltbound status` adds a fragment-balance line.

### 14.8. Web / panel hook points (for the aquilo-site repo)

Routes added to `cards-web.js`:
- `POST boltbound/recycle` `{ cardId, count }` → `{ ok, fragmentsAfter, recycled }`
- `POST boltbound/craft`   `{ packType }`     → `{ ok, fragmentsAfter, packId }`
- `GET  boltbound/state` extended with `fragments: <number>`

The web pack-opener page (Phase-2 aquilo-site work) gets a "Craft
Pack" CTA next to "Buy Pack". The Twitch panel TCG view gets a
read-only fragment-balance chip in the header.

---

## 15. Card art — extended pipeline (CR-1)

Clay's directive: *"Cards should look cooler."*

Current 82-sprite pipeline hand-authors each card. Extending the
same pattern to 1,000 sprites doesn't scale, so we move to an
**archetype-template** approach inside the same generator:

### 15.1. Archetype templates

Each card declares a `visualArchetype` (e.g. `humanoid-warrior`,
`beast-quad`, `undead-skeleton`, `elemental-fire`, `dragon-flier`,
`spell-bolt`, `spell-circle`). The generator maps archetype +
family palette + accessory hints to a procedural sprite recipe.

Initial 15 archetypes (Phase 5 sprite pass):

| Archetype | Used by |
| --- | --- |
| humanoid-warrior  | wild, forge, light, vault knights |
| humanoid-mage     | arcane, fire, frost, storm casters |
| humanoid-rogue    | shadow, fae, goblin |
| humanoid-priest   | light priests, healers |
| beast-quad        | beast, wild quadrupeds |
| beast-bird        | wild rangers' companions, fae |
| undead-skeleton   | undead (skeletons, lich) |
| undead-zombie     | undead (zombies, ghouls) |
| elemental-fire    | fire family minions |
| elemental-frost   | frost family minions |
| elemental-storm   | storm family minions |
| construct-golem   | forge family minions |
| construct-mech    | forge family advanced |
| dragon-flier      | dragon family |
| demon-fiend       | demon family |
| spell-bolt        | direct-damage spells |
| spell-circle      | summon / utility spells |
| spell-heal        | heal spells |
| spell-buff        | buff spells |

The card's **detail tier** scales with rarity:

| Rarity | Detail tier |
| --- | --- |
| common    | 3-tone shade, simple silhouette |
| uncommon  | + accent color, outline highlight |
| rare      | + rim light, sub-detail (belts, runes), glow halo |
| legendary | full detail + 4-frame APNG animation |

### 15.2. Generation flow

`tools/build-card-sprites.ps1` is extended with one new function per
archetype: `Draw-Archetype-<Name>` that takes `(bmp, palette,
accessory, detailTier)` and produces the sprite. The catalogue's
`visualArchetype` field drives which function the generator calls
for each card.

Output paths stay the same:
- `aquilo-gg/sprites/cards/<cardId>.png` for static
- `aquilo-gg/sprites/_card-legendary-frames/<slug>-fx-<n>.png` →
  stitched by `build-card-apng.mjs` into `cards/<cardId>.png` for
  animated legendaries.

The expansion sprite pass runs in chunks (one family at a time)
because regenerating 1,000+ sprites in one shot is slow on a single
machine. The PS1 script honours the existing `-Only` flag and gets
a new `-Family` flag to scope generation.

### 15.3. No emoji — confirmed

Standing rule from §1 holds. No emoji glyphs in any card record.
All card art is custom pixel art, served from
`aquilo.gg/sprites/cards/<cardId>.png`.

---

## 16. Migration + compatibility

- Existing 82 cards: untouched. Their IDs (`c.*`, `u.*`, `r.*`,
  `leg.*`, `champ.*`, `tok.*`) stay valid. Their sprites stay valid.
- Existing decks: still valid. Existing collections: still valid.
- Existing pulled packs: still valid (rolls were frozen at open
  time; the new catalogue's only effect is on FUTURE rolls).
- NPC archetype decks: regenerated to use the expanded pool. Old
  IDs may still appear — no break.
- Pack pull rates: unchanged. The rarity weighting (60/30/9/1 in a
  Bolt Pack etc.) stays — there are just more cards in each pool.
- `RARITY_DECK_CAP`, `DUPE_BOLTS`, `STARTING_HP`, `DECK_SIZE`:
  unchanged.

Anything not explicitly changed in §13-15 is unchanged.

---

## 17. Roadmap after CR-1

For context — not committed, just shape of next passes:

- **CR-2: Tribal-payoff cards** — cards that read "+X for every
  Beast you control" etc. Hooks already in place via the
  `tribe:beast` tag stamped on each card.
- **CR-3: Crafting-loop UX** — pity counters specific to fragment
  craft, "next legendary in N crafts" surfacing.
- **CR-4: Web pack-opener animations** — read pre-rolled pulls, do
  the fancy reveal on aquilo-site.

