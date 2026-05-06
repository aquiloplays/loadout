using System;
using System.Linq;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// Counters - !deaths, !wins, and any custom counter the broadcaster adds
    /// in Settings → Counters. Chat command grammar:
    ///
    ///   !&lt;name&gt;             show value
    ///   !&lt;name&gt; +1          increment by 1 (or any signed int)
    ///   !&lt;name&gt; -2          decrement by 2
    ///   !&lt;name&gt; reset       set to 0
    ///   !&lt;name&gt; set 7       set to 7
    ///
    /// Mutating commands respect the counter's ModifyRoles. Free tier supports
    /// up to 3 counters; Plus/Pro lifts the cap.
    ///
    /// Every change publishes counter.updated on the Aquilo Bus so OBS overlays
    /// update live without polling.
    /// </summary>
    public sealed class CountersModule : IEventModule
    {
        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.Counters || !s.Counters.Enabled) return;

            var msg = (ctx.Message ?? "").Trim();
            if (msg.Length < 2 || msg[0] != '!') return;

            // First token is the command, rest is args.
            var spaceIdx = msg.IndexOf(' ');
            var cmd = (spaceIdx < 0 ? msg.Substring(1) : msg.Substring(1, spaceIdx - 1)).ToLowerInvariant();
            var rest = spaceIdx < 0 ? "" : msg.Substring(spaceIdx + 1).Trim();

            // Free tier cap: only the first 3 enabled counters respond to commands.
            var counters = s.Counters.Counters;
            if (!Entitlements.IsUnlocked(Feature.UnlimitedCounters))
                counters = counters.Take(3).ToList();

            var counter = counters.FirstOrDefault(c =>
                string.Equals(c.Name, cmd, StringComparison.OrdinalIgnoreCase));
            if (counter == null) return;

            string reply;
            if (string.IsNullOrEmpty(rest))
            {
                reply = Render(counter);
            }
            else if (CanModify(counter, ctx.UserType))
            {
                if (rest == "reset")
                {
                    counter.Value = 0;
                    reply = $"{counter.Display} reset to 0.";
                }
                else if (rest.StartsWith("set ", StringComparison.OrdinalIgnoreCase) &&
                         int.TryParse(rest.Substring(4), out var setTo))
                {
                    counter.Value = setTo;
                    reply = Render(counter);
                }
                else if ((rest.StartsWith("+") || rest.StartsWith("-")) && int.TryParse(rest, out var delta))
                {
                    counter.Value += delta;
                    reply = Render(counter);
                }
                else if (int.TryParse(rest, out var bareDelta))
                {
                    // Bare integer: treat as increment (covers `!deaths 1`).
                    counter.Value += bareDelta;
                    reply = Render(counter);
                }
                else
                {
                    return;     // ignore unknown sub-syntax silently
                }

                SettingsManager.Instance.Mutate(_ => { /* counter mutated above; persist */ });
                AquiloBus.Instance.Publish("counter.updated", new
                {
                    name    = counter.Name,
                    display = counter.Display,
                    value   = counter.Value,
                    by      = ctx.User
                });
                Util.EventStats.Instance.Hit(ctx.Kind, nameof(CountersModule));
            }
            else
            {
                reply = $"@{ctx.User} only mods can change {counter.Display}.";
            }

            // Throttle counter chat acks: every-N mode + cooldown. Overlay still
            // updates instantly via the bus event we already published above.
            var ackEveryN = Math.Max(0, s.ChatNoise.CounterAckEveryN);
            if (ackEveryN == 0) return;
            if (counter.Value % ackEveryN != 0 && !string.IsNullOrEmpty(rest)) return;
            var cd = TimeSpan.FromSeconds(Math.Max(0, s.ChatNoise.CounterAckCooldownSec));
            if (!ChatGate.TrySend(ChatGate.Area.Counters, "counter:" + counter.Name, cd)) return;

            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, reply, s.Platforms);
        }

        private static bool CanModify(Counter c, string userType)
        {
            var ut = (userType ?? "viewer").ToLowerInvariant();
            if (ut == "broadcaster") return true;
            return (c.ModifyRoles ?? "")
                .Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(r => r.Trim().ToLowerInvariant())
                .Any(r => r == ut || (r == "mod" && (ut == "moderator" || ut == "mod")));
        }

        private static string Render(Counter c)
        {
            var t = string.IsNullOrWhiteSpace(c.ResponseTemplate) ? "{display}: {value}" : c.ResponseTemplate;
            return t.Replace("{display}", c.Display ?? c.Name)
                    .Replace("{name}",    c.Name)
                    .Replace("{value}",   c.Value.ToString());
        }

        // Read API for other modules / overlays that don't go through chat.
        public static int GetValue(string name)
        {
            var c = SettingsManager.Instance.Current.Counters.Counters
                .FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            return c?.Value ?? 0;
        }
    }
}
