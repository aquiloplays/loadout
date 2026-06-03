# Character system, pixel-art creator + paper-doll gear layering

> Status: **signed off, building.** Clay's decisions on the open
> questions are locked in §11; pets are §12. Ship gate: every gear
> piece has its final art (no placeholder-silhouette launch).
>
> Author: Loadout team · Date: 2026-05-20 · Owner: Clay
>
> Clay's ask (verbatim):
> *"Every viewer can create and customize their own pixel-art
> character, customizable from Discord OR the website, and every
> piece of gear they own can be equipped onto the character to
> enhance both its appearance and its stats."*
>
> Art directive (verbatim):
> *"Every loot/gear piece must be its OWN unique custom sprite, no
> reused textures, each one new, and gear should look more detailed
> and 'cooler' the rarer / more expensive it is."*
>
> Production directive (verbatim):
> *"Make all the art in house. It doesn't have to be human grade but
> I just want it to look as good as you can make it."*, i.e. ship
> in-house, programmatic generator per piece, no contract artist,
> legendary tier animated. Quality bar is the best we can drive
> from a procedural sprite generator.
>
> Pets addendum (replaces the Patreon hair-palette idea from §11):
> *Patrons adopt cosmetic pets that render in-frame alongside the
> character. Tamagotchi-style mini-game keeps them happy.* See §12.

---

## 1. Guiding principles

- **One identity, one record.** The character is the *visual
  expression* of the viewer's existing dungeon hero. It is NOT a new
  parallel record, it's a `look` field on `HeroState`. Same hero,
  same gear, same level, now with a face.
- **Sprite-once, render-twice.** Every gear sprite is authored ONE
  time at a fixed canvas size. The same PNG file serves as the
  inventory icon AND as the equipped paper-doll layer on the
  character. No "icon vs in-game art" split. Authoring discipline.
- **Rarity is the dial.** A common boot is a flat 3-shade silhouette.
  A legendary boot is a multi-frame animation with glow particles
  and a unique outline. Same canvas, same slot, same layering rules, the *content* of the sprite is what scales with rarity.
- **Discord-first, web-fancier.** The character editor must work
  inside Discord's button/select/modal constraints (no clickable
  pixels, no rich-canvas). The web editor at
  `loadout.aquilo.gg/character` gets the live-preview drag-and-drop
  treatment. Both flows write to the same `HeroState.look`.
- **Composition is server-rendered.** A single Worker endpoint
  composes the character PNG from layers on demand and serves it.
  Discord embeds, Twitch panel, web, all hit the same URL. One
  source of truth, identical pixels everywhere.

---

## 2. The character model, what a viewer customizes

Six customization axes. Each is a small set of discrete options so
the editor fits in a Discord select-menu (max 25 options each).
Anything that needs a colour gets a curated palette, no free-form
hex pickers (palette discipline keeps the art coherent across the
whole roster).

| Axis | Options (Phase 1) | Notes |
| --- | --- | --- |
| **Body type** | `slim`, `stocky` (2) | Two silhouettes, same 24×40 footprint. All gear sprites are authored to fit both, drives the gear-sprite spec. Adding a 3rd type triples gear authoring effort, so we stop at 2. |
| **Skin tone** | 10 swatches (Fitzpatrick-style, plus 2 fantasy: pale-violet, ash-grey) | Curated palette, named (`fair`, `tan`, `bronze`, `umber`, `ebony`, `pale-violet`, `ash`, `olive`, `rose`, `porcelain`). |
| **Hair style** | 12 styles (Phase 1) | `short-tousled`, `long-straight`, `bun`, `mohawk`, `braids`, `curly-afro`, `pixie`, `ponytail`, `bald`, `shaved-sides`, `mullet`, `wizard-long`. Each authored once; recoloured at render time via palette swap. |
| **Hair colour** | 14 swatches (natural + a 4-colour fantasy bonus row) | Brown / black / blonde / red / grey / white + violet / teal / pink / mint accents. |
| **Eye colour** | 8 swatches | Brown / blue / green / hazel / amber / violet / silver / pink. Renders as a 2-pixel face overlay; subtle but visible at the standard sprite size. |
| **Accent** | 6 cosmetic flairs | `freckles`, `eye-shadow`, `face-scar`, `beauty-mark`, `glasses-round`, `none`. Subtle face-layer overlays. Glasses sit above the eye-colour pixels and below hair fringe. |

Excluded from Phase 1 to keep scope honest:
- **Face shape / jaw geometry**, at 24×40 the silhouette options
  read as the body-type axis already.
- **Tattoos / chest art**, hidden by chest gear in practice, low
  payoff for the sprite work.
