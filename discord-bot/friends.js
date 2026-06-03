// Friends system, bidirectional friendship + pending request flow.
//
// State (KV, mirrored on both sides):
//   pfriends:<userId>  {
//     friends:  [userId, ...],           // accepted (mirrored)
//     incoming: [{ fromUserId, sentUtc }, ...],
//     outgoing: [{ toUserId,   sentUtc }, ...],
//     blocked:  [userId, ...],           // (reserved, no UI yet)
//   }
//
// pprofile.friends is the historical array (already used by privacy
// gating); we keep it in sync as the authoritative `friends` list so
// pre-existing readFullProfile call sites keep working. The new
// pending-state lives in pfriends:<userId> only.
//
// HMAC-gated against AQUILO_SITE_WEB_SECRET (same secret /web/* uses).

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

const KEY = (uid) => `pfriends:${uid}`;
const MAX_FRIENDS = 200;
const MAX_PENDING_OUT = 25;

function freshRec() {
  return { friends: [], incoming: [], outgoing: [], blocked: [] };
}

export async function getFriends(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(KEY(userId), { type: 'json' });
  return { ...freshRec(), ...(raw || {}) };
}

async function putFriends(env, userId, rec) {
  await env.LOADOUT_BOLTS.put(KEY(userId), JSON.stringify(rec));
}

// Mirror onto pprofile.friends so the existing privacy gate +
// readFullProfile.friendCount field keep working. Best-effort, // pprofile may not exist yet for new users; we create it.
async function syncProfileFriends(env, userId, friendsList) {
  try {
    const { getProfile, putProfile } = await import('./progression/profile.js');
    const p = await getProfile(env, userId);
    p.friends = friendsList;
    await putProfile(env, userId, p);
  } catch { /* non-fatal */ }
}

// ── Request → Accept / Decline → Remove ───────────────────────────

export async function sendFriendRequest(env, fromUserId, toUserId) {
  if (!fromUserId || !toUserId) return { ok: false, error: 'userIds required' };
  if (fromUserId === toUserId) return { ok: false, error: 'self' };
  const from = await getFriends(env, fromUserId);
  const to   = await getFriends(env, toUserId);
  if (from.friends.includes(toUserId)) return { ok: false, error: 'already-friends' };
  if (to.blocked?.includes(fromUserId)) return { ok: false, error: 'blocked' };
  if (from.outgoing.find(x => x.toUserId === toUserId)) {
    return { ok: false, error: 'already-pending' };
  }
  // Inverse pending? Treat as auto-accept.
  if (from.incoming.find(x => x.fromUserId === toUserId)) {
    return acceptFriendRequest(env, fromUserId, toUserId);
  }
  if (from.outgoing.length >= MAX_PENDING_OUT) {
    return { ok: false, error: 'too-many-outgoing', max: MAX_PENDING_OUT };
  }
  const sentUtc = Date.now();
  from.outgoing.push({ toUserId, sentUtc });
  to.incoming.push({ fromUserId, sentUtc });
  await putFriends(env, fromUserId, from);
  await putFriends(env, toUserId, to);
  return { ok: true, fromUserId, toUserId, sentUtc };
}

export async function acceptFriendRequest(env, viewerUserId, fromUserId) {
  if (!viewerUserId || !fromUserId) return { ok: false, error: 'userIds required' };
  const me = await getFriends(env, viewerUserId);
  const them = await getFriends(env, fromUserId);
  const idx = me.incoming.findIndex(x => x.fromUserId === fromUserId);
  if (idx < 0) return { ok: false, error: 'no-pending-request' };
  me.incoming.splice(idx, 1);
  them.outgoing = (them.outgoing || []).filter(x => x.toUserId !== viewerUserId);
  if (me.friends.length >= MAX_FRIENDS || them.friends.length >= MAX_FRIENDS) {
    return { ok: false, error: 'friends-cap' };
  }
  if (!me.friends.includes(fromUserId))   me.friends.push(fromUserId);
  if (!them.friends.includes(viewerUserId)) them.friends.push(viewerUserId);
  await putFriends(env, viewerUserId, me);
  await putFriends(env, fromUserId, them);
  await syncProfileFriends(env, viewerUserId, me.friends);
  await syncProfileFriends(env, fromUserId, them.friends);
  return { ok: true, viewerUserId, fromUserId };
}

