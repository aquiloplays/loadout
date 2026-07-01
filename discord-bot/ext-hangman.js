// Co-op Hangman for the Twitch panel extension (/ext/hangman/*).
//
// One shared round per channel (Clay only — single-tenant like the rest
// of ext.js). The broadcaster or a mod starts a round; ANY panel viewer
// guesses letters or tries to solve the whole word. Lives are shared, so
// the whole chat is playing one board together. Twitch CHAT just narrates
// the milestones (start / win / loss) via Helix Send Chat Message — the
// game itself lives in the panel.
//
// State: KV LOADOUT_BOLTS `hangman:<guildId>:round` — a single round,
// TTL-expired so a forgotten round self-cleans. The answer is NEVER sent
// to the client while the round is active (masked server-side) so viewers
// can't read it from the network tab.
//
// Routes (sub-path after /ext/hangman/):
//   GET  state          → current board (masked, wrong letters, lives, status)
//   POST start          → broadcaster/mod only: new round (announces in chat)
//   POST guess {letter} → any viewer: guess one A–Z letter
//   POST solve {word}   → any viewer: attempt the whole word
//   POST cancel         → broadcaster/mod only: end the round

import { json, debounced } from './ext-shared.js';
import { sendChatMessage } from './twitch-helix.js';

const ROUND_KEY = (g) => `hangman:${g}:round`;
const ROUND_TTL_S = 60 * 60; // a forgotten round self-cleans after 1h
const MAX_LIVES = 6;

// PG word bank — single words, A–Z only (keeps masking clean).
const WORDS = [
  { w: 'PIXEL', c: 'Gaming' }, { w: 'RESPAWN', c: 'Gaming' }, { w: 'CHECKPOINT', c: 'Gaming' },
  { w: 'SPEEDRUN', c: 'Gaming' }, { w: 'INVENTORY', c: 'Gaming' }, { w: 'BOSSFIGHT', c: 'Gaming' },
  { w: 'CONTROLLER', c: 'Gaming' }, { w: 'COOLDOWN', c: 'Gaming' }, { w: 'LOADOUT', c: 'Gaming' },
  { w: 'PENGUIN', c: 'Animals' }, { w: 'DOLPHIN', c: 'Animals' }, { w: 'OCTOPUS', c: 'Animals' },
  { w: 'ELEPHANT', c: 'Animals' }, { w: 'HEDGEHOG', c: 'Animals' }, { w: 'FLAMINGO', c: 'Animals' },
  { w: 'CHEETAH', c: 'Animals' }, { w: 'RACCOON', c: 'Animals' }, { w: 'PLATYPUS', c: 'Animals' },
  { w: 'BURRITO', c: 'Food' }, { w: 'PANCAKE', c: 'Food' }, { w: 'SPAGHETTI', c: 'Food' },
  { w: 'AVOCADO', c: 'Food' }, { w: 'PRETZEL', c: 'Food' }, { w: 'CROISSANT', c: 'Food' },
  { w: 'DUMPLING', c: 'Food' }, { w: 'WATERMELON', c: 'Food' }, { w: 'CINNAMON', c: 'Food' },
  { w: 'GALAXY', c: 'Space' }, { w: 'NEBULA', c: 'Space' }, { w: 'ASTEROID', c: 'Space' },
  { w: 'TELESCOPE', c: 'Space' }, { w: 'GRAVITY', c: 'Space' }, { w: 'SATELLITE', c: 'Space' },
  { w: 'ECLIPSE', c: 'Space' }, { w: 'METEOR', c: 'Space' }, { w: 'ORBIT', c: 'Space' },
  { w: 'VOLCANO', c: 'Nature' }, { w: 'GLACIER', c: 'Nature' }, { w: 'WATERFALL', c: 'Nature' },
  { w: 'THUNDER', c: 'Nature' }, { w: 'RAINBOW', c: 'Nature' }, { w: 'CANYON', c: 'Nature' },
  { w: 'KEYBOARD', c: 'Tech' }, { w: 'FIREWALL', c: 'Tech' }, { w: 'BANDWIDTH', c: 'Tech' },
  { w: 'ALGORITHM', c: 'Tech' }, { w: 'DATABASE', c: 'Tech' }, { w: 'PROCESSOR', c: 'Tech' },
  { w: 'GUITAR', c: 'Music' }, { w: 'TRUMPET', c: 'Music' }, { w: 'MELODY', c: 'Music' },
  { w: 'DRUMMER', c: 'Music' }, { w: 'SYNTHESIZER', c: 'Music' }, { w: 'HARMONY', c: 'Music' },
];

