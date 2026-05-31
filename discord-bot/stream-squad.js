// Stream Squad — co-watch a Twitch stream as a group with a shared
// activity feed. Cross-cutting premium feature #5.
//
// 2026-05-30 sprint. D1-backed (aquilo_bot_db, same DB binding the
// rest of the worker uses). Three tables, seeded by
// stream-squad-migration.sql:
//   stream_squad_session  one row per co-watch session
//   stream_squad_member   one row per (squad, user); left_at NULL = in
//   stream_squad_event    the shared activity feed
//
// The "Aquilo is LIVE" dashboard embed (live-status-embed.js) gets a
// "Join Stream Squad" button wired to the auto-created squad for Clay's
// channel — see ensureSquadForChannel() + handleSquadComponent() (the
// `squad:` interaction prefix, dispatched in commands.js).
//
// member_count on the session row is the cached count of ACTIVE members
// (left_at IS NULL); it's recomputed from the member table on every
// join/leave so it can't drift out of sync.

// ── D1 helper ─────────────────────────────────────────────────────

function db(env) {
  if (!env || !env.DB) throw new Error('stream-squad: no D1 binding (env.DB missing)');
  return env.DB;
}

// crypto.randomUUID is available in the Workers runtime + Node ≥16.
function newId() {
  return crypto.randomUUID();
}

// ── Internal reads ────────────────────────────────────────────────

async function fetchSession(D, squadId) {
  return D.prepare(
    `SELECT id, owner_user_id, twitch_channel, started_at, ended_at, member_count
       FROM stream_squad_session
      WHERE id = ?
      LIMIT 1`
  ).bind(squadId).first();
}

async function activeMemberCount(D, squadId) {
  const row = await D.prepare(
    `SELECT COUNT(*) AS n
       FROM stream_squad_member
      WHERE squad_id = ? AND left_at IS NULL`
  ).bind(squadId).first();
  return Number(row?.n || 0);
}

async function recomputeMemberCount(D, squadId) {
  const n = await activeMemberCount(D, squadId);
  await D.prepare(
    `UPDATE stream_squad_session SET member_count = ? WHERE id = ?`
  ).bind(n, squadId).run();
  return n;
}

function shapeSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    twitchChannel: row.twitch_channel,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    memberCount: Number(row.member_count || 0),
    active: row.ended_at == null,
  };
}

// ── Session lifecycle ─────────────────────────────────────────────

// Create a new squad. The owner is auto-joined as the first member.
// Returns { ok, squad }.
export async function createSquad(env, { ownerUserId, twitchChannel } = {}) {
  if (!ownerUserId || !twitchChannel) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const id = newId();
  const now = Date.now();
  await D.prepare(
    `INSERT INTO stream_squad_session
       (id, owner_user_id, twitch_channel, started_at, ended_at, member_count)
     VALUES (?, ?, ?, ?, NULL, 1)`
  ).bind(id, String(ownerUserId), String(twitchChannel), now).run();
  await D.prepare(
    `INSERT INTO stream_squad_member (squad_id, user_id, joined_at, left_at)
     VALUES (?, ?, ?, NULL)`
  ).bind(id, String(ownerUserId), now).run();
  const session = await fetchSession(D, id);
  return { ok: true, squad: shapeSession(session) };
}

// Idempotent active-squad-per-channel helper. Returns the existing
// active squad for `twitchChannel` if one exists, else creates one.
// Used by the live-embed hook so a "Join Squad" button always has a
// live squad behind it.
export async function ensureSquadForChannel(env, { ownerUserId, twitchChannel } = {}) {
  if (!twitchChannel) return { ok: false, error: 'no-channel' };
  const D = db(env);
  const existing = await D.prepare(
    `SELECT id, owner_user_id, twitch_channel, started_at, ended_at, member_count
       FROM stream_squad_session
      WHERE twitch_channel = ? AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1`
  ).bind(String(twitchChannel)).first();
  if (existing) return { ok: true, squad: shapeSession(existing), created: false };
  const r = await createSquad(env, { ownerUserId: ownerUserId || 'system', twitchChannel });
  return { ...r, created: !!r.ok };
}

