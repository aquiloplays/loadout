// warden-selftest.mjs — pure-logic self-tests for BE-1 (no live Twitch).
//
// Covers: schema DDL shape, subjectKey/newId, room-ticket mint+verify
// round-trip + tamper/expiry rejection, and resolveActingToken hybrid
// selection with a mocked KV vault (far-future expires_at → no network).
//
//   node test/warden-selftest.mjs   → prints PASS/FAIL per case, exit 1 on any fail.

import assert from 'node:assert';
import {
  ensureSchema, subjectKey, now, newId,
  mintRoomTicket, verifyRoomTicket,
} from '../warden-db.js';
import { resolveActingToken } from '../warden-twitch.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  -', name); }
  catch (e) { fail++; console.log('FAIL  -', name, '::', e && e.message || e); }
}

const SECRET = 'test-web-secret-abc123';
const MANAGE = 'moderator:manage:banned_users';

// ── mock KV / env ─────────────────────────────────────────────────────
function mockKV(map) {
  return {
    async get(key, opts) {
      const v = map.get(key);
      if (v == null) return null;
      if (opts && opts.type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async put(key, val) { map.set(key, val); },
    async delete(key) { map.delete(key); },
  };
}
// A vault record whose broadcaster token is valid far into the future
// (so broadcasterToken never hits the network) with the given scope.
function vaultRec(id, login, scope) {
  return {
    twitchId: id, login, display_name: login,
    broadcaster: {
      twitchId: id, login, access_token: `at-${id}`, refresh_token: `rt-${id}`,
      expires_at: Date.now() + 3600_000, scope,
    },
  };
}
function envWith(vaultMap, extra = {}) {
  return {
    AQUILO_SITE_WEB_SECRET: SECRET,
    TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret',
    LOADOUT_BOLTS: mockKV(vaultMap),
    ...extra,
  };
}

// ── schema DDL parses (miniflare-free: just assert exec is invoked per
//    statement and none throw). We give a fake DB whose exec records the
//    SQL so we can sanity-check the statements are single + non-empty.
async function run() {
  console.log('warden self-test\n');

  await t('ensureSchema runs every DDL statement (single-statement, non-empty)', async () => {
    const seen = [];
    const env = { DB: { async exec(sql) { seen.push(sql); } } };
    await ensureSchema(env);
    assert(seen.length >= 8, `expected >=8 statements, got ${seen.length}`);
    for (const s of seen) {
      assert(s && s.length > 0, 'empty statement');
      // D1 exec is one statement per call — no statement separators.
      assert(!s.includes(';'), `statement contains ';': ${s.slice(0, 40)}`);
      assert(/^CREATE (TABLE|INDEX) IF NOT EXISTS/.test(s), `not idempotent DDL: ${s.slice(0, 40)}`);
    }
    // All warden_* tables present.
    const joined = seen.join('\n');
    for (const tbl of ['warden_mods', 'warden_audit', 'warden_notes', 'warden_watchlist', 'warden_terms', 'warden_identity']) {
      assert(joined.includes(tbl), `missing table ${tbl}`);
    }
  });

  await t('ensureSchema graceful-degrades with no DB', async () => {
    await ensureSchema({});          // no throw
    await ensureSchema(null);        // no throw
  });

  await t('subjectKey normalizes platform + login', () => {
    assert.equal(subjectKey('twitch', 'SomeViewer'), 'twitch:someviewer');
    assert.equal(subjectKey('YouTube', ' Foo '), 'youtube:foo');
    assert.equal(subjectKey('', 'x'), 'twitch:x');           // default platform
  });

  await t('newId is 32 hex chars + unique', () => {
    const a = newId(), b = newId();
    assert(/^[0-9a-f]{32}$/.test(a), `bad id ${a}`);
    assert.notEqual(a, b);
  });

  await t('now() is epoch millis', () => {
    const n = now();
    assert(typeof n === 'number' && n > 1e12);
  });

  // ── room ticket ──────────────────────────────────────────────────────
  const env = envWith(new Map());

  await t('mintRoomTicket + verifyRoomTicket round-trip', async () => {
    const ticket = await mintRoomTicket(env, '111', '222', 'modlogin', 'mod');
    assert(typeof ticket === 'string' && ticket.includes('.'));
    const v = await verifyRoomTicket(env, ticket);
    assert(v, 'verify returned null');
    assert.equal(v.streamerId, '111');
    assert.equal(v.actorId, '222');
    assert.equal(v.actorLogin, 'modlogin');
    assert.equal(v.role, 'mod');
  });

  await t('broadcaster role preserved', async () => {
    const ticket = await mintRoomTicket(env, '111', '111', 'streamer', 'broadcaster');
    const v = await verifyRoomTicket(env, ticket);
    assert.equal(v.role, 'broadcaster');
  });

  await t('verifyRoomTicket rejects tampered payload', async () => {
    const ticket = await mintRoomTicket(env, '111', '222', 'mod', 'mod');
    const [payload, tag] = ticket.split('.');
    // Flip a char in the payload; HMAC must fail.
    const bad = (payload.slice(0, -1) + (payload.slice(-1) === 'A' ? 'B' : 'A')) + '.' + tag;
    assert.equal(await verifyRoomTicket(env, bad), null);
  });

  await t('verifyRoomTicket rejects tampered tag', async () => {
    const ticket = await mintRoomTicket(env, '111', '222', 'mod', 'mod');
    const [payload] = ticket.split('.');
    assert.equal(await verifyRoomTicket(env, payload + '.deadbeef'), null);
  });

  await t('verifyRoomTicket rejects wrong secret', async () => {
    const ticket = await mintRoomTicket(env, '111', '222', 'mod', 'mod');
    const otherEnv = { AQUILO_SITE_WEB_SECRET: 'different-secret' };
    assert.equal(await verifyRoomTicket(otherEnv, ticket), null);
  });

  await t('verifyRoomTicket rejects expired ticket', async () => {
    // Mint a ticket then fast-forward past exp by rewriting the payload's
    // exp is not possible (HMAC), so instead mint with a patched Date.now.
    const realNow = Date.now;
    Date.now = () => realNow() - 120_000;   // ticket minted 2 min in the past
    let ticket;
    try { ticket = await mintRoomTicket(env, '111', '222', 'mod', 'mod'); }
    finally { Date.now = realNow; }
    assert.equal(await verifyRoomTicket(env, ticket), null, 'expired ticket accepted');
  });

  await t('verifyRoomTicket rejects garbage', async () => {
    assert.equal(await verifyRoomTicket(env, ''), null);
    assert.equal(await verifyRoomTicket(env, 'nodot'), null);
    assert.equal(await verifyRoomTicket(env, '.'), null);
    assert.equal(await verifyRoomTicket(env, 'a.b'), null);
  });

  // ── resolveActingToken hybrid selection ──────────────────────────────
  await t('resolves MOD own token when mod has manage scope (native)', async () => {
    const m = new Map();
    m.set('vault:tw:S', vaultRec('S', 'streamer', MANAGE));
    m.set('vault:tw:M', vaultRec('M', 'modguy', `chat:read ${MANAGE}`));
    const r = await resolveActingToken(envWith(m), 'S', 'M');
    assert(r && r.token === 'at-M', `expected mod token, got ${JSON.stringify(r)}`);
    assert.equal(r.moderatorId, 'M');
    assert.equal(r.ownToken, true);
  });

  await t('falls back to BROADCASTER token when mod lacks manage scope', async () => {
    const m = new Map();
    m.set('vault:tw:S', vaultRec('S', 'streamer', `channel:moderate ${MANAGE}`));
    m.set('vault:tw:M', vaultRec('M', 'modguy', 'chat:read'));   // no manage
    const r = await resolveActingToken(envWith(m), 'S', 'M');
    assert(r && r.token === 'at-S', `expected broadcaster token, got ${JSON.stringify(r)}`);
    assert.equal(r.moderatorId, 'S');
    assert.equal(r.ownToken, false);
  });

  await t('falls back to broadcaster when mod has NO vault record', async () => {
    const m = new Map();
    m.set('vault:tw:S', vaultRec('S', 'streamer', MANAGE));
    const r = await resolveActingToken(envWith(m), 'S', 'M');
    assert(r && r.token === 'at-S' && r.moderatorId === 'S' && r.ownToken === false);
  });

  await t('broadcaster acting on OWN channel uses own token', async () => {
    const m = new Map();
    m.set('vault:tw:S', vaultRec('S', 'streamer', MANAGE));
    const r = await resolveActingToken(envWith(m), 'S', 'S');
    assert(r && r.token === 'at-S' && r.ownToken === false);
  });

  await t('needsReconnect when broadcaster token lacks manage scope', async () => {
    const m = new Map();
    m.set('vault:tw:S', vaultRec('S', 'streamer', 'channel:moderate'));   // no manage
    const r = await resolveActingToken(envWith(m), 'S', 'M');
    assert(r && r.needsReconnect === true, `expected needsReconnect, got ${JSON.stringify(r)}`);
  });

  await t('null when neither streamer nor mod has any vault record', async () => {
    const r = await resolveActingToken(envWith(new Map()), 'S', 'M');
    assert.equal(r, null);
  });

  await t('scope as array is honored', async () => {
    const m = new Map();
    m.set('vault:tw:S', vaultRec('S', 'streamer', MANAGE));
    m.set('vault:tw:M', vaultRec('M', 'modguy', ['chat:read', MANAGE]));   // array scope
    const r = await resolveActingToken(envWith(m), 'S', 'M');
    assert(r && r.ownToken === true && r.moderatorId === 'M');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
