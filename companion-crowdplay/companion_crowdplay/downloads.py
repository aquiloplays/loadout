"""GitHub-release downloader + zip extractor used by the auto-installer.

Everything here is pure stdlib (urllib + zipfile + json) so PyInstaller bundles
cleanly without extra wheels. Progress is reported through a callback that the
install dialog hooks up to its log + progress bar.

Per-release auth: GitHub allows 60 unauthenticated requests per hour per IP;
plenty for a one-click install. If we ever hit rate limits we can swap in
`Authorization: Bearer <token>` from env.
"""

from __future__ import annotations
import io
import json
import os
import re
import sys
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


# ── public helpers ────────────────────────────────────────────────────
ProgressFn = Callable[[str], None]


@dataclass
class ReleaseAsset:
    name: str
    url: str           # browser_download_url
    size: int          # bytes


def fetch_latest_release(repo: str, log: ProgressFn = lambda _msg: None) -> dict:
    """`repo` is 'owner/name'. Returns the parsed release JSON.

    Falls back from /releases/latest (which 404s when no release is tagged as
    "latest", as on MikuAuahDark/luasocket-mod) to /releases?per_page=10 and
    picks the newest non-draft entry.
    """
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "aquilo-crowdplay-companion",
    }
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    log(f"  GET {url}")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        log(f"  /releases/latest 404; falling back to /releases list")
    list_url = f"https://api.github.com/repos/{repo}/releases?per_page=10"
    log(f"  GET {list_url}")
    with urllib.request.urlopen(urllib.request.Request(list_url, headers=headers), timeout=15) as r:
        releases = json.loads(r.read().decode("utf-8")) or []
    for rel in releases:
        if not rel.get("draft"):
            return rel
    raise RuntimeError(f"{repo} has no public releases")


def pick_asset(release: dict, name_re: str) -> Optional[ReleaseAsset]:
    rx = re.compile(name_re, re.IGNORECASE)
    for a in release.get("assets", []) or []:
        if rx.search(a.get("name") or ""):
            return ReleaseAsset(name=a["name"], url=a["browser_download_url"], size=int(a.get("size") or 0))
    return None


def download(url: str, dest: Path, log: ProgressFn = lambda _msg: None,
             progress: ProgressFn = lambda _msg: None) -> Path:
    """Stream a URL to `dest` with chunked progress reporting."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"  GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "aquilo-crowdplay-companion"})
    with urllib.request.urlopen(req, timeout=60) as r, dest.open("wb") as fp:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        chunk_size = 256 * 1024
        last_pct = -1
        while True:
            buf = r.read(chunk_size)
            if not buf:
                break
            fp.write(buf)
            got += len(buf)
            if total > 0:
                pct = int(got * 100 / total)
                if pct != last_pct and pct % 5 == 0:
                    progress(f"  {pct:3d}%  {got/1_048_576:.1f} / {total/1_048_576:.1f} MiB")
                    last_pct = pct
    log(f"  saved -> {dest} ({got/1_048_576:.1f} MiB)")
    return dest


def extract_zip(zip_path: Path, target_dir: Path, log: ProgressFn = lambda _msg: None,
                strip_top_level: bool = False) -> int:
    """Extract a zip into target_dir.

    `strip_top_level=True` flattens the common case where a release zip has a
    single top-level folder (eg `UE4SS-3.0.1/...`). Returns the number of
    members extracted.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    with zipfile.ZipFile(zip_path) as zf:
        members = zf.namelist()
        top = _common_top_level(members) if strip_top_level else None
        for name in members:
            # Skip directory entries.
            if name.endswith("/"):
                continue
            out_rel = name
            if top:
                out_rel = name[len(top):]
            if not out_rel:
                continue
            out = target_dir / out_rel
            out.parent.mkdir(parents=True, exist_ok=True)
            # Block path traversal.
            if not _is_within(out, target_dir):
                log(f"  refused traversal: {name}")
                continue
            with zf.open(name) as src, out.open("wb") as dst:
                dst.write(src.read())
            n += 1
    log(f"  extracted {n} files into {target_dir}")
    return n


def _common_top_level(members: list[str]) -> Optional[str]:
    """If every non-empty member starts with `XYZ/`, return `XYZ/`."""
    tops = set()
    for m in members:
        if not m:
            continue
        first = m.split("/", 1)[0]
        tops.add(first + "/")
        if len(tops) > 1:
            return None
    return tops.pop() if len(tops) == 1 else None


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


# ── opinionated wrappers for the three release sources we care about ──
def install_ue4ss(target_win64: Path, log: ProgressFn) -> tuple[bool, str]:
    """Download latest UE4SS release and extract into `<game>/.../Binaries/Win64/`.

    UE4SS ships dwmapi.dll + the ue4ss/ folder at the zip root, which is
    exactly what we want side-by-side with the game's exe folder.
    """
    try:
        rel = fetch_latest_release("UE4SS-RE/RE-UE4SS", log)
    except Exception as e:
        return False, f"latest-release lookup failed: {e}"
    # Prefer the stable non-experimental asset.
    asset = pick_asset(rel, r"^UE4SS_v[\d.]+\.zip$") or pick_asset(rel, r"^UE4SS_v.*\.zip$")
    if not asset:
        return False, "no UE4SS asset matched the expected name pattern"
    log(f"  picked asset: {asset.name} ({asset.size/1_048_576:.1f} MiB)")
    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / asset.name
        try:
            download(asset.url, zip_path, log, log)
            extract_zip(zip_path, target_win64, log, strip_top_level=False)
        except Exception as e:
            return False, f"download/extract failed: {e}"
    return True, f"UE4SS {rel.get('tag_name', '')} installed at {target_win64}"


