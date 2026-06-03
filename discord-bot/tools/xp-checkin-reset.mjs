#!/usr/bin/env node
// One-shot reset, Aquilo Pass XP + daily check-in counters back to 0.
//
// Clay's directive (2026-06-02): start everyone on a fresh season climb.
// Resets engagement/grind counters ONLY; currency, collections, decks,
// achievements, ranked, Patreon, Twitch entitlement counters, and all
// profile customization are preserved (this script never writes to those
// keys/tables). Every affected structure is snapshotted to KV under a
// 30-day-TTL archive BEFORE any mutation, and the snapshot is read back +
// verified non-empty; if a snapshot fails, the matching reset is skipped.
//
// Idempotent: re-running re-zeroes already-zero values (no-op) and writes
// a fresh dated snapshot.
//
// Usage:
//   node tools/xp-checkin-reset.mjs            # DRY RUN (snapshots + plan, no writes)
//   node tools/xp-checkin-reset.mjs --execute  # snapshot, verify, then reset
//
// Talks to production via the already-authenticated wrangler CLI
// (workers_kv + d1 write). No worker deploy required.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Bindings (from discord-bot/wrangler.toml) ───────────────────────────
const NS_ID = 'ffa4638187fd4c71b65f62e00b9437fa';   // LOADOUT_BOLTS
const D1_DB = 'aquilo_bot_db';                       // DB binding
const GUILD = '1504103035951906883';                 // AQUILO_VAULT_GUILD_ID
const TTL_S = 30 * 24 * 60 * 60;                     // 30-day snapshot TTL

const EXECUTE = process.argv.includes('--execute');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');  // KV-safe ISO
const ARCHIVE = (name) => `xp-reset-archive:${STAMP}:${name}`;

const WRANGLER = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const TMP = mkdtempSync(join(tmpdir(), 'xpreset-'));

