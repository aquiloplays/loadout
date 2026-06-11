# Stream Schedule: Vote-Based (Design, NOT yet live)

Status, 2026-06-11: rules captured from Clay; the two-part interest
poll has been posted to Discord channel `1508318929855184987`. The
aquilo.gg schedule page and the Discord schedule surfaces are
UNCHANGED on purpose. Do not wire voting into the site schedule or
re-post schedule embeds until Clay gives the go.

## Core rules

- The schedule is decided by community votes going forward.
- Default game when a slot has no winning vote: **Fallout 4 Crowd
  Control Chaos**.
- There are TWO vote types per game:
  - **Watch vote**: anyone can vote that they want to watch it.
  - **Play vote**: an opt-in that says "I will play this WITH Clay."
- A multiplayer game can only be scheduled as a play-along night when
  at least **3 viewers** have play-opted-in. Exception: **Elden Ring:
  Nightreign needs only 2** (3-player co-op).
- Solo/variety games have no play vote at all, watch votes only.

## Multiplayer (play-along eligible) games

Dead by Daylight · Burglin' Gnomes · R.E.P.O. · Lethal Company ·
Gamble With Your Friends · MIMESIS · RV There Yet? · Phasmophobia ·
Fortnite · PUBG · Left 4 Dead 2 · Among Us · Apex Legends ·
ARC Raiders · Minecraft · Elden Ring: Nightreign (needs 2, not 3) ·
Hunt: Showdown 1896 · Far Far West · Sea of Thieves ·
Escape from Tarkov · COD Warzone

## Solo stream options (watch only, no play opt-in)

Baby Steps · Cult of the Lamb · Megabonk · Slay the Spire 2 ·
Supermarket Simulator · Waterpark Simulator · Marbles on Stream ·
Burgie's Cozy Kitchen · Hitman: World of Assassination ·
Dune: Awakening · DayZ · Age of Empires 2 · Paralives · Retro Rewind

(Apex Legends, ARC Raiders, COD Warzone, Minecraft, Hunt: Showdown
1896, Escape from Tarkov, and PUBG also appear on Clay's solo list;
they are listed once above as multiplayer since the play-along offer
exists for them.)

## Poll-only additions (interest gauging, no play-along offer yet)

Baldur's Gate 3 · Stardew Valley · Skyrim · Elden Ring ·
The Witcher 3 · Kingdom Come: Deliverance · Red Dead Redemption 2 ·
Sons of the Forest · Cyberpunk 2077 · Rimworld · Subnautica 2

## The posted poll (2026-06-11)

Posted via `discord-bot/tools/post-schedule-poll.mjs` (worker
`/admin/post-embed` with native poll passthrough):

1. Header message explaining the legend (🎮 play-along eligible,
   📺 watch only) and the Fallout 4 CC Chaos default.
2. Poll, single-select, 7 days: "What kind of content do you want to
   see on stream?" with options
   - Fallout 4 Crowd Control Chaos & Community Nights Only
   - CC Play Throughs, Variety Chaos, & Community Nights
     (CC spelled out in the header; Discord caps answers at 55 chars)
   - Crowd Control Chaos, Community Nights, & Variety
3. Five polls, multiselect, 7 days: "What games from this are you
   interested in watching and/or playing with me? (Part N of 5)",
   46 deduped games total, tagged 🎮/📺.

## Still to build (when Clay says go)

- Watch/play vote capture as a persistent system (poll results seed
  it; likely worker KV + a viewer page or Discord component flow that
  records per-game play opt-ins by user).
- Schedule page on aquilo.gg renders the vote winners + play-along
  rosters; HomeScheduleStrip follows.
- Threshold logic: play-along night requires the 3 (or 2 for
  Nightreign) committed players; otherwise the slot falls back to
  watch-vote winner, then to Fallout 4 Crowd Control Chaos.
