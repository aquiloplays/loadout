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
  enqueue, walkQueueComplete, getQueue,
  recordContribution,
  NOTIFY_KINDS, getNotifyMask, setNotifyMask,
  putRaid, appendRaidLog, readRaidLog,
  refreshDefenseSnapshot, getDefenseSnapshot,
  topRaiders, topTowns, topContributors,
  isExcluded,
  getActiveDefenderChampion, grantBattlePlan, spendBattlePlan, MAX_BATTLE_PLANS,
} from './clash-state.js';
import {
  BUILDINGS, TROOPS_PERSONAL, TROOPS_GARRISON,
  generateNpcTown, generateGoblinCamp,
  personalTroopCost, townBuildCost, townGarrisonCost,
  TH_HERO_GATE,
} from './clash-content.js';
import { simulate, computeLoot, computeTrophyDelta } from './clash-raid.js';
import {
  pushRaidIncoming, pushRaidDefended, pushRaidSacked, pushRaidResult,
  pushBuildComplete,
  pushWarDeclared, pushWarAccepted, pushWarRefused, pushWarCancelled, pushWarEnded,
} from './clash-push.js';
import {
  declareWar, castVote, staffOverride, advanceWar, recordWarRaid,
  findActiveWarForRaid, getActiveWarId, getWar, getWarCooldown, getWarBadge,
  STATE as WAR_STATE,
} from './clash-war.js';
import { appendClashEvent } from './clash-http.js';

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

  // Ensure the channel's town exists. ONE communal town per server,
  // keyed by guildId — not per-viewer. The town's owner is the
  // streamer who ran /loadout-claim (the guildowner record); viewers
  // can donate + raid but can't build or train the garrison.
  //
  // We refuse to autocreate the town before /loadout-claim has run,
  // otherwise a random first-time viewer would pin their user id into
  // the town's ownerUserId field. The streamer will still control
  // builds via the guildowner record either way (canManageTown checks
  // both), but the town record should never list a non-streamer as
  // its owner.
  const ownerRec = await env.LOADOUT_BOLTS.get('guildowner:' + guildId, { type: 'json' });
  if (!ownerRec?.discordUserId) {
    return ephemeral(
      'This server isn\'t bound to a Loadout install yet — Clash can\'t open until the streamer runs `/loadout-claim` with their bind code.'
    );
  }
  await ensureTown(env, guildId, ownerRec.discordUserId);
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
      case 'designate-defender':
                       return ephemeral(await handleDefenderDesignate(env, guildId, userId, getOpt('user')));
      case 'clear-defender':
                       return ephemeral(await handleDefenderClear(env, guildId, userId));
      case 'skip':     return ephemeral(await handleSkipCooldown(env, guildId, userId));
      default:         return ephemeral('Unknown /clash town subcommand.');
    }
  }
  if (group === 'defender') {
    switch (leaf) {
      case 'accept':  return ephemeral(await handleDefenderAccept(env, guildId, userId));
      case 'decline': return ephemeral(await handleDefenderDecline(env, guildId, userId));
      default:        return ephemeral('Unknown /clash defender subcommand.');
    }
  }
  if (group === 'war') {
    switch (leaf) {
      case 'declare': return handleWarDeclare(env, guildId, userId, getOpt('target'));
      case 'view':    return publicReply(await renderWarView(env, guildId));
      case 'accept':  return ephemeral(await handleWarStaff(env, guildId, userId, 'accept'));
      case 'refuse':  return ephemeral(await handleWarStaff(env, guildId, userId, 'refuse'));
      case 'history': return ephemeral(await renderWarHistory(env, guildId));
      default:        return ephemeral('Unknown /clash war subcommand.');
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
  // Treasury caps Bolts at its capacity. Donating into a full
  // treasury would silently drop the donation (`addTreasury` clamps
  // at cap) while still debiting the viewer's wallet — UX trap.
  // Clamp the accepted donation here, refuse the rest with a clear
  // message that points the streamer at the Storage upgrade.
  const tres = await getTreasury(env, guildId);
  const headroom = Math.max(0, (tres.capacity || 0) - (tres.bolts || 0));
  if (headroom === 0) {
    return `🏛 Treasury is full (${tres.bolts}/${tres.capacity}⚡). Streamer/mods can upgrade Storage to raise the cap.`;
  }
  const accepted = Math.min(n, headroom);
  await applyVaultDelta(env, guildId, userId, -accepted, 'clash:donate');
  await addTreasury(env, guildId, { bolts: accepted });
  await recordContribution(env, guildId, userId, accepted);
  if (accepted < n) {
    return `💰 Donated **${accepted}** Bolts (treasury cap hit). The other ${n - accepted} stayed in your wallet — Storage upgrade raises the cap.`;
  }
  return `💰 Donated **${accepted}** Bolts to the town treasury. Thank you for your service.`;
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

  // Phase 3: defender Champion (only when the target is a real town
  // with an active War Tent + accepted defender — never on NPCs or
  // goblins).
  let defenderHeroPack = null;
  if (target.kind === 'town') {
    defenderHeroPack = await readDefenderHeroForRaid(env, target.guildId);
  }

  // Sim.
  const raidId = 'raid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const sim = simulate({ userId, army: deployedArmy, hero }, targetSnapshot, raidId, {
    defenderHero: defenderHeroPack?.hero || null,
    tentHpMult: defenderHeroPack?.tentHpMult || 1.0,
  });

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
  // If this is a war-pairing raid (attacker home guild + target match
  // an active war), apply amplified loot/trophies and bank the stars
  // into the war's running score.
  const { warAmplify } = (target.kind === 'town')
    ? await applyWarAmplification(env, guildId, target.guildId)
    : { warAmplify: false };
  const loot = computeLoot(sim, defenderTreasury, targetTier, { warAmplify });

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
    // Battle Plan drop (Phase 3) — 8% chance on NPC town clears,
    // 3% chance on goblin camps. Goes to the attacker's home town
    // pool (capped at MAX_BATTLE_PLANS). Solo PvE feeds the
    // community in a small but visible way.
    const dropChance = target.kind === 'npc' ? 0.08 : 0.03;
    if (sim.stars >= 2 && Math.random() < dropChance) {
      await grantBattlePlan(env, guildId);
    }
  }

  // Trophies (PvP only). War amplification scales the deltas 1.5x.
  let trophyText = '';
  if (target.kind === 'town') {
    const defTrophies = await getPrestige(env, target.guildId);
    const td = computeTrophyDelta(sim, trophies.tier, defTrophies.tier, { warAmplify });
    await adjustTrophies(env, guildId, userId, td.attacker);
    await adjustPrestige(env, target.guildId, td.defender);
    trophyText = `\n🏆 ${td.attacker >= 0 ? '+' : ''}${td.attacker} trophies${warAmplify ? ' (war ×1.5)' : ''}`;
    // Shields on the loser — but NOT during an active war pairing,
    // otherwise a single sacking would end the war early.
    if (!warAmplify) {
      if (sim.stars >= 2) await setShield(env, target.guildId, 12 * 3_600_000, 'sacked');
      else if (sim.stars === 1) await setShield(env, target.guildId, 6 * 3_600_000, 'breached');
    }
  }

  // War scoring (if applicable). Banks stars into the war's running
  // total; may close the war if the active window has just expired.
  if (warAmplify && target.kind === 'town') {
    const ended = await recordWarRaidIfAny(env, guildId, target.guildId, raidId, sim.stars);
    if (ended?.state === WAR_STATE.COMPLETED) {
      trophyText += `\n⚔ War ended — score ${ended.scores.attacker}★ vs ${ended.scores.defender}★, winner: ${ended.winner}`;
    }
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

  // Pushes + local-bus ring-buffer events. The DLL polls
  // /sync/<guildId>/clash-events to republish on the Aquilo Bus,
  // which drives the OBS browser-source raid-alert overlay.
  if (target.kind === 'town') {
    await pushRaidIncoming(env, { guildId: target.guildId, attackerName: userName });
    await appendClashEvent(env, target.guildId, 'raid.incoming', {
      attackerUserId: userId, attackerName: userName, raidId,
      stars: sim.stars, war: warAmplify,
    });
    if (sim.stars >= 2) {
      await pushRaidSacked(env, { guildId: target.guildId, attackerName: userName, stars: sim.stars });
      await appendClashEvent(env, target.guildId, 'raid.sacked', { attackerUserId: userId, attackerName: userName, stars: sim.stars, raidId });
    } else {
      await pushRaidDefended(env, { guildId: target.guildId, attackerName: userName, stars: sim.stars });
      await appendClashEvent(env, target.guildId, 'raid.defended', { attackerUserId: userId, attackerName: userName, stars: sim.stars, raidId });
    }
  }
  await pushRaidResult(env, { userId, stars: sim.stars, targetName, voltaic: loot.voltaic });
  // Also surface the attacker's result on their home channel's
  // bus — useful for an "outgoing raid result" overlay.
  await appendClashEvent(env, guildId, 'raid.result', {
    userId, userName, stars: sim.stars, targetName,
    targetGuildId: target.kind === 'town' ? target.guildId : null,
    raidId, voltaic: loot.voltaic ? loot.voltaic[2] : null,
  });

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
    // Hero-level gate on TH tiers (Phase 3) — the community needs at
    // least one hero meeting the threshold before upgrading. Forces
    // them to engage with dungeons for late-game town power.
    if (kind === 'townhall' && TH_HERO_GATE[nextLevel]) {
      const need = TH_HERO_GATE[nextLevel];
      const best = await highestHeroLevelInGuild(env, guildId);
      if (best < need) {
        return `🔒 TH${nextLevel} needs at least one community hero at level ${need}. Highest right now: L${best}. Train more in the dungeon.`;
      }
    }
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

// ── War subcommands (Phase 2) ────────────────────────────────────────

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON     = 2;
const STYLE_PRIMARY        = 1;
const STYLE_SECONDARY      = 2;
const STYLE_SUCCESS        = 3;
const STYLE_DANGER         = 4;

async function handleWarDeclare(env, guildId, userId, targetGuildId) {
  if (!await canManageTown(env, guildId, userId)) {
    return ephemeral('🔒 Only the streamer + mods can declare wars.');
  }
  if (!targetGuildId || !/^\d{6,30}$/.test(String(targetGuildId).trim())) {
    return ephemeral('❌ Target must be a guild id. Find one via `/clash leaderboard`.');
  }
  const r = await declareWar(env, guildId, String(targetGuildId).trim(), userId);
  if (r.error) return ephemeral('❌ ' + (r.message || r.error));
  const war = r.war;
  // Public post in the attacker's channel with vote buttons.
  return {
    type: 4,
    data: {
      content:
        `⚔ **War declared** — vote to confirm.\n` +
        `Target: \`${targetGuildId}\`.  Vote ends in 10 min.  Need at least ${3} voters with majority **Yes** to proceed.`,
      components: warVoteRow(war.warId, 'declare'),
    },
  };
}

async function renderWarView(env, guildId) {
  const warId = await getActiveWarId(env, guildId);
  if (!warId) {
    const cd = await getWarCooldown(env, guildId);
    const badge = await getWarBadge(env, guildId);
    const lines = ['No active war.'];
    if (cd) lines.push(`Cooldown ends in ${Math.ceil((cd.until - Date.now()) / 60_000)} min.`);
    if (badge) lines.push(`🏅 **Victorious** banner active until <t:${Math.floor(badge.expiresUtc / 1000)}:R>.`);
    return lines.join('\n');
  }
  let war = await getWar(env, warId);
  war = await advanceWar(env, war);
  const lines = [`**War ${war.warId.slice(-8)}** — ${war.state}`];
  lines.push(`Attacker: \`${war.attackerGuildId}\``);
  lines.push(`Defender: \`${war.defenderGuildId}\``);
  if (war.state === WAR_STATE.DECLARING) {
    const yes = war.declareVotes.yes.length;
    const no = war.declareVotes.no.length;
    lines.push(`🗳 Declaration vote: ${yes} Yes / ${no} No  ·  ends <t:${Math.floor(war.declarationEndsUtc / 1000)}:R>`);
  } else if (war.state === WAR_STATE.PENDING_ACCEPT) {
    const a = war.acceptVotes.accept.length;
    const r = war.acceptVotes.refuse.length;
    lines.push(`🗳 Accept/refuse vote: ${a} Accept / ${r} Refuse  ·  ends <t:${Math.floor(war.acceptEndsUtc / 1000)}:R>`);
  } else if (war.state === WAR_STATE.ACTIVE) {
    lines.push(`⚔ Live war  ·  ends <t:${Math.floor(war.activeEndsUtc / 1000)}:R>`);
    lines.push(`Score: **${war.scores.attacker}★** (attacker) vs **${war.scores.defender}★** (defender)`);
    lines.push(`Raids landed: ${war.raids.length}`);
  } else {
    lines.push(`Final score: ${war.scores.attacker}★ vs ${war.scores.defender}★`);
    lines.push(`Winner: ${war.winner || '—'}`);
  }
  // Surface a button row for the current phase.
  const components = (war.state === WAR_STATE.DECLARING)
    ? warVoteRow(war.warId, 'declare')
    : (war.state === WAR_STATE.PENDING_ACCEPT)
      ? warVoteRow(war.warId, 'accept')
      : [];
  return { type: 4, data: { content: lines.join('\n'), components } };
}

async function handleWarStaff(env, guildId, userId, action) {
  if (!await canManageTown(env, guildId, userId)) {
    return '🔒 Only the streamer + mods can override the community vote.';
  }
  const warId = await getActiveWarId(env, guildId);
  if (!warId) return 'No active war.';
  let war = await getWar(env, warId);
  if (!war) return 'No active war.';
  // Determine side
  const side = guildId === war.attackerGuildId ? 'attacker'
             : guildId === war.defenderGuildId ? 'defender'
             : null;
  if (!side) return 'Not a participant.';
  if (action === 'accept' || action === 'refuse') {
    if (side !== 'defender') return 'Only the defender can accept/refuse.';
    const r = await staffOverride(env, warId, 'defender', action);
    if (r?.error) return r.error;
    war = r;
    if (war.state === WAR_STATE.ACTIVE) {
      await pushWarAccepted(env, { attackerGuildId: war.attackerGuildId, defenderGuildId: war.defenderGuildId, endsUtc: war.activeEndsUtc });
      return `✅ War accepted. 24h window now open.`;
    }
    if (war.state === WAR_STATE.REFUSED) {
      await pushWarRefused(env, { attackerGuildId: war.attackerGuildId, defenderGuildId: war.defenderGuildId });
      return `❌ War refused.`;
    }
  }
  return 'Nothing to do.';
}

async function renderWarHistory(env, guildId) {
  // KV doesn't index by guild, so we list and filter. Cheap because
  // wars are rare and 60d TTL caps the total count.
  const lines = ['**Recent wars:**'];
  let cursor;
  let shown = 0;
  for (let i = 0; i < 3 && shown < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'clash:war:', cursor, limit: 1000 });
    for (const k of r.keys) {
      if (shown >= 5) break;
      const w = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!w) continue;
      if (w.attackerGuildId !== guildId && w.defenderGuildId !== guildId) continue;
      const role = w.attackerGuildId === guildId ? 'attacker' : 'defender';
      const stamp = `<t:${Math.floor((w.completedUtc || w.declaredUtc) / 1000)}:R>`;
      lines.push(`• ${stamp}  ·  ${role}  ·  ${w.state}  ·  ${w.scores.attacker}★ vs ${w.scores.defender}★${w.winner ? ` · winner: ${w.winner}` : ''}`);
      shown++;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  if (shown === 0) return 'No wars yet.';
  return lines.join('\n');
}

