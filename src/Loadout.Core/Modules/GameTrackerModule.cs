using System;
using Loadout.Bus;
using Loadout.Games;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Drives the per-game stats store. Listens to the stream lifecycle events
    /// and the periodic chat-velocity tick to capture peak viewer counts. Also
    /// triggers the optional "reset counters on game switch" behavior.
    ///
    /// Always-on (free tier) — but the tracking is cheap (one row update on
    /// state change) and the data lives entirely on disk.
    /// </summary>
    public sealed class GameTrackerModule : IEventModule
    {
        private string _lastGameRecorded;

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.GameTracker) return;
            GameStatsStore.Instance.Initialize();

            switch (ctx.Kind)
            {
                case "streamOnline":
                {
                    var game = SbBridge.Instance.GetGlobal<string>("twitch.streamCategory", null);
                    GameStatsStore.Instance.OnStreamOnline(game);
                    _lastGameRecorded = game;
                    AquiloBus.Instance.Publish("game.session.started", new { game });
                    return;
                }
                case "streamUpdate":
                {
                    var newGame = ctx.Get<string>("category", ctx.Get<string>("game", null));
                    if (string.IsNullOrWhiteSpace(newGame)) return;
                    if (string.Equals(newGame, _lastGameRecorded, StringComparison.OrdinalIgnoreCase)) return;

                    // If the broadcaster opted in for "reset counters on game
                    // switch" for the OUTGOING game, do that now.
                    if (!string.IsNullOrEmpty(_lastGameRecorded))
                    {
                        var outgoing = FindStat(_lastGameRecorded);
                        if (outgoing != null && outgoing.ResetCountersOnSwitch)
                            ResetAllCountersToZero();
                    }

                    GameStatsStore.Instance.OnGameChanged(newGame);
                    AquiloBus.Instance.Publish("game.session.changed", new
                    {
                        from = _lastGameRecorded,
                        to   = newGame
                    });
                    _lastGameRecorded = newGame;
                    return;
                }
                case "streamOffline":
                {
                    GameStatsStore.Instance.OnStreamOffline();
                    AquiloBus.Instance.Publish("game.session.ended", new { game = _lastGameRecorded });
                    _lastGameRecorded = null;
                    return;
                }
                case "chat":
                {
                    // Use chat as a low-frequency hook to capture viewer count.
                    // CPH publishes the count as a global; we read it lazily.
                    var viewers = SbBridge.Instance.GetGlobal<int>("loadout.viewers", 0);
                    if (viewers > 0) GameStatsStore.Instance.RecordViewerCount(viewers);
                    return;
                }
            }
        }

        public void OnTick() { }

        private static GameStat FindStat(string game)
        {
            if (string.IsNullOrWhiteSpace(game)) return null;
            foreach (var g in GameStatsStore.Instance.All())
                if (string.Equals(g.GameName, game, StringComparison.OrdinalIgnoreCase)) return g;
            return null;
        }

        private static void ResetAllCountersToZero()
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                foreach (var c in s.Counters.Counters) c.Value = 0;
                SettingsManager.Instance.SaveNow();
                AquiloBus.Instance.Publish("counter.reset.all", new { reason = "game-switch" });
            }
            catch (Exception ex)
            {
                Util.ErrorLog.Write("GameTracker.ResetCounters", ex);
            }
        }
    }
}
