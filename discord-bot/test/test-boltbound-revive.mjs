// Focused tests for the Boltbound worker REVIVAL wiring:
//   1. Hero-power engine wiring (createMatch init, applyAction 'heroPower',
//      armor absorb, fire-bolt/coin/mark/heal, startTurn reset,
//      renderableState projection).
//   2. Emote route through handleBoltboundWeb + opponent-emote merge on
//      the match-state poll.
//   3. actionId idempotency (replay a stored response for a duplicate id).
//
// Run from discord-bot/:
//   node test/test-boltbound-revive.mjs

import { createMatch, applyMulligan, applyAction } from '../cards-battle.js';
import { renderableState, sideOf } from '../cards-match.js';
import { putMatch, setActiveMatchId } from '../cards-state.js';
import { handleBoltboundWeb } from '../cards-web.js';
import { CARDS, championForClass } from '../cards-content.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory KV shim ─────────────────────────────────────────────
function makeKv() {
  const store = new Map();
  return {
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') { try { return JSON.parse(v); } catch { return null; } }
      return v;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async list({ prefix, limit } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix || '')) keys.push({ name: k });
      return { keys: keys.slice(0, limit || 1000), list_complete: true };
    },
    _store: store,
  };
}

// Build a small legal-ish deck (1 champion + a handful of cheap minions,
// padded to 20). Only used to seed a match object; not deck-validated here.
function buildDeck(cls) {
  const champ = championForClass(cls);
  const minions = Object.values(CARDS)
    .filter(c => c.type === 'minion' && !c.token && (c.mana || 0) <= 3 && c.rarity !== 'champion')
    .slice(0, 19)
    .map(c => c.id);
  return [champ, ...minions];
}

// ── 1. Hero-power engine wiring ───────────────────────────────────

console.log('- createMatch initialises per-side hero powers from champion class');
{
  const m = createMatch({
    matchId: 'hp-init',
    playerA: { userId: 'ua', deck: buildDeck('warrior'), championClass: 'warrior' },
    npc: { archetype: 'aggro', deck: buildDeck('mage'), championClass: 'mage' },
  });
  assert(m.heroPower && m.heroPower.A && m.heroPower.B, 'heroPower record exists per side');
  eq(m.heroPower.A.id, 'armor-up', 'A (warrior) → armor-up');
  eq(m.heroPower.B.id, 'fire-bolt', 'B (mage) → fire-bolt');
  eq(m.heroPower.A.usedThisTurn, false, 'A usedThisTurn starts false');
  assert(m.heroArmor && m.heroArmor.A === 0, 'heroArmor initialised to 0');
}

// Helper: force a match to a playable active turn for `side`.
function activeMatch(opts) {
  const m = createMatch(opts);
  applyMulligan(m, 'A', []);
  applyMulligan(m, 'B', []);
  return m;
}

console.log('- applyAction heroPower: warrior Armor Up grants armor, absorbed before hp');
{
  const m = activeMatch({
    matchId: 'hp-armor',
    playerA: { userId: 'ua', deck: buildDeck('warrior'), championClass: 'warrior' },
    playerB: { userId: 'ub', deck: buildDeck('warrior'), championClass: 'warrior' },
  });
  const side = m.active;
  m.mana[side].cur = 5;
  const r = applyAction(m, { kind: 'heroPower', side });
  assert(!r.error, 'armor-up action accepted');
  eq(m.heroArmor[side], 2, 'armor = +2');
  eq(m.heroPower[side].usedThisTurn, true, 'usedThisTurn set');
  eq(m.mana[side].cur, 3, 'mana spent 5 → 3');
  // Re-fire same turn is rejected.
  const r2 = applyAction(m, { kind: 'heroPower', side });
  eq(r2.error, 'already-used-this-turn', 'second fire same turn rejected');
  eq(m.heroArmor[side], 2, 'armor unchanged by rejected re-fire');
}

console.log('- Fire Bolt (mage) hits any target; deaths + hp resolve');
{
  const m = activeMatch({
    matchId: 'hp-firebolt',
    playerA: { userId: 'ua', deck: buildDeck('mage'), championClass: 'mage' },
    playerB: { userId: 'ub', deck: buildDeck('mage'), championClass: 'mage' },
  });
  const side = m.active; const opp = side === 'A' ? 'B' : 'A';
  m.mana[side].cur = 5;
  const before = m.hp[opp];
  const r = applyAction(m, { kind: 'heroPower', side, targetId: 'oppHero' });
  assert(!r.error, 'fire-bolt at enemy hero accepted');
  eq(m.hp[opp], before - 1, 'enemy hero took 1');
  // No target → rejected, nothing spent.
  m.heroPower[side].usedThisTurn = false; m.mana[side].cur = 5;
  const r2 = applyAction(m, { kind: 'heroPower', side, targetId: null });
  eq(r2.error, 'invalid-target', 'fire-bolt with no target rejected');
  eq(m.mana[side].cur, 5, 'no mana spent on rejected fire-bolt');
}

