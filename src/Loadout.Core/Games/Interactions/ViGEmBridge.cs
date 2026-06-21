using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;

namespace Loadout.Games.Interactions
{
    /// <summary>
    /// Optional bridge to ViGEm Bus (a virtual-gamepad driver). Loaded
    /// reflectively because most Loadout users don't need this — the
    /// dependency is heavy (kernel-mode driver MSI + .NET wrapper lib)
    /// and a hard reference would crash every install without it.
    ///
    /// Two failure modes, both handled gracefully:
    ///   1. Lib missing — Nefarius.ViGEm.Client.dll not next to our DLL.
    ///      <see cref="IsAvailable"/> returns false; controller actions
    ///      no-op + log.
    ///   2. Driver missing — lib loads but the bus connection throws.
    ///      Same outcome; <see cref="LastErrorMessage"/> carries the
    ///      detail so the Settings UI can show "Driver not installed".
    ///
    /// Streamer setup:
    ///   - Install the ViGEm Bus Driver MSI from
    ///     https://github.com/nefarius/ViGEmBus/releases
    ///   - Download Nefarius.ViGEm.Client.dll (NuGet, .NET 4.8 target)
    ///     and drop it in %APPDATA%\Loadout\ next to settings.json
    ///   - Restart Streamer.bot; Loadout will pick the lib up via the
    ///     AssemblyResolve hook below.
    ///
    /// We poll the public API of the wrapper via reflection so the
    /// build doesn't bind a version. Tested against Nefarius.ViGEm.Client
    /// 1.21.x; should keep working across patch versions since the
    /// CreateXbox360Controller / Connect / SetButtonState shape is stable.
    /// </summary>
    public static class ViGEmBridge
    {
        // Cached state. _initialized=true means we've tried once; later
        // calls just observe IsAvailable / LastErrorMessage.
        private static bool   _initialized;
        private static bool   _available;
        private static string _lastError = "";
        private static object _client;          // IViGEmClient
        private static object _x360Controller;  // IXbox360Controller
        private static readonly object _gate = new object();

        // Reflection handles cached on first successful load.
        private static MethodInfo _miSetButtonState;       // (button, isPressed)
        private static MethodInfo _miSetAxisValue;         // (axis, short)
        private static MethodInfo _miSetSliderValue;       // (slider, byte)
        private static Type _btnEnumType;
        private static Type _axisEnumType;
        private static Type _sliderEnumType;

        public static bool   IsAvailable     { get { lock (_gate) return _available; } }
        public static string LastErrorMessage { get { lock (_gate) return _lastError ?? ""; } }
        /// <summary>"lib-missing" / "driver-missing" / "ok" / "init-not-tried".</summary>
        public static string Status
        {
            get
            {
                lock (_gate)
                {
                    if (!_initialized) return "init-not-tried";
                    if (_available)    return "ok";
                    var le = (_lastError ?? "").ToLowerInvariant();
                    if (le.Contains("could not load") ||
                        le.Contains("file not found") ||
                        le.Contains("loadfile"))
                        return "lib-missing";
                    return "driver-missing";
                }
            }
        }

        /// <summary>One-shot init. Re-callable as a no-op after the
        /// first attempt; call <see cref="Reset"/> if the user dropped
        /// the lib in or installed the driver mid-session.</summary>
        public static bool Initialize()
        {
            lock (_gate)
            {
                if (_initialized) return _available;
                _initialized = true;
                try
                {
                    // 1. Hook AssemblyResolve so when we ask for the
                    //    Nefarius.ViGEm.Client type, .NET checks our
                    //    data folder before throwing.
                    AppDomain.CurrentDomain.AssemblyResolve -= OnAssemblyResolve;
                    AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;

                    // 2. Try to load the assembly.
                    var asm = LoadViGEmAssembly();
                    if (asm == null)
                    {
                        _lastError = "Nefarius.ViGEm.Client.dll not found. Drop it in " +
                            Settings.SettingsManager.Instance.DataFolder +
                            " or alongside Loadout.dll, then restart Streamer.bot.";
                        return false;
                    }

                    var clientType = asm.GetType("Nefarius.ViGEm.Client.ViGEmClient")
                                  ?? asm.GetType("Nefarius.ViGEm.Client.ViGEmTarget");
                    if (clientType == null)
                    {
                        _lastError = "Loaded the wrapper DLL but ViGEmClient type wasn't found — wrong/unsupported version?";
                        return false;
                    }

                    // 3. Instantiate the bus client. This is the call
                    //    that fails when the kernel driver isn't
                    //    installed — we catch + report.
                    _client = Activator.CreateInstance(clientType);

                    // 4. Create the default Xbox 360 controller and connect.
                    var createMi = clientType.GetMethod("CreateXbox360Controller", Type.EmptyTypes);
                    if (createMi == null)
                    {
                        _lastError = "CreateXbox360Controller not found on ViGEmClient";
                        return false;
                    }
                    _x360Controller = createMi.Invoke(_client, null);
                    var connectMi = _x360Controller.GetType()
                        .GetMethod("Connect", BindingFlags.Public | BindingFlags.Instance);
                    if (connectMi == null)
                    {
                        _lastError = "Connect not found on Xbox360Controller";
                        return false;
                    }
                    connectMi.Invoke(_x360Controller, null);

                    // 5. Resolve the method handles we'll reuse hot-path.
                    var ctrlType = _x360Controller.GetType();
                    _btnEnumType    = asm.GetType("Nefarius.ViGEm.Client.Targets.Xbox360.Xbox360Button");
                    _axisEnumType   = asm.GetType("Nefarius.ViGEm.Client.Targets.Xbox360.Xbox360Axis");
                    _sliderEnumType = asm.GetType("Nefarius.ViGEm.Client.Targets.Xbox360.Xbox360Slider");
                    _miSetButtonState = FindMethod(ctrlType, "SetButtonState", _btnEnumType,    typeof(bool));
                    _miSetAxisValue   = FindMethod(ctrlType, "SetAxisValue",    _axisEnumType,   typeof(short));
                    _miSetSliderValue = FindMethod(ctrlType, "SetSliderValue",  _sliderEnumType, typeof(byte));

                    _available = _miSetButtonState != null;
                    if (!_available)
                        _lastError = "Wrapper loaded but Xbox360Controller method shapes don't match the expected v1.x layout.";

                    return _available;
                }
                catch (TargetInvocationException tie)
                {
                    _lastError = (tie.InnerException ?? tie).Message;
                    return false;
                }
                catch (Exception ex)
                {
                    _lastError = ex.Message;
                    return false;
                }
            }
        }

