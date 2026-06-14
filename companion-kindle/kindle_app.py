"""Aquilo Kindle companion, entry point.

Runs in the system tray. Scrapes Clay's read.amazon.com/notebook highlights
on a daily schedule (and on demand) and pushes them to the Knowledge Vault.
Cookie-only auth, captured once via a real browser sign-in; no password is
ever stored. No main window.
"""
import os
import threading
import time

import autostart
import config
import local_server
import updater
from logsetup import log
from _version import __version__


def now_ms():
    return int(time.time() * 1000)


def _ask_string(title, prompt, secret=False):
    """Modal text prompt via tkinter (stdlib, bundled). Returns the string or
    None. Run from a tray callback; creates a throwaway root."""
    try:
        import tkinter as tk
        from tkinter import simpledialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        val = simpledialog.askstring(title, prompt, show="*" if secret else None, parent=root)
        root.destroy()
        return val
    except Exception as e:
        log(f"dialog failed: {str(e)[:80]}", "warning")
        return None


class App:
    def __init__(self):
        self.controller = local_server.Controller(clock=now_ms)
        self._icon = None

    # tray actions -------------------------------------------------------
    def sync(self):
        self.controller.start_sync()

    def login(self):
        self.controller.start_auth(then_sync=True)

    def set_secret_dialog(self):
        val = _ask_string("Aquilo Kindle", "Paste your VAULT_INGEST_SECRET (the same hex set on the worker):", secret=True)
        if val:
            config.set_secret(val)
            log("ingest secret saved (encrypted)")

    def set_hour_dialog(self):
        cur = config.load_prefs()["syncHour"]
        val = _ask_string("Aquilo Kindle", f"Daily sync hour, local 0-23 (current: {cur}):")
        if val and val.strip().isdigit():
            config.save_prefs({"syncHour": int(val.strip()) % 24})
            log(f"daily sync hour set to {int(val.strip()) % 24}")

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
                self.quit()

    def _first_run_autostart(self):
        marker = os.path.join(config.config_dir(), "first-run.done")
        if os.path.exists(marker):
            return
        autostart.enable()
        try:
            open(marker, "w").close()
        except OSError:
            pass

    def run(self):
        threading.Thread(target=local_server.serve, args=(self.controller, now_ms), daemon=True).start()
        threading.Thread(target=self.controller.run_scheduler, daemon=True).start()
        self._first_run_autostart()
        threading.Timer(3.0, lambda: self._do_update(False)).start()

        import tray
        self._icon = tray.build_tray(self)
        self._icon.run()


def main():
    print(f"Aquilo Kindle companion {__version__} starting (tray).")
    log(f"==== Aquilo Kindle {__version__} boot ====")
    App().run()


if __name__ == "__main__":
    main()
