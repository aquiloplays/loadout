"""YouTube Data API v3 client for the per-stream broadcast lifecycle.

Each Go Live creates a fresh `liveBroadcast` with the user's metadata,
creates (or reuses) a `liveStream` (CDN ingestion endpoint), binds them,
and returns the RTMP URL + stream key. On End we transition the
broadcast to "complete" so YouTube cleanly closes the session.

API surface used (each request costs 50 quota units; default daily quota
is 10,000 = ~50 streams/day, plenty for a single creator):

  liveBroadcasts.insert    create the user-facing broadcast (title etc)
  liveStreams.insert       create the RTMP ingestion endpoint
  liveBroadcasts.bind      bind broadcast -> stream
  liveBroadcasts.transition  testing|live|complete state changes
  videoCategories.list     populate the dock's category dropdown

References:
  https://developers.google.com/youtube/v3/live/docs
  https://developers.google.com/youtube/v3/live/getting-started

We never write to global YouTube settings (channel, defaults). Every call
is scoped to the OAuth user's own channel via 'mine=true' or the bound
broadcast/stream id.
"""
import time

import requests

import youtube_oauth
from logsetup import log

BASE = "https://www.googleapis.com/youtube/v3"
DEFAULT_INGESTION = "rtmp"  # Aitum + OBS both push RTMP
DEFAULT_RESOLUTION = "1080p"
DEFAULT_FRAMERATE = "60fps"


class YouTubeError(Exception):
    """Raised on any non-2xx Data API response. Carries status + parsed body
    so callers can map to a friendly dock message."""
    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


def _request(method, path, client_id, params=None, json_body=None, timeout=20):
    """Authenticated wrapper. Auto-refreshes via youtube_oauth, raises
    YouTubeError on non-2xx."""
    tok = youtube_oauth.refresh_if_needed(client_id)
    if not tok:
        raise YouTubeError("YouTube not signed in", status=401)
    headers = {
        "Authorization": f"Bearer {tok['access_token']}",
        "Accept": "application/json",
    }
    if json_body is not None:
        headers["Content-Type"] = "application/json"
    url = BASE + path
    try:
        r = requests.request(method, url, headers=headers,
                             params=params, json=json_body, timeout=timeout)
    except requests.RequestException as e:
        raise YouTubeError(f"network: {str(e)[:160]}", status=None)
    if r.status_code >= 400:
        try:
            body = r.json()
        except Exception:
            body = {"raw": r.text[:240]}
        msg = body.get("error", {}).get("message") if isinstance(body, dict) else str(body)[:160]
        raise YouTubeError(msg or f"HTTP {r.status_code}", status=r.status_code, body=body)
    try:
        return r.json()
    except Exception:
        return {}


# -- broadcasts --------------------------------------------------------------

def insert_broadcast(client_id, title, description, privacy="public",
                     category_id=None, made_for_kids=False,
                     scheduled_start_time=None, enable_dvr=True):
    """Create a liveBroadcast. Returns the broadcast resource (includes id).

    `scheduled_start_time` must be RFC3339 (e.g., 2026-06-26T19:00:00Z); when
    omitted we use 'now + 1 minute' which is the convention for "start
    immediately" streams.
    """
    if not scheduled_start_time:
        # Google requires a near-future timestamp; 60s from now is the
        # convention for 'go live immediately'.
        scheduled_start_time = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 60)
        )
    body = {
        "snippet": {
            "title": (title or "Live")[:100],
            "description": description or "",
            "scheduledStartTime": scheduled_start_time,
        },
        "status": {
            "privacyStatus": privacy,             # public|unlisted|private
            "selfDeclaredMadeForKids": bool(made_for_kids),
        },
        "contentDetails": {
            "enableDvr": bool(enable_dvr),
            "enableAutoStart": True,              # auto-go-live when bytes arrive
            "enableAutoStop": True,               # auto-end on stop pushing
        },
    }
    if category_id:
        body["snippet"]["categoryId"] = str(category_id)
    return _request("POST", "/liveBroadcasts", client_id,
                    params={"part": "snippet,status,contentDetails"},
                    json_body=body)


def insert_stream(client_id, title="Aquilo ingestion",
                  resolution=DEFAULT_RESOLUTION, framerate=DEFAULT_FRAMERATE):
    """Create a liveStream (CDN endpoint). Returns the stream resource;
    cdn.ingestionInfo carries the RTMP URL + key the encoder uses."""
    body = {
        "snippet": {"title": title[:100]},
        "cdn": {
            "frameRate": framerate,
            "ingestionType": DEFAULT_INGESTION,
            "resolution": resolution,
        },
    }
    return _request("POST", "/liveStreams", client_id,
                    params={"part": "snippet,cdn,status"},
                    json_body=body)


def bind_broadcast(client_id, broadcast_id, stream_id):
    return _request("POST", "/liveBroadcasts/bind", client_id,
                    params={"part": "id,contentDetails",
                            "id": broadcast_id, "streamId": stream_id})


def transition_broadcast(client_id, broadcast_id, status):
    """status must be one of: testing, live, complete."""
    return _request("POST", "/liveBroadcasts/transition", client_id,
                    params={"part": "id,status",
                            "id": broadcast_id, "broadcastStatus": status})


def get_broadcast(client_id, broadcast_id):
    return _request("GET", "/liveBroadcasts", client_id,
                    params={"part": "id,snippet,status,contentDetails",
                            "id": broadcast_id})


def list_categories(client_id, region="US"):
    """videoCategories.list — populates the dock's category dropdown.
    YouTube category ids are stable (Gaming=20, etc) so the dock can also
    cache this. Returns [{id, title, assignable}]."""
    raw = _request("GET", "/videoCategories", client_id,
                   params={"part": "snippet", "regionCode": region})
    out = []
    for item in raw.get("items", []):
        s = item.get("snippet", {})
        out.append({
            "id": item.get("id"),
            "title": s.get("title", ""),
            "assignable": bool(s.get("assignable")),
        })
    return out


def extract_rtmp(stream_resource):
    """Pull (rtmpUrl, streamName) out of a liveStream.cdn.ingestionInfo.
    Aitum + OBS join these into the actual RTMP URL + key fields."""
    cdn = (stream_resource or {}).get("cdn", {})
    info = cdn.get("ingestionInfo", {})
    return info.get("ingestionAddress", ""), info.get("streamName", "")
