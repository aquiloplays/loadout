# Boltbound expansion — build notes (2026-05-21)

> Branch: `claude/kind-cerf-2bc1fe`. Pairs with the §13 / §14 / §15
> additions to `CARD-GAME-DESIGN.md`. This file is the operational
> companion — what was built, where it lives, and how to extend it.

## Scoreboard

| Metric | Before | After |
| --- | --- | --- |
| Total cards | 82 | **1,593** |
| Champions | 5 | 5 |
| Legendary | 10 | 32 _(10 original + 22 family flagships)_ |
| Rare | 14 | 279 _(14 + 16 signature + 249 generated)_ |
| Uncommon | 20 | 536 _(20 + 516 generated)_ |
| Common | 31 | 814 _(31 + 783 generated)_ |
| Spells | (in counts above) | ~70 across 7 schools |
| Tokens | 2 | 8 |
| Pack types | 3 | 3 _(unchanged — common / bolt / voltaic)_ |
| Currencies | Bolts | Bolts + **Pack Fragments** |
| Pack sources | bolts buy, daily, clash drop, lootbox | + **fragment craft** |

Sprite rendering target: **one 64×80 PNG per non-token card** (APNG
for legendaries). ~1,500 sprite files committed to
`aquilo-gg/sprites/cards/`.

## File map of the expansion

```
discord-bot/
  cards-content.js         — hand-curated + imports generator
  cards-catalog-gen.js     — NEW — family × mana × rarity grid
  cards-fragments.js       — NEW — recycle / craft loop + invariant check
  cards-packs.js           — unchanged (creditPack now accepts 'crafted-frag' source)
  cards-state.js           — unchanged
  cards-battle.js          — unchanged
  cards.js                 — + fragments / recycle / craft handlers
  cards-web.js             — + /boltbound/fragments | /recycle | /craft endpoints
  commands-spec.js         — + slash-command schema for new subcommands

tools/
  build-card-sprites.ps1   — + family-template dispatch + manifest loader
  dump-card-manifest.mjs   — NEW — JS -> JSON manifest for the PS script
  build-card-apng.mjs      — unchanged (handles whatever frames the PS script drops)

CARD-GAME-DESIGN.md         — + §13 (1,000+ cards), §14 (fragments), §15 (sprites)
BOLTBOUND-EXPANSION-NOTES.md — this file
```

## How the catalogue is generated

`cards-content.js` builds `RAW_ROSTER` from:

1. Hand-curated arrays (verbatim) — champions, original legendaries,
   the 22 new family flagships, originals + 16 signature rares,
   uncommons, commons, tokens.
2. `generateCatalogue()` from `cards-catalog-gen.js` — the
   programmatic block.

The generator iterates a `FAMILIES` table (~36 entries) × mana range
× rarity tier × variant slot, applying the deterministic stat curve
in `statsFor()`. Stat curve formula:

```
total = mana * 2 + 1
total *= { common: 1.00, uncommon: 0.85, rare: 0.80, legendary: 1.00 }
atk = round(total * archetypeBias.atkBias)
hp  = total - atk
```

Keywords / abilities are picked from per-family + per-rarity allow-lists
so each card respects its family's flavour. The IIFE at the bottom of
`cards-content.js` re-runs `dedupeCheck` against the merged set —
duplicate ids crash at module load, not at runtime.

### To add a new family

1. Add a `{ key, name, archetype, palette, skin, template, weapon,
   sig, keywords, keywordPool, minMana, maxMana, nameSuffixes }` entry
   to `FAMILIES` in `cards-catalog-gen.js`.
2. If you used a new `template` value, add a `Family-<NewTemplate>`
   render function in `tools/build-card-sprites.ps1` and wire it
   into `Family-Dispatch`.
3. If you used a new `palette` or `skin` key, add it to
   `$PALETTE_BY_KEY` / `$SKIN_BY_KEY` in the sprite script.
4. Re-run `node tools/dump-card-manifest.mjs` then
   `pwsh tools/build-card-sprites.ps1`.

### To add a new spell

Append to a `SPELL_SCHOOLS[].spells[]` entry in
`cards-catalog-gen.js`. The id format is
`<tier>.sp.<schoolKey>.<index>`.

## Fragment loop (§14)

Storage:
```
cards:frag:<userId> = { frag, recycled, crafted, ts }
```

Yields:
- common: **1** frag per copy recycled
- uncommon: **4**
- rare: **20**
- legendary: **100**

Craft prices:
- Common Pack: **50** frag
- Bolt Pack: **400** frag _(strictly > 250 bolts — locked by IIFE)_
- Voltaic Pack: **1,200** frag

Discord surface adds `/boltbound fragments`, `/boltbound recycle`,
`/boltbound craft`. Web/panel hits `boltbound/fragments`,
`boltbound/recycle`, `boltbound/craft` in `cards-web.js`.

## Sprite generation

Two-tier render:

1. **Hand-tuned** — every existing `Draw-Card-*` function in
   `build-card-sprites.ps1` remains the entry point for cards in
   `$CARD_DRAW`. The 82 originals keep their bespoke art.
2. **Family templates** — anything else dispatches to
   `Family-Dispatch` keyed by manifest entry's `template` field.
   The manifest's `dump-card-manifest.mjs` also *infers* family
   from id prefix for hand-curated cards without a `Draw-Card-*`
   function (`leg.dra.crimsonwyrm` → dragon family + gold palette).

To rebuild every sprite from scratch:

```
node tools/dump-card-manifest.mjs
pwsh tools/build-card-sprites.ps1
node tools/build-card-apng.mjs
```

Time budget: ~5-10 minutes wall-clock on Windows PowerShell 5.1 + GDI+.
Paging args (`-Skip N -Take M -IdsFile <file>`) make a partial regen
resumable if anything errors mid-batch.

## Determinism

- `cards-catalog-gen.js` is pure: same code in → same ids + stats out.
  Existing collections (`cards:col:<g>:<u>`) referencing card ids stay
  stable across deploys.
- The sprite generator uses `Rng-Init $cardId` so each sprite's
  weapon variant / pose tilt / accent gem is stable for that id.

## What to verify before shipping to prod

1. `node -e "import('./discord-bot/cards-content.js').then(m => console.log(Object.keys(m.CARDS).length))"` reports 1,593.
2. `cards-fragments.js`'s module-load IIFE doesn't throw (it checks
   craft costs > bolt prices).
3. `/boltbound fragments` returns balance + preview without erroring
   for a fresh user.
4. A handful of new card sprites display correctly in the Discord
   pack-open embed (sprite URL convention unchanged:
   `https://aquilo.gg/sprites/cards/<id>.png`).
5. Boltbound battle resolver still treats every generated card's
   abilities — all abilities use the existing ability dictionary in
   `cards-content.js`'s `EFFECTS` / `TARGETS` / `KEYWORDS` arrays.

## What's intentionally NOT touched

- Battle engine (`cards-battle.js`) — engine reads cards by id from
  `CARDS`, which is the merged catalogue. No code changes needed.
- NPC archetype decks (`NPC_DECKS` in `cards-content.js`) — still
  reference the original ~20 hand-curated cards each. Fine; bots
  don't need to know about the expanded card pool. A future pass
  could randomise NPC decks across the bigger catalogue but Phase 1
  scope holds the locked NPC decks.
- Pack-pull weights — unchanged (60/30/9/1 etc). The expanded pools
  give viewers a bigger card horizon but the same rate curve.