function warVoteRow(warId, phase) {
  if (phase === 'declare') {
    return [{
      type: COMPONENT_ACTION_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: STYLE_SUCCESS,   label: '✅ Yes — declare', custom_id: `clash:war:vote:${warId}:declare:yes` },
        { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '❌ No', custom_id: `clash:war:vote:${warId}:declare:no` },
        { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '👁 View war', custom_id: `clash:war:view:${warId}` },
      ],
    }];
  }
  if (phase === 'accept') {
    return [{
      type: COMPONENT_ACTION_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: STYLE_SUCCESS,   label: '⚔ Accept war', custom_id: `clash:war:vote:${warId}:accept:accept` },
        { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '🛡 Refuse', custom_id: `clash:war:vote:${warId}:accept:refuse` },
        { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '👁 View war', custom_id: `clash:war:view:${warId}` },
      ],
    }];
  }
  return [];
}

// ── Component handler — war vote buttons ────────────────────────────
//
// Routed by commands.js for any custom_id that starts with "clash:".
// We only handle "clash:war:*" prefixes here; future Clash component
// surfaces (raid replay viewers etc.) can branch off this same entry.

export async function handleClashComponent(env, data) {
  const cid = data.data?.custom_id || '';
  if (!cid.startsWith('clash:war:')) {
    return ephemeral('Unknown Clash component.');
  }
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');

  // clash:war:vote:<warId>:<phase>:<choice>
  if (cid.startsWith('clash:war:vote:')) {
    const parts = cid.split(':');
    const warId = parts[3];
    const phase = parts[4];       // declare | accept
    const choice = parts[5];      // yes | no | accept | refuse
    const before = await getWar(env, warId);
    const r = await castVote(env, warId, userId, guildId, choice);
    if (r.error) return ephemeral('❌ ' + (r.message || r.error));
    const war = r.war;
    // Side-effects: if the vote tripped a state transition, fire the
    // matching push.
    if (before && before.state !== war.state) {
      if (war.state === WAR_STATE.PENDING_ACCEPT) {
        await pushWarDeclared(env, { attackerGuildId: war.attackerGuildId, defenderGuildId: war.defenderGuildId });
        await appendClashEvent(env, war.defenderGuildId, 'war.declared', { warId: war.warId, attackerGuildId: war.attackerGuildId });
        await appendClashEvent(env, war.attackerGuildId, 'war.declaration.passed', { warId: war.warId, defenderGuildId: war.defenderGuildId });
      } else if (war.state === WAR_STATE.ACTIVE) {
        await pushWarAccepted(env, { attackerGuildId: war.attackerGuildId, defenderGuildId: war.defenderGuildId, endsUtc: war.activeEndsUtc });
        await appendClashEvent(env, war.attackerGuildId, 'war.active', { warId: war.warId, defenderGuildId: war.defenderGuildId, endsUtc: war.activeEndsUtc });
        await appendClashEvent(env, war.defenderGuildId, 'war.active', { warId: war.warId, attackerGuildId: war.attackerGuildId, endsUtc: war.activeEndsUtc });
      } else if (war.state === WAR_STATE.REFUSED) {
        await pushWarRefused(env, { attackerGuildId: war.attackerGuildId, defenderGuildId: war.defenderGuildId });
        await appendClashEvent(env, war.attackerGuildId, 'war.refused', { warId: war.warId });
      } else if (war.state === WAR_STATE.CANCELLED) {
        await pushWarCancelled(env, { attackerGuildId: war.attackerGuildId, reason: 'Declaration vote failed.' });
        await appendClashEvent(env, war.attackerGuildId, 'war.cancelled', { warId: war.warId });
      }
    }
    const tallyText = war.state === WAR_STATE.DECLARING
      ? `Vote recorded — ${war.declareVotes.yes.length} Yes / ${war.declareVotes.no.length} No.`
      : war.state === WAR_STATE.PENDING_ACCEPT
        ? `Vote recorded — ${war.acceptVotes.accept.length} Accept / ${war.acceptVotes.refuse.length} Refuse.`
        : war.state === WAR_STATE.ACTIVE
          ? `Your community voted **Accept** — the war window is open.`
          : war.state === WAR_STATE.REFUSED
            ? `Your community voted **Refuse**. War cancelled.`
            : war.state === WAR_STATE.CANCELLED
              ? `Declaration failed — not enough Yes votes.`
              : `Vote recorded.`;
    return ephemeral(tallyText);
  }

  // clash:war:view:<warId> — just rerender
  if (cid.startsWith('clash:war:view:')) {
    return renderWarView(env, guildId);
  }
  return ephemeral('Unknown Clash component.');
}

