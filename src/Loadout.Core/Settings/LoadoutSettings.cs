using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Loadout.Settings
{
    /// <summary>
    /// Root settings object — serialized as JSON to <data>/Loadout/settings.json.
    /// Add new modules here and they'll be persisted automatically.
    /// </summary>
    public class LoadoutSettings
    {
        // Schema version for one-shot migrations. Bumped in
        // SettingsManager.MigrateSchema after each migration runs so a
        // rebalance never re-applies on subsequent launches. Migrations
        // only touch fields still at their previous default — anything
        // the streamer customized survives.
        // Current = 3 (June 2026 — seed starter-pack custom commands).
        public int    SchemaVersion   { get; set; } = 3;
        // Default is informational only — SettingsManager.LoadFromDisk
        // stamps this with the running DLL's actual assembly version on
        // every load, so the value persisted to disk always reflects
        // the binary the streamer is running, not whatever was current
        // when their settings.json was first created.
        public string SuiteVersion    { get; set; } = "1.10.0";
        public bool   OnboardingDone  { get; set; } = false;
        public string BroadcasterName { get; set; } = "";

        // Dry-run: when true, MultiPlatformSender logs intended sends to
        // Util.ErrorLog but doesn't actually post to chat. Lets a streamer
        // verify alert / timer / welcome behavior without spamming.
        public bool   DryRun          { get; set; } = false;

        public PlatformsConfig    Platforms    { get; set; } = new PlatformsConfig();
        public ModulesConfig      Modules      { get; set; } = new ModulesConfig();
        public AlertsConfig       Alerts       { get; set; } = new AlertsConfig();
        public TimersConfig       Timers       { get; set; } = new TimersConfig();
        public DiscordConfig      Discord      { get; set; } = new DiscordConfig();
        public TwitterConfig      Twitter      { get; set; } = new TwitterConfig();
        public WebhookConfig      Webhooks     { get; set; } = new WebhookConfig();
        public ModerationConfig   Moderation   { get; set; } = new ModerationConfig();
        public WelcomesConfig     Welcomes     { get; set; } = new WelcomesConfig();
        public UpdatesConfig      Updates      { get; set; } = new UpdatesConfig();
        public CountersConfig     Counters     { get; set; } = new CountersConfig();
        public CheckInConfig      CheckIn      { get; set; } = new CheckInConfig();
        public PatreonSupportersConfig PatreonSupporters { get; set; } = new PatreonSupportersConfig();
        public InfoCommandsConfig InfoCommands { get; set; } = new InfoCommandsConfig();
        public GoalsConfig        Goals        { get; set; } = new GoalsConfig();
        public VipRotationConfig  VipRotation  { get; set; } = new VipRotationConfig();
        public BoltsConfig        Bolts        { get; set; } = new BoltsConfig();
        public ChatNoiseConfig    ChatNoise    { get; set; } = new ChatNoiseConfig();
        public ApexConfig         Apex         { get; set; } = new ApexConfig();
        public RotationIntegrationConfig RotationIntegration { get; set; } = new RotationIntegrationConfig();
        public RotationConnectionConfig  RotationConnection  { get; set; } = new RotationConnectionConfig();
        public ClipsConfig        Clips        { get; set; } = new ClipsConfig();
        public FollowBatchConfig  FollowBatch  { get; set; } = new FollowBatchConfig();
        public GameProfilesConfig GameProfiles { get; set; } = new GameProfilesConfig();
        public ChannelPointsConfig ChannelPoints { get; set; } = new ChannelPointsConfig();
        public DiscordBotConfig    DiscordBot   { get; set; } = new DiscordBotConfig();
        public BoltsShopConfig     BoltsShop    { get; set; } = new BoltsShopConfig();
        public HypeTrainConfig     HypeTrain    { get; set; } = new HypeTrainConfig();
        public AdBreakConfig       AdBreak      { get; set; } = new AdBreakConfig();
        public ChatVelocityConfig  ChatVelocity { get; set; } = new ChatVelocityConfig();
        public AutoPollConfig      AutoPoll     { get; set; } = new AutoPollConfig();
        public SubAnniversaryConfig SubAnniversary { get; set; } = new SubAnniversaryConfig();
        public SubRaidTrainConfig  SubRaidTrain { get; set; } = new SubRaidTrainConfig();
        public CcCoinConfig        CcCoin       { get; set; } = new CcCoinConfig();
        public FirstWordsConfig    FirstWords   { get; set; } = new FirstWordsConfig();
        public OverlayThemeConfig  OverlayTheme { get; set; } = new OverlayThemeConfig();
        public CommandsTickerIconsConfig CommandsTickerIcons { get; set; } = new CommandsTickerIconsConfig();
        public CommandsTickerEntriesConfig CommandsTickerEntries { get; set; } = new CommandsTickerEntriesConfig();
        public ViewerProfilesConfig ViewerProfiles { get; set; } = new ViewerProfilesConfig();
        public DungeonConfig       Dungeon       { get; set; } = new DungeonConfig();
        public ChatAnnouncementsConfig ChatAnnouncements { get; set; } = new ChatAnnouncementsConfig();
        public GameInteractionsConfig  GameInteractions  { get; set; } = new GameInteractionsConfig();
    }

    /// <summary>
    /// "Crowd Control"-style game interactions. Viewers fire keyboard /
    /// mouse / controller inputs against the streamer's active game via
    /// chat commands, Twitch channel-point redemptions, or TikTok gifts.
    ///
    /// Each <see cref="GameAction"/> binds a trigger (a !command, a
    /// channel-point reward name, or a TikTok gift name) to an input
    /// action (key press, key combo, mouse click / move, sequence DSL).
    /// Cooldowns, role gates, probability rolls, and a foreground-window
    /// guard keep the streamer from getting their game spammed or
    /// having a key leak into Discord while the game is unfocused.
    ///
    /// Inputs are sent via Win32 SendInput so they target whatever
    /// window has focus — same as a real keypress. Mouse coords are
    /// relative-to-current by default; absolute pixel mode is opt-in.
    /// </summary>
    public class GameInteractionsConfig
    {
        // Master kill-switch. Off by default — a fresh install should
        // never auto-arm a system that types into the streamer's game.
        public bool Enabled { get; set; } = false;

        // When set, every action checks the foreground window's title
        // against this substring (case-insensitive). If it doesn't
        // match, the action logs and skips - so a typo'd !crouch when
        // OBS is focused doesn't paste "c" into the scene name. Empty
        // = fire regardless of foreground window (matches Crowd
        // Control's default behavior).
        public string TargetWindowTitle { get; set; } = "";

        // Multiplies every action's CooldownGlobalSec + CooldownPerUserSec.
        // 1.0 = exact values, 0.5 = twice as fast, 2.0 = half as often.
        // Useful for "panic mode" during raids without editing each row.
        public double GlobalCooldownMultiplier { get; set; } = 1.0;

        // When true, every action logs what it WOULD do without sending
        // any actual input. Pair with the Settings -> Game interactions
        // Test button to validate a setup before going live.
        public bool DryRun { get; set; } = false;

        // Safety: skip every action while the stream is offline.
        // Tracked via SB's streamOnline / streamOffline events.
        // Default ON because a chat "!flash" hitting your game while
        // you're configuring scenes pre-stream is a worse experience
        // than a viewer's command silently doing nothing.
        public bool RequireStreamOnline { get; set; } = true;

        // Per-platform send rate guard. SendInput is fast enough to
        // mash a key 100x/sec, which crashes some games; this caps
        // total actions fired per second across ALL viewers / triggers.
        // 0 = unlimited (use at your own risk).
        public int MaxActionsPerSecond { get; set; } = 6;

        // Per-viewer rate cap — independent of cooldowns. Limits a
        // single chatter to <N> fires per <Window> seconds across ALL
        // actions, so one viewer with the bolts to spare can't
        // monopolize chaos. 0 = unlimited.
        public int MaxActionsPerViewerWindow { get; set; } = 5;
        public int MaxActionsPerViewerWindowSec { get; set; } = 60;

        public List<GameAction> Actions { get; set; } = new List<GameAction>();

        // --- Multi-game profile switcher (June 2026) ----------------------
        // When enabled, the module polls the foreground window every
        // ProfilePollSec seconds and swaps the active action set + the
        // TargetWindowTitle to the first matching profile. Lets a
        // streamer keep "Fortnite", "CS2", and "Minecraft" configs
        // around and never manually flip between them.
        //
        // The default (un-named) <see cref="Actions"/> list above is
        // the FALLBACK when no profile's window-match hits.
        public bool ProfileAutoSwitch { get; set; } = false;
        public int  ProfilePollSec    { get; set; } = 3;
        public List<GameInteractionProfile> Profiles { get; set; } = new List<GameInteractionProfile>();
    }

    /// <summary>
    /// One named game-interactions profile. <see cref="WindowMatch"/> is
    /// a substring of the foreground window's title that triggers a
    /// swap; first match wins. Actions are completely independent from
    /// the global fallback list so e.g. !jump can mean "press Space"
    /// in one game and "press Z" in another.
    ///
    /// Distinct from the older <see cref="GameProfile"/> used by
    /// GameProfilesModule for per-Twitch-category welcome / timer
    /// overrides — different problem, different shape.
    /// </summary>
    public class GameInteractionProfile
    {
        public string Name        { get; set; } = "";
        public string WindowMatch { get; set; } = "";   // substring of foreground title
        public List<GameAction> Actions { get; set; } = new List<GameAction>();
    }

    /// <summary>
    /// One trigger -> action binding. Triggers are matched by
    /// <see cref="TriggerKind"/> + <see cref="TriggerValue"/>; actions
    /// are dispatched by <see cref="ActionType"/> + the typed payload
    /// fields (keys / mouse coords / sequence DSL).
    /// </summary>
    public class GameAction
    {
        public bool   Enabled       { get; set; } = true;
        // Display name for the Settings table + chat ack template.
        public string Name          { get; set; } = "";

        // --- Trigger ---------------------------------------------------
        // "command"        — chat !command (TriggerValue = "jump" or "!jump")
        // "channelPoint"   — Twitch reward title (case-insensitive)
        // "tiktokGift"     — TikTok gift name (case-insensitive)
        public string TriggerKind   { get; set; } = "command";
        public string TriggerValue  { get; set; } = "";

        // For "tiktokGift": only fire if the gift's coin value is at
        // least this. 0 = any gift, 50 = roses+ only, 500 = mid-tier+, etc.
        public int    TikTokMinCoins { get; set; } = 0;

        // For "command": CSV of roles allowed to invoke.
        // "everyone" / "*" / empty = anyone. Otherwise: broadcaster, mod, vip, sub, viewer.
        public string AllowedRoles  { get; set; } = "everyone";

        // --- Cooldowns -------------------------------------------------
        // 0 = no cooldown. Mods + broadcaster bypass per-user (not global).
        public int    CooldownGlobalSec  { get; set; } = 0;
        public int    CooldownPerUserSec { get; set; } = 0;
        // Per-role per-user overrides. Format: "role:seconds" pairs.
        //   { "sub": 10, "vip": 5, "mod": 0 }
        // The viewer's highest-priority matching role wins:
        //   broadcaster > mod > vip > sub > viewer
        // Missing role = fall back to CooldownPerUserSec.
        // "0" for a role explicitly removes their cooldown.
        // Lets a streamer ship "free for subs, 30s viewers" without two rows.
        public System.Collections.Generic.Dictionary<string, int> CooldownOverrides { get; set; }
            = new System.Collections.Generic.Dictionary<string, int>(System.StringComparer.OrdinalIgnoreCase);

        // Same shape but multiplies BoltsCost per role. "vip": 0.5 = half
        // price. "sub": 0 = free. Default (missing) = 1.0 = full price.
        public System.Collections.Generic.Dictionary<string, double> CostMultipliers { get; set; }
            = new System.Collections.Generic.Dictionary<string, double>(System.StringComparer.OrdinalIgnoreCase);

        // --- Action ----------------------------------------------------
        // "key"           — Press <see cref="Keys"/> as a combo (e.g. "Ctrl+S", "W").
        //                   Held for <see cref="HoldMs"/>; repeated <see cref="Repeat"/> times.
        // "mouseClick"    — Click <see cref="MouseButton"/>.
        // "mouseMove"     — Move mouse by (X,Y) per MouseMode.
        // "scroll"        — Wheel <see cref="ScrollDelta"/> (positive = up).
        // "sequence"      — Multi-step macro; see <see cref="Sequence"/>.
        // "controller"    — Reserved for ViGEm-backed virtual gamepad
        //                   (future); v1 logs and skips so a config
        //                   referencing it doesn't crash.
        // "sb-action"     — Run a Streamer.bot action by its action id;
        //                   delegates to the existing SbBridge.RunAction.
        public string ActionType { get; set; } = "key";

        // For "key" / "sequence": "W", "Ctrl+S", "Shift+F1".
        public string Keys       { get; set; } = "";
        // How long each key is held down (milliseconds). 50 = a normal
        // tap; 2000 = a 2-second hold (forward-walk for 2s in most games).
        public int    HoldMs     { get; set; } = 50;
        public int    Repeat     { get; set; } = 1;
        public int    RepeatDelayMs { get; set; } = 50;

        // Mouse-specific
        public string MouseButton { get; set; } = "left";      // left | right | middle
        public int    MouseX      { get; set; } = 0;
        public int    MouseY      { get; set; } = 0;
        public string MouseMode   { get; set; } = "relative";  // relative | absolute | current
        public int    ScrollDelta { get; set; } = 0;

        // Sequence DSL — semicolon-separated steps, each one of:
        //   "W:2000ms"        hold W for 2 seconds
        //   "Space"           tap Space (HoldMs default)
        //   "Ctrl+S:50ms"     combo hold
        //   "pause:500ms"     wait 500ms
        //   "click:left"      left-click at current pos
        //   "move:50,-20"     move mouse by (50, -20)
        //   "scroll:-3"       scroll down 3 notches
        // Empty = unused (set ActionType != "sequence" or leave blank).
        public string Sequence    { get; set; } = "";

        // --- Polish ----------------------------------------------------
        // 0..1. Probability the action actually fires per trigger.
        // 1 = always, 0.5 = coin-flip, 0 = never (silent disable).
        public double Probability { get; set; } = 1.0;

        // Optional chat acknowledgement. Empty = silent. Placeholders:
        //   {user} {name} {keys} {gift} {coins}
        public string AckTemplate { get; set; } = "";

        // For "sb-action": the SB action id (GUID). Otherwise ignored.
        public string SbActionId  { get; set; } = "";

        // For ActionType = "roulette":
        // Chat votes between child action NAMES over RouletteWindowSec.
        // Semicolon-separated NAMES of other GameActions in the same
        // list. Each viewer can vote once during the window via:
        //   1 / 2 / 3 / ... (digit)
        //   <option-name>   (full match, case-insensitive)
        // The winner fires when the window closes; ties resolve to the
        // earliest cast vote. Useful for "chat decides what !chaos does".
        public string RouletteOptions   { get; set; } = "";
        public int    RouletteWindowSec { get; set; } = 30;
        // Optional chat announcement at vote start. Placeholders:
        //   {user} {window} {options}
        public string RouletteOpenTemplate { get; set; } =
            "🎰 Voting open {window}s: reply with the number to pick — {options}";

        // For ActionType = "chain":
        // Each step is "actionName" (matches another GameAction.Name in the
        // same list) optionally followed by ":delayMs". Steps run on a
        // thread one after the other. Children skip their own gates so
        // a chain doesn't need to re-bill bolts / re-check cooldowns on
        // every step — the parent's gates apply once at the trigger.
        // Example:  "panic:0; reload:300; jump:200; flash:500"
        public string ChainSteps { get; set; } = "";

        // For ActionType = "controller":
        // Acts on a virtual Xbox 360 gamepad via ViGEm. Driver must be
        // installed (see Settings -> Game interactions -> Controller).
        //
        // ControllerKind:
        //   "button"  — tap ControllerButton for HoldMs (A / B / X / Y /
        //               LB / RB / Start / Back / DPadUp / DPadDown /
        //               DPadLeft / DPadRight / LS / RS)
        //   "trigger" — pull LT or RT to ControllerValue (0..255), hold
        //   "stick"   — push L or R stick to (StickX, StickY), -1..1
        public string ControllerKind   { get; set; } = "button";
        public string ControllerButton { get; set; } = "";
        public string ControllerTrigger { get; set; } = "RT";    // RT | LT
        public int    ControllerValue   { get; set; } = 255;     // trigger pressure 0..255
        public string ControllerStick   { get; set; } = "L";     // L | R
        public double StickX            { get; set; } = 0;       // -1..1
        public double StickY            { get; set; } = 0;       // -1..1

        // For "obs-scene" / "obs-source" action types ------------------
        // Scene to switch to (obs-scene) OR scene that hosts the source
        // (obs-source). Empty = no-op.
        public string ObsScene    { get; set; } = "";
        // Source name (obs-source only). Empty = no-op.
        public string ObsSource   { get; set; } = "";
        // Source visibility. "show" / "hide" / "toggle". Default toggle.
        public string ObsVisibility { get; set; } = "toggle";
        // OBS connection index (Streamer.bot supports multiple). 0 = primary.
        public int    ObsConnection { get; set; } = 0;

        // --- Bolts cost gate (June 2026) -------------------------------
        // Charge the viewer this many bolts to fire the action. 0 = free.
        // Debited from the viewer's wallet BEFORE the action runs; if
        // they can't cover the cost the action is skipped and the
        // FailAckTemplate is sent (if set). Mods + broadcaster bypass
        // by default — flip ChargePrivilegedRoles on to bill them too.
        public int    BoltsCost     { get; set; } = 0;
        // Apply BoltsCost even when a channel-point or TikTok-gift
        // trigger fires (those viewers already paid). Default false:
        // bolts cost only applies to chat-command triggers.
        public bool   ChargeOnAllTriggers { get; set; } = false;
        // Charge mods + broadcaster too. Default false (they typically
        // use commands for testing and shouldn't be billed).
        public bool   ChargePrivilegedRoles { get; set; } = false;
        // Optional chat reply when the viewer can't cover the cost.
        // Placeholders: {user} {cost} {balance} {emoji}
        public string FailAckTemplate { get; set; } = "";

        // Override for GameInteractionsConfig.RequireStreamOnline. When
        // true, this specific action fires even while the stream is
        // offline. Useful for setup-time test commands (broadcaster +
        // mods only normally).
        public bool   AllowOffline { get; set; } = false;

        // Optional .wav file to play synchronously before / after the
        // input. Empty = silent. Plays via System.Media.SoundPlayer so
        // it doesn't need an audio library; only WAV is supported.
        // Volume is whatever the file is recorded at; OBS-side mixing
        // can attenuate the application audio source.
        public string AudioCuePath { get; set; } = "";
        // "before" (play, wait for finish, then input) or "after" or
        // "parallel" (kick off sound + input concurrently). Default
        // "parallel" so a 1-second sound effect doesn't add latency
        // to a fast keypress.
        public string AudioCueWhen { get; set; } = "parallel";
    }

    /// <summary>
    /// Chat announcements for bus-driven game events that lack their own
    /// chat reply (dungeon recruiting / dungeon completed / duel completed).
    /// Sent via the same MultiPlatformSender path the rest of the bot uses,
    /// so they fan out to every enabled platform in PlatformsConfig.
    ///
    /// Mini-game wins are intentionally OFF by default -- BoltsModule's
    /// own !coinflip / !dice / !slots responses already chat the result.
    /// Toggle MinigameBigWins on if you want a SECOND celebratory line
    /// for wins above MinigameBigWinThreshold bolts.
    ///
    /// Heist start / success / failure are not toggled here -- the
    /// HeistController owns its own chat lifecycle. This module would
    /// double-announce, so we leave heist to the controller.
    /// </summary>
    public class ChatAnnouncementsConfig
    {
        // Master kill-switch.
        public bool Enabled                  { get; set; } = true;
        // Per-event toggles. Dungeon + duel announcements default OFF
        // since the DungeonModule is archived — no events ever publish.
        // Fields kept so existing settings.json files round-trip without
        // a migration bump.
        public bool DungeonRecruiting        { get; set; } = false;
        public bool DungeonCompleted         { get; set; } = false;
        public bool DuelCompleted            { get; set; } = false;
        // Mini-game big-win celebration -- OFF by default to avoid
        // double-announcing on top of BoltsModule's own game responses.
        public bool MinigameBigWins          { get; set; } = false;
        // Mini-game win must be at LEAST this many bolts to announce.
        // Stops a 5-bolt coinflip from ever tripping the celebration line.
        public int  MinigameBigWinThreshold  { get; set; } = 250;
    }

    /// <summary>
    /// Dungeon Crawler + Duel mini-game knobs. The game is a chat-driven
    /// party adventure that runs entirely on the bus — DungeonModule
    /// publishes scene events the OBS overlay reads. Heroes (per-viewer
    /// state) live in the dungeon-heroes.json store, NOT in this config.
    /// </summary>
    public class DungeonConfig
    {
        // Chat command names. Streamers can rename to whatever fits
        // their community ("!raid", "!quest", etc.).
        public string DungeonCommand { get; set; } = "!dungeon";
        public string JoinCommand    { get; set; } = "!join";
        public string DuelCommand    { get; set; } = "!duel";

        // How long !dungeon's recruit window stays open before the run
        // starts. Shorter = punchier; longer = more chances to !join.
        public int JoinWindowSec { get; set; } = 30;

        // How long the actual dungeon run takes. The engine spaces
        // scenes evenly across this window then leaves a tail for the
        // loot reveal animation.
        public int RunDurationSec { get; set; } = 30;

        // Number of scenes (encounters / traps / treasures / story) to
        // schedule per run. 5 reads as a meaningful adventure without
        // dragging on stream.
        public int SceneCount { get; set; } = 5;

        // Cap on party size. Above ~12 the overlay's avatar row gets
        // crowded and the chat reply for outcomes turns into spam.
        public int MaxPartySize { get; set; } = 8;

        // 1..5. Higher difficulty pulls stronger monsters AND skews
        // the rarity drop curve toward epic / legendary so risk pays.
        public int Difficulty { get; set; } = 2;

        // Cross-stream cooldown on !dungeon so a viewer can't summon
        // ten in five minutes. Mods + broadcaster bypass cooldown.
        public int DungeonCooldownSec { get; set; } = 600;   // 10 min default

        // Phase BR — odds (per 100) that a non-wiped run ends on a
        // branching scene the viewers vote on. 0 disables branching;
        // 100 makes every run branch. Default keeps the feel of a
        // rare "this run got interesting" moment.
        public int BranchChancePct { get; set; } = 20;

        // Per-user cooldown on !duel so chatters can't pick fights
        // every 10 seconds. Cooldown sits on the challenger.
        public int DuelCooldownSec { get; set; } = 300;

        // How long !duel waits for an opponent to !join before
        // forfeiting.
        public int DuelJoinWindowSec { get; set; } = 30;

        // Comma-separated whitelist of additional handles allowed to
        // summon dungeons (beyond mods + broadcaster). e.g. "@regular1, @regular2".
        public string ExtraHosts { get; set; } = "";

        // Streamer-supplied custom assets for the dungeon overlay. The
        // overlay reads these from URL params (?bg= / ?bgOpacity=) so a
        // single browser-source URL bakes the whole theme in. Both are
        // optional — empty values render the default look.
        public string BackgroundImageUrl { get; set; } = "";
        public int    BackgroundDimPercent { get; set; } = 50;   // 0..100
    }

    /// <summary>
    /// Self-served viewer profiles - !setbio, !setpfp, !setsocial, etc.
    /// Profiles live in ~/Loadout/viewer-profiles.json (separate from
    /// the bolts wallet); this config gates the chat commands and
    /// constrains length / allowed platforms.
    /// </summary>
    public class ViewerProfilesConfig
    {
        // Master switch. When false, !profile still works (read-only)
        // but the !set* commands are silent no-ops.
        public bool ChatCommandsEnabled { get; set; } = true;

        // Per-field limits so a single chat message can't store a novel.
        public int MaxBioChars      { get; set; } = 200;
        public int MaxSocialChars   { get; set; } = 80;
        public int MaxGamerTagChars { get; set; } = 60;
        public int MaxPronounsChars { get; set; } = 24;
        public int MaxPfpUrlChars   { get; set; } = 400;

        // Per-user channel-wide cooldown across all profile commands so
        // a viewer can't spam !setbio every 2s. Mods + broadcaster bypass.
        public int PerUserCooldownSec { get; set; } = 10;

        // Whitelist of social / game platform tokens the streamer
        // accepts. Empty = allow any. Lowercase, comma-separated.
        public string AllowedSocials      { get; set; } = "twitter,x,instagram,ig,tiktok,youtube,twitch,kick,bluesky,bsky,threads,linkedin,github,discord";
        public string AllowedGamePlatforms { get; set; } = "psn,xbox,steam,riot,valorant,leagueoflegends,lol,minecraft,fortnite,nintendo,switch,activision,epic";
    }

    /// <summary>
    /// Per-category badge override for the commands ticker (and the
    /// compact overlay's badge slot when an idle command rolls).
    /// Streamers can replace the default emoji with their own emoji,
    /// short text, or a data: URL for an uploaded PNG/JPG. Empty /
    /// missing key = use the overlay's hardcoded default. Published
    /// to the bus as <c>commands.icons</c> alongside
    /// <c>commands.list</c>; overlays cache and apply.
    /// </summary>
    public class CommandsTickerIconsConfig
    {
        public Dictionary<string, string> ByCategory { get; set; } = new Dictionary<string, string>();
    }

    /// <summary>
    /// Per-command preferences for the commands ticker overlay (and the
    /// compact overlay's idle ticker, which renders the same list).
    ///
    /// <see cref="HiddenCommands"/> drops a command from the ticker
    /// entirely. <see cref="Groups"/> bundles multiple commands into a
    /// single rotating card so a streamer can fold the noisy info
    /// commands into one "Info: !uptime / !followage / !accountage" tile
    /// rather than letting them eat three rotation slots.
    ///
    /// Match is exact (case-insensitive) on the visible command name —
    /// e.g. "!uptime", "!gift @user N". A grouped command is replaced by
    /// the group's tile; commands not in any group stay individual.
    /// </summary>
    public class CommandsTickerEntriesConfig
    {
        // List of command names (exact match, case-insensitive on the
        // base name). One per line in the textbox. "!commands" hides
        // !commands; "!gift @user N" hides the gift-with-args entry.
        public List<string> HiddenCommands { get; set; } = new List<string>();
        // Group definitions. Each group renders as a single ticker card
        // whose name is the joined member list ("!uptime / !followage")
        // and whose description is the group's <see cref="Label"/>.
        public List<CommandsTickerGroup> Groups { get; set; } = new List<CommandsTickerGroup>();
    }

    public class CommandsTickerGroup
    {
        public string Label    { get; set; } = "";   // shown as the group's description in the ticker
        public string Cat      { get; set; } = "info"; // ticker category — drives the badge icon
        // Commands belonging to this group. Same matching rules as
        // HiddenCommands above.
        public List<string> Commands { get; set; } = new List<string>();
    }

    /// <summary>
    /// Persisted state for every control on the Overlays tab (the global
    /// theme card AND every per-overlay card). Without this, reopening
    /// Settings shows blank textboxes / default combos every time, and
    /// the streamer has to re-paste values into OBS to keep their look.
    ///
    /// Global theme params (Font / FontScale / Accent2 / Text) get added
    /// to every overlay's URL via SettingsWindow.GlobalThemeParams().
    /// Per-overlay UI state (accent, bgOpacity, position, layer toggles,
    /// etc.) lives in <see cref="CardValues"/> keyed by the control's
    /// XAML name — opaque blob so adding a new card means listing it in
    /// SettingsWindow.OverlayControlNames, no settings migration needed.
    /// </summary>
    public class OverlayThemeConfig
    {
        // CSS font-family stack ("Inter, system-ui, sans-serif"). Empty =
        // use the overlay's baked-in default.
        public string Font     { get; set; } = "";
        // 0.5 .. 2.0 typical. 1 = no scale.
        public double FontScale { get; set; } = 1.0;
        // Secondary accent (hex without #). Used by overlays that draw
        // gradients or two-color emphasis (welcomes toast, gift burst).
        public string Accent2  { get; set; } = "";
        // Foreground / body text color (hex without #). Empty = use the
        // overlay's default (typically a near-white).
        public string Text     { get; set; } = "";

        // Per-overlay UI values keyed by control name. TextBox.Text,
        // ComboBoxItem.Tag (for ComboBox), and "0"/"1" for CheckBox.
        // Unknown / removed keys are silently ignored on load so the
        // schema can grow without breaking older settings.json.
        public Dictionary<string, string> CardValues { get; set; } = new Dictionary<string, string>();
    }

    public class PlatformsConfig
    {
        public bool Twitch  { get; set; } = true;
        public bool TikTok  { get; set; } = true;
        public bool YouTube { get; set; } = true;
        public bool Kick    { get; set; } = true;

        // Outgoing TikTok messages route through a Streamer.bot action that
        // TikFinity (or another bridge) registers — there's no native CPH
        // SendTikTokMessage. Set this to the action name TikFinity exposes
        // (or your own custom one); the message is passed via the
        // "loadoutTikTokMessage" CPH global var.
        public string TikTokSendActionName { get; set; } = "";

        // When true, outgoing Twitch chat goes through CPH's bot-account
        // SendMessage overload (asBot:true) so messages post as the
        // configured bot account instead of the broadcaster. Requires the
        // streamer to have a bot account connected in Streamer.bot. Falls
        // back to broadcaster send if the bot account isn't connected.
        public bool UseBotAccount { get; set; } = false;

        [JsonIgnore]
        public PlatformMask AsMask
        {
            get
            {
                var m = PlatformMask.None;
                if (Twitch)  m |= PlatformMask.Twitch;
                if (TikTok)  m |= PlatformMask.TikTok;
                if (YouTube) m |= PlatformMask.YouTube;
                if (Kick)    m |= PlatformMask.Kick;
                return m;
            }
        }
    }

    public class ModulesConfig
    {
        // Every module ships OFF. Users opt in during onboarding (or in
        // Settings → Modules later). This keeps a fresh install silent until
        // the streamer says otherwise — no surprise alerts in chat, no
        // background HTTP listeners, nothing competing for screen space.
        public bool InfoCommands       { get; set; } = false;
        public bool Engagement         { get; set; } = false;
        public bool ContextWelcomes    { get; set; } = false;
        public bool LoyaltyWallet      { get; set; } = false;
        public bool StreamControl      { get; set; } = false;
        public bool Alerts             { get; set; } = false;
        public bool TikTokHypeTrain    { get; set; } = false;
        public bool TimedMessages      { get; set; } = false;
        public bool StreamRecap        { get; set; } = false;
        public bool DiscordLiveStatus  { get; set; } = false;
        public bool TwitterLiveStatus  { get; set; } = false;
        public bool WebhookInbox       { get; set; } = false;
        public bool Moderation         { get; set; } = false;
        public bool HateRaidDetector   { get; set; } = false;
        public bool Fun                { get; set; } = false;
        public bool Goals              { get; set; } = false;
        public bool Counters           { get; set; } = false;
        public bool DailyCheckIn       { get; set; } = false;
        public bool FirstWords         { get; set; } = false;
        public bool AdBreak            { get; set; } = false;
        public bool ChatVelocity       { get; set; } = false;
        public bool AutoPoll           { get; set; } = false;
        public bool SubRaidTrain       { get; set; } = false;
        public bool VipRotation        { get; set; } = false;
        public bool CcCoinTracker      { get; set; } = false;
        public bool SubAnniversary     { get; set; } = false;
        public bool Bolts              { get; set; } = false;
        public bool Apex               { get; set; } = false;
        public bool GameTracker        { get; set; } = true;   // free, on by default
        public bool Clips              { get; set; } = false;
        public bool Dungeon            { get; set; } = false;
        public bool GameInteractions   { get; set; } = false;
    }

    public class AlertsConfig
    {
        public AlertTemplate Follow      { get; set; } = new AlertTemplate { Enabled = true,  Message = "{user} just followed! Welcome 💜" };
        public AlertTemplate Sub         { get; set; } = new AlertTemplate { Enabled = true,  Message = "🎉 {user} subscribed at Tier {tier}!" };
        public AlertTemplate Resub       { get; set; } = new AlertTemplate { Enabled = true,  Message = "{user} resubbed for {months} months! 🎉" };
        public AlertTemplate GiftSub     { get; set; } = new AlertTemplate { Enabled = true,  Message = "{gifter} gifted {count} subs! 🎁" };
        public AlertTemplate Cheer       { get; set; } = new AlertTemplate { Enabled = true,  Message = "{user} cheered {bits} bits!" };
        public AlertTemplate Raid        { get; set; } = new AlertTemplate { Enabled = true,  Message = "RAID INCOMING from {user} with {viewers} viewers! 🚀" };
        public AlertTemplate SuperChat   { get; set; } = new AlertTemplate { Enabled = true,  Message = "{user} sent a Super Chat: {amount}!" };
        public AlertTemplate Membership  { get; set; } = new AlertTemplate { Enabled = true,  Message = "{user} just became a member! 💚" };
        public AlertTemplate KickSub     { get; set; } = new AlertTemplate { Enabled = true,  Message = "🦵 {user} subscribed on Kick!" };
        public AlertTemplate KickGift    { get; set; } = new AlertTemplate { Enabled = true,  Message = "🎁 {gifter} gifted {count} subs on Kick!" };
        public AlertTemplate TikTokGift  { get; set; } = new AlertTemplate { Enabled = true,  Message = "{user} sent {gift} ({coins} coins)!" };
    }

    public class AlertTemplate
    {
        public bool   Enabled { get; set; } = true;
        public string Message { get; set; } = "";
        public string SoundPath { get; set; } = "";
    }

    public class TimersConfig
    {
        public bool Enabled { get; set; } = true;

        // Global sequence settings. Messages cycle through in order on this
        // cadence; per-message intervals were removed in favour of one
        // interval for the whole sequence.
        public int IntervalMinutes      { get; set; } = 15;
        public int MinChatMessages      { get; set; } = 5;
        public int MinChatWindowMinutes { get; set; } = 5;
        public int BroadcasterPauseSec  { get; set; } = 60;

        public List<TimedMessage> Messages { get; set; } = new List<TimedMessage>
        {
            new TimedMessage
            {
                Name = "Follow reminder",
                Message = "Enjoying the stream? Drop a follow ❤️",
                Platforms = new PlatformsConfig(),
                Enabled = true
            }
        };
    }

    public class TimedMessage
    {
        public string Name                 { get; set; } = "";
        public string Message              { get; set; } = "";
        public bool   Enabled              { get; set; } = true;
        public string Group                { get; set; } = "Default";
        public PlatformsConfig Platforms   { get; set; } = new PlatformsConfig();
    }

    public class TwitterConfig
    {
        // Webhook-based, NOT direct X API. Why: X charges $100/mo for the
        // Basic API tier needed for write access. A webhook (Zapier / IFTTT
        // / Make / n8n / custom worker) lets the user wire their own posting
        // path with zero infra cost on our side. Loadout sends a JSON payload
        // describing the live event; the user's webhook decides what to do
        // with it (post a tweet, file an Airtable row, send themselves an
        // email, whatever).
        public string LiveWebhook       { get; set; } = "";
        public string LiveTemplate      { get; set; } = "🔴 LIVE: {title}\nNow playing {game} → {url}\n#twitch";
        public string OfflineTemplate   { get; set; } = "Stream's wrapped for the day. Thanks for hanging out 💜";
        public bool   PostOnUpdate      { get; set; } = false;     // most users don't want a tweet on every title change
    }

    public class DiscordConfig
    {
        public string LiveStatusWebhook   { get; set; } = "";
        public string RecapWebhook        { get; set; } = "";
        public string GoLiveTemplate      { get; set; } = "🔴 **{broadcaster}** is now live!\n**{title}** — *{game}*\n{url}";
        public bool   AutoEditOnChange    { get; set; } = true;
        public bool   ArchiveOnOffline    { get; set; } = true;
        // Optional embed for the go-live post. When UseEmbed is true, the
        // module uses these fields instead of (or in addition to) the
        // simple GoLiveTemplate string.
        public DiscordEmbedConfig Embed   { get; set; } = new DiscordEmbedConfig();
    }

    public class DiscordEmbedConfig
    {
        // Off by default - existing setups keep posting plain content. When
        // Use is true, the live-status post sends an embed instead.
        public bool   Use         { get; set; } = false;
        public string Title       { get; set; } = "🔴 {broadcaster} is now live";
        public string Description { get; set; } = "**{title}**\nNow playing *{game}*\n{url}";
        // Hex like "#3A86FF". Discord accepts decimal int too; we convert
        // when serializing so the user types the friendlier hex form.
        public string ColorHex    { get; set; } = "#3A86FF";
        public string ImageUrl    { get; set; } = "";
        public string ThumbUrl    { get; set; } = "";
        public string AuthorName  { get; set; } = "";
        public string AuthorIcon  { get; set; } = "";
        public string FooterText  { get; set; } = "Loadout · aquilo.gg";
        public string FooterIcon  { get; set; } = "";
    }

    public class FollowBatchConfig
    {
        // Off by default; turning it on coalesces follow alerts during a
        // raid burst into one summary line instead of N individual lines.
        public bool   Enabled         { get; set; } = false;
        // Wait this many seconds after the FIRST follow before flushing the batch.
        // The window is reset (not extended) when more follows land - so 60s
        // means "60s after the burst started, post the summary".
        public int    WindowSeconds   { get; set; } = 60;
        // Below this count, just use the regular per-event Follow alert.
        // Otherwise the batched summary fires.
        public int    MinToTrigger    { get; set; } = 4;
        public string Template        { get; set; } = "👋 Welcoming our {count} new followers: {users}!";
        // Cap how many names land in the message - 50 names blow out chat.
        public int    MaxNamesShown   { get; set; } = 8;
    }

    /// <summary>
    /// Per-game profile = a named override bundle that swaps welcome
    /// templates and the active timer-group filter when Twitch category
    /// changes. Empty profile entries fall through to the global settings,
    /// so a streamer can write just the bits that differ for that game.
    /// </summary>
    public class GameProfilesConfig
    {
        public bool Enabled { get; set; } = false;
        public List<GameProfile> Profiles { get; set; } = new List<GameProfile>();
    }

    public class GameProfile
    {
        public string GameName       { get; set; } = "";
        // Welcome overrides (empty = inherit from global Welcomes config).
        public string WelcomeFirstTime { get; set; } = "";
        public string WelcomeRegular   { get; set; } = "";
        public string WelcomeSub       { get; set; } = "";
        // Active timer groups (CSV). Empty = run every timer (group-agnostic).
        public string ActiveTimerGroups { get; set; } = "";
        // Scratch field the user can fill - a quick reminder to themself.
        public string Notes              { get; set; } = "";
    }

    /// <summary>
    /// Maps Twitch channel-point reward names to actions. Reward redemption
    /// events (kind="rewardRedemption") look up the redeemed reward name
    /// and execute the configured action.
    ///
    /// Action format examples:
    ///   chat:Hydrate time! 💧
    ///   bolts:+250                       (award the redeemer N bolts)
    ///   counter:deaths:+1
    ///   sb-action:&lt;guid&gt;          (run a Streamer.bot action by ID)
    ///   alert:custom-message-template    (fire a one-off alert)
    /// </summary>
    public class ChannelPointsConfig
    {
        public bool Enabled { get; set; } = false;
        public List<ChannelPointMapping> Mappings { get; set; } = new List<ChannelPointMapping>();
    }

    public class ChannelPointMapping
    {
        public string RewardName { get; set; } = "";   // matched case-insensitively
        public string Action     { get; set; } = "";   // see ChannelPointsConfig docstring
        public bool   Enabled    { get; set; } = true;
    }

    /// <summary>
    /// Configuration for the Cloudflare-hosted Loadout Discord bot. The
    /// streamer registers their server once (which seeds the worker's KV
    /// with a per-guild HMAC secret); from then on Loadout periodically
    /// syncs the wallet state with the worker so off-stream Discord
    /// activity (gifts, daily claim, minigames) reconciles into the local
    /// wallet on the next stream.
    /// </summary>
    /// <summary>
    /// Off-stream Discord engagement. Invite-and-go model: the streamer
    /// clicks "Get my code" in Loadout, invites the shared Loadout Bot to
    /// their Discord server (one OAuth click), and runs <c>/loadout-claim
    /// &lt;code&gt;</c> in their server. The bot binds the server to this
    /// Loadout install. From there, slash commands like /balance, /gift,
    /// /daily, etc. work in the streamer's Discord while their PC is off.
    ///
    /// The single shared bot eliminates the per-streamer Discord developer
    /// portal setup that the old flow required (App ID, Public Key, Bot
    /// Token, Interactions URL, command registration). Self-hosting is
    /// still supported - just point WorkerUrl at your own deployed worker.
    /// </summary>
    public class DiscordBotConfig
    {
        public bool   Enabled        { get; set; } = false;
        // Shared aquilo.gg-hosted worker by default. Self-hosters override.
        public string WorkerUrl      { get; set; } = "https://loadout-discord.aquiloplays.workers.dev";
        // Bound after a successful /loadout-claim: the Discord guild ID
        // and the per-guild HMAC secret used for sync calls.
        public string GuildId        { get; set; } = "";
        public string SyncSecret     { get; set; } = "";
        // Pending claim state, populated by "Get my code". When non-empty,
        // Loadout polls /claim/:code/status until the worker reports it
        // bound to a guild, then promotes the values into GuildId/SyncSecret.
        public string PendingClaimCode   { get; set; } = "";
        [JsonIgnore]
        public DateTime PendingClaimMintedUtc { get; set; } = DateTime.MinValue;
        // How often Loadout polls the worker for off-stream changes. 0
        // disables auto-sync (manual button only).
        public int    AutoSyncMinutes { get; set; } = 5;
        // Sync direction. "merge" (default) keeps the max balance per user.
        // "push" overwrites the worker with local state. "pull" overwrites
        // local state with the worker.
        public string SyncMode       { get; set; } = "merge";

        [JsonIgnore] public DateTime LastSyncUtc    { get; set; } = DateTime.MinValue;
        [JsonIgnore] public string   LastSyncStatus { get; set; } = "";
    }

    /// <summary>
    /// Bolts shop catalog. Viewers spend bolts to redeem rewards via chat
    /// (!shop / !buy &lt;name&gt;). Each item runs an action that follows the
    /// same grammar as channel-point mappings.
    /// </summary>
    public class BoltsShopConfig
    {
        public bool   Enabled        { get; set; } = false;
        public string ShopCommand    { get; set; } = "!shop";
        public string BuyCommand     { get; set; } = "!buy";
        public List<BoltsShopItem> Items { get; set; } = new List<BoltsShopItem>();
    }

    public class BoltsShopItem
    {
        public string Name        { get; set; } = "";       // !buy &lt;Name&gt;
        public int    Cost        { get; set; } = 100;
        public string Action      { get; set; } = "";       // chat:msg | sb-action:guid | alert:tmpl | counter:name:+N
        public string Description { get; set; } = "";
        public int    StockTotal  { get; set; } = -1;       // -1 = unlimited
        public int    StockSold   { get; set; } = 0;        // runtime-managed
        public int    PerUserCap  { get; set; } = 0;        // 0 = unlimited per user
        public bool   Enabled     { get; set; } = true;
    }

    /// <summary>
    /// TikTok hype train — accumulates "fuel" from TikTok gifts and other
    /// engagement events; level-up awards bolts + fires a chat alert.
    /// All numeric tunables are exposed in the UI's Tuning tab.
    /// </summary>
    public class HypeTrainConfig
    {
        public int    LevelThreshold     { get; set; } = 100;     // fuel needed to advance per level
        public int    MaxLevel           { get; set; } = 5;
        public int    DecayPerMinute     { get; set; } = 10;      // fuel lost when idle
        public int    BoltsRewardBase    { get; set; } = 50;      // total = base * level
        public int    CooldownMinutes    { get; set; } = 15;      // dead-time after a train ends before another can start
        public string LevelUpTemplate    { get; set; } = "🚂 Hype train hit level {level}! +{bolts} bolts to recent contributors.";
        public string EndTemplate        { get; set; } = "🚂 Hype train ended at level {level}.";
        public bool   AnnounceLevelUps   { get; set; } = true;
        public bool   AnnounceEnd        { get; set; } = true;
        // When true, a SEPARATE Twitch-only hype train runs alongside
        // the cross-platform one. Fed only by Twitch-sourced events; its
        // bus events carry source="twitch" so a dedicated overlay
        // (?source=twitch) can render it independently of the
        // cross-platform aggregate.
        public bool   TwitchOnlyTrain    { get; set; } = true;
        // When true, the cross-platform hype train drops a dungeon item
        // into every contributor's bag when it ends. Rarity scales with
        // the final train level; a max-level train can drop the
        // hype-train-exclusive legendaries + mythics. Off = no loot.
        public bool   DropDungeonLoot    { get; set; } = true;
    }

    /// <summary>
    /// Ad-break helper. Reminds the streamer + chat that an ad is about to
    /// run; can also fire a "thanks for waiting" message after.
    /// </summary>
    public class AdBreakConfig
    {
        public int    PreWarnSeconds      { get; set; } = 30;
        public string PreWarnTemplate     { get; set; } = "📺 Ad break in {seconds}s - hang tight!";
        public string PostTemplate        { get; set; } = "📺 Welcome back! Ads pay the rent 💜";
        public bool   PostBackThanks      { get; set; } = true;
        public bool   PauseTimedMessages  { get; set; } = true;   // mute timers for ~90s after an ad starts
    }

    /// <summary>
    /// Chat velocity tracker — detects "hype" moments by counting messages
    /// over a rolling window. Crossing the threshold publishes a bus event
    /// so overlays + auto-clips can react.
    /// </summary>
    public class ChatVelocityConfig
    {
        public int    WindowSeconds       { get; set; } = 30;
        public int    HypeThreshold       { get; set; } = 30;     // messages in window to be "hype"
        public int    SuperHypeThreshold  { get; set; } = 60;
        public bool   AutoClipOnSuperHype { get; set; } = false;
        public bool   AnnounceHype        { get; set; } = false;
        public string HypeTemplate        { get; set; } = "🔥 Chat is COOKING ({rate} msg/s)!";
    }

    /// <summary>
    /// Auto poll — proposes a poll question after a stretch of chat
    /// activity. Pulls from the configured question pool; falls back to
    /// generic prompts. Respects role gates so only mods can resolve.
    /// </summary>
    public class AutoPollConfig
    {
        public int    IdleMinutesToTrigger { get; set; } = 25;    // wait this long between auto-polls
        public int    VoteWindowSeconds    { get; set; } = 60;
        public List<string> QuestionPool   { get; set; } = new List<string>
        {
            "What's the play?",
            "Should we keep going?",
            "Vibe check?"
        };
        public bool   AnnounceResults      { get; set; } = true;
    }

    /// <summary>
    /// Sub-anniversary milestone announcements. The module fires when a
    /// sub re-subs at one of the configured month thresholds. Bolts award
    /// scales with the milestone via BoltsConfig.SubAnniversaryBonusBase.
    /// </summary>
    public class SubAnniversaryConfig
    {
        public List<int> Milestones        { get; set; } = new List<int> { 3, 6, 12, 24, 36, 48, 60 };
        public string Template             { get; set; } = "🎉 {user} hit their {months}-month sub anniversary! +{bolts} bolts.";
        public bool   AnnounceInChat       { get; set; } = true;
        public string DiscordWebhook       { get; set; } = "";
    }

    /// <summary>
    /// Sub raid train — tracks sub bursts and announces milestone counts.
    /// </summary>
    public class SubRaidTrainConfig
    {
        public int    WindowSeconds       { get; set; } = 120;     // sub burst window
        public int    MinSubsToTrigger    { get; set; } = 5;
        public List<int> AnnounceAt       { get; set; } = new List<int> { 5, 10, 25, 50, 100 };
        public string Template            { get; set; } = "🚂 SUB RAID TRAIN! {count} subs in the last {window}s 🎉";
    }

    /// <summary>
    /// Crowd Control coin tracker — surface CC coin earns on the bus and
    /// optionally credit Bolts.
    /// </summary>
    public class CcCoinConfig
    {
        public bool   AnnounceCoinEarn    { get; set; } = false;
        public string EarnTemplate        { get; set; } = "🪙 {user} earned {coins} CC coins.";
        public bool   AwardBolts          { get; set; } = true;   // controlled by BoltsConfig.PerCcCoinDivisor
    }

    /// <summary>
    /// First-words tracker — track the first thing a chatter says on a
    /// fresh stream session. Useful for shoutouts and !firstword games.
    /// </summary>
    public class FirstWordsConfig
    {
        public bool   ResetOnStreamOnline { get; set; } = true;
        public bool   AnnounceFirstChatter { get; set; } = true;
        public string Template             { get; set; } = "🥇 First chatter of the stream: {user}!";
    }

    public class WebhookConfig
    {
        public bool   Enabled    { get; set; } = true;
        public int    Port       { get; set; } = 7474;
        public string SharedSecret { get; set; } = "";
        public List<WebhookMapping> Mappings { get; set; } = new List<WebhookMapping>();
    }

    public class WebhookMapping
    {
        public string Path        { get; set; } = "/kofi";
        public string SbActionId  { get; set; } = "";
        public string Description { get; set; } = "";
    }

    public class ModerationConfig
    {
        public bool LinkPermsByRole       { get; set; } = true;
        public bool CopypastaDetect       { get; set; } = true;
        public bool HateRaidDetector      { get; set; } = true;
        public int  HateRaidAccountAgeHrs { get; set; } = 24;
        public int  HateRaidWindowSec     { get; set; } = 30;
        public int  HateRaidMinAccounts   { get; set; } = 5;
    }

    public class WelcomesConfig
    {
        public bool Enabled { get; set; } = true;
        public string FirstTime { get; set; } = "Welcome {user}! Glad you stopped by 👋";
        public string Returning { get; set; } = "Welcome back {user}! 💜";
        public string Regular   { get; set; } = "{user} is in the building 🔥";
        public string Sub       { get; set; } = "Sub squad! Welcome {user} 💜";
        public string Vip       { get; set; } = "👑 Welcome the VIP {user}!";
        public string Mod       { get; set; } = "🛡️ {user} on the watch.";
    }

    public class UpdatesConfig
    {
        public bool   AutoCheck       { get; set; } = true;
        public int    CheckIntervalHr { get; set; } = 6;
        public string Channel         { get; set; } = "stable"; // stable | beta
        public string GitHubRepo      { get; set; } = "aquiloplays/loadout-downloads";
        // When true (default), a newer release detected by AutoCheck is
        // downloaded straight to <data>/Loadout.dll.new in the background,
        // so all the user has to do is restart Streamer.bot — no extra
        // "Apply update" tray click. Matches electron-updater's
        // autoDownload behaviour on the StreamFusion side. Flip off if
        // you want the streamer to explicitly opt in to each download
        // (low-bandwidth setups, mid-stream caution, etc).
        public bool   AutoDownload    { get; set; } = true;

        [JsonIgnore]
        public DateTime LastCheckedUtc { get; set; } = DateTime.MinValue;
    }

    public class CountersConfig
    {
        public bool Enabled { get; set; } = true;
        // Counters overlay opacity (0-100). 100 = fully opaque.
        public int  Opacity { get; set; } = 100;
        // When true, the counters overlay only shows briefly after a
        // command triggers a counter change, then auto-hides. Off by
        // default — most streamers want the counters persistently visible.
        public bool ShowOnTriggerOnly { get; set; } = false;
        // Seconds the overlay stays visible after a trigger when
        // ShowOnTriggerOnly is on.
        public int  HideAfterSeconds { get; set; } = 6;
        // Counter overlay layout. "stack" = vertical list (default),
        // "row" = horizontal pill row, "grid" = 2-column grid.
        public string Layout { get; set; } = "stack";
        // Accent hex (no #) for the counter pill background. Empty = use
        // overlay default theme accent. Per-counter Color overrides this.
        public string Accent { get; set; } = "";

        // --- New customizer knobs (June 2026) ---------------------------
        // Bump animation length (ms) when a counter changes. 0 = no
        // animation. Higher = more conspicuous reaction.
        public int    BumpDurationMs { get; set; } = 600;
        // Render the per-counter emoji next to the value. Disabling
        // makes the overlay reads as a clean number-only badge.
        public bool   ShowEmojis     { get; set; } = true;
        // Corner radius (px) of each counter pill. 0 = sharp square,
        // 999 = pill. Lets a streamer match the rest of their UI.
        public int    CornerRadiusPx { get; set; } = 12;
        // Counter pill background alpha (0-100). 0 = pills disappear
        // (text floats), 100 = fully solid.
        public int    BgOpacity      { get; set; } = 60;
        // Show a small +N / -N delta chip next to the value for ~1s
        // after each change. Reads as "wait, did that just change?".
        public bool   ShowDeltaChip  { get; set; } = true;
        // Font weight for the value digits. 400 normal, 700 bold, 800 heavy.
        public int    ValueFontWeight { get; set; } = 700;

        public List<Counter> Counters { get; set; } = new List<Counter>
        {
            new Counter
            {
                Name = "deaths", Display = "Deaths", Emoji = "💀", Value = 0,
                IncrementCommand = "!died",
                DecrementCommand = "!undied",
                ResetCommand     = "!resetdeaths",
                Color = "ef4444"
            },
            new Counter
            {
                Name = "wins", Display = "Wins", Emoji = "🏆", Value = 0,
                IncrementCommand = "!gg",
                DecrementCommand = "",
                ResetCommand     = "!resetwins",
                Color = "f59e0b"
            }
        };

        // Combo commands — one chat trigger fires N counter mutations.
        // Lets a streamer define things like "every death adds +1 to the
        // deaths counter AND +10 to the push-ups penalty counter" without
        // needing two manual commands. Checked BEFORE the per-counter
        // alias / primary command path in CountersModule so the combo
        // takes precedence when both would match the same word.
        public List<CounterCombo> Combos { get; set; } = new List<CounterCombo>();
    }

    /// <summary>
    /// A single chat trigger that mutates multiple counters in one shot.
    /// Role-gated; optional chat acknowledgement with {user} / {actions}
    /// placeholders. Matched on the bare token (case-insensitive); leading
    /// '!' is optional in <see cref="Command"/>.
    /// </summary>
    public class CounterCombo
    {
        // Chat trigger. "!died" and "died" both match the typed "!died".
        public string Command { get; set; } = "";
        // CSV of roles allowed to invoke (broadcaster always passes).
        public string ModifyRoles { get; set; } = "broadcaster,mod";
        // Optional chat ack on success. Empty = silent (the per-counter
        // bus events still fire so overlays react). Placeholders:
        //   {user}    — invoker handle
        //   {actions} — comma-joined "Display: value" of each mutated counter
        public string AckTemplate { get; set; } = "";
        public List<CounterAction> Actions { get; set; } = new List<CounterAction>();
    }

    /// <summary>
    /// One mutation step inside a <see cref="CounterCombo"/>. Targets a
    /// counter by name (case-insensitive); ignored if no counter with
    /// that name exists, so removing a counter doesn't break the combo.
    /// </summary>
    public class CounterAction
    {
        public string CounterName { get; set; } = "";
        // Op = "add" -> Value = signed delta (positive or negative).
        //      "set" -> Value = absolute new value.
        //      "reset" -> Value ignored, counter goes to 0.
        public string Op    { get; set; } = "add";
        public int    Value { get; set; } = 0;
    }

    public class Counter
    {
        // Lowercase token used in chat commands (!deaths). Must be a single word.
        public string Name    { get; set; } = "";
        // Pretty label shown in overlays / responses.
        public string Display { get; set; } = "";
        // Optional emoji rendered next to the counter in the overlay
        // and chat response (e.g. 💀 for deaths, 🏆 for wins).
        public string Emoji   { get; set; } = "";
        public int    Value   { get; set; } = 0;
        // Optional template the response message uses; "{display}: {value}" by default.
        public string ResponseTemplate { get; set; } = "{display}: {value}";
        // Roles that may modify (mod, broadcaster, vip, viewer). Comma-separated.
        public string ModifyRoles { get; set; } = "broadcaster,mod";
        // Resets each new stream (we detect via ObsStreamingStarted later).
        public bool   ResetEachStream { get; set; } = false;

        // Aliases — extra commands that perform a fixed action on this
        // counter. The main "!<Name>" command always works (show / set /
        // +N / -N / reset). These give the streamer punchier one-shots:
        //   !died      -> deaths +1
        //   !gg        -> wins   +1
        //   !resetdeaths -> deaths reset
        // Empty = no alias. Aliases respect the same ModifyRoles gate.
        public string IncrementCommand { get; set; } = "";
        public string DecrementCommand { get; set; } = "";
        public string ResetCommand     { get; set; } = "";
        // Per-counter pill color (hex without #). Empty = use the
        // counters overlay's default theme accent or CountersConfig.Accent.
        public string Color { get; set; } = "";
        // Optional minimum / maximum the counter can hit. Stored as
        // nullable so existing settings.json files (no Min/Max field)
        // deserialize to "no cap" instead of accidentally clamping at 0
        // — Newtonsoft fills missing ints with 0, which would break
        // deaths counters that need to swing through 0.
        public int? MinValue { get; set; } = null;
        public int? MaxValue { get; set; } = null;
        // When true the counter is excluded from the overlay (still shows
        // in chat). Useful for an internal counter you track but don't
        // want on stream.
        public bool Hidden { get; set; } = false;
    }

    public class CheckInConfig
    {
        public bool   Enabled         { get; set; } = true;
        // Twitch reward title (case-insensitive). Channel-Point redemption with this
        // exact title fires the check-in. Anything else is ignored.
        public string TwitchRewardName { get; set; } = "Daily Check-In";
        // Cross-platform fallback command. Same effect as the Twitch reward.
        public string CrossPlatformCommand { get; set; } = "!checkin";
        public int    CooldownPerUserHours { get; set; } = 20;
        // Stats rotated below the username on the overlay. Reorder / remove freely.
        public List<string> RotatingStats { get; set; } = new List<string>
        {
            "uptime", "viewers", "followers", "subsThisStream", "topChatter", "counter:deaths", "counter:wins"
        };
        public int    RotateIntervalSec { get; set; } = 4;
        // Animation theme applied to the avatar ring + flair.
        public string AnimationTheme  { get; set; } = "shimmer"; // shimmer | bounce | glow | minimal
        public bool   ShowPatreonFlair { get; set; } = true;
        public bool   ShowSubFlair     { get; set; } = true;
        public bool   ShowVipModFlair  { get; set; } = true;

        // --- New customizer knobs (June 2026) ---------------------------
        // Total seconds the check-in card stays on screen before fading.
        // 0 = persistent (no auto-hide).
        public int    DisplaySeconds   { get; set; } = 12;
        // Accent hex (no #). Empty = use the global OverlayTheme accent.
        public string Accent           { get; set; } = "";
        // Card corner radius (px).
        public int    CornerRadiusPx   { get; set; } = 16;
        // Card background alpha (0-100). Drops with the background dim
        // for a translucent look that works over any scene.
        public int    BgOpacity        { get; set; } = 86;
        // Show the rotating stats row beneath the username. Off = only
        // the avatar + display name + flairs render.
        public bool   ShowStatsRow     { get; set; } = true;
        // Replace the username with the gamer-tag for the current
        // active platform when the viewer has one set in their profile.
        public bool   ShowGamerTag     { get; set; } = false;
    }

    public class PatreonSupportersConfig
    {
        // Local mapping: when broadcaster manually identifies a viewer as a Patreon
        // supporter, their handle goes here. Phase 2: central worker mapping that
        // viewers self-claim via aquilo.gg/link will replace this.
        public List<PatreonSupporter> Supporters { get; set; } = new List<PatreonSupporter>();
    }

    public class PatreonSupporter
    {
        public string Platform { get; set; } = "twitch";   // twitch | youtube | kick | tiktok
        public string Handle   { get; set; } = "";
        public string Tier     { get; set; } = "patron";   // single Patreon tier
    }

    public class InfoCommandsConfig
    {
        // Legacy single-string fields. Still respected when the new
        // structured maps are empty so existing settings.json files
        // keep working. New onboarding flows go through SocialLinks +
        // GamerTags.
        public string Discord { get; set; } = "Join the Discord: https://discord.gg/example";
        public string Socials { get; set; } = "";

        // Structured streamer socials. Keys are platform tokens
        // (twitter / ig / bluesky / youtube / ...) — see
        // _shared/platform-icons.js for the full set. Values are
        // the link or @handle the streamer wants chat to see.
        // !socials chat reply formats this as a friendly line; the
        // commands ticker renders the brand logos for each entry.
        public Dictionary<string, string> SocialLinks { get; set; } = new Dictionary<string, string>();

        // Streamer's gamer tags for !gamertags. Keys are platform
        // tokens (psn / xbox / steam / riot / ...). Off by default
        // so streamers opt in.
        public bool   GamerTagsEnabled { get; set; } = false;
        public string GamerTagsCommand { get; set; } = "!gamertags";
        public Dictionary<string, string> GamerTags { get; set; } = new Dictionary<string, string>();

        // Common chat commands every channel ends up wanting. These ship
        // as a starter pack so a fresh install has more than just the
        // built-ins; the streamer can edit/delete any line in Settings.
        // Onboarding seeds the same set when InfoCommands is enabled.
        public List<CustomCommand> Custom { get; set; } = new List<CustomCommand>
        {
            new CustomCommand { Name = "waddup",   Response = "WADDUP {user}! 👋 welcome in." },
            new CustomCommand { Name = "hello",    Response = "Hey {user}! Glad you're here 💜" },
            new CustomCommand { Name = "hug",      Response = "{user} sends a big hug 🤗" },
            new CustomCommand { Name = "hype",     Response = "🚀 LET'S GOOO 🚀" },
            new CustomCommand { Name = "raid",     Response = "Thanks for the raid {rest}! Welcome raiders 💜" },
            new CustomCommand { Name = "specs",    Response = "PC specs: edit this in Settings -> Info commands -> Custom (!specs)." },
            new CustomCommand { Name = "sens",     Response = "Sens: edit this in Settings -> Info commands -> Custom (!sens)." },
            new CustomCommand { Name = "schedule", Response = "Stream schedule: edit this in Settings -> Info commands -> Custom (!schedule)." },
            new CustomCommand { Name = "merch",    Response = "Merch link: edit this in Settings -> Info commands -> Custom (!merch)." },
            new CustomCommand { Name = "donate",   Response = "Support the stream: edit this in Settings -> Info commands -> Custom (!donate)." },
            new CustomCommand { Name = "youtube",  Response = "YouTube: edit this in Settings -> Info commands -> Your socials." },
            new CustomCommand { Name = "tiktok",   Response = "TikTok: edit this in Settings -> Info commands -> Your socials." },
            new CustomCommand { Name = "twitter",  Response = "Twitter/X: edit this in Settings -> Info commands -> Your socials." },
            new CustomCommand { Name = "rules",    Response = "Be cool, be kind, no spoilers. Have fun 💜" },
            new CustomCommand { Name = "prime",    Response = "Twitch Prime subs are FREE every month! Use yours on the channel 💜" },
            new CustomCommand { Name = "bot",      Response = "I run Loadout for Streamer.bot — full suite, one import. https://aquilo.gg/tools" }
        };
    }

    public class CustomCommand
    {
        public string Name         { get; set; } = "";   // chat token, lowercase, no leading !
        public string Response     { get; set; } = "";   // {user}, {rest} interpolated
        // Comma-separated roles that may invoke this command. Empty / "*"
        // / "everyone" means anyone. Recognized roles: broadcaster, mod,
        // vip, sub, viewer. ModifyRoles is the legacy alias.
        public string AllowedRoles { get; set; } = "everyone";
        public string ModifyRoles  { get; set; } = "";   // legacy alias for AllowedRoles
        // Per-command cooldown in seconds. 0 = uses ChatNoise.InfoCommandCooldownSec.
        public int    CooldownSec  { get; set; } = 0;
    }

    public class GoalsConfig
    {
        public List<Goal> Goals { get; set; } = new List<Goal>
        {
            new Goal { Name = "Sub goal", Kind = "subs",      Target = 100, Current = 0, Enabled = false },
            new Goal { Name = "Bit goal", Kind = "bits",      Target = 5000, Current = 0, Enabled = false },
            new Goal { Name = "Followers", Kind = "followers", Target = 1000, Current = 0, Enabled = false }
        };

        // --- Customizer knobs (June 2026) -------------------------------
        // Visual style of the progress bar. "filled" = solid fill,
        // "striped" = animated diagonal stripes, "glow" = subtle pulse.
        public string BarStyle      { get; set; } = "filled";   // filled | striped | glow
        // Render the numeric "X / Y" + percentage text on each goal row.
        public bool   ShowNumbers   { get; set; } = true;
        // Display goals as horizontal bars (default) or vertical thermometers.
        public string Orientation   { get; set; } = "horizontal"; // horizontal | vertical
        // Bar corner radius (px). 0 = sharp, 999 = pill.
        public int    CornerRadiusPx { get; set; } = 999;
        // Bar accent hex (no #). Empty = aurora gradient.
        public string Accent        { get; set; } = "";
        // Celebrate when a goal hits 100%: brief confetti + ring flash.
        public bool   CelebrateOnReach { get; set; } = true;
    }

    public class Goal
    {
        public string Name    { get; set; } = "";
        public string Kind    { get; set; } = "subs"; // followers | subs | bits | coins | custom
        public int    Target  { get; set; } = 100;
        public int    Current { get; set; } = 0;
        public bool   Enabled { get; set; } = false;
    }

    public class ChatNoiseConfig
    {
        // Master mute - kills every ambient chat post. Info commands and
        // explicit user actions still respond (silencing them looks broken).
        public bool QuietMode             { get; set; } = false;
        // Loadout will not send more than this many messages/minute, total.
        public int  MaxChatPerMinute      { get; set; } = 30;

        // Block list - chat events from any handle in this list are
        // dropped before any module sees them. Used to ignore Nightbot /
        // StreamElements / Moobot / other bots that would otherwise
        // trigger welcomes, counters, info commands, etc. Match is
        // case-insensitive on the user handle WITHOUT the leading @.
        // Wildcards: a trailing "*" matches any suffix
        // ("streamlabs*" hits "streamlabs", "streamlabsBot", etc.).
        // Comma- or newline-separated when edited in Settings; stored
        // here as a normalized list.
        public List<string> BlockedUsers { get; set; } = new List<string>
        {
            "nightbot",
            "streamelements",
            "moobot",
            "streamlabs",
            "wizebot",
            "sery_bot",
            "soundalerts",
            "fossabot"
        };

        // Ignore the broadcaster's own chat for AMBIENT processing —
        // welcomes, first-chatter style celebrations, per-message bolt
        // earns, engagement tracking (top chatter), chat-velocity hype
        // detection, and recap chat counts. Default ON: the streamer
        // talking shouldn't make them their own top chatter, earn them
        // bolts, or trip hype detection — and when Loadout sends chat
        // through the broadcaster account, this also stops the bot's
        // own output from feeding back into those trackers.
        //
        // Deliberately NOT a full block: the broadcaster's COMMANDS
        // (!died, !uptime, mod tampers, game actions) still work, and
        // the timed-messages "pause after the streamer talks" gate
        // still sees their messages.
        public bool IgnoreBroadcasterChat { get; set; } = true;

        // Per-area chat output. Disable any of these and the underlying module
        // still runs - overlays, persistence, bus events all keep working.
        public bool AlertsToChat          { get; set; } = true;
        public bool WelcomesToChat        { get; set; } = true;
        public bool InfoCommandsToChat    { get; set; } = true;
        public bool CountersToChat        { get; set; } = true;
        public bool BoltsToChat           { get; set; } = true;
        public bool GoalsToChat           { get; set; } = true;

        // Per-command global cooldown (anyone can hit the command, but only N
        // seconds apart channel-wide). 0 disables.
        public int  InfoCommandCooldownSec { get; set; } = 30;
        public int  CounterAckCooldownSec  { get; set; } = 5;
        // Counter chat ack mode: 0 silent, 1 every change, N every Nth change.
        public int  CounterAckEveryN       { get; set; } = 1;
    }

    public class RotationIntegrationConfig
    {
        // Lets viewers spend Bolts via !boltsong <song> to push a priority
        // request into the Rotation music widget. The widget subscribes to
        // rotation.song.request on the Aquilo Bus and treats messages from
        // Loadout as priority requests (skip their own cooldowns / gates).
        // Refunds Bolts automatically if the widget rejects the request
        // (queue full, blocked artist, etc.).
        public bool   Enabled              { get; set; } = false;
        public string Command              { get; set; } = "!boltsong";
        public int    Cost                 { get; set; } = 200;
        public int    PerUserCooldownSec   { get; set; } = 120;
        public int    RefundOnFailureSec   { get; set; } = 30;
    }

    /// <summary>
    /// Connection between Loadout and the streamer's Rotation Spotify widget.
    /// The widget runs at widget.aquilo.gg/rotation/* and connects to the
    /// local Aquilo Bus so it can both ack !boltsong requests and publish
    /// rotation.song.playing as the Spotify track changes. We surface
    /// the URL with bus params pre-baked, plus a "!song" chat command
    /// that NowPlayingModule serves from the cached payload.
    /// </summary>
    public class RotationConnectionConfig
    {
        // Override the deploy host if the streamer self-hosts the
        // Rotation widget. Empty = use the default widget.aquilo.gg.
        public string BaseUrl { get; set; } = "";
        // Which page variant the streamer's URL points at. The bus
        // wiring is identical across pages — this is purely the visual
        // surface. "widget" = compact card, "queue" = upcoming list,
        // "now-playing" = large hero card.
        public string Variant { get; set; } = "widget";

        // Chat command for now-playing. When enabled, viewers can type
        // !song (or whatever Command is set to) and Loadout replies
        // with the cached rotation.song.playing payload.
        public bool   SongCommandEnabled  { get; set; } = true;
        public string SongCommand         { get; set; } = "!song";
        // Channel-wide cooldown so chat can't spam !song. Mods +
        // broadcaster bypass like other info commands.
        public int    SongCooldownSec     { get; set; } = 30;
    }

    public class BoltsConfig
    {
        public string DisplayName         { get; set; } = "Bolts";
        public string Emoji               { get; set; } = "⚡";

        // Earn rates (raw, before multipliers). May 2026: cut to roughly
        // half the previous defaults so the economy is a meaningful grind
        // instead of a passive trickle. Channel-point coins took the
        // hardest cut (10 → 25) since they're the most farmable source.
        // Existing installs migrate to these via SettingsSchemaVersion=1
        // — only fields still at the old defaults get bumped down.
        public int    PerChatMessage      { get; set; } = 1;
        public int    PerSub              { get; set; } = 25;
        public int    PerGiftSub          { get; set; } = 15;
        public int    PerRaidBrought      { get; set; } = 50;
        public int    PerCheerBitDivisor  { get; set; } = 200;   // 1 bolt per N bits
        public int    PerCcCoinDivisor    { get; set; } = 25;
        public int    PerDailyCheckIn     { get; set; } = 50;
        public int    SubAnniversaryBonusBase { get; set; } = 50;   // total = base * milestoneMonths

        // Multipliers applied at credit time. Stack additively (e.g. sub 0.5 +
        // patron 0.5 + streak = final).
        public double SubMultiplier         { get; set; } = 0.5;   // +50%
        public double PatreonBonus          { get; set; } = 0.5;   // +50% for active Patrons
        public double DailyStreakPerDay     { get; set; } = 0.1;
        public double DailyStreakCap        { get; set; } = 1.0;   // cap streak bonus alone

        // Anti-AFK: cap chat earns per minute per viewer (no point sitting and macro-spamming).
        // Halved in May 2026 to make passive chat farming less productive
        // alongside the rest of the economy rebalance. Migration bumps
        // existing installs from 6 → 3 only when still at the old default.
        public int    MaxChatEarnsPerMinute { get; set; } = 3;

        // Spend rules.
        public int    GiftMinAmount       { get; set; } = 10;     // !gift floor

        // Tip integration — when a viewer tips via Streamlabs / Stream
        // Elements / Ko-fi / etc., the streamer wires their provider's
        // webhook to the Worker's /tips/<guildId>/<secret> endpoint via
        // a Streamer.bot HTTP request action. The DLL polls the Worker
        // for new tip events, awards bolts at TipBoltsPerDollar, and
        // republishes on the Aquilo Bus as `tips.received` so overlays
        // can render a celebration. Set Enabled=false to opt out
        // entirely; the polling loop also short-circuits.
        public bool   TipsEnabled         { get; set; } = false;
        public int    TipBoltsPerDollar   { get; set; } = 100;     // 100 bolts per $1 tipped (counts as on-stream earn)
        public int    TipMinDollars       { get; set; } = 1;       // ignore tips below this floor
        public string TipAlertTemplate    { get; set; } = "💖 {tipper} tipped {amount} {currency} — +{bolts}{emoji}!";

        // Weekly digest — once a week the DLL POSTs a stats summary to
        // the Worker, which formats it as a Discord embed and posts to
        // the configured channel. Pure off-stream summary; no overlay
        // surface. Set Enabled=false to opt out entirely.
        public bool   WeeklyDigestEnabled    { get; set; } = false;
        public int    WeeklyDigestDay        { get; set; } = 1;        // 0=Sun … 6=Sat (default Monday)
        public int    WeeklyDigestHourUtc    { get; set; } = 14;       // 14:00 UTC (mid-morning US East / late afternoon EU)
        public string WeeklyDigestChannelId  { get; set; } = "";       // Discord channel id (snowflake string)

        // Daily quests — 3 quests per viewer per UTC day, completing
        // each pays a bolt bonus. Bus-driven trackers; deterministic
        // daily set seeded by viewer-key + date so a viewer always
        // sees the same 3 quests across menu re-opens.
        public bool   DailyQuestsEnabled { get; set; } = true;

        // Slots minigame (!slots <wager>). Symbols pulled from
        // SlotsImagePool — newline-separated image URLs (Twitch
        // emote CDN URLs work great). Empty = use the overlay's
        // built-in default global-emote pool. Match payouts:
        // 3-of-a-kind = wager × SlotsPayoutAllSame; any 2-of-a-kind
        // returns wager × SlotsPayoutTwoSame (default 1 = wash).
        public string SlotsImagePool       { get; set; } = "";
        // When true, the slots reels auto-populate from the Twitch
        // emotes the broadcaster's chat actually uses. The DLL
        // harvests emote URLs out of every chat event (TwitchEmoteCache)
        // and the !slots resolver prefers that rolling pool over
        // SlotsImagePool. Channel + sub emotes naturally dominate
        // because they show up most often in the broadcaster's chat.
        // Falls back to SlotsImagePool / built-in defaults when fewer
        // than ~3 unique emotes have been observed yet.
        public bool   SlotsUseTwitchEmotes { get; set; } = false;
        public int    SlotsMinWager        { get; set; } = 5;
        public int    SlotsMaxWager        { get; set; } = 500;
        public int    SlotsPayoutAllSame   { get; set; } = 5;     // 3 same → wager × 5
        public int    SlotsPayoutTwoSame   { get; set; } = 1;     // 2 same → wager × 1 (returns wager)

        // Coinflip + dice chat games (chat-side equivalents of the
        // Discord /coinflip and /dice slash commands). Same wallet,
        // same bus events, same minigames overlay rendering. Streamers
        // can disable individually by setting Min/Max to 0.
        public int    CoinflipMinWager     { get; set; } = 5;
        public int    CoinflipMaxWager     { get; set; } = 500;
        public int    DiceMinWager         { get; set; } = 5;
        public int    DiceMaxWager         { get; set; } = 500;
        // !rps and !roulette wager bounds — previously rode on the
        // coinflip bounds, which made tuning the spread for one game
        // affect the other. Defaults match coinflip so existing
        // configs don't shift on upgrade.
        public int    RpsMinWager          { get; set; } = 5;
        public int    RpsMaxWager          { get; set; } = 500;
        public int    RouletteMinWager     { get; set; } = 5;
        public int    RouletteMaxWager     { get; set; } = 500;
        // Master per-game enable. Min/Max=0 still disables, but these
        // give the streamer an obvious on/off in the Settings card
        // without having to zero the wager bounds (and remember the
        // previous values when they want to re-enable).
        public bool   CoinflipEnabled      { get; set; } = true;
        public bool   DiceEnabled          { get; set; } = true;
        public bool   SlotsEnabled         { get; set; } = true;
        public bool   RpsEnabled           { get; set; } = true;
        public bool   RouletteEnabled      { get; set; } = true;

        // !heist <stake> — community heist mini-event. Initiator stakes
        // bolts, opens a 60s window where everyone in chat can `!join`
        // with their own stake. If the pot crosses TargetPot by deadline,
        // the crew splits TargetPot × PayoutMultiplier proportional to
        // each contributor's stake (so big-staker gets bigger payout).
        // If the pot falls short, every contribution is lost — that's
        // the "heist failed, nobody walks away clean" drama that makes
        // viewers chip in instead of free-riding.
        public bool   HeistEnabled              { get; set; } = true;
        public int    HeistMinStake             { get; set; } = 25;
        public int    HeistMaxStake             { get; set; } = 1000;
        public int    HeistTargetPot            { get; set; } = 500;     // pot must reach this to succeed
        public int    HeistJoinWindowSec        { get; set; } = 60;
        public double HeistPayoutMultiplier     { get; set; } = 1.6;     // payout = TargetPot × this
        public int    HeistPerUserCooldownSec   { get; set; } = 600;     // per-viewer initiator cooldown (10 min)
        public int    HeistGlobalCooldownSec    { get; set; } = 180;     // chat-wide cooldown between heists (3 min)
        // Dice payout multiplier when the rolled face matches the
        // target (1-6, 1/6 chance). 5 = wager × 5 net win, matching
        // the off-stream Discord /dice math.
        public int    DicePayoutMultiplier { get; set; } = 5;

        // Per-user cooldown applied to ALL three minigames. Stops a
        // single supporter from spamming a hundred spins. Mods +
        // broadcaster bypass.
        public int    GamePerUserCooldownSec { get; set; } = 30;

        // Delay (ms) between the bus event firing (which kicks the
        // overlay's spin / flip / roll animation) and the chat reply
        // posting the result. Lets the on-screen game play out so
        // chat doesn't spoiler the outcome before viewers see it.
        // Default 1800 ms tracks the longest minigames-overlay
        // animation (slots, ~1700 ms settle).
        public int    GameResultDelayMs    { get; set; } = 1800;

        // Master toggle for the chat-side win/loss replies on minigame
        // results. Bus events and overlay animations always fire; this
        // controls only whether chat ALSO gets a "@user flipped HEADS
        // — +N bolts" line. Some streamers prefer the overlay-only
        // experience; others want the visibility in chat. Default on.
        public bool   GameChatReplies      { get; set; } = true;

        // Editable templates for each minigame outcome — placeholders
        // {user} {wager} {payout} {balance} {emoji} {result} {target}
        // {multiplier} get substituted at send time. Empty string falls
        // back to the hardcoded default. Defaults are intentionally
        // SHORT — chat already gets a flood when several viewers play
        // back-to-back; long replies make it worse. Streamers who want
        // the balance / wager spelled out can re-add {balance} to the
        // template manually.
        public string CoinflipWinTemplate  { get; set; } = "🪙 @{user} HEADS +{payout}{emoji}";
        public string CoinflipLoseTemplate { get; set; } = "🪙 @{user} tails -{wager}{emoji}";
        public string DiceWinTemplate      { get; set; } = "🎲 @{user} rolled {result} — JACKPOT +{payout}{emoji}";
        public string DiceLoseTemplate     { get; set; } = "🎲 @{user} rolled {result}, missed {target} -{wager}{emoji}";
        public string SlotsJackpotTemplate { get; set; } = "🎰 JACKPOT @{user} +{payout}{emoji}";
        public string SlotsTwoTemplate     { get; set; } = "🎰 @{user} two-match +{payout}{emoji}";
        public string SlotsNoneTemplate    { get; set; } = "🎰 @{user} -{wager}{emoji}";
        public string RpsWinTemplate       { get; set; } = "✊✋✌ @{user} {viewer}>{bot} +{payout}{emoji}";
        public string RpsLoseTemplate      { get; set; } = "✊✋✌ @{user} {viewer}<{bot} -{wager}{emoji}";
        public string RpsTieTemplate       { get; set; } = "✊✋✌ @{user} {viewer}={bot} tie";
        public string RouletteWinTemplate  { get; set; } = "🎡 @{user} {pick} → {pocket}{colorGlyph} +{payout}{emoji}";
        public string RouletteLoseTemplate { get; set; } = "🎡 @{user} {pick} → {pocket}{colorGlyph} -{wager}{emoji}";

        // Global throttle on minigame result chat replies — max 1
        // posted reply per N seconds across ALL games. Prevents a
        // back-to-back hit train from flooding chat. Bus events and
        // overlay animations always fire; this only gates the chat
        // send. Set to 0 to disable throttling.
        public int    GameReplyMinIntervalSec { get; set; } = 4;
    }

    public class ApexConfig
    {
        // HP pool when a fresh viewer takes the crown (first-blood OR finisher
        // OR manual mod crown). Higher = harder to dethrone.
        public int    StartingHealth                  { get; set; } = 1000;

        // Per-event damage values. Tweak to taste; defaults assume a moderately
        // active channel where a quick reign change is exciting, not constant.
        public int    DamageSub                       { get; set; } = 100;
        public int    DamageResub                     { get; set; } = 100;
        public int    DamageGiftSub                   { get; set; } = 80;     // multiplied by gift count
        public int    DamagePerHundredBits            { get; set; } = 10;
        public int    DamagePerTikTokCoin             { get; set; } = 1;
        public int    DamagePerCcCoin                 { get; set; } = 1;
        public int    DamagePerBoltsSpent             { get; set; } = 1;
        public int    DamagePerChannelPointRedemption { get; set; } = 50;
        public int    DamagePerCheckIn                { get; set; } = 25;
        public int    DamagePerRaidViewer             { get; set; } = 1;      // raid count * this

        // Behavior toggles.
        public bool   AutoCrownFinisher               { get; set; } = true;
        public bool   SelfImmunity                    { get; set; } = true;
        public bool   IncludeBroadcaster              { get; set; } = false;  // streamer can't be Apex by default
        public bool   AnnounceCrownChange             { get; set; } = true;   // chat msg on dethrone
        public string DiscordWebhook                  { get; set; } = "";

        // Damage messages: only post on chat if damage >= this; under that we
        // only push to the bus / overlay. Keeps chat readable during cheers.
        public int    ChatAnnounceDamageThreshold     { get; set; } = 200;
    }

    /// <summary>
    /// Configuration for the !clip command. Defaults are tuned for a typical
    /// Twitch streamer who wants subs/VIPs/mods to clip without spamming.
    /// </summary>
    public class ClipsConfig
    {
        public bool   Enabled              { get; set; } = true;
        public string Command              { get; set; } = "!clip";
        // CSV of roles allowed to clip. "everyone" / "all" / "*" = no role gate.
        public string AllowedRoles         { get; set; } = "sub,vip,mod,broadcaster";
        // Per-user cooldown for non-mods (seconds).
        public int    PerUserCooldownSec   { get; set; } = 300;
        // Mods + broadcaster get a much shorter cooldown.
        public int    ModCooldownSec       { get; set; } = 30;
        // Channel-wide cooldown (any chatter) - safety net so 50 viewers can't
        // each successfully clip in a 5-second window.
        public int    ChannelCooldownSec   { get; set; } = 8;
        // Twitch CPH params. Bot account avoids using broadcaster's auth.
        public bool   UseBotAccount        { get; set; } = false;
        // hasDelay = wait ~5s before grabbing the moment - nice when a key
        // moment just happened and you want context, not the chat reaction.
        public bool   HasDelay             { get; set; } = false;
        // Acknowledgement before the URL resolves (~3-7s).
        public bool   AckInChat            { get; set; } = true;
        public string AckTemplate          { get; set; } = "📎 Clipping that for you, {user}...";
        // Template for the actual URL post. {user} {url} interpolated.
        public string PostTemplate         { get; set; } = "🎬 Clip by {user}: {url}";
        // Optional Discord webhook to mirror clips to a #clips channel.
        public string DiscordWebhook       { get; set; } = "";
        public string DiscordTemplate      { get; set; } = "🎬 New clip by **{user}**: {url}";
        // Bonus Bolts awarded to the clipper. 0 = off.
        public int    AwardBolts           { get; set; } = 25;
    }

    public class VipRotationConfig
    {
        public int    IntervalDays         { get; set; } = 7;
        public int    RotationsPerCycle    { get; set; } = 2;
        // Viewers in this list never get demoted or promoted automatically.
        public List<string> ExemptHandles  { get; set; } = new List<string>();
        // Promotion candidates need at least this many tracked messages.
        public int    MinMessages          { get; set; } = 50;
        public string DiscordWebhook       { get; set; } = "";

        [JsonIgnore]
        public DateTime LastRunUtc         { get; set; } = DateTime.MinValue;
    }
}
