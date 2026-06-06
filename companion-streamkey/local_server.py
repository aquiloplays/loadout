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

import token_retriever as tok
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

    def start(self, title, category, mature, refreshed_at):
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
            out = dict(self.creds)
        log("start: live session created ok")
        return {"ok": True, **out}

    def end(self):
        api = self._api
        if api is None:
            with self._lock:
                self.live = False
            return True
        ok = api.end()                      # 15s timeout, not under lock
        if ok:
            with self._lock:
                self.live = False
                self.creds = None
        return ok

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
        return {"live": live, "viewers": viewers, "title": title,
                "category": category, "matureContent": mature, "authed": self.authed()}

    def categories(self, query):
        key = (query or "").strip().lower()
        with self._lock:
            hit = self._cat_cache.get(key)
            if hit and (self._clock() - hit["at_ms"]) < self.CAT_TTL_MS:
                return {"categories": hit["items"], "authed": True, "cached": True}
        api = self._client()
        if api is None:
            return {"categories": [], "authed": False}
        try:
            raw = api.search_categories(query)      # not under lock
        except Exception:
            return {"categories": [], "authed": self.authed()}
        out = [{"name": c.get("full_name", ""), "id": c.get("game_mask_id", "")}
               for c in raw if c.get("full_name")]
        with self._lock:
            self._cat_cache[key] = {"at_ms": self._clock(), "items": out}
        return {"categories": out, "authed": True}

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

    return app


def serve(controller, clock):
    log(f"companion {__version__} server starting on 127.0.0.1:{PORT}")
    app = create_app(controller, clock)
    app.run(host="127.0.0.1", port=PORT, threaded=True, use_reloader=False)
