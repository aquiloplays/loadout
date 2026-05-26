// LFG (Looking-For-Game / "Open for playing") — shared between the
// aquilo.gg website + the /lfg Discord slash command.
//
// State layout (KV):
//   lfg:active:<lfgId>  { id, hostUserId, hostName, game, slots, players[],
//                          channelId, messageId, createdUtc, closedUtc? }
//   lfg:index           [{ lfgId, createdUtc }, ...]  newest first, cap 50
//
// Lifecycle:
//   1. createLfg() stores the record, posts a Discord embed in the
//      designated LFG channel, stamps the message id back on the
//      record so we can edit it later (player joins, closure).
//   2. joinLfg() appends a player; edits the embed.
//   3. closeLfg() (host or auto on full) edits the embed to "closed"
//      and moves the entry from active to archive.
//
// One config: LFG_CHANNEL_ID (set in wrangler.toml; per-guild via the
// future bindings dropdown) — falls back to ENGAGEMENT_CHANNEL_ID
// when unset so we don't break Day 1.

const ACTIVE_KEY = (id) => `lfg:active:${id}`;
const INDEX_KEY  = 'lfg:index';
const ARCHIVE_KEY = (id) => `lfg:archive:${id}`;
const INDEX_CAP = 50;

function newLfgId() {
  return 'lfg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

async function getIndex(env) {
  const raw = await env.LOADOUT_BOLTS.get(INDEX_KEY, { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}
async function putIndex(env, idx) {
  if (idx.length > INDEX_CAP) idx.length = INDEX_CAP;
  await env.LOADOUT_BOLTS.put(INDEX_KEY, JSON.stringify(idx));
}

// Designated LFG channel — first lookup checks per-guild config
// (lfg:channel:<guildId>) so admins can rebind via the dropdown.
async function resolveLfgChannel(env, guildId) {
  if (guildId) {
    try {
      const v = await env.LOADOUT_BOLTS.get(`lfg:channel:${guildId}`, { type: 'text' });
      if (v) return v;
    } catch { /* fall through */ }
  }
  // env.LFG_CHANNEL_ID is set by wrangler.toml's L9-build channel map
  // (1507973931372646490 → 🧩│looking-for-game). Falls back to the
  // engagement channel only if no LFG binding exists at all.
  return env.LFG_CHANNEL_ID || env.ENGAGEMENT_CHANNEL_ID || null;
}

// Build a Discord embed payload for an LFG entry. Used by both the
// initial post and the edits when players join / it closes.
function buildEmbed(lfg) {
  const open = !lfg.closedUtc && lfg.players.length < lfg.slots;
  const status = lfg.closedUtc
    ? '🔒 Closed'
    : (open ? `🎮 ${lfg.slots - lfg.players.length}/${lfg.slots} slots open` : '🟢 Full — starting soon');
  const playersList = lfg.players.length
    ? lfg.players.map(p => `<@${p.userId}>`).join(' · ')
    : '_no players yet — be the first!_';
  return {
    title: `Looking to play: ${lfg.game}`,
    description: status,
    color: lfg.closedUtc ? 0x6a7088 : 0x7c5cff,
    fields: [
      { name: 'Host', value: `<@${lfg.hostUserId}>`, inline: true },
      { name: 'Slots', value: `${lfg.players.length}/${lfg.slots}`, inline: true },
      { name: 'Players', value: playersList },
    ],
    footer: { text: `lfg id: ${lfg.id} · join via /lfg join id:${lfg.id} or aquilo.gg/lfg` },
    timestamp: new Date(lfg.createdUtc).toISOString(),
  };
}

// Post or edit the Discord embed for this LFG. Best-effort — if Discord
// fails, LFG state remains in KV so the website still works.
async function postOrEditEmbed(env, lfg) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const channelId = await resolveLfgChannel(env, lfg.guildId);
  if (!channelId) return { ok: false, error: 'no-lfg-channel-configured' };
  const embed = buildEmbed(lfg);
  // First time: POST a new message.
  if (!lfg.messageId) {
    const r = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: 'discord-post-failed', detail: txt.slice(0, 200), status: r.status };
    }
    const msg = await r.json();
    lfg.channelId = channelId;
    lfg.messageId = msg.id;
    return { ok: true, channelId, messageId: msg.id };
  }
  // Re-render existing message.
  const r = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(lfg.channelId)}/messages/${encodeURIComponent(lfg.messageId)}`,
    {
      method: 'PATCH',
      headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { ok: false, error: 'discord-edit-failed', detail: txt.slice(0, 200) };
  }
  return { ok: true };
}

// ── Public API ────────────────────────────────────────────────────

export async function createLfg(env, { userId, hostName, game, slots, guildId = null }) {
  if (!userId) return { ok: false, error: 'userId required' };
  const cleanGame = String(game || '').trim().slice(0, 80);
  if (!cleanGame) return { ok: false, error: 'game required' };
  const n = Math.max(1, Math.min(16, parseInt(slots, 10) || 0));
  if (!n) return { ok: false, error: 'slots required (1-16)' };
  // Optional rate-limit: don't allow >3 active LFGs per host
  const idx = await getIndex(env);
  const myActive = [];
  for (const e of idx) {
    const rec = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(e.lfgId), { type: 'json' });
    if (rec?.hostUserId === userId && !rec.closedUtc) myActive.push(rec.id);
  }
  if (myActive.length >= 3) return { ok: false, error: 'too-many-active', myActive };

  const lfg = {
    id: newLfgId(),
    hostUserId: userId,
    hostName: hostName || `Player ${userId.slice(-4)}`,
    game: cleanGame,
    slots: n,
    players: [{ userId, name: hostName || `Player ${userId.slice(-4)}` }],
    guildId,
    channelId: null,
    messageId: null,
    createdUtc: Date.now(),
    closedUtc: null,
  };
  // Post Discord embed first so we can stamp message id on the record.
  await postOrEditEmbed(env, lfg);
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY(lfg.id), JSON.stringify(lfg));
  idx.unshift({ lfgId: lfg.id, createdUtc: lfg.createdUtc });
  await putIndex(env, idx);
  // F2 — Fan out to host's friends (Discord DM + web-push). Fire-and-
  // forget; LFG state is already persisted so a fan-out failure
  // doesn't break the host's creation flow.
  try {
    const { notifyFriendsOfLfg } = await import('./friends.js');
    await notifyFriendsOfLfg(env, lfg);
  } catch (e) {
    console.warn('[lfg] friend fan-out failed:', e && e.message);
  }
  return { ok: true, lfg };
}

export async function joinLfg(env, lfgId, { userId, name }) {
  const lfg = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(lfgId), { type: 'json' });
  if (!lfg) return { ok: false, error: 'not-found' };
  if (lfg.closedUtc) return { ok: false, error: 'already-closed' };
  if (lfg.players.find(p => p.userId === userId)) return { ok: false, error: 'already-joined' };
  if (lfg.players.length >= lfg.slots) return { ok: false, error: 'full' };
  lfg.players.push({ userId, name: name || `Player ${userId.slice(-4)}` });
  // Auto-close when full.
  if (lfg.players.length >= lfg.slots) lfg.closedUtc = Date.now();
  await postOrEditEmbed(env, lfg);
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY(lfg.id), JSON.stringify(lfg));
  if (lfg.closedUtc) {
    await archive(env, lfg);
    return { ok: true, lfg, autoClosed: true };
  }
  return { ok: true, lfg };
}

export async function closeLfg(env, lfgId, byUserId) {
  const lfg = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(lfgId), { type: 'json' });
  if (!lfg) return { ok: false, error: 'not-found' };
  if (lfg.closedUtc) return { ok: true, alreadyClosed: true, lfg };
  // Only the host (or an admin caller — checked at the dispatch site)
  // can close.
  if (lfg.hostUserId !== byUserId) return { ok: false, error: 'forbidden' };
  lfg.closedUtc = Date.now();
  await postOrEditEmbed(env, lfg);
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY(lfg.id), JSON.stringify(lfg));
  await archive(env, lfg);
  return { ok: true, lfg };
}

async function archive(env, lfg) {
  await env.LOADOUT_BOLTS.put(ARCHIVE_KEY(lfg.id), JSON.stringify(lfg), { expirationTtl: 7 * 24 * 60 * 60 });
  await env.LOADOUT_BOLTS.delete(ACTIVE_KEY(lfg.id));
  const idx = await getIndex(env);
  await putIndex(env, idx.filter(e => e.lfgId !== lfg.id));
}

export async function listActiveLfgs(env, { limit = 50 } = {}) {
  const idx = await getIndex(env);
  const out = [];
  for (const e of idx.slice(0, limit)) {
    const rec = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(e.lfgId), { type: 'json' });
    if (rec && !rec.closedUtc) out.push(rec);
  }
  return out;
}

export async function readLfg(env, lfgId) {
  return await env.LOADOUT_BOLTS.get(ACTIVE_KEY(lfgId), { type: 'json' });
}

// ── HTTP dispatcher (HMAC-gated) ──────────────────────────────────

import { verifyHmac } from './auth.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

async function gateHmac(req, env) {
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return { ok: false, status: 503, error: 'AQUILO_SITE_WEB_SECRET missing' };
  }
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'unauthorized' };
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch { return { ok: false, status: 400, error: 'bad-json' }; }
  }
  return { ok: true, body };
}

export async function handleLfgRoute(req, env, path) {
  const url = new URL(req.url);
  // /web/lfg              GET list (public)
  // /web/lfg/<lfgId>      GET single (public)
  // /web/lfg/create       POST HMAC
  // /web/lfg/join         POST HMAC
  // /web/lfg/close        POST HMAC
  const parts = path.split('/').filter(Boolean);   // ['web','lfg', ...]
  const tail = parts[2] || null;

  if (req.method === 'GET' && !tail) {
    const list = await listActiveLfgs(env);
    return json({ active: list, count: list.length });
  }
  if (req.method === 'GET' && tail && !['create', 'join', 'close', 'list'].includes(tail)) {
    const rec = await readLfg(env, tail);
    if (!rec) return json({ error: 'not-found' }, 404);
    return json({ lfg: rec });
  }
  if (req.method === 'POST' && tail === 'create') {
    const gate = await gateHmac(req, env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const r = await createLfg(env, {
      userId: String(gate.body.userId || ''),
      hostName: gate.body.hostName,
      game: gate.body.game,
      slots: gate.body.slots,
      guildId: gate.body.guildId || null,
    });
    return json(r, r.ok ? 200 : 400);
  }
  if (req.method === 'POST' && tail === 'join') {
    const gate = await gateHmac(req, env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const r = await joinLfg(env, gate.body.lfgId, {
      userId: String(gate.body.userId || ''),
      name: gate.body.name,
    });
    return json(r, r.ok ? 200 : 400);
  }
  if (req.method === 'POST' && tail === 'close') {
    const gate = await gateHmac(req, env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const r = await closeLfg(env, gate.body.lfgId, String(gate.body.userId || ''));
    return json(r, r.ok ? 200 : 400);
  }
  return json({ error: 'unknown-op' }, 404);
}
