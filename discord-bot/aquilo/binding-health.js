// Daily binding health check. A dozen community features post to KV-only
// channel bindings that silently no-op when unbound. During the Claude
// pause, silent breakage is the failure mode to guard against, so this
// posts a once-daily warning to the bot-admin channel listing any CORE
// binding that a live feature consumes but that is currently unbound. If
// everything is bound it stays silent.
//
// Public API: runBindingHealthCron(env)

import { listChannelBindings } from "../channel-bindings.js";
import { postChannelMessage } from "./util.js";
import { todayET } from "../community-checkin.js";

// Bindings the community actively depends on; unbound = that feature is dark.
const CORE = ["welcome", "checkin", "live", "recap", "poll", "clips", "schedule"];

export async function runBindingHealthCron(env) {
  const guildId = env.AQUILO_VAULT_GUILD_ID;
  const adminCh = env.AQUILO_ADMIN_HUB_CHANNEL_ID;
  if (!guildId || !adminCh || !env.LOADOUT_BOLTS) return { ok: false, reason: "no-config" };

  const dayKey = `binding-health:sent:${guildId}:${todayET()}`;
  if (await env.LOADOUT_BOLTS.get(dayKey)) return { ok: true, skipped: "already" };

  let all;
  try {
    all = await listChannelBindings(env, guildId);
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "list-failed" };
  }

  const unbound = CORE.filter((k) => !all[k] || !all[k].resolved);
  // Reserve the day so we warn at most once per day regardless of outcome.
  await env.LOADOUT_BOLTS.put(dayKey, "1", { expirationTtl: 30 * 3600 });
  if (!unbound.length) return { ok: true, healthy: true };

  try {
    await postChannelMessage(env, adminCh, {
      embeds: [
        {
          title: "Binding health: some channels are not set",
          description:
            "These community features post to a channel that is not bound, so they are silently doing nothing:\n\n" +
            unbound.map((k) => "- `" + k + "`").join("\n") +
            "\n\nBind them from the /admin Setup dashboard (or set the matching channel-id env var).",
          color: 0xffb454,
        },
      ],
    });
    return { ok: true, unbound };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "post-failed" };
  }
}
