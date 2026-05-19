using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bus;
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

        private readonly bool _enabled;
        private readonly string _relayToken;
        private readonly string _ingestUrl;

        private readonly object _gate = new object();
        private JObject _dungeon;                       // snapshot being pushed
        private DateTime _runStartUtc;
        private readonly List<PendingUpdate> _pending = new List<PendingUpdate>();
        private Timer _replay;

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
        }

        public void Dispose()
        {
            if (_enabled) AquiloBus.Instance.LocalPublished -= OnBusPublished;
            lock (_gate)
            {
                _replay?.Dispose();
                _replay = null;
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
                        // the burst ends (see dungeon.completed).
                        _pending.Add(new PendingUpdate
                        {
                            OffsetMs = data?["delayMs"]?.Value<long>() ?? 0,
                            Scene = new JObject
                            {
                                ["kind"]  = data?["kind"],
                                ["text"]  = data?["text"],
                                ["glyph"] = data?["glyph"],
                            },
                        });
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
                    }
                }
                Push("dungeon", _dungeon);
                ScheduleNext();
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
    }
}
