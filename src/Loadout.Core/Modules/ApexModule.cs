using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Apex;
using Loadout.Bus;
using Loadout.Identity;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;

namespace Loadout.Modules
{
    /// <summary>
    /// APEX — top-viewer feature with cross-platform damage.
    ///
    /// One viewer holds the spot at a time. Every "spend" event from anyone
    /// else (sub, gift, cheer, channel-point redemption, CC coin, Bolts spent,
    /// TikTok gift, daily check-in, raid) deals damage. When HP hits 0 the
    /// reign ends and (by default) the finisher takes the crown.
    ///
    /// Cross-platform identity is canonical via <see cref="IdentityLinker"/> —
    /// a TikTok viewer who's <c>!link</c>'d their Twitch handle holds one
    /// Apex slot, not two.
    /// </summary>
    public sealed class ApexModule : IEventModule
    {
        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };

        private readonly object _gate = new object();
        private string _statePath;
        private ApexState _state;
        private DateTime _lastBroadcastUtc = DateTime.MinValue;

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.Apex) return;
            EnsureLoaded();

            // Chat commands first (cheap path).
            if (ctx.Kind == "chat")
            {
                HandleChatCommand(ctx, s);
                return;
            }

            // Compute damage and attribute it.
            var attacker = AttackerFromEvent(ctx);
            if (string.IsNullOrEmpty(attacker.Handle)) return;
            var damage = DamageForEvent(ctx, s);
            if (damage <= 0) return;

            ApplyDamage(s, attacker, damage, ctx.Kind);
        }

        public void OnTick()
        {
            // Re-publish state once a minute so a freshly-connected overlay
            // doesn't have to wait for the next damage event to populate.
            if (!SettingsManager.Instance.Current.Modules.Apex) return;
            if ((DateTime.UtcNow - _lastBroadcastUtc).TotalSeconds < 60) return;
            _lastBroadcastUtc = DateTime.UtcNow;
            EnsureLoaded();
            PublishState();
        }

        // ── Damage routing ────────────────────────────────────────────────────

        private static (string Platform, string Handle, string Display, string Pfp) AttackerFromEvent(EventContext ctx)
        {
            var platform = ctx.Platform.ToShortName();
            var handle   = ctx.User;
            var display  = handle;
            string pfp = ctx.Get<string>("userImage", ctx.Get<string>("profileImageUrl", null));
            return (platform, handle, display, pfp);
        }

        private static int DamageForEvent(EventContext ctx, LoadoutSettings s)
        {
            switch (ctx.Kind)
            {
                case "sub":          return s.Apex.DamageSub;
                case "resub":        return s.Apex.DamageResub;
                case "giftSub":      return Math.Max(1, ctx.Get<int>("count", 1)) * s.Apex.DamageGiftSub;
                case "cheer":        return ctx.Get<int>("bits", 0) / 100 * s.Apex.DamagePerHundredBits;
                case "raid":         return ctx.Get<int>("viewers", 0) * s.Apex.DamagePerRaidViewer;
                case "tiktokGift":   return ctx.Get<int>("coins", 0) * s.Apex.DamagePerTikTokCoin;
                case "ccCoinExchange":
                case "ccEffectSuccess":
                    var cost = ctx.Get<int>("cost", ctx.Get<int>("coinCost", 0));
                    return cost * s.Apex.DamagePerCcCoin;
                case "rewardRedemption":     return s.Apex.DamagePerChannelPointRedemption;
                case "checkin":              return s.Apex.DamagePerCheckIn;
                case "boltsSpent":
                    return ctx.Get<int>("amount", 0) * s.Apex.DamagePerBoltsSpent;
                default: return 0;
            }
        }

        private void ApplyDamage(LoadoutSettings s, (string Platform, string Handle, string Display, string Pfp) attacker, int damage, string sourceKind)
        {
            if (damage <= 0) return;
            ApexChampion previousChampion = null;
            ApexChampion newChampion      = null;
            int          dealt            = 0;
            string       attackerKey      = ResolveCanonicalKey(attacker.Platform, attacker.Handle);

            lock (_gate)
            {
                // No champion yet → first-blood crowns the attacker.
                if (_state.Current == null)
                {
                    if (s.Apex.IncludeBroadcaster || !IsBroadcaster(attacker.Handle, s))
                    {
                        Crown(attacker, s.Apex.StartingHealth, "first-blood", s);
                        PublishCrowned();
                    }
                    return;
                }

                // Self-immunity: champion can't damage themselves.
                if (s.Apex.SelfImmunity && string.Equals(_state.Current.CanonicalKey, attackerKey, StringComparison.OrdinalIgnoreCase))
                    return;

                // Skip damage if attacker is the broadcaster and broadcaster is excluded.
                if (!s.Apex.IncludeBroadcaster && IsBroadcaster(attacker.Handle, s))
                    return;

                // Apply damage.
                _state.Current.Health = Math.Max(0, _state.Current.Health - damage);
                dealt = damage;

                if (!_state.Current.Contributors.TryGetValue(attackerKey, out var c))
                {
                    c = new ApexContributor { Display = attacker.Display, Platform = attacker.Platform };
                    _state.Current.Contributors[attackerKey] = c;
                }
                c.TotalDamage += damage;
                c.HitCount++;
                c.LastHitUtc = DateTime.UtcNow;

                // Dethroned?
                if (_state.Current.Health <= 0)
                {
                    previousChampion = _state.Current;
                    _state.History.Insert(0, new ApexReignSummary
                    {
                        Champion = previousChampion.Display,
                        Platform = previousChampion.Platform,
                        CrownedUtc = previousChampion.CrownedUtc,
                        EndedUtc = DateTime.UtcNow,
                        EndedBy = attacker.Display,
                        MaxHealth = previousChampion.MaxHealth,
                        DistinctAttackers = previousChampion.Contributors.Count,
                        TotalDamageDealt = previousChampion.Contributors.Values.Sum(x => x.TotalDamage)
                    });
                    while (_state.History.Count > ApexState.MaxHistory) _state.History.RemoveAt(_state.History.Count - 1);

                    _state.Current = null;
                    if (s.Apex.AutoCrownFinisher)
                    {
                        Crown(attacker, s.Apex.StartingHealth, "finisher:" + attacker.Handle, s);
                        newChampion = _state.Current;
                    }
                }
                Save();
            }

            // Bus events fire outside the lock.
            AquiloBus.Instance.Publish("apex.damaged", new
            {
                attacker = attacker.Display,
                attackerPlatform = attacker.Platform,
                damage = dealt,
                source = sourceKind,
                health = _state.Current?.Health ?? 0,
                maxHealth = _state.Current?.MaxHealth ?? 0
            });

            if (previousChampion != null)
            {
                AquiloBus.Instance.Publish("apex.dethroned", new
                {
                    previous = previousChampion.Display,
                    previousPlatform = previousChampion.Platform,
                    finisher = attacker.Display,
                    finisherPlatform = attacker.Platform,
                    reignDurationSec = (int)(DateTime.UtcNow - previousChampion.CrownedUtc).TotalSeconds,
                    distinctAttackers = previousChampion.Contributors.Count,
                    totalDamage = previousChampion.Contributors.Values.Sum(x => x.TotalDamage)
                });
                if (s.Apex.AnnounceCrownChange)
                    AnnounceCrownChange(s, previousChampion, attacker, newChampion);
                _ = PostDiscordAsync(s, previousChampion, attacker);
            }

            if (newChampion != null) PublishCrowned();

            // Damage echo: only post a chat line for big hits, otherwise we only push to overlay.
            if (dealt >= s.Apex.ChatAnnounceDamageThreshold && _state.Current != null)
            {
                if (ChatGate.TrySend(ChatGate.Area.Other, "apex:dmg", TimeSpan.FromSeconds(4)))
                {
                    var msg = "💥 " + attacker.Display + " hit the Apex for " + dealt
                            + "  (" + _state.Current.Health + "/" + _state.Current.MaxHealth + " HP)";
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(PlatformMask.All, msg, s.Platforms);
                }
            }
        }

        private void Crown((string Platform, string Handle, string Display, string Pfp) victim, int hp, string reason, LoadoutSettings settings)
        {
            _state.Current = new ApexChampion
            {
                CanonicalKey = ResolveCanonicalKey(victim.Platform, victim.Handle),
                Platform     = victim.Platform,
                Handle       = victim.Handle,
                Display      = victim.Display,
                ProfileImage = victim.Pfp,
                Health       = hp,
                MaxHealth    = hp,
                CrownedUtc   = DateTime.UtcNow,
                CrownedBy    = reason,
                Contributors = new Dictionary<string, ApexContributor>(StringComparer.OrdinalIgnoreCase)
            };
            Save();
        }

        // ── Chat commands ─────────────────────────────────────────────────────

        private void HandleChatCommand(EventContext ctx, LoadoutSettings s)
        {
            var msg = (ctx.Message ?? "").Trim();
            if (!msg.StartsWith("!apex", StringComparison.OrdinalIgnoreCase)) return;
            var rest = msg.Length > 5 ? msg.Substring(5).Trim() : "";

            // Mod-only subcommands.
            var role = (ctx.UserType ?? "").ToLowerInvariant();
            var isMod = role == "broadcaster" || role == "moderator" || role == "mod";

            if (rest.StartsWith("set ", StringComparison.OrdinalIgnoreCase) && isMod)
            {
                var args = rest.Substring(4).Split(new[] { ' ' }, 2);
                if (args.Length < 1) return;
                var target = args[0].TrimStart('@');
                int hp = (args.Length > 1 && int.TryParse(args[1], out var h)) ? h : s.Apex.StartingHealth;
                Crown((ctx.Platform.ToShortName(), target, target, null), hp, "mod:" + ctx.User, s);
                PublishCrowned();
                if (ChatGate.TrySend(ChatGate.Area.Other, "apex:set", TimeSpan.FromSeconds(2)))
                    new MultiPlatformSender(CphPlatformSender.Instance)
                        .Send(PlatformMask.All, "👑 " + target + " has been crowned the Apex (" + hp + " HP).", s.Platforms);
                return;
            }
            if (rest == "kill" && isMod)
            {
                if (_state.Current != null)
                {
                    _state.Current.Health = 0;
                    AquiloBus.Instance.Publish("apex.dethroned", new
                    {
                        previous = _state.Current.Display,
                        finisher = ctx.User,
                        manual = true
                    });
                    _state.Current = null;
                    Save();
                    if (ChatGate.TrySend(ChatGate.Area.Other, "apex:kill", TimeSpan.FromSeconds(2)))
                        new MultiPlatformSender(CphPlatformSender.Instance)
                            .Send(PlatformMask.All, "👑 The Apex spot is empty. First damage takes the crown.", s.Platforms);
                }
                return;
            }
            if (rest == "top")
            {
                if (_state.Current == null || _state.Current.Contributors.Count == 0) return;
                var top = _state.Current.Contributors.Values
                    .OrderByDescending(c => c.TotalDamage)
                    .Take(5)
                    .ToList();
                if (!ChatGate.TrySend(ChatGate.Area.Other, "apex:top", TimeSpan.FromSeconds(15))) return;
                var line = "⚔️ Top damage on " + _state.Current.Display + ": " + string.Join(", ",
                    top.Select((c, i) => (i + 1) + ". " + c.Display + " (" + c.TotalDamage + ")"));
                new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, line, s.Platforms);
                return;
            }

            // Default: show current state.
            if (!ChatGate.TrySend(ChatGate.Area.Other, "apex:show", TimeSpan.FromSeconds(15))) return;
            string text;
            if (_state.Current == null)
            {
                text = "👑 The Apex spot is open. First sub / gift / cheer / TikTok gift / channel point takes the crown.";
            }
            else
            {
                var dur = DateTime.UtcNow - _state.Current.CrownedUtc;
                text = "👑 Apex: " + _state.Current.Display + "  ·  HP " + _state.Current.Health + "/" + _state.Current.MaxHealth
                     + "  ·  reigning " + Format(dur)
                     + "  ·  " + _state.Current.Contributors.Count + " challengers";
            }
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, text, s.Platforms);
        }

        private static string Format(TimeSpan ts)
        {
            if (ts.TotalHours >= 1) return ((int)ts.TotalHours) + "h " + ts.Minutes + "m";
            if (ts.TotalMinutes >= 1) return ts.Minutes + "m " + ts.Seconds + "s";
            return ts.Seconds + "s";
        }

        // ── Announcements ─────────────────────────────────────────────────────

        private void AnnounceCrownChange(LoadoutSettings s, ApexChampion previous, (string Platform, string Handle, string Display, string Pfp) finisher, ApexChampion newChampion)
        {
            if (!ChatGate.TrySend(ChatGate.Area.Other, "apex:crown", TimeSpan.FromSeconds(3))) return;
            string msg;
            if (newChampion != null)
                msg = "👑 " + finisher.Display + " dethroned " + previous.Display
                    + " and is the new Apex! (" + newChampion.MaxHealth + " HP)";
            else
                msg = "👑 " + finisher.Display + " ended " + previous.Display + "'s reign. The Apex spot is open.";
            new MultiPlatformSender(CphPlatformSender.Instance).Send(PlatformMask.All, msg, s.Platforms);
        }

        private static async Task PostDiscordAsync(LoadoutSettings s, ApexChampion previous, (string Platform, string Handle, string Display, string Pfp) finisher)
        {
            if (string.IsNullOrEmpty(s.Apex.DiscordWebhook)) return;
            try
            {
                var dur = DateTime.UtcNow - previous.CrownedUtc;
                var body = "**Apex change** 👑\n"
                         + "**" + finisher.Display + "** (" + finisher.Platform + ") dethroned **" + previous.Display + "**\n"
                         + "Reign: " + (int)dur.TotalMinutes + "m  ·  challengers: " + previous.Contributors.Count
                         + "  ·  total damage: " + previous.Contributors.Values.Sum(c => c.TotalDamage);
                var json = JsonConvert.SerializeObject(new { content = body, allowed_mentions = new { parse = new string[] { } } });
                using var resp = await _http.PostAsync(s.Apex.DiscordWebhook,
                    new StringContent(json, Encoding.UTF8, "application/json")).ConfigureAwait(false);
            }
            catch (Exception ex) { ErrorLog.Write("Apex.DiscordPost", ex); }
        }

        // ── Bus snapshots ─────────────────────────────────────────────────────

        private void PublishState()
        {
            object payload;
            lock (_gate)
            {
                if (_state.Current == null) { payload = new { champion = (object)null }; }
                else
                {
                    payload = new
                    {
                        champion = new
                        {
                            handle    = _state.Current.Display,
                            platform  = _state.Current.Platform,
                            pfp       = _state.Current.ProfileImage,
                            health    = _state.Current.Health,
                            maxHealth = _state.Current.MaxHealth,
                            crownedUtc = _state.Current.CrownedUtc,
                            reignSeconds = (int)(DateTime.UtcNow - _state.Current.CrownedUtc).TotalSeconds,
                            challengers = _state.Current.Contributors.Count,
                            topContributors = _state.Current.Contributors.Values
                                .OrderByDescending(c => c.TotalDamage)
                                .Take(5)
                                .Select(c => new { c.Display, c.Platform, c.TotalDamage, c.HitCount })
                                .ToArray()
                        }
                    };
                }
            }
            AquiloBus.Instance.Publish("apex.state", payload);
        }

        private void PublishCrowned()
        {
            object payload;
            lock (_gate)
            {
                if (_state.Current == null) return;
                payload = new
                {
                    champion = _state.Current.Display,
                    platform = _state.Current.Platform,
                    pfp      = _state.Current.ProfileImage,
                    maxHealth = _state.Current.MaxHealth,
                    by        = _state.Current.CrownedBy
                };
            }
            AquiloBus.Instance.Publish("apex.crowned", payload);
        }

        // ── Helpers ───────────────────────────────────────────────────────────

        private static string ResolveCanonicalKey(string platform, string handle)
        {
            if (string.IsNullOrEmpty(handle)) return null;
            try
            {
                var mask = PlatformMaskExtensions.FromShortName(platform);
                if (mask != PlatformMask.None)
                    return IdentityLinker.Instance.GetPrimary(mask, handle).ToString();
            }
            catch { }
            return (platform ?? "?").ToLowerInvariant() + ":" + handle.Trim().TrimStart('@').ToLowerInvariant();
        }

        private static bool IsBroadcaster(string handle, LoadoutSettings s)
        {
            return !string.IsNullOrEmpty(s.BroadcasterName) &&
                   string.Equals(handle, s.BroadcasterName, StringComparison.OrdinalIgnoreCase);
        }

        // ── Persistence ───────────────────────────────────────────────────────

        private void EnsureLoaded()
        {
            if (_state != null) return;
            lock (_gate)
            {
                if (_state != null) return;
                _statePath = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "apex.json");
                if (File.Exists(_statePath))
                {
                    try { _state = JsonConvert.DeserializeObject<ApexState>(File.ReadAllText(_statePath)) ?? new ApexState(); }
                    catch { _state = new ApexState(); }
                }
                else _state = new ApexState();
            }
        }

        private void Save()
        {
            try { File.WriteAllText(_statePath, JsonConvert.SerializeObject(_state, Formatting.Indented)); }
            catch (Exception ex) { ErrorLog.Write("Apex.Save", ex); }
        }
    }
}
