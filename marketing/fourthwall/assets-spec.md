# Image asset spec for Fourthwall product pages

What you need to upload for each product. Sizes match Fourthwall's templates; if you provide higher-res they're downscaled cleanly.

## Per-product hero image (1200×800, PNG/JPG)

Each of the four products needs its own hero. Brand-consistent so the storefront reads as a family.

### Loadout (Free download) — primary hero

The featured product. Goes hardest on visual polish.

- **1200×800 px**, transparent or `#0E0E10` background
- Center-left: the Loadout "L" mark from `assets/Loadout.png` at 320×320 with the cyan-blue glow ring
- Center-right: the "status card" mockup that's already on the landing page (HTML in `aquilo-gg/loadout/index.html`):
  ```
  Loadout · ready
    • Bus: running on 7470
    • Patreon: Loadout Pro (Tier 3)
    • Modules: 12 enabled
    • Quiet mode: off
  ```
- Top-right corner: small "FREE" pill in `#3FB950`
- No text bigger than the L mark — no headlines on the hero itself, that's the product page's job

**Export from `aquilo-gg/loadout/promo-banner.html`** if I build that next round, or use any screenshot tool against the existing landing page hero.

### Setup Service hero

- **1200×800 px**, dark background
- Center: a stylized 30-minute clock face in the brand blue
- Top: "1-on-1 Setup" in 64px Segoe UI Bold
- Bottom: "30 minutes · Done before we hang up"

### Lifetime Pro hero

- **1200×800 px**, dark background
- Hero element: the Loadout "L" with a small gold/amber crown flair on the upper-right corner of the badge
- Subtle "PRO" wordmark watermark behind the L at 30% opacity
- Top-right: "$59 · One-time" pill in gold
- Bottom: "All features. Forever. No subscription."

### Loadout T-shirt

- **Standard merch shot** — Fourthwall's print-on-demand partner usually provides these once you upload the print
- If you need a hand-mocked shot: `aquilo.gg`-style dark backdrop, model wearing the shirt centered, print clearly visible

## Gallery images (3+ per product, 800×800 each)

For the digital products, use OBS overlay screenshots. For the merch, mockups in different colors / angles.

### Loadout gallery (suggest 6 images)

1. **Settings UI screenshot** — the WPF Settings window with the Modules tab visible, showing toggles
2. **Apex overlay** — running with HP bar at 60%, damage feed showing recent hits
3. **Bolts overlay** — leaderboard ticker bottom-right + earn toast top-right + bolt rain mid-screen (composite)
4. **Daily Check-In overlay** — broadcaster's avatar, Patreon Tier 3 flair, sub flair, rotating stat showing "Deaths: 12"
5. **Onboarding wizard** — Step 3 (Modules picker) with the "Recommended" preset selected
6. **Tray icon menu screenshot** — health row visible with bus running, Patreon Tier 3, 12 modules enabled

You can capture these with the local install you just did. Steps:

```
1. Right-click Loadout: Boot → Run Now
2. Run !loadout settings in your bot's chat (or right-click tray → Open Settings)
3. Win+Shift+S to capture each tab + the tray menu
4. For overlays, open them in a browser with ?debug=1 to get the demo cycle
```

### Setup service gallery

1. Calendar/Calendly screenshot
2. "Before / after" of a chat with no alerts → with Loadout running
3. Discord screenshot of a happy testimonial (once you have one)

### Lifetime Pro gallery

1. Same as Loadout #1, #2, #3 above (showcasing Pro-tier features)
2. Settings → Patreon tab with the "License key" field highlighted
3. Comparison table: Free / Plus / Pro feature matrix

## Banner / og:image (1200×630)

For social sharing when someone posts a Fourthwall product link to Twitter/Discord/etc.

Reuse the landing page `og:image` design — gradient background, Loadout logo, "The complete Streamer.bot suite" tagline.

I haven't generated this asset yet. To create one quickly:

1. Open `~/Desktop/Loadout/aquilo-gg/loadout/index.html` in a browser
2. Resize the viewport to 1200×630
3. Crop to the hero section
4. Save as `og.png` and put in `aquilo-gg/loadout/og.png` (referenced from index.html)

Or: build a dedicated `promo-banner.html` like StreamFusion has at `marketing/promo-horizontal.html` — let me know and I'll write one.

## Logo / favicon

- **`assets/Loadout.png`** — 256×256, already in the repo, ready to upload
- **`assets/Loadout.ico`** — multi-resolution Windows icon, already shipping inside the DLL

For Fourthwall's "Brand logo" field on the storefront, upload `Loadout.png` directly.

## Color reference (for any custom artwork you commission)

| Use | Hex |
|---|---|
| Background | `#0E0E10` |
| Card surface | `#18181B` |
| Border | `#2A2A30` |
| Text | `#EFEFF1` |
| Muted text | `#ADADB8` |
| **Primary accent** | `#3A86FF` |
| Cyan accent | `#00F2EA` |
| Gold (Pro tier) | `#F0B429` |
| Patreon gradient | `#F55D44` → `#FFCD3C` |
| Twitch | `#9147FF` |
| YouTube | `#FF0000` |
| Kick | `#53FC18` |
| TikTok | `#00F2EA` |

Same palette as StreamFusion. Anyone designing custom artwork should reuse these.
