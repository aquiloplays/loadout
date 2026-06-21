"""Background check for a newer release on GitHub. Emits a `update_available`
signal if one is found. Non-blocking: failures (offline, rate-limited, no
release page yet) are silent.

The repo URL is configurable via Settings; default points at the Loadout
mono-repo's companion-crowdplay sub-releases tag pattern. Compatible with
the existing companion-streamkey release flow.
"""
from __future__ import annotations
import json
import re
import urllib.request
from typing import Optional

from PySide6.QtCore import QObject, QThread, Signal

from companion_crowdplay import __version__


def _norm(v: str) -> tuple[int, ...]:
    """Cheap semver tuple. '1.2.3' -> (1,2,3); 'v0.1.0-rc1' -> (0,1,0)."""
    nums = re.findall(r"\d+", v or "")
    return tuple(int(x) for x in nums[:3]) if nums else (0,)


class UpdateChecker(QObject):
    update_available = Signal(str, str)  # latest version, html url
    no_update = Signal()
    error = Signal(str)

    def __init__(self, repo: str = "aquiloplays/Loadout",
                 tag_prefix: str = "companion-crowdplay-v"):
        super().__init__()
        self._repo = repo
        self._tag_prefix = tag_prefix
        self._thread: Optional[QThread] = None

    def start(self) -> None:
        self._thread = QThread()
        self.moveToThread(self._thread)
        self._thread.started.connect(self._run)
        self._thread.start()

    def _run(self) -> None:
        try:
            url = f"https://api.github.com/repos/{self._repo}/releases?per_page=12"
            req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
            with urllib.request.urlopen(req, timeout=6) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            self.error.emit(str(e)); self._thread.quit(); return

        # Find newest non-draft release whose tag starts with our prefix.
        candidates = []
        for rel in data:
            if rel.get("draft") or rel.get("prerelease"):
                continue
            tag = rel.get("tag_name") or ""
            if not tag.startswith(self._tag_prefix):
                continue
            candidates.append((tag, rel.get("html_url") or ""))
        if not candidates:
            self.no_update.emit(); self._thread.quit(); return
        candidates.sort(key=lambda t: _norm(t[0]), reverse=True)
        latest_tag, html_url = candidates[0]
        if _norm(latest_tag) > _norm(__version__):
            self.update_available.emit(latest_tag, html_url)
        else:
            self.no_update.emit()
        self._thread.quit()
