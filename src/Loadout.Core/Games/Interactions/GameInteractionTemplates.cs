using System.Collections.Generic;
using Loadout.Settings;

namespace Loadout.Games.Interactions
{
    /// <summary>
    /// Curated starter packs of <see cref="GameAction"/> rows for popular
    /// games. The Settings tab's "Add from template" dropdown reads
    /// <see cref="All"/>; each entry returns a fresh List so a streamer
    /// can apply the same template multiple times without aliasing.
    ///
    /// Default key bindings used here are the games' STOCK keybinds at
    /// the time of writing. Streamers who've remapped keys edit each
    /// row's Keys cell after applying.
    ///
    /// Each template also:
    ///   - Sets a sensible `TargetWindowTitle` hint in <see cref="WindowHint"/>
    ///     (the Settings UI auto-applies it if the field is empty)
    ///   - Defaults role gate to "everyone" with a 5s per-user cooldown
    ///     and 1s global cooldown — safe-ish for a chat-driven game
    ///   - Uses chat-command triggers as the starting point. Streamers
    ///     who want channel-point or TikTok-gift triggers retarget per-row.
    ///
    /// Templates are intentionally on-the-conservative side: jump,
    ///   reload, crouch, swap weapon, throw grenade. They avoid actions
    ///   that would get the streamer killed or anti-cheat-flagged (no
    ///   auto-aim, no rapid-fire) and skip game-disrupting binds like
    ///   "quit to desktop". Streamers can add anything they want by
    ///   hand — these are just the "I want chat to mess with me a
    ///   little" starter pack.
    /// </summary>
    public static class GameInteractionTemplates
    {
        public sealed class Template
        {
            public string Key         { get; set; }
            public string Label       { get; set; }
            public string WindowHint  { get; set; }
            public string Description { get; set; }
            public System.Func<List<GameAction>> Build { get; set; }
        }

        public static readonly Template[] All = new[]
        {
            new Template
            {
                Key = "cod", Label = "Call of Duty (MW / Warzone)",
                WindowHint = "Call of Duty",
                Description = "Standard PC keybinds: jump=Space, crouch=C, reload=R, switch weapon=1/2, lethal=G, tactical=Q, melee=V.",
                Build = Cod
            },
            new Template
            {
                Key = "fortnite", Label = "Fortnite",
                WindowHint = "Fortnite",
                Description = "Builds + edits + jump + crouch + harvest. Default builder-mode keys (wall=F1, ramp=F3, floor=F2, cone=F4, edit=G).",
                Build = Fortnite
            },
            new Template
            {
                Key = "pubg", Label = "PUBG",
                WindowHint = "PUBG",
                Description = "Crouch=C, prone=Z, jump=Space, reload=R, peek=Q/E, throw=G.",
                Build = Pubg
            },
            new Template
            {
                Key = "valorant", Label = "Valorant",
                WindowHint = "VALORANT",
                Description = "Ability 1=C, ability 2=Q, signature=E, ultimate=X, jump=Space, walk=Shift, knife=3.",
                Build = Valorant
            },
            new Template
            {
                Key = "cs", Label = "CS2 / CS:GO",
                WindowHint = "Counter-Strike",
                Description = "Drop=G, flash=4, smoke=3, molotov=1, knife=3, jump=Space, crouch=Ctrl, buy menu=B.",
                Build = CounterStrike
            },
            new Template
            {
                Key = "apex", Label = "Apex Legends",
                WindowHint = "Apex Legends",
                Description = "Tactical=Q, ultimate=Z, ping=Middle-mouse, slide=Ctrl, reload=R, melee=V, jump=Space.",
                Build = Apex
            },
            new Template
            {
                Key = "rocketleague", Label = "Rocket League",
                WindowHint = "Rocket League",
                Description = "Jump=Space, boost=Shift, handbrake=Ctrl, ball cam=Y, scoreboard=Tab, quick chats=1-4.",
                Build = RocketLeague
            },
            new Template
            {
                Key = "overwatch", Label = "Overwatch 2",
                WindowHint = "Overwatch",
                Description = "Ability 1=Shift, ability 2=E, ultimate=Q, melee=V, jump=Space, crouch=Ctrl, reload=R.",
                Build = Overwatch
            },
            new Template
            {
                Key = "minecraft", Label = "Minecraft",
                WindowHint = "Minecraft",
                Description = "Hotbar 1-9, jump=Space, sneak=Shift, sprint=Ctrl, drop=Q, inventory=E, swap=F.",
                Build = Minecraft
            },
            new Template
            {
                Key = "fallout4", Label = "Fallout 4",
                WindowHint = "Fallout4",
                Description = "Pip-Boy=Tab, VATS=V, jump=Space, run=Shift, crouch=C, reload=R, switch grenade=G.",
                Build = Fallout4
            },
            new Template
            {
                Key = "elden-ring", Label = "Elden Ring",
                WindowHint = "ELDEN RING",
                Description = "Stock keyboard binds: roll=Space, R1=Left-click, R2=Shift+Click, jump=F, sit at site=O.",
                Build = EldenRing
            },
            new Template
            {
                Key = "gta5", Label = "GTA V",
                WindowHint = "Grand Theft Auto",
                Description = "Jump=Space, sprint=Shift, crouch=Ctrl, swap weapon=Tab, horn=E, phone=Up arrow.",
                Build = Gta5
            },
            new Template
            {
                Key = "lethalcompany", Label = "Lethal Company",
                WindowHint = "Lethal Company",
                Description = "Jump=Space, crouch=Ctrl, flashlight=F, scan=Q, push-to-talk=V, terminal=E.",
                Build = LethalCompany
            },
            new Template
            {
                Key = "phasmophobia", Label = "Phasmophobia",
                WindowHint = "Phasmophobia",
                Description = "Crouch=C, flashlight=T, journal=J, place=F, pickup=E, mic=V.",
                Build = Phasmophobia
            },
            new Template
            {
                Key = "xbox360-controller", Label = "Xbox 360 controller (ViGEm)",
                WindowHint = "",
                Description = "Virtual gamepad via ViGEm. Buttons (A/B/X/Y/LB/RB), D-pad, triggers (LT/RT), and stick pushes. Needs the ViGEm Bus Driver + Nefarius.ViGEm.Client.dll — see the Controller card above.",
                Build = Xbox360Controller
            },
            new Template
            {
                Key = "generic-fps", Label = "Generic FPS (WASD)",
                WindowHint = "",
                Description = "Move=WASD, jump=Space, crouch=Ctrl, reload=R, sprint=Shift, melee=V, mouse-click.",
                Build = GenericFps
            },
            new Template
            {
                Key = "platformer", Label = "Generic platformer (arrows)",
                WindowHint = "",
                Description = "Arrows + space + Z/X (run/jump/attack).",
                Build = GenericPlatformer
            }
        };