// ── Phase 3: defender Champion + Battle Plans ───────────────────────

async function handleDefenderDesignate(env, guildId, userId, targetUserOpt) {
  if (!await canManageTown(env, guildId, userId)) {
    return '🔒 Only the streamer + mods can designate a defender.';
  }
  const targetUserId = String(targetUserOpt || '').trim();
  if (!/^\d{6,30}$/.test(targetUserId)) {
    return '❌ Pass a Discord user mention (USER type option).';
  }
  const town = await getTown(env, guildId);
  // Must have a War Tent built (level >= 1, not currently being built)
  const tent = (town.buildings || []).find(b => b.kind === 'warTent' && b.level >= 1 && b.status !== 'building');
  if (!tent) {
    return '⛺ Build a War Tent first: `/clash town build kind:warTent`.';
  }
  // The target must have a dungeon hero on this channel.
  const hero = await env.LOADOUT_BOLTS.get(`d:hero:${guildId}:${targetUserId}`, { type: 'json' });
  if (!hero) {
    return '❌ That user has no dungeon hero on this channel yet — they need to run `/loadout` first.';
  }
  const ttl = (BUILDINGS.warTent.designationTtlMs[tent.level] || 7 * 86_400_000);
  town.defenderChampion = {
    userId: targetUserId,
    designatedByUserId: userId,
    designatedUtc: Date.now(),
    acceptedUtc: null,
    expiresUtc: Date.now() + ttl,
  };
  await putTown(env, guildId, town);
  await refreshDefenseSnapshot(env, guildId);
  const days = Math.round(ttl / 86_400_000);
  return `⛺ Designated <@${targetUserId}> as the defending Champion. They need to run \`/clash defender accept\` within ${days} days for the role to go live.`;
}

