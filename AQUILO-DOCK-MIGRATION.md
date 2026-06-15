# Aquilo Dock - relationship to the TikTok Streamkey dock

The Aquilo Dock (aquilo.gg/dock) is the unified control panel for
every Aquilo product. The TikTok Streamkey Pusher dock
(aquilo.gg/dock/streamkey/) is a separate standalone product. Both
ship and stay shipped. Neither replaces the other.

## What the unified dock is

A single OBS browser source that surfaces status and quick actions
for every Aquilo tool a streamer uses, including the Streamkey
Companion as one card among many. It is a control panel, not a
replacement for any tool's dedicated surface.

## What the standalone Streamkey dock stays

A focused single-purpose OBS dock for TikTok Go-Live flows. Streamers
who only want the key-paste workflow keep using `/dock/streamkey/`
exactly as before. No redirect, no deprecation, no cutover window.

## Cross-links between the two

- The standalone `/dock/streamkey/` page links out to `/dock` with the
  copy "use the all-in-one dock to manage everything from here too".
  Small, in the header sub-line, not a takeover banner.
- The unified dock's Streamkey Companion card carries an extra "Open
  standalone" link to `/dock/streamkey/` so a streamer who wants the
  full key-paste UI is one click away.
- Both pages keep their own marketing landings:
  `/free-tools/streamkey-companion` for the standalone product,
  `/free-tools/aquilo-dock` for the unified control panel.

## What got absorbed from the TikTok dock work

Patterns, not product surface:

- Aurora dark theme + status palette (violet + teal + green + gold +
  red). The CSS variables in `DockView.tsx` mirror the ones in
  `/dock/streamkey/index.html` so the two pages feel like the same
  family.
- "Status dot + label + detail" card pattern. The Streamkey dock
  established it for the companion/key/Aitum trio; the unified dock
  generalizes it to one card per registered tool.
- 400px-wide layout tuning for OBS Custom Browser Docks. Both pages
  default to 400px; the unified dock stretches to 520px in the popout
  (`layoutPref=roomy`).
- The OBS "Custom Browser Docks" install instructions on
  `/free-tools/aquilo-dock` are written in the same voice as the
  Streamkey dock's README.

The `aquilo-tiktok-dock` repo's backend (server.mjs, obs.js,
streamlabs.js, aitum.js, keysource.js, categories.js) is unchanged.
It keeps running as the Streamkey Companion local app the unified
dock probes via `127.0.0.1:7480`.

## What does NOT change

- `/dock/streamkey/` stays mounted permanently. No redirect ever.
- `aquilo-tiktok-dock` repo stays as-is. No rename.
- Per-tool admin pages stay where they are: `/cam-border`,
  `/scene-themer`, `/overlay-composer`, `/vault`, `/kitchen`. The
  unified dock surfaces status and quick actions only.

## Tier-gate future-proofing

`dock.js` reads from `TIER_LIMITS` (free=3, t1=6, t2+ unlimited) and
already calls `getWidgetPresetAccess` for Patreon-token resolution.
The v1 owner-only flag short-circuits the limit; flipping the unified
dock to public is a one-line `requireOwner` -> `resolveAccess` swap
plus the matching marketing copy. No D1 migration, no schema bump.
The standalone Streamkey dock has its own gating model and is not
affected.
