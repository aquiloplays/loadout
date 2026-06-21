# Aquilo Overlay Composer migration

Internal codename: `overlay-canvas`. Public name: **Aquilo Overlay Composer**.

This is the one-shot migration doc for Clay. Existing
`/personal-overlays/*` URLs keep working unchanged; the canvas overlay
ships alongside, so nothing breaks. You migrate at your own pace by
replacing individual browser sources with the unified one.

## What's new

- **Static overlay**: `public/overlays/canvas/index.html` plus
  `runtime.js`. One transparent 1920x1080 surface that loads a layout
  JSON from the worker and mounts every widget on it.
- **Layout builder**: `/overlay-builder` (owner-only). Drag, drop,
  resize, snap to 16px grid, scene templates, OBS reference image
  background, live preview, debounced save.
- **Free-tools landing**: `/free-tools/overlay-composer`. Public
  marketing page with a guest-mode CTA.
- **Worker module**: `discord-bot/overlay-canvas.js`. KV-backed layout
  storage, D1 metadata, SSE bus (taps existing `ActivityBroadcaster`,
  no new EventSub subs), tier enforcement, iframe probe, R2 reference
  image upload.

## Manual actions

1. **D1 migration**
   ```bash
   cd discord-bot
   wrangler d1 execute aquilo_bot_db --remote --file=overlay-canvas-migration.sql
   ```
2. **R2 bucket** (for the OBS reference image upload). Without this the
   reference image route returns `r2-not-wired` and the rest of the
   composer keeps working.
   ```bash
   wrangler r2 bucket create aquilo-overlay-references
   ```
   The binding name `OVERLAY_REFERENCES` is already in `wrangler.toml`.
3. **Deploy the worker**
   ```bash
   wrangler deploy
   ```
4. **Deploy the site** (Next.js, normal pipeline)
   ```bash
   cd ../aquilo-site
   npm run build
   ```

## Worker.js edit

A single additive block was added next to the existing
`/api/overlay-test/` dispatcher:

```js
if (path.startsWith('/api/overlay-canvas/')) {
  const { handleOverlayCanvas } = await import('./overlay-canvas.js');
  return handleOverlayCanvas(req, env, ctx, url);
}
```

No other lines in `worker.js` were touched. Your in-progress vault
Kindle ingest, kitchen weekly pick, aquilo site sync, and find-game-art
routes are preserved.

## OBS migration steps

For each scene where you have 9+ browser sources today:

1. Open the builder at `/overlay-builder`.
2. Click "New layout" and label it after the scene (for example "Game",
   "BRB", "Intro").
3. Optional: upload a screenshot of the current scene as the reference
   image (the toggleable background in the canvas). Use the slider to
   set opacity around 30%, then drag widgets to match positions.
4. Drag each widget from the palette onto the canvas.
   - For widgets that are 1:1 ports (aurora cam border, chat, sub goal,
     follow popup, death counter), the defaults match the existing
     `/personal-overlays/*` behaviour.
   - For widgets backed by a non-Aquilo URL (Tipeeestream donation
     tickers, StreamElements, etc.), use the **Custom URL** widget and
     paste the URL.
5. Tag each widget with the scene names it should appear in (or `*` for
   always). Use the scene-template dropdown above the canvas to preview
   different scenes locally.
6. Click "Copy overlay URL" and replace your existing browser sources
   in OBS with one source pointed at that URL.
7. The old `/personal-overlays/*` browser sources continue to work, so
   you can keep them around until you trust the new layout.

## Layout sharing

The overlay URL embeds the layout id:

```
https://aquilo.gg/overlays/canvas?id=<layoutId>
```

Anyone can paste that URL into OBS to render the same layout. Layouts
marked `visibility: 'unlisted'` or `'public'` (v2 feature) become
discoverable; for v1 every layout starts as `private` and is reachable
by id only.

The fork endpoint copies a layout under the caller's ownership:

```
POST /api/overlay-canvas/layout/<sourceId>/fork
```

This is the same mechanism that v2's community templates will use.

## Performance comparison

| Setup                                | Chromium instances | SSE connections | Shared asset cache |
| ------------------------------------ | ------------------ | --------------- | ------------------ |
| Today (9 individual browser sources) | 9                  | up to 9         | no                 |
| Composer (1 unified source)          | 1                  | 1               | yes                |

Each individual browser source is a full Chromium tab that ticks every
frame even when idle, plus its own SSE handshake against
`/api/cam-border/events/*` or the equivalent. Consolidating to one
process drops compositing cost, halves the number of socket file
handles OBS pins, and lets every widget share one asset cache.