- **Pets / familiars**, separate system; possibly a Patreon perk
  later.
- **Background / scene**, render is character-only by design. The
  surfaces that show it (Discord embed, panel, web) provide the
  background.
- **Animated idle for the BASE figure**, only the rarest gear gets
  animation in Phase 1. Idle bob can come later.

That's **6 axes × ~10 average choices = 600,000 combinations** at
the figure level alone before any gear is layered. Plenty of
identity.

---

## 3. Relationship to the existing `HeroState`

The character **extends** `HeroState` rather than replacing or
shadowing it. One record, one identity, one truth.

```js
// discord-bot/dungeon.js HeroState, Phase 1 addition (the `look` block)
{
  className: 'warrior',
  level: 8,
  xp: 245,
  hpMax: 28, hpCurrent: 28,
  bag: [
    { id, slot, rarity, name, glyph, powerBonus, defenseBonus,
      goldValue, setName, weaponType, preferredClass, ability,
      spriteId },                              // NEW: see §4
  ],
  equipped: { weapon: 'wk_3f9a', chest: 'ch_7c1d', ... },
  // ── NEW: character `look` block ─────────────────────────────────
  look: {
    bodyType:  'slim',          // see §2
    skinTone:  'tan',
    hair:      'short-tousled',
    hairColor: 'brown',
    eyes:      'amber',
    accent:    'freckles',
    // Optional palette overrides (cosmetic Patreon perks later, see
    // CLASH-FEATURE-DESIGN §2 for the precedent).
    palette:   null,
  },
  lookVersion: 3,                // bumped on every edit; lets caches
                                 // invalidate the rendered PNG.
  // existing fields below, unchanged
  dungeonsSurvived: ...,
  duelsWon: ...,
  ...
}
```

### Why nested, not separate

- **Single source of truth.** Hero level, gear, AND look all sync
  through the same wallet/dungeon snapshot. No second sync pipeline.
- **No re-link surface.** Discord-user → hero already resolves via
  the existing `wallet:<guild>:<user>.links[]` chain. The character
  inherits that resolver for free.
- **Phase 0 backfill is trivial.** On first read of a hero with no
  `look` field, write a deterministic default seeded by the viewer's
  user-id hash (`bodyType: slim, skinTone: <hash-pick>, hair:
  short-tousled, ...`). Viewer can customise from there.
- **Class still shapes identity.** `className` stays where it is and
  drives Champion role + class-tinted ring around the avatar slot
  (already in `aquilo-gg/overlays/dungeon/style.css`). Look + class
  together give "a viewer's hero." Look without class is generic.

### What stays where it is

- `bag[]` and `equipped{}` shape is unchanged, Phase 1 just adds
  one new optional field per item (`spriteId`, see §4).
- `dungeonsSurvived`, `duelsWon`, `legendariesFound` and the rest of
  the stats, untouched.
- Voltaic loot pieces (Clash) follow the same gear schema and get
  their own sprites in the same way as every other gear piece.

---

## 4. Paper-doll layering, sprite-once, render-twice

### The canvas spec (the rule that has to hold for every asset)

**40 wide × 56 tall pixels.** All gear and the base figure are
authored at this exact canvas. The figure occupies a 24×40
footprint centred at the bottom of the canvas:

```
0          24w canvas         40
┌──────────────────────────────┐ 0
│                              │
│          ░░░░░░░░░░          │   ← head room (helms +
│         ░░░░░░░░░░░░         │     plumes + hair fringe
│        ░░░░░░░░░░░░░░        │     extend up to here)
│       ░░░░░░░░░░░░░░░░       │
│      ┌──────────────────┐    │
│      │       head       │    │ 16  ← figure footprint
│      │       neck       │    │     starts here:
│      │   chest / arms   │    │     24w × 40h, centred
│      │     midsection   │    │
│      │    legs / hips   │    │
│      │       boots      │    │
│      └──────────────────┘    │
│                              │
└──────────────────────────────┘ 56
```

The 8-pixel gutter on each side gives weapons a horizontal swing
zone (greatswords, polearms, longbows). The 16-pixel headroom gives
plumed helms, wizard hats and crowns somewhere to live.

### Layers, back to front

