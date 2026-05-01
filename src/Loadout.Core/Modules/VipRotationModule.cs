using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Engagement;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Newtonsoft.Json;

namespace Loadout.Modules
{
    /// <summary>
    /// Auto-rotates Twitch VIPs on a configurable cadence (default 7 days):
    /// promotes the most engaged non-VIPs from <see cref="EngagementTracker"/>,
    /// demotes the least active current VIPs, posts the swap to Discord and
    /// chat. Mods can override at any time via <c>!viprotate</c>.
    ///
    /// VIP add/remove uses CPH's <c>AddVip</c> / <c>RemoveVip</c> when the SB
    /// version exposes them, falling back to the legacy chat slash commands
    /// (<c>/vip name</c>) which still work via IRC.
    ///
    /// Tier 3 only — this is a Pro feature.
    /// </summary>
    public sealed class VipRotationModule : IEventModule
    {
        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        private DateTime _lastTickUtc = DateTime.MinValue;

        public void OnEvent(EventContext ctx)
        {
            // Mod / broadcaster can force a rotation with !viprotate
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.VipRotation) return;
            var msg = (ctx.Message ?? "").Trim().ToLowerInvariant();
            if (msg != "!viprotate") return;
            var role = (ctx.UserType ?? "").ToLowerInvariant();
            if (role != "broadcaster" && role != "mod" && role != "moderator") return;
            _ = Task.Run(() => RunRotationAsync(s, manual: true, requestedBy: ctx.User));
        }

        public void OnTick()
        {
            // Rotate at most once per Tick batch and only if the configured interval has elapsed.
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.VipRotation) return;
            if (!Entitlements.IsUnlocked(Feature.VipRotationAuto)) return;

            var now = DateTime.UtcNow;
            // Don't run more than once per minute regardless of config (the tick is 60s anyway).
            if ((now - _lastTickUtc).TotalSeconds < 30) return;
            _lastTickUtc = now;

            var due = s.VipRotation.LastRunUtc == DateTime.MinValue
                || (now - s.VipRotation.LastRunUtc).TotalDays >= Math.Max(1, s.VipRotation.IntervalDays);
            if (!due) return;

            // Only rotate while live (avoid surprising people offline).
            var liveSince = SbBridge.Instance.GetGlobal<string>("twitch.streamStart", null);
            if (string.IsNullOrEmpty(liveSince)) return;

