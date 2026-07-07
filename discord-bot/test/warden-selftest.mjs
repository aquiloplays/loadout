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
import { isObsCommandAllowed, parseDb } from '../warden-obs.js';

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

  // ── syncTwitchMods (auto-detect from the Twitch mod list) ───────────
  // Mock D1 that understands exactly the statements syncTwitchMods and
  // listMods issue against warden_mods, backed by a Map keyed mod_id.
  function mockDB(rows) {
    // rows: Map<mod_id, {mod_id, mod_login, added_by, added_at, status}>
    function runStmt(sql, args) {
      if (/^INSERT INTO warden_mods/.test(sql)) {
        const [, mod_id, mod_login, added_by, added_at] = args;
        const prev = rows.get(mod_id);
        if (prev) { prev.mod_login = mod_login; prev.status = 'active'; }
        else rows.set(mod_id, { mod_id, mod_login, added_by, added_at, status: 'active' });
        return {};
      }
      if (/^DELETE FROM warden_mods/.test(sql)) { rows.delete(args[1]); return {}; }
      if (/SET status = 'removed'/.test(sql)) {
        const r = rows.get(args[1]); if (r) r.status = 'removed'; return {};
      }
      throw new Error('unexpected stmt: ' + sql.slice(0, 60));
    }
    return {
      async exec() { /* ensureSchema no-op */ },
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async all() {
                if (/^SELECT mod_id, added_by, status/.test(sql)) {
                  return { results: [...rows.values()] };
                }
                if (/^SELECT mod_id, mod_login, added_by, added_at/.test(sql)) {
                  return { results: [...rows.values()].filter((r) => r.status == null || r.status === 'active') };
                }
                throw new Error('unexpected all(): ' + sql.slice(0, 60));
              },
              async first() { return null; },
              async run() { return runStmt(sql, args); },
              _exec() { return runStmt(sql, args); },
            };
          },
        };
      },
      async batch(stmts) { for (const st of stmts) await st._exec(); },
    };
  }
  // Stub Helix: any /moderation/moderators GET returns `mods` (one page).
  function stubHelix(mods, status = 200) {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/moderation/moderators')) {
        if (status !== 200) return new Response(JSON.stringify({ error: 'x' }), { status });
        return new Response(JSON.stringify({ data: mods, pagination: {} }), { status: 200 });
      }
      throw new Error('unexpected fetch ' + url);
    };
    return () => { globalThis.fetch = orig; };
  }
  const { syncTwitchMods } = await import('../warden-mods.js');

  await t('sync adds Twitch mods as twitch-sync rows', async () => {
    const rows = new Map();
    const m = new Map(); m.set('vault:tw:S', vaultRec('S', 'streamer', MANAGE));
    const restore = stubHelix([
      { user_id: 'M1', user_login: 'ModOne' },
      { user_id: 'M2', user_login: 'modtwo' },
      { user_id: 'S',  user_login: 'streamer' },   // self, skipped
    ]);
    try {
      const r = await syncTwitchMods(envWith(m, { DB: mockDB(rows) }), 'S', { force: true });
      assert(r.ok && r.added === 2 && r.total === 2, JSON.stringify(r));
      assert.equal(rows.get('M1').added_by, 'twitch-sync');
      assert.equal(rows.get('M1').mod_login, 'modone');   // lowercased
    } finally { restore(); }
  });

  await t('sync prunes auto rows that lost the sword, keeps manual rows', async () => {
    const rows = new Map();
    rows.set('OLD', { mod_id: 'OLD', mod_login: 'old', added_by: 'twitch-sync', added_at: 1, status: 'active' });
    rows.set('MAN', { mod_id: 'MAN', mod_login: 'man', added_by: 'S', added_at: 1, status: 'active' });
    const m = new Map(); m.set('vault:tw:S', vaultRec('S', 'streamer', MANAGE));
    const restore = stubHelix([{ user_id: 'M1', user_login: 'new' }]);
    try {
      const r = await syncTwitchMods(envWith(m, { DB: mockDB(rows) }), 'S', { force: true });
      assert(r.ok && r.added === 1 && r.removed === 1, JSON.stringify(r));
      assert(!rows.has('OLD'), 'auto row should be pruned');
      assert(rows.has('MAN'), 'manual row must survive');
    } finally { restore(); }
  });

  await t('sync never resurrects a manually-removed (tombstoned) mod', async () => {
    const rows = new Map();
    rows.set('M1', { mod_id: 'M1', mod_login: 'm1', added_by: 'twitch-sync', added_at: 1, status: 'removed' });
    const m = new Map(); m.set('vault:tw:S', vaultRec('S', 'streamer', MANAGE));
    const restore = stubHelix([{ user_id: 'M1', user_login: 'm1' }]);
    try {
      const r = await syncTwitchMods(envWith(m, { DB: mockDB(rows) }), 'S', { force: true });
      assert(r.ok && r.added === 0, JSON.stringify(r));
      assert.equal(rows.get('M1').status, 'removed');
    } finally { restore(); }
  });

  await t('sync surfaces scope-missing (403) as needsReconnect', async () => {
    const m = new Map(); m.set('vault:tw:S', vaultRec('S', 'streamer', 'channel:moderate'));
    const restore = stubHelix([], 403);
    try {
      const r = await syncTwitchMods(envWith(m, { DB: mockDB(new Map()) }), 'S', { force: true });
      assert(!r.ok && r.error === 'scope-missing' && r.needsReconnect === true, JSON.stringify(r));
    } finally { restore(); }
  });

  await t('background sync respects the KV throttle; force bypasses', async () => {
    const rows = new Map();
    const m = new Map();
    m.set('vault:tw:S', vaultRec('S', 'streamer', MANAGE));
    m.set('warden:modsync:S', '1');   // throttle gate present
    const restore = stubHelix([{ user_id: 'M1', user_login: 'm1' }]);
    try {
      const bg = await syncTwitchMods(envWith(m, { DB: mockDB(rows) }), 'S');
      assert(bg.ok && bg.skipped === true, JSON.stringify(bg));
      assert(!rows.has('M1'), 'throttled sync must not write');
      const forced = await syncTwitchMods(envWith(m, { DB: mockDB(rows) }), 'S', { force: true });
      assert(forced.ok && forced.added === 1, JSON.stringify(forced));
    } finally { restore(); }
  });

  // ── isObsCommandAllowed (OBS capability allowlist) ──────────────────
  const CAPS = {
    enabled: true, brbPanic: true, brbScene: 'BRB', replay: true,
    scenes: ['Game'], sources: ['Cam'], mics: ['Mic'],
    movable: ['Cam', 'Overlay Group'], volumes: ['Music'], media: ['Intro'],
    browsers: ['Alerts'], filters: ['Cam::Blur'], hotkeys: ['ClipHotkey'],
  };

  await t('obs allow: enabled gate + each capability with an allowed target', async () => {
    assert(isObsCommandAllowed(CAPS, 'brbPanic', '', ''));
    assert(isObsCommandAllowed(CAPS, 'saveReplay', '', ''));
    assert(isObsCommandAllowed(CAPS, 'sceneSwitch', 'Game', ''));
    assert(isObsCommandAllowed(CAPS, 'sourceToggle', 'Cam', ''));
    assert(isObsCommandAllowed(CAPS, 'muteMic', 'Mic', ''));
    assert(isObsCommandAllowed(CAPS, 'moveSource', 'Cam', 'topright'));
    assert(isObsCommandAllowed(CAPS, 'moveSource', 'Overlay Group', 'reset'));
    assert(isObsCommandAllowed(CAPS, 'setVolume', 'Music', '-6'));
    assert(isObsCommandAllowed(CAPS, 'mediaControl', 'Intro', 'play'));
    assert(isObsCommandAllowed(CAPS, 'refreshBrowser', 'Alerts', ''));
    assert(isObsCommandAllowed(CAPS, 'filterToggle', 'Cam', 'Blur'));
    assert(isObsCommandAllowed(CAPS, 'fireHotkey', 'ClipHotkey', ''));
  });

  await t('obs deny: disabled caps refuses everything', async () => {
    const off = { ...CAPS, enabled: false };
    assert(!isObsCommandAllowed(off, 'brbPanic', '', ''));
    assert(!isObsCommandAllowed(off, 'sceneSwitch', 'Game', ''));
  });

  await t('obs deny: target not on the allowlist', async () => {
    assert(!isObsCommandAllowed(CAPS, 'sceneSwitch', 'Private', ''));
    assert(!isObsCommandAllowed(CAPS, 'moveSource', 'Webcam', 'topleft'));
    assert(!isObsCommandAllowed(CAPS, 'filterToggle', 'Cam', 'Sharpen')); // wrong filter
    assert(!isObsCommandAllowed(CAPS, 'fireHotkey', 'EndStream', ''));
    assert(!isObsCommandAllowed(CAPS, 'unknownAction', 'Cam', '')); // unlisted verb
  });

  await t('obs deny: bad arg2 (position / verb / dB range)', async () => {
    assert(!isObsCommandAllowed(CAPS, 'moveSource', 'Cam', 'sideways'));
    assert(!isObsCommandAllowed(CAPS, 'mediaControl', 'Intro', 'explode'));
    assert(!isObsCommandAllowed(CAPS, 'setVolume', 'Music', '5'));   // > 0 dB
    assert(!isObsCommandAllowed(CAPS, 'setVolume', 'Music', '-250')); // < -100
    assert(!isObsCommandAllowed(CAPS, 'setVolume', 'Music', 'loud')); // not a number
  });

  await t('obs deny: replay/brb only when their flag is set', async () => {
    const noExtras = { ...CAPS, replay: false, brbPanic: false };
    assert(!isObsCommandAllowed(noExtras, 'saveReplay', '', ''));
    assert(!isObsCommandAllowed(noExtras, 'brbPanic', '', ''));
  });

  await t('parseDb accepts [-100,0], rejects positives / garbage', async () => {
    assert.equal(parseDb('0'), 0);
    assert.equal(parseDb('-6'), -6);
    assert.equal(parseDb('-12.5'), -12.5);
    assert.equal(parseDb('-100'), -100);
    assert.equal(parseDb('1'), null);
    assert.equal(parseDb('-101'), null);
    assert.equal(parseDb('x'), null);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
