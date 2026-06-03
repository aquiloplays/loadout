// AI opponents for the head-to-head board games (connect4, checkers,
// chess, tanks). Server-side only: when a human plays a vs-AI match the
// engine calls pickAiMove() after each human move and applies the
// chosen move through the same adapter the PvP path uses, so the AI can
// never make an illegal move and the rules stay single-source.
//
// Four difficulties, each a thematic persona surfaced in the lobby:
//   easy   "The Greenhorn"  blunders ~35% of the time, else 1-ply greedy
//   medium "The Regular"    shallow search, solid but not sharp
//   hard   "The Champion"   deeper search, knows the material math
//   insane "The Apex"       deepest search we allow (still beatable)
//
// The perfect-information games (connect4/checkers/chess) use a
// negamax + alpha-beta search over the adapter's own legalMoves/
// applyMove, with a per-game leaf evaluation. Multi-move turns (a
// checkers multi-jump keeps the same side to move) are handled by NOT
// negating when sideToMove doesn't flip. A node budget bounds worst
// case CPU so a pathological position can't blow the request timeout.
//
// Tanks is continuous (angle + power), so instead of enumerating it
// samples a difficulty-scaled grid of shots, simulates each through the
// adapter, and scores by (opponent damage - self damage), picking the
// best (with difficulty-tuned slop so lower tiers miss).

const WIN_SCORE = 1_000_000;

// Search depth (plies) per game x difficulty. Easy is handled specially
// (random blunder / 1-ply) so its depth here is just the fallback.
const DEPTH = {
  connect4: { easy: 1, medium: 4, hard: 6, insane: 8 },
  checkers: { easy: 1, medium: 4, hard: 6, insane: 8 },
  chess:    { easy: 1, medium: 2, hard: 3, insane: 4 },
};

const NODE_BUDGET = { connect4: 60_000, checkers: 60_000, chess: 40_000 };

export const AI_PERSONAS = {
  easy:   { name: 'The Greenhorn', blurb: 'Still learning the ropes' },
  medium: { name: 'The Regular',   blurb: 'Plays a solid game' },
  hard:   { name: 'The Champion',  blurb: 'Knows the math' },
  insane: { name: 'The Apex',      blurb: 'Near-optimal, but beatable' },
};

export function isValidDifficulty(d) {
  return d === 'easy' || d === 'medium' || d === 'hard' || d === 'insane';
}

/**
 * Pick a move for `side` to play in `state`. Returns a move object the
 * adapter accepts, or null if there are no legal moves.
 *   adapter    the per-game adapter (from boardgames-engine.getAdapter)
 *   game       the game slug (selects the evaluator)
 *   state      current match state (AI is the side to move)
 *   side       'p1' | 'p2'  (which side the AI plays)
 *   difficulty 'easy' | 'medium' | 'hard' | 'insane'
 */
export function pickAiMove(adapter, game, state, side, difficulty) {
  if (game === 'tanks') return pickTanksMove(adapter, state, side, difficulty);

  const moves = adapter.legalMoves(state, side) || [];
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  // Greenhorn throws away ~35% of its moves with a random pick.
  if (difficulty === 'easy' && Math.random() < 0.35) {
    return moves[(Math.random() * moves.length) | 0];
  }

  const depth = (DEPTH[game] && DEPTH[game][difficulty]) || 2;
  const evalFn = EVALS[game];
  const budget = { n: 0, max: NODE_BUDGET[game] || 40_000 };
  return searchRoot(adapter, game, state, side, depth, evalFn, budget);
}

// ── Negamax + alpha-beta ─────────────────────────────────────────────

function searchRoot(adapter, game, state, side, depth, evalFn, budget) {
  const moves = orderMoves(game, state, adapter.legalMoves(state, side) || []);
  let best = -Infinity;
  let bestMoves = [];
  let alpha = -Infinity;
  const beta = Infinity;
  for (const mv of moves) {
    const res = adapter.applyMove(state, side, mv);
    if (!res.ok) continue;
    let score;
    if (res.terminal) {
      score = terminalScore(res.terminal, side, depth);
    } else {
      const ns = adapter.sideToMove(res.state);
      score = ns === side
        ? negamax(adapter, game, res.state, side, depth - 1, alpha, beta, evalFn, budget)
        : -negamax(adapter, game, res.state, ns, depth - 1, -beta, -alpha, evalFn, budget);
    }
    if (score > best) { best = score; bestMoves = [mv]; }
    else if (score === best) bestMoves.push(mv);
    if (best > alpha) alpha = best;
  }
  if (bestMoves.length === 0) return moves[0];
  // Random tie-break gives the AI natural variety across games.
  return bestMoves[(Math.random() * bestMoves.length) | 0];
}

