# TikTok "Follow = Random Game Effect" banner overlay

A self-contained Browser Source overlay shaped as a **thin full-width horizontal
banner**. It sits between the streamer cam/chat zone and the game capture on a
vertical TikTok canvas. Left: aquilo.gg emblem + wordmark + spinning d20 accent.
Center (dominant): **FOLLOW = RANDOM GAME EFFECT** in aurora gradient. Right: a
rotating aquilo.gg + Clay product callout that fades every ~7s.

## Add it in OBS
1. **Sources → + → Browser Source.**
2. **URL:** point at the file (`file:///.../overlays/tiktok/follow-reward.html`)
   or the hosted path (`https://aquilo.gg/overlays/tiktok/follow-reward.html`).
3. **Width 1080 · Height 120.** Leave "Shutdown source when not visible" off.
4. **Position:** full width at X = 0, and set Y to the gap between your cam/chat
   row and the game capture (≈ Y 740 on a 1080×1920 canvas — nudge to taste).
5. Background is transparent by default; no green-screen / chroma key needed.

## URL flags
- `?compact=1` — hide the rotating callout (hero-only minimal mode).
- `?theme=violet|pink|teal` — per-stream accent tint.
- `?interval=10` — rotation speed in seconds (default 7).

Edit the `CONFIG` block at the top of the `<script>` to change callout copy.
