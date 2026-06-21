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
    /// Mutating commands respect the counter's ModifyRoles. Any number of
    /// counters is supported.
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

            var counters = s.Counters.Counters;

            // Combos — one trigger, multiple counter mutations. Checked
            // FIRST so they take precedence over single-counter aliases
            // that might use the same word. Combos own their own role
            // gate; the per-counter ModifyRoles doesn't apply here.
            if (s.Counters.Combos != null && s.Counters.Combos.Count > 0)
            {
                for (int i = 0; i < s.Counters.Combos.Count; i++)
                {
                    var combo = s.Counters.Combos[i];
                    if (combo == null || string.IsNullOrWhiteSpace(combo.Command)) continue;
                    var trigger = combo.Command.Trim().TrimStart('!').ToLowerInvariant();
                    if (trigger.Length == 0 || trigger != cmd) continue;

                    if (!RolesAllow(combo.ModifyRoles, ctx.UserType))
                    {
                        // Silent ignore; combos shouldn't spam "only mods" replies
                        // for every random viewer who guesses the trigger.
                        return;
                    }
                    if (combo.Actions == null || combo.Actions.Count == 0) return;

                    var mutated = new System.Collections.Generic.List<Counter>();
                    foreach (var act in combo.Actions)
                    {
                        if (act == null || string.IsNullOrWhiteSpace(act.CounterName)) continue;
                        var target = counters.FirstOrDefault(c =>
                            string.Equals(c.Name, act.CounterName, StringComparison.OrdinalIgnoreCase));
                        if (target == null) continue;
                        switch ((act.Op ?? "add").ToLowerInvariant())
                        {
                            case "set":   target.Value = ClampValue(target, act.Value); break;
                            case "reset": target.Value = 0; break;
                            case "add":
                            default:      target.Value = ClampValue(target, target.Value + act.Value); break;
                        }
                        mutated.Add(target);
                        AquiloBus.Instance.Publish("counter.updated", new
                        {
                            name    = target.Name,
                            display = target.Display,
                            value   = target.Value,
                            color   = target.Color,
                            hidden  = target.Hidden,
                            by      = ctx.User
                        });
                    }
                    if (mutated.Count == 0) return;

                    // Persist all mutations as one save.
                    SettingsManager.Instance.Mutate(_ => { });
                    Util.EventStats.Instance.Hit(ctx.Kind, nameof(CountersModule));

                    // Optional chat ack — gated by the same chat-noise
                    // rules as the single-counter path so it never
                    // out-shouts a busy chat.
                    if (!string.IsNullOrWhiteSpace(combo.AckTemplate) &&
                        s.ChatNoise.CountersToChat)
                    {
                        var actionsStr = string.Join(", ",
                            mutated.Select(c => (c.Display ?? c.Name) + ": " + c.Value));
                        var ack = combo.AckTemplate
                            .Replace("{user}", ctx.User ?? "")
                            .Replace("{actions}", actionsStr);
                        var comboCd = TimeSpan.FromSeconds(Math.Max(0, s.ChatNoise.CounterAckCooldownSec));
                        if (ChatGate.TrySend(ChatGate.Area.Counters, "combo:" + trigger, comboCd))
                        {
                            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, ack, s.Platforms);
                        }
                    }
                    return;   // combo handled; skip the single-counter path
                }
            }

            // Primary command (matches Counter.Name) OR alias commands
            // (IncrementCommand / DecrementCommand / ResetCommand). The
            // alias path rewrites `rest` so the rest of the resolver can
            // stay simple.
            Counter counter = counters.FirstOrDefault(c =>
                string.Equals(c.Name, cmd, StringComparison.OrdinalIgnoreCase));
            string aliasAction = null;   // "+1" | "-1" | "reset"
            if (counter == null)
            {
                foreach (var c in counters)
                {
                    if (MatchAlias(c.IncrementCommand, cmd)) { counter = c; aliasAction = "+1"; break; }
                    if (MatchAlias(c.DecrementCommand, cmd)) { counter = c; aliasAction = "-1"; break; }
                    if (MatchAlias(c.ResetCommand,     cmd)) { counter = c; aliasAction = "reset"; break; }
                }
                if (counter == null) return;
            }
            if (aliasAction != null) rest = aliasAction;

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
                    counter.Value = ClampValue(counter, setTo);
                    reply = Render(counter);
                }
                else if ((rest.StartsWith("+") || rest.StartsWith("-")) && int.TryParse(rest, out var delta))
                {
                    counter.Value = ClampValue(counter, counter.Value + delta);
                    reply = Render(counter);
                }
                else if (int.TryParse(rest, out var bareDelta))
                {
                    // Bare integer: treat as increment (covers `!deaths 1`).
                    counter.Value = ClampValue(counter, counter.Value + bareDelta);
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
                    color   = counter.Color,
                    hidden  = counter.Hidden,
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

        private static bool MatchAlias(string configured, string typed)
        {
            if (string.IsNullOrWhiteSpace(configured)) return false;
            var c = configured.Trim().TrimStart('!').ToLowerInvariant();
            return c.Length > 0 && c == typed;
        }

        // Combo-level role gate. Matches the per-counter ModifyRoles
        // grammar (CSV of broadcaster/mod/vip/sub/viewer). Empty / "*"
        // / "everyone" means anyone can fire the combo.
        private static bool RolesAllow(string csv, string userType)
        {
            var ut = (userType ?? "viewer").ToLowerInvariant();
            if (ut == "broadcaster") return true;
            if (string.IsNullOrWhiteSpace(csv)) return true;
            var trimmed = csv.Trim();
            if (trimmed == "*" || trimmed.Equals("everyone", StringComparison.OrdinalIgnoreCase)) return true;
            foreach (var raw in trimmed.Split(','))
            {
                var r = raw.Trim().ToLowerInvariant();
                if (r.Length == 0) continue;
                if (r == ut) return true;
                if (r == "mod" && (ut == "moderator" || ut == "mod")) return true;
            }
            return false;
        }

        private static int ClampValue(Counter c, int v)
        {
            if (c.MinValue.HasValue && v < c.MinValue.Value) return c.MinValue.Value;
            if (c.MaxValue.HasValue && v > c.MaxValue.Value) return c.MaxValue.Value;
            return v;
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
