"""
Aquilo gateway shim — always-on Discord gateway listener that forwards
real-time events to the loadout-discord Cloudflare Worker.

This is a standalone Railway service that lives in the same repository
as the Cloudflare Worker (discord-bot/) and the Loadout DLL. It
authenticates as the Aquilo Discord application (1500849448866025573)
and listens for events the Worker needs but can't subscribe to over
Discord's interactions webhook (member joins, message activity in
gated channels, reactions, voice state).

Entry point:
    python aquilo_gateway.py

Required env vars:
    AQUILO_DISCORD_BOT_TOKEN   Bot token for the Aquilo app (1500849448866025573)
    AQUILO_WORKER_URL          e.g. https://loadout-discord.aquiloplays.workers.dev
    AQUILO_GATEWAY_SECRET      shared secret (random hex; same value on the worker)

Optional env vars:
    AQUILO_GUILD_ALLOWLIST     comma-separated guild IDs; if unset, all guilds forward
    PORT                       Railway sets this; /healthz binds to 0.0.0.0:$PORT
    AQUILO_FORWARD_CHANNELS_TTL  seconds between /forward-channels polls (default 300)

Auth scheme — every POST carries TWO auth headers so the worker can
verify via either path without a shim redeploy. The worker's
verifyGatewaySig helper (discord-bot/auth.js) accepts both:
    x-counting-secret: <AQUILO_GATEWAY_SECRET>           (legacy shared-secret path)
    x-aquilo-gw-ts:    <unix-seconds>                    (HMAC path, preferred)
    x-aquilo-gw-sig:   <hex SHA-256(secret, ts + "\\n" + body))>

Worker endpoints (snake_case slim Discord subsets, matching worker.js):
    POST /member/joined       — GUILD_MEMBER_ADD
    POST /counting/message    — MESSAGE_CREATE (only channels in /forward-channels)
    POST /reaction/event      — MESSAGE_REACTION_ADD / REMOVE
                                (worker reads `action` to skip un-stars)
    POST /voice/state         — VOICE_STATE_UPDATE
    POST /voice/empty         — voice channel occupancy hit 0
"""

from __future__ import annotations

import asyncio
import collections
import hashlib
import hmac
import json
import os
import time
import traceback
from typing import Any, Deque, Dict, Optional, Set

import aiohttp
from aiohttp import web
import discord

# ── Config ────────────────────────────────────────────────────────────────────

TOKEN           = os.environ.get("AQUILO_DISCORD_BOT_TOKEN", "")
WORKER_URL      = os.environ.get("AQUILO_WORKER_URL", "").rstrip("/")
GATEWAY_SECRET  = os.environ.get("AQUILO_GATEWAY_SECRET", "")
GUILD_ALLOWLIST = {
    g.strip() for g in os.environ.get("AQUILO_GUILD_ALLOWLIST", "").split(",") if g.strip()
}
PORT                = int(os.environ.get("PORT", "8080"))
FORWARD_CHANS_TTL_S = int(os.environ.get("AQUILO_FORWARD_CHANNELS_TTL", "300"))

# Bounded backlog. Discord.py covers gateway reconnect + resume on its
# own (a short blip rarely loses events). The queue exists for the rarer
# case where the worker is degraded; 1000 events is ~minutes of a busy
# guild and the oldest get dropped if we overflow.
QUEUE_CAP    = 1000
HTTP_TIMEOUT = aiohttp.ClientTimeout(total=8)

# ── State (process-global, fine for a single-process shim) ────────────────────

class ShimState:
    started_at: float = time.time()
    last_event_ts: Optional[float] = None
    events_forwarded: int = 0
    events_failed: int = 0
    events_dropped: int = 0
    connection_state: str = "starting"  # starting | connecting | ready | disconnected
    forward_channels: Set[str] = set()
    forward_channels_ever_fetched: bool = False

S = ShimState()

# ── Auth ──────────────────────────────────────────────────────────────────────

