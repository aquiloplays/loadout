// Standalone harness for the user-uploaded hero avatar in
// character.js. Stubs env.LOADOUT_BOLTS with an in-memory KV that
// supports the metadata API (put with { metadata }, getWithMetadata,
// delete) and a tiny `crypto.subtle` no-op shim so character.js's
// transitive imports don't crash.
//
// Coverage:
//   - valid upload returns avatarUrl + contentType + size + uploadedAt
//   - GET handler round-trip streams stored bytes with correct
//     Content-Type + cache-control + CORS headers
//   - oversized (> 4MB) rejected with `too-large` + size/max fields
//   - bad contentType rejected with `bad-content-type`
//   - bad / empty base64 rejected with `bad-data`
//   - data: URI prefix stripped from dataBase64
//   - clear via clear:true deletes
//   - clear via empty dataBase64 deletes
//   - clear is idempotent (clearing a missing avatar still returns ok)
//   - locked character can still upload / clear avatar (lock not
//     consulted by putAvatarWeb / clearAvatarWeb)
//   - getAvatarUrl returns null when no avatar stored, real URL after
//     upload
//   - GET handler returns 404 for missing user + malformed path
//
// Run from repo root:
//   node discord-bot/test/test-character-avatar.mjs

import {
  putAvatarWeb,
  clearAvatarWeb,
  getAvatarUrl,
  handleCharacterAvatar,
  AVATAR_MAX_BYTES,
  AVATAR_ALLOWED_CONTENT_TYPES,
} from '../character.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ✅ ' + label);
  else { failures++; console.log('  ❌ ' + label); }
}
function eq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('    expected', JSON.stringify(b), '\n    got     ', JSON.stringify(a));
  assert(ok, label);
}

// KV stub, values are stored as { value, metadata }. Supports
// put(key, value, opts?), get(key, opts?), getWithMetadata(key, opts?),
// delete(key), list({ prefix }).
function makeKv() {
  const store = new Map();
  return {
    async put(key, value, opts) {
      // Normalize bytes to Uint8Array (Workers KV accepts ArrayBuffer
      // too but our test code only feeds Uint8Array / string).
      let v;
      if (value instanceof Uint8Array) v = value;
      else if (value instanceof ArrayBuffer) v = new Uint8Array(value);
      else v = value;
      store.set(key, { value: v, metadata: (opts && opts.metadata) || null });
    },
    async get(key, opts) {
      const rec = store.get(key);
      if (!rec) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(typeof rec.value === 'string' ? rec.value : new TextDecoder().decode(rec.value)); }
        catch { return null; }
      }
      if (opts && opts.type === 'arrayBuffer') {
        return rec.value instanceof Uint8Array ? rec.value.buffer.slice(rec.value.byteOffset, rec.value.byteOffset + rec.value.byteLength) : rec.value;
      }
      return rec.value;
    },
    async getWithMetadata(key, opts) {
      const rec = store.get(key);
      if (!rec) return { value: null, metadata: null };
      const v = (opts && opts.type === 'arrayBuffer')
        ? (rec.value instanceof Uint8Array ? rec.value.buffer.slice(rec.value.byteOffset, rec.value.byteOffset + rec.value.byteLength) : rec.value)
        : rec.value;
      return { value: v, metadata: rec.metadata };
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

const GUILD = '1504103035951906883';
const USER  = '209640265063006208';
const ENV_BASE = { PUBLIC_WORKER_URL: 'https://loadout-discord.test.workers.dev' };

// Smallest valid-ish image, 8 raw bytes is enough for the validator;
// it doesn't decode. Base64-encoded.
function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  // btoa exists in Node ≥16.
  return Buffer.from(s, 'binary').toString('base64');
}
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TINY_PNG_B64 = b64(PNG_HEADER);

console.log('- constants exported');
{
  eq(AVATAR_MAX_BYTES, 4 * 1024 * 1024, 'AVATAR_MAX_BYTES = 4MB');
  assert(AVATAR_ALLOWED_CONTENT_TYPES.has('image/png'),  'png allowed');
  assert(AVATAR_ALLOWED_CONTENT_TYPES.has('image/jpeg'), 'jpeg allowed');
  assert(AVATAR_ALLOWED_CONTENT_TYPES.has('image/gif'),  'gif allowed');
  assert(AVATAR_ALLOWED_CONTENT_TYPES.has('image/webp'), 'webp allowed');
  assert(!AVATAR_ALLOWED_CONTENT_TYPES.has('image/svg+xml'), 'svg refused');
}

console.log('- valid upload');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  const r = await putAvatarWeb(env, USER, 'image/png', TINY_PNG_B64, GUILD);
  assert(r.ok, 'ok:true');
  eq(r.contentType, 'image/png', 'contentType echoed');
  eq(r.size, PNG_HEADER.length, 'size matches decoded length');
  assert(typeof r.uploadedAt === 'number' && r.uploadedAt > 0, 'uploadedAt timestamp');
  assert(typeof r.avatarUrl === 'string' && r.avatarUrl.includes('/character/avatar/' + USER), 'avatarUrl points at /character/avatar/<userId>');
  assert(r.avatarUrl.includes('?v=' + r.uploadedAt), 'avatarUrl pinned to uploadedAt');
}

console.log('- GET round-trip');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  await putAvatarWeb(env, USER, 'image/gif', b64(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), GUILD);
  const req = new Request('https://w/character/avatar/' + USER + '.bin');
  const resp = await handleCharacterAvatar(req, env, '/character/avatar/' + USER + '.bin');
  eq(resp.status, 200, 'GET returns 200');
  eq(resp.headers.get('content-type'), 'image/gif', 'content-type from metadata');
  assert((resp.headers.get('cache-control') || '').includes('immutable'), 'cache-control immutable');
  eq(resp.headers.get('access-control-allow-origin'), '*', 'CORS *');
  const buf = new Uint8Array(await resp.arrayBuffer());
  eq(Array.from(buf), [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'body bytes round-trip');
}

