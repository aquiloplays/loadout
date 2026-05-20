using System;
using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// Twitch / YouTube / Kick / TikTok chat announcements for bus-driven
    /// game events that previously had NO chat reply -- dungeon recruiting,
    /// dungeon completed (survived vs wiped), duel completed.
    ///
    /// Why this module exists separately from DungeonModule:
    ///   - DungeonModule owns the !dungeon / !join command replies and
    ///     publishes the overlay-driven bus scene events (dungeon.scene,
    ///     dungeon.completed) -- but it does NOT post a chat line when a
    ///     run opens for recruiting or when a run ends. Viewers staring at
    ///     chat had to alt-tab to the overlay to know a dungeon was forming.
    ///   - Duels publish duel.completed but no chat winner-announce existed.
    ///   - Splitting announcements into their own module means the
    ///     formatting + toggles + rate-limit-aware send live in one place,
    ///     not scattered across the engine.
    ///
    /// We subscribe via <see cref="AquiloBus.LocalPublished"/> rather than
    /// RegisterHandler -- per EVENTS.md, RegisterHandler fires only for
    /// client-published frames; in-process Publish calls (DungeonModule,
    /// BoltsModule etc.) only hit LocalPublished. LocalPublished catches
    /// both, so this single subscription covers chat-driven AND Discord-
    /// relayed game events.
    ///
    /// Chat sends go through <see cref="MultiPlatformSender"/> with
    /// <see cref="PlatformMask.All"/> as the target -- the sender filters
    /// down to the platforms enabled in <see cref="PlatformsConfig"/> and
    /// honors the per-platform rate limiters (Twitch 90/min, YouTube 15/min,
    /// etc.) so a runaway loop can't get the bot timed out.
    ///
    /// Tone matches existing modules (CheckInModule's "✅ Checked in!",
    /// ApexModule's "👑 X has been crowned", HeistController's heist lines):
    /// one short sentence, one emoji prefix, no @-pings, no walls of text.
    /// </summary>
    public sealed class ChatAnnouncementsModule : IEventModule
    {
        private readonly MultiPlatformSender _sender =
            new MultiPlatformSender(CphPlatformSender.Instance);

        public ChatAnnouncementsModule()
        {
            AquiloBus.Instance.LocalPublished += OnBusPublished;
        }

        // IEventModule surface -- pure bus-driven; no chat / tick path.
        public void OnEvent(EventContext ctx) { }
        public void OnTick() { }

        private void OnBusPublished(string kind, JToken data)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                var cfg = s.ChatAnnouncements;
                if (cfg == null || !cfg.Enabled) return;

                switch (kind)
                {
                    case "dungeon.recruiting":
                        if (cfg.DungeonRecruiting) AnnounceDungeonRecruiting(data, s);
                        break;
                    case "dungeon.completed":
                        if (cfg.DungeonCompleted) AnnounceDungeonCompleted(data, s);
                        break;
                    case "duel.completed":
                        if (cfg.DuelCompleted) AnnounceDuelCompleted(data, s);
                        break;
                    case "bolts.minigame.coinflip":
                    case "bolts.minigame.dice":
                    case "bolts.minigame.slots":
                    case "bolts.minigame.rps":
                    case "bolts.minigame.roulette":
                        if (cfg.MinigameBigWins) AnnounceMinigameBigWin(kind, data, cfg, s);
                        break;
                }
            }
            catch (Exception ex)
            {
                // LocalPublished runs on the publishing thread -- a throw
                // here would bubble into whatever module fired the event.
                // Swallow + debug-log; missing a chat line beats poisoning
                // the bus.
                System.Diagnostics.Debug.WriteLine(
                    "[Loadout/ChatAnnouncements] " + kind + " failed: " + ex.Message);
            }
        }

        // ---- formatters ---------------------------------------------------

        private void AnnounceDungeonRecruiting(JToken data, LoadoutSettings s)
        {
            var dungeonName  = Str(data, "dungeonName", "the dungeon");
            var joinCmd      = Str(data, "joinCommand", "!dungeon join");
            var openSec      = Int(data, "openSec", 0);
            var msg = openSec > 0
                ? "⚔️ A party is forming for " + dungeonName + "! Type " + joinCmd + " to enter (" + openSec + "s)."
                : "⚔️ A party is forming for " + dungeonName + "! Type " + joinCmd + " to enter.";
            Send(msg, s);
        }

        private void AnnounceDungeonCompleted(JToken data, LoadoutSettings s)
        {
            var dungeonName = Str(data, "dungeonName", "the dungeon");
            var partySize   = Int(data, "partySize", 0);
            var outcomes    = data?["outcomes"] as JArray;
            // outcomes[] entries carry a per-hero result; we count survivors
            // by anyone whose `survived` flag is true. If the field isn't
            // present (older payload shape), fall back to "the party made it
            // out" wording so we don't claim a wipe that didn't happen.
            int survivors = 0;
            bool sawAnyOutcome = false;
            if (outcomes != null)
            {
                foreach (var o in outcomes)
                {
                    sawAnyOutcome = true;
                    if (o?["survived"]?.Type == JTokenType.Boolean &&
                        o.Value<bool>("survived"))
                    {
                        survivors++;
                    }
                }
            }
            string msg;
            if (sawAnyOutcome && survivors == 0)
            {
                msg = "💀 " + dungeonName + ": the party was WIPED. F.";
            }
            else if (sawAnyOutcome && partySize > 0 && survivors < partySize)
            {
                msg = "🏁 " + dungeonName + " cleared! " + survivors + "/" + partySize +
                      " hero" + (survivors == 1 ? "" : "es") + " made it out.";
            }
            else
            {
                // Full survival or unknown party shape.
                var sizeFrag = partySize > 0
                    ? " (" + partySize + " hero" + (partySize == 1 ? "" : "es") + ")"
                    : "";
                msg = "🏆 " + dungeonName + ": the party survived!" + sizeFrag;
            }
            Send(msg, s);
        }

        private void AnnounceDuelCompleted(JToken data, LoadoutSettings s)
        {
            var winner = Str(data, "winner", "");
            var loser  = Str(data, "loser",  "");
            if (string.IsNullOrEmpty(winner) || string.IsNullOrEmpty(loser)) return;
            var gold = Int(data, "gold", 0);
            var msg = gold > 0
                ? "🗡️ " + winner + " defeated " + loser + " in a duel! (+" + gold + " bolts)"
                : "🗡️ " + winner + " defeated " + loser + " in a duel!";
            Send(msg, s);
        }

        private void AnnounceMinigameBigWin(string kind, JToken data,
                                            ChatAnnouncementsConfig cfg, LoadoutSettings s)
        {
            // Only celebrate WINS above the threshold. Losses + small wins
            // are noise -- BoltsModule's own game-response line already
            // covers the per-call ack.
            if (data?["won"]?.Type == JTokenType.Boolean && !data.Value<bool>("won")) return;
            var payout = Int(data, "payout", 0);
            if (payout < cfg.MinigameBigWinThreshold) return;
            var user = Str(data, "user", "");
            if (string.IsNullOrEmpty(user)) return;
            // kind = "bolts.minigame.<game>" -- strip prefix for display.
            var game = kind.StartsWith("bolts.minigame.")
                ? kind.Substring("bolts.minigame.".Length)
                : kind;
            var msg = "🎰 " + user + " just won " + payout + " bolts on " + game + "!";
            Send(msg, s);
        }

        // ---- helpers ------------------------------------------------------

        private void Send(string msg, LoadoutSettings s)
        {
            if (string.IsNullOrEmpty(msg)) return;
            _sender.Send(PlatformMask.All, msg, s.Platforms);
        }

        private static string Str(JToken t, string key, string fallback)
        {
            if (t == null) return fallback;
            var v = t[key];
            if (v == null || v.Type == JTokenType.Null) return fallback;
            var s = v.ToString();
            return string.IsNullOrWhiteSpace(s) ? fallback : s;
        }

        private static int Int(JToken t, string key, int fallback)
        {
            if (t == null) return fallback;
            var v = t[key];
            if (v == null || v.Type == JTokenType.Null) return fallback;
            try { return v.Value<int>(); }
            catch { return fallback; }
        }
    }
}
