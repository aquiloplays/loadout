"""Persistent on-disk index of TikTok stream categories.

The Streamlabs slobs API has no "list all categories" endpoint; it only
answers prefix searches via `GET /info?category=<query>`. To make the dock's
autocomplete instant and resilient (the companion may be offline, or TikTok
may have renamed/removed a category since the user last saw it), we sweep
the full alphabet on a background thread and persist the union to disk.

  %APPDATA%\\AquiloStreamkey\\categories.json
    {
      "updatedAt": <ms>,
      "items": [ {"name": "Just Chatting", "id": "<game_mask_id>"}, ... ]
    }

Lookup pipeline (see Controller.categories):
  1. Substring-match against the on-disk index. If we have hits, return them
     immediately (no network roundtrip).
  2. Only if the index returned nothing AND we are authed, fall through to a
     live Streamlabs call to catch a brand-new game the sweep has not seen
     yet. Merge the live result into the index so the next query is instant.

The sweep itself is rate-friendly: one HTTP call per single-letter prefix,
~26 calls total, ~5-10s wall-clock, then once every 24h while the companion
is authed. A `force` parameter lets the tray (or a future endpoint) refresh
on demand.
"""
import json
import os
import string
import threading
import time

import token_retriever as tok
from logsetup import log

REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000   # daily
STALE_AT_MS = 7 * 24 * 60 * 60 * 1000       # force a sweep if older than a week
SWEEP_PREFIXES = list(string.ascii_lowercase) + list(string.digits)
MAX_RESULTS = 40


def _path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, "AquiloStreamkey")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.expanduser("~")
    return os.path.join(d, "categories.json")


def load():
    """Return {'updatedAt': int|None, 'items': list[{'name','id'}]}.
    Missing / corrupt file returns an empty snapshot, never raises.
    """
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        items = [c for c in data.get("items", []) if c.get("name")]
        return {"updatedAt": data.get("updatedAt"), "items": items}
    except (OSError, ValueError):
        return {"updatedAt": None, "items": []}


def save(snapshot):
    """Write atomically so a partial flush never leaves a half-baked file."""
    path = _path()
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False)
        os.replace(tmp, path)
        return True
    except OSError as e:
        log(f"category_cache: save failed: {e}", "warning")
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def search(snapshot, query, limit=MAX_RESULTS):
    """Case-insensitive substring search; falls through to startswith ranking
    so 'mine' yields Minecraft before Game-with-mine-in-the-middle."""
    q = (query or "").strip().lower()
    if not q:
        return []
    starts, contains = [], []
    for c in snapshot.get("items", []):
        n = c.get("name", "")
        nl = n.lower()
        if nl.startswith(q):
            starts.append(c)
        elif q in nl:
            contains.append(c)
    out = starts + contains
    return out[:limit]


def merge(snapshot, items, clock):
    """Dedupe + persist. Returns new snapshot."""
    by = {}
    for c in snapshot.get("items", []):
        key = (c.get("name", "").lower(), c.get("id", ""))
        if key[0]:
            by[key] = {"name": c["name"], "id": c.get("id", "")}
    for c in items:
        name = c.get("name") or c.get("full_name") or ""
        if not name:
            continue
        cid = c.get("id") or c.get("game_mask_id") or ""
        by[(name.lower(), cid)] = {"name": name, "id": cid}
    out_items = sorted(by.values(), key=lambda c: c["name"].lower())
    return {"updatedAt": clock(), "items": out_items}


def sweep(api, clock, prefixes=None):
    """Enumerate categories by querying each prefix. Returns the new snapshot.

    `api` is a StreamlabsTikTok instance. Individual prefix failures are
    logged and skipped; we still persist whatever we collected so a partial
    sweep is better than nothing.
    """
    snap = load()
    prefixes = prefixes or SWEEP_PREFIXES
    seen_total = 0
    for p in prefixes:
        try:
            raw = api.search_categories(p)
        except Exception as e:  # noqa: BLE001
            log(f"category_cache: sweep prefix {p!r} failed: {str(e)[:120]}", "warning")
            continue
        seen_total += len(raw)
        snap = merge(snap, raw, clock)
    save(snap)
    log(f"category_cache: swept {len(prefixes)} prefixes, {seen_total} raw / {len(snap['items'])} unique, file={_path()}")
    return snap


def needs_refresh(snapshot, clock, interval_ms=REFRESH_INTERVAL_MS):
    ts = snapshot.get("updatedAt")
    if not isinstance(ts, (int, float)):
        return True
    return (clock() - ts) >= interval_ms


class Refresher:
    """Background thread that sweeps categories periodically while authed.

    Owned by Controller; stop() is unused in production (process exits with
    the tray) but kept for tests.
    """
    def __init__(self, get_api, clock, interval_ms=REFRESH_INTERVAL_MS, initial_delay_s=5.0):
        self._get_api = get_api
        self._clock = clock
        self._interval_ms = interval_ms
        self._initial_delay_s = initial_delay_s
        self._stop = threading.Event()
        self._thread = None
        self._last_sweep_ms = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def status(self):
        snap = load()
        return {
            "count": len(snap.get("items", [])),
            "updatedAt": snap.get("updatedAt"),
            "lastSweepMs": self._last_sweep_ms,
        }

    def _run(self):
        # Wait until the server is up + auth is settled before hammering the API.
        self._stop.wait(self._initial_delay_s)
        while not self._stop.is_set():
            snap = load()
            if needs_refresh(snap, self._clock, self._interval_ms):
                api = self._get_api()
                if api is not None:
                    try:
                        sweep(api, self._clock)
                        self._last_sweep_ms = self._clock()
                    except Exception as e:  # noqa: BLE001
                        log(f"category_cache: refresher sweep failed: {str(e)[:160]}", "warning")
            # Re-check hourly. Cheap: load() is just a file read, sweep only
            # actually fires when needs_refresh is true.
            self._stop.wait(60 * 60)
