"""Localhost HTTP server the OBS dock talks to.

Binds 127.0.0.1:7480 only and allows CORS from the aquilo.gg dock (plus
localhost for development). Holds a Controller that owns the Streamlabs token,
the API client, the cached details, and the active session credentials.

v0.2.1 no-hang rules (a stuck go-live was the bug):
  - The PKCE browser sign-in NEVER runs inside a request handler. If there is no
    cached token a request returns awaiting_login immediately and the OAuth flow
    runs on a background thread (POST /auth/start triggers it).
  - The controller lock is held only for quick state reads/writes, never during
    a Streamlabs network call or the browser flow.
  - Every Streamlabs call has a 15s timeout; nothing blocks forever.
  - Every request + every blocking step is logged to app.log.

Endpoints (all JSON):
  GET  /healthz          -> { ok, version, authed, oauthFlow, lastError }
  GET  /streamkey        -> { active, url?, key?, refreshedAt?, authed }
  GET  /stream/status    -> { live, viewers, title, category, matureContent, authed }
  POST /stream/start     -> { ok, url, key, id, refreshedAt } | { ok:false, status:'awaiting_login', ... } | mapped error
  POST /stream/end       -> { ok, ended }
  POST /stream/details   -> { ok, details }
  GET  /categories?q=    -> { categories, authed }
  GET  /tiktok/access-status -> { enabled, authed }
  POST /auth/start       -> { ok, oauthFlow, browserOpened, loginUrl }
  GET  /debug/status     -> { tokenCached, lastError, oauthFlow, browserOpened, pending }
  GET  /debug/log        -> { ok, log }

The RTMP URL + stream key are returned ONLY on /streamkey and /stream/start;
they are never logged.
"""
import threading
import time

import requests
from flask import Flask, jsonify, request

import aitum_writer
import category_cache
import diag
import obs_ws
import presets
import session_watchdog
import settings as user_settings
import token_health
import token_retriever as tok
import webhook
import youtube_controller
from logsetup import log, tail
from streamlabs_api import StreamlabsTikTok, StreamlabsError
from _version import __version__

ALLOWED_ORIGINS = {"https://aquilo.gg", "http://localhost:3000", "http://127.0.0.1:3000"}
PORT = 7480
APPLY_URL = "https://tiktok.com/falcon/live_g/live_access_pc_apply/result/index.html?id=GL6399433079641606942&lang=en-US"


def friendly_error(e):
    """Map an exception to (code, message, http_status) for the dock."""
    if isinstance(e, requests.Timeout):
        return ("timeout", "Can't reach Streamlabs (timed out). Try again.", 504)
    if isinstance(e, requests.ConnectionError):
        return ("network", "Can't reach Streamlabs servers.", 502)
    status = getattr(e, "status", None) or getattr(getattr(e, "response", None), "status_code", None)
    txt = str(e).lower()
    if status == 401:
        return ("session_expired", "Streamlabs session expired. Use Refresh token to sign in again.", 401)
    if status == 403 or "live access" in txt or "not eligible" in txt or "permission" in txt:
        return ("no_live_access", "TikTok Live access is not enabled on this account. Use Apply for access above.", 403)
    if status == 429:
        return ("rate_limited", "Streamlabs rate limited. Try again in a minute.", 429)
    if status and status >= 500:
        return ("streamlabs_error", "Streamlabs API error. Try again shortly.", 502)
    msg = str(e)
    return ("start_failed", "Could not go live: " + (msg[:140] if msg else "unknown error"), 502)


