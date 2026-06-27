"""Minimal obs-websocket v5 client for triggering Aitum outputs.

Reads OBS's own config to find the WebSocket port + password (so the user
never has to paste anything into the companion), then exposes the few
calls we need (`call_aitum`, `obs_call`, plus aitum start/stop/get and
`force_aitum_reload`).

The critical primitive is `force_aitum_reload`. Aitum's plugin caches
output settings in memory at profile-load time and ignores changes to
`aitum.json` until the user switches OBS profiles. Empirically (verified
by mutating outputs[0].name and observing get_outputs):
  - Writing the file alone: no effect.
  - stop_output + start_output: no effect.
  - Create temp profile -> switch to temp -> switch back -> delete temp:
    Aitum re-reads aitum.json. Works.
So `force_aitum_reload` does exactly that profile-bounce so a freshly
written stream key actually reaches the encoder.

Connection is per-call rather than persistent because Aitum interactions
are infrequent (one per Go Live / End), and a persistent socket would have
to handle OBS restarting under us. Per-call keeps the code dead simple and
fails fast when OBS is not running.

Uses websocket-client (synchronous). Auth handshake is the standard
obs-websocket v5 challenge: sha256(password + salt) base64 -> sha256(that +
challenge) base64.
"""
import base64
import hashlib
import json
import os
import time

from logsetup import log

OBS_WS_HOST = "127.0.0.1"
OBS_WS_PORT_DEFAULT = 4455
AITUM_VENDOR = "aitum-stream-suite"
RELOAD_PROFILE_NAME = "AquiloStreamkeyReload"   # transient, deleted after use

# Profile-scoped config files OBS reads on SetCurrentProfile. Copying these
# from the user profile to the helper profile BEFORE the bounce makes the
# switch visually a no-op (docks + encoder + service stay identical) while
# still tripping Aitum's profile-changed handler. Without this sync, OBS
# rearranges every dock + restarts the encoder during the bounce -- that's
# the flicker users see. aitum.json is intentionally excluded (we want
# Aitum to read fresh creds from the user profile's file mid-bounce).
PROFILE_MIRROR_FILES = ("basic.ini", "service.json", "streamEncoder.json")


def _config_path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "obs-studio", "plugin_config", "obs-websocket", "config.json")


def _load_obs_ws_config():
    """Return (port, password, enabled). All None / False on read failure."""
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return (
            int(cfg.get("server_port") or OBS_WS_PORT_DEFAULT),
            cfg.get("server_password") or "",
            bool(cfg.get("server_enabled")),
        )
    except (OSError, ValueError):
        return (OBS_WS_PORT_DEFAULT, "", False)


def _authenticate(ws, password, hello):
    """Reply to an obs-websocket v5 Hello with Identify (op 1)."""
    auth_info = hello["d"].get("authentication")
    auth_string = ""
    if auth_info and password:
        salt = auth_info["salt"]
        challenge = auth_info["challenge"]
        s1 = base64.b64encode(hashlib.sha256((password + salt).encode()).digest()).decode()
        auth_string = base64.b64encode(hashlib.sha256((s1 + challenge).encode()).digest()).decode()
    identify = {"op": 1, "d": {"rpcVersion": 1, "eventSubscriptions": 0}}
    if auth_string:
        identify["d"]["authentication"] = auth_string
    ws.send(json.dumps(identify))
    reply = json.loads(ws.recv())
    if reply.get("op") != 2:
        raise RuntimeError(f"obs-ws identify failed: {reply}")


