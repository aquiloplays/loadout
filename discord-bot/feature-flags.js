// Single source of truth for hiding Boltbound across the Discord worker.
//
// Boltbound hidden 2026-06-16: the community is going all-in on the Fallout
// theme and the card battler does not fit right now. No Boltbound code is
// deleted; this flag only gates visibility (slash command registration,
// command dispatch, the games-menu hub, and the onboarding interest picker).
//
// To bring Boltbound back: set BOLTBOUND_VISIBLE=true and redeploy.
//   - worker:               add it under [vars] in wrangler.toml
//   - register-commands.js: export BOLTBOUND_VISIBLE=true in the shell
// Then re-register the slash commands (see MOD-PERMISSIONS.md).

function readEnvFlag(env, name) {
  if (env && typeof env[name] !== 'undefined') return env[name];
  if (typeof process !== 'undefined' && process.env && typeof process.env[name] !== 'undefined') {
    return process.env[name];
  }
  return undefined;
}

export function boltboundVisible(env) {
  const v = readEnvFlag(env, 'BOLTBOUND_VISIBLE');
  return v === 'true' || v === true;
}

// Module-load convenience for places that build static structures (the
// command registry, the games-menu rows) before any request `env` is
// available. Falls back to process.env, which is unset by default, so
// Boltbound stays hidden until the flag is explicitly turned on.
export const BOLTBOUND_VISIBLE = boltboundVisible(undefined);
