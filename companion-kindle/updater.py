"""Update check against the Loadout GitHub releases.

Companion releases are tagged `companion-kindle-v<semver>` on the
aquiloplays/loadout repo. check() returns info about a newer release or None.
download_asset() fetches the .exe to a temp path; apply_update() does a safe
self-replace via a throwaway .bat.
"""
import os
import subprocess
import sys
import tempfile

import requests
from packaging import version

from _version import __version__

REPO = "aquiloplays/loadout"
TAG_PREFIX = "companion-kindle-v"
RELEASES_API = f"https://api.github.com/repos/{REPO}/releases"


def _headers():
    h = {"Accept": "application/vnd.github+json", "User-Agent": "aquilo-kindle-updater"}
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def check():
    """Return { current, latest, url, asset } if a newer release exists, else None."""
    try:
        r = requests.get(RELEASES_API, headers=_headers(), params={"per_page": 30}, timeout=8)
        r.raise_for_status()
        releases = r.json()
    except (requests.RequestException, ValueError):
        return None
    best = None
    for rel in releases:
        tag = str(rel.get("tag_name", ""))
        if not tag.startswith(TAG_PREFIX) or rel.get("draft"):
            continue
        ver = tag[len(TAG_PREFIX):]
        try:
            parsed = version.parse(ver)
        except Exception:
            continue
        if best is None or parsed > best[0]:
            best = (parsed, rel, ver)
    if best is None:
        return None
    parsed, rel, ver = best
    if parsed <= version.parse(__version__):
        return None
    asset = None
    for a in rel.get("assets", []):
        if str(a.get("name", "")).lower().endswith(".exe"):
            asset = a.get("browser_download_url")
            break
    return {"current": __version__, "latest": ver, "url": rel.get("html_url"), "asset": asset}


def download_asset(asset_url):
    try:
        r = requests.get(asset_url, headers=_headers(), timeout=180, stream=True)
        r.raise_for_status()
    except requests.RequestException:
        return None
    fd, path = tempfile.mkstemp(suffix=".exe", prefix="aquilo-kindle-")
    try:
        with os.fdopen(fd, "wb") as f:
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
        return path
    except OSError:
        return None


def apply_update(new_exe):
    """Swap the running exe with new_exe and relaunch (Windows, frozen only)."""
    if not getattr(sys, "frozen", False) or os.name != "nt":
        return False
    target = sys.executable
    bat = os.path.join(tempfile.gettempdir(), "aquilo-kindle-update.bat")
    script = (
        "@echo off\r\n"
        "timeout /t 2 /nobreak >nul\r\n"
        f'copy /y "{new_exe}" "{target}" >nul\r\n'
        f'start "" "{target}"\r\n'
        f'del "{new_exe}" >nul 2>&1\r\n'
        'del "%~f0" >nul 2>&1\r\n'
    )
    try:
        with open(bat, "w", encoding="ascii") as f:
            f.write(script)
        subprocess.Popen(["cmd", "/c", bat], creationflags=0x08000000)  # no window
        return True
    except OSError:
        return False
