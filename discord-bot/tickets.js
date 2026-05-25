// Aquilo ticketing system.
//
// Two entrypoints:
//   • /ticket [topic]          slash command
//   • button "ticket:open"     posted in any channel via admin
//
// Both open a NEW private text channel under the same category as the
// ticket-panel channel (configurable per-guild via the panel-post
// endpoint). Permission overwrites:
//   • @everyone           deny VIEW
//   • opener              allow VIEW + SEND + ATTACH + READ_HISTORY
//   • 🛡️ Moderator        allow VIEW + SEND + ATTACH + READ_HISTORY
//
// Close button on the ticket message:
//   • opener or staff can press
//   • saves the full message history as a transcript in KV
//   • locks the channel to read-only
//   • optionally deletes after a 24h grace (the grace is left to a
//     cron sweep we haven't wired yet — for now we just lock + mark)
//
// KV layout:
//   guild:ticket:<g>:<ticketId>            canonical record
//   guild:ticket-counter:<g>                next ticket integer
//   guild:ticket-transcript:<g>:<ticketId>  []{ts, userId, username, content}
//   guild:ticket-panel:<g>                  { channelId, messageId } — post target

const RESP_CHAT      = 4;
const RESP_UPDATE    = 7;
const FLAG_EPHEMERAL = 64;

const TYPE_GUILD_TEXT = 0;
const PERM_VIEW_CHANNEL    = 0x400n;
const PERM_SEND_MESSAGES   = 0x800n;
const PERM_ATTACH_FILES    = 0x8000n;
const PERM_READ_HISTORY    = 0x10000n;
const PERM_USE_APP_COMMANDS = 0x80000000n;

const MAX_TICKETS_PER_USER = 3;
const MAX_TOPIC_LEN = 100;

function eph(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}

async function dapi(env, method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? safeParse(text) : null, raw: text };
}
function safeParse(t) { try { return JSON.parse(t); } catch { return null; } }

async function loadGuildCfg(env, guildId) {
  return env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
}

// ── Open a ticket (called from /ticket OR the button) ──────────────────

export async function openTicket(env, guildId, openerId, openerName, topic) {
  const cfg = await loadGuildCfg(env, guildId);
  if (!cfg?.ids) return { ok: false, error: 'guild-not-configured' };
  const modRole = cfg.ids.role_mod;
  const everyone = guildId; // @everyone has the guild id

  // Pick the parent category for new ticket channels. Prefer the
  // configured ticket-panel channel's parent; else the products
  // category from the guild build.
  const panel = await env.LOADOUT_BOLTS.get(`guild:ticket-panel:${guildId}`, { type: 'json' });
  let parentId = null;
  if (panel?.channelId) {
    const ch = await dapi(env, 'GET', `/channels/${panel.channelId}`);
    if (ch.ok) parentId = ch.body?.parent_id;
  }
  if (!parentId) parentId = cfg.ids.cat_products || cfg.ids.cat_start;

  // Cap open tickets per user.
  const openCount = await countOpenTicketsForUser(env, guildId, openerId);
  if (openCount >= MAX_TICKETS_PER_USER) {
    return { ok: false, error: 'too-many-open-tickets', max: MAX_TICKETS_PER_USER, count: openCount };
  }

  // Increment counter
  const counterRaw = await env.LOADOUT_BOLTS.get(`guild:ticket-counter:${guildId}`);
  const next = (parseInt(counterRaw || '0', 10) || 0) + 1;
  await env.LOADOUT_BOLTS.put(`guild:ticket-counter:${guildId}`, String(next));

  const ticketId = `T${String(next).padStart(4, '0')}`;
  const safeName = (openerName || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) || 'user';
  const channelName = `ticket-${String(next).padStart(4, '0')}-${safeName}`;

  // Create the channel with overwrites
  const allow = String(PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_ATTACH_FILES | PERM_READ_HISTORY | PERM_USE_APP_COMMANDS);
  const overwrites = [
    { id: everyone, type: 0, allow: '0', deny: String(PERM_VIEW_CHANNEL) },
    { id: openerId, type: 1, allow, deny: '0' },
  ];
  if (modRole) overwrites.push({ id: modRole, type: 0, allow, deny: '0' });

  const create = await dapi(env, 'POST', `/guilds/${guildId}/channels`, {
    name: channelName,
    type: TYPE_GUILD_TEXT,
    parent_id: parentId || undefined,
    permission_overwrites: overwrites,
    topic: (topic || '').slice(0, MAX_TOPIC_LEN) || 'Support ticket',
  });
  if (!create.ok) return { ok: false, error: 'create-channel-failed', status: create.status, body: create.raw.slice(0, 200) };
  const channelId = create.body.id;

  // Save the canonical record
  const rec = {
    ticketId, guildId, openerUserId: openerId, openerName,
    channelId, parentId, topic: (topic || '').slice(0, MAX_TOPIC_LEN),
    createdUtc: Date.now(), status: 'open',
    closedUtc: 0, closedBy: null,
  };
  await env.LOADOUT_BOLTS.put(`guild:ticket:${guildId}:${ticketId}`, JSON.stringify(rec));

  // Welcome message in the new channel with a Close button
  const welcome = await dapi(env, 'POST', `/channels/${channelId}/messages`, {
    content: `**Ticket ${ticketId}** opened by <@${openerId}>\n${topic ? `Topic: _${topic}_\n` : ''}\nA staff member will be with you shortly. Click **Close** when the issue is resolved.`,
    components: [{
      type: 1,
      components: [{
        type: 2, style: 4, label: '🔒 Close ticket',
        custom_id: `ticket:close:${ticketId}`,
      }],
    }],
  });
  if (welcome.ok) rec.welcomeMsgId = welcome.body.id;

  // Append the welcome to the transcript as the first entry
  await appendTranscript(env, guildId, ticketId, {
    ts: Date.now(),
    userId: openerId,
    username: openerName,
    content: `[ticket opened] topic: ${topic || '(none)'}`,
  });

  return { ok: true, ticket: rec, channelId };
}

