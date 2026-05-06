using System;
using System.Collections.Generic;
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

                SbBridge.Instance.LogInfo("[Loadout] Booted. Settings: " + SettingsManager.Instance.SettingsPath);

                if (!SettingsManager.Instance.Current.OnboardingDone)
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
            catch { return ""; }
        }

        // -------------------- Patreon --------------------

        public static string PatreonTier()
        {
            try { return Patreon.Entitlements.CurrentTierDisplay(); }
            catch { return "Free"; }
        }

        public static bool PatreonStartSignIn()
        {
            try
            {
                _ = Patreon.PatreonClient.Instance.StartSignInAsync();
                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] PatreonStartSignIn: " + ex);
                return false;
            }
        }

        public static bool PatreonSignOut()
        {
            try { Patreon.PatreonClient.Instance.SignOut(); return true; }
            catch { return false; }
        }

        // -------------------- Quiet mode --------------------

        public static bool ToggleQuiet()
        {
            try
            {
                bool now = false;
                SettingsManager.Instance.Mutate(s =>
                {
                    s.ChatNoise.QuietMode = !s.ChatNoise.QuietMode;
                    now = s.ChatNoise.QuietMode;
                });
                SettingsManager.Instance.SaveNow();
                return now;
            }
            catch { return false; }
        }

        public static bool IsQuiet()
        {
            try { return SettingsManager.Instance.Current.ChatNoise.QuietMode; }
            catch { return false; }
        }

        /// <summary>
        /// Force a reload from disk so a hand-edited settings.json takes effect
        /// without restarting Streamer.bot. Same effect as restarting SB but
        /// without the disconnect.
        /// </summary>
        public static bool ReloadSettings()
        {
            try
            {
                var folder = SettingsManager.Instance.DataFolder;
                SettingsManager.Instance.SaveNow();        // flush any pending writes first
                SettingsManager.Instance.Initialize(folder); // re-read from disk
                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] ReloadSettings: " + ex);
                return false;
            }
        }
    }
}
