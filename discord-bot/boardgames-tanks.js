// Tanks — turn-based artillery PvP adapter for the boardgames engine.
//
// Two tanks on either side of a 1-D destructible heightmap. Each turn,
// the side-to-move submits { angle, power }. The worker resolves the
// physics deterministically (gravity + per-turn wind), computes the
// trajectory, the impact point, the crater dug into the terrain, and
// the damage to each tank from blast-radius falloff. First tank to 0
// HP loses; the survivor takes the wager pot via the engine's normal
// settle path. Self-kill = loss (opponent wins).
//
// Server-authoritative: the PWA submits angle + power only, never a
// trajectory. The worker's `lastShot` field carries everything the
// client needs to replay the animation faithfully (trajectory points,
// impact, crater geometry, per-tank damage).
//
// State shape (also the over-the-wire contract — redactMatch passes
// state through unchanged because tanks is perfect-information):
//   {
//     w, h,                    // logical map size (cells × max height)
//     terrain: number[w],      // current heightmap, integer 0..h
//     tanks: [
//       { side: 'p1', x, hp },
//       { side: 'p2', x, hp },
//     ],
//     wind,                     // cells/s² horizontal accel; recomputed each turn
//     turn: 'p1' | 'p2',
//     shotsFired: int,
//     winner: null | 'p1' | 'p2',
//     winReason?: string,
//     matchSeed: string,        // for deterministic per-turn wind
//     lastShot: null | {
//       by, angle, power,
//       trajectory: [[x,y], ...],         // sample points for replay anim
//       impact: { x, y, reason: 'ground'|'tank'|'offmap'|'timeout' },
//       crater: { x, radius, depth } | null,
//       damages: [
//         { side: 'p1', amount, hpAfter },
//         { side: 'p2', amount, hpAfter },
//       ],
//       hitTankSide?: 'p1'|'p2'|null,    // present if a direct tank hit
//     },
//     // Kill-feed-friendly summary of every shot, trajectory stripped
//     // to keep state.shotLog compact. Indexed by turn (0-based).
//     shotLog: [
//       { by, angle, power,
//         impact: {...}, crater: {...},
//         damages: [...], hitTankSide?, },
//       ...
//     ],
//   }
//
// Move shape: { angle: number, power: number }
//   angle in 0..180 (0 = east, 90 = straight up, 180 = west).
//   power in 10..100.

// ── Game constants ────────────────────────────────────────────────────
const MAP_W           = 200;     // terrain cells
const MAP_H           = 100;     // max heightmap value
const TANK_HP         = 100;
const TANK_RADIUS     = 4;       // collision + visual half-width
const BLAST_RADIUS    = 14;      // damage falloff range
const DIRECT_HIT_DMG  = 50;      // additional damage on direct tank collision
const MAX_BLAST_DMG   = 50;      // max edge of blast falloff curve
const CRATER_DEPTH    = 10;      // peak depth at impact center
const CRATER_RADIUS   = 14;      // wider than blast so terrain mutates a touch beyond
// Tuned so a max-power 45° shot covers ~75% of the map (≈ 150 cells of
// range, map is 200 wide). Players still have to compensate for wind +
// terrain blocking + the opponent's spawn-pad protection. Sustained
// "max power 45°" play is hittable but rarely a one-shot kill, which
// keeps shot 2-3 interesting.
const SPEED_SCALE     = 1.0;     // power → initial velocity (cells/s)
const GRAVITY         = 60;      // cells/s² downward
const WIND_MAX        = 6;       // cells/s² horizontal accel, signed
const DT              = 0.05;    // simulation step (s)
const MAX_STEPS       = 600;     // 30s of in-flight — overshoots into 'timeout'
const SAMPLE_EVERY    = 3;       // sample every Nth step into trajectory
const ANGLE_MIN       = 1;
const ANGLE_MAX       = 179;
const POWER_MIN       = 10;
const POWER_MAX       = 100;
const BARREL_LEN      = 3;       // shot spawns this far above tank center
const HOME_MARGIN     = 0.15;    // tank starts this far from each edge

