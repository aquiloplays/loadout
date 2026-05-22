// Chess adapter for the boardgames engine.
//
// Standard rules: legal-move generation per piece, castling (both
// sides), en passant, promotion (auto-queen if not specified),
// check/checkmate/stalemate detection, 50-move rule, insufficient
// material (KvK, KBvK, KNvK, KBvKB-same-color).
//
// Board layout (matches the visual when white is at the bottom):
//   r=0 = rank 8 (black's back rank, top)
//   r=7 = rank 1 (white's back rank, bottom)
//   c=0 = file a (left), c=7 = file h (right)
//   index i = r * 8 + c
//
// Cell encoding — sign for color, magnitude for type:
//   0 = empty
//   +1 P  +2 N  +3 B  +4 R  +5 Q  +6 K   (white)
//   -1..-6 same for black
//
// Move shape sent by client:
//   { from: i, to: i, promotion?: 'Q'|'R'|'B'|'N' }
//
// `kind` is included on each generated legalMove for client-side UX
// (highlight castles, captures, en-passant differently):
//   "move" | "capture" | "ep" | "castleK" | "castleQ" | "double" | "promote"

const ROWS = 8;
const COLS = 8;
const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;

function idx(r, c) { return r * COLS + c; }
function rc(i) { return [Math.floor(i / COLS), i % COLS]; }
function inBounds(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }
function colorOf(v) { return v > 0 ? 'w' : v < 0 ? 'b' : null; }
function typeOf(v) { return Math.abs(v); }
function sideOf(v) {
  const c = colorOf(v);
  if (c === 'w') return 'p1';
  if (c === 'b') return 'p2';
  return null;
}
function sideColor(side) { return side === 'p1' ? 'w' : 'b'; }
function isEnemy(v, color) {
  if (v === 0) return false;
  return colorOf(v) !== color;
}
function isFriend(v, color) {
  if (v === 0) return false;
  return colorOf(v) === color;
}

export const adapter = {
  initialState() {
    const board = new Array(ROWS * COLS).fill(0);
    // Black back rank (r=0): R N B Q K B N R
    const back = [R, N, B, Q, K, B, N, R];
    for (let c = 0; c < COLS; c++) {
      board[idx(0, c)] = -back[c];
      board[idx(1, c)] = -P;
      board[idx(6, c)] = +P;
      board[idx(7, c)] = +back[c];
    }
    return {
      board,
      turn: 'p1',
      castle: { wK: true, wQ: true, bK: true, bQ: true },
      enPassant: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      inCheck: false,
      winLine: null,
    };
  },

  sideToMove(state) { return state.turn; },

  isTerminal(state) {
    const side = state.turn;
    const moves = adapter.legalMoves(state, side);
    if (moves.length === 0) return true;
    if (state.halfmoveClock >= 100) return true;
    if (insufficientMaterial(state.board)) return true;
    return false;
  },

  legalMoves(state, side) {
    const color = sideColor(side || state.turn);
    const pseudo = generatePseudo(state, color);
    // Filter: a move is legal only if it doesn't leave own king in check.
    const out = [];
    for (const mv of pseudo) {
      const next = applyMoveRaw(state, mv);
      if (!isInCheck(next.board, color)) out.push(mv);
    }
    return out;
  },

  applyMove(state, side, move) {
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number') {
      return { ok: false, error: 'bad-move' };
    }
    if (state.turn !== side) return { ok: false, error: 'not-your-turn' };

    const color = sideColor(side);
    const piece = state.board[move.from] || 0;
    if (piece === 0 || colorOf(piece) !== color) {
      return { ok: false, error: 'not-your-piece' };
    }

    const legal = adapter.legalMoves(state, side);
    const found = legal.find(m =>
      m.from === move.from &&
      m.to === move.to &&
      (m.kind !== 'promote' || (m.promotion === (move.promotion || 'Q')))
    );
    if (!found) return { ok: false, error: 'illegal-move' };

    const next = applyMoveRaw(state, found);

    // Update half-move clock (50-move rule): reset on pawn move or capture.
    const wasPawn = typeOf(piece) === P;
    const wasCapture = (state.board[move.to] !== 0) || found.kind === 'ep';
    next.halfmoveClock = (wasPawn || wasCapture) ? 0 : (state.halfmoveClock + 1);
    if (color === 'b') next.fullmoveNumber = (state.fullmoveNumber || 1) + 1;
    else next.fullmoveNumber = state.fullmoveNumber || 1;

    // Flip turn + recompute inCheck.
    next.turn = side === 'p1' ? 'p2' : 'p1';
    next.inCheck = isInCheck(next.board, sideColor(next.turn));

    // Terminal detection.
    const otherMoves = adapter.legalMoves(next, next.turn);
    if (otherMoves.length === 0) {
      if (next.inCheck) {
        return { ok: true, state: next, terminal: { winner: side, reason: 'checkmate' } };
      }
      return { ok: true, state: next, terminal: { winner: 'draw', reason: 'stalemate' } };
    }
    if (next.halfmoveClock >= 100) {
      return { ok: true, state: next, terminal: { winner: 'draw', reason: '50-move' } };
    }
    if (insufficientMaterial(next.board)) {
      return { ok: true, state: next, terminal: { winner: 'draw', reason: 'insufficient-material' } };
    }
    return { ok: true, state: next };
  },
};