const pickWord = () => WORDS[Math.floor(Math.random() * WORDS.length)];
const shortId = () => Math.random().toString(36).slice(2, 8);

function maskWord(word, guessed) {
  let out = '';
  for (const ch of word) {
    if (ch === ' ') out += ' ';
    else out += guessed.indexOf(ch) >= 0 ? ch : '_';
  }
  return out;
}

function isSolved(word, guessed) {
  for (const ch of word) {
    if (ch !== ' ' && guessed.indexOf(ch) < 0) return false;
  }
  return true;
}

function uniqueLetters(word) {
  const out = [];
  for (const ch of word) if (ch !== ' ' && out.indexOf(ch) < 0) out.push(ch);
  return out;
}

const cleanName = (s) => String(s || '').replace(/[^\w \-]/g, '').trim().slice(0, 25);

const livesLeft = (round) =>
  Math.max(0, MAX_LIVES - (round.wrong ? round.wrong.length : 0) - (round.solveMisses || 0));

// Client view — NEVER includes `word` while the round is active.
function view(round) {
  if (!round) return { active: false, status: 'idle' };
  const v = {
    active: round.status === 'active',
    id: round.id,
    status: round.status, // active | won | lost
    category: round.category || '',
    masked: maskWord(round.word, round.guessed || []),
    guessed: round.guessed || [],
    wrong: round.wrong || [],
    lives: livesLeft(round),
    maxLives: MAX_LIVES,
    length: round.word.replace(/ /g, '').length,
    startedBy: round.startedBy || '',
    lastGuess: round.lastGuess || null,
    solvedBy: round.solvedBy || null,
  };
  if (round.status !== 'active') v.word = round.word; // reveal only once ended
  return v;
}

// Chat announcements are best-effort (fire-and-forget via waitUntil). If
// the broadcaster token lacks user:write:chat the send no-ops silently.
function announce(env, ctx, text) {
  try {
    const p = sendChatMessage(env, text);
    if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.resolve(p).catch(() => {}));
  } catch { /* best-effort */ }
}