console.log('- Coin Strike (rogue) always hits the enemy hero, no target needed');
{
  const m = activeMatch({
    matchId: 'hp-coin',
    playerA: { userId: 'ua', deck: buildDeck('rogue'), championClass: 'rogue' },
    playerB: { userId: 'ub', deck: buildDeck('rogue'), championClass: 'rogue' },
  });
  const side = m.active; const opp = side === 'A' ? 'B' : 'A';
  m.mana[side].cur = 5;
  const before = m.hp[opp];
  const r = applyAction(m, { kind: 'heroPower', side });
  assert(!r.error, 'coin-strike accepted with no target');
  eq(m.hp[opp], before - 1, 'enemy hero took 1 from coin-strike');
}

console.log('- Armor absorbs an incoming attack before hero hp (dealDamage hook)');
{
  const m = activeMatch({
    matchId: 'hp-absorb',
    playerA: { userId: 'ua', deck: buildDeck('warrior'), championClass: 'warrior' },
    playerB: { userId: 'ub', deck: buildDeck('warrior'), championClass: 'warrior' },
  });
  // Give side A 3 armor, then deal 2 face damage via a synthesised attacker.
  const s = 'A', opp = 'B';
  m.heroArmor[s] = 3;
  const hpBefore = m.hp[s];
  // Directly exercise the damage path: put an enemy minion and attack the hero.
  m.active = opp;
  const atkr = { uid: 'x1', cardId: 'test', atk: 2, hp: 5, maxHp: 5, canAttack: true, status: [], keywords: [] };
  m.board[opp] = [atkr];
  const r = applyAction(m, { kind: 'attack', side: opp, attackerUid: 'x1', defenderUid: 'hero' });
  assert(!r.error, 'attack on armored hero resolves');
  eq(m.heroArmor[s], 1, 'armor 3 → 1 (absorbed 2)');
  eq(m.hp[s], hpBefore, 'hero hp unchanged while armor absorbs');
}

console.log('- Mark Target adds +1 damage from all sources this turn, cleared at turn-end');
{
  const m = activeMatch({
    matchId: 'hp-mark',
    playerA: { userId: 'ua', deck: buildDeck('ranger'), championClass: 'ranger' },
    playerB: { userId: 'ub', deck: buildDeck('ranger'), championClass: 'ranger' },
  });
  const side = m.active; const opp = side === 'A' ? 'B' : 'A';
  const victim = { uid: 'v1', cardId: 'test', atk: 1, hp: 5, maxHp: 5, canAttack: true, status: [], keywords: [] };
  m.board[opp] = [victim];
  m.mana[side].cur = 5;
  const r = applyAction(m, { kind: 'heroPower', side, targetId: 'v1' });
  assert(!r.error, 'mark accepted on enemy minion');
  assert(m.markedTargets && m.markedTargets['v1'], 'markedTargets entry present');
  // A friendly 2-atk attacker now deals 2+1 = 3 to the marked minion.
  const atkr = { uid: 'a1', cardId: 'test', atk: 2, hp: 5, maxHp: 5, canAttack: true, status: [], keywords: [] };
  m.board[side] = [atkr];
  applyAction(m, { kind: 'attack', side, attackerUid: 'a1', defenderUid: 'v1' });
  eq(victim.hp, 2, 'marked minion took 3 (2 atk + 1 mark), 5 → 2');
  // End the marker's turn: mark clears.
  m.mana[side].cur = 0;
  applyAction(m, { kind: 'endTurn', side });
  assert(!(m.markedTargets && m.markedTargets['v1']), 'mark cleared at marker turn-end');
}

console.log('- startTurn resets usedThisTurn for the incoming side');
{
  const m = activeMatch({
    matchId: 'hp-reset',
    playerA: { userId: 'ua', deck: buildDeck('warrior'), championClass: 'warrior' },
    playerB: { userId: 'ub', deck: buildDeck('warrior'), championClass: 'warrior' },
  });
  const side = m.active;
  m.mana[side].cur = 5;
  applyAction(m, { kind: 'heroPower', side });
  eq(m.heroPower[side].usedThisTurn, true, 'used after firing');
  applyAction(m, { kind: 'endTurn', side });          // → opp turn
  const opp = side === 'A' ? 'B' : 'A';
  m.mana[opp].cur = 0;
  applyAction(m, { kind: 'endTurn', side: opp });      // → back to side
  eq(m.heroPower[side].usedThisTurn, false, 'usedThisTurn reset on the side\'s next turn');
}

console.log('- renderableState emits heroPower { id, manaCost, usedThisTurn } per side');
{
  const m = activeMatch({
    matchId: 'hp-render',
    playerA: { userId: 'ua', deck: buildDeck('warrior'), championClass: 'warrior' },
    playerB: { userId: 'ub', deck: buildDeck('mage'), championClass: 'mage' },
  });
  const view = renderableState(m, 'ua');
  assert(view.you.heroPower && view.you.heroPower.id === 'armor-up', 'you.heroPower.id = armor-up');
  eq(view.you.heroPower.manaCost, 2, 'you.heroPower.manaCost = 2');
  assert(view.them.heroPower && view.them.heroPower.id === 'fire-bolt', 'them.heroPower.id = fire-bolt');
  assert(typeof view.you.armor === 'number', 'you.armor projected');
}

