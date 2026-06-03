// Boltbound — friend match private rooms (RET-6).
//
// A player creates a room → gets a 6-char code (e.g. "VOID42") → shares
// it with a friend → the friend joins with the code → the two are put
// into a private PvP match. Private matches don't affect the ranked
// ladder (cards-match flags match.private; boltbound-ranked skips it).
// Rooms expire after 5 minutes if nobody joins.
//
// KV (short TTL):
//   cards:room:<CODE>          -> { code, creatorId, guildId, createdUtc, status, matchId }
//   cards:room-owner:<userId>  -> CODE   (so a creator can find/cancel their room)

import { startRoomMatch, renderableState } from './cards-match.js';
import { getActiveMatch } from './cards-state.js';

const ROOM_TTL_SECONDS = 300; // 5 minutes
const ROOM_KEY = (code) => `cards:room:${code}`;
const OWNER_KEY = (userId) => `cards:room-owner:${userId}`;
// No I/O/0/1 — unambiguous when read aloud or copied.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(n = 6) {
  // crypto.getRandomValues for an unguessable code (rooms are private).
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

async function readRoom(env, code) {
  if (!code) return null;
  return env.LOADOUT_BOLTS.get(ROOM_KEY(code), { type: 'json' });
}

// Create a room for the creator. Refuses if they already have an active
// match. Returns { ok, code, expiresUtc }.
export async function createRoom(env, guildId, creatorId) {
  const active = await getActiveMatch(env, guildId, creatorId);
  if (active && (active.status === 'active' || active.status === 'mulligan')) {
    return { ok: false, error: 'already-in-match' };
  }
  // Clear any stale prior room this user owned.
  try {
    const prior = await env.LOADOUT_BOLTS.get(OWNER_KEY(creatorId));
    if (prior) await env.LOADOUT_BOLTS.delete(ROOM_KEY(prior));
  } catch { /* best-effort */ }

  // Generate a code, retrying on the rare collision.
  let code = null;
  for (let i = 0; i < 6; i++) {
    const c = randomCode();
    if (!(await readRoom(env, c))) { code = c; break; }
  }
  if (!code) return { ok: false, error: 'code-collision' };

  const room = {
    code, creatorId: String(creatorId), guildId: guildId || null,
    createdUtc: Date.now(), status: 'open', matchId: null,
  };
  await env.LOADOUT_BOLTS.put(ROOM_KEY(code), JSON.stringify(room), { expirationTtl: ROOM_TTL_SECONDS });
  await env.LOADOUT_BOLTS.put(OWNER_KEY(creatorId), code, { expirationTtl: ROOM_TTL_SECONDS });
  return { ok: true, code, expiresUtc: room.createdUtc + ROOM_TTL_SECONDS * 1000 };
}

// The creator's current room (for the "waiting for opponent" poll).
// Returns { ok, room: { code, status, matchId, expiresUtc } | null }.
export async function getMyRoom(env, guildId, userId) {
  const code = await env.LOADOUT_BOLTS.get(OWNER_KEY(userId));
  if (!code) return { ok: true, room: null };
  const room = await readRoom(env, code);
  if (!room) return { ok: true, room: null };
  return {
    ok: true,
    room: {
      code: room.code,
      status: room.status,
      matchId: room.matchId || null,
      expiresUtc: (room.createdUtc || 0) + ROOM_TTL_SECONDS * 1000,
    },
  };
}

// Join a room by code. Creates the private PvP match between creator and
// joiner. Returns { ok, match } (renderable for the joiner) or an error.
export async function joinRoom(env, guildId, joinerId, codeRaw) {
  const code = String(codeRaw || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return { ok: false, error: 'bad-code' };
  const room = await readRoom(env, code);
  if (!room) return { ok: false, error: 'room-not-found' };
  if (room.status !== 'open') return { ok: false, error: 'room-already-filled' };
  if (String(room.creatorId) === String(joinerId)) return { ok: false, error: 'cannot-join-own-room' };

  const r = await startRoomMatch(env, room.guildId || guildId, room.creatorId, joinerId);
  if (!r.ok) return r;

  room.status = 'matched';
  room.matchId = r.match.matchId;
  // Keep the matched record briefly so the creator's poll sees it, then
  // it expires naturally.
  await env.LOADOUT_BOLTS.put(ROOM_KEY(code), JSON.stringify(room), { expirationTtl: 60 });
  return { ok: true, match: renderableState(r.match, joinerId) };
}

// Cancel the creator's open room.
export async function cancelRoom(env, guildId, userId) {
  const code = await env.LOADOUT_BOLTS.get(OWNER_KEY(userId));
  if (code) {
    try { await env.LOADOUT_BOLTS.delete(ROOM_KEY(code)); } catch { /* noop */ }
    try { await env.LOADOUT_BOLTS.delete(OWNER_KEY(userId)); } catch { /* noop */ }
  }
  return { ok: true };
}
