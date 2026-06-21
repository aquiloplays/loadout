"""Install detection: figures out whether each game's mod is installed and
where the project root + Node binary live.

Three things we detect:

1. **Aquilo CrowdPlay project root** - the local clone of aquilo-crowdplay.
   We need this to launch `node src/index.js`. We try common locations
   (next to this app, ../aquilo-crowdplay, Desktop/Aquilo/aquilo-crowdplay)
   before asking the user to pick.

2. **Node.js** - we shell out to `node --version`; if that fails, the
   companion can't launch the engine. The UI flags it with a link to
   nodejs.org.

3. **Per-game install** - for each game, we check whether the adapter file
   is at the expected path inside the game's install directory. Steam
   library discovery via `libraryfolders.vdf`.

Nothing here mutates anything. Install actions live in install.py
(write-side, kept separate so a future "auto-install" wizard can sit on
top of detection without touching the read path).
"""

from __future__ import annotations
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dataclasses import field
from companion_crowdplay.games import Game, CATALOG


# ── Aquilo CrowdPlay project root ────────────────────────────────────
PROJECT_MARKERS = ("package.json", "src/index.js")


def is_project_root(path: Path) -> bool:
    return all((path / m).exists() for m in PROJECT_MARKERS)


def guess_project_root() -> Optional[Path]:
    """Try a few common locations for the aquilo-crowdplay clone."""
    candidates = []
    # Sibling of this app
    here = Path(__file__).resolve().parent.parent
    candidates += [
        here.parent / "aquilo-crowdplay",                # ../aquilo-crowdplay
        here.parent.parent / "aquilo-crowdplay",         # ../../aquilo-crowdplay
        Path.home() / "Desktop" / "Aquilo" / "aquilo-crowdplay",
        Path("C:/Users/bishe/Desktop/Aquilo/aquilo-crowdplay"),
    ]
    for c in candidates:
        try:
            if c.exists() and is_project_root(c):
                return c.resolve()
        except OSError:
            continue
    return None