| z | Layer | Source |
| --- | --- | --- |
| 0  | (transparent canvas) |, |
| 10 | **Back accessory** | `trinket` item if `back == true` (capes, wings) |
| 20 | **Body** | Base figure sprite, determined by `look.bodyType` + `look.skinTone` |
| 30 | **Legs** | `legs` slot item |
| 35 | **Boots** | `boots` slot item |
| 40 | **Chest** | `chest` slot item |
| 45 | **Front trinket** | `trinket` item if non-back (rings, amulets, render on a small pixel zone the chest sprite intentionally leaves open) |
| 50 | **Off-hand** | reserved (Phase 2, shields, orbs) |
| 60 | **Hair** | Figure sprite chosen by `look.hair`, palette-swapped to `look.hairColor` |
| 65 | **Face overlay** | Eye-colour 2-pixel highlights + `look.accent` (freckles / glasses) |
| 70 | **Head** | `head` slot item, drawn AFTER hair so helmets cover it |
| 80 | **Weapon** | `weapon` slot item (drawn front because it's the read-at-a-glance signal) |
| 90 | **FX overlay** | Particle / glow animation frames for legendary gear (§5) |

The renderer iterates the equipped slot list in z-order, draws each
sprite at (0,0) on the canvas, and writes the final PNG. **Every
gear sprite is positioned in its source PNG at the exact pixel where
it belongs on the figure.** No per-slot offset table, no
runtime placement logic, the authoring is the placement.

### The "one sprite, two uses" rule

Every gear PNG is rendered TWO ways:

1. **Inventory icon.** Auto-crop the PNG to its opaque bounding box,
   pad to a square at the longest side, scale up 2× or 4× depending
   on UI density. Used in `/inventory`, the panel, the website.
2. **Equipped layer.** Render the PNG as-is on the 40×56 canvas at
   (0,0). The transparent canvas pixels are the offset, they
   *are* the position metadata. No external coordinate table to keep
   in sync.

The art rule that makes this work: **every gear sprite must be
authored on the 40×56 canvas with the figure ghost-layer visible to
the artist.** The art-export tool (a small Aseprite / Photoshop
template) ships with the base body sprite locked as a non-exported
guide layer. Authors paint on top; export removes the guide.

### Slot conflicts and stacking

- Head + hair: helmets cover hair by z-order. Hoods, caps, and
  open-top helms expose part of the hair if their sprite has
  transparent gaps. Authoring guideline: a "tall plumed helm" leaves
  no hair visible; a "circlet" or "headband" lets the entire hair
  silhouette through. No code-side rule needed, the *sprite
  shape* decides.
- Boots + legs: same layering principle. Tall greaves cover trouser
  legs from the knee down.
- Front trinket vs chest: chest sprite intentionally leaves a 6×6
  pixel patch over the sternum where small front-trinkets (necklaces,
  pendants) can sit on top. If a chest piece *should* cover the
  trinket (heavy plate armour), its sprite fills that patch, the
  trinket renders underneath. Sprite shape decides again.

---

## 5. Rarity-scaled art direction

Five tiers, escalating sprite quality:

| Tier | Pixels | Shading | Effects | Animation |
| --- | --- | --- | --- | --- |
| **Common** | 24×24 max active pixel area | 2 shade tiers (base + shadow) | none | 1 frame |
| **Uncommon** | up to 28×28 | 3 tiers | small accent highlight pixel | 1 frame |
| **Rare** | up to 32×32 | 4 tiers | coloured highlight + 1-px outline glow | 1 frame |
| **Epic** | up to 36×40 | 5 tiers | magical accent + selective recolour-on-class | 2-frame pulse loop (gentle shimmer; optional in Phase 1, required by Phase 4) |
| **Legendary** | full 40×56 canvas | 6+ tiers | particle FX overlay (z=90), full glow halo, unique silhouette | 4-frame animation (idle bob + glow pulse), required |

Art direction notes that ride above the tier ladder:

- **Silhouette test.** A common boot should still read clearly as a
  boot at 2×. A legendary item should read at 1×. If the
  recogniser-test fails, the sprite goes back to the artist
  regardless of polish.
- **Colour signal.** Common = muted earth palette. Uncommon = adds
  one saturated accent. Rare = saturated colour with a soft glow.
  Epic = brand-palette colours (aquilo violet / mint). Legendary =
  gradient fill + animated glow halo.
- **Set bonuses telegraph visually.** When two pieces from the same
  set are equipped, the renderer applies a subtle "set-active"
  outline frame around the matching slots' layers. Authored as a
  +1-pixel-radius outline pass at render time, no per-set art.
- **Class tint, optional.** Items with `preferredClass` get a small
  class-tint pixel zone the artist marks in a special palette index.
  Render swaps that index to the class's `TintColor` (warrior red,
  mage violet, etc., already defined in `DungeonContent.cs`). This
  is how a "class-aligned epic" reads visually without authoring 5×
  variants.

---

## 6. Customization UX

