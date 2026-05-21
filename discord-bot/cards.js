// Boltbound — Discord slash command + component dispatch.
//
// One top-level command, `/boltbound`. See CARD-GAME-DESIGN.md §5.
//
// Each turn of a match is one slash invocation — this avoids Discord
// component-state plumbing and keeps the surface honest for the async
// 24h-per-turn pace. Phase 2 (web + Twitch) gets the click-to-target
// pretty UI on top of the same backend.

import { CARDS, CHAMPIONS, PACKS, championForClass, validateDeck } from './cards-content.js';
import {
  ensureCollection, getCollection,
  listPendingPacks, getPendingPack,
  hasClaimedFreePackToday,
  getActiveMatch, getActiveDeck, getActiveDeckId,
  listDecks, getDeck,
  readLog,
  getTrophies, tierOf,
  ladderCapacity,
  listChallenges,
} from './cards-state.js';
import {
  creditPack, openPack, buyPack, claimDailyFreePack,
} from './cards-packs.js';
import {
  startNpcMatch, queueOrMatchPvp, challengeUser, acceptChallenge,
  takeAction, takeMulligan,
  sideOf, renderableState, isLegalAction,
} from './cards-match.js';
import {
  saveDeck, dropDeck, activateDeck, listDeckSummaries, buildStarterDeck,
} from './cards-decks.js';
import {
  getFragments, recycleCard, craftPack,
  RECYCLE_YIELD, CRAFT_COST,
} from './cards-fragments.js';
import { loadHero } from './dungeon.js';

const RESP_CHAT   = 4;
const RESP_UPDATE = 7;
const FLAG_EPHEMERAL = 64;

function ephemeral(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}
function publicReply(content) {
  return { type: RESP_CHAT, data: { content } };
}
function update(content, components) {
  const data = { content };
  if (components) data.components = components;
  return { type: RESP_UPDATE, data };
}
function ephemeralRich({ content, components, embeds }) {
  const data = { content, flags: FLAG_EPHEMERAL };
  if (components) data.components = components;
  if (embeds) data.embeds = embeds;
  return { type: RESP_CHAT, data };
}

// ── Entry point ─────────────────────────────────────────────────────

