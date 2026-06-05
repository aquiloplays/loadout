# Aquilo Vault, design doc (for review)

Status: DESIGN ONLY. No code. Clay reviews and greenlights before any build.
Direction: Option B, an idle resource sim inspired by Fallout Shelter, but
stream-integrated so the audience IS the vault population.

This is a NEW system at aquilo.gg/vault. It is NOT the archived Vault project
(the FS-Bot RPG / vault.db / Railway parked work). This one is settlement and
stream focused, sidebar-trackable, and built on the existing worker + KV + Bus.

---

## 1. The pitch in one line

The chat is the Vault. While Clay streams, viewers accumulate Caps, vote to
build rooms, become permanent settlers, and weather raider attacks together. It
runs itself between streams and posts a daily report.

---

## 2. Core loop

1. A stream goes live. The Vault wakes up.
2. Caps accrue passively: 1 cap per minute per active viewer (counted off the
   existing presence / activity signal). Caps are the build currency.
3. Chat votes to spend Caps on rooms (`!vault build <room>`). A room needs a
   Caps threshold of votes within a window to break ground.
4. Viewers who watch 30+ minutes become permanent settlers (one-time), auto
   assigned to a room by their behavior.
5. Crises fire on a timer. Chat votes to spend Caps to resolve them.
6. Stream ends. The Vault auto-saves, computes a daily report, and posts it to
   Discord. Caps keep a small idle trickle so the Vault is never fully dead.

The hook: it is a shared, persistent base that visibly grows across many
streams, with the audience as both population and decision-makers.

---

## 3. Currency and economy

- **Caps**: the only currency. Earned passively during streams (1/min/active
  viewer), plus crisis rewards. Spent on rooms and crisis defense.
- Idle trickle off-stream: 1 cap / 10 min, capped, so the Vault ticks but
  streaming is clearly the main engine.
- Caps are a Vault-wide shared pool, NOT per-viewer (this is a communal base,
  distinct from the per-user Bolts wallet). A Workshop room multiplies the
  accrual rate.
- Suggested early numbers (tune live): generator 250, hydroponics 300,
  workshop 600, medbay 400, bar 500, armory 700, living quarters 350, radio
  600. Crises cost 50 to 400 depending on severity.

---

## 4. Rooms

Each room has a Caps cost, a passive effect, and a staffing requirement met by
assigned settlers. Power is the gate: most rooms need the Generator online.

| Room | Effect |
| --- | --- |
| Generator | Powers other rooms. Must be staffed or a Power Failure crisis can cascade. |
| Hydroponics | Food. Sustains population; lurkers are auto-assigned here. |
| Workshop | Caps accrual multiplier (for example +25 percent per level). |
| Medbay | Heals injured settlers after raider attacks; reduces crisis losses. |
| Bar | Entertainment. Attracts more settlers; chatty viewers staff it. |
| Armory | Defense rating; lowers raider-attack failure odds. |
| Living Quarters | Raises the settler population cap. |
| Radio Room | Boosts new-viewer attraction (cosmetic nudge in the sidebar). |

Rooms level up with repeat builds (diminishing returns). A simple adjacency or
power-budget rule keeps choices interesting without being a spreadsheet.

---

## 5. Settlers (the audience)

- A viewer becomes a permanent settler after 30 cumulative minutes watched.
  One-time, sticky across streams. Keyed by the existing aquilo userId.
- Auto-assignment by behavior signal:
  - chatty (high message rate) -> Bar
  - lurker (watches, rarely chats) -> Hydroponics
  - cheerers / gifters -> Armory
  - new followers -> Radio Room
  - moderators -> Generator (keep the lights on)
- Patreon supporters get auto-named cosmetic flair on their settler (a tier
  title, a small accent) and show first in the population list.
- Top settlers (by tenure or contribution) can become named NPCs visible in the
  Vault overlay (see Brotherhood Outpost stretch).

Privacy: settlers are display-name only, opt-out respected (reuse the existing
exclusion list so the owner and opted-out users are not listed).

---

## 6. Crises

