# Character system — pixel-art creator + paper-doll gear layering

> Status: **design only, not yet built.** Awaiting Clay's sign-off on
> the open questions in §11.
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
> *"Every loot/gear piece must be its OWN unique custom sprite — no
> reused textures, each one new — and gear should look more detailed
> and 'cooler' the rarer / more expensive it is."*

---

## 1. Guiding principles

- **One identity, one record.** The character is the *visual
  expression* of the viewer's existing dungeon hero. It is NOT a new
  parallel record — it's a `look` field on `HeroState`. Same hero,
  same gear, same level — now with a face.
- **Sprite-once, render-twice.** Every gear sprite is authored ONE
  time at a fixed canvas size. The same PNG file serves as the
  inventory icon AND as the equipped paper-doll layer on the
  character. No "icon vs in-game art" split. Authoring discipline.
- **Rarity is the dial.** A common boot is a flat 3-shade silhouette.
  A legendary boot is a multi-frame animation with glow particles
  and a unique outline. Same canvas, same slot, same layering rules
  — the *content* of the sprite is what scales with rarity.
- **Discord-first, web-fancier.** The character editor must work
  inside Discord's button/select/modal constraints (no clickable
  pixels, no rich-canvas). The web editor at
  `loadout.aquilo.gg/character` gets the live-preview drag-and-drop
  treatment. Both flows write to the same `HeroState.look`.
- **Composition is server-rendered.** A single Worker endpoint
  composes the character PNG from layers on demand and serves it.
  Discord embeds, Twitch panel, web — all hit the same URL. One
  source of truth, identical pixels everywhere.

---

## 2. The character model — what a viewer customizes

Six customization axes. Each is a small set of discrete options so
the editor fits in a Discord select-menu (max 25 options each).
Anything that needs a colour gets a curated palette — no free-form
hex pickers (palette discipline keeps the art coherent across the
whole roster).

| Axis | Options (Phase 1) | Notes |
| --- | --- | --- |
| **Body type** | `slim`, `stocky` (2) | Two silhouettes, same 24×40 footprint. All gear sprites are authored to fit both — drives the gear-sprite spec. Adding a 3rd type triples gear authoring effort, so we stop at 2. |
| **Skin tone** | 10 swatches (Fitzpatrick-style, plus 2 fantasy: pale-violet, ash-grey) | Curated palette, named (`fair`, `tan`, `bronze`, `umber`, `ebony`, `pale-violet`, `ash`, `olive`, `rose`, `porcelain`). |
| **Hair style** | 12 styles (Phase 1) | `short-tousled`, `long-straight`, `bun`, `mohawk`, `braids`, `curly-afro`, `pixie`, `ponytail`, `bald`, `shaved-sides`, `mullet`, `wizard-long`. Each authored once; recoloured at render time via palette swap. |
| **Hair colour** | 14 swatches (natural + a 4-colour fantasy bonus row) | Brown / black / blonde / red / grey / white + violet / teal / pink / mint accents. |
| **Eye colour** | 8 swatches | Brown / blue / green / hazel / amber / violet / silver / pink. Renders as a 2-pixel face overlay; subtle but visible at the standard sprite size. |
| **Accent** | 6 cosmetic flairs | `freckles`, `eye-shadow`, `face-scar`, `beauty-mark`, `glasses-round`, `none`. Subtle face-layer overlays. Glasses sit above the eye-colour pixels and below hair fringe. |

Excluded from Phase 1 to keep scope honest:
- **Face shape / jaw geometry** — at 24×40 the silhouette options
  read as the body-type axis already.
- **Tattoos / chest art** — hidden by chest gear in practice, low
  payoff for the sprite work.
- **Pets / familiars** — separate system; possibly a Patreon perk
  later.
- **Background / scene** — render is character-only by design. The
  surfaces that show it (Discord embed, panel, web) provide the
  background.
- **Animated idle for the BASE figure** — only the rarest gear gets
  animation in Phase 1. Idle bob can come later.

