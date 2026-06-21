"""One-click connection wizard.

Runs every wire-up check in sequence and surfaces a single dialog with
results: which links are up, which are down, what to do about each. Saves
the user from chasing individual error messages across multiple tabs.

Checks performed:
  - Node.js installed and reachable
  - Engine project root resolved
  - Each engine port free (8787/8788/8789) - or already in use BY us
  - Relay URL reachable + token accepted (HTTP 200 on /web/crowdplay/active)
  - Engine /info reachable (if engine is running)
  - Adapter heartbeat alive (if engine is running)
  - Twitch chat configured (channel set)
  - TikTok configured (username set)
"""
from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

from PySide6.QtCore import Qt, QSettings, QTimer
from PySide6.QtWidgets import (
    QDialog, QFrame, QHBoxLayout, QLabel, QPushButton, QScrollArea,
    QVBoxLayout, QWidget,
)


UA = "Mozilla/5.0 AquiloCrowdPlay/2.0"


@dataclass
class CheckResult:
    name: str
    state: str          # "ok" | "warn" | "err" | "off"
    message: str
    hint: Optional[str] = None


def _port_in_use(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _http_json_safe(url: str, timeout: float = 2.5, headers: Optional[dict] = None,
                    method: str = "GET", body: Optional[bytes] = None):
    try:
        req = urllib.request.Request(url, data=body,
            headers={"User-Agent": UA, **(headers or {})}, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r) if "application/json" in (r.headers.get_content_type() or "") else None
    except Exception as e:
        return None, str(e)


def run_checks(settings: QSettings, project_root: Optional[str]) -> list[CheckResult]:
    out: list[CheckResult] = []

    # Node.js
    try:
        from companion_crowdplay.detect import node_available
        v = node_available()
        if v:
            out.append(CheckResult("Node.js", "ok", f"installed {v}"))
        else:
            out.append(CheckResult("Node.js", "err",
                "not found on PATH and no bundled portable Node",
                "Settings -> Install bundled Node, or install from nodejs.org"))
    except Exception as e:
        out.append(CheckResult("Node.js", "err", f"detect failed: {e}"))

    # Project root
    if project_root and (project_root.rstrip("/\\")):
        from pathlib import Path
        p = Path(project_root)
        if (p / "src" / "index.js").exists():
            out.append(CheckResult("Engine source", "ok", str(p)))
        else:
            out.append(CheckResult("Engine source", "err",
                f"src/index.js missing under {p}",
                "Setup tab -> Install everything"))
    else:
        out.append(CheckResult("Engine source", "warn",
            "no project root configured",
            "Setup tab -> Install everything (auto-resolves the path)"))

    # Engine ports
    engine_up = _port_in_use(8787) and _port_in_use(8788) and _port_in_use(8789)
    if engine_up:
        out.append(CheckResult("Engine ports", "ok", "8787/8788/8789 all bound (engine running)"))
    else:
        held = [p for p in (8787, 8788, 8789) if _port_in_use(p)]
        if held:
            out.append(CheckResult("Engine ports", "warn",
                f"partially bound: {held}",
                "Stop session, then run cleanup.ps1 if any ports are stuck"))
        else:
            out.append(CheckResult("Engine ports", "off",
                "all free (engine not started)",
                "click Start session on the Stream tab"))

    # Engine /info (live engine introspection)
    if engine_up:
        status, body = _http_json_safe("http://127.0.0.1:8789/info", timeout=2)
        if status == 200 and isinstance(body, dict):
            out.append(CheckResult("Engine /info", "ok",
                f"{body.get('display', '?')} ({body.get('mode', '?')}), {body.get('effects', 0)} effects"))
            adapter = body.get("adapter") or {}
            adapter_status = adapter.get("status", "unknown")
            if adapter_status == "alive":
                out.append(CheckResult("Adapter heartbeat", "ok",
                    f"alive ({adapter.get('age_ms')}ms ago)"))
            elif adapter_status == "stale":
                out.append(CheckResult("Adapter heartbeat", "warn",
                    f"stale ({adapter.get('age_ms')}ms ago)",
                    "Game's in a menu or paused; effects requiring world will skip"))
            else:
                out.append(CheckResult("Adapter heartbeat", "off",
                    "dead (no game running)",
                    "Launch the target game to load the in-game adapter"))
        else:
            out.append(CheckResult("Engine /info", "err",
                f"engine bound but /info failed: {body}",
                "Engine may be from an older bundle - restart session"))

    # Worker / relay
    url = (settings.value("crowdplay/ext_url", "") or "").strip()
    tok = (settings.value("crowdplay/ext_token", "") or "").strip()
    if url:
        status, body = _http_json_safe(url.rstrip("/") + "/web/crowdplay/active", timeout=4)
        if status == 200:
            out.append(CheckResult("Worker relay (read)", "ok", f"{url} -> {status}"))
        else:
            out.append(CheckResult("Worker relay (read)", "err",
                f"{url} unreachable: {body}",
                "Check that the worker is deployed and the URL is right"))
        # Verify token by hitting an authed endpoint
        if tok:
            data = json.dumps({"kind": "noop"}).encode()
            status, body = _http_json_safe(url.rstrip("/") + "/web/crowdplay/control",
                timeout=4, method="POST",
                headers={"Content-Type": "application/json", "x-crowdplay-token": tok},
                body=data)
            if status == 200:
                out.append(CheckResult("Worker token", "ok", "accepted"))
            elif status == 401:
                out.append(CheckResult("Worker token", "err",
                    "rejected (HTTP 401)",
                    "Token mismatch; Settings -> Relay token must match worker CROWDPLAY_TOKEN env var"))
            elif status == 403:
                out.append(CheckResult("Worker token", "warn",
                    "Cloudflare bot mitigation (403)",
                    "Test fire uses local /fire as a fallback, so this is non-fatal"))
            else:
                out.append(CheckResult("Worker token", "warn",
                    f"HTTP {status} {body}",
                    "Worker accepted but didn't auth; check worker logs"))
        else:
            out.append(CheckResult("Worker token", "off", "not set",
                "Settings -> Relay token (only needed for Twitch panel buy mode)"))
    else:
        out.append(CheckResult("Worker relay", "off",
            "no URL configured",
            "Settings -> Relay URL (only needed for Twitch panel buy mode)"))

    # Ingestion configs
    twitch = (settings.value("crowdplay/twitch", "") or "").strip()
    if twitch:
        out.append(CheckResult("Twitch chat", "ok", f"#{twitch.lstrip('#')}"))
    else:
        out.append(CheckResult("Twitch chat", "off", "channel not set",
            "Settings -> Twitch channel (required for vote-mode chat)"))

    tiktok = (settings.value("crowdplay/tiktok", "") or "").strip()
    if tiktok:
        out.append(CheckResult("TikTok", "ok", f"@{tiktok.lstrip('@')}"))
    else:
        out.append(CheckResult("TikTok", "off", "username not set",
            "Settings -> TikTok username (only needed for TikTok gifts)"))

    return out


class ConnectionWizardDialog(QDialog):
    def __init__(self, settings: QSettings, project_root: Optional[str], parent=None):
        super().__init__(parent)
        self.setWindowTitle("Connection wizard")
        self.resize(720, 520)
        self.settings = settings
        self.project_root = project_root

        root = QVBoxLayout(self)
        root.setSpacing(10)

        title = QLabel("Connection wizard")
        title.setStyleSheet("color: #fff; font-size: 18px; font-weight: 700;")
        root.addWidget(title)
        sub = QLabel("Runs every wire-up check. Click Re-run to refresh after a fix.")
        sub.setStyleSheet("color: #aaa;")
        root.addWidget(sub)

        # Scroll area for results
        self.scroll = QScrollArea(); self.scroll.setWidgetResizable(True)
        self.scroll.setStyleSheet("QScrollArea { background: transparent; border: none; }")
        self.container = QWidget(); self.container.setStyleSheet("background: transparent;")
        self.results_layout = QVBoxLayout(self.container)
        self.results_layout.setSpacing(8); self.results_layout.setContentsMargins(0, 0, 0, 0)
        self.scroll.setWidget(self.container)
        root.addWidget(self.scroll, stretch=1)

        # Buttons
        row = QHBoxLayout()
        self.summary = QLabel(""); self.summary.setStyleSheet("color: #ddd;")
        row.addWidget(self.summary); row.addStretch(1)
        self.btn_run = QPushButton("Re-run checks")
        self.btn_run.setStyleSheet("padding: 6px 18px; background: #3b82f6; color: white; border: none; border-radius: 6px;")
        self.btn_run.clicked.connect(self.run)
        row.addWidget(self.btn_run)
        close_btn = QPushButton("Close")
        close_btn.setStyleSheet("padding: 6px 18px; background: #444; color: white; border: none; border-radius: 6px;")
        close_btn.clicked.connect(self.accept)
        row.addWidget(close_btn)
        root.addLayout(row)

        # Run on open
        QTimer.singleShot(0, self.run)

    def run(self):
        # Clear
        while self.results_layout.count():
            item = self.results_layout.takeAt(0)
            w = item.widget()
            if w: w.deleteLater()
        results = run_checks(self.settings, self.project_root)
        ok = sum(1 for r in results if r.state == "ok")
        warn = sum(1 for r in results if r.state == "warn")
        err = sum(1 for r in results if r.state == "err")
        for r in results:
            self.results_layout.addWidget(self._build_row(r))
        self.results_layout.addStretch(1)
        self.summary.setText(f"  {ok} ok  •  {warn} warning  •  {err} error")

    def _build_row(self, r: CheckResult) -> QWidget:
        row = QFrame()
        row.setStyleSheet("QFrame { background: #2a2a30; border-radius: 8px; }")
        h = QHBoxLayout(row); h.setContentsMargins(14, 10, 14, 10); h.setSpacing(12)
        colors = {"ok": "#3cb371", "warn": "#e6c84a", "err": "#e0566c", "off": "#888"}
        dot = QLabel("●"); dot.setStyleSheet(f"color: {colors.get(r.state, '#888')}; font-size: 18px;")
        h.addWidget(dot)
        col = QVBoxLayout(); col.setSpacing(3)
        name = QLabel(r.name); name.setStyleSheet("color: #fff; font-weight: 600;")
        msg = QLabel(r.message); msg.setStyleSheet("color: #ddd;"); msg.setWordWrap(True)
        col.addWidget(name); col.addWidget(msg)
        if r.hint:
            hint = QLabel(r.hint); hint.setStyleSheet("color: #f7c25c; font-size: 11px;")
            hint.setWordWrap(True)
            col.addWidget(hint)
        h.addLayout(col, stretch=1)
        return row
