"""System-tray icon for the companion (pystray).

The tray icon is the aurora key mark (assets/tray-64.png), bundled into the
exe via PyInstaller --add-data and resolved frozen-or-not below. If the asset
is missing for any reason it falls back to a drawn aurora roundel so the tray
always has an icon. Menu: sign in, open dock, update check, releases,
start-with-Windows (checkable), quit.
"""
import os
import sys
import webbrowser

import pystray
from PIL import Image, ImageDraw

import autostart
from _version import __version__

DOCK_URL = "https://aquilo.gg/dock/streamkey/"
RELEASES_URL = "https://github.com/aquiloplays/loadout/releases"


def _asset(name):
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "assets", name)


def _drawn_fallback(size=64):
    """Aurora roundel, used only if the bundled key png is unavailable."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(0x7c + (0x22 - 0x7c) * t)
        g = int(0x5c + (0xd3 - 0x5c) * t)
        b = int(0xff + (0xee - 0xff) * t)
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


def build_tray(app):
    """app exposes: login(), check_update(manual), quit()."""

    def _toggle_autostart(icon, item):
        if autostart.is_enabled():
            autostart.disable()
        else:
            autostart.enable()

    menu = pystray.Menu(
        pystray.MenuItem("aquilo.gg TikTok Key Generator " + __version__, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Sign in to Streamlabs", lambda icon, item: app.login()),
        pystray.MenuItem("Open dock", lambda icon, item: webbrowser.open(DOCK_URL)),
        pystray.MenuItem("Check for updates", lambda icon, item: app.check_update(manual=True)),
        pystray.MenuItem("Downloads / releases", lambda icon, item: webbrowser.open(RELEASES_URL)),
        pystray.MenuItem("Start with Windows", _toggle_autostart,
                         checked=lambda item: autostart.is_enabled()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", lambda icon, item: app.quit()),
    )
    return pystray.Icon("aquilo-streamkey", _icon_image(), "aquilo.gg TikTok Key Generator", menu)
