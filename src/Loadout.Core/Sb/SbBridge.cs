using System;
using System.Collections.Generic;
using System.Reflection;
using Loadout.Settings;

namespace Loadout.Sb
{
    /// <summary>
    /// Wraps the opaque CPH host object that Streamer.bot's inline-C# runtime hands
    /// us. We reach into it reflectively for two reasons:
    ///   1. The DLL ships with no compile-time reference to SB internals — that
    ///      lets the same DLL work across SB versions where method shapes shift.
    ///   2. The user never has to add anything to an action's References tab.
    ///
    /// All public methods here swallow exceptions and log to Debug — a single
    /// reflection failure must never propagate up and cancel a chat alert.
    /// </summary>
    public sealed class SbBridge
    {
        private static readonly SbBridge _instance = new SbBridge();
        public static SbBridge Instance => _instance;

        private object _cph;
        private Type _cphType;

        public bool IsBound => _cph != null;

        public void Bind(object cph)
        {
            _cph = cph;
            _cphType = cph?.GetType();
        }

        // -------------------- Logging --------------------

        public void LogInfo(string msg)  => InvokeIgnore("LogInfo",  msg);
        public void LogWarn(string msg)  => InvokeIgnore("LogWarn",  msg);
        public void LogError(string msg) => InvokeIgnore("LogError", msg);
        public void LogDebug(string msg) => InvokeIgnore("LogDebug", msg);

        // -------------------- Chat sending --------------------

        public void SendTwitch(string message)
        {
            if (string.IsNullOrEmpty(message)) return;
            InvokeFlexible("SendMessage", new object[] { message });
        }

        public void SendYouTube(string message)
        {
            if (string.IsNullOrEmpty(message)) return;
            InvokeFlexible("SendYouTubeMessage", new object[] { message });
        }

        public void SendKick(string message)
        {
            if (string.IsNullOrEmpty(message)) return;
            InvokeFlexible("KickSendMessage", new object[] { message });
        }

        public void Send(PlatformMask platform, string message)
        {
            switch (platform)
            {
                case PlatformMask.Twitch:  SendTwitch(message);  return;
                case PlatformMask.YouTube: SendYouTube(message); return;
                case PlatformMask.Kick:    SendKick(message);    return;
                // TikTok via TikFinity is read-only; outbound goes via mirror channels.
            }
        }

        // -------------------- Connection probes --------------------

        public bool IsTwitchConnected()  => InvokeBool("IsTwitchConnected", true);
        public bool IsYouTubeConnected() => InvokeBool("IsYouTubeConnected", true);
        public bool IsKickConnected()    => InvokeBool("IsKickConnected", true);

        // -------------------- Globals (cross-action storage) --------------------

        public T GetGlobal<T>(string key, T fallback = default)
        {
            if (_cph == null) return fallback;
            try
            {
                var mi = _cphType.GetMethod("GetGlobalVar", new[] { typeof(string), typeof(bool) });
                if (mi == null) return fallback;
                var generic = mi.MakeGenericMethod(typeof(T));
                var result = generic.Invoke(_cph, new object[] { key, true });
                return result is T t ? t : fallback;
            }
            catch { return fallback; }
        }

        public void SetGlobal(string key, object value, bool persisted = true)
        {
            if (_cph == null) return;
            try
            {
                var mi = _cphType.GetMethod("SetGlobalVar", new[] { typeof(string), typeof(object), typeof(bool) });
                mi?.Invoke(_cph, new object[] { key, value, persisted });
            }
            catch { /* swallow */ }
        }

        // -------------------- Twitch clips --------------------

