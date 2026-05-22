// Connect Four adapter for the boardgames engine.
//
// Board: 7 cols × 6 rows. Discs drop top-down, settle in the lowest
// empty row of the chosen column. Win = 4-in-a-row horizontally,
// vertically, or diagonally. Draw = board full with no winner.
//
// State shape:
//   {
//     cols: number[7][]    -- per column, indexed bottom-up: cols[c][0]
//                              is the lowest row, cols[c][n-1] is the
//                              top. Cell values: 1 = p1, 2 = p2.
//     turn: 'p1' | 'p2'    -- side to move
//     winLine: [{c,r}]|null -- highlight cells when finished
//   }
//
// Move shape: { col: 0..6 }

const COLS = 7;
const ROWS = 6;

export const adapter = {
  initialState() {
    return {
      cols: Array.from({ length: COLS }, () => []),
      turn: 'p1',
      winLine: null,
    };
  },

  sideToMove(state) {
    return state.turn;
  },

  isTerminal(state) {
    return !!state.winLine || boardFull(state);
  },

  legalMoves(state) {
    if (this.isTerminal(state)) return [];
    const out = [];
    for (let c = 0; c < COLS; c++) {
      if (state.cols[c].length < ROWS) out.push({ col: c });
    }
    return out;
  },

  applyMove(state, side, move) {
    if (!move || typeof move.col !== 'number') {
      return { ok: false, error: 'bad-move', message: 'Need { col }.' };
    }
    const c = move.col | 0;
    if (c < 0 || c >= COLS) {
      return { ok: false, error: 'bad-col', message: 'Column out of range.' };
    }
    if (state.cols[c].length >= ROWS) {
      return { ok: false, error: 'col-full', message: 'Column is full.' };
    }
    if (state.turn !== side) {
      return { ok: false, error: 'not-your-turn' };
    }

    const next = cloneState(state);
    const piece = side === 'p1' ? 1 : 2;
    next.cols[c].push(piece);
    const row = next.cols[c].length - 1;

    const win = findWinLine(next, c, row, piece);
    if (win) {
      next.winLine = win;
      return {
        ok: true,
        state: next,
        terminal: { winner: side, reason: 'four-in-a-row' },
      };
    }
    if (boardFull(next)) {
      return {
        ok: true,
        state: next,
        terminal: { winner: 'draw', reason: 'board-full' },
      };
    }
    next.turn = side === 'p1' ? 'p2' : 'p1';
    return { ok: true, state: next };
  },
};

function cloneState(s) {
  return {
    cols: s.cols.map(col => col.slice()),
    turn: s.turn,
    winLine: s.winLine ? s.winLine.slice() : null,
  };
}

function cellAt(state, c, r) {
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return 0;
  return state.cols[c][r] || 0;
}

function boardFull(state) {
  return state.cols.every(col => col.length >= ROWS);
}

// Walk in both directions from (c, r) along (dc, dr) and collect
// matching-piece cells. If the run is >= 4, return them; else null.
const DIRS = [
  [1, 0],   // horizontal
  [0, 1],   // vertical
  [1, 1],   // diag /
  [1, -1],  // diag \
];

function findWinLine(state, c, r, piece) {
  for (const [dc, dr] of DIRS) {
    const run = [{ c, r }];
    let cc = c + dc, rr = r + dr;
    while (cellAt(state, cc, rr) === piece) {
      run.push({ c: cc, r: rr });
      cc += dc; rr += dr;
    }
    cc = c - dc; rr = r - dr;
    while (cellAt(state, cc, rr) === piece) {
      run.unshift({ c: cc, r: rr });
      cc -= dc; rr -= dr;
    }
    if (run.length >= 4) return run.slice(0, 4);
  }
  return null;
}
