// Checkers (American / English draughts) adapter for the boardgames engine.
//
// Board: 8×8, dark squares only are playable. r=0 is white's back rank
// (top), r=7 is red's back rank (bottom). Red (p1) moves up (decreasing
// r); White (p2) moves down (increasing r). Red moves first.
//
// Square index: i = r * 8 + c. (r, c) in [0, 7].
// Dark square test: (r + c) % 2 === 1.
//
// Cell encoding in state.board[64]:
//   0 = empty
//   1 = red man
//   2 = red king
//   3 = white man
//   4 = white king
//
// Move shape sent by client:
//   { from: i, to: i }
//
// Rules implemented:
// - Diagonal-forward moves for men, any-diagonal for kings.
// - Single-square moves go one diagonal step.
// - Capture = jump over an adjacent enemy to the empty square beyond,
//   removing the captured piece.
// - **Mandatory captures**: if ANY of your pieces can capture, every
//   move you make must be a capture. Simple moves are rejected with
//   error 'must-capture'.
// - **Multi-jumps**: after a capture, if the same piece can capture
//   again, the turn DOES NOT flip, the server sets `pendingFrom` and
//   waits for the next jump from that square. A player may stop a
//   multi-jump only when no further capture is available. (UI tells
//   them this via the legalMoves hint.)
// - **Kinging**: a man that reaches its furthest rank becomes a king.
//   Per American rule, kinging ENDS the turn even if more jumps would
//   be available, kept here as it simplifies the multi-jump flow and
//   is the more common casual ruleset.
// - **Win**: opponent has no pieces, or has pieces but no legal moves.
// - **Draw**: 40 turns with no capture and no man-to-king (`movesSinceProgress`).

const ROWS = 8;
const COLS = 8;

const RED_MAN = 1, RED_KING = 2;
const WHITE_MAN = 3, WHITE_KING = 4;

function idx(r, c) { return r * COLS + c; }
function rc(i) { return [Math.floor(i / COLS), i % COLS]; }
function inBounds(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }
function isDark(r, c) { return ((r + c) & 1) === 1; }
function isRed(v) { return v === RED_MAN || v === RED_KING; }
function isWhite(v) { return v === WHITE_MAN || v === WHITE_KING; }
function isKing(v) { return v === RED_KING || v === WHITE_KING; }
function sideOf(v) {
  if (isRed(v)) return 'p1';
  if (isWhite(v)) return 'p2';
  return null;
}
function isEnemy(v, side) {
  if (v === 0) return false;
  return sideOf(v) !== side;
}

// Diagonal step directions per piece type. Men move only "forward" from
// their side's POV; kings move in all 4 diagonal directions.
function moveDirs(v) {
  if (v === RED_MAN)   return [[-1, -1], [-1, 1]];           // up
  if (v === WHITE_MAN) return [[ 1, -1], [ 1, 1]];           // down
  if (isKing(v))       return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  return [];
}