async function countOpenTicketsForUser(env, guildId, openerId) {
  const prefix = `guild:ticket:${guildId}:`;
  let cursor;
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys) {
      const t = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (t && t.status === 'open' && String(t.openerUserId) === String(openerId)) n++;
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return n;
}

// ── Close a ticket ─────────────────────────────────────────────────────

export async function closeTicket(env, guildId, ticketId, closerId) {
  const key = `guild:ticket:${guildId}:${ticketId}`;
  const rec = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  if (!rec) return { ok: false, error: 'not-found' };
  if (rec.status === 'closed') return { ok: true, alreadyClosed: true, ticket: rec };

  // Authorization: opener OR staff.
  const cfg = await loadGuildCfg(env, guildId);
  const modRole = cfg?.ids?.role_mod;
  const m = await dapi(env, 'GET', `/guilds/${guildId}/members/${closerId}`);
  const isStaff = m.ok && modRole && (m.body.roles || []).includes(modRole);
  const isOpener = String(closerId) === String(rec.openerUserId);
  if (!isOpener && !isStaff) return { ok: false, error: 'not-authorized' };

  // Fetch full message history (paginated). Up to ~500 messages saved
  // — past that, we save the most recent 500 to bound KV write size.
  let before = null;
  const all = [];
  for (let i = 0; i < 5; i++) {
    const path = `/channels/${rec.channelId}/messages?limit=100${before ? '&before='+before : ''}`;
    const r = await dapi(env, 'GET', path);
    if (!r.ok || !Array.isArray(r.body) || r.body.length === 0) break;
    for (const m of r.body) {
      all.push({
        ts: Date.parse(m.timestamp) || Date.now(),
        userId: m.author?.id,
        username: m.author?.global_name || m.author?.username || 'unknown',
        bot: !!m.author?.bot,
        content: (m.content || '').slice(0, 2000),
        attachments: (m.attachments || []).map(a => a.url),
      });
    }
    before = r.body[r.body.length - 1].id;
    if (r.body.length < 100) break;
  }
  all.reverse();
  await env.LOADOUT_BOLTS.put(`guild:ticket-transcript:${guildId}:${ticketId}`, JSON.stringify(all));

  // Lock the channel — deny SEND for the opener and the @everyone catch.
  const cur = await dapi(env, 'GET', `/channels/${rec.channelId}`);
  if (cur.ok) {
    const everyone = guildId;
    const allowView = String(PERM_VIEW_CHANNEL | PERM_READ_HISTORY);
    const overwrites = [
      { id: everyone, type: 0, allow: '0', deny: String(PERM_VIEW_CHANNEL) },
      { id: rec.openerUserId, type: 1, allow: allowView, deny: String(PERM_SEND_MESSAGES) },
    ];
    if (modRole) overwrites.push({ id: modRole, type: 0, allow: String(PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY), deny: '0' });
    await dapi(env, 'PATCH', `/channels/${rec.channelId}`, {
      name: `closed-${rec.ticketId.toLowerCase()}`,
      permission_overwrites: overwrites,
    });
  }

  // Post closure message
  await dapi(env, 'POST', `/channels/${rec.channelId}/messages`, {
    content: `🔒 Ticket closed by <@${closerId}>. The channel is now read-only and will be archived. Transcript saved.`,
  });

  rec.status = 'closed';
  rec.closedUtc = Date.now();
  rec.closedBy = closerId;
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec));
  return { ok: true, ticket: rec, transcriptCount: all.length };
}

