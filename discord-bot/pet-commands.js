// /pet slash command tree — adopt / view / feed / play / clean /
// rename / release. Pet care + cosmetic state lives in pet.js;
// this file is the Discord-side wiring.
//
// All Bolts-spending actions go through the shared wallet path
// inside pet.js so the recap + bolts-feed digests pick them up the
// same way other features do.

import {
  adoptPet, getPet, computeMood,
  feedPet, playWithPet, cleanPet,
  renamePet, releasePet,
  patreonTierFor, unlockedColoursForTier,
  SPECIES, SPECIES_COLOURS,
} from './pet.js';

const RESP_CHAT      = 4;
const FLAG_EPHEMERAL = 64;

function ephemeral(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}
function publicReply(content, embeds, components) {
  const data = { content };
  if (embeds) data.embeds = embeds;
  if (components) data.components = components;
  return { type: RESP_CHAT, data };
}

function petPreviewUrl(env, guildId, userId, opts) {
  const base = (env && env.PUBLIC_WORKER_URL) || 'https://loadout-discord.aquiloplays.workers.dev';
  // Reuse the character render — pet renders in-frame at z=15. ?v=
  // bumps from pet care to bust Discord's embed cache.
  const v = opts?.v ?? Date.now();
  return `${base}/character/render/${guildId}/${userId}.png?v=${v}`;
}

function moodEmoji(mood) {
  if (!mood) return '';
  if (mood.label === 'happy') return '😺';
  if (mood.label === 'content') return '😌';
  if (mood.hint === 'hungry') return '😋';
  if (mood.hint === 'dirty') return '🧼';
  return '🥲';
}

function statsLine(mood) {
  if (!mood) return '';
  const bar = (v) => {
    const filled = Math.round(v / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };
  return [
    `🍖 Hunger:      \`${bar(mood.stats.hunger)}\``,
    `🎾 Happiness:   \`${bar(mood.stats.happiness)}\``,
    `🧼 Cleanliness: \`${bar(mood.stats.cleanliness)}\``,
  ].join('\n');
}

// ── Subcommand dispatch ──────────────────────────────────────────
export async function handlePetCommand(env, data) {
  const guildId = data.guild_id;
  const userId = data?.member?.user?.id || data?.user?.id;
  if (!guildId || !userId) return ephemeral('Run this in a server.');

  const opts = data.data?.options || [];
  const sub = opts[0]?.name;
  const subOpts = opts[0]?.options || [];
  const getOpt = (name) => subOpts.find(o => o.name === name)?.value;

  switch (sub) {
    case 'adopt':   return doAdopt(env, guildId, userId, getOpt('species'), getOpt('colour'), getOpt('name'));
    case 'view':    return doView(env, guildId, userId);
    case 'feed':    return doCare(env, guildId, userId, 'feed');
    case 'play':    return doCare(env, guildId, userId, 'play');
    case 'clean':   return doCare(env, guildId, userId, 'clean');
    case 'rename':  return doRename(env, guildId, userId, getOpt('name'));
    case 'release': return doRelease(env, guildId, userId);
    default:        return ephemeral('Unknown /pet subcommand.');
  }
}

async function doAdopt(env, guildId, userId, species, colour, name) {
  const tier = await patreonTierFor(env, guildId, userId);
  if (tier === 0) {
    return ephemeral('🔒 Pets are a Patreon perk. Link your Patreon via `/loadout` first.');
  }
  if (!SPECIES.includes(species)) {
    return ephemeral('❌ Species options: ' + SPECIES.join(', '));
  }
  const colours = unlockedColoursForTier(species, tier);
  if (!colours.includes(colour)) {
    return ephemeral(`❌ Unlocked ${species} colours for your tier: ${colours.join(', ')}.`);
  }
  const r = await adoptPet(env, guildId, userId, species, colour, name);
  if (!r.ok) {
    if (r.error === 'already-have-pet') {
      const m = computeMood(r.pet);
      return ephemeral(`You already have **${r.pet.name}** the ${r.pet.colour} ${r.pet.species} ${moodEmoji(m)}. Use \`/pet release\` first to swap.`);
    }
    if (r.error === 'release-cooldown') {
      return ephemeral(`⏳ Re-adoption is on cooldown for ${r.hours} more hour${r.hours === 1 ? '' : 's'}.`);
    }
    if (r.error === 'not-a-patron') {
      return ephemeral('🔒 Active Patreon link required.');
    }
    if (r.error === 'colour-locked') {
      return ephemeral(`🔒 That colour unlocks at Patreon tier ${r.tierNeeded}.`);
    }
    return ephemeral('❌ Adoption failed: ' + r.error);
  }
  const m = computeMood(r.pet);
  return publicReply(
    `🎉 Adopted **${r.pet.name}** the ${r.pet.colour} ${r.pet.species} ${moodEmoji(m)}!`,
    [{
      image: { url: petPreviewUrl(env, guildId, userId, { v: Date.now() }) },
      color: 0x7c5cff,
      description: statsLine(m),
    }],
  );
}

async function doView(env, guildId, userId) {
  const pet = await getPet(env, guildId, userId);
  if (!pet) return ephemeral('🐾 No pet yet. Patrons can `/pet adopt`.');
  const m = computeMood(pet);
  return publicReply(
    `**${pet.name}** — ${pet.colour} ${pet.species} ${moodEmoji(m)}`,
    [{
      image: { url: petPreviewUrl(env, guildId, userId, { v: Date.now() }) },
      color: 0x7c5cff,
      description: statsLine(m),
    }],
  );
}

async function doCare(env, guildId, userId, action) {
  const fn = action === 'feed' ? feedPet : action === 'play' ? playWithPet : cleanPet;
  const r = await fn(env, guildId, userId);
  if (!r.ok) {
    if (r.error === 'no-pet') return ephemeral('🐾 No pet yet. Patrons can `/pet adopt`.');
    if (r.error === 'cooldown') return ephemeral(`⏳ Can ${action} again in ${r.waitMin} min.`);
    if (r.error === 'insufficient-bolts') return ephemeral(`❌ Need ${r.need} Bolts (you have ${r.have}).`);
    return ephemeral('❌ Action failed: ' + r.error);
  }
  const m = r.mood;
  const verb = action === 'feed' ? '🍖 Fed' : action === 'play' ? '🎾 Played with' : '🧼 Cleaned';
  return publicReply(
    `${verb} **${r.pet.name}** ${moodEmoji(m)} (spent ${r.spent} Bolts)`,
    [{
      image: { url: petPreviewUrl(env, guildId, userId, { v: Date.now() }) },
      color: 0x7c5cff,
      description: statsLine(m),
    }],
  );
}

async function doRename(env, guildId, userId, newName) {
  const r = await renamePet(env, guildId, userId, newName);
  if (!r.ok) {
    if (r.error === 'no-pet') return ephemeral('🐾 No pet yet.');
    return ephemeral('❌ Bad name (1–16 chars).');
  }
  return ephemeral(`📝 Renamed to **${r.pet.name}**.`);
}

async function doRelease(env, guildId, userId) {
  const r = await releasePet(env, guildId, userId);
  if (!r.ok) return ephemeral('🐾 No pet to release.');
  return ephemeral(`👋 Released **${r.released.name}** the ${r.released.species}. 24h cooldown before adopting again.`);
}
