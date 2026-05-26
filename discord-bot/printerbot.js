// PrinterBot → Discord webhook helper.
//
// Clay's PrinterBot generates receipt-style images of viewer events
// (subs/cheers/tips) and posts them directly into a dedicated Discord
// channel. Rather than route those through the bot token (which would
// require maintaining a Gateway connection AND eat slash-command rate
// limits), we create a channel-scoped Discord webhook once and hand
// the resulting URL to Streamer.bot.
//
// Persistence: `printerbot:webhook-url:<guildId>` →
//   { url, webhookId, channelId, createdAt, reused }
//
// Rotation: re-running setup against the same channel re-uses any
// existing webhook named "PrinterBot" (Discord doesn't return the
// token on subsequent GETs unless we created it). If Clay needs a
// fresh token, delete the webhook via Discord first, then re-run
// setup.

const KEY = (g) => `printerbot:webhook-url:${g}`;
const DEFAULT_NAME = 'PrinterBot';

// Create (or reuse) a channel webhook + persist the URL. Caller has
// already authenticated. Returns:
//   { ok: true,  url, webhookId, channelId, reused }
//   { ok: false, error, status?, body? }
export async function ensurePrinterBotWebhook(env, guildId, channelId, name = DEFAULT_NAME) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId)   return { ok: false, error: 'guild-id-required' };
  if (!channelId) return { ok: false, error: 'channel-id-required' };

  // List existing webhooks in the channel — re-use one we already
  // own to keep the URL stable across re-runs.
  const listRes = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/webhooks`,
    {
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent':  'loadout-discord printerbot',
      },
    },
  );
  if (!listRes.ok) {
    const t = await listRes.text();
    return { ok: false, error: 'webhooks-list-failed', status: listRes.status, body: t.slice(0, 200) };
  }
  const existing = await listRes.json();
  if (Array.isArray(existing)) {
    const reuse = existing.find(w => w && w.name === name && w.token);
    if (reuse) {
      const url = `https://discord.com/api/webhooks/${reuse.id}/${reuse.token}`;
      await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify({
        url,
        webhookId: String(reuse.id),
        channelId: String(channelId),
        createdAt: Date.now(),
        reused: true,
      }));
      return { ok: true, url, webhookId: String(reuse.id), channelId: String(channelId), reused: true };
    }
  }

  // Create a fresh one. Discord returns `{ id, token, ... }`; the
  // token is only included on the POST response, never on
  // subsequent GETs.
  const createRes = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/webhooks`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent':  'loadout-discord printerbot',
        'X-Audit-Log-Reason': 'PrinterBot webhook for receipt-style image relay',
      },
      body: JSON.stringify({ name }),
    },
  );
  if (!createRes.ok) {
    const t = await createRes.text();
    return { ok: false, error: 'create-failed', status: createRes.status, body: t.slice(0, 200) };
  }
  const j = await createRes.json();
  if (!j?.id || !j?.token) {
    return { ok: false, error: 'no-id-or-token-in-response' };
  }
  const url = `https://discord.com/api/webhooks/${j.id}/${j.token}`;
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify({
    url,
    webhookId: String(j.id),
    channelId: String(channelId),
    createdAt: Date.now(),
    reused: false,
  }));
  return { ok: true, url, webhookId: String(j.id), channelId: String(channelId), reused: false };
}

export async function readPrinterBotWebhook(env, guildId) {
  if (!env.LOADOUT_BOLTS || !guildId) return null;
  return env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' });
}