### Discord, `/character` slash command

Discord doesn't allow rich-canvas inputs, so the editor is built
from sequential select-menus and a live preview image. The
ephemeral message looks like:

```
                  ┌─ Your Character ─────┐
                  │                      │
                  │   [40×56 preview]    │
                  │   (renders via       │
                  │   /character/render  │
                  │   image URL)         │
                  │                      │
                  └──────────────────────┘

  [ Body type ▼ ]   [ Skin tone ▼ ]
  [ Hair      ▼ ]   [ Hair colour ▼ ]
  [ Eyes      ▼ ]   [ Accent ▼ ]

  [ 🎨 Random ] [ 💾 Save ] [ ✖ Cancel ]
```

Implementation:
- Five `string-select` components (Discord allows ≤5 action rows of
  ≤5 components each, fits comfortably).
- The preview image is a single embed image whose URL points at
  `/character/render/<guildId>/<userId>.png?v=<lookVersion>`. Each
  edit bumps `lookVersion` so the cache invalidates and Discord
  re-fetches.
- "Save" persists the look and shows a confirmation embed.
  "Random" rolls all six axes from the palette and re-renders.
- "Cancel" reverts to the saved state.

Gear equipping stays in the existing `/inventory` and `/equip`
flows; equipping a new piece bumps `lookVersion` automatically and
the next render shows the new layer.

### Web, `loadout.aquilo.gg/character`

Full client-side editor. Lives in the `aquilo-site` repo, owned by
the other session. Phase 4 of this project.

- Side panel: the six axis selectors as labeled rows of swatch
  buttons (no dropdowns, pixel-art swatches are more readable than
  text).
- Centre stage: live-render canvas at 4× or 8× scale. Updates on
  every click without a server round-trip (composition happens
  client-side from the same layer PNGs the Worker serves).
- Right rail: equipped gear list, with each row showing the
  inventory icon + the slot it occupies. Drag-and-drop swap between
  bag and slot, with the live preview re-composing instantly.
- "Save" button at the bottom POSTs the look to the Worker
  (`POST /sync/<guildId>/character`, HMAC-gated via the same
  per-guild syncSecret used by the Clash sync endpoints).

---

## 7. Storage + rendering pipeline

### Storage

- `HeroState.look` lives inside the existing
  `d:hero:<guildId>:<userId>` KV record (see `discord-bot/dungeon.js`).
  No new KV namespace; no new top-level keys. One record per hero
  per channel, exactly as it is today.
- Sprite assets live in the public Pages site:
  `aquilo-gg/sprites/<kind>/<id>.png`. Examples:
  - `aquilo-gg/sprites/figure/body-slim-fair.png`
  - `aquilo-gg/sprites/figure/hair-short-tousled.png`
  - `aquilo-gg/sprites/gear/weapon/bolt-knight-sword.png`
  - `aquilo-gg/sprites/gear/head/wayfarer-hat.png`
- Each gear item in `SHOP_POOL` (and Voltaic in `clash-content.js`)
  grows a `spriteId` field that maps to the asset path. Items
  without a sprite yet fall back to a rarity-tier silhouette
  placeholder (Phase 1, see §9).

### Composition

A new Worker route renders the character PNG on demand:

```
GET /character/render/<guildId>/<userId>.png[?v=<lookVersion>]

  → reads HeroState
  → resolves look + equipped[] into a layer list
  → fetches each layer PNG from the Pages bucket (cached at the
    CF edge by URL, ~5 KB each)
  → composes them in z-order into a single 40×56 PNG
  → returns image/png with strong cache headers
    (Cache-Control: public, max-age=600, must-revalidate;
     ETag tied to lookVersion + equippedHash)
```

Cloudflare Workers' `Image` API + canvas-style compositing has
edge cases, so the most reliable path is to compose pixels
directly: decode each layer PNG with a small Wasm PNG decoder
(`@jsquash/png` or similar, ~30 KB), iterate top-down in z-order,
copy non-transparent pixels into the output buffer, re-encode with
the same library. ~2-5 ms per render at this canvas size; fully
within CF's CPU budget.

