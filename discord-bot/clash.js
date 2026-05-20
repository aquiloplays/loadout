// Clash — slash command dispatch.
//
// One top-level command, `/clash`, with two subgroups + a flat list of
// leaf subcommands. Phase 1 surface:
//
//   /clash status                        — your raider summary
//   /clash army                          — view your trained troops
//   /clash train troop:<id> count:<n>    — train personal troops
//   /clash donate amount:<n>             — donate Bolts to your home town treasury
//   /clash raid kind:<goblin|npc|player> — fire a solo raid
//   /clash log                           — last 10 raids (yours + your town's)
//   /clash notify kind:<…> on:<bool>     — toggle a push-notification kind
//   /clash leaderboard                   — top raiders + top towns
//   /clash town view                     — town state (anyone)
//   /clash town build kind:<id>          — queue a town build (streamer/mods)
//   /clash town garrison troop:<id> count:<n>  — train town garrison (streamer/mods)
//   /clash town pause                    — toggle PvP matchmaking opt-out
//
// War-related subcommands (declare/accept/refuse) are Phase 2.

import { applyVaultDelta, getWallet } from './wallet.js';
import {
  ensureTown, getTown, putTown, getTreasury, addTreasury,
  getArmy, addTroops, consumeTroops,
  getTrophies, adjustTrophies, getPrestige, adjustPrestige,
  pickRaidTarget, getShield, setShield,
  enqueue, walkQueueComplete,
  recordContribution,
  NOTIFY_KINDS, getNotifyMask, setNotifyMask,
  putRaid, appendRaidLog, readRaidLog,
  refreshDefenseSnapshot, getDefenseSnapshot,
  topRaiders, topTowns, topContributors,
  isExcluded,
} from './clash-state.js';
import {
  BUILDINGS, TROOPS_PERSONAL, TROOPS_GARRISON,
  generateNpcTown, generateGoblinCamp,
  personalTroopCost, townBuildCost, townGarrisonCost,
} from './clash-content.js';
import { simulate, computeLoot, computeTrophyDelta } from './clash-raid.js';
import {
  pushRaidIncoming, pushRaidDefended, pushRaidSacked, pushRaidResult,
  pushBuildComplete,
} from './clash-push.js';

const RESP_CHAT = 4;
const FLAG_EPHEMERAL = 64;

function ephemeral(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}
function publicReply(content) {
  return { type: RESP_CHAT, data: { content } };
}

// Walk both queues for this viewer + their home town, fire push for
// anything that completed, apply the effects. Cheap; runs on every
// /clash subcommand so cooldown UX is always honest without a cron.
async function syncCooldowns(env, guildId, userId) {
  // Town queue
  const townDone = await walkQueueComplete(env, 'clash:queue:' + guildId);
  if (townDone.length) {
    const town = await getTown(env, guildId);
    if (town) {
      for (const item of townDone) {
        if (item.kind === 'build' && item.target?.buildingId) {
          const b = town.buildings.find(x => x.id === item.target.buildingId);
          if (b) {
            b.level = item.target.toLevel;
            b.hp = BUILDINGS[b.kind]?.hp?.[b.level] || b.hp;
            b.status = 'idle';
          }
          await pushBuildComplete(env, { guildId, kind: 'town', name: `Town: ${BUILDINGS[item.target.kind]?.name || item.target.kind}` });
        }
        if (item.kind === 'newBuilding' && item.target?.kind) {
          const newId = Math.max(...town.buildings.map(b => b.id)) + 1;
          const place = item.target.kind === 'wall'
            ? findFreeTile(town.buildings, 4, 4, 12, 12, 'wall')
            : findFreeTile(town.buildings, 4, 4, 12, 12, 'tower');
          town.buildings.push({
            id: newId, kind: item.target.kind, level: 1,
            x: place.x, y: place.y,
            hp: BUILDINGS[item.target.kind]?.hp?.[1] || 200,
            status: 'idle',
          });
          town.layoutVersion = (town.layoutVersion || 0) + 1;
          await pushBuildComplete(env, { guildId, kind: 'town', name: `New ${BUILDINGS[item.target.kind]?.name || item.target.kind}` });
        }
        if (item.kind === 'garrison' && item.target?.troopId) {
          town.garrison = town.garrison || {};
          town.garrison[item.target.troopId] = (town.garrison[item.target.troopId] || 0) + item.target.count;
        }
      }
      await putTown(env, guildId, town);
      await refreshDefenseSnapshot(env, guildId);
    }
  }
  // Personal queue
  const personalDone = await walkQueueComplete(env, `clash:trainq:${guildId}:${userId}`);
  if (personalDone.length) {
    for (const item of personalDone) {
      if (item.kind === 'trainPersonal' && item.target?.troopId) {
        await addTroops(env, guildId, userId, item.target.troopId, item.target.count);
        await pushBuildComplete(env, {
          guildId, userId,
          kind: 'personal',
          name: `${item.target.count}× ${TROOPS_PERSONAL[item.target.troopId]?.name || item.target.troopId}`,
        });
      }
    }
  }
}

