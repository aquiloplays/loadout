"""Write a freshly-generated TikTok stream key + server straight into Aitum's
on-disk config so the user never has to paste credentials into Aitum's UI.

Aitum's OBS plugin stores its config at
  %APPDATA%/obs-studio/basic/profiles/<profile>/aitum.json
with an `outputs` array. Each stream-type output has two parallel copies of
the credentials we need to keep in sync:
  outputs[N].stream_server  +  outputs[N].stream_key
  outputs[N].video_encoders[M].stream_server  +  .stream_key

We update every output that looks like a TikTok push target (URL substring
match, fallback to name substring) across every OBS profile we can find,
since one user may have several profiles all pointed at the same TikTok
account.

We never delete entries we don't recognize and we write atomically via
tmpfile + os.replace so a partial flush can never leave a half-baked file.
"""
import json
import os
import re

from logsetup import log


def _profiles_root():
    base = os.environ.get("APPDATA")
    if not base:
        return None
    p = os.path.join(base, "obs-studio", "basic", "profiles")
    return p if os.path.isdir(p) else None


def find_configs():
    """Return every aitum.json under every OBS profile, newest first."""
    root = _profiles_root()
    if not root:
        return []
    out = []
    try:
        for name in os.listdir(root):
            cfg = os.path.join(root, name, "aitum.json")
            if os.path.isfile(cfg):
                out.append(cfg)
    except OSError:
        return []
    out.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return out


def _is_tiktok_output(out):
    """Match an output to the TikTok destination by URL or name."""
    if out.get("type") != "stream":
        return False
    url = (out.get("stream_server") or "").lower()
    name = (out.get("name") or "").lower()
    if "tiktok" in url or "tiktokcdn" in url:
        return True
    if "tiktok" in name or re.search(r"\btt\b", name):
        return True
    return False


def _apply(out, stream_server, stream_key):
    """Update the credentials in the output AND its nested video_encoders."""
    changed = False
    if stream_server and out.get("stream_server") != stream_server:
        out["stream_server"] = stream_server
        changed = True
    if out.get("stream_key") != stream_key:
        out["stream_key"] = stream_key
        changed = True
    for ve in out.get("video_encoders", []) or []:
        if not isinstance(ve, dict):
            continue
        if stream_server and ve.get("stream_server") != stream_server:
            ve["stream_server"] = stream_server
            changed = True
        if ve.get("stream_key") != stream_key:
            ve["stream_key"] = stream_key
            changed = True
    return changed


def update_tiktok(stream_server, stream_key, configs=None):
    """Write `stream_server` + `stream_key` into every TikTok output across
    every aitum.json found. Returns a summary dict the dock can render.

    Empty `stream_server` means "leave the URL alone, only rotate the key",
    which is what /stream/start usually returns since the URL is stable per
    user even when the key rotates.
    """
    configs = configs if configs is not None else find_configs()
    if not configs:
        return {"ok": False, "files": [], "outputs": 0, "error": "no aitum.json under obs-studio profiles"}

    files_touched = []
    outputs_touched = 0
    errors = []

    for path in configs:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            errors.append(f"read {path}: {e}")
            continue
        outs = data.get("outputs", []) or []
        file_changed = False
        for out in outs:
            if isinstance(out, dict) and _is_tiktok_output(out):
                if _apply(out, stream_server, stream_key):
                    outputs_touched += 1
                    file_changed = True
        if not file_changed:
            continue
        tmp = path + ".aquilo-tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, path)
            files_touched.append(path)
        except OSError as e:
            errors.append(f"write {path}: {e}")
            try:
                os.unlink(tmp)
            except OSError:
                pass

    result = {
        "ok": bool(files_touched),
        "files": files_touched,
        "outputs": outputs_touched,
    }
    if errors:
        result["errors"] = errors
    log(f"aitum_writer: outputs={outputs_touched} files={len(files_touched)} errors={len(errors)}")
    return result
