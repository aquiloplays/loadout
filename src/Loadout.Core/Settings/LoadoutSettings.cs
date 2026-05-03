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
        public int    SchemaVersion   { get; set; } = 1;
        public string SuiteVersion    { get; set; } = "0.1.0";
        public bool   OnboardingDone  { get; set; } = false;
        public string BroadcasterName { get; set; } = "";

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
    }

    public class PlatformsConfig
    {
        public bool Twitch  { get; set; } = true;
        public bool TikTok  { get; set; } = true;
        public bool YouTube { get; set; } = true;
        public bool Kick    { get; set; } = true;

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
        public List<TimedMessage> Messages { get; set; } = new List<TimedMessage>
        {
            new TimedMessage
            {
                Name = "Follow reminder",
                Message = "Enjoying the stream? Drop a follow ❤️",
                IntervalMinutes = 20,
                MinChatMessages = 5,
                MinChatWindowMinutes = 5,
                Platforms = new PlatformsConfig(),
                Enabled = true
            }
        };
    }

    public class TimedMessage
    {
        public string Name                 { get; set; } = "";
        public string Message              { get; set; } = "";
        public int    IntervalMinutes      { get; set; } = 15;
        public int    MinChatMessages      { get; set; } = 5;
        public int    MinChatWindowMinutes { get; set; } = 5;
        public int    BroadcasterPauseSec  { get; set; } = 60;
        public bool   Enabled              { get; set; } = true;
        public string Group                { get; set; } = "Default";
        public PlatformsConfig Platforms   { get; set; } = new PlatformsConfig();

        [JsonIgnore]
        public DateTime LastFiredUtc { get; set; } = DateTime.MinValue;
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
        public string GitHubRepo      { get; set; } = "aquiloplays/loadout";

        [JsonIgnore]
        public DateTime LastCheckedUtc { get; set; } = DateTime.MinValue;
    }

    public class CountersConfig
    {
        public bool Enabled { get; set; } = true;
        public List<Counter> Counters { get; set; } = new List<Counter>
        {
            new Counter { Name = "deaths", Display = "Deaths", Value = 0 },
            new Counter { Name = "wins",   Display = "Wins",   Value = 0 }
        };
    }

    public class Counter
    {
        // Lowercase token used in chat commands (!deaths). Must be a single word.
        public string Name    { get; set; } = "";
        // Pretty label shown in overlays / responses.
        public string Display { get; set; } = "";
        public int    Value   { get; set; } = 0;
        // Optional template the response message uses; "{display}: {value}" by default.
        public string ResponseTemplate { get; set; } = "{display}: {value}";
        // Roles that may modify (mod, broadcaster, vip, viewer). Comma-separated.
        public string ModifyRoles { get; set; } = "broadcaster,mod";
        // Resets each new stream (we detect via ObsStreamingStarted later).
        public bool   ResetEachStream { get; set; } = false;
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
        public string Tier     { get; set; } = "tier2";    // tier1 | tier2 | tier3
    }

    public class InfoCommandsConfig
    {
        public string Discord { get; set; } = "Join the Discord: https://discord.gg/example";
        public string Socials { get; set; } = "Find me everywhere: https://aquilo.gg";
        public List<CustomCommand> Custom { get; set; } = new List<CustomCommand>();
    }

    public class CustomCommand
    {
        public string Name     { get; set; } = "";       // chat token, lowercase, no leading !
        public string Response { get; set; } = "";       // {user}, {rest} interpolated
        public string ModifyRoles { get; set; } = "";    // unused for now, reserved
    }

    public class GoalsConfig
    {
        public List<Goal> Goals { get; set; } = new List<Goal>
        {
            new Goal { Name = "Sub goal", Kind = "subs",      Target = 100, Current = 0, Enabled = false },
            new Goal { Name = "Bit goal", Kind = "bits",      Target = 5000, Current = 0, Enabled = false },
            new Goal { Name = "Followers", Kind = "followers", Target = 1000, Current = 0, Enabled = false }
        };
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

    public class BoltsConfig
    {
        public string DisplayName         { get; set; } = "Bolts";
        public string Emoji               { get; set; } = "⚡";

        // Earn rates (raw, before multipliers).
        public int    PerChatMessage      { get; set; } = 1;
        public int    PerSub              { get; set; } = 50;
        public int    PerGiftSub          { get; set; } = 30;
        public int    PerRaidBrought      { get; set; } = 100;
        public int    PerCheerBitDivisor  { get; set; } = 100;   // 1 bolt per N bits
        public int    PerCcCoinDivisor    { get; set; } = 10;
        public int    PerDailyCheckIn     { get; set; } = 100;
        public int    SubAnniversaryBonusBase { get; set; } = 100;   // total = base * milestoneMonths

        // Multipliers applied at credit time. Stack additively (e.g. sub 0.5 +
        // patreon-tier3 1.0 = 2.5x final).
        public double SubMultiplier         { get; set; } = 0.5;   // +50%
        public double PatreonTier1Bonus     { get; set; } = 0.2;
        public double PatreonTier2Bonus     { get; set; } = 0.5;
        public double PatreonTier3Bonus     { get; set; } = 1.0;
        public double DailyStreakPerDay     { get; set; } = 0.1;
        public double DailyStreakCap        { get; set; } = 1.0;   // cap streak bonus alone

        // Anti-AFK: cap chat earns per minute per viewer (no point sitting and macro-spamming).
        public int    MaxChatEarnsPerMinute { get; set; } = 6;

        // Spend rules.
        public int    GiftMinAmount       { get; set; } = 10;     // !gift floor
        public int    BoltRainMinTotal    { get; set; } = 100;
        public int    BoltRainMaxRecipients { get; set; } = 100;
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