export async function declineFriendRequest(env, viewerUserId, fromUserId) {
  const me = await getFriends(env, viewerUserId);
  const them = await getFriends(env, fromUserId);
  const before = me.incoming.length;
  me.incoming = me.incoming.filter(x => x.fromUserId !== fromUserId);
  them.outgoing = (them.outgoing || []).filter(x => x.toUserId !== viewerUserId);
  await putFriends(env, viewerUserId, me);
  await putFriends(env, fromUserId, them);
  return { ok: true, declined: before !== me.incoming.length };
}

export async function cancelOutgoingRequest(env, viewerUserId, toUserId) {
  const me = await getFriends(env, viewerUserId);
  const them = await getFriends(env, toUserId);
  const before = me.outgoing.length;
  me.outgoing = me.outgoing.filter(x => x.toUserId !== toUserId);
  them.incoming = (them.incoming || []).filter(x => x.fromUserId !== viewerUserId);
  await putFriends(env, viewerUserId, me);
  await putFriends(env, toUserId, them);
  return { ok: true, cancelled: before !== me.outgoing.length };
}

export async function removeFriend(env, viewerUserId, targetUserId) {
  const me = await getFriends(env, viewerUserId);
  const them = await getFriends(env, targetUserId);
  me.friends = me.friends.filter(id => id !== targetUserId);
  them.friends = them.friends.filter(id => id !== viewerUserId);
  await putFriends(env, viewerUserId, me);
  await putFriends(env, targetUserId, them);
  await syncProfileFriends(env, viewerUserId, me.friends);
  await syncProfileFriends(env, targetUserId, them.friends);
  return { ok: true };
}

// ── Read-side ────────────────────────────────────────────────────
//
// readFriendsDisplay enriches the friends list with each friend's
// aquilo.gg username + visible gamertags (reusing the visibility
// flags from the B2 gamertag system). Walks pprofile + pgamertags
// for each friend, bounded by MAX_FRIENDS.

const GAMERTAG_PLATFORMS = ['steam', 'xbox', 'psn', 'epic'];

async function visibleGamertagsFor(env, userId) {
  try {
    const rec = await env.LOADOUT_BOLTS.get(`pgamertags:${userId}`, { type: 'json' });
    if (!rec) return {};
    const out = {};
    for (const p of GAMERTAG_PLATFORMS) {
      if (rec[p]?.visible && rec[p].id) out[p] = rec[p].id;
    }
    return out;
  } catch { return {}; }
}

async function usernameFor(env, userId) {
  try {
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' });
    return p?.username || p?.displayName || `Player ${userId.slice(-4)}`;
  } catch { return `Player ${userId.slice(-4)}`; }
}

export async function readFriendsDisplay(env, userId) {
  const rec = await getFriends(env, userId);
  const friends = await Promise.all(rec.friends.map(async (fid) => ({
    userId: fid,
    username: await usernameFor(env, fid),
    gamertags: await visibleGamertagsFor(env, fid),
  })));
  const incoming = await Promise.all(rec.incoming.map(async (r) => ({
    fromUserId: r.fromUserId,
    fromUsername: await usernameFor(env, r.fromUserId),
    sentUtc: r.sentUtc,
  })));
  const outgoing = await Promise.all(rec.outgoing.map(async (r) => ({
    toUserId: r.toUserId,
    toUsername: await usernameFor(env, r.toUserId),
    sentUtc: r.sentUtc,
  })));
  return { userId, friends, incoming, outgoing };
}

// ── HTTP dispatcher ──────────────────────────────────────────────

