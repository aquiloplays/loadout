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
            var method = platform switch
            {
                PlatformMask.Twitch  => "SendMessage",
                PlatformMask.YouTube => "SendYouTubeMessage",
                PlatformMask.Kick    => "KickSendMessage",
                // TikTok is read-only on TikFinity — sending happens on Twitch/YT mirror or overlay.
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
    }
}