        // ---- Helper: build a stock GameAction with sensible defaults ----
        private static GameAction Cmd(string name, string trigger, string keys, int cost = 25, int holdMs = 50, int repeat = 1)
        {
            return new GameAction
            {
                Enabled            = true,
                Name               = name,
                TriggerKind        = "command",
                TriggerValue       = trigger,
                AllowedRoles       = "everyone",
                CooldownGlobalSec  = 1,
                CooldownPerUserSec = 5,
                ActionType         = "key",
                Keys               = keys,
                HoldMs             = holdMs,
                Repeat             = repeat,
                Probability        = 1.0,
                BoltsCost          = cost
            };
        }

        // ---- Templates ----------------------------------------------------

        private static List<GameAction> Cod() => new List<GameAction>
        {
            Cmd("Jump",           "jump",     "Space"),
            Cmd("Crouch toggle",  "crouch",   "C"),
            Cmd("Prone",          "prone",    "X"),
            Cmd("Reload",         "reload",   "R", cost: 50),
            Cmd("Swap weapon 1",  "weapon1",  "1"),
            Cmd("Swap weapon 2",  "weapon2",  "2"),
            Cmd("Throw lethal",   "frag",     "G", cost: 100),
            Cmd("Throw tactical", "tactical", "Q", cost: 75),
            Cmd("Melee",          "melee",    "V", cost: 40),
            Cmd("Sprint burst",   "sprint",   "Shift", holdMs: 1500, cost: 30),
        };

        private static List<GameAction> Fortnite() => new List<GameAction>
        {
            Cmd("Jump",          "jump",   "Space"),
            Cmd("Crouch",        "crouch", "Ctrl"),
            Cmd("Harvest tool",  "pickaxe","1"),
            Cmd("Edit build",    "edit",   "G", cost: 100),
            Cmd("Build wall",    "wall",   "F1"),
            Cmd("Build floor",   "floor",  "F2"),
            Cmd("Build ramp",    "ramp",   "F3"),
            Cmd("Build cone",    "cone",   "F4"),
            Cmd("Reload",        "reload", "R", cost: 50),
            Cmd("Switch slot 2", "slot2",  "2"),
            Cmd("Mark a spot",   "ping",   "Middle"),
        };