def _sign(body: bytes) -> Dict[str, str]:
    """Return the auth headers for a single POST."""
    ts = str(int(time.time()))
    sig = hmac.new(
        GATEWAY_SECRET.encode("utf-8"),
        (ts + "\n" + body.decode("utf-8", "replace")).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        # Legacy shared-secret path — verifyGatewaySig still accepts it.
        "x-counting-secret": GATEWAY_SECRET,
        # HMAC path — verifyGatewaySig's preferred check (signed body).
        "x-aquilo-gw-ts":  ts,
        "x-aquilo-gw-sig": sig,
        "content-type":    "application/json",
        "user-agent":      "aquilo-gateway-shim/1.0",
    }

# ── Bounded drop-oldest queue ─────────────────────────────────────────────────

class ForwardQueue:
    """Single-consumer FIFO that drops the oldest item on overflow."""
    def __init__(self, cap: int) -> None:
        self._items: Deque[Dict[str, Any]] = collections.deque(maxlen=cap)
        # Semaphore counts queued items the consumer hasn't taken yet.
        # On overflow we don't release, so the count stays in sync with len().
        self._sem = asyncio.Semaphore(0)

    def put(self, item: Dict[str, Any]) -> bool:
        """Returns False if an older event was displaced to fit."""
        full = len(self._items) == self._items.maxlen
        self._items.append(item)
        if full:
            S.events_dropped += 1
            return False
        self._sem.release()
        return True

    async def get(self) -> Dict[str, Any]:
        await self._sem.acquire()
        return self._items.popleft()

Q = ForwardQueue(QUEUE_CAP)

# ── HTTP forwarder ────────────────────────────────────────────────────────────

async def _post_with_retry(session: aiohttp.ClientSession, path: str, payload: Dict[str, Any]) -> None:
    """POST one event. Logs failures; never raises."""
    url = WORKER_URL + path
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = _sign(body)
    # Two-shot delivery: one immediate, one with a 2s backoff on transient
    # errors. Anything past that we drop and log — the worker is best-effort,
    # we don't want a slow upstream to ratchet the queue into starvation.
    for attempt in (0, 1):
        try:
            async with session.post(url, data=body, headers=headers, timeout=HTTP_TIMEOUT) as r:
                if 200 <= r.status < 300:
                    S.events_forwarded += 1
                    return
                if r.status in (408, 429, 500, 502, 503, 504) and attempt == 0:
                    await asyncio.sleep(2)
                    continue
                txt = (await r.text())[:200]
                print(f"[forward] {path} → {r.status} {txt!r}")
                S.events_failed += 1
                return
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            if attempt == 0:
                await asyncio.sleep(2)
                continue
            print(f"[forward] {path} → network error: {e!r}")
            S.events_failed += 1
            return

async def _forward_loop(session: aiohttp.ClientSession) -> None:
    while True:
        item = await Q.get()
        path = item["_path"]
        payload = {k: v for k, v in item.items() if not k.startswith("_")}
        try:
            await _post_with_retry(session, path, payload)
        except Exception as e:  # belt-and-braces; _post_with_retry catches its own
            print(f"[forward] unexpected error: {e!r}")
            traceback.print_exc()

# ── /forward-channels refresh ────────────────────────────────────────────────

async def _refresh_forward_channels_loop(session: aiohttp.ClientSession) -> None:
    """Periodic GET of /forward-channels so we only push MESSAGE_CREATE for
    channels the worker actually consumes. Worker's contract — see
    worker.js:270."""
    while True:
        try:
            async with session.get(WORKER_URL + "/forward-channels", timeout=HTTP_TIMEOUT) as r:
                if r.status == 200:
                    j = await r.json()
                    chans = j.get("channels") or []
                    S.forward_channels = {str(c) for c in chans}
                    S.forward_channels_ever_fetched = True
                else:
                    print(f"[forward-channels] {r.status}")
        except Exception as e:
            print(f"[forward-channels] {e!r}")
        await asyncio.sleep(FORWARD_CHANS_TTL_S)

# ── Discord client ────────────────────────────────────────────────────────────

intents = discord.Intents.none()
intents.guilds          = True
intents.members         = True   # privileged — enable in Developer Portal
intents.messages        = True
intents.message_content = True   # privileged — enable in Developer Portal
intents.reactions       = True
intents.voice_states    = True

client = discord.Client(intents=intents)

def _guild_allowed(guild_id: Optional[int]) -> bool:
    if not GUILD_ALLOWLIST:
        return True
    return guild_id is not None and str(guild_id) in GUILD_ALLOWLIST