export async function handleBoltboundCommand(env, data, userId, userName) {
  const guildId = data.guild_id;
  if (!guildId) return ephemeral('Run this in a server.');

  // First-/boltbound bootstrap. Reads the dungeon hero's class so the
  // starting champion matches what the viewer plays elsewhere in
  // Loadout (warrior / mage / rogue / ranger / healer). No class
  // chosen yet -> default warrior; the deck's champion updates the
  // moment they /loadout class.
  const hero = await loadHero(env, guildId, userId);
  const championClass = hero?.className || 'warrior';
  const { isNew } = await ensureCollection(env, guildId, userId, championClass);
  if (isNew) {
    // Welcome gift: one Common Pack + an auto-built starter deck.
    await creditPack(env, guildId, userId, 'common', 'welcome');
    const col = await getCollection(env, guildId, userId);
    const starter = buildStarterDeck(col, championClass, { name: 'Starter' });
    // Save returns ok:false until the welcome pack is opened (the
    // collection is empty). That's fine — caller will see the
    // status message guide them to open the pack first.
    await saveDeck(env, guildId, userId, starter, championClass);
    // If save failed (empty collection), don't activate; surface the
    // "open your welcome pack" hint via /boltbound status.
    const decks = await listDecks(env, guildId, userId);
    if (decks.length) {
      const { setActiveDeckId } = await import('./cards-state.js');
      await setActiveDeckId(env, guildId, userId, decks[0].id);
    }
  }

  const opts = data.data?.options || [];
  let group = null, leaf = null, leafOpts = [];
  if (opts.length && opts[0].type === 2) {
    group = opts[0].name;
    leaf = opts[0].options?.[0]?.name || '';
    leafOpts = opts[0].options?.[0]?.options || [];
  } else if (opts.length && opts[0].type === 1) {
    leaf = opts[0].name;
    leafOpts = opts[0].options || [];
  } else {
    leaf = 'status';
  }
  const getOpt = (name) => leafOpts.find(o => o.name === name)?.value;

  if (group === 'deck') {
    switch (leaf) {
      case 'list':      return ephemeral(await renderDeckList(env, guildId, userId));
      case 'active':    return ephemeral(await activateDeckHandler(env, guildId, userId, getOpt('deck')));
      case 'rebuild':   return ephemeral(await rebuildStarterHandler(env, guildId, userId, championClass));
      case 'show':      return ephemeral(await showDeckHandler(env, guildId, userId, getOpt('deck')));
      default:          return ephemeral('Unknown /boltbound deck subcommand.');
    }
  }
  if (group === 'play') {
    switch (leaf) {
      case 'npc':       return playReply(await startNpcMatchHandler(env, guildId, userId, getOpt('archetype')));
      case 'queue':     return ephemeral(await queueMatchHandler(env, guildId, userId, userName));
      case 'challenge': return ephemeral(await challengeHandler(env, guildId, userId, getOpt('user')));
      case 'accept':    return playReply(await acceptHandler(env, guildId, userId, getOpt('user')));
      default:          return ephemeral('Unknown /boltbound play subcommand.');
    }
  }

  switch (leaf) {
    case 'status':      return ephemeral(await renderStatus(env, guildId, userId, userName));
    case 'packs':       return ephemeral(await renderPacks(env, guildId, userId));
    case 'open':        return ephemeral(await openPackHandler(env, guildId, userId, getOpt('id')));
    case 'buy':         return ephemeral(await buyPackHandler(env, guildId, userId, getOpt('pack')));
    case 'daily':       return ephemeral(await dailyHandler(env, guildId, userId));
    case 'collection':  return ephemeral(await renderCollection(env, guildId, userId, getOpt('rarity')));
    case 'match':       return ephemeral(await renderMatch(env, guildId, userId));
    case 'move':        return ephemeral(await moveHandler(env, guildId, userId, getOpt('card'), getOpt('target')));
    case 'attack':      return ephemeral(await attackHandler(env, guildId, userId, getOpt('attacker'), getOpt('target')));
    case 'end-turn':    return ephemeral(await endTurnHandler(env, guildId, userId));
    case 'concede':     return ephemeral(await concedeHandler(env, guildId, userId));
    case 'mulligan':    return ephemeral(await mulliganHandler(env, guildId, userId, getOpt('keep')));
    case 'log':         return ephemeral(await renderMatchLog(env, guildId, userId));
    case 'leaderboard': return ephemeral(await renderLeaderboard(env, guildId));
    case 'challenges':  return ephemeral(await renderChallenges(env, guildId, userId));
    case 'fragments':   return ephemeral(await renderFragments(env, userId));
    case 'recycle':     return ephemeral(await recycleHandler(env, guildId, userId, getOpt('card'), getOpt('count')));
    case 'craft':       return ephemeral(await craftHandler(env, guildId, userId, getOpt('pack')));
    case '':            return ephemeral(await renderStatus(env, guildId, userId, userName));
    default:            return ephemeral('Unknown /boltbound subcommand: ' + leaf);
  }
}

// Reply that uses a public channel post (so the opponent can see a
// PvP match was started) vs an ephemeral for solo NPC/queueing.
function playReply(result) {
  if (result.publicMessage) return publicReply(result.publicMessage);
  return ephemeral(result.privateMessage || result.message || '...');
}

// ── Component dispatch (refresh + concede buttons on match embed) ───

export async function handleBoltboundComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');

  if (cid === 'boltbound:refresh') {
    return update(await renderMatch(env, guildId, userId));
  }
  if (cid === 'boltbound:concede') {
    const r = await concedeHandler(env, guildId, userId);
    return update(r);
  }
  if (cid.startsWith('boltbound:openpack:')) {
    const packId = cid.split(':')[2];
    const r = await openPackById(env, guildId, userId, packId);
    return update(r);
  }
  return ephemeral('Unknown action.');
}

// ── Renderers ────────────────────────────────────────────────────────

