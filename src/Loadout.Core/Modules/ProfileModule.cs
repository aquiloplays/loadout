using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Bus;
using Loadout.Bolts;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Loadout.ViewerProfile;

namespace Loadout.Modules
{
    /// <summary>
    /// Self-served viewer profile chat commands. Lets viewers personalize
    /// what shows up on the !profile overlay + future tooltips:
    /// <list type="bullet">
    ///   <item><c>!setbio &lt;text&gt;</c>            short bio (max chars in settings)</item>
    ///   <item><c>!setpfp &lt;url&gt;</c>             avatar override (PNG / JPG URL)</item>
    ///   <item><c>!setpronouns &lt;txt&gt;</c>        e.g. "they/them"</item>
    ///   <item><c>!setsocial &lt;platform&gt; &lt;handle&gt;</c>   add/replace a social link</item>
    ///   <item><c>!setgamertag &lt;platform&gt; &lt;tag&gt;</c>    add/replace a gamer tag</item>
    ///   <item><c>!clearprofile</c>           wipe self profile</item>
    /// </list>
    /// !profile (read) lives in InfoCommandsModule and reads from
    /// <see cref="ViewerProfileStore"/> here.
    ///
    /// Mods + broadcaster bypass the per-user cooldown so the streamer
    /// can demo the commands during onboarding.
    /// </summary>
    public sealed class ProfileModule : IEventModule
    {
        // <platform>:<handle> -> last-action timestamp.
        private readonly Dictionary<string, DateTime> _lastUse = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            var cfg = s.ViewerProfiles ?? new ViewerProfilesConfig();
            if (!cfg.ChatCommandsEnabled) return;

            var msg = (ctx.Message ?? "").Trim();
            if (msg.Length < 2 || msg[0] != '!') return;

            var spaceIdx = msg.IndexOf(' ');
            var cmd  = (spaceIdx < 0 ? msg.Substring(1) : msg.Substring(1, spaceIdx - 1)).ToLowerInvariant();
            var rest = spaceIdx < 0 ? "" : msg.Substring(spaceIdx + 1).Trim();

            switch (cmd)
            {
                case "setbio":      HandleBio(ctx, rest, s, cfg); return;
                case "setpfp":
                case "setpic":      HandlePfp(ctx, rest, s, cfg); return;
                case "setpronouns": HandlePronouns(ctx, rest, s, cfg); return;
                case "setsocial":
                case "setsocials":  HandleSocial(ctx, rest, s, cfg); return;
                case "setgamertag":
                case "setgametag":
                case "settag":      HandleGamerTag(ctx, rest, s, cfg); return;
                case "clearprofile":
                case "wipeprofile": HandleClear(ctx, s); return;
            }
        }

        // ---- per-command handlers -------------------------------------

        private void HandleBio(EventContext ctx, string rest, LoadoutSettings s, ViewerProfilesConfig cfg)
        {
            if (!CooldownOk(ctx, cfg)) return;
            if (string.IsNullOrWhiteSpace(rest))
            { Reply(ctx, s, "@" + ctx.User + " usage: !setbio <text> (max " + cfg.MaxBioChars + " chars)"); return; }
            if (rest.Length > cfg.MaxBioChars)
            { Reply(ctx, s, "@" + ctx.User + " bio is " + rest.Length + " chars — keep it under " + cfg.MaxBioChars + "."); return; }

            var p = ViewerProfileStore.Instance.UpdateBio(ctx.Platform.ToShortName(), ctx.User, rest);
            BroadcastUpdate(p);
            Reply(ctx, s, "📝 @" + ctx.User + " bio saved.");
            EventStats.Instance.Hit(ctx.Kind, nameof(ProfileModule));
        }