export async function handleFriendsRoute(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['web','friends', ...]
  const tail = parts[2] || null;
  const sub  = parts[3] || null;

  // GET /web/friends/<userId>           full payload (friends + pending in/out + gamertags)
  // GET /web/friends/<userId>/list      just the friends array
  if (req.method === 'GET' && tail && !['request','accept','decline','remove','cancel'].includes(tail)) {
    const userId = tail;
    if (sub === 'list') {
      const rec = await getFriends(env, userId);
      return json({ userId, friends: rec.friends });
    }
    const payload = await readFriendsDisplay(env, userId);
    return json(payload);
  }
  // All writes require HMAC.
  const gate = await gateHmac(req, env);
  if (!gate.ok) return json({ error: gate.error }, gate.status);
  const b = gate.body || {};
  const userId = String(b.userId || '').trim();
  if (!userId) return json({ error: 'userId required' }, 400);

  if (req.method === 'POST' && tail === 'request') {
    const target = String(b.targetUserId || '').trim();
    if (!target) return json({ error: 'targetUserId required' }, 400);
    const r = await sendFriendRequest(env, userId, target);
    // Best-effort notification, send a Discord DM to the target if
    // they're opted in. We do this inline since friend requests are
    // low-volume.
    if (r.ok) {
      try {
        const { sendDm } = await import('./aquilo/util.js');
        await sendDm(env, target, {
          content: `🤝 **Friend request**, <@${userId}> wants to be your friend on aquilo.gg.\nAccept or decline at https://aquilo.gg/friends.`,
        });
      } catch { /* DMs might be off */ }
    }
    return json(r, r.ok ? 200 : 400);
  }
  if (req.method === 'POST' && tail === 'accept') {
    const from = String(b.fromUserId || b.targetUserId || '').trim();
    if (!from) return json({ error: 'fromUserId required' }, 400);
    const r = await acceptFriendRequest(env, userId, from);
    return json(r, r.ok ? 200 : 400);
  }
  if (req.method === 'POST' && tail === 'decline') {
    const from = String(b.fromUserId || b.targetUserId || '').trim();
    if (!from) return json({ error: 'fromUserId required' }, 400);
    const r = await declineFriendRequest(env, userId, from);
    return json(r, r.ok ? 200 : 400);
  }
  if (req.method === 'POST' && tail === 'cancel') {
    const to = String(b.toUserId || b.targetUserId || '').trim();
    if (!to) return json({ error: 'toUserId required' }, 400);
    const r = await cancelOutgoingRequest(env, userId, to);
    return json(r, r.ok ? 200 : 400);
  }
  if (req.method === 'POST' && tail === 'remove') {
    const target = String(b.targetUserId || '').trim();
    if (!target) return json({ error: 'targetUserId required' }, 400);
    const r = await removeFriend(env, userId, target);
    return json(r, r.ok ? 200 : 400);
  }
  return json({ error: 'unknown-op' }, 404);
}

// ── LFG fan-out helper (used by lfg.js createLfg) ────────────────
//
// For each of the host's friends, send a Discord DM via the existing
// /push/dm payload contract (in-process, no HTTP loopback) AND fire
// a /api/push/external web-push so opted-in friends get the
// notification on aquilo.gg too. Respects each friend's pprofile.
// pushPrefs.discordDm + pushPrefs.kinds['friend.lfg'].

export async function notifyFriendsOfLfg(env, lfg) {
  if (!lfg?.hostUserId) return { sent: 0 };
  const me = await getFriends(env, lfg.hostUserId);
  if (!me.friends.length) return { sent: 0 };
  const { sendDm } = await import('./aquilo/util.js');
  const hostName = lfg.hostName || `Player ${lfg.hostUserId.slice(-4)}`;
  const dmContent = [
    `🎮 **${hostName}** is looking to play **${lfg.game}**.`,
    `${lfg.slots - lfg.players.length}/${lfg.slots} slots open · id \`${lfg.id}\``,
    `Join via /lfg join id:${lfg.id} or https://aquilo.gg/lfg`,
  ].join('\n');
  let sent = 0, skipped = 0;
  for (const friendId of me.friends) {
    // Per-friend opt-out check.
    const prefs = await readPushPrefs(env, friendId);
    if (!prefs.discordDm) { skipped++; continue; }
    if (prefs.kinds && prefs.kinds['friend.lfg'] === false) { skipped++; continue; }
    try { await sendDm(env, friendId, { content: dmContent }); sent++; }
    catch { /* DMs off / left guild */ }
  }
  // Web-push fan-out via the existing aquilo-site relay.
  try {
    await firePushExternal(env, {
      kind: 'friend.lfg',
      title: `${hostName} is looking to play ${lfg.game}`,
      body: `${lfg.slots - lfg.players.length}/${lfg.slots} slots open. Tap to join.`,
      url: `https://aquilo.gg/lfg`,
      audience: { kind: 'users', userIds: me.friends },
    });
  } catch { /* web-push receiver might be offline */ }
  return { sent, skipped, total: me.friends.length };
}