Fire on a timer (for example every 25 to 40 min live), weighted by current
Vault state. Chat votes to resolve; failure has a visible but recoverable cost
(injured settlers, lost Caps), never a hard reset.

- **Raider attack**: vote to spend Caps on defense. Armory rating lowers the
  cost and failure odds. Failure injures settlers (Medbay heals them).
- **Radroach swarm**: small Caps cost, quick vote.
- **Vault-Tec inspector**: passes only if certain rooms exist (for example
  Hydroponics + Medbay). A nudge to build broadly, not tall.
- **Power failure**: the Generator must be staffed; if not, rooms go dark until
  resolved. Mods assigned to the Generator resolve it fastest.

Every crisis emits a Bus event so the on-stream sidebar can flash it and the
activity overlay can announce it.

---

## 7. Stream-day cycle

- On go-live: load Vault state from KV, mark the day open.
- During: accrue Caps, accept votes, run crises, register new settlers.
- On end (or the existing stream-end signal): snapshot state to KV, compute a
  daily report, post it to a Discord channel.
- Daily report contents: Caps earned, rooms built, new settlers, crises faced
  and outcomes, current population and Caps, a one-line flavor headline.

State is versioned in KV so a bad day can be rolled back if needed.

---

## 8. Surfaces

- **On-stream sidebar overlay** (`personal-overlays/vault-sidebar/`): a compact
  corner panel showing population, Caps, room count, and the current crisis with
  a vote timer. Aurora-tinted Vault-Tec styling. Consumes Bus events; no polling.
- **Full UI** at `aquilo.gg/vault`: anyone can view the Vault, room grid,
  population, and live crisis. Settlers see their own assignment. Read-only for
  the audience; actions happen through chat.
- **Chat command**: `!vault build <room>`, `!vault status`, `!vault vote <opt>`.
  Routed through the existing Twitch command path; votes tallied in KV with a
  short window and a per-user dedupe.

---

## 9. Data model (sketch)

- `vault:state` (KV JSON): `{ caps, rooms: {room: level}, population, settlers:
  count, crisis: {...} | null, day, updatedUtc }`. Versioned snapshots under
  `vault:snapshot:<ISO>` with a TTL for rollback.
- `vault:settler:<userId>` (KV): `{ joinedUtc, room, minutesWatched, flair }`.
  Or a compact aggregate if per-user keys get heavy.
- Votes: `vault:vote:<topic>` short-TTL tally with `vault:voted:<topic>:<userId>`
  dedupe markers.
- Bus events: `vault.caps`, `vault.room.built`, `vault.settler.joined`,
  `vault.crisis.start`, `vault.crisis.resolved` for the overlays + activity feed.

Reuses existing infra: presence/activity for active-viewer counts, the Twitch
command path for `!vault`, KV for state, the Aquilo Bus + activity overlay for
events, and the Discord posting helper for the daily report.

---

## 10. Brotherhood Outpost (stretch, post-v1)

- Viewers level up a personal Vault stat (tenure + contribution) over many
  streams.
- The top settlers become named NPCs rendered in the Vault overlay (small
  standing figures with names), a visible status reward.
- Optional faction flavor (Brotherhood vs Raiders vs Enclave) tied to behavior,
  purely cosmetic.

---

## 11. Suggested build phases

1. State + Caps accrual + the on-stream sidebar overlay (read-only, looks alive).
2. `!vault build` votes + the room grid + 2 crises (raider, radroach).
3. Settler registration + auto-assignment + the aquilo.gg/vault page.
4. Daily report to Discord + the remaining crises.
5. Brotherhood Outpost named-NPC stretch.

Art needed (cheap): a set of CSS or small Replicate room icons and a Vault
interior background for the sidebar + page (budget around 0.50 USD).

---

## 12. Open questions for Clay

- Caps tuning: is 1/min/active-viewer too fast or too slow for your average
  concurrent count?
- Should settlers be truly permanent, or decay after long inactivity?
- Daily report channel: a new `#vault-report` or an existing one?
- Crisis cadence: every stream, or only past a certain uptime?
- Do you want the audience to spend their personal Bolts on the Vault too, or
  keep the communal Caps pool strictly separate (recommended: separate)?