async function renderStatus(env, guildId, userId, userName) {
  const col = await getCollection(env, guildId, userId);
  const trophies = await getTrophies(env, userId);
  const cap = await ladderCapacity(env, userId);
  const packs = await listPendingPacks(env, guildId, userId, 50);
  const decks = await listDecks(env, guildId, userId);
  const activeId = await getActiveDeckId(env, guildId, userId);
  const active = activeId ? decks.find(d => d.id === activeId) : null;
  const cardCount = Object.values(col.cards || {}).reduce((a, b) => a + b, 0);
  const dailyClaimed = await hasClaimedFreePackToday(env, guildId, userId);
  const activeMatch = await getActiveMatch(env, guildId, userId);
  const frags = await getFragments(env, userId);
  const lines = [
    `**${userName} — Boltbound profile**`,
    `🏆 Trophies: **${trophies.trophies}** · Tier: ${trophies.tier} · Peak: ${trophies.peak}`,
    `🃏 Collection: **${cardCount}** cards · Decks: ${decks.length}/6 ${active ? `(active: ${active.name})` : '(none active)'}`,
    `📦 Pending packs: **${packs.length}** ${packs.length ? `(\`/boltbound packs\` to view)` : ''}`,
    `🎁 Daily Common Pack: ${dailyClaimed ? 'claimed' : '`/boltbound daily` to claim'}`,
    `🧩 Fragments: **${frags}** _(recycle owned cards · craft packs)_`,
    `⚡ Ladder Bolts today: ${cap.earnedToday}/${cap.cap}`,
  ];
  if (activeMatch && activeMatch.status === 'active') {
    lines.push(``);
    lines.push(`▶ **Match in progress** — \`/boltbound match\` to view, \`/boltbound move\` to play.`);
  } else if (activeMatch && activeMatch.status === 'mulligan') {
    lines.push(``);
    lines.push(`▶ **Mulligan pending** — \`/boltbound mulligan keep:1,2,3\` to choose what to keep.`);
  } else {
    lines.push(``);
    lines.push(`Play: \`/boltbound play npc\` (instant) or \`/boltbound play queue\` (PvP wait queue).`);
  }
  return lines.join('\n');
}

async function renderPacks(env, guildId, userId) {
  const packs = await listPendingPacks(env, guildId, userId, 25);
  if (!packs.length) {
    const dailyClaimed = await hasClaimedFreePackToday(env, guildId, userId);
    return [
      '📭 No pending packs.',
      '',
      dailyClaimed
        ? 'Buy a Bolt Pack with `/boltbound buy pack:bolt` (250 Bolts).'
        : 'Claim your daily Common Pack with `/boltbound daily`.',
    ].join('\n');
  }
  const lines = ['**📦 Pending packs:**', ''];
  for (const p of packs) {
    const def = PACKS[p.packType] || { name: p.packType };
    const age = ageStr(p.mintedUtc);
    lines.push(`• \`${p.id.slice(0, 8)}\` — ${def.name} _(from ${p.source}, ${age} ago)_`);
  }
  lines.push('');
  lines.push('Open one: `/boltbound open id:<id>` (first 8 chars are enough).');
  return lines.join('\n');
}

async function openPackHandler(env, guildId, userId, idOrPrefix) {
  if (!idOrPrefix) return '❌ Pack id required. Run `/boltbound packs` to list yours.';
  const packs = await listPendingPacks(env, guildId, userId, 50);
  const match = packs.find(p => p.id === idOrPrefix || p.id.startsWith(idOrPrefix));
  if (!match) return `❌ No pending pack with id starting \`${idOrPrefix}\`. Try \`/boltbound packs\`.`;
  return openPackById(env, guildId, userId, match.id);
}

async function openPackById(env, guildId, userId, packId) {
  const r = await openPack(env, guildId, userId, packId);
  if (!r.ok) return `❌ Open failed: ${r.error}`;
  const def = PACKS[r.packType] || { name: r.packType };
  const lines = [`**${def.name} opened!**`, ''];
  for (const res of r.results) {
    const card = CARDS[res.cardId];
    if (res.credited) {
      lines.push(`• ${rarityGlyph(card?.rarity)} **${card?.name || res.cardId}** _(${card?.rarity})_ — added (you now own ${res.count})`);
    } else {
      lines.push(`• ${rarityGlyph(card?.rarity)} ${card?.name || res.cardId} _(${card?.rarity})_ — duplicate, **+${res.dupeBolts} Bolts**`);
    }
  }
  if (r.totalDupeBolts > 0) {
    lines.push('');
    lines.push(`💰 Total dupe refund: **+${r.totalDupeBolts} Bolts**`);
  }
  return lines.join('\n');
}

