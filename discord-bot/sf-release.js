// SF release-notes posting, ported from the retired
// StreamFusion/bot-service/index.js /post-release handler.
//
// Voice-channel detection (the only thing that needed a persistent
// Gateway connection) was scrapped per Clay's bot-consolidation
// decision; this is the one piece worth keeping, so it moves into
// the Loadout Worker.
//
// Route: POST /sf/post-release
// Auth:  X-SF-Release-Secret header == env.SF_RELEASE_SECRET
//        (same shared-secret-in-request pattern the old endpoint
//         used, just promoted from a JSON-body field to a header
//         so it doesn't surface in logs of body payloads)
//
// Body (JSON):
//   {
//     channelId:   "1494765819891159202",     required
//     version:     "1.5.0",                   required
//     title?:      "StreamFusion 1.5.0",
//     body?:       "## Highlights ...",       used when summary absent
//     summary?:    "Short user-friendly blurb when provided, full
//                   release notes get linked underneath."
//     url?:        "https://github.com/.../releases/tag/v1.5.0",
//     color?:      0x7c5cff (default, aquilo violet),
//     pingRoleId?: "1486090420675936488"      optional role mention
//   }
//
// Returns: { ok, messageId, channelId } or { ok: false, error }.
//
// Posts as the unified Loadout bot (the surviving Discord app after
// consolidation). The pre-1.7 StreamFusion bot identity is retired, // any release-notes channel where the old SF bot was the author will
// now see the Loadout bot post instead. That's intentional (one bot
// is the whole point of the consolidation).

const EMBED_DESC_MAX = 4096;

export async function handlePostRelease(req, env) {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method' }, 405);
  }
  const headerSecret = req.headers.get('x-sf-release-secret') || '';
  if (!env.SF_RELEASE_SECRET) return json({ ok: false, error: 'disabled' }, 503);
  if (headerSecret !== env.SF_RELEASE_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DISCORD_BOT_TOKEN) return json({ ok: false, error: 'no_bot_token' }, 500);

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const channelId = String(body.channelId || '').trim();
  if (!/^\d{15,25}$/.test(channelId)) {
    return json({ ok: false, error: 'invalid_channel_id' }, 400);
  }

  // Description = summary OR full body, capped at Discord's 4096 limit.
  // When `summary` is present, always append a "Full release notes →"
  // link, the whole point of a summary is to keep the embed short
  // and point readers at the full body on GitHub.
  let desc = String(body.summary || body.body || '');
  const linkSuffix = '\n\n[Full release notes on GitHub →](' + (body.url || '#') + ')';
  if (body.summary) {
    if ((desc.length + linkSuffix.length) <= EMBED_DESC_MAX) {
      desc = desc + linkSuffix;
    } else {
      desc = desc.slice(0, EMBED_DESC_MAX - linkSuffix.length - 20).replace(/\n[^\n]*$/, '') + '\n…' + linkSuffix;
    }
  } else if (desc.length > EMBED_DESC_MAX) {
    desc = desc.slice(0, EMBED_DESC_MAX - 80).replace(/\n[^\n]*$/, '') + linkSuffix;
  }

  const version = String(body.version || '');
  const embed = {
    title:       String(body.title || ('StreamFusion ' + version)).slice(0, 256),
    description: desc,
    url:         body.url || undefined,
    // Default colour was SF blue (0x3A86FF) in the old service; the
    // post-rebrand default is aquilo violet (0x7C5CFF) so it matches
    // the rest of the brand. Callers can still override.
    color:       typeof body.color === 'number' ? body.color : 0x7c5cff,
    timestamp:   new Date().toISOString(),
    footer:      { text: 'StreamFusion v' + (version || '?') },
  };

  const payload = {
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };
  const pingRoleId = body.pingRoleId ? String(body.pingRoleId).trim() : '';
  if (pingRoleId && /^\d{15,25}$/.test(pingRoleId)) {
    payload.content = '<@&' + pingRoleId + '>';
    payload.allowed_mentions = { parse: [], roles: [pingRoleId] };
  }

  try {
    const r = await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type':  'application/json',
        'User-Agent':    'Loadout-Worker/1.0 (sf-release)',
      },
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    if (!r.ok) {
      return json({
        ok: false,
        error: 'discord_' + r.status,
        body: txt.slice(0, 400),
      }, r.status === 401 ? 502 : 502);
    }
    let msg;
    try { msg = JSON.parse(txt); } catch { msg = null; }
    if (msg && msg.id) return json({ ok: true, messageId: msg.id, channelId });
    return json({ ok: false, error: 'discord_no_id' }, 502);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
