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


def _is_youtube_output(out):
    """Match an output to the YouTube destination by URL or name. YouTube
    ingest URLs look like rtmp://a.rtmp.youtube.com/live2 (multiple regional
    hosts), or rtmps://a.rtmps.youtube.com/live2."""
    if out.get("type") != "stream":
        return False
    url = (out.get("stream_server") or "").lower()
    name = (out.get("name") or "").lower()
    if "youtube.com" in url or "ytlive" in url:
        return True
    if "youtube" in name or re.search(r"\byt\b", name):
        return True
    return False


def _matcher_for(platform):
    """Resolve a platform key to its output-matcher predicate."""
    if platform == "youtube":
        return _is_youtube_output
    # Default keeps existing TikTok callers working without per-call changes.
    return _is_tiktok_output


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


def _verify(path, stream_server, stream_key, match_fn=None):
    """Read the file back and confirm every matching output has the new key.
    Catches the case where the write succeeded but OBS / Aitum / another
    process raced us and overwrote the file. Returns (ok, mismatches).

    Defaults to TikTok matcher for backward compatibility with the
    original update_tiktok call sites that don't pass match_fn."""
    match = match_fn or _is_tiktok_output
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return False, [f"reread {path}: {e}"]
    bad = []
    for i, out in enumerate(data.get("outputs", []) or []):
        if not (isinstance(out, dict) and match(out)):
            continue
        if out.get("stream_key") != stream_key:
            bad.append(f"outputs[{i}].stream_key mismatch")
        if stream_server and out.get("stream_server") != stream_server:
            bad.append(f"outputs[{i}].stream_server mismatch")
        for j, ve in enumerate(out.get("video_encoders", []) or []):
            if not isinstance(ve, dict):
                continue
            if ve.get("stream_key") != stream_key:
                bad.append(f"outputs[{i}].video_encoders[{j}].stream_key mismatch")
            if stream_server and ve.get("stream_server") != stream_server:
                bad.append(f"outputs[{i}].video_encoders[{j}].stream_server mismatch")
    return (not bad), bad


def update_destination(platform, stream_server, stream_key, configs=None, retries=2):
    """Generic platform-aware variant. `platform` is 'tiktok' (default) or
    'youtube' -- selects which outputs to rewrite. Same atomic write + verify
    pattern as update_tiktok."""
    match = _matcher_for(platform)
    return _update(match, stream_server, stream_key, configs=configs, retries=retries)


def update_tiktok(stream_server, stream_key, configs=None, retries=2):
    """Write `stream_server` + `stream_key` into every TikTok output across
    every aitum.json found. Re-reads each updated file to confirm the new
    values landed; retries on mismatch (covers a transient OBS write race).
    Returns a summary dict the dock can render.

    Empty `stream_server` means "leave the URL alone, only rotate the key",
    which is what /stream/start usually returns since the URL is stable per
    user even when the key rotates.
    """
    return _update(_is_tiktok_output, stream_server, stream_key, configs=configs, retries=retries)


def _update(match_fn, stream_server, stream_key, configs=None, retries=2):
    """Shared core for update_tiktok and update_destination."""
    configs = configs if configs is not None else find_configs()
    if not configs:
        return {"ok": False, "files": [], "outputs": 0, "verified": False,
                "error": "no aitum.json under obs-studio profiles"}

    files_touched = []
    outputs_touched = 0
    errors = []
    verified = True

    for path in configs:
        attempt_errors = []
        for attempt in range(retries + 1):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError) as e:
                attempt_errors.append(f"read {path}: {e}")
                continue
            outs = data.get("outputs", []) or []
            file_changed = False
            file_outputs = 0
            for out in outs:
                if isinstance(out, dict) and match_fn(out):
                    if _apply(out, stream_server, stream_key):
                        file_outputs += 1
                        file_changed = True
            if not file_changed:
                # File already in sync; treat as success-no-op.
                ok, _ = _verify(path, stream_server, stream_key, match_fn=match_fn)
                if ok:
                    break  # nothing to do
                # If not in sync but no fields detected as changed, the file
                # is missing the TikTok output entirely. Skip retry.
                attempt_errors.append(f"{path}: no TikTok-shaped output to update")
                break
            tmp = path + ".aquilo-tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
                os.replace(tmp, path)
            except OSError as e:
                attempt_errors.append(f"write {path}: {e}")
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                continue
            ok, bad = _verify(path, stream_server, stream_key, match_fn=match_fn)
            if ok:
                outputs_touched += file_outputs
                files_touched.append(path)
                break
            attempt_errors.append(f"verify {path} attempt {attempt + 1}: " + "; ".join(bad[:3]))
            # Brief backoff; OBS may have raced us with a save.
            import time as _t
            _t.sleep(0.25)
        else:
            verified = False
            errors.extend(attempt_errors)
            continue

    result = {
        "ok": bool(files_touched),
        "files": files_touched,
        "outputs": outputs_touched,
        "verified": verified and bool(files_touched),
    }
    if errors:
        result["errors"] = errors
    log(f"aitum_writer: outputs={outputs_touched} files={len(files_touched)} verified={result['verified']} errors={len(errors)}")
    return result
