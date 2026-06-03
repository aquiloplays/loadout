# follow-repo, TikTok Follow Overlay (R.E.P.O.)

R.E.P.O. (chaotic physics co-op, valuables extraction) theme, built on the shared
Fallout-4 follow-overlay engine. Engine logic (follow pipeline, idle loop, 6-phase
celebration contract, TikFinity WS, screenshot helpers) is identical to FO4; only the
theme layer changed.

## Theme
- **Bar:** text-only. Industrial hazard-orange (`#f5a623`) border + amber glow, hazard-strobe pulse. Font **Oswald** (condensed bold), uppercase amber signage.
- **Palette:** hazard orange `#f5a623`, brushed dark-metal greys/blacks, warm amber highlights.
- **Background / particles:** dark warehouse gradient; ambient drifting dust (default), `?particles=sparks` for rising amber embers, `?particles=none` to disable.

## Sprites (canvas-drawn, PEEK_SPRITES)
`robot` (R.E.P.O. droid, glass dome, twin camera-lens eyes, extendable grabber arms),
`vase`, `lamp`, `bust`, `clock` (the four extractable valuables),
`hidden` (shimmer/refraction outline + eye glints), `shadowchild` (small dark silhouette),
`banger` (round bomb-head with lit fuse + spark).

## Celebration (6 phases)
popIn → idle (robot rises holding a random valuable) → **charge** (straining grab-shake +
"⚠ EXTRACTING... ⚠") → **boom** (valuable SHATTERS, flash, shockwave ring, ceramic-shard
burst, screen shake) → **smoke** (gold coins/cash rise & rain, ceramic shards settle, cash
count-up "$" cha-ching; banner **EXTRACTION COMPLETE**, or **MISSION FAILED** in red ~18% of runs)
→ fade.

## Counter sign
Extraction terminal: header `R.E.P.O. EXTRACTION`, body `VALUABLES: <total>` / `LAST: @name`.
Brushed-metal amber panel with corner rivets; tracks `state.totalFollowers` + cycles recent names.

## URL params
- `?demo=1`, show demo control panel (H toggles)
- `?cycle=off`, don't cycle recent names on the sign
- `?particles=dust|sparks|none`, ambient layer (default `dust`)
- `?fire=1[&user=Name]`, auto-trigger a live follow after load
- `?freeze=popin|idle|charge|boom|smoke|fade`, render one static celebration frame
- `?signshot=N[&user=Name]`, static render of the extraction terminal sign
- `?shot=mobs`, contact sheet of all 8 sprites

## Source
TikFinity WebSocket `ws://localhost:21213/` (follow events). CTA locked: `Follow = Random Game Effect`.