def _enqueue(path: str, payload: Dict[str, Any]) -> None:
    S.last_event_ts = time.time()
    payload["_path"] = path
    Q.put(payload)

@client.event
async def on_ready():
    S.connection_state = "ready"
    me = client.user
    guild_names = ", ".join(f"{g.name} ({g.id})" for g in client.guilds) or "(none)"
    allow = "ALL" if not GUILD_ALLOWLIST else ",".join(sorted(GUILD_ALLOWLIST))
    print(f"[gateway] ready as {me} ({getattr(me, 'id', '?')}) | guilds: {guild_names} | allow: {allow}")

@client.event
async def on_disconnect():
    S.connection_state = "disconnected"
    print("[gateway] disconnected")

@client.event
async def on_resumed():
    S.connection_state = "ready"
    print("[gateway] resumed")

@client.event
async def on_connect():
    S.connection_state = "connecting"
    print("[gateway] connected to gateway, awaiting READY…")

@client.event
async def on_member_join(member: discord.Member):
    if not _guild_allowed(member.guild.id):
        return
    u = member  # discord.Member subclasses User
    payload = {
        # Worker contract (snake_case slim Discord subset):
        "guild_id": str(member.guild.id),
        "user": {
            "id":          str(u.id),
            "username":    u.name,
            "global_name": getattr(u, "global_name", None),
            "avatar":      u.avatar.key if u.avatar else None,
            "bot":         u.bot,
        },
        # Spec mirrors (camelCase + joinedAt; harmless extras for worker today):
        "guildId":    str(member.guild.id),
        "userId":     str(u.id),
        "joinedAt":   (member.joined_at.isoformat() if member.joined_at else None),
        "isBot":      u.bot,
        "username":   u.name,
        "avatarHash": u.avatar.key if u.avatar else None,
    }
    _enqueue("/member/joined", payload)

@client.event
async def on_message(message: discord.Message):
    if message.guild is None:
        return  # DMs aren't part of the contract
    if not _guild_allowed(message.guild.id):
        return
    # Worker's /counting/message is channel-gated. We mirror the existing
    # aquilo-presence behavior: only forward channels the worker advertises
    # via /forward-channels. Until that endpoint has answered at least once
    # we fail closed (no forwards) — avoids hammering the worker with every
    # message in the guild during startup.
    if not S.forward_channels_ever_fetched:
        return
    if str(message.channel.id) not in S.forward_channels:
        return

    payload = {
        # Snake_case Discord-slim subset that the worker's downstream
        # handlers (counting, clip, checkin, community-chat) all read.
        "guild_id":   str(message.guild.id),
        "channel_id": str(message.channel.id),
        "id":         str(message.id),
        "author": {
            "id":          str(message.author.id),
            "username":    message.author.name,
            "global_name": getattr(message.author, "global_name", None),
            "bot":         message.author.bot,
        },
        "content":     message.content or "",
        "attachments": [
            {
                "id":           str(a.id),
                "url":          a.url,
                "proxy_url":    a.proxy_url,
                "filename":     a.filename,
                "content_type": a.content_type,
                "size":         a.size,
            }
            for a in (message.attachments or [])
        ],
        "mentions":  [str(m.id) for m in (message.mentions or [])],
        "timestamp": message.created_at.isoformat() if message.created_at else None,
        # camelCase spec mirrors:
        "guildId":   str(message.guild.id),
        "channelId": str(message.channel.id),
        "messageId": str(message.id),
        "userId":    str(message.author.id),
        "isBot":     message.author.bot,
        "ts":        message.created_at.isoformat() if message.created_at else None,
    }
    _enqueue("/counting/message", payload)

def _reaction_payload(p: discord.RawReactionActionEvent, action: str) -> Dict[str, Any]:
    emoji = p.emoji
    return {
        # Worker contract (snake_case slim):
        "guild_id":   str(p.guild_id) if p.guild_id is not None else None,
        "channel_id": str(p.channel_id),
        "message_id": str(p.message_id),
        "user_id":    str(p.user_id),
        "emoji": {
            "name":     emoji.name,
            "id":       str(emoji.id) if emoji.id else None,
            "animated": emoji.animated,
        },
        # action discriminator — worker's handleStarboardReaction reads
        # this to skip the pin path on un-stars.
        "action":    action,
        "guildId":   str(p.guild_id) if p.guild_id is not None else None,
        "channelId": str(p.channel_id),
        "messageId": str(p.message_id),
        "userId":    str(p.user_id),
    }

