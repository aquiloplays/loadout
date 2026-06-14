"""Rotating file logger for the companion (%APPDATA%\\AquiloKindle\\app.log).

5 MB per file, 3 backups. Secrets (Amazon cookies, the ingest secret) are
NEVER logged; only counts, progress, and errors. Diagnosable from the log
alone if a sync fails.
"""
import logging
import os
from logging.handlers import RotatingFileHandler

_LOG = None
_PATH = None


def _init():
    global _LOG, _PATH
    base = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    d = os.path.join(base, "AquiloKindle")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.expanduser("~")
    _PATH = os.path.join(d, "app.log")
    lg = logging.getLogger("aquilo-kindle")
    lg.setLevel(logging.INFO)
    if not lg.handlers:
        try:
            h = RotatingFileHandler(_PATH, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
            h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            lg.addHandler(h)
        except OSError:
            pass
    _LOG = lg


def log(msg, level="info"):
    if _LOG is None:
        _init()
    getattr(_LOG, level, _LOG.info)(str(msg))


def log_path():
    if _PATH is None:
        _init()
    return _PATH


def tail(n=160):
    try:
        with open(log_path(), "r", encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:])
    except OSError:
        return ""
