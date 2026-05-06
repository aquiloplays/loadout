using System;
using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// Bridges the streamer's Rotation Spotify widget into chat. When the
    /// widget reports a track change via <c>rotation.song.playing</c> on
    /// the Aquilo Bus, we cache the payload. Viewers asking <c>!song</c>
    /// (configurable via <see cref="RotationConnectionConfig.SongCommand"/>)
    /// get a chat reply with the title, artist, and source.
    ///
    /// Why a separate module instead of folding into InfoCommandsModule:
    /// the rotation widget is its own product and only some streamers run
    /// it; the command needs to silently do nothing if no track has been
    /// reported yet, and the cached state lives here so other modules
    /// (compact overlay, future surfaces) can read it without touching
    /// InfoCommands.
    /// </summary>
    public sealed class NowPlayingModule : IEventModule
    {
        // Latest rotation.song.playing payload, if any. Held under the
        // gate so chat replies don't race a fresh track change. The
        // payload shape mirrors the bus event Rotation publishes — see
        // ~/Desktop/aquilo-widget/rotation/src/widget.js publishPlaying.
        private readonly object _gate = new object();
        private NowPlaying _current;

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            // Cache fresh now-playing payloads from the bus → dispatcher
            // bridge that LoadoutHost wires up at startup.
            if (string.Equals(ctx.Kind, "rotation.song.playing", StringComparison.OrdinalIgnoreCase))
            {
                lock (_gate)
                {
                    _current = new NowPlaying
                    {
                        Title         = ctx.Get<string>("title", ""),
                        Artist        = ctx.Get<string>("artist", ""),
                        Album         = ctx.Get<string>("album", ""),
                        Source        = ctx.Get<string>("source", "Spotify"),
                        IsPlaying     = ctx.Get<bool>("isPlaying", true),
                        RequestedBy   = ctx.Get<string>("requestedBy", ""),
                        ReceivedUtc   = DateTime.UtcNow
                    };
                }
                return;
            }

            // !song chat command (config-overridable name).
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            var cfg = s.RotationConnection;
            if (cfg == null || !cfg.SongCommandEnabled) return;

            var raw = (ctx.Message ?? "").Trim();
            if (raw.Length < 2 || raw[0] != '!') return;
            var cmdToken = "!" + raw.Substring(1).Split(' ')[0].ToLowerInvariant();
            var configured = (cfg.SongCommand ?? "!song").Trim().ToLowerInvariant();
            if (!string.Equals(cmdToken, configured, StringComparison.OrdinalIgnoreCase)) return;

            string reply;
            lock (_gate)
            {
                if (_current == null || string.IsNullOrEmpty(_current.Title))
                {
                    // Stay quiet if there's nothing to say — chatty bots that
                    // post "no song detected" every minute clutter chat.
                    return;
                }
                var title  = _current.Title;
                var artist = string.IsNullOrEmpty(_current.Artist) ? "" : " — " + _current.Artist;
                var note   = _current.IsPlaying ? "" : " (paused)";
                var who    = string.IsNullOrEmpty(_current.RequestedBy) ? "" : "  · req by " + _current.RequestedBy;
                reply = "🎵 " + title + artist + note + who;
            }

            // Mods + broadcaster bypass cooldown (same convention as
            // InfoCommandsModule) so a streamer testing the integration
            // can fire it back-to-back.
            var u = (ctx.UserType ?? "").ToLowerInvariant();
            var bypass = (u == "broadcaster" || u == "moderator" || u == "mod");
            var cdSec = Math.Max(0, cfg.SongCooldownSec);
            if (bypass)
            {
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands)) return;
            }
            else
            {
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "info:song",
                        TimeSpan.FromSeconds(cdSec))) return;
            }

            new MultiPlatformSender(CphPlatformSender.Instance)
                .Send(ctx.Platform, reply, s.Platforms);
            EventStats.Instance.Hit(ctx.Kind, nameof(NowPlayingModule));
        }

        // Latest cached payload. Public so other surfaces (overlays,
        // future modules) can read it without subscribing to the bus
        // independently. Returns null until the widget reports a track.
        public NowPlaying GetCurrent()
        {
            lock (_gate) return _current;
        }

        public sealed class NowPlaying
        {
            public string   Title       { get; set; }
            public string   Artist      { get; set; }
            public string   Album       { get; set; }
            public string   Source      { get; set; }
            public bool     IsPlaying   { get; set; }
            public string   RequestedBy { get; set; }
            public DateTime ReceivedUtc { get; set; }
        }
    }
}