# ── Node.js ──────────────────────────────────────────────────────────
def node_available() -> Optional[str]:
    """Returns the node version string ('v20.10.0') or None if not found.

    Prefers a bundled portable Node (installed via Setup) so the user doesn't
    need a system install on PATH.
    """
    exe: Optional[str] = None
    try:
        from companion_crowdplay.downloads import find_bundled_node
        bundled = find_bundled_node()
        if bundled and bundled.exists():
            exe = str(bundled)
    except Exception:
        exe = None
    if not exe:
        exe = shutil.which("node")
    if not exe:
        return None
    try:
        r = subprocess.run(
            [exe, "--version"], capture_output=True, text=True, timeout=5,
            creationflags=_no_window(),
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return None
    return None


def _no_window() -> int:
    """CREATE_NO_WINDOW so shell-outs don't flash a console window on Win."""
    return 0x08000000 if sys.platform == "win32" else 0


# ── Steam library discovery ──────────────────────────────────────────
STEAM_DEFAULT_PATHS = [
    Path("C:/Program Files (x86)/Steam"),
    Path("C:/Program Files/Steam"),
    Path.home() / "Steam",
]


def steam_install_path() -> Optional[Path]:
    """Read HKCU\\Software\\Valve\\Steam\\SteamPath if available, else fall back
    to the standard install paths."""
    if sys.platform == "win32":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
                v, _ = winreg.QueryValueEx(k, "SteamPath")
                p = Path(v.replace("/", "\\"))
                if p.exists():
                    return p
        except (OSError, FileNotFoundError, ImportError):
            pass
    for c in STEAM_DEFAULT_PATHS:
        if c.exists():
            return c
    return None


def steam_library_paths() -> list[Path]:
    """All Steam library folders, parsed from libraryfolders.vdf."""
    root = steam_install_path()
    if not root:
        return []
    vdf = root / "steamapps" / "libraryfolders.vdf"
    if not vdf.exists():
        return [root / "steamapps"]
    text = vdf.read_text(encoding="utf-8", errors="ignore")
    # Match every "path" "X" line in the VDF. Crude but reliable.
    paths = [Path(m) for m in re.findall(r'"path"\s+"([^"]+)"', text)]
    out = []
    seen = set()
    for p in paths + [root]:
        p = Path(str(p).replace("\\\\", "/").replace("\\", "/"))
        sa = p / "steamapps"
        if sa.exists() and sa not in seen:
            seen.add(sa); out.append(sa)
    return out


def find_steam_game_dir(folder_name: str) -> Optional[Path]:
    """Look for steamapps/common/<folder_name> across all libraries."""
    for sa in steam_library_paths():
        d = sa / "common" / folder_name
        if d.exists():
            return d
    return None


# ── Per-game install status ──────────────────────────────────────────
@dataclass
class InstallStatus:
    game: Game
    game_dir: Optional[Path]      # detected or user-set game folder
    adapter_exists: bool          # is our adapter file at expected path?
    expected_path: Optional[Path] # where it should be
    notes: list[str]              # human-readable hints / next steps
    # Detailed checks for the per-row UI: (label, ok, detail)
    checks: list[tuple[str, bool, str]] = field(default_factory=list)


def check_install(game: Game, override_game_dir: Optional[Path] = None) -> InstallStatus:
    """Detailed check for one game's install state. Each step lands as a
    (label, ok, detail) row in `checks` so the UI can render a green/red
    grid instead of a single line."""
    notes: list[str] = []
    checks: list[tuple[str, bool, str]] = []

    if game.install_into is None:
        if game.harness == "pymem":
            try:
                import pymem  # noqa: F401
                checks.append(("Python pymem installed", True, "ok"))
            except Exception:
                checks.append(("Python pymem installed", False, "pip install pymem requests"))
                notes.append("Run `pip install pymem requests` to install the runtime dep.")
        return InstallStatus(game=game, game_dir=None, adapter_exists=True,
                             expected_path=None,
                             notes=["No in-game install needed for this adapter."] + notes,
                             checks=checks)

    game_dir = override_game_dir or (find_steam_game_dir(game.game_dir) if game.game_dir else None)
    if not game_dir:
        checks.append(("Game folder detected", False, "not found in any Steam library"))
        return InstallStatus(game=game, game_dir=None, adapter_exists=False,
                             expected_path=None,
                             notes=["Game folder not found. Use Browse... to point at it."],
                             checks=checks)
    checks.append(("Game folder detected", True, str(game_dir)))

    expected = Path(game.install_into.format(game_dir=str(game_dir)))
    exists = expected.exists()

    if game.harness == "ue4ss":
        # Two UE4SS install layouts exist in the wild:
        #   - v3.0.1 stable (Feb 2024): everything flat in Binaries/Win64/
        #     (dwmapi.dll, UE4SS.dll, UE4SS-settings.ini, Mods/)
        #   - experimental-latest (2026+): everything inside a ue4ss/
        #     subfolder (Win64/ue4ss/UE4SS.dll etc.); only dwmapi.dll stays
        #     at Win64/ root. THIS is the one that works on Half Sword's
        #     UE 5.4 because v3.0.1 fails the FText AOB scan.
        # We accept either: install_into can either include /ue4ss/Mods/...
        # or just /Mods/...; we walk up to Win64/ in both cases and probe
        # for the right core-DLL location.
        parts = list(expected.parents)
        # Find the Win64/ folder by walking up
        win64 = None
        for p in parts:
            if p.name.lower() == "win64" and p.parent.name.lower() == "binaries":
                win64 = p; break
        if not win64:
            # Fallback: assume install_into = .../Win64/[ue4ss/]Mods/crowdplay/Scripts/main.lua
            win64 = expected.parent.parent.parent
            if win64.name.lower() != "win64":
                win64 = win64.parent  # peel one more (the ue4ss/ segment)
        # Mods/ location depends on layout
        mods_dir = (win64 / "ue4ss" / "Mods") if (win64 / "ue4ss").exists() else (win64 / "Mods")
        # 1) Proxy DLL (always at Win64/ root)
        if (win64 / "dwmapi.dll").exists() or (win64 / "xinput1_3.dll").exists():
            checks.append(("UE4SS proxy DLL", True, str(win64)))
        else:
            checks.append(("UE4SS proxy DLL", False, f"missing dwmapi.dll under {win64}"))
            notes.append("UE4SS not detected. Click 'Install adapter' to auto-download.")
        # 1b) Core DLL + settings (at Win64/ for stable, Win64/ue4ss/ for experimental)
        core_root = (win64 / "ue4ss") if (win64 / "ue4ss" / "UE4SS.dll").exists() else win64
        if (core_root / "UE4SS.dll").exists() and (core_root / "UE4SS-settings.ini").exists():
            checks.append(("UE4SS core (UE4SS.dll)", True, str(core_root / "UE4SS.dll")))
        else:
            checks.append(("UE4SS core (UE4SS.dll)", False,
                           f"UE4SS.dll missing (looked at {win64} and {win64 / 'ue4ss'})"))
            notes.append("UE4SS core files missing. Re-run Install adapter.")
        # 2) LuaSocket-mod (legacy) - ONLY when the adapter actually uses
        #    sockets. The newer file-IPC adapters (e.g. half-sword) read from
        #    a JSONL queue instead and have no LuaSocket dependency at all.
        needs_luasocket = False
        if exists:
            try:
                src = expected.read_text(encoding="utf-8", errors="ignore")
                needs_luasocket = ("require('socket')" in src
                                   or 'require "socket"' in src
                                   or "require[[socket]]" in src)
            except OSError:
                pass
        if needs_luasocket:
            shared = mods_dir / "shared"
            if (shared / "socket").exists() \
               or (mods_dir / "lua-luasocket").exists() \
               or (shared / "Scripts" / "socket.lua").exists() \
               or any(shared.glob("luasocket-mod*")) \
               or any(shared.glob("**/socket.lua")):
                checks.append(("LuaSocket-mod installed", True, str(shared)))
            else:
                checks.append(("LuaSocket-mod installed", False, f"missing under {shared}"))
                notes.append("LuaSocket not detected. Install adapter will fetch it.")
        else:
            checks.append(("LuaSocket (not needed)", True, "adapter uses file IPC"))
        # 3) adapter file
        if exists:
            checks.append(("crowdplay adapter file", True, str(expected)))
        else:
            checks.append(("crowdplay adapter file", False, str(expected)))
            notes.append("Adapter Lua file is not at the expected path.")
        # 4) mods.txt enabled (probe `expected`'s parents - the mod is at
        #    Mods/crowdplay/Scripts/main.lua, so the active Mods/ is two
        #    levels up regardless of the surrounding layout)
        actual_mods_dir = expected.parent.parent.parent  # Scripts -> crowdplay -> Mods
        if actual_mods_dir.exists() and actual_mods_dir.name.lower() == "mods":
            mods_dir = actual_mods_dir
        mods_txt = mods_dir / "mods.txt"
        if mods_txt.exists():
            content = mods_txt.read_text(encoding="utf-8", errors="ignore")
            entries = [l.split(":")[0].strip() for l in content.splitlines()
                       if l.strip() and not l.strip().startswith(";")]
            if "crowdplay" in entries:
                checks.append(("crowdplay enabled in mods.txt", True, "crowdplay : 1"))
            else:
                checks.append(("crowdplay enabled in mods.txt", False, f"not in {mods_txt.name}"))
                notes.append("crowdplay isn't enabled in mods.txt - re-run install.")
        else:
            checks.append(("crowdplay enabled in mods.txt", False, f"missing {mods_txt}"))

    elif game.harness == "bepinex":
        # 1) BepInEx itself
        bep_dir = game_dir / "BepInEx"
        if bep_dir.exists():
            checks.append(("BepInEx installed", True, str(bep_dir)))
        else:
            checks.append(("BepInEx installed", False, f"missing {bep_dir}"))
            notes.append("BepInEx not detected. Install adapter will auto-download it.")
        # 2) DLL present
        dll = game_dir / "BepInEx" / "plugins" / "AquiloCrowdPlay.dll"
        if dll.exists():
            checks.append(("AquiloCrowdPlay.dll dropped", True, str(dll)))
        else:
            checks.append(("AquiloCrowdPlay.dll dropped", False, f"missing {dll}"))
            notes.append("Prebuilt DLL not in BepInEx/plugins/. Click Install adapter.")
        if not exists:
            notes.append(f"Expected: {expected}")

    elif game.harness == "zhmmodsdk":
        # 1) prebuilt DLL
        dll = game_dir / "Retail" / "mods" / "CrowdPlay.dll"
        if dll.exists():
            checks.append(("CrowdPlay.dll dropped", True, str(dll)))
        else:
            checks.append(("CrowdPlay.dll dropped", False,
                           "missing - waiting for first CI build"))
            notes.append("CI hasn't shipped the prebuilt DLL yet. Stage source via Install adapter.")

    if not exists and not checks:
        notes.append(f"Adapter missing: {expected}")

    return InstallStatus(
        game=game, game_dir=game_dir, adapter_exists=exists,
        expected_path=expected, notes=notes, checks=checks,
    )


def check_pymem_installed() -> bool:
    """For Crimson Desert: ensure the Python adapter can run."""
    try:
        import pymem  # noqa: F401
        return True
    except ImportError:
        return False