The expected render-cost reduction matches Clay's previous log:
roughly **8 to 15% rendering lag** clawed back on the OBS render
thread. Verify in OBS under Stats once you swap a scene over.

## Tier limits

Enforced server-side on every PUT. Owner (Discord id
`1107161695262085210` or email `bisherclay@gmail.com`) bypasses every
limit.

| Tier   | Layouts   | Widgets / layout | Custom CSS | Featured |
| ------ | --------- | ---------------- | ---------- | -------- |
| Free   | 5         | 5                | no         | no       |
| T1     | 15        | 15               | no         | no       |
| T2     | unlimited | unlimited        | yes        | no       |
| T3     | unlimited | unlimited        | yes        | yes      |

## Guest mode

Anonymous visitors land on `/free-tools/overlay-composer` and click
"Try it free, no signup". This opens `/overlay-builder?mode=guest`. The
layout is saved to `localStorage` under `aquilo:composer:guest:layout`
with a 7 day expiry, and the overlay URL travels in the URL itself:

```
https://aquilo.gg/overlays/canvas?guest=<base64-json>
```

The hard URL cap is 8 KB. If a guest builds a layout that exceeds it,
the copy-URL button surfaces a friendly "sign in to remove the limit"
message.

## Sample default layout JSON

Drop this into the builder via the import button (v2 feature) or just
PUT it directly:

```json
{
  "schemaVersion": 1,
  "label": "Clay default",
  "canvasSize": { "w": 1920, "h": 1080 },
  "visibility": "private",
  "requiredTier": "free",
  "widgets": [
    {
      "id": "wgt_cam_border",
      "type": "aurora-cam-border",
      "x": 320, "y": 180, "w": 1280, "h": 720, "z": 10,
      "scenes": ["*"],
      "config": { "configId": "default" }
    },
    {
      "id": "wgt_chat",
      "type": "chat",
      "x": 1500, "y": 200, "w": 400, "h": 700, "z": 5,
      "scenes": ["Game", "BRB"],
      "config": { "maxLines": 12, "fontSize": 18, "showBadges": true }
    },
    {
      "id": "wgt_sub_goal",
      "type": "sub-goal",
      "x": 32, "y": 32, "w": 320, "h": 110, "z": 6,
      "scenes": ["Game"],
      "config": { "label": "Sub goal", "goal": 10 }
    },
    {
      "id": "wgt_death",
      "type": "death-counter",
      "x": 32, "y": 160, "w": 240, "h": 80, "z": 6,
      "scenes": ["Game"],
      "config": { "start": 0, "label": "Deaths" }
    }
  ],
  "templates": [
    { "name": "Game", "widgetVisibility": { "wgt_chat": true, "wgt_sub_goal": true, "wgt_death": true } },
    { "name": "BRB",  "widgetVisibility": { "wgt_chat": true, "wgt_sub_goal": false, "wgt_death": false } }
  ],
  "customCss": "",
  "backgroundColor": "",
  "referenceImage": null
}
```

## Custom URL widget - example sources

The Custom URL widget renders ANY iframe-friendly URL. A few real
examples to validate:

- **StreamElements alertbox**: `https://streamelements.com/overlay/<id>/<token>`
- **Streamlabs alert**: `https://streamlabs.com/alert-box/v3/<token>`
- **OWN3D notifications**: `https://overlay.own3d.tv/widget/<id>`
- **Nutty viewer counter**: `https://viewers.nutty.gg/?channel=<login>`
- **Lottin / Lurkit feeds**: paste the OBS browser-source URL they give you

Save the widget URL into the config. The builder pings a HEAD request
to surface a soft warning when the provider blocks framing via
`X-Frame-Options: DENY` or a restrictive CSP `frame-ancestors`. The
save is not blocked, since many providers fail the server-side check
but render fine inside OBS (which is a desktop Chromium with no host
frame chain enforcing the policy).

## Debug HUD

Append `?debug=1` to the overlay URL to render a small aurora-violet
HUD in the top-left corner. Shows FPS, the active scene, total
mounted widgets, and per-widget initial render time in ms. Safe to
leave on while you tune positions.

## Rollback

Roll back by deleting the unified OBS browser source and re-adding the
old individual sources. Nothing about the new system touches the old
`/personal-overlays/*` overlays or their KV keys. The
`overlay-canvas:*` KV keys and the `overlay_canvas_layouts` D1 table
are scoped to this feature.
