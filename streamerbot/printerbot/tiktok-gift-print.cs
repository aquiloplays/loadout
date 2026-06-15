// PrinterBot - TikTok Gift Print router
// Triggered on every TikTok gift (TikFinity/SB native). Filters to a
// known allow-list of gift names before delegating to the shared
// "PrinterBot - Print Receipt" sub-action. Heart Me is the latest
// addition; TikTok itself enforces 1 Heart Me / viewer / stream so no
// per-user cooldown is needed here.
//
// IMPORTANT: only fires for actual GIFT events. Free heart taps (the
// "like" event) reach SB as a different trigger (TikTok Like /
// TikFinity 'like'); this action's triggers are gift-only, AND we
// double-check the event name in code so a mis-wired trigger can't
// promote likes into prints.
using System;
using System.Collections.Generic;

public class CPHInline
{
    // Allow-list of TikTok gift names that print. Keep this list in
    // sync with aquilo-gg/overlays/_shared/tiktok-gifts.js and the
    // gift-jar overlay. Names are matched case/space/punct insensitive.
    private static readonly HashSet<string> AllowedGifts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "heart me",
        "rose",
        "tiktok",
        "gg",
        "ice cream cone",
        "finger heart",
        "perfume",
        "doughnut",
        "paper crane",
        "rosa",
        "cap",
        "team bracelet",
        "friendship necklace",
        "birthday cake",
        "love bang",
        "galaxy",
        "rocket",
        "drama queen",
        "lion",
        "universe",
    };

    private static string Norm(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var lower = s.ToLowerInvariant().Trim();
        var sb = new System.Text.StringBuilder(lower.Length);
        bool lastSpace = false;
        foreach (var c in lower)
        {
            if (c == '_' || c == '-' || c == '.' || char.IsWhiteSpace(c))
            {
                if (!lastSpace) { sb.Append(' '); lastSpace = true; }
            }
            else { sb.Append(c); lastSpace = false; }
        }
        return sb.ToString().Trim();
    }

    public bool Execute()
    {
        // Hard gate: must be a gift event, never a like. TikFinity uses
        // event = "gift"; native SB TikTok integration uses arg
        // "eventType" = "gift" or "like". Reject anything else.
        string evt = "";
        if (args.ContainsKey("event")) evt = (args["event"] ?? "").ToString();
        if (string.IsNullOrEmpty(evt) && args.ContainsKey("eventType")) evt = (args["eventType"] ?? "").ToString();
        if (!string.IsNullOrEmpty(evt) && !evt.Equals("gift", StringComparison.OrdinalIgnoreCase))
        {
            // Anything that isn't an explicit gift event (likes, follows,
            // joins, shares) is a no-op for the printer.
            return true;
        }

        string giftName = "";
        if (args.ContainsKey("giftName"))     giftName = (args["giftName"]     ?? "").ToString();
        if (string.IsNullOrEmpty(giftName) && args.ContainsKey("gift"))     giftName = (args["gift"]     ?? "").ToString();
        if (string.IsNullOrEmpty(giftName) && args.ContainsKey("giftLabel")) giftName = (args["giftLabel"] ?? "").ToString();

        var norm = Norm(giftName);
        if (string.IsNullOrEmpty(norm))
        {
            CPH.LogDebug("[PrinterBot] TikTok gift event with no name, skipping.");
            return true;
        }

        if (!AllowedGifts.Contains(norm))
        {
            CPH.LogDebug("[PrinterBot] TikTok gift '" + giftName + "' not in print allow-list.");
            return true;
        }

        // Route into the shared print action. The render step picks up
        // user/gift args from CPH.GetArg.
        CPH.SetArgument("source", "tiktok");
        CPH.SetArgument("gift_name", giftName);
        CPH.RunAction("PrinterBot - Print Receipt", false);
        // Discord mirror runs after print on the same chain via the
        // group's Run Action -> Discord Relay sub-action.
        CPH.RunAction("PrinterBot - Discord Relay", false);
        return true;
    }
}