function findFreeTile(buildings, x0, y0, x1, y1, hint) {
  const occupied = new Set(buildings.map(b => `${b.x},${b.y}`));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!occupied.has(`${x},${y}`)) return { x, y };
    }
  }
  return { x: 8, y: 8 };
}

// Optimistic ack — Discord wants a response within 3s. The actual
// raid simulation completes well inside that, so we just return
// synchronously.

export async function handleClashCommand(env, data, userId, userName) {
  const guildId = data.guild_id;
  if (!guildId) return ephemeral('Run this in a server.');

  // Ensure the town exists. First /clash run in a channel autocreates
  // the town with TH 1 + a couple of walls + a cannon (defaults in
  // ensureTown). The owner is the channel's guild owner (claim record),
  // not the first caller, so the streamer ends up controlling builds.
  const ownerRec = await env.LOADOUT_BOLTS.get('guildowner:' + guildId, { type: 'json' });
  await ensureTown(env, guildId, ownerRec?.discordUserId || userId);
  await syncCooldowns(env, guildId, userId);

  const opts = data.data?.options || [];
  // Discord nests subcommand groups: opts[0] is either a SUB_COMMAND
  // (type 1) leaf or a SUB_COMMAND_GROUP (type 2) wrapping another
  // SUB_COMMAND.
  let group = null;
  let leaf = null;
  let leafOpts = [];
  if (opts.length && opts[0].type === 2) {
    group = opts[0].name;
    const sub = opts[0].options?.[0];
    leaf = sub?.name || '';
    leafOpts = sub?.options || [];
  } else if (opts.length && opts[0].type === 1) {
    leaf = opts[0].name;
    leafOpts = opts[0].options || [];
  } else {
    leaf = '';
  }

  const getOpt = (name) => leafOpts.find(o => o.name === name)?.value;

  if (group === 'town') {
    switch (leaf) {
      case 'view':     return publicReply(await renderTownView(env, guildId));
      case 'build':    return ephemeral(await handleTownBuild(env, guildId, userId, getOpt('kind'), getOpt('building')));
      case 'garrison': return ephemeral(await handleTownGarrison(env, guildId, userId, getOpt('troop'), getOpt('count')));
      case 'pause':    return ephemeral(await handleTownPause(env, guildId, userId));
      default:         return ephemeral('Unknown /clash town subcommand.');
    }
  }

  switch (leaf) {
    case 'status':       return ephemeral(await renderStatus(env, guildId, userId, userName));
    case 'army':         return ephemeral(await renderArmy(env, guildId, userId));
    case 'train':        return ephemeral(await handleTrain(env, guildId, userId, getOpt('troop'), getOpt('count')));
    case 'donate':       return ephemeral(await handleDonate(env, guildId, userId, getOpt('amount')));
    case 'raid':         return publicReply(await handleRaid(env, guildId, userId, userName, getOpt('kind')));
    case 'log':          return ephemeral(await renderLog(env, guildId, userId));
    case 'notify':       return ephemeral(await handleNotify(env, guildId, userId, getOpt('kind'), getOpt('on')));
    case 'leaderboard':  return ephemeral(await renderLeaderboard(env));
    case '':             return ephemeral(await renderStatus(env, guildId, userId, userName));
    default:             return ephemeral('Unknown /clash subcommand: ' + leaf);
  }
}

// ── Renderers ────────────────────────────────────────────────────────

