"""Watches the TikTok live session for unexpected drops mid-stream and
auto-recovers by re-creating the session, re-pushing the new key to Aitum,
and re-starting Aitum's output. Designed for streams that run for hours
(when TikTok may silently close the session without the user clicking End).

How drop detection works:
  - We polled `api.get_info()` every POLL_INTERVAL_S seconds.
  - TikTok's `info` payload exposes the live state via the same fields the
    dock reads. If our local `Controller.live == True` (user did Go Live and
    has NOT clicked End) but the API reports the session as not live for
    DROP_THRESHOLD consecutive polls, we declare a drop.

Why a consecutive threshold: a single poll can hiccup (network blip,
Streamlabs 5xx) and we don't want to fire recovery on noise.

Recovery is a Controller method (recover_session) the watchdog calls. It
re-uses the LAST title/category/mature setting the user picked, calls
api.start() to get fresh creds, push_creds_and_reload to Aitum, and
aitum_start_output. Capped at MAX_RECOVERIES per session so a permanently
broken state doesn't loop forever; on exhaustion the user gets a tray
balloon and the watchdog stops.

Stops cleanly when:
  - Controller.end() is called (sets _end_requested).
  - controller.live drops to False through any normal path.
  - The watchdog's stop() is called (e.g., app quit).
"""
import threading
import time

from logsetup import log

POLL_INTERVAL_S = 60        # one minute; cheap relative to a Streamlabs roundtrip
DROP_THRESHOLD = 2          # consecutive "not live" reads before declaring drop
MAX_RECOVERIES = 3          # per Go Live session
RECOVERY_BACKOFF_S = 15     # wait between recovery attempts


class SessionWatchdog:
    def __init__(self, controller, notify=None):
        self.controller = controller
        self.notify = notify or (lambda title, body: None)
        self._stop = threading.Event()
        self._thread = None
        self._recoveries = 0
        self._consecutive_dead = 0

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._recoveries = 0
        self._consecutive_dead = 0
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        log("session-watchdog: started")

    def stop(self):
        self._stop.set()
        log("session-watchdog: stopped")

    def _run(self):
        while not self._stop.is_set():
            self._stop.wait(POLL_INTERVAL_S)
            if self._stop.is_set():
                return
            try:
                if not self._tick():
                    return  # watchdog gave up; controller wraps any state cleanup
            except Exception as e:  # noqa: BLE001
                log(f"session-watchdog: tick error: {str(e)[:160]}", "warning")

    def _tick(self):
        """One poll. Returns False if the watchdog should exit cleanly."""
        ctrl = self.controller
        # If Controller doesn't think we're live anymore (normal End), stop.
        if not getattr(ctrl, "live", False):
            log("session-watchdog: controller.live == False, exiting")
            return False
        api = getattr(ctrl, "_api", None)
        if api is None:
            return True  # no token; watchdog idles
        try:
            info = api.get_info() or {}
        except Exception as e:  # noqa: BLE001
            log(f"session-watchdog: get_info failed: {str(e)[:120]}", "warning")
            return True
        data = info.get("data") if isinstance(info, dict) else None
        src = data if isinstance(data, dict) else info
        tiktok_live = self._tiktok_says_live(src)
        if tiktok_live:
            if self._consecutive_dead:
                log(f"session-watchdog: recovered (was {self._consecutive_dead} dead reads)")
            self._consecutive_dead = 0
            return True
        self._consecutive_dead += 1
        log(f"session-watchdog: TikTok not live (count={self._consecutive_dead}/{DROP_THRESHOLD})")
        if self._consecutive_dead < DROP_THRESHOLD:
            return True
        return self._attempt_recovery()

    def _tiktok_says_live(self, src):
        """Heuristic: TikTok considers the session live if status/state says
        so OR viewer count is non-zero OR a stream id is reported. Different
        slobs responses use different shapes, so try them all."""
        for k in ("live", "is_live", "isLive", "is_streaming"):
            v = src.get(k)
            if isinstance(v, bool):
                return v
        status = (src.get("status") or src.get("stream_status") or "").lower()
        if status in ("live", "active", "streaming", "started"):
            return True
        if status in ("ended", "stopped", "inactive"):
            return False
        # Fallback: viewer_count > 0 implies live (a closed session reports 0).
        try:
            if int(src.get("viewers") or src.get("viewer_count") or 0) > 0:
                return True
        except (TypeError, ValueError):
            pass
        return False  # default: treat unknown as dead so recovery has a chance

    def _attempt_recovery(self):
        """Re-create the session via Controller.recover_session. Returns
        False to exit the watchdog (max retries exceeded), True to keep
        polling."""
        if self._recoveries >= MAX_RECOVERIES:
            log(f"session-watchdog: max recoveries ({MAX_RECOVERIES}) reached; giving up")
            self.notify("Stream drop, recovery failed",
                        f"TikTok session keeps closing after {MAX_RECOVERIES} retries. "
                        "Check TikTok / network and re-click Go Live.")
            return False
        self._recoveries += 1
        log(f"session-watchdog: attempting recovery #{self._recoveries}")
        self.notify("Stream dropped, reconnecting...",
                    f"Recovery attempt {self._recoveries} of {MAX_RECOVERIES}.")
        result = self.controller.recover_session()
        if result.get("ok"):
            self._consecutive_dead = 0
            log(f"session-watchdog: recovery #{self._recoveries} ok")
            self.notify("Stream reconnected",
                        f"TikTok session restored on attempt {self._recoveries}.")
        else:
            log(f"session-watchdog: recovery #{self._recoveries} failed: {result.get('reason')}")
            self._stop.wait(RECOVERY_BACKOFF_S)
        return True
