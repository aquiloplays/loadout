using System;
using System.Reflection;
using Loadout.Settings;

namespace Loadout.Platforms
{
    /// <summary>
    /// Reflective bridge to Streamer.bot's CPH host. We can't reference CPH directly
    /// from a class library, so this binds dynamically to whatever CPH instance the
    /// inline-C# action passes in via <see cref="Bind"/>.
    ///
    /// Why reflection: CPH is an opaque host object provided by Streamer.bot's inline
    /// C# runtime. Linking against it would couple the DLL to a specific SB version.
    /// Reflection lets the same DLL ship across SB versions as long as method names
    /// stay stable.
    /// </summary>
    public sealed class CphPlatformSender : IPlatformSender
    {
        private static CphPlatformSender _instance;
        public static CphPlatformSender Instance => _instance ?? (_instance = new CphPlatformSender());

        private object _cph;

        public void Bind(object cphInstance)
        {
            _cph = cphInstance;
        }

        public bool IsConnected(PlatformMask platform)
        {
            // Optimistic: assume true if CPH is bound. SB exposes IsTwitchConnected /
            // IsYouTubeConnected etc. on newer versions; older versions don't.
            // We probe via reflection and fall back to true.
            if (_cph == null) return false;
            var method = platform switch
            {
                PlatformMask.Twitch  => "IsTwitchConnected",
                PlatformMask.YouTube => "IsYouTubeConnected",
                _                    => null
            };
            if (method == null) return true;
            try
            {
                var mi = _cph.GetType().GetMethod(method, BindingFlags.Public | BindingFlags.Instance);
                if (mi == null) return true;
                var result = mi.Invoke(_cph, null);
                return result is bool b && b;
            }
            catch { return true; }
        }

        public void Send(PlatformMask platform, string message)
        {
            if (_cph == null || string.IsNullOrEmpty(message)) return;

            // TikTok has no native CPH send method. Route through a
            // Streamer.bot action the user (or TikFinity) registers, with
            // the message handed off via a global var.
            if (platform == PlatformMask.TikTok)
            {
                SendViaTikTokAction(message);
                return;
            }

            var method = platform switch
            {
                PlatformMask.Twitch  => "SendMessage",
                PlatformMask.YouTube => "SendYouTubeMessage",
                PlatformMask.Kick    => "KickSendMessage",
                _                    => null
            };
            if (method == null) return;
            try
            {
                var mi = _cph.GetType().GetMethod(method, BindingFlags.Public | BindingFlags.Instance);
                if (mi == null) return;

                // SendMessage signatures vary by SB version: (string), (string, bool), (string, bool, bool).
                // We try the simplest first.
                var parameters = mi.GetParameters();
                object[] args = parameters.Length switch
                {
                    1 => new object[] { message },
                    2 => new object[] { message, false },
                    3 => new object[] { message, false, false },
                    _ => null
                };
                if (args != null) mi.Invoke(_cph, args);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Send failed on " + platform + ": " + ex.Message);
            }
        }

        /// <summary>
        /// Reflectively calls CPH.TwitchGetRewards and returns the titles of
        /// every channel-point reward currently configured on the streamer's
        /// Twitch channel. Returns an empty list on any failure (CPH not
        /// bound, Twitch not connected, method missing on this SB version).
        /// </summary>
        public System.Collections.Generic.List<string> GetTwitchRewardTitles()
        {
            var result = new System.Collections.Generic.List<string>();
            if (_cph == null) return result;
            try
            {
                var mi = _cph.GetType().GetMethod("TwitchGetRewards",
                    BindingFlags.Public | BindingFlags.Instance);
                if (mi == null) return result;
                var rewards = mi.Invoke(_cph, null) as System.Collections.IEnumerable;
                if (rewards == null) return result;
                foreach (var r in rewards)
                {
                    if (r == null) continue;
                    var titleProp = r.GetType().GetProperty("Title");
                    var title = titleProp?.GetValue(r) as string;
                    if (!string.IsNullOrWhiteSpace(title)) result.Add(title);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] TwitchGetRewards failed: " + ex.Message);
            }
            return result;
        }

        private void SendViaTikTokAction(string message)
        {
            var actionName = SettingsManager.Instance.Current.Platforms?.TikTokSendActionName;
            if (string.IsNullOrWhiteSpace(actionName)) return;   // not configured

            try
            {
                var t = _cph.GetType();

                // Hand the message to the SB action via a CPH global var.
                // Action picks it up with %loadoutTikTokMessage% / args.
                var setMi = t.GetMethod("SetGlobalVar",
                    new[] { typeof(string), typeof(object), typeof(bool) });
                if (setMi != null)
                    setMi.Invoke(_cph, new object[] { "loadoutTikTokMessage", message, false });
                else
                {
                    var setMi2 = t.GetMethod("SetGlobalVar",
                        new[] { typeof(string), typeof(object) });
                    setMi2?.Invoke(_cph, new object[] { "loadoutTikTokMessage", message });
                }

                // Trigger the action. RunAction signatures: (name) or (name, bool runImmediately).
                var runMi = t.GetMethod("RunAction",
                    new[] { typeof(string), typeof(bool) });
                if (runMi != null)
                {
                    runMi.Invoke(_cph, new object[] { actionName, false });
                    return;
                }
                var runMi1 = t.GetMethod("RunAction", new[] { typeof(string) });
                runMi1?.Invoke(_cph, new object[] { actionName });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] TikTok action invoke failed: " + ex.Message);
            }
        }
    }
}
