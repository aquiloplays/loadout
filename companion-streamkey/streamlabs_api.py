"""Thin wrapper over the Streamlabs Desktop (slobs) TikTok API.

Ported and tidied from the reference project Stream.py
(github.com/Loukious/StreamLabsTikTokStreamKeyGenerator). Every call is
authorized with the Streamlabs OAuth token obtained by token_retriever.

The key fact this module encodes: TikTok / Streamlabs has no "fetch the
stream key" call. The RTMP URL + stream key only exist once a live session
is created via stream/start, which returns them together. end() tears the
session down. So "get the key" is the same action as "create the live
session"; the broadcast only actually goes live once an encoder (OBS /
Aitum) starts pushing to that URL + key.
"""
import requests

# Mimic the Streamlabs Desktop Electron client so the slobs endpoints answer.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) StreamlabsDesktop/1.20.4 Chrome/122.0.6261.156 "
    "Electron/29.3.1 Safari/537.36"
)
BASE = "https://streamlabs.com/api/v5/slobs/tiktok"


class StreamlabsError(Exception):
    """Raised when the slobs API returns an error payload."""


class StreamlabsTikTok:
    def __init__(self, token):
        self._token = token
        self.s = requests.Session()
        self.s.headers.update({
            "user-agent": USER_AGENT,
            "authorization": f"Bearer {token}",
        })
        # Id of the currently active live session (set by start()).
        self.stream_id = None

    # -- categories -------------------------------------------------------
    def search_categories(self, query):
        """TikTok game categories matching `query`. Empty query -> []."""
        if not query:
            return []
        # The API 500s on category strings longer than 25 chars.
        query = str(query)[:25]
        r = self.s.get(f"{BASE}/info", params={"category": query}, timeout=20)
        r.raise_for_status()
        data = r.json()
        cats = list(data.get("categories", []))
        # The reference appends an explicit "Other" with an empty mask id.
        cats.append({"full_name": "Other", "game_mask_id": ""})
        return cats

    # -- live session -----------------------------------------------------
    def start(self, title, category, audience_type="0"):
        """Create the TikTok live session. Returns (rtmp_url, stream_key).

        category is the game_mask_id (empty string is allowed = "Other").
        audience_type "0" = everyone, "1" = mature (18+).
        """
        files = (
            ("title", (None, str(title or ""))),
            ("device_platform", (None, "win32")),
            ("category", (None, str(category or ""))),
            ("audience_type", (None, str(audience_type or "0"))),
        )
        r = self.s.post(f"{BASE}/stream/start", files=files, timeout=30)
        r.raise_for_status()
        data = r.json()
        if "rtmp" not in data or "key" not in data:
            # Surface the message without leaking the key (there is none here).
            raise StreamlabsError(str(data.get("message") or data.get("error") or data))
        self.stream_id = data.get("id")
        return data["rtmp"], data["key"]

    def end(self):
        """End the active live session. No-op (returns True) if none is set."""
        if not self.stream_id:
            return True
        r = self.s.post(f"{BASE}/stream/{self.stream_id}/end", timeout=30)
        r.raise_for_status()
        ok = bool(r.json().get("success"))
        if ok:
            self.stream_id = None
        return ok

    def get_info(self):
        """Raw slobs tiktok/info payload (account + any live-session state)."""
        r = self.s.get(f"{BASE}/info", timeout=20)
        r.raise_for_status()
        return r.json()
