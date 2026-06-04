"""Aquilo Streamkey companion, entry point.

Runs headless (system tray only): starts the localhost server the OBS dock
talks to, offers a one-time browser sign-in to Streamlabs, and auto-updates
from GitHub releases on launch. No main window.
"""
import os
import threading
import time

import autostart
import local_server
import token_retriever as tok
import updater
from _version import __version__


def now_ms():
    return int(time.time() * 1000)


class App:
    def __init__(self):
        self.controller = local_server.Controller()
        self._icon = None

    # tray actions -------------------------------------------------------
    def login(self):
        threading.Thread(target=self.controller.login, daemon=True).start()

    def check_update(self, manual=False):
        threading.Thread(target=self._do_update, args=(manual,), daemon=True).start()

    def quit(self):
        if self._icon is not None:
            self._icon.stop()
        os._exit(0)

    # internals ----------------------------------------------------------
    def _do_update(self, manual):
        try:
            info = updater.check()
        except Exception:
            info = None
        if not info:
            return
        if info.get("asset"):
            path = updater.download_asset(info["asset"])
            if path and updater.apply_update(path):
                # Swap scheduled; exit so the .bat can replace the exe.
                self.quit()

    def _first_run_autostart(self):
        # Enable start-with-Windows once, the first time we ever run, so the
        # companion is available when OBS opens. The user can toggle it off.
        marker = os.path.join(tok.config_dir(), "first-run.done")
        if os.path.exists(marker):
            return
        autostart.enable()
        try:
            open(marker, "w").close()
        except OSError:
            pass

    def run(self):
        # Local server (daemon) so the dock can reach it immediately.
        threading.Thread(
            target=local_server.serve, args=(self.controller, now_ms), daemon=True
        ).start()
        self._first_run_autostart()
        # Auto-update check shortly after launch (non-blocking).
        threading.Timer(3.0, lambda: self._do_update(False)).start()

        # Tray on the main thread (blocks). Imported here so a headless CI
        # import of the rest of the package does not require a display.
        import tray
        self._icon = tray.build_tray(self)
        self._icon.run()


def main():
    print(f"Aquilo Streamkey companion {__version__} starting (tray).")
    App().run()


if __name__ == "__main__":
    main()
