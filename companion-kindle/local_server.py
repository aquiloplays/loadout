"""Controller + tiny localhost control server for the Kindle companion.

The Controller owns the sync pipeline (authenticated driver -> scrape ->
ingest) and the daily scheduler. The HTTP server on 127.0.0.1:7481 exposes
status + manual triggers for the tray and any future OBS/dock surface. All
heavy work runs on background threads so the tray never blocks.
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import config
import notebook_scraper
import token_retriever as tok
import vault_client
from logsetup import log

PORT = 7481
ALLOWED_ORIGIN = "https://aquilo.gg"


def now_ms():
    return int(time.time() * 1000)


class Controller:
    def __init__(self, clock=now_ms):
        self.clock = clock
        self._lock = threading.Lock()
        self.syncing = False
        self.authing = False
        self.progress = ""
        prefs = config.load_prefs()
        self.last_sync_ms = prefs["lastSyncMs"]
        self.last_count = prefs["lastCount"]
        self.last_error = ""

    # ── status ──────────────────────────────────────────────────────────
    def status(self):
        return {
            "ok": True,
            "syncing": self.syncing,
            "authing": self.authing,
            "progress": self.progress,
            "lastSyncMs": self.last_sync_ms,
            "lastCount": self.last_count,
            "lastError": self.last_error,
            "hasSecret": config.has_secret(),
            "hasSession": config.has_session(),
            "syncHour": config.load_prefs()["syncHour"],
        }

    def _set_progress(self, i, total, title):
        self.progress = f"Syncing book {i}/{total}: {title[:40]}"

    # ── auth ────────────────────────────────────────────────────────────
    def start_auth(self, then_sync=True):
        if self.authing:
            return
        self.authing = True
        threading.Thread(target=self._run_auth, args=(then_sync,), daemon=True).start()

    def _run_auth(self, then_sync):
        try:
            ok = tok.login_interactive()
            self.last_error = "" if ok else "Sign-in was not completed."
            if ok and then_sync:
                self._do_sync()
        finally:
            self.authing = False

    # ── sync ────────────────────────────────────────────────────────────
    def start_sync(self):
        if self.syncing:
            return
        threading.Thread(target=self._do_sync, daemon=True).start()

    def _do_sync(self):
        with self._lock:
            if self.syncing:
                return
            self.syncing = True
        self.progress = "Starting..."
        try:
            if not config.has_secret():
                self.last_error = "Ingest secret not set. Use the tray menu to paste it."
                log("sync aborted: no ingest secret", "warning")
                return
            driver = tok.build_authenticated_driver()
            if driver is None:
                self.last_error = "Sign-in needed. Use 'Sign in to Amazon' in the tray."
                log("sync: no valid session, prompting login", "warning")
                return
            try:
                highlights = notebook_scraper.scrape(driver, progress=self._set_progress)
            finally:
                try:
                    driver.quit()
                except Exception:
                    pass
            self.progress = f"Uploading {len(highlights)} highlights..."
            res = vault_client.push(highlights)
            if res.get("ok"):
                self.last_sync_ms = self.clock()
                self.last_count = len(highlights)
                self.last_error = ""
                config.save_prefs({"lastSyncMs": self.last_sync_ms, "lastCount": self.last_count, "lastError": ""})
                log(f"sync done: {len(highlights)} scraped, {res.get('inserted', 0)} new")
            else:
                self.last_error = "Upload failed: " + str(res.get("error", "unknown"))
                log(self.last_error, "error")
        except Exception as e:
            self.last_error = "Sync error: " + str(e)[:120]
            log(self.last_error, "error")
        finally:
            self.progress = ""
            self.syncing = False

    # ── daily scheduler ─────────────────────────────────────────────────
    def run_scheduler(self):
        """Fire a sync once per day at the configured local hour."""
        last_fired_day = None
        while True:
            try:
                lt = time.localtime()
                hour = config.load_prefs()["syncHour"]
                day = (lt.tm_year, lt.tm_yday)
                if lt.tm_hour == hour and last_fired_day != day and config.has_secret() and config.has_session():
                    last_fired_day = day
                    log("scheduler: daily sync trigger")
                    self.start_sync()
            except Exception as e:
                log(f"scheduler error: {str(e)[:80]}", "warning")
            time.sleep(45)


# ── HTTP server ─────────────────────────────────────────────────────────
def _make_handler(controller):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass  # silence default stderr logging

        def _send(self, obj, status=200):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("access-control-allow-origin", ALLOWED_ORIGIN)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith("/healthz"):
                self._send({"ok": True})
            elif self.path.startswith("/status"):
                self._send(controller.status())
            else:
                self._send({"error": "not-found"}, 404)

        def do_POST(self):
            if self.path.startswith("/sync"):
                controller.start_sync()
                self._send({"ok": True, "started": True})
            elif self.path.startswith("/auth"):
                controller.start_auth()
                self._send({"ok": True, "started": True})
            else:
                self._send({"error": "not-found"}, 404)

    return H


def serve(controller, _clock=now_ms):
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), _make_handler(controller))
        log(f"control server on 127.0.0.1:{PORT}")
        httpd.serve_forever()
    except OSError as e:
        log(f"control server failed to bind :{PORT} ({str(e)[:60]})", "warning")
