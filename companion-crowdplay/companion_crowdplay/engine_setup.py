"""First-run engine source provisioning.

The companion app ships the aquilo-crowdplay source inside its PyInstaller
bundle (added via build.ps1's `--add-data`). On first launch, if the user
hasn't pointed at an existing clone, we:

  1. Copy the bundled source into %LocalAppData%/AquiloCrowdPlay/engine.
  2. Run `npm install` against it using the bundled portable Node (or PATH
     node as a fallback).
  3. Persist the resulting path into QSettings so the rest of the app uses it.

If we're running from source (not a PyInstaller bundle), the bundled-source
detection falls back to the sibling `aquilo-crowdplay` folder next to the
companion clone, so developers don't have to reconfigure anything.
"""

from __future__ import annotations
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable, Optional

ProgressFn = Callable[[str], None]


def bundled_source_dir() -> Optional[Path]:
    """Where the engine source lives in this binary.

    When PyInstaller wraps us, `sys._MEIPASS` points at the extraction dir
    and the engine source sits at `<MEIPASS>/aquilo-crowdplay/`. When we're
    running from source, fall back to the sibling clone two levels up from
    this file.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        bundled = Path(meipass) / "aquilo-crowdplay"
        if (bundled / "src" / "index.js").exists():
            return bundled
        return None
    # Source-tree fallback: ../../aquilo-crowdplay
    here = Path(__file__).resolve().parent.parent
    cand = here.parent.parent / "aquilo-crowdplay"
    if (cand / "src" / "index.js").exists():
        return cand
    return None


def user_engine_dir() -> Path:
    """Per-user copy of the engine source. Lives next to the portable Node
    in %LocalAppData%/AquiloCrowdPlay/ so an uninstall can sweep both."""
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local")
    return base / "AquiloCrowdPlay" / "engine"


def engine_is_installed(at: Path) -> bool:
    """The engine is "installed" once src/index.js is present AND
    node_modules has at least one package (ws is the smallest mandatory dep)."""
    return (at / "src" / "index.js").exists() and (at / "node_modules" / "ws").exists()


def copy_bundle_to_user(progress: ProgressFn) -> tuple[bool, Path | str]:
    """Copy the bundled engine source into the user dir. Idempotent: skips
    files that already match by size. Returns (ok, target_or_error)."""
    src = bundled_source_dir()
    if not src:
        return False, "no engine source bundled (developer build?)"
    dst = user_engine_dir()
    dst.mkdir(parents=True, exist_ok=True)
    # Walk + copy. We deliberately skip node_modules/ in the source so the
    # bundle stays tiny; the user gets a fresh install via `npm install`.
    n_copied = 0
    skipped_dirs = {"node_modules", ".git", ".wrangler", "dist"}
    for root, dirs, files in os.walk(src):
        # In-place filter so os.walk doesn't descend into excluded dirs.
        dirs[:] = [d for d in dirs if d not in skipped_dirs]
        rel = Path(root).relative_to(src)
        out_root = dst / rel
        out_root.mkdir(parents=True, exist_ok=True)
        for name in files:
            sp = Path(root) / name
            dp = out_root / name
            try:
                if dp.exists() and dp.stat().st_size == sp.stat().st_size:
                    continue
                shutil.copy2(sp, dp)
                n_copied += 1
            except OSError as e:
                progress(f"  copy failed {sp.name}: {e}")
    progress(f"  copied {n_copied} files into {dst}")
    return True, dst


def find_node_for_install() -> Optional[str]:
    """Pick the node we'll spawn `npm install` with. Prefer the portable one."""
    try:
        from companion_crowdplay.downloads import find_bundled_node
        bundled = find_bundled_node()
        if bundled and bundled.exists():
            return str(bundled)
    except Exception:
        pass
    return shutil.which("node")


def run_npm_install(at: Path, progress: ProgressFn) -> tuple[bool, str]:
    """Run `npm install` in `at` using whichever node we resolved. Streams
    stdout into progress. Returns (ok, message)."""
    node = find_node_for_install()
    if not node:
        return False, "no Node.js found - run Install Node.js first."
    # npm.cmd lives next to node.exe in the portable bundle; on a system
    # install it's on PATH alongside node.
    node_dir = Path(node).parent
    npm = node_dir / ("npm.cmd" if sys.platform == "win32" else "npm")
    if not npm.exists():
        # System install: rely on PATH lookup for npm.
        npm = shutil.which("npm") or "npm"
    progress(f"  spawning {npm} install ...")
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
    try:
        p = subprocess.Popen(
            [str(npm), "install", "--no-audit", "--no-fund", "--loglevel=error"],
            cwd=str(at),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
    except OSError as e:
        return False, f"failed to spawn npm: {e}"
    assert p.stdout is not None
    for line in iter(p.stdout.readline, ""):
        line = line.rstrip()
        if line:
            progress(f"  npm: {line}")
    code = p.wait()
    if code != 0:
        return False, f"npm install exited {code}"
    return True, f"npm install ok in {at}"


def provision_engine(progress: ProgressFn) -> tuple[bool, Path | str]:
    """High-level entry point used by the first-run wizard:
       1. If a user-dir engine is already provisioned, short-circuit.
       2. Copy the bundled source into the user dir.
       3. Run npm install.
       4. Return the engine path on success.
    """
    target = user_engine_dir()
    if engine_is_installed(target):
        return True, target
    ok, val = copy_bundle_to_user(progress)
    if not ok:
        return False, str(val)
    ok2, msg2 = run_npm_install(target, progress)
    if not ok2:
        return False, msg2
    return True, target
