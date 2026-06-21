"""Three-step first-run wizard.

Triggered when companion launches with NO project root configured. Runs
inline as a modal dialog over the main window. Each step is a simple
QWizardPage backed by QSettings keys that the rest of the app already
reads.

Steps:
  1. Pick the aquilo-crowdplay folder (auto-guess if possible).
  2. Twitch channel + Relay URL/token.
  3. Pick a first game + (optionally) point to its install folder. The
     install button is offered but not forced - the user can install later.
"""
from __future__ import annotations
from pathlib import Path

from PySide6.QtCore import Qt, QSettings, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QComboBox, QFileDialog, QFormLayout, QHBoxLayout, QLabel, QLineEdit,
    QPushButton, QVBoxLayout, QWidget, QWizard, QWizardPage,
)

from companion_crowdplay import APP_NAME, ORG_NAME
from companion_crowdplay.games import CATALOG
from companion_crowdplay.detect import guess_project_root
from companion_crowdplay.engine_setup import (
    bundled_source_dir, engine_is_installed, user_engine_dir, provision_engine,
)


# ── helpers ─────────────────────────────────────────────────────────────
def _bold(text: str) -> QLabel:
    lbl = QLabel(text); lbl.setObjectName("h2")
    return lbl


# ── step 1: project folder ──────────────────────────────────────────────
class ProjectPage(QWizardPage):
    """Step 1: locate (or install) the engine. The app bundles the engine
    source, so by default we auto-install into %LocalAppData% with one click.
    An "Advanced" path lets power users point at an existing clone."""

    def __init__(self, settings: QSettings):
        super().__init__()
        self.settings = settings
        self.setTitle("Step 1 of 3 - Engine")
        self.setSubTitle("The engine source ships with this app. Click Install and we drop it under your AppData.")
        v = QVBoxLayout(self)

        v.addWidget(_bold("Install bundled engine"))
        self.status = QLabel("Not yet installed.")
        self.status.setWordWrap(True); self.status.setObjectName("sub")
        v.addWidget(self.status)
        if engine_is_installed(user_engine_dir()):
            self.status.setText(f"Already installed at {user_engine_dir()}.")
            self._final_path = str(user_engine_dir())
        else:
            self._final_path = None
        row = QHBoxLayout()
        self.install_btn = QPushButton("Install engine here")
        self.install_btn.clicked.connect(self._install)
        row.addWidget(self.install_btn); row.addStretch()
        v.addLayout(row)

        v.addSpacing(12)
        v.addWidget(_bold("Advanced: use an existing clone"))
        row2 = QHBoxLayout()
        self.edit = QLineEdit()
        guess = guess_project_root()
        if guess:
            self.edit.setText(str(guess))
        self.edit.setPlaceholderText(r"C:\path\to\aquilo-crowdplay")
        b = QPushButton("Browse..."); b.setObjectName("ghost"); b.clicked.connect(self._pick)
        row2.addWidget(self.edit, 1); row2.addWidget(b)
        v.addLayout(row2)
        hint = QLabel("Only fill this in if you already cloned the repo. Otherwise leave it blank and click Install above.")
        hint.setWordWrap(True); hint.setObjectName("sub")
        v.addWidget(hint)
        v.addStretch()

    def _pick(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "Pick aquilo-crowdplay folder",
                                             self.edit.text() or str(Path.home()))
        if d:
            self.edit.setText(d)

    def _install(self) -> None:
        """Run provision_engine in a worker thread so the wizard stays
        responsive while npm install churns."""
        from PySide6.QtCore import QObject, QThread, Signal
        from PySide6.QtWidgets import QApplication

        class _W(QObject):
            done = Signal(bool, str)
            log_line = Signal(str)
            def run(self):
                ok, val = provision_engine(self.log_line.emit)
                self.done.emit(ok, str(val))

        self.install_btn.setEnabled(False)
        self.status.setText("Installing... (this can take ~30s while npm fetches deps)")
        QApplication.processEvents()
        self._thr = QThread()
        self._w = _W()
        self._w.moveToThread(self._thr)
        self._thr.started.connect(self._w.run)
        self._w.log_line.connect(lambda l: self.status.setText(l))
        def on_done(ok, val):
            if ok:
                self._final_path = val
                self.status.setText(f"Installed at {val}.")
            else:
                self.status.setText(f"Install failed: {val}")
            self.install_btn.setEnabled(True)
            self._thr.quit()
        self._w.done.connect(on_done)
        self._thr.start()

    def validatePage(self) -> bool:
        # Power-user override takes precedence if filled in.
        manual = self.edit.text().strip()
        if manual:
            if not (Path(manual) / "src" / "index.js").exists():
                return False
            self.settings.setValue("project_root", manual)
            return True
        # Otherwise we accept the auto-installed path.
        if self._final_path:
            self.settings.setValue("project_root", str(self._final_path))
            return True
        return False