        /// <summary>
        /// Creates a Twitch clip via CPH and returns the public URL, or null
        /// if the clip couldn't be made (channel offline, no Twitch auth,
        /// rate-limited, etc.). Tries multiple method names + signatures
        /// since SB has shifted them across versions:
        ///   - TwitchClipCreate(useBotAccount, hasDelay)        - newer
        ///   - TwitchCreateClip(useBotAccount, hasDelay)        - older
        ///   - TwitchCreateClip()                                - very old
        /// The returned object has been .Url, .EditUrl, .url depending on
        /// version; we read whichever is non-null.
        /// </summary>
        public string CreateTwitchClip(bool useBotAccount, bool hasDelay)
        {
            if (_cph == null) return null;
            try
            {
                // Probe candidate method names in order of likelihood.
                MethodInfo mi = null;
                string[] candidates = { "TwitchClipCreate", "TwitchCreateClip", "CreateTwitchClip" };
                foreach (var name in candidates)
                {
                    foreach (var m in _cphType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                    {
                        if (m.Name == name) { mi = m; break; }
                    }
                    if (mi != null) break;
                }
                if (mi == null) return null;

                var pars = mi.GetParameters();
                object[] callArgs;
                if (pars.Length == 0)      callArgs = new object[0];
                else if (pars.Length == 1) callArgs = new object[] { useBotAccount };
                else if (pars.Length == 2) callArgs = new object[] { useBotAccount, hasDelay };
                else                       callArgs = new object[pars.Length]; // best effort

                var result = mi.Invoke(_cph, callArgs);
                if (result == null) return null;
                // Result is a ClipData-like POCO; pull whichever URL field exists.
                var rt = result.GetType();
                foreach (var pn in new[] { "Url", "url", "ClipUrl", "EditUrl" })
                {
                    var p = rt.GetProperty(pn, BindingFlags.Public | BindingFlags.Instance);
                    if (p != null)
                    {
                        var v = p.GetValue(result, null) as string;
                        if (!string.IsNullOrEmpty(v)) return v;
                    }
                }
                // Some versions return the raw URL string directly.
                if (result is string s) return s;
                return null;
            }
            catch
            {
                return null;
            }
        }

        // -------------------- Twitch user lookup --------------------

        /// <summary>
        /// Reflective call to SB's CPH.TwitchGetExtendedUserInfoByLogin so
        /// !accountage can read the chatter's account-creation date. CPH
        /// chat events don't carry this field — it has to come from a
        /// Helix lookup, and SB exposes the helper natively. Falls through
        /// to TwitchGetUserInfoByLogin if the extended variant isn't on
        /// this SB version.
        /// </summary>
        public DateTime? GetTwitchUserCreatedUtc(string login)
        {
            if (_cph == null || string.IsNullOrEmpty(login)) return null;
            try
            {
                var mi = FindMethodByName("TwitchGetExtendedUserInfoByLogin")
                      ?? FindMethodByName("TwitchGetUserInfoByLogin");
                if (mi == null) return null;
                var result = mi.Invoke(_cph, new object[] { login });
                if (result == null) return null;
                var t = result.GetType();
                // Different CPH versions name this property created_at,
                // CreatedAt, or createdAt. Try them all.
                var prop = t.GetProperty("created_at") ?? t.GetProperty("CreatedAt") ?? t.GetProperty("createdAt");
                if (prop == null) return null;
                var v = prop.GetValue(result);
                if (v is DateTime dt) return DateTime.SpecifyKind(dt, DateTimeKind.Utc);
                if (v is string s && DateTime.TryParse(s, out var ds)) return DateTime.SpecifyKind(ds.ToUniversalTime(), DateTimeKind.Utc);
                return null;
            }
            catch { return null; }
        }

        /// <summary>
        /// Returns the Twitch profile picture URL for a given login, via
        /// the same reflective CPH call as <see cref="GetTwitchUserCreatedUtc"/>.
        /// Used by Settings test buttons so a check-in preview shows the
        /// streamer's actual face instead of a generic letter circle.
        /// Returns null if CPH isn't bound or the user doesn't exist.
        /// </summary>
        public string GetTwitchProfilePicture(string login)
        {
            if (_cph == null || string.IsNullOrEmpty(login)) return null;
            try
            {
                var mi = FindMethodByName("TwitchGetExtendedUserInfoByLogin")
                      ?? FindMethodByName("TwitchGetUserInfoByLogin");
                if (mi == null) return null;
                var result = mi.Invoke(_cph, new object[] { login });
                if (result == null) return null;
                var t = result.GetType();
                // Same property-name fan-out as the created_at lookup —
                // CPH's casing varies across SB versions.
                var prop = t.GetProperty("profile_image_url")
                        ?? t.GetProperty("ProfileImageUrl")
                        ?? t.GetProperty("profileImageUrl");
                if (prop == null) return null;
                return prop.GetValue(result) as string;
            }
            catch { return null; }
        }

        // -------------------- Action dispatch --------------------

        public bool RunAction(string actionName)
        {
            if (_cph == null || string.IsNullOrEmpty(actionName)) return false;
            try
            {
                var mi = _cphType.GetMethod("RunAction", new[] { typeof(string) });
                if (mi == null) return false;
                var result = mi.Invoke(_cph, new object[] { actionName });
                return result is bool b && b;
            }
            catch { return false; }
        }

        /// <summary>
        /// Create a Twitch channel-point reward via whatever creation
        /// method this SB version exposes. Returns null on success,
        /// the sentinel "not-supported" when no creation method exists
        /// on this CPH build, or an error message otherwise.
        ///
        /// Note: rewards created through SB's app credentials are the
        /// only ones SB can later update/pause — which is exactly what
        /// we want for Game Interactions triggers.
        /// </summary>
        public string TwitchCreateReward(string title, int cost, string prompt)
        {
            if (_cph == null) return "Streamer.bot not bound — run the Loadout: Boot action first";
            if (string.IsNullOrWhiteSpace(title)) return "empty reward title";
            var candidates = new[]
            {
                "TwitchCreateReward",
                "TwitchCreateCustomReward",
                "CreateCustomReward",
                "CreateReward"
            };
            foreach (var name in candidates)
            {
                // Richest signature first so prompt text lands when supported.
                var mi4 = _cphType.GetMethod(name, new[] { typeof(string), typeof(int), typeof(string), typeof(bool) });
                if (mi4 != null)
                {
                    try { mi4.Invoke(_cph, new object[] { title, cost, prompt ?? "", true }); return null; }
                    catch (Exception ex) { return Unwrap(ex); }
                }
                var mi3 = _cphType.GetMethod(name, new[] { typeof(string), typeof(int), typeof(string) });
                if (mi3 != null)
                {
                    try { mi3.Invoke(_cph, new object[] { title, cost, prompt ?? "" }); return null; }
                    catch (Exception ex) { return Unwrap(ex); }
                }
                var mi2 = _cphType.GetMethod(name, new[] { typeof(string), typeof(int) });
                if (mi2 != null)
                {
                    try { mi2.Invoke(_cph, new object[] { title, cost }); return null; }
                    catch (Exception ex) { return Unwrap(ex); }
                }
            }
            return "not-supported";
        }

        private static string Unwrap(Exception ex)
            => (ex is System.Reflection.TargetInvocationException tie ? tie.InnerException ?? tie : ex).Message;

        /// <summary>
        /// Names of every action defined in Streamer.bot, sorted. Empty
        /// list when CPH isn't bound or this SB version lacks
        /// GetActions(). Used by the OBS dock's run-action autocomplete.
        /// </summary>
        public System.Collections.Generic.List<string> GetActionNames()
        {
            var result = new System.Collections.Generic.List<string>();
            if (_cph == null) return result;
            try
            {
                var mi = _cphType.GetMethod("GetActions", Type.EmptyTypes);
                if (mi == null) return result;
                var actions = mi.Invoke(_cph, null) as System.Collections.IEnumerable;
                if (actions == null) return result;
                foreach (var a in actions)
                {
                    if (a == null) continue;
                    var nameProp = a.GetType().GetProperty("Name");
                    var name = nameProp?.GetValue(a) as string;
                    if (!string.IsNullOrWhiteSpace(name)) result.Add(name);
                }
                result.Sort(StringComparer.OrdinalIgnoreCase);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] GetActions failed: " + ex.Message);
            }
            return result;
        }

