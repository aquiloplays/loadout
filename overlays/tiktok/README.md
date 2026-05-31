# TikTok "Follow = Reward" middle-canvas overlay

A self-contained Browser Source overlay that sits in the safe middle band of a
vertical TikTok canvas. Hero CTA: **FOLLOW = REWARD** (draw a card / spin for a
random game effect), with a rotating aquilo.gg + Clay product callout strip.

## Add it in OBS
1. **Sources → + → Browser Source.**
2. **URL:** point at the file (`file:///.../overlays/tiktok/follow-reward.html`)
   or the hosted path (`https://aquilo.gg/overlays/tiktok/follow-reward.html`).
3. **Width 600 · Height 800.** Leave "Shutdown source when not visible" off.
4. **Position:** center it on the 1080×1920 canvas (X ≈ 240, Y ≈ 560) — clears
   the top streamer-cam zone and the bottom TikTok chrome.
5. Background is transparent by default; no green-screen / chroma key needed.

## URL flags
- `?compact=1` — hide the rotating ad strip (ultra-minimal hero-only mode).
- `?theme=violet|pink|teal` — per-stream accent tint.
- `?interval=10` — rotation speed in seconds (default 7).

Edit the `CONFIG` block at the top of the `<script>` to change callout copy.