function negamax(adapter, game, state, side, depth, alpha, beta, evalFn, budget) {
  budget.n++;
  if (budget.n > budget.max) return evalFn(state, side);
  if (depth <= 0) return evalFn(state, side);
  const moves = adapter.legalMoves(state, side) || [];
  if (moves.length === 0) return evalFn(state, side);

  let best = -Infinity;
  for (const mv of orderMoves(game, state, moves)) {
    const res = adapter.applyMove(state, side, mv);
    if (!res.ok) continue;
    let score;
    if (res.terminal) {
      score = terminalScore(res.terminal, side, depth);
    } else {
      const ns = adapter.sideToMove(res.state);
      score = ns === side
        ? negamax(adapter, game, res.state, side, depth - 1, alpha, beta, evalFn, budget)
        : -negamax(adapter, game, res.state, ns, depth - 1, -beta, -alpha, evalFn, budget);
    }
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// Terminal node value from `side`'s perspective. Prefer faster wins /
// slower losses by folding the remaining depth into the magnitude.
function terminalScore(terminal, side, depth) {
  if (terminal.winner === 'draw') return 0;
  if (terminal.winner === side) return WIN_SCORE + depth;
  return -WIN_SCORE - depth;
}

// Cheap move ordering to make alpha-beta bite: center-first (connect4),
// captures-first (chess). Checkers forced-captures are already the only
// legal moves when a capture exists, so no ordering needed.
function orderMoves(game, state, moves) {
  if (game === 'connect4') {
    return [...moves].sort((a, b) => Math.abs(3 - a.col) - Math.abs(3 - b.col));
  }
  if (game === 'chess') {
    return [...moves].sort((a, b) => captureRank(b) - captureRank(a));
  }
  return moves;
}
function captureRank(mv) {
  if (mv.kind === 'capture' || mv.kind === 'ep') return 2;
  if (mv.kind === 'promote') return 3;
  return 0;
}

// ── Evaluators (leaf score, positive = good for `side`) ──────────────

const EVALS = {
  connect4: evalConnect4,
  checkers: evalCheckers,
  chess: evalChess,
};

function evalConnect4(state, side) {
  const ROWS = 6, COLS = 7;
  const me = side === 'p1' ? 1 : 2;
  const opp = me === 1 ? 2 : 1;
  const at = (c, r) => state.cols[c][r] || 0;   // r=0 bottom
  let score = 0;
  // Center column control.
  for (let r = 0; r < ROWS; r++) {
    if (at(3, r) === me) score += 6;
    else if (at(3, r) === opp) score -= 6;
  }
  const windows = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (c + 3 < COLS) windows.push([[c, r], [c + 1, r], [c + 2, r], [c + 3, r]]);
      if (r + 3 < ROWS) windows.push([[c, r], [c, r + 1], [c, r + 2], [c, r + 3]]);
      if (c + 3 < COLS && r + 3 < ROWS) windows.push([[c, r], [c + 1, r + 1], [c + 2, r + 2], [c + 3, r + 3]]);
      if (c + 3 < COLS && r - 3 >= 0) windows.push([[c, r], [c + 1, r - 1], [c + 2, r - 2], [c + 3, r - 3]]);
    }
  }
  for (const w of windows) {
    let mine = 0, theirs = 0;
    for (const [c, r] of w) {
      const v = at(c, r);
      if (v === me) mine++;
      else if (v === opp) theirs++;
    }
    if (mine && theirs) continue;
    if (mine === 3) score += 50;
    else if (mine === 2) score += 8;
    else if (mine === 1) score += 1;
    if (theirs === 3) score -= 65;   // value blocking a touch higher
    else if (theirs === 2) score -= 8;
    else if (theirs === 1) score -= 1;
  }
  return score;
}

function evalCheckers(state, side) {
  // 1 red man, 2 red king, 3 white man, 4 white king. p1=red, p2=white.
  let red = 0, white = 0;
  const b = state.board;
  for (let i = 0; i < 64; i++) {
    const v = b[i];
    if (!v) continue;
    const r = (i / 8) | 0;
    if (v === 1) red += 100 + (7 - r) * 4;          // red advances toward r=0
    else if (v === 2) red += 175 + centerBonus(i);
    else if (v === 3) white += 100 + r * 4;         // white advances toward r=7
    else if (v === 4) white += 175 + centerBonus(i);
  }
  return side === 'p1' ? red - white : white - red;
}
function centerBonus(i) {
  const c = i % 8;
  return (c >= 2 && c <= 5) ? 6 : 0;
}

