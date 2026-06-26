"""Fire-and-forget Discord webhook posts for Go Live and stream end.

The whole module is best-effort by design: any network / 4xx / format error
is logged and swallowed so a webhook misconfiguration never breaks Go Live.
If `discordPings` is off OR `discordWebhookUrl` is empty, every send is a
no-op.

Embed shape mirrors what the Twitch-side live-ping uses (memory
[[twitch-live-ping-vod-welcome-logo]]): one rich embed per event so the
Discord channel reads cleanly.

Webhooks are HTTP-only (no auth), so the URL is the secret. We never log
the URL contents -- only "configured" / "not configured" state.
"""
import datetime

import requests

from logsetup import log

TIMEOUT_S = 5
TIKTOK_COLOR = 0xff0050        # TikTok pink/red
AQUILO_FOOTER = "Aquilo Streamkey companion"


def _post(url, payload):
    try:
        r = requests.post(url, json=payload, timeout=TIMEOUT_S,
                          headers={"Content-Type": "application/json"})
        if r.status_code >= 400:
            log(f"webhook: HTTP {r.status_code} {r.text[:160]}", "warning")
            return False
        return True
    except requests.RequestException as e:
        log(f"webhook: post failed: {str(e)[:120]}", "warning")
        return False


def _iso(ts_ms):
    if not ts_ms:
        return datetime.datetime.utcnow().isoformat() + "Z"
    return datetime.datetime.utcfromtimestamp(ts_ms / 1000).isoformat() + "Z"


def send_start(settings, title, category_name, mature, started_at_ms):
    """Post the 'going live' embed. Skips silently if disabled / unconfigured."""
    if not settings.get("discordPings", True):
        return {"ok": False, "reason": "discordPings off"}
    url = (settings.get("discordWebhookUrl") or "").strip()
    if not url:
        return {"ok": False, "reason": "no webhook URL configured"}
    fields = []
    if category_name:
        fields.append({"name": "Category", "value": category_name, "inline": True})
    fields.append({"name": "Mature (18+)", "value": "Yes" if mature else "No", "inline": True})
    embed = {
        "title": "Live on TikTok",
        "description": (title or "(no title)")[:200],
        "color": TIKTOK_COLOR,
        "fields": fields,
        "timestamp": _iso(started_at_ms),
        "footer": {"text": AQUILO_FOOTER},
    }
    tiktok_url = (settings.get("tiktokLiveUrl") or "").strip()
    if tiktok_url:
        embed["url"] = tiktok_url
    return {"ok": _post(url, {"embeds": [embed]})}


def send_end(settings, title, duration_s, peak_viewers, recovery_count):
    if not settings.get("discordPings", True):
        return {"ok": False, "reason": "discordPings off"}
    url = (settings.get("discordWebhookUrl") or "").strip()
    if not url:
        return {"ok": False, "reason": "no webhook URL configured"}
    dur_str = ""
    if duration_s > 0:
        m, s = divmod(int(duration_s), 60)
        h, m = divmod(m, 60)
        dur_str = (f"{h}h " if h else "") + (f"{m}m " if m or h else "") + f"{s}s"
    fields = []
    if dur_str:
        fields.append({"name": "Duration", "value": dur_str, "inline": True})
    if peak_viewers:
        fields.append({"name": "Peak viewers", "value": str(peak_viewers), "inline": True})
    if recovery_count:
        fields.append({"name": "Auto-recoveries", "value": str(recovery_count), "inline": True})
    embed = {
        "title": "Stream ended",
        "description": (title or "(no title)")[:200],
        "color": 0x6b6f86,
        "fields": fields,
        "timestamp": _iso(None),
        "footer": {"text": AQUILO_FOOTER},
    }
    return {"ok": _post(url, {"embeds": [embed]})}


def send_test(settings):
    """Used by the dock's test button. Returns the same shape as send_start."""
    return send_start(settings,
                      title="Webhook test from the companion",
                      category_name="Test",
                      mature=False,
                      started_at_ms=None)
