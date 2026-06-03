// Scratch-off outcome content, per-game challenge + tamper pools.
//
// THIS IS THE FILE TO EDIT when you want to add or reword scratch outcomes.
// It is pure data (no D1, no fetch) so it is safe to hand-tune. `seedScratch`
// in scratch-off.js loads STREAMER_BOT_ACTIONS + POOLS into D1; the Haiku
// generator backfills any game with no curated pool. Editing here and
// re-running POST /web/admin/scratch/seed?force=1 reseeds.
//
// Two outcome kinds:
//   challenge, something Clay performs live (chat-driven). actionKey null.
//   tamper, a Streamer.bot control tamper. actionKey MUST be one of the
//               registry keys below; durationSec is the auto-revert length.
//
// Voice rules (strict, Aquilo): no em dashes, no exclamation spam, no cringe,
// no emoji, no hype words. Dry, dark-humored, mechanical TCG-card brevity.
// One imperative sentence each. Reference the game where it fits.
//
// game_slug 'generic' is the fallback pool any game falls back to when it has
// no entries of its own. Slugs match GAMES in scratch-off.js.

// ── Streamer.bot tamper action registry ────────────────────────────────
// Every tamper outcome references one of these action_keys. The Loadout
// relay + scratch-tamper.cs map each key to a real input action with a
// MANDATORY auto-revert timer (see SCRATCH-OFF-STREAMERBOT.md). Keep this in
// sync with the dispatch table in streamerbot/actions/scratch-tamper.cs.
export const STREAMER_BOT_ACTIONS = [
  { action_key: 'invert_mouse',    action_name: 'Invert Mouse',    default_duration_sec: 30, description: 'Invert mouse Y (and X) axis for the duration.' },
  { action_key: 'swap_wasd',       action_name: 'Swap WASD',       default_duration_sec: 60, description: 'Remap movement keys so W/S and A/D are swapped.' },
  { action_key: 'lock_crouch',     action_name: 'Lock Crouch',     default_duration_sec: 90, description: 'Force-hold the crouch key.' },
  { action_key: 'force_jump',      action_name: 'Force Jump',      default_duration_sec: 30, description: 'Inject periodic jump key presses.' },
  { action_key: 'mute_mic',        action_name: 'Mute Mic',        default_duration_sec: 10, description: 'Mute the streamer mic input.' },
  { action_key: 'random_keys',     action_name: 'Random Keys',     default_duration_sec: 30, description: 'Inject random key presses.' },
  { action_key: 'mouse_drift',     action_name: 'Mouse Drift',     default_duration_sec: 30, description: 'Apply a constant cursor drift in one direction.' },
  { action_key: 'force_walk',      action_name: 'Force Walk',      default_duration_sec: 60, description: 'Hold the walk modifier so movement is slow.' },
  { action_key: 'sensitivity_max', action_name: 'Max Sensitivity', default_duration_sec: 45, description: 'Spike look sensitivity to max.' },
  { action_key: 'flip_screen',     action_name: 'Flip Screen',     default_duration_sec: 20, description: 'Flip the game capture upside down (display filter).' },
  { action_key: 'deafen',          action_name: 'Deafen Game',     default_duration_sec: 30, description: 'Mute game audio output.' },
  { action_key: 'spam_emote',      action_name: 'Force Emote',     default_duration_sec: 15, description: 'Trigger an in-game emote/taunt repeatedly.' },
];

// ── Loss flavor lines ──────────────────────────────────────────────────
export const LOSS_LINES = [
  'No win this time.', 'Not this one. Try again.', 'Empty. Better luck next card.',
  'Nothing here. The vault stays sealed.', 'Dud. Buy another.', 'So close. (Not really.)',
  'House keeps this one.', 'Blank. The foil owed you nothing.',
  'Clean miss. Chat saw it.', 'That one was always a loser. Thanks for the bits.',
];

