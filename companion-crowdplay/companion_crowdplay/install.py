"""Auto-installer for the CrowdPlay adapter mods.

Each game's adapter has a different install path (UE4SS Lua, BizHawk Lua,
ZHMModSDK C++, BepInEx C#, pymem Python). This module produces a per-game
*plan* - an ordered list of `Step`s - that the install dialog runs in a
background thread.

A Step is intentionally tiny:
    name:        what the user sees in the progress list
    description: optional one-line hint shown under the step
    run(ctx):    does the thing; returns (ok, message) and may call
                 ctx.log(...) for verbose output.

The planner itself is pure: it returns a list of Steps without touching
disk. The dialog calls `Step.run(ctx)` for each step in order, marking
each green / red based on the return value.

We do NOT auto-download UE4SS / BepInEx / LuaSocket: those vary per game
build, anti-cheat surface, and game version, and we don't want to land a
known-bad version. The plan detects them and surfaces a one-click
"Open download page" alongside the install button.
"""

from __future__ import annotations
import os
import shutil
import subprocess
import sys
import urllib.request
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from companion_crowdplay.downloads import (
    install_bepinex, install_luasocket, install_ue4ss,
)
from companion_crowdplay.games import Game


# ── Context passed to each step ────────────────────────────────────────
@dataclass
class InstallContext:
    project_root: Path                 # local aquilo-crowdplay clone
    game: Game                         # the game being installed
    game_dir: Optional[Path]           # game install folder (may be None for non-Steam adapters)
    log: Callable[[str], None] = lambda _msg: None  # log sink


# ── A single step in the plan ──────────────────────────────────────────
@dataclass
class Step:
    name: str
    run: Callable[[InstallContext], tuple[bool, str]]
    description: str = ""


# ── External URLs we point users at when prerequisites are missing ─────
URL_UE4SS = "https://github.com/UE4SS-RE/RE-UE4SS/releases"
URL_LUASOCKET = "https://github.com/MikuAuahDark/luasocket-mod/releases"
URL_BEPINEX = "https://github.com/BepInEx/BepInEx/releases"
URL_ZHMMODSDK = "https://github.com/OrfeasZ/ZHMModSDK"


# ── Helpers ────────────────────────────────────────────────────────────
def _win64_for(game_dir: Path, install_into: str) -> Path:
    """Resolve the Binaries/Win64/ folder by walking up from install_into.
    Handles both UE4SS layouts:
      - stable v3.0.1: .../Win64/Mods/crowdplay/Scripts/main.lua
      - experimental: .../Win64/ue4ss/Mods/crowdplay/Scripts/main.lua
    """
    expected = Path(install_into.format(game_dir=str(game_dir)))
    for p in expected.parents:
        if p.name.lower() == "win64" and p.parent.name.lower() == "binaries":
            return p
    # Fallback: peel parents by name until we hit something that looks like Win64
    cur = expected.parent
    while cur != cur.parent:
        if cur.name.lower() == "win64": return cur
        cur = cur.parent
    return expected.parent.parent.parent  # last-resort


_ue4ss_dir_for = _win64_for  # back-compat alias


def _ue4ss_present(win64: Path) -> bool:
    """UE4SS is installed if dwmapi.dll (or xinput1_3.dll) is at Win64/ root
    AND UE4SS.dll + UE4SS-settings.ini exist either at Win64/ root (stable
    layout) or under Win64/ue4ss/ (experimental layout)."""
    proxy = (win64 / "dwmapi.dll").exists() or (win64 / "xinput1_3.dll").exists()
    if not proxy: return False
    if (win64 / "UE4SS.dll").exists() and (win64 / "UE4SS-settings.ini").exists():
        return True  # stable
    if (win64 / "ue4ss" / "UE4SS.dll").exists() and (win64 / "ue4ss" / "UE4SS-settings.ini").exists():
        return True  # experimental
    return False