async function buyPackHandler(env, guildId, userId, packId) {
  if (!packId) return '❌ Which pack? Try `pack:bolt` (250 Bolts).';
  const r = await buyPack(env, guildId, userId, packId);
  if (!r.ok) {
    if (r.error === 'insufficient-bolts') return `❌ Not enough Bolts. Need ${r.need}, have ${r.have}.`;
    if (r.error === 'not-purchasable') return `❌ That pack isn't for sale — drop-only.`;
    return `❌ ${r.error}`;
  }
  return `✅ Bought **${PACKS[r.pack.packType]?.name}**. Open it: \`/boltbound open id:${r.pack.id.slice(0, 8)}\``;
}

async function dailyHandler(env, guildId, userId) {
  const r = await claimDailyFreePack(env, guildId, userId);
  if (!r.ok) {
    if (r.error === 'already-claimed-today') return '⏰ You already claimed today\'s Common Pack. Comes back at 00:00 UTC.';
    return `❌ ${r.error}`;
  }
  return `🎁 **Daily Common Pack claimed.** Open it: \`/boltbound open id:${r.pack.id.slice(0, 8)}\``;
}

async function renderCollection(env, guildId, userId, rarityFilter) {
  const col = await getCollection(env, guildId, userId);
  const own = col.cards || {};
  const entries = Object.entries(own)
    .map(([id, n]) => ({ id, n, card: CARDS[id] }))
    .filter(x => x.card && (!rarityFilter || x.card.rarity === rarityFilter))
    .sort((a, b) => {
      const rOrder = { legendary: 0, rare: 1, uncommon: 2, common: 3 };
      const dr = (rOrder[a.card.rarity] || 9) - (rOrder[b.card.rarity] || 9);
      if (dr !== 0) return dr;
      return (a.card.mana || 0) - (b.card.mana || 0);
    });
  if (!entries.length) {
    return '📭 Your collection is empty. Try `/boltbound daily` or `/boltbound buy pack:bolt`.';
  }
  const lines = ['**🃏 Collection**' + (rarityFilter ? ` _(${rarityFilter})_` : ''), ''];
  let lastRarity = null;
  for (const { id, n, card } of entries) {
    if (card.rarity !== lastRarity) {
      lines.push(`__${(card.rarity || '').toUpperCase()}__`);
      lastRarity = card.rarity;
    }
    lines.push(`• ${card.name} (${card.mana} mana) ×${n}`);
  }
  // Truncate hard if oversized — Discord max message ~2000 chars.
  let out = lines.join('\n');
  if (out.length > 1900) out = out.slice(0, 1900) + '\n…(truncated)';
  return out;
}

async function renderDeckList(env, guildId, userId) {
  const decks = await listDeckSummaries(env, guildId, userId);
  if (!decks.length) {
    return [
      '📭 No saved decks. Run `/boltbound deck rebuild` to auto-build one from your collection.',
    ].join('\n');
  }
  const lines = ['**📚 Your decks:**', ''];
  for (const d of decks) {
    const marker = d.active ? ' ✅' : '';
    lines.push(`• \`${d.id}\` — **${d.name}**${marker}  _(${d.championClass}, ${d.cardsCount} cards)_`);
  }
  lines.push('');
  lines.push('Activate: `/boltbound deck active deck:<id>` · Rebuild starter: `/boltbound deck rebuild`');
  return lines.join('\n');
}

async function activateDeckHandler(env, guildId, userId, deckId) {
  if (!deckId) return '❌ Which deck? Run `/boltbound deck list` first.';
  const r = await activateDeck(env, guildId, userId, deckId);
  if (!r.ok) return `❌ ${r.error}`;
  return `✅ Active deck: **${r.deck.name}**.`;
}

async function rebuildStarterHandler(env, guildId, userId, championClass) {
  const col = await getCollection(env, guildId, userId);
  const deck = buildStarterDeck(col, championClass, { name: 'Starter' });
  const r = await saveDeck(env, guildId, userId, deck, championClass);
  if (!r.ok) return `❌ ${r.error}`;
  await activateDeck(env, guildId, userId, r.deck.id);
  return `✅ Built and activated **${r.deck.name}** _(${championClass})_.`;
}

