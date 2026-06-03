# Follow Overlay, Phasmophobia (Ghost Hunt)

Per-game TikTok follow overlay, built on the shared Fallout 4 engine. Theme layer only, pipeline, idle loop, 6-phase celebration contract, demo wiring, TikFinity WS, and all screenshot hooks are unchanged.

**Theme:** ghost-hunting horror. Paranormal purple (`#7c3aed`) border with an erratic failing-power flicker (occasional hard dim-outs). Pale ghostly italic `Special Elite` typewriter text. Deep night-black gloom; EMF accent colors (green→red) on equipment readouts.

**Sprites (PEEK_SPRITES):** all canvas-drawn, no external assets.
- `spiritbox`, handheld radio scanner (antenna, frequency screen, speaker grille)
- `emf`, EMF reader with 5 LED bars (green→red), idle reads ~2
- `ouija`, spirit board with glyph arc, YES/NO, planchette
- `camera`, camcorder with night-vision green lens + REC dot
- `crucifix`, worn wooden cross
- `flashlight`, torch with translucent beam cone
- `wraith`, floating cloaked ghost (translucent), glowing eyes
- `apparition`, faint spectral face/orb (very translucent)

**Celebration (6 phases):** popIn (spirit box rises) → idle (scan hover) → charge (lights flicker hard, EMF spikes 1→5, "EMF LEVEL 5", dread shake) → boom (lights cut to dark, apparition fades in, camera FLASH strobe) → smoke (flashlight strobe sweep, ghost dissolves into rising spirit wisps, "EVIDENCE FOUND") → fade. Particles: rising spirit wisps + EMF sparks + ambient ghost-orbs.

**Counter sign:** investigation journal page, header `INVESTIGATION JOURNAL`, body `GHOSTS IDENTIFIED: <total>`, `LAST: @name`. Aged-paper-on-purple, candlelit flicker, blinking pen cursor.

**CTA (locked, identical across all overlays):** `Follow = Random Game Effect`
**Promo:** `Hunt with us, aquilo.gg • Community Night`

## URL params
- `?demo=1`, show demo control panel (H toggles)
- `?cycle=off`, disable name cycling on the journal sign
- `?particles=wisps|dust|none`, ambient bg layer (default `wisps`)
- `?fire=1[&user=Name]`, auto-trigger a live follow on load
- `?freeze=popin|idle|charge|boom|smoke|fade`, render one static celebration frame
- `?signshot=N[&user=Name]`, static render of the journal sign at total N
- `?shot=mobs`, contact sheet of all 8 sprites
- JS hooks: `window.triggerFollow(user,pic)`, `window.startSpritePeek(name)`, `window.renderContactSheet()`

## Deploy
Identical file lives at:
- `aquilo-site/public/personal-overlays/follow-phasmophobia/index.html` (deployed; push master → auto-deploy)
- `aquilo-gg/overlays/follow-phasmophobia/index.html` (Loadout backup)
