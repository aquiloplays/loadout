"""Diagnostics tab + per-effect Test Fire tab.

Polls the engine's HTTP endpoints (/info, /health, /acks, /stats, /manifest)
every 1s and renders:

  - Status grid: engine reachable, adapter heartbeat (alive/stale/dead +
    age), pawn name, world ready, manifest effect count
  - Recent ACKs table (last 20): time, effect, status, msg
  - Per-effect health: ok / skip / error counts since session start
  - "Live log" panel that streams engine stdout

Per-effect Test Fire tab:
  - For each effect in the manifest, render a Fire button + last status pip
  - "Fire all in sequence" button
  - Each button hits localhost:8789/fire (no auth, no Cloudflare).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Optional

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QFrame, QGridLayout, QHBoxLayout, QHeaderView,
    QLabel, QPlainTextEdit, QPushButton, QScrollArea, QSizePolicy, QTableWidget,
    QTableWidgetItem, QVBoxLayout, QWidget,
)


ENGINE_BASE = "http://127.0.0.1:8789"
POLL_MS = 1000
UA = "Mozilla/5.0 AquiloCrowdPlay/2.0"


def _http_get_json(path: str, timeout: float = 2.0):
    req = urllib.request.Request(f"{ENGINE_BASE}{path}",
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _http_post_json(path: str, body: dict, timeout: float = 3.0):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(f"{ENGINE_BASE}{path}", data=data,
                                 headers={"User-Agent": UA,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r) if r.status == 200 else {"err": f"HTTP {r.status}"}


# ─────────────────────────────────────────────────────────────────────
# Status grid pill
# ─────────────────────────────────────────────────────────────────────
class StatusPill(QFrame):
    """Small rounded label that shows state in color."""

    def __init__(self, label: str, parent=None):
        super().__init__(parent)
        self.setFrameShape(QFrame.NoFrame)
        h = QHBoxLayout(self); h.setContentsMargins(10, 6, 10, 6); h.setSpacing(8)
        self._dot = QLabel("●"); self._dot.setStyleSheet("color: #888;")
        self._label = QLabel(label); self._label.setStyleSheet("color: #ccc; font-weight: 500;")
        self._value = QLabel("…"); self._value.setStyleSheet("color: #fff;")
        h.addWidget(self._dot); h.addWidget(self._label); h.addStretch(1); h.addWidget(self._value)
        self.setStyleSheet("StatusPill { background: #2a2a30; border-radius: 8px; }")

    def set_state(self, state: str, value: str):
        colors = {"ok": "#3cb371", "warn": "#e6c84a", "err": "#e0566c", "off": "#888"}
        self._dot.setStyleSheet(f"color: {colors.get(state, '#888')}; font-size: 14px;")
        self._value.setText(value)


# ─────────────────────────────────────────────────────────────────────
# Diagnostics tab
# ─────────────────────────────────────────────────────────────────────
class DiagnosticsTab(QWidget):
    """Engine snapshot + ACK history. Polls every second."""

    def __init__(self, parent=None):
        super().__init__(parent)
        root = QVBoxLayout(self); root.setContentsMargins(16, 16, 16, 16); root.setSpacing(14)

        # Top status grid
        grid = QGridLayout(); grid.setSpacing(10)
        self.pip_engine  = StatusPill("Engine")
        self.pip_adapter = StatusPill("Adapter heartbeat")
        self.pip_world   = StatusPill("World")
        self.pip_pawn    = StatusPill("Pawn")
        self.pip_game    = StatusPill("Game")
        self.pip_effects = StatusPill("Effects")
        grid.addWidget(self.pip_engine,  0, 0); grid.addWidget(self.pip_adapter, 0, 1)
        grid.addWidget(self.pip_world,   1, 0); grid.addWidget(self.pip_pawn,    1, 1)
        grid.addWidget(self.pip_game,    2, 0); grid.addWidget(self.pip_effects, 2, 1)
        root.addLayout(grid)

        # Per-effect health row
        eff_header = QLabel("Per-effect health (this session)")
        eff_header.setStyleSheet("color: #ccc; font-weight: 600; padding-top: 6px;")
        root.addWidget(eff_header)
        self.stats_label = QLabel("(no data yet)")
        self.stats_label.setStyleSheet("color: #aaa; font-family: Consolas, monospace;")
        self.stats_label.setWordWrap(True)
        root.addWidget(self.stats_label)

        # Recent ACKs table
        acks_header = QLabel("Recent fires (newest first)")
        acks_header.setStyleSheet("color: #ccc; font-weight: 600; padding-top: 12px;")
        root.addWidget(acks_header)

        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["Time", "Effect", "Status", "Detail"])
        self.table.verticalHeader().setVisible(False)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.table.setStyleSheet("""
            QTableWidget { background: #1f1f24; color: #ddd; gridline-color: #333; border: 1px solid #333; border-radius: 8px; }
            QHeaderView::section { background: #2a2a30; color: #ccc; padding: 6px; border: none; }
            QTableWidget::item { padding: 4px; }
        """)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setMinimumHeight(180)
        root.addWidget(self.table, stretch=1)

        # ── Engine log tail with filter chips ──────────────────────
        log_header = QLabel("Engine log")
        log_header.setStyleSheet("color: #ccc; font-weight: 600; padding-top: 12px;")
        root.addWidget(log_header)
        chip_row = QHBoxLayout(); chip_row.setSpacing(8)
        self._log_filters: dict[str, QCheckBox] = {}
        # Tag → display label. Engine prefixes every log line with [tag].
        for tag, label in [("FIRE", "Fires"), ("bus", "Bus"), ("tcp", "TCP"),
                            ("http", "HTTP"), ("file", "File"), ("ack", "ACKs"),
                            ("hot-reload", "Reloads"), ("safety", "Safety"),
                            ("crash", "Crashes"), ("watchdog", "Watchdog")]:
            cb = QCheckBox(label); cb.setChecked(True)
            cb.setStyleSheet("color: #ddd;")
            cb.stateChanged.connect(self._rerender_log)
            chip_row.addWidget(cb)
            self._log_filters[tag] = cb
        chip_row.addStretch(1)
        root.addLayout(chip_row)

        self.log_view = QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumBlockCount(500)
        self.log_view.setStyleSheet("""
            QPlainTextEdit { background: #15151a; color: #cdd; border: 1px solid #333;
                              border-radius: 6px; font-family: Consolas, monospace; font-size: 11px;
                              padding: 6px; }
        """)
        self.log_view.setMinimumHeight(140)
        root.addWidget(self.log_view, stretch=1)
        self._log_buffer: list[str] = []

        # Timer
        self._timer = QTimer(self); self._timer.setInterval(POLL_MS); self._timer.timeout.connect(self.refresh)
        self._timer.start()
        self.refresh()

    # Called by MainWindow when the engine emits a stdout line.
    def append_log(self, line: str):
        self._log_buffer.append(line)
        if len(self._log_buffer) > 1000:
            self._log_buffer = self._log_buffer[-800:]
        if self._line_passes_filter(line):
            self.log_view.appendPlainText(line)

    def _line_passes_filter(self, line: str) -> bool:
        # Each engine log starts with one of the known tags like "[bus] ...".
        # If no known tag matches, show by default (unrecognized lines pass).
        for tag, cb in self._log_filters.items():
            needle = f"[{tag}]"
            if needle in line:
                return cb.isChecked()
        return True

    def _rerender_log(self, _state=None):
        self.log_view.clear()
        for line in self._log_buffer:
            if self._line_passes_filter(line):
                self.log_view.appendPlainText(line)

    def refresh(self):
        # Probe /info; if unreachable, mark everything off.
        try:
            info = _http_get_json("/info", timeout=1.5)
        except (urllib.error.URLError, OSError):
            self.pip_engine.set_state("err", "unreachable")
            self.pip_adapter.set_state("off", "(no engine)")
            self.pip_world.set_state("off", "?")
            self.pip_pawn.set_state("off", "?")
            self.pip_game.set_state("off", "?")
            self.pip_effects.set_state("off", "?")
            return
        self.pip_engine.set_state("ok", f"alive on 8789")
        self.pip_game.set_state("ok", f"{info.get('display', '?')} ({info.get('mode', '?')})")
        self.pip_effects.set_state("ok", f"{info.get('effects', 0)} loaded")

        adapter = info.get("adapter") or {}
        status = adapter.get("status", "unknown")
        age = adapter.get("age_ms")
        if status == "alive":
            self.pip_adapter.set_state("ok", f"alive ({age}ms ago)")
        elif status == "stale":
            self.pip_adapter.set_state("warn", f"stale ({age/1000:.1f}s ago)")
        else:
            self.pip_adapter.set_state("err", f"dead (no heartbeat)")

        payload = adapter.get("payload") or {}
        ready = payload.get("world_ready")
        self.pip_world.set_state("ok" if ready else "warn",
                                 "ready" if ready else "not loaded")
        pawn = payload.get("pawn") or "—"
        self.pip_pawn.set_state("ok" if ready else "off", str(pawn)[:48])

        stats = info.get("stats") or {}
        if stats:
            parts = []
            for eff, s in sorted(stats.items()):
                parts.append(f"{eff:18s}  ok={s.get('ok', 0):<3} skip={s.get('skip', 0):<3} err={s.get('error', 0):<3}  last={s.get('lastStatus', '-')}")
            self.stats_label.setText("\n".join(parts))
        else:
            self.stats_label.setText("(no effects dispatched yet)")

        # Recent ACKs
        try:
            acks_resp = _http_get_json("/acks?limit=30", timeout=1.5)
            acks = list(reversed(acks_resp.get("acks", [])))  # newest first
        except Exception:
            acks = []
        self.table.setRowCount(len(acks))
        from datetime import datetime
        for r, a in enumerate(acks):
            ts = a.get("ts") or a.get("_rxTs")
            tstr = datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S") if ts else "-"
            self.table.setItem(r, 0, QTableWidgetItem(tstr))
            self.table.setItem(r, 1, QTableWidgetItem(str(a.get("effect", ""))))
            status_item = QTableWidgetItem(str(a.get("status", "")))
            color = {"ok": "#3cb371", "skip": "#e6c84a", "error": "#e0566c"}.get(a.get("status"), "#aaa")
            status_item.setForeground(Qt.GlobalColor.white)
            from PySide6.QtGui import QBrush, QColor
            status_item.setForeground(QBrush(QColor(color)))
            self.table.setItem(r, 2, status_item)
            self.table.setItem(r, 3, QTableWidgetItem(str(a.get("msg") or "")))


# ─────────────────────────────────────────────────────────────────────
# Per-effect Test Fire tab
# ─────────────────────────────────────────────────────────────────────
class FireTestTab(QWidget):
    """Per-effect Fire buttons + last-status pips. Rebuilds when manifest changes."""

    statusMessage = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        root = QVBoxLayout(self); root.setContentsMargins(16, 16, 16, 16); root.setSpacing(12)

        header_row = QHBoxLayout()
        title = QLabel("Test fire effects")
        title.setStyleSheet("color: #fff; font-size: 18px; font-weight: 600;")
        header_row.addWidget(title); header_row.addStretch(1)

        self.btn_all = QPushButton("Fire all in sequence")
        self.btn_all.setStyleSheet("padding: 6px 14px; background: #3b82f6; color: white; border: none; border-radius: 6px;")
        self.btn_all.clicked.connect(self._fire_all)
        header_row.addWidget(self.btn_all)

        self.btn_refresh = QPushButton("Refresh from engine")
        self.btn_refresh.setStyleSheet("padding: 6px 14px; background: #444; color: white; border: none; border-radius: 6px;")
        self.btn_refresh.clicked.connect(self.refresh)
        header_row.addWidget(self.btn_refresh)

        root.addLayout(header_row)

        sub = QLabel("Each button hits the engine's local /fire endpoint (no auth, no Cloudflare). Result pill below shows the adapter's ACK status.")
        sub.setStyleSheet("color: #aaa;")
        sub.setWordWrap(True)
        root.addWidget(sub)

        # Scrollable grid of effect rows
        self.scroll = QScrollArea(); self.scroll.setWidgetResizable(True)
        self.scroll.setStyleSheet("QScrollArea { background: transparent; border: none; }")
        self.container = QWidget(); self.container.setStyleSheet("background: transparent;")
        self.grid = QVBoxLayout(self.container); self.grid.setSpacing(8); self.grid.setContentsMargins(0, 0, 0, 0)
        self.scroll.setWidget(self.container)
        root.addWidget(self.scroll, stretch=1)

        self._rows: dict[str, dict] = {}
        self._effects: list[dict] = []

        # Refresh periodically so the ACK pips stay current.
        self._timer = QTimer(self); self._timer.setInterval(1500); self._timer.timeout.connect(self._update_pips)
        self._timer.start()
        self.refresh()

    def refresh(self):
        try:
            mfst = _http_get_json("/manifest", timeout=1.5)
        except Exception:
            self.statusMessage.emit("Engine not reachable - start the session first.")
            return
        self._effects = mfst.get("effects") or []
        # Tear down + rebuild rows.
        while self.grid.count():
            item = self.grid.takeAt(0)
            w = item.widget()
            if w: w.deleteLater()
        self._rows.clear()
        for eff in self._effects:
            self._add_row(eff)
        self.grid.addStretch(1)
        self._update_pips()

    def _add_row(self, eff: dict):
        row = QFrame(); row.setStyleSheet("QFrame { background: #2a2a30; border-radius: 8px; }")
        h = QHBoxLayout(row); h.setContentsMargins(12, 8, 12, 8); h.setSpacing(10)

        label_col = QVBoxLayout(); label_col.setSpacing(2)
        name = QLabel(eff.get("label", eff["id"]))
        name.setStyleSheet("color: #fff; font-weight: 600;")
        # Per-effect metadata sub-line. Tier and one-shot badges surface
        # gating info so the streamer knows what's premium at a glance.
        tier = eff.get("tier", "free")
        badges = []
        if tier and tier != "free": badges.append(f"[{tier.upper()}]")
        if eff.get("oneShotPerStream"): badges.append("[ONE-SHOT]")
        if eff.get("scaleByBits"): badges.append("[BITS-SCALED]")
        meta = (f"id: {eff['id']}  •  cooldown: {eff.get('cooldownSec', 0)}s  "
                f"•  cost: {eff.get('costBolts', 0)} bolts")
        if badges: meta = " ".join(badges) + "  " + meta
        sub = QLabel(meta); sub.setStyleSheet("color: #888; font-size: 11px;")
        label_col.addWidget(name); label_col.addWidget(sub)
        h.addLayout(label_col, stretch=1)

        # Tooltip with description (CC's source-of-truth blurb) + meta.
        description = (eff.get("description") or "").strip()
        params_text = ", ".join(f"{k}={v}" for k, v in (eff.get("params") or {}).items()) or "no params"
        category = eff.get("category") or ""
        tooltip_parts = [f"<b>{eff.get('label', eff['id'])}</b>"]
        if description:
            tooltip_parts.append(f"<i>{description}</i>")
        tooltip_parts.append(f"id: <code>{eff['id']}</code>")
        if category:
            tooltip_parts.append(f"category: {category}")
        tooltip_parts.append(f"params: {params_text}")
        tooltip_parts.append(f"weight: {eff.get('weight', 0)} (higher = appears more in vote pool)")
        tooltip_parts.append(f"cooldown: {eff.get('cooldownSec', 0)}s")
        tooltip_parts.append(f"cost: {eff.get('costBolts', 0)} bolts")
        tooltip_parts.append(f"tier: {tier}")
        row.setToolTip("<br>".join(tooltip_parts))

        pip = QLabel("never fired"); pip.setStyleSheet("color: #888; padding: 4px 10px;")
        h.addWidget(pip)

        fire_btn = QPushButton("Fire")
        fire_btn.setStyleSheet("padding: 6px 18px; background: #3b82f6; color: white; border: none; border-radius: 6px;")
        fire_btn.clicked.connect(lambda _, eid=eff["id"]: self._fire_one(eid))
        h.addWidget(fire_btn)

        self.grid.addWidget(row)
        self._rows[eff["id"]] = {"pip": pip, "row": row}

    _suppress_unsafe_warning = False

    def _fire_one(self, effect_id: str):
        # online-safe check: if the engine's manifest has online_safe=false
        # AND the user hasn't dismissed the warning this session, show a
        # one-time confirmation before firing. The point isn't to nag - it's
        # to stop a "fired in online lobby" mistake from happening once.
        try:
            mfst = _http_get_json("/manifest", timeout=1.0)
            is_online_safe = mfst.get("online_safe", True)
        except Exception:
            is_online_safe = True

        if not is_online_safe and not FireTestTab._suppress_unsafe_warning:
            from PySide6.QtWidgets import QMessageBox, QCheckBox
            box = QMessageBox(self)
            box.setIcon(QMessageBox.Warning)
            box.setWindowTitle("Online-mode warning")
            box.setText("This game's manifest is marked NOT online_safe.")
            box.setInformativeText(
                "Memory writes / hooks may be detected by anti-cheat (EAC, "
                "BattlEye, etc.) or break online lobbies. Use in single-player / "
                "offline only.\n\nFire anyway?"
            )
            box.setStandardButtons(QMessageBox.Cancel | QMessageBox.Yes)
            box.setDefaultButton(QMessageBox.Cancel)
            cb = QCheckBox("Don't warn me again this session"); box.setCheckBox(cb)
            r = box.exec()
            if cb.isChecked():
                FireTestTab._suppress_unsafe_warning = True
            if r != QMessageBox.Yes:
                self.statusMessage.emit(f"Cancelled fire of '{effect_id}' (online unsafe).")
                return

        try:
            r = _http_post_json("/fire", {"effect": effect_id, "user": "fire-tab"}, timeout=3.0)
            if r.get("ok"):
                self.statusMessage.emit(f"Fired '{effect_id}' (id={r.get('id')})")
            else:
                self.statusMessage.emit(f"Fire failed: {r.get('err', 'unknown')}")
        except Exception as e:
            self.statusMessage.emit(f"Fire failed: {e}")

    def _fire_all(self):
        if not self._effects:
            self.statusMessage.emit("No effects to fire - refresh from engine first.")
            return
        # Stagger 1500ms apart so each effect has time to ACK before the next fires.
        for i, eff in enumerate(self._effects):
            QTimer.singleShot(i * 1500, lambda eid=eff["id"]: self._fire_one(eid))

    def _update_pips(self):
        try:
            stats_resp = _http_get_json("/stats", timeout=1.0)
            stats = stats_resp.get("stats", {})
        except Exception:
            return
        for eid, row in self._rows.items():
            s = stats.get(eid)
            if not s:
                row["pip"].setText("never fired")
                row["pip"].setStyleSheet("color: #888; padding: 4px 10px;")
                continue
            last = s.get("lastStatus")
            ok = s.get("ok", 0); skip = s.get("skip", 0); err = s.get("error", 0)
            color = {"ok": "#3cb371", "skip": "#e6c84a", "error": "#e0566c"}.get(last, "#aaa")
            row["pip"].setText(f"{last or '-'}  •  ok {ok} / skip {skip} / err {err}")
            row["pip"].setStyleSheet(
                f"color: {color}; background: #1f1f24; border: 1px solid #333; "
                f"border-radius: 6px; padding: 4px 10px;")
