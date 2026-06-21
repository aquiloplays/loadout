r"""Main window. Tab-based layout, one screen per task.

  +-------------------------------------------------------+
  |  [Logo]  Aquilo CrowdPlay                  [_] [#] [X]|
  +-------------------------------------------------------+
  |  Stream | Setup | Effects | Triggers | Activity | Tools|
  +-------------------------------------------------------+
  |                                                       |
  |               ( tab body )                            |
  |                                                       |
  +-------------------------------------------------------+
  |  [Settings]   v0.1.0   Engine: running                |
  +-------------------------------------------------------+

The window registers a stable AppUserModelID + WM_CLASS so Windows can pin
it to the taskbar without bucketing it with the parent Python interpreter.
"""

from __future__ import annotations
import os
import sys
import webbrowser
from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, QSettings, QTimer, QUrl
from PySide6.QtGui import QAction, QColor, QFont, QIcon, QPainter, QPixmap, QDesktopServices
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDialog, QDialogButtonBox, QFileDialog, QFormLayout,
    QFrame, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMessageBox,
    QPlainTextEdit, QPushButton, QScrollArea, QSizePolicy, QSpacerItem,
    QStatusBar, QSystemTrayIcon, QTabWidget, QToolButton, QVBoxLayout, QWidget,
)

from companion_crowdplay import APP_NAME, ORG_NAME, __version__
from companion_crowdplay.customize import CustomizePanel
from companion_crowdplay.one_click import OneClickInstallDialog
from companion_crowdplay.games import CATALOG, BY_SLUG, Game, HARNESS_NOTES
from companion_crowdplay.detect import (
    InstallStatus, check_install, check_pymem_installed,
    guess_project_root, node_available,
)
from companion_crowdplay.engine import EngineController, EngineStatus
from companion_crowdplay.first_run import FirstRunWizard, needs_first_run
from companion_crowdplay.install_dialog import InstallDialog
from companion_crowdplay.theme import QSS
from companion_crowdplay.update_check import UpdateChecker
from companion_crowdplay.win_job import (
    find_pid_on_port, free_ports_elevated, port_in_use,
)


# ── settings keys ──────────────────────────────────────────────────────
K_PROJECT_ROOT  = "project_root"
K_LAST_GAME     = "last_game"
K_TWITCH        = "twitch_channel"
K_TIKTOK        = "tiktok_username"
K_PAID_BITS_MIN = "paid_vote_bits_min"
K_PAID_GIFT_MIN = "paid_vote_gift_diamonds_min"
K_EXT_URL       = "ext_relay_url"
K_EXT_TOKEN     = "ext_relay_token"
K_GAME_DIR      = "game_dir/{slug}"
K_MODE          = "crowdplay_mode"


# ── helpers ────────────────────────────────────────────────────────────
def make_icon(size: int = 64) -> QIcon:
    """Load the bundled logo PNG (PyInstaller-aware) with a runtime-drawn
    fallback for editable installs that lack the asset."""
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "companion_crowdplay" / "assets" / "logo.png")
    candidates.append(Path(__file__).resolve().parent / "assets" / "logo.png")
    for p in candidates:
        if p.exists():
            return QIcon(str(p))
    pm = QPixmap(size, size)
    pm.fill(Qt.GlobalColor.transparent)
    pp = QPainter(pm)
    pp.setRenderHint(QPainter.RenderHint.Antialiasing)
    pp.setBrush(QColor("#0A0B12")); pp.setPen(Qt.PenStyle.NoPen)
    pp.drawRoundedRect(2, 2, size - 4, size - 4, size * 0.22, size * 0.22)
    pp.setBrush(QColor("#9a82ff"))
    bolt = [(37, 8), (17, 38), (29, 38), (25, 56), (47, 26), (35, 26)]
    from PySide6.QtGui import QPolygon
    from PySide6.QtCore import QPoint
    poly = QPolygon([QPoint(int(x / 64 * size), int(y / 64 * size)) for x, y in bolt])
    pp.drawPolygon(poly); pp.end()
    return QIcon(pm)


def hr() -> QFrame:
    f = QFrame(); f.setObjectName("hr"); f.setFrameShape(QFrame.Shape.NoFrame)
    return f


def card(*, accent: bool = False) -> tuple[QFrame, QVBoxLayout]:
    f = QFrame(); f.setObjectName("cardAccent" if accent else "card")
    v = QVBoxLayout(f); v.setContentsMargins(20, 18, 20, 20); v.setSpacing(12)
    return f, v


def section_title(text: str) -> QLabel:
    lbl = QLabel(text); lbl.setObjectName("h2")
    return lbl


def big_title(text: str) -> QLabel:
    lbl = QLabel(text); lbl.setObjectName("h1")
    return lbl


def check_row(text: str, state: str = "off", detail: str = "") -> tuple[QWidget, QLabel, QLabel]:
    """One row in the install-checklist style. Returns (widget, glyph, text_label)."""
    w = QWidget(); w.setObjectName("checkRow")
    outer_v = QVBoxLayout(w); outer_v.setContentsMargins(0, 0, 0, 0); outer_v.setSpacing(2)
    top = QHBoxLayout(); top.setContentsMargins(0, 0, 0, 0); top.setSpacing(10)
    glyph = QLabel("●"); glyph.setObjectName("checkMark"); glyph.setProperty("state", state)
    title = QLabel(text); title.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
    title.setWordWrap(True)
    top.addWidget(glyph); top.addWidget(title, 1)
    outer_v.addLayout(top)
    if detail:
        d = QLabel(detail); d.setObjectName("sub"); d.setWordWrap(True)
        d.setContentsMargins(32, 0, 0, 0)  # indent under the glyph
        outer_v.addWidget(d)
    glyph.style().unpolish(glyph); glyph.style().polish(glyph)
    return w, glyph, title


def set_check(glyph: QLabel, state: str) -> None:
    glyph.setText({"ok": "✓", "err": "✗", "warn": "!", "off": "•"}.get(state, "•"))
    glyph.setProperty("state", state)
    glyph.style().unpolish(glyph); glyph.style().polish(glyph)


def badge(text: str, state: str = "off") -> QLabel:
    b = QLabel(text); b.setObjectName("badge"); b.setProperty("state", state)
    b.style().unpolish(b); b.style().polish(b)
    return b


