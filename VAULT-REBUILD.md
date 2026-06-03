# Aquilo's Vault, worker-native community cross-section (rebuild)

**Shipped overnight 2026-06-02.** Built the new *community* Aquilo's Vault, a single shared Fallout-Shelter-style cross-section the whole community
builds and defends together, fully inside the Loadout Cloudflare Worker.
This is **additive**: it does not touch the legacy per-user FS-Bot RPG.

## ⚠ Scope decision (please confirm)

The brief framed this as "rebuild a viewer / drop the Railway bot entirely."
On disk, the reality is different and that changed the plan:

- `../FS Bot/bot.py` is **9,157 lines / ~36 SQLite tables**, a full mature
  RPG (dwellers, items, raids, factions, perks, pets, expeditions, market…)
  with **live player save data** in `vault.db`.
- The brief's data model (`vault_state` / `vault_dweller(userId,assignedRoom,class)`
  / `vault_crisis`, assign/expand/contribute, cross-section viewer) describes a
  **new, simpler community layer**, not that RPG.
- The named env var `AQUILO_VAULT_API_URL` and the file `aquilo_outstanding.md`
  **do not exist** anywhere in the tree (the real legacy vars are
  `VAULT_INGEST_URL` / `VAULT_WEBHOOK_SECRET` / `VAULT_INGEST_SECRET`).

**Decision:** built the new community vault additively; did **NOT** port the
9k-line RPG (infeasible overnight, not in the data model); did **NOT** delete
Railway or `vault.db`. The Railway service + save data are **parked** (already
502ing → nothing working was lost). Final cutover is yours to flip, see below.

## What shipped (all live)

| Layer | What | Where |
|---|---|---|
| D1 | `vault_state` / `vault_dweller` / `vault_crisis` (+indexes) | `discord-bot/vault-community-migration.sql` (applied to `aquilo_bot_db`) |
| Engine | room catalog (16 types, class affinities), seed (9 starter rooms = all 5 class rooms), dweller enlist/assign, resource recompute, expansion, crisis lifecycle, snapshot | `discord-bot/vault-community.js` |
| Public API | `GET /web/vault/state` (CORS-open, lazy-seeds) | `worker.js` |
| Authed API | `POST /web/vault/{assign,expand,contribute-to-crisis}` (HMAC) + owner `/web/vault/start-crisis` | `web.js` |
| Cron | vault tick (expire crises, low-prob spawn, recompute) every 5 min, riding the every-minute trigger (4-cron ceiling) | `worker.js` scheduled() |
| Bus | `vault.dweller.move` / `vault.crisis.start` / `vault.crisis.resolved` / `vault.room.unlocked` via `publishActivity` | `vault-community.js` |
| Art | 35 premium Flux Pro-Ultra assets (terrain, door, 16 rooms, 10 dwellers, 5 crisis FX, HUD) → `pixel-art-vault:<name>`, served at `/asset/vault/<name>.png` | `discord-bot/tools/vault-art-pipeline.py` ($1.74 spend) |
| Discord | Vault Dweller / Overseer / Crisis Responder roles; Vault category + `#vault-status` / `#vault-crises` / `#vault-overseer`; crisis announce embeds + affected-dweller DMs | `discord-bot/vault-discord.js`, setup via `POST /admin/vault/setup/:guildId` |
| Onboarding | "Join the Vault?" step (age18 → **vault** → tour): grants Vault Dweller + enlists dweller auto-stationed by RPG class | `discord-bot/onboarding.js` |
| Site | `/play/vault` Canvas2D cross-section viewer (read-only): rooms+dwellers+HUD+crises, pan/zoom, terminal panel, live via SSE | `aquilo-site/src/components/play/VaultCrossSection.tsx` (legacy preserved as `PlayVaultLegacy.tsx`) |

### Discord ids created (Aquilo guild `1504103035951906883`)
- Roles: Vault Dweller `1511229289444413630`, Vault Overseer `1511229291294363749`, Crisis Responder `1511229293492048012`
- Category Vault `1511229295677276221`; channels `#vault-status` `1511229298038800465`, `#vault-crises` `1511229300135821434`, `#vault-overseer` `1511229302237040691`
- All persisted to `guild:cfg:<guild>.ids` (`role_vault_*`, `cat_vault`, `ch_vault_*`).

## Class → starter room
Warrior → Security Office · Mage → Reactor Lab · Rogue → Stealth Bay · Ranger → Watchtower · Healer → Medical Bay

## Outstanding manual actions (for Clay)

1. **Deploy aquilo-site.** The viewer is committed locally on `master`
   (`38e0afc`) but **NOT pushed**, the repo has the in-flight site-polish
   chip's uncommitted work, and aquilo-site auto-deploys on push. Coordinate
   the push/deploy with that work.
2. **Decide the legacy FS-Bot cutover.** The new community vault is the
   `/play/vault` surface now. The legacy RPG (Railway `bot.py` + `vault.db`)
   is parked. When you're ready to fully decommission it:
   - Stop the Railway service; back up `vault.db`.
   - Remove the legacy bridge from the worker: `VAULT_INGEST_URL`,
     `VAULT_WEBHOOK_SECRET`, `VAULT_INGEST_SECRET` secrets; `/vault/event` +
     `handleVaultPostActions` in `worker.js`; `vault-hub.js`; and the site's
     `functions/api/web/vault/[[route]].js` + `_lib/vault-bridge.js` (or
     repoint them at the new worker routes).
   - These were left in place tonight for reversibility, they no-op cleanly
     when their secrets are unset.
