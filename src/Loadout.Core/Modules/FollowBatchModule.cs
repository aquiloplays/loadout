using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// Coalesces follow events during a burst (e.g. a raid) into one chat
    /// line and one bus event, instead of letting AlertsModule post 50
    /// individual lines. Off by default; opt-in via Settings → Welcomes.
    ///
    /// How it interacts with AlertsModule: this runs AHEAD of AlertsModule
    /// in the dispatcher (registration order matters in
    /// SbEventDispatcher.RegisterDefaultModules - see comment there). When
    /// batching is active for an in-flight burst, we still let the
    /// individual follow event flow through, but we mark it so AlertsModule
    /// suppresses its per-event chat post. The bus event still fires (so
    /// overlays animate every follow); only the chat line is coalesced.
    ///
    /// Suppression is signaled via EventContext.Raw["loadout.suppress.alert"]=true.
    /// AlertsModule checks for this before posting follow alerts.
    /// </summary>
    public sealed class FollowBatchModule : IEventModule
    {
        private readonly object _gate = new object();
        private DateTime _windowStartUtc = DateTime.MinValue;
        private readonly List<string> _names = new List<string>();
        private PlatformMask _platform = PlatformMask.None;

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "follow") return;
            var s = SettingsManager.Instance.Current;
            if (!s.FollowBatch.Enabled) return;

            // First follow in a window starts the timer. Subsequent follows
            // join the same batch until WindowSeconds elapses; the next
            // follow after that opens a fresh batch.
            lock (_gate)
            {
                var now = DateTime.UtcNow;
                if (_windowStartUtc == DateTime.MinValue)
                {
                    _windowStartUtc = now;
                    _platform = ctx.Platform;
                    _names.Clear();
                }

                if (!string.IsNullOrEmpty(ctx.User) &&
                    !_names.Contains(ctx.User, StringComparer.OrdinalIgnoreCase))
                    _names.Add(ctx.User);

                // Suppress AlertsModule's per-event chat post for THIS event;
                // we'll post once per batch when OnTick fires the flush. The
                // bus event still goes out (AlertsModule does that before
                // chat), so overlays animate every follow.
                if (ctx.Raw != null) ctx.Raw["loadout.suppress.alert"] = true;
            }
        }

        public void OnTick()
        {
            // Tick fires once a minute. If a batch's window has elapsed,
            // flush. Streamer.bot's tick is "ample" for this; for tighter
            // bursts a streamer can shorten the WindowSeconds.
            var s = SettingsManager.Instance.Current;
            if (!s.FollowBatch.Enabled) return;

            List<string> snapshotNames;
            PlatformMask snapPlat;
            DateTime snapStart;
            lock (_gate)
            {
                if (_windowStartUtc == DateTime.MinValue) return;
                if ((DateTime.UtcNow - _windowStartUtc).TotalSeconds < s.FollowBatch.WindowSeconds) return;
                if (_names.Count == 0) { _windowStartUtc = DateTime.MinValue; return; }
                snapshotNames = new List<string>(_names);
                snapPlat = _platform;
                snapStart = _windowStartUtc;
                _names.Clear();
                _windowStartUtc = DateTime.MinValue;
            }

            // Below the threshold, the regular AlertsModule already
            // handled them per-event - so we just drop the batch.
            if (snapshotNames.Count < s.FollowBatch.MinToTrigger) return;

            var maxShown = Math.Max(1, s.FollowBatch.MaxNamesShown);
            var shown = snapshotNames.Take(maxShown).ToList();
            var hidden = snapshotNames.Count - shown.Count;
            var users = string.Join(", ", shown);
            if (hidden > 0) users += " +" + hidden + " more";
            var line = (s.FollowBatch.Template ?? "{count} follows: {users}")
                .Replace("{count}", snapshotNames.Count.ToString())
                .Replace("{users}", users);

            if (!ChatGate.TrySend(ChatGate.Area.Alerts, "follow:batch", TimeSpan.FromSeconds(2))) return;
            new MultiPlatformSender(CphPlatformSender.Instance).Send(snapPlat, line, s.Platforms);

            AquiloBus.Instance.Publish("follows.batched", new
            {
                count    = snapshotNames.Count,
                names    = snapshotNames,
                platform = snapPlat.ToShortName(),
                windowStart = snapStart,
                ts       = DateTime.UtcNow
            });
        }
    }
}