async function handleDefenderClear(env, guildId, userId) {
  if (!await canManageTown(env, guildId, userId)) {
    return '🔒 Only the streamer + mods can clear the defender.';
  }
  const town = await getTown(env, guildId);
  town.defenderChampion = null;
  await putTown(env, guildId, town);
  await refreshDefenseSnapshot(env, guildId);
  return '⛺ Defender slot cleared.';
}

async function handleDefenderAccept(env, guildId, userId) {
  const town = await getTown(env, guildId);
  const d = town.defenderChampion;
  if (!d) return 'No defender designation pending.';
  if (d.userId !== userId) return 'You\'re not the designated defender on this town.';
  if (d.expiresUtc && d.expiresUtc < Date.now()) {
    town.defenderChampion = null;
    await putTown(env, guildId, town);
    return 'Designation expired — ask the streamer to designate again.';
  }
  d.acceptedUtc = Date.now();
  await putTown(env, guildId, town);
  await refreshDefenseSnapshot(env, guildId);
  return '🛡 You accepted the defending Champion role. Your dungeon hero now defends this town on every raid.';
}

async function handleDefenderDecline(env, guildId, userId) {
  const town = await getTown(env, guildId);
  const d = town.defenderChampion;
  if (!d || d.userId !== userId) return 'No designation for you.';
  town.defenderChampion = null;
  await putTown(env, guildId, town);
  await refreshDefenseSnapshot(env, guildId);
  return '⛺ Declined. Streamer can designate someone else.';
}

