# Installing Loadout

5 minutes start to finish.

## Prerequisites

- **Streamer.bot 1.0.0 or later** — running on Windows (the DLL targets .NET Framework 4.8 / WPF, which is Windows-only)
- A connected platform (Twitch / YouTube / Kick) inside Streamer.bot — at least one
- Optional but recommended: TikFinity for TikTok gift events; OBS WebSocket enabled for stream-lifecycle events

## 1. Download the kit

From the [latest release](https://github.com/aquiloplays/loadout/releases/latest), grab:

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

8 steps. Most can be skipped and revisited later from Settings.

| Step | What you set |
|---|---|
| **Welcome** | Read-only intro |
| **Platforms** | Tick which platforms you stream on (Twitch / TikTok / YouTube / Kick) and your broadcaster name |
| **Modules** | Pick which modules to enable. Default state: everything OFF. Use the Recommended button if you don't want to think about it |
| **Discord** | (optional) Webhook URL for go-live posts and stream recap. Skippable — set later in Settings → Discord |
| **AI shoutouts** | (optional) Anthropic or OpenAI API key. Without one, raid shoutouts use a template. Skip for now if you want |
| **Webhook inbox** | (optional) Port + shared secret for external services like Ko-fi |
| **Patreon** | Click *Connect Patreon* if you want supporter flair / multipliers. Skippable |
| **Done** | Tick *Open Settings now* to dive deeper, or close and start streaming |

## 6. OBS browser sources

Each overlay is one URL with two query params (`bus` and `secret`). Your secret is in `%APPDATA%\Aquilo\bus-secret.txt` — copy the whole line.

```
Daily Check-In:
https://aquilo.gg/overlays/check-in?bus=ws://127.0.0.1:7470&secret=YOUR_SECRET

Counters:
https://aquilo.gg/overlays/counters?bus=ws://127.0.0.1:7470&secret=YOUR_SECRET&counters=deaths,wins

Goals:
https://aquilo.gg/overlays/goals?bus=ws://127.0.0.1:7470&secret=YOUR_SECRET

Bolts (everything in one overlay):
https://aquilo.gg/overlays/bolts?bus=ws://127.0.0.1:7470&secret=YOUR_SECRET

Apex (top-viewer mode):
https://aquilo.gg/overlays/apex?bus=ws://127.0.0.1:7470&secret=YOUR_SECRET
```

Recommended OBS browser source defaults: 1920×1080, transparent background, "Shutdown source when not visible" OFF (keeps the WebSocket alive).

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

**Bolts didn't credit.** Check earn rate isn't 0 in `BoltsConfig`. Anti-AFK caps chat earns at 6/min per viewer (so spammers don't farm).

---

## Uninstall

1. Streamer.bot → select all 9 `Loadout` actions → right-click → Delete.
2. Delete `<Streamerbot>/data/Loadout/`.
3. (optional) Delete `%APPDATA%\Loadout\` and `%APPDATA%\Aquilo\` for a clean wipe.

Loadout never installs anything outside those folders.
