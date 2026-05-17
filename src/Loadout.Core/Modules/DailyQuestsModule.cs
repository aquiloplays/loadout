using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// Daily quests for viewers — lightweight engagement loop. Each
    /// stream day a viewer is offered ~3 quests (mix of easy / medium /
    /// hard); completing any awards a fixed bolts bonus on top of the
    /// activity's normal earnings. Progress persists across the UTC
    /// day; quests refresh at midnight UTC. Crashes never strand
    /// progress — state writes synchronously on each increment.
    ///
    /// Quest catalog (small + tunable, deliberately not data-driven —
    /// the tracking hooks are coupled to bus event shapes that can
    /// shift across versions):
    ///
    ///   chat-active   chat 5 messages          easy   +25 ⚡
    ///   bolts-earned  earn 50 bolts            easy   +50 ⚡
    ///   minigame-play play any minigame        easy   +30 ⚡
    ///   coinflip-win  win a !coinflip          medium +75 ⚡
    ///   dungeon-run   complete a !dungeon      medium +100 ⚡
    ///   heist-join    join a heist             medium +50 ⚡
    ///   sub-anniv     hit a sub anniversary    hard   +200 ⚡
    ///   boss-kill     slay a dungeon boss      hard   +250 ⚡
    ///   tip-stream    tip the streamer         hard   +500 ⚡
    ///
    /// State shape (per-viewer): a dict of quest-key → progress + a
    /// completion flag so re-emitting the same event after completion
    /// doesn't double-pay. Quest set per day is generated from a
    /// deterministic seed (date + viewer key) so a viewer always sees
    /// the same 3 quests per day across DLL restarts.
    /// </summary>
    public sealed class DailyQuestsModule : IEventModule
    {
        private readonly object _gate = new object();
        private QuestStore _store;
        private string _path;

        public DailyQuestsModule()
        {
            _path = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "daily-quests.json");
            _store = LoadFromDisk();

            // Bus subscriptions wire the trackers. Each handler is
            // narrow (one quest type) so adding a new quest only
            // requires a new handler and an entry in QuestCatalog.
            AquiloBus.Instance.RegisterHandler("bolts.earned",       (c, m) => Track(m, "bolts-earned",  d => Math.Max(0, AsLong(d?["amount"]))));
            AquiloBus.Instance.RegisterHandler("bolts.minigame.coinflip", (c, m) => TrackUnit(m, "minigame-play", "coinflip-win", d => AsBool(d?["won"])));
            AquiloBus.Instance.RegisterHandler("bolts.minigame.dice",     (c, m) => TrackUnit(m, "minigame-play", null, _ => false));
            AquiloBus.Instance.RegisterHandler("bolts.minigame.slots",    (c, m) => TrackUnit(m, "minigame-play", null, _ => false));
            AquiloBus.Instance.RegisterHandler("bolts.minigame.rps",      (c, m) => TrackUnit(m, "minigame-play", null, _ => false));
            AquiloBus.Instance.RegisterHandler("bolts.minigame.roulette", (c, m) => TrackUnit(m, "minigame-play", null, _ => false));
            AquiloBus.Instance.RegisterHandler("bolts.heist.success",     (c, m) => TrackHeistJoin(m, true));
            AquiloBus.Instance.RegisterHandler("bolts.heist.failure",     (c, m) => TrackHeistJoin(m, false));
            AquiloBus.Instance.RegisterHandler("dungeon.completed",       (c, m) => TrackUnit(m, "dungeon-run", "boss-kill", d => AsBool(d?["slewBoss"])));
            AquiloBus.Instance.RegisterHandler("tips.received",           (c, m) => TrackTip(m));
        }

        public void OnEvent(EventContext ctx)
        {
            // Chat-active is the only quest fed by chat events instead
            // of the bus. Increment on every non-bot message so a
            // 5-message quest rolls easily.
            if (ctx == null || string.IsNullOrEmpty(ctx.User)) return;
            var s = SettingsManager.Instance.Current;
            if (s?.Bolts == null || !s.Bolts.DailyQuestsEnabled) return;
            if (!IsChatEvent(ctx)) return;
            BumpProgress(ctx.Platform.ToShortName(), ctx.User, "chat-active", 1, s);
        }

        public void OnTick() { /* no-op — bus + chat drive the trackers */ }

        // ── Public API used by the menu / overlay ──────────────────────
        /// <summary>Snapshot of today's quests for a viewer. Generates
        /// the day's quest set if none exists yet (3 randomly-seeded
        /// quests by viewer-key + date so the set is stable across
        /// re-opens of the menu).</summary>
        public List<QuestProgress> GetTodayQuests(string platform, string handle)
        {
            EnsureLoaded();
            string key = MakeKey(platform, handle);
            string day = DateTime.UtcNow.ToString("yyyy-MM-dd");
            lock (_gate)
            {
                if (!_store.Viewers.TryGetValue(key, out var v))
                {
                    v = new QuestViewerState();
                    _store.Viewers[key] = v;
                }
                if (v.Day != day || v.Quests == null || v.Quests.Count == 0)
                {
                    v.Day = day;
                    v.Quests = GenerateDailySet(key, day);
                    Save();
                }
                // Return a clone so the caller can't mutate state.
                return v.Quests.Select(q => q.Clone()).ToList();
            }
        }

        // ── Trackers ───────────────────────────────────────────────────
        private BusMessage Track(BusMessage m, string questKey, Func<JToken, long> deltaFn)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                if (s?.Bolts == null || !s.Bolts.DailyQuestsEnabled) return null;
                var d = AsObject(m?.Data);
                string user = AsString(d?["user"]);
                if (string.IsNullOrEmpty(user)) return null;
                long amt = deltaFn(d);
                if (amt <= 0) return null;
                BumpProgress("twitch", user, questKey, amt, s);
            }
            catch (Exception ex) { ErrorLog.Write("DailyQuests.Track:" + questKey, ex); }
            return null;
        }

        // Two-quest convenience tracker: the first quest gets +1
        // unconditionally, the second gets +1 only if the predicate fires
        // (e.g. coinflip-win quest only counts wins).
        private BusMessage TrackUnit(BusMessage m, string baseQuest, string conditionalQuest, Func<JToken, bool> predicate)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                if (s?.Bolts == null || !s.Bolts.DailyQuestsEnabled) return null;
                var d = AsObject(m?.Data);
                string user = AsString(d?["user"]);
                if (string.IsNullOrEmpty(user)) return null;
                BumpProgress("twitch", user, baseQuest, 1, s);
                if (!string.IsNullOrEmpty(conditionalQuest) && predicate(d))
                    BumpProgress("twitch", user, conditionalQuest, 1, s);
            }
            catch (Exception ex) { ErrorLog.Write("DailyQuests.TrackUnit:" + baseQuest, ex); }
            return null;
        }

        // Heist contributes count for both joiners and the initiator —
        // the bus event includes the splits array, so we credit every
        // contributor with +1 to the heist-join quest.
        private BusMessage TrackHeistJoin(BusMessage m, bool succeeded)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                if (s?.Bolts == null || !s.Bolts.DailyQuestsEnabled) return null;
                var d = AsObject(m?.Data);
                var splits = d?["splits"] as JArray;
                if (splits == null) return null;
                foreach (var sp in splits)
                {
                    var user     = AsString(sp?["user"]);
                    var platform = AsString(sp?["platform"]) ?? "twitch";
                    if (string.IsNullOrEmpty(user)) continue;
                    BumpProgress(platform, user, "heist-join", 1, s);
                }
            }
            catch (Exception ex) { ErrorLog.Write("DailyQuests.Heist", ex); }
            return null;
        }

        private BusMessage TrackTip(BusMessage m)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                if (s?.Bolts == null || !s.Bolts.DailyQuestsEnabled) return null;
                var d = AsObject(m?.Data);
                string handle   = AsString(d?["tipperHandle"]);
                string platform = AsString(d?["tipperPlatform"]) ?? "twitch";
                if (string.IsNullOrEmpty(handle)) return null;
                BumpProgress(platform, handle, "tip-stream", 1, s);
            }
            catch { }
            return null;
        }

        // ── Bumpers ────────────────────────────────────────────────────
        private void BumpProgress(string platform, string handle, string questKey, long delta, LoadoutSettings s)
        {
            EnsureLoaded();
            string viewerKey = MakeKey(platform, handle);
            string day = DateTime.UtcNow.ToString("yyyy-MM-dd");
            QuestProgress completedJustNow = null;
            int rewardBolts = 0;
            string rewardName = "";
            string rewardGlyph = "";
            lock (_gate)
            {
                if (!_store.Viewers.TryGetValue(viewerKey, out var v))
                {
                    v = new QuestViewerState();
                    _store.Viewers[viewerKey] = v;
                }
                if (v.Day != day || v.Quests == null || v.Quests.Count == 0)
                {
                    v.Day = day;
                    v.Quests = GenerateDailySet(viewerKey, day);
                }
                var quest = v.Quests.FirstOrDefault(q => q.Key == questKey);
                if (quest == null || quest.Completed) return;
                quest.Progress += delta;
                if (quest.Progress >= quest.Target)
                {
                    quest.Progress = quest.Target;
                    quest.Completed = true;
                    quest.CompletedUtc = DateTime.UtcNow;
                    var def = QuestCatalog.FirstOrDefault(c => c.Key == questKey);
                    rewardBolts = def?.RewardBolts ?? 0;
                    rewardName  = def?.Name ?? questKey;
                    rewardGlyph = def?.Glyph ?? "🎯";
                    completedJustNow = quest.Clone();
                }
                Save();
            }
            // Award + announce OUTSIDE the lock so a slow Earn() or bus
            // publish can't deadlock the next tracker firing in another
            // thread.
            if (completedJustNow != null && rewardBolts > 0)
            {
                BoltsWallet.Instance.Earn(platform, handle, rewardBolts, "daily-quest:" + questKey);
                AquiloBus.Instance.Publish("quest.completed", new
                {
                    user        = handle,
                    platform    = platform,
                    questKey    = questKey,
                    questName   = rewardName,
                    glyph       = rewardGlyph,
                    rewardBolts = rewardBolts,
                    ts          = DateTime.UtcNow
                });
            }
        }

        // ── Daily-set generation ───────────────────────────────────────
        // Three quests per day, deterministically seeded by viewerKey + day:
        //   1 easy + 1 medium + 1 hard so the streamer's most-engaged
        //   regulars always have a hard-tier quest to chase.
        private static List<QuestProgress> GenerateDailySet(string viewerKey, string day)
        {
            int seed = HashSeed(viewerKey + ":" + day);
            var rng = new Random(seed);
            var easy   = QuestCatalog.Where(q => q.Tier == "easy").OrderBy(_ => rng.Next()).First();
            var medium = QuestCatalog.Where(q => q.Tier == "medium").OrderBy(_ => rng.Next()).First();
            var hard   = QuestCatalog.Where(q => q.Tier == "hard").OrderBy(_ => rng.Next()).First();
            return new List<QuestProgress>
            {
                new QuestProgress { Key = easy.Key,   Target = easy.Target },
                new QuestProgress { Key = medium.Key, Target = medium.Target },
                new QuestProgress { Key = hard.Key,   Target = hard.Target }
            };
        }

        private static int HashSeed(string s)
        {
            unchecked
            {
                int h = 17;
                foreach (var c in s) h = h * 31 + c;
                return h;
            }
        }

        // ── Catalog ────────────────────────────────────────────────────
        public sealed class QuestDef
        {
            public string Key;
            public string Name;
            public string Tier;          // easy | medium | hard
            public int    Target;
            public int    RewardBolts;
            public string Glyph;
            public string Description;
        }
        public static readonly QuestDef[] QuestCatalog = new[]
        {
            new QuestDef { Key = "chat-active",   Tier = "easy",   Name = "Show up",       Target = 5,   RewardBolts = 25,  Glyph = "💬", Description = "Send 5 chat messages" },
            new QuestDef { Key = "bolts-earned",  Tier = "easy",   Name = "Bolt earner",   Target = 50,  RewardBolts = 50,  Glyph = "⚡", Description = "Earn 50 bolts on stream" },
            new QuestDef { Key = "minigame-play", Tier = "easy",   Name = "Roll the dice", Target = 1,   RewardBolts = 30,  Glyph = "🎲", Description = "Play any minigame" },
            new QuestDef { Key = "coinflip-win",  Tier = "medium", Name = "Lucky flip",    Target = 1,   RewardBolts = 75,  Glyph = "🪙", Description = "Win a !coinflip" },
            new QuestDef { Key = "dungeon-run",   Tier = "medium", Name = "Dungeon run",   Target = 1,   RewardBolts = 100, Glyph = "🗺", Description = "Complete a !dungeon" },
            new QuestDef { Key = "heist-join",    Tier = "medium", Name = "Crew up",       Target = 1,   RewardBolts = 50,  Glyph = "🦹", Description = "Join a heist" },
            new QuestDef { Key = "sub-anniv",     Tier = "hard",   Name = "Anniversary",   Target = 1,   RewardBolts = 200, Glyph = "🎂", Description = "Hit a sub anniversary" },
            new QuestDef { Key = "boss-kill",     Tier = "hard",   Name = "Boss slayer",   Target = 1,   RewardBolts = 250, Glyph = "👑", Description = "Slay a dungeon boss" },
            new QuestDef { Key = "tip-stream",    Tier = "hard",   Name = "Patron",        Target = 1,   RewardBolts = 500, Glyph = "💖", Description = "Tip the streamer" }
        };
        public static QuestDef DefByKey(string key) => QuestCatalog.FirstOrDefault(q => q.Key == key);

        // ── State types ────────────────────────────────────────────────
        public sealed class QuestProgress
        {
            public string Key { get; set; }
            public long   Progress { get; set; }
            public long   Target { get; set; }
            public bool   Completed { get; set; }
            public DateTime CompletedUtc { get; set; }
            public QuestProgress Clone() => new QuestProgress
            {
                Key = Key, Progress = Progress, Target = Target,
                Completed = Completed, CompletedUtc = CompletedUtc
            };
        }
        private sealed class QuestViewerState
        {
            public string Day { get; set; }
            public List<QuestProgress> Quests { get; set; } = new List<QuestProgress>();
        }
        private sealed class QuestStore
        {
            public Dictionary<string, QuestViewerState> Viewers { get; set; }
                = new Dictionary<string, QuestViewerState>(StringComparer.OrdinalIgnoreCase);
        }

        // ── Persistence ────────────────────────────────────────────────
        private void EnsureLoaded()
        {
            if (_store != null) return;
            lock (_gate) { if (_store == null) _store = LoadFromDisk(); }
        }
        private QuestStore LoadFromDisk()
        {
            try
            {
                if (string.IsNullOrEmpty(_path) || !File.Exists(_path)) return new QuestStore();
                var json = File.ReadAllText(_path);
                return JsonConvert.DeserializeObject<QuestStore>(json) ?? new QuestStore();
            }
            catch { return new QuestStore(); }
        }
        private void Save()
        {
            try { File.WriteAllText(_path, JsonConvert.SerializeObject(_store, Formatting.Indented)); }
            catch (Exception ex) { ErrorLog.Write("DailyQuests.Save", ex); }
        }

        // ── Helpers ────────────────────────────────────────────────────
        private static string MakeKey(string platform, string handle) =>
            ((platform ?? "twitch") + ":" + (handle ?? "").Trim().TrimStart('@')).ToLowerInvariant();

        private static bool IsChatEvent(EventContext ctx)
        {
            // ChatMessage / Subscriber / GiftSub / Cheer all carry a User
            // and Platform; for quest purposes "chat-active" is best
            // gated on raw chat messages only. Detect via the EventKind.
            var k = (ctx.Kind ?? "").ToLowerInvariant();
            return k.Contains("chat") || k == "twitch.chatmessage";
        }

        private static JObject AsObject(JToken t)
        {
            if (t == null) return null;
            return t.Type == JTokenType.Object ? (JObject)t : null;
        }
        private static long AsLong(JToken t)
        {
            if (t == null) return 0;
            try { return t.Type == JTokenType.Integer ? t.Value<long>() : long.Parse(t.ToString()); }
            catch { return 0; }
        }
        private static bool AsBool(JToken t)
        {
            if (t == null) return false;
            try { return t.Value<bool>(); } catch { return false; }
        }
        private static string AsString(JToken t) => t?.Type == JTokenType.Null ? null : t?.ToString();
    }
}