class Controller:
    """Owns auth + the active TikTok live session. Never blocks on the browser."""

    TITLE_MAX = 32                 # TikTok caps the live title at 32 chars
    CAT_TTL_MS = 60 * 60 * 1000
    AITUM_OUTPUT_NAME = "TikTok Output"   # Aitum's default; overridable later

    def __init__(self, clock=None):
        self._lock = threading.Lock()
        self._clock = clock or (lambda: int(time.time() * 1000))
        self._api = None
        self._authed = False
        self.creds = None
        self.details = {"title": "", "category": "", "matureContent": False}
        self.live = False
        self._cat_cache = {}
        self._access = None
        # auth flow state
        self._oauth = "idle"        # idle | waiting | completed | failed
        self._browser_opened = False
        self._last_error = None
        self._auth_thread = None
        # Background sweeper keeps the on-disk category index fresh so the
        # dock autocomplete is instant even when the user has been offline
        # for a while. See [[category_cache]].
        self._cat_refresher = category_cache.Refresher(
            get_api=self._client, clock=self._clock,
        )
        self._cat_refresher.start()
        # Aitum auto-push state surfaced via /debug/diag + /aitum/status.
        self._aitum_last = {"at": None, "ok": None, "outputs": 0, "files": 0,
                             "started": None, "reason": None}
        # Long-stream watchdog: started after a successful start(), stopped
        # by end() or explicit recovery exhaustion. Notifier is wired by the
        # App during boot so tray balloons can fire from the watchdog thread.
        self._notify = lambda title, body: None
        self._watchdog = session_watchdog.SessionWatchdog(
            controller=self, notify=lambda t, b: self._notify(t, b),
        )
        # Stream stats accumulated during a Go Live so we can include them
        # in the end-of-stream Discord post (and other consumers later).
        self._stream_stats = {"startedAt": 0, "peakViewers": 0, "recoveryCount": 0, "title": ""}
        # Token-health background watcher (probes Streamlabs token every 12h
        # and tray-balloons on first failure so the user re-auths BEFORE Go
        # Live time, not during).
        self._token_health = token_health.Watcher(notify=lambda t, b: self._notify(t, b))
        self._token_health.start()
        # YouTube companion: parallel platform with its own OAuth + broadcast
        # lifecycle. Lives alongside (not inside) Controller so the TikTok
        # plumbing stays focused on the slobs path.
        self.youtube = youtube_controller.YouTubeController(clock=self._clock)

    # -- auth (never blocks a request) ------------------------------------
    def _client(self):
        """Cached client, or build one from a cached/local token. No browser."""
        with self._lock:
            if self._api is not None:
                return self._api
        token = tok.get_token(allow_browser=False)   # cached/local only, fast
        if not token:
            return None
        api = StreamlabsTikTok(token)
        with self._lock:
            self._api = api
            self._authed = True
        return api

    def authed(self):
        if self._authed:
            return True
        return bool(tok.load_cached_token())

    def start_auth(self):
        """Kick off the browser sign-in on a background thread (idempotent)."""
        with self._lock:
            if self._oauth == "waiting" and self._auth_thread and self._auth_thread.is_alive():
                return {"oauthFlow": "waiting", "browserOpened": self._browser_opened, "loginUrl": tok.LAST_AUTH_URL}
            self._oauth = "waiting"
            self._browser_opened = False
            self._auth_thread = threading.Thread(target=self._run_auth, daemon=True)
            self._auth_thread.start()
        return {"oauthFlow": "waiting", "browserOpened": self._browser_opened, "loginUrl": tok.LAST_AUTH_URL}

    def _run_auth(self):
        log("auth: waiting for Streamlabs sign-in (browser)")
        try:
            def on_open(url, opened):
                self._browser_opened = bool(opened)
            token = tok.login_via_browser(on_open=on_open)
            if token:
                tok.save_token(token)
                api = StreamlabsTikTok(token)
                with self._lock:
                    self._api = api
                    self._authed = True
                    self._oauth = "completed"
                    self._last_error = None
                log("auth: token acquired, sign-in complete")
            else:
                with self._lock:
                    self._oauth = "failed"
                    self._last_error = "login cancelled or timed out"
                log("auth: sign-in failed or timed out")
        except Exception as e:  # noqa: BLE001
            with self._lock:
                self._oauth = "failed"
                self._last_error = str(e)[:160]
            log("auth: error " + str(e)[:160], "error")

    def auth_state(self):
        return {
            "tokenCached": bool(tok.load_cached_token()),
            "oauthFlow": self._oauth,
            "browserOpened": self._browser_opened,
            "lastError": self._last_error,
            "loginUrl": tok.LAST_AUTH_URL,
        }

    def logout(self):
        with self._lock:
            self._api = None
            self._authed = False
            self.creds = None
            self.live = False
        tok.clear_token()

    # -- stream control ---------------------------------------------------
    def get_streamkey(self):
        with self._lock:
            if self.creds:
                return {"active": True, **self.creds, "authed": True}
            return {"active": False, "authed": self.authed()}

    def set_details(self, title, category, mature):
        with self._lock:
            self.details = {
                "title": str(title or "")[:self.TITLE_MAX],
                "category": str(category or ""),
                "matureContent": bool(mature),
            }
            return dict(self.details)

    def start(self, title, category, mature, refreshed_at, _record_preset=True):
        if title and len(str(title)) > self.TITLE_MAX:
            raise StreamlabsError(f"Title is over the {self.TITLE_MAX} character TikTok limit.")
        self.set_details(title, category, mature)
        api = self._client()
        if api is None:
            self.start_auth()
            log("start: no token, returning awaiting_login")
            return {"ok": False, "status": "awaiting_login",
                    "message": "Sign in to Streamlabs to continue.",
                    "browserOpened": self._browser_opened}
        audience = "1" if self.details["matureContent"] else "0"
        log(f"start: calling Streamlabs stream/start (category set={bool(self.details['category'])})")
        url, key = api.start(self.details["title"], self.details["category"], audience)  # 15s timeout, not under lock
        with self._lock:
            self.creds = {"url": url, "key": key, "id": api.stream_id, "refreshedAt": refreshed_at}
            self.live = True
            self._last_audience = audience
            out = dict(self.creds)
        log("start: live session created ok")
        # Push credentials into Aitum + auto-start its output so the user
        # never has to paste a key into Aitum. Best-effort: any failure is
        # logged and surfaced via /aitum/status but does NOT fail Go Live.
        aitum = self._push_to_aitum(url, key, auto_start=True)
        out["aitum"] = aitum
        # Remember this Go Live so the tray menu can offer a Repeat Last.
        # `start()` is also called by recover_session; that path passes
        # _record_preset=False so a recovery doesn't churn the "last" slot.
        if _record_preset:
            try:
                presets.record_last(
                    self.details.get("title", ""),
                    {"id": self.details.get("category", ""),
                     "name": self._category_display_name()},
                    self.details.get("matureContent", False),
                    self._clock,
                )
            except Exception as e:  # noqa: BLE001
                log(f"presets: record_last failed: {str(e)[:120]}", "warning")
        # Long-stream watchdog watches for TikTok dropping the session.
        try:
            self._watchdog.start()
        except Exception as e:  # noqa: BLE001
            log(f"watchdog start failed: {str(e)[:120]}", "warning")
        # Track stats for the end-of-stream webhook and reset on a fresh
        # Go Live (a recover_session keeps the existing startedAt so the
        # duration includes the gap; only a brand-new start() resets it).
        if _record_preset:
            with self._lock:
                self._stream_stats = {
                    "startedAt": self._clock(),
                    "peakViewers": 0,
                    "recoveryCount": 0,
                    "title": self.details.get("title", ""),
                }
        else:
            with self._lock:
                self._stream_stats["recoveryCount"] = self._stream_stats.get("recoveryCount", 0) + 1
        # Fire the Discord webhook (best-effort; failure does not fail Go Live).
        if _record_preset:
            try:
                webhook.send_start(
                    user_settings.load(),
                    title=self.details.get("title", ""),
                    category_name=self._category_display_name(),
                    mature=self.details.get("matureContent", False),
                    started_at_ms=self._stream_stats["startedAt"],
                )
            except Exception as e:  # noqa: BLE001
                log(f"webhook start failed: {str(e)[:120]}", "warning")
        return {"ok": True, **out}

    def _category_display_name(self):
        """Best-effort: turn the cached category id into the display name
        Aitum/dock will recognize on next quick-go-live."""
        cid = self.details.get("category", "")
        if not cid:
            return ""
        for entry in (self._cat_cache or {}).values():
            for c in entry.get("items", []):
                if c.get("id") == cid:
                    return c.get("name", "")
        # Fall back to the disk index (covers a fresh-companion case where
        # the in-memory cache hasn't been hit for this category yet).
        try:
            snap = category_cache.load()
            for c in snap.get("items", []):
                if c.get("id") == cid:
                    return c.get("name", "")
        except Exception:
            pass
        return ""

    def recover_session(self):
        """Re-create a dropped TikTok session reusing the last title /
        category / mature setting. Called by SessionWatchdog. Skips
        preset 'last' recording so we don't churn the slot during retries."""
        with self._lock:
            details = dict(self.details)
        try:
            return self.start(details.get("title", ""), details.get("category", ""),
                              details.get("matureContent", False), self._clock(),
                              _record_preset=False)
        except StreamlabsError as e:
            return {"ok": False, "reason": f"streamlabs: {str(e)[:160]}"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "reason": str(e)[:160]}

    def quick_go_live(self, preset_name):
        """Fire Go Live from a saved preset. Returns the same shape as
        /stream/start does."""
        if preset_name and preset_name.lower() == "__last__":
            p = presets.get_last()
        else:
            p = presets.find(preset_name)
        if not p:
            return {"ok": False, "reason": f"preset {preset_name!r} not found"}
        cat = p.get("category") or {}
        return self.start(p.get("title", ""), cat.get("id", ""),
                          p.get("matureContent", False), self._clock())

    def end(self):
        api = self._api
        # User explicitly clicked End -> stop the watchdog so it doesn't
        # interpret the deliberate session close as a TikTok-side drop.
        try:
            self._watchdog.stop()
        except Exception:
            pass
        # Stop Aitum's TikTok output first so the broadcast actually ends
        # at the encoder. Best-effort; failures are logged.
        try:
            r = obs_ws.aitum_stop_output(self.AITUM_OUTPUT_NAME)
            if not r.get("ok"):
                log(f"end: aitum stop_output: {r.get('reason')}", "warning")
        except Exception as e:  # noqa: BLE001
            log(f"end: aitum stop_output error: {str(e)[:120]}", "warning")
        if api is None:
            with self._lock:
                self.live = False
            self._send_end_webhook()
            return True
        ok = api.end()                      # 15s timeout, not under lock
        if ok:
            with self._lock:
                self.live = False
                self.creds = None
        self._send_end_webhook()
        return ok

    def _send_end_webhook(self):
        """Fire the Discord end-of-stream embed with duration + peak +
        recovery count. Best-effort; logged but never raised."""
        with self._lock:
            stats = dict(self._stream_stats)
            self._stream_stats = {"startedAt": 0, "peakViewers": 0, "recoveryCount": 0, "title": ""}
        duration_s = 0
        if stats.get("startedAt"):
            duration_s = max(0, int((self._clock() - stats["startedAt"]) / 1000))
        try:
            webhook.send_end(
                user_settings.load(),
                title=stats.get("title", ""),
                duration_s=duration_s,
                peak_viewers=stats.get("peakViewers", 0),
                recovery_count=stats.get("recoveryCount", 0),
            )
        except Exception as e:  # noqa: BLE001
            log(f"webhook end failed: {str(e)[:120]}", "warning")

    def _discover_aitum_output(self):
        """Ask Aitum for its outputs and pick the TikTok-shaped one. Result
        is cached on self so we only round-trip once per process unless the
        cache is invalidated (output not found anymore)."""
        cached = getattr(self, "_aitum_output_name", None)
        r = obs_ws.aitum_get_outputs()
        if not r.get("ok"):
            return cached or self.AITUM_OUTPUT_NAME, r.get("reason")
        outs = r.get("outputs", [])
        stream_outs = [o for o in outs if (o.get("type") == "stream")]
        # Prefer cached name if it still exists.
        if cached and any(o.get("name") == cached for o in stream_outs):
            return cached, None
        # Prefer one whose name says tiktok / tt; otherwise first stream output.
        def score(o):
            n = (o.get("name") or "").lower()
            if "tiktok" in n: return 0
            if "tt" in n.split(): return 1
            return 2
        stream_outs.sort(key=score)
        if not stream_outs:
            return cached or self.AITUM_OUTPUT_NAME, "no stream-type output in Aitum"
        chosen = stream_outs[0]["name"]
        self._aitum_output_name = chosen
        return chosen, None

    def _push_to_aitum(self, url, key, auto_start=False):
        """Foolproof Aitum credential push. The critical detail is that
        the file write must happen MID-BOUNCE (after switching away from
        the user profile, before switching back), because Aitum dumps its
        cached creds to disk on switch-away, overwriting any pre-bounce
        write. push_creds_and_reload encapsulates that sequence.

        Each step's outcome is recorded in self._aitum_last.steps so
        /aitum/status surfaces exactly which link in the chain failed.
        """
        steps = []
        def step(name, ok, reason=None, extra=None):
            entry = {"step": name, "ok": bool(ok)}
            if reason: entry["reason"] = reason
            if extra: entry["extra"] = extra
            steps.append(entry)
            log(f"aitum: {name} ok={bool(ok)} reason={reason or ''} extra={extra or ''}")
            return ok

        result = {"writeOk": False, "verified": False, "reloadOk": None,
                  "stopOk": None, "startOk": None, "active": None,
                  "files": 0, "outputs": 0, "outputName": None,
                  "reason": None, "steps": steps}

        # 1) Discover the output name BEFORE the bounce. After the bounce
        # Aitum's cache has the new file contents, but the name field is
        # whatever it cached -- discovering now gives us the user's last
        # known display name so stop/start_output target the right one.
        out_name, name_reason = self._discover_aitum_output()
        result["outputName"] = out_name
        step("discover_output", bool(out_name and not name_reason), name_reason, {"name": out_name})

        # 2) Stop the output if running. Safe always (Aitum no-ops if idle).
        try:
            stop_r = obs_ws.aitum_stop_output(out_name)
            result["stopOk"] = bool(stop_r.get("ok"))
            step("stop_output", stop_r.get("ok"), stop_r.get("reason"))
        except Exception as e:  # noqa: BLE001
            result["stopOk"] = False
            step("stop_output", False, f"stop error: {str(e)[:120]}")

        # 3) Profile-bounce-with-mid-write. This is the only sequence that
        # both writes our key AND survives Aitum's on-switch-away save.
        time.sleep(0.2)
        try:
            push = obs_ws.push_creds_and_reload(url, key)
        except Exception as e:  # noqa: BLE001
            step("push_creds_and_reload", False, f"push error: {str(e)[:120]}")
            result["reason"] = steps[-1].get("reason")
            self._record_aitum(result)
            return result
        result["writeOk"] = bool(push.get("writeOk"))
        result["verified"] = bool(push.get("verified"))
        result["reloadOk"] = bool(push.get("ok"))
        result["files"] = push.get("files", 0)
        result["outputs"] = push.get("outputs", 0)
        step("push_creds_and_reload", push.get("ok"), push.get("reason"),
             {"method": push.get("method"), "elapsedMs": push.get("elapsedMs"),
              "writeOk": result["writeOk"], "verified": result["verified"],
              "outputs": result["outputs"]})
        if not push.get("ok"):
            result["reason"] = push.get("reason") or "credential push failed"
            self._record_aitum(result)
            return result

        # Let the plugin settle after the profile bounce before starting.
        time.sleep(0.4)

        if not auto_start:
            self._record_aitum(result)
            return result

        # 4) Start the output. Aitum now has the fresh creds in cache.
        try:
            start_r = obs_ws.aitum_start_output(out_name)
            result["startOk"] = bool(start_r.get("ok"))
            step("start_output", start_r.get("ok"), start_r.get("reason"))
        except Exception as e:  # noqa: BLE001
            result["startOk"] = False
            step("start_output", False, f"start error: {str(e)[:120]}")

        if not result["startOk"]:
            result["reason"] = "Aitum did not start the output. Open Aitum and click Start manually."
            self._record_aitum(result)
            return result

        # 5) Verify the output really did go active.
        time.sleep(0.5)
        try:
            outs_r = obs_ws.aitum_get_outputs()
            if outs_r.get("ok"):
                match = next((o for o in outs_r.get("outputs", []) if o.get("name") == out_name), None)
                result["active"] = bool(match and match.get("active"))
                step("verify_active", result["active"], None if result["active"] else f"output '{out_name}' did not become active")
            else:
                step("verify_active", False, outs_r.get("reason"))
        except Exception as e:  # noqa: BLE001
            step("verify_active", False, f"verify error: {str(e)[:120]}")

        if result["active"] is False:
            result["reason"] = "Aitum accepted start but the output did not go active. Check Aitum's status."

        self._record_aitum(result)
        return result

    def _record_aitum(self, result):
        with self._lock:
            self._aitum_last = {
                "at": self._clock(),
                "ok": bool(result.get("writeOk") and result.get("verified")
                           and result.get("reloadOk") and
                           (result.get("startOk") in (None, True)) and
                           (result.get("active") in (None, True))),
                "writeOk": result.get("writeOk"),
                "verified": result.get("verified"),
                "reloadOk": result.get("reloadOk"),
                "stopOk": result.get("stopOk"),
                "startOk": result.get("startOk"),
                "active": result.get("active"),
                "outputs": result.get("outputs"),
                "files": result.get("files"),
                "outputName": result.get("outputName"),
                "reason": result.get("reason"),
                "steps": list(result.get("steps") or []),
            }

    def push_to_aitum(self):
        """Manual re-push of whatever credentials we currently hold. Does
        the full foolproof sequence (write -> reload -> start) so the user
        gets the same one-click experience as a fresh Go Live."""
        with self._lock:
            creds = dict(self.creds) if self.creds else None
        if not creds:
            return {"ok": False, "reason": "no active credentials; go live first"}
        return self._push_to_aitum(creds["url"], creds["key"], auto_start=True)

    def aitum_status(self):
        with self._lock:
            return {"defaultOutputName": self.AITUM_OUTPUT_NAME,
                    "discoveredOutputName": getattr(self, "_aitum_output_name", None),
                    "last": dict(self._aitum_last)}

    def youtube_go_live(self, title, description, privacy, category_id, made_for_kids):
        """Create the YouTube broadcast + stream, push the fresh key into
        Aitum's YouTube output (separate Aitum output from TikTok's), and
        return a dict matching the shape /youtube/go expects."""
        r = self.youtube.start(title=title, description=description,
                                privacy=privacy, category_id=category_id,
                                made_for_kids=made_for_kids)
        if not r.get("ok"):
            return r
        # Persist this run's metadata as the YouTube 'last used' so next
        # session can pre-fill the dock fields.
        try:
            user_settings.update({
                "ytLastTitle": title or "",
                "ytLastDescription": description or "",
                "ytLastCategoryId": category_id or "",
                "ytLastPrivacy": privacy or "public",
                "ytLastMadeForKids": bool(made_for_kids),
            })
        except Exception:
            pass
        # Push the YouTube RTMP URL + key into Aitum's YouTube output using
        # the same foolproof profile-bounce path as TikTok.
        out_name = (user_settings.load().get("aitumYouTubeOutputName") or "YouTube Output").strip()
        # YouTube returns the ingestion URL as a base (e.g. rtmp://a.rtmp.youtube.com/live2)
        # and a separate streamName, which Aitum expects as the URL + key.
        push = {"writeOk": False, "verified": False, "startOk": None, "reason": None}
        try:
            p = obs_ws.push_creds_and_reload_for("youtube", r["url"], r["key"])
            push.update({"writeOk": p.get("writeOk"), "verified": p.get("verified"),
                         "reloadOk": p.get("ok"), "files": p.get("files", 0),
                         "outputs": p.get("outputs", 0), "reason": p.get("reason"),
                         "method": p.get("method")})
        except Exception as e:  # noqa: BLE001
            push["reason"] = f"push error: {str(e)[:120]}"
        # Start the YouTube Aitum output so encoding begins.
        if push.get("reloadOk"):
            time.sleep(0.4)
            try:
                s = obs_ws.aitum_start_output(out_name)
                push["startOk"] = bool(s.get("ok"))
                if not s.get("ok"):
                    push["reason"] = s.get("reason") or "start_output failed"
            except Exception as e:  # noqa: BLE001
                push["startOk"] = False
                push["reason"] = f"start error: {str(e)[:120]}"
        r["aitum"] = push
        return r

    def youtube_end(self):
        """Stop Aitum's YouTube output + transition the broadcast to complete."""
        out_name = (user_settings.load().get("aitumYouTubeOutputName") or "YouTube Output").strip()
        try:
            obs_ws.aitum_stop_output(out_name)
        except Exception:
            pass
        return self.youtube.end()

    def aitum_preflight(self):
        """Probe every link in the chain so the dock can show readiness BEFORE
        the user clicks Go Live. Read-only; never starts a stream."""
        out = {"ok": True, "checks": []}
        def add(name, ok, reason=None, extra=None):
            entry = {"name": name, "ok": bool(ok)}
            if reason: entry["reason"] = reason
            if extra: entry["extra"] = extra
            out["checks"].append(entry)
            if not ok: out["ok"] = False
            return ok

        # Token health: cheap read of last probe state (background watcher
        # actively re-probes every 12h). A failing probe means the user has
        # to re-auth via the tray before Go Live will work.
        th = token_health.status()
        token_ok = th.get("ok")
        if token_ok is None:
            add("Streamlabs token", True, None, {"note": "not probed yet"})
        else:
            add("Streamlabs token", bool(token_ok),
                None if token_ok else (th.get("reason") or "token rejected"),
                {"lastProbe": th.get("at"), "consecutiveFailures": th.get("consecutiveFailures")})

        configs = aitum_writer.find_configs()
        add("aitum.json found", bool(configs), None if configs else "no aitum.json under obs-studio profiles", {"paths": configs})

        port, _pw, ws_enabled = obs_ws._load_obs_ws_config()
        add("obs-websocket enabled", ws_enabled, None if ws_enabled else "enable in OBS -> Tools -> WebSocket Server Settings", {"port": port})

        if not ws_enabled:
            return out

        # Vendor probe (proves OBS is up + Aitum loaded)
        v = obs_ws.aitum_get_outputs()
        add("Aitum vendor responds", v.get("ok"), v.get("reason"))
        if not v.get("ok"):
            return out

        outs = v.get("outputs", [])
        stream_outs = [o for o in outs if o.get("type") == "stream"]
        add("Aitum stream output exists", bool(stream_outs),
            None if stream_outs else "no stream-type output configured in Aitum")
        if stream_outs:
            name, reason = self._discover_aitum_output()
            add("TikTok output discoverable", bool(name and not reason), reason, {"name": name})

        # File contains a matching TikTok-shaped output
        if configs:
            try:
                import json as _json
                tiktok_in_file = False
                for c in configs:
                    with open(c, "r", encoding="utf-8") as f:
                        d = _json.load(f)
                    for o in d.get("outputs", []) or []:
                        if isinstance(o, dict) and aitum_writer._is_tiktok_output(o):
                            tiktok_in_file = True
                            break
                add("TikTok output in aitum.json", tiktok_in_file,
                    None if tiktok_in_file else "aitum.json has no output whose URL contains 'tiktok'")
            except Exception as e:  # noqa: BLE001
                add("TikTok output in aitum.json", False, f"parse error: {str(e)[:120]}")

        return out

    def status(self):
        api = self._client()
        with self._lock:
            live = self.live
            title = self.details.get("title", "")
            category = self.details.get("category", "")
            mature = self.details.get("matureContent", False)
        viewers = 0
        if api is not None:
            try:
                info = api.get_info() or {}     # not under lock
                data = info.get("data") if isinstance(info, dict) else None
                src = data if isinstance(data, dict) else info
                viewers = int(src.get("viewers") or src.get("viewer_count") or 0)
                title = src.get("title") or title
            except Exception:
                pass
        # Track peak viewers across the session for the end-of-stream webhook.
        if live and viewers:
            with self._lock:
                if viewers > self._stream_stats.get("peakViewers", 0):
                    self._stream_stats["peakViewers"] = viewers
        return {"live": live, "viewers": viewers, "title": title,
                "category": category, "matureContent": mature, "authed": self.authed()}

    def categories(self, query):
        """Substring-search the persistent disk index first (instant), only
        hit the live API as a fallback for queries the index has not seen.
        Live results are merged back into the index so future hits are
        instant too."""
        q = (query or "").strip()
        if not q:
            return {"categories": [], "authed": self.authed()}
        snap = category_cache.load()
        hits = category_cache.search(snap, q)
        if hits:
            return {"categories": hits, "authed": self.authed(), "source": "index"}
        api = self._client()
        if api is None:
            return {"categories": [], "authed": False, "source": "index"}
        try:
            raw = api.search_categories(q)
        except Exception:
            return {"categories": [], "authed": self.authed(), "source": "live"}
        out = [{"name": c.get("full_name", ""), "id": c.get("game_mask_id", "")}
               for c in raw if c.get("full_name")]
        if out:
            try:
                category_cache.save(category_cache.merge(snap, out, self._clock))
            except Exception as e:  # noqa: BLE001
                log(f"categories: merge-into-index failed: {str(e)[:120]}", "warning")
        return {"categories": out, "authed": True, "source": "live"}

    def refresh_categories(self):
        """Manual sweep, used by /categories/refresh + the tray menu."""
        api = self._client()
        if api is None:
            return {"ok": False, "authed": False, "message": "Sign in first."}
        try:
            snap = category_cache.sweep(api, self._clock)
            return {"ok": True, "count": len(snap.get("items", [])),
                    "updatedAt": snap.get("updatedAt")}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "authed": True, "message": str(e)[:160]}

    def categories_status(self):
        snap = category_cache.load()
        return {"count": len(snap.get("items", [])),
                "updatedAt": snap.get("updatedAt")}

    def access_status(self):
        api = self._client()
        if api is None:
            return {"enabled": None, "authed": False}
        try:
            val = api.can_be_live()                 # not under lock
            self._access = val
        except Exception:
            val = self._access
        return {"enabled": val, "authed": True}


