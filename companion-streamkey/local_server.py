"""Localhost HTTP server the OBS dock talks to.

Binds 127.0.0.1:7480 only and allows CORS from the aquilo.gg dock (plus
localhost for development). Holds a small Controller that owns the
Streamlabs token, the API client, the cached stream details, and the active
session credentials.

Endpoints (all JSON):
  GET  /healthz          -> { ok, version, authed }
  GET  /streamkey        -> { active, url?, key?, refreshedAt?, authed }
  GET  /stream/status    -> { live, viewers, title, category, matureContent, authed }
  POST /stream/start     -> { ok, url, key, id, refreshedAt }     body { title, category, matureContent }
  POST /stream/end       -> { ok, ended }
  POST /stream/details   -> { ok, details }                       body { title, category, matureContent }
  GET  /categories?q=    -> { categories: [{ name, id }], authed }

The RTMP URL + stream key are returned ONLY on the explicit /streamkey and
/stream/start responses (the dock surfaces them); they are never logged.
"""
import threading

from flask import Flask, jsonify, request

import token_retriever as tok
from streamlabs_api import StreamlabsTikTok, StreamlabsError
from _version import __version__

ALLOWED_ORIGINS = {"https://aquilo.gg", "http://localhost:3000", "http://127.0.0.1:3000"}
PORT = 7480


class Controller:
    """Owns auth + the active TikTok live session. Thread-safe."""

    def __init__(self, clock=None):
        self._lock = threading.Lock()
        self._clock = clock or (lambda: 0)
        self._api = None
        self._authed = False
        self.creds = None          # { url, key, id, refreshedAt }
        self.details = {"title": "", "category": "", "matureContent": False}
        self.live = False
        self._cat_cache = {}       # query -> { at_ms, items }
        self._access = None        # last known can_be_live

    # -- auth -------------------------------------------------------------
    def _ensure_api(self, allow_browser):
        """Return a StreamlabsTikTok client, acquiring a token if needed."""
        if self._api is not None:
            return self._api
        token = tok.get_token(allow_browser=allow_browser)
        if not token:
            self._authed = False
            return None
        self._api = StreamlabsTikTok(token)
        self._authed = True
        return self._api

    def authed(self):
        # Cheap: a cached token file exists. Real validity is checked on use.
        return self._authed or bool(tok.load_cached_token())

    def login(self):
        with self._lock:
            self._api = None
            return self._ensure_api(allow_browser=True) is not None

    def logout(self):
        with self._lock:
            tok.clear_token()
            self._api = None
            self._authed = False
            self.creds = None
            self.live = False

    # -- stream control ---------------------------------------------------
    def get_streamkey(self):
        with self._lock:
            if self.creds:
                return {"active": True, **self.creds, "authed": True}
            return {"active": False, "authed": self.authed()}

    # TikTok caps the live title at 32 characters.
    TITLE_MAX = 32

    def set_details(self, title, category, mature):
        with self._lock:
            self.details = {
                "title": str(title or "")[:self.TITLE_MAX],
                "category": str(category or ""),
                "matureContent": bool(mature),
            }
            return dict(self.details)

    def start(self, title, category, mature, refreshed_at):
        with self._lock:
            if title and len(str(title)) > self.TITLE_MAX:
                raise StreamlabsError(f"title-too-long (max {self.TITLE_MAX} characters)")
            self.set_details(title, category, mature)
            api = self._ensure_api(allow_browser=True)
            if api is None:
                raise StreamlabsError("not-authenticated")
            audience = "1" if self.details["matureContent"] else "0"
            url, key = api.start(self.details["title"], self.details["category"], audience)
            self.creds = {"url": url, "key": key, "id": api.stream_id, "refreshedAt": refreshed_at}
            self.live = True
            return dict(self.creds)

    def end(self):
        with self._lock:
            if self._api is None:
                self.live = False
                return True
            ok = self._api.end()
            if ok:
                self.live = False
                self.creds = None
            return ok

    def status(self):
        with self._lock:
            live = self.live
            viewers = 0
            title = self.details.get("title", "")
            category = self.details.get("category", "")
            mature = self.details.get("matureContent", False)
            if self._api is not None:
                try:
                    info = self._api.get_info() or {}
                    data = info.get("data") if isinstance(info, dict) else None
                    src = data if isinstance(data, dict) else info
                    # Best-effort: the slobs info payload shape varies; pull
                    # viewer/title fields when present, fall back to cached.
                    viewers = int(src.get("viewers") or src.get("viewer_count") or 0)
                    title = src.get("title") or title
                except (StreamlabsError, ValueError, KeyError, TypeError):
                    pass
                except Exception:
                    pass
            return {
                "live": live, "viewers": viewers, "title": title,
                "category": category, "matureContent": mature, "authed": self.authed(),
            }

    CAT_TTL_MS = 60 * 60 * 1000   # cache category search results for an hour

    @staticmethod
    def _category_enabled(c):
        # Streamlabs returns live-eligible categories from this search, but if
        # a payload ever carries an explicit eligibility flag, respect it.
        for flag in ("enabled", "live_eligible", "is_enabled", "available"):
            if flag in c and not c.get(flag):
                return False
        return True

    def categories(self, query, allow_browser):
        key = (query or "").strip().lower()
        with self._lock:
            hit = self._cat_cache.get(key)
            if hit and (self._clock() - hit["at_ms"]) < self.CAT_TTL_MS:
                return {"categories": hit["items"], "authed": True, "cached": True}
            api = self._ensure_api(allow_browser=allow_browser)
            if api is None:
                return {"categories": [], "authed": False}
            try:
                raw = api.search_categories(query)
            except Exception:
                return {"categories": [], "authed": self.authed()}
            out = [
                {"name": c.get("full_name", ""), "id": c.get("game_mask_id", "")}
                for c in raw if self._category_enabled(c) and c.get("full_name")
            ]
            self._cat_cache[key] = {"at_ms": self._clock(), "items": out}
            return {"categories": out, "authed": True}

    def access_status(self):
        """TikTok LIVE access. Cached ~60s to avoid hammering the API."""
        with self._lock:
            api = self._ensure_api(allow_browser=False)
            if api is None:
                return {"enabled": None, "authed": False}
            try:
                val = api.can_be_live()
                self._access = val
            except Exception:
                val = self._access
            return {"enabled": val, "authed": True}