        /// <summary>Switch the active scene on the configured OBS
        /// connection (0 = primary). Returns false if CPH isn't bound
        /// or the host doesn't expose ObsSetScene on this version.</summary>
        public bool ObsSetScene(string sceneName, int connection = 0)
        {
            if (_cph == null || string.IsNullOrEmpty(sceneName)) return false;
            try
            {
                // CPH.ObsSetScene has signatures (string), (string, int).
                var mi2 = _cphType.GetMethod("ObsSetScene", new[] { typeof(string), typeof(int) });
                if (mi2 != null) { mi2.Invoke(_cph, new object[] { sceneName, connection }); return true; }
                var mi1 = _cphType.GetMethod("ObsSetScene", new[] { typeof(string) });
                if (mi1 != null) { mi1.Invoke(_cph, new object[] { sceneName }); return true; }
                return false;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] ObsSetScene failed: " + ex.Message);
                return false;
            }
        }

        /// <summary>Toggle a source's visibility on a given scene. When
        /// <paramref name="visible"/> is null, toggles the current value.</summary>
        public bool ObsSetSourceVisibility(string scene, string source, bool? visible, int connection = 0)
        {
            if (_cph == null || string.IsNullOrEmpty(scene) || string.IsNullOrEmpty(source)) return false;
            try
            {
                // Prefer the explicit setter when a value is supplied;
                // toggle via the host's own ObsSourceToggle when null.
                if (visible.HasValue)
                {
                    var mi = _cphType.GetMethod("ObsSetSourceVisibility",
                        new[] { typeof(string), typeof(string), typeof(bool), typeof(int) });
                    if (mi != null)
                    { mi.Invoke(_cph, new object[] { scene, source, visible.Value, connection }); return true; }
                    var mi3 = _cphType.GetMethod("ObsSetSourceVisibility",
                        new[] { typeof(string), typeof(string), typeof(bool) });
                    if (mi3 != null)
                    { mi3.Invoke(_cph, new object[] { scene, source, visible.Value }); return true; }
                }
                else
                {
                    var miT = _cphType.GetMethod("ObsSourceToggle",
                        new[] { typeof(string), typeof(string), typeof(int) });
                    if (miT != null)
                    { miT.Invoke(_cph, new object[] { scene, source, connection }); return true; }
                    var miT2 = _cphType.GetMethod("ObsSourceToggle",
                        new[] { typeof(string), typeof(string) });
                    if (miT2 != null)
                    { miT2.Invoke(_cph, new object[] { scene, source }); return true; }
                }
                return false;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] ObsSetSourceVisibility failed: " + ex.Message);
                return false;
            }
        }

        // -------------------- Internal helpers --------------------

        private bool InvokeBool(string method, bool fallback)
        {
            if (_cph == null) return fallback;
            try
            {
                var mi = _cphType.GetMethod(method, BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null);
                if (mi == null) return fallback;
                return mi.Invoke(_cph, null) is bool b ? b : fallback;
            }
            catch { return fallback; }
        }

        private void InvokeIgnore(string method, params object[] args)
        {
            if (_cph == null) return;
            try
            {
                var types = new Type[args.Length];
                for (int i = 0; i < args.Length; i++) types[i] = args[i]?.GetType() ?? typeof(object);
                var mi = _cphType.GetMethod(method, types) ?? FindMethodByName(method);
                mi?.Invoke(_cph, args);
            }
            catch { /* swallow */ }
        }

        /// <summary>
        /// Some CPH versions overload Send / SendMessage with extra optional args
        /// (broadcast, useBot). We try the simplest signature that fits.
        /// </summary>
        private void InvokeFlexible(string method, object[] singleArgPair)
        {
            if (_cph == null) return;
            try
            {
                var mi = FindMethodByName(method);
                if (mi == null) return;
                var parameters = mi.GetParameters();
                object[] callArgs;
                if (parameters.Length == 1) callArgs = singleArgPair;
                else if (parameters.Length == 2) callArgs = new[] { singleArgPair[0], (object)false };
                else if (parameters.Length == 3) callArgs = new[] { singleArgPair[0], (object)false, (object)false };
                else return;
                mi.Invoke(_cph, callArgs);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Loadout] {method} failed: {ex.Message}");
            }
        }

        private MethodInfo FindMethodByName(string method)
        {
            if (_cphType == null) return null;
            foreach (var mi in _cphType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                if (mi.Name == method) return mi;
            return null;
        }
    }
}