async function showDeckHandler(env, guildId, userId, deckId) {
  let deck;
  if (deckId) deck = await getDeck(env, guildId, userId, deckId);
  else deck = await getActiveDeck(env, guildId, userId);
  if (!deck) return '❌ No deck. Run `/boltbound deck list`.';
  // Re-insert champion if not already present (we store decks champion-less).
  const champId = championForClass(deck.championClass || 'warrior');
  const cards = (deck.cards || []).slice();
  if (!cards.some(id => CARDS[id]?.rarity === 'champion')) cards.unshift(champId);
  const lines = [
    `**${deck.name}** _(${deck.championClass})_`,
    `\`${deck.id}\` · ${cards.length} cards`,
    '',
  ];
  const counts = new Map();
  for (const id of cards) counts.set(id, (counts.get(id) || 0) + 1);
  const rOrder = { champion: 0, legendary: 1, rare: 2, uncommon: 3, common: 4 };
  const sorted = Array.from(counts.entries()).sort(([a], [b]) => {
    const ca = CARDS[a], cb = CARDS[b];
    const dr = (rOrder[ca?.rarity] || 9) - (rOrder[cb?.rarity] || 9);
    if (dr !== 0) return dr;
    return (ca?.mana || 0) - (cb?.mana || 0);
  });
  for (const [id, n] of sorted) {
    const c = CARDS[id];
    if (!c) continue;
    lines.push(`• ${rarityGlyph(c.rarity)} **${c.name}** (${c.mana} mana) ×${n}`);
  }
  return lines.join('\n');
}

// ── Play / match ────────────────────────────────────────────────────

async function startNpcMatchHandler(env, guildId, userId, archetype) {
  const r = await startNpcMatch(env, guildId, userId, archetype);
  if (!r.ok) {
    if (r.error === 'already-in-match') return { privateMessage: `❌ You already have a match in progress. \`/boltbound match\` to view.` };
    if (r.error === 'no-active-deck') return { privateMessage: '❌ No active deck. Run `/boltbound deck rebuild` first.' };
    return { privateMessage: `❌ ${r.error}` };
  }
  return { privateMessage: [
    `🃏 **Boltbound — vs ${r.match.npc.archetype} bot.**`,
    `Mulligan: \`/boltbound mulligan keep:0,1,2,3\` (or just \`/boltbound mulligan\` to keep all).`,
  ].join('\n') };
}

async function queueMatchHandler(env, guildId, userId, userName) {
  const r = await queueOrMatchPvp(env, guildId, userId);
  if (!r.ok) {
    if (r.error === 'already-in-match') return '❌ You already have a match in progress.';
    if (r.error === 'no-active-deck') return '❌ No active deck. Run `/boltbound deck rebuild`.';
    return `❌ ${r.error}`;
  }
  if (r.queued) {
    return '⏳ **Queued for PvP.** When another viewer queues you\'ll both be auto-matched. Run `/boltbound match` anytime to check.';
  }
  return [
    `⚔ **Match found vs <@${r.match.players.B}>**`,
    `Mulligan: \`/boltbound mulligan keep:...\` (or empty for none).`,
  ].join('\n');
}

async function challengeHandler(env, guildId, userId, target) {
  if (!target) return '❌ Who? Try `/boltbound play challenge user:@friend`.';
  const r = await challengeUser(env, guildId, userId, target);
  if (!r.ok) {
    if (r.error === 'no-active-deck') return '❌ No active deck. Run `/boltbound deck rebuild`.';
    if (r.error === 'recipient-inbox-full') return '❌ That viewer\'s challenge inbox is full (3 outstanding max).';
    if (r.error === 'cannot-challenge-self') return '❌ You can\'t challenge yourself.';
    return `❌ ${r.error}`;
  }
  return `✅ Challenge sent to <@${target}>. They accept with \`/boltbound play accept user:<@you>\`.`;
}

async function acceptHandler(env, guildId, userId, senderId) {
  if (!senderId) return { privateMessage: '❌ Who challenged you? Try `/boltbound challenges`.' };
  const r = await acceptChallenge(env, guildId, userId, senderId);
  if (!r.ok) return { privateMessage: `❌ ${r.error}` };
  return { publicMessage: [
    `⚔ **Boltbound match starts!** <@${senderId}> vs <@${userId}>`,
    `Both players: \`/boltbound mulligan keep:...\` to set up.`,
  ].join('\n') };
}

async function renderChallenges(env, guildId, userId) {
  const inbox = await listChallenges(env, guildId, userId);
  if (!inbox.length) return '📭 No pending challenges.';
  const lines = ['**📜 Pending challenges to you:**', ''];
  for (const c of inbox) lines.push(`• from <@${c.sender}> _(${ageStr(c.ts)} ago)_ — \`/boltbound play accept user:<@${c.sender}>\``);
  return lines.join('\n');
}