        private static List<GameAction> Pubg() => new List<GameAction>
        {
            Cmd("Jump",     "jump",   "Space"),
            Cmd("Crouch",   "crouch", "C"),
            Cmd("Prone",    "prone",  "Z", cost: 30),
            Cmd("Reload",   "reload", "R", cost: 50),
            Cmd("Peek left","lpeek",  "Q"),
            Cmd("Peek right","rpeek", "E"),
            Cmd("Throw frag","frag",  "G", cost: 120),
            Cmd("Heal",     "heal",   "F5", cost: 80),
            Cmd("Swap to pistol", "pistol", "2"),
        };

        private static List<GameAction> Valorant() => new List<GameAction>
        {
            Cmd("Jump",      "jump",   "Space"),
            Cmd("Crouch",    "crouch", "Ctrl"),
            Cmd("Walk",      "walk",   "Shift", holdMs: 800),
            Cmd("Knife out", "knife",  "3"),
            Cmd("Ability 1", "ability1","C",  cost: 75),
            Cmd("Ability 2", "ability2","Q",  cost: 75),
            Cmd("Signature", "signature","E", cost: 100),
            Cmd("Ultimate",  "ult",    "X",   cost: 250),
            Cmd("Drop weapon","drop",  "G",   cost: 200),
            Cmd("Reload",    "reload", "R",   cost: 50),
        };

        private static List<GameAction> CounterStrike() => new List<GameAction>
        {
            Cmd("Jump",        "jump",   "Space"),
            Cmd("Crouch",      "crouch", "Ctrl"),
            Cmd("Buy menu",    "buy",    "B"),
            Cmd("Drop weapon", "drop",   "G",  cost: 150),
            Cmd("Flashbang",   "flash",  "4",  cost: 80),
            Cmd("Smoke",       "smoke",  "3",  cost: 80),
            Cmd("Molotov",     "molly",  "1",  cost: 100),
            Cmd("Knife out",   "knife",  "3",  cost: 30),
            Cmd("Inspect",     "inspect","F",  cost: 20),
            Cmd("Reload",      "reload", "R",  cost: 40),
        };

        private static List<GameAction> Apex() => new List<GameAction>
        {
            Cmd("Jump",       "jump",     "Space"),
            Cmd("Slide",      "slide",    "Ctrl"),
            Cmd("Tactical",   "tactical", "Q",  cost: 75),
            Cmd("Ultimate",   "ult",      "Z",  cost: 250),
            Cmd("Reload",     "reload",   "R",  cost: 40),
            Cmd("Melee",      "melee",    "V",  cost: 40),
            Cmd("Ping",       "ping",     "Middle"),
            Cmd("Swap weapon","swap",     "1"),
            Cmd("Heal",       "heal",     "4",  cost: 80),
        };

        private static List<GameAction> RocketLeague() => new List<GameAction>
        {
            Cmd("Jump",        "jump",  "Space"),
            Cmd("Boost",       "boost", "Shift", holdMs: 800, cost: 50),
            Cmd("Handbrake",   "drift", "Ctrl",  holdMs: 500),
            Cmd("Ball cam",    "ballcam","Y"),
            Cmd("Scoreboard",  "score", "Tab"),
            Cmd("Quick chat 1","qc1",   "1"),
            Cmd("Quick chat 2","qc2",   "2"),
            Cmd("Quick chat 3","qc3",   "3"),
            Cmd("Quick chat 4","qc4",   "4"),
            Cmd("What a save!","save",  "3", cost: 150),    // qc3 sequence shortcut
        };

        private static List<GameAction> Overwatch() => new List<GameAction>
        {
            Cmd("Jump",      "jump",     "Space"),
            Cmd("Crouch",    "crouch",   "Ctrl"),
            Cmd("Ability 1", "ability1", "Shift", cost: 75),
            Cmd("Ability 2", "ability2", "E",     cost: 75),
            Cmd("Ultimate",  "ult",      "Q",     cost: 300),
            Cmd("Melee",     "melee",    "V",     cost: 40),
            Cmd("Reload",    "reload",   "R",     cost: 40),
            Cmd("Voice line","voiceline","C",     cost: 25),
            Cmd("Emote",     "emote",    "T",     cost: 50),
        };

        private static List<GameAction> Minecraft() => new List<GameAction>
        {
            Cmd("Jump",          "jump",      "Space"),
            Cmd("Sneak",         "sneak",     "Shift"),
            Cmd("Sprint",        "sprint",    "Ctrl", holdMs: 1500),
            Cmd("Inventory",     "inv",       "E"),
            Cmd("Drop item",     "drop",      "Q",  cost: 80),
            Cmd("Swap to off-hand","swap",    "F"),
            Cmd("Hotbar 1",      "hot1",      "1"),
            Cmd("Hotbar 2",      "hot2",      "2"),
            Cmd("Hotbar 3",      "hot3",      "3"),
            Cmd("Hotbar 4",      "hot4",      "4"),
            Cmd("Hotbar 9",      "hot9",      "9"),
            Cmd("Open chat",     "openchat",  "T"),
        };

