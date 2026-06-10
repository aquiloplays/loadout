# Gift Jar overlay

A cross-platform support jar for OBS. Every sub, resub, gift sub, cheer,
member, super chat, tip and TikTok gift drops a token into a glass jar
with real rigid-body physics (Matter.js, vendored, no CDN). Tokens
bounce off the rim, stack, settle, and persist across OBS restarts, so
the jar fills up over the course of a stream.

Five jar shapes, all in the signature vector glass style (smooth
blown-glass outline, layered strokes, accent caustic, breathing
under-glow): `classic` canning jar (default), round `bowl`, faceted
`hex`, round-bottom `potion` flask, and a curved `vase`. Bits drop
as Twitch's official animated cheermote gems, frame-decoded and played
inside the physics canvas. Platform coins carry the official brand
marks (simpleicons at runtime, embedded fallback), and TikTok gifts
fall as their real artwork, both live (TikFinity URLs, with a built-in
catalog fallback) and in demo mode (16 verified popular gifts from
Rose to Universe).

```
https://widget.aquilo.gg/overlays/gift-jar/
```

Try it without any apps running:

```
https://widget.aquilo.gg/overlays/gift-jar/?demo=1
```

## What drops what

| Event                            | Token |
| -------------------------------- | ----- |
| Twitch / YouTube / Kick sub      | platform coin (Tier 2/3 are bigger) |
| Resub                            | platform coin |
| Gift subs / gift bombs           | one gift box per sub, platform colored |
| Bits / cheers                    | Twitch's real animated cheermote gem for the amount tier (gray, purple, green, blue, red), `bitsAnim=0` for static |
| YouTube member                   | green star coin |
| YouTube super chat               | blue $ coin, sized by amount |
| YouTube super sticker            | teal star coin |
| Tips / donations (via SB)        | gold $ coin, sized by amount |
| TikTok gift                      | the actual gift artwork from TikFinity, sized by coin value |
| TikTok sub                       | TikTok coin |
| Follows (opt-in via `events`)    | small heart |

Big moments (10+ gift bombs, 5k+ bits, 1k+ coin TikTok gifts, $20+
super chats, $50+ tips) also float a toast above the jar.

## Connections

The overlay connects directly from the browser source, nothing else to
install or run besides the apps you already use:

- **Streamer.bot** (Twitch / YouTube / Kick): enable the WebSocket
  server under `Servers/Clients > WebSocket Server` (default
  `127.0.0.1:8080`, the overlay default). If you set a password, pass
  `?sbPass=...`.
- **TikFinity** (TikTok): just have the TikFinity desktop app running.
  It exposes its local WebSocket on port 21213. Disable with `?tf=0` if
  you do not stream on TikTok.

A small status pill bottom-left shows what is connected and fades out
once stable. Hide it entirely with `?status=0`.

## OBS setup

1. Add a Browser source, size around `600 x 950` (any size works, the
   jar fits itself to the source).
2. URL: `https://widget.aquilo.gg/overlays/gift-jar/`
3. Done. The jar refills itself with the same tokens after a restart
   (12h memory by default).

To reset the jar mid-stream: right click the source, `Interact`, press
`R`. Or set a fresh `?jar=` name.

## URL params

| Param       | Default   | What it does |
| ----------- | --------- | ------------ |
| `jarStyle`  | classic   | jar shape: `classic`, `bowl`, `hex`, `potion`, `vase`, all vector glass |
| `discord`   | empty     | Discord webhook URL (encoded); enables the stream recap GIF post |
| `recap`     | auto      | force the recap recorder on/off; defaults on when `discord` is set, `recap=1` alone downloads the GIF instead of posting |
| `full`      | recycle   | what happens when the pile reaches the neck: `recycle` (oldest fade), `stop` (keep pile, keep counting), `spill` (overflow the rim), `pop` (jar erupts, jar counter ticks, fresh jar) |
| `bitsAnim`  | 1         | animated cheermote gems for bits; `0` uses the static frame |
| `sbHost`    | 127.0.0.1 | Streamer.bot WebSocket host |
| `sbPort`    | 8080      | Streamer.bot WebSocket port |
| `sbPass`    | empty     | Streamer.bot WebSocket password, if set |
| `tf`        | 1         | TikFinity connection on/off |
| `tfPort`    | 21213     | TikFinity WebSocket port |
| `events`    | subs,resubs,gifts,bits,members,superchats,tips,tiktok | which families drop tokens; add `follows` for follow hearts |
| `maxItems`  | 140       | physics body cap; oldest tokens fade out beyond this |
| `burst`     | 30        | max tokens spawned per single event (counter still counts the real total) |
| `iconScale` | 1         | multiply token sizes |
| `jarScale`  | 1         | shrink/grow the jar inside the source |
| `gravity`   | 1         | drop speed feel |
| `bounce`    | 1         | restitution multiplier, 0 = dead drop, 2 = bouncy |
| `label`     | GIFTS     | etched text on the glass, `label=` for none |
| `counter`   | 1         | running total chip on the jar |
| `status`    | 1         | connection pill bottom-left |
| `persist`   | 1         | refill the jar after a reload |
| `ttlHours`  | 12        | how long the saved jar contents stay valid |
| `jar`       | default   | storage bucket name, use different values for different scenes |
| `demo`      | 0         | fake event firehose for testing/layout |
| `bg`        | 0         | dark backdrop when testing outside OBS |
| `accent`    | 35e0c2    | hex, glow + chip accent (shared theme.js knob) |

## Stream recap GIF

Add `?discord=<your webhook URL>` (URL-encoded) and the overlay records
the night: it snapshots the jar whenever new drops settle (at most one
frame per 30s, thinning automatically on long streams) and when the
stream ends it posts a looping timelapse GIF, running total ticking up,
final-count end card included, straight to that channel. Stream end is
detected from Streamer.bot's Twitch StreamOffline event; you can also
trigger it manually with `G` in OBS Interact. With `recap=1` and no
webhook the GIF downloads locally instead. Frames capture at 240px wide
so a full night stays comfortably under Discord's upload limit.

## Notes

- Gift bombs: Streamer.bot fires both a bomb event and per-recipient
  gift events; the overlay suppresses the singles for 20s per gifter so
  a 50 bomb drops exactly 50 boxes.
- TikTok streaks: only the streak-end event drops, with the full
  repeat count, so combos do not flood the jar mid-streak.
- The physics walls are generated from the same coordinates as the
  drawn glass, so tokens visibly rest against the real jar, and the
  invisible funnel above the mouth guarantees no token is ever lost
  off-screen.
- Performance: bodies sleep once settled, tokens are pre-rendered
  offscreen, and the body count is capped, safe to leave running all
  stream.
