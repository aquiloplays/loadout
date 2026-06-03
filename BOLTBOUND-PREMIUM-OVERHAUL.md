# Boltbound battler, Glossy Game Premium overhaul

Restyle of the Boltbound battler/arena/menus to match the Glossy Game
Premium card faces. UI work lives in the **aquilo-site** repo; this note
is the Loadout-side handoff (engine/worker context + follow-ups).

Brand direction: **cosmic aurora**. Anchors `#7c5cff` (violet) /
`#ff6ab5` (pink) / `#5bff95` (emerald) / `#22d3ee` (teal).

## What shipped (aquilo-site)

1. **Cosmic-aurora arena backdrop**, replaced the flat arena with a
   painterly nebula scene (Flux 1.1 Pro Ultra, `safety_tolerance: 6`).
   - Root cause of the prior *flat* arena: `.bb-board-bg--arena` injected
     the photo via a `var(--bb-arena-bg)` layer **and** stacked an
     inline-SVG `data:` URI hex pattern. The data-URI made the whole
     `background-image` declaration unparseable, so the browser silently
     dropped the entire rule, only the base `.bb-board-bg` gradient ever
     painted. Rewritten to a plain static `url()` (no var, no data-URI).
   - Backdrop ships as a **bundled aquilo-site asset**
     (`public/sprites/boltbound/arena-bg-1.webp`, 210 KB), NOT a worker/KV
     asset, deploy-independent, no `loadout-discord` round-trip, never
     404s. The old worker arena ids (`stone-arena-bg`, medallion frames,
     `lane-slot`, `crit-*` in the `boltbound-arena` KV namespace) are no
     longer the bg source; medallion/lane art still degrade gracefully
     from the worker as before.
   - Generator: `aquilo-site/scripts/gen-boltbound-arena-bg.py`
     (`REPLICATE_API_TOKEN`, ~$0.06/img; 3 variants generated, variant 1
     chosen). Total spend ≈ $0.18.

2. **Premium menu chrome**, reusable aurora utilities in `globals.css`
   (`.bb-premium-surface`, `.bb-glossy-primary` / `-gold` / `-emerald` /
   `-rose` / `-ghost`, `.bb-tab-active`, `.bb-tab-rail`) applied across
   the hub (`PlayBoltbound`), deck-select, pack opener, and in-match
   buttons. All respect `prefers-reduced-motion`.

3. **Victory/Defeat**, victory burst re-toned from single-gold to a
   rotating **aurora** ray fan + soft bloom. Stamps gained an optional
   `rewards` prop that renders a premium reward strip.

Already in place before this pass (left untouched, just verified):
carved hero medallions, lane glow, fanned hand + hover-lift, deck
stacks + draw anim, pack-open cinematics (tear/fan/3D-flip/flare),
drag/place/flip/shake feedback, and the full `playSound()` wiring.

## Worker / engine notes

- No worker code change was required: the resolver and card/data contract
  are unchanged (card text stays display-only; `cards-battle.js` owns
  resolution). This was a pure presentation pass.
- **Sound cues** fire for every gameplay event via `playSound()`. The
  `audio/sfx/boltbound/*` mp3s are still being published by the separate
  audio-pipeline effort; until they land, each cue falls back to the
  procedural synth (by design, see `scripts/audio-sources.mjs`).

## Follow-up

- **Real victory/defeat reward values.** `MatchView` carries no reward
  fields today, so the cinematic stamp's `rewards` prop is passed nothing
  (it degrades to no strip; the demo moves no bolts/trophies). To show
  real earned bolts / trophy delta / quest progress, surface them on the
  match-end network result and pass them into `VictoryStamp` /
  `DefeatStamp` / `DrawStamp` at the `BoltboundMatch` call site.