class _Session:
    """One authenticated obs-websocket connection. Use via `with _open() as s:`
    so multiple requests share one connection (avoids reconnect on every step
    of a multi-call sequence like the profile reload bounce)."""
    def __init__(self, ws):
        self.ws = ws

    def __enter__(self):
        return self

    def __exit__(self, *a):
        try:
            self.ws.close()
        except Exception:
            pass

    def request(self, request_type, request_data=None, timeout=4):
        self.ws.settimeout(timeout)
        req_id = f"aquilo-{int(time.time() * 1000000)}"
        self.ws.send(json.dumps({
            "op": 6,
            "d": {"requestType": request_type, "requestId": req_id, "requestData": request_data or {}},
        }))
        reply = json.loads(self.ws.recv())
        rd = reply.get("d", {})
        status = rd.get("requestStatus", {})
        if not status.get("result"):
            return {"ok": False, "reason": status.get("comment") or "request failed", "code": status.get("code")}
        return {"ok": True, "data": rd.get("responseData", {})}

    def vendor(self, request_type, request_data=None, timeout=4):
        r = self.request("CallVendorRequest", {
            "vendorName": AITUM_VENDOR,
            "requestType": request_type,
            "requestData": request_data or {},
        }, timeout=timeout)
        if not r.get("ok"):
            return r
        inner = r["data"].get("responseData", {})
        ok = bool(inner.get("success", True))
        return {"ok": ok, "data": inner, "reason": None if ok else inner.get("error")}


def _open():
    """Authenticated session, or raise. Caller wraps in try/except to convert
    to a {'ok': False, 'reason': ...} dict."""
    try:
        import websocket
    except ImportError:
        raise RuntimeError("websocket-client not installed")
    port, password, enabled = _load_obs_ws_config()
    if not enabled:
        raise RuntimeError(f"obs-websocket disabled in OBS settings (port {port})")
    try:
        ws = websocket.create_connection(f"ws://{OBS_WS_HOST}:{port}", timeout=4)
    except Exception as e:
        raise RuntimeError(f"OBS not reachable on {port}: {str(e)[:120]}")
    try:
        hello = json.loads(ws.recv())
        _authenticate(ws, password, hello)
    except Exception as e:
        try:
            ws.close()
        except Exception:
            pass
        raise RuntimeError(f"obs-ws auth failed: {str(e)[:120]}")
    return _Session(ws)


def _safe_session(fn):
    """Run fn(session) inside a fresh connection; convert exceptions to
    {'ok': False, 'reason': ...}."""
    try:
        with _open() as s:
            return fn(s)
    except RuntimeError as e:
        return {"ok": False, "reason": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"obs-ws error: {str(e)[:120]}"}


def call_aitum(request_type, request_data=None, timeout=4):
    """One-shot vendor call. Use the session-based path for multi-step flows."""
    return _safe_session(lambda s: s.vendor(request_type, request_data, timeout=timeout))


def obs_call(request_type, request_data=None, timeout=4):
    """One-shot core obs-websocket call (e.g. GetProfileList, SetCurrentProfile)."""
    return _safe_session(lambda s: s.request(request_type, request_data, timeout=timeout))


def aitum_start_output(name):
    return call_aitum("start_output", {"output": name})


def aitum_stop_output(name):
    return call_aitum("stop_output", {"output": name})


def aitum_get_outputs():
    r = call_aitum("get_outputs")
    if not r.get("ok"):
        return r
    return {"ok": True, "outputs": r["data"].get("outputs", [])}


def _profile_dir(profile_name):
    base = os.environ.get("APPDATA")
    if not base or not profile_name:
        return None
    return os.path.join(base, "obs-studio", "basic", "profiles", profile_name)