async function renderStatus(env, guildId, userId, userName) {
  const trophies = await getTrophies(env, guildId, userId);
  const army = await getArmy(env, guildId, userId);
  const wallet = await getWallet(env, guildId, userId);
  const town = await getTown(env, guildId);
  const totalTroops = Object.values(army.troops || {}).reduce((a, b) => a + b, 0);
  const tokens = computeRaidTokens(army);
  return [
    `**${userName} — raider profile**`,
    `🏆 Trophies: **${trophies.trophies}**  ·  Tier: ${trophies.tier}  ·  Peak: ${trophies.peak}`,
    `⚡ Bolts: **${wallet.balance}**  ·  🧪 Scrap: ${army.scrap}  ·  ⚙ Cores: ${army.cores}`,
    `🪖 Army: ${totalTroops} troops  ·  🎟 Raid tokens: ${tokens.available}/4 (next +1 in ${tokens.nextInMin}m)`,
    ``,
    `Home town: **${town?.guildId === guildId ? 'this channel' : 'unbound'}** · TH${town?.thLevel || 1} · Prestige ${town?.prestige?.score || 0}`,
    ``,
    `Try: \`/clash train\`, \`/clash raid\`, \`/clash town view\`.`,
  ].join('\n');
}

async function renderArmy(env, guildId, userId) {
  const army = await getArmy(env, guildId, userId);
  if (!Object.keys(army.troops || {}).length) {
    return '🪖 Your army is empty. Train some troops: `/clash train troop:scrapper count:5`';
  }
  const lines = ['**Your army:**'];
  for (const [id, n] of Object.entries(army.troops)) {
    const t = TROOPS_PERSONAL[id];
    lines.push(`• ${t?.glyph || '·'} ${t?.name || id} ×${n}`);
  }
  return lines.join('\n');
}

async function handleTrain(env, guildId, userId, troopId, count) {
  if (!troopId || !TROOPS_PERSONAL[troopId]) return '❌ Unknown troop. Try: scrapper, archerLite, boltKnight, sapperRogue, healerCleric, voltaicMage.';
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const cost = personalTroopCost(troopId, n);
  if (!cost) return '❌ Cost lookup failed.';
  // applyVaultDelta clamps to 0 silently on overdraft — pre-check balance
  // so an under-Bolts viewer gets an honest error instead of a fake
  // "training queued" plus a partial debit.
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < cost.bolts) {
    return `❌ Not enough Bolts. Need ${cost.bolts}, have ${wallet.balance || 0}.`;
  }
  await applyVaultDelta(env, guildId, userId, -cost.bolts, 'clash:train:' + troopId);
  // Wallet was debited. Enqueue the training.
  const item = {
    id: 'trainq:' + Date.now() + ':' + Math.floor(Math.random() * 1e6),
    kind: 'trainPersonal',
    target: { troopId, count: n },
    endsAt: Date.now() + cost.timeMs,
  };
  await enqueue(env, `clash:trainq:${guildId}:${userId}`, item);
  const minutes = Math.ceil(cost.timeMs / 60_000);
  return `✅ Training ${n}× ${TROOPS_PERSONAL[troopId].name}. Ready in ${minutes} min. Cost: ${cost.bolts} bolts.`;
}

async function handleDonate(env, guildId, userId, amount) {
  const n = Math.max(1, Math.floor(Number(amount) || 0));
  if (!n) return '❌ Donate at least 1 Bolt.';
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < n) {
    return `❌ Not enough Bolts. You have ${wallet.balance || 0}.`;
  }
  await applyVaultDelta(env, guildId, userId, -n, 'clash:donate');
  await addTreasury(env, guildId, { bolts: n });
  await recordContribution(env, guildId, userId, n);
  return `💰 Donated **${n}** Bolts to the town treasury. Thank you for your service.`;
}