async function handleSkipCooldown(env, guildId, userId) {
  if (!await canManageTown(env, guildId, userId)) {
    return '🔒 Only the streamer + mods can spend Battle Plans.';
  }
  const town = await getTown(env, guildId);
  if ((town.battlePlans || 0) <= 0) {
    return `📜 No Battle Plans on hand. Earn them from PvE raids + dungeon training (max ${MAX_BATTLE_PLANS} stored).`;
  }
  // Find the oldest in-flight queue item.
  const q = await getQueue(env, 'clash:queue:' + guildId);
  if (!q.items?.length) {
    return '📜 No in-flight builds to skip. Queue one first.';
  }
  const oldest = q.items.slice().sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0))[0];
  oldest.endsAt = Date.now();   // mark complete on next walk
  await env.LOADOUT_BOLTS.put('clash:queue:' + guildId, JSON.stringify(q));
  await spendBattlePlan(env, guildId);
  await syncCooldowns(env, guildId, userId);
  return `📜 Battle Plan consumed — the oldest in-flight build just finished. ${(town.battlePlans || 0) - 1} left.`;
}

// Walk every hero on the guild, return the max level. Cheap because
// it's a single KV list-by-prefix; we cap iteration at 3 pages (3k
// heroes) which is far more than any single community.
async function highestHeroLevelInGuild(env, guildId) {
  let best = 0;
  let cursor;
  for (let i = 0; i < 3; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: `d:hero:${guildId}:`, cursor, limit: 1000 });
    for (const k of r.keys) {
      const h = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!h) continue;
      if ((h.level || 0) > best) best = h.level || 0;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return best;
}

