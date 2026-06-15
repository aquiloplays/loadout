// PrinterBot - Twitch Gift / Cheer / Sub Print router
// Hand-off for Twitch giftsub/cheer/sub triggers. Sets the source +
// gift_name args then delegates to the shared print + Discord relay
// actions. Existing trigger config (Twitch GiftSub, Cheer, Sub) stays
// pointed at this action; the Heart Me work is TikTok-only.
using System;

public class CPHInline
{
    public bool Execute()
    {
        string label = "";
        if (args.ContainsKey("triggerName")) label = (args["triggerName"] ?? "").ToString();
        CPH.SetArgument("source", "twitch");
        CPH.SetArgument("gift_name", string.IsNullOrEmpty(label) ? "gift" : label);
        CPH.RunAction("PrinterBot - Print Receipt", false);
        CPH.RunAction("PrinterBot - Discord Relay", false);
        return true;
    }
}