# ── step 2: creds ───────────────────────────────────────────────────────
class CredsPage(QWizardPage):
    def __init__(self, settings: QSettings):
        super().__init__()
        self.settings = settings
        self.setTitle("Step 2 of 3 - Twitch + Relay")
        self.setSubTitle("Tell the engine which channel to read votes from and where to relay state.")
        form = QFormLayout(self); form.setSpacing(10)
        self.twitch = QLineEdit(settings.value("twitch_channel", "") or "")
        self.twitch.setPlaceholderText("prodigalttv")
        form.addRow("Twitch channel:", self.twitch)
        self.tiktok = QLineEdit(settings.value("tiktok_username", "") or "")
        self.tiktok.setPlaceholderText("optional - your TikTok handle")
        form.addRow("TikTok handle:", self.tiktok)
        self.ext_url = QLineEdit(settings.value("ext_relay_url", "https://loadout-discord.aquiloplays.workers.dev") or "")
        form.addRow("Relay URL:", self.ext_url)
        self.ext_tok = QLineEdit(settings.value("ext_relay_token", "") or "")
        self.ext_tok.setEchoMode(QLineEdit.EchoMode.Password)
        form.addRow("Relay token:", self.ext_tok)
        hint = QLabel("Relay token is the worker's CROWDPLAY_TOKEN secret. Without it, the dock + Twitch panel can't talk to your engine. Leave blank to skip and only run engine + adapter locally.")
        hint.setWordWrap(True); hint.setObjectName("sub")
        form.addRow(hint)
        self.registerField("twitch_channel", self.twitch)

    def validatePage(self) -> bool:
        self.settings.setValue("twitch_channel", self.twitch.text().strip())
        self.settings.setValue("tiktok_username", self.tiktok.text().strip())
        self.settings.setValue("ext_relay_url", self.ext_url.text().strip())
        self.settings.setValue("ext_relay_token", self.ext_tok.text().strip())
        return True


# ── step 3: first game ──────────────────────────────────────────────────
class GamePage(QWizardPage):
    def __init__(self, settings: QSettings):
        super().__init__()
        self.settings = settings
        self.setTitle("Step 3 of 3 - First game")
        self.setSubTitle("Pick a game to start with. You can change this anytime.")
        v = QVBoxLayout(self)
        self.combo = QComboBox()
        for g in CATALOG:
            self.combo.addItem(f"{g.display}  -  {g.harness}", g.slug)
        v.addWidget(self.combo)
        msg = QLabel("After Finish, the main window opens. Use Browse... to point at this game's install folder, then click Install adapter to drop the mod into place.")
        msg.setWordWrap(True); msg.setObjectName("sub")
        v.addWidget(msg)
        v.addStretch()

    def validatePage(self) -> bool:
        self.settings.setValue("last_game", self.combo.currentData())
        return True


# ── wizard wrapper ──────────────────────────────────────────────────────
class FirstRunWizard(QWizard):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"{APP_NAME} - First run")
        self.setMinimumSize(560, 460)
        self.setWizardStyle(QWizard.WizardStyle.ModernStyle)
        self.setOption(QWizard.WizardOption.NoBackButtonOnStartPage, True)
        s = QSettings(ORG_NAME, APP_NAME)
        self.addPage(ProjectPage(s))
        self.addPage(CredsPage(s))
        self.addPage(GamePage(s))


def needs_first_run() -> bool:
    s = QSettings(ORG_NAME, APP_NAME)
    return not (s.value("project_root", "") or "").strip()