        private static List<GameAction> Fallout4() => new List<GameAction>
        {
            Cmd("Pip-Boy",       "pipboy", "Tab"),
            Cmd("Jump",          "jump",   "Space"),
            Cmd("Crouch",        "crouch", "C"),
            Cmd("Run burst",     "run",    "Shift", holdMs: 1500),
            Cmd("Reload",        "reload", "R",  cost: 40),
            Cmd("Switch grenade","grenade","G",  cost: 100),
            Cmd("VATS",          "vats",   "V",  cost: 200),
            Cmd("Throw grenade", "frag",   "Alt",cost: 150),
            Cmd("Quick save",    "save",   "F5", cost: 500),  // expensive - chaos protection
        };

        private static List<GameAction> EldenRing() => new List<GameAction>
        {
            Cmd("Roll",          "roll",   "Space",  cost: 30),
            Cmd("Jump",          "jump",   "F",      cost: 25),
            Cmd("Crouch",        "crouch", "X"),
            Cmd("Use item",      "use",    "R",      cost: 100),
            Cmd("Switch right",  "rswap",  "ArrowRight"),
            Cmd("Switch left",   "lswap",  "ArrowLeft"),
            Cmd("Switch up",     "uswap",  "ArrowUp"),
            Cmd("Switch down",   "dswap",  "ArrowDown"),
            Cmd("Two-hand",      "twohand","E"),
            Cmd("Wave",          "gesture","G",      cost: 50),
        };

        private static List<GameAction> Gta5() => new List<GameAction>
        {
            Cmd("Jump",       "jump",   "Space"),
            Cmd("Sprint",     "sprint", "Shift", holdMs: 1500),
            Cmd("Crouch",     "crouch", "Ctrl"),
            Cmd("Swap weapon","swap",   "Tab"),
            Cmd("Honk",       "honk",   "E"),
            Cmd("Phone",      "phone",  "Up"),
            Cmd("Aim",        "aim",    "Right",   holdMs: 1000),    // mouse map varies
            Cmd("Punch",      "punch",  "R",       cost: 60),
            Cmd("Reload",     "reload", "R",       cost: 40),
        };

        private static List<GameAction> LethalCompany() => new List<GameAction>
        {
            Cmd("Jump",        "jump",    "Space"),
            Cmd("Crouch",      "crouch",  "Ctrl"),
            Cmd("Flashlight",  "flash",   "F"),
            Cmd("Scan",        "scan",    "Q"),
            Cmd("Push-to-talk","ptt",     "V",  holdMs: 1500),
            Cmd("Use terminal","term",    "E"),
            Cmd("Drop item",   "drop",    "G",  cost: 100),
            Cmd("Switch slot 2","slot2",  "2"),
            Cmd("Switch slot 3","slot3",  "3"),
        };

        private static List<GameAction> Phasmophobia() => new List<GameAction>
        {
            Cmd("Crouch",     "crouch", "C"),
            Cmd("Flashlight", "flash",  "T"),
            Cmd("Journal",    "journal","J"),
            Cmd("Place item", "place",  "F",  cost: 50),
            Cmd("Pick up",    "pickup", "E"),
            Cmd("Push-to-talk","ptt",   "V",  holdMs: 1500),
            Cmd("Toggle camera","cam",  "G",  cost: 80),
        };

        // Helper for controller actions — shape mirrors Cmd() but with
        // ActionType=controller + ControllerKind/Button. BoltsCost
        // skewed slightly higher than keyboard because controller fires
        // tend to mean "actually do a game action" not "scoot a step".
        private static GameAction PadBtn(string name, string trigger, string button, int cost = 40, int holdMs = 80)
        {
            return new GameAction
            {
                Enabled            = true,
                Name               = name,
                TriggerKind        = "command",
                TriggerValue       = trigger,
                AllowedRoles       = "everyone",
                CooldownGlobalSec  = 1,
                CooldownPerUserSec = 5,
                ActionType         = "controller",
                ControllerKind     = "button",
                ControllerButton   = button,
                HoldMs             = holdMs,
                Repeat             = 1,
                Probability        = 1.0,
                BoltsCost          = cost
            };
        }
        private static GameAction PadTrigger(string name, string trigger, string lr, int cost = 60)
        {
            return new GameAction
            {
                Enabled = true, Name = name,
                TriggerKind = "command", TriggerValue = trigger,
                AllowedRoles = "everyone",
                CooldownGlobalSec = 1, CooldownPerUserSec = 5,
                ActionType = "controller", ControllerKind = "trigger",
                ControllerTrigger = lr, ControllerValue = 255,
                HoldMs = 250, Repeat = 1, Probability = 1.0, BoltsCost = cost
            };
        }
        private static GameAction PadStick(string name, string trigger, string lr, double x, double y, int cost = 30, int holdMs = 500)
        {
            return new GameAction
            {
                Enabled = true, Name = name,
                TriggerKind = "command", TriggerValue = trigger,
                AllowedRoles = "everyone",
                CooldownGlobalSec = 1, CooldownPerUserSec = 5,
                ActionType = "controller", ControllerKind = "stick",
                ControllerStick = lr, StickX = x, StickY = y,
                HoldMs = holdMs, Repeat = 1, Probability = 1.0, BoltsCost = cost
            };
        }

