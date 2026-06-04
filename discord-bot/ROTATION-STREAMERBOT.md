# Rotation, Streamer.bot chat notifications

Rotation posts request feedback into Twitch chat (accepted / cooldown /
failed / now-playing). The worker never talks to Twitch chat directly; it
drops a chat trigger on a relay key and a Streamer.bot action on Clay's PC
polls for it and sends the message. Same pattern as the OBS overlay relay,
just a separate drain so the widget bridge never sees these.

## How it flows

1. A request resolves in `rotation.js` (accepted, on cooldown, rejected) or
   a new track starts playing.
2. The worker writes `relay:rotchat-<uuid>` to KV (60s TTL) with
   `{ type: "chat", notifType, message }`. The `message` is already rendered
   from the template, so Streamer.bot only has to send it.
3. A Streamer.bot action polls:

   ```
   GET https://loadout-discord.aquiloplays.workers.dev/relay/pending?for=rotation-chat
   header: X-Relay-Token: <RELAY_TOKEN>
   ```

   Response: `{ "triggers": [ { "type": "chat", "notifType": "accepted",
   "message": "..." }, ... ] }`. The poll drains + deletes (at-most-once).

4. For each trigger, Streamer.bot runs **Twitch > Send Message** with the
   `message` field.

`RELAY_TOKEN` is already set as a worker secret (the same token the check-in
and rotation pollers use). Do not echo it.

## Streamer.bot setup (one time)

1. **Add a sub-action group** "Rotation chat poll" on a timed trigger
   (every 2 to 3 seconds is fine; the relay holds triggers for 60s).
2. Action steps:
   - **Fetch URL** (HTTP GET) to the `?for=rotation-chat` endpoint above,
     with the `X-Relay-Token` header. Store the response.
   - **JSON parse** the `triggers` array.
   - **Loop** the array; for each item, **Twitch > Send Message to Channel**
     with `%message%`.
   - If you want, gate on `notifType` to route different types to different
     places (e.g. only whisper failures). Not required.
3. That is the whole bridge. Reuse the same Fetch-URL pattern the scratch-off
   relay uses (see SCRATCH-OFF-STREAMERBOT.md); only the `?for=` value and the
   Send-Message step differ.

## Notification types + default copy

All templates use `{placeholders}`. Aquilo voice: dry, short, no exclamation
marks except the now-playing marker.

| notifType  | default template |
|------------|------------------|
| `accepted` | `✓ @{user} added {track} to the queue. eta ~{eta} min.` |
| `cooldown` | `@{user} hold up, {mins} min before your next request.` |
| `failed`   | `@{user} request failed: {reason}.` |
| `playing`  | `▶ now playing: {track}{by}` |

Placeholders: `{user}` requester display name, `{track}` resolved track,
`{eta}` whole-minute queue estimate, `{mins}` cooldown minutes left,
`{reason}` friendly failure reason, `{by}` ` (requested by @name)` when known.

## Overriding the templates + cooldowns

```
POST https://loadout-discord.aquiloplays.workers.dev/admin/rotation/config
header: X-Relay-Token: <RELAY_TOKEN>
body:
{
  "cooldownMs": 300000,
  "tierCooldownMs": { "mod": 60000, "t3": 120000, "t2": 180000 },
  "chatEnabled": true,
  "chatTemplates": {
    "accepted": "✓ @{user} queued {track}, eta ~{eta} min",
    "failed":   "@{user} no dice: {reason}"
  }
}
```

All fields optional, shallow-merged into KV `rot:config`. `GET` the same
route to read the current effective config. Set `"chatEnabled": false` to mute
chat posts without touching Streamer.bot. Cooldowns are clamped to 0 to 60 min.

## Cooldowns

- Channel default: 5 min (`cooldownMs`).
- Per-tier overrides (shortest applicable wins): mods/broadcaster 1 min,
  paid Patreon T3 2 min, T2 3 min. Tier is read from the Twitch viewer role
  (mod/broadcaster) and the `patreon:tier:<userId>` record.
- Bits-paid requests bypass the cooldown entirely; the bits are the skip.
