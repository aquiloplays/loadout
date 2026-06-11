// Hangman core selftest. Deterministic, no DOM, no network.
//   node overlays/hangman/selftest.mjs
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
function load(file) {
  const code = fs.readFileSync(path.join(here, file), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'self', code)(mod, mod.exports, undefined);
  return mod.exports;
}
const Words = load('words.js');
const Core = load('hangman-core.js');

let fail = 0, pass = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (c) pass++; else fail++;
};

// ── word bank ────────────────────────────────────────────────────────
console.log('Word bank:');
ok(Words.keys.length === 8, `eight categories (${Words.keys.length})`);
let total = 0, bad = [];
for (const k of Words.keys) {
  const cat = Words.categories[k];
  for (const w of cat.words) {
    total++;
    const n = Core.normalizeWord(w);
    if (n !== w || !Core.validWord(w)) bad.push(`${k}:${w}`);
  }
}
ok(bad.length === 0, `every word is pre-normalized and valid${bad.length ? ' (' + bad.slice(0, 5).join(', ') + ')' : ''}`);
ok(total >= 250, `bank has ${total} words (>= 250)`);
{
  const all = Words.keys.flatMap(k => Words.categories[k].words);
  ok(new Set(all).size === all.length, 'no duplicate words across the bank');
}

// ── normalizeWord ────────────────────────────────────────────────────
console.log('normalizeWord:');
ok(Core.normalizeWord("don't-stop  now") === 'DONT-STOP NOW', 'apostrophes drop, spacing collapses');
ok(Core.normalizeWord('a' + String.fromCharCode(0x2014) + 'b') === 'A-B', 'em dash becomes hyphen');
ok(Core.normalizeWord('  $$ghost!! ') === 'GHOST', 'junk characters stripped');
ok(Core.normalizeWord('- hello -') === 'HELLO', 'leading/trailing separators trimmed');
ok(Core.validWord('GAME OVER') === true, 'validWord accepts phrases');
ok(Core.validWord('CAT') === false, 'validWord rejects under 4 letters');
ok(Core.validWord('') === false, 'validWord rejects empty');

// ── pickWord ─────────────────────────────────────────────────────────
console.log('pickWord:');
{
  const p = Core.pickWord({ customWords: ['neon ghost'], customOnly: true, bank: Words, rng: () => 0 });
  ok(p && p.word === 'NEON GHOST' && p.category === 'Streamer pick', 'customOnly picks the custom word');
}
{
  const p = Core.pickWord({ customWords: ['ab'], customOnly: true, bank: Words, rng: () => 0 });
  ok(p && p.category !== 'Streamer pick', 'invalid custom list falls back to the bank');
}
{
  const p = Core.pickWord({ categories: ['animals'], bank: Words, rng: () => 0 });
  ok(p && p.category === 'Animals', 'category filter respected');
}
{
  const p = Core.pickWord({ categories: ['nope'], bank: Words, rng: () => 0 });
  ok(p && !!p.word, 'unknown category falls back to all');
}
{
  const first = Core.pickWord({ categories: ['animals'], bank: Words, rng: () => 0 }).word;
  const p = Core.pickWord({ categories: ['animals'], bank: Words, rng: () => 0, avoid: first });
  ok(p.word !== first, 'avoid skips the previous word');
}
ok(Core.pickWord({ customWords: [], customOnly: true }) === null, 'no pool at all returns null');

// ── newGame ──────────────────────────────────────────────────────────
console.log('newGame:');
const P = { id: '42', login: 'chatfan', name: 'ChatFan' };
{
  const g = Core.newGame({ word: 'game over', player: P, now: 1000, secs: 120 });
  ok(g && g.word === 'GAME OVER' && g.status === 'playing', 'creates a playing game');
  ok(g.endsAt === 1000 + 120000, 'endsAt honors secs');
  ok(g.lives === 6, 'default lives 6');
}
ok(Core.newGame({ word: 'x', player: P }) === null, 'invalid word returns null');
ok(Core.newGame({ word: 'longword', player: P, lives: 9 }).lives === 6, 'lives clamp high to 6');
ok(Core.newGame({ word: 'longword', player: P, lives: 1 }).lives === 3, 'lives clamp low to 3');
ok(Core.newGame({ word: 'longword', player: P, now: 0, secs: 5 }).endsAt === 20000, 'secs clamp low to 20');

