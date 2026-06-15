# Stream tuning playbook

Diagnosis from your June 10 stream log: 25.7% rendering lag on the horizontal canvas, 30.4% on the TikTok vertical canvas. The encoder never overloaded. The GPU could not composite the scene fast enough at 60fps for both canvases simultaneously.

Hardware: Ryzen 5 7600, RTX 4060 8GB, 48GB RAM, OBS 32.1.2. Fine for 1080p60. The render pipeline is overloaded, not the encoder.

## Step 1: Run the Windows tuning script

Right-click `stream-tuning.ps1` (in this folder) and pick **Run with PowerShell**. It will:

- Enable Hardware-Accelerated GPU Scheduling (HAGS)
- Disable Windows Game DVR background recording
- Switch to Ultimate Performance power plan
- Add Defender exclusions for OBS and your Videos folder

REBOOT after the script finishes. HAGS only activates on reboot.

## Step 2: Aitum dual canvas hygiene (biggest single win)

You are running TWO output canvases live: horizontal 1920x1080 AND TikTok vertical 1080x1920. Each has its own scene render and encoder pipeline. That doubles GPU compositing load even when one canvas isn't connected to a destination.

If you are only streaming to Twitch this session, **disable the TikTok vertical canvas output** in Aitum Stream Suite. If you stream to both Twitch + TikTok, keep both, but realize this is a major load.

In OBS: dock `AitumStreamSuiteOutput` panel, look for the TikTok Vertical canvas, toggle its output off when not in use.

## Step 3: Browser source tuning

You have 9+ browser sources active concurrently (Chat, FO4 BPM, Gift Jar, Horizontal Starting, Printerbot, Punch Card, Rotation, Tangia, scumbag sub goal). Each is a full Chromium instance.

For every browser source:

1. Right-click source > Properties
2. Set **FPS** to **30** (none of them need 60fps)
3. Set **Custom CSS** to keep
4. Check **Shutdown source when not visible** (huge win for sources only used in specific scenes)
5. Check **Refresh browser when scene becomes active**

Rotation (your song widget) is the heaviest because it does YouTube video decode. Keep that at 30fps and shutdown-when-not-visible if it's only on certain scenes.

## Step 4: Replace Composite Blur filter

Composite Blur is one of the most expensive filter plugins for what it does. On the Blurred Game source on your vertical canvas:

Option A: Right-click source > Filters > delete Composite Blur > Add > Blur (built-in). Built-in Blur is much lighter.

Option B (best perf): pre-render the blurred game capture as a static PNG/looped video and use it as the background. Zero GPU cost.

## Step 5: NVIDIA Control Panel

Open NVIDIA Control Panel > Manage 3D settings > Program Settings tab > Add > obs64.exe. Set:

- Power management mode: **Prefer maximum performance**
- Low Latency Mode: **On** (NOT Ultra, ultra hurts NVENC)
- Threaded optimization: **On**
- Shader Cache Size: **Unlimited**

Then go to NVIDIA App > System > Display > Enable **G-Sync Compatible** on the DELL S3222DGM monitor (you already have 165Hz refresh which is great).

## Step 6: OBS encoder verification

Settings > Output > Output Mode: Advanced > Streaming tab:

- Encoder: **NVIDIA NVENC HEVC** (better quality at the same bitrate than H.264; Twitch Enhanced Broadcasting supports it). Or NVENC H.264 if HEVC gives compatibility issues.
- Rate Control: **CBR**
- Bitrate: **8000 Kbps** (Twitch Partner/affiliate 1080p60 max). If non-partner, 6000.
- Keyframe interval: **2** seconds
- Preset: **P5: Slower (Better quality)**
- Tuning: **High Quality**
- Multipass Mode: **Two Passes (Quarter Resolution)**
- Profile: **high**
- Look-ahead: **OFF** (incompatible with HAGS for low-latency encoding)
- Psycho Visual Tuning: **ON**
- GPU: 0
- Max B-frames: **2**

Audio tab:

- Track 1 Audio Encoder: **AAC**
- Bitrate: **160** Kbps (you have this already)

## Step 7: OBS preview when streaming

When live, right-click the preview window > **Disable preview** (or hide via View menu). The preview is rendered separately from the stream output and costs real GPU cycles. You can still see what's going out via the multiview window (View > Multiview).

## Step 8: DroidCam over USB

DroidCam over Wi-Fi introduces network hitches that show up as render stalls. Switch to USB tethering for the same source.

If you have an actual webcam (logging shows DroidCam is your only cam input), USB is the move regardless.

## Step 9: Verify

After Steps 1 through 8, do a 5-minute test stream. Then check the latest OBS log file at:

