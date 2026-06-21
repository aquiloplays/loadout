using System;
using System.Collections.Generic;
using System.Reflection;
using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// Write-path for the OBS dock (aquilo.gg/dock/loadout/). The dock
    /// already reads everything off the bus; this bridge makes its
    /// buttons DO things — counter bumps, quiet-mode toggles, module
    /// flips, chat sends, Game-Interactions pause, and arbitrary
    /// Streamer.bot action runs.
    ///
    /// Every handler replies to the requesting client only (in-process
    /// handler semantics) AND broadcasts the relevant state event so
    /// other connected surfaces (overlays, a second dock, the
    /// customizer) converge on the same state.
    ///
    /// Security: the bus is localhost-bound + secret-gated, so any
    /// client that can reach us is the streamer's own machine. We still
    /// route everything through this one dispatcher so each command is
    /// logged and the surface area is an explicit whitelist, not
    /// arbitrary settings access.
    /// </summary>
    public static class DockCommandBridge
    {
        public static void Register()
        {
            var bus = AquiloBus.Instance;
            bus.RegisterHandler("loadout.status.request",            OnStatusRequest);
            bus.RegisterHandler("counter.update.request",            OnCounterUpdate);
            bus.RegisterHandler("loadout.quiet.toggle",              OnQuietToggle);
            bus.RegisterHandler("loadout.module.toggle",             OnModuleToggle);
            bus.RegisterHandler("loadout.chat.send",                 OnChatSend);
            bus.RegisterHandler("loadout.test.send",                 OnTestSend);
            bus.RegisterHandler("loadout.gameactions.pause.request", OnPauseRequest);
            bus.RegisterHandler("loadout.sb.action.run",             OnSbActionRun);
            bus.RegisterHandler("loadout.sb.actions.request",        OnSbActionsRequest);
            bus.RegisterHandler("loadout.bolts.adjust",              OnBoltsAdjust);
        }

        // ── SB action list (for the dock's run-action autocomplete) ──

        private static BusMessage OnSbActionsRequest(string fromClient, BusMessage incoming)
        {
            try
            {
                var names = SbBridge.Instance.GetActionNames();
                return Reply("loadout.sb.actions", new { actions = names });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.SbActions", ex);
                return Reply("loadout.sb.actions", new { actions = new List<string>(), error = ex.Message });
            }
        }

        // ── Bolts grant / deduct (mod tool) ──────────────────────────

        private static BusMessage OnBoltsAdjust(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = incoming?.Data as JObject;
                var user     = (d?.Value<string>("user") ?? "").Trim().TrimStart('@');
                var amount   = d?.Value<int?>("amount") ?? 0;
                var platform = (d?.Value<string>("platform") ?? "twitch").Trim().ToLowerInvariant();
                if (user.Length == 0 || amount == 0)
                    return Reply("loadout.bolts.ack", new { ok = false, reason = "user + non-zero amount required" });

                long balance;
                if (amount > 0)
                {
                    balance = Loadout.Bolts.BoltsWallet.Instance.Earn(platform, user, amount, "dock-grant");
                }
                else
                {
                    // Deduct via Spend so we never push a viewer negative.
                    var ok = Loadout.Bolts.BoltsWallet.Instance.Spend(platform, user, -amount, "dock-deduct");
                    if (!ok)
                    {
                        var have = Loadout.Bolts.BoltsWallet.Instance.Balance(platform, user);
                        return Reply("loadout.bolts.ack", new
                        {
                            ok = false, user, amount,
                            reason = "insufficient balance (has " + have + ") or unknown user"
                        });
                    }
                    balance = Loadout.Bolts.BoltsWallet.Instance.Balance(platform, user);
                }
                EventStats.Instance.Hit("dock.command", nameof(DockCommandBridge));
                return Reply("loadout.bolts.ack", new { ok = true, user, amount, balance });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.BoltsAdjust", ex);
                return Reply("loadout.bolts.ack", new { ok = false, reason = ex.Message });
            }
        }

        // ── Status ───────────────────────────────────────────────────

        private static BusMessage OnStatusRequest(string fromClient, BusMessage incoming)
        {
            return Reply("loadout.status", BuildStatus());
        }

        /// <summary>Broadcast the status snapshot to every subscriber.
        /// Called after any state-changing command and from Boot so the
        /// dock's pills/toggles initialize without a request.</summary>
        public static void PublishStatus()
        {
            try { AquiloBus.Instance.Publish("loadout.status", BuildStatus()); }
            catch { /* bus down — nothing to update */ }
        }

        private static object BuildStatus()
        {
            var s = SettingsManager.Instance.Current;
            var modules = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in typeof(ModulesConfig).GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (p.PropertyType != typeof(bool)) continue;
                modules[p.Name] = p.GetValue(s.Modules) is bool b && b;
            }
            return new
            {
                version = s.SuiteVersion,
                quiet   = s.ChatNoise?.QuietMode == true,
                dryRun  = s.DryRun,
                modules,
                gameInteractions = new
                {
                    enabled        = s.GameInteractions?.Enabled == true,
                    paused         = GameInteractionsModule.IsPaused,
                    pausedUntilUtc = GameInteractionsModule.IsPaused
                        ? (DateTime?)GameInteractionsModule.PausedUntilUtc : null
                },
                // Per-kind event counts since the DLL booted — the dock
                // renders a "session stats" pill row from these.
                session = new
                {
                    sinceUtc = EventStats.Instance.SinceUtc,
                    total    = EventStats.Instance.Total,
                    counts   = EventStats.Instance.Snapshot()
                }
            };
        }

        // ── Counters ─────────────────────────────────────────────────

        private static BusMessage OnCounterUpdate(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = incoming?.Data as JObject;
                var name  = d?.Value<string>("name");
                var delta = d?.Value<int?>("delta") ?? 0;
                var setTo = d?.Value<int?>("set");        // absolute assignment, e.g. reset = set:0
                if (string.IsNullOrWhiteSpace(name) || (delta == 0 && !setTo.HasValue))
                    return Reply("counter.update.ack", new { ok = false, reason = "name plus delta or set required" });

                Counter counter = null;
                SettingsManager.Instance.Mutate(s =>
                {
                    foreach (var c in s.Counters?.Counters ?? new List<Counter>())
                    {
                        if (c != null && string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))
                        { counter = c; break; }
                    }
                    if (counter == null) return;
                    var v = setTo ?? (counter.Value + delta);
                    if (counter.MinValue.HasValue && v < counter.MinValue.Value) v = counter.MinValue.Value;
                    if (counter.MaxValue.HasValue && v > counter.MaxValue.Value) v = counter.MaxValue.Value;
                    counter.Value = v;
                });
                if (counter == null)
                    return Reply("counter.update.ack", new { ok = false, reason = "no counter named '" + name + "'" });

                // Broadcast so the counters overlay + every dock update.
                AquiloBus.Instance.Publish("counter.updated", new
                {
                    name    = counter.Name,
                    display = counter.Display,
                    value   = counter.Value,
                    color   = counter.Color,
                    hidden  = counter.Hidden,
                    by      = fromClient ?? "dock"
                });
                EventStats.Instance.Hit("dock.command", nameof(DockCommandBridge));
                return Reply("counter.update.ack", new { ok = true, name = counter.Name, value = counter.Value });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.CounterUpdate", ex);
                return Reply("counter.update.ack", new { ok = false, reason = ex.Message });
            }
        }

        // ── Quiet mode ───────────────────────────────────────────────

        private static BusMessage OnQuietToggle(string fromClient, BusMessage incoming)
        {
            try
            {
                bool now = false;
                SettingsManager.Instance.Mutate(s =>
                {
                    s.ChatNoise.QuietMode = !s.ChatNoise.QuietMode;
                    now = s.ChatNoise.QuietMode;
                });
                EventStats.Instance.Hit("dock.command", nameof(DockCommandBridge));
                PublishStatus();
                return Reply("loadout.quiet.ack", new { ok = true, quiet = now });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.QuietToggle", ex);
                return Reply("loadout.quiet.ack", new { ok = false, reason = ex.Message });
            }
        }

        // ── Module toggle ────────────────────────────────────────────

        private static BusMessage OnModuleToggle(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = incoming?.Data as JObject;
                var moduleName = d?.Value<string>("module");
                var enabled    = d?.Value<bool?>("enabled");   // null = toggle
                if (string.IsNullOrWhiteSpace(moduleName))
                    return Reply("loadout.module.ack", new { ok = false, reason = "module required" });

                var prop = typeof(ModulesConfig).GetProperty(moduleName,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (prop == null || prop.PropertyType != typeof(bool))
                    return Reply("loadout.module.ack", new { ok = false, reason = "unknown module '" + moduleName + "'" });

                bool now = false;
                SettingsManager.Instance.Mutate(s =>
                {
                    var current = prop.GetValue(s.Modules) is bool b && b;
                    now = enabled ?? !current;
                    prop.SetValue(s.Modules, now);
                    // GameInteractions has a second master switch inside its
                    // own config; keep them in lockstep like the Settings UI does.
                    if (string.Equals(prop.Name, "GameInteractions", StringComparison.OrdinalIgnoreCase) &&
                        s.GameInteractions != null)
                        s.GameInteractions.Enabled = now;
                });
                EventStats.Instance.Hit("dock.command", nameof(DockCommandBridge));
                PublishStatus();
                return Reply("loadout.module.ack", new { ok = true, module = prop.Name, enabled = now });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.ModuleToggle", ex);
                return Reply("loadout.module.ack", new { ok = false, reason = ex.Message });
            }
        }

        // ── Chat send ────────────────────────────────────────────────

        private static BusMessage OnChatSend(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = incoming?.Data as JObject;
                var message = (d?.Value<string>("message") ?? "").Trim();
                if (message.Length == 0)
                    return Reply("loadout.chat.ack", new { ok = false, reason = "empty message" });
                if (message.Length > 450) message = message.Substring(0, 450);

                // Optional platform filter: ["twitch","youtube"]. Default all.
                var mask = PlatformMask.None;
                if (d?["platforms"] is JArray plats && plats.Count > 0)
                {
                    foreach (var p in plats)
                        mask |= PlatformMaskExtensions.FromShortName(p?.ToString() ?? "");
                }
                if (mask == PlatformMask.None) mask = PlatformMask.All;

                var s = SettingsManager.Instance.Current;
                var sent = new MultiPlatformSender(CphPlatformSender.Instance)
                    .Send(mask, message, s.Platforms);
                EventStats.Instance.Hit("dock.command", nameof(DockCommandBridge));
                return Reply("loadout.chat.ack", new
                {
                    ok   = sent != PlatformMask.None,
                    sent = sent.ToString(),
                    reason = sent == PlatformMask.None
                        ? "no platform accepted the send (SB connected? platforms enabled? dry-run?)" : null
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.ChatSend", ex);
                return Reply("loadout.chat.ack", new { ok = false, reason = ex.Message });
            }
        }

        private static BusMessage OnTestSend(string fromClient, BusMessage incoming)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                var sent = new MultiPlatformSender(CphPlatformSender.Instance).Send(
                    PlatformMask.All,
                    "Loadout test message - if you see this in chat, outgoing send is working.",
                    s.Platforms);
                EventStats.Instance.Hit("dock.command", nameof(DockCommandBridge));
                return Reply("loadout.test.ack", new
                {
                    ok = sent != PlatformMask.None,
                    sent = sent.ToString()
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.TestSend", ex);
                return Reply("loadout.test.ack", new { ok = false, reason = ex.Message });
            }
        }

        // ── Game Interactions pause ──────────────────────────────────

        private static BusMessage OnPauseRequest(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = incoming?.Data as JObject;
                var minutes = d?.Value<double?>("minutes") ?? 0;
                // PauseFor(<=0) clears; it also publishes the
                // loadout.gameactions.pause broadcast + refunds.
                GameInteractionsModule.PauseFor(TimeSpan.FromMinutes(minutes));
                EventStats.Instance.Hit("dock.command", nameof(DockCommandBridge));
                PublishStatus();
                return Reply("loadout.gameactions.pause.ack", new
                {
                    ok = true,
                    paused = GameInteractionsModule.IsPaused,
                    pausedUntilUtc = GameInteractionsModule.IsPaused
                        ? (DateTime?)GameInteractionsModule.PausedUntilUtc : null
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.Pause", ex);
                return Reply("loadout.gameactions.pause.ack", new { ok = false, reason = ex.Message });
            }
        }

        // ── Arbitrary SB action ──────────────────────────────────────

        private static BusMessage OnSbActionRun(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = incoming?.Data as JObject;
                var action = (d?.Value<string>("action") ?? "").Trim();
                if (action.Length == 0)
                    return Reply("loadout.sb.action.ack", new { ok = false, reason = "action name required" });
                var ok = SbBridge.Instance.RunAction(action);
                EventStats.Instance.Hit("dock.command", nameof(DockCommandBridge));
                return Reply("loadout.sb.action.ack", new
                {
                    ok,
                    action,
                    reason = ok ? null : "RunAction returned false (action missing? SB not bound?)"
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DockCommandBridge.SbAction", ex);
                return Reply("loadout.sb.action.ack", new { ok = false, reason = ex.Message });
            }
        }

        private static BusMessage Reply(string kind, object data)
        {
            return new BusMessage
            {
                V    = 1,
                Kind = kind,
                Data = data == null ? null : JToken.FromObject(data)
            };
        }
    }
}