def _luasocket_present(win64: Path) -> bool:
    """LuaSocket-mod presence (legacy; new adapters use file IPC and don't
    need this). Probes both layouts."""
    candidates = [
        win64 / "Mods" / "shared" / "socket",
        win64 / "Mods" / "lua-luasocket",
        win64 / "Mods" / "shared" / "Scripts" / "socket.lua",
        win64 / "ue4ss" / "Mods" / "shared" / "socket",
        win64 / "ue4ss" / "Mods" / "lua-luasocket",
        win64 / "ue4ss" / "Mods" / "shared" / "Scripts" / "socket.lua",
    ]
    return any(p.exists() for p in candidates)


def _copy_file(src: Path, dst: Path, log: Callable[[str], None]) -> tuple[bool, str]:
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        log(f"  copied {src.name} -> {dst}")
        return True, f"copied {dst.name}"
    except OSError as e:
        return False, f"copy failed: {e}"


def _copy_tree(src: Path, dst: Path, log: Callable[[str], None]) -> tuple[bool, str]:
    try:
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        log(f"  copied tree {src} -> {dst}")
        return True, f"copied {dst.name}/"
    except OSError as e:
        return False, f"copy failed: {e}"


def _append_to_mods_txt(mods_txt: Path, line: str, log: Callable[[str], None]) -> tuple[bool, str]:
    """Append `line` to mods.txt unless an active entry with the same mod name
    already exists. Handles both 'mod : 1' and 'mod:1' shapes."""
    try:
        mods_txt.parent.mkdir(parents=True, exist_ok=True)
        existing = ""
        if mods_txt.exists():
            existing = mods_txt.read_text(encoding="utf-8", errors="ignore")
        mod_name = line.split(":")[0].strip()
        for raw in existing.splitlines():
            stripped = raw.strip()
            if not stripped or stripped.startswith(";"):
                continue
            name = stripped.split(":")[0].strip()
            if name == mod_name:
                log(f"  mods.txt already contains '{mod_name}', skipping append")
                return True, "already enabled"
        sep = "" if existing.endswith("\n") or not existing else "\n"
        with mods_txt.open("a", encoding="utf-8") as f:
            f.write(f"{sep}{line}\n")
        log(f"  appended '{line}' to {mods_txt.name}")
        return True, "enabled"
    except OSError as e:
        return False, f"mods.txt edit failed: {e}"


