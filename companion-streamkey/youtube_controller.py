"""High-level YouTube-side controller: turn dock inputs into one Go Live
that creates a broadcast + stream, binds them, hands the RTMP URL + key
to whoever wants to push (typically Aitum's YouTube output), and tears
down cleanly on End.

Lives alongside (not inside) `Controller` so the TikTok plumbing stays
focused. The TikTok-side Controller calls methods here when YouTube is
enabled in the unified Go Live flow.

State machine per session:
    idle  --start-->  live  --end-->  idle
                       ^                v
                       +-- (recover) ---+
"""
import threading

import settings as user_settings
import youtube_api
import youtube_oauth
from logsetup import log


class YouTubeController:
    def __init__(self, clock):
        self._lock = threading.Lock()
        self._clock = clock
        self.broadcast_id = None
        self.stream_id = None
        self.creds = None         # {"url": ..., "key": ..., "broadcastId": ...}
        self.live = False

    # -- auth ----------------------------------------------------------------

    def _client_id(self):
        return (user_settings.load().get("googleClientId") or "").strip()

    def signed_in(self):
        return bool(youtube_oauth.load_token())

    def start_auth(self, on_open=None):
        client_id = self._client_id()
        if not client_id:
            return {"ok": False, "reason": "Set your Google Cloud OAuth Client ID in YouTube settings first."}
        def runner():
            try:
                youtube_oauth.login(client_id, on_open=on_open)
            except Exception as e:  # noqa: BLE001
                log(f"youtube: auth error: {str(e)[:160]}", "warning")
        threading.Thread(target=runner, daemon=True).start()
        return {"ok": True, "started": True}

    def status(self):
        return {
            "configured": bool(self._client_id()),
            "auth": youtube_oauth.status(),
            "live": self.live,
            "broadcastId": self.broadcast_id,
            "streamId": self.stream_id,
        }

    # -- categories ----------------------------------------------------------

    def categories(self, region="US"):
        client_id = self._client_id()
        if not client_id or not self.signed_in():
            return {"ok": False, "categories": [], "reason": "not signed in"}
        try:
            cats = youtube_api.list_categories(client_id, region=region)
            return {"ok": True, "categories": [c for c in cats if c.get("assignable")]}
        except youtube_api.YouTubeError as e:
            return {"ok": False, "categories": [], "reason": str(e)[:160]}

    # -- lifecycle -----------------------------------------------------------

    def start(self, title, description="", privacy="public",
              category_id=None, made_for_kids=False):
        """Create broadcast + stream + bind. Returns {ok, url, key,
        broadcastId} or {ok: False, reason}."""
        client_id = self._client_id()
        if not client_id:
            return {"ok": False, "reason": "Set your Google Cloud OAuth Client ID first."}
        if not self.signed_in():
            return {"ok": False, "reason": "Sign in to YouTube first (Settings -> YouTube -> Sign in)."}
        try:
            b = youtube_api.insert_broadcast(
                client_id, title=title, description=description,
                privacy=privacy, category_id=category_id,
                made_for_kids=made_for_kids,
            )
            broadcast_id = b.get("id")
            s = youtube_api.insert_stream(client_id, title=f"Aquilo {title}"[:100])
            stream_id = s.get("id")
            youtube_api.bind_broadcast(client_id, broadcast_id, stream_id)
            url, key = youtube_api.extract_rtmp(s)
            if not (url and key):
                return {"ok": False, "reason": "YouTube returned no RTMP credentials"}
            with self._lock:
                self.broadcast_id = broadcast_id
                self.stream_id = stream_id
                self.creds = {"url": url, "key": key,
                              "broadcastId": broadcast_id, "streamId": stream_id}
                self.live = True
            log(f"youtube: broadcast={broadcast_id} stream={stream_id} ok")
            return {"ok": True, "url": url, "key": key,
                    "broadcastId": broadcast_id, "streamId": stream_id}
        except youtube_api.YouTubeError as e:
            log(f"youtube start failed: {str(e)[:160]}", "warning")
            return {"ok": False, "reason": str(e)[:200], "status": e.status}

    def end(self):
        client_id = self._client_id()
        with self._lock:
            bid = self.broadcast_id
        if not bid:
            return {"ok": True, "noop": True}
        try:
            if client_id:
                youtube_api.transition_broadcast(client_id, bid, "complete")
        except youtube_api.YouTubeError as e:
            # Already complete? Treat as success so End is idempotent.
            log(f"youtube end transition: {str(e)[:160]}", "warning")
        with self._lock:
            self.broadcast_id = None
            self.stream_id = None
            self.creds = None
            self.live = False
        return {"ok": True}

    def get_creds(self):
        with self._lock:
            return dict(self.creds) if self.creds else None