// Read a defender hero (if any) for a raid resolution. Returns the
// same shape readHeroForRaid uses for the attacker, plus the tent
// HP multiplier so the resolver can scale the defending Champion.
async function readDefenderHeroForRaid(env, defenderGuildId) {
  const d = await getActiveDefenderChampion(env, defenderGuildId);
  if (!d) return null;
  const town = await getTown(env, defenderGuildId);
  const tent = (town?.buildings || []).find(b => b.kind === 'warTent' && b.level >= 1 && b.status !== 'building');
  if (!tent) return null;
  const heroRaw = await env.LOADOUT_BOLTS.get(`d:hero:${defenderGuildId}:${d.userId}`, { type: 'json' });
  if (!heroRaw) return null;
  let voltaicPieces = 0;
  let atkBonus = 0, defBonus = 0;
  for (const slot of ['head', 'chest', 'legs', 'boots', 'weapon', 'trinket']) {
    const itemId = heroRaw.equipped?.[slot];
    if (!itemId) continue;
    const inv = (heroRaw.bag || []).find(i => i.id === itemId);
    if (inv?.setName === 'voltaic') voltaicPieces++;
    atkBonus += inv?.powerBonus || 0;
    defBonus += inv?.defenseBonus || 0;
  }
  return {
    hero: {
      level: heroRaw.level || 1,
      cls: heroRaw.className || 'warrior',
      atkBonus, defBonus, voltaicPieces,
    },
    tentHpMult: BUILDINGS.warTent.championHpMult[tent.level] || 1.0,
  };
}

