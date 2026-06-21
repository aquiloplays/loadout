# Aquilo Ecosystem UX Audit

Comprehensive UX/UI audit covering aquilo-site (Next.js / Cloudflare Pages) and
the Loadout discord-bot (Cloudflare Worker). Generated as part of a focused
polish pass to rival StreamElements / Streamlabs / OWN3D / Nutty on ease of
use, and beat them on clarity.

Severity scale:

- **P0** – Broken, unclear-to-the-point-of-blocking, or leaking infrastructure
  jargon to users. Fix before anything else.
- **P1** – Confusing copy, jargon-heavy labels, settings that need a tooltip
  to make sense. Fix once P0 is clean.
- **P2** – Polish: animations, mobile touch targets, theme consistency,
  accessibility hardening.

Owner-only sections are intentionally redacted (no secrets, no internal URLs,
no token values appear below).

---

## P0 – Broken / blocking

1. **`/dock/setup` is a swamp of hardcoded hex values**. `src/app/dock/setup/page.tsx`
   and `src/components/dock/DockSetup.tsx` paint roughly twenty inline hex
   colors (`#07080e`, `#7c5cff`, `#f5f6fb`, `#aeb0c4`, `#ffb454`, `#5bff95`,
   etc) instead of CSS custom properties. Theme switching does nothing on
   this page. Mig everything to `var(--background)`, `var(--primary)`,
   `var(--muted)` etc.

2. **Native `alert()` and `confirm()` calls in the overlay builder** break the
   in-app flow and look like a debug build. `src/components/overlay-builder/Builder.client.tsx`
   uses three native modals (delete, copy-confirm, error). Replace with a
   reusable `<Confirm />` / `<Toast />` pattern.

3. **Cloudflare Worker URL leaked in client code**. `Builder.client.tsx` has a
   hard-coded `https://loadout-discord.aquiloplays.workers.dev` reference.
   Proxy through the existing `/api/*` Pages Function so the URL stays
   private and CORS posture stays simple.

4. **Vault pages render `null` instead of redirecting**. `/vault`,
   `/vault/daily`, `/vault/settings`, `/vault/kindle-extension` all return
   nothing. Anyone with a bookmark hits a blank screen. Redirect to a
   short deprecation notice that points them to the live tools.

5. **Internal config leaks into user-visible Discord copy**. The check-in
   slash command says `GIF search isn't available, 'GIPHY_API_KEY' isn't set
   on the worker.` Users should never see env-var names. Replace with
   `GIF search is offline right now. Try again later.`

6. **`/dock/setup` exposes the literal user id `"owner"`** in the "you are
   signed in as" line. Show a friendly account name (or just "Your account")
   instead.

7. **PNGs over 100 KB are referenced in the public folder** (banner art,
   character renders). LCP on the homepage is dragged down by these.
   Pre-encode to WebP/AVIF with a PNG fallback and ship the smaller one.

## P1 – Confusing copy and jargon

Across the site and Discord bot, the rule is: if a streamer with no API
background can't translate the label in their head, rewrite it. Examples
below are representative; the full sweep is in the fix batch.

### Dock + companion pages

- `/tools/kindle-companion`: "ingest secret" → "sync key (a private code,
  stored in your browser only)".
- `/tools/kindle-companion`: the raw `wrangler secret put VAULT_INGEST_SECRET`
  command needs a one-line lead-in: "Run this in the discord-bot folder
  (wrangler is the Cloudflare uploader)".
- `/tools/streamfusion-chat`: "Turn on Streamer.bot's WebSocket" → "Let
  Streamer.bot send live chat to the dock (Servers > WebSocket Server,
  port 8080)".
- `/tools/streamfusion-chat`: "Run TikFinity" → "Start TikFinity (the
  TikTok bridge)".
- `/tools/streamfusion-chat`: BTTV / 7TV referenced with no context →
  "custom chat emotes (BTTV and 7TV)".
- `/tools/tiktok-key-generator`: "push them to OBS as a custom browser
  dock" → "show them inside OBS so you can paste into Aitum Multistream".
