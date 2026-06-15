using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Discord;
using Loadout.Host;
using Loadout.Identity;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout
{
    /// <summary>
    /// Public surface called from SB inline-C# trampolines (which load this DLL
    /// via Assembly.LoadFrom and invoke us reflectively — no SB References-tab
    /// editing required by the user).
    ///
    /// Keep this surface narrow and stable. Adding a new method is fine; renaming
    /// or changing parameter types breaks already-imported SB bundles in the field.
    /// </summary>
    public static class LoadoutEntry
    {
        // -------------------- Boot --------------------

        /// <summary>
        /// Single entry point for the SB-side "Loadout: Boot" action. Idempotent —
        /// re-runs are no-ops after the first successful boot.
        /// </summary>
        public static bool Boot(object cph)
        {
            try
            {
                SbBridge.Instance.Bind(cph);
                CphPlatformSender.Instance.Bind(cph);
                LoadoutHost.EnsureStarted(null);
                SbEventDispatcher.Instance.RegisterDefaultModules();

                // Background poller that mirrors Discord-side /coinflip and
                // /dice results from the Worker into the local bus, so the
                // OBS bolts minigames overlay renders them too.
                DiscordMinigameBridge.Instance.Start();
                // Background poller that mirrors Discord-side /profile-set-*
                // edits into the local ViewerProfileStore.
                DiscordProfileBridge.Instance.Start();

                // Structured boot banner — makes "is Loadout actually
                // running?" obvious from the SB log without opening any UI.
                // Each line is intentionally short so it survives SB's log
                // truncation on long sessions. Format mirrors a typical
                // service-startup summary so streamers comparing notes
                // recognize the shape.
                var s = SettingsManager.Instance.Current;
                int enabledModules = 0;
                foreach (var p in typeof(Settings.ModulesConfig).GetProperties())
                    if (p.PropertyType == typeof(bool) && p.GetValue(s.Modules) is bool b && b) enabledModules++;
                var platforms = new System.Collections.Generic.List<string>();
                if (s.Platforms.Twitch)  platforms.Add("twitch");
                if (s.Platforms.TikTok)  platforms.Add("tiktok");
                if (s.Platforms.YouTube) platforms.Add("youtube");
                if (s.Platforms.Kick)    platforms.Add("kick");
                SbBridge.Instance.LogInfo("[Loadout] ======== Loadout v" + (s.SuiteVersion ?? "?") + " booted ========");
                SbBridge.Instance.LogInfo("[Loadout]   Settings:   " + SettingsManager.Instance.SettingsPath);
                SbBridge.Instance.LogInfo("[Loadout]   Onboarding: " + (s.OnboardingDone ? "done" : "PENDING — wizard opening"));
                SbBridge.Instance.LogInfo("[Loadout]   Platforms:  " + (platforms.Count == 0 ? "none enabled" : string.Join(", ", platforms))
                    + (s.Platforms.UseBotAccount ? " (sending as BOT account)" : " (sending as broadcaster)"));
                SbBridge.Instance.LogInfo("[Loadout]   Modules:    " + enabledModules + " enabled");
                SbBridge.Instance.LogInfo("[Loadout]   Patreon:    " + Patreon.Entitlements.CurrentTierDisplay());
                SbBridge.Instance.LogInfo("[Loadout]   Quiet mode: " + (s.ChatNoise.QuietMode ? "ON (chat sends muted)" : "off"));
                SbBridge.Instance.LogInfo("[Loadout]   Dry-run:    " + (s.DryRun ? "ON (no actual sends)" : "off"));
                SbBridge.Instance.LogInfo("[Loadout]   Block list: " + (s.ChatNoise.BlockedUsers?.Count ?? 0) + " entries");
                SbBridge.Instance.LogInfo("[Loadout]   Bus:        ws://127.0.0.1:7470/aquilo/bus/ ("
                    + (Bus.AquiloBus.Instance.IsRunning ? "running" : "stopped") + ")");
                SbBridge.Instance.LogInfo("[Loadout] =====================================================");

                // Push a status snapshot to any already-connected dock /
                // customizer so their pills + toggles initialize without
                // waiting for a request.
                try { Modules.DockCommandBridge.PublishStatus(); } catch { }

                if (!s.OnboardingDone)
                    LoadoutHost.OpenOnboarding();
                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Boot failed: " + ex);
                try { SbBridge.Instance.LogError("[Loadout] Boot failed: " + ex.Message); } catch { }
                return false;
            }
        }

        // -------------------- Event dispatch from SB trampolines --------------------

        /// <summary>
        /// Called by every SB-side event trampoline: a string event kind
        /// ("follow", "sub", "raid", "chat", "tiktokGift", ...) plus the raw CPH
        /// args dictionary. The dispatcher fans out to module handlers.
        /// </summary>
        public static void DispatchEvent(object cph, string kind, IDictionary<string, object> args)
        {
            try
            {
                if (!SbBridge.Instance.IsBound) Boot(cph);
                SbEventDispatcher.Instance.DispatchEvent(kind, args);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] DispatchEvent: " + ex);
            }
        }

        /// <summary>
        /// Called once a minute by the SB-side Tick action. Drives timed messages,
        /// hype-train decay, and any future cadence-driven module.
        /// </summary>
        public static void Tick(object cph)
        {
            try
            {
                if (!SbBridge.Instance.IsBound) Boot(cph);
                SbEventDispatcher.Instance.Tick();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Tick: " + ex);
            }
        }

        /// <summary>
        /// Verification path for the auto-message ("timed messages") pipeline.
        /// Bypasses the activity / broadcaster-pause / interval gates and
        /// sends the first enabled timed message right now via the same
        /// MultiPlatformSender + CphPlatformSender path the real timer
        /// uses. Returns the platform mask (as int) actually written to,
        /// or 0 when nothing went out (no enabled platform, none connected,
        /// rate-limited, or no enabled message configured).
        ///
        /// SB-side trigger: add an inline-C# action that calls
        ///     LoadoutEntry.TestTimedMessageNow(cph);
        /// and bind it to a chat command (e.g. !timer-test) or a Manual
        /// Trigger button. The result is also logged to the SB log so it
        /// shows up in the Loadout console without needing a return path.
        /// </summary>
        public static int TestTimedMessageNow(object cph)
        {
            try
            {
                if (!SbBridge.Instance.IsBound) Boot(cph);
                var s = SettingsManager.Instance.Current;
                var due = s.Timers.Messages.FirstOrDefault(t => t.Enabled && !string.IsNullOrWhiteSpace(t.Message));
                if (due == null)
                {
                    SbBridge.Instance.LogInfo("[Loadout] TestTimedMessageNow: no enabled timed message configured.");
                    return 0;
                }
                var sender = new MultiPlatformSender(CphPlatformSender.Instance);
                var target = due.Platforms.AsMask;
                if (target == PlatformMask.None) target = s.Platforms.AsMask;
                var sent = sender.Send(target, due.Message, s.Platforms);
                SbBridge.Instance.LogInfo("[Loadout] TestTimedMessageNow: sent=" + sent + " text=" + (due.Message?.Length ?? 0) + "ch");
                Util.EventStats.Instance.Hit("timer.test", "TestTimedMessageNow");
                return (int)sent;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] TestTimedMessageNow: " + ex);
                try { SbBridge.Instance.LogError("[Loadout] TestTimedMessageNow failed: " + ex.Message); } catch { }
                return 0;
            }
        }

        // -------------------- Window openers --------------------

        public static bool IsOnboardingDone()
        {
            try { return SettingsManager.Instance.Current.OnboardingDone; }
            catch { return false; }
        }

        public static void OpenSettings()
        {
            try { LoadoutHost.OpenSettings(); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("[Loadout] OpenSettings: " + ex); }
        }

        public static void OpenOnboarding()
        {
            try { LoadoutHost.OpenOnboarding(); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("[Loadout] OpenOnboarding: " + ex); }
        }

        // -------------------- Direct send (for ad-hoc actions) --------------------

        public static int Send(string message, int targetMaskInt)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                var target = targetMaskInt < 0 ? PlatformMask.All : (PlatformMask)targetMaskInt;
                var sender = new MultiPlatformSender(CphPlatformSender.Instance);
                return (int)sender.Send(target, message, s.Platforms);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Send: " + ex);
                return 0;
            }
        }

        // -------------------- Identity linking --------------------

        public static string RequestLink(string srcPlatform, string srcUser,
                                         string dstPlatform, string dstUser)
        {
            try
            {
                var src = PlatformMaskExtensions.FromShortName(srcPlatform);
                var dst = PlatformMaskExtensions.FromShortName(dstPlatform);
                if (src == PlatformMask.None || dst == PlatformMask.None) return "";
                if (string.IsNullOrWhiteSpace(srcUser) || string.IsNullOrWhiteSpace(dstUser)) return "";
                var req = IdentityLinker.Instance.RequestLink(src, srcUser, dst, dstUser);
                return req.Id;
            }
            catch { return ""; }
        }

        public static bool ApproveLink(string requestId, string approver)
        {
            try { return IdentityLinker.Instance.Approve(requestId, approver); }
            catch { return false; }
        }

        public static bool DenyLink(string requestId, string denier)
        {
            try { return IdentityLinker.Instance.Deny(requestId, denier); }
            catch { return false; }
        }

        public static string Version()
        {
            try { return SettingsManager.Instance.Current.SuiteVersion ?? "0.0.0"; }
            catch { return "0.0.0"; }
        }

        public static string SettingsPath()
        {
            try { return SettingsManager.Instance.SettingsPath ?? ""; }
            catch 