# ── UE4SS plan ─────────────────────────────────────────────────────────
def _plan_ue4ss(game: Game, project_root: Path, game_dir: Optional[Path]) -> list[Step]:
    def step_game_folder(ctx: InstallContext) -> tuple[bool, str]:
        if not ctx.game_dir or not ctx.game_dir.exists():
            return False, "Game folder not set or doesn't exist"
        return True, f"using {ctx.game_dir}"

    def step_ue4ss(ctx: InstallContext) -> tuple[bool, str]:
        win64 = _win64_for(ctx.game_dir, ctx.game.install_into)
        if _ue4ss_present(win64):
            return True, f"UE4SS detected at {win64}"
        ctx.log("UE4SS not detected. Downloading latest stable release...")
        ok, msg = install_ue4ss(win64, ctx.log)
        if not ok:
            webbrowser.open(URL_UE4SS)
            return False, f"{msg}. Opened the releases page as a fallback."
        return True, msg

    def step_luasocket(ctx: InstallContext) -> tuple[bool, str]:
        # Skip LuaSocket entirely when the adapter uses file IPC (no
        # require('socket')). The newer adapters do.
        adapter_src = ctx.project_root / ctx.game.adapter_rel
        try:
            txt = adapter_src.read_text(encoding="utf-8", errors="ignore")
            uses_socket = ("require('socket')" in txt
                           or 'require "socket"' in txt
                           or "require[[socket]]" in txt)
        except OSError:
            uses_socket = True  # be conservative
        if not uses_socket:
            return True, "skipped (adapter uses file IPC, no LuaSocket needed)"
        win64 = _win64_for(ctx.game_dir, ctx.game.install_into)
        if _luasocket_present(win64):
            return True, "LuaSocket detected"
        ctx.log("LuaSocket not detected. Downloading latest release...")
        ok, msg = install_luasocket(win64, ctx.log)
        if not ok:
            webbrowser.open(URL_LUASOCKET)
            return False, f"{msg}. Opened the releases page as a fallback."
        return True, msg

    def step_copy_adapter(ctx: InstallContext) -> tuple[bool, str]:
        src = ctx.project_root / ctx.game.adapter_rel
        if not src.exists():
            return False, f"adapter source missing: {src}"
        dst = Path(ctx.game.install_into.format(game_dir=str(ctx.game_dir)))
        return _copy_file(src, dst, ctx.log)

    def step_mods_txt(ctx: InstallContext) -> tuple[bool, str]:
        # Whichever Mods/ directory holds our crowdplay/ folder is the live
        # one - walk up from install_into to find it (handles both layouts).
        dst = Path(ctx.game.install_into.format(game_dir=str(ctx.game_dir)))
        mods_dir = dst.parent.parent.parent   # Scripts -> crowdplay -> Mods
        mods_txt = mods_dir / "mods.txt"
        return _append_to_mods_txt(mods_txt, "crowdplay : 1", ctx.log)

    def step_verify(ctx: InstallContext) -> tuple[bool, str]:
        dst = Path(ctx.game.install_into.format(game_dir=str(ctx.game_dir)))
        return (dst.exists(), f"verified at {dst}" if dst.exists() else "main.lua missing after install")

    return [
        Step("Game folder", step_game_folder),
        Step("UE4SS installed", step_ue4ss,
             description="Downloads the latest UE4SS release (dwmapi.dll + UE4SS.dll + UE4SS-settings.ini + Mods/) into Binaries/Win64/."),
        Step("LuaSocket installed", step_luasocket,
             description="Only used by adapters that call require('socket'); skipped for file-IPC adapters."),
        Step("Copy crowdplay/Scripts/main.lua", step_copy_adapter),
        Step("Enable in mods.txt", step_mods_txt),
        Step("Verify install", step_verify),
    ]


# ── BizHawk plan ───────────────────────────────────────────────────────
def _plan_bizhawk(game: Game, project_root: Path) -> list[Step]:
    """Pokemon Platinum: no in-game install, but reveal the .lua file so the
    user can drag it into BizHawk's Lua Console."""

    def step_check_source(ctx: InstallContext) -> tuple[bool, str]:
        src = ctx.project_root / ctx.game.adapter_rel
        return (src.exists(), str(src) if src.exists() else f"missing {src}")

    def step_open_folder(ctx: InstallContext) -> tuple[bool, str]:
        src = ctx.project_root / ctx.game.adapter_rel
        folder = src.parent
        try:
            if sys.platform == "win32":
                os.startfile(folder)  # type: ignore[attr-defined]
            else:
                subprocess.run(["xdg-open", str(folder)], check=False)
            return True, f"Opened {folder}. In BizHawk: Tools -> Lua Console -> Open Script -> crowdplay.lua"
        except OSError as e:
            return False, f"could not open folder: {e}"

    return [
        Step("Adapter source present", step_check_source),
        Step("Open adapter folder", step_open_folder,
             description="Drag crowdplay.lua into BizHawk's Lua Console; no install path on the game side."),
    ]


