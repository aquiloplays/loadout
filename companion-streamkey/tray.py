"""System-tray icon for the companion (pystray).

The icon is generated at runtime with Pillow (a small aurora mark) so the
build ships no binary asset. Menu: Login / Refresh, Open Dock, Open
Releases, Start with Windows (checkable), Quit.
"""
import webbrowser

import pystray
from PIL import Image, ImageDraw

import autostart
from _version import __version__

DOCK_URL = "https://aquilo.gg/dock/streamkey/"
RELEASES_URL = "https://github.com/aquiloplays/loadout/releases"


def _make_icon(size=64):
    """A simple aurora roundel: violet-to-teal gradient disc with a spark."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Vertical violet -> teal gradient inside a circle.
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
    # A small upward spark in the middle (no emoji, just a polygon).
    s = size
    spark = [(s * 0.50, s * 0.24), (s * 0.60, s * 0.52), (s * 0.50, s * 0.46),
             (s * 0.40, s * 0.52)]
    ImageDraw.Draw(disc).polygon(spark, fill=(10, 11, 18, 230))
    return disc


def build_tray(app):
    """app exposes: login(), open_dock(), check_update(), quit()."""

    def _toggle_autostart(icon, item):
        if autostart.is_enabled():
            autostart.disable()
        else:
            autostart.enable()

    menu = pystray.Menu(
        pystray.MenuItem("Aquilo Streamkey " + __version__, None, enabled=False),
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
    icon = pystray.Icon("aquilo-streamkey", _make_icon(), "Aquilo Streamkey", menu)
    return icon