async function handleRaid(env, guildId, userId, userName, kind) {
  const trophies = await getTrophies(env, guildId, userId);
  const army = await getArmy(env, guildId, userId);
  const tokens = computeRaidTokens(army);
  if (tokens.available < 1) {
    return `🎟 Out of raid tokens. Next in ${tokens.nextInMin} min.`;
  }
  if (Object.keys(army.troops || {}).length === 0) {
    return '🪖 No troops to send. Train some first: `/clash train troop:scrapper count:5`';
  }

  // Consume one token.
  army.lastRaidUtc = Date.now();
  army.tokensSpent = (army.tokensSpent || 0) + 1;
  await env.LOADOUT_BOLTS.put(`clash:army:${guildId}:${userId}`, JSON.stringify(army));

  // Pick target.
  let target;
  let targetSnapshot;
  let targetTier = trophies.tier;
  let targetName = 'NPC town';
  if (kind === 'goblin') {
    const seed = ((+userId || 0) ^ Math.floor(Date.now() / 60_000)) >>> 0;
    targetSnapshot = generateGoblinCamp(seed);
    targetName = 'a goblin camp';
    target = { kind: 'goblin', seed };
  } else if (kind === 'npc') {
    const seed = ((+userId || 0) ^ Math.floor(Date.now() / 600_000)) >>> 0;
    targetSnapshot = generateNpcTown(seed, trophies.tier);
    targetName = 'an NPC town';
    target = { kind: 'npc', seed };
  } else {
    target = await pickRaidTarget(env, guildId, trophies.tier);
    if (target.kind === 'npc') {
      targetSnapshot = generateNpcTown(target.seed, trophies.tier);
      targetName = 'an NPC town (no human in range)';
    } else {
      targetSnapshot = await getDefenseSnapshot(env, target.guildId);
      if (!targetSnapshot) {
        targetSnapshot = await refreshDefenseSnapshot(env, target.guildId);
      }
      const targetTown = await getTown(env, target.guildId);
      targetTier = targetTown?.prestige?.tier || 'bronze';
      targetName = `town in <#${target.guildId}>`;
    }
  }
  if (!targetSnapshot) {
    return '⚠️ No raid target available right now. Try again in a minute.';
  }

  // Resolve a hero deploy from the existing dungeon HeroState.
  const hero = await readHeroForRaid(env, guildId, userId);

  // Snapshot the army at deploy time — they're consumed by the raid.
  const deployedArmy = { ...army.troops };
  await consumeTroops(env, guildId, userId, deployedArmy);

  // Sim.
  const raidId = 'raid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const sim = simulate({ userId, army: deployedArmy, hero }, targetSnapshot, raidId);

  // Loot.
  let defenderTreasury = null;
  if (target.kind === 'town') {
    defenderTreasury = await getTreasury(env, target.guildId);
  } else {
    // PvE: treasury is the camp's reward base
    defenderTreasury = target.kind === 'goblin'
      ? { bolts: 0, scrap: targetSnapshot.rewardScrapBase * (sim.stars + 1), cores: Math.random() < (targetSnapshot.rewardCoresChance * (sim.stars + 1)) ? 1 : 0 }
      : { bolts: 0, scrap: 400, cores: sim.stars === 3 ? 1 : 0 };
  }
  const loot = computeLoot(sim, defenderTreasury, targetTier);

  // Apply loot. Solo raid = 100% to attacker (per design Q's resolution).
  if (target.kind === 'town' && sim.stars > 0) {
    // PvP: move Bolts from defender treasury -> attacker wallet.
    await addTreasury(env, target.guildId, { bolts: -loot.bolts, scrap: -loot.scrap, cores: -loot.cores });
    if (loot.bolts > 0) await applyVaultDelta(env, guildId, userId, loot.bolts, 'clash:raid-loot');
    const a = await getArmy(env, guildId, userId);
    a.scrap = (a.scrap || 0) + loot.scrap;
    a.cores = (a.cores || 0) + loot.cores;
    await env.LOADOUT_BOLTS.put(`clash:army:${guildId}:${userId}`, JSON.stringify(a));
  } else if (target.kind !== 'town' && sim.stars > 0) {
    // PvE: minted Scrap + Cores to attacker; no Bolts.
    const a = await getArmy(env, guildId, userId);
    a.scrap = (a.scrap || 0) + loot.scrap;
    a.cores = (a.cores || 0) + loot.cores;
    await env.LOADOUT_BOLTS.put(`clash:army:${guildId}:${userId}`, JSON.stringify(a));
  }

  // Trophies (PvP only).
  let trophyText = '';
  if (target.kind === 'town') {
    const defTrophies = await getPrestige(env, target.guildId);
    const td = computeTrophyDelta(sim, trophies.tier, defTrophies.tier);
    await adjustTrophies(env, guildId, userId, td.attacker);
    await adjustPrestige(env, target.guildId, td.defender);
    trophyText = `\n🏆 ${td.attacker >= 0 ? '+' : ''}${td.attacker} trophies`;
    // Shields on the loser
    if (sim.stars >= 2) await setShield(env, target.guildId, 12 * 3_600_000, 'sacked');
    else if (sim.stars === 1) await setShield(env, target.guildId, 6 * 3_600_000, 'breached');
  }

  // Receipt + logs.
  const receipt = {
    raidId,
    attackerUserId: userId,
    attackerHomeGuildId: guildId,
    targetKind: target.kind,
    targetGuildId: target.kind === 'town' ? target.guildId : null,
    targetSeed: target.kind !== 'town' ? target.seed : null,
    startedUtc: sim.startedUtc,
    durationMs: sim.durationMs,
    log: sim.log,
    stars: sim.stars,
    pctDestroyed: sim.pctDestroyed,
    thDown: sim.thDown,
    lootBolts: loot.bolts,
    lootScrap: loot.scrap,
    lootCores: loot.cores,
    voltaic: loot.voltaic ? loot.voltaic[2] : null,
    armyLost: sim.armyLost,
  };
  await putRaid(env, receipt);
  await appendRaidLog(env, `clash:raidlog:${guildId}:${userId}`, raidId);
  if (target.kind === 'town') {
    await appendRaidLog(env, `clash:raidlog:${target.guildId}`, raidId);
  }

  // Pushes.
  if (target.kind === 'town') {
    await pushRaidIncoming(env, { guildId: target.guildId, attackerName: userName });
    if (sim.stars >= 2) {
      await pushRaidSacked(env, { guildId: target.guildId, attackerName: userName, stars: sim.stars });
    } else {
      await pushRaidDefended(env, { guildId: target.guildId, attackerName: userName, stars: sim.stars });
    }
  }
  await pushRaidResult(env, { userId, stars: sim.stars, targetName, voltaic: loot.voltaic });

  // Add Voltaic to the hero's dungeon inventory if it dropped.
  if (loot.voltaic) {
    await dropVoltaicToHero(env, guildId, userId, loot.voltaic);
  }

  // Reply.
  const starStr = '★'.repeat(sim.stars) + '☆'.repeat(3 - sim.stars);
  return [
    `**${userName}** raided ${targetName} — **${starStr}** (${Math.round(sim.pctDestroyed * 100)}% destroyed${sim.thDown ? ', TH down' : ''}).`,
    sim.stars > 0
      ? `Loot: ${loot.bolts ? `${loot.bolts}⚡  ` : ''}${loot.scrap}🧪  ${loot.cores}⚙${loot.voltaic ? `  · 🌀 **Voltaic drop:** ${loot.voltaic[2]}` : ''}`
      : `No loot.`,
    trophyText.trim(),
    `Raid id: \`${raidId}\``,
  ].filter(Boolean).join('\n');
}