def create_app(controller, clock):
    """clock() -> current epoch milliseconds (injected so the entry owns time)."""
    app = Flask(__name__)

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
        return resp

    @app.route("/healthz", methods=["GET", "OPTIONS"])
    def healthz():
        if request.method == "OPTIONS":
            return ("", 204)
        return jsonify({"ok": True, "version": __version__, "authed": controller.authed()})

    @app.route("/streamkey", methods=["GET", "OPTIONS"])
    def streamkey():
        if request.method == "OPTIONS":
            return ("", 204)
        return jsonify(controller.get_streamkey())

    @app.route("/stream/status", methods=["GET", "OPTIONS"])
    def stream_status():
        if request.method == "OPTIONS":
            return ("", 204)
        return jsonify(controller.status())

    @app.route("/categories", methods=["GET", "OPTIONS"])
    def categories():
        if request.method == "OPTIONS":
            return ("", 204)
        q = request.args.get("q", "").strip()
        return jsonify(controller.categories(q, allow_browser=False))

    @app.route("/tiktok/access-status", methods=["GET", "OPTIONS"])
    def access_status():
        if request.method == "OPTIONS":
            return ("", 204)
        return jsonify(controller.access_status())

    @app.route("/stream/details", methods=["POST", "OPTIONS"])
    def details():
        if request.method == "OPTIONS":
            return ("", 204)
        b = request.get_json(silent=True) or {}
        d = controller.set_details(b.get("title"), b.get("category"), b.get("matureContent"))
        return jsonify({"ok": True, "details": d})

    @app.route("/stream/start", methods=["POST", "OPTIONS"])
    def start():
        if request.method == "OPTIONS":
            return ("", 204)
        b = request.get_json(silent=True) or {}
        try:
            creds = controller.start(b.get("title"), b.get("category"), b.get("matureContent"), clock())
        except StreamlabsError as e:
            return jsonify({"ok": False, "error": str(e)}), 502
        except Exception as e:  # noqa: BLE001 - surface a clean message to the dock
            return jsonify({"ok": False, "error": "start-failed", "message": str(e)}), 502
        return jsonify({"ok": True, **creds})

    @app.route("/stream/end", methods=["POST", "OPTIONS"])
    def end():
        if request.method == "OPTIONS":
            return ("", 204)
        try:
            ok = controller.end()
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": "end-failed", "message": str(e)}), 502
        return jsonify({"ok": True, "ended": bool(ok)})

    return app


def serve(controller, clock):
    app = create_app(controller, clock)
    # threaded so the dock's concurrent polls do not serialise; localhost only.
    app.run(host="127.0.0.1", port=PORT, threaded=True, use_reloader=False)
