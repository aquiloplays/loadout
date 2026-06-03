# Boltbound — Engine Mechanics Whitelist & Audit

_Authoritative list of what the match resolver actually executes, the
2026-05-31 broken-card audit, and the handoff steps to ship it._

## Where the engine lives

The **authoritative match resolver is server-side**, in
`discord-bot/cards-battle.js` (bundled into the Loadout worker). The
website's `aquilo-site/src/components/play/BoltboundMatch.tsx` is **pure
presentation** — it sends action bodies to the worker and renders the
returned log/state; it does not resolve effects. `aquilo-site/src/lib/
boltbound-catalogue.ts` is an auto-generated copy of the card _shape_
(for rendering only), built from `cards-content.js`.

Consequence: **card `text` is display-only**. The resolver dispatches off
the structured `keywords[]` and `abilities[]` fields, never the
description string. (This is why the effect-text diversification was
mechanically safe.)

## Implemented whitelist (after the 2026-05-31 extension)

Anything a card declares MUST be in these sets or it is a silent no-op
(`runEffect`'s `default` logs `unknown-effect` and continues). Use this
as the constraint set when generating or rewording card effects.

**Triggers** (`abilities[].trigger`):
`onPlay`, `onCast`, `onAttack`, `onDamage`, `onDeath`, `endOfTurn`,
`startOfTurn`, `combo` (fires only when this is NOT the turn's first card),
`spellDamageBonus`.

**Effects** (`abilities[].effect`):
`damage`, `heal`, `draw`, `discard`, `summon`, `buff`, `buffThisTurn`,
`destroy`, `returnToHand`, `copyOpponentCard`, `silence`, `counter`,
`manaThisTurn`, `peekDeck`, `freeze`, `cloneSelf`, `reSummon`,
`revealAndDraw`, `doubleBattlecry`, `recruit`, `adapt`, `discover`.

**Targets** (`abilities[].target`):
`oppHero`, `selfHero`, `allEnemyMinions`, `allEnemy`/`allEnemies`,
`allFriendlyMinions`, `allFriendlyTribe` (needs `ab.tribe`), `allMinions`,
`allOtherMinions`, `randomEnemyMinion`, `randomFriendlyMinion`,
`pickedTarget`, `lastDeadFriendly`, `self`, `oppHand`, `selfHand`.
(`draw`/`summon`/`counter`/`cloneSelf`/`recruit`/`adapt` etc. need no target.)

**Keywords** (`keywords[]`), all with combat/status behavior:
`taunt`, `charge`, `rush`, `shield` (Ward), `lifesteal` (Drain), `poison`
(Venomous), `reach`, `stealth` (Veiled), `spell-immune`, `reborn`
(Phoenix — dies once, returns at 1 HP, loses the keyword), `echo`
(returns a copy to hand the turn played), `regen` (cosmetic label; the
heal comes from an `endOfTurn heal selfHero` ability),
`cannot-attack-unless-3-spells` (Hollow King gate).

**Card-level fields**: `set` (defaults `core`; expansion gating lives in
`boltbound-sets.js`), `tribe` (one of `TRIBES` for tribal synergy),
`overload` (0..3, locks that many mana next turn), `chooseOne` (two
onPlay groups tagged `option:0`/`option:1`; the player's pick fires).

### CR-2 additions (Voidborn expansion, 2026-06-03)
- **reborn** — the first death summons a 1-HP copy with the keyword
  stripped (no loop). Silence cancels it.
- **recruit** (effect, `value`=maxMana, optional `tribe`) — pulls an
  eligible minion OUT of your deck and summons it. Seeded pick.
- **combo** (trigger) — extra effect when this isn't the turn's first card.
- **overload** (card field) — locks `overload` mana at your next start-of-turn.
- **onDamage** (trigger) — fires for a minion that took and SURVIVED damage.
- **allFriendlyTribe** (target) — friendly minions sharing `ab.tribe`.
- **adapt** / **discover** (effects) — pick-one mechanics; resolve via
  `action.adaptChoice`/`action.discoverChoice`, else a seeded default.
- A load-time **schemaCheck** in `cards-content.js` validates every
  EXPANSION card's keywords/triggers/effects/targets against the locked
  dictionaries so a typo can't ship as a silent no-op.

### Keyword semantics
- **taunt** — enemies must attack it before anything else.
- **charge** — can attack (incl. face) the turn it is played.
- **rush** — can attack the turn it is played, **minions only** (not the
  enemy hero) that turn. Enforced by a `rush-fresh` status cleared at the
  owner's next start-of-turn.
- **shield** — absorbs the first instance of damage, then drops.
- **lifesteal** — damage it deals also heals its hero.
- **poison** — any damage it deals to a minion destroys that minion.
- **reach** — may attack the enemy hero even through Taunt.
- **stealth** — cannot be targeted by attacks until it attacks; wears off
  the owner's following turn.
- **spell-immune** — cannot be targeted by an effect cast by its
  **opponent** (enemy spells/abilities). Friendly buffs still land, and
  **combat is unaffected**.
- **frozen** (status, applied by `freeze`) — skips its next turn.

## 2026-05-31 audit

Cross-checked all 1267 cards' `keywords[]` + `abilities[]` against the
resolver. **61 cards referenced mechanics with no handler** (silent
no-ops — the card text lied):

| mechanic | cards | resolution |
|---|---|---|
| `rush` keyword | 30 | implemented |
| `spell-immune` keyword | 22 | implemented |
| `freeze` effect | 1 (Permafrost Lich) | implemented |
| `allEnemies` target | 1 (Apexorb Tyrant) | added `allEnemy` target |
| `oppMinion` target | 1 (Duneturban Sphinx) | data fix → `randomEnemyMinion` |
| `cloneSelf` | 1 (Silvermask Twin) | implemented |
| `reSummon` | 1 (Relicspine Reaver) | implemented (resurrect once, no loop) |
| `revealAndDraw` | 1 (Starcharter Magus) | implemented |
| `doubleBattlecry` | 1 (Cogheart Maestro) | implemented (best-effort) |

`regen` (30) and `cannot-attack-unless-3-spells` (1) were flagged by name
but were already functional (heal via ability / Hollow King gate); left
as-is.

**Re-audit after the extension: 0 cards reference an unimplemented
mechanic.** Tests: `test/test-cards-battle-mechanics.mjs` (21/21);
`test/test-hero-powers.mjs` unchanged (67/0).

## Handoff — to ship live (NOT done in this chip)

1. **Deploy the Loadout worker** (`wrangler deploy` in `discord-bot/`) so
   the resolver changes take effect in live matches. Sequence this with /
   after any in-flight worker work to avoid a half-baked bundle.
2. **Regenerate the site catalogue** in `aquilo-site`:
   `LOADOUT_REPO=<path-to-Loadout> node scripts/build-boltbound-catalogue.mjs`
   then commit `src/lib/boltbound-catalogue.ts` (picks up the diversified
   effect text + the Duneturban target fix). Left for the site session —
   that repo currently has unrelated uncommitted work.
3. **Optional client polish**: `BoltboundMatch.tsx` renders auras for
   `taunt`/`stealth`; consider adding visual indicators for `frozen`,
   `rush`, and `spell-immune` (cosmetic — correctness is server-side).

## Adding a new mechanic (pattern)

1. Add the keyword/effect/target string here + to the locked dictionary in
   `cards-content.js`.
2. Parser/handler in `cards-battle.js`: a `keyword` hooks combat/status
   (see `makeBoardMinion`, `attackAction`, `dealDamage`); an `effect`
   gets a `case` in `runEffect`; a `target` gets a `case` in
   `resolveTargets`.
3. Mirror any hard attack-legality in BOTH `attackAction` (authoritative)
   and `isLegalAction` (UI helper).
4. Add a match-simulation test to `test/test-cards-battle-mechanics.mjs`.
