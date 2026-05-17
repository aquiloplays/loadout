using System;
using System.Collections.Generic;
using Loadout.Modules;
using Loadout.Settings;

namespace Loadout.Sb
{
    /// <summary>
    /// Single funnel for every event coming out of Streamer.bot. The SB-side
    /// trampoline actions all call <see cref="DispatchEvent"/> with a string event
    /// kind ("follow", "sub", "raid", ...) and the raw CPH args dictionary; from
    /// there, this class fans out to module handlers.
    ///
    /// Why string-keyed routing instead of an enum: SB invents new event types
    /// over time and we want users to receive them on a DLL update without re-
    /// importing the SB bundle. The bundle-side C# is intentionally stupid.
    /// </summary>
    public sealed class SbEventDispatcher
    {
        private static readonly SbEventDispatcher _instance = new SbEventDispatcher();
        public static SbEventDispatcher Instance => _instance;

        private readonly List<IEventModule> _modules = new List<IEventModule>();

        private SbEventDispatcher() { }

        public void RegisterDefaultModules()
        {
            lock (_modules)
            {
                if (_modules.Count > 0) return;
                _modules.Add(new EngagementFeederModule());     // must be first - feeds the tracker before consumers read
                // GameProfilesModule must run before WelcomesModule + TimedMessagesModule
                // so the active-profile pointer is set before they consult it on
                // their next chat / tick. Order on the same event matters here.
                _modules.Add(new GameProfilesModule());
                // FollowBatchModule must run BEFORE AlertsModule so the
                // "loadout.suppress.alert" flag is set on the EventContext
                // before AlertsModule sees the follow event.
                _modules.Add(new FollowBatchModule());
                _modules.Add(new InfoCommandsModule());
                _modules.Add(new WelcomesModule());
                _modules.Add(new AlertsModule());
                _modules.Add(new ChannelPointsModule());
                _modules.Add(new TimedMessagesModule());
                _modules.Add(new HateRaidModule());
                _modules.Add(new HypeTrainModule());
                _modules.Add(new CountersModule());
                _modules.Add(new CheckInModule());
                _modules.Add(new FirstWordsModule());
                _modules.Add(new AdBreakModule());
                _modules.Add(new ChatVelocityModule());
                _modules.Add(new DiscordLiveStatusModule());
                _modules.Add(new TwitterLiveStatusModule());
                _modules.Add(new WebhookInboxModule());
                _modules.Add(new StreamRecapModule());
                _modules.Add(new SubRaidTrainModule());
                _modules.Add(new AutoPollModule());
                _modules.Add(new GoalsModule());
                _modules.Add(new VipRotationModule());
                _modules.Add(new CcCoinTrackerModule());
                _modules.Add(new SubAnniversaryModule());
                _modules.Add(new BoltsModule());
                _modules.Add(new ApexModule());
                _modules.Add(new GameTrackerModule());
                _modules.Add(new ClipsModule());
                _modules.Add(new BoltsShopModule());
                // DungeonModule wires !dungeon / !join / !duel. Owns its
                // own per-game state (DungeonGameStore) and publishes
                // dungeon.* / duel.* bus events the OBS overlay reads.
                _modules.Add(new DungeonModule());
                // NowPlayingModule caches rotation.song.playing payloads
                // and serves !song. Register before CommandsBroadcaster so
                // !song shows up in the published commands.list snapshot.
                _modules.Add(new NowPlayingModule());
                // ProfileModule serves !setbio / !setpfp / !setsocial /
                // !setgamertag / !setpronouns / !clearprofile.
                _modules.Add(new ProfileModule());
                // Weekly digest: bus-driven counters + a 1-min scheduler
                // that posts to the Worker once a week. Pure listener;
                // doesn't need to be in any particular order.
                _modules.Add(new WeeklyDigestModule());
                // Daily quests: 3 viewer quests per UTC day, bus-driven
                // tracking + completion bonuses. Static singleton holds
                // the per-viewer state; lookups from the /loadout menu
                // hit DailyQuestsStore via this module.
                _modules.Add(new DailyQuestsModule());
                // Cross-product achievements: bus-driven trackers across
                // bolts / hype train / minigames / heists / tips.
                // Separate from the dungeon-specific achievement set
                // which lives on HeroState.Achievements.
                _modules.Add(new AchievementsModule());
                // Last - just publishes the canonical command list to the bus
                // for the "Available commands" overlay. Must come AFTER every
                // module that contributes commands so the snapshot it builds
                // at construction reflects the full set.
                _modules.Add(new CommandsBroadcaster());
            }
        }

        public void DispatchEvent(string kind, IDictionary<string, object> args)
        {
            if (string.IsNullOrEmpty(kind)) return;
            args = args ?? new Dictionary<string, object>();

            // Per-kind counter for the Health tab's "Activity (session)" row.
            Util.EventStats.Instance.Increment(kind);

            var ctx = EventContext.From(kind, args);
            List<IEventModule> snapshot;
            lock (_modules) snapshot = new List<IEventModule>(_modules);

            foreach (var m in snapshot)
            {
                try { m.OnEvent(ctx); }
                catch (Exception ex)
                {
                    Util.ErrorLog.Write(m.GetType().Name + ".OnEvent[" + kind + "]", ex);
                }
            }
        }

        /// <summary>
        /// Tick hook — invoked once a minute by the SB-side timer trigger. Modules
        /// that care about wall-clock cadence (timed messages, hype-train decay)
        /// implement <see cref="IEventModule.OnTick"/>.
        /// </summary>
        public void Tick()
        {
            List<IEventModule> snapshot;
            lock (_modules) snapshot = new List<IEventModule>(_modules);
            foreach (var m in snapshot)
            {
                try { m.OnTick(); }
                catch (Exception ex)
                {
                    Util.ErrorLog.Write(m.GetType().Name + ".OnTick", ex);
                }
            }
        }
    }

    /// <summary>
    /// Normalized event payload — module handlers read this rather than the raw
    /// CPH dictionary, so adding a new platform later is a one-place change.
    /// </summary>
    public sealed class EventContext
    {
        public string Kind        { get; private set; }
        public PlatformMask Platform { get; private set; }
        public string User        { get; private set; }
        public string UserType    { get; private set; }      // viewer | sub | vip | mod | broadcaster
        public string Message     { get; private set; }
        public IDictionary<string, object> Raw { get; private set; }

        public static EventContext From(string kind, IDictionary<string, object> raw)
        {
            string source = TryGet(raw, "eventSource", "");
            return new EventContext
            {
                Kind = kind,
                Platform = PlatformMaskExtensions.FromShortName(source),
                User     = TryGet(raw, "user", TryGet(raw, "userName", "")),
                UserType = TryGet(raw, "userType", "viewer"),
                Message  = TryGet(raw, "message", TryGet(raw, "rawInput", "")),
                Raw      = raw
            };
        }

        public T Get<T>(string key, T fallback = default)
        {
            if (Raw == null || !Raw.TryGetValue(key, out var v)) return fallback;
            if (v is T t) return t;
            try { return (T)Convert.ChangeType(v, typeof(T)); } catch { return fallback; }
        }

        private static string TryGet(IDictionary<string, object> d, string key, string fallback)
        {
            if (d == null) return fallback;
            return d.TryGetValue(key, out var v) ? (v?.ToString() ?? fallback) : fallback;
        }
    }
}