        public static void Reset()
        {
            lock (_gate)
            {
                Disconnect();
                _initialized = false; _available = false; _lastError = "";
                _client = null; _x360Controller = null;
                _miSetButtonState = _miSetAxisValue = _miSetSliderValue = null;
                _btnEnumType = _axisEnumType = _sliderEnumType = null;
            }
        }

        public static void Disconnect()
        {
            lock (_gate)
            {
                if (_x360Controller != null)
                {
                    try
                    {
                        var mi = _x360Controller.GetType().GetMethod("Disconnect", Type.EmptyTypes);
                        mi?.Invoke(_x360Controller, null);
                    }
                    catch { }
                }
                if (_client is IDisposable d)
                {
                    try { d.Dispose(); } catch { }
                }
                _client = null; _x360Controller = null;
            }
        }

        /// <summary>Press a named button (A / B / X / Y / LB / RB / Back /
        /// Start / Up / Down / Left / Right / LeftThumb / RightThumb)
        /// for <paramref name="holdMs"/> ms then release.</summary>
        public static bool TapButton(string buttonName, int holdMs = 50)
        {
            if (!Initialize()) return false;
            var btn = ResolveButton(buttonName);
            if (btn == null) return false;
            try
            {
                _miSetButtonState.Invoke(_x360Controller, new[] { btn, (object)true });
                if (holdMs > 0) Thread.Sleep(holdMs);
                _miSetButtonState.Invoke(_x360Controller, new[] { btn, (object)false });
                return true;
            }
            catch (Exception ex) { lock (_gate) _lastError = ex.Message; return false; }
        }

        /// <summary>Move a stick to (x, y) in the -1..1 range, hold for
        /// <paramref name="holdMs"/>, then re-center. "L" or "R".</summary>
        public static bool MoveStick(string stick, double x, double y, int holdMs = 250)
        {
            if (!Initialize() || _miSetAxisValue == null) return false;
            var s = (stick ?? "").ToUpperInvariant();
            string xName = s == "R" ? "RightThumbX" : "LeftThumbX";
            string yName = s == "R" ? "RightThumbY" : "LeftThumbY";
            var xAxis = ResolveAxis(xName);
            var yAxis = ResolveAxis(yName);
            if (xAxis == null || yAxis == null) return false;
            short xi = (short)Math.Round(Math.Max(-1, Math.Min(1, x)) * 32767);
            short yi = (short)Math.Round(Math.Max(-1, Math.Min(1, y)) * 32767);
            try
            {
                _miSetAxisValue.Invoke(_x360Controller, new[] { xAxis, (object)xi });
                _miSetAxisValue.Invoke(_x360Controller, new[] { yAxis, (object)yi });
                if (holdMs > 0) Thread.Sleep(holdMs);
                _miSetAxisValue.Invoke(_x360Controller, new[] { xAxis, (object)(short)0 });
                _miSetAxisValue.Invoke(_x360Controller, new[] { yAxis, (object)(short)0 });
                return true;
            }
            catch (Exception ex) { lock (_gate) _lastError = ex.Message; return false; }
        }