# ── ZHMModSDK (Hitman) plan ────────────────────────────────────────────
def _plan_hitman(game: Game, project_root: Path, game_dir: Optional[Path]) -> list[Step]:
    """The adapter is a C++ plugin; building it requires VS2022 + CMake +
    the ZHMModSDK. We can't build it for the user, but we can stage the
    source under the game's mods folder and open the README."""

    def step_game_folder(ctx: InstallContext) -> tuple[bool, str]:
        if not ctx.game_dir or not (ctx.game_dir / "Retail").exists():
            return False, "Game folder not set or doesn't contain Retail/"
        return True, f"using {ctx.game_dir}"

    def step_copy_prebuilt_dll(ctx: InstallContext) -> tuple[bool, str]:
        """Drop the CI-built CrowdPlay.dll into Retail/mods/ if it exists.
        Falls through gracefully to the source-stage step otherwise."""
        src = ctx.project_root / "adapters" / "hitman-woa" / "prebuilt" / "CrowdPlay.dll"
        if not src.exists():
            return True, "no prebuilt DLL yet (CI has not run); falling back to source."
        dst = ctx.game_dir / "Retail" / "mods" / "CrowdPlay.dll"
        return _copy_file(src, dst, ctx.log)

    def step_copy_source(ctx: InstallContext) -> tuple[bool, str]:
        src = ctx.project_root / ctx.game.adapter_rel
        if not src.exists():
            return False, f"adapter source missing: {src}"
        dst = ctx.game_dir / "Retail" / "mods" / "CrowdPlay-src"
        return _copy_tree(src, dst, ctx.log)

    def step_open_readme(ctx: InstallContext) -> tuple[bool, str]:
        # Only useful when the prebuilt DLL isn't there yet.
        prebuilt = ctx.project_root / "adapters" / "hitman-woa" / "prebuilt" / "CrowdPlay.dll"
        if prebuilt.exists():
            return True, "Prebuilt DLL installed. Launch the game + open the ZHMModSDK menu."
        readme = ctx.project_root / "adapters" / "hitman-woa" / "README.md"
        try:
            if sys.platform == "win32":
                os.startfile(readme)  # type: ignore[attr-defined]
            else:
                subprocess.run(["xdg-open", str(readme)], check=False)
        except OSError:
            pass
        webbrowser.open(URL_ZHMMODSDK)
        return True, "Opened the build README + the ZHMModSDK GitHub page."

    return [
        Step("Game folder", step_game_folder),
        Step("Drop prebuilt CrowdPlay.dll into Retail/mods/", step_copy_prebuilt_dll,
             description="CI-built plugin - the harness is auto-installed; effect bodies still need ZHMModSDK wiring."),
        Step("Stage C++ source under Retail/mods/CrowdPlay-src/", step_copy_source),
        Step("Open build instructions", step_open_readme,
             description="Only when no prebuilt DLL exists - requires VS2022 + CMake + ZHMModSDK."),
    ]


# ── BepInEx plan ───────────────────────────────────────────────────────
def _plan_bepinex(game: Game, project_root: Path, game_dir: Optional[Path]) -> list[Step]:
    """Killer Bean and any future Unity adapter. The DLL needs `dotnet
    build` against the game's Managed/ assemblies; we can't do that for
    the user without their dotnet SDK + the game's path."""

    def step_game_folder(ctx: InstallContext) -> tuple[bool, str]:
        if not ctx.game_dir or not ctx.game_dir.exists():
            return False, "Game folder not set or doesn't exist"
        return True, f"using {ctx.game_dir}"

    def step_bepinex(ctx: InstallContext) -> tuple[bool, str]:
        if (ctx.game_dir / "BepInEx").exists():
            return True, "BepInEx detected"
        ctx.log("BepInEx not detected. Downloading latest stable release...")
        ok, msg = install_bepinex(ctx.game_dir, ctx.log)
        if not ok:
            webbrowser.open(URL_BEPINEX)
            return False, f"{msg}. Opened the releases page as a fallback."
        return True, msg

    def step_copy_prebuilt_dll(ctx: InstallContext) -> tuple[bool, str]:
        """Drop the harness DLL into BepInEx/plugins/. Built without the
        game's assemblies, so spawn/heal/ammo handlers log a TODO line, but
        Time.timeScale / Physics.gravity effects (slow_mo, low_gravity,
        fast_mo) work out of the box. To get full spawns, rebuild the
        plugin against the game's Managed/ folder (see README)."""
        src = ctx.project_root / "adapters" / "killer-bean" / "prebuilt" / "AquiloCrowdPlay.dll"
        if not src.exists():
            return False, f"prebuilt DLL missing in repo: {src}"
        dst = ctx.game_dir / "BepInEx" / "plugins" / "AquiloCrowdPlay.dll"
        return _copy_file(src, dst, ctx.log)

    def step_stage_source(ctx: InstallContext) -> tuple[bool, str]:
        """Also drop the source next to the DLL so power users can rebuild
        against the game's assemblies for full spawns."""
        src = ctx.project_root / ctx.game.adapter_rel
        if not src.exists():
            return False, f"adapter source missing: {src}"
        dst = ctx.game_dir / "BepInEx" / "plugins" / "AquiloCrowdPlay-src"
        return _copy_tree(src, dst, ctx.log)

    return [
        Step("Game folder", step_game_folder),
        Step("BepInEx installed", step_bepinex,
             description="Unity plugin loader. Auto-downloaded if missing."),
        Step("Drop prebuilt AquiloCrowdPlay.dll into BepInEx/plugins/", step_copy_prebuilt_dll,
             description="Harness build: networking + slow_mo / low_gravity / fast_mo work out of the box. Spawns log TODO until you rebuild against game assemblies."),
        Step("Stage source under BepInEx/plugins/AquiloCrowdPlay-src/", step_stage_source,
             description="For when you want full spawns: rebuild the plugin against the game's Managed/ folder (see README)."),
    ]


