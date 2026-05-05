using System;
using System.Collections.Generic;
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
    /// Bolts shop. Two chat commands:
    ///   !shop          - lists every enabled item, costs, remaining stock
    ///   !buy &lt;name&gt;    - attempts to purchase the named item; if the
    ///                    viewer has the bolts and the stock allows it,
    ///                    debits the wallet and runs the item's action.
    ///
    /// The item Action grammar is intentionally identical to the channel-
    /// point mapping action grammar, so a streamer who already learned that
    /// shape can author shop items in the same vocabulary:
    ///   chat:&lt;message&gt;       chat post (placeholders: {user} {item})
    ///   alert:&lt;template&gt;     gated chat post that the chat-velocity gate
    ///                          treats as an alert
    ///   sb-action:&lt;guid&gt;     run an SB action by ID
    ///   counter:&lt;name&gt;:+N    bump a counter
    /// </summary>
    public sealed class BoltsShopModule : IEventModule
    {
        // Per-user redemption counts (in-memory, resets per SB session).
        // For a per-stream cap that survives restart we'd persist this; for
        // v1 the streamer re-running SB during a stream is a corner case.
        private readonly Dictionary<string, Dictionary<string, int>> _userBuyCount =
            new Dictionary<string, Dictionary<string, int>>(StringComparer.OrdinalIgnoreCase);

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.Bolts || !s.BoltsShop.Enabled) return;

            var msg = (ctx.Message ?? "").Trim();
            if (msg.Length < 2 || msg[0] != '!') return;

            var lower = msg.ToLowerInvariant();
            var shopCmd = (s.BoltsShop.ShopCommand ?? "!shop").ToLowerInvariant();
            var buyCmd  = (s.BoltsShop.BuyCommand  ?? "!buy").ToLowerInvariant();

            if (lower == shopCmd) { ListShop(ctx, s); return; }
            if (lower.StartsWith(buyCmd + " ")) { TryBuy(ctx, s, msg.Substring(buyCmd.Length + 1).Trim()); return; }
        }

        // -------------------- !shop --------------------

        private static void ListShop(EventContext ctx, LoadoutSettings s)
        {
            var items = (s.BoltsShop.Items ?? new List<BoltsShopItem>())
                .Where(i => i != null && i.Enabled && !string.IsNullOrEmpty(i.Name))
                .ToList();
            if (items.Count == 0)
            {
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "shop:empty", TimeSpan.FromSeconds(60))) return;
                new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                    "The shop is empty - the streamer hasn't added items yet.", s.Platforms);
                return;
            }
            if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "shop:list", TimeSpan.FromSeconds(15))) return;

            // Render compact: "name:cost (k left)" comma-joined; truncate at
            // ~480 chars to stay under most platforms' chat caps.
            var bits = new List<string>();
            foreach (var it in items)
            {
                var stockBit = it.StockTotal > 0 ? " (" + Math.Max(0, it.StockTotal - it.StockSold) + " left)" : "";
                bits.Add(it.Name + ":" + it.Cost + stockBit);
            }
            var line = "🛒 Shop: " + string.Join(" · ", bits);
            if (line.Length > 480) line = line.Substring(0, 477) + "...";
            line += "    Buy with " + (s.BoltsShop.BuyCommand ?? "!buy") + " <name>";
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, line, s.Platforms);
        }

        // -------------------- !buy <name> --------------------

        private void TryBuy(EventContext ctx, LoadoutSettings s, string itemName)
        {
            if (string.IsNullOrEmpty(itemName))
            {
                Reply(ctx, s, "Usage: " + (s.BoltsShop.BuyCommand ?? "!buy") + " <name>", gateKey: "shop:usage");
                return;
            }

            var item = (s.BoltsShop.Items ?? new List<BoltsShopItem>())
                .FirstOrDefault(i => i != null && i.Enabled && string.Equals(i.Name, itemName, StringComparison.OrdinalIgnoreCase));
            if (item == null)
            {
                Reply(ctx, s, "Couldn't find an item called \"" + itemName + "\". Try " + (s.BoltsShop.ShopCommand ?? "!shop") + ".",
                      gateKey: "shop:notfound:" + itemName);
                return;
            }

            // Stock + per-user cap.
            if (item.StockTotal >= 0 && item.StockSold >= item.StockTotal)
            {
                Reply(ctx, s, "Sold out: " + item.Name + ".", gateKey: "shop:soldout:" + item.Name);
                return;
            }
            if (item.PerUserCap > 0)
            {
                int already = GetBuyCount(ctx.Platform.ToShortName() + ":" + (ctx.User ?? ""), item.Name);
                if (already >= item.PerUserCap)
                {
                    Reply(ctx, s, "@" + ctx.User + " you've already bought your max of " + item.Name + " this session.",
                          gateKey: "shop:cap:" + ctx.User + ":" + item.Name);
                    return;
                }
            }

            // Debit. If the wallet doesn't have enough, refuse cleanly.
            BoltsWallet.Instance.Initialize();
            var ok = BoltsWallet.Instance.Spend(ctx.Platform.ToShortName(), ctx.User, item.Cost, "shop:" + item.Name);
            if (!ok)
            {
                var bal = BoltsWallet.Instance.Balance(ctx.Platform.ToShortName(), ctx.User);
                Reply(ctx, s, "@" + ctx.User + " not enough bolts (" + bal + " / " + item.Cost + ").",
                      gateKey: "shop:nsf:" + ctx.User + ":" + item.Name);
                return;
            }

            // Persist the stock + per-user count. We mutate the in-memory
            // settings object directly + schedule a save through Mutate.
            SettingsManager.Instance.Mutate(cfg =>
            {
                var live = cfg.BoltsShop.Items.FirstOrDefault(i =>
                    string.Equals(i.Name, item.Name, StringComparison.OrdinalIgnoreCase));
                if (live != null) live.StockSold = (live.StockSold) + 1;
            });
            BumpBuyCount(ctx.Platform.ToShortName() + ":" + (ctx.User ?? ""), item.Name);

            // Bus event so overlays / Discord sync see the redemption.
            AquiloBus.Instance.Publish("bolts.shop.purchased", new
            {
                user     = ctx.User,
                platform = ctx.Platform.ToShortName(),
                item     = item.Name,
                cost     = item.Cost,
                ts       = DateTime.UtcNow
            });

            // Run the item's action if it has one. Identical grammar to the
            // channel-point module so the codepath is shared in spirit.
            try { RunAction(item.Action, ctx, s, item.Name); }
            catch (Exception ex) { ErrorLog.Write("BoltsShopModule.RunAction[" + item.Name + "]", ex); }
        }

        // -------------------- Helpers --------------------

        private static void RunAction(string action, EventContext ctx, LoadoutSettings s, string itemName)
        {
            if (string.IsNullOrEmpty(action))
            {
                // No action configured - just confirm the purchase.
                Reply(ctx, s, "@" + ctx.User + " bought " + itemName + " 🎁", gateKey: "shop:confirm:" + ctx.User + ":" + itemName);
                return;
            }
            var colonIdx = action.IndexOf(':');
            if (colonIdx < 1) return;
            var verb = action.Substring(0, colonIdx).ToLowerInvariant();
            var rest = action.Substring(colonIdx + 1);
            string Sub(string raw) => (raw ?? "")
                .Replace("{user}", ctx.User ?? "")
                .Replace("{item}", itemName);
            switch (verb)
            {
                case "chat":
                    Reply(ctx, s, Sub(rest), gateKey: "shop:chat:" + itemName);
                    return;
                case "alert":
                    if (!ChatGate.TrySend(ChatGate.Area.Alerts, "shop:alert:" + itemName, TimeSpan.FromSeconds(3))) return;
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, Sub(rest), s.Platforms);
                    return;
                case "sb-action":
                case "sbaction":
                    SbBridge.Instance.RunAction(rest.Trim());
                    return;
                case "counter":
                {
                    var inner = rest.IndexOf(':');
                    if (inner < 1) return;
                    var name  = rest.Substring(0, inner).Trim();
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
                        by      = "shop:" + itemName
                    });
                    SettingsManager.Instance.SaveNow();
                    return;
                }
            }
        }

        private static void Reply(EventContext ctx, LoadoutSettings s, string text, string gateKey)
        {
            if (string.IsNullOrEmpty(text)) return;
            if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, gateKey, TimeSpan.FromSeconds(5))) return;
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, text, s.Platforms);
        }

        private int GetBuyCount(string userKey, string itemName)
        {
            lock (_userBuyCount)
            {
                if (_userBuyCount.TryGetValue(userKey, out var inner) &&
                    inner.TryGetValue(itemName, out var n))
                    return n;
                return 0;
            }
        }
        private void BumpBuyCount(string userKey, string itemName)
        {
            lock (_userBuyCount)
            {
                if (!_userBuyCount.TryGetValue(userKey, out var inner))
                {
                    inner = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    _userBuyCount[userKey] = inner;
                }
                inner.TryGetValue(itemName, out var n);
                inner[itemName] = n + 1;
            }
        }
    }
}