// ── Go-live fan-out helper (used by sf-community.js handleCommunityLive)
//
// Fired ONCE per new live-session for a streamer who is linked to an
// aquilo account. The SF heartbeat payload doesn't always carry an
// aquilo userId, so callers can pass either an aquilo userId or a
// Twitch userId, we resolve via plink:twitch:<id> as a fallback.
//
// Per-friend Discord DM via sendDm AND web-push fan-out via the
// /api/push/external relay. Respects pprofile.pushPrefs.discordDm +
// pushPrefs.kinds['friend.live'].
//
// Session dedup marker (KV TTL 24h) prevents re-firing if the SF
// heartbeat flaps offline→online inside a single stream session.

export async function notifyFriendsOfGoLive(env, args = {}) {
  const { aquiloUserId, twitchUserId, streamerName, platform, url, title, game } = args;
  // Resolve to an aquilo userId.
  let userId = aquiloUserId || null;
  if (!userId && twitchUserId) {
    try {
      const linkedId = await env.LOADOUT_BOLTS.get(`plink:twitch:${twitchUserId}`, { type: 'text' });
      if (linkedId) userId = linkedId;
    } catch { /* fall through */ }
  }
  if (!userId) return { sent: 0, skipped: 0, reason: 'no-aquilo-link' };

  // Session dedup, by stable session start (rounded to nearest hour
  // so we don't double-fire on flapping heartbeats inside one stream).
  const sessionKey = `friend.live:notified:${userId}:${Math.floor(Date.now() / 3_600_000)}`;
  try {
    const seen = await env.LOADOUT_BOLTS.get(sessionKey);
    if (seen) return { sent: 0, skipped: 0, reason: 'already-notified' };
    await env.LOADOUT_BOLTS.put(sessionKey, '1', { expirationTtl: 6 * 60 * 60 });
  } catch { /* non-fatal */ }

  const me = await getFriends(env, userId);
  if (!me.friends.length) return { sent: 0, skipped: 0, total: 0 };
  const { sendDm } = await import('./aquilo/util.js');
  const platLabel = platform || 'Twitch';
  const nm = streamerName || `Player ${userId.slice(-4)}`;
  const titleLine = title ? `\n*${title}*` : '';
  const gameLine = game ? `\n**Playing:** ${game}` : '';
  const dmContent = [
    `🔴 **${nm}** is live on ${platLabel}.`,
    titleLine || gameLine ? (titleLine + gameLine).trim() : '',
    url ? `Watch: ${url}` : 'aquilo.gg/community',
  ].filter(Boolean).join('\n');

  let sent = 0, skipped = 0;
  for (const friendId of me.friends) {
    const prefs = await readPushPrefs(env, friendId);
    if (!prefs.discordDm) { skipped++; continue; }
    if (prefs.kinds && prefs.kinds['friend.live'] === false) { skipped++; continue; }
    try { await sendDm(env, friendId, { content: dmContent }); sent++; }
    catch { /* DMs off / left guild */ }
  }
  try {
    await firePushExternal(env, {
      kind: 'friend.live',
      title: `${nm} is live on ${platLabel}`,
      body: title || game || 'Tap to watch.',
      url: url || 'https://aquilo.gg/community',
      audience: { kind: 'users', userIds: me.friends },
    });
  } catch { /* web-push receiver might be offline */ }
  return { sent, skipped, total: me.friends.length };
}

async function readPushPrefs(env, userId) {
  try {
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' });
    return { ...{ discordDm: true, web: true, kinds: {} }, ...(p?.pushPrefs || {}) };
  } catch { return { discordDm: true, web: true, kinds: {} }; }
}

// Hex-encode HMAC-SHA-256 (mirror of clash-push.js signing).
async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function firePushExternal(env, payload) {
  const url = env.AQUILO_PUSH_URL || 'https://aquilo.gg/api/push/external';
  const secret = env.AQUILO_PUSH_SECRET || env.AQUILO_SITE_WEB_SECRET;
  if (!secret) return;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const sig = await sign(secret, ts + '\n' + body);
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aquilo-web-ts': ts,
        'x-aquilo-web-sig': sig,
      },
      body,
    });
  } catch { /* fire-and-forget */ }
}
