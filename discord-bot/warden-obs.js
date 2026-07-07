// warden-obs.js — OBS capability allowlist validation (shared server-side).
//
// The streamer authors a capability set in StreamFusion's Warden Bridge pane;
// it's mirrored to KV warden:obscaps:<streamerId> and re-validated HERE on
// every mod command (the browser can't be trusted, and the on-machine agent
// re-checks the same rules as defense-in-depth). Every action a mod can fire
// must appear on the streamer's list with the exact target — nothing is
// implicit.
//
// Command envelope is uniform: { action, arg, arg2 }.
//   action         what to do
//   arg            primary target (scene / source / input / hotkey name)
//   arg2           secondary param (filter name, dB, media verb, move target)
//
// The SF agent (StreamFusion/warden-agent.js) carries a copy of MEDIA_ACTIONS
// and MOVE_TARGETS + the same allow logic; keep them in sync.

// Media-source verbs a mod may trigger (TriggerMediaInputAction).
export const MEDIA_ACTIONS = ['play', 'pause', 'restart', 'stop', 'next', 'previous'];

// Preset positions moveSource accepts. `reset` restores the pre-move spot.
export const MOVE_TARGETS = ['topleft', 'topright', 'bottomleft', 'bottomright', 'center', 'reset'];

function inList(list, v) {
  return Array.isArray(list) && list.indexOf(v) !== -1;
}

// A signed, finite dB in OBS's accepted range [-100, 0]. Accepts "0", "-6",
// "-12.5". Returns the parsed number or null.
export function parseDb(s) {
  if (!/^-?\d{1,3}(\.\d+)?$/.test(String(s))) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n > 0 || n < -100) return null;
  return n;
}

/**
 * isObsCommandAllowed(caps, action, arg, arg2) -> boolean
 *
 * The single source of truth for "may this streamer's mods fire this exact
 * command?" — used by the worker router before it fans the frame, and mirrored
 * in the agent before it touches OBS.
 */
export function isObsCommandAllowed(caps, action, arg, arg2) {
  if (!caps || !caps.enabled) return false;
  switch (action) {
    // ── original four ──────────────────────────────────────────────────
    case 'brbPanic':
      return caps.brbPanic === true;
    case 'sceneSwitch':
      return inList(caps.scenes, arg);
    case 'sourceToggle':
      return inList(caps.sources, arg);
    case 'muteMic':
      return inList(caps.mics, arg);
    // ── tier 1 additions ───────────────────────────────────────────────
    case 'saveReplay':
      return caps.replay === true;
    case 'filterToggle':
      // Allowlist entries are "source::filter" so a mod can only flip the
      // exact filters the streamer chose, not any filter on an allowed source.
      return !!arg && !!arg2 && inList(caps.filters, arg + '::' + arg2);
    case 'setVolume':
      return inList(caps.volumes, arg) && parseDb(arg2) !== null;
    case 'mediaControl':
      return inList(caps.media, arg) && MEDIA_ACTIONS.indexOf(arg2) !== -1;
    case 'refreshBrowser':
      return inList(caps.browsers, arg);
    case 'fireHotkey':
      return inList(caps.hotkeys, arg);
    // ── move a camera / source / group to a preset spot ────────────────
    case 'moveSource':
      return inList(caps.movable, arg) && MOVE_TARGETS.indexOf(arg2) !== -1;
    default:
      return false;
  }
}