That's **6 axes × ~10 average choices = 600,000 combinations** at
the figure level alone before any gear is layered. Plenty of
identity.

---

## 3. Relationship to the existing `HeroState`

The character **extends** `HeroState` rather than replacing or
shadowing it. One record, one identity, one truth.

```js
// discord-bot/dungeon.js HeroState — Phase 1 addition (the `look` block)
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
    // Optional palette overrides (cosmetic Patreon perks later — see
    // CLASH-FEATURE-DESIGN §2 for the precedent).
    palette:   null,
  },
  lookVersion: 3,                // bumped on every edit; lets caches
                                 // invalidate the rendered PNG.
  // existing fields below — unchanged
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

- `bag[]` and `equipped{}` shape is unchanged — Phase 1 just adds
  one new optional field per item (`spriteId`, see §4).
- `dungeonsSurvived`, `duelsWon`, `legendariesFound` and the rest of
  the stats — untouched.
- Voltaic loot pieces (Clash) follow the same gear schema and get
  their own sprites in the same way as every other gear piece.

---

## 4. Paper-doll layering — sprite-once, render-twice

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
| 0  | (transparent canvas) | — |
| 10 | **Back accessory** | `trinket` item if `back == true` (capes, wings) |
| 20 | **Body** | Base figure sprite — determined by `look.bodyType` + `look.skinTone` |
| 30 | **Legs** | `legs` slot item |
| 35 | **Boots** | `boots` slot item |
| 40 | **Chest** | `chest` slot item |
| 45 | **Front trinket** | `trinket` item if non-back (rings, amulets — render on a small pixel zone the chest sprite intentionally leaves open) |
| 50 | **Off-hand** | reserved (Phase 2 — shields, orbs) |
| 60 | **Hair** | Figure sprite chosen by `look.hair`, palette-swapped to `look.hairColor` |
| 65 | **Face overlay** | Eye-colour 2-pixel highlights + `look.accent` (freckles / glasses) |
| 70 | **Head** | `head` slot item — drawn AFTER hair so helmets cover it |
| 80 | **Weapon** | `weapon` slot item (drawn front because it's the read-at-a-glance signal) |
| 90 | **FX overlay** | Particle / glow animation frames for legendary gear (§5) |

The renderer iterates the equipped slot list in z-order, draws each
sprite at (0,0) on the canvas, and writes the final PNG. **Every
gear sprite is positioned in its source PNG at the exact pixel where
it belongs on the figure.** No per-slot offset table, no
runtime placement logic — the authoring is the placement.

### The "one sprite, two uses" rule

Every gear PNG is rendered TWO ways:

1. **Inventory icon.** Auto-crop the PNG to its opaque bounding box,
   pad to a square at the longest side, scale up 2× or 4× depending
   on UI density. Used in `/inventory`, the panel, the website.
2. **Equipped layer.** Render the PNG as-is on the 40×56 canvas at
   (0,0). The transparent canvas pixels are the offset — they
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
  silhouette through. No code-side rule needed — the *sprite
  shape* decides.
- Boots + legs: same layering principle. Tall greaves cover trouser
  legs from the knee down.
- Front trinket vs chest: chest sprite intentionally leaves a 6×6
  pixel patch over the sternum where small front-trinkets (necklaces,
  pendants) can sit on top. If a chest piece *should* cover the
  trinket (heavy plate armour), its sprite fills that patch — the
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
| **Legendary** | full 40×56 canvas | 6+ tiers | particle FX overlay (z=90), full glow halo, unique silhouette | 4-frame animation (idle bob + glow pulse) — required |

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
  +1-pixel-radius outline pass at render time — no per-set art.
- **Class tint, optional.** Items with `preferredClass` get a small
  class-tint pixel zone the artist marks in a special palette index.
  Render swaps that index to the class's `TintColor` (warrior red,
  mage violet, etc. — already defined in `DungeonContent.cs`). This
  is how a "class-aligned epic" reads visually without authoring 5×
  variants.

---

## 6. Customization UX

### Discord — `/character` slash command

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
  ≤5 components each — fits comfortably).
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

### Web — `loadout.aquilo.gg/character`

Full client-side editor. Lives in the `aquilo-site` repo, owned by
the other session. Phase 4 of this project.

- Side panel: the six axis selectors as labeled rows of swatch
  buttons (no dropdowns — pixel-art swatches are more readable than
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
  placeholder (Phase 1 — see §9).

### Composition

A new Worker route renders the character PNG on demand:

```
GET /character/render/<guildId>/<userId>.png[?v=<lookVersion>]

  → reads HeroState
  → resolves look + equipped[] into a layer list
  → fetches each layer PNG from the Pages bucket (cached at the
    CF edge by URL — ~5 KB each)
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
service. Costs $5/mo for 100k transforms — fine for our volume.
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

