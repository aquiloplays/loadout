"""QDialog that runs an install plan in a worker thread, with a live step
list + log view. Used by the 'Install adapter' button on the main window."""

from __future__ import annotations
from pathlib import Path

from PySide6.QtCore import Qt, QObject, QThread, Signal, Slot
from PySide6.QtWidgets import (
    QDialog, QDialogButtonBox, QFrame, QHBoxLayout, QLabel, QPlainTextEdit,
    QProgressBar, QPushButton, QSizePolicy, QVBoxLayout, QWidget,
)

from companion_crowdplay.games import Game
from companion_crowdplay.install import InstallContext, Step, plan_for_game


# ── worker that runs the plan ──────────────────────────────────────────
class _InstallWorker(QObject):
    """Runs each step sequentially in a thread.

    Signals:
      step_started(int, str)              - step index, step name
      step_finished(int, bool, str)       - step index, ok, message
      log(str)                            - free-form log line
      finished(bool)                      - whole plan ok? (first failure aborts)
    """
    step_started = Signal(int, str)
    step_finished = Signal(int, bool, str)
    log = Signal(str)
    finished = Signal(bool)

    def __init__(self, plan: list[Step], ctx: InstallContext):
        super().__init__()
        self._plan = plan
        self._ctx = ctx

    @Slot()
    def run(self) -> None:
        # Wire ctx.log to our signal so install.py can stream verbose output.
        self._ctx.log = self.log.emit
        all_ok = True
        for i, step in enumerate(self._plan):
            self.step_started.emit(i, step.name)
            try:
                ok, msg = step.run(self._ctx)
            except Exception as e:    # noqa: BLE001 - any step error becomes a step failure
                ok, msg = False, f"unhandled error: {e}"
            self.step_finished.emit(i, ok, msg)
            if not ok:
                all_ok = False
                # First fail aborts the rest, so the user can fix and re-run.
                break
        self.finished.emit(all_ok)


# ── dialog ─────────────────────────────────────────────────────────────
class InstallDialog(QDialog):
    """Modal install dialog. Construct with a game + project root + game dir,
    call exec()."""

    def __init__(self, parent, game: Game, project_root: Path, game_dir: Path | None):
        super().__init__(parent)
        self.setWindowTitle(f"Install adapter - {game.display}")
        self.setMinimumSize(560, 520)
        self._plan = plan_for_game(game, project_root, game_dir)
        self._ctx = InstallContext(project_root=project_root, game=game, game_dir=game_dir)
        self._step_widgets: list[tuple[QFrame, QLabel, QLabel]] = []
        self._build_ui(game)
        self._start_worker()

    def _build_ui(self, game: Game) -> None:
        v = QVBoxLayout(self); v.setContentsMargins(14, 14, 14, 14); v.setSpacing(10)

        head = QLabel(f"Installing {game.display} ({game.harness})")
        head.setObjectName("h1")
        v.addWidget(head)

        sub = QLabel("The steps below run in order. The first failure aborts so you can fix it and re-run.")
        sub.setObjectName("sub"); sub.setWordWrap(True)
        v.addWidget(sub)

        # Step list
        steps_wrap = QFrame(); steps_wrap.setObjectName("card")
        sv = QVBoxLayout(steps_wrap); sv.setContentsMargins(12, 12, 12, 12); sv.setSpacing(8)
        for i, step in enumerate(self._plan):
            row = QFrame()
            rl = QHBoxLayout(row); rl.setContentsMargins(0, 0, 0, 0); rl.setSpacing(10)
            dot = QFrame(); dot.setObjectName("pip"); dot.setProperty("state", "off")
            dot.setFixedSize(10, 10)
            text = QLabel(f"<b>{step.name}</b>")
            msg = QLabel("queued"); msg.setObjectName("sub")
            msg.setWordWrap(True)
            inner = QWidget(); il = QVBoxLayout(inner); il.setContentsMargins(0, 0, 0, 0); il.setSpacing(2)
            il.addWidget(text); il.addWidget(msg)
            if step.description:
                desc = QLabel(step.description); desc.setObjectName("sub"); desc.setWordWrap(True)
                il.addWidget(desc)
            rl.addWidget(dot); rl.addWidget(inner, 1)
            sv.addWidget(row)
            self._step_widgets.append((dot, text, msg))
        v.addWidget(steps_wrap)

        # Progress bar
        self.bar = QProgressBar(); self.bar.setRange(0, len(self._plan)); self.bar.setValue(0)
        self.bar.setTextVisible(False)
        v.addWidget(self.bar)

        # Log
        self.log = QPlainTextEdit(); self.log.setObjectName("log"); self.log.setReadOnly(True)
        self.log.setMinimumHeight(110)
        self.log.setPlaceholderText("Verbose output appears here.")
        v.addWidget(self.log, 1)

        # Buttons
        bb = QDialogButtonBox()
        self.close_btn = bb.addButton("Close", QDialogButtonBox.ButtonRole.AcceptRole)
        self.close_btn.setEnabled(False)
        self.close_btn.clicked.connect(self.accept)
        v.addWidget(bb)

    def _set_step(self, i: int, state: str, msg: str) -> None:
        dot, _text, lbl = self._step_widgets[i]
        dot.setProperty("state", state)
        dot.style().unpolish(dot); dot.style().polish(dot)
        lbl.setText(msg)

    # ── worker plumbing ──────────────────────────────────────────────
    def _start_worker(self) -> None:
        self._thread = QThread()
        self._worker = _InstallWorker(self._plan, self._ctx)
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
        self.log.appendPlainText(("OK  " if ok else "FAIL ") + msg)
        self.bar.setValue(i + 1)

    @Slot(str)
    def _on_log(self, line: str) -> None:
        if line:
            self.log.appendPlainText(line)

    @Slot(bool)
    def _on_done(self, all_ok: bool) -> None:
        self.close_btn.setEnabled(True)
        self.log.appendPlainText("\n" + ("Install complete." if all_ok else "Install stopped on first failure."))
        self._thread.quit(); self._thread.wait()