- `/dock/setup`: "The dock setup is owner-only for v1." → "This dashboard is
  just for you right now (shared docks are coming later)."
- `/dock`: tier badge prints `owner` → show "Your account" instead.

### Free tools landing pages

- `/free-tools/overlay-composer`: "Chromium browser source" → "browser
  sources in OBS".
- `/free-tools/overlay-composer`: "Custom URL widget" → "embed any web
  page".
- `/free-tools/overlay-composer`: "Scene-aware visibility" → "Show/hide
  widgets per OBS scene".
- `/free-tools/aquilo-dock`: "probes" → "status checks".
- `/free-tools/aquilo-dock`: "short-lived token" → "auto-generated security
  code that expires after setup".
- `/free-tools/aquilo-dock`: "Tier gating is wired in the backend" → remove
  from user-facing copy entirely.
- `/free-tools/scene-themer`: "webhook trigger" → "instant update".
- `/free-tools/scene-themer`: "OBS WebSocket calls" → "native OBS commands".
- `/scene-themer` (admin): "Instant push webhook (optional, T1+)" → "Instant
  update (the dock re-skins as soon as your category changes)".
- `/scene-themer` (admin): "Twitch broadcaster user id" + "Config id (URL
  slug)" need plain-language help text.
- `/overlay-builder`: "Show outlines" → "Show widget placement guides".
- `/overlay-builder`: scene selector tooltip → "Pick which scene's widgets
  are visible. 'All scenes' shows every widget."

### Kitchen

- `KitchenDashboard.tsx`: "Pick this week" → "Plan this week" (or
  contextual label – "selects a rotation from your generated library").
- `KitchenDashboard.tsx`: "Repick" → "Shuffle meals".
- `KitchenSettings.tsx`: "Infant age" help text "Drives the infant recipe
  prompt" → "Customizes recipes for safe textures and portions for your
  baby".
- `KitchenSettings.tsx`: "Allergies (hard exclusion)" → "Allergies, we'll
  always avoid these".
- `KitchenSettings.tsx`: Push day/time help text → "Day and time we send
  your weekly meal plan notification".
- `KitchenPantry.tsx`: "Qty" placeholder → "Amount".
- `KitchenPantry.tsx`: "Days to expiry" placeholder → "Days until it
  expires (e.g. 7)".
- `KitchenGrocery.tsx`: "pantry already deducted" → "pantry items already
  removed".
- `KitchenGrocery.tsx`: "for Pasta, Salad, Rice..." → "for Pasta, Salad,
  Rice +2 more".

### Discord bot user copy

- Replace every literal `"Admin only."` ephemeral with one of:
  - `Sorry, this one is admin-only.`
  - `Only admins can run that.`
  - `That command is streamer-only.`
- `"You don't have permission to use this."` → `Sorry, that one is
  admin-only. Ping a mod if you think this is wrong.`
- `"Couldn't identify you."` (repeated 5+ times) → `I couldn't match your
  account, try again in a sec.`
- `"Bad vote button."` → `That vote expired, hit the latest poll.`
- `"Poll not found."` → `That poll has closed, jump to the latest one.`
- `"Empty search."` (GIF picker) → `I need a search term, try "coffee" or
  "victory dance".`
- Country leak: `COUNTDOWN_VC_ID` mentioned in user-visible setup error →
  `Countdown isn't configured yet, ping the streamer.`