def create_app(controller, clock):
    app = Flask(__name__)

    @app.before_request
    def _t0():
        request._t0 = time.time()

    @app.after_request
    def _cors(resp):
        origin = request.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Vary"] = "Origin"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
            resp.headers["Access-Control-Max-Age"] = "600"
        resp.headers["Cache-Control"] = "no-store"
        if request.method != "OPTIONS":
            dur = int((time.time() - getattr(request, "_t0", time.time())) * 1000)
            log(f"{request.method} {request.path} -> {resp.status_code} {dur}ms")
        return resp

    def opt():
        return ("", 204)

    @app.route("/healthz", methods=["GET", "OPTIONS"])
    def healthz():
        if request.method == "OPTIONS":
            return opt()
        return jsonify({"ok": True, "version": __version__, "authed": controller.authed(),
                        "oauthFlow": controller._oauth, "lastError": controller._last_error})

    @app.route("/streamkey", methods=["GET", "OPTIONS"])
    def streamkey():
        return opt() if request.method == "OPTIONS" else jsonify(controller.get_streamkey())

    @app.route("/stream/status", methods=["GET", "OPTIONS"])
    def stream_status():
        return opt() if request.method == "OPTIONS" else jsonify(controller.status())

    @app.route("/categories", methods=["GET", "OPTIONS"])
    def categories():
        return opt() if request.method == "OPTIONS" else jsonify(controller.categories(request.args.get("q", "").strip()))

    @app.route("/categories/refresh", methods=["POST", "OPTIONS"])
    def categories_refresh():
        return opt() if request.method == "OPTIONS" else jsonify(controller.refresh_categories())

    @app.route("/categories/status", methods=["GET", "OPTIONS"])
    def categories_status():
        return opt() if request.method == "OPTIONS" else jsonify(controller.categories_status())

    @app.route("/aitum/push", methods=["POST", "OPTIONS"])
    def aitum_push():
        return opt() if request.method == "OPTIONS" else jsonify(controller.push_to_aitum())

    @app.route("/aitum/status", methods=["GET", "OPTIONS"])
    def aitum_status():
        return opt() if request.method == "OPTIONS" else jsonify(controller.aitum_status())

    @app.route("/aitum/preflight", methods=["GET", "OPTIONS"])
    def aitum_preflight():
        return opt() if request.method == "OPTIONS" else jsonify(controller.aitum_preflight())

    @app.route("/presets", methods=["GET", "OPTIONS"])
    def presets_list():
        if request.method == "OPTIONS": return opt()
        return jsonify({"ok": True, "presets": presets.list_presets(), "last": presets.get_last()})

    @app.route("/presets/save", methods=["POST", "OPTIONS"])
    def presets_save():
        if request.method == "OPTIONS": return opt()
        b = request.get_json(silent=True) or {}
        return jsonify(presets.save(
            b.get("name"), b.get("title"), b.get("category"),
            b.get("matureContent"), clock,
        ))

    @app.route("/presets/delete", methods=["POST", "OPTIONS"])
    def presets_delete():
        if request.method == "OPTIONS": return opt()
        b = request.get_json(silent=True) or {}
        return jsonify(presets.remove(b.get("name")))

    @app.route("/presets/go", methods=["POST", "OPTIONS"])
    def presets_go():
        if request.method == "OPTIONS": return opt()
        b = request.get_json(silent=True) or {}
        try:
            return jsonify(controller.quick_go_live(b.get("name")))
        except StreamlabsError as e:
            code, message, status = friendly_error(e)
            return jsonify({"ok": False, "error": code, "message": message}), status
        except Exception as e:  # noqa: BLE001
            log(f"presets/go: unexpected error: {str(e)[:160]}", "error")
            return jsonify({"ok": False, "error": "go_failed", "message": str(e)[:160]}), 502

    @app.route("/settings", methods=["GET", "POST", "OPTIONS"])
    def settings_handler():
        if request.method == "OPTIONS": return opt()
        if request.method == "POST":
            return jsonify(user_settings.update(request.get_json(silent=True) or {}))
        return jsonify({"ok": True, "settings": user_settings.load()})

    @app.route("/webhook/test", methods=["POST", "OPTIONS"])
    def webhook_test():
        if request.method == "OPTIONS": return opt()
        return jsonify(webhook.send_test(user_settings.load()))

    @app.route("/token/probe", methods=["POST", "OPTIONS"])
    def token_probe_handler():
        if request.method == "OPTIONS": return opt()
        return jsonify(token_health.probe(clock))

    @app.route("/youtube/status", methods=["GET", "OPTIONS"])
    def youtube_status():
        if request.method == "OPTIONS": return opt()
        return jsonify(controller.youtube.status())

    @app.route("/youtube/auth", methods=["POST", "OPTIONS"])
    def youtube_auth():
        if request.method == "OPTIONS": return opt()
        return jsonify(controller.youtube.start_auth())

    @app.route("/youtube/signout", methods=["POST", "OPTIONS"])
    def youtube_signout():
        if request.method == "OPTIONS": return opt()
        import youtube_oauth
        youtube_oauth.clear_token()
        return jsonify({"ok": True})

    @app.route("/youtube/categories", methods=["GET", "OPTIONS"])
    def youtube_categories():
        if request.method == "OPTIONS": return opt()
        return jsonify(controller.youtube.categories(region=request.args.get("region", "US")))

    @app.route("/youtube/go", methods=["POST", "OPTIONS"])
    def youtube_go():
        if request.method == "OPTIONS": return opt()
        b = request.get_json(silent=True) or {}
        try:
            return jsonify(controller.youtube_go_live(
                title=b.get("title", ""),
                description=b.get("description", ""),
                privacy=b.get("privacy", "public"),
                category_id=b.get("categoryId") or None,
                made_for_kids=bool(b.get("madeForKids")),
            ))
        except Exception as e:  # noqa: BLE001
            log(f"youtube/go: unexpected error: {str(e)[:160]}", "error")
            return jsonify({"ok": False, "reason": str(e)[:200]}), 502

    @app.route("/youtube/end", methods=["POST", "OPTIONS"])
    def youtube_end():
        if request.method == "OPTIONS": return opt()
        try:
            return jsonify(controller.youtube_end())
        except Exception as e:  # noqa: BLE001
            log(f"youtube/end: unexpected error: {str(e)[:160]}", "error")
            return jsonify({"ok": False, "reason": str(e)[:200]}), 502

    @app.route("/tiktok/access-status", methods=["GET", "OPTIONS"])
    def access_status():
        return opt() if request.method == "OPTIONS" else jsonify(controller.access_status())

    @app.route("/stream/details", methods=["POST", "OPTIONS"])
    def details():
        if request.method == "OPTIONS":
            return opt()
        b = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "details": controller.set_details(b.get("title"), b.get("category"), b.get("matureContent"))})

    @app.route("/stream/start", methods=["POST", "OPTIONS"])
    def start():
        if request.method == "OPTIONS":
            return opt()
        b = request.get_json(silent=True) or {}
        try:
            r = controller.start(b.get("title"), b.get("category"), b.get("matureContent"), clock())
            return jsonify(r)
        except StreamlabsError as e:
            code, message, status = friendly_error(e)
            details = e.body if isinstance(getattr(e, "body", None), dict) else None
            log(f"start: Streamlabs error {code} (http {getattr(e, 'status', None)}): {str(e)[:160]}", "warning")
            return jsonify({"ok": False, "error": code, "message": message,
                            "applyUrl": APPLY_URL if code == "no_live_access" else None, "details": details}), status
        except requests.RequestException as e:
            code, message, status = friendly_error(e)
            log(f"start: network error {code}: {str(e)[:120]}", "warning")
            return jsonify({"ok": False, "error": code, "message": message}), status
        except Exception as e:  # noqa: BLE001
            log("start: unexpected error " + str(e)[:160], "error")
            return jsonify({"ok": False, "error": "start_failed", "message": "Unexpected error. Check companion logs."}), 502

    @app.route("/stream/end", methods=["POST", "OPTIONS"])
    def end():
        if request.method == "OPTIONS":
            return opt()
        try:
            return jsonify({"ok": True, "ended": bool(controller.end())})
        except Exception as e:  # noqa: BLE001
            _, message, status = friendly_error(e)
            return jsonify({"ok": False, "error": "end_failed", "message": message}), status

    @app.route("/auth/start", methods=["POST", "OPTIONS"])
    def auth_start():
        if request.method == "OPTIONS":
            return opt()
        r = controller.start_auth()
        return jsonify({"ok": True, **r})

    @app.route("/debug/status", methods=["GET", "OPTIONS"])
    def debug_status():
        return opt() if request.method == "OPTIONS" else jsonify(controller.auth_state())

    @app.route("/debug/log", methods=["GET", "OPTIONS"])
    def debug_log():
        return opt() if request.method == "OPTIONS" else jsonify({"ok": True, "log": tail(140)})

    @app.route("/debug/diag", methods=["GET", "OPTIONS"])
    def debug_diag():
        return opt() if request.method == "OPTIONS" else jsonify({"ok": True, "diag": diag.collect(controller, PORT)})

    return app


def serve(controller, clock):
    log(f"companion {__version__} server starting on 127.0.0.1:{PORT}")
    app = create_app(controller, clock)
    app.run(host="127.0.0.1", port=PORT, threaded=True, use_reloader=False)