def install_luasocket(ue4ss_dir: Path, log: ProgressFn) -> tuple[bool, str]:
    """Download LuaSocket-mod and place into `<ue4ss>/Mods/shared/` so any UE4SS
    Lua mod can `require('socket')`.

    The repo has no formal GitHub releases, so we fall back to the source
    archive of the default branch. Also appends `shared : 1` to mods.txt.
    """
    target_shared = ue4ss_dir / "Mods" / "shared"
    url = None
    name = "luasocket-mod-source.zip"
    # Try a tagged release first; fall back to the master/main archive.
    try:
        rel = fetch_latest_release("MikuAuahDark/luasocket-mod", log)
        asset = pick_asset(rel, r"\.zip$")
        if asset:
            url = asset.url; name = asset.name
            log(f"  picked release asset: {asset.name}")
    except Exception as e:
        log(f"  no release found ({e}); falling back to source archive")
    if not url:
        # The default branch may be `master` or `main`; we try `master` first.
        for branch in ("master", "main"):
            cand = f"https://github.com/MikuAuahDark/luasocket-mod/archive/refs/heads/{branch}.zip"
            try:
                urllib.request.urlopen(urllib.request.Request(cand, method="HEAD"), timeout=8).close()
                url = cand
                log(f"  using source archive: {cand}")
                break
            except Exception:
                continue
        if not url:
            return False, "could not find a LuaSocket source archive"
    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / name
        try:
            download(url, zip_path, log, log)
            extract_zip(zip_path, target_shared, log, strip_top_level=True)
        except Exception as e:
            return False, f"download/extract failed: {e}"
    # Enable in mods.txt
    mods_txt = ue4ss_dir / "Mods" / "mods.txt"
    try:
        content = mods_txt.read_text(encoding="utf-8") if mods_txt.exists() else ""
        if not any(line.split(":")[0].strip() == "shared" for line in content.splitlines() if line.strip() and not line.strip().startswith(";")):
            with mods_txt.open("a", encoding="utf-8") as f:
                if content and not content.endswith("\n"):
                    f.write("\n")
                f.write("shared : 1\n")
            log("  enabled 'shared' in mods.txt")
    except OSError as e:
        return False, f"mods.txt edit failed: {e}"
    return True, f"LuaSocket installed at {target_shared}"


def install_bepinex(game_dir: Path, log: ProgressFn) -> tuple[bool, str]:
    """Download latest BepInEx 5 (x64, Mono) and extract into the game root."""
    try:
        rel = fetch_latest_release("BepInEx/BepInEx", log)
    except Exception as e:
        return False, f"latest-release lookup failed: {e}"
    # BepInEx 5 stable bin assets look like `BepInEx_win_x64_5.4.23.0.zip`.
    asset = pick_asset(rel, r"BepInEx_(win_)?x64_[\d.]+\.zip$")
    if not asset:
        return False, "no BepInEx x64 asset matched the expected name pattern"
    log(f"  picked asset: {asset.name} ({asset.size/1_048_576:.1f} MiB)")
    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / asset.name
        try:
            download(asset.url, zip_path, log, log)
            extract_zip(zip_path, game_dir, log, strip_top_level=False)
        except Exception as e:
            return False, f"download/extract failed: {e}"
    return True, f"BepInEx {rel.get('tag_name', '')} installed at {game_dir}"


# ── Node.js portable ──────────────────────────────────────────────────
NODE_PORTABLE_URL = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip"
NODE_PORTABLE_VER = "v20.18.0"


def node_portable_root() -> Path:
    """Where we drop a portable Node.js so the engine doesn't need one on PATH."""
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local")
    return base / "AquiloCrowdPlay" / "node"


def find_bundled_node() -> Optional[Path]:
    """Returns the path to node.exe under our portable install, or None."""
    root = node_portable_root()
    if not root.exists():
        return None
    # The portable zip extracts to a folder like `node-v20.18.0-win-x64/node.exe`.
    for cand in root.glob("node-*/node.exe"):
        return cand
    if (root / "node.exe").exists():
        return root / "node.exe"
    return None


def install_node_portable(log: ProgressFn) -> tuple[bool, str]:
    """Download + extract portable Node.js so the engine can run without a
    system install. Idempotent: short-circuits if a node.exe is already in
    place.
    """
    existing = find_bundled_node()
    if existing:
        return True, f"already installed at {existing}"
    target = node_portable_root()
    log(f"  installing portable Node.js {NODE_PORTABLE_VER} -> {target}")
    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / "node.zip"
        try:
            download(NODE_PORTABLE_URL, zip_path, log, log)
            extract_zip(zip_path, target, log, strip_top_level=False)
        except Exception as e:
            return False, f"download/extract failed: {e}"
    node = find_bundled_node()
    if not node:
        return False, "extracted but node.exe not found at expected path"
    return True, f"portable Node.js installed at {node}"