// ── Adapter contract ──────────────────────────────────────────────────
export const adapter = {
  initialState() {
    const seed = randomSeed();
    const terrain = generateTerrain(MAP_W, MAP_H, seed);
    return {
      w: MAP_W, h: MAP_H,
      terrain,
      tanks: [
        { side: 'p1', x: Math.floor(MAP_W * HOME_MARGIN),       hp: TANK_HP },
        { side: 'p2', x: Math.floor(MAP_W * (1 - HOME_MARGIN)), hp: TANK_HP },
      ],
      wind: windFor(seed, 0),
      turn: 'p1',
      shotsFired: 0,
      winner: null,
      winReason: null,
      matchSeed: seed,
      lastShot: null,
      shotLog: [],
    };
  },

  sideToMove(s) { return s.turn; },
  isTerminal(s) { return !!s.winner; },

  // No enumerable legal-moves for a continuous game — return the
  // valid input bounds so the client can render slider min/max.
  legalMoves(s) {
    if (s.winner) return [];
    return [{
      kind: 'fire-bounds',
      angle: { min: ANGLE_MIN, max: ANGLE_MAX },
      power: { min: POWER_MIN, max: POWER_MAX },
    }];
  },

  applyMove(state, side, move) {
    if (state.winner) return { ok: false, error: 'finished' };
    if (state.turn !== side) return { ok: false, error: 'not-your-turn' };

    const angle = Number(move?.angle);
    const power = Number(move?.power);
    if (!Number.isFinite(angle) || angle < ANGLE_MIN || angle > ANGLE_MAX) {
      return { ok: false, error: 'bad-angle',
               message: `angle must be ${ANGLE_MIN}..${ANGLE_MAX} (0 = east, 90 = up, 180 = west).` };
    }
    if (!Number.isFinite(power) || power < POWER_MIN || power > POWER_MAX) {
      return { ok: false, error: 'bad-power',
               message: `power must be ${POWER_MIN}..${POWER_MAX}.` };
    }

    const next = cloneState(state);

    // Resolve the shot. The shooter's tank fires from its centre + a
    // short barrel offset upward; this keeps the shell from immediately
    // colliding with its own terrain cell when fired at low angles.
    const shooter = next.tanks.find(t => t.side === side);
    const opponentSide = side === 'p1' ? 'p2' : 'p1';
    const x0 = shooter.x;
    const y0 = next.terrain[shooter.x] + TANK_RADIUS + BARREL_LEN;
    const flight = simulate({
      x0, y0, angle, power,
      wind: next.wind, gravity: GRAVITY,
      terrain: next.terrain,
      tanks: next.tanks,
      shooterSide: side,
    });

    // Apply terrain crater + damage if the shell landed somewhere
    // damageable (ground or tank). Offmap / timeout shots whiff with
    // no terrain change and no damage.
    let crater = null;
    const damages = [
      { side: 'p1', amount: 0, hpAfter: next.tanks[0].hp },
      { side: 'p2', amount: 0, hpAfter: next.tanks[1].hp },
    ];
    if (flight.impact.reason === 'ground' || flight.impact.reason === 'tank') {
      crater = { x: clampInt(flight.impact.x, 0, MAP_W - 1),
                 radius: CRATER_RADIUS, depth: CRATER_DEPTH };
      applyCrater(next.terrain, crater);
      settleTanksOnTerrain(next.tanks, next.terrain);
      // Blast falloff damage to BOTH tanks.
      for (let i = 0; i < 2; i++) {
        const t = next.tanks[i];
        const tx = t.x;
        const ty = next.terrain[t.x] + TANK_RADIUS / 2;   // tank's centre
        const dx = tx - flight.impact.x;
        const dy = ty - flight.impact.y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < BLAST_RADIUS) {
          // Linear falloff. Round to int so HP stays clean.
          const dmg = Math.round(MAX_BLAST_DMG * (1 - d / BLAST_RADIUS));
          damages[i].amount += dmg;
        }
      }
      if (flight.impact.reason === 'tank' && flight.hitTankSide) {
        // Direct hit — extra damage on top of blast falloff.
        const i = flight.hitTankSide === 'p1' ? 0 : 1;
        damages[i].amount += DIRECT_HIT_DMG;
      }
      // Commit damages.
      for (let i = 0; i < 2; i++) {
        next.tanks[i].hp = Math.max(0, next.tanks[i].hp - damages[i].amount);
        damages[i].hpAfter = next.tanks[i].hp;
      }
    }

    next.shotsFired += 1;
    next.lastShot = {
      by: side,
      angle, power,
      trajectory: flight.trajectory,
      impact: flight.impact,
      crater,
      damages,
      hitTankSide: flight.hitTankSide || null,
    };
    // Trajectory-stripped copy for the kill-feed history. Without
    // dropping trajectory[] the shot log would be the biggest thing
    // in state — a 30-shot match would pile ~12 KB of sample points
    // into KV with nothing rendering them after the first turn.
    next.shotLog = (next.shotLog || []).slice();
    next.shotLog.push({
      by: side, angle, power,
      impact: flight.impact,
      crater,
      damages,
      hitTankSide: flight.hitTankSide || null,
    });

    // Win check. If BOTH die on the same shot, the SHOOTER loses
    // (self-kill rules: better not blow yourself up). If only the
    // opponent dies, the shooter wins. If only the shooter dies (via
    // their own blast), opponent wins.
    const p1Dead = next.tanks[0].hp <= 0;
    const p2Dead = next.tanks[1].hp <= 0;
    if (p1Dead || p2Dead) {
      let winner, reason;
      if (p1Dead && p2Dead) {
        winner = opponentSide;
        reason = 'mutual-destruction-shooter-loses';
      } else if (p1Dead) {
        winner = 'p2';
        reason = side === 'p1' ? 'self-destruction' : 'direct-kill';
      } else {
        winner = 'p1';
        reason = side === 'p2' ? 'self-destruction' : 'direct-kill';
      }
      next.winner = winner;
      next.winReason = reason;
      next.turn = side;  // freeze on the side that fired
      return { ok: true, state: next, terminal: { winner, reason } };
    }

    // Pass the turn + re-roll wind for the next shooter.
    next.turn = opponentSide;
    next.wind = windFor(next.matchSeed, next.shotsFired);
    return { ok: true, state: next };
  },
};

