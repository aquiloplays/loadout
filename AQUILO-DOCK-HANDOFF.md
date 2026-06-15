# Aquilo Dock - handoff notes for Clay

This session built the unified Aquilo Dock across aquilo-site and
Loadout. Files are on disk. Two manual steps are left.

## Two manual steps

### 1. Apply the worker.js routing block

The Cowork bash mount could not reliably sync the worker.js tail back
through git, so this 7-line insert was made via the host file tools.
The host file is correct, but please verify the block below is in
place (immediately after the `/api/sfdock/` block, near line 750):

```js
    // Aquilo Dock backend (the unified per-user control panel). Public
    // registry read, owner-only state read + toggle + layout writes.
    // D1 table dock_user_state is lazily created on first hit.
    // See dock.js for the registry + tier-slot model.
    if (path.startsWith('/api/dock/')) {
      const { handleDock } = await import('./dock.js');
      return handleDock(req, env, ctx, url);
    }
```

If `grep "/api/dock/" discord-bot/worker.js` returns the line, you are
good.

### 2. Commit both repos

Both repos had a stale `.git/index.lock` this session could not remove
(mount permissions). From PowerShell:

```powershell
# Loadout
cd C:\Users\bishe\Desktop\Aquilo\Loadout
Remove-Item .git\index.lock -ErrorAction SilentlyContinue
git add discord-bot/dock.js discord-bot/dock-migration.sql discord-bot/worker.js AQUILO-DOCK-MIGRATION.md AQUILO-DOCK-HANDOFF.md
git commit -m "feat(dock): unified Aquilo Dock backend + D1 schema"

# aquilo-site (real folder, the Desktop\Aquilo entry is a junction)
cd C:\Users\bishe\Desktop\aquilo-site
Remove-Item .git\index.lock -ErrorAction SilentlyContinue
git add functions/api/admin/dock src/app/dock src/app/free-tools/aquilo-dock src/components/dock
git commit -m "feat(dock): /dock + /dock/setup + free-tools landing + admin proxies"
```

## What was built

### Loadout (`discord-bot/`)
- `dock.js` — backend module. `GET /api/dock/registry`, `GET /api/dock/state/:userId`, `POST /api/dock/toggle/:toolId`, `PUT /api/dock/layout`. Owner-only writes via the same HMAC envelope `scene-themer.js` uses. Tier-slot limits wired (free 3, t1 6, t2+ unlimited) with v1 owner short-circuit.
- `dock-migration.sql` — canonical D1 schema for `dock_user_state`.
- `worker.js` — 7-line route insert above.
- `AQUILO-DOCK-MIGRATION.md` — TikTok-dock cutover plan.

### aquilo-site

Pages:
- `src/app/dock/page.tsx` — main dock view. URL params `?user=&token=`. Aurora dark theme. Compact (400px) and roomy (520px) layouts.
- `src/app/dock/setup/page.tsx` — three-step onboarding wizard.
- `src/app/free-tools/aquilo-dock/page.tsx` — marketing landing with tools list, OBS install steps, tier table.

Components:
- `src/components/dock/registry.ts` — front-end tool registry. Add new tools = one file + one line.
- `src/components/dock/glyphs.tsx` — vector glyphs only (no emoji).
- `src/components/dock/DockView.tsx` — owner control surface with status dots, quick actions, Available tools drawer.
- `src/components/dock/DockSetup.tsx` — wizard component.
- `src/components/dock/tools/*` — 8 launch modules: cam-border, overlay-composer, scene-themer, streamkey-companion, kindle-companion, knowledge-vault, kitchen, tikfinity-bridge.

Pages Functions (HMAC envelope to the worker, owner-only via aq_link cookie):
- `functions/api/admin/dock/_lib.js` — shared HMAC + ownership helpers.
- `functions/api/admin/dock/state/[userId].js`
- `functions/api/admin/dock/toggle/[toolId].js`
- `functions/api/admin/dock/layout.js`
- `functions/api/admin/dock/proxy.js` — allowlisted per-tool action forwarder.
- `functions/api/admin/dock/probe/[toolId].js` — owner-only status read for vault + kitchen.
- `functions/api/admin/dock/url.js` — mints the short-lived OBS dock URL.

## Live URLs after deploy

- Dock: `https://aquilo.gg/dock`
- Setup: `https://aquilo.gg/dock/setup`
- Marketing: `https://aquilo.gg/free-tools/aquilo-dock`
- Worker base: `/api/dock/registry`, `/api/dock/state/:userId`, `/api/dock/toggle/:toolId`, `/api/dock/layout`

## Constraints honored

- No em dashes (grep clean across all new files).
- Vector glyphs only, no emoji assets.
- Aurora theme on every new page (violet `#7c5cff` + teal `#22d3ee` + green `#5bff95` + gold + red).
- Owner-only on every mutating endpoint, both worker side (`requireOwner`) and site side (`requireOwnerSession`).
- v1 ships owner-only; tier-gate hook is already in `dock.js` so flipping to public is a single `requireOwner` -> `resolveAccess` swap.
- TikTok Streamkey dock at `/dock/streamkey/` stays as a permanent standalone product. No redirect, no deprecation. Cross-linked both directions (see `AQUILO-DOCK-MIGRATION.md`).
- Per-tool admin pages stay where they are; the dock is status + quick actions only.

## Verification done

- `grep "—"` clean on every new file.
- `node --check` passes on `dock.js` and every Pages Function.
- Brace balance check passes on every new TSX file.
- Owner enforcement grep'd on every endpoint.

## Verification still to do (manual)

- 400px-wide render in OBS Custom Browser Dock. Open the dock in a 400px iframe locally first.
- D1 table autocreate on first hit. Confirm by hitting `GET /api/dock/state/owner` after deploy and checking the wrangler logs.
- Setup wizard end-to-end with a fresh user record.