async function renderMatch(env, guildId, userId) {
  const match = await getActiveMatch(env, guildId, userId);
  if (!match) return '📭 No active match. `/boltbound play npc` or `/boltbound play queue`.';
  const state = renderableState(match, userId);
  if (!state) return '❌ Internal: you aren\'t a side of this match.';

  if (match.status === 'mulligan') {
    return [
      `**Mulligan — ${state.you.hand.length} cards**`,
      '',
      ...state.you.hand.map((id, i) => `  \`${i}\` ${rarityGlyph(CARDS[id]?.rarity)} ${CARDS[id]?.name} (${CARDS[id]?.mana})`),
      '',
      'Run `/boltbound mulligan keep:0,1,2` to replace cards you DON\'T list (omit for keep all).',
    ].join('\n');
  }
  if (match.status !== 'active') {
    return [
      `**Match ended — ${match.status}**`,
      `Your HP: ${state.you.hp} · Opp HP: ${state.them.hp}`,
      '',
      '`/boltbound log` for the recap.',
    ].join('\n');
  }
  return [
    `**Boltbound — turn ${match.turn} (${state.yourTurn ? 'YOUR TURN' : 'opp turn'})**`,
    '',
    `__You__   ❤️ ${state.you.hp}   ⚡ ${state.you.mana.cur}/${state.you.mana.max}   📥 hand ${state.you.handCount}   🃏 deck ${state.you.deckCount}`,
    `__Opp__   ❤️ ${state.them.hp}   ⚡ ${state.them.mana.cur}/${state.them.mana.max}   📥 hand ${state.them.handCount}   🃏 deck ${state.them.deckCount}` + (state.them.npc ? ` _(NPC: ${state.them.npc.archetype})_` : ''),
    '',
    '**Your board:**',
    state.you.board.length ? state.you.board.map(m => `  \`${m.uid}\` ${CARDS[m.cardId]?.name} ${m.atk}/${m.hp}${m.canAttack ? ' ⚔️' : ''}${(m.keywords || []).length ? ' [' + m.keywords.join(',') + ']' : ''}`).join('\n') : '  _(empty)_',
    '',
    '**Opp board:**',
    state.them.board.length ? state.them.board.map(m => `  \`${m.uid}\` ${CARDS[m.cardId]?.name} ${m.atk}/${m.hp}${(m.keywords || []).length ? ' [' + m.keywords.join(',') + ']' : ''}`).join('\n') : '  _(empty)_',
    '',
    '**Your hand:**',
    state.you.hand.length ? state.you.hand.map((id, i) => `  \`${i}\` ${rarityGlyph(CARDS[id]?.rarity)} ${CARDS[id]?.name} (${CARDS[id]?.mana} mana) — ${CARDS[id]?.text || ''}`).join('\n') : '  _(empty)_',
    '',
    state.yourTurn ? '`/boltbound move card:<idx> [target:<uid|oppHero|selfHero>]` · `/boltbound attack attacker:<uid> target:<uid|hero>` · `/boltbound end-turn`' : '_Waiting on opponent. Refresh with `/boltbound match`._',
  ].join('\n');
}

async function moveHandler(env, guildId, userId, cardIdx, target) {
  const match = await getActiveMatch(env, guildId, userId);
  if (!match) return '❌ No active match.';
  const side = sideOf(match, userId);
  if (!side) return '❌ Internal: not a side.';
  if (match.status !== 'active') return '❌ Match isn\'t active.';
  const idx = parseInt(cardIdx, 10);
  if (!Number.isInteger(idx)) return '❌ card index required (a number, e.g. `card:0`).';
  const action = { kind: 'playCard', side, handIdx: idx, targetUid: target || null };
  const legal = isLegalAction(match, action);
  if (!legal.ok) return `❌ ${legal.reason}`;
  const r = await takeAction(env, match, side, action);
  if (!r.ok) return `❌ ${r.error}`;
  if (r.ended) return renderEndedShort(r.match, userId);
  return await renderMatch(env, guildId, userId);
}

