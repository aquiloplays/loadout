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
import shortcut
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
    """app exposes: login(), check_update(manual), quit(), notify(title, body)."""

    def _toggle_autostart(icon, item):
        if autostart.is_enabled():
            autostart.disable()
        else:
            autostart.enable()

    def _install_shortcut(icon, item):
        """Drop a Desktop + Start-menu .lnk for the companion so the user
        can right-click -> Pin to taskbar. The actual pin step has to be
        manual on Win 11; we pop Explorer with the new file selected so
        the menu is one right-click away.
        """
        result = shortcut.install()
        title = "Shortcut installed" if result["ok"] else "Couldn't install shortcut"
        if result["ok"]:
            body = (
                "Desktop + Start-menu shortcuts created.\n"
                "Right-click 'Aquilo TikTok Key' on the Desktop -> Pin to taskbar."
            )
        else:
            body = "; ".join(result["errors"]) or "Unknown error - check the log."
        # icon.notify is a Windows balloon; falls through silently if
        # the host doesn't support balloons.
        try:
            icon.notify(body, title)
        except Exception:
            pass
        # Best-effort console / log message too so headless / no-balloon
        # users still see the outcome.
        try:
            app.notify(title, body)
        except (AttributeError, Exception):
            pass

    def _refresh_categories(icon, item):
        """Force a TikTok category sweep so the dock autocomplete is current.
        The background refresher does this daily; this is the on-demand path."""
        try:
            app.refresh_categories()
            try:
                icon.notify("Refreshing TikTok categories in the background.", "Categories")
            except Exception:
                pass
        except Exception:
            pass

    def _push_to_aitum(icon, item):
        """Re-push the active TikTok credentials into Aitum's config (handy
        if the auto-push at Go Live missed or you opened OBS afterward)."""
        try:
            r = app.controller.push_to_aitum()
            if r.get("writeOk"):
                msg = f"Updated {r.get('outputs', 0)} output(s) in Aitum config."
            else:
                msg = r.get("reason") or "Nothing to push (no active credentials?)"
            try:
                icon.notify(msg, "Aitum push")
            except Exception:
                pass
        except Exception:
            pass

    menu = pystray.Menu(
        pystray.MenuItem("aquilo.gg TikTok Key Generator " + __version__, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Sign in to Streamlabs", lambda icon, item: app.login()),
        pystray.MenuItem("Open dock", lambda icon, item: webbrowser.open(DOCK_URL)),
        pystray.MenuItem("Check for updates", lambda icon, item: app.check_update(manual=True)),
        pystray.MenuItem("Refresh TikTok categories", _refresh_categories),
        pystray.MenuItem("Push key to Aitum now", _push_to_aitum),
        pystray.MenuItem("Downloads / releases", lambda icon, item: webbrowser.open(RELEASES_URL)),
        pystray.MenuItem("Install desktop / taskbar shortcut", _install_shortcut),
        pystray.MenuItem("Start with Windows", _toggle_autostart,
                         checked=lambda item: autostart.is_enabled()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", lambda icon, item: app.quit()),
    )
    return pystray.Icon("aquilo-streamkey", _icon_image(), "aquilo.gg TikTok Key Generator", menu)