export const adapter = {
  initialState() {
    const board = new Array(ROWS * COLS).fill(0);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!isDark(r, c)) continue;
        if (r < 3) board[idx(r, c)] = WHITE_MAN;
        else if (r > 4) board[idx(r, c)] = RED_MAN;
      }
    }
    return {
      board,
      turn: 'p1',
      pendingFrom: null,
      movesSinceProgress: 0,
      winLine: null,
    };
  },

  sideToMove(state) { return state.turn; },

  isTerminal(state) {
    return hasWinner(state) !== null || drawByInactivity(state);
  },

  legalMoves(state, side) {
    // If side isn't specified, default to sideToMove.
    const me = side || state.turn;
    // If in a forced multi-jump, only jumps from pendingFrom count.
    if (state.pendingFrom !== null) {
      return jumpsFrom(state, state.pendingFrom);
    }
    const jumps = allJumps(state, me);
    if (jumps.length > 0) return jumps;
    return allSimpleMoves(state, me);
  },

  applyMove(state, side, move) {
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number') {
      return { ok: false, error: 'bad-move' };
    }
    if (state.turn !== side) return { ok: false, error: 'not-your-turn' };

    const from = move.from, to = move.to;
    const piece = state.board[from] || 0;
    if (!piece || sideOf(piece) !== side) {
      return { ok: false, error: 'not-your-piece' };
    }
    if (state.pendingFrom !== null && state.pendingFrom !== from) {
      return { ok: false, error: 'must-continue-jump' };
    }

    // Validate move against legal list.
    const legal = adapter.legalMoves(state, side);
    const found = legal.find(m => m.from === from && m.to === to);
    if (!found) {
      // Was the player trying to make a non-jump while a jump was
      // available? Surface a friendly error.
      const anyJump = state.pendingFrom !== null ? [] : allJumps(state, side);
      if (anyJump.length > 0 && !found) {
        return { ok: false, error: 'must-capture', message: 'You must take an available jump.' };
      }
      return { ok: false, error: 'illegal-move' };
    }

    const next = cloneState(state);
    next.board[to] = piece;
    next.board[from] = 0;

    let captured = false;
    if (found.capture !== undefined) {
      next.board[found.capture] = 0;
      captured = true;
    }

    // Kinging: red man on row 0, white man on row 7. Kinging stops a
    // multi-jump (American rule).
    const [tr] = rc(to);
    let kinged = false;
    if (piece === RED_MAN && tr === 0) {
      next.board[to] = RED_KING; kinged = true;
    } else if (piece === WHITE_MAN && tr === ROWS - 1) {
      next.board[to] = WHITE_KING; kinged = true;
    }

    // Multi-jump check: another capture available from `to`?
    if (captured && !kinged) {
      const more = jumpsFrom(next, to);
      if (more.length > 0) {
        next.pendingFrom = to;
        // Same player keeps the turn.
        return { ok: true, state: next };
      }
    }

    next.pendingFrom = null;
    next.turn = side === 'p1' ? 'p2' : 'p1';

    // Draw counter: bumps only when nothing "progressed". A capture or
    // a king-promotion resets it.
    if (captured || kinged) next.movesSinceProgress = 0;
    else next.movesSinceProgress = (state.movesSinceProgress || 0) + 1;

    const winner = hasWinner(next);
    if (winner) {
      return { ok: true, state: next, terminal: { winner, reason: 'opponent-stuck' } };
    }
    if (drawByInactivity(next)) {
      return { ok: true, state: next, terminal: { winner: 'draw', reason: '40-move-rule' } };
    }
    return { ok: true, state: next };
  },
};

function cloneState(s) {
  return {
    board: s.board.slice(),
    turn: s.turn,
    pendingFrom: s.pendingFrom,
    movesSinceProgress: s.movesSinceProgress || 0,
    winLine: null,
  };
}

// All jumps available from a specific square. Used by single-piece
// scans and the multi-jump continuation check.
function jumpsFrom(state, i) {
  const piece = state.board[i];
  if (!piece) return [];
  const side = sideOf(piece);
  const [r, c] = rc(i);
  const out = [];
  for (const [dr, dc] of moveDirs(piece)) {
    const er = r + dr, ec = c + dc;
    const lr = r + 2 * dr, lc = c + 2 * dc;
    if (!inBounds(lr, lc)) continue;
    const enemyI = idx(er, ec);
    const landI = idx(lr, lc);
    if (state.board[landI] !== 0) continue;
    if (!isEnemy(state.board[enemyI], side)) continue;
    out.push({ from: i, to: landI, capture: enemyI });
  }
  return out;
}

function allJumps(state, side) {
  const out = [];
  for (let i = 0; i < state.board.length; i++) {
    const v = state.board[i];
    if (!v || sideOf(v) !== side) continue;
    for (const m of jumpsFrom(state, i)) out.push(m);
  }
  return out;
}

function allSimpleMoves(state, side) {
  const out = [];
  for (let i = 0; i < state.board.length; i++) {
    const v = state.board[i];
    if (!v || sideOf(v) !== side) continue;
    const [r, c] = rc(i);
    for (const [dr, dc] of moveDirs(v)) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const ni = idx(nr, nc);
      if (state.board[ni] === 0) out.push({ from: i, to: ni });
    }
  }
  return out;
}

function hasWinner(state) {
  let redHas = false, whiteHas = false;
  let redCanMove = false, whiteCanMove = false;
  for (let i = 0; i < state.board.length; i++) {
    const v = state.board[i];
    if (isRed(v)) redHas = true;
    else if (isWhite(v)) whiteHas = true;
  }
  if (!redHas) return 'p2';
  if (!whiteHas) return 'p1';
  // Stuck-out check: the side whose turn it is has zero legal moves.
  const sideMoves = adapter.legalMoves(state, state.turn);
  if (sideMoves.length === 0) {
    return state.turn === 'p1' ? 'p2' : 'p1';
  }
  // Suppress unused-var warnings, kept for future use if we add early
  // exits.
  void redCanMove; void whiteCanMove;
  return null;
}

function drawByInactivity(state) {
  return (state.movesSinceProgress || 0) >= 40;
}