        /// <summary>Pull a trigger (LT / RT) to <paramref name="value"/>
        /// (0..255), hold, then release.</summary>
        public static bool PullTrigger(string trigger, byte value, int holdMs = 200)
        {
            if (!Initialize() || _miSetSliderValue == null) return false;
            var t = (trigger ?? "").ToUpperInvariant();
            string sliderName = t == "RT" ? "RightTrigger" : "LeftTrigger";
            var slider = ResolveSlider(sliderName);
            if (slider == null) return false;
            try
            {
                _miSetSliderValue.Invoke(_x360Controller, new[] { slider, (object)value });
                if (holdMs > 0) Thread.Sleep(holdMs);
                _miSetSliderValue.Invoke(_x360Controller, new[] { slider, (object)(byte)0 });
                return true;
            }
            catch (Exception ex) { lock (_gate) _lastError = ex.Message; return false; }
        }

        // --- Reflection helpers ---------------------------------------

        private static MethodInfo FindMethod(Type owner, string name, Type a, Type b)
        {
            if (owner == null || a == null || b == null) return null;
            foreach (var mi in owner.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (mi.Name != name) continue;
                var ps = mi.GetParameters();
                if (ps.Length == 2 && ps[0].ParameterType == a && ps[1].ParameterType == b) return mi;
            }
            return null;
        }

        // Xbox360Button enum reachable as static properties (modern wrapper)
        // OR enum values (older wrapper). Try property first.
        private static object ResolveButton(string name)
        {
            if (_btnEnumType == null) return null;
            var canonical = NormalizeButton(name);
            var prop = _btnEnumType.GetProperty(canonical,
                BindingFlags.Public | BindingFlags.Static);
            if (prop != null) return prop.GetValue(null);
            try { return Enum.Parse(_btnEnumType, canonical, ignoreCase: true); }
            catch { return null; }
        }
        private static object ResolveAxis(string name)
        {
            if (_axisEnumType == null) return null;
            var prop = _axisEnumType.GetProperty(name, BindingFlags.Public | BindingFlags.Static);
            if (prop != null) return prop.GetValue(null);
            try { return Enum.Parse(_axisEnumType, name, ignoreCase: true); }
            catch { return null; }
        }
        private static object ResolveSlider(string name)
        {
            if (_sliderEnumType == null) return null;
            var prop = _sliderEnumType.GetProperty(name, BindingFlags.Public | BindingFlags.Static);
            if (prop != null) return prop.GetValue(null);
            try { return Enum.Parse(_sliderEnumType, name, ignoreCase: true); }
            catch { return null; }
        }

        // Friendly name → wrapper's canonical capitalization.
        private static string NormalizeButton(string n)
        {
            switch ((n ?? "").Trim().ToUpperInvariant())
            {
                case "A":          return "A";
                case "B":          return "B";
                case "X":          return "X";
                case "Y":          return "Y";
                case "LB":
                case "LEFTSHOULDER":  return "LeftShoulder";
                case "RB":
                case "RIGHTSHOULDER": return "RightShoulder";
                case "BACK":          return "Back";
                case "START":         return "Start";
                case "LS":
                case "LEFTTHUMB":     return "LeftThumb";
                case "RS":
                case "RIGHTTHUMB":    return "RightThumb";
                case "UP":
                case "DPADUP":        return "Up";
                case "DOWN":
                case "DPADDOWN":      return "Down";
                case "LEFT":
                case "DPADLEFT":      return "Left";
                case "RIGHT":
                case "DPADRIGHT":     return "Right";
                case "GUIDE":
                case "XBOX":          return "Guide";
                default:              return n ?? "";
            }
        }

        // --- Assembly loading -----------------------------------------

        private static Assembly LoadViGEmAssembly()
        {
            // First search: same folder as Loadout.dll.
            var probed = new List<string>();
            var loadoutDll = typeof(ViGEmBridge).Assembly.Location;
            string dllDir = null;
            try { dllDir = Path.GetDirectoryName(loadoutDll); } catch { }
            if (!string.IsNullOrEmpty(dllDir))
                probed.Add(Path.Combine(dllDir, "Nefarius.ViGEm.Client.dll"));

            // Second search: %APPDATA%\Loadout\ (data folder)
            try
            {
                var data = Settings.SettingsManager.Instance.DataFolder;
                if (!string.IsNullOrEmpty(data))
                    probed.Add(Path.Combine(data, "Nefarius.ViGEm.Client.dll"));
            }
            catch { }

            foreach (var p in probed)
            {
                if (File.Exists(p))
                {
                    try { return Assembly.LoadFrom(p); }
                    catch (Exception ex) { _lastError = "Failed to load " + p + ": " + ex.Message; }
                }
            }
            return null;
        }

        // Lets the wrapper's own dependency assemblies resolve if a
        // streamer drops the whole NuGet payload (a few .deps) into
        // the data folder.
        private static Assembly OnAssemblyResolve(object sender, ResolveEventArgs args)
        {
            try
            {
                var simple = new AssemblyName(args.Name).Name;
                if (simple.IndexOf("ViGEm", StringComparison.OrdinalIgnoreCase) < 0) return null;
                var data = Settings.SettingsManager.Instance.DataFolder;
                if (string.IsNullOrEmpty(data)) return null;
                var candidate = Path.Combine(data, simple + ".dll");
                if (File.Exists(candidate)) return Assembly.LoadFrom(candidate);
            }
            catch { }
            return null;
        }
    }
}
