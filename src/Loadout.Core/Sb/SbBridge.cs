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
