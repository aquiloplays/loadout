// /encounter — viewer-facing fun command. Rolls a random event from a
// curated list; some events award bolts, some deduct, some are neutral.
// Per-user cooldown (10 min) to keep chat from filling with rolls.
// Bolts are credited via the Loadout wallet (shared with counting.js).

import { ephemeral, chat } from './util.js';
import { ensureBootstrap } from './bootstrap.js';
import { applyBolts } from './bolts.js';

const COOLDOWN_MIN = 10;
const COOLDOWN_KEY = (uid) => 'encounter_cd:' + uid;

// 28 events. Bolt math is roughly zero-sum across the table so heavy
// rolling doesn't either blow the wallet up or grind it to dust. Tune
// the list freely — the bot doesn't care about ordering.
const ENCOUNTERS = [
  // Wins
  { emoji: '💎', text: 'You stumble onto diamond ore!',                                    bolts:  20 },
  { emoji: '👑', text: 'You found a royal treasure chest.',                                bolts:  25 },
  { emoji: '🍀', text: 'A four-leaf clover floats by. Lucky.',                             bolts:  10 },
  { emoji: '🪙', text: 'You pick up a pile of loose bolts.',                               bolts:  15 },
  { emoji: '🐟', text: 'You catch a rare fish. The chat is impressed.',                    bolts:   8 },
  { emoji: '🎯', text: 'Critical hit on a passing mob.',                                   bolts:  12 },
  { emoji: '✨', text: 'A streamer-shaped figure smiles upon you.',                        bolts:   7 },
  { emoji: '🦊', text: 'A fox darts past — drops something shiny.',                        bolts:   5 },
  // Neutrals
  { emoji: '🌧️', text: 'It starts raining. You stay dry, somehow.',                       bolts:   0 },
  { emoji: '🌅', text: 'You catch a perfect sunrise. Inner peace +1.',                     bolts:   0 },
  { emoji: '🐌', text: 'A snail crosses your path. Surprisingly fast.',                    bolts:   1 },
  { emoji: '🍞', text: 'Half a loaf of bread. Better than nothing.',                       bolts:   1 },
  { emoji: '🪨', text: 'Just a rock. A normal rock.',                                      bolts:   0 },
  { emoji: '🦗', text: 'Cricket noises.',                                                  bolts:   0 },
  // Light losses
  { emoji: '💥', text: 'You stepped on a creeper. Ow.',                                    bolts:  -3 },
  { emoji: '🦇', text: 'A bat swoops down and steals a bolt.',                             bolts:  -2 },
  { emoji: '🌵', text: 'Cactus. You did not see the cactus.',                              bolts:  -4 },
  { emoji: '🕳️', text: 'You fall into a hole. You are not okay.',                         bolts:  -5 },
  { emoji: '🌶️', text: 'Bit into a pepper meant for someone else.',                       bolts:  -2 },
  { emoji: '🐝', text: 'A bee. You panic. The bee panics. Everyone panics.',               bolts:  -4 },
  // Bigger losses
  { emoji: '☠️', text: 'A skeleton arches its bow. Yikes.',                                bolts: -10 },
  { emoji: '👻', text: 'Ghost steals your wallet. Mostly empty though.',                   bolts:  -8 },
  { emoji: '🧊', text: 'Slipped on ice. Embarrassing.',                                    bolts:  -6 },
  // Big wins
  { emoji: '🎰', text: 'JACKPOT! ... well, mini-jackpot.',                                 bolts:  35 },
  { emoji: '💸', text: 'A passing patron throws bolts at you.',                            bolts:  18 },
  { emoji: '🏆', text: 'Achievement unlocked: clicked /encounter.',                        bolts:  14 },
  { emoji: '⚡', text: 'A lightning bolt strikes a nearby chest. Free bolts!',             bolts:  22 },
  { emoji: '🦄', text: 'A unicorn nods at you. You are now blessed.',                      bolts:  16 }
];

function rollEncounter() {
  return ENCOUNTERS[Math.floor(Math.random() * ENCOUNTERS.length)];
}

function color(bolts) {
  if (bolts > 0)  return 0x57F287;   // green
  if (bolts < 0)  return 0xED4245;   // red
  return 0x5865F2;                    // blurple (neutral)
}

export async function handleEncounterCommand(data, env) {
  const userId = data.member?.user?.id || data.user?.id;
  if (!userId) return ephemeral('Couldn\'t identify you.');

  // Cooldown gate
  const cdKey = COOLDOWN_KEY(userId);
  const last = await env.STATE.get(cdKey);
  if (last) {
    const elapsed = Date.now() - parseInt(last, 10);
    const cdMs = COOLDOWN_MIN * 60 * 1000;
    if (elapsed < cdMs) {
      const leftSec = Math.ceil((cdMs - elapsed) / 1000);
      const leftMin = Math.floor(leftSec / 60);
      const leftS = leftSec % 60;
      const human = leftMin > 0 ? leftMin + 'm ' + leftS + 's' : leftS + 's';
      return ephemeral('⏱️ You can /encounter again in **' + human + '**.');
    }
  }

  const e = rollEncounter();
  await env.STATE.put(cdKey, String(Date.now()), { expirationTtl: COOLDOWN_MIN * 60 });

  // Apply bolts (positive or negative; zero = no-op).
  let boltResult = null;
  if (e.bolts !== 0) {
    const guildId = await ensureBootstrap(env);
    boltResult = await applyBolts(env, guildId, userId, e.bolts, 'encounter');
  }

  const sign = e.bolts > 0 ? '+' : '';
  const boltLine = e.bolts === 0
    ? '_no bolt change_'
    : '🪙 ' + sign + e.bolts + ' bolt' + (Math.abs(e.bolts) === 1 ? '' : 's') +
      (boltResult?.balance != null ? ' · balance: ' + boltResult.balance : '');

  return chat({
    embeds: [{
      title: e.emoji + ' Encounter',
      description: '**' + e.text + '**\n\n' + boltLine,
      color: color(e.bolts),
      footer: { text: '/encounter · ' + COOLDOWN_MIN + ' min cooldown' }
    }]
  });
}