async function readHeroForRaid(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(`d:hero:${guildId}:${userId}`, { type: 'json' });
  if (!raw) {
    // No dungeon hero — deploy a barebones level-1 warrior champion.
    return { level: 1, cls: 'warrior', atkBonus: 0, defBonus: 0, voltaicPieces: 0 };
  }
  // Count Voltaic pieces equipped — set bonus boosts Champion damage in raids.
  let voltaicPieces = 0;
  for (const slot of ['head', 'chest', 'legs', 'boots', 'weapon', 'trinket']) {
    const itemId = raw.equipped?.[slot];
    if (!itemId) continue;
    const inv = (raw.bag || []).find(i => i.id === itemId);
    if (inv?.setName === 'voltaic') voltaicPieces++;
  }
  // Sum atk/def bonuses from equipped gear. Schema field names match
  // dungeon.js (powerBonus / defenseBonus) — NOT atk/def.
  let atkBonus = 0, defBonus = 0;
  for (const slot of ['head', 'chest', 'legs', 'boots', 'weapon', 'trinket']) {
    const itemId = raw.equipped?.[slot];
    if (!itemId) continue;
    const inv = (raw.bag || []).find(i => i.id === itemId);
    atkBonus += inv?.powerBonus || 0;
    defBonus += inv?.defenseBonus || 0;
  }
  return {
    level: raw.level || 1,
    cls: raw.className || 'warrior',
    atkBonus, defBonus, voltaicPieces,
  };
}