`C:\Users\bishe\AppData\Roaming\obs-studio\logs\`

Look at the bottom for:

```
Video stopped, number of skipped frames due to encoding lag: X/Y (Z%)
Output 'rtmp ...': Number of lagged frames due to rendering lag/stalls: X/Y (Z%)
```

Target: under 1%. If still high, send me the log path and I will pinpoint what is still bottlenecking.

## Step 10: Game side (this matters a lot)

You usually have OBS + Crowd Control + StreamFusion + the game + Aquilo TikTok Key open at once. Single-PC streaming means the GPU 3D engine is shared between the game and OBS scene compositing. If the game is at 99% GPU, OBS gets the leftovers and you see exactly the rendering lag we are seeing.

For every game you stream:

1. **Cap framerate** in the game settings to **60 or 120** FPS, never uncapped. Your monitor is 165Hz, but uncapped FPS at 200+ fps eats the GPU headroom OBS needs.
   - Fallout 4: edit `Fallout4Prefs.ini`, set `iPresentInterval=1` and cap to 60 (FO4 physics break above 60 anyway).
   - Cyberpunk 2077, Elden Ring, BG3, Witcher 3: in graphics settings, set Max FPS = 120, VSync off, DLSS Quality or Performance to keep frame times stable.
   - Hollow Knight, Hades, Stardew Valley, Balatro, light games: 60 FPS cap is fine.
2. **Borderless windowed fullscreen**, not exclusive fullscreen. Game Capture works fine with borderless and Windows can preempt for OBS frames cleanly. Some games (Fortnite, Apex) crash on alt-tab from exclusive fullscreen mid-stream.
3. **Disable in-game overlays**:
   - Discord: User Settings > Game Overlay > off
   - Steam: Settings > In-Game > "Enable Steam Overlay" off (if not using it)
   - NVIDIA: NVIDIA App > Overlay disabled
   - Xbox Game Bar: Settings > Gaming > Xbox Game Bar > off (the script disables Game DVR but not the bar itself)
4. **G-Sync on the DELL monitor**: NVIDIA Control Panel > Set up G-SYNC. Enable for full screen and windowed mode. Stops frame-time judder.

## Step 11: Other apps running during stream

- **Crowd Control desktop app**: low overhead, leave running. Confirm it is NOT using hardware acceleration in its settings if it has the option.
- **StreamFusion**: Electron app. If the SF chat overlay is also showing in your OBS scene as a browser source pointing to your aquilo.gg overlay route, you are rendering chat twice (once in SF, once in OBS). Pick one. If SF chat is only your local dock, that is fine. If it is also a browser source in OBS, remove the dock and keep the OBS source.
- **Aquilo TikTok Key app**: Python tray app on localhost:7480. Negligible overhead. Leave running.
- **Streamer.bot**: low CPU, leave running.
- **TikFinity** (TikTok chat client): if you only stream to Twitch in a session, close TikFinity. Each WebSocket source and Chromium tab it spawns adds load.
- **Discord (your own client)**: User Settings > Voice & Video > set "Hardware Acceleration" OFF (saves GPU). Or close Discord during streams and use your phone for voice chat.
- **Browsers** (Chrome, Edge, Opera GX, Brave): close all browser windows you do not need during stream. Each tab is GPU compositing work even minimized. Chrome / Edge with hardware acceleration plus a YouTube tab plus a Twitch dashboard can take 10 to 20% GPU.
- **Spotify**: lightweight, fine. Brain.fm same.
- **NVIDIA App / GeForce Experience**: close it after configuring. The background service can spike GPU.

## Step 12: Pre-stream checklist (laminate this)

Before going live, in order:

1. Reboot if it has been more than 24 hours since last reboot (clears GPU memory fragmentation)
2. Close ALL browser windows except the one with your stream dashboard
3. Close TikFinity if Twitch-only stream
4. Close Discord client if you can use phone or another device for voice
5. Open OBS first, let it fully initialize (browser sources cache, NVENC warms up)
6. Open Crowd Control
7. Open StreamFusion
8. Open Aquilo TikTok Key tray
9. Open the game LAST so it claims its NVENC encoder slot before competing
10. In OBS, verify Aitum TikTok Vertical canvas is DISABLED if not streaming to TikTok
11. Right-click OBS preview > Disable Preview
12. Start stream

## What we did NOT change

- Your canvas resolution (1920x1080 is correct)
- Your FPS (60 is correct for game streaming)
- Your bitrate baseline (only changing if you switch encoder)
- Your scene structure
- Your Twitch service config

## Summary of expected impact

| Change                          | Expected lag reduction |
|---------------------------------|------------------------|
| HAGS on + Game DVR off          | 3 to 5%                |
| Defender exclusions + power plan| 1 to 3%                |
| Aitum vertical canvas off       | 10 to 15%              |
| Browser source 30fps + shutdown | 5 to 10%               |
| Composite Blur removed          | 3 to 7%                |
| NVIDIA Control Panel tuning     | 1 to 3%                |
| OBS preview off when live       | 2 to 5%                |
| DroidCam USB                    | variable               |
| Game FPS cap + borderless       | 5 to 15%               |
| Close TikFinity/browsers/Discord| 3 to 8%                |

Combined: should get you from 25-30% lag down to under 2%.
