"""Google OAuth 2.0 (Authorization Code with PKCE) for the YouTube Data API.

Google's desktop-app OAuth flow:
  1. We generate a code_verifier + code_challenge (PKCE).
  2. We bind a loopback HTTP server to a free port; that's the redirect URI.
  3. We open the consent URL in the user's browser. They sign in + approve.
  4. Google redirects to our localhost with ?code=...; the local handler
     captures it.
  5. We POST to oauth2/token with the code + code_verifier to exchange for
     {access_token, refresh_token, expires_in}.

The refresh_token is long-lived (unlike Streamlabs' opaque token). We
persist it alongside the access_token + computed expiry so subsequent
calls just refresh transparently when access_token nears expiry.

  %APPDATA%/AquiloStreamkey/youtube_token.json
    {
      "access_token":  "...",
      "refresh_token": "...",
      "expires_at":    <ms epoch>,
      "scope":         "https://www.googleapis.com/auth/youtube ..."
    }

The client_id is user-provided (set up in their own Google Cloud project)
and is NOT a secret. We never ship a built-in one because Google requires
the OAuth consent screen to list test users, and one client_id can't
verify everyone's account. Each user owns their own project.
"""
import base64
import hashlib
import json
import os
import secrets
import socket
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlencode, urlparse, parse_qs

import requests

from logsetup import log

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"

# Minimal scope set: youtube manages broadcasts + streams; youtube.force-ssl
# is what liveBroadcasts.insert actually needs (Google quirk).
SCOPES = [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]
LAST_AUTH_URL = ""


def _token_path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, "AquiloStreamkey")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.expanduser("~")
    return os.path.join(d, "youtube_token.json")


def load_token():
    try:
        with open(_token_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_token(token):
    """Atomic write so a partial flush never leaves a corrupt token."""
    path = _token_path()
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(token, f)
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return True
    except OSError as e:
        log(f"youtube_oauth: save failed: {e}", "warning")
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def clear_token():
    try:
        os.remove(_token_path())
    except OSError:
        pass


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _pkce_pair():
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    return verifier, challenge


class _CallbackHandler(BaseHTTPRequestHandler):
    """Captures the ?code=... redirect, displays a 'login complete' page,
    sets the flow's event. Logs are suppressed to keep the console clean."""

    flow = None  # set per-server below

    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        if "code" in params:
            self.flow.code = params["code"][0]
            body = b"<h2>YouTube sign-in complete. You can close this tab.</h2>"
            code = 200
        elif "error" in params:
            self.flow.error = params["error"][0]
            body = f"<h2>YouTube sign-in failed: {self.flow.error}</h2>".encode()
            code = 400
        else:
            body = b"<h2>Unexpected callback. Try again from the tray.</h2>"
            code = 400
        self.send_response(code)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.flow.done.set()

    def log_message(self, *_):
        pass


class _PkceFlow:
    def __init__(self, client_id):
        self.client_id = client_id
        self.verifier, self.challenge = _pkce_pair()
        self.code = None
        self.error = None
        self.done = threading.Event()

    def run(self, on_open=None, timeout=300):
        global LAST_AUTH_URL
        port = _free_port()
        redirect_uri = f"http://127.0.0.1:{port}/"
        params = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "code_challenge": self.challenge,
            "code_challenge_method": "S256",
            "access_type": "offline",        # so we get a refresh_token
            "prompt": "consent",             # force consent so we always get refresh_token
        }
        url = f"{AUTH_URL}?{urlencode(params)}"
        LAST_AUTH_URL = url

        # Bind handler + per-flow attribute
        handler_cls = type("H", (_CallbackHandler,), {"flow": self})
        server = HTTPServer(("127.0.0.1", port), handler_cls)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        opened = False
        try:
            opened = webbrowser.open(url)
        except Exception:
            pass
        log(f"youtube_oauth: browser opened={opened}, awaiting callback on port {port}")
        if on_open:
            try:
                on_open(url, opened)
            except Exception:
                pass

        completed = self.done.wait(timeout=timeout)
        threading.Thread(target=server.shutdown, daemon=True).start()
        if not completed or not self.code:
            return None
        return self._exchange(redirect_uri)

    def _exchange(self, redirect_uri):
        try:
            r = requests.post(TOKEN_URL, data={
                "client_id": self.client_id,
                "code": self.code,
                "code_verifier": self.verifier,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            }, timeout=30)
        except requests.RequestException as e:
            log(f"youtube_oauth: token exchange request failed: {str(e)[:120]}", "warning")
            return None
        if r.status_code != 200:
            log(f"youtube_oauth: token exchange HTTP {r.status_code}: {r.text[:200]}", "warning")
            return None
        data = r.json()
        token = {
            "access_token": data.get("access_token"),
            "refresh_token": data.get("refresh_token"),
            "expires_at": int(time.time() * 1000) + int(data.get("expires_in", 0)) * 1000,
            "scope": data.get("scope", ""),
        }
        if not token["access_token"]:
            return None
        save_token(token)
        return token


def login(client_id, on_open=None, timeout=300):
    """Run the consent flow and persist the token. Returns the token dict
    or None on failure / cancellation."""
    if not client_id:
        return None
    return _PkceFlow(client_id).run(on_open=on_open, timeout=timeout)


def refresh_if_needed(client_id, skew_s=60):
    """Refresh the access_token if it's within `skew_s` of expiry. Returns
    the (possibly-refreshed) token dict, or None if no token / refresh
    failed."""
    tok = load_token()
    if not tok:
        return None
    expires_at = int(tok.get("expires_at") or 0)
    if expires_at - int(time.time() * 1000) > skew_s * 1000:
        return tok
    rtok = tok.get("refresh_token")
    if not rtok or not client_id:
        return None
    try:
        r = requests.post(TOKEN_URL, data={
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": rtok,
        }, timeout=30)
    except requests.RequestException as e:
        log(f"youtube_oauth: refresh request failed: {str(e)[:120]}", "warning")
        return None
    if r.status_code != 200:
        log(f"youtube_oauth: refresh HTTP {r.status_code}: {r.text[:200]}", "warning")
        return None
    data = r.json()
    tok["access_token"] = data.get("access_token", tok["access_token"])
    if data.get("refresh_token"):
        tok["refresh_token"] = data["refresh_token"]
    tok["expires_at"] = int(time.time() * 1000) + int(data.get("expires_in", 0)) * 1000
    save_token(tok)
    return tok


def get_access_token(client_id):
    """One-line shortcut for the API client. Returns the access_token
    string or None if no usable token."""
    tok = refresh_if_needed(client_id)
    return tok.get("access_token") if tok else None


def status():
    """For /youtube/status + /aitum/preflight. Cheap (file read only)."""
    tok = load_token()
    if not tok:
        return {"signedIn": False}
    return {
        "signedIn": True,
        "expiresAt": tok.get("expires_at"),
        "hasRefreshToken": bool(tok.get("refresh_token")),
        "scope": tok.get("scope", ""),
    }