export async function handleExtHangman(env, ctx, guildId, userId, payload, sub, req) {
  const role = String((payload && payload.role) || 'viewer');
  const isMod = role === 'broadcaster' || role === 'moderator';
  const key = ROUND_KEY(guildId);

  if (req.method === 'GET' && sub === 'state') {
    const round = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    return json(view(round));
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { body = {}; }
  }

  if (req.method === 'POST' && sub === 'start') {
    if (!isMod) return json({ error: 'forbidden', message: 'Only the streamer or a mod can start Hangman.' }, 403);
    const existing = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (existing && existing.status === 'active') {
      return json({ error: 'active', message: 'A round is already running.', ...view(existing) }, 409);
    }
    const pick = pickWord();
    const round = {
      id: shortId(),
      word: pick.w.toUpperCase(),
      category: pick.c,
      guessed: [],
      wrong: [],
      solveMisses: 0,
      status: 'active',
      startedBy: cleanName(body.name) || (role === 'broadcaster' ? 'The streamer' : 'A mod'),
      startedAt: Date.now(),
      endedAt: null,
      lastGuess: null,
      solvedBy: null,
    };
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(round), { expirationTtl: ROUND_TTL_S });
    announce(env, ctx, `🎮 Hangman is live! Category: ${pick.c} — ${round.word.replace(/ /g, '').length} letters. Guess a letter in the panel below 👇`);
    return json(view(round));
  }

  if (req.method === 'POST' && sub === 'guess') {
    const round = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (!round || round.status !== 'active') return json({ error: 'no-round', message: 'No Hangman round is running.' }, 409);
    const letter = String(body.letter || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1);
    if (!letter) return json({ error: 'bad-letter', message: 'Guess a single A–Z letter.' }, 400);
    if (await debounced(env, 'hang-guess', guildId, userId)) {
      return json({ error: 'slow-down', message: 'One guess every few seconds.', ...view(round) }, 429);
    }
    if (round.guessed.indexOf(letter) >= 0 || round.wrong.indexOf(letter) >= 0) {
      return json({ already: true, ...view(round) });
    }
    const who = cleanName(body.name) || 'Someone';
    const hit = round.word.indexOf(letter) >= 0;
    if (hit) round.guessed.push(letter);
    else round.wrong.push(letter);
    round.lastGuess = { by: who, letter, hit, ts: Date.now() };
    let win = false, lost = false;
    if (hit && isSolved(round.word, round.guessed)) {
      round.status = 'won'; round.endedAt = Date.now(); round.solvedBy = who; win = true;
    } else if (!hit && (round.wrong.length + (round.solveMisses || 0)) >= MAX_LIVES) {
      round.status = 'lost'; round.endedAt = Date.now(); lost = true;
    }
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(round), { expirationTtl: ROUND_TTL_S });
    if (win) announce(env, ctx, `🎉 Solved! The word was ${round.word} — nice one, ${who}! GG all.`);
    if (lost) announce(env, ctx, `💀 Out of lives! The word was ${round.word}. Better luck next round.`);
    return json({ hit, win, lost, ...view(round) });
  }

  if (req.method === 'POST' && sub === 'solve') {
    const round = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (!round || round.status !== 'active') return json({ error: 'no-round' }, 409);
    if (await debounced(env, 'hang-solve', guildId, userId)) {
      return json({ error: 'slow-down', message: 'One try every few seconds.', ...view(round) }, 429);
    }
    const attempt = String(body.word || '').toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
    if (!attempt) return json({ error: 'bad-word', message: 'Type the full word.' }, 400);
    const who = cleanName(body.name) || 'Someone';
    if (attempt === round.word) {
      round.guessed = uniqueLetters(round.word);
      round.status = 'won'; round.endedAt = Date.now(); round.solvedBy = who;
      round.lastGuess = { by: who, letter: null, hit: true, solve: true, ts: Date.now() };
      await env.LOADOUT_BOLTS.put(key, JSON.stringify(round), { expirationTtl: ROUND_TTL_S });
      announce(env, ctx, `🎉 ${who} solved it: ${round.word}! GG.`);
      return json({ win: true, ...view(round) });
    }
    round.solveMisses = (round.solveMisses || 0) + 1;
    round.lastGuess = { by: who, letter: null, hit: false, solve: true, ts: Date.now() };
    const lost = (round.wrong.length + round.solveMisses) >= MAX_LIVES;
    if (lost) { round.status = 'lost'; round.endedAt = Date.now(); }
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(round), { expirationTtl: ROUND_TTL_S });
    if (lost) announce(env, ctx, `💀 Out of lives! The word was ${round.word}. Better luck next round.`);
    return json({ win: false, wrongSolve: true, lost, ...view(round) });
  }

  if (req.method === 'POST' && sub === 'cancel') {
    if (!isMod) return json({ error: 'forbidden' }, 403);
    await env.LOADOUT_BOLTS.delete(key);
    return json({ ok: true, active: false, status: 'idle' });
  }

  return json({ error: 'not-found' }, 404);
}