async function attackHandler(env, guildId, userId, attacker, target) {
  const match = await getActiveMatch(env, guildId, userId);
  if (!match) return '❌ No active match.';
  const side = sideOf(match, userId);
  if (!side) return '❌ Internal: not a side.';
  if (match.status !== 'active') return '❌ Match isn\'t active.';
  if (!attacker || !target) return '❌ Need `attacker:<uid>` and `target:<uid|hero>`.';
  const action = { kind: 'attack', side, attackerUid: attacker, defenderUid: target };
  const legal = isLegalAction(match, action);
  if (!legal.ok) return `❌ ${legal.reason}`;
  const r = await takeAction(env, match, side, action);
  if (!r.ok) return `❌ ${r.error}`;
  if (r.ended) return renderEndedShort(r.match, userId);
  return await renderMatch(env, guildId, userId);
}

async function endTurnHandler(env, guildId, userId) {
  const match = await getActiveMatch(env, guildId, userId);
  if (!match) return '❌ No active match.';
  const side = sideOf(match, userId);
  if (!side) return '❌ Internal: not a side.';
  const r = await takeAction(env, match, side, { kind: 'endTurn' });
  if (!r.ok) return `❌ ${r.error}`;
  if (r.ended) return renderEndedShort(r.match, userId);
  return await renderMatch(env, guildId, userId);
}

async function concedeHandler(env, guildId, userId) {
  const match = await getActiveMatch(env, guildId, userId);
  if (!match) return '❌ No active match.';
  const side = sideOf(match, userId);
  if (!side) return '❌ Internal: not a side.';
  const r = await takeAction(env, match, side, { kind: 'concede' });
  return renderEndedShort(r.match, userId);
}

async function mulliganHandler(env, guildId, userId, keepCsv) {
  const match = await getActiveMatch(env, guildId, userId);
  if (!match) return '❌ No active match.';
  const side = sideOf(match, userId);
  if (!side) return '❌ Internal: not a side.';
  if (match.status !== 'mulligan') return '❌ Not in mulligan phase.';
  // `keep` is a CSV of indices to KEEP. The engine takes the indices
  // to REPLACE — so we compute the complement.
  const keepIdxs = (keepCsv || '').split(',').map(s => s.trim()).filter(Boolean).map(n => parseInt(n, 10)).filter(Number.isInteger);
  const handLen = match.hands[side].length;
  const toReplace = [];
  for (let i = 0; i < handLen; i++) if (!keepIdxs.includes(i)) toReplace.push(i);
  // If keep was unspecified entirely, default to "keep all" (toReplace stays empty if keepCsv non-empty).
  // If keepCsv is empty AND user explicitly wants to mulligan all, they'd say `keep:` (still empty) — we treat that as keep-all.
  // To mulligan everything, the user passes `keep:` with no values OR a value that doesn't include any of 0..n-1, e.g. `keep:99`.
  await takeMulligan(env, match, side, toReplace);
  // Re-read in case NPC finished mulligan and turns ran.
  return await renderMatch(env, guildId, userId);
}

function renderEndedShort(match, userId) {
  const state = renderableState(match, userId);
  const won = (match.status === 'A-won' && state.me === 'A') || (match.status === 'B-won' && state.me === 'B');
  const draw = match.status === 'draw';
  const tag = won ? '🏆 **WIN**' : draw ? '🤝 **DRAW**' : '💀 **LOSS**';
  return [
    `${tag} — Turn ${match.turn}`,
    `You: ${state.you.hp} HP · Opp: ${state.them.hp} HP`,
    '',
    '`/boltbound log` for replay · `/boltbound play npc` for another round.',
  ].join('\n');
}

async function renderMatchLog(env, guildId, userId) {
  const log = await readLog(env, guildId, userId);
  if (!log.length) return '📭 No recent matches.';
  const lines = ['**📜 Last 10 matches:**', ''];
  for (const r of log) {
    const result = r.status === 'A-won' ? (r.players?.A === userId ? 'W' : 'L')
                 : r.status === 'B-won' ? (r.players?.B === userId ? 'W' : 'L')
                 : r.status === 'draw' ? 'D' : '?';
    const vs = r.npc ? `vs ${r.npc.archetype}` : `vs PvP`;
    lines.push(`• ${result} · turn ${r.turn} · ${vs}`);
  }
  return lines.join('\n');
}

// ── CR-1: fragments + recycle + craft ───────────────────────────────

