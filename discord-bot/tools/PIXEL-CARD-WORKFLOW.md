# Pixel Card Asset Workflow — Best-Results Recipe

This is the workflow that gets the best results for the Boltbound
1252-card pixel asset library while sidestepping Flux Schnell's
biggest weakness (text legibility).

## The reality of Schnell text

Flux Schnell is the cheapest tier at $0.003/image but it's a **4-step
distilled model** — it cannot reliably render specific characters,
words, or numbers. The "MINOW" / "MINEE" / "CHAMPPION" artifacts we
saw aren't fixable by prompt engineering alone. **No reasonable prompt
gets clean text out of Schnell.**

Options to fix it:
1. **Pay more per image** — Flux Pro (~$0.04/image, ~13×) or Dev
   (~$0.025/image, ~8×) render text 70-90% cleaner. For 1252 cards
   that's $50 instead of $4.
2. **Use a text-strong model** — Ideogram v2 ($0.08/image) is purpose-
   built for text-in-images. Renders most words perfectly. ~$100 for
   the full library.
3. **Stay on Schnell + overlay clean text with Pillow** — keep the
   visual cohesion + cost from Schnell, stamp just the critical 3-5
   text/number elements via Pillow. **~$4 cost, near-perfect text.**

Option 3 is the recommendation below.

## Recommended workflow

### Step 1 — Schnell prompt strategy

Tell the AI to render the visual elements but leave the actual
characters/numbers EMPTY. Schnell is great at "an empty pixel gem
socket waiting for a number" — much better than at "the number 4."

Prompt template per rarity tier:

```
16-bit retro pixel art complete trading card design, square 1:1
aspect.

The card has [RARITY_FRAME_STYLE]:
- common:    simple silver and gray stone-tile pixel border
- uncommon:  polished green-tinted silver with emerald gem inlays
- rare:      ornate blue-tinted silver with sapphire gem inlays
- epic:      ornate violet-and-pink gradient with amethyst gems
- legendary: highly ornate aurora-pink-and-gold radiant border
             with elaborate filigree and gold gem inlays

The card layout includes (all EMPTY of text, just the shapes):
- a glowing pixel mana gem SOCKET in the top-left corner
- a small type-label banner in the top-right (empty parchment)
- a horizontal pixel name banner ribbon in the lower-middle (empty)
- two pixel stat circles at the bottom corners (one red, one green,
  both empty)

The card art portion (centered, ~55% of the card) shows
[CHARACTER_DESCRIPTION] in front of a [THEMATIC_BACKGROUND].

Vibrant 16-color palette, crisp pixel edges, no anti-aliasing,
classic Final Fantasy VI / Chrono Trigger trading card aesthetic.
NO TEXT, NO LETTERS, NO NUMBERS anywhere in the image — every
banner and gem is EMPTY.
```

Adding "NO TEXT" explicitly stops Schnell from hallucinating
gibberish.

### Step 2 — Thematic background based on card family

Map each card to its thematic context via id prefix + name keywords:

```
fire/ember/flame/pyre/cinder/lava  → volcanic cavern with lava streams
frost/ice/glacier/snow/rime         → frozen glacier cave with icicles
storm/lightning/thunder/bolt        → stormy mountain peak with lightning
undead/bone/crypt/tomb/reaper/lich  → shadowy crypt with green torchlight
verdant/root/grove/briar/thorn      → mossy forest grove
sand/dune/desert/bazaar/sphinx      → desert dune sunset
star/cosmos/astral/nebula           → cosmic starfield with nebula
vampire/crimson/velvet/blood/fang   → gothic catacomb with crimson banners
gear/cog/forge/clockwork/mech       → clockwork foundry with steam
dragon/wyrm/drake                   → dragon lair cavern
tide/depth/kraken/coral/siren       → sunken underwater temple
mirror/echo/twin/shimmer            → hall of mirrors
default                             → dark arena with aurora particles
```

### Step 3 — Pillow text overlays (the legibility fix)

After AI generation, stamp these 4-5 elements in Press Start 2P
(headers) and VT323 (body), all with 2-3px stroke outlines:

- Mana number (top-left, inside the AI's gem socket)
- Type label (top-right, inside the AI's banner)
- Name (lower-middle, on the AI's name ribbon)
- ATK number (bottom-left red circle)
- HP number (bottom-right green circle)

Positions are calibrated PER FRAME RARITY because the AI puts
sockets in slightly different spots. Keep a per-rarity position
table:

```python
OVERLAY_POS = {
    'common':    {'mana': (95, 95),  'type': (875, 100), 'name': (512, 770), ...},
    'uncommon':  {'mana': (95, 90),  ...},
    'rare':      ...,
    'epic':      ...,
    'legendary': ...,
}
```

Tune these by running 1 card per rarity through validation and
adjusting until each text lands in the middle of its AI socket.

### Step 4 — Rate limit + pacing

Replicate's per-key rate limit at the < $5 balance tier is 6/min
with burst-1. The full 1252-card run needs ~14s pacing between
calls. Total wall-clock: ~5 hours.

### Step 5 — Hosting

Save PNGs locally during the run. After completion, upload to R2
(or another CDN) and update `global-card-art:<cardId>` KV entries
to point at the new URLs.

## What we get with this workflow

- **Visual cohesion** = AI generates frame + character + banner +
  background as a unified composition. Best result.
- **Clean numbers + name** = Pillow overlays guarantee 100% legibility.
- **Cost** = $4 total, vs $50-100 for cleaner AI text.
- **Animation** = static images. Gameplay UI handles motion via
  CSS/JS on the site side.

## Cost summary

| Item                         | Quantity | Unit cost     | Total     |
|------------------------------|----------|---------------|-----------|
| Boltbound card library       | 1252     | $0.003 / img  | **$3.76** |
| Heroes (12 classes)          | 12       | $0.003 / img  | $0.04     |
| Gear icons                   | ~200     | $0.003 / img  | $0.60     |
| Clash buildings + units      | ~260     | $0.003 / img  | $0.78     |
| Pets                         | ~50      | $0.003 / img  | $0.15     |
| Cross-asset retries (10%)    | est      | $0.003 / img  | ~$0.50    |
| **Total estimated**          |          |               | **~$5.83** |

Well within the $10 budget.