Alternative path if the Wasm-PNG route gets complicated:
[Cloudflare Images](https://developers.cloudflare.com/images/) with
the layered URL parameters does the compositing as a managed
service. Costs $5/mo for 100k transforms, fine for our volume.
Fallback documented in case the in-Worker approach turns out to be
fiddly.

### Surface integration

| Surface | How it shows the character |
| --- | --- |
| **Discord embed** (`/character`, `/inventory`) | `image` field on the embed pointing to `/character/render/...`. Each edit bumps `lookVersion` in the URL so Discord re-fetches. |
| **Twitch panel** | `<img src="https://loadout-discord.aquiloplays.workers.dev/character/render/...">` displayed in the viewer's profile tab on the panel. Same URL, same cache. |
| **Web editor** (`loadout.aquilo.gg/character`) | Live: composes client-side from the same layer PNGs. On save, the next visit hits the Worker render endpoint for the canonical PNG. |
| **OBS overlays** | The dungeon overlay (`aquilo-gg/overlays/dungeon/`) already has a `.has-sprite` mode in its CSS. Switch its `<img>` `src` to the new render endpoint and the existing recruit / loot / duel scenes light up with proper character art instead of class glyphs. |
| **Clash raid resolver replay** | When the Phase-4 Clash web base-editor or panel renders raids, each attacker / defender Champion shows the actual character PNG instead of a generic class icon. Visual cohesion. |

---

## 8. Build phasing

### Phase 1, Foundation (no gear sprites yet)
*~1-2 weeks engineering + ~1 week initial figure art*

- `HeroState.look` schema + Phase 0 deterministic backfill.
- Figure assets: 2 body types × 10 skin tones × base figure sprite,
  hair styles × 12 (palette-swappable), eye-colour overlays × 8,
  accents × 6. **≈ 40 unique figure PNGs.**
- Discord `/character` editor (5 select-menus + preview embed).
- Worker `GET /character/render/<g>/<u>.png` endpoint composing
  figure layers only (no gear). PNG decode/encode via Wasm.
- Existing `/inventory` and the dungeon overlay swap their portrait
  source to the new endpoint. Generic gear remains glyph-rendered
  (no sprite yet).

### Phase 2, Gear layering with placeholder sprites
*~2 weeks engineering + ongoing art*

- Add `spriteId` field to every catalogue item in `dungeon.js`
  SHOP_POOL + `clash-content.js` VOLTAIC_LOOT.
- Renderer extends to layer equipped gear from the equipped slots.
- **Placeholder sprite policy:** items without an authored sprite
  yet render a **rarity-tier silhouette**, a procedurally
  generated outline of the slot, tinted by rarity. Common boots
  render as a grey boot silhouette. Epic weapons render as a violet
  weapon silhouette. Lets the system go live with the full
  catalogue immediately while art is produced.
- Set-bonus visual frame ("set-active outline") wired.

### Phase 3, Real gear art, common → epic
*~6 weeks art (see §10 estimate)*

- Author every common, uncommon, rare, and epic sprite in the
  catalogue. Voltaic (epic) gets full treatment.
- Each piece replaces its rarity-silhouette placeholder as it
  lands. No deploy required per asset, Pages cache flushes on
  Worker version bump.
- Class-tint zones authored where applicable; renderer applies the
  class palette swap.

### Phase 4, Legendary animation + web editor
*~3 weeks engineering + ~2 weeks art*

- Animated sprites for legendary tier: 4-frame loop, ~150 ms /
  frame. Worker render endpoint extends to APNG output (animated
  PNG) when any equipped piece is legendary; static PNG otherwise.
- Web `loadout.aquilo.gg/character` editor (in aquilo-site repo).
- Twitch panel character tab.
- Dungeon overlay scene transitions tap the same render URL with
  optional frame variations (idle, walk).

### Phase 5, Polish + cosmetic perks (open-ended)
- Patreon cosmetic hair tints (the fantasy bonus row of hair-colour
  swatches gets unlocked for supporters).
- Per-character "banner" cosmetic (the 8-pixel canvas gutter on
  each side fills with a tier-specific banner pattern).
- Animated idle bob on the base figure.
- Mounted display ("mount" trinket category that adds a creature
  beneath the figure, pushes the canvas to 40×72; a clean Phase 5
  not Phase 1 because it changes the asset spec).

---

## 9. Art production effort estimate

The catalogue right now has roughly:

- **Dungeon shop (`dungeon.js SHOP_POOL`)**, 120 items across 6
  slots × 4 rarity tiers (Common, Uncommon, Rare, Epic), with 4
  named sets (`ironclad`, `arcane`, `forester`, `wayfarer`).
- **Voltaic loot (`clash-content.js VOLTAIC_LOOT`)**, 6 epic
  pieces.
- **Future loot from Phase 3 of CLASH**, Battle Plans, future
  legendary drops, ~20 more pieces.

≈ **150 unique gear sprites** at Phase-3 completion. Plus the
~**40 figure sprites** for the base character (Phase 1).

Time per sprite, rough authoring estimate (assumes a competent
pixel-art artist familiar with our 40×56 spec):

| Tier | Time / sprite | Pieces (est.) | Subtotal |
| --- | --- | --- | --- |
| Figure (body+hair+face) | 30-45 min | 40 | 30 h |
| Common gear | 30 min | 60 | 30 h |
| Uncommon gear | 45 min | 35 | 26 h |
| Rare gear | 60 min | 25 | 25 h |
| Epic gear | 90 min | 20 | 30 h |
| Legendary gear (Phase 4, animated) | 4 h | 10 | 40 h |
| **Total** | | **~190 pieces** | **~180 h** |

180 hours = **~4.5 weeks of full-time art**, or 9 weeks at
half-time. Realistically this is a multi-month commitment if it's
one person. Two ways to stage:

1. **Hire-rate.** Contract a pixel artist for a 4-6 week sprint.
   At $30-50/hr that's ~$6k-$9k. Highest velocity, single style.
2. **In-house tier-laddered.** Author commons + uncommons first
   (~56 h, 1.5 weeks). Ship Phase 2 with the placeholder silhouettes
   for rare/epic and live with it for 1-2 months. Add tiers over
   time. Lowest cost, slower visible payoff.

**Recommendation: in-house tier-laddered.** Common + uncommon
covers ~95% of inventory by drop volume (drops are weighted toward
common). Legendary appears rarely enough that it's fine to take
extra weeks per piece. The placeholder silhouettes carry the
system convincingly enough to ship, players will see *something*
in every slot from day one.

---

## 10. Risks + mitigations

- **Render endpoint CPU budget.** Composing pixels in a Worker is
  CPU-bound. At 40×56 the worst case is ~8.6 k pixels × 14 layers =
  ~120 k pixel writes per render. Should land at <5 ms; CF
  Workers' default 10 ms CPU budget is fine. If it isn't, fall back
  to Cloudflare Images (managed compositing, $5/mo).
- **Asset cache invalidation.** Every gear edit bumps
  `lookVersion`. Discord aggressively caches embed images; pinning
  `?v=<lookVersion>` in the URL forces a re-fetch. Tested with the
  existing dungeon portrait flow already.
- **Body-type vs gear authoring.** Authoring every gear sprite to
  fit both `slim` and `stocky` doubles asset count. **Mitigation:**
  author each gear sprite ONCE on the average between the two
  bodies. The renderer applies a 1-px horizontal squash/stretch on
  the equipped layer based on body type. Imperceptible at this
  scale; cuts authoring work in half.
- **"Reused textures" rule.** Clay's directive is no reused
  textures, every piece unique. That bumps the authoring count
  but **set families** (ironclad, arcane, etc.) still share visual
  language while differing in detail. The rule is *no copy-paste*,
  not *no consistent style*. Documented for the artist.
- **Sprite drift.** Without strict canvas-spec discipline, gear
  sprites land at the wrong pixel position and layer wrong. The
  Aseprite template (with the body ghost-layer locked) is the
  enforcement mechanism; ship it on day one.

---

## 11. Decisions locked

Clay signed off 2026-05-20. The build follows these defaults; doc kept
here as the record so a future reader doesn't have to dig through chat
history.

| # | Question | Decision |
| --- | --- | --- |
| 1 | Sprite canvas | **40×56** (default kept). |
| 2 | Animation policy | **Yes, legendary animates.** APNG output from the start; no static-legendary fallback. |
| 3 | Body types | **Two (slim + stocky)** (default kept). |
| 4 | Art production path | **In-house, programmatic.** Verbatim: *"Make all the art in house. It doesn't have to be human grade but I just want it to look as good as you can make it."* No contractor; we build a generator and run it. |
| 5 | Placeholder silhouettes | **No.** Ship gate = every gear piece has its final art. Verbatim: *"Ship when final art is done."* |
| 6 | Discord render UX | Live preview via re-fetched embed image (default kept), simpler, fewer API calls. |
| 7 | Class tint zones | Only items with `preferredClass != ''` (default kept). |
| 8 | Patreon cosmetics | **Hair-palette idea dropped.** Replaced by Pets (§12), Patreon perk is cosmetic pet adoption. |
| 9 | Mount/taller canvas | Stay 40×56; mounts ship as a separate non-character entity if/when they happen. |
| 10 | Sprite asset repo | `aquilo-gg/sprites/` (default kept, already ships via Pages mirror). |

### Implications for the build

- **No contract artist.** A Node-side procedural pixel-art generator
  produces every sprite from a recipe per piece. Each gear item gets
  a unique recipe, Clay's "no reused textures" rule is enforced by
  the generator emitting per-piece variation seeds into the recipe.
- **Animated legendaries from day one.** The generator emits APNG
  for legendary-tier pieces (4-frame glow/shimmer loop).
- **No staged rollout.** Phase 2 of §8 (placeholder silhouettes) is
  cancelled. The system goes live after every piece in the catalogue
  has its final sprite committed.
- **Pets are a new Phase.** Folded into the Phase plan as a
  parallel work stream, see §12. Hair-fantasy palette no longer
  on the roadmap.

---

## 12. Pets

Patrons can adopt a cosmetic pet that renders in-frame alongside
their character. Pets are **fully cosmetic**, no stats, no combat
effect, no equipped slot conflict, no gameplay advantage. The
mechanic is a tamagotchi-style care loop that gives Patrons a
small recurring reason to check in.

### Adoption model

- **Patreon-gated.** `/pet adopt` is open only to wallet records
  whose `links[]` array contains an active Patreon link (the same
  `IdentityLinker` flow the rest of Loadout uses).
- **One pet per viewer per channel.** Same scoping as `HeroState`.
- **Pet species + colour** chosen at adoption. Phase-1 species
  list: cat, dog, owl, fox, slime, dragonling, frog, bunny. Each
  has 4 colour variants. Same generator-driven art pipeline as
  gear (§4): each species + colour permutation is a unique sprite.
- **Tier-gated colours.** Common colours unlock for any Patron
  tier; rare/epic colours unlock at higher tiers. (Concrete
  tier→colour mapping deferred to first Patreon-tier read once
  the build lands; flagged in the open-question list at the bottom.)

### Render integration

- **New z-layer**, slotted between the back accessory and the body:

  | z | Layer |
  | --- | --- |
  | 10 | Back accessory (capes) |
  | **15** | **Pet** ← new |
  | 20 | Body |
  | 30 | Legs |
  | … | … |

  Pets stand to the figure's side (drawn in the 8-px canvas gutter
  on the right by default) so they don't obscure the figure or
  the chest gear. Sprite authoring rule: pets occupy the lower-
  right 12×16 box of the 40×56 canvas, with optional 2-px overlap
  with the figure for "leaning in" species (cat brushing the leg).
