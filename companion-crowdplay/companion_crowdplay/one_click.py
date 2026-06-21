"""One-click "Install everything for <game>" orchestrator.

Bundles in a single QDialog the four sub-steps that historically required
the user to know which buttons to press in which order:

    1. Portable Node.js  - install if not on disk + not on PATH
    2. Engine source     - copy bundled aquilo-crowdplay -> %LocalAppData%
    3. npm install       - one-time dependency install in the engine dir
    4. Adapter install   - per-game plan (UE4SS + LuaSocket + crowdplay
                           mod for UE4SS games; BepInEx + prebuilt DLL
                           for Killer Bean; pip install for Crimson Desert,
                           etc.)

Each step is skipped if its prerequisites already pass, so this is safe to
re-run.
"""

from __future__ import annotations
import shutil
from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, QObject, QSettings, QThread, Signal, Slot
from PySide6.QtWidgets import (
    QDialog, QDialogButtonBox, QFrame, QHBoxLayout, QLabel, QPlainTextEdit,
    QProgressBar, QPushButton, QSizePolicy, QVBoxLayout, QWidget,
)

from companion_crowdplay.detect import check_install, node_available
from companion_crowdplay.downloads import (
    find_bundled_node, install_node_portable,
)
from companion_crowdplay.engine_setup import (
    engine_is_installed, provision_engine, user_engine_dir,
)
from companion_crowdplay.games import Game
from companion_crowdplay.install import InstallContext, plan_for_game


# ── one composite step ───────────────────────────────────────────────────
class _Worker(QObject):
    step_started = Signal(int, str)
    step_finished = Signal(int, bool, str)
    log = Signal(str)
    finished = Signal(bool)

    def __init__(self, game: Game, project_root_setting: str, game_dir: Optional[Path]):
        super().__init__()
        self._game = game
        self._proj_setting = project_root_setting
        self._game_dir = game_dir
        self._resolved_project_root: Optional[Path] = None

    @Slot()
    def run(self) -> None:
        steps = [
            ("Node.js runtime",      self._step_node),
            ("Engine source",        self._step_engine_source),
            ("Engine dependencies",  self._step_npm),
            (f"Adapter for {self._game.display}", self._step_adapter),
        ]
        all_ok = True
        for i, (name, fn) in enumerate(steps):
            self.step_started.emit(i, name)
            try:
                ok, msg = fn()
            except Exception as e:    # noqa: BLE001
                ok, msg = False, f"unhandled error: {e}"
            self.step_finished.emit(i, ok, msg)
            if not ok:
                all_ok = False
                break
        self.finished.emit(all_ok)

    # ── per-step implementations ────────────────────────────────────────
    def _step_node(self) -> tuple[bool, str]:
        v = node_available()
        if v:
            return True, f"already installed: {v}"
        ok, msg = install_node_portable(self.log.emit)
        return ok, msg

    def _step_engine_source(self) -> tuple[bool, str]:
        # If the user has pointed at an existing clone, honour it.
        if self._proj_setting:
            p = Path(self._proj_setting)
            if (p / "src" / "index.js").exists():
                self._resolved_project_root = p
                return True, f"using existing engine at {p}"
        # Otherwise provision into %LocalAppData% from the bundled source.
        target = user_engine_dir()
        if engine_is_installed(target):
            self._resolved_project_root = target
            return True, f"already installed at {target}"
        ok, val = provision_engine(self.log.emit)
        if ok:
            self._resolved_project_root = Path(str(val))
            return True, f"installed to {val}"
        return False, str(val)

    def _step_npm(self) -> tuple[bool, str]:
        # provision_engine already runs npm install; this step is a no-op when
        # the engine was just installed. We re-check node_modules/ws to handle
        # the "user pointed at a fresh clone without running npm install" case.
        proj = self._resolved_project_root
        if not proj:
            return False, "engine root not resolved"
        if (proj / "node_modules" / "ws").exists():
            return True, "node_modules present"
        # Re-trigger the install via engine_setup.run_npm_install.
        from companion_crowdplay.engine_setup import run_npm_install
        ok, msg = run_npm_install(proj, self.log.emit)
        return ok, msg

    def _step_adapter(self) -> tuple[bool, str]:
        proj = self._resolved_project_root
        if not proj:
            return False, "engine root not resolved"
        if not self._game_dir and self._game.install_into:
            # Try one more steam detect with the resolved game dir.
            from companion_crowdplay.detect import find_steam_game_dir
            if self._game.game_dir:
                gd = find_steam_game_dir(self._game.game_dir)
                if gd:
                    self._game_dir = gd
        plan = plan_for_game(self._game, proj, self._game_dir)
        ctx = InstallContext(project_root=proj, game=self._game, game_dir=self._game_dir,
                             log=self.log.emit)
        for step in plan:
            self.log.emit(f">>> {step.name}")
            ok, msg = step.run(ctx)
            self.log.emit(("OK   " if ok else "FAIL ") + msg)
            if not ok:
                return False, f"{step.name}: {msg}"
        return True, "adapter installed"


