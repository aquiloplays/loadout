// Central helper — is this shim-forwarded MESSAGE_CREATE / reaction /
// member-add / voice-state event from a Discord bot?
//
// The aquilo-gateway shim (see aquilo-gateway/aquilo_gateway.py)
// forwards every event including the bot's own outgoing messages.
// Reward handlers (counting bolts, checkin streak, clip_curator
// achievement, etc.) MUST skip when the originating author is a bot,
// or:
//   • bots earn the rewards we hand out to humans,
//   • our own bot's replies feed back into the handler (loop), and
//   • achievement counts get inflated by automation.
//
// The shim's payload shape places the flag in MULTIPLE locations
// depending on the event type:
//   payload.bot        — legacy top-level (older payloads)
//   payload.isBot      — camelCase mirror added in the May 2026 shim
//   payload.author.bot — Discord-slim subset (MESSAGE_CREATE shape)
//   payload.user.bot   — GUILD_MEMBER_ADD shape
//
// Checking only one of these is what produced the May 2026 counting
// loop. Always use this helper.

export function isBotPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.bot === true) return true;
  if (payload.isBot === true) return true;
  if (payload.author && payload.author.bot === true) return true;
  if (payload.user && payload.user.bot === true) return true;
  return false;
}

// Exposed for parity with the other test-friendly underscore aliases
// in this repo.
export { isBotPayload as _isBotPayloadForTest };