async function renderFragments(env, userId) {
  const frags = await getFragments(env, userId);
  return [
    `🧩 **Fragments: ${frags}**`,
    '',
    '**Recycle yield (per card):**',
    `  • Common ${RECYCLE_YIELD.common} · Uncommon ${RECYCLE_YIELD.uncommon} · Rare ${RECYCLE_YIELD.rare} · Legendary ${RECYCLE_YIELD.legendary}`,
    '',
    '**Craft costs (frags → pack):**',
    `  • Common Pack: ${CRAFT_COST.common} frags`,
    `  • Bolt Pack:   ${CRAFT_COST.bolt} frags  _(60% more than 250 Bolts — Bolts is the faster path)_`,
    `  • Voltaic Pack:${CRAFT_COST.voltaic} frags  _(otherwise drop-only)_`,
    '',
    'Recycle: `/boltbound recycle card:<id> count:<n>` · Craft: `/boltbound craft pack:bolt`',
  ].join('\n');
}

async function recycleHandler(env, guildId, userId, cardId, count) {
  if (!cardId) return '❌ Which card? Try `/boltbound collection` to see your owned cards.';
  const n = Math.max(1, Number(count) || 1);
  const r = await recycleCard(env, guildId, userId, cardId, n);
  if (!r.ok) {
    if (r.error === 'unknown-card') return '❌ Unknown card id.';
    if (r.error === 'champions-not-recyclable') return '❌ Champions can\'t be recycled.';
    if (r.error === 'tokens-not-recyclable') return '❌ Tokens can\'t be recycled.';
    if (r.error === 'insufficient-copies') return `❌ You only own ${r.owned} copies.`;
    if (r.error === 'deck-uses-this-card') return `❌ ${r.message}`;
    return `❌ ${r.error}`;
  }
  return [
    `🧩 Recycled **${r.recycled}× ${r.cardName}** (${r.rarity}) → **+${r.yield} fragments**`,
    `You now own ${r.ownedAfter}× this card · Balance: **${r.balanceAfter}** frags.`,
  ].join('\n');
}

async function craftHandler(env, guildId, userId, packType) {
  if (!packType) return '❌ Which pack? Try `pack:bolt` (400 frags).';
  const r = await craftPack(env, guildId, userId, packType);
  if (!r.ok) {
    if (r.error === 'insufficient-fragments') return `❌ Not enough fragments. Need ${r.need}, have ${r.have}.`;
    if (r.error === 'unknown-pack-type') return '❌ Unknown pack type. Try `common`, `bolt`, or `voltaic`.';
    return `❌ ${r.error}`;
  }
  const packName = packType === 'voltaic' ? 'Voltaic Pack' : packType === 'bolt' ? 'Bolt Pack' : 'Common Pack';
  return [
    `🛠 Crafted **Boltbound ${packName}** for ${r.cost} fragments.`,
    `Open it: \`/boltbound open id:${r.packId.slice(0, 8)}\``,
    `Fragments remaining: **${r.fragmentsAfter}**.`,
  ].join('\n');
}

async function renderLeaderboard(env, guildId) {
  // Top-by-trophies across the world. Lists are global since trophies
  // are per-user (not per-guild). For Phase 1 we surface the top 10
  // by trophies; we don't filter to the channel.
  const prefix = `cards:trophies:`;
  const out = [];
  let cursor;
  for (let i = 0; i < 3; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys) {
      out.push(env.LOADOUT_BOLTS.get(k.name, { type: 'json' }).then(v => ({ userId: k.name.slice(prefix.length), v })));
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  const resolved = (await Promise.all(out)).filter(x => x.v);
  resolved.sort((a, b) => (b.v.trophies || 0) - (a.v.trophies || 0));
  if (!resolved.length) return '📭 No rankings yet.';
  const lines = ['**🏆 Boltbound — Top Trophies**', ''];
  for (let i = 0; i < Math.min(10, resolved.length); i++) {
    const { userId, v } = resolved[i];
    lines.push(`${i + 1}. <@${userId}> — **${v.trophies}** trophies (${tierOf(v.trophies)})`);
  }
  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

function rarityGlyph(rarity) {
  // Note: design says no emoji in CARD records; these glyphs are
  // INTERFACE markers in chat-only messages, not card art. The cards
  // themselves render through aquilo-gg/sprites/cards/<id>.png.
  return ({ champion: '◆', legendary: '🟧', rare: '🟪', uncommon: '🟦', common: '⬜', token: '·' })[rarity] || '·';
}

function ageStr(ts) {
  const ms = Date.now() - (ts || 0);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