# ── dialog ───────────────────────────────────────────────────────────────
class OneClickInstallDialog(QDialog):
    """Hero dialog for the Setup tab's 'Install everything' button."""

    def __init__(self, parent, game: Game, settings: QSettings, game_dir: Optional[Path]):
        super().__init__(parent)
        self.setWindowTitle(f"Install everything for {game.display}")
        self.setMinimumSize(640, 520)
        self._step_widgets: list[tuple[QLabel, QLabel]] = []  # (glyph, msg_label)
        self._build_ui(game)
        self._start_worker(game, (settings.value("project_root", "") or "").strip(), game_dir)

    def _build_ui(self, game: Game) -> None:
        v = QVBoxLayout(self); v.setContentsMargins(20, 20, 20, 20); v.setSpacing(14)

        # Header
        head = QLabel(f"Installing CrowdPlay for {game.display}")
        head.setObjectName("h1"); v.addWidget(head)
        sub = QLabel("This runs all four sub-steps in sequence. The first failure aborts so you can fix it and re-run safely.")
        sub.setObjectName("sub"); sub.setWordWrap(True); v.addWidget(sub)

        # Step list
        wrap = QFrame(); wrap.setObjectName("card")
        wv = QVBoxLayout(wrap); wv.setContentsMargins(16, 14, 16, 14); wv.setSpacing(10)
        STEP_NAMES = [
            "Node.js runtime",
            "Engine source",
            "Engine dependencies (npm install)",
            f"Adapter for {game.display}",
        ]
        for name in STEP_NAMES:
            row = QFrame()
            rl = QHBoxLayout(row); rl.setContentsMargins(0, 0, 0, 0); rl.setSpacing(10)
            glyph = QLabel("•"); glyph.setObjectName("checkMark"); glyph.setProperty("state", "off")
            txt = QLabel(f"<b>{name}</b>")
            msg = QLabel("queued"); msg.setObjectName("sub"); msg.setWordWrap(True)
            inner = QWidget(); il = QVBoxLayout(inner); il.setContentsMargins(0, 0, 0, 0); il.setSpacing(2)
            il.addWidget(txt); il.addWidget(msg)
            rl.addWidget(glyph); rl.addWidget(inner, 1)
            wv.addWidget(row)
            self._step_widgets.append((glyph, msg))
        v.addWidget(wrap)

        # Progress bar
        self.bar = QProgressBar(); self.bar.setRange(0, len(STEP_NAMES)); self.bar.setValue(0); self.bar.setTextVisible(False)
        v.addWidget(self.bar)

        # Verbose log (collapsible feel: small + scrollable)
        self.log = QPlainTextEdit(); self.log.setObjectName("log"); self.log.setReadOnly(True)
        self.log.setMinimumHeight(120); self.log.setPlaceholderText("Verbose output...")
        v.addWidget(self.log, 1)

        # Buttons
        bb = QDialogButtonBox()
        self.close_btn = bb.addButton("Close", QDialogButtonBox.ButtonRole.AcceptRole)
        self.close_btn.setEnabled(False)
        self.close_btn.clicked.connect(self.accept)
        v.addWidget(bb)

    def _set_step(self, i: int, state: str, msg: str) -> None:
        glyph, lbl = self._step_widgets[i]
        glyph.setText({"ok": "✓", "err": "✗", "warn": "!", "off": "•"}.get(state, "•"))
        glyph.setProperty("state", state)
        glyph.style().unpolish(glyph); glyph.style().polish(glyph)
        lbl.setText(msg)

    # ── worker plumbing ─────────────────────────────────────────────
    def _start_worker(self, game: Game, project_setting: str, game_dir: Optional[Path]) -> None:
        self._thread = QThread()
        self._worker = _Worker(game, project_setting, game_dir)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.run)
        self._worker.step_started.connect(self._on_step_started)
        self._worker.step_finished.connect(self._on_step_finished)
        self._worker.log.connect(self._on_log)
        self._worker.finished.connect(self._on_done)
        self._thread.start()

    @Slot(int, str)
    def _on_step_started(self, i: int, name: str) -> None:
        self._set_step(i, "warn", "running...")
        self.log.appendPlainText(f">>> {name}")

    @Slot(int, bool, str)
    def _on_step_finished(self, i: int, ok: bool, msg: str) -> None:
        self._set_step(i, "ok" if ok else "err", msg)
        self.log.appendPlainText(("OK   " if ok else "FAIL ") + msg)
        self.bar.setValue(i + 1)

    @Slot(str)
    def _on_log(self, line: str) -> None:
        if line: self.log.appendPlainText(line)

    @Slot(bool)
    def _on_done(self, all_ok: bool) -> None:
        self.close_btn.setEnabled(True)
        self.log.appendPlainText("\n" + ("All done. You can Start session now." if all_ok
                                        else "Install stopped on first failure."))
        self._thread.quit(); self._thread.wait()