- Welcome card "flip a coin" → either explain ("flip a coin in `/loadout`
  for a small Bolts bet") or drop it.

### Admin pages (owner-only)

- Owner-only gates verified in `/admin/scratch-off-content`,
  `/admin/triple-c`, `/admin/rotation`. Copy on each page is functional;
  the only nit is button height (40 px) being below the 44 px touch
  target on phones.

## P2 – Polish

1. **Animations** – Currently inconsistent. Adopt a system:
   - Page transitions: `200ms` opacity fade-in.
   - Buttons: `150ms` colour + `transform: scale(1.02)` on hover.
   - Modals: `200ms` opacity + scale 0.96 → 1.
   - List entrance: `100ms` stagger per item.
   - Skeleton loaders on every async card.
   - Respect `prefers-reduced-motion: reduce` and collapse to plain fades.
   - GPU-friendly properties only (`opacity`, `transform`).

2. **Mobile touch targets** – Multiple sub-44 px controls:
   - Step badges (`h-7 w-7`) on Kindle, StreamFusion chat, TikTok
     companion pages.
   - Toggle buttons in `DockSetup` (`padding: 6px 14px`).
   - Remove buttons in `DockView` (`padding: 2px 6px`).
   - Retry button on `/admin/rotation` (`h-9`, 36 px).

3. **Aurora theme tokens** – The brief calls out `--aurora-violet`,
   `--aurora-cyan`, `--aurora-pink`. Today the codebase uses `--primary`,
   `--accent-indigo`, `--brand-pink`. Add aurora aliases in `globals.css`
   so future copy can reach for either token. Standardise card radius on
   `rounded-2xl`, button radius on `rounded-xl`, pill radius on
   `rounded-full`.

4. **Accessibility hardening**:
   - Add `id` / `htmlFor` to every form field in Kitchen + Vault settings.
   - Add `role="status" aria-live="polite"` to the "Saved." toast pattern.
   - Add `aria-label` to all icon-only buttons (overlay builder copy
     menu, dock remove buttons, vote buttons).
   - Visible focus rings on every interactive element (currently scoped
     too narrowly).

5. **Performance**:
   - Preload Geist Sans WOFF2.
   - Mark below-fold sections `loading="lazy"`.
   - Convert PNG hero / character art to WebP / AVIF with PNG fallback.
   - Trim the `_render-all.log` and large unused PNGs out of the
     `public/` shipping set.
   - Audit `next.config.ts` for `images.formats` (force webp/avif first).

6. **Onboarding** – No tool currently shows a first-visit welcome modal.
   Add a single reusable `<WelcomeModal>` keyed per-tool in `localStorage`:
   - Dock: "Three steps, three minutes. Sign in, pick tools, paste into
     OBS."
   - Overlay builder: "Drag widgets onto the canvas. Right panel sets
     colours. Copy the URL into an OBS browser source."
   - Cam border: "Pick a shape. Pick a colour. Paste the URL into OBS
     above your webcam."
   - Scene themer: "One OBS scene that re-skins itself when you change
     game on Twitch."
   - Kitchen: "Generate meals from your prefs, then plan a week."

## Pages audited

Homepage, `/tools`, `/dock`, `/dock/setup`, `/overlay-builder`,
`/free-tools/overlay-composer`, `/cam-border`, `/free-tools/cam-border`,
`/scene-themer`, `/free-tools/scene-themer`, `/free-tools/aquilo-dock`,
`/pdf` (deprecated), `/tools/kindle-companion`,
`/tools/streamfusion-chat`, `/tools/tiktok-key-generator`,
`/tools/loadout-streamerbot`, `/install`, `/welcome`, `/kitchen`,
`/kitchen/settings`, `/kitchen/recipe/[id]`, `/kitchen/pantry`,
`/kitchen/grocery`, `/vault*` (all deprecated),
`/admin/scratch-off-content`, `/admin/triple-c`, `/admin/rotation`,
Discord bot welcome card, daily check-in, schedule embed, queue, polls,
permission denials.

## Acceptance criteria

- Every user-facing string passes the "would my mum understand this"
  test.
- Animations respect `prefers-reduced-motion`.
- All interactive controls are at least 44 × 44 px on touch devices.
- No `webhook`, `endpoint`, `bitfield`, `HMAC`, `OAuth`, `SSE`,
  `WebSocket`, `D1`, `KV`, `CSP`, `JWT`, `bearer`, `Cloudflare Worker`,
  `Pages Function`, `EventSub`, `tier_exceeded` appears in copy outside
  developer companion pages.
- No em dashes anywhere in copy.
- All hex literals in components reference CSS custom properties.
- Both deploys (Cloudflare Pages site and Cloudflare Worker bot) succeed
  after the fix batches land.
