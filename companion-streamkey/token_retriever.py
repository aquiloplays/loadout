"""Streamlabs OAuth token acquisition for the companion.

Ported from the reference project's TokenRetriever.py
(github.com/Loukious/StreamLabsTikTokStreamKeyGenerator), which uses a PKCE
browser-login flow (NOT a local Streamlabs Desktop config-file read). The
companion caches the resulting token so login is a one-time step, not a
per-stream one.

Order of attempts in get_token():
  1. A valid cached token (companion config dir), unless force=True.
  2. A best-effort read of a token from a local Streamlabs Desktop install.
     The on-disk format is undocumented, so this is opportunistic and almost
     always falls through.
  3. The PKCE browser-login flow: open the Streamlabs TikTok login in the
     default browser, catch the callback on a local port, exchange the code
     for an oauth_token, and cache it.

The token is a secret: it is cached to disk (user-profile only) but never
printed to stdout/logs.
"""
import base64
import hashlib
import json
import os
import socket
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import requests

AUTH_DATA_URL = "https://streamlabs.com/api/v5/slobs/auth/data"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) StreamlabsDesktop/1.20.4 Chrome/122.0.6261.156 "
    "Electron/29.3.1 Safari/537.36"
)


def config_dir():
    base = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    d = os.path.join(base, "AquiloStreamkey")
    os.makedirs(d, exist_ok=True)
    return d


def _token_path():
    return os.path.join(config_dir(), "token.json")


def load_cached_token():
    try:
        with open(_token_path(), "r", encoding="utf-8") as f:
            tok = json.load(f).get("oauth_token")
            return tok or None
    except (OSError, ValueError):
        return None


def save_token(token):
    try:
        with open(_token_path(), "w", encoding="utf-8") as f:
            json.dump({"oauth_token": token}, f)
        # Best-effort tighten perms on POSIX; Windows ACLs already user-scoped.
        try:
            os.chmod(_token_path(), 0o600)
        except OSError:
            pass
    except OSError:
        pass


def clear_token():
    try:
        os.remove(_token_path())
    except OSError:
        pass


def token_is_valid(token):
    """Cheap liveness check: the tiktok/info call 200s with a good token."""
    if not token:
        return False
    try:
        r = requests.get(
            "https://streamlabs.com/api/v5/slobs/tiktok/info",
            headers={"user-agent": USER_AGENT, "authorization": f"Bearer {token}"},
            timeout=15,
        )
        return r.status_code == 200
    except requests.RequestException:
        return False


def _try_local_streamlabs_token():
    """Opportunistic read of a token from a local Streamlabs Desktop install.

    The slobs-client on-disk credential format is undocumented and has
    changed across versions, so this intentionally stays conservative: it
    scans a couple of likely config files for an `oauth_token`/`apiToken`
    field and returns the first plausible match, else None. The browser flow
    is the reliable path; this just saves a login when it happens to work.
    """
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    candidates = [
        os.path.join(appdata, "slobs-client", "app.json"),
        os.path.join(appdata, "slobs-client", "config.json"),
        os.path.join(appdata, "slobs-client", "basic.json"),
    ]
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        for key in ("oauth_token", "apiToken", "token"):
            val = data.get(key) if isinstance(data, dict) else None
            if isinstance(val, str) and len(val) > 16:
                return val
    return None


class _PkceFlow:
    def __init__(self):
        self.code_verifier = os.urandom(64).hex()
        digest = hashlib.sha256(self.code_verifier.encode()).digest()
        self.code_challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
        self._auth_code = None
        self._done = threading.Event()

    @staticmethod
    def _free_port():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def _handler(self):
        flow = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                params = parse_qs(urlparse(self.path).query)
                ok = params.get("success", [""])[0] == "true" and "code" in params
                if ok:
                    flow._auth_code = params["code"][0]
                    body = b"<h2>Aquilo Streamkey: login complete. You can close this tab.</h2>"
                    code = 200
                else:
                    body = b"<h2>Login failed. Please try again from the tray app.</h2>"
                    code = 400
                self.send_response(code)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                flow._done.set()

            def log_message(self, *_):
                pass

        return H

    def run(self, timeout=300):
        port = self._free_port()
        server = HTTPServer(("127.0.0.1", port), self._handler())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        auth_url = (
            "https://streamlabs.com/slobs/login?"
            "skip_splash=true&external=electron&tiktok&force_verify"
            f"&origin=slobs&port={port}"
            f"&code_challenge={self.code_challenge}&code_flow=true"
        )
        webbrowser.open(auth_url)
        completed = self._done.wait(timeout=timeout)
        threading.Thread(target=server.shutdown, daemon=True).start()
        if not completed or not self._auth_code:
            return None
        return self._exchange(self._auth_code)

    def _exchange(self, code):
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
            "Accept-Language": "en-US",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        }
        try:
            r = requests.get(
                AUTH_DATA_URL,
                params={"code_verifier": self.code_verifier, "code": code},
                headers=headers, timeout=30,
            )
        except requests.RequestException:
            return None
        if r.status_code != 200:
            return None
        try:
            data = r.json()
        except ValueError:
            return None
        if not data.get("success"):
            return None
        return (data.get("data") or {}).get("oauth_token")


def login_via_browser(timeout=300):
    """Run the PKCE browser flow and return an oauth_token, or None."""
    return _PkceFlow().run(timeout=timeout)


def get_token(force=False, allow_browser=True):
    """Resolve a usable Streamlabs token. Returns the token string or None.

    Caches a freshly acquired token. Validates a cached token cheaply and
    re-auths if it has gone stale.
    """
    if not force:
        cached = load_cached_token()
        if cached and token_is_valid(cached):
            return cached

    local = _try_local_streamlabs_token()
    if local and token_is_valid(local):
        save_token(local)
        return local

    if not allow_browser:
        return None

    token = login_via_browser()
    if token:
        save_token(token)
        return token
    return None
