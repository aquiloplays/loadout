// Hangman, the in-panel co-op word game backend for the Aquilo Twitch
// extension. One SHARED board per channel: a mod starts a round, then ANY
// viewer of that channel guesses letters or solves the whole word, and the
// lives are shared across the whole chat. The answer is masked server-side so
// it never reaches the client until the round ends.
//
// Multi-tenant: `guildId` and `userId` are ALREADY resolved by the caller —
// guildId is the per-channel namespace, userId is `tw:<id>`. We use them
// verbatim and NEVER re-derive. The game state lives at `hangman:${guildId}`
// so every channel gets its own independent board automatically.
//
// Routes (all under /ext/hangman/):
//   GET  /ext/hangman/state           -> public board (see stateView)
//   POST /ext/hangman/start  {name}   -> board | {error:'forbidden'} | {error:'active'}
//   POST /ext/hangman/guess  {letter,name} -> board | {error:'no-round'} | {already:true} | 429
//   POST /ext/hangman/solve  {word,name}   -> board | {error:'no-round'} | 429
//   POST /ext/hangman/cancel {name}   -> idle board | {error:'forbidden'}
//
// No Bolts are awarded — the panel's Hangman card surfaces no wallet/reward,
// so this backend intentionally does not touch the economy.

// ── local JSON helper (CORS + no-store) ──────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

const MAX_LIVES = 6;

// Built-in word bank — streaming / gaming themed nouns, 4–9 letters, no
// spaces or repeats that would confuse the masked display. { word, category }.
const WORDS = [
  { w: 'STREAM', c: 'Streaming' },
  { w: 'OVERLAY', c: 'Streaming' },
  { w: 'CHANNEL', c: 'Streaming' },
  { w: 'EMOTE', c: 'Streaming' },
  { w: 'RAID', c: 'Streaming' },
  { w: 'CLIP', c: 'Streaming' },
  { w: 'FOLLOW', c: 'Streaming' },
  { w: 'CHAT', c: 'Streaming' },
  { w: 'DONATE', c: 'Streaming' },
  { w: 'VIEWER', c: 'Streaming' },
  { w: 'BITS', c: 'Streaming' },
  { w: 'MARKER', c: 'Streaming' },
  { w: 'WEBCAM', c: 'Streaming' },
  { w: 'MICPHONE', c: 'Streaming' },
  { w: 'AVATAR', c: 'Gaming' },
  { w: 'BOSS', c: 'Gaming' },
  { w: 'QUEST', c: 'Gaming' },
  { w: 'LOOT', c: 'Gaming' },
  { w: 'SHIELD', c: 'Gaming' },
  { w: 'SWORD', c: 'Gaming' },
  { w: 'POTION', c: 'Gaming' },
  { w: 'WIZARD', c: 'Gaming' },
  { w: 'DRAGON', c: 'Gaming' },
  { w: 'GOBLIN', c: 'Gaming' },
  { w: 'CASTLE', c: 'Gaming' },
  { w: 'ARCADE', c: 'Gaming' },
  { w: 'PIXEL', c: 'Gaming' },
  { w: 'RESPAWN', c: 'Gaming' },
  { w: 'COMBO', c: 'Gaming' },
  { w: 'TROPHY', c: 'Gaming' },
  { w: 'JOYSTICK', c: 'Gaming' },
  { w: 'CONTROL', c: 'Gaming' },
  { w: 'PLATFORM', c: 'Gaming' },
  { w: 'CHECKPNT', c: 'Gaming' },
  { w: 'DUNGEON', c: 'Gaming' },
];

const key = (guildId) => `hangman:${guildId}`;
const cdKey = (guildId, userId) => `hangcd:${guildId}:${userId}`;

// Light anti-spam so one viewer can't machine-gun the shared board. Stored
// value is Date.now(); KV floors expirationTtl at 60s but the timestamp
// enforces the real ~1s window.
const COOLDOWN_MS = 1000;
const COOLDOWN_TTL = 60;

// True when this viewer is still inside their per-channel cooldown window.
async function cooling(env, guildId, userId) {
  try {
    const k = cdKey(guildId, userId);
    const last = parseInt((await env.LOADOUT_BOLTS.get(k)) || '0', 10);
    const now = Date.now();
    if (last && now - last < COOLDOWN_MS) return true;
    await env.LOADOUT_BOLTS.put(k, String(now), { expirationTtl: COOLDOWN_TTL });
    return false;
  } catch {
    // Best-effort — never block a guess because the cooldown store hiccuped.
    return false;
  }
}

async function loadGame(env, guildId) {
  try {
    return await env.LOADOUT_BOLTS.get(key(guildId), { type: 'json' });
  } catch {
    return null;
  }
}

async function saveGame(env, guildId, game) {
  await env.LOADOUT_BOLTS.put(key(guildId), JSON.stringify(game));
}

const cleanName = (n) => {
  const s = (n || '').toString().trim().slice(0, 40);
  return s || 'Someone';
};

// Unique A–Z letters that make up the answer.
function lettersOf(word) {
  const set = [];
  for (const ch of word) if (set.indexOf(ch) < 0) set.push(ch);
  return set;
}

// Build the masked string a client is allowed to see: revealed letters where
// guessed, underscores everywhere else. (Panel spaces the slots via CSS.)
function maskWord(word, guessed) {
  let out = '';
  for (const ch of word) out += guessed.indexOf(ch) >= 0 ? ch : '_';
  return out;
}