3. **(Optional) Import legacy dwellers** into the new community vault
   (map `vault.db` dwellers → `vault_dweller`, infer class from room).
4. **(Optional) Overseer role automation**, `vault_dweller.contribution_total`
   drives it; wire a small cron to grant Vault Overseer to the top N
   contributors (role exists, assignment not yet automated).

## Rework, 2026-06-02 (Clay's feedback pass)

Shipped on top of the overnight v1. Branding confirmed **"Aquilo's Vault"**
everywhere (the v1 had already used it; only stylistic "Fallout-Shelter-style"
comments remained, now softened).

| Part | What shipped | Where |
|---|---|---|
| Rooms carved into rock | All 16 room cells re-rendered as **front-facing** scenes hewn into the mountain with rough natural-stone apertures that blend into the bedrock (watchtower/reactor-lab look). Opaque full-bleed (no magenta key); the viewer composites a rock-edge vignette so edges fade into the terrain. | `vault-art-pipeline.py` (rooms now `isolate=False`), re-rendered + live in KV |
| Idle scene animations | Per-room-type `ROOM_FX` registry: generator turbine, water bubbles, diner steam, training dummy, medical heart-blip + IV drip, reactor runes, garden grow-light, storage dust, science/radio. Clipped per room; **skipped under `prefers-reduced-motion`**. | `VaultCrossSection.tsx` |
| Animated dwellers | Deterministic walk + class-task state machine, FNV-1a `userId` hash desyncs pacing, mirror-on-turn, walk bob, periodic class task (warrior jab / mage glow / healer blip / ranger aim / rogue flicker). **No per-frame randomness.** | `VaultCrossSection.tsx` |
| Customizable dwellers | New `vault_dweller_customization` D1 table (applied), `get/setDwellerCustomization` (+ server-side validation & premium gate), `snapshot().dwellers[].customization`, HMAC route `POST /web/vault/dweller-customize`, site `/profile/vault-dweller` customizer reusing the Hero paper-doll + an OUTFIT pick. | `vault-community.js`, `web.js`, `vault-dweller-customization-migration.sql`, `aquilo-site` (`vaultDweller.ts`, `VaultDwellerCustomizer.tsx`, `HeroComposite.tsx` `vaultOutfit` prop, Pages proxy) |
| Outfit art | 6 overlays generated (jumpsuit/reinforced/hazmat × M/F) at `/asset/vault/outfit-<slug>-<sex>.png`. | KV |

**Replicate spend:** ~$1.32 this pass (16 rooms force-regen + 6 outfits); $3.06 cumulative on `pixel-art-vault:*`.

**Art-tool caveat (important):** Flux rendered the outfit overlays as **full
figures** (head/face/hands included), not headless floating garments. So the
customizer does **not** composite the outfit over the hero paper-doll (it would
occlude the user's hair/face). Instead the page shows the personalized paper-doll
("Your look") **alongside** the chosen outfit portrait. The `HeroComposite.vaultOutfit`
layer prop is in place (backward-compatible) for when true garment-only overlay art exists.

**Verification:** both repos typecheck clean (site `tsc` 0 errors; worker `node --check` OK);
worker deployed (version `12a3c820`); D1 migration applied; live snapshot emits the
`customization` path; `/play/vault` mounts cleanly in-browser (HUD/terminal/caption, no
errors). Live animated pixels could **not** be captured headlessly, the preview tab is
backgrounded so `requestAnimationFrame` is paused (verified 0 ticks while hidden); the
room art + canvas draw path were verified directly instead.

**Follow-ups (not blocking):**
- Draw the `outfit-<slug>-<sex>.png` layer on the small cross-section dwellers too (viewer currently uses the base class+sex sprite; outfit shows on the profile page).
- Cross-section consumes only `customization.classKey`/`sex`; `skinTone`/`hair`/`eyes`/`facial` are typed but not yet drawn at that scale.
- Pre-existing lint nit at `VaultCrossSection.tsx` (set-state-in-effect on the poll), untouched, out of scope.
- The audio/music subsystem (`BoltboundSpire`/`PlayExpedition`/`TownManager`/`PwaShell`/`AchievementUnlockToast`/`public/audio`/`scripts/audio-*`) is a **separate in-flight chip's** uncommitted work, deliberately left untouched & uncommitted.

## Operating notes
- Re-arm Discord setup: `wrangler kv key put vault-setup-token <hex> --binding LOADOUT_BOLTS --remote`, then `POST /admin/vault/setup/<guild>?token=<hex>` (idempotent).
- Force a crisis (owner): signed `POST /web/vault/start-crisis` `{kind, roomId?, severity?}` (kinds: raiders, fire, radstorm, infestation, power-failure).
- Re-run / extend art: `REPLICATE_API_TOKEN=… python -u discord-bot/tools/vault-art-pipeline.py --commit` (resumable; `--force` to re-art).