async function appendTranscript(env, guildId, ticketId, entry) {
  const key = `guild:ticket-transcript:${guildId}:${ticketId}`;
  let list = [];
  const raw = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  if (Array.isArray(raw)) list = raw;
  list.push(entry);
  if (list.length > 500) list = list.slice(-500);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(list));
}

// ── Post the ticket-panel button message in a channel ──────────────────

export async function postTicketPanel(env, guildId, channelId) {
  const r = await dapi(env, 'POST', `/channels/${channelId}/messages`, {
    embeds: [{
      title: '🎫  Need help?',
      description:
        'Click **Open a ticket** below to start a private conversation with the staff team. ' +
        'Use it for moderation issues, payment questions, account problems, or anything else ' +
        'you\'d rather not share publicly.\n\n' +
        '_Tip: you can also run `/ticket` from any channel._',
      color: 0x57F287,
    }],
    components: [{
      type: 1,
      components: [{
        type: 2, style: 3, label: '🎫 Open a ticket',
        custom_id: 'ticket:open',
      }],
    }],
  });
  if (!r.ok) return { ok: false, status: r.status, body: r.raw.slice(0, 200) };
  await env.LOADOUT_BOLTS.put(`guild:ticket-panel:${guildId}`, JSON.stringify({
    channelId, messageId: r.body.id, postedUtc: Date.now(),
  }));
  return { ok: true, channelId, messageId: r.body.id };
}

// ── Slash command + button dispatchers ─────────────────────────────────

export async function handleTicketCommand(env, data) {
  const guildId = data.guild_id;
  const userId = data?.member?.user?.id || data?.user?.id;
  const userName = data?.member?.user?.global_name || data?.member?.user?.username || 'user';
  if (!guildId || !userId) return eph('Run this in a server.');

  const opts = data.data?.options || [];
  const topic = opts.find(o => o.name === 'topic')?.value || '';
  const result = await openTicket(env, guildId, userId, userName, topic);
  if (!result.ok) {
    if (result.error === 'too-many-open-tickets') {
      return eph(`You already have ${result.count} open ticket(s). Close one before opening another (max ${result.max}).`);
    }
    return eph(`Couldn't open the ticket: ${result.error}`);
  }
  return eph(`✅ Ticket opened: <#${result.channelId}>`);
}

export async function handleTicketComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const guildId = data.guild_id;
  const userId = data?.member?.user?.id || data?.user?.id;
  const userName = data?.member?.user?.global_name || data?.member?.user?.username || 'user';
  if (!guildId || !userId) return eph('Run this in a server.');

  if (cid === 'ticket:open') {
    const result = await openTicket(env, guildId, userId, userName, '');
    if (!result.ok) {
      if (result.error === 'too-many-open-tickets') {
        return eph(`You already have ${result.count} open ticket(s). Close one before opening another (max ${result.max}).`);
      }
      return eph(`Couldn't open the ticket: ${result.error}`);
    }
    return eph(`✅ Ticket opened: <#${result.channelId}>`);
  }
  if (cid.startsWith('ticket:close:')) {
    const ticketId = cid.slice('ticket:close:'.length);
    const result = await closeTicket(env, guildId, ticketId, userId);
    if (!result.ok) {
      if (result.error === 'not-authorized') return eph('Only the ticket opener or staff can close this ticket.');
      return eph(`Couldn't close: ${result.error}`);
    }
    if (result.alreadyClosed) return eph('Already closed.');
    return eph(`✅ Closed. Transcript saved (${result.transcriptCount} message(s)).`);
  }
  return eph(`Unknown ticket action: \`${cid}\`.`);
}