// ── War amplification hook (called inline by handleRaid) ─────────────
export async function applyWarAmplification(env, attackerHomeGuildId, targetGuildId) {
  const war = await findActiveWarForRaid(env, attackerHomeGuildId, targetGuildId);
  return { war, warAmplify: !!war };
}

// ── Editor adapters (Phase 4) ────────────────────────────────────────
//
// Thin wrappers exposing the slash handlers so the HMAC-gated
// /sync/<guildId>/clash POST endpoints can write through the same
// validation + side-effect path as a Discord interaction. Prefixed
// with _ because they're internal — only clash-http.js calls them.

export async function _editorTownBuild(env, guildId, userId, kind, buildingId) {
  await syncCooldowns(env, guildId, userId);
  return handleTownBuild(env, guildId, userId, kind, buildingId);
}
export async function _editorTownGarrison(env, guildId, userId, troopId, count) {
  await syncCooldowns(env, guildId, userId);
  return handleTownGarrison(env, guildId, userId, troopId, count);
}
export async function _editorDonate(env, guildId, userId, amount) {
  return handleDonate(env, guildId, userId, amount);
}

export async function recordWarRaidIfAny(env, attackerHomeGuildId, targetGuildId, raidId, stars) {
  const war = await findActiveWarForRaid(env, attackerHomeGuildId, targetGuildId);
  if (!war) return null;
  const updated = await recordWarRaid(env, war, attackerHomeGuildId, raidId, stars);
  // If this raid closed the active window via simultaneous expiry, advance.
  if (updated.state === WAR_STATE.ACTIVE && Date.now() >= updated.activeEndsUtc) {
    const ended = await advanceWar(env, updated);
    if (ended.state === WAR_STATE.COMPLETED) {
      await pushWarEnded(env, {
        winnerGuildId: ended.rewards?.winnerGuildId,
        loserGuildId: ended.rewards?.winnerGuildId === ended.attackerGuildId ? ended.defenderGuildId : ended.attackerGuildId,
        scores: ended.scores,
        coresTribute: ended.rewards?.coresTribute || 0,
      });
    }
    return ended;
  }
  return updated;
}