// ── Pseudo-legal generator ───────────────────────────────────────────
// Generates moves that respect piece movement and don't capture own
// pieces, but doesn't filter "leaves king in check" — that's the
// caller's job.

function generatePseudo(state, color) {
  const out = [];
  for (let i = 0; i < state.board.length; i++) {
    const v = state.board[i];
    if (v === 0 || colorOf(v) !== color) continue;
    const t = typeOf(v);
    if (t === P) addPawn(out, state, i, color);
    else if (t === N) addKnight(out, state, i, color);
    else if (t === B) addSlider(out, state, i, color, [[1,1],[1,-1],[-1,1],[-1,-1]]);
    else if (t === R) addSlider(out, state, i, color, [[1,0],[-1,0],[0,1],[0,-1]]);
    else if (t === Q) addSlider(out, state, i, color, [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]]);
    else if (t === K) addKing(out, state, i, color);
  }
  return out;
}

function addPawn(out, state, from, color) {
  const [r, c] = rc(from);
  const dir = color === 'w' ? -1 : 1;
  const startRank = color === 'w' ? 6 : 1;
  const promoRank = color === 'w' ? 0 : 7;

  // 1-step forward
  const f1 = r + dir;
  if (inBounds(f1, c) && state.board[idx(f1, c)] === 0) {
    if (f1 === promoRank) {
      for (const pr of ['Q', 'R', 'B', 'N']) {
        out.push({ from, to: idx(f1, c), kind: 'promote', promotion: pr });
      }
    } else {
      out.push({ from, to: idx(f1, c), kind: 'move' });
      // 2-step from start
      const f2 = r + 2 * dir;
      if (r === startRank && state.board[idx(f2, c)] === 0) {
        out.push({ from, to: idx(f2, c), kind: 'double' });
      }
    }
  }
  // Captures
  for (const dc of [-1, 1]) {
    const nr = r + dir, nc = c + dc;
    if (!inBounds(nr, nc)) continue;
    const ti = idx(nr, nc);
    const tv = state.board[ti];
    if (tv !== 0 && colorOf(tv) !== color) {
      if (nr === promoRank) {
        for (const pr of ['Q', 'R', 'B', 'N']) {
          out.push({ from, to: ti, kind: 'promote', promotion: pr });
        }
      } else {
        out.push({ from, to: ti, kind: 'capture' });
      }
    }
    // En passant — target square is the empty square the enemy pawn
    // skipped over (state.enPassant).
    if (state.enPassant !== null && ti === state.enPassant) {
      out.push({ from, to: ti, kind: 'ep' });
    }
  }
}

const KNIGHT_DELTAS = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];

function addKnight(out, state, from, color) {
  const [r, c] = rc(from);
  for (const [dr, dc] of KNIGHT_DELTAS) {
    const nr = r + dr, nc = c + dc;
    if (!inBounds(nr, nc)) continue;
    const ti = idx(nr, nc);
    const tv = state.board[ti];
    if (tv === 0) out.push({ from, to: ti, kind: 'move' });
    else if (colorOf(tv) !== color) out.push({ from, to: ti, kind: 'capture' });
  }
}

