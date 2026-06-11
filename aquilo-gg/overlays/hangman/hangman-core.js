/*
 * Hangman core. Pure game logic, zero DOM, zero network.
 *
 * main.js drives this from Streamer.bot chat events; selftest.mjs
 * drives it from Node. Keep every rule in here so the selftest stays
 * the source of truth:
 *
 *   - words are uppercase A-Z plus spaces/hyphens; only letters are
 *     guessable, separators are pre-revealed
 *   - one player owns the game (the viewer who redeemed/commanded)
 *   - a bare single letter in chat is a letter guess
 *   - "!guess x" / "!g x" also guess a letter
 *   - "!solve some words" attempts the full answer
 *   - a bare single token with the same letter count as the answer is
 *     also a solve attempt (typing the word straight into chat)
 *   - wrong letters and wrong solves both cost one life
 *   - lives default 6: head, torso, arm, arm, leg, leg
 *   - running out of time loses the game
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HangmanCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOTAL_PARTS = 6;

  // ── words ──────────────────────────────────────────────────────────
  function normalizeWord(raw) {
    if (typeof raw !== 'string') return '';
    var w = raw.toUpperCase()
      .replace(/[‘’']/g, '')   // drop apostrophes: DON'T -> DONT
      .replace(/[\u2013\u2014_]/g, '-')  // any dash style -> hyphen
      .replace(/[^A-Z \-]/g, '')            // letters, space, hyphen only
      .replace(/\s+/g, ' ')
      .replace(/-+/g, '-')
      .trim()
      .replace(/^[\s\-]+|[\s\-]+$/g, '');
    return w;
  }

  function letterCount(word) {
    var n = 0;
    for (var i = 0; i < word.length; i++) {
      var c = word.charAt(i);
      if (c >= 'A' && c <= 'Z') n++;
    }
    return n;
  }

  function validWord(word) {
    return /^[A-Z][A-Z \-]*[A-Z]$/.test(word) && letterCount(word) >= 4;
  }

  // Pick a word: custom list first (always when customOnly), otherwise
  // from the selected built-in categories. rng is injectable for tests.
  function pickWord(opts) {
    opts = opts || {};
    var rng = opts.rng || Math.random;
    var bank = opts.bank || null; // HangmanWords-shaped {categories:{key:{label,words}}}
    var pool = [];

    var custom = (opts.customWords || [])
      .map(normalizeWord)
      .filter(validWord);
    for (var i = 0; i < custom.length; i++) {
      pool.push({ word: custom[i], category: opts.customLabel || 'Streamer pick' });
    }

    if ((!opts.customOnly || pool.length === 0) && bank) {
      var keys = (opts.categories && opts.categories.length)
        ? opts.categories.filter(function (k) { return bank.categories[k]; })
        : Object.keys(bank.categories);
      if (!keys.length) keys = Object.keys(bank.categories);
      keys.forEach(function (k) {
        var cat = bank.categories[k];
        cat.words.forEach(function (w) {
          var n = normalizeWord(w);
          if (validWord(n)) pool.push({ word: n, category: cat.label });
        });
      });
    }

    if (!pool.length) return null;
    var idx = Math.floor(rng() * pool.length);
    if (idx >= pool.length) idx = pool.length - 1;
    var avoid = opts.avoid || null; // do not repeat the previous word
    if (avoid && pool.length > 1 && pool[idx].word === avoid) {
      idx = (idx + 1) % pool.length;
    }
    return pool[idx];
  }

  // ── game state ─────────────────────────────────────────────────────
  function newGame(opts) {
    var word = normalizeWord(opts.word);
    if (!validWord(word)) return null;
    var lives = Math.max(3, Math.min(6, Math.floor(opts.lives || 6)));
    var now = opts.now != null ? opts.now : Date.now();
    var durationMs = Math.max(20, Math.min(600, Math.floor(opts.secs || 120))) * 1000;
    return {
      word: word,
      category: opts.category || '',
      player: {
        id: String(opts.player && opts.player.id || ''),
        login: String(opts.player && opts.player.login || ''),
        name: String(opts.player && opts.player.name || opts.player && opts.player.login || 'player')
      },
      lives: lives,
      wrong: [],          // wrong letters, in order
      hits: [],           // correct letters, in order
      solveMisses: 0,     // failed full-word attempts (cost a life each)
      status: 'playing',  // playing | won | lost
      loseReason: '',     // letters | solve | time
      startedAt: now,
      endsAt: now + durationMs,
      endedAt: 0
    };
  }

  function wrongCount(state) {
    return state.wrong.length + state.solveMisses;
  }

  function livesLeft(state) {
    return Math.max(0, state.lives - wrongCount(state));
  }

  // How many of the 6 figure parts to draw. Lives < 6 scale up so the
  // figure still completes exactly on the losing guess.
  function partsShown(state) {
    if (state.status === 'lost') return TOTAL_PARTS;
    var n = Math.round(wrongCount(state) * TOTAL_PARTS / state.lives);
    return Math.max(0, Math.min(TOTAL_PARTS, n));
  }

  function slots(state) {
    var out = [];
    for (var i = 0; i < state.word.length; i++) {
      var c = state.word.charAt(i);
      var isLetter = c >= 'A' && c <= 'Z';
      out.push({
        ch: c,
        gap: !isLetter,
        shown: !isLetter || state.hits.indexOf(c) >= 0 || state.status !== 'playing'
      });
    }
    return out;
  }

  function isRevealed(state) {
    for (var i = 0; i < state.word.length; i++) {
      var c = state.word.charAt(i);
      if (c >= 'A' && c <= 'Z' && state.hits.indexOf(c) < 0) return false;
    }
    return true;
  }

  function expire(state, now) {
    if (state.status !== 'playing') return null;
    if ((now != null ? now : Date.now()) < state.endsAt) return null;
    state.status = 'lost';
    state.loseReason = 'time';
    state.endedAt = state.endsAt;
    return { kind: 'lose', reason: 'time' };
  }

  function guessLetter(state, letter, now) {
    now = now != null ? now : Date.now();
    if (state.status !== 'playing') return { kind: 'over' };
    if (expire(state, now)) return { kind: 'lose', reason: 'time' };
    letter = String(letter || '').toUpperCase();
    if (!/^[A-Z]$/.test(letter)) return { kind: 'invalid' };
    if (state.hits.indexOf(letter) >= 0 || state.wrong.indexOf(letter) >= 0) {
      return { kind: 'dup', letter: letter };
    }
    if (state.word.indexOf(letter) >= 0) {
      state.hits.push(letter);
      if (isRevealed(state)) {
        state.status = 'won';
        state.endedAt = now;
        return { kind: 'win', letter: letter };
      }
      return { kind: 'hit', letter: letter };
    }
    state.wrong.push(letter);
    if (wrongCount(state) >= state.lives) {
      state.status = 'lost';
      state.loseReason = 'letters';
      state.endedAt = now;
      return { kind: 'lose', letter: letter, reason: 'letters' };
    }
    return { kind: 'miss', letter: letter };
  }

  function lettersOnly(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  }

  function guessWord(state, attempt, now) {
    now = now != null ? now : Date.now();
    if (state.status !== 'playing') return { kind: 'over' };
    if (expire(state, now)) return { kind: 'lose', reason: 'time' };
    var a = lettersOnly(attempt);
    if (a.length < 2) return { kind: 'invalid' };
    if (a === lettersOnly(state.word)) {
      // reveal everything
      for (var i = 0; i < state.word.length; i++) {
        var c = state.word.charAt(i);
        if (c >= 'A' && c <= 'Z' && state.hits.indexOf(c) < 0) state.hits.push(c);
      }
      state.status = 'won';
      state.endedAt = now;
      return { kind: 'solve-win' };
    }
    state.solveMisses++;
    if (wrongCount(state) >= state.lives) {
      state.status = 'lost';
      state.loseReason = 'solve';
      state.endedAt = now;
      return { kind: 'lose', reason: 'solve' };
    }
    return { kind: 'solve-miss' };
  }

  // ── chat parsing ───────────────────────────────────────────────────
  // Returns {type:'letter', letter} | {type:'solve', word} | null.
  // state is optional; bare-token solve attempts need the answer length.
  function parseChat(text, state) {
    var t = String(text || '').trim();
    if (!t) return null;

    var m = t.match(/^!(?:guess|g)\s+(.+)$/i);
    if (m) {
      var g = m[1].trim();
      if (/^[a-z]$/i.test(g)) return { type: 'letter', letter: g.toUpperCase() };
      if (lettersOnly(g).length >= 2) return { type: 'solve', word: g };
      return null;
    }

    m = t.match(/^!solve\s+(.+)$/i);
    if (m) return { type: 'solve', word: m[1].trim() };

    // bare single letter (allow trailing punctuation like "e?")
    var bare = t.replace(/[!?.,:;"']+$/g, '').trim();
    if (/^[a-z]$/i.test(bare)) return { type: 'letter', letter: bare.toUpperCase() };

    // bare single token that matches the answer's letter count = a solve
    // attempt (typing the word straight into chat). Multi-token chatter
    // is ignored so casual messages never cost a life.
    if (state && state.word && /^[a-z][a-z\-]*$/i.test(bare)) {
      if (lettersOnly(bare).length === letterCount(state.word) && lettersOnly(bare).length >= 2) {
        return { type: 'solve', word: bare };
      }
    }
    return null;
  }

  // ── persistence ────────────────────────────────────────────────────
  function serialize(state) {
    return JSON.stringify(state);
  }

  function deserialize(json, now) {
    var s;
    try { s = JSON.parse(json); } catch (e) { return null; }
    if (!s || typeof s !== 'object' || !s.word || s.status !== 'playing') return null;
    if (!validWord(normalizeWord(s.word))) return null;
    now = now != null ? now : Date.now();
    if (now >= s.endsAt) return null; // stale: would have expired anyway
    if (!Array.isArray(s.wrong) || !Array.isArray(s.hits)) return null;
    return s;
  }

  return {
    TOTAL_PARTS: TOTAL_PARTS,
    normalizeWord: normalizeWord,
    letterCount: letterCount,
    validWord: validWord,
    pickWord: pickWord,
    newGame: newGame,
    wrongCount: wrongCount,
    livesLeft: livesLeft,
    partsShown: partsShown,
    slots: slots,
    isRevealed: isRevealed,
    expire: expire,
    guessLetter: guessLetter,
    guessWord: guessWord,
    parseChat: parseChat,
    serialize: serialize,
    deserialize: deserialize
  };
});