        private void HandlePfp(EventContext ctx, string rest, LoadoutSettings s, ViewerProfilesConfig cfg)
        {
            if (!CooldownOk(ctx, cfg)) return;
            var url = (rest ?? "").Trim();
            if (string.IsNullOrEmpty(url))
            { Reply(ctx, s, "@" + ctx.User + " usage: !setpfp <png/jpg URL>"); return; }
            if (url.Length > cfg.MaxPfpUrlChars)
            { Reply(ctx, s, "@" + ctx.User + " URL too long (" + url.Length + " chars). Use a shorter image link."); return; }
            if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            { Reply(ctx, s, "@" + ctx.User + " URL has to start with http(s)://"); return; }

            var p = ViewerProfileStore.Instance.UpdatePfp(ctx.Platform.ToShortName(), ctx.User, url);
            BroadcastUpdate(p);
            Reply(ctx, s, "🖼️ @" + ctx.User + " profile pic saved.");
            EventStats.Instance.Hit(ctx.Kind, nameof(ProfileModule));
        }

        private void HandlePronouns(EventContext ctx, string rest, LoadoutSettings s, ViewerProfilesConfig cfg)
        {
            if (!CooldownOk(ctx, cfg)) return;
            var v = (rest ?? "").Trim();
            if (string.IsNullOrEmpty(v))
            { Reply(ctx, s, "@" + ctx.User + " usage: !setpronouns <txt> (e.g. they/them)"); return; }
            if (v.Length > cfg.MaxPronounsChars)
            { Reply(ctx, s, "@" + ctx.User + " keep pronouns under " + cfg.MaxPronounsChars + " chars."); return; }

            var p = ViewerProfileStore.Instance.UpdatePronouns(ctx.Platform.ToShortName(), ctx.User, v);
            BroadcastUpdate(p);
            Reply(ctx, s, "✨ @" + ctx.User + " pronouns saved.");
            EventStats.Instance.Hit(ctx.Kind, nameof(ProfileModule));
        }

        private void HandleSocial(EventContext ctx, string rest, LoadoutSettings s, ViewerProfilesConfig cfg)
        {
            if (!CooldownOk(ctx, cfg)) return;
            // Args: "<platform> <handle>".  Allow handle with spaces by
            // taking everything after the first space, but typical usage
            // is single-word handles.
            var parts = (rest ?? "").Trim().Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2)
            { Reply(ctx, s, "@" + ctx.User + " usage: !setsocial <platform> <handle> (twitter/ig/bsky/...)"); return; }
            var platform = parts[0].ToLowerInvariant();
            var handle   = parts[1].Trim();

            if (!IsAllowed(platform, cfg.AllowedSocials))
            { Reply(ctx, s, "@" + ctx.User + " '" + platform + "' isn't on the allowed-socials list."); return; }
            if (handle.Length > cfg.MaxSocialChars)
            { Reply(ctx, s, "@" + ctx.User + " social handle too long. Max " + cfg.MaxSocialChars + " chars."); return; }

