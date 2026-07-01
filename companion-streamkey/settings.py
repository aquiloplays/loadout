"""Persistent companion settings: things the user configures once and that
outlast a restart. Currently small (Discord webhook + TikTok profile URL),
deliberately a separate file from `presets.json` so the schemas don't have
to grow together.

  %APPDATA%/AquiloStreamkey/settings.json
    {
      "discordWebhookUrl": "https://discord.com/api/webhooks/...",
      "tiktokLiveUrl": "https://tiktok.com/@aquilogg/live",
      "discordPings": true
    }

Reading is cheap (one file read); the in-memory cache is just a courtesy
for hot paths. Writes are atomic via tmp + rename, same pattern as the
other persistent stores in this companion.
"""
import json
import os
import threading

from logsetup import log

_LOCK = threading.Lock()

DEFAULTS = {
    "discordWebhookUrl": "",
    "tiktokLiveUrl": "",
    "discordPings": True,
    # Aitum auto-push: writes the new key to aitum.json + does the OBS
    # profile bounce + auto-starts Aitum's output on every Go Live. Off
    # by default because the profile bounce was visually disruptive and
    # interfered with normal OBS use during testing. Users who want
    # one-click streaming can opt in from the dock; everyone else gets
    # the old workflow (Go Live returns key, user manually pastes into
    # Aitum). The tray menu "Push key to Aitum now" still works as a
    # manual one-shot regardless of this setting.
    "aitumAutoPush": False,
}


def _path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, "AquiloStreamkey")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.expanduser("~")
    return os.path.join(d, "settings.json")


def load():
    """Return the current settings dict, merged on top of DEFAULTS so new
    fields added later don't crash older config files."""
    out = dict(DEFAULTS)
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k, v in data.items():
                if k in DEFAULTS:
                    out[k] = v
    except (OSError, ValueError):
        pass
    return out


def update(patch):
    """Merge `patch` (dict) into current settings, persist, return new state."""
    if not isinstance(patch, dict):
        return {"ok": False, "reason": "patch must be an object"}
    with _LOCK:
        cur = load()
        for k, v in patch.items():
            if k in DEFAULTS:
                cur[k] = v
        path = _path()
        tmp = path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(cur, f, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError as e:
            log(f"settings: save failed: {e}", "warning")
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return {"ok": False, "reason": f"write failed: {e}"}
    return {"ok": True, "settings": cur}