// ── Physics ────────────────────────────────────────────────────────────

function simulate({ x0, y0, angle, power, wind, gravity, terrain, tanks, shooterSide }) {
  const angleRad = (angle * Math.PI) / 180;
  // Angle convention: 0 = east, 90 = straight up, 180 = west. So
  // vx = cos(angle), vy = sin(angle). Gravity pulls y DOWN (-vy/sec²).
  const v0 = power * SPEED_SCALE;
  let vx = Math.cos(angleRad) * v0;
  let vy = Math.sin(angleRad) * v0;
  let x = x0, y = y0;
  const trajectory = [[round1(x), round1(y)]];
  let hitTankSide = null;

  for (let step = 1; step <= MAX_STEPS; step++) {
    // Integrate. wind is a horizontal acceleration (cells/s²); gravity
    // is a vertical deceleration. Both act over DT.
    vx += wind * DT;
    vy -= gravity * DT;
    x  += vx * DT;
    y  += vy * DT;

    // Off-map?
    if (x < 0 || x >= terrain.length) {
      trajectory.push([round1(x), round1(y)]);
      return { impact: { x: clamp(x, 0, terrain.length - 1), y: round1(y), reason: 'offmap' },
               trajectory, hitTankSide: null };
    }

    // Direct tank collision? Check both tanks; ignore the shooter's
    // own tank for the first few steps so a low-angle shot from your
    // own muzzle doesn't blow you up on step 1.
    for (const t of tanks) {
      // The shell is fired from above the shooter's muzzle; treat the
      // first 6 steps as muzzle clearance for the shooter's OWN tank.
      if (t.side === shooterSide && step < 6) continue;
      const tx = t.x;
      const ty = terrain[t.x] + TANK_RADIUS / 2;
      const dx = x - tx;
      const dy = y - ty;
      if (dx * dx + dy * dy <= TANK_RADIUS * TANK_RADIUS) {
        hitTankSide = t.side;
        trajectory.push([round1(x), round1(y)]);
        return { impact: { x: round1(x), y: round1(y), reason: 'tank' },
                 trajectory, hitTankSide };
      }
    }

    // Ground collision — heightmap is sampled at the integer cell
    // containing x. When y dips at or below terrain height we've hit.
    const cellX = Math.floor(x);
    if (y <= terrain[cellX]) {
      const groundY = terrain[cellX];
      trajectory.push([round1(x), groundY]);
      return { impact: { x: round1(x), y: groundY, reason: 'ground' },
               trajectory, hitTankSide: null };
    }

    // Sample less aggressively than DT so the trajectory array stays
    // small. Always include the apex-ish + descent points though.
    if (step % SAMPLE_EVERY === 0) trajectory.push([round1(x), round1(y)]);
  }
  // Out of time. Treat as a whiff at wherever the shell is now.
  return { impact: { x: round1(x), y: round1(y), reason: 'timeout' },
           trajectory, hitTankSide: null };
}

