using System;
using System.Collections.Generic;
using System.IO;
using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Newtonsoft.Json;

namespace Loadout.Modules
{
    /// <summary>
    /// Bonus module: detects sub-anniversary milestones (3, 6, 12, 18, 24, 36
    /// months) and posts a celebration the next time the sub chats. Stores
    /// each viewer's sub-start date the first time we see it on a sub event,
    /// then checks (today vs start) on every chat message — fires once per
    /// milestone per viewer.
    ///
    /// Free tier; tiny module. Nothing to upsell here, it's just nice.
    /// </summary>
    public sealed class SubAnniversaryModule : IEventModule
    {
        private static readonly int[] Milestones = { 3, 6, 12, 18, 24, 36, 48, 60, 72, 84, 96, 108, 120 };
        private readonly object _gate = new object();
        private string _statePath;
        private Dictionary<string, SubRecord> _records;

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            EnsureLoaded();
            switch (ctx.Kind)
            {
                case "sub":
                case "resub":
                    RecordSub(ctx);
                    return;
                case "chat":
                    if (ctx.UserType == "subscriber" || ctx.UserType == "sub" ||
                        ctx.UserType == "vip"        || ctx.UserType == "moderator") CheckChat(ctx);
                    return;
            }
        }

        private void RecordSub(EventContext ctx)
        {
            if (string.IsNullOrEmpty(ctx.User)) return;
            var key = ctx.Platform.ToShortName() + ":" + ctx.User.ToLowerInvariant();

            // SB's resub event usually carries the cumulative month count. If we have
            // it, we can back-date the original start so milestones fire at the right
            // time even for users we've never seen subscribe natively.
            var months = ctx.Get<int>("cumulativeMonths", ctx.Get<int>("months", 1));

            lock (_gate)
            {
                if (!_records.TryGetValue(key, out var rec))
                {
                    rec = new SubRecord
                    {
                        Platform = ctx.Platform.ToShortName(),
                        Handle   = ctx.User,
                        StartedUtc = DateTime.UtcNow.AddDays(-30 * Math.Max(0, months - 1)),
                        LastMilestoneFired = 0
                    };
                    _records[key] = rec;
                }
                else if (rec.StartedUtc == default)
                {
                    rec.StartedUtc = DateTime.UtcNow.AddDays(-30 * Math.Max(0, months - 1));
                }
                Save();
            }
        }

        private void CheckChat(EventContext ctx)
        {
            if (string.IsNullOrEmpty(ctx.User)) return;
            var key = ctx.Platform.ToShortName() + ":" + ctx.User.ToLowerInvariant();
            SubRecord rec;
            lock (_gate) { _records.TryGetValue(key, out rec); }
            if (rec == null || rec.StartedUtc == default) return;

            var monthsApprox = (int)Math.Floor((DateTime.UtcNow - rec.StartedUtc).TotalDays / 30);
            int? milestoneToFire = null;
            foreach (var m in Milestones)
            {
                if (monthsApprox >= m && rec.LastMilestoneFired < m) { milestoneToFire = m; break; }
            }
            if (!milestoneToFire.HasValue) return;

            lock (_gate) { rec.LastMilestoneFired = milestoneToFire.Value; Save(); }

            var msg = "🎉 " + ctx.User + " is celebrating " + milestoneToFire.Value + " months as a sub! Thanks for sticking around 💜";
            new MultiPlatformSender(CphPlatformSender.Instance)
                .Send(ctx.Platform, msg, SettingsManager.Instance.Current.Platforms);

            AquiloBus.Instance.Publish("sub.anniversary", new
            {
                user = ctx.User,
                platform = ctx.Platform.ToShortName(),
                months = milestoneToFire.Value
            });

            // Re-dispatch so BoltsModule can credit the milestone bonus.
            var enriched = new System.Collections.Generic.Dictionary<string, object>(ctx.Raw ?? new System.Collections.Generic.Dictionary<string, object>())
            {
                ["months"] = milestoneToFire.Value
            };
            try { Sb.SbEventDispatcher.Instance.DispatchEvent("subAnniversary", enriched); } catch { }
        }

        // ── Persistence ───────────────────────────────────────────────────────

        private void EnsureLoaded()
        {
            if (_records != null) return;
            lock (_gate)
            {
                if (_records != null) return;
                _statePath = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "sub-anniversary.json");
                if (File.Exists(_statePath))
                {
                    try
                    {
                        var list = JsonConvert.DeserializeObject<List<SubRecord>>(File.ReadAllText(_statePath))
                                    ?? new List<SubRecord>();
                        _records = new Dictionary<string, SubRecord>(StringComparer.OrdinalIgnoreCase);
                        foreach (var r in list)
                            _records[r.Platform + ":" + (r.Handle ?? "").ToLowerInvariant()] = r;
                    }
                    catch { _records = new Dictionary<string, SubRecord>(StringComparer.OrdinalIgnoreCase); }
                }
                else _records = new Dictionary<string, SubRecord>(StringComparer.OrdinalIgnoreCase);
            }
        }

        private void Save()
        {
            try
            {
                var list = new List<SubRecord>(_records.Values);
                File.WriteAllText(_statePath, JsonConvert.SerializeObject(list, Formatting.Indented));
            }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("[Loadout] SubAnniversary save: " + ex.Message); }
        }

        private class SubRecord
        {
            public string   Platform           { get; set; }
            public string   Handle             { get; set; }
            public DateTime StartedUtc         { get; set; }
            public int      LastMilestoneFired { get; set; }
        }
    }
}