async function dropVoltaicToHero(env, guildId, userId, voltaicRow) {
  // Append the dropped piece to the existing dungeon hero's bag.
  // Schema matches dungeon.js loot inventory at write time
  // (powerBonus / defenseBonus / goldValue) so /equip, /unequip, and
  // /sell work on the drop with zero further wiring.
  const raw = await env.LOADOUT_BOLTS.get(`d:hero:${guildId}:${userId}`, { type: 'json' });
  if (!raw) return;
  raw.bag = raw.bag || [];
  const [slot, rarity, name, glyph, atk, def, gold, setName, weaponType, preferredClass, ability] = voltaicRow;
  raw.bag.push({
    id: 'v_' + Math.random().toString(36).slice(2, 10),
    slot, rarity, name, glyph,
    powerBonus: atk || 0,
    defenseBonus: def || 0,
    goldValue: gold || 0,
    setName: setName || '',
    weaponType: weaponType || '',
    preferredClass: preferredClass || '',
    ability: ability || '',
    foundIn: 'clash',
    foundUtc: new Date().toISOString(),
  });
  raw.lastUpdatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put(`d:hero:${guildId}:${userId}`, JSON.stringify(raw));
}

async function renderLog(env, guildId, userId) {
  const myIds = await readRaidLog(env, `clash:raidlog:${guildId}:${userId}`);
  const townIds = await readRaidLog(env, `clash:raidlog:${guildId}`);
  const lines = ['**Your last 5 raids:**'];
  for (const id of myIds.slice(0, 5)) {
    const r = await env.LOADOUT_BOLTS.get('clash:raid:' + id, { type: 'json' });
    if (!r) continue;
    const stars = '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars);
    const where = r.targetKind === 'town' ? `town:${r.targetGuildId?.slice(-4)}` : r.targetKind;
    lines.push(`• ${stars}  ${where}  ·  ${r.lootBolts}⚡  ${r.lootScrap}🧪${r.voltaic ? ` · 🌀 ${r.voltaic}` : ''}`);
  }
  lines.push('', '**Your town\'s last 5 incoming raids:**');
  for (const id of townIds.slice(0, 5)) {
    const r = await env.LOADOUT_BOLTS.get('clash:raid:' + id, { type: 'json' });
    if (!r) continue;
    const stars = '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars);
    lines.push(`• ${stars}  by <@${r.attackerUserId}>  ·  −${r.lootBolts}⚡`);
  }
  if (myIds.length === 0 && townIds.length === 0) {
    return 'No raids yet. `/clash raid kind:goblin` to get started.';
  }
  return lines.join('\n');
}

async function handleNotify(env, guildId, userId, kind, on) {
  if (!kind || !NOTIFY_KINDS.includes(kind)) {
    return 'Available kinds: ' + NOTIFY_KINDS.map(k => `\`${k.replace('clash.', '')}\``).join(', ');
  }
  const idx = NOTIFY_KINDS.indexOf(kind);
  const mask = await getNotifyMask(env, guildId, userId);
  const next = on === false || on === 'false' ? (mask & ~(1 << idx)) : (mask | (1 << idx));
  await setNotifyMask(env, guildId, userId, next);
  return `🔔 ${on === false ? 'Off' : 'On'}: ${kind}`;
}

async function renderLeaderboard(env) {
  const [raiders, towns] = await Promise.all([
    topRaiders(env, 5),
    topTowns(env, 5),
  ]);
  const lines = ['**🏆 Top raiders**'];
  raiders.forEach((r, i) => lines.push(`${i + 1}. <@${r.userId}> — ${r.trophies}🏆 (${r.tier})`));
  if (raiders.length === 0) lines.push('—');
  lines.push('', '**🏛 Top towns**');
  towns.forEach((t, i) => lines.push(`${i + 1}. \`${t.guildId.slice(-6)}\` — ${t.score} prestige (${t.tier})`));
  if (towns.length === 0) lines.push('—');
  return lines.join('\n');
}

