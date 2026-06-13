# Tank Battle overlay

Worms-style artillery played entirely by chat, on stream. A viewer redeems a
Twitch channel point reward to open the lobby, up to 3 more viewers grab a
seat with `!join`, then tanks paradrop onto randomly generated destructible
terrain and take turns firing:

```
!shoot 45        fire at 45 degrees (0 = right, 90 = straight up, 180 = left)
!shoot 45 80     same shot with power 80 (10-100, default 70)
```

Real projectile physics: gravity, per-turn wind, knockback, fall damage,
pixel-destructible terrain with craters, sudden death after round 8.
Last tank standing wins.

```
https://widget.aquilo.gg/overlays/tanks/
```

Demo (bots play a full match on loop, no apps needed):

```
https://widget.aquilo.gg/overlays/tanks/?demo=1
```

## Setup

1. Add a **Browser Source** in OBS, size **1920 x 1080**, URL above.
2. In **Streamer.bot**: Servers/Clients > WebSocket Server > Start (default
   `127.0.0.1:8080`). That carries Twitch chat, Twitch channel point
   redemptions, and YouTube/Kick chat if those accounts are connected.
3. Create a Twitch **channel point reward** whose title contains the word
   `tank` (e.g. "Tank Battle"), or pass the exact title with
   `?reward=My%20Reward%20Name`. Give it a cooldown roughly the length of a
   match (5-10 min) so redemptions don't pile up while a battle is running.
4. Optional: run **TikFinity** on the same PC and TikTok chat can `!join`
   and `!shoot` too (default `ws://localhost:21213`).

No reward yet? The broadcaster or a mod can open a lobby any time with
`!tank`.

## Commands

| who | command | effect |
| --- | --- | --- |
| viewer | `!join` | take a seat while the lobby is open |
| seated player | `!shoot <angle> [power]` | fire on your turn (`!fire` works too) |
| seated player | `!nuke <angle> [power]` | once-per-match double-radius shell |
| seated player | `!dig <angle> [power]` | once-per-match tunnelling drill (bores terrain, light damage) |
| broadcaster / mod | `!tank` | open a lobby without a redemption |
| broadcaster / mod | `!tank start` | start now with the current seats |
| broadcaster / mod | `!tank end` | abort the current battle |

## Spectator strikes (whole chat plays)

Viewers who aren't seated still shape the battle by spending **bits** (Twitch)
or **gifts** (TikTok diamonds). The amount picks the biggest tier it affords:

| spend (default) | event |
| --- | --- |
| `20+` | **wind shift** — scrambles the wind for the next shot |
| `100+` | **care package** — parachutes a heal onto the lowest-HP tank |
| `300+` | **airstrike** — drops a bomb on whoever's currently leading |
| `1000+` | **barrage** — 4-5 bombs rain across the field |

Neutral **supply crates** also parachute in between rounds: shoot one for a
bigger blast and a +20 heal. All thresholds are tunable (see params).

On victory the overlay fires a Streamer.bot action (`Tanks · Winner` by
default) with the winner name/platform/streak as arguments, so you can wire
bolts, a shoutout, or anything else without touching the overlay. Point
`?discord=` at a webhook for an automatic match-recap embed. The reigning
champion keeps a 👑 crown and win-streak count across matches.

Rules baked in: the redeemer is always P1 and shoots first. If the lobby
countdown ends with nobody else seated, a CPU tank rolls in so the
redemption is never wasted (disable with `cpu=0`). A player who lets their
turn timer lapse twice in a row is eliminated as afk. From round 9 on,
sudden death doubles all damage so matches always end.

## URL params

| param | default | what it does |
| --- | --- | --- |
| `sbHost` / `sbPort` | `127.0.0.1` / `8080` | Streamer.bot WebSocket address |
| `sbPass` | empty | WebSocket auth password, if enabled in SB |
| `tf` | `1` | TikFinity connection (`tf=0` disables) |
| `tfPort` | `21213` | TikFinity WebSocket port |
| `reward` | any title containing `tank` | exact channel point reward title to react to |
| `lobby` | `60` | lobby countdown, seconds |
| `turn` | `45` | per-turn shot clock, seconds |
| `players` | `4` | seats, 2-4 |
| `hp` | `100` | tank health |
| `wind` | `28` | max wind strength, `0` disables wind |
| `cpu` | `1` | fill a lonely lobby with a CPU tank |
| `theme` | `grass` | terrain look: `grass`, `desert`, `snow`, `void`, `lava` (molten floor burns tanks that fall in) |
| `ground` | `74` | mean terrain surface as % of screen height (50-90). Bigger = lower hills = more of your broadcast visible. 74 keeps the action in roughly the bottom quarter |
| `cam` | `1` | shot-follow camera: pushes in on the shooter, tracks the shell, holds on the impact, eases back out. `cam=0` for a fixed full-field view |
| `strikes` | `1` | spectator bits/gifts trigger battlefield events (`strikes=0` disables) |
| `windCost` / `crateCost` / `strikeCost` / `barrageCost` | `20` / `100` / `300` / `1000` | bits-or-diamonds thresholds for each strike tier |
| `crateHeal` | `25` | hp a care package restores |
| `nukes` / `digs` | `1` / `1` | special shots each player gets per match (`0` removes one) |
| `crates` | `1` | neutral supply crates drop between rounds as aiming targets (`crates=0` off) |
| `winAction` | `Tanks · Winner` | Streamer.bot action fired on victory (`winAction=0` disables) |
| `discord` | empty | Discord webhook URL for a match-recap embed |
| `vol` | `55` | sound volume 0-100, `0` mutes |
| `announce` | `0` | post lobby/turn/win prompts into Twitch chat via SB |
| `sky` | off | paint a sky behind the terrain. Defaults on for `demo=1` in a normal browser only, never inside OBS/Streamlabs, so the broadcast underneath always shows through |
| `test` | `0` | anyone may use `!tank` commands, for dry runs |
| `demo` | `0` | endless bot matches, for layout previews |
| `dot` | `1` | connection status pill when Streamer.bot is unreachable |
| `hint` | `1` | "armed and waiting" card while idle. Only ever shows in a normal browser tab, never inside OBS or Streamlabs (detected via user agent), so the overlay stays invisible on stream between battles. `hint=0` hides it everywhere |

Shared theming knobs from `_shared/theme.js` also work: `accent`, `accent2`,
`text`, `font`, `fontScale`, `scale`, `opacity`, `offsetX`, `offsetY`.

## Console test drive

Open the overlay in a normal browser (add `?sky=1&test=1`) and use the
DevTools console:

```js
TB.redeem('Clay')               // open the lobby
TB.chat('ana',  '!join')        // seat 2
TB.chat('bo',   '!join', 'tt')  // seat 3, from TikTok
TB.chat('cy',   '!join', 'yt')  // seat 4
TB.chat('Clay', '!shoot 60 85') // P1 fires
TB.snap()                       // state snapshot
TB.end()                        // force reset
```