function applyCrater(terrain, crater) {
  const { x: cx, radius, depth } = crater;
  const lo = Math.max(0, Math.floor(cx - radius));
  const hi = Math.min(terrain.length - 1, Math.ceil(cx + radius));
  for (let i = lo; i <= hi; i++) {
    const dx = i - cx;
    const d2 = dx * dx;
    const r2 = radius * radius;
    if (d2 >= r2) continue;
    // Parabolic well — full depth at centre, zero at the rim.
    const drop = Math.round(depth * (1 - d2 / r2));
    terrain[i] = Math.max(0, terrain[i] - drop);
  }
}

function settleTanksOnTerrain(tanks, terrain) {
  // Tanks sit on top of whatever terrain is below them. If a crater
  // dug below a tank, it drops. (No fall damage in v1.) Tank x is
  // unchanged — only its derived y moves.
  // Nothing to do to the state object here; the y is derived from
  // terrain[tank.x] at render time. This function is a hook for
  // future polish (e.g. lateral roll into pits).
  return tanks;
}

// ── Terrain generation (deterministic from match seed) ─────────────────

function generateTerrain(width, maxHeight, seed) {
  // Sum of three sine waves at different frequencies + a tiny noise
  // jitter, normalised to 0..maxHeight*0.55 so there's headroom for
  // shots to fly over. Deterministic from `seed` so a replay or a
  // match snapshot regenerates the same map.
  const rng = mulberry32(hashSeed(seed));
  const a1 = 0.6 + rng() * 0.4;
  const a2 = 0.25 + rng() * 0.25;
  const a3 = 0.10 + rng() * 0.10;
  const f1 = 0.02 + rng() * 0.01;
  const f2 = 0.05 + rng() * 0.02;
  const f3 = 0.13 + rng() * 0.05;
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;
  const phase3 = rng() * Math.PI * 2;
  const base = maxHeight * 0.22;
  const amp  = maxHeight * 0.30;
  const out = new Array(width);
  for (let i = 0; i < width; i++) {
    const h = base + amp * (
      a1 * Math.sin(i * f1 + phase1) +
      a2 * Math.sin(i * f2 + phase2) +
      a3 * Math.sin(i * f3 + phase3)
    );
    // Small jitter ±1 to avoid pixel-perfect terrain looking too clean.
    out[i] = Math.max(0, Math.min(maxHeight, Math.round(h + (rng() - 0.5) * 2)));
  }
  // Flatten the spawn pads under each tank so the first shot doesn't
  // land on a cliff edge that hides the target.
  const padW = 6;
  for (const tx of [Math.floor(width * HOME_MARGIN), Math.floor(width * (1 - HOME_MARGIN))]) {
    const padH = out[tx];
    for (let i = Math.max(0, tx - padW); i <= Math.min(width - 1, tx + padW); i++) {
      out[i] = padH;
    }
  }
  return out;
}

// Per-turn wind. Derived from (matchSeed, shotsFired) so it's
// reproducible from state alone — a re-render or a replay never sees
// a different wind than what actually fired.
function windFor(seed, shotIdx) {
  const rng = mulberry32(hashSeed(seed + ':' + shotIdx));
  // Bias toward zero with a soft tail (cube of uniform → still in
  // [-1,1] but mostly low-magnitude). Scaled to ±WIND_MAX.
  const u = rng() * 2 - 1;
  return +(u * u * u * WIND_MAX).toFixed(2);
}

// ── Utilities ──────────────────────────────────────────────────────────

function cloneState(s) {
  return {
    w: s.w, h: s.h,
    terrain: s.terrain.slice(),
    tanks: s.tanks.map(t => ({ side: t.side, x: t.x, hp: t.hp })),
    wind: s.wind,
    turn: s.turn,
    shotsFired: s.shotsFired,
    winner: s.winner,
    winReason: s.winReason || null,
    matchSeed: s.matchSeed,
    lastShot: s.lastShot,   // overwritten by applyMove, so shallow-copy OK
    shotLog:  s.shotLog || [],
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function clampInt(v, lo, hi) { return Math.round(clamp(v, lo, hi)); }
function round1(v) { return Math.round(v * 10) / 10; }

function randomSeed() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hashSeed(s) {
  // FNV-1a 32-bit, sufficient for seeding mulberry32.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Mulberry32 — small, fast, deterministic 32-bit PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