// ── Town subcommands ────────────────────────────────────────────────

async function renderTownView(env, guildId) {
  const town = await getTown(env, guildId);
  const tres = await getTreasury(env, guildId);
  const contribs = await topContributors(env, guildId, 5);
  const lines = [
    `**🏛 Town — TH${town.thLevel}**  ·  Prestige ${town.prestige.score} (${town.prestige.tier})`,
    `Treasury: ${tres.bolts}⚡  ${tres.scrap}🧪  ${tres.cores}⚙  (cap ${tres.capacity}⚡)`,
    '',
    '**Buildings:**',
    ...town.buildings.map(b => `• ${BUILDINGS[b.kind]?.glyph || '·'} ${BUILDINGS[b.kind]?.name || b.kind} L${b.level}${b.status !== 'idle' ? ` (${b.status})` : ''}`),
    '',
    '**Garrison:**',
    ...Object.entries(town.garrison || {}).map(([id, n]) => `• ${TROOPS_GARRISON[id]?.glyph || '·'} ${TROOPS_GARRISON[id]?.name || id} ×${n}`),
    '',
  ];
  if (contribs.length) {
    lines.push('**Top contributors:**');
    contribs.forEach((c, i) => lines.push(`${i + 1}. <@${c.userId}> — ${c.lifetimeBolts}⚡`));
  }
  const shield = await getShield(env, guildId);
  if (shield) {
    const minLeft = Math.max(0, Math.round((shield.endsAt - Date.now()) / 60_000));
    lines.push('', `🛡 Shielded — ${minLeft} min left (${shield.reason})`);
  }
  return lines.join('\n');
}

async function handleTownBuild(env, guildId, userId, kind, buildingId) {
  if (!await canManageTown(env, guildId, userId)) {
    return '🔒 Only the streamer + mods can queue town builds. (Donate Bolts to support the build: `/clash donate amount:<n>`)';
  }
  if (!kind || !BUILDINGS[kind]) {
    return '❌ Unknown building. Try: townhall, wall, cannon, archerTower, trap, storage, barracks.';
  }
  const town = await getTown(env, guildId);
  let targetBuilding = null;
  if (buildingId) {
    targetBuilding = town.buildings.find(b => String(b.id) === String(buildingId));
    if (!targetBuilding) return `❌ No building with id ${buildingId}.`;
    if (targetBuilding.kind !== kind) return `❌ Building #${buildingId} is a ${targetBuilding.kind}, not a ${kind}.`;
  }
  const tres = await getTreasury(env, guildId);

  // Two paths: level up an existing building, OR build a new one of
  // the requested kind. If buildingId provided -> upgrade. Otherwise
  // -> place a new one (the cooldown completes by picking a free tile
  // and adding it to the buildings array).
  if (targetBuilding) {
    const nextLevel = (targetBuilding.level || 1) + 1;
    if (kind === 'townhall' && nextLevel > 10) return '🏰 Town Hall is maxed.';
    const c = townBuildCost(kind, nextLevel);
    if (!c) return '❌ Max level reached.';
    if ((tres.bolts || 0) < (c.cost.bolts || 0) || (tres.scrap || 0) < (c.cost.scrap || 0) || (tres.cores || 0) < (c.cost.cores || 0)) {
      return `❌ Treasury short. Need ${c.cost.bolts}⚡ ${c.cost.scrap || 0}🧪 ${c.cost.cores || 0}⚙. Donations: \`/clash donate amount:<n>\``;
    }
    await addTreasury(env, guildId, { bolts: -(c.cost.bolts || 0), scrap: -(c.cost.scrap || 0), cores: -(c.cost.cores || 0) });
    targetBuilding.status = 'building';
    await putTown(env, guildId, town);
    await enqueue(env, 'clash:queue:' + guildId, {
      id: 'q_' + Date.now(),
      kind: 'build',
      target: { buildingId: targetBuilding.id, kind, toLevel: nextLevel },
      endsAt: Date.now() + c.timeMs,
    });
    const minutes = Math.ceil(c.timeMs / 60_000);
    return `🏗 Upgrading ${BUILDINGS[kind].name} #${targetBuilding.id} → L${nextLevel}. Ready in ${minutes} min.`;
  }

  // New building. v1: just place at first free tile. (Real drag-and-
  // drop layout editor is Phase 4 web.)
  const c = townBuildCost(kind, 1);
  if (!c) return '❌ Cost lookup failed.';
  if ((tres.bolts || 0) < (c.cost.bolts || 0) || (tres.scrap || 0) < (c.cost.scrap || 0)) {
    return `❌ Treasury short. Need ${c.cost.bolts}⚡ ${c.cost.scrap || 0}🧪.`;
  }
  await addTreasury(env, guildId, { bolts: -(c.cost.bolts || 0), scrap: -(c.cost.scrap || 0) });
  await enqueue(env, 'clash:queue:' + guildId, {
    id: 'q_' + Date.now(),
    kind: 'newBuilding',
    target: { kind },
    endsAt: Date.now() + Math.max(60_000, c.timeMs),
  });
  return `🏗 New ${BUILDINGS[kind].name} queued. Ready in ${Math.ceil(c.timeMs / 60_000)} min.`;
}