function addSlider(out, state, from, color, deltas) {
  const [r, c] = rc(from);
  for (const [dr, dc] of deltas) {
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      const ti = idx(nr, nc);
      const tv = state.board[ti];
      if (tv === 0) { out.push({ from, to: ti, kind: 'move' }); }
      else {
        if (colorOf(tv) !== color) out.push({ from, to: ti, kind: 'capture' });
        break;
      }
      nr += dr; nc += dc;
    }
  }
}

function addKing(out, state, from, color) {
  const [r, c] = rc(from);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const ti = idx(nr, nc);
      const tv = state.board[ti];
      if (tv === 0) out.push({ from, to: ti, kind: 'move' });
      else if (colorOf(tv) !== color) out.push({ from, to: ti, kind: 'capture' });
    }
  }
  // Castling: king + rook unmoved, squares between empty, king not in
  // check, king doesn't pass through attacked squares.
  const rights = state.castle || {};
  const homeRank = color === 'w' ? 7 : 0;
  if (r !== homeRank || c !== 4) return;
  if (isInCheck(state.board, color)) return;

  const kingside = color === 'w' ? rights.wK : rights.bK;
  const queenside = color === 'w' ? rights.wQ : rights.bQ;

  if (kingside) {
    // F and G empty; king passes through F and lands on G.
    if (state.board[idx(homeRank, 5)] === 0 && state.board[idx(homeRank, 6)] === 0) {
      const rookV = state.board[idx(homeRank, 7)];
      if (typeOf(rookV) === R && colorOf(rookV) === color) {
        if (!squareAttacked(state.board, idx(homeRank, 5), color) &&
            !squareAttacked(state.board, idx(homeRank, 6), color)) {
          out.push({ from, to: idx(homeRank, 6), kind: 'castleK' });
        }
      }
    }
  }
  if (queenside) {
    // B, C, D empty; king passes through D and lands on C.
    if (state.board[idx(homeRank, 1)] === 0 &&
        state.board[idx(homeRank, 2)] === 0 &&
        state.board[idx(homeRank, 3)] === 0) {
      const rookV = state.board[idx(homeRank, 0)];
      if (typeOf(rookV) === R && colorOf(rookV) === color) {
        if (!squareAttacked(state.board, idx(homeRank, 3), color) &&
            !squareAttacked(state.board, idx(homeRank, 2), color)) {
          out.push({ from, to: idx(homeRank, 2), kind: 'castleQ' });
        }
      }
    }
  }
}

// Apply a move WITHOUT legality filtering. Returns the next state.
function applyMoveRaw(state, mv) {
  const board = state.board.slice();
  const rights = { ...(state.castle || {}) };
  let enPassant = null;

  const piece = board[mv.from];
  const color = colorOf(piece);
  board[mv.from] = 0;

  if (mv.kind === 'ep') {
    // Captured pawn sits on the rank ABOVE the destination for white,
    // BELOW for black.
    const [tr, tc] = rc(mv.to);
    const capRow = color === 'w' ? tr + 1 : tr - 1;
    board[idx(capRow, tc)] = 0;
    board[mv.to] = piece;
  } else if (mv.kind === 'double') {
    // Sets en-passant target square (the empty square between from/to).
    const [, fc] = rc(mv.from);
    const [tr] = rc(mv.to);
    const epR = (tr + (color === 'w' ? 1 : -1));
    enPassant = idx(epR, fc);
    board[mv.to] = piece;
  } else if (mv.kind === 'promote') {
    const pType = mv.promotion === 'N' ? N : mv.promotion === 'R' ? R : mv.promotion === 'B' ? B : Q;
    board[mv.to] = color === 'w' ? +pType : -pType;
  } else if (mv.kind === 'castleK') {
    const [hr] = rc(mv.from);
    board[mv.to] = piece;
    // Move rook from h-file (col 7) to f-file (col 5).
    board[idx(hr, 5)] = board[idx(hr, 7)];
    board[idx(hr, 7)] = 0;
  } else if (mv.kind === 'castleQ') {
    const [hr] = rc(mv.from);
    board[mv.to] = piece;
    // Move rook from a-file (col 0) to d-file (col 3).
    board[idx(hr, 3)] = board[idx(hr, 0)];
    board[idx(hr, 0)] = 0;
  } else {
    board[mv.to] = piece;
  }

  // Strip castling rights as needed.
  const t = typeOf(piece);
  if (t === K) {
    if (color === 'w') { rights.wK = false; rights.wQ = false; }
    else { rights.bK = false; rights.bQ = false; }
  } else if (t === R) {
    const [fr, fc] = rc(mv.from);
    if (color === 'w' && fr === 7) {
      if (fc === 0) rights.wQ = false;
      if (fc === 7) rights.wK = false;
    } else if (color === 'b' && fr === 0) {
      if (fc === 0) rights.bQ = false;
      if (fc === 7) rights.bK = false;
    }
  }
  // Capturing the opponent's rook on its starting square also strips
  // their castling rights on that side.
  const [tr, tc] = rc(mv.to);
  if (tr === 7 && tc === 0) rights.wQ = false;
  if (tr === 7 && tc === 7) rights.wK = false;
  if (tr === 0 && tc === 0) rights.bQ = false;
  if (tr === 0 && tc === 7) rights.bK = false;

  return {
    board,
    turn: state.turn,         // caller flips
    castle: rights,
    enPassant,
    halfmoveClock: state.halfmoveClock || 0,
    fullmoveNumber: state.fullmoveNumber || 1,
    inCheck: false,
    winLine: null,
  };
}

