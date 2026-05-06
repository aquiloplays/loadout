using System;
using System.Linq;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// Channel-point reward → action mapping. Listens for Twitch reward
    /// redemption events (kind="rewardRedemption") and looks up the
    /// configured action by reward name (case-insensitive). Action format
    /// is documented on <see cref="ChannelPointsConfig"/>.
    ///
    /// Design notes:
    ///   - We deliberately do NOT pull the reward list from Twitch's API
    ///     here. The streamer types the reward name once into the mapping
    ///     table (it shows up in chat / SB events anyway). Pulling it
    ///     would require Helix auth, which Loadout doesn't have - SB does
    ///     the auth and surfaces the redemption event. Match by name and
    ///     we keep the integration trivial.
    ///   - Failed actions log via ErrorLog rather than spamming chat -
    ///     redeems should never block on a misconfigured action.
    /// </summary>
    public sealed class ChannelPointsModule : IEventModule
    {
        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "rewardRedemption" && ctx.Kind != "channelPointsRedemption") return;
            var s = SettingsManager.Instance.Current;
            if (!s.ChannelPoints.Enabled) return;

            var rewardName = ctx.Get<string>("rewardName",
                              ctx.Get<string>("rewardTitle",
                              ctx.Get<string>("title", "")));
            if (string.IsNullOrEmpty(rewardName)) return;

            var mapping = s.ChannelPoints.Mappings?.FirstOrDefault(m =>
                m != null && m.Enabled && !string.IsNullOrEmpty(m.RewardName) &&
                string.Equals(m.RewardName.Trim(), rewardName.Trim(), StringComparison.OrdinalIgnoreCase));
            if (mapping == null) return;
            if (string.IsNullOrEmpty(mapping.Action)) return;

            try { Execute(mapping.Action.Trim(), ctx, s); }
            catch (Exception ex) { ErrorLog.Write("ChannelPointsModule.Execute[" + rewardName + "]", ex); }

            Util.EventStats.Instance.Hit(ctx.Kind, nameof(ChannelPointsModule));
            AquiloBus.Instance.Publish("channelpoints.redeemed", new
            {
                reward = rewardName,
                user   = ctx.User,
                action = mapping.Action,
                ts     = DateTime.UtcNow
            });
        }

        /// <summary>
        /// Action grammar (kept tiny on purpose):
        ///   chat:&lt;message&gt;        post the message back to chat
        ///   bolts:+N                    award N bolts to the redeemer
        ///   counter:&lt;name&gt;:+N    bump named counter by N (negatives ok)
        ///   sb-action:&lt;guid&gt;     run SB action by ID
        ///   alert:&lt;template&gt;     fire a one-off alert post (gated)
        /// Substitutions: {user} {reward}.
        /// </summary>
        private static void Execute(string action, EventContext ctx, LoadoutSettings s)
        {
            var colonIdx = action.IndexOf(':');
            if (colonIdx < 1) return;
            var verb = action.Substring(0, colonIdx).ToLowerInvariant();
            var rest = action.Substring(colonIdx + 1);

            string Sub(string raw) => raw
                .Replace("{user}",   ctx.User ?? "")
                .Replace("{reward}", ctx.Get<string>("rewardName", ctx.Get<string>("rewardTitle", "")));

            switch (verb)
            {
                case "chat":
                {
                    if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "cp:chat:" + ctx.Kind, TimeSpan.FromSeconds(2))) return;
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, Sub(rest), s.Platforms);
                    return;
                }
                case "bolts":
                {
                    var amountStr = rest.TrimStart('+');
                    if (!int.TryParse(amountStr, out var amount) || amount == 0) return;
                    if (string.IsNullOrEmpty(ctx.User)) return;
                    BoltsWallet.Instance.Initialize();
                    BoltsWallet.Instance.Earn(ctx.Platform.ToShortName(), ctx.User, amount, "channelpoint");
                    return;
                }
                case "counter":
                {
                    // counter:<name>:+N
                    var inner = rest.IndexOf(':');
                    if (inner < 1) return;
                    var name = rest.Substring(0, inner).Trim();
                    var delta = rest.Substring(inner + 1).TrimStart('+');
                    if (!int.TryParse(delta, out var d)) return;
                    var counter = s.Counters.Counters?.FirstOrDefault(c =>
                        string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase));
                    if (counter == null) return;
                    counter.Value += d;
                    AquiloBus.Instance.Publish("counter.updated", new
                    {
                        name    = counter.Name,
                        display = counter.Display,
                        value   = counter.Value,
                        by      = "channelpoint"
                    });
                    SettingsManager.Instance.SaveNow();
                    return;
                }
                case "sb-action":
                case "sbaction":
                {
                    var id = rest.Trim();
                    if (string.IsNullOrEmpty(id)) return;
                    SbBridge.Instance.RunAction(id);
                    return;
                }
                case "alert":
                {
                    if (!ChatGate.TrySend(ChatGate.Area.Alerts, "cp:alert", TimeSpan.FromSeconds(3))) return;
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, Sub(rest), s.Platforms);
                    return;
                }
            }
        }
    }
}
