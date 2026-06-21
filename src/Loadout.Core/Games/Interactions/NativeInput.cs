using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Loadout.Games.Interactions
{
    /// <summary>
    /// Win32 SendInput wrapper for keyboard + mouse input. Targets
    /// whatever window has focus — same as a real keypress — so the
    /// caller is responsible for the foreground-window guard.
    ///
    /// Layered API:
    ///   KeyTap("W")                       — tap a single key, default hold
    ///   KeyCombo("Ctrl+S", holdMs)        — chord of modifiers + main key
    ///   MouseClick("left")                — click at current cursor
    ///   MouseMove(x, y, mode)             — relative / absolute / current
    ///   MouseScroll(delta)                — wheel notches (positive = up)
    ///
    /// All methods are synchronous + blocking for the hold duration.
    /// Callers wanting non-blocking behavior should Task.Run them.
    /// </summary>
    internal static class NativeInput
    {
        // --- P/Invoke shapes -----------------------------------------------

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public InputUnion U;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        private const uint INPUT_MOUSE    = 0;
        private const uint INPUT_KEYBOARD = 1;

        // Keyboard flags
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP       = 0x0002;
        private const uint KEYEVENTF_SCANCODE    = 0x0008;
        private const uint KEYEVENTF_UNICODE     = 0x0004;

        // Mouse flags
        private const uint MOUSEEVENTF_MOVE       = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP     = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;
        private const uint MOUSEEVENTF_WHEEL      = 0x0800;
        private const uint MOUSEEVENTF_ABSOLUTE   = 0x8000;
        private const int  WHEEL_DELTA            = 120;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int nIndex);
        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;

        // --- Public API ----------------------------------------------------

        /// <summary>Title of the currently-focused window. "" if none.</summary>
        public static string ForegroundWindowTitle()
        {
            try
            {
                var hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero) return "";
                var sb = new StringBuilder(512);
                int len = GetWindowText(hwnd, sb, sb.Capacity);
                return len > 0 ? sb.ToString() : "";
            }
            catch { return ""; }
        }

        /// <summary>Tap one key. <paramref name="holdMs"/> = how long
        /// before the key-up is sent.</summary>
        public static void KeyTap(string keyName, int holdMs = 50)
        {
            var vk = ParseKey(keyName);
            if (vk == 0) throw new ArgumentException("Unknown key: " + keyName);
            SendKey(vk, true);
            if (holdMs > 0) Thread.Sleep(holdMs);
            SendKey(vk, false);
        }

        /// <summary>Hold a combo of modifiers + a final key.
        /// e.g. KeyCombo("Ctrl+Shift+S", 50). Each part separated by '+'.</summary>
        public static void KeyCombo(string combo, int holdMs = 50)
        {
            var parts = SplitCombo(combo);
            if (parts.Count == 0) return;
            // Press modifiers first, then the final key.
            var mods  = new List<ushort>();
            ushort mainKey = 0;
            for (int i = 0; i < parts.Count; i++)
            {
                var vk = ParseKey(parts[i]);
                if (vk == 0) throw new ArgumentException("Unknown key in combo: " + parts[i]);
                if (i == parts.Count - 1) mainKey = vk;
                else mods.Add(vk);
            }
            foreach (var m in mods) SendKey(m, true);
            SendKey(mainKey, true);
            if (holdMs > 0) Thread.Sleep(holdMs);
            SendKey(mainKey, false);
            // Release modifiers in reverse order — matches what a real
            // user does and avoids ghost modifier sticks in some games.
            for (int i = mods.Count - 1; i >= 0; i--) SendKey(mods[i], false);
        }

        public static void MouseClick(string button = "left", int holdMs = 30)
        {
            uint downFlag, upFlag;
            switch ((button ?? "left").ToLowerInvariant())
            {
                case "right":  downFlag = MOUSEEVENTF_RIGHTDOWN;  upFlag = MOUSEEVENTF_RIGHTUP;  break;
                case "middle": downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; break;
                case "left":
                default:       downFlag = MOUSEEVENTF_LEFTDOWN;   upFlag = MOUSEEVENTF_LEFTUP;   break;
            }
            SendMouse(0, 0, 0, downFlag);
            if (holdMs > 0) Thread.Sleep(holdMs);
            SendMouse(0, 0, 0, upFlag);
        }

        /// <summary>
        /// Move the mouse cursor.
        ///   "relative" — by (x, y) pixels from current position
        ///   "absolute" — to (x, y) in screen pixels (translated to 0..65535)
        ///   "current"  — no-op (used when only a click is desired)
        /// </summary>
        public static void MouseMove(int x, int y, string mode = "relative")
        {
            var m = (mode ?? "relative").ToLowerInvariant();
            if (m == "current") return;
            if (m == "absolute")
            {
                int screenW = GetSystemMetrics(SM_CXSCREEN);
                int screenH = GetSystemMetrics(SM_CYSCREEN);
                if (screenW <= 0) screenW = 1920;
                if (screenH <= 0) screenH = 1080;
                int normX = (int)Math.Round(x * 65535.0 / screenW);
                int normY = (int)Math.Round(y * 65535.0 / screenH);
                SendMouse(normX, normY, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE);
            }
            else
            {
                SendMouse(x, y, 0, MOUSEEVENTF_MOVE);
            }
        }

        public static void MouseScroll(int notches)
        {
            // SendInput wheel data is in WHEEL_DELTA units (120 per notch).
            SendMouse(0, 0, (uint)(notches * WHEEL_DELTA), MOUSEEVENTF_WHEEL);
        }

        // --- Internals -----------------------------------------------------

        private static void SendKey(ushort vk, bool down)
        {
            var input = new INPUT { type = INPUT_KEYBOARD };
            input.U.ki = new KEYBDINPUT
            {
                wVk = vk,
                wScan = 0,
                dwFlags = down ? 0 : KEYEVENTF_KEYUP,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            };
            SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
        }

        private static void SendMouse(int dx, int dy, uint mouseData, uint flags)
        {
            var input = new INPUT { type = INPUT_MOUSE };
            input.U.mi = new MOUSEINPUT
            {
                dx = dx,
                dy = dy,
                mouseData = mouseData,
                dwFlags = flags,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            };
            SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
        }

        private static List<string> SplitCombo(string combo)
        {
            var result = new List<string>();
            if (string.IsNullOrWhiteSpace(combo)) return result;
            foreach (var p in combo.Split('+'))
            {
                var t = p.Trim();
                if (t.Length > 0) result.Add(t);
            }
            return result;
        }

        // Curated VK code table. Covers the keys streamers actually bind:
        // letters/digits, arrows, function keys, modifiers, common game
        // keys (space/shift/etc.), media keys. Anything not listed falls
        // through to OEM-1..8 / VK_ codes by exact name (e.g. "VK_OEM_3"
        // for backtick) so power users can extend without code edits.
        private static ushort ParseKey(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return 0;
            var k = name.Trim().ToUpperInvariant();

            // Single-letter A-Z and digit 0-9.
            if (k.Length == 1)
            {
                char ch = k[0];
                if (ch >= 'A' && ch <= 'Z') return (ushort)ch;
                if (ch >= '0' && ch <= '9') return (ushort)ch;
            }

            switch (k)
            {
                // Modifiers / common
                case "CTRL": case "CONTROL":    return 0x11;
                case "ALT":  case "MENU":       return 0x12;
                case "SHIFT":                   return 0x10;
                case "WIN":  case "META":       return 0x5B;
                case "TAB":                     return 0x09;
                case "ENTER": case "RETURN":    return 0x0D;
                case "ESC": case "ESCAPE":      return 0x1B;
                case "SPACE":                   return 0x20;
                case "BACKSPACE": case "BKSP":  return 0x08;
                case "DELETE": case "DEL":      return 0x2E;
                case "INSERT": case "INS":      return 0x2D;
                case "HOME":                    return 0x24;
                case "END":                     return 0x23;
                case "PAGEUP":   case "PGUP":   return 0x21;
                case "PAGEDOWN": case "PGDN":   return 0x22;
                case "CAPSLOCK":                return 0x14;
                case "NUMLOCK":                 return 0x90;
                // Arrows
                case "LEFT":  case "ARROWLEFT":  return 0x25;
                case "UP":    case "ARROWUP":    return 0x26;
                case "RIGHT": case "ARROWRIGHT": return 0x27;
                case "DOWN":  case "ARROWDOWN":  return 0x28;
                // Function row
                case "F1":  return 0x70; case "F2":  return 0x71; case "F3":  return 0x72;
                case "F4":  return 0x73; case "F5":  return 0x74; case "F6":  return 0x75;
                case "F7":  return 0x76; case "F8":  return 0x77; case "F9":  return 0x78;
                case "F10": return 0x79; case "F11": return 0x7A; case "F12": return 0x7B;
                // Numpad
                case "NUM0": return 0x60; case "NUM1": return 0x61; case "NUM2": return 0x62;
                case "NUM3": return 0x63; case "NUM4": return 0x64; case "NUM5": return 0x65;
                case "NUM6": return 0x66; case "NUM7": return 0x67; case "NUM8": return 0x68;
                case "NUM9": return 0x69;
                case "NUMADD": case "NUMPLUS":  return 0x6B;
                case "NUMSUB": case "NUMMINUS": return 0x6D;
                case "NUMMUL":                  return 0x6A;
                case "NUMDIV":                  return 0x6F;
                case "NUMDOT": case "NUMDECIMAL": return 0x6E;
                case "NUMENTER":                return 0x0D;
                // Common punctuation by OEM codes (US layout)
                case ";":  case "SEMICOLON":     return 0xBA;
                case "=":  case "EQUALS":        return 0xBB;
                case ",":  case "COMMA":         return 0xBC;
                case "-":  case "MINUS":         return 0xBD;
                case ".":  case "PERIOD":        return 0xBE;
                case "/":  case "SLASH":         return 0xBF;
                case "`":  case "BACKTICK": case "GRAVE": return 0xC0;
                case "[":  case "LBRACKET":      return 0xDB;
                case "\\": case "BACKSLASH":     return 0xDC;
                case "]":  case "RBRACKET":      return 0xDD;
                case "'":  case "QUOTE":         return 0xDE;
            }

            // Fallthrough: "VK_<NUM>" exact escape for power users.
            if (k.StartsWith("VK_") && k.Length > 3)
            {
                if (ushort.TryParse(k.Substring(3), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var code))
                    return code;
            }
            return 0;
        }
    }
}
