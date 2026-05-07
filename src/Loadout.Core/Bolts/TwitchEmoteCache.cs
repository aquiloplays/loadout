using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Bolts
{
    /// <summary>
    /// Rolling, in-memory cache of Twitch emote URLs harvested from
    /// chat events. Populated as the broadcaster + chatters use
    /// emotes — channel-tier sub emotes naturally dominate because
    /// they show up most in the broadcaster's chat. Used by the
    /// !slots minigame's symbol pool when
    /// <c>BoltsConfig.SlotsUseTwitchEmotes</c> is on, so the
    /// streamer doesn't have to manually paste a list of emote URLs.
    ///
    /// Capped at <see cref="Cap"/> entries (FIFO eviction). Keys by
    /// emote ID so the same emote re-used in multiple messages doesn't
    /// inflate the pool.
    /// </summary>
    public sealed class TwitchEmoteCache
    {
        private const int Cap = 64;

        private static TwitchEmoteCache _instance;
        public static TwitchEmoteCache Instance => _instance ?? (_instance = new TwitchEmoteCache());

        private readonly ConcurrentDictionary<string, string> _byId = new ConcurrentDictionary<string, string>();
        private readonly object _orderGate = new object();
        private readonly Queue<string> _order = new Queue<string>();   // FIFO of ids for cap-eviction

        /// <summary>
        /// Harvest every emote SB attached to this chat event, no-op
        /// when the event isn't from Twitch or carries no emote args.
        /// SB exposes Twitch emotes as numbered keys (emote0Id /
        /// emote0ImageUrl / emoteCount); same shape CheckInModule
        /// reads for the per-viewer message render.
        /// </summary>
        public void Harvest(EventContext ctx)
        {
            if (ctx == null) return;
            if (ctx.Platform != PlatformMask.Twitch) return;
            int count = ctx.Get<int>("emoteCount", 0);
            if (count <= 0) return;
            for (int i = 0; i < count; i++)
            {
                var id  = ctx.Get<string>("emote" + i + "Id",
                          ctx.Get<string>("emote" + i + "ID", null));
                if (string.IsNullOrEmpty(id)) continue;
                var url = ctx.Get<string>("emote" + i + "ImageUrl",
                          ctx.Get<string>("emote" + i + "Url", null));
                if (string.IsNullOrEmpty(url))
                {
                    // Reconstruct the standard CDN URL when SB only gave us
                    // the ID. v2 path with dark theme + 2.0 scale is the
                    // safest middle-of-the-road for the slots reel cell.
                    url = "https://static-cdn.jtvnw.net/emoticons/v2/" + id + "/default/dark/2.0";
                }

                if (_byId.TryAdd(id, url))
                {
                    lock (_orderGate)
                    {
                        _order.Enqueue(id);
                        while (_order.Count > Cap)
                        {
                            var dropId = _order.Dequeue();
                            _byId.TryRemove(dropId, out _);
                        }
                    }
                }
            }
        }

        /// <summary>Snapshot the current pool as a flat URL list. Order is
        /// insertion (oldest emote first). Caller can shuffle / pick
        /// freely without affecting the cache.</summary>
        public IReadOnlyList<string> SnapshotUrls()
        {
            return _byId.Values.ToList();
        }

        /// <summary>Diagnostic — total emotes seen this session.</summary>
        public int Count => _byId.Count;

        /// <summary>Wipe the cache. Intended for the dry-run / Settings
        /// "Reset" affordance, not the hot path.</summary>
        public void Clear()
        {
            _byId.Clear();
            lock (_orderGate) { _order.Clear(); }
        }
    }
}