// ── wrangler helpers (with a small retry for transient API blips) ───────
// shell:true is required on Windows (Node refuses to spawn .cmd otherwise),
// and with shell:true args are concatenated UNESCAPED. So we build the
// command line ourselves, double-quoting any arg that contains a space
// (our SQL is the only such arg and contains no double-quotes of its own).
function quoteArg(a) {
  return /[\s]/.test(a) ? `"${a}"` : a;
}
function wr(args) {
  const cmd = [WRANGLER, 'wrangler', ...args].map(quoteArg).join(' ');
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync(cmd, { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 0) return r.stdout || '';
    last = out;
    // Transient Cloudflare API auth/availability blips, retry briefly.
    if (/code: ?(10000|9109)|fetch failed|ECONNRESET|timed? ?out/i.test(out)) continue;
    break;
  }
  throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${last}`);
}

function kvList(prefix) {
  const t = wr(['kv', 'key', 'list', `--namespace-id=${NS_ID}`, `--prefix=${prefix}`, '--remote']);
  const i = t.indexOf('[');
  if (i < 0) return [];
  return JSON.parse(t.slice(i)).map((k) => k.name);
}
function kvGet(key) {
  try {
    const v = wr(['kv', 'key', 'get', key, `--namespace-id=${NS_ID}`, '--remote']);
    return v == null ? null : v.replace(/\r?\n$/, '');
  } catch { return null; }  // missing key
}
function kvGetJson(key) {
  const v = kvGet(key);
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch { return null; }
}
function kvPutJson(key, obj, { ttl } = {}) {
  const f = join(TMP, 'v.json');
  writeFileSync(f, JSON.stringify(obj));
  const args = ['kv', 'key', 'put', key, `--path=${f}`, `--namespace-id=${NS_ID}`, '--remote'];
  if (ttl) args.push(`--ttl=${ttl}`);  // wrangler uses --ttl (seconds of visibility)
  wr(args);
}
function d1(sql) {
  // SQL goes inline via --command; wr() double-quotes it for the shell.
  const t = wr(['d1', 'execute', D1_DB, '--remote', '--json', `--command=${sql}`]);
  const i = t.indexOf('[');
  const parsed = JSON.parse(t.slice(i));
  return parsed[0]?.results ?? [];
}

// ── Snapshot + verify one structure ─────────────────────────────────────
// Returns { ok, key, size }, ok:false aborts that structure's reset.
function snapshot(name, payload) {
  const key = ARCHIVE(name);
  kvPutJson(key, payload, { ttl: TTL_S });
  // Read-back: confirm it round-trips and is non-empty.
  const back = kvGet(key);
  let ok = false, size = 0;
  if (back && back.length > 0) {
    try { JSON.parse(back); ok = true; size = back.length; } catch { ok = false; }
  }
  return { ok, key, size };
}

const report = { stamp: STAMP, execute: EXECUTE, structures: {}, snapshots: {}, preserve: {}, errors: [] };

console.log(`\n=== Aquilo Pass XP + check-in reset ===`);
console.log(`mode: ${EXECUTE ? 'EXECUTE (will write)' : 'DRY RUN (no writes)'}`);
console.log(`archive stamp: ${STAMP}\n`);

// ── Gather current state ────────────────────────────────────────────────
console.log('[1/4] Reading current state ...');

// pxp:<uid>  (skip the pxp:table singleton if present)
const pxpKeys = kvList('pxp:').filter((k) => k !== 'pxp:table');
const pxp = {};
for (const k of pxpKeys) pxp[k] = kvGetJson(k);
const pxpSumXp = Object.values(pxp).reduce((s, r) => s + (r?.xp || 0), 0);

// community-checkin:<g>:<u>
const ccKeys = kvList(`community-checkin:${GUILD}:`);
const cc = {};
for (const k of ccKeys) cc[k] = kvGetJson(k);
const ccSumStreak = Object.values(cc).reduce((s, r) => s + (r?.streak || 0), 0);
const ccSumTotal = Object.values(cc).reduce((s, r) => s + (r?.total || 0), 0);

// aquilo-pass:user:<uid>:<sid>  (legacy KV pass)
const apKeys = kvList('aquilo-pass:user:');
const ap = {};
for (const k of apKeys) ap[k] = kvGetJson(k);
const apSumXp = Object.values(ap).reduce((s, r) => s + (r?.xp || 0), 0);

// cards:login:<uid>  (Boltbound daily-login)
const clKeys = kvList('cards:login:');
const cl = {};
for (const k of clKeys) cl[k] = kvGetJson(k);

// D1: user_pass_progress
const upp = d1('SELECT season_id, user_id, xp, tier, premium, claimed_free, claimed_premium, updated_at FROM user_pass_progress');
const uppSumXp = upp.reduce((s, r) => s + (Number(r.xp) || 0), 0);

// D1: discord_checkins (legacy pic check-in)
const dc = d1('SELECT guild_id, user_id, current_days, longest_days, last_day_et, total_checkins FROM discord_checkins');
const dcSumStreak = dc.reduce((s, r) => s + (Number(r.current_days) || 0), 0);
const dcSumTotal = dc.reduce((s, r) => s + (Number(r.total_checkins) || 0), 0);

report.structures = {
  'pxp: (KV progression XP)':            { keys: pxpKeys.length, sumXp: pxpSumXp },
  'community-checkin: (KV)':             { keys: ccKeys.length, sumStreak: ccSumStreak, sumTotal: ccSumTotal },
  'aquilo-pass:user: (KV legacy pass)':  { keys: apKeys.length, sumXp: apSumXp },
  'cards:login: (KV Boltbound login)':   { keys: clKeys.length },
  'user_pass_progress (D1 pass v2)':     { rows: upp.length, sumXp: uppSumXp },
  'discord_checkins (D1 legacy)':        { rows: dc.length, sumStreak: dcSumStreak, sumTotal: dcSumTotal },
};
console.log('  current state:', JSON.stringify(report.structures, null, 2));

// ── Preserve sample (before), prove currency/collection untouched ──────
// Sample the union of users we touch, so the report can show before/after.
const sampleUsers = [...new Set([
  ...pxpKeys.map((k) => k.slice('pxp:'.length)),
  ...ccKeys.map((k) => k.slice(`community-checkin:${GUILD}:`.length)),
])].slice(0, 5);
function preserveSnap(uid) {
  return {
    wallet: kvGetJson(`wallet:${GUILD}:${uid}`),
    dust: kvGet(`cards:dust:${uid}`),
    collectionBytes: (kvGet(`cards:col:${uid}`) || '').length,
    decksBytes: (kvGet(`cards:deck:${uid}`) || '').length,
  };
}
const preserveBefore = {};
for (const u of sampleUsers) preserveBefore[u] = preserveSnap(u);
report.preserve.before = preserveBefore;

// ── Snapshot everything to KV (30-day TTL) ──────────────────────────────
console.log('\n[2/4] Snapshotting to KV (30-day TTL) ...');
const snaps = [
  ['pxp', { prefix: 'pxp:', keys: pxp }],
  ['community-checkin', { prefix: `community-checkin:${GUILD}:`, keys: cc }],
  ['aquilo-pass-user', { prefix: 'aquilo-pass:user:', keys: ap }],
  ['cards-login', { prefix: 'cards:login:', keys: cl }],
  ['user_pass_progress', { table: 'user_pass_progress', rows: upp }],
  ['discord_checkins', { table: 'discord_checkins', rows: dc }],
];
let allSnapsOk = true;
const snapOk = {};
for (const [name, payload] of snaps) {
  const r = snapshot(name, { ...payload, stamp: STAMP, capturedAt: Date.now() });
  snapOk[name] = r.ok;
  report.snapshots[name] = { key: r.key, ok: r.ok, bytes: r.size };
  console.log(`  ${r.ok ? 'OK ' : 'FAIL'} ${r.key} (${r.size} bytes)`);
  if (!r.ok) allSnapsOk = false;
}
if (!allSnapsOk) {
  console.error('\n!! One or more snapshots failed read-back. ABORTING reset (per directive).');
  report.errors.push('snapshot-readback-failed');
  finish(1);
}

if (!EXECUTE) {
  console.log('\n[3/4] DRY RUN, no reset performed. Re-run with --execute to apply.');
  finish(0);
}

// ── Reset (only structures whose snapshot succeeded) ────────────────────
console.log('\n[3/4] Resetting ...');
const todayYmd = new Date().toISOString().slice(0, 10);
const now = Date.now();

// pxp:<uid> → fresh record (preserve nothing engagement-y; xp/level zeroed)
if (snapOk['pxp']) {
  for (const k of pxpKeys) {
    const r = pxp[k] || {};
    kvPutJson(k, {
      xp: 0, level: 1, lastLevelUtc: 0,
      dailyXp: { ymd: todayYmd, total: 0 }, perKindToday: {},
    });
  }
  console.log(`  pxp: reset ${pxpKeys.length} record(s)`);
}

// community-checkin:<g>:<u> → zero streak/longest/total, clear lastDayEt;
// keep lastUtc/lastSurface (historical, harmless).
if (snapOk['community-checkin']) {
  for (const k of ccKeys) {
    const r = cc[k] || {};
    kvPutJson(k, {
      ...r, streak: 0, longest: 0, total: 0, lastDayEt: null,
    });
  }
  console.log(`  community-checkin: reset ${ccKeys.length} record(s)`);
}

// aquilo-pass:user:<uid>:<sid> → xp/level 0, preserve claimed arrays.
if (snapOk['aquilo-pass-user']) {
  for (const k of apKeys) {
    const r = ap[k] || {};
    kvPutJson(k, { ...r, xp: 0, level: 0, updatedUtc: new Date().toISOString() });
  }
  console.log(`  aquilo-pass:user: reset ${apKeys.length} record(s)`);
}

// cards:login:<uid> → zero streaks/lifetime, clear lastClaimDate, KEEP cosmetics.
if (snapOk['cards-login']) {
  for (const k of clKeys) {
    const r = cl[k] || {};
    kvPutJson(k, {
      ...r, currentStreak: 0, lifetimeDays: 0, peakStreak: 0, lastClaimDate: null,
      cosmetics: Array.isArray(r.cosmetics) ? r.cosmetics : [],
    });
  }
  console.log(`  cards:login: reset ${clKeys.length} record(s)`);
}

// D1 user_pass_progress → xp/tier 0 (preserve premium + claimed_*).
if (snapOk['user_pass_progress']) {
  d1(`UPDATE user_pass_progress SET xp = 0, tier = 0, updated_at = ${now}`);
  console.log(`  user_pass_progress: zeroed xp+tier (${upp.length} row(s))`);
}

// D1 discord_checkins → zero counters (last_day_et is NOT NULL → empty string).
if (snapOk['discord_checkins']) {
  d1(`UPDATE discord_checkins SET current_days = 0, longest_days = 0, total_checkins = 0, last_day_et = ''`);
  console.log(`  discord_checkins: zeroed counters (${dc.length} row(s))`);
}

// ── Verify ──────────────────────────────────────────────────────────────
console.log('\n[4/4] Verifying ...');
const verify = {};

// XP / streak sums should now be 0.
const uppAfter = d1('SELECT COALESCE(SUM(xp),0) sx, COALESCE(SUM(tier),0) st, COALESCE(SUM(premium),0) sp FROM user_pass_progress')[0] || {};
const dcAfter = d1('SELECT COALESCE(SUM(current_days),0) sc, COALESCE(SUM(longest_days),0) sl, COALESCE(SUM(total_checkins),0) st FROM discord_checkins')[0] || {};
verify.user_pass_progress_after = uppAfter;
verify.discord_checkins_after = dcAfter;

let pxpAfterSum = 0;
for (const k of pxpKeys) pxpAfterSum += (kvGetJson(k)?.xp || 0);
let ccAfterStreak = 0, ccAfterTotal = 0;
for (const k of ccKeys) { const r = kvGetJson(k) || {}; ccAfterStreak += (r.streak || 0); ccAfterTotal += (r.total || 0); }
verify.pxp_sumXp_after = pxpAfterSum;
verify.community_checkin_sumStreak_after = ccAfterStreak;
verify.community_checkin_sumTotal_after = ccAfterTotal;

// Preserve check (after), must equal `before`.
const preserveAfter = {};
let preserveOk = true;
for (const u of sampleUsers) {
  const a = preserveSnap(u);
  preserveAfter[u] = a;
  const b = preserveBefore[u];
  const same =
    JSON.stringify(a.wallet) === JSON.stringify(b.wallet) &&
    a.dust === b.dust &&
    a.collectionBytes === b.collectionBytes &&
    a.decksBytes === b.decksBytes;
  if (!same) { preserveOk = false; report.errors.push(`preserve-mismatch:${u}`); }
}
report.preserve.after = preserveAfter;
verify.preserveOk = preserveOk;

// Snapshot retrievable, decode one archive entry and confirm pre-reset data.
const checkKey = report.snapshots['community-checkin']?.key || report.snapshots['pxp']?.key;
const decoded = kvGetJson(checkKey);
const decodedKeys = decoded?.keys ? Object.keys(decoded.keys).length : (decoded?.rows?.length ?? 0);
verify.snapshotRetrievable = { key: checkKey, entries: decodedKeys };

report.verify = verify;
console.log('  verify:', JSON.stringify(verify, null, 2));

const zeroed =
  Number(uppAfter.sx) === 0 && Number(dcAfter.sc) === 0 && Number(dcAfter.st) === 0 &&
  pxpAfterSum === 0 && ccAfterStreak === 0 && ccAfterTotal === 0;
if (!zeroed) report.errors.push('post-reset-sums-nonzero');
if (!preserveOk) console.error('  !! PRESERVE CHECK FAILED, currency/collection changed.');

console.log(`\n=== ${report.errors.length ? 'COMPLETED WITH ERRORS' : 'RESET COMPLETE'} ===`);
finish(report.errors.length ? 2 : 0);

// ── exit + dump machine-readable report ─────────────────────────────────
function finish(code) {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log('\n----- REPORT JSON -----');
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}