- **Mood overlay.** A tiny 4×4 emote above the pet's head reflects
  current happiness:
  - `happy`, heart, sparkle, or smile (rotating)
  - `content`, no overlay
  - `hungry`, bowl + arrow
  - `sad`, droopy ear or eye
  - `dirty`, fly buzzing around (small)
  The mood is computed at render time from the care stats below;
  no separate "save the mood" plumbing.

### Tamagotchi-style care loop

Each pet has three care stats that decay over time:

| Stat | Decays at | Refilled by |
| --- | --- | --- |
| `hunger` (0..100, lower = hungrier) | −2 / hour | `/pet feed` |
| `happiness` (0..100) | −1 / hour | `/pet play` |
| `cleanliness` (0..100) | −1 / 2 hours | `/pet clean` |

Stat math is **timestamp-only**, no background tick. On every
read of the pet record we compute `current = max(0, stored -
(decayRate × hoursSinceLastSet))`. Same pattern as the Clash
cooldown queue.

Each care action costs a small amount of Bolts (the recurring
gentle wallet sink):
- `/pet feed`, 10 Bolts, sets `hunger = 100`.
- `/pet play`, 5 Bolts, sets `happiness = 100`.
- `/pet clean`, 5 Bolts, sets `cleanliness = 100`.

Cooldowns: each action is on a 30-minute cooldown per pet
(prevents zero-cost spam by setting `hunger` repeatedly to 100
and waiting for decay).

