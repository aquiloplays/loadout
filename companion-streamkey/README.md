# Aquilo Streamkey companion

A tiny Windows tray app that pulls your TikTok LIVE RTMP URL + stream key
from Streamlabs and serves them to the Aquilo OBS dock, so you can paste them
into Aitum Multistream. It also drives stream details (title, category,
mature toggle) and go-live / end-stream, all from the dock.

It pairs with the dock at https://aquilo.gg/dock/streamkey/.

## Requirements

- Windows.
- A Streamlabs account signed in with your TikTok account, with TikTok LIVE
  access granted (the same account the reference Python tool uses).
- Streamlabs Desktop does NOT need to be running. You sign in once through
  the companion (a browser window), and the token is cached locally.

## Install (most people)

1. Download `AquiloStreamkey.exe` from the latest release:
   https://github.com/aquiloplays/loadout/releases
   (look for a `companion-streamkey-v...` release).
2. Run it. It lives in the system tray (no window). On first run it enables
   start-with-Windows so it is ready whenever OBS opens (toggle it off from
   the tray menu if you prefer).
3. The first time you go live or pull categories, a browser opens for a
   one-time Streamlabs sign-in. After that the token is cached.
4. In OBS: Docks, Custom Browser Docks, Add, name it "Streamlabs
   Multistream", paste `https://aquilo.gg/dock/streamkey/`, Apply.

## Use

1. The dock shows a green "Connected" dot when the companion is running.
2. Set your Title, search and pick a Game category, set the Mature toggle if
   needed, and Save details (optional, details are also applied on go-live).
3. Click "Go live and generate key". This creates your TikTok live session
   on Streamlabs and returns the RTMP URL + stream key.
4. Copy the URL and key into your Aitum Multistream TikTok destination. Your
   encoder pushing video is what actually makes the broadcast public.
5. "End stream" ends the TikTok session.

Note: Streamlabs / TikTok have no "fetch the key" call. The URL and key only
exist once the live session is created, so the key appears after Go live.
"Pull stream key" re-reads the active session (useful if you reopened the
dock while already live).

## Local server

The companion serves localhost only, on `http://localhost:7480`, and allows
cross-origin requests from `https://aquilo.gg` (the dock). Endpoints:

- `GET  /healthz`        -> `{ ok, version, authed }`
- `GET  /streamkey`      -> `{ active, url?, key?, refreshedAt?, authed }`
- `GET  /stream/status`  -> `{ live, viewers, title, category, matureContent, authed }`
- `POST /stream/start`   -> `{ ok, url, key, id, refreshedAt }` body `{ title, category, matureContent }`
- `POST /stream/end`     -> `{ ok, ended }`
- `POST /stream/details` -> `{ ok, details }` body `{ title, category, matureContent }`
- `GET  /categories?q=`  -> `{ categories: [{ name, id }], authed }`

## Build from source

```
cd companion-streamkey
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt pyinstaller
python build.py
```

Produces `dist/AquiloStreamkey.exe`. The release workflow does this on a
Windows runner when a `companion-streamkey-v*` tag is pushed, and attaches
the exe to a GitHub Release.

## Security

- Binds 127.0.0.1 only; no LAN exposure.
- CORS is restricted to the aquilo.gg dock origin.
- The Streamlabs token is cached under `%APPDATA%\AquiloStreamkey\` (user
  profile only) and is never printed to logs. The stream key is returned
  only on the explicit `/streamkey` and `/stream/start` responses.

## Auth note

The reference project (github.com/Loukious/StreamLabsTikTokStreamKeyGenerator)
acquires the Streamlabs token through a PKCE browser-login flow rather than
by reading Streamlabs Desktop config files on disk. This companion uses the
same proven browser flow (with a one-time cache), and makes a best-effort
attempt to reuse a locally stored token first. So "Streamlabs Desktop
installed + signed in" is the practical requirement; the token itself comes
from the one-time browser sign-in.
