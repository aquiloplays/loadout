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


def force_aitum_reload(session=None):
    """Force Aitum to re-read aitum.json from disk. Aitum has no in-API
    reload primitive; the only known trigger is an OBS profile change, so
    we create a transient profile, switch to it, switch back, then delete
    it. Returns a {'ok', 'reason', 'method', 'currentProfile'} dict.

    Accepts an existing session for the multi-call sequence; opens its own
    if None. Tolerates partial state from prior failed reloads (a leftover
    AquiloStreamkeyReload profile is reused / deleted).
    """
    def run(s):
        pl = s.request("GetProfileList")
        if not pl.get("ok"):
            return {"ok": False, "reason": "GetProfileList failed: " + str(pl.get("reason"))}
        data = pl["data"]
        current = data.get("currentProfileName")
        all_profiles = data.get("profiles", []) or []

        # Prefer switching to an existing other profile (faster, no create/delete).
        other = next((p for p in all_profiles if p != current and p != RELOAD_PROFILE_NAME), None)
        method = "existing-profile"
        temp_created = False

        if not other:
            # Single-profile setup: create a transient one, reuse if leftover.
            if RELOAD_PROFILE_NAME not in all_profiles:
                cr = s.request("CreateProfile", {"profileName": RELOAD_PROFILE_NAME}, timeout=8)
                if not cr.get("ok"):
                    return {"ok": False, "reason": "CreateProfile failed: " + str(cr.get("reason"))}
                temp_created = True
                # OBS takes ~half a second to finalize a profile create. If we
                # SetCurrentProfile too quickly the profile isn't in the index
                # yet and the switch fails with a generic "request failed".
                time.sleep(0.6)
            other = RELOAD_PROFILE_NAME
            method = "temp-profile"

        try:
            sw1 = s.request("SetCurrentProfile", {"profileName": other}, timeout=8)
            if not sw1.get("ok"):
                return {"ok": False, "reason": f"SetCurrentProfile({other}) failed: " + str(sw1.get("reason"))}
            time.sleep(0.8)
            sw2 = s.request("SetCurrentProfile", {"profileName": current}, timeout=8)
            if not sw2.get("ok"):
                # Worst-case: we left the user on the temp profile. Surface loudly.
                return {"ok": False, "reason": f"SetCurrentProfile(back to {current}) failed; OBS may be on '{other}'"}
            time.sleep(0.8)
        finally:
            if temp_created:
                # Best-effort cleanup. Switching back may have left the temp around.
                s.request("RemoveProfile", {"profileName": RELOAD_PROFILE_NAME}, timeout=8)

        return {"ok": True, "method": method, "currentProfile": current}

    if session is not None:
        return run(session)
    return _safe_session(run)