### Phase 1 — Foundation (no gear sprites yet)
*~1–2 weeks engineering + ~1 week initial figure art*

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

### Phase 2 — Gear layering with placeholder sprites
*~2 weeks engineering + ongoing art*

- Add `spriteId` field to every catalogue item in `dungeon.js`
  SHOP_POOL + `clash-content.js` VOLTAIC_LOOT.
- Renderer extends to layer equipped gear from the equipped slots.
- **Placeholder sprite policy:** items without an authored sprite
  yet render a **rarity-tier silhouette** — a procedurally
  generated outline of the slot, tinted by rarity. Common boots
  render as a grey boot silhouette. Epic weapons render as a violet
  weapon silhouette. Lets the system go live with the full
  catalogue immediately while art is produced.
- Set-bonus visual frame ("set-active outline") wired.

### Phase 3 — Real gear art, common → epic
*~6 weeks art (see §10 estimate)*

- Author every common, uncommon, rare, and epic sprite in the
  catalogue. Voltaic (epic) gets full treatment.
- Each piece replaces its rarity-silhouette placeholder as it
  lands. No deploy required per asset — Pages cache flushes on
  Worker version bump.
- Class-tint zones authored where applicable; renderer applies the
  class palette swap.

### Phase 4 — Legendary animation + web editor
*~3 weeks engineering + ~2 weeks art*

- Animated sprites for legendary tier: 4-frame loop, ~150 ms /
  frame. Worker render endpoint extends to APNG output (animated
  PNG) when any equipped piece is legendary; static PNG otherwise.
- Web `loadout.aquilo.gg/character` editor (in aquilo-site repo).
- Twitch panel character tab.
- Dungeon overlay scene transitions tap the same render URL with
  optional frame variations (idle, walk).

### Phase 5 — Polish + cosmetic perks (open-ended)
- Patreon cosmetic hair tints (the fantasy bonus row of hair-colour
  swatches gets unlocked for supporters).
- Per-character "banner" cosmetic (the 8-pixel canvas gutter on
  each side fills with a tier-specific banner pattern).
- Animated idle bob on the base figure.
- Mounted display ("mount" trinket category that adds a creature
  beneath the figure — pushes the canvas to 40×72; a clean Phase 5
  not Phase 1 because it changes the asset spec).

---

## 9. Art production effort estimate

The catalogue right now has roughly:

- **Dungeon shop (`dungeon.js SHOP_POOL`)** — 120 items across 6
  slots × 4 rarity tiers (Common, Uncommon, Rare, Epic), with 4
  named sets (`ironclad`, `arcane`, `forester`, `wayfarer`).
- **Voltaic loot (`clash-content.js VOLTAIC_LOOT`)** — 6 epic
  pieces.
- **Future loot from Phase 3 of CLASH** — Battle Plans, future
  legendary drops, ~20 more pieces.

≈ **150 unique gear sprites** at Phase-3 completion. Plus the
~**40 figure sprites** for the base character (Phase 1).

Time per sprite, rough authoring estimate (assumes a competent
pixel-art artist familiar with our 40×56 spec):