// Owner-only. Marks the session ended (and best-effort posts a 'end'
// event). No-op if already ended or the caller isn't the owner.
export async function endSquad(env, squadId, userId) {
  if (!squadId || !userId) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const session = await fetchSession(D, squadId);
  if (!session) return { ok: false, error: 'not-found' };
  if (String(session.owner_user_id) !== String(userId)) return { ok: false, error: 'not-owner' };
  if (session.ended_at != null) return { ok: true, alreadyEnded: true, squad: shapeSession(session) };
  await D.prepare(
    `UPDATE stream_squad_session SET ended_at = ? WHERE id = ? AND ended_at IS NULL`
  ).bind(Date.now(), squadId).run();
  const after = await fetchSession(D, squadId);
  return { ok: true, squad: shapeSession(after) };
}

export async function getSquad(env, squadId) {
  if (!squadId) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const session = await fetchSession(D, squadId);
  if (!session) return { ok: false, error: 'not-found' };
  const { results } = await D.prepare(
    `SELECT user_id, joined_at
       FROM stream_squad_member
      WHERE squad_id = ? AND left_at IS NULL
      ORDER BY joined_at ASC`
  ).bind(squadId).all();
  return {
    ok: true,
    squad: shapeSession(session),
    members: (results || []).map(r => ({ userId: r.user_id, joinedAt: r.joined_at })),
  };
}

// Active sessions, newest first. Optional twitchChannel filter.
export async function listActiveSquads(env, { twitchChannel, limit } = {}) {
  const D = db(env);
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  let rows;
  if (twitchChannel) {
    ({ results: rows } = await D.prepare(
      `SELECT id, owner_user_id, twitch_channel, started_at, ended_at, member_count
         FROM stream_squad_session
        WHERE ended_at IS NULL AND twitch_channel = ?
        ORDER BY started_at DESC
        LIMIT ?`
    ).bind(String(twitchChannel), lim).all());
  } else {
    ({ results: rows } = await D.prepare(
      `SELECT id, owner_user_id, twitch_channel, started_at, ended_at, member_count
         FROM stream_squad_session
        WHERE ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT ?`
    ).bind(lim).all());
  }
  return { ok: true, squads: (rows || []).map(shapeSession) };
}

// ── Membership ────────────────────────────────────────────────────

async function fetchMember(D, squadId, userId) {
  return D.prepare(
    `SELECT squad_id, user_id, joined_at, left_at
       FROM stream_squad_member
      WHERE squad_id = ? AND user_id = ?
      LIMIT 1`
  ).bind(squadId, String(userId)).first();
}

// Join (or re-join) a squad. Refuses if the session has ended. Posts a
// 'join' feed event on a fresh join. Returns { ok, squad, alreadyIn }.
export async function joinSquad(env, squadId, userId) {
  if (!squadId || !userId) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const session = await fetchSession(D, squadId);
  if (!session) return { ok: false, error: 'not-found' };
  if (session.ended_at != null) return { ok: false, error: 'ended' };

  const now = Date.now();
  const member = await fetchMember(D, squadId, userId);
  let alreadyIn = false;
  if (member) {
    if (member.left_at == null) {
      alreadyIn = true;   // already an active member — no-op
    } else {
      await D.prepare(
        `UPDATE stream_squad_member SET left_at = NULL, joined_at = ?
          WHERE squad_id = ? AND user_id = ?`
      ).bind(now, squadId, String(userId)).run();
    }
  } else {
    await D.prepare(
      `INSERT INTO stream_squad_member (squad_id, user_id, joined_at, left_at)
       VALUES (?, ?, ?, NULL)`
    ).bind(squadId, String(userId), now).run();
  }
  const memberCount = await recomputeMemberCount(D, squadId);
  if (!alreadyIn) {
    await insertEvent(D, squadId, String(userId), 'join', null, now);
    // Fan out to the community-activity SSE feed (best-effort).
    try {
      const { publishActivity } = await import('./activity-do.js');
      await publishActivity(env, { kind: 'squad-join', squadId, userId, memberCount,
        twitchChannel: session.twitch_channel });
    } catch { /* sse optional */ }
  }
  const after = await fetchSession(D, squadId);
  return { ok: true, squad: shapeSession(after), memberCount, alreadyIn };
}

