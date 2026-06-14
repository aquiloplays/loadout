"""Companion config + secret storage under %APPDATA%\\AquiloKindle.

  config.json   non-secret prefs (daily sync hour, last sync time/count)
  secret.enc    the VAULT_INGEST_SECRET, DPAPI-encrypted (never plaintext,
                never logged)
  session.enc   the captured Amazon session cookies, DPAPI-encrypted

The ingest secret is the SAME hex Clay set as the worker's VAULT_INGEST_SECRET.
It is a shared HMAC secret, not a password; it lives encrypted at rest and is
only ever read into memory to sign an ingest request.
"""
import json
import os

import crypto

APP_DIR_NAME = "AquiloKindle"
DEFAULT_SYNC_HOUR = 4  # 4am local


def config_dir():
    base = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    d = os.path.join(base, APP_DIR_NAME)
    os.makedirs(d, exist_ok=True)
    return d


def _path(name):
    return os.path.join(config_dir(), name)


# ── non-secret prefs ───────────────────────────────────────────────────
def load_prefs():
    try:
        with open(_path("config.json"), "r", encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    return {
        "syncHour": int(d.get("syncHour", DEFAULT_SYNC_HOUR)) % 24,
        "lastSyncMs": int(d.get("lastSyncMs", 0)),
        "lastCount": int(d.get("lastCount", 0)),
        "lastError": str(d.get("lastError", "")),
    }


def save_prefs(patch):
    cur = load_prefs()
    cur.update({k: v for k, v in patch.items() if k in cur})
    try:
        with open(_path("config.json"), "w", encoding="utf-8") as f:
            json.dump(cur, f)
    except OSError:
        pass
    return cur


# ── ingest secret (DPAPI) ──────────────────────────────────────────────
def get_secret():
    # Env var wins (handy for dev), else the encrypted on-disk copy.
    env = os.environ.get("VAULT_INGEST_SECRET")
    if env:
        return env.strip()
    try:
        with open(_path("secret.enc"), "rb") as f:
            return crypto.decrypt(f.read()).decode("utf-8").strip()
    except (OSError, ValueError):
        return ""


def set_secret(secret):
    secret = (secret or "").strip()
    if not secret:
        return False
    try:
        with open(_path("secret.enc"), "wb") as f:
            f.write(crypto.encrypt(secret.encode("utf-8")))
        return True
    except OSError:
        return False


def has_secret():
    return bool(get_secret())


# ── session cookies (DPAPI) ────────────────────────────────────────────
def save_cookies(cookies):
    try:
        with open(_path("session.enc"), "wb") as f:
            f.write(crypto.encrypt(json.dumps(cookies).encode("utf-8")))
        return True
    except OSError:
        return False


def load_cookies():
    try:
        with open(_path("session.enc"), "rb") as f:
            return json.loads(crypto.decrypt(f.read()).decode("utf-8"))
    except (OSError, ValueError):
        return None


def has_session():
    return load_cookies() is not None


def clear_session():
    try:
        os.remove(_path("session.enc"))
    except OSError:
        pass
