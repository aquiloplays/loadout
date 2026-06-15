# Overlay Migration Plan

Move all overlay FRONTEND assets out of `Loadout/` and into `aquilo-site/`. After this migration, Loadout is pure backend: Discord-bot worker, Streamer.bot bundle, build tooling.

## Source tree (Loadout)

Loadout currently mirrors the overlay frontends under `aquilo-gg/overlays/<name>/`. Each overlay is a folder with `index.html` + `main.js` + `style.css` (some have extra assets). The Loadout-built worker (`discord-bot/overlay-canvas.js`) and Durable Object (`discord-bot/aquilo/overlay-do.js`) stay; only the static frontends move.

## Destination tree (aquilo-site)

- Personal "follow" alert overlays already exist at `aquilo-site/public/personal-overlays/follow-*`. Loadout copies of these are byte-identical, so the Loadout copies are removed without copy.
- Production frontends (the bus-wired overlays such as hypetrain, viewer, all, commands, etc.) move to `aquilo-site/public/overlays/<name>/`.
- The standalone TikTok reward overlay moves to `aquilo-site/public/overlays/tiktok/follow-reward.html`.

## Manifest

### A. Migrated to aquilo-site/public/overlays/

| Source (Loadout) | Destination (aquilo-site) | Files | Notes |
|---|---|---|---|
| aquilo-gg/overlays/hypetrain | public/overlays/hypetrain | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/viewer | public/overlays/viewer | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/commands | public/overlays/commands | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/recap | public/overlays/recap | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/all | public/overlays/all | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/check-in | public/overlays/check-in | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/clash | public/overlays/clash | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/compact | public/overlays/compact | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/engagement | public/overlays/engagement | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/goals | public/overlays/goals | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/lobby | public/overlays/lobby | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/minigames | public/overlays/minigames | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/vertical | public/overlays/vertical | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/bolts | public/overlays/bolts | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/promo | public/overlays/promo | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/heart-roulette | public/overlays/heart-roulette | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/counters | public/overlays/counters | index.html, main.js, style.css | New on aquilo-site |
| aquilo-gg/overlays/tiktok-bar | public/overlays/tiktok-bar | index.html, main.js, style.css, aquilo-lockup.svg, heart-me.webp | New on aquilo-site |
| aquilo-gg/overlays/_shared | public/overlays/_shared | shared CSS/JS used by the above (loadout-design.css, tiktok-gifts.js) | Shared deps |
| overlays/tiktok/follow-reward.html | public/overlays/tiktok/follow-reward.html | follow-reward.html | Standalone TikTok reward overlay |

### B. Duplicates removed from Loadout (already present in aquilo-site)

All eight follow-* alert overlays under Loadout/aquilo-gg/overlays/ are byte-identical to the existing files in aquilo-site/public/personal-overlays/follow-*. They are removed from Loadout without copy:

- follow-amongus, follow-fallout4, follow-gwyf, follow-lethalcompany, follow-minecraft, follow-peak, follow-phasmophobia, follow-repo

Exception: `follow-fallout4/_shot-*.png` (boom, charge, contact, peek, sign, smoke) are reference screenshots that exist only in Loadout and are not referenced by index.html. They move to `aquilo-site/docs/overlay-references/follow-fallout4/`.

### C. Deleted (dead / archived)

- `Loadout/aquilo-gg/overlays/apex/` (Clay archived Apex)
- `Loadout/companion-crowdplay/_MEI*` (8 PyInstaller bundle remnants)
- `Loadout/_MEI*` (6 root-level PyInstaller bundle remnants)
- `Loadout/.claude/worktrees/*` (12 stale ephemeral worktrees)
- Root-level reference screenshots (16 PNGs): `follow-overlay-*.png` (7) and `activity-overlay-demo-*.png` (8) and `00-contact-sheet.png` (1). Useful ones (the follow-overlay sample contact sheets) move to `aquilo-site/docs/overlay-references/`.

### D. KEEP in Loadout (backend only)

- `discord-bot/aquilo/overlay-do.js` (Durable Object backend)
- `discord-bot/overlay-canvas.js` (Composer worker)
- `discord-bot/overlay-test.js` (test route)
- `discord-bot/overlay-canvas-migration.sql`
- `discord-bot/tools/*-overlay-*.py / .mjs` (build tooling pipelines)
- `streamerbot/` Streamer.bot bundle (no Loadout overlay path references found; bundle text uses friendly `aquilo.gg/*` URLs only)

### E. Out of scope (NOT touched)

Loadout still has design specs, art renders, the gateway, the aquilo-gg site mirror, etc. Those are NOT overlay-frontend assets. Cleaning them is follow-up work; see "Final report" notes.

## Streamer.bot bundle references

A grep across `streamerbot/` for `aquilo-gg/overlays`, raw Loadout paths, `localhost`, or `file://` URLs found ZERO direct references to old Loadout overlay paths. Bundle descriptions use friendly URLs (`aquilo.gg/hangman`, `aquilo.gg/powerdeck`, etc.). No bundle JSON updates are required.

## Verification

- `node --check` on each kept backend file: `discord-bot/overlay-canvas.js`, `discord-bot/overlay-test.js`, `discord-bot/aquilo/overlay-do.js`.
- Composer route: `discord-bot/overlay-canvas.js` is mounted by `discord-bot/worker.js` and serves `aquilo.gg/overlays/canvas/*`. Frontend assets at `aquilo-site/public/overlays/canvas/` (already present) continue to be served via the aquilo-site Pages build.

## Commit strategy

- One commit per repo. Only the migration paths are staged. The repos already have unrelated dirty files which are NOT included in these commits.
- No em dashes in commit messages.
