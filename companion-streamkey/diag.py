"""Structured diagnostics for the companion.

`collect()` returns a single JSON-serializable dict the dock surfaces via
/debug/diag and the boot banner writes line-by-line to app.log. The point is
that any future "doesn't work on this machine" report can be debugged from a
log tail or a one-click clipboard paste, without us having to chase the user
for env details.

Everything here is read-only and exception-safe; a single failed probe never
breaks the whole snapshot.
"""
import os
import platform
import socket
import sys
import time

from _version import __version__


def _safe(fn, default=None):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        return f"<error: {type(e).__name__}: {str(e)[:80]}>" if default is None else default


def _port_in_use(port, host="127.0.0.1"):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def collect(controller=None, port=7480):
    """Snapshot the runtime environment. Safe to call any time."""
    import token_retriever as tok  # local import keeps diag importable in CI

    frozen = bool(getattr(sys, "frozen", False))
    meipass = getattr(sys, "_MEIPASS", None)
    exe = sys.executable
    cfg_dir = _safe(tok.config_dir, "")
    log_path = _safe(lambda: __import__("logsetup").log_path(), "")
    autostart_on = _safe(lambda: __import__("autostart").is_enabled(), False)
    watchdog_on = _safe(lambda: __import__("watchdog_task").is_enabled(), False)
    cat_snap = _safe(lambda: __import__("category_cache").load(), {"items": [], "updatedAt": None})
    cat_count = len(cat_snap.get("items", []) if isinstance(cat_snap, dict) else [])
    cat_updated = cat_snap.get("updatedAt") if isinstance(cat_snap, dict) else None

    diag = {
        "version": __version__,
        "ts": int(time.time() * 1000),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "frozen": frozen,
        "meipass": meipass,
        "runtimeTmpdir": os.path.dirname(meipass) if meipass else None,
        "exe": exe,
        "cwd": _safe(os.getcwd, ""),
        "configDir": cfg_dir,
        "logPath": log_path,
        "tempEnv": os.environ.get("TEMP") or os.environ.get("TMP"),
        "port": port,
        "portInUse": _port_in_use(port),
        "autostartEnabled": autostart_on,
        "watchdogEnabled": watchdog_on,
        "categoriesCount": cat_count,
        "categoriesUpdatedAt": cat_updated,
    }
    if controller is not None:
        diag["authed"] = _safe(controller.authed, False)
        diag["oauthFlow"] = getattr(controller, "_oauth", None)
        diag["lastError"] = getattr(controller, "_last_error", None)
    return diag


def banner_lines(diag):
    """Format a diag dict as one log line per field for the boot banner."""
    keys = ["version", "python", "platform", "frozen", "meipass", "runtimeTmpdir",
            "exe", "cwd", "configDir", "logPath", "tempEnv", "port", "portInUse",
            "autostartEnabled", "watchdogEnabled", "categoriesCount", "categoriesUpdatedAt"]
    return [f"boot {k}={diag.get(k)!r}" for k in keys if k in diag]