            _ = Task.Run(() => RunRotationAsync(s, manual: false));
        }

        // ── Core rotation ─────────────────────────────────────────────────────

        private async Task RunRotationAsync(LoadoutSettings s, bool manual, string requestedBy = null)
        {
            try
            {
                var rotateCount = Math.Max(1, s.VipRotation.RotationsPerCycle);
                var exempt = new HashSet<string>((s.VipRotation.ExemptHandles ?? new List<string>())
                    .Select(x => x.Trim().ToLowerInvariant()), StringComparer.OrdinalIgnoreCase);

                var currentVips = await GetCurrentVipsAsync().ConfigureAwait(false);
                if (currentVips == null)
                {
                    SbBridge.Instance.LogWarn("[Loadout] VIP rotation skipped — couldn't read current VIP list from SB.");
                    return;
                }

                // Score every viewer; split into VIP / non-VIP; pick promote/demote candidates.
                var allViewers = EngagementTracker.Instance.All()
                    .Where(v => string.Equals(v.Platform, "twitch", StringComparison.OrdinalIgnoreCase))
                    .Where(v => !exempt.Contains(v.Handle))
                    .ToList();

                var nonVipsByScore = allViewers
                    .Where(v => !currentVips.Contains(v.Handle, StringComparer.OrdinalIgnoreCase))
                    .Where(v => v.MsgCount >= s.VipRotation.MinMessages)
                    .OrderByDescending(EngagementTracker.Score)
                    .Take(rotateCount)
                    .ToList();

                var vipsByScore = currentVips
                    .Where(h => !exempt.Contains(h))
                    .Select(h => EngagementTracker.Instance.Get("twitch", h) ?? new ViewerActivity { Platform = "twitch", Handle = h, MsgCount = 0 })
                    .OrderBy(EngagementTracker.Score)
                    .Take(rotateCount)
                    .ToList();

                // Don't demote when there's nobody to promote — would leave slots open for nothing.
                var swaps = Math.Min(nonVipsByScore.Count, vipsByScore.Count);
                var promoted = new List<string>();
                var demoted  = new List<string>();
                for (int i = 0; i < swaps; i++)
                {
                    var add = nonVipsByScore[i].Handle;
                    var rem = vipsByScore[i].Handle;
                    if (await SetVipAsync(rem, vip: false).ConfigureAwait(false)) demoted.Add(rem);
                    if (await SetVipAsync(add, vip: true).ConfigureAwait(false))  promoted.Add(add);
                }

                SettingsManager.Instance.Mutate(x => x.VipRotation.LastRunUtc = DateTime.UtcNow);

                if (promoted.Count == 0 && demoted.Count == 0)
                {
                    if (manual) SbBridge.Instance.SendTwitch("@" + (requestedBy ?? "mod") + " no rotation needed right now.");
                    return;
                }

                AnnounceRotation(s, promoted, demoted, manual);
                AquiloBus.Instance.Publish("vip.rotation.completed", new
                {
                    promoted, demoted, manual,
                    by = requestedBy
                });
            }
            catch (Exception ex)
            {
                SbBridge.Instance.LogError("[Loadout] VIP rotation threw: " + ex.Message);
            }
        }

        private void AnnounceRotation(LoadoutSettings s, List<string> promoted, List<string> demoted, bool manual)
        {
            var prefix = manual ? "🔄 Manual VIP rotation:" : "🔄 Weekly VIP rotation:";
            var msg = prefix
                + (promoted.Count > 0 ? "  promoted " + string.Join(", ", promoted) : "")
                + (demoted.Count  > 0 ? "  demoted "  + string.Join(", ", demoted)  : "")
                + ". Thanks for hanging out 💜";
            SbBridge.Instance.SendTwitch(msg);

            var hook = string.IsNullOrEmpty(s.VipRotation.DiscordWebhook)
                ? s.Discord.RecapWebhook                      // fall back to recap channel
                : s.VipRotation.DiscordWebhook;
            if (string.IsNullOrEmpty(hook)) return;

            try
            {
                var content = "**VIP rotation** " + (manual ? "(manual)" : "(weekly)") + "\n"
                    + (promoted.Count > 0 ? "**Promoted:** " + string.Join(", ", promoted) + "\n" : "")
                    + (demoted.Count  > 0 ? "**Demoted:** "  + string.Join(", ", demoted)  + "\n" : "")
                    + "Engagement scores from the past " + s.VipRotation.IntervalDays + " days.";
                var json = JsonConvert.SerializeObject(new { content, allowed_mentions = new { parse = new string[] { } } });
                _ = _http.PostAsync(hook, new StringContent(json, Encoding.UTF8, "application/json"));
            }
            catch (Exception ex)
            {
                SbBridge.Instance.LogWarn("[Loadout] VIP rotation Discord post failed: " + ex.Message);
            }
        }

        // ── CPH bridge for VIP add/remove + list ──────────────────────────────

        /// <summary>
        /// Try CPH.GetTwitchVips() / GetVipUsers() reflectively. Returns null if
        /// SB doesn't expose any version of the method, in which case we skip
        /// the rotation rather than guess.
        /// </summary>
        private async Task<List<string>> GetCurrentVipsAsync()
        {
            await Task.CompletedTask;
            // Prefer dedicated "list VIPs" methods if present.
            var names = TryInvokeStringList("GetTwitchVipUsers")
                     ?? TryInvokeStringList("GetTwitchVips")
                     ?? TryInvokeStringList("GetVips");
            return names;
        }

        private static List<string> TryInvokeStringList(string method)
        {
            var bridge = SbBridge.Instance;
            if (!bridge.IsBound) return null;
            try
            {
                var cphField = typeof(SbBridge).GetField("_cph", BindingFlags.NonPublic | BindingFlags.Instance);
                var cph = cphField?.GetValue(bridge);
                if (cph == null) return null;
                var mi = cph.GetType().GetMethod(method, BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null);
                if (mi == null) return null;
                var result = mi.Invoke(cph, null);
                if (result is IEnumerable<string> seq) return seq.Select(s => (s ?? "").ToLowerInvariant()).ToList();
                return null;
            }
            catch { return null; }
        }

        private async Task<bool> SetVipAsync(string handle, bool vip)
        {
            await Task.CompletedTask;
            if (string.IsNullOrEmpty(handle)) return false;
            // Prefer the typed method if present, otherwise issue the slash command.
            var methodName = vip ? "AddVip" : "RemoveVip";
            try
            {
                var cphField = typeof(SbBridge).GetField("_cph", BindingFlags.NonPublic | BindingFlags.Instance);
                var cph = cphField?.GetValue(SbBridge.Instance);
                if (cph != null)
                {
                    var mi = cph.GetType().GetMethod(methodName, new[] { typeof(string) });
                    if (mi != null)
                    {
                        mi.Invoke(cph, new object[] { handle });
                        return true;
                    }
                }
            }
            catch { /* fall through */ }

            // Fallback: send the slash command via chat. Twitch's chat slash commands
            // are deprecated for direct IRC use, but CPH's SendMessage still routes
            // them through Helix where available.
            SbBridge.Instance.SendTwitch((vip ? "/vip " : "/unvip ") + handle);
            return true;
        }
    }
}
