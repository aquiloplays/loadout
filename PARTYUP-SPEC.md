# PartyUp, the community night queue

A full Aquilo product: the queue system for streamers who play with viewers.
Viewers join from chat on Twitch, YouTube, Kick and TikTok; the streamer picks
parties with fair selection modes, ready checks weed out AFKs, gamertags get
collected and copied in one click, and viewers can watch their spot live on a
public web page instead of spamming "am I next?".

Live surfaces:

| Surface     | URL                                  | What it is                                   |
| ----------- | ------------------------------------ | -------------------------------------------- |
| Landing     | `aquilo.gg/partyup/`                 | Product page with live demo hero             |
| Overlay     | `aquilo.gg/partyup/overlay/`         | OBS browser source, the queue engine itself  |
| Customizer  | `aquilo.gg/partyup/customize/`       | Schema-driven controls + live preview        |
| Dock        | `aquilo.gg/partyup/dock/`            | OBS custom browser dock, full queue control  |
| Live page   | `aquilo.gg/partyup/live/?r=<room>`   | Public read-only queue for viewers           |

## Architecture

ScratchDrop/PowerDeck twin: static pages + the overlay connecting DIRECTLY to
the two local apps a streamer already runs. No accounts, no install.

- `pu-connect.js`: Streamer.bot WebSocket (ws://127.0.0.1:8080, Hello/Auth/
  Subscribe) for Twitch + YouTube + Kick chat, channel point redemptions,
  bits, super chats; TikFinity WebSocket (ws://localhost:21213) for TikTok
  chat + gifts. Fork of pd-connect.js; power-up frames fold into `bits`.
- `pu-engine.js`: pure queue logic, RNG injected, no DOM. Drives the overlay,
  the customizer preview and the selftest.
- Overlay = the engine host (like Tank Battle). State persists in
  localStorage (18h TTL) so an OBS crash never loses the queue. A Web Worker
  tick keeps ready-check countdowns and polling alive in hidden tabs.
- Worker module `discord-bot/partyup.js` (route `/api/partyup/`, KV prefix
  `pu:` on LOADOUT_BOLTS) exists ONLY for the two cross-device features:
  the viewer live page and remote dock control. A running stream never
  depends on it: no room configured = fully local product.

### Room sync (capability model)

The customizer generates `room.id` (10 base36) + `room.key` (24 hex). First
snapshot POST claims the room and stores only the SHA-256 of the key
(sfdock/PowerDeck trust shape). Overlay pushes sanitized snapshots
(debounced 1.2s, min gap 2.5s, heartbeat 25s) and polls dock commands every
2.5s. The live page reads the public subset by room id alone; the key never
appears in the viewer link.

### Dock command bus

Two paths at once, PowerDeck-style: localStorage `pu-cmd-v1` (works inside
OBS, dock + source share one profile) and the worker command queue when a
room is configured (works from a phone). Commands carry `seq`; the overlay
dedupes.

## Queue mechanics

- Join methods: chat command (`!join [gamertag]`), channel point reward
  (title match, input text becomes the gamertag), and priority boosts from a
  priority reward, bits >= threshold, TikTok gift coins >= threshold, or
  super chats. All thresholds default off; free chat joins default on.
- Selection modes:
  - `fifo`: strict join order; boosted viewers form a front lane (toggle).
  - `raffle`: weighted random; subs get `subTickets` extra tickets, boosts
    get `priorityTickets`.
  - `fair`: raffle weights divided by (1 + games played tonight), so new
    players win seats over repeat players.
- Ready check: picked viewers must type `!here` within `readySecs`.
  Misses go to the back / get dropped / hold their spot (configurable) and
  auto-fill pulls the next candidates.
- Per-night memory: games played per viewer, one-game-per-night cap,
  rejoin cooldown, auto-requeue after a game (rotation nights).
- Mod grammar (`!q ...`): open, close, next/pick [n], start, reroll,
  size N, mode fifo|raffle|fair, skip <name>, punt <name>, ban/unban <name>,
  add <name> [tag], clear, resetnight.
- Replies (Twitch via `TwitchSendMessage` with `SendMessage` fallback,
  best-effort for YT/Kick): position confirmations, pick announcements,
  ready locks; globally throttled, templates editable, off switch.

## Overlay presentation

Side layout (vertical card stack) or `bar` lower-third. Header with title +
OPEN/CLOSED pill + count, NOW PLAYING strip with ready countdown rings
(conic-gradient on the entry deadline), numbered queue list with platform
icons + sub/priority badges + optional gamertag chips, join-hint footer.
Pick = draft moment: slots cycle queue names then lock in, confetti burst.
Slide-away parks the whole stage off screen when the queue is closed and
idle (`slide=down|left|right`, `idleSecs`). `?demo=1` runs a scripted loop
(used by the landing hero and customizer preview). `?bg=1` adds a backdrop
for browser viewing. `test-listener.js` wired for "Send test to OBS"
(slug `partyup`, vignette never touches real state).

## Config

`PUEngine.DEFAULTS` is the schema; customizer renders from it, URL carries
base64url JSON of the diff (`?cfg=`), localStorage `pu-cfg-v1` is the shared
copy (profile suffix `?profile=` like PowerDeck). Connection params stay as
plain query params (`sbHost/sbPort/sbPass/tf/tfPort`).

## Worker API

```
POST /api/partyup/snapshot  { room, key, state }   claim-or-verify, store public subset
GET  /api/partyup/room?room=                        public sanitized state (live page, dock fallback)
POST /api/partyup/cmd       { room, key, cmd }      push dock command (kind whitelist, cap 30)
GET  /api/partyup/cmds?room=&key=&after=            overlay polls (key-gated)
```

KV: `pu:room:<id>` (keyHash + public state, TTL 7d refresh), `pu:cmd:<id>`
(TTL 300s), `pu:rl:<ip>:<op>` rate markers.

## Selftest

`aquilo-site/scripts/pu-selftest.mjs` (`npm run pu-selftest`): worker module
in-process with mocked KV (claim, wrong-key 403, sanitize caps, command
cursor) + headless Chrome over the static pages (boot globals, engine
invariants: dedupe, fifo order, priority lane, raffle/fair weight bands,
ready timeout + autofill + consequences, ban/punt/clear/night reset,
serialize round trip, chat grammar incl. mod commands, reward/bits/gift
classification, cfg round trip, customizer + dock + live + landing boot).

## Ship checklist

1. Loadout: `discord-bot/partyup.js` (owned) + `worker.js` mount (anchored
   head_edited) + this spec, via `_commit_mine.py`.
2. aquilo-site: `public/partyup/**` + `scripts/pu-selftest.mjs` (owned);
   `src/lib/products.ts`, `src/components/ProductCard.tsx`,
   `public/support/products.json`, `package.json` (head_edited anchors).
3. Deploy worker: clean worktree, `npm ci` in discord-bot, `wrangler deploy`.
4. Deploy site: clean worktree, `npm ci`, `npm run build`,
   `npx wrangler pages deploy out --project-name aquilo-site --branch master`.
5. Verify: all five URLs 200, worker e2e via curl (never python-urllib),
   selftest ALL PASS.