        private static List<GameAction> Xbox360Controller() => new List<GameAction>
        {
            // Face buttons
            PadBtn("A button",         "pad-a",      "A",      cost: 40),
            PadBtn("B button",         "pad-b",      "B",      cost: 40),
            PadBtn("X button",         "pad-x",      "X",      cost: 40),
            PadBtn("Y button",         "pad-y",      "Y",      cost: 40),
            // Shoulders + Start/Back
            PadBtn("Left bumper",      "pad-lb",     "LB",     cost: 50),
            PadBtn("Right bumper",     "pad-rb",     "RB",     cost: 50),
            PadBtn("Start",            "pad-start",  "Start",  cost: 100),
            PadBtn("Back",             "pad-back",   "Back",   cost: 30),
            // D-pad
            PadBtn("D-pad Up",         "pad-up",     "DPadUp",    cost: 30),
            PadBtn("D-pad Down",       "pad-down",   "DPadDown",  cost: 30),
            PadBtn("D-pad Left",       "pad-left",   "DPadLeft",  cost: 30),
            PadBtn("D-pad Right",      "pad-right",  "DPadRight", cost: 30),
            // Stick clicks
            PadBtn("Click L-stick",    "pad-ls",     "LS",     cost: 40),
            PadBtn("Click R-stick",    "pad-rs",     "RS",     cost: 40),
            // Triggers — full pull
            PadTrigger("Right trigger","pad-rt",     "RT",     cost: 80),
            PadTrigger("Left trigger", "pad-lt",     "LT",     cost: 80),
            // Stick pushes — short 500ms shoves
            PadStick("Push L-stick up",    "pad-pushup",    "L",  0,  1, cost: 30),
            PadStick("Push L-stick down",  "pad-pushdown",  "L",  0, -1, cost: 30),
            PadStick("Push L-stick left",  "pad-pushleft",  "L", -1,  0, cost: 30),
            PadStick("Push L-stick right", "pad-pushright", "L",  1,  0, cost: 30),
        };

        private static List<GameAction> GenericFps() => new List<GameAction>
        {
            Cmd("Forward burst",  "w",      "W",     holdMs: 600),
            Cmd("Back burst",     "s",      "S",     holdMs: 600),
            Cmd("Left burst",     "a",      "A",     holdMs: 600),
            Cmd("Right burst",    "d",      "D",     holdMs: 600),
            Cmd("Jump",           "jump",   "Space"),
            Cmd("Crouch",         "crouch", "Ctrl"),
            Cmd("Sprint",         "sprint", "Shift", holdMs: 1500),
            Cmd("Reload",         "reload", "R", cost: 40),
            Cmd("Melee",          "melee",  "V", cost: 40),
            new GameAction
            {
                Enabled = true, Name = "Left click", TriggerKind = "command",
                TriggerValue = "click", AllowedRoles = "everyone",
                CooldownGlobalSec = 2, CooldownPerUserSec = 8,
                ActionType = "mouseClick", MouseButton = "left",
                Probability = 1.0, BoltsCost = 50
            }
        };

        private static List<GameAction> GenericPlatformer() => new List<GameAction>
        {
            Cmd("Left",   "left",  "ArrowLeft",  holdMs: 600),
            Cmd("Right",  "right", "ArrowRight", holdMs: 600),
            Cmd("Up",     "up",    "ArrowUp",    holdMs: 600),
            Cmd("Down",   "down",  "ArrowDown",  holdMs: 600),
            Cmd("Jump",   "jump",  "Space",      cost: 20),
            Cmd("Run",    "run",   "Z",          holdMs: 800),
            Cmd("Attack", "attack","X",          cost: 30),
        };
    }
}