| Tier | Time / sprite | Pieces (est.) | Subtotal |
| --- | --- | --- | --- |
| Figure (body+hair+face) | 30–45 min | 40 | 30 h |
| Common gear | 30 min | 60 | 30 h |
| Uncommon gear | 45 min | 35 | 26 h |
| Rare gear | 60 min | 25 | 25 h |
| Epic gear | 90 min | 20 | 30 h |
| Legendary gear (Phase 4, animated) | 4 h | 10 | 40 h |
| **Total** | | **~190 pieces** | **~180 h** |

180 hours = **~4.5 weeks of full-time art**, or 9 weeks at
half-time. Realistically this is a multi-month commitment if it's
one person. Two ways to stage:

1. **Hire-rate.** Contract a pixel artist for a 4–6 week sprint.
   At $30–50/hr that's ~$6k–$9k. Highest velocity, single style.
2. **In-house tier-laddered.** Author commons + uncommons first
   (~56 h, 1.5 weeks). Ship Phase 2 with the placeholder silhouettes
   for rare/epic and live with it for 1–2 months. Add tiers over
   time. Lowest cost, slower visible payoff.

**Recommendation: in-house tier-laddered.** Common + uncommon
covers ~95% of inventory by drop volume (drops are weighted toward
common). Legendary appears rarely enough that it's fine to take
extra weeks per piece. The placeholder silhouettes carry the
system convincingly enough to ship — players will see *something*
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
  textures — every piece unique. That bumps the authoring count
  but **set families** (ironclad, arcane, etc.) still share visual
  language while differing in detail. The rule is *no copy-paste*,
  not *no consistent style*. Documented for the artist.
- **Sprite drift.** Without strict canvas-spec discipline, gear
  sprites land at the wrong pixel position and layer wrong. The
  Aseprite template (with the body ghost-layer locked) is the
  enforcement mechanism; ship it on day one.

---

## 11. Open questions for Clay

1. **Sprite canvas — confirm 40×56.** Bigger (e.g. 48×64) costs
   more pixels per asset but gives plumes/weapons more room. Smaller
   (32×48) is faster to author. **Recommend 40×56.**
2. **Animation policy.** Does *legendary* tier require animation
   from day one, or is "static legendary, animation later" OK? The
   ~40 hours of animation work is the single biggest chunk in §9.
3. **Body types — confirm two.** Slim + stocky covers gender-
   ambiguous identity well without bloating gear authoring.
   Alternative: a third "child" or "tall" silhouette adds variety
   but triples gear-fit work.
4. **Art production path.** §9's hire-rate (~$6–9k, 4–6 weeks) or
   in-house tier-laddered (slower, placeholder silhouettes in the
   meantime)? Recommend tier-laddered unless there's a launch
   deadline.
5. **Placeholder silhouettes.** Acceptable for Phase 2 ship, or
   should the system block until every catalogue item has art?
   Recommend ship with placeholders.
6. **Discord render UX.** Per the §6 sketch, the live preview is a
   re-fetched embed image. Acceptable, or does the editor need
   *true* live update via an ephemeral message edit on every
   select-menu interaction (more responsive, more interactions)?
7. **Class tint zones.** Should every gear piece have an optional
   class-tint pixel zone (cleaner alignment with class identity),
   or only items with `preferredClass != ''`? **Recommend the
   latter** (today's catalogue already has the field).
8. **Patreon cosmetics scope.** Hair fantasy palette unlocked for
   supporters (cosmetic only) — is that the right brand fit, or
   should cosmetic gating stay out of the character system entirely
   for fairness?
9. **Mounted display.** Phase 5 sketches a "mount" trinket category
   that requires a taller canvas (40×72). Worth designing around now
   so we don't have to migrate every asset later, or commit to 40×56
   forever and ship mounts as their own non-character entity?
10. **Where do sprite PNGs live in git?** This repo (`assets/sprites/`)
    or the aquilo-site repo (`aquilo-gg/sprites/`)? Either works
    operationally; choice affects which session owns the asset
    pipeline. **Recommend aquilo-gg/sprites/** because it already
    serves the overlays and ships via the Cloudflare Pages mirror —
    minimal new infra.
