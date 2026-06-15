#!/usr/bin/env python3
"""
Build streamerbot/printerbot-import.bundle.json + .sb.txt from the
companion .cs source files. Mirrors the build-scene-themer-bundle.js
pattern so all SB sub-actions stay round-trippable through git review.

Run:
  python3 streamerbot/build-printerbot-bundle.py

Sources live under streamerbot/printerbot/*.cs. The bundle bundles:
  - PrinterBot - Print Receipt        renders the receipt PNG + prints
  - PrinterBot - Discord Relay        mirrors the PNG to Discord
  - PrinterBot - TikTok Gift Print    TikTok gift router (incl. Heart Me)
  - PrinterBot - Twitch Gift Print    Twitch/YouTube/Kick gift router

The Heart Me filter is owned by the TikTok router; the canonical gift
name comes from aquilo-gg/overlays/_shared/tiktok-gifts.js. Free TikTok
heart taps (the like event) are NOT printed; the router rejects any
non-gift event up front.
"""
from __future__ import annotations

import base64
import gzip
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "printerbot"

REFS = [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\mscorlib.dll",
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.dll",
]


# Stable ids so re-imports update existing actions rather than
# duplicating them in SB. Generated once; do not rotate without
# walking the user base.
IDS = {
    "print":   ("5f4a6c2e-9b1d-4f7e-b3a0-7e6f1c2d8a21", "5f4a6c2e-9b1d-4f7e-b3a0-7e6f1c2d8a22"),
    "discord": ("5f4a6c2e-9b1d-4f7e-b3a0-7e6f1c2d8a31", "5f4a6c2e-9b1d-4f7e-b3a0-7e6f1c2d8a32"),
    "tiktok":  ("5f4a6c2e-9b1d-4f7e-b3a0-7e6f1c2d8a01", "5f4a6c2e-9b1d-4f7e-b3a0-7e6f1c2d8a02"),
    "twitch":  ("5f4a6c2e-9b1d-4f7e-b3a0-7e6f1c2d8a11", "5f4a6c2e-9b1d-4f7e-b3a0-7e6f1c2d8a12"),
}

ACTION_META = [
    ("print",
     "PrinterBot - Print Receipt",
     "print-receipt.cs",
     "Renders the receipt PNG via Loadout.dll PrinterBotEntry and pushes it to the thermal printer. Sets %printedImagePath% for the Discord relay step. Invoked by the per-source router actions; not triggered directly."),
    ("discord",
     "PrinterBot - Discord Relay",
     "discord-relay.cs",
     "POSTs %printedImagePath% + caption to the Loadout Worker's /printerbot/discord-relay endpoint (multipart). The Worker mirrors the receipt to Discord using the bot token; SB never sees it. Fail-open. Set the PRINTERBOT_RELAY_SECRET global var before first use."),
    ("tiktok",
     "PrinterBot - TikTok Gift Print",
     "tiktok-gift-print.cs",
     "TikTok gift router: filters to the allow-list (incl. Heart Me), then calls Print Receipt + Discord Relay. Gift events ONLY; like events are explicitly excluded. Wire TikFinity / TikTok Gift triggers here."),
    ("twitch",
     "PrinterBot - Twitch Gift Print",
     "twitch-gift-print.cs",
     "Twitch/YouTube/Kick gift/sub/cheer router: calls Print Receipt + Discord Relay. Wire your existing gift triggers here."),
]


def build_action(key: str, name: str, cs_file: str, description: str) -> dict:
    action_id, sub_id = IDS[key]
    code_bytes = (SRC / cs_file).read_bytes()
    b64 = base64.b64encode(code_bytes).decode("ascii")
    return {
        "id": action_id,
        "queue": "00000000-0000-0000-0000-000000000000",
        "enabled": True,
        "excludeFromHistory": False,
        "excludeFromPending": False,
        "name": name,
        "group": "PrinterBot",
        "alwaysRun": False,
        "randomAction": False,
        "concurrent": False,
        "triggers": [],
        "subActions": [
            {
                "name": name,
                "description": description,
                "references": list(REFS),
                "byteCode": b64,
                "precompile": False,
                "delayStart": False,
                "saveResultToVariable": False,
                "saveToVariable": "",
                "id": sub_id,
                "weight": 0,
                "type": 99999,
                "parentId": None,
                "enabled": True,
                "index": 0,
            }
        ],
        "collapsedGroups": [],
    }


def main() -> None:
    actions = [build_action(k, n, f, d) for (k, n, f, d) in ACTION_META]

    bundle = {
        "meta": {
            "name": "PrinterBot",
            "author": "aquiloplays",
            "version": "1.0.0",
            "description": "Thermal-print receipts for stream gifts (TikTok / Twitch / YouTube / Kick) with a Discord channel mirror. Includes the Heart Me filter.",
            "autoRunAction": None,
            "minimumVersion": None,
        },
        "manifest": {
            "product": "PrinterBot",
            "packageVersion": "1.0.0",
            "group": "PrinterBot",
            "generatedBy": "streamerbot/build-printerbot-bundle.py",
            "actionCount": len(actions),
            "actions": [a["name"] for a in actions],
            "commands": [],
            "includes": [k for (k, _, _, _) in ACTION_META],
        },
        "data": {
            "actions": actions,
            "queues": [],
            "commands": [],
            "websocketServers": [],
            "websocketClients": [],
            "timers": [],
        },
        "version": 23,
        "exportedFrom": "1.0.4",
        "minimumVersion": "1.0.0-alpha.1",
    }

    bundle_path = ROOT / "printerbot-import.bundle.json"
    sb_path = ROOT / "printerbot-import.sb.txt"

    with bundle_path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(bundle, f, indent=4, ensure_ascii=False)
        f.write("\n")

    raw_json = bundle_path.read_bytes()
    gz = gzip.compress(raw_json, compresslevel=9)
    packed = b"SBAE" + gz
    sb_path.write_text(base64.b64encode(packed).decode("ascii"), newline="\n")

    print(f"wrote {bundle_path.name} ({bundle_path.stat().st_size} bytes)")
    print(f"wrote {sb_path.name} ({sb_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