// Is `color`'s king in check on the given board?
function isInCheck(board, color) {
  const king = color === 'w' ? +K : -K;
  let kingI = -1;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === king) { kingI = i; break; }
  }
  if (kingI < 0) return false;     // shouldn't happen in a legal position
  return squareAttacked(board, kingI, color);
}

// Is square `i` attacked by ANY piece of the OPPOSITE color of `color`?
function squareAttacked(board, i, color) {
  const enemy = color === 'w' ? 'b' : 'w';
  const [r, c] = rc(i);

  // Pawn attacks (note: enemy pawns attack from THEIR direction,
  // which means they sit one rank in the direction THEY move FROM
  // — easier to enumerate by the squares from which an enemy pawn
  // could capture INTO i).
  const pDir = enemy === 'w' ? -1 : 1;
  for (const dc of [-1, 1]) {
    const pr = r - pDir;
    const pc = c + dc;
    if (inBounds(pr, pc)) {
      const v = board[idx(pr, pc)];
      if (typeOf(v) === P && colorOf(v) === enemy) return true;
    }
  }
  // Knight attacks
  for (const [dr, dc] of KNIGHT_DELTAS) {
    const nr = r + dr, nc = c + dc;
    if (!inBounds(nr, nc)) continue;
    const v = board[idx(nr, nc)];
    if (typeOf(v) === N && colorOf(v) === enemy) return true;
  }
  // King adjacency
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const v = board[idx(nr, nc)];
      if (typeOf(v) === K && colorOf(v) === enemy) return true;
    }
  }
  // Bishop / Queen diagonals
  for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      const v = board[idx(nr, nc)];
      if (v !== 0) {
        if (colorOf(v) === enemy && (typeOf(v) === B || typeOf(v) === Q)) return true;
        break;
      }
      nr += dr; nc += dc;
    }
  }
  // Rook / Queen orthogonals
  for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      const v = board[idx(nr, nc)];
      if (v !== 0) {
        if (colorOf(v) === enemy && (typeOf(v) === R || typeOf(v) === Q)) return true;
        break;
      }
      nr += dr; nc += dc;
    }
  }
  // Mark `color` as used — silence linters.
  void color; void sideOf;
  return false;
}

// Insufficient material heuristic. We treat as draw:
//   K vs K
//   K + minor vs K (minor = bishop or knight)
//   K + B vs K + B with bishops on same color square
function insufficientMaterial(board) {
  const pieces = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== 0) pieces.push({ i, v: board[i] });
  }
  if (pieces.length === 2) return true; // K vs K
  if (pieces.length === 3) {
    const minor = pieces.find(p => typeOf(p.v) === B || typeOf(p.v) === N);
    return !!minor;
  }
  if (pieces.length === 4) {
    const wB = pieces.find(p => p.v === +B);
    const bB = pieces.find(p => p.v === -B);
    if (wB && bB) {
      const [wr, wc] = rc(wB.i);
      const [br, bc] = rc(bB.i);
      if (((wr + wc) & 1) === ((br + bc) & 1)) return true;
    }
  }
  return false;
}