// Leave a squad. No-op if not an active member. Posts a 'leave' event.
export async function leaveSquad(env, squadId, userId) {
  if (!squadId || !userId) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const session = await fetchSession(D, squadId);
  if (!session) return { ok: false, error: 'not-found' };

  const member = await fetchMember(D, squadId, userId);
  if (!member || member.left_at != null) {
    return { ok: true, wasMember: false, squad: shapeSession(session) };
  }
  const now = Date.now();
  await D.prepare(
    `UPDATE stream_squad_member SET left_at = ?
      WHERE squad_id = ? AND user_id = ? AND left_at IS NULL`
  ).bind(now, squadId, String(userId)).run();
  const memberCount = await recomputeMemberCount(D, squadId);
  await insertEvent(D, squadId, String(userId), 'leave', null, now);
  const after = await fetchSession(D, squadId);
  return { ok: true, wasMember: true, squad: shapeSession(after), memberCount };
}

// ── Activity feed ─────────────────────────────────────────────────

async function insertEvent(D, squadId, userId, kind, payload, createdAt) {
  const id = newId();
  const payloadStr = payload == null ? null
    : (typeof payload === 'string' ? payload : JSON.stringify(payload));
  await D.prepare(
    `INSERT INTO stream_squad_event (id, squad_id, user_id, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, squadId, userId, kind, payloadStr, createdAt).run();
  return { id, squadId, userId, kind, createdAt };
}

// Post an activity event. Requires the caller to be an active member
// (so a non-member can't spam a squad's feed). Returns { ok, event }.
export async function postSquadEvent(env, squadId, userId, kind, payload) {
  if (!squadId || !userId || !kind) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const session = await fetchSession(D, squadId);
  if (!session) return { ok: false, error: 'not-found' };
  if (session.ended_at != null) return { ok: false, error: 'ended' };
  const member = await fetchMember(D, squadId, userId);
  if (!member || member.left_at != null) return { ok: false, error: 'not-a-member' };

  const ev = await insertEvent(D, squadId, String(userId), String(kind).slice(0, 32), payload, Date.now());
  return { ok: true, event: ev };
}

// Feed read, newest first. `before` is a created_at cursor (exclusive)
// for pagination. Parses each row's payload JSON back to an object.
export async function getSquadFeed(env, squadId, { limit, before } = {}) {
  if (!squadId) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const lim = Math.max(1, Math.min(100, Number(limit) || 50));
  let rows;
  if (Number.isFinite(Number(before)) && Number(before) > 0) {
    ({ results: rows } = await D.prepare(
      `SELECT id, squad_id, user_id, kind, payload, created_at
         FROM stream_squad_event
        WHERE squad_id = ? AND created_at < ?
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(squadId, Number(before), lim).all());
  } else {
    ({ results: rows } = await D.prepare(
      `SELECT id, squad_id, user_id, kind, payload, created_at
         FROM stream_squad_event
        WHERE squad_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(squadId, lim).all());
  }
  const events = (rows || []).map(r => {
    let payload = null;
    if (r.payload != null) { try { payload = JSON.parse(r.payload); } catch { payload = r.payload; } }
    return { id: r.id, userId: r.user_id, kind: r.kind, payload, createdAt: r.created_at };
  });
  const nextBefore = events.length === lim ? events[events.length - 1].createdAt : null;
  return { ok: true, events, nextBefore };
}

// ── Discord interaction: "Join Stream Squad" button ───────────────
//
// custom_id shape: squad:join:<squadId>. Joins the clicking user to
// the squad + acks ephemerally. Dispatched from commands.js via the
// `squad:` prefix.
export async function handleSquadComponent(env, interaction) {
  const cid = interaction?.data?.custom_id || '';
  const userId = interaction?.member?.user?.id || interaction?.user?.id;
  const parts = cid.split(':');           // ['squad', 'join', '<id>']
  const action = parts[1];
  const squadId = parts[2];
  const ephem = (content) => ({ type: 4, data: { content, flags: 64 } });

  if (!userId) return ephem('Run this in a server.');
  if (action !== 'join' || !squadId) return ephem('Unknown squad action.');

  try {
    const r = await joinSquad(env, squadId, userId);
    if (!r.ok) {
      if (r.error === 'ended')     return ephem('That Stream Squad has already wrapped up. 👋');
      if (r.error === 'not-found') return ephem('That Stream Squad no longer exists.');
      return ephem('Could not join the squad right now — try again in a moment.');
    }
    if (r.alreadyIn) {
      return ephem(`You're already in the squad — **${r.memberCount}** watching together. 🎉`);
    }
    return ephem(`You joined the Stream Squad! **${r.memberCount}** watching together. 🎉`);
  } catch (e) {
    console.warn('[stream-squad] join component', e?.message || e);
    return ephem('Something went wrong joining the squad.');
  }
}