// ── Builders ───────────────────────────────────────────────────────────
const T = (body, actionKey, durationSec, weight = 10) => ({ kind: 'tamper', body, actionKey, durationSec, weight });
const C = (body, durationSec = 0, weight = 10) => ({ kind: 'challenge', body, durationSec, weight });

// ── Per-game pools ─────────────────────────────────────────────────────
export const POOLS = {
  generic: [
    C('Pose for the stream. Hold it 10 seconds.', 10),
    C('Do 5 push-ups off camera. Chat counts.', 0),
    C('Pick the worst dialogue option at the next prompt.', 0),
    C('Read the next chat message in a villain voice.', 0),
    C('Whisper everything you say for the next 2 minutes.', 120),
    C('No coffee/drink for 5 minutes.', 300),
    C('Name your next save file whatever chat picks.', 0),
    C('Give a 20-second TED talk on your current objective.', 20),
    C('Compliment the last person who followed.', 0),
    C('Narrate the next 60 seconds like a nature documentary.', 60),
    C('Switch to your worst posture for 3 minutes.', 180),
    C('Do the next section one-handed.', 0, 6),
    C('Sit in silence for 30 seconds. No talking.', 30),
    C('Speak only in questions for 90 seconds.', 90),
    C('Let chat name the next thing you kill or build.', 0),
    C('Explain your last death like it was the plan all along.', 0),
    T('Mouse inverted for 30 seconds.', 'invert_mouse', 30, 12),
    T('WASD swapped for 60 seconds.', 'swap_wasd', 60, 10),
    T('Mic muted for 10 seconds. Mid-sentence.', 'mute_mic', 10, 10),
    T('Random key presses for 30 seconds.', 'random_keys', 30, 8),
    T('Cursor drifts left for 30 seconds.', 'mouse_drift', 30, 8),
    T('Look sensitivity maxed for 45 seconds.', 'sensitivity_max', 45, 6),
    T('Forced to walk, no running, for 60 seconds.', 'force_walk', 60, 8),
    T('Screen flips upside down for 20 seconds.', 'flip_screen', 20, 5),
  ],
  fallout4: [
    C('Lone survivor. Dismiss your companion for the next quest.', 0, 8),
    C('Pacifist mode. No kills for 5 minutes.', 300, 8),
    C('Sell your best weapon to the next vendor.', 0, 6),
    C('Talk to the next NPC entirely in character.', 0),
    C('Drop all your stimpaks. Right now.', 0, 5),
    C('Build something ugly in the next settlement. Chat names it.', 0),
    C('Only V.A.T.S. for the next 5 minutes. No free aim.', 300, 7),
    C('Wear the worst armor in your inventory until the next loading screen.', 0),
    T('Mouse inverted for 60 seconds. Good luck in the wasteland.', 'invert_mouse', 60, 12),
    T('Crouch locked for 90 seconds. Sneak whether you like it or not.', 'lock_crouch', 90, 9),
    T('WASD swapped for 60 seconds.', 'swap_wasd', 60, 9),
    T('Forced V.A.T.S. spam: random key presses for 30 seconds.', 'random_keys', 30, 7),
    T('Pip-Boy posture: forced walk for 60 seconds.', 'force_walk', 60, 7),
    T('Rad-vision: screen flips for 20 seconds.', 'flip_screen', 20, 5),
  ],
  among_us: [
    C('Vote yourself out next round.', 0, 9),
    C('Do not talk during the next meeting. At all.', 0, 9),
    C('Accuse the first person who speaks next meeting.', 0, 7),
    C('Self-report the next body you find.', 0, 6),
    C('Follow one crewmate the entire next round. Say nothing.', 0),
    C('Defend the most sus player like your life depends on it.', 0),
    T('Random key presses for 30 seconds. Good luck doing tasks.', 'random_keys', 30, 10),
    T('Mouse drift for 30 seconds.', 'mouse_drift', 30, 8),
    T('Mic muted for 10 seconds next meeting.', 'mute_mic', 10, 8),
  ],
  sts2: [
    C('Take the worst card option at the next 3 rewards.', 0, 9),
    C('Skip the next relic. No exceptions.', 0, 7),
    C('Open the next chest. Whatever it is, keep it.', 0, 6),
    C('Play your hand left to right, no thinking, next combat.', 0, 7),
    C('Purge your best card at the next merchant.', 0, 5),
    C('Take the elite path at the next fork.', 0, 6),
    T('Mouse drifts left for 2 turns worth of time (20 seconds).', 'mouse_drift', 20, 9),
    T('Cursor sensitivity maxed for 45 seconds.', 'sensitivity_max', 45, 6),
    T('Random key presses for 20 seconds mid-deckbuild.', 'random_keys', 20, 6),
  ],
  minecraft: [
    C('Sleep is banned for the next night cycle.', 0, 7),
    C('Drop your best tool into lava. Chat picks which.', 0, 6),
    C('Only punch trees, no axe, for 3 minutes.', 180, 7),
    C('Name the next tamed mob whatever chat says.', 0),
    C('Build the next structure with no blocks but dirt.', 0, 6),
    T('Mouse inverted for 45 seconds.', 'invert_mouse', 45, 11),
    T('Crouch locked for 90 seconds. Sneak everywhere.', 'lock_crouch', 90, 9),
    T('Forced jump presses for 30 seconds.', 'force_jump', 30, 8),
    T('Forced walk for 60 seconds.', 'force_walk', 60, 7),
  ],
  lethal_company: [
    C('Lead the way into the next building. No backing out.', 0, 8),
    C('Drop your most valuable scrap and leave it for 60 seconds.', 60, 7),
    C('No flashlight for the next 2 minutes.', 120, 7),
    C('Narrate everything you see until you die or leave.', 0),
    T('Mic muted for 10 seconds. Pick a bad moment.', 'mute_mic', 10, 10),
    T('Mouse inverted for 30 seconds inside the facility.', 'invert_mouse', 30, 10),
    T('Random key presses for 30 seconds.', 'random_keys', 30, 7),
    T('Forced walk for 60 seconds. The monsters are not slow.', 'force_walk', 60, 7),
  ],
  peak: [
    C('Take the worst climbing route at the next fork.', 0, 8),
    C('Carry the heaviest item for the next 3 minutes.', 180, 7),
    C('No stamina items for the next climb.', 0, 6),
    T('Mouse inverted for 30 seconds mid-climb.', 'invert_mouse', 30, 11),
    T('WASD swapped for 45 seconds.', 'swap_wasd', 45, 9),
    T('Forced jump for 20 seconds. On a cliff. Sorry.', 'force_jump', 20, 7),
  ],
  content_warning: [
    C('Film the next monster up close. No running.', 0, 8),
    C('Do a 15-second piece to camera before the next room.', 15, 7),
    C('Be the cameraperson the whole next dive.', 0),
    T('Mic muted for 10 seconds while filming.', 'mute_mic', 10, 10),
    T('Camera drift: mouse drift for 30 seconds.', 'mouse_drift', 30, 9),
    T('Random key presses for 30 seconds.', 'random_keys', 30, 7),
  ],
  phasmophobia: [
    C('Go in alone. Solo the next room.', 0, 9),
    C('No flashlight in the next room. Total dark.', 0, 8),
    C('Say the ghost type out loud and commit. No changing.', 0, 6),
    C('Stay in the room until the next hunt ends. No leaving.', 0, 6),
    T('Mic muted for 10 seconds during the hunt.', 'mute_mic', 10, 10),
    T('Mouse inverted for 30 seconds.', 'invert_mouse', 30, 9),
    T('Flashlight flicker: random key presses for 20 seconds.', 'random_keys', 20, 7),
  ],
  dbd: [
    C('No looping. Hold W only at the next chase.', 0, 7),
    C('Cleanse/bless the next totem even if it is a trap.', 0, 6),
    C('Go for the save even if it is a bad idea.', 0, 7),
    T('Mouse inverted for 30 seconds.', 'invert_mouse', 30, 10),
    T('Look sensitivity maxed for 45 seconds.', 'sensitivity_max', 45, 7),
    T('Forced walk for 30 seconds. In a chase. Brutal.', 'force_walk', 30, 6),
  ],
  eldenring: [
    C('No blocking for the next 2 minutes.', 120, 8),
    C('Two-hand your worst weapon until the next grace.', 0, 6),
    C('No healing for the next 90 seconds.', 90, 7),
    C('Bow to the next enemy before you fight it.', 0),
    T('Mouse inverted for 45 seconds. Maidenless.', 'invert_mouse', 45, 11),
    T('Lock crouch for 60 seconds.', 'lock_crouch', 60, 7),
    T('Random key presses for 20 seconds.', 'random_keys', 20, 7),
  ],
  cyberpunk2077: [
    C('Sell your best iconic weapon at the next drop point.', 0, 6),
    C('Talk to the next NPC in your worst Night City accent.', 0),
    C('No quickhacks for the next 2 minutes. Chrome only.', 120, 7),
    C('Take the dumbest dialogue choice at the next branch.', 0, 7),
    T('Mouse inverted for 45 seconds. Wake up, samurai.', 'invert_mouse', 45, 11),
    T('Sensitivity maxed for 45 seconds.', 'sensitivity_max', 45, 7),
    T('Forced walk for 60 seconds. No sprinting through Watson.', 'force_walk', 60, 7),
  ],
  witcher3: [
    C('No Signs for the next fight. Steel and silver only.', 0, 7),
    C('Drink no potions for the next 3 minutes.', 180, 6),
    C('Play the next Gwent hand with whatever chat tells you.', 0),
    T('Mouse inverted for 30 seconds.', 'invert_mouse', 30, 10),
    T('Forced walk for 45 seconds. Roach is faster than this.', 'force_walk', 45, 7),
    T('Random key presses for 20 seconds mid-cast.', 'random_keys', 20, 6),
  ],
  bg3: [
    C('Take the next fight without your strongest party member.', 0, 7),
    C('Accept the next bad persuasion roll. No reload.', 0, 8),
    C('Let chat pick your next dialogue line.', 0),
    T('Mouse drift for 30 seconds mid-turn.', 'mouse_drift', 30, 9),
    T('Sensitivity maxed for 45 seconds.', 'sensitivity_max', 45, 6),
    T('Random key presses for 20 seconds.', 'random_keys', 20, 6),
  ],
  hades: [
    C('Take the next boon you would never pick.', 0, 8),
    C('No call/cast for the next chamber.', 0, 6),
    C('Two worst weapon aspect until the next death.', 0, 6),
    T('Mouse inverted for 30 seconds. There is no escape.', 'invert_mouse', 30, 10),
    T('Sensitivity maxed for 30 seconds.', 'sensitivity_max', 30, 7),
    T('Random key presses for 20 seconds.', 'random_keys', 20, 6),
  ],
  repo: [
    C('Carry the heaviest valuable to extraction alone.', 0, 8),
    C('No sprinting until the next room is cleared.', 0, 7),
    C('Whatever you grab next, you keep. No swapping.', 0, 6),
    T('Mic muted for 10 seconds. Pick a bad moment.', 'mute_mic', 10, 9),
    T('Mouse inverted for 30 seconds.', 'invert_mouse', 30, 9),
    T('Forced walk for 45 seconds.', 'force_walk', 45, 7),
  ],
  gwyf: [
    C('Bet it all on the next round. No hedging.', 0, 8),
    C('Trust the most untrustworthy player at the table.', 0, 7),
    C('Make the worst play and explain why it was genius.', 0),
    T('Mouse drift for 30 seconds.', 'mouse_drift', 30, 9),
    T('Random key presses for 20 seconds.', 'random_keys', 20, 7),
    T('Mic muted for 10 seconds during negotiations.', 'mute_mic', 10, 7),
  ],
};