# ── Settings dialog ────────────────────────────────────────────────────
class SettingsDialog(QDialog):
    def __init__(self, settings: QSettings, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Settings")
        self.resize(560, 420)
        self.settings = settings

        form = QFormLayout(self); form.setSpacing(12); form.setContentsMargins(20, 20, 20, 20)

        self.project_edit = QLineEdit(settings.value(K_PROJECT_ROOT, "") or "")
        proj_row = QWidget(); pr = QHBoxLayout(proj_row); pr.setContentsMargins(0, 0, 0, 0)
        pr.addWidget(self.project_edit, 1)
        b = QPushButton("Browse..."); b.setObjectName("ghost")
        b.clicked.connect(self._pick_project); pr.addWidget(b)
        form.addRow("Engine folder:", proj_row)

        self.twitch_edit = QLineEdit(settings.value(K_TWITCH, "") or "")
        self.twitch_edit.setPlaceholderText("prodigalttv")
        form.addRow("Twitch channel:", self.twitch_edit)

        self.tiktok_edit = QLineEdit(settings.value(K_TIKTOK, "") or "")
        self.tiktok_edit.setPlaceholderText("(blank = TikTok off)")
        form.addRow("TikTok handle:", self.tiktok_edit)

        self.ext_url_edit = QLineEdit(settings.value(K_EXT_URL, "https://loadout-discord.aquiloplays.workers.dev") or "")
        form.addRow("Relay URL:", self.ext_url_edit)

        self.ext_tok_edit = QLineEdit(settings.value(K_EXT_TOKEN, "") or "")
        self.ext_tok_edit.setEchoMode(QLineEdit.EchoMode.Password)
        form.addRow("Relay token:", self.ext_tok_edit)

        # ── Paid-vote mode thresholds ───────────────────────────────
        # When MODE=paid-vote, bits >= this OR gift diamonds >= this open
        # a vote round (with the sponsor credited on the overlay).
        from PySide6.QtWidgets import QSpinBox
        self.paid_bits = QSpinBox()
        self.paid_bits.setRange(1, 100000)
        self.paid_bits.setValue(int(settings.value(K_PAID_BITS_MIN, 100) or 100))
        self.paid_bits.setSuffix("  bits  (Twitch)")
        form.addRow("Paid-vote bits min:", self.paid_bits)
        self.paid_diamonds = QSpinBox()
        self.paid_diamonds.setRange(1, 100000)
        self.paid_diamonds.setValue(int(settings.value(K_PAID_GIFT_MIN, 30) or 30))
        self.paid_diamonds.setSuffix("  diamonds  (TikTok gift)")
        form.addRow("Paid-vote gift min:", self.paid_diamonds)
        hint = QLabel("Used only when Mode is set to 'paid-vote'. Free-running modes ignore these.")
        hint.setStyleSheet("color: #888; font-size: 11px;")
        hint.setWordWrap(True)
        form.addRow("", hint)

        bb = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        bb.accepted.connect(self._save); bb.rejected.connect(self.reject)
        form.addRow(bb)

    def _pick_project(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "Pick engine folder",
                                             self.project_edit.text() or str(Path.home()))
        if d: self.project_edit.setText(d)

    def _save(self) -> None:
        self.settings.setValue(K_PROJECT_ROOT, self.project_edit.text().strip())
        self.settings.setValue(K_TWITCH, self.twitch_edit.text().strip())
        self.settings.setValue(K_TIKTOK, self.tiktok_edit.text().strip())
        self.settings.setValue(K_EXT_URL, self.ext_url_edit.text().strip())
        self.settings.setValue(K_EXT_TOKEN, self.ext_tok_edit.text().strip())
        self.settings.setValue(K_PAID_BITS_MIN, int(self.paid_bits.value()))
        self.settings.setValue(K_PAID_GIFT_MIN, int(self.paid_diamonds.value()))
        self.accept()


# ── Main window ────────────────────────────────────────────────────────
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(1120, 880)
        self.setMinimumSize(900, 740)

        self.settings = QSettings(ORG_NAME, APP_NAME)
        self.engine = EngineController(self)
        self.engine.status_changed.connect(self._on_status)
        self.engine.exited.connect(self._on_exit)
        self.engine.log.connect(self._append_log)

        self._build_ui()
        self._populate_games()
        self._restore_last_game()
        self._refresh_install_status()
        self._refresh_runtime_status()

        self._tray = self._build_tray()
        self._update_checker = None
        QTimer.singleShot(1500, self._check_for_updates)

    # ── UI build ──────────────────────────────────────────────────────
    def _build_ui(self) -> None:
        central = QWidget(); central.setObjectName("central")
        outer = QVBoxLayout(central); outer.setContentsMargins(26, 20, 26, 16); outer.setSpacing(14)

        # Header row
        head = QHBoxLayout(); head.setSpacing(12)
        bolt = QLabel(); bolt.setPixmap(make_icon(64).pixmap(36, 36))
        head.addWidget(bolt)
        title_wrap = QVBoxLayout(); title_wrap.setSpacing(0); title_wrap.setContentsMargins(0, 0, 0, 0)
        t1 = big_title(APP_NAME); t1.setObjectName("h1")
        t2 = QLabel(f"v{__version__}  ·  Viewer-driven game effects"); t2.setObjectName("sub")
        title_wrap.addWidget(t1); title_wrap.addWidget(t2)
        head.addLayout(title_wrap)
        head.addStretch()
        # Top-right runtime badge (Running / Idle / Crashed)
        self.runtime_badge = badge("Idle", "off")
        head.addWidget(self.runtime_badge)
        outer.addLayout(head)

        # Main tabs
        self.main_tabs = QTabWidget(); self.main_tabs.setObjectName("mainTabs")
        self.main_tabs.setDocumentMode(True)
        self.main_tabs.addTab(self._build_stream_tab(),   "Stream")
        self.main_tabs.addTab(self._build_setup_tab(),    "Setup")
        self.main_tabs.addTab(self._build_effects_tab(),  "Effects")
        self.main_tabs.addTab(self._build_triggers_tab(), "Triggers")
        # Live diagnostics + per-effect Fire (added in the reliability stack).
        # The Companion polls the engine's /info /health /acks /stats so the
        # user sees what's actually firing in-game without log-diving.
        from companion_crowdplay.diagnostics import DiagnosticsTab, FireTestTab
        self.diag_tab = DiagnosticsTab(self)
        self.fire_tab = FireTestTab(self)
        self.fire_tab.statusMessage.connect(lambda s: self.statusBar().showMessage(s, 4000))
        self.main_tabs.addTab(self.diag_tab, "Diagnostics")
        self.main_tabs.addTab(self.fire_tab, "Test Fire")
        self.main_tabs.addTab(self._build_activity_tab(), "Activity")
        self.main_tabs.addTab(self._build_tools_tab(),    "Tools")
        outer.addWidget(self.main_tabs, 1)

        # Footer
        foot = QHBoxLayout(); foot.setSpacing(10)
        b_settings = QPushButton("Settings"); b_settings.setObjectName("ghost"); b_settings.clicked.connect(self._open_settings)
        foot.addWidget(b_settings)
        ver = QLabel(f"v{__version__}"); ver.setObjectName("sub"); ver.setStyleSheet("color: #6b6f86;")
        foot.addWidget(ver)
        foot.addStretch()
        self.footer_status = QLabel(""); self.footer_status.setObjectName("sub")
        foot.addWidget(self.footer_status)
        outer.addLayout(foot)

        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar()); self.statusBar().hide()

    # ── Stream tab ────────────────────────────────────────────────────
    def _build_stream_tab(self) -> QWidget:
        wrap = QWidget(); v = QVBoxLayout(wrap); v.setContentsMargins(4, 18, 4, 0); v.setSpacing(22)

        # ── Game + mode card (accented hero) ──────────────────────────
        gc, gv = card(accent=True)
        gv.setSpacing(16)
        gv.addWidget(section_title("Now playing"))
        row = QHBoxLayout(); row.setSpacing(16)
        self.game_combo = QComboBox(); self.game_combo.setObjectName("hero")
        self.game_combo.currentIndexChanged.connect(self._on_game_changed)
        row.addWidget(self.game_combo, 1)
        mode_lbl = QLabel("Mode"); mode_lbl.setObjectName("micro")
        self.mode_combo = QComboBox()
        # paid-vote: rounds open only when a viewer pays (bits/gifts above
        # threshold). Tunes thresholds in Settings.
        for m, label in (
            ("vote", "Vote"),
            ("buy", "Buy"),
            ("mixed", "Mixed"),
            ("paid-vote", "Paid Vote"),
        ):
            self.mode_combo.addItem(label, m)
        self.mode_combo.currentIndexChanged.connect(self._on_mode_changed)
        cur_mode = (self.settings.value(K_MODE, "vote") or "vote").lower()
        for i in range(self.mode_combo.count()):
            if self.mode_combo.itemData(i) == cur_mode: self.mode_combo.setCurrentIndex(i); break
        mode_wrap = QVBoxLayout(); mode_wrap.setSpacing(4); mode_wrap.setContentsMargins(0, 0, 0, 0)
        mode_wrap.addWidget(mode_lbl); mode_wrap.addWidget(self.mode_combo)
        row.addLayout(mode_wrap)
        gv.addLayout(row)
        v.addWidget(gc)

        # ── Big Start/Stop card ───────────────────────────────────────
        bc, bv = card(); bv.setSpacing(20)
        actions = QHBoxLayout(); actions.setSpacing(14)
        self.btn_start = QPushButton("▶  Start session"); self.btn_start.setObjectName("hero")
        self.btn_start.clicked.connect(self._start)
        self.btn_stop = QPushButton("■  Stop"); self.btn_stop.setObjectName("stop")
        self.btn_stop.setEnabled(False); self.btn_stop.clicked.connect(self._stop)
        actions.addWidget(self.btn_start, 1); actions.addWidget(self.btn_stop)
        bv.addLayout(actions)
        v.addWidget(bc)

        # ── Status: 2x2 grid for breathing room ──────────────────────
        sc, sv = card(); sv.setSpacing(14)
        sv.addWidget(section_title("Status"))
        grid = QGridLayout(); grid.setSpacing(14); grid.setContentsMargins(0, 0, 0, 0)
        self._pip_engine  = self._pip_with_label("Engine", "Idle")
        self._pip_adapter = self._pip_with_label("Adapter", "—")
        self._pip_relay   = self._pip_with_label("Relay", "—")
        self._pip_token   = self._pip_with_label("Token", "—")
        # 2 columns x 2 rows
        grid.addWidget(self._pip_engine["w"],  0, 0)
        grid.addWidget(self._pip_adapter["w"], 0, 1)
        grid.addWidget(self._pip_relay["w"],   1, 0)
        grid.addWidget(self._pip_token["w"],   1, 1)
        grid.setColumnStretch(0, 1); grid.setColumnStretch(1, 1)
        sv.addLayout(grid)
        v.addWidget(sc)

        # ── Recent activity ──────────────────────────────────────────
        rc, rv = card(); rv.setSpacing(10)
        h = QHBoxLayout(); h.addWidget(section_title("Recent activity")); h.addStretch()
        b_view = QPushButton("Open Activity tab"); b_view.setObjectName("ghost")
        b_view.clicked.connect(lambda: self.main_tabs.setCurrentIndex(4))
        h.addWidget(b_view)
        rv.addLayout(h)
        self.recent_log = QPlainTextEdit(); self.recent_log.setObjectName("log"); self.recent_log.setReadOnly(True)
        self.recent_log.setMaximumBlockCount(50); self.recent_log.setFixedHeight(120)
        rv.addWidget(self.recent_log)
        v.addWidget(rc)

        v.addStretch()
        scroll = QScrollArea(); scroll.setWidget(wrap); scroll.setWidgetResizable(True); scroll.setFrameShape(QFrame.Shape.NoFrame)
        return scroll

    def _pip_with_label(self, title: str, sub: str) -> dict:
        w = QFrame(); w.setObjectName("card")
        h = QVBoxLayout(w); h.setContentsMargins(20, 16, 20, 16); h.setSpacing(8)
        top = QHBoxLayout(); top.setSpacing(10)
        dot = QFrame(); dot.setObjectName("pip"); dot.setProperty("state", "off"); dot.setFixedSize(14, 14)
        top.addWidget(dot)
        lbl = QLabel(title); lbl.setStyleSheet("font-size: 11px; color: #aeb0c4; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 800;")
        top.addWidget(lbl); top.addStretch()
        h.addLayout(top)
        sublbl = QLabel(sub); sublbl.setStyleSheet("color: #f5f6fb; font-size: 16px; font-weight: 700;")
        sublbl.setWordWrap(True)
        h.addWidget(sublbl)
        return {"w": w, "dot": dot, "sub": sublbl, "title": lbl}

    def _set_pip(self, slot: dict, state: str, sub_text: str) -> None:
        slot["dot"].setProperty("state", state)
        slot["dot"].style().unpolish(slot["dot"]); slot["dot"].style().polish(slot["dot"])
        slot["sub"].setText(sub_text)

    # ── Setup tab ─────────────────────────────────────────────────────
    def _build_setup_tab(self) -> QWidget:
        wrap = QWidget(); outer = QVBoxLayout(wrap); outer.setContentsMargins(4, 18, 4, 0); outer.setSpacing(22)

        # ── Hero: Install everything ─────────────────────────────────
        c0, v0 = card(accent=True); v0.setSpacing(14)
        v0.addWidget(section_title("One-click install"))
        intro = QLabel("Installs Node.js, the engine, dependencies, and the adapter mod for the selected game. Safe to re-run.")
        intro.setObjectName("sub"); intro.setWordWrap(True); v0.addWidget(intro)
        self.btn_install_all = QPushButton("Install everything"); self.btn_install_all.setObjectName("hero")
        self.btn_install_all.clicked.connect(self._install_everything)
        v0.addWidget(self.btn_install_all)
        outer.addWidget(c0)

        # ── Game folder + adapter status combined ─────────────────────
        c1, v1 = card()
        v1.addWidget(section_title("Game folder"))
        sub1 = QLabel("Auto-detected from Steam when possible. Pick manually if not on Steam.")
        sub1.setObjectName("sub"); sub1.setWordWrap(True); v1.addWidget(sub1)
        row = QHBoxLayout(); row.setSpacing(10)
        self.game_dir_edit = QLineEdit(); self.game_dir_edit.editingFinished.connect(self._on_game_dir_typed)
        row.addWidget(self.game_dir_edit, 1)
        b_browse = QPushButton("Browse..."); b_browse.setObjectName("ghost"); b_browse.clicked.connect(self._pick_game_dir)
        row.addWidget(b_browse)
        v1.addLayout(row)
        outer.addWidget(c1)

        # ── Adapter install state ────────────────────────────────────
        c2, v2 = card()
        v2.addWidget(section_title("Adapter status"))
        sub2 = QLabel("What the game needs to receive effects. Install everything (above) takes care of all of this.")
        sub2.setObjectName("sub"); sub2.setWordWrap(True); v2.addWidget(sub2)
        self.install_checks_container = QVBoxLayout(); self.install_checks_container.setSpacing(8)
        v2.addLayout(self.install_checks_container)
        self.install_check_widgets: list[tuple[QWidget, QLabel, QLabel]] = []
        v2.addSpacing(6)
        actions = QHBoxLayout(); actions.setSpacing(10)
        self.btn_install = QPushButton("Install adapter only"); self.btn_install.setObjectName("ghost")
        self.btn_install.clicked.connect(self._install_adapter)
        actions.addWidget(self.btn_install)
        b_re = QPushButton("Re-check"); b_re.setObjectName("ghost")
        b_re.clicked.connect(self._refresh_install_status)
        actions.addWidget(b_re); actions.addStretch()
        v2.addLayout(actions)
        outer.addWidget(c2)

        # ── Prerequisites: Node + Engine + Token ──────────────────────
        c3, v3 = card()
        v3.addWidget(section_title("Prerequisites"))
        self.pre_node_row, self.pre_node_glyph, self.pre_node_label = check_row("Node.js runtime", "off")
        self.pre_engine_row, self.pre_engine_glyph, self.pre_engine_label = check_row("Engine source + dependencies", "off")
        self.pre_token_row, self.pre_token_glyph, self.pre_token_label = check_row("Relay token (optional, for dock/panel)", "off")
        v3.addWidget(self.pre_node_row); v3.addWidget(self.pre_engine_row); v3.addWidget(self.pre_token_row)
        v3.addSpacing(6)
        pre_actions = QHBoxLayout(); pre_actions.setSpacing(10)
        b_node = QPushButton("Install Node.js"); b_node.setObjectName("ghost"); b_node.clicked.connect(self._install_bundled_node)
        b_settings = QPushButton("Open Settings"); b_settings.setObjectName("ghost"); b_settings.clicked.connect(self._open_settings)
        pre_actions.addWidget(b_node); pre_actions.addWidget(b_settings); pre_actions.addStretch()
        v3.addLayout(pre_actions)
        outer.addWidget(c3)

        outer.addStretch()
        scroll = QScrollArea(); scroll.setWidget(wrap); scroll.setWidgetResizable(True); scroll.setFrameShape(QFrame.Shape.NoFrame)
        return scroll

    def _install_everything(self) -> None:
        """Run the one-click installer for the current game."""
        g = self._current_game()
        gd_text = self.game_dir_edit.text().strip()
        game_dir = Path(gd_text) if gd_text else None
        d = OneClickInstallDialog(self, g, self.settings, game_dir)
        d.exec()
        # After running, settings.project_root may be unset but engine landed
        # at user_engine_dir(). Bind it so the rest of the app uses it.
        from companion_crowdplay.engine_setup import user_engine_dir, engine_is_installed
        if (not (self.settings.value(K_PROJECT_ROOT, "") or "").strip()
                and engine_is_installed(user_engine_dir())):
            self.settings.setValue(K_PROJECT_ROOT, str(user_engine_dir()))
        self._refresh_runtime_status(); self._refresh_install_status()

    # ── Effects + Triggers tabs (reuse CustomizePanel) ────────────────
    def _build_effects_tab(self) -> QWidget:
        # CustomizePanel has both Effects (table) and Triggers (sub-tab) internally.
        # We split: route to its Effects inner tab here.
        self.customize = CustomizePanel(self.settings)
        self.customize.fire_requested.connect(self._fire_from_customize)
        # The Effects view is the customize panel showing its inner-Effects tab.
        wrap = QWidget(); v = QVBoxLayout(wrap); v.setContentsMargins(0, 14, 0, 0); v.setSpacing(12)
        v.addWidget(self.customize, 1)
        # Default to Effects sub-tab
        if hasattr(self.customize, 'inner_tabs'):
            self.customize.inner_tabs.setCurrentIndex(0)
        return wrap

    def _build_triggers_tab(self) -> QWidget:
        # The Triggers content is already inside CustomizePanel's inner tab #1.
        # Wrap a hint that jumps to it.
        w = QWidget(); v = QVBoxLayout(w); v.setContentsMargins(0, 14, 0, 0); v.setSpacing(12)
        c, cv = card()
        cv.addWidget(section_title("Triggers"))
        sub = QLabel("Edit which TikTok gifts, Twitch bits tiers, likes and follows fire which effects. Toggle 'Random' to pick a random effect every time.")
        sub.setObjectName("sub"); sub.setWordWrap(True); cv.addWidget(sub)
        b = QPushButton("Open Triggers editor")
        b.clicked.connect(self._open_triggers_editor)
        cv.addWidget(b, 0, Qt.AlignmentFlag.AlignLeft)
        v.addWidget(c); v.addStretch()
        return w

    def _open_triggers_editor(self) -> None:
        # Jump to the Effects tab + flip to inner Triggers tab.
        self.main_tabs.setCurrentIndex(2)
        if hasattr(self.customize, 'inner_tabs'):
            self.customize.inner_tabs.setCurrentIndex(1)

    # ── Activity tab ──────────────────────────────────────────────────
    def _build_activity_tab(self) -> QWidget:
        w = QWidget(); v = QVBoxLayout(w); v.setContentsMargins(0, 14, 0, 0); v.setSpacing(12)
        c, cv = card()
        head = QHBoxLayout()
        head.addWidget(section_title("Engine log"))
        head.addStretch()
        b_clear = QPushButton("Clear"); b_clear.setObjectName("ghost"); b_clear.clicked.connect(lambda: self.log_view.clear())
        b_copy = QPushButton("Copy"); b_copy.setObjectName("ghost"); b_copy.clicked.connect(self._copy_log)
        head.addWidget(b_clear); head.addWidget(b_copy)
        cv.addLayout(head)
        self.log_view = QPlainTextEdit(); self.log_view.setObjectName("log"); self.log_view.setReadOnly(True)
        self.log_view.setMaximumBlockCount(2000)
        cv.addWidget(self.log_view, 1)
        v.addWidget(c, 1)
        return w

    # ── Tools tab ─────────────────────────────────────────────────────
    def _build_tools_tab(self) -> QWidget:
        w = QWidget(); v = QVBoxLayout(w); v.setContentsMargins(0, 14, 0, 0); v.setSpacing(14)

        def tool_card(title: str, desc: str, btn_text: str, handler, ghost: bool = True) -> QFrame:
            c, cv = card()
            cv.addWidget(section_title(title))
            d = QLabel(desc); d.setObjectName("sub"); d.setWordWrap(True); cv.addWidget(d)
            b = QPushButton(btn_text)
            if ghost: b.setObjectName("ghost")
            b.clicked.connect(handler)
            cv.addWidget(b, 0, Qt.AlignmentFlag.AlignLeft)
            return c

        v.addWidget(tool_card(
            "Connection wizard", "One-button audit of every wire-up: Node, ports, engine /info, adapter heartbeat, worker, Twitch, TikTok. Shows what works and how to fix what doesn't.",
            "Run wizard", self._connection_wizard, ghost=False))
        v.addWidget(tool_card(
            "Test fire", "Force-fire a random effect locally (or via worker relay if local is offline).",
            "Test fire", self._test_fire))
        v.addWidget(tool_card(
            "Test connection (legacy)", "Probe TCP 8788 + HTTP 8789 + WS 8787 + the worker relay. Reports per-channel.",
            "Test connection", self._test_connection))
        v.addWidget(tool_card(
            "Stream mode (fullscreen)", "Distraction-free fullscreen showing only Diagnostics + Test Fire. Press Esc to exit.",
            "Open stream mode", self._open_stream_mode))
        v.addWidget(tool_card(
            "Free port (admin)", "Terminate any process holding 8787 / 8788 / 8789. Requires UAC. Use if a previous engine left orphans.",
            "Free port (admin)", self._free_port_now))
        v.addWidget(tool_card(
            "Open OBS overlay folder", "Opens the overlay/ folder so you can drag overlay.html or vertical.html into OBS.",
            "Open folder", self._open_overlay_folder))
        v.addWidget(tool_card(
            "Open CrowdPlay dock", "The web operator surface at aquilo.gg/dock/crowdplay/.",
            "Open dock", lambda: webbrowser.open("https://aquilo.gg/dock/crowdplay/")))
        v.addWidget(tool_card(
            "Open engine folder", "Reveals %LocalAppData%/AquiloCrowdPlay/engine in Explorer.",
            "Open folder", self._open_project_folder))
        v.addStretch()
        scroll = QScrollArea(); scroll.setWidget(w); scroll.setWidgetResizable(True); scroll.setFrameShape(QFrame.Shape.NoFrame)
        return scroll

    # ── Tray ──────────────────────────────────────────────────────────
    def _build_tray(self) -> Optional[QSystemTrayIcon]:
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return None
        tray = QSystemTrayIcon(self.windowIcon(), self)
        tray.setToolTip(APP_NAME)
        from PySide6.QtWidgets import QMenu
        m = QMenu()
        a_show = QAction("Show window", self); a_show.triggered.connect(self._show_normal)
        a_start = QAction("Start session", self); a_start.triggered.connect(self._start)
        a_stop = QAction("Stop", self); a_stop.triggered.connect(self._stop)
        a_dock = QAction("Open dock", self); a_dock.triggered.connect(lambda: webbrowser.open("https://aquilo.gg/dock/crowdplay/"))
        a_quit = QAction("Quit", self); a_quit.triggered.connect(self._real_quit)
        for a in (a_show, None, a_start, a_stop, None, a_dock, None, a_quit):
            if a is None: m.addSeparator()
            else:         m.addAction(a)
        tray.setContextMenu(m)
        tray.activated.connect(lambda r: self._show_normal() if r == QSystemTrayIcon.ActivationReason.Trigger else None)
        tray.show()
        return tray

    # ── Game catalog ──────────────────────────────────────────────────
    def _populate_games(self) -> None:
        self.game_combo.clear()
        for g in CATALOG:
            self.game_combo.addItem(f"{g.display}  ·  {g.harness}", g.slug)

    def _restore_last_game(self) -> None:
        slug = self.settings.value(K_LAST_GAME, CATALOG[0].slug)
        for i in range(self.game_combo.count()):
            if self.game_combo.itemData(i) == slug:
                self.game_combo.setCurrentIndex(i); return
        self.game_combo.setCurrentIndex(0)

    def _current_game(self) -> Game:
        slug = self.game_combo.currentData()
        return BY_SLUG[slug]

    def _on_game_changed(self) -> None:
        g = self._current_game()
        self.settings.setValue(K_LAST_GAME, g.slug)
        d = self.settings.value(K_GAME_DIR.format(slug=g.slug), "") or ""
        self.game_dir_edit.setText(d)
        self._refresh_install_status()
        # Customize panel switches game too
        proj = self._resolve_project_root()
        if proj: self.customize.load_for(g, proj)

    def _on_mode_changed(self) -> None:
        mode = self.mode_combo.currentData()
        if mode: self.settings.setValue(K_MODE, mode)

    def _on_game_dir_typed(self) -> None:
        g = self._current_game()
        self.settings.setValue(K_GAME_DIR.format(slug=g.slug), self.game_dir_edit.text().strip())
        self._refresh_install_status()

    def _pick_game_dir(self) -> None:
        g = self._current_game()
        d = QFileDialog.getExistingDirectory(self, f"Pick {g.display} folder",
                                             self.game_dir_edit.text() or str(Path.home()))
        if d:
            self.game_dir_edit.setText(d); self._on_game_dir_typed()

    # ── Status / install panels ──────────────────────────────────────
    def _refresh_install_status(self) -> None:
        g = self._current_game()
        override = self.game_dir_edit.text().strip() or self.settings.value(K_GAME_DIR.format(slug=g.slug), "") or ""
        override_path = Path(override) if override else None
        st = check_install(g, override_path)
        if not override and st.game_dir:
            self.game_dir_edit.setText(str(st.game_dir))

        # Re-render install checks into the container
        # Wipe existing widgets
        while self.install_checks_container.count():
            item = self.install_checks_container.takeAt(0)
            if item.widget(): item.widget().deleteLater()
        self.install_check_widgets.clear()
        # Add rows for each check
        rows = st.checks or []
        if not rows:
            empty_row, glyph, lbl = check_row(
                "No in-game install required." if st.game.install_into is None else "Game folder not set",
                "ok" if st.game.install_into is None else "warn",
            )
            self.install_checks_container.addWidget(empty_row)
            self.install_check_widgets.append((empty_row, glyph, lbl))
        else:
            for label, ok, detail in rows:
                state = "ok" if ok else "err"
                row, glyph, lbl = check_row(label, state, detail if not ok else "")
                self.install_checks_container.addWidget(row)
                self.install_check_widgets.append((row, glyph, lbl))

        # Reflect adapter status on the Stream tab's pip
        all_ok = (not rows) or all(ok for _, ok, _ in rows)
        if st.game.install_into is None or all_ok:
            self._set_pip(self._pip_adapter, "ok", "Ready")
        else:
            failed = [label for label, ok, _ in rows if not ok]
            self._set_pip(self._pip_adapter, "err", failed[0] if failed else "Missing pieces")

    def _refresh_runtime_status(self) -> None:
        tok = (self.settings.value(K_EXT_TOKEN, "") or "").strip()
        self._set_pip(self._pip_token, "ok" if tok else "warn", "Set" if tok else "Not set")

        proj = self._resolve_project_root()
        node_v = node_available()
        # Prerequisites checklist (Setup tab)
        if node_v:
            set_check(self.pre_node_glyph, "ok")
            self.pre_node_label.setText(f"Node.js {node_v}")
        else:
            set_check(self.pre_node_glyph, "err")
            self.pre_node_label.setText("Node.js NOT found - click Install Node.js")
        if proj and (proj / "node_modules" / "ws").exists():
            set_check(self.pre_engine_glyph, "ok")
            self.pre_engine_label.setText(f"Engine source ready at {proj}")
        elif proj:
            set_check(self.pre_engine_glyph, "warn")
            self.pre_engine_label.setText("Engine folder exists but npm install hasn't run")
        else:
            set_check(self.pre_engine_glyph, "err")
            self.pre_engine_label.setText("Engine folder not set - open Settings")
        set_check(self.pre_token_glyph, "ok" if tok else "warn")
        self.pre_token_label.setText("Relay token saved" if tok else "No relay token - open Settings")

        # Footer status string
        bits = []
        if proj: bits.append(f"Engine: {proj.name}" if hasattr(proj, 'name') else f"Engine: {proj}")
        else:    bits.append("Engine: NOT SET")
        if node_v: bits.append(f"Node: {node_v}")
        self.footer_status.setText("  ·  ".join(bits))

    # ── Engine control ────────────────────────────────────────────────
    def _resolve_project_root(self) -> Optional[Path]:
        v = self.settings.value(K_PROJECT_ROOT, "") or ""
        if v: return Path(v)
        return guess_project_root()

    def _start(self) -> None:
        proj = self._resolve_project_root()
        if not proj:
            QMessageBox.warning(self, APP_NAME, "Set the engine folder in Settings first."); return
        # Refresh customize tab
        self.customize.load_for(self._current_game(), proj)
        # Port pre-flight
        held = [p for p in (8787, 8788, 8789) if port_in_use(p)]
        if held:
            pid_info = [f"port {p} (PID {find_pid_on_port(p) or '?'})" for p in held]
            box = QMessageBox(self); box.setWindowTitle(APP_NAME); box.setIcon(QMessageBox.Icon.Warning)
            box.setText("These ports are already in use:\n  " + "\n  ".join(pid_info) +
                        "\n\nFree them now (requires UAC)?")
            free_btn = box.addButton("Free Port (admin)", QMessageBox.ButtonRole.ActionRole)
            box.addButton(QMessageBox.StandardButton.Cancel)
            box.exec()
            if box.clickedButton() is free_btn:
                ok, m = free_ports_elevated()
                QMessageBox.information(self, APP_NAME,
                    "Elevation accepted - wait a couple of seconds, then Start session again." if ok
                    else f"Couldn't elevate ({m}). Reboot to clear the orphan engine.")
            return
        g = self._current_game()
        extra = {}
        # Propagate paid-vote thresholds to the engine via env.
        extra["PAID_VOTE_BITS_MIN"] = str(self.settings.value(K_PAID_BITS_MIN, 100))
        extra["PAID_VOTE_GIFT_MIN"] = str(self.settings.value(K_PAID_GIFT_MIN, 30))
        for key, env_key in ((K_TWITCH, "TWITCH_CHANNEL"),
                             (K_TIKTOK, "TIKTOK_USERNAME"),
                             (K_EXT_URL, "EXT_RELAY_URL"),
                             (K_EXT_TOKEN, "EXT_RELAY_TOKEN")):
            v = self.settings.value(key, "") or ""
            if v: extra[env_key] = v
        if extra.get("TIKTOK_USERNAME"): extra["TIKTOK_ENABLED"] = "true"
        mode = (self.settings.value(K_MODE, "vote") or "vote").lower()
        if mode in ("vote", "buy", "mixed"): extra["MODE"] = mode

        ok, msg = self.engine.start(proj, g.slug, extra)
        if not ok:
            QMessageBox.warning(self, APP_NAME, msg); return
        self.btn_start.setEnabled(False); self.btn_stop.setEnabled(True)
        self._set_pip(self._pip_engine, "warn", "Starting...")
        self.runtime_badge.setText("Starting")
        self.runtime_badge.setProperty("state", "warn"); self.runtime_badge.style().unpolish(self.runtime_badge); self.runtime_badge.style().polish(self.runtime_badge)

    def _stop(self) -> None:
        self.engine.stop()

    def _on_status(self, st: EngineStatus) -> None:
        if self.engine.is_running():
            self._set_pip(self._pip_engine, "ok", "Running")
            self.runtime_badge.setText("Running"); self.runtime_badge.setProperty("state", "ok")
            self.runtime_badge.style().unpolish(self.runtime_badge); self.runtime_badge.style().polish(self.runtime_badge)
        self._set_pip(self._pip_relay, "ok" if st.relay_up else "err", "Up" if st.relay_up else "Disabled")
        if self.engine.is_running():
            if st.adapters_connected > 0:
                self._set_pip(self._pip_adapter, "ok", f"Connected ({st.adapters_connected})")
            elif st.tcp_listening or st.http_listening:
                self._set_pip(self._pip_adapter, "warn", "Waiting for game adapter")
            else:
                self._set_pip(self._pip_adapter, "warn", "Engine starting ports...")

    def _on_exit(self, code: int) -> None:
        self.btn_start.setEnabled(True); self.btn_stop.setEnabled(False)
        self._set_pip(self._pip_engine, "err" if code not in (0, -1) else "off",
                      "Crashed" if code not in (0, -1) else "Idle")
        self.runtime_badge.setText("Idle" if code in (0, -1) else "Crashed")
        self.runtime_badge.setProperty("state", "off" if code in (0, -1) else "err")
        self.runtime_badge.style().unpolish(self.runtime_badge); self.runtime_badge.style().polish(self.runtime_badge)
        self._set_pip(self._pip_relay, "off", "—")
        self._refresh_install_status()

    def _append_log(self, line: str) -> None:
        self.log_view.appendPlainText(line)
        self.recent_log.appendPlainText(line)
        # Mirror to the Diagnostics tab's filterable log view.
        if hasattr(self, "diag_tab") and self.diag_tab:
            self.diag_tab.append_log(line)

    def _copy_log(self) -> None:
        QApplication.clipboard().setText(self.log_view.toPlainText())

    # ── Tools / extras ────────────────────────────────────────────────
    def _free_port_now(self) -> None:
        ok, msg = free_ports_elevated()
        if ok:
            QMessageBox.information(self, APP_NAME,
                "Elevation accepted. The cleanup runs in a hidden admin shell. "
                "Wait a couple of seconds, then Start session.")
        else:
            QMessageBox.warning(self, APP_NAME,
                f"Couldn't elevate ({msg}). If UAC was denied, try again; "
                "if blocked, reboot to clear the orphan engine.")

    def _install_bundled_node(self) -> None:
        from PySide6.QtCore import QObject, QThread, Signal
        from companion_crowdplay.downloads import install_node_portable

        class _Worker(QObject):
            done = Signal(bool, str); log_line = Signal(str)
            def run(self):
                ok, msg = install_node_portable(self.log_line.emit); self.done.emit(ok, msg)

        self._node_dlg = QMessageBox(self); self._node_dlg.setIcon(QMessageBox.Icon.Information)
        self._node_dlg.setWindowTitle("Installing Node.js")
        self._node_dlg.setText("Downloading portable Node.js v20.18.0...")
        self._node_dlg.setStandardButtons(QMessageBox.StandardButton.NoButton)
        self._node_thread = QThread(self); self._node_worker = _Worker()
        self._node_worker.moveToThread(self._node_thread)
        self._node_thread.started.connect(self._node_worker.run)
        def _on_log(line: str):
            cur = self._node_dlg.detailedText() or ""
            self._node_dlg.setDetailedText(cur + line + "\n")
        def _on_done(ok: bool, msg: str):
            self._node_dlg.setText(("DONE: " if ok else "FAILED: ") + msg)
            self._node_dlg.setStandardButtons(QMessageBox.StandardButton.Ok)
            self._node_thread.quit(); self._refresh_runtime_status()
        self._node_worker.log_line.connect(_on_log); self._node_worker.done.connect(_on_done)
        self._node_thread.start(); self._node_dlg.exec()

    def _connection_wizard(self) -> None:
        """Run the one-button connection audit."""
        from companion_crowdplay.connection_wizard import ConnectionWizardDialog
        proj = self._resolve_project_root()
        dlg = ConnectionWizardDialog(self.settings, str(proj) if proj else None, self)
        dlg.exec()

    def _open_stream_mode(self) -> None:
        """Open a fullscreen distraction-free view with just Diagnostics +
        Test Fire side by side. Escape closes it."""
        from PySide6.QtWidgets import QDialog, QHBoxLayout
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QShortcut, QKeySequence
        from companion_crowdplay.diagnostics import DiagnosticsTab, FireTestTab
        dlg = QDialog(self)
        dlg.setWindowTitle("CrowdPlay - Stream mode")
        dlg.setWindowFlag(Qt.WindowType.Window, True)
        layout = QHBoxLayout(dlg); layout.setContentsMargins(8, 8, 8, 8); layout.setSpacing(8)
        diag = DiagnosticsTab(dlg)
        fire = FireTestTab(dlg)
        fire.statusMessage.connect(lambda s: dlg.setWindowTitle(f"CrowdPlay - Stream mode :: {s}"))
        layout.addWidget(diag, 1); layout.addWidget(fire, 1)
        # Esc closes
        esc = QShortcut(QKeySequence("Esc"), dlg)
        esc.activated.connect(dlg.close)
        dlg.resize(1400, 900)
        dlg.showMaximized()
        dlg.exec()

    def _test_fire(self) -> None:
        g = self._current_game(); proj = self._resolve_project_root()
        if not proj: QMessageBox.warning(self, APP_NAME, "Set the engine folder first."); return
        try:
            import json, random, urllib.request, urllib.error
            with open(proj / "manifests" / f"{g.slug}.json", encoding="utf-8") as f:
                effects = json.load(f).get("effects") or []
            if not effects: QMessageBox.warning(self, APP_NAME, "Manifest has no effects."); return
            eff = random.choice(effects)
            label = eff.get("label", eff["id"])

            # PRIMARY: hit the engine's local debug fire endpoint. No auth, no
            # worker round-trip, no Cloudflare. Works whenever the engine is
            # running. We always try this first because it's the only path
            # that's guaranteed to reach the in-game adapter.
            body = json.dumps({"effect": eff["id"]}).encode("utf-8")
            try:
                req = urllib.request.Request(
                    "http://127.0.0.1:8789/fire",
                    data=body,
                    headers={"Content-Type": "application/json",
                             # Mozilla UA so any future remote hop is not 403'd
                             # by Cloudflare's bot-mitigation (error code 1010).
                             "User-Agent": "Mozilla/5.0 AquiloCrowdPlay/1.0"},
                )
                with urllib.request.urlopen(req, timeout=3) as r:
                    if r.status == 200:
                        QMessageBox.information(self, APP_NAME, f"Test-fired locally: {label}")
                        return
            except urllib.error.URLError:
                pass  # engine offline - fall through to worker

            # FALLBACK: route via worker if relay creds exist. Adds a proper
            # User-Agent so Cloudflare doesn't reject us.
            url = (self.settings.value(K_EXT_URL, "") or "").strip()
            tok = (self.settings.value(K_EXT_TOKEN, "") or "").strip()
            if not url or not tok:
                QMessageBox.warning(self, APP_NAME,
                    "Engine is not running locally and Relay URL/token aren't set. "
                    "Start the session, or fill in Relay creds in Settings.")
                return
            body = json.dumps({"kind": "force-fire", "effectId": eff["id"]}).encode("utf-8")
            req = urllib.request.Request(url.rstrip("/") + "/web/crowdplay/control",
                                         data=body,
                                         headers={"Content-Type": "application/json",
                                                  "x-crowdplay-token": tok,
                                                  "User-Agent": "Mozilla/5.0 AquiloCrowdPlay/1.0"})
            with urllib.request.urlopen(req, timeout=4) as r:
                ok = (r.status == 200)
            QMessageBox.information(self, APP_NAME,
                f"Test-fired via relay: {label}" if ok else "Test-fire failed.")
        except Exception as e:
            QMessageBox.warning(self, APP_NAME, f"Test-fire failed: {e}")

    def _test_connection(self) -> None:
        import socket, urllib.request
        results = []
        for label, port in [("TCP adapter feed", 8788), ("HTTP adapter feed", 8789), ("Overlay WS", 8787)]:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1.0):
                    results.append(f"OK    {label} 127.0.0.1:{port}")
            except OSError as e:
                results.append(f"FAIL  {label} 127.0.0.1:{port}: {e.__class__.__name__}")
        url = (self.settings.value(K_EXT_URL, "") or "").strip()
        if url:
            try:
                with urllib.request.urlopen(url.rstrip("/") + "/web/crowdplay/active", timeout=4) as r:
                    results.append(f"OK    Relay {url} (HTTP {r.status})")
            except Exception as e:
                results.append(f"FAIL  Relay {url}: {e}")
        else:
            results.append("WARN  Relay URL not set")
        QMessageBox.information(self, "Connection test", "\n".join(results))

    def _open_overlay_folder(self) -> None:
        proj = self._resolve_project_root()
        if not proj: QMessageBox.warning(self, APP_NAME, "Set the engine folder first."); return
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(proj / "overlay")))

    def _fire_from_customize(self, effect_id: str) -> None:
        if not effect_id: return
        try:
            import json as _json, urllib.request, urllib.error
            # Local engine first (no auth, no Cloudflare).
            body = _json.dumps({"effect": effect_id}).encode("utf-8")
            try:
                req = urllib.request.Request(
                    "http://127.0.0.1:8789/fire", data=body,
                    headers={"Content-Type": "application/json",
                             "User-Agent": "Mozilla/5.0 AquiloCrowdPlay/1.0"})
                with urllib.request.urlopen(req, timeout=3) as r:
                    if r.status == 200:
                        self.statusBar().showMessage(f"Fired '{effect_id}'", 2500)
                        return
            except urllib.error.URLError:
                pass
            # Fallback: relay.
            url = (self.settings.value(K_EXT_URL, "") or "").strip()
            tok = (self.settings.value(K_EXT_TOKEN, "") or "").strip()
            if not url or not tok:
                QMessageBox.warning(self, APP_NAME, "Engine offline and relay creds missing."); return
            body = _json.dumps({"kind": "force-fire", "effectId": effect_id}).encode("utf-8")
            req = urllib.request.Request(url.rstrip("/") + "/web/crowdplay/control",
                                         data=body,
                                         headers={"Content-Type": "application/json",
                                                  "x-crowdplay-token": tok,
                                                  "User-Agent": "Mozilla/5.0 AquiloCrowdPlay/1.0"})
            with urllib.request.urlopen(req, timeout=4) as r:
                ok = (r.status == 200)
            if ok: self.statusBar().showMessage(f"Fired '{effect_id}'", 2500)
        except Exception as e:
            QMessageBox.warning(self, APP_NAME, f"Fire failed: {e}")

    def _open_settings(self) -> None:
        d = SettingsDialog(self.settings, self)
        if d.exec():
            self._refresh_runtime_status(); self._refresh_install_status()

    def _open_project_folder(self) -> None:
        proj = self._resolve_project_root()
        if not proj: QMessageBox.warning(self, APP_NAME, "Set the engine folder first."); return
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(proj)))

    def _install_adapter(self) -> None:
        g = self._current_game(); proj = self._resolve_project_root()
        if not proj: QMessageBox.warning(self, APP_NAME, "Set the engine folder first."); return
        gd_text = self.game_dir_edit.text().strip()
        game_dir = Path(gd_text) if gd_text else None
        if g.install_into and not game_dir:
            QMessageBox.warning(self, APP_NAME, f"Pick the {g.display} folder first."); return
        d = InstallDialog(self, g, proj, game_dir); d.exec()
        self._refresh_install_status()

    def _check_for_updates(self) -> None:
        self._update_checker = UpdateChecker()
        self._update_checker.update_available.connect(self._on_update_available)
        self._update_checker.start()

    def _on_update_available(self, ver: str, url: str) -> None:
        self.footer_status.setText(f"Update available: {ver}  ·  {self.footer_status.text()}")

    # ── Tray glue ─────────────────────────────────────────────────────
    def _show_normal(self) -> None:
        self.showNormal(); self.raise_(); self.activateWindow()

    def _real_quit(self) -> None:
        self.engine.stop(); QApplication.quit()

    def closeEvent(self, event):
        if self._tray and self._tray.isVisible() and self.engine.is_running():
            event.ignore(); self.hide()
            self._tray.showMessage(APP_NAME, "Still running - engine stays up. Right-click tray to quit.",
                                   QSystemTrayIcon.MessageIcon.Information, 2500)
        else:
            self.engine.stop(); event.accept()


# ── App bootstrap ──────────────────────────────────────────────────────
def _set_windows_app_id() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("gg.aquilo.crowdplay.companion")
    except Exception:
        pass


def main() -> None:
    _set_windows_app_id()
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME); app.setOrganizationName(ORG_NAME)
    icon = make_icon(64); app.setWindowIcon(icon)
    app.setStyleSheet(QSS)
    app.setQuitOnLastWindowClosed(False)

    if needs_first_run():
        FirstRunWizard().exec()

    w = MainWindow(); w.setWindowIcon(icon); w.show()
    sys.exit(app.exec())