def _mirror_helper_to(user_profile_name):
    """Copy basic.ini + service.json + streamEncoder.json from `user_profile_name`
    into the helper profile so OBS sees identical settings on the bounce
    switch. Best-effort: any per-file copy failure is logged and skipped
    (the bounce still works, just with more visual flicker). atomic via
    tmp + rename so a half-flushed file can't break OBS's load.

    Excludes aitum.json on purpose -- we want Aitum to re-read the user
    profile's aitum.json mid-bounce, which only happens because the
    profile-changed event fires; helper having its own aitum.json content
    is fine since we never write to it during the user-targeted push."""
    src_dir = _profile_dir(user_profile_name)
    dst_dir = _profile_dir(RELOAD_PROFILE_NAME)
    if not src_dir or not dst_dir:
        return {"ok": False, "reason": "profile dir not found"}
    if not os.path.isdir(src_dir):
        return {"ok": False, "reason": f"source profile dir missing: {src_dir}"}
    if not os.path.isdir(dst_dir):
        return {"ok": False, "reason": f"helper profile dir missing: {dst_dir}"}
    copied = []
    errors = []
    for fname in PROFILE_MIRROR_FILES:
        src = os.path.join(src_dir, fname)
        dst = os.path.join(dst_dir, fname)
        if not os.path.isfile(src):
            continue
        tmp = dst + ".aquilo-tmp"
        try:
            with open(src, "rb") as r:
                data = r.read()
            with open(tmp, "wb") as w:
                w.write(data)
            os.replace(tmp, dst)
            copied.append(fname)
        except OSError as e:
            errors.append(f"{fname}: {e}")
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return {"ok": not errors, "copied": copied, "errors": errors}


def ensure_reload_helper_profile():
    """Make sure the persistent OBS profile we use for force-reload bounces
    exists. Called once at companion startup so per-Go-Live reloads can be
    just two SetCurrentProfile calls (no CreateProfile + RemoveProfile cost,
    saves ~1-1.5s per Go Live).

    Idempotent: returns ok if the helper already exists. The profile sticks
    around between sessions on purpose; cleaning it up every shutdown would
    re-introduce the create/delete latency.
    """
    def run(s):
        pl = s.request("GetProfileList")
        if not pl.get("ok"):
            return {"ok": False, "reason": "GetProfileList failed: " + str(pl.get("reason"))}
        profiles = pl["data"].get("profiles", []) or []
        if RELOAD_PROFILE_NAME in profiles:
            return {"ok": True, "created": False}
        cr = s.request("CreateProfile", {"profileName": RELOAD_PROFILE_NAME}, timeout=8)
        if not cr.get("ok"):
            return {"ok": False, "reason": "CreateProfile failed: " + str(cr.get("reason"))}
        time.sleep(0.6)  # OBS needs a moment to finalize before next call
        return {"ok": True, "created": True}
    return _safe_session(run)


def push_creds_and_reload_for(platform, stream_server, stream_key, configs=None):
    """Platform-aware variant of push_creds_and_reload. `platform` is one of
    'tiktok' (default) or 'youtube' -- routes the write through
    aitum_writer.update_destination so YouTube outputs use the YouTube
    matcher. Same bounce + verify sequence as the TikTok-only path."""
    import aitum_writer
    return _push_with_writer(
        lambda: aitum_writer.update_destination(platform, stream_server, stream_key, configs),
    )


def push_creds_and_reload(stream_server, stream_key, configs=None):
    """The ONLY way to reliably get a fresh stream_key into Aitum.

    The naive sequence (write file -> bounce profiles) loses the write,
    because Aitum's on-switch-away handler dumps its in-memory cache (the
    STALE creds) back to disk, overwriting whatever we just wrote.
    Empirically verified: stream_key file edit survived the bounce when
    written AFTER the switch-away, but was overwritten when written before.

    Correct order:
      1. SetCurrentProfile -> helper. Aitum dumps its cached creds to the
         user-profile aitum.json (overwriting any pre-write we'd done,
         which is why writing first is futile). 0.7s settle.
      2. update_tiktok(stream_server, stream_key) writes the fresh creds.
         Aitum is on the helper profile now; it isn't watching user's file
         and can't undo our edit. ~0.3s settle.
      3. SetCurrentProfile -> back to user. Aitum loads user/aitum.json
         from disk, picks up our fresh creds, caches them. 0.7s settle.

    Returns {ok, writeOk, verified, files, outputs, reason, elapsedMs,
    method, currentProfile} -- everything Controller needs for /aitum/status.
    """
    # Lazy import keeps obs_ws importable in CI without aitum_writer's deps.
    import aitum_writer
    return _push_with_writer(
        lambda: aitum_writer.update_tiktok(stream_server, stream_key, configs),
    )


