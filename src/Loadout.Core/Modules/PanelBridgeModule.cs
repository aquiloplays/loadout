using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// B3 PANEL-BRIDGE (sub-phase 1: state DOWN, read-only).
    ///
    /// Mirrors in-process dungeon / mini-game bus events up to the Aquilo
    /// Worker so Clay's Twitch panel can show a live, read-only view of a
    /// dungeon run or a recent mini-game play. The panel polls the Worker;
    /// this module is the only writer of that state.
    ///
    /// OPT-IN, CLAY-ONLY. The module is completely inert unless
    /// %APPDATA%\Aquilo\panel-bridge.json exists and parses to:
    ///   { "enabled": true, "relayToken": "...", "workerUrl": "https://..." }
    /// Other streamers shipping the same Loadout.dll never get that file, so
    /// PanelBridgeModule no-ops for everyone but Clay. There is intentionally
    /// no settings-UI surface for it.
    ///
    /// DUNGEON REPLAY. DungeonModule publishes a whole run — started, every
    /// scene, completed — in one synchronous burst; each scene carries a
    /// `delayMs` offset and the OBS overlay sequences playback client-side.
    /// A naive observer would therefore jump straight to "complete", so this
    /// module buffers the burst and replays it on a timer keyed to `delayMs`.
    /// The panel then sees recruiting -> running (scenes advancing) ->
    /// complete in real time, the same as the overlay does.
    ///
    /// Going idle is implicit: the module only ever pushes active state, and
    /// the Worker ages the record out (~30s) once the pushes stop.
    /// </summary>
    public sealed class PanelBridgeModule : IDisposable
    {
        // HttpClient is built to be shared for the process lifetime.
        private static readonly HttpClient Http =
            new HttpClient { Timeout = TimeSpan.FromSeconds(8) };

        // How often the downstream command poll hits /relay/dll-pending.
        private const int PollMs = 2000;

        private readonly bool _enabled;
        private readonly string _relayToken;
        private readonly string _ingestUrl;
        private readonly string _pendingUrl;

        private readonly object _gate = new object();
        private JObject _dungeon;                       // snapshot being pushed
        private DateTime _runStartUtc;
        private readonly List<PendingUpdate> _pending = new List<PendingUpdate>();
        private Timer _replay;
        private Timer _poll;                            // downstream command poll
        private volatile bool _disposed;
        // Phase D — duel snapshot. Simpler than dungeon since duel scenes
        // already carry their own offsets and the run is short (3 strikes
        // + completion); no replay buffering needed.
        private JObject _duel;

        // A buffered step of the dungeon-run replay timeline.
        private sealed class PendingUpdate
        {
            public long OffsetMs;       // ms after run start to apply this step
            public JObject Scene;       // a dungeon.scene snapshot, or null
            public bool Complete;       // true => the dungeon.completed step
            public JToken Outcomes;     // outcomes payload, when Complete
        }

        /// <summary>
        /// Reads the opt-in config. Construction never throws and has no side
        /// effects — call <see cref="Start"/> (or use <see cref="StartIfConfigured"/>)
        /// to actually hook the bus.
        /// </summary>
        public PanelBridgeModule()
        {
            try
            {
                var path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "Aquilo", "panel-bridge.json");
                if (!File.Exists(path)) return;

                var cfg = JObject.Parse(File.ReadAllText(path));
                if (cfg.Value<bool?>("enabled") != true) return;

                _relayToken = (cfg.Value<string>("relayToken") ?? "").Trim();
                var worker = (cfg.Value<string>("workerUrl") ?? "").Trim().TrimEnd('/');
                if (_relayToken.Length == 0 || worker.Length == 0) return;

                _ingestUrl = worker + "/relay/dll-ingest";
                _pendingUrl = worker + "/relay/dll-pending";
                _enabled = true;
            }
            catch (Exception ex)
            {
                // Missing / malformed config -> stay inert, never crash the host.
                ErrorLog.Write("PanelBridgeModule.ctor", ex);
            }
        }

        /// <summary>
        /// Host convenience: build, and hook the bus only when the opt-in
        /// config is present. Returns null when the module is inert, so the
        /// caller has nothing to hold or dispose.
        /// </summary>
        public static PanelBridgeModule StartIfConfigured()
        {
            var m = new PanelBridgeModule();
            if (!m._enabled) return null;
            m.Start();
            return m;
        }

        public void Start()
        {
            if (!_enabled) return;
            AquiloBus.Instance.LocalPublished += OnBusPublished;
            // Downstream: poll the Worker for panel-issued commands. Self-
            // reschedules after each poll so a slow request can't stack.
            _poll = new Timer(_ => { var _ignore = PollOnceAsync(); },
                              null, PollMs, Timeout.Infinite);
        }

        public void Dispose()
        {
            _disposed = true;
            if (_enabled) AquiloBus.Instance.LocalPublished -= OnBusPublished;
            lock (_gate)
            {
                _replay?.Dispose();
                _replay = null;
                _poll?.Dispose();
                _poll = null;
            }
        }

        // ------------------------------------------------------------------

        private void OnBusPublished(string kind, JToken data)
        {
            if (!_enabled || string.IsNullOrEmpty(kind)) return;
            try
            {
                if (kind.StartsWith("dungeon.", StringComparison.Ordinal))
                    OnDungeonEvent(kind, data as JObject);
                else if (kind.StartsWith("duel.", StringComparison.Ordinal))
                    OnDuelEvent(kind, data as JObject);
                else if (kind.StartsWith("bolts.minigame.", StringComparison.Ordinal))
                    OnMinigameEvent(kind, data as JObject);
            }
            catch (Exception ex)
            {
                ErrorLog.Write("PanelBridgeModule.OnBusPublished:" + kind, ex);
            }
        }

        // ---- dungeon ------------------------------------------------------

        private void OnDungeonEvent(string kind, JObject data)
        {
            lock (_gate)
            {
                switch (kind)
                {
                    case "dungeon.recruiting":
                        ResetReplay();
                        _dungeon = new JObject
                        {
                            ["phase"]       = "recruiting",
                            ["dungeonName"] = data?["dungeonName"],
                            ["party"]       = data?["party"] as JArray ?? new JArray(),
                        };
                        Push("dungeon", _dungeon);
                        break;

                    case "dungeon.joined":
                        if (_dungeon != null && data?["hero"] is JObject hero)
                        {
                            AppendPartyMember(hero);
                            Push("dungeon", _dungeon);
                        }
                        break;

                    case "dungeon.started":
                        if (_dungeon == null)
                            _dungeon = new JObject { ["party"] = new JArray() };
                        _dungeon["phase"] = "running";
                        if (data?["dungeonName"] != null)
                            _dungeon["dungeonName"] = data["dungeonName"];
                        _dungeon["scene"] = null;
                        _dungeon.Remove("outcomes");
                        _runStartUtc = DateTime.UtcNow;
                        _pending.Clear();
                        Push("dungeon", _dungeon);
                        break;

                    case "dungeon.scene":
                        // Buffered, not pushed — replayed on the timer once
                        // the burst ends (see dungeon.completed). `target`
                        // mirrors the engine's `targetUser` so the panel can
                        // pulse the chip of whoever the scene happens to;
                        // `partyHp` ticks HP bars down live as the replay
                        // plays each scene back in time. `options` is
                        // present on branching scenes (Phase BR) and drives
                        // the panel's vote buttons.
                        _pending.Add(new PendingUpdate
                        {
                            OffsetMs = data?["delayMs"]?.Value<long>() ?? 0,
                            Scene = new JObject
                            {
                                ["kind"]    = data?["kind"],
                                ["text"]    = data?["text"],
                                ["glyph"]   = data?["glyph"],
                                ["target"]  = data?["targetUser"],
                                ["partyHp"] = data?["partyHp"],
                                ["options"] = data?["options"],
                            },
                        });
                        break;

                    case "dungeon.choice":
                        // Phase BR — branch resolved. Park the resolve info
                        // on the dungeon snapshot so the panel renders the
                        // "{N} votes — {resolveText}" line in real time when
                        // its 2 s poll catches up.
                        if (_dungeon == null) _dungeon = new JObject();
                        _dungeon["choice"] = new JObject
                        {
                            ["optionId"]    = data?["optionId"],
                            ["votes"]       = data?["votes"],
                            ["viaTimeout"]  = data?["viaTimeout"],
                            ["resolveText"] = data?["resolveText"],
                            ["glyph"]       = data?["glyph"],
                        };
                        Push("dungeon", _dungeon);
                        break;

                    case "dungeon.completed":
                        // End of the burst — schedule the completed step just
                        // after the last scene, then start the replay clock.
                        long last = 0;
                        foreach (var p in _pending)
                            if (p.OffsetMs > last) last = p.OffsetMs;
                        _pending.Add(new PendingUpdate
                        {
                            OffsetMs = last + 1500,
                            Complete = true,
                            Outcomes = data?["outcomes"],
                        });
                        _pending.Sort((a, b) => a.OffsetMs.CompareTo(b.OffsetMs));
                        ArmReplay();
                        break;

                    case "dungeon.cooldown":
                        // Phase BR polish — surface the channel-cooldown
                        // window as its own state record so the panel can
                        // render "Next dungeon in 4:32" even when no
                        // dungeon is currently in play.
                        Push("cooldown", new JObject
                        {
                            ["kind"]        = "dungeon",
                            ["untilUtc"]    = data?["untilUtc"],
                            ["durationSec"] = data?["durationSec"],
                        });
                        break;

                    case "dungeon.vote":
                        // Phase BR polish — running tally for live vote
                        // badges. Decorates the current dungeon snapshot
                        // so it rides on the next 2 s panel poll.
                        if (_dungeon != null)
                        {
                            _dungeon["voteTally"] = data?["tally"];
                            Push("dungeon", _dungeon);
                        }
                        break;
                }
            }
        }

        // Caller holds _gate.
        private void AppendPartyMember(JObject hero)
        {
            var party = _dungeon["party"] as JArray;
            if (party == null) { party = new JArray(); _dungeon["party"] = party; }

            var user = hero.Value<string>("user");
            foreach (var m in party)
            {
                if (string.Equals(m?.Value<string>("user"), user,
                        StringComparison.OrdinalIgnoreCase))
                    return; // host auto-include / double !join — already in
            }
            party.Add(hero);
        }

        // Caller holds _gate.
        private void ResetReplay()
        {
            _pending.Clear();
            _replay?.Dispose();
            _replay = null;
        }

        // Caller holds _gate.
        private void ArmReplay()
        {
            if (_replay == null)
                _replay = new Timer(_ => ReplayTick(), null,
                                    Timeout.Infinite, Timeout.Infinite);
            ScheduleNext();
        }

        // Caller holds _gate.
        private void ScheduleNext()
        {
            if (_replay == null || _pending.Count == 0) return;
            var elapsed = (DateTime.UtcNow - _runStartUtc).TotalMilliseconds;
            var due = _pending[0].OffsetMs - elapsed;
            _replay.Change((long)Math.Max(0, due), Timeout.Infinite);
        }

        private void ReplayTick()
        {
            lock (_gate)
            {
                if (_dungeon == null) { _pending.Clear(); return; }

                var elapsed = (DateTime.UtcNow - _runStartUtc).TotalMilliseconds;
                // Apply every step that is now due, then push once (a slow
                // tick that swallowed several scenes still only sends one
                // update — the panel just wants the latest).
                while (_pending.Count > 0 && _pending[0].OffsetMs <= elapsed)
                {
                    var p = _pending[0];
                    _pending.RemoveAt(0);
                    if (p.Complete)
                    {
                        _dungeon["phase"] = "complete";
                        _dungeon["outcomes"] = p.Outcomes;
                    }
                    else if (p.Scene != null)
                    {
                        _dungeon["scene"] = p.Scene;
                        // Phase BR polish — stamp openedAt + window
                        // when a branching scene becomes current, so
                        // the panel can render a real countdown
                        // ("27s remaining") from these fields rather
                        // than guessing.
                        var opts = p.Scene["options"] as JArray;
                        if (opts != null && opts.Count > 0)
                        {
                            p.Scene["openedAt"] =
                                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                            p.Scene["voteWindowMs"] = 30000;
                        }
                    }
                }
                Push("dungeon", _dungeon);
                ScheduleNext();
            }
        }

        // ---- duels --------------------------------------------------------

        // Duels are short (3 strike rounds + completion) so we don't need
        // the dungeon's replay-on-a-timer dance — each event just updates
        // the snapshot and pushes immediately. The Worker ages the record
        // out after the usual TTL once the bus goes quiet.
        private void OnDuelEvent(string kind, JObject data)
        {
            lock (_gate)
            {
                switch (kind)
                {
                    case "duel.recruiting":
                        _duel = new JObject
                        {
                            ["phase"]      = "recruiting",
                            ["challenger"] = data?["challenger"],
                            ["target"]     = data?["target"],
                            ["openSec"]    = data?["openSec"],
                        };
                        break;
                    case "duel.started":
                        if (_duel == null) _duel = new JObject();
                        _duel["phase"]      = "running";
                        _duel["challenger"] = data?["challenger"] ?? _duel["challenger"];
                        _duel["defender"]   = data?["defender"];
                        _duel["strikes"]    = new JArray();
                        break;
                    case "duel.scene":
                        if (_duel == null) _duel = new JObject { ["phase"] = "running" };
                        var strikes = _duel["strikes"] as JArray ?? new JArray();
                        strikes.Add(new JObject
                        {
                            ["delayMs"]        = data?["delayMs"],
                            ["kind"]           = data?["kind"],
                            ["text"]           = data?["text"],
                            ["glyph"]          = data?["glyph"],
                            ["attackerHpAfter"]= data?["attackerHpAfter"],
                            ["defenderHpAfter"]= data?["defenderHpAfter"],
                        });
                        _duel["strikes"] = strikes;
                        break;
                    case "duel.completed":
                        if (_duel == null) _duel = new JObject();
                        _duel["phase"]  = "complete";
                        _duel["winner"] = data?["winner"];
                        _duel["loser"]  = data?["loser"];
                        _duel["reason"] = data?["reason"];
                        _duel["xp"]     = data?["xp"];
                        _duel["gold"]   = data?["gold"];
                        break;
                    default: return;
                }
                Push("duel", _duel);
            }
        }

        // ---- mini-games ---------------------------------------------------

        private void OnMinigameEvent(string kind, JObject data)
        {
            // Each bolts.minigame.* event is a complete one-shot result; the
            // panel just shows the most recent play.
            var game = kind.Substring("bolts.minigame.".Length);
            Push("minigame", new JObject
            {
                ["game"]    = game,
                ["payload"] = data ?? new JObject(),
            });
        }

        // ---- transport ----------------------------------------------------

        // Builds the ingest body and fires the POST. DeepClone keeps the
        // serialized payload stable even though `state` may be a live
        // snapshot the caller keeps mutating. For dungeon pushes the caller
        // holds _gate so the clone reads a consistent snapshot.
        private void Push(string type, JToken state)
        {
            if (!_enabled) return;
            var body = new JObject
            {
                ["type"]   = type,
                ["active"] = true,
                ["state"]  = state != null ? state.DeepClone() : JValue.CreateNull(),
            };
            _ = PostAsync(body.ToString(Formatting.None));
        }

        private async Task PostAsync(string json)
        {
            try
            {
                using (var req = new HttpRequestMessage(HttpMethod.Post, _ingestUrl))
                {
                    req.Headers.TryAddWithoutValidation("X-Relay-Token", _relayToken);
                    req.Content = new StringContent(json, Encoding.UTF8, "application/json");
                    using (var resp = await Http.SendAsync(req).ConfigureAwait(false))
                    {
                        // Fire-and-forget: a dropped panel update is cosmetic.
                        // Log only hard failures so a bad token is visible.
                        if (!resp.IsSuccessStatusCode)
                            ErrorLog.Write("PanelBridgeModule.Post",
                                "ingest HTTP " + (int)resp.StatusCode);
                    }
                }
            }
            catch (Exception ex)
            {
                ErrorLog.Write("PanelBridgeModule.Post", ex);
            }
        }

        // ---- downstream: panel commands -> engines ------------------------

        // Polls /relay/dll-pending, replays each queued command, then
        // reschedules itself. Runs on a thread-pool thread.
        private async Task PollOnceAsync()
        {
            try
            {
                using (var req = new HttpRequestMessage(HttpMethod.Get, _pendingUrl))
                {
                    req.Headers.TryAddWithoutValidation("X-Relay-Token", _relayToken);
                    using (var resp = await Http.SendAsync(req).ConfigureAwait(false))
                    {
                        if (resp.IsSuccessStatusCode)
                        {
                            var body = await resp.Content.ReadAsStringAsync()
                                                 .ConfigureAwait(false);
                            DispatchPanelCommands(body);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                ErrorLog.Write("PanelBridgeModule.Poll", ex);
            }
            finally
            {
                if (!_disposed)
                {
                    try { _poll?.Change(PollMs, Timeout.Infinite); } catch { }
                }
            }
        }

        private void DispatchPanelCommands(string body)
        {
            JArray cmds;
            try { cmds = JObject.Parse(body)["commands"] as JArray; }
            catch { return; }
            if (cmds == null) return;

            foreach (var c in cmds)
            {
                try { DispatchPanelCommand(c as JObject); }
                catch (Exception ex)
                {
                    ErrorLog.Write("PanelBridgeModule.Dispatch", ex);
                }
            }
        }

        // Replays one panel command as a synthesized Twitch chat event, so
        // the existing dungeon / mini-game engines handle it through their
        // normal chat-command path — no engine changes needed. Role is
        // JWT-derived (the Worker only trusts that field), so engine-side
        // gates like "!dungeon is mods-only" still hold.
        private void DispatchPanelCommand(JObject cmd)
        {
            if (cmd == null) return;

            var kind   = (string)cmd["kind"];
            var action = ((string)cmd["action"] ?? "").ToLowerInvariant();
            var arg    = ((string)cmd["arg"] ?? "").Trim();
            var user   = cmd["user"] as JObject;
            var name   = (user?.Value<string>("name") ?? "").Trim();
            var role   = (user?.Value<string>("role") ?? "viewer").ToLowerInvariant();
            if (name.Length == 0) name = "viewer";

            var message = BuildCommandMessage(kind, action, arg);
            if (message == null) return;   // unknown kind / action — drop

            var args = new Dictionary<string, object>
            {
                ["eventSource"] = "twitch",
                ["user"]        = name,
                ["userName"]    = name,
                ["userType"]    = role == "broadcaster" ? "broadcaster"
                                : role == "moderator"   ? "mod"
                                                        : "viewer",
                ["message"]     = message,
                ["rawInput"]    = message,
            };
            // Phase BR — stamp the panel-skip trust flag so DungeonModule
            // can tell "the Worker validated a Bits/bolts payment" from
            // "a chat viewer typed !dungeon skip". Worker only enqueues
            // the skip action AFTER charging, so seeing it here means it's
            // legitimate.
            if (kind == "dungeon" && action == "skip")
            {
                args["loadout.panel.skip"] = true;
            }
            SbEventDispatcher.Instance.DispatchEvent("chat", args);
        }

        // Maps a (kind, action) pair to the chat line a viewer would type.
        // Dungeon verbs honour Clay's configured command words; mini-game
        // verbs are fixed (BoltsModule matches them literally).
        private static string BuildCommandMessage(string kind, string action, string arg)
        {
            string word;
            if (kind == "dungeon")
            {
                var dc = SettingsManager.Instance.Current?.Dungeon;
                var dungeonWord = NormalizeCmd(dc?.DungeonCommand, "!dungeon");
                switch (action)
                {
                    case "dungeon": word = dungeonWord; break;
                    case "join":    word = NormalizeCmd(dc?.JoinCommand, "!join"); break;
                    case "duel":    word = NormalizeCmd(dc?.DuelCommand, "!duel"); break;
                    // Phase BR — vote on the current branching scene; arg is
                    // the option id. Synthesizes "!dungeon vote <id>".
                    case "vote":    word = dungeonWord + " vote"; break;
                    // Phase BR — bypass the channel cooldown and start a
                    // dungeon. DispatchPanelCommand stamps a trust flag in
                    // the args so DungeonModule.OnEvent honours it (a chat
                    // user typing the same line is still subject to the
                    // cooldown).
                    case "skip":    word = dungeonWord + " skip"; break;
                    default: return null;
                }
            }
            else if (kind == "minigame")
            {
                switch (action)
                {
                    case "coinflip":
                    case "dice":
                    case "slots":
                    case "rps":
                    case "roulette":
                        word = "!" + action;
                        break;
                    default: return null;
                }
            }
            else return null;

            return arg.Length > 0 ? word + " " + arg : word;
        }

        // Mirror of DungeonModule.NormalizeCmd — ensures a leading '!' and
        // lower-cases, so the synthesized line matches what the engine
        // compares against.
        private static string NormalizeCmd(string cfg, string fallback)
        {
            var c = (cfg ?? "").Trim();
            if (c.Length == 0) c = fallback;
            if (!c.StartsWith("!", StringComparison.Ordinal)) c = "!" + c;
            return c.ToLowerInvariant();
        }
    }
}