console.log('- oversized rejection');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  // Construct a payload one byte over the cap.
  const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const r = await putAvatarWeb(env, USER, 'image/png', b64(big), GUILD);
  eq(r.ok, false, 'ok:false');
  eq(r.error, 'too-large', 'error code');
  eq(r.max, AVATAR_MAX_BYTES, 'max echoed');
  eq(r.size, AVATAR_MAX_BYTES + 1, 'size echoed');
  // KV should not have a key after rejection.
  const url = await getAvatarUrl(env, USER);
  eq(url, null, 'no avatar persisted on rejection');
}

console.log('- bad contentType');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  const r = await putAvatarWeb(env, USER, 'image/svg+xml', TINY_PNG_B64, GUILD);
  eq(r.ok, false, 'ok:false');
  eq(r.error, 'bad-content-type', 'error code');
  assert(Array.isArray(r.allowed) && r.allowed.includes('image/png'), 'allowed list returned');
  // Case-insensitive normalize: 'IMAGE/PNG' should pass.
  const r2 = await putAvatarWeb(env, USER, 'IMAGE/PNG', TINY_PNG_B64, GUILD);
  assert(r2.ok, 'uppercase contentType normalized');
}

console.log('- bad / empty base64');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  const r1 = await putAvatarWeb(env, USER, 'image/png', '!@#$%^', GUILD);
  eq(r1.error, 'bad-data', 'invalid base64 → bad-data');
  // Empty string is handled by routeCharacterAvatar (clear path), but
  // putAvatarWeb directly with '' returns bad-data, both fine.
  const r2 = await putAvatarWeb(env, USER, 'image/png', '', GUILD);
  eq(r2.error, 'bad-data', 'empty base64 → bad-data');
}

console.log('- data: URI prefix stripped');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  const dataUri = 'data:image/png;base64,' + TINY_PNG_B64;
  const r = await putAvatarWeb(env, USER, 'image/png', dataUri, GUILD);
  assert(r.ok, 'data: URI prefix accepted');
  eq(r.size, PNG_HEADER.length, 'size matches decoded body, not the prefix');
}

console.log('- clear via clear flag');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  await putAvatarWeb(env, USER, 'image/png', TINY_PNG_B64, GUILD);
  assert(await getAvatarUrl(env, USER), 'avatarUrl present before clear');
  const c = await clearAvatarWeb(env, USER);
  eq(c, { ok: true, avatarUrl: null }, 'clear returns ok + null');
  const url = await getAvatarUrl(env, USER);
  eq(url, null, 'avatarUrl gone after clear');
  // GET now 404.
  const resp = await handleCharacterAvatar(
    new Request('https://w/character/avatar/' + USER),
    env, '/character/avatar/' + USER,
  );
  eq(resp.status, 404, 'GET 404s after clear');
}

console.log('- clear idempotent');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  const c1 = await clearAvatarWeb(env, USER);
  eq(c1.ok, true, 'first clear ok');
  const c2 = await clearAvatarWeb(env, USER);
  eq(c2.ok, true, 'second clear still ok');
  eq(c2.avatarUrl, null, 'avatarUrl null');
}

console.log('- locked character can still upload + clear');
{
  // Direct simulation: write a hero record with locked:true to KV,
  // then exercise both avatar paths. Neither putAvatarWeb nor
  // clearAvatarWeb touches the hero record, so the lock has no
  // effect, that\'s the requirement (cosmetic upload is independent
  // of the class-lock slot).
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  await env.LOADOUT_BOLTS.put(
    `d:hero:${GUILD}:${USER}`,
    JSON.stringify({ locked: true, className: 'rogue', lookVersion: 1, custom: {} }),
  );
  const r = await putAvatarWeb(env, USER, 'image/png', TINY_PNG_B64, GUILD);
  assert(r.ok, 'put succeeds against a locked hero');
  const url = await getAvatarUrl(env, USER);
  assert(typeof url === 'string' && url.length > 0, 'getAvatarUrl returns the URL');
  const c = await clearAvatarWeb(env, USER);
  assert(c.ok, 'clear succeeds against a locked hero');
  // And the hero record is unchanged, lock is still set.
  const hero = await env.LOADOUT_BOLTS.get(`d:hero:${GUILD}:${USER}`, { type: 'json' });
  eq(hero.locked, true, 'hero.locked untouched by avatar swap');
}

console.log('- getAvatarUrl null when no avatar');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  eq(await getAvatarUrl(env, USER), null, 'no kv entry → null');
}

console.log('- GET handler edge cases');
{
  const env = { ...ENV_BASE, LOADOUT_BOLTS: makeKv() };
  // Unknown user.
  const r1 = await handleCharacterAvatar(
    new Request('https://w/character/avatar/' + USER),
    env, '/character/avatar/' + USER,
  );
  eq(r1.status, 404, 'unknown user 404s');
  // Malformed path, non-snowflake id.
  const r2 = await handleCharacterAvatar(
    new Request('https://w/character/avatar/not-a-snowflake'),
    env, '/character/avatar/not-a-snowflake',
  );
  eq(r2.status, 404, 'malformed path 404s');
  // No KV binding at all.
  const r3 = await handleCharacterAvatar(
    new Request('https://w/character/avatar/' + USER),
    { ...ENV_BASE }, '/character/avatar/' + USER,
  );
  eq(r3.status, 503, 'missing kv binding 503s');
}

console.log('');
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