async function handleTownGarrison(env, guildId, userId, troopId, count) {
  if (!await canManageTown(env, guildId, userId)) {
    return '🔒 Only the streamer + mods can train town garrison.';
  }
  if (!troopId || !TROOPS_GARRISON[troopId]) {
    return '❌ Unknown garrison troop. Try: scrapper, boltKnight, voltaicMage, archerLite.';
  }
  const n = Math.max(1, Math.min(20, Number(count) || 1));
  const cost = townGarrisonCost(troopId, n);
  const tres = await getTreasury(env, guildId);
  if ((tres.bolts || 0) < cost.bolts) {
    return `❌ Treasury short. Need ${cost.bolts}⚡.`;
  }
  await addTreasury(env, guildId, { bolts: -cost.bolts });
  await enqueue(env, 'clash:queue:' + guildId, {
    id: 'q_' + Date.now(),
    kind: 'garrison',
    target: { troopId, count: n },
    endsAt: Date.now() + cost.timeMs,
  });
  return `⛺ Training ${n}× ${TROOPS_GARRISON[troopId].name} for the garrison. Ready in ${Math.ceil(cost.timeMs / 60_000)} min.`;
}

async function handleTownPause(env, guildId, userId) {
  if (!await canManageTown(env, guildId, userId)) {
    return '🔒 Only the streamer + mods can pause matchmaking.';
  }
  const town = await getTown(env, guildId);
  town.matchmakingPaused = !town.matchmakingPaused;
  await putTown(env, guildId, town);
  return town.matchmakingPaused
    ? '⏸ Town is paused — no new PvP raids will be matched against it. In-flight raids still resolve.'
    : '▶ Town is live for PvP matchmaking.';
}

async function canManageTown(env, guildId, userId) {
  const owner = await env.LOADOUT_BOLTS.get('guildowner:' + guildId, { type: 'json' });
  if (owner?.discordUserId === userId) return true;
  const town = await getTown(env, guildId);
  if (town?.ownerUserId === userId) return true;
  if (Array.isArray(town?.modUserIds) && town.modUserIds.includes(userId)) return true;
  return false;
}

// ── Raid tokens ──────────────────────────────────────────────────────
//
// 4 tokens per viewer, 1 regen / 4h. Stateless reconstruction: army
// keeps `lastRaidUtc` + `tokensSpent`. Available = clamp01..4(4 -
// tokensSpent + floor(hours since lastRaid / 4)). Simpler than
// individual token timers and identical behaviour.

function computeRaidTokens(army) {
  const last = army.lastRaidUtc || 0;
  const spent = army.tokensSpent || 0;
  const hoursSince = (Date.now() - last) / 3_600_000;
  const regenned = Math.floor(hoursSince / 4);
  let avail = Math.max(0, Math.min(4, 4 - spent + regenned));
  if (regenned >= 4) {
    // full reset
    avail = 4;
  }
  const minutesSinceRegen = Math.floor((hoursSince - regenned * 4) * 60);
  const nextInMin = Math.max(0, 4 * 60 - minutesSinceRegen);
  return { available: avail, nextInMin };
}
