// /encounter, viewer-facing fun command. Rolls a random event from a
// curated list of fun flavor outcomes.
// Per-user cooldown (10 min) to keep chat from filling with rolls.

import { ephemeral, chat } from './util.js';
// (Bolts economy sunset: removed bolts.js import / bolt award; ensureBootstrap no longer needed)

const COOLDOWN_MIN = 10;
const COOLDOWN_KEY = (uid) => 'encounter_cd:' + uid;

// 28 flavor events. Tune the list freely, the bot doesn't care about
// ordering.
const ENCOUNTERS = [
  // Wins
  { emoji: '💎', text: 'You stumble onto diamond ore!' },
  { emoji: '👑', text: 'You found a royal treasure chest.' },
  { emoji: '🍀', text: 'A four-leaf clover floats by. Lucky.' },
  { emoji: '🪙', text: 'You pick up a pile of loose bolts.' },
  { emoji: '🐟', text: 'You catch a rare fish. The chat is impressed.' },
  { emoji: '🎯', text: 'Critical hit on a passing mob.' },
  { emoji: '✨', text: 'A streamer-shaped figure smiles upon you.' },
  { emoji: '🦊', text: 'A fox darts past, drops something shiny.' },
  // Neutrals
  { emoji: '🌧️', text: 'It starts raining. You stay dry, somehow.' },
  { emoji: '🌅', text: 'You catch a perfect sunrise. Inner peace +1.' },
  { emoji: '🐌', text: 'A snail crosses your path. Surprisingly fast.' },
  { emoji: '🍞', text: 'Half a loaf of bread. Better than nothing.' },
  { emoji: '🪨', text: 'Just a rock. A normal rock.' },
  { emoji: '🦗', text: 'Cricket noises.' },
  // Light losses
  { emoji: '💥', text: 'You stepped on a creeper. Ow.' },
  { emoji: '🦇', text: 'A bat swoops down and steals a bolt.' },
  { emoji: '🌵', text: 'Cactus. You did not see the cactus.' },
  { emoji: '🕳️', text: 'You fall into a hole. You are not okay.' },
  { emoji: '🌶️', text: 'Bit into a pepper meant for someone else.' },
  { emoji: '🐝', text: 'A bee. You panic. The bee panics. Everyone panics.' },
  // Bigger losses
  { emoji: '☠️', text: 'A skeleton arches its bow. Yikes.' },
  { emoji: '👻', text: 'Ghost steals your wallet. Mostly empty though.' },
  { emoji: '🧊', text: 'Slipped on ice. Embarrassing.' },
  // Big wins
  { emoji: '🎰', text: 'JACKPOT! ... well, mini-jackpot.' },
  { emoji: '💸', text: 'A passing patron throws bolts at you.' },
  { emoji: '🏆', text: 'Achievement unlocked: clicked /encounter.' },
  { emoji: '⚡', text: 'A lightning bolt strikes a nearby chest. Free bolts!' },
  { emoji: '🦄', text: 'A unicorn nods at you. You are now blessed.' }
];

function rollEncounter() {
  return ENCOUNTERS[Math.floor(Math.random() * ENCOUNTERS.length)];
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

  // (Bolts economy sunset: removed bolt award)

  return chat({
    embeds: [{
      title: e.emoji + ' Encounter',
      description: '**' + e.text + '**',
      color: 0x5865F2,   // blurple
      footer: { text: '/encounter · ' + COOLDOWN_MIN + ' min cooldown' }
    }]
  });
}