def _push_with_writer(writer_fn):
    """Shared bounce sequence parameterized by which writer to call mid-bounce.
    See push_creds_and_reload for the long explanation of why the write
    has to happen between the two SetCurrentProfile calls."""
    def run(s):
        t0 = time.time()
        pl = s.request("GetProfileList")
        if not pl.get("ok"):
            return {"ok": False, "reason": "GetProfileList failed: " + str(pl.get("reason"))}
        data = pl["data"]
        current = data.get("currentProfileName")
        all_profiles = data.get("profiles", []) or []

        if current == RELOAD_PROFILE_NAME:
            recover_to = next((p for p in all_profiles if p != current), None)
            if not recover_to:
                return {"ok": False, "reason": f"only profile is the helper '{current}'; can't recover"}
            s.request("SetCurrentProfile", {"profileName": recover_to}, timeout=8)
            time.sleep(0.7)
            current = recover_to

        if RELOAD_PROFILE_NAME in all_profiles and current != RELOAD_PROFILE_NAME:
            other = RELOAD_PROFILE_NAME
            method = "persistent-helper"
        else:
            other = next((p for p in all_profiles if p != current and p != RELOAD_PROFILE_NAME), None)
            if other:
                method = "existing-profile"
            else:
                cr = s.request("CreateProfile", {"profileName": RELOAD_PROFILE_NAME}, timeout=8)
                if not cr.get("ok"):
                    return {"ok": False, "reason": "CreateProfile failed: " + str(cr.get("reason"))}
                time.sleep(0.7)
                other = RELOAD_PROFILE_NAME
                method = "created-helper"

        # 0. Mirror the user's basic.ini / service.json / streamEncoder.json
        # into the helper profile. With identical OBS-level settings on
        # both profiles, the visible UI rebuild (docks + encoder) during
        # the bounce becomes a no-op while Aitum's profile-changed handler
        # still fires. Only fires when we're actually going to use the
        # helper (which is the common case).
        mirror = None
        if other == RELOAD_PROFILE_NAME:
            try:
                mirror = _mirror_helper_to(current)
            except Exception as e:  # noqa: BLE001
                log(f"obs-ws: helper mirror error: {str(e)[:120]}", "warning")

        # 1. Switch away. Aitum dumps its stale cache to user/aitum.json.
        sw1 = s.request("SetCurrentProfile", {"profileName": other}, timeout=8)
        if not sw1.get("ok"):
            return {"ok": False, "reason": f"SetCurrentProfile({other}) failed: " + str(sw1.get("reason"))}
        time.sleep(0.7)

        # 2. NOW write the fresh creds. Aitum can't undo this -- it's on the helper.
        try:
            w = writer_fn()
        except Exception as e:  # noqa: BLE001
            # Try to put the user back on their profile anyway.
            s.request("SetCurrentProfile", {"profileName": current}, timeout=8)
            return {"ok": False, "reason": f"file write error: {str(e)[:120]}"}
        time.sleep(0.3)

        # 3. Switch back. Aitum loads user/aitum.json -> picks up our creds.
        sw2 = s.request("SetCurrentProfile", {"profileName": current}, timeout=8)
        if not sw2.get("ok"):
            return {"ok": False, "reason": f"SetCurrentProfile(back to {current}) failed; OBS may be on '{other}'", "writeOk": w.get("ok"), "verified": w.get("verified")}
        time.sleep(0.7)

        return {
            "ok": bool(w.get("ok") and w.get("verified")),
            "writeOk": bool(w.get("ok")),
            "verified": bool(w.get("verified")),
            "files": len(w.get("files", [])),
            "outputs": w.get("outputs", 0),
            "method": method,
            "currentProfile": current,
            "elapsedMs": int((time.time() - t0) * 1000),
            "reason": (w.get("errors") or [None])[0] if not w.get("ok") else None,
            "mirror": mirror,
        }

    return _safe_session(run)