# ── pymem (Crimson Desert) plan ────────────────────────────────────────
def _plan_pymem(game: Game, project_root: Path) -> list[Step]:
    """No in-game install. Just ensure pymem + requests are installed in the
    Python interpreter the user will use to run crowdplay.py."""

    def step_check_source(ctx: InstallContext) -> tuple[bool, str]:
        src = ctx.project_root / ctx.game.adapter_rel
        return (src.exists(), str(src) if src.exists() else f"missing {src}")

    def step_pip_install(ctx: InstallContext) -> tuple[bool, str]:
        try:
            r = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--upgrade",
                 "pymem>=1.13.0", "requests>=2.31.0"],
                capture_output=True, text=True, timeout=180,
                creationflags=(0x08000000 if sys.platform == "win32" else 0),
            )
            ctx.log(r.stdout)
            if r.returncode != 0:
                ctx.log(r.stderr)
                return False, f"pip exit {r.returncode}"
            return True, "pymem + requests installed"
        except (subprocess.SubprocessError, OSError) as e:
            return False, f"pip failed: {e}"

    def step_open_folder(ctx: InstallContext) -> tuple[bool, str]:
        src = ctx.project_root / ctx.game.adapter_rel
        try:
            if sys.platform == "win32":
                os.startfile(src.parent)  # type: ignore[attr-defined]
            return True, f"Opened {src.parent}. Run: python crowdplay.py"
        except OSError as e:
            return False, f"could not open folder: {e}"

    return [
        Step("Adapter source present", step_check_source),
        Step("pip install pymem + requests", step_pip_install,
             description="Installs into the Python interpreter that's running this companion."),
        Step("Open adapter folder", step_open_folder,
             description="Crimson Desert single-player only - online play has anti-cheat that bans for injection."),
    ]


# ── Dispatcher ─────────────────────────────────────────────────────────
def plan_for_game(game: Game, project_root: Path, game_dir: Optional[Path]) -> list[Step]:
    """Return the install plan for the given game and machine state."""
    if game.harness == "ue4ss":
        return _plan_ue4ss(game, project_root, game_dir)
    if game.harness == "bizhawk":
        return _plan_bizhawk(game, project_root)
    if game.harness == "zhmmodsdk":
        return _plan_hitman(game, project_root, game_dir)
    if game.harness == "bepinex":
        return _plan_bepinex(game, project_root, game_dir)
    if game.harness == "pymem":
        return _plan_pymem(game, project_root)
    return []
