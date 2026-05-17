# Installing Loadout

5 minutes start to finish.

## Prerequisites

- **Streamer.bot 1.0.0 or later** — running on Windows (the DLL targets .NET Framework 4.8 / WPF, which is Windows-only)
- A connected platform (Twitch / YouTube / Kick) inside Streamer.bot — at least one
- Optional but recommended: TikFinity for TikTok gift events; OBS WebSocket enabled for stream-lifecycle events

## 1. Download the kit

From the [latest release](https://download.aquilo.gg/loadout), grab:

- `Loadout.dll`
- `Newtonsoft.Json.dll` (only if your Streamer.bot install doesn't already have it — newer SB versions ship with it; the bootstrap action will tell you if it's missing)
- `loadout-import.sb.txt` — the one-string SB import

## 2. Drop the DLL in place

Create the folder and drop the DLLs:

```
<Streamerbot>/data/Loadout/Loadout.dll
<Streamerbot>/data/Loadout/Newtonsoft.Json.dll        (only if the boot action complains)
```

If you skip this step entirely, the bootstrap action will download `Loadout.dll` for you on first run from the GitHub release matching its hardcoded version. Doing it manually is just faster.

## 3. Import the bundle into Streamer.bot

1. Open Streamer.bot.
2. Click **Import** in the top-right toolbar.
3. Open `loadout-import.sb.txt` in a text editor and copy the entire contents.
4. Paste into the import dialog. You should see 9 actions previewed under the `Loadout` group.
5. Click **Import**.

That's it for the SB side. **No References-tab editing, no per-event action wiring, no manual trigger setup** — every action loads `Loadout.dll` via reflection at runtime.

## 4. First run

Either restart Streamer.bot, or right-click the `Loadout: Boot` action in the actions panel and choose **Run Now**.

On first boot:

- The tray icon appears in the Windows system tray (look for the blue / cyan "L" badge)
- The onboarding wizard opens automatically
- The Aquilo Bus starts on `127.0.0.1:7470`
- A shared secret is created at `%APPDATA%\Aquilo\bus-secret.txt`

## 5. Walk the wizard

8 steps, about 3 minutes. Most can be skipped and revisited later — re-open the wizard any time from the tray icon → **Open Loadout Onboarding**.

| Step | What you set |
|---|---|
| **Welcome** | Read-only intro + a preview of what the wizard covers |
| **Platforms** | Tick which platforms you stream on (Twitch / TikTok / YouTube / Kick) and your broadcaster name |
| **Modules** | Pick which features start enabled. Default: everything OFF. Use **Essentials**, **Recommended**, or **Everything** presets if you don't want to think about it |
| **Discord** | (optional) Webhook URL for go-live posts and stream recap. Set later in Settings → Discord |
| **Webhook inbox** | (optional) Port + shared secret for external services like Ko-fi / Streamlabs tips |
| **Your links** | (optional) Socials + gamer tags — populate `!socials` / `!gamertags` with real brand logos |
| **Patreon** | Optional early-access sign-in. Every feature is free for everyone; connecting Patreon gets supporters new features early, plus supporter flair and a boosted Bolts earning rate. Skippable |
| **Done** | Tick *Open Settings now* to dive deeper, or close and start streaming |

## 6. OBS browser sources

**Easiest path: don't hand-write URLs.** Open Settings → **Overlays**. Every overlay card has a ready-to-paste URL with your `bus` + `secret` already baked in — just click **Copy** and paste into an OBS browser source. Each card also shows the recommended source size and a **Send test** button so you can place it without going live.

The overlays are served from `https://widget.aquilo.gg/overlays/<name>/`. The bus URL is the full path `ws://127.0.0.1:7470/aquilo/bus/`. A finished URL looks like:

```
https://widget.aquilo.gg/overlays/bolts/?bus=ws://127.0.0.1:7470/aquilo/bus/&secret=YOUR_SECRET
```

Your secret is in `%APPDATA%\Aquilo\bus-secret.txt` — copy the whole line (the Settings cards do this for you).

**One source for everything:** the **All-in-one** card builds a single composite URL that renders every overlay you enable, each in its own non-overlapping zone — position + scale set per layer right in the Settings grid. Drop that one URL into a single 1920×1080 browser source instead of managing a dozen.

**Vertical streams:** the **Vertical** overlay (tile / banner / side modes) and the compact overlay's bare mode are built for 9:16 canvases — see those cards in Settings → Overlays.

Recommended OBS browser source defaults: transparent background, "Shutdown source when not visible" OFF (keeps the WebSocket alive). Each Settings card lists the exact width × height to use.

## 7. Day-2 commands

| Command | Who | What |
|---|---|---|
| `!loadout` | anyone | Version + hint |
| `!loadout help` | anyone | Command list |
| `!loadout settings` | mod | Opens the Settings window on the streamer's screen |
| `!loadout reload` | mod | Re-reads `settings.json` without restarting SB |
| `!loadout quiet` | mod | Toggles Quiet Mode (silences ambient chat from Loadout — overlays still update) |
| `!link <platform> <user>` | anyone | Cross-platform identity link request |
| `!linkapprove <id>` | mod | Approve a pending link |

Plus every module's own commands once enabled.

## 8. Updates

Loadout checks GitHub every 6 hours. New versions surface as a tray notification. Click **Update** in the tray menu to open the release page.

To update manually:

1. Download the new `Loadout.dll` from the release page.
2. Replace `<Streamerbot>/data/Loadout/Loadout.dll`.
3. Right-click `Loadout: Boot` → Run Now (or restart SB).

Beta channel: Settings → General → Update channel = beta. Pulls pre-release tags.

---

## Troubleshooting

**No tray icon after boot.** Right-click the SB taskbar entry, look at the action history for `Loadout: Boot`. Check `<Streamerbot>/data/Loadout/loadout-errors.log`.

**Module is on but nothing happens.** Confirm the underlying SB trigger is firing — Settings → Tools → Test Action. If the trigger fires but Loadout doesn't react, check the error log: `<Streamerbot>/data/Loadout/loadout-errors.log`. Module exceptions land there with a timestamp.

**Overlay shows "bus: connecting…"** Make sure the secret in your URL matches `%APPDATA%\Aquilo\bus-secret.txt` exactly. Spaces / line breaks at the end of the file are a common cause.

**Discord webhook fails silently.** Check the error log. The most common issue is Discord rate-limited the webhook — wait 10 minutes and try again.

**Patreon sign-in opens browser then nothing.** The OAuth callback hits `127.0.0.1:17823–17825`. If your firewall blocks loopback ports, the callback can't reach Loadout. Re-check your security software.

**Settings UI says "0 modules enabled".** That's the default. Open the onboarding wizard from the tray icon and tick what you want.

**`!command` doesn't respond.** Free-tier info commands have a 30-second per-command global cooldown. Mods bypass. Wait 30 s and retry. To shorten: Settings → Chat noise → InfoCommandCooldownSec.

**Bolts didn't credit.** Check earn rate isn't 0 in `BoltsConfig`. Anti-AFK caps chat earns at 3/min per viewer (so spammers don't farm).

---

## Uninstall

1. Streamer.bot → select all 9 `Loadout` actions → right-click → Delete.
2. Delete `<Streamerbot>/data/Loadout/`.
3. (optional) Delete `%APPDATA%\Loadout\` and `%APPDATA%\Aquilo\` for a clean wipe.

Loadout never installs anything outside those folders.
