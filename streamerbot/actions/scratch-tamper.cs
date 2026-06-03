using System;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// Streamer.bot inline action: execute a scratch-off "control tamper".
//
// Trigger this action from a Streamer.bot "WebSocket Client" subscribed to
// the local Aquilo Bus (ws://127.0.0.1:7470). On a `scratch.tamper` message
// the worker forwards { actionKey, durationSec, viewer, body, forced } in the
// message `data`; map those onto these args:
//
//     actionKey    (string)  e.g. "invert_mouse"  REQUIRED
//     durationSec  (int)     auto-revert length, clamped to [1,120]
//     viewer       (string)  who scratched it (logging/overlay only)
//     body         (string)  the human text (logging/overlay only)
//
// SAFETY CONTRACT: every tamper here is bounded. The revert ALWAYS runs after
// durationSec on a background thread, even if the start path threw, and is
// hard-capped at MAX_SECONDS so nothing can wedge the input forever. Only one
// tamper runs at a time; a new one while another is active is skipped (the
// worker already spaces hits with a cooldown, this is defense-in-depth).
//
// Two implementation tiers:
//   DIRECT  — pure keyboard-injection tampers handled in this file with no
//             external setup (random_keys, force_jump, spam_emote).
//   ROUTED  — OS/game remaps that need Clay's own AHK/vJoy/OBS plumbing
//             (invert_mouse, swap_wasd, lock_crouch, force_walk,
//             sensitivity_max, mouse_drift, flip_screen, deafen, mute_mic).
//             This action runs the named start action, waits durationSec,
//             then runs the named revert action. Build those two actions per
//             key using the convention below; THIS file owns the timer.
//
//     start action name : "scratch.tamper.<actionKey>.start"
//     revert action name: "scratch.tamper.<actionKey>.revert"
//
// See SCRATCH-OFF-STREAMERBOT.md for the per-key recipe + an AHK example.
public class CPHInline {
  // ── Win32 input ───────────────────────────────────────────────────────
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  const uint KEYUP = 0x0002;
  // Safe virtual-key set for random injection (letters + space + arrows).
  // Deliberately excludes Alt/Ctrl/Win/Esc/Tab/F-keys so nothing closes the
  // game, alt-tabs, or opens a system menu.
  static readonly byte[] RANDOM_VK = {
    0x57, 0x41, 0x53, 0x44, 0x20,             // W A S D Space
    0x45, 0x51, 0x52, 0x46, 0x43,             // E Q R F C
    0x25, 0x26, 0x27, 0x28,                   // arrows
  };
  const byte VK_SPACE = 0x20;

  const int MAX_SECONDS = 120;     // hard ceiling — nothing runs longer
  static readonly object _gate = new object();
  static volatile bool _active = false;

  public bool Execute() {
    string actionKey = GetStr("actionKey");
    int duration = Clamp(GetInt("durationSec", 30), 1, MAX_SECONDS);
    string viewer = GetStr("viewer");
    string body = GetStr("body");
    if (string.IsNullOrEmpty(actionKey)) { CPH.LogWarn("[scratch] tamper with no actionKey — skipped."); return false; }

    lock (_gate) {
      if (_active) { CPH.LogWarn("[scratch] tamper already active — skipping " + actionKey); return true; }
      _active = true;
    }
    CPH.LogInfo("[scratch] tamper " + actionKey + " for " + duration + "s (" + (viewer ?? "?") + ")");

    // Run start + schedule revert on a background thread so Execute() returns
    // immediately and the input loop / wait does not block Streamer.bot.
    var th = new Thread(() => {
      try { RunTamper(actionKey, duration); }
      catch (Exception ex) { CPH.LogError("[scratch] tamper start failed: " + ex.Message); }
      finally {
        try { Revert(actionKey); }
        catch (Exception ex2) { CPH.LogError("[scratch] tamper revert failed: " + ex2.Message); }
        _active = false;
        CPH.LogInfo("[scratch] tamper " + actionKey + " reverted.");
      }
    });
    th.IsBackground = true;
    th.Start();
    return true;
  }

  // Returns true when handled directly here; false means it was routed to a
  // named Streamer.bot start action (revert is the matching named action).
  void RunTamper(string key, int duration) {
    switch (key) {
      case "random_keys": InjectLoop(duration, RandomVk, 120); return;
      case "force_jump":  InjectLoop(duration, () => VK_SPACE, 700); return;
      case "spam_emote":  InjectLoop(duration, () => EmoteVk(), 900); return;
      default:
        // ROUTED: run the named start action; revert runs in Revert().
        CPH.RunAction("scratch.tamper." + key + ".start", false);
        SleepSec(duration);
        return;
    }
  }

  void Revert(string key) {
    switch (key) {
      // DIRECT tampers stop when their inject loop ends — nothing to undo.
      case "random_keys": case "force_jump": case "spam_emote": return;
      default:
        CPH.RunAction("scratch.tamper." + key + ".revert", false);
        return;
    }
  }

  // Inject keypresses for `duration` seconds, one every `intervalMs`. `pick`
  // returns the virtual-key to tap each time. Always releases the key.
  void InjectLoop(int duration, Func<byte> pick, int intervalMs) {
    long endTick = Environment.TickCount + duration * 1000L;
    while (Environment.TickCount < endTick) {
      byte vk = pick();
      try {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        Thread.Sleep(40);
        keybd_event(vk, 0, KEYUP, UIntPtr.Zero);
      } catch { /* never let a stray input error wedge the thread */ }
      Thread.Sleep(Math.Max(20, intervalMs));
    }
  }

  static readonly Random _rng = new Random();
  byte RandomVk() { return RANDOM_VK[_rng.Next(RANDOM_VK.Length)]; }
  // Emote key is configurable per game via the "scratch.emoteKey" global
  // (a single char, e.g. "B" or "T"); defaults to B.
  byte EmoteVk() {
    string g = null;
    try { var v = CPH.GetGlobalVar<string>("scratch.emoteKey", true); g = v; } catch { }
    char c = (!string.IsNullOrEmpty(g)) ? char.ToUpper(g[0]) : 'B';
    return (byte)c;
  }

  void SleepSec(int sec) { Thread.Sleep(Clamp(sec, 1, MAX_SECONDS) * 1000); }

  // ── arg helpers ───────────────────────────────────────────────────────
  string GetStr(string name) {
    string s; if (CPH.TryGetArg(name, out s) && s != null) return s;
    object o; if (CPH.TryGetArg(name, out o) && o != null) return o.ToString();
    return null;
  }
  int GetInt(string name, int def) {
    object o; if (CPH.TryGetArg(name, out o) && o != null) { int v; if (int.TryParse(o.ToString(), out v)) return v; }
    return def;
  }
  static int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
}
