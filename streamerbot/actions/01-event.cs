// LOADOUT — EVENT TRAMPOLINE
// One action handles every platform event. Triggers attached: Follow / Sub /
// Resub / Gift Sub / Cheer / Raid / Super Chat / Membership / Kick Sub / Kick
// Gift / TikTok Gift across Twitch, YouTube, Kick. The SB triggerName arg
// disambiguates which kind fired so the DLL routes correctly.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

public class CPHInline
{
    private static Type _entry;

    public bool Execute()
    {
        try
        {
            if (_entry == null)
            {
                var dll = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "Loadout", "Loadout.dll");
                if (!File.Exists(dll)) { CPH.LogWarn("[Loadout] Event before boot — skipping."); return false; }
                _entry = Assembly.LoadFrom(dll).GetType("Loadout.LoadoutEntry");
            }

            // Map SB's triggerName → our normalized event kind. Add new mappings
            // here when SB introduces a new event type — DLL changes don't require it.
            var trigger = (args.ContainsKey("triggerName") ? args["triggerName"]?.ToString() : "") ?? "";
            string kind = MapKind(trigger);
            if (string.IsNullOrEmpty(kind)) { CPH.LogDebug("[Loadout] Unmapped trigger: " + trigger); return false; }

            var dispatch = _entry.GetMethod("DispatchEvent", BindingFlags.Public | BindingFlags.Static);
            dispatch.Invoke(null, new object[] { CPH, kind, (IDictionary<string, object>)args });
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] Event dispatch failed: " + ex.Message);
            return false;
        }
    }

    private static string MapKind(string t)
    {
        if (string.IsNullOrEmpty(t)) return "";
        var lc = t.ToLowerInvariant();
        if (lc.Contains("twitchfollow")    || lc.Contains("youtubefollow") || lc.Contains("kickfollow")) return "follow";
        if (lc.Contains("twitchresub") || lc.Contains("youtubemembermilestone")) return "resub";
        if (lc.Contains("twitchsub") || lc.Contains("youtubememberjoined") || lc.Contains("youtubenewsub") || lc.Contains("youtubenewsponsor")) return "sub";
        if (lc.Contains("giftsub") || lc.Contains("giftbomb") || lc.Contains("youtubegiftmember") || lc.Contains("youtubemembershipgift")) return "giftSub";
        if (lc.Contains("twitchcheer")) return "cheer";
        if (lc.Contains("twitchraid")) return "raid";
        if (lc.Contains("youtubesuperchat") || lc.Contains("youtubesuper")) return "superChat";
        if (lc.Contains("youtubemembership")) return "membership";
        if (lc.Contains("kicksub")) return "kickSub";
        if (lc.Contains("kickgift")) return "kickGift";
        if (lc.Contains("tiktokgift") || lc.Contains("tikfinity")) return "tiktokGift";
        if (lc.Contains("rewardredemption") || lc.Contains("automaticreward")) return "rewardRedemption";
        if (lc.Contains("firstword") || lc.Contains("firstwords")) return "firstWords";
        if (lc.Contains("upcomingad") || lc.Contains("adrun")) return "upcomingAd";
        if (lc.Contains("streamonline") || lc.Contains("broadcaststarted") || lc.Contains("streamingstarted")) return "streamOnline";
        if (lc.Contains("streamoffline") || lc.Contains("broadcastended") || lc.Contains("streamingstopped")) return "streamOffline";
        if (lc.Contains("streamupdate") || lc.Contains("broadcastupdate")) return "streamUpdate";
        if (lc.Contains("crowdcontrolgamesessionstart")) return "ccGameSessionStart";
        if (lc.Contains("crowdcontroleffectsuccess"))    return "ccEffectSuccess";
        if (lc.Contains("crowdcontroleffectfailure"))    return "ccEffectFailure";
        if (lc.Contains("crowdcontrolcoinexchange"))     return "ccCoinExchange";
        if (lc.Contains("subcounterrollover"))           return "subCounterRollover";
        return "";
    }
}
