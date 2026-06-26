"""Minimal obs-websocket v5 client for triggering Aitum outputs.

Reads OBS's own config to find the WebSocket port + password (so the user
never has to paste anything into the companion), then exposes
`call_aitum(request_type, request_data)` and the two we actually use,
`aitum_start_output(name)` / `aitum_stop_output(name)`.

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


def call_aitum(request_type, request_data=None, timeout=4):
    """Send a single CallVendorRequest to aitum-stream-suite and return its
    response dict. Returns a {'ok': False, 'reason': ...} dict on connection
    or auth failure; never raises.
    """
    try:
        import websocket  # lazy import keeps the bare exe smaller if unused
    except ImportError:
        return {"ok": False, "reason": "websocket-client not installed"}

    port, password, enabled = _load_obs_ws_config()
    if not enabled:
        return {"ok": False, "reason": "obs-websocket disabled in OBS settings"}

    try:
        ws = websocket.create_connection(f"ws://{OBS_WS_HOST}:{port}", timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"OBS not reachable on {port}: {str(e)[:120]}"}

    try:
        hello = json.loads(ws.recv())
        _authenticate(ws, password, hello)
        req_id = f"aquilo-{int(time.time() * 1000)}"
        req = {
            "op": 6, "d": {
                "requestType": "CallVendorRequest",
                "requestId": req_id,
                "requestData": {
                    "vendorName": AITUM_VENDOR,
                    "requestType": request_type,
                    "requestData": request_data or {},
                },
            },
        }
        ws.send(json.dumps(req))
        reply = json.loads(ws.recv())
    except Exception as e:  # noqa: BLE001
        try:
            ws.close()
        except Exception:
            pass
        return {"ok": False, "reason": f"obs-ws call failed: {str(e)[:120]}"}
    try:
        ws.close()
    except Exception:
        pass

    rd = reply.get("d", {})
    status = rd.get("requestStatus", {})
    if not status.get("result"):
        return {"ok": False, "reason": status.get("comment") or "request failed", "raw": reply}
    inner = rd.get("responseData", {}).get("responseData", {})
    return {"ok": bool(inner.get("success", True)), "data": inner}


def aitum_start_output(name):
    return call_aitum("start_output", {"output": name})


def aitum_stop_output(name):
    return call_aitum("stop_output", {"output": name})


def aitum_get_outputs():
    r = call_aitum("get_outputs")
    if not r.get("ok"):
        return r
    return {"ok": True, "outputs": r["data"].get("outputs", [])}