@client.event
async def on_raw_reaction_add(payload: discord.RawReactionActionEvent):
    if not _guild_allowed(payload.guild_id):
        return
    _enqueue("/reaction/event", _reaction_payload(payload, "add"))

@client.event
async def on_raw_reaction_remove(payload: discord.RawReactionActionEvent):
    if not _guild_allowed(payload.guild_id):
        return
    _enqueue("/reaction/event", _reaction_payload(payload, "remove"))

@client.event
async def on_voice_state_update(member: discord.Member,
                                before: discord.VoiceState,
                                after: discord.VoiceState):
    if not _guild_allowed(member.guild.id):
        return
    # Forward the state update itself.
    after_channel_id = after.channel.id if after.channel else None
    payload = {
        # Worker contract — slim subset matching worker.js:210 comment.
        "guild_id":   str(member.guild.id),
        "channel_id": str(after_channel_id) if after_channel_id else None,
        "user_id":    str(member.id),
        "session_id": after.session_id,
        # Full state mirror per spec — handy for future worker handlers.
        "self_mute":   after.self_mute,
        "self_deaf":   after.self_deaf,
        "self_stream": after.self_stream,
        "self_video":  after.self_video,
        "mute":        after.mute,
        "deaf":        after.deaf,
        "suppress":    after.suppress,
        # camelCase mirrors:
        "guildId":   str(member.guild.id),
        "channelId": str(after_channel_id) if after_channel_id else None,
        "userId":    str(member.id),
    }
    _enqueue("/voice/state", payload)

    # If the user left a channel and that channel is now empty, signal it.
    # discord.py applies the new state to the cache before this event fires,
    # so before.channel.members already excludes the departing user.
    if before.channel is not None and before.channel != after.channel:
        if not before.channel.members:
            _enqueue("/voice/empty", {
                "guild_id":  str(member.guild.id),
                "channel_id": str(before.channel.id),
                "guildId":   str(member.guild.id),
                "channelId": str(before.channel.id),
            })

# ── Health server ────────────────────────────────────────────────────────────

async def _healthz(request: web.Request) -> web.Response:
    return web.json_response({
        "ok":               S.connection_state == "ready",
        "service":          "aquilo-gateway",
        "uptime":           int(time.time() - S.started_at),
        "lastEventTs":      int(S.last_event_ts) if S.last_event_ts else None,
        "connectionState":  S.connection_state,
        "eventsForwarded":  S.events_forwarded,
        "eventsFailed":     S.events_failed,
        "eventsDropped":    S.events_dropped,
        "forwardChannels":  len(S.forward_channels),
        "allowlist":        sorted(GUILD_ALLOWLIST) or None,
    })

async def _start_health_server() -> web.AppRunner:
    app = web.Application()
    app.router.add_get("/healthz", _healthz)
    app.router.add_get("/", _healthz)  # convenience
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, host="0.0.0.0", port=PORT)
    await site.start()
    print(f"[health] listening on 0.0.0.0:{PORT}")
    return runner

# ── Boot ──────────────────────────────────────────────────────────────────────

def _require_env() -> None:
    missing = [k for k, v in (
        ("AQUILO_DISCORD_BOT_TOKEN", TOKEN),
        ("AQUILO_WORKER_URL",        WORKER_URL),
        ("AQUILO_GATEWAY_SECRET",    GATEWAY_SECRET),
    ) if not v]
    if missing:
        raise SystemExit(f"missing required env vars: {', '.join(missing)}")

async def main() -> None:
    _require_env()
    print(f"[boot] worker={WORKER_URL} allow={sorted(GUILD_ALLOWLIST) or 'ALL'}")
    session = aiohttp.ClientSession()
    runner: Optional[web.AppRunner] = None
    try:
        runner = await _start_health_server()
        asyncio.create_task(_forward_loop(session))
        asyncio.create_task(_refresh_forward_channels_loop(session))
        S.connection_state = "connecting"
        await client.start(TOKEN)
    finally:
        await session.close()
        if runner is not None:
            await runner.cleanup()

if __name__ == "__main__":
    asyncio.run(main())
