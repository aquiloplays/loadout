using System;
using System.Collections.Generic;
using Loadout.Bus;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Tracks a sliding 5-minute chat velocity (messages / minute) and writes
    /// it to a global var the rest of SB can read in templates - that's how
    /// "smart cooldowns" work without us having to wrap every command:
    ///
    ///     %loadout.chatVelocity%   - msgs/min, integer
    ///     %loadout.chatTier%       - "dead" | "calm" | "active" | "raid"
    ///
    /// Patterns chat goes through:
    ///   dead   &lt; 2 msgs/min      cooldowns can be relaxed (or skipped)
    ///   calm   2-15                normal
    ///   active 15-50               consider raising cooldowns
    ///   raid   50+                 enable strict cooldowns / followers-only
    ///
    /// Also publishes <c>chat.velocity</c> on the bus every minute.
    /// </summary>
    public sealed class ChatVelocityModule : IEventModule
    {
        private readonly LinkedList<DateTime> _msgTimes = new LinkedList<DateTime>();
        private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;
            if (!SettingsManager.Instance.Current.Modules.ChatVelocity) return;
            lock (_msgTimes)
            {
                _msgTimes.AddLast(DateTime.UtcNow);
                Trim();
            }
        }

        public void OnTick()
        {
            if (!SettingsManager.Instance.Current.Modules.ChatVelocity) return;
            int count;
            lock (_msgTimes) { Trim(); count = _msgTimes.Count; }
            // msgs / min averaged across the window
            var perMinute = (int)Math.Round(count / Window.TotalMinutes);
            var tier = perMinute < 2 ? "dead" : perMinute < 15 ? "calm" : perMinute < 50 ? "active" : "raid";

            SbBridge.Instance.SetGlobal("loadout.chatVelocity", perMinute);
            SbBridge.Instance.SetGlobal("loadout.chatTier", tier);

            AquiloBus.Instance.Publish("chat.velocity", new
            {
                perMinute,
                tier,
                windowMinutes = (int)Window.TotalMinutes
            });
        }

        private void Trim()
        {
            var cutoff = DateTime.UtcNow - Window;
            while (_msgTimes.First != null && _msgTimes.First.Value < cutoff)
                _msgTimes.RemoveFirst();
        }
    }
}
