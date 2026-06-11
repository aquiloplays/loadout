# Hangman overlay

A viewer redeems a channel point reward (or types `!hangman`) and goes on
the gallows. Their Twitch profile picture hangs as the head; every wrong
guess draws another body part. Solve the word in time or eat a chat
timeout, fired through Streamer.bot.

- Overlay: `https://widget.aquilo.gg/overlays/hangman/`
- Demo: `https://widget.aquilo.gg/overlays/hangman/?demo=1&bg=1`
- Landing + customizer + Streamer.bot import: `https://aquilo.gg/hangman/`

Recommended OBS browser source size: **900 x 380**.

## How it plays

1. A viewer starts a game with the channel point reward (any reward whose
   title contains "hangman" by default) or the `!hangman` command.
2. Only that viewer can play. They guess by typing single letters in chat
   (`e`), or go for the whole word with `!solve word` (a bare word with
   the right letter count also counts as a solve attempt).
3. Wrong letters and wrong solves cost a life. First miss hangs their
   avatar as the head, then torso, arms, legs.
4. Win: confetti and a chat shoutout. Lose (out of lives or out of time):
   the figure completes and the player gets a 60 second Twitch timeout
   via the `Hangman · Timeout` action.

Mods and the broadcaster cannot be timed out by Twitch; the action posts
a "immune to the gallows" chat note instead.

## Requirements

- Streamer.bot with the WebSocket server on (Servers/Clients > WebSocket
  Server > Start Server, default `127.0.0.1:8080`).
- The Hangman import bundle from `aquilo.gg/hangman/` for timeouts and
  chat announcements (two trigger-less actions invoked over the
  WebSocket: `Hangman · Timeout`, `Hangman · Announce`). The game itself
  runs without them; losses just stop hurting.

## URL parameters

| param | default | what it does |
| --- | --- | --- |
| `sbHost` / `sbPort` / `sbPass` | `127.0.0.1` / `8080` / empty | Streamer.bot WebSocket |
| `reward` | `hangman` | reward title substring that starts a game; `reward=0` disables |
| `cmd` | `!hangman` | chat command that starts a game; `cmd=0` disables |
| `who` | `everyone` | who may use the command: `everyone` `subs` `vips` `mods` |
| `lives` | `6` | wrong guesses allowed (3-6); the figure always completes on the last one |
| `secs` | `120` | time limit per game (20-600) |
| `cd` | `30` | cooldown between games, seconds |
| `to` | `60` | chat timeout on a loss, seconds; `to=0` disables |
| `reason` | `Lost a game of Hangman` | timeout reason shown in mod view |
| `say` | `start,win,lose` | which chat announcements fire; `say=0` silences |
| `cats` | all | built-in categories: `games,stream,animals,food,screen,places,tech,sports` |
| `words` | empty | custom comma-separated words (the customizer builds this) |
| `customOnly` | `0` | only draw from custom words |
| `reveal` | `1` | reveal the word on a loss |
| `sound` / `vol` | `1` / `60` | synth sounds + volume |
| `status` | `1` | connection pill (auto-hides) |
| `actTimeout` / `actSay` | bundle names | override the Streamer.bot action names |
| `key` | `default` | persistence bucket (mid-game state survives OBS reloads) |
| `accent` / `scale` / `bgOpacity` | theme | shared theme bridge knobs |
| `demo` | `0` | fake game loop, never touches Streamer.bot |
| `bg` | `0` | dark backdrop for testing outside OBS |

## OBS Interact keys

- `T` starts a test game (announcements and timeouts stay off)
- `X` cancels the current game

## Files

- `hangman-core.js` pure game rules (no DOM); run `node selftest.mjs`
- `words.js` word bank, 8 categories
- `main.js` Streamer.bot wiring, rendering, sounds, persistence
