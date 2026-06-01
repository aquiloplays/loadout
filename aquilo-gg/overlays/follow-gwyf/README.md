# GWYF Follow Overlay

A **Gamble With Your Friends** TikTok follow overlay. A thin gold-framed casino
bar — **Follow = Random Game Effect** — sits at the bottom-centre of the canvas.
Casino cubes peek up above it on idle, and a TikFinity **follow** triggers a
slot-machine JACKPOT celebration with a coin explosion + a thank-you card.

![idle + jackpot celebration](preview.png)

Built on the canonical Minecraft follow-overlay template — the architecture is
preserved 1:1 (440×260 stage, pulsing bar, above-bar FX canvas, 3D pixel-cube
peek-ups, the 6-phase celebration timeline, screen shake, follower counter,
demo panel, TikFinity WebSocket). Only the **theme tokens** are swapped to a
casino look. The same structure is the foundation for future per-game variants
(Among Us, Lethal Company, Phasmophobia, …).

---

## Quick start (OBS)

1. **Sources → +  → Browser**.
2. **URL**: `https://aquilo.gg/personal-overlays/follow-gwyf/`
   (backup: a local `file:///…/aquilo-gg/overlays/follow-gwyf/index.html` path).
3. **Width `440`, Height `300`** (the stage is 440×260, pinned 20px off the
   bottom — 300px tall gives the pop-ups headroom; larger is fine, it's centred).
4. Tick **Shutdown source when not visible** and **Refresh browser when scene
   becomes active**.
5. Press **H** to hide the demo panel before going live (it's top-right).

Single self-contained `index.html` — CSS + JS + procedurally-drawn sprites are
all inline. No external image files, no folder of resources, works offline.

---

## TikFinity connection

Listens to TikFinity's local WebSocket for TikTok LIVE follow events.

1. Run **[TikFinity Desktop](https://tikfinity.zerody.one/)** connected to your
   TikTok LIVE.
2. It exposes `ws://localhost:21213/` — the overlay connects there by default
   (the demo panel's **WS** chip shows the connection state).
3. Different port? Append `?tikfinity=ws://localhost:PORT/` to the URL.
4. Auto-reconnects every 5s if TikFinity restarts.

A follow arrives as `{ "event":"follow", "data":{ "nickname":…, "uniqueId":…,
"profilePictureUrl":… } }`. The follower's name drives the thank-you card and
the felt poker-table counter; the profile pic shows in the counter + bar slot.

---

## Demo panel (top-right)

| control            | what it does                                        |
|--------------------|-----------------------------------------------------|
| **Trigger 1 Follow** | fire a single follow with the username field       |
| username / batch   | name + batch size for the buttons                   |
| **Trigger Batch**  | fire N follows at once (cycles demo names)           |
| **Auto-Loop**      | auto-fire random follows every 5–9s                  |
| **Hide Panel (H)** | hide the panel (toggle with the **H** key)           |
| **WS** chip        | TikFinity connection status                           |

`?shot=idle` / `?shot=follow` freeze-frame a state for screenshots.

---

## What plays

- **Idle** (every 4–8s): a 3D casino cube — gold **coin**, white **die**, red
  **chip**, **ace** of spades, lucky **seven** — peeks up above the bar (round
  robin), bobs, and lowers back down. A floating *"aquilo.gg • Follow for Random
  Game Effects"* promo rides above the bar.
- **Follow**: a lucky-seven slot symbol pops up → "spins" (charge: flash + swell
  + shake) → **BOOM** — a `JACKPOT!` burst with a coin/chip explosion (gold +
  silver debris, floating **$** sparks, smoke puffs) + screen shake → a
  *"Thanks for the follow, @user!"* card → a felt poker-table counter showing
  total followers + the follower's name & pic. Batches cycle names on the card.

The 6-phase celebration timeline is unchanged from the template: popIn 500 / idle
400 / charge 750 / boom 200 / smoke 850 / fade 300 ms.

---

## Files

Single file — `index.html`. (`preview.png` is just the README image.)

To re-theme for another game, copy this file and swap: `CTA_TEXT`, the bar glow
colours (CSS `#bar` + `barPulse`), the `MOB3D` cube set + `PEEK_MOBS`, the
celebration palette/text in `playJackpotAnim`, the felt counter colours in
`drawFollowerCounter`, and the promo string in `drawPromoText`.
