"""Game catalog. Mirrors discord-bot/crowdplay.js::CROWDPLAY_GAMES.

After the 2026-06-11 expansion: 6 games. Hitman is the headline (focused
dev). The 5 multiplayer entries all use the friends-install-nothing
model: streamer is host, the BepInEx/UE4SS/RCON adapter lives on the
streamer's PC only, effects propagate to friends through the game's
own netcode. Every multiplayer effect is scope=host-replicates or
server-wide; nothing client-only ships.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Game:
    slug: str
    display: str
    harness: str
    adapter_rel: str
    game_dir: Optional[str]
    install_into: Optional[str]
    online_safe: bool = True


CATALOG: list[Game] = [
    # ── ZHMModSDK C++ (Hitman, the focus game) ────────────────────────
    Game(
        slug="hitman-woa",
        display="Hitman: World of Assassination",
        harness="zhmmodsdk",
        adapter_rel="adapters/hitman-woa/",
        game_dir="HITMAN World of Assassination",
        install_into="{game_dir}/Retail/mods/CrowdPlay.dll",
        online_safe=False,
    ),

    # ── UE4SS Lua (Chained Together) ─────────────────────────────────
    Game(
        slug="chained-together",
        display="Chained Together",
        harness="ue4ss",
        adapter_rel="adapters/chained-together/Scripts/main.lua",
        game_dir="Chained Together",
        install_into="{game_dir}/ChainedTogether/Binaries/Win64/ue4ss/Mods/crowdplay/Scripts/main.lua",
        online_safe=False,
    ),

    # ── BepInEx 5 Mono Unity (Burglin' Gnomes) ───────────────────────
    Game(
        slug="burglin-gnomes",
        display="Burglin' Gnomes",
        harness="bepinex",
        adapter_rel="adapters/burglin-gnomes/CrowdPlay/",
        game_dir="Burglin' Gnomes",
        install_into="{game_dir}/BepInEx/plugins/AquiloCrowdPlay.dll",
        online_safe=False,  # co-op multiplayer
    ),

    # ── BepInEx 6 IL2CPP Unity (Roadside Research) ───────────────────
    Game(
        slug="roadside-research",
        display="Roadside Research",
        harness="bepinex6",
        adapter_rel="adapters/roadside-research/CrowdPlay/",
        game_dir="Roadside Research",
        install_into="{game_dir}/BepInEx/plugins/AquiloCrowdPlay.dll",
        online_safe=False,  # co-op multiplayer
    ),

    # ── BepInEx 6 IL2CPP Unity (MECCHA CHAMELEON) ────────────────────
    Game(
        slug="meccha-chameleon",
        display="MECCHA CHAMELEON",
        harness="bepinex6",
        adapter_rel="adapters/meccha-chameleon/CrowdPlay/",
        game_dir="MECCHA CHAMELEON",
        install_into="{game_dir}/BepInEx/plugins/AquiloCrowdPlay.dll",
        online_safe=False,  # PvP, custom lobbies only
    ),

    # ── Source RCON (Left 4 Dead 2) ──────────────────────────────────
    Game(
        slug="left-4-dead-2",
        display="Left 4 Dead 2",
        harness="source-rcon",
        adapter_rel="adapters/left-4-dead-2/crowdplay.mjs",
        game_dir="Left 4 Dead 2",
        install_into=None,  # no in-game file; talks to console via RCON
    ),
]

BY_SLUG = {g.slug: g for g in CATALOG}


HARNESS_NOTES: dict[str, str] = {
    "zhmmodsdk":   "C++ plugin. Drop CrowdPlay.dll into <Hitman>/Retail/mods/. CI builds it.",
    "ue4ss":       "UE4SS Lua mod via file IPC. UE4SS experimental-latest into ue4ss/Mods/.",
    "bepinex":     "Unity Mono - BepInEx 5, AquiloCrowdPlay.dll into BepInEx/plugins/.",
    "bepinex6":    "Unity IL2CPP - BepInEx 6, AquiloCrowdPlay.dll into BepInEx/plugins/.",
    "source-rcon": "Source RCON. Launch the game with -port 27015 +rcon_password <pw>; adapter connects + dispatches console commands.",
}
