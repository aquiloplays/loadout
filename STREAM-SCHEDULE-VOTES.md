# Stream Schedule: Community Votes Nights (FINAL, live 2026-06-11)

Clay finalized the weekly layout on 2026-06-11 and it is LIVE across
the site, the worker, and the Discord pinned schedule embed:

| Day | Show |
| --- | --- |
| Sunday | Community Votes Night |
| Monday | Fallout 4 Crowd Control Chaos |
| Tuesday | Community Votes Night |
| Wednesday | Fallout 4 Crowd Control Chaos |
| Thursday | Community Votes Night |
| Friday | Fallout 4 Crowd Control Chaos |
| Saturday | Community Votes Night |

All nights 10:30 PM to 12:30 AM ET.

## The CVN game pool (admin-managed)

Source of truth: `games:v1:<guildId>` in the shared LOADOUT_BOLTS KV,
edited at aquilo.gg/admin (GamesEditor, "Community Votes Night" tab,
Steam search add/remove). On every save the site pings the bot worker
(`POST /admin/aquilo/site-sync/:guildId`, signed with
AQUILO_SITE_WEB_SECRET), which mirrors the community pool into the D1
`games` table (the CN-poll candidate source) and refreshes the pinned
weekly schedule embed. So: add or remove a game on the admin page and
the site schedule, the vote polls, and Discord all follow.

Seeded pool (29): Fallout 4 · R.E.P.O. · Lethal Company · MIMESIS ·
Gamble With Your Friends · RV There Yet? · MECCHA CHAMELEON ·
PUBG: BATTLEGROUNDS · Apex Legends · COD: Warzone · Marbles on Stream ·
Dead by Daylight · Phasmophobia · The Outlast Trials · The Finals ·
Hunt: Showdown 1896 · Overwatch · DayZ · Escape From Tarkov ·
Dune: Awakening · Hitman: World of Assassination · Marathon ·
Far Far West · Arena Breakout: Infinite · Path of Exile 2 ·
Wuthering Waves · Rainbow Six Siege · Where Winds Meet ·
Slay the Spire 2

## How a night gets its game

- The bot's CN poll (aquilo/poll.js, button-vote embeds in the bound
  poll channel) now targets any of Sun/Tue/Thu/Sat (hub "post poll"
  button picks today or the next CVN). 9 candidates are sampled from
  the active pool per poll; this week's earlier winners are excluded
  so nights stay varied. Winners land in `cn_winners[<weekday>]`, per
  night, and the embed + aquilo.gg render each night's own game.
- Sunday's poll post resets last week's winners.
- A one-shot per-date override (`schedule:override:<ISO>`) still wins
  over everything, so Clay can hand-pin any night.
- No winner yet = the night renders "vote in progress" with a pointer
  at the vote channel.

## Posted polls (channel 1508318929855184987)

- 2026-06-11 two-part interest poll (content direction + 46-game
  watch/play interest, `tools/post-schedule-poll.mjs`).
- 2026-06-11 CVN game-interest poll: 29-game pool over 3 multiselect
  native polls, 7 days (`tools/post-cvn-poll.mjs`).

## Held for later (Clay has not greenlit these)

- Watch-vote vs play-vote split with the 3-ready-players threshold
  (Elden Ring: Nightreign 2) from the 2026-06-11 brainstorm. The CVN
  poll above is interest-gauging; per-night votes are the existing CN
  button polls for now.
- vote-hub.js phase windows (CN_OPEN Wed 12 PM to Fri 12 PM etc.)
  still describe the old one-CN-per-week cadence; the hub embed copy
  and the site's /schedule/community vote page lean on those phases.
  Works, but the windows should eventually become per-night.