// ── guessLetter ──────────────────────────────────────────────────────
console.log('guessLetter:');
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 120 });
  ok(Core.guessLetter(g, 'g', 1).kind === 'hit', 'lowercase hit counts');
  ok(Core.guessLetter(g, 'G', 2).kind === 'dup', 'repeat guess is a dup, no penalty');
  ok(Core.wrongCount(g) === 0, 'dup did not cost a life');
  ok(Core.guessLetter(g, 'Z', 3).kind === 'miss', 'miss registers');
  ok(Core.wrongCount(g) === 1 && Core.livesLeft(g) === 5, 'one life gone');
  ok(Core.partsShown(g) === 1, 'one figure part after first miss');
  ok(Core.guessLetter(g, '7', 4).kind === 'invalid', 'non-letter is invalid');
  const seq = ['A', 'M', 'E', 'O', 'V'];
  for (const L of seq) Core.guessLetter(g, L, 5);
  const last = Core.guessLetter(g, 'R', 6);
  ok(last.kind === 'win' && g.status === 'won', 'revealing the last letter wins');
  ok(Core.slots(g).every(s => s.shown), 'all slots shown after win');
  ok(Core.guessLetter(g, 'B', 7).kind === 'over', 'guesses after the end are ignored');
}
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 120 });
  const misses = ['Z', 'X', 'Q', 'J', 'K'];
  for (const L of misses) Core.guessLetter(g, L, 1);
  ok(g.status === 'playing' && Core.livesLeft(g) === 1, 'five misses leaves one life');
  const end = Core.guessLetter(g, 'W', 2);
  ok(end.kind === 'lose' && end.reason === 'letters' && g.status === 'lost', 'sixth miss loses');
  ok(Core.partsShown(g) === 6, 'figure complete on loss');
}

// ── guessWord ────────────────────────────────────────────────────────
console.log('guessWord:');
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 120 });
  ok(Core.guessWord(g, 'gameover', 1).kind === 'solve-win', 'solve ignores spacing and case');
  ok(g.status === 'won' && Core.isRevealed(g), 'solve win reveals the board');
}
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 120 });
  ok(Core.guessWord(g, 'lava lamp', 1).kind === 'solve-miss', 'wrong solve is a miss');
  ok(Core.wrongCount(g) === 1, 'wrong solve costs one life');
  ok(Core.guessWord(g, 'x', 2).kind === 'invalid', 'one-letter solve attempt invalid');
  g.solveMisses = 5;
  const end = Core.guessWord(g, 'wrong again', 3);
  ok(end.kind === 'lose' && end.reason === 'solve', 'wrong solve on last life loses');
}

// ── lives scaling ────────────────────────────────────────────────────
console.log('parts scaling (lives=3):');
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 120, lives: 3 });
  Core.guessLetter(g, 'Z', 1);
  ok(Core.partsShown(g) === 2, 'first miss draws 2 parts');
  Core.guessLetter(g, 'X', 2);
  ok(Core.partsShown(g) === 4, 'second miss draws 4 parts');
  const end = Core.guessLetter(g, 'Q', 3);
  ok(end.kind === 'lose' && Core.partsShown(g) === 6, 'third miss completes the figure');
}

// ── time ─────────────────────────────────────────────────────────────
console.log('timer:');
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 60 });
  ok(Core.expire(g, 59999) === null, 'not expired before the deadline');
  const e = Core.expire(g, 60000);
  ok(e && e.kind === 'lose' && g.status === 'lost' && g.loseReason === 'time', 'expires at the deadline');
}
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 60 });
  const r = Core.guessLetter(g, 'G', 61000);
  ok(r.kind === 'lose' && r.reason === 'time', 'late guess triggers the time loss');
}

// ── parseChat ────────────────────────────────────────────────────────
console.log('parseChat:');
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 120 });
  const t = (s) => Core.parseChat(s, g);
  ok(t('e').type === 'letter' && t('e').letter === 'E', 'bare letter');
  ok(t('E?').letter === 'E', 'trailing punctuation tolerated');
  ok(t('!guess a').letter === 'A', '!guess letter');
  ok(t('!g b').letter === 'B', '!g letter');
  ok(t('!solve game over').type === 'solve', '!solve phrase');
  ok(t('!guess gameover').type === 'solve', '!guess full word becomes a solve');
  ok(t('gameover').type === 'solve', 'bare token matching letter count is a solve');
  ok(t('lol') === null, 'short bare token ignored');
  ok(t('no way') === null, 'multi-token chatter ignored');
  ok(t('') === null, 'empty ignored');
  ok(Core.parseChat('gameover', null) === null, 'bare-token solve needs game state');
}

// ── persistence ──────────────────────────────────────────────────────
console.log('persistence:');
{
  const g = Core.newGame({ word: 'GAME OVER', player: P, now: 0, secs: 120 });
  Core.guessLetter(g, 'G', 1);
  Core.guessLetter(g, 'Z', 2);
  const back = Core.deserialize(Core.serialize(g), 3);
  ok(back && back.word === 'GAME OVER' && back.hits.includes('G') && back.wrong.includes('Z'),
    'playing game roundtrips');
  ok(Core.deserialize(Core.serialize(g), 999999999) === null, 'stale game discarded');
  g.status = 'won';
  ok(Core.deserialize(Core.serialize(g), 3) === null, 'finished game not restored');
  ok(Core.deserialize('{not json', 3) === null, 'garbage tolerated');
}

console.log(`\n${fail === 0 ? `ALL PASS (${pass}/${pass})` : `${fail} FAILURE(S) (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