// The ONLY shape sent to clients. The answer is included solely when the round
// has ended (won/lost) — never while it is still 'active'.
function stateView(game) {
  if (!game || game.status === 'idle') {
    return {
      status: 'idle',
      masked: '',
      length: 0,
      category: '',
      guessed: [],
      wrong: [],
      wrongSolves: 0,
      lives: MAX_LIVES,
      maxLives: MAX_LIVES,
      startedBy: '',
      startedAt: 0,
      lastGuess: null,
    };
  }
  const wrong = game.wrong || [];
  const wrongSolves = game.wrongSolves || 0;
  const guessed = game.guessed || [];
  const ended = game.status === 'won' || game.status === 'lost';
  const view = {
    status: game.status,
    masked: maskWord(game.word, guessed),
    length: game.word.length,
    category: game.category || '',
    guessed,
    wrong,
    wrongSolves,
    lives: Math.max(0, (game.maxLives || MAX_LIVES) - wrong.length - wrongSolves),
    maxLives: game.maxLives || MAX_LIVES,
    startedBy: game.startedBy || '',
    startedAt: game.startedAt || 0,
    lastGuess: game.lastGuess || null,
  };
  if (ended) {
    view.word = game.word;
    if (game.status === 'won') view.solvedBy = game.solvedBy || '';
  }
  return view;
}

// Recompute win/loss after a guess/solve mutates the game in place.
function settle(game) {
  const answer = lettersOf(game.word);
  const solved = answer.every((ch) => game.guessed.indexOf(ch) >= 0);
  if (solved) {
    game.status = 'won';
  } else if ((game.wrong.length + (game.wrongSolves || 0)) >= game.maxLives) {
    game.status = 'lost';
  }
}

// ── actions ──────────────────────────────────────────────────────────

function startRound(env, guildId, game, meta, name) {
  if (!meta.isClay) {
    return json({ error: 'forbidden', message: 'Mods only.' }, 403);
  }
  if (game && game.status === 'active') {
    return json({ error: 'active', message: 'A round is already running.' }, 409);
  }
  const pick = WORDS[Math.floor(Math.random() * WORDS.length)];
  const next = {
    status: 'active',
    word: pick.w,
    category: pick.c,
    guessed: [],
    wrong: [],
    wrongSolves: 0,
    maxLives: MAX_LIVES,
    startedBy: name,
    startedAt: Date.now(),
    lastGuess: null,
    solvedBy: '',
  };
  return saveGame(env, guildId, next).then(() => json(stateView(next)));
}

async function guessLetter(env, guildId, userId, game, body, name) {
  if (!game || game.status !== 'active') {
    return json({ error: 'no-round', message: 'No round is running right now.' }, 200);
  }
  const raw = (body.letter || '').toString().trim().toUpperCase();
  if (!/^[A-Z]$/.test(raw)) {
    return json({ error: 'bad-letter', message: 'Guess a single letter.', ...stateView(game) }, 200);
  }
  // Already tried? Soft-reject with the current board so the UI stays put.
  if (game.guessed.indexOf(raw) >= 0 || game.wrong.indexOf(raw) >= 0) {
    return json({ already: true, ...stateView(game) }, 200);
  }
  // Cooldown AFTER the cheap validations so a repeat/typo doesn't burn it.
  if (await cooling(env, guildId, userId)) {
    return json({ message: 'Slow down a sec.', ...stateView(game) }, 429);
  }
  const hit = game.word.indexOf(raw) >= 0;
  if (hit) game.guessed.push(raw);
  else game.wrong.push(raw);
  game.lastGuess = { ts: Date.now(), by: name, letter: raw, solve: false, hit };
  settle(game);
  await saveGame(env, guildId, game);
  return json(stateView(game));
}

async function solveWord(env, guildId, userId, game, body, name) {
  if (!game || game.status !== 'active') {
    return json({ error: 'no-round', message: 'No round is running right now.' }, 200);
  }
  const guess = (body.word || '').toString().trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!guess) {
    return json({ error: 'bad-word', message: 'Type a word first.', ...stateView(game) }, 200);
  }
  if (await cooling(env, guildId, userId)) {
    return json({ message: 'Slow down a sec.', ...stateView(game) }, 429);
  }
  const hit = guess === game.word;
  if (hit) {
    // Reveal every letter and mark the winner.
    game.guessed = lettersOf(game.word);
    game.solvedBy = name;
  } else {
    // A blown solve costs a shared life (tracked apart from missed letters so
    // the panel's "Missed:" row stays letters-only).
    game.wrongSolves = (game.wrongSolves || 0) + 1;
  }
  game.lastGuess = { ts: Date.now(), by: name, letter: null, solve: true, hit };
  settle(game);
  await saveGame(env, guildId, game);
  return json(stateView(game));
}

function cancelRound(env, guildId, meta) {
  if (!meta.isClay) {
    return json({ error: 'forbidden', message: 'Mods only.' }, 403);
  }
  const idle = { status: 'idle' };
  return saveGame(env, guildId, idle).then(() => json(stateView(idle)));
}

// ── entry point ──────────────────────────────────────────────────────
// sub: the action after /ext/hangman/ ('state'|'start'|'guess'|'solve'|
// 'cancel'). meta = { twId, name, isClay }.
export async function handleHangman(env, guildId, userId, sub, req, meta) {
  meta = meta || {};

  if (req && req.method === 'OPTIONS') return json({}, 204);

  // Read-only shared board.
  if (sub === 'state') {
    return json(stateView(await loadGame(env, guildId)));
  }

  const body = await req.json().catch(() => ({}));
  const name = cleanName(body.name || meta.name);
  const game = await loadGame(env, guildId);

  switch (sub) {
    case 'start':
      return startRound(env, guildId, game, meta, name);
    case 'guess':
      return guessLetter(env, guildId, userId, game, body, name);
    case 'solve':
      return solveWord(env, guildId, userId, game, body, name);
    case 'cancel':
      return cancelRound(env, guildId, meta);
    default:
      return json({ error: 'not-found' }, 404);
  }
}
