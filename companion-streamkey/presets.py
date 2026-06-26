"""Stream presets: named (title + category + matureContent) bundles the user
saves once and fires from either the dock or the tray menu.

Stored as JSON in %APPDATA%/AquiloStreamkey/presets.json with two slots:

  {
    "presets": [{name, title, category: {id, name}, matureContent, updatedAt}],
    "last":    {title, category: {id, name}, matureContent, updatedAt}
  }

`presets` is the user's named saves. `last` is the implicit "last Go Live"
slot so the tray menu can offer a one-click 'Repeat last' without forcing
the user to name every stream.

Names are unique; saving over an existing name replaces it. Order preserved
(last-saved first), so the tray menu shows freshest at top.
"""
import json
import os
import threading

from logsetup import log

_LOCK = threading.Lock()
NAME_MAX = 40
TITLE_MAX = 32


def _path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, "AquiloStreamkey")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.expanduser("~")
    return os.path.join(d, "presets.json")


def _load_raw():
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return {"presets": [], "last": None}
        d.setdefault("presets", [])
        d.setdefault("last", None)
        return d
    except (OSError, ValueError):
        return {"presets": [], "last": None}


def _save_raw(d):
    path = _path()
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        os.replace(tmp, path)
        return True
    except OSError as e:
        log(f"presets: save failed: {e}", "warning")
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def _normalize(entry):
    """Clamp + coerce a preset entry to the canonical shape."""
    cat = entry.get("category") or {}
    if not isinstance(cat, dict):
        cat = {}
    return {
        "name": str(entry.get("name") or "")[:NAME_MAX].strip(),
        "title": str(entry.get("title") or "")[:TITLE_MAX],
        "category": {
            "id": str(cat.get("id") or ""),
            "name": str(cat.get("name") or ""),
        },
        "matureContent": bool(entry.get("matureContent")),
        "updatedAt": int(entry.get("updatedAt") or 0),
    }


def list_presets():
    with _LOCK:
        return list(_load_raw().get("presets", []))


def get_last():
    with _LOCK:
        return _load_raw().get("last")


def save(name, title, category, mature_content, clock):
    """Insert or replace a preset by name. Empty name = invalid."""
    name = (name or "").strip()
    if not name:
        return {"ok": False, "reason": "preset name required"}
    entry = _normalize({
        "name": name, "title": title, "category": category,
        "matureContent": mature_content, "updatedAt": clock(),
    })
    with _LOCK:
        d = _load_raw()
        existing = [p for p in d["presets"] if p.get("name", "").lower() != name.lower()]
        d["presets"] = [entry] + existing  # newest-first
        ok = _save_raw(d)
    return {"ok": ok, "preset": entry, "count": len(d["presets"])}


def remove(name):
    name = (name or "").strip()
    if not name:
        return {"ok": False, "reason": "preset name required"}
    with _LOCK:
        d = _load_raw()
        before = len(d["presets"])
        d["presets"] = [p for p in d["presets"] if p.get("name", "").lower() != name.lower()]
        if len(d["presets"]) == before:
            return {"ok": False, "reason": f"no preset named {name!r}"}
        ok = _save_raw(d)
    return {"ok": ok, "count": len(d["presets"])}


def find(name):
    """Case-insensitive lookup by name. Returns None if missing."""
    name = (name or "").strip().lower()
    if not name:
        return None
    with _LOCK:
        for p in _load_raw().get("presets", []):
            if p.get("name", "").lower() == name:
                return p
    return None


def record_last(title, category, mature_content, clock):
    """Update the implicit 'last Go Live' slot, called by Controller.start."""
    entry = _normalize({
        "title": title, "category": category,
        "matureContent": mature_content, "updatedAt": clock(),
    })
    entry.pop("name", None)
    with _LOCK:
        d = _load_raw()
        d["last"] = entry
        _save_raw(d)
