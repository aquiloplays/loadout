using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Auto-timed messages with the smart-behavior rules promised in the spec:
    /// activity gate, cooldown after broadcaster, randomized order, per-platform
    /// routing, pause when offline.
    ///
    /// Tick is the natural cadence (once a minute). Activity tracking listens to
    /// chat events and stores a sliding window of recent message timestamps.
    /// </summary>
    public sealed class TimedMessagesModule : IEventModule
    {
        // Sliding window of recent chat message timestamps for the activity gate.
        // Bounded - older entries roll off as we sample.
        private readonly LinkedList<DateTime> _recentChats = new LinkedList<DateTime>();
        private const int RecentChatsWindowMinutes = 30;

        private DateTime _lastBroadcasterMessageUtc = DateTime.MinValue;
        private DateTime _lastFiredUtc = DateTime.MinValue;
        private int _seqIndex;

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;

            // Broadcaster-typed chat arms the cooldown that pauses timers
            // right after the streamer talks. This runs EVEN when the
            // broadcaster ambient-ignore flag is set, the pause gate is
            // the whole point of watching their messages.
            //
            // EXCEPTION: when the bot sends through the broadcaster
            // account (UseBotAccount == false) every auto-message we
            // emit comes back through here labeled "broadcaster". Arming
            // the pause on our own echo creates a feedback loop that
            // delays the next message for BroadcasterPauseSec for no
            // reason. We detect the echo by matching the last message
            // we just sent and skip the pause arm.
            if (string.Equals(ctx.UserType, "broadcaster", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsOurOwnEcho(ctx.Message))
                    _lastBroadcasterMessageUtc = DateTime.UtcNow;
            }

            // Activity gate: count VIEWER chat. Broadcaster lines are
            // excluded under ambient-ignore so the streamer narrating an
            // empty room doesn't convince the timers the room is active.
            // Also drop our own echo when ambient-ignore is OFF so the
            // auto-message itself never inflates the activity count.
            if (ctx.SuppressAmbient) return;
            if (string.Equals(ctx.UserType, "broadcaster", StringComparison.OrdinalIgnoreCase)
                && IsOurOwnEcho(ctx.Message)) return;
            lock (_recentChats)
            {
                _recentChats.AddLast(DateTime.UtcNow);
                Trim();
            }
        }

        // Echo-detect window: SB chat echo usually lands within ~3s of
        // send; we keep the marker for 10s for safety on slow hosts.
        private string _lastSentText;
        private DateTime _lastSentUtc = DateTime.MinValue;
        private const int EchoMatchWindowSec = 10;

        private bool IsOurOwnEcho(string incoming)
        {
            if (string.IsNullOrEmpty(_lastSentText) || string.IsNullOrEmpty(incoming)) return false;
            if ((DateTime.UtcNow - _lastSentUtc).TotalSeconds > EchoMatchWindowSec) return false;
            return string.Equals(_lastSentText.Trim(), incoming.Trim(), StringComparison.Ordinal);
        }

        public void OnTick()
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.TimedMessages || !s.Timers.Enabled) return;

            var due = SelectNextMessage(s);
            if (due == null) return;

            var sender = new MultiPlatformSender(CphPlatformSender.Instance);
            var target = due.Platforms.AsMask;
            if (target == PlatformMask.None) target = s.Platforms.AsMask;

            var sent = sender.Send(target, due.Message, s.Platforms);

            if (sent == PlatformMask.None)
            {
                // Nothing actually went out (no enabled+connected platform,
                // every limiter at cap, or platform-cap is 0). Rolling the
                // cooldown forward here would silently swallow the message
                // and skip it in the rotation, the user-visible symptom is
                // "timers never fire". Leave _lastFiredUtc + _seqIndex
                // alone so the next tick retries with the same message.
                Util.EventStats.Instance.Hit("timer.noop", nameof(TimedMessagesModule));
                try { Sb.SbBridge.Instance.LogInfo("[Loadout] Timed message skipped, no eligible platform: " + Truncate(due.Message, 60)); } catch { }
                return;
            }

            // Remember what we just sent so the echo-detect filter in
            // OnEvent can ignore our own broadcaster-account echo (and
            // not arm the broadcaster pause against ourselves).
            _lastSentText = due.Message;
            _lastSentUtc  = DateTime.UtcNow;

            // Advance the sequence cursor ONLY on a real send; selection
            // intentionally re-reads the same message on retry ticks.
            AdvanceSequence(s);

            // Report to EventStats so the Health tab + OBS dock see the
            // timer fire. Using "timer.fired" as the kind matches the
            // domain-event naming the dock filters off.
            Util.EventStats.Instance.Hit("timer.fired", nameof(TimedMessagesModule));