// ── HMAC signer for HTTP-layer tests ──────────────────────────────
const SECRET = 'revive-test-secret';
const GUILD = '1504103035951906883';
const USER_A = '111111111111111111';

async function signPost(path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '\n' + body)));
  let hex = ''; for (const b of sig) hex += b.toString(16).padStart(2, '0');
  return new Request('https://bot.example.com' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aquilo-web-ts': ts, 'x-aquilo-web-sig': hex },
    body,
  });
}

function makeEnv() {
  return { LOADOUT_BOLTS: makeKv(), AQUILO_SITE_WEB_SECRET: SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
}

// Seed an active NPC match (USER_A on side A) directly in KV.
async function seedMatch(env, matchId) {
  const m = createMatch({
    matchId, guildId: GUILD,
    playerA: { userId: USER_A, deck: buildDeck('warrior'), championClass: 'warrior' },
    npc: { archetype: 'aggro', deck: buildDeck('mage'), championClass: 'mage' },
  });
  applyMulligan(m, 'A', []);
  const npcSide = m.npc.side;
  applyMulligan(m, npcSide, []);
  await putMatch(env, m);
  await setActiveMatchId(env, GUILD, USER_A, matchId);
  return m;
}

// ── 2. Emote route + opponent-emote merge ─────────────────────────

console.log('- emote route accepts a canonical emote and match-state merges the opponent bubble');
{
  const env = makeEnv();
  const m = await seedMatch(env, 'emote-match');
  const npcSide = m.npc.side;             // opponent side (B)
  // Post an emote AS the opponent by writing straight to the feed via the
  // module (the HTTP write resolves the caller's side to A; to simulate the
  // opponent we seed the feed directly).
  const { sendEmote } = await import('../boltbound-emotes.js');
  const sent = await sendEmote(env, 'emote-match', npcSide, 'wp');
  assert(sent.ok, 'opponent emote persisted to feed');

  // Player A polls match state → opponent emote merged onto them.emote.
  const stateReq = await signPost('/web/boltbound/match/state', { discordId: USER_A, guildId: GUILD });
  const stateResp = await handleBoltboundWeb(stateReq, env);
  const stateBody = await stateResp.json();
  eq(stateResp.status, 200, 'match/state 200');
  assert(stateBody.match && stateBody.match.them && stateBody.match.them.emote, 'them.emote present');
  eq(stateBody.match.them.emote.id, 'wp', 'merged opponent emote id = wp');

  // The player's own emote write is accepted + rate-shaped by the module.
  const emoteReq = await signPost('/web/boltbound/emote', { discordId: USER_A, guildId: GUILD, emoteId: 'hello' });
  const emoteResp = await handleBoltboundWeb(emoteReq, env);
  const emoteBody = await emoteResp.json();
  eq(emoteResp.status, 200, 'own emote write 200');
  assert(emoteBody.ok, 'own emote ok');

  // A bogus emote id is rejected.
  const badReq = await signPost('/web/boltbound/emote', { discordId: USER_A, guildId: GUILD, emoteId: 'rage' });
  const badResp = await handleBoltboundWeb(badReq, env);
  eq(badResp.status, 400, 'bogus emote rejected 400');
}

// ── 3. actionId idempotency (replay) ──────────────────────────────

console.log('- duplicate actionId replays the first response instead of re-mutating');
{
  const env = makeEnv();
  await seedMatch(env, 'dedupe-match');
  // Two identical match/action end-turn writes with the SAME actionId.
  const payload = { discordId: USER_A, guildId: GUILD, kind: 'endTurn', actionId: 'act-123' };
  const req1 = await signPost('/web/boltbound/match/action', payload);
  const resp1 = await handleBoltboundWeb(req1, env);
  const body1 = await resp1.text();
  assert(resp1.headers.get('x-bb-replay') !== '1', 'first call is fresh (not a replay)');

  const req2 = await signPost('/web/boltbound/match/action', payload);
  const resp2 = await handleBoltboundWeb(req2, env);
  const body2 = await resp2.text();
  eq(resp2.headers.get('x-bb-replay'), '1', 'second call is a replay');
  eq(body2, body1, 'replayed body is byte-identical to the first');

  // A different actionId is processed fresh (not a replay).
  const req3 = await signPost('/web/boltbound/match/action',
    { discordId: USER_A, guildId: GUILD, kind: 'endTurn', actionId: 'act-999' });
  const resp3 = await handleBoltboundWeb(req3, env);
  assert(resp3.headers.get('x-bb-replay') !== '1', 'distinct actionId processed fresh');

  // Absent actionId is always processed fresh.
  const req4 = await signPost('/web/boltbound/match/action', { discordId: USER_A, guildId: GUILD, kind: 'endTurn' });
  const resp4 = await handleBoltboundWeb(req4, env);
  assert(resp4.headers.get('x-bb-replay') !== '1', 'absent actionId processed fresh');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