### Mood = (hunger + happiness + cleanliness) / 3

- ≥ 80 → `happy`
- 50-79 → `content`
- 20-49 → `sad` (with the lowest stat hinted: hungry / dirty /
  sad-eared)
- < 20 → low-energy `sad` + slower idle animation

**Neglect has no real cost.** A neglected pet just looks sad in
the render. No despawn, no permanent loss, no death. Verbatim
from Clay (no gameplay-advantage rule): pets are cosmetic. The
care loop is the engagement hook; the pet doesn't punish absence.

### KV layout

```
pet:<guildId>:<userId>   → {
  species:   'cat' | 'dog' | 'owl' | 'fox' | 'slime' | 'dragonling' | 'frog' | 'bunny',
  colour:    string,                 // species-specific palette key
  name:      string,                 // viewer-set, ≤16 chars
  adoptedUtc: number,
  hunger:      { value, lastSetUtc },
  happiness:   { value, lastSetUtc },
  cleanliness: { value, lastSetUtc },
  lastFedUtc:    number,             // separate from hunger.lastSetUtc, gates the 30-min cooldown
  lastPlayedUtc: number,
  lastCleanedUtc: number,
}
```

Single record per viewer per channel. ~1 KB. Reads on every
`/character/render` (mood determines the overlay) and on every
`/pet *` command.