def force_aitum_reload(session=None):
    """Force Aitum to re-read aitum.json from disk WITHOUT writing creds.

    Use this for the manual-refresh path (tray menu or /aitum/refresh)
    when the user's file is already correct and we just need Aitum to
    notice. For the credential-push path, use push_creds_and_reload
    which writes the file mid-bounce so Aitum's save can't overwrite it.

    Sleep timing is calibrated: shorter than ~0.5s and OBS coalesces the
    two SetCurrentProfile calls into a no-op. With 0.6s sleeps Aitum's
    cache is reliably refreshed; total bounce is ~1.7s. The visible OBS
    UI flash during that window is unavoidable.

    Prefers a pre-created persistent RELOAD_PROFILE_NAME helper (created
    by ensure_reload_helper_profile at startup) so we avoid CreateProfile
    + RemoveProfile costs. Falls back to any existing user profile, or
    creates the helper on demand if missing.

    Returns {'ok', 'reason', 'method', 'currentProfile', 'elapsedMs'}.
    """
    def run(s):
        t0 = time.time()
        pl = s.request("GetProfileList")
        if not pl.get("ok"):
            return {"ok": False, "reason": "GetProfileList failed: " + str(pl.get("reason"))}
        data = pl["data"]
        current = data.get("currentProfileName")
        all_profiles = data.get("profiles", []) or []

        # If the current profile is somehow the helper (prior reload left us
        # stranded), switch to any other profile first or create+switch to
        # one so the rest of the bounce makes sense.
        if current == RELOAD_PROFILE_NAME:
            recover_to = next((p for p in all_profiles if p != current), None)
            if not recover_to:
                return {"ok": False, "reason": f"only profile is the helper '{current}'; can't recover"}
            s.request("SetCurrentProfile", {"profileName": recover_to}, timeout=8)
            time.sleep(0.6)
            current = recover_to

        # Prefer the persistent helper for predictable behavior; fall back
        # to any other existing profile if helper is missing.
        if RELOAD_PROFILE_NAME in all_profiles and current != RELOAD_PROFILE_NAME:
            other = RELOAD_PROFILE_NAME
            method = "persistent-helper"
        else:
            other = next((p for p in all_profiles if p != current and p != RELOAD_PROFILE_NAME), None)
            if other:
                method = "existing-profile"
            else:
                # No suitable profile and no helper. Create the helper now;
                # subsequent reloads will hit the persistent-helper path.
                cr = s.request("CreateProfile", {"profileName": RELOAD_PROFILE_NAME}, timeout=8)
                if not cr.get("ok"):
                    return {"ok": False, "reason": "CreateProfile failed: " + str(cr.get("reason"))}
                time.sleep(0.6)
                other = RELOAD_PROFILE_NAME
                method = "created-helper"

        # Mirror user profile -> helper profile so OBS sees identical
        # settings on the bounce switch (kills the dock-rearrange flicker).
        if other == RELOAD_PROFILE_NAME:
            try:
                _mirror_helper_to(current)
            except Exception as e:  # noqa: BLE001
                log(f"obs-ws: helper mirror error: {str(e)[:120]}", "warning")

        sw1 = s.request("SetCurrentProfile", {"profileName": other}, timeout=8)
        if not sw1.get("ok"):
            return {"ok": False, "reason": f"SetCurrentProfile({other}) failed: " + str(sw1.get("reason"))}
        time.sleep(0.6)
        sw2 = s.request("SetCurrentProfile", {"profileName": current}, timeout=8)
        if not sw2.get("ok"):
            return {"ok": False, "reason": f"SetCurrentProfile(back to {current}) failed; OBS may be on '{other}'"}
        time.sleep(0.6)

        return {"ok": True, "method": method, "currentProfile": current,
                "elapsedMs": int((time.time() - t0) * 1000)}

    if session is not None:
        return run(session)
    return _safe_session(run)
