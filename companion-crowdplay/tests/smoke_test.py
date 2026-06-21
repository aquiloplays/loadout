"""Construct every Qt widget in the Companion offscreen.

Catches PySide6 enum / import / attribute regressions BEFORE PyInstaller
packs the exe. If this script exits non-zero, the build halts and the
user sees the real error in their terminal instead of a popup on first
launch.

Usage:
    python tests/smoke_test.py

Designed for build.ps1 to gate on `python tests/smoke_test.py`.
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

# Make companion_crowdplay importable regardless of cwd
HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

# Force offscreen so the smoke test runs headless in CI / build script.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

FAILURES: list[tuple[str, str]] = []


def try_construct(name: str, factory):
    try:
        w = factory()
        # Force a layout pass so any deferred widget-spec resolution fires.
        if hasattr(w, "resize"):
            w.resize(800, 600)
        if hasattr(w, "show"):
            w.show()
            w.hide()
        print(f"OK   {name}")
    except Exception as e:
        tb = traceback.format_exc()
        FAILURES.append((name, tb))
        print(f"FAIL {name}: {e}")


def main():
    app = QApplication([])

    # Diagnostics + Test Fire (where the recent enum bug was)
    from companion_crowdplay.diagnostics import DiagnosticsTab, FireTestTab
    try_construct("DiagnosticsTab",  lambda: DiagnosticsTab())
    try_construct("FireTestTab",     lambda: FireTestTab())

    # Main window - exercises every other tab via its _build_*_tab() methods
    try:
        from companion_crowdplay.main import MainWindow
        try_construct("MainWindow",  lambda: MainWindow())
    except Exception as e:
        # Some MainWindow init paths poke the registry/network - if that fails
        # we still want the test to surface it.
        FAILURES.append(("MainWindow (import)", traceback.format_exc()))
        print(f"FAIL MainWindow (import): {e}")

    # CustomizePanel needs a QSettings instance.
    try:
        from PySide6.QtCore import QSettings
        from companion_crowdplay.customize import CustomizePanel
        try_construct("CustomizePanel",
                      lambda: CustomizePanel(QSettings("AquiloTest", "Smoke")))
    except Exception:
        FAILURES.append(("CustomizePanel", traceback.format_exc()))

    if FAILURES:
        print(f"\n{len(FAILURES)} smoke failure(s):\n")
        for name, tb in FAILURES:
            print(f"--- {name} ---")
            print(tb)
        sys.exit(1)
    print("\nAll widgets constructed without exceptions.")


if __name__ == "__main__":
    main()
