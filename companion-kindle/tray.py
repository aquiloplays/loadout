"""System-tray icon for the Kindle companion (pystray).

Aurora key+book mark (assets/tray-64.png, bundled via PyInstaller --add-data),
with a drawn aurora-roundel fallback. Menu: sync now, a live last-sync line,
sign in to Amazon, paste the ingest secret, set the daily time, open the vault,
start-with-Windows, quit.
"""
import os
import sys
import time
import webbrowser

import pystray
from PIL import Image, ImageDraw

import autostart
import config
from _version import __version__

VAULT_URL = "https://aquilo.gg/vault/"
RELEASES_URL = "https://github.com/aquiloplays/loadout/releases"


def _asset(name):
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "assets", name)


def _drawn_fallback(size=64):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(0x9a + (0x5b - 0x9a) * t)
        g = int(0x82 + (0xff - 0x82) * t)
        b = int(0xff + (0x95 - 0xff) * t)
        d.line([(0, y), (size, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([2, 2, size - 2, size - 2], fill=255)
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    disc.paste(img, (0, 0), mask)
    return disc


def _icon_image():
    try:
        return Image.open(_asset("tray-64.png")).convert("RGBA")
    except OSError:
        return _drawn_fallback()


def _ago(ms):
    if not ms:
        return "never"
    s = max(0, int(time.time() - ms / 1000))
    if s < 90:
        return f"{s}s ago"
    m = s // 60
    if m < 90:
        return f"{m}m ago"
    h = m // 60
    return f"{h}h ago" if h < 36 else f"{h // 24}d ago"


def _status_line(controller):
    st = controller.status()
    if st["syncing"]:
        return st["progress"] or "Syncing..."
    if st["lastError"]:
        return "Last error: " + st["lastError"][:48]
    return f"Last sync: {_ago(st['lastSyncMs'])} ({st['lastCount']} highlights)"


def build_tray(app):
    controller = app.controller

    def _toggle_autostart(icon, item):
        if autostart.is_enabled():
            autostart.disable()
        else:
            autostart.enable()

    def _open_logs(icon, item):
        try:
            os.startfile(config.config_dir())  # type: ignore[attr-defined]
        except Exception:
            pass

    menu = pystray.Menu(
        pystray.MenuItem("Aquilo Kindle " + __version__, None, enabled=False),
        pystray.MenuItem(lambda item: _status_line(controller), None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Sync now", lambda icon, item: app.sync()),
        pystray.MenuItem("Sign in to Amazon", lambda icon, item: app.login()),
        pystray.MenuItem("Paste ingest secret...", lambda icon, item: app.set_secret_dialog()),
        pystray.MenuItem("Set daily sync time...", lambda icon, item: app.set_hour_dialog()),
        pystray.MenuItem("Open Vault dashboard", lambda icon, item: webbrowser.open(VAULT_URL)),
        pystray.MenuItem("View log folder", _open_logs),
        pystray.MenuItem("Check for updates", lambda icon, item: app.check_update(manual=True)),
        pystray.MenuItem("Start with Windows", _toggle_autostart,
                         checked=lambda item: autostart.is_enabled()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", lambda icon, item: app.quit()),
    )
    return pystray.Icon("aquilo-kindle", _icon_image(), "Aquilo Kindle", menu)
