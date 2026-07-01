// POST /announce/channel — site announcement → Discord announcements channel.
//
// Direction B of the announce↔push bridge: aquilo.gg's /api/announce calls
// this (HMAC-signed with AQUILO_SITE_WEB_SECRET) when the owner ticks "post to
// Discord". We post an embed into env.ANNOUNCE_DISCORD_CHANNEL_ID as the bot.
// Because the message is bot-authored, Direction A (aquilo/worker.js
// /counting/message) ignores it, so it never bounces back as a PWA push.

import { verifyHmac } from './auth.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function handleAnnounceChannel(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!env.AQUILO_SITE_WEB_SECRET) return json({ error: 'not-configured' }, 503);
  if (!env.DISCORD_BOT_TOKEN) return json({ error: 'no-bot-token' }, 503);
  const channelId = String(env.ANNOUNCE_DISCORD_CHANNEL_ID || '').trim();
  if (!channelId) return json({ error: 'no-announce-channel' }, 503);

  const bodyText = await req.text();
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  if (!(await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || ''))) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body; try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad-json' }, 400); }

  const title = String(body.title || '').slice(0, 256).trim();
  const text = String(body.body || '').slice(0, 1800).trim();
  const link = String(body.link || '').slice(0, 400).trim();
  if (!title && !text) return json({ error: 'empty' }, 400);

  const embed = {
    title: title || 'Announcement',
    color: 0x9147ff,
  };
  if (text) embed.description = text;
  if (/^https?:\/\//i.test(link)) embed.url = link;

  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'content-type': 'application/json',
      'User-Agent': 'loadout-discord announce-channel',
    },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return json({ ok: false, status: r.status, body: t.slice(0, 200) }, 502);
  }
  const j = await r.json().catch(() => ({}));
  return json({ ok: true, messageId: j.id });
}
