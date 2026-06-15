// PrinterBot Discord relay endpoint.
//
// Mirrors the PrinterBot thermal-receipt feed into a Discord channel.
// The Streamer.bot print action calls POST /printerbot/discord-relay
// after rendering the receipt PNG; we forward the file + caption to
// Discord using the bot token already configured for the Worker.
//
// Why a Worker endpoint and not direct SB -> Discord?
//   • Keeps the bot token off Clay's PC and out of the SB action body.
//   • SB only needs PRINTERBOT_RELAY_SECRET (low-blast-radius secret).
//   • One choke point for rate-limit handling, channel rotation, etc.
//
// Request:
//   POST /printerbot/discord-relay
//   Header: x-printerbot-secret: <shared secret, matches PRINTERBOT_RELAY_SECRET>
//   Body (multipart/form-data):
//     image       file       the rendered receipt PNG
//     caption     string     e.g. "@viewer sent Heart Me"   (optional)
//     channel_id  string     override target channel        (optional)
//
// Response: always 200 with a small JSON status payload. Discord
// errors are logged but never propagated to SB, so a Discord outage
// doesn't break the thermal print queue.
//
// Env:
//   DISCORD_BOT_TOKEN              bot identity for the upload
//   PRINTERBOT_RELAY_SECRET        shared secret (header value)
//   PRINTERBOT_DISCORD_CHANNEL_ID  default target channel snowflake
//                                  (defaults to the live receipt channel
//                                   1508871768817795082 if unset)

const DEFAULT_CHANNEL = '1508871768817795082';

function jsonOk(extra = {}) {
  return new Response(JSON.stringify({ ok: true, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonStatus(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Constant-time-ish secret compare to keep the shape consistent with
// the rest of the Worker auth code. Both inputs are short strings, so
// a basic length+xor loop is enough; nothing here is a timing oracle.
function secretMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handlePrinterBotDiscordRelay(req, env) {
  // Shape check first. If the secret env var isn't set, this endpoint
  // is effectively disabled and returns 503 so the operator knows to
  // configure it. Without a secret we won't trust any inbound request.
  const expected = env.PRINTERBOT_RELAY_SECRET;
  if (!expected) {
    return jsonStatus({ ok: false, error: 'relay-secret-not-configured' }, 503);
  }
  const got = req.headers.get('x-printerbot-secret') || '';
  if (!secretMatches(got, expected)) {
    return jsonStatus({ ok: false, error: 'unauthorized' }, 401);
  }

  // Parse multipart up front. If SB sends the wrong content-type or no
  // image part we still return 200 (fail-open) but tag the response so
  // an operator looking at logs can see the misconfig.
  let form;
  try {
    form = await req.formData();
  } catch (err) {
    console.warn('[printerbot-relay] form parse failed:', err?.message || err);
    return jsonOk({ skipped: 'bad-form' });
  }

  const file = form.get('image');
  if (!file || typeof file === 'string') {
    return jsonOk({ skipped: 'no-image' });
  }

  const caption = (form.get('caption') || '').toString().slice(0, 1900);
  const channelArg = (form.get('channel_id') || '').toString().trim();
  const channelId = channelArg || env.PRINTERBOT_DISCORD_CHANNEL_ID || DEFAULT_CHANNEL;

  if (!env.DISCORD_BOT_TOKEN) {
    console.warn('[printerbot-relay] DISCORD_BOT_TOKEN not configured, skipping post');
    return jsonOk({ skipped: 'no-bot-token' });
  }

  // Re-pack into a Discord-flavoured multipart body. Discord accepts
  // files[0] + payload_json with content; we send caption as content
  // so it renders alongside the receipt thumbnail.
  const fd = new FormData();
  const filename = (file.name && /\.(png|jpe?g|gif|webp)$/i.test(file.name)) ? file.name : 'receipt.png';
  fd.append('files[0]', file, filename);
  fd.append('payload_json', JSON.stringify({
    content: caption || '',
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename, description: 'PrinterBot receipt' }],
  }));

  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'User-Agent': 'loadout-discord printerbot-relay',
        },
        body: fd,
      },
    );
    if (!res.ok) {
      const body = await res.text();
      // Never echo the token; log status + first 200 chars of the
      // error body so we can debug without leaking credentials.
      console.warn('[printerbot-relay] discord rejected', res.status, body.slice(0, 200));
      return jsonOk({ posted: false, status: res.status });
    }
    return jsonOk({ posted: true });
  } catch (err) {
    console.warn('[printerbot-relay] discord fetch failed:', err?.message || err);
    return jsonOk({ posted: false, error: 'fetch-failed' });
  }
}