            var p = ViewerProfileStore.Instance.UpdateSocial(ctx.Platform.ToShortName(), ctx.User, platform, handle);
            BroadcastUpdate(p);
            Reply(ctx, s, "🔗 @" + ctx.User + " saved " + platform + ":" + handle + ".");
            EventStats.Instance.Hit(ctx.Kind, nameof(ProfileModule));
        }

        private void HandleGamerTag(EventContext ctx, string rest, LoadoutSettings s, ViewerProfilesConfig cfg)
        {
            if (!CooldownOk(ctx, cfg)) return;
            var parts = (rest ?? "").Trim().Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2)
            { Reply(ctx, s, "@" + ctx.User + " usage: !setgamertag <platform> <tag> (psn/xbox/steam/...)"); return; }
            var platform = parts[0].ToLowerInvariant();
            var tag      = parts[1].Trim();

            if (!IsAllowed(platform, cfg.AllowedGamePlatforms))
            { Reply(ctx, s, "@" + ctx.User + " '" + platform + "' isn't on the allowed-game-platforms list."); return; }
            if (tag.Length > cfg.MaxGamerTagChars)
            { Reply(ctx, s, "@" + ctx.User + " tag too long. Max " + cfg.MaxGamerTagChars + " chars."); return; }

            var p = ViewerProfileStore.Instance.UpdateGamerTag(ctx.Platform.ToShortName(), ctx.User, platform, tag);
            BroadcastUpdate(p);
            Reply(ctx, s, "🎮 @" + ctx.User + " saved " + platform + ":" + tag + ".");
            EventStats.Instance.Hit(ctx.Kind, nameof(ProfileModule));
        }

        private void HandleClear(EventContext ctx, LoadoutSettings s)
        {
            var ok = ViewerProfileStore.Instance.Clear(ctx.Platform.ToShortName(), ctx.User);
            BroadcastUpdate(new ViewerProfile.ViewerProfile { Platform = ctx.Platform.ToShortName(), Handle = ctx.User });
            Reply(ctx, s, ok
                ? "🧹 @" + ctx.User + " profile wiped."
                : "@" + ctx.User + " no profile to clear.");
            EventStats.Instance.Hit(ctx.Kind, nameof(ProfileModule));
        }

        // ---- helpers ---------------------------------------------------

        private bool CooldownOk(EventContext ctx, ViewerProfilesConfig cfg)
        {
            var u = (ctx.UserType ?? "").ToLowerInvariant();
            if (u == "broadcaster" || u == "moderator" || u == "mod") return true;
            var cd = Math.Max(0, cfg.PerUserCooldownSec);
            if (cd == 0) return true;
            var key = ctx.Platform.ToShortName() + ":" + ctx.User.ToLowerInvariant();
            if (_lastUse.TryGetValue(key, out var last) && (DateTime.UtcNow - last).TotalSeconds < cd)
                return false;
            _lastUse[key] = DateTime.UtcNow;
            return true;
        }

        private static bool IsAllowed(string platform, string allowedCsv)
        {
            if (string.IsNullOrWhiteSpace(allowedCsv)) return true;
            foreach (var raw in allowedCsv.Split(','))
            {
                var t = raw.Trim().ToLowerInvariant();
                if (t.Length > 0 && t == platform) return true;
            }
            return false;
        }

        private static void Reply(EventContext ctx, LoadoutSettings s, string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            // Light global gate so a single viewer's typo doesn't avalanche
            // chat with usage hints. Mods + broadcaster bypass.
            var u = (ctx.UserType ?? "").ToLowerInvariant();
            var bypass = (u == "broadcaster" || u == "moderator" || u == "mod");
            if (bypass)
            {
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands)) return;
            }
            else
            {
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "profile:" + ctx.User, TimeSpan.FromSeconds(3))) return;
            }
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, text, s.Platforms);
        }

        // Broadcasts the updated profile so live overlays can refresh
        // without waiting for a !profile re-trigger. Same shape as the
        // viewer.profile.shown event (handled by the viewer overlay).
        private static void BroadcastUpdate(ViewerProfile.ViewerProfile p)
        {
            if (p == null) return;
            try
            {
                var bolts = 0L;
                try
                {
                    BoltsWallet.Instance.Initialize();
                    bolts = BoltsWallet.Instance.Balance(p.Platform ?? "twitch", p.Handle ?? "");
                }
                catch { }

                AquiloBus.Instance.Publish("viewer.profile.updated", new
                {
                    platform   = p.Platform,
                    handle     = p.Handle,
                    bio        = p.Bio,
                    pfp        = p.Pfp,
                    pronouns   = p.Pronouns,
                    socials    = p.Socials,
                    gamerTags  = p.GamerTags,
                    bolts      = bolts,
                    ts         = DateTime.UtcNow
                });
            }
            catch (Exception ex) { ErrorLog.Write("ProfileModule.Broadcast", ex); }
        }
    }
}
