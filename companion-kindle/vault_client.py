"""Push scraped highlights to the worker's ingest endpoint.

Contract (discord-bot/vault.js handleKindleIngest):
  POST <worker>/vault/kindle/ingest
  headers: x-aquilo-vault-ts = unix seconds,
           x-aquilo-vault-sig = hex HMAC-SHA256( ts + "\n" + rawBody )  keyed by VAULT_INGEST_SECRET
  body: { "highlights": [ {book_title, book_author, location, asin, highlight_text, color, note} ] }
  reply: { ok, inserted, skipped }

The worker dedupes by a deterministic id (asin|location|text), so re-sending
the whole library every day is safe and cheap. The ingest secret is read from
config (DPAPI) and used only to sign; it is never logged.
"""
import hashlib
import hmac
import json
import os
import time

import requests

import config
from logsetup import log

# The endpoint lives on the worker, not the Pages site. Override with
# AQUILO_VAULT_INGEST_URL if the worker URL ever changes.
INGEST_URL = os.environ.get(
    "AQUILO_VAULT_INGEST_URL",
    "https://loadout-discord.aquiloplays.workers.dev/vault/kindle/ingest",
)
CHUNK = 500


def _sign(secret, ts, body):
    msg = (ts + "\n" + body).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def push(highlights):
    """Send highlights in chunks. Returns {ok, inserted, skipped, error?}."""
    secret = config.get_secret()
    if not secret:
        return {"ok": False, "error": "no-secret"}
    if not highlights:
        return {"ok": True, "inserted": 0, "skipped": 0}

    inserted = 0
    skipped = 0
    for start in range(0, len(highlights), CHUNK):
        batch = highlights[start:start + CHUNK]
        body = json.dumps({"highlights": batch})
        ts = str(int(time.time()))
        sig = _sign(secret, ts, body)
        try:
            r = requests.post(
                INGEST_URL,
                data=body,
                headers={
                    "content-type": "application/json",
                    "x-aquilo-vault-ts": ts,
                    "x-aquilo-vault-sig": sig,
                    "user-agent": "aquilo-kindle-companion",
                },
                timeout=30,
            )
        except requests.RequestException as e:
            log(f"ingest: network error {str(e)[:80]}", "error")
            return {"ok": False, "error": "network", "inserted": inserted, "skipped": skipped}
        if r.status_code == 401:
            return {"ok": False, "error": "bad-secret", "inserted": inserted, "skipped": skipped}
        if r.status_code == 503:
            return {"ok": False, "error": "secret-not-set-on-worker", "inserted": inserted, "skipped": skipped}
        if not r.ok:
            log(f"ingest: HTTP {r.status_code}", "error")
            return {"ok": False, "error": f"http-{r.status_code}", "inserted": inserted, "skipped": skipped}
        try:
            d = r.json()
        except ValueError:
            d = {}
        inserted += int(d.get("inserted", 0))
        skipped += int(d.get("skipped", 0))
        log(f"ingest: batch {start // CHUNK + 1} -> +{d.get('inserted', 0)} new")
    return {"ok": True, "inserted": inserted, "skipped": skipped}
