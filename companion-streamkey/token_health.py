"""Track Streamlabs OAuth token health by periodic live probe.

Streamlabs' token blob (see token_retriever) doesn't include an
`expires_in` field we can compute against, so 'expiring in X days' is not
something we can predict. Instead this module:

  - Persists the result of every probe in %APPDATA%/AquiloStreamkey/
    token_health.json: {ok, at, consecutiveFailures}.
  - Runs a probe in the background every PROBE_INTERVAL_S so the dock
    preflight can show "Streamlabs token healthy" vs. "expired".
  - Fires a one-shot tray balloon the FIRST time a probe flips from OK
    to failing (so the user gets warned BEFORE they try to Go Live).

The probe re-uses `token_retriever.token_is_valid` which does a cheap
GET /tiktok/info call; a 200 means the token is good.
"""
import json
import os
import threading
import time

from logsetup import log

PROBE_INTERVAL_S = 12 * 60 * 60          # twice a day
STARTUP_DELAY_S = 8                       # let the server settle before first probe
FAILING_BALLOON_THRESHOLD = 1            # warn the user on first failing probe


def _path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, "AquiloStreamkey")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.expanduser("~")
    return os.path.join(d, "token_health.json")


def _load():
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save(data):
    path = _path()
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def status():
    """Return last-known state for /aitum/preflight + /debug/diag."""
    return _load()


def probe(clock=None):
    """Run one live probe + persist the result. Returns the new state dict."""
    import token_retriever as tok  # lazy: avoids import cycle if used in tests
    clock = clock or (lambda: int(time.time() * 1000))
    token = tok.load_cached_token()
    if not token:
        state = {"ok": False, "at": clock(), "reason": "no token cached", "consecutiveFailures": 0}
        _save(state); return state
    ok = tok.token_is_valid(token)
    prev = _load()
    state = {
        "ok": bool(ok),
        "at": clock(),
        "consecutiveFailures": 0 if ok else int(prev.get("consecutiveFailures", 0)) + 1,
    }
    if not ok:
        state["reason"] = "Streamlabs rejected the cached token"
    _save(state)
    log(f"token-health: probe ok={ok}")
    return state


class Watcher:
    """Background thread that probes every PROBE_INTERVAL_S. Fires
    `notify(title, body)` once when health flips from OK to failing so
    the user sees the tray balloon promptly without spamming on every
    repeat failure."""

    def __init__(self, notify=None):
        self.notify = notify or (lambda *_: None)
        self._stop = threading.Event()
        self._thread = None
        self._warned = False

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        self._stop.wait(STARTUP_DELAY_S)
        while not self._stop.is_set():
            try:
                state = probe()
                if not state.get("ok") and state.get("consecutiveFailures", 0) >= FAILING_BALLOON_THRESHOLD and not self._warned:
                    self._warned = True
                    self.notify("Streamlabs sign-in expired",
                                "Sign in again from the tray to keep Go Live working.")
                elif state.get("ok"):
                    self._warned = False
            except Exception as e:  # noqa: BLE001
                log(f"token-health: watcher error: {str(e)[:160]}", "warning")
            self._stop.wait(PROBE_INTERVAL_S)