const PIECE_VAL = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 0 };
function evalChess(state, side) {
  // +P..+K white (p1), -.. black (p2). Material + light centrality.
  const b = state.board;
  let white = 0, black = 0;
  for (let i = 0; i < 64; i++) {
    const v = b[i];
    if (!v) continue;
    const t = Math.abs(v);
    const r = (i / 8) | 0, c = i % 8;
    // Centrality: closer to the middle of the board is worth a touch.
    const central = (3.5 - Math.abs(3.5 - r)) + (3.5 - Math.abs(3.5 - c));
    const pos = PIECE_VAL[t] + (t >= 2 && t <= 3 ? central * 3 : central);
    if (v > 0) white += pos;
    else black += pos;
  }
  return side === 'p1' ? white - black : black - white;
}

// ── Tanks (continuous artillery) ─────────────────────────────────────

const TANK_GRID = {
  easy:   { aStep: 20, pStep: 30, slop: 'random' },
  medium: { aStep: 10, pStep: 15, slop: 'top30' },
  hard:   { aStep: 6,  pStep: 8,  slop: 'top3' },
  insane: { aStep: 4,  pStep: 6,  slop: 'best' },
};

function pickTanksMove(adapter, state, side, difficulty) {
  const cfg = TANK_GRID[difficulty] || TANK_GRID.medium;
  const myIdx = side === 'p1' ? 0 : 1;
  const oppIdx = myIdx === 0 ? 1 : 0;
  const oppX = state.tanks[oppIdx].x;
  const scored = [];
  for (let angle = 10; angle <= 170; angle += cfg.aStep) {
    for (let power = 30; power <= 100; power += cfg.pStep) {
      const res = adapter.applyMove(state, side, { angle, power });
      if (!res.ok) continue;
      const shot = res.state.lastShot;
      const dmg = (shot && shot.damages) || [{ amount: 0 }, { amount: 0 }];
      const oppDmg = dmg[oppIdx].amount || 0;
      const selfDmg = dmg[myIdx].amount || 0;
      let s = oppDmg - selfDmg * 2;
      // Proximity tiebreak: when no shot lands damage (common on the
      // opening turn before terrain opens up), prefer the one that
      // impacts nearest the enemy so the AI walks its fire toward them.
      // Tiny weight so any actual damage dominates.
      const impactX = shot && shot.impact && typeof shot.impact.x === 'number' ? shot.impact.x : null;
      if (impactX != null) s -= Math.abs(impactX - oppX) * 0.05;
      if (res.terminal) {
        if (res.terminal.winner === side) s += 5000;
        else s -= 5000;   // self-destruct / mutual: avoid
      }
      scored.push({ angle, power, s });
    }
  }
  if (scored.length === 0) return { angle: 45, power: 60 };
  scored.sort((a, b) => b.s - a.s);

  let pick;
  if (cfg.slop === 'best') {
    pick = scored[0];
  } else if (cfg.slop === 'top3') {
    pick = scored[(Math.random() * Math.min(3, scored.length)) | 0];
  } else if (cfg.slop === 'top30') {
    const k = Math.max(1, Math.floor(scored.length * 0.3));
    pick = scored[(Math.random() * k) | 0];
  } else {
    // Greenhorn: 45% pure-random shot, else a mediocre middling one.
    if (Math.random() < 0.45) {
      pick = scored[(Math.random() * scored.length) | 0];
    } else {
      const k = Math.max(1, Math.floor(scored.length * 0.6));
      pick = scored[Math.min(scored.length - 1, ((scored.length - k) + (Math.random() * k)) | 0)];
    }
  }
  // A little aim jitter on the lower tiers so they don't repeat a line.
  if (cfg.slop !== 'best') {
    const jitterA = cfg.slop === 'top3' ? 1 : 4;
    pick = {
      angle: clamp(pick.angle + ((Math.random() * 2 - 1) * jitterA) | 0, 1, 179),
      power: clamp(pick.power + ((Math.random() * 2 - 1) * jitterA) | 0, 10, 100),
    };
  }
  return { angle: pick.angle, power: pick.power };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