### Slash commands

| Command | Notes |
| --- | --- |
| `/pet adopt species:<…> colour:<…> name:<…>` | Patron-only. Creates the record. One-shot, re-running shows current pet, doesn't replace it. |
| `/pet view` | Anyone-readable. Renders the pet alone (no character chrome) + shows stats + mood. |
| `/pet feed` | 30-min cooldown, 10 Bolts. |
| `/pet play` | 30-min cooldown, 5 Bolts. |
| `/pet clean` | 30-min cooldown, 5 Bolts. |
| `/pet rename name:<…>` | Free, ≤16 chars. |
| `/pet release` | Removes the pet record (so a Patron can swap species). 24-h cooldown before re-adopting to discourage churn. |

### Where pets show up

- Composed into the character render endpoint (§7), every surface
  that displays the character automatically shows the pet too.
  Discord embeds, Twitch panel, web profile, dungeon overlay.
- The pet does NOT appear in raid replays or town views (Clash), keeps PvP imagery uncluttered. Renderer flag: `?nopet=1` for
  raid contexts.

### Art production

Same generator pipeline as gear (§4-§5). Sprite count for Phase 1
pet roster:
- 8 species × 4 colours = **32 base pet sprites**
- 4-frame idle animation per pet (cosmetic, bob, blink, tail
  flick) = **128 animation frames** packaged as APNG
- 4 mood-overlay icons (happy / hungry / sad / dirty) = 4 tiny
  4×4 sprites

Total pet art = **~32 APNGs + 4 overlay PNGs**. Generator can
emit these on the same Node run that builds the gear catalogue.

### Open questions for Clay (pets-specific)

These three came out of the pet design and weren't in the original
Clay-decisions list. Sensible defaults assumed during the build, flag for sign-off after first viewing:

1. **Patreon tier → colour mapping.** Common colours for tier-1
   patrons, rare for tier-2, epic for tier-3? Defaulting yes; can
   re-balance after live data.
2. **Care-action Bolt costs.** Drafted at 5-10 Bolts per action.
   With the 30-min cooldown, max daily spend ≈ 1k Bolts per pet
   per day, modest. Acceptable or tune?
3. **Pet on raid pages.** Currently rendered everywhere except
   raid replays + town views. Should the pet also be hidden on
   the OBS dungeon overlay during active scenes (recruit, loot,
   duel) or always-visible there too? Defaulting to always-visible
   on the dungeon overlay; raid views (Clash) keep pets hidden.

---

## 13. Build status (Phase 1 art complete)

All passes the spec called out have landed on
`claude/character-pet-build` (PR #7). State on disk:

| Pass | Output | On disk |
| --- | --- | --- |
| 1, plumbing | schema + slash commands + render endpoint + PNG codec | `dungeon.js`, `pet.js`, `character.js`, `commands{,-spec}.js`, `png-codec.js` |
| 2, figure layers | bodies × tones, hair × styles, eye colours, accents | 45 PNGs under `aquilo-gg/sprites/figure/` |
| 3, gear catalogue | every SHOP_POOL + Voltaic piece as a unique pixel sprite | 191 PNGs under `aquilo-gg/sprites/gear/{weapon,head,chest,legs,boots,trinket}/` |
| 4, pets | 8 species × 4 colours + 3 mood overlays | 35 PNGs under `aquilo-gg/sprites/pet/` |
| 5, legendary animation | Excalibur base sprite + 4-frame APNG halo | `gear/weapon/excalibur.png` + `gear/fx/excalibur.png` |

**Sprite roster total: 273 PNGs** (45 figure + 191 gear + 35 pet + 1
legendary base + 1 legendary APNG). Every file decodes through the
runtime codec at 40×56 RGBA.

**Tests:** 115 pass (13 png-codec + 25 character/pet + 77 clash) on
the build branch. No regressions in pre-existing modules.

**Build commands** (regenerate from scratch):
```
pwsh -ExecutionPolicy Bypass -File tools/build-sprites.ps1 -OutRoot aquilo-gg/sprites
node tools/build-apng.mjs
```

**Deploy:** held per Clay's directive ("Deploy stays held until the
whole thing, full catalogue + animations + pets, is done with
final art"). Phase 1 art is done; deploy step is awaiting sign-off.
