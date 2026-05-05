// Slash command handlers. Each one returns a Discord interaction response
// object: https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object
//
// Pattern: every handler is fast (single KV read + small RNG). Discord
// gives us 3 seconds to respond before the interaction expires.

import { getWallet, transfer, leaderboard } from './wallet.js';
import { coinflip, dice, daily } from './games.js';

// Discord interaction types
const TYPE_PING            = 1;
const TYPE_APPLICATION_CMD = 2;
// Response types
const RESP_PONG            = 1;
const RESP_CHAT            = 4;

// Channel-message-with-source flags. 64 = ephemeral (only the caller sees).
const FLAG_EPHEMERAL = 64;

const ACK_PONG = { type: RESP_PONG };

export async function handleInteraction(req, env, body) {
  let data;
  try { data = JSON.parse(body); }
  catch { return new Response('bad json', { status: 400 }); }

  // Discord pings the endpoint with type 1 to verify it's online.
  if (data.type === TYPE_PING) return json(ACK_PONG);

  if (data.type !== TYPE_APPLICATION_CMD) {
    return json({ type: RESP_CHAT, data: { content: 'Unknown interaction type.', flags: FLAG_EPHEMERAL } });
  }

  const cmd  = (data.data?.name || '').toLowerCase();
  const opts = parseOpts(data.data?.options);
  const guild = data.guild_id;
  const user  = data.member?.user || data.user;
  const userId = user?.id;
  const userName = user?.global_name || user?.username || 'viewer';

  if (!guild || !userId) {
    return json({ type: RESP_CHAT, data: { content: 'This command must be run in a server.', flags: FLAG_EPHEMERAL } });
  }

  // Link gate: every command except /link and /help requires the caller
  // to have linked at least one stream identity. Keeps off-stream bolts
  // tied to a real viewer so cross-platform reconciliation works.
  const allowWithoutLink = new Set(['link', 'help']);
  if (!allowWithoutLink.has(cmd)) {
    const w = await getWallet(env, guild, userId);
    if (!Array.isArray(w.links) || w.links.length === 0) {
      return reply({
        content: '🔗 **Link your stream account first.**\n' +
                 'Run `/link <platform> <username>` to connect your Discord to your stream identity.\n' +
                 'Supported platforms: `twitch`, `kick`, `youtube`, `tiktok`.',
        ephemeral: true
      });
    }
  }

  switch (cmd) {
    case 'balance':     return reply(await cmdBalance(env, guild, userId, opts.user, userName));
    case 'gift':        return reply(await cmdGift(env, guild, userId, opts.user, opts.amount, userName));
    case 'leaderboard': return reply(await cmdLeaderboard(env, guild));
    case 'daily':       return reply(await cmdDaily(env, guild, userId, userName));
    case 'coinflip':    return reply(await cmdCoinflip(env, guild, userId, opts.bet, userName));
    case 'dice':        return reply(await cmdDice(env, guild, userId, opts.bet, opts.target, userName));
    case 'link':        return reply(await cmdLink(env, guild, userId, opts.platform, opts.username, userName));
    case 'help':        return reply(cmdHelp());
    default:            return reply({ content: 'Unknown command: ' + cmd, ephemeral: true });
  }
}

function parseOpts(options) {
  const out = {};
  if (!Array.isArray(options)) return out;
  for (const o of options) out[o.name] = o.value;
  return out;
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function reply({ content, ephemeral = false, embeds }) {
  const data = { content };
  if (embeds) data.embeds = embeds;
  if (ephemeral) data.flags = FLAG_EPHEMERAL;
  return json({ type: RESP_CHAT, data });
}

// ---------- Command implementations ----------

async function cmdBalance(env, guild, callerId, targetUser, callerName) {
  const targetId = targetUser?.id || callerId;
  const targetName = targetUser?.username || (targetId === callerId ? callerName : 'that viewer');
  const w = await getWallet(env, guild, targetId);
  return {
    content: '⚡ **' + targetName + '** has **' + w.balance + '** bolts (lifetime: ' +
             (w.lifetimeEarned || w.balance) + ')' +
             (w.dailyStreak ? '  ·  daily streak: ' + w.dailyStreak : ''),
    ephemeral: targetId !== callerId   // protect lookups of other users
  };
}

async function cmdGift(env, guild, fromId, toUser, amount, fromName) {
  if (!toUser?.id) return { content: 'Pick a user to gift to.', ephemeral: true };
  if (toUser.id === fromId) return { content: "You can't gift yourself.", ephemeral: true };
  if (!Number.isInteger(amount) || amount <= 0) return { content: 'Amount must be a positive integer.', ephemeral: true };

  const r = await transfer(env, guild, fromId, toUser.id, amount);
  if (!r.ok) return { content: '❌ ' + (r.reason || 'gift failed'), ephemeral: true };
  return {
    content: '🎁 <@' + fromId + '> gifted **' + amount + '** bolts to <@' + toUser.id + '>.\n' +
             'Their balance: ' + r.recipient.balance + ' · yours: ' + r.sender.balance + '.'
  };
}

async function cmdLeaderboard(env, guild) {
  const top = await leaderboard(env, guild, 10);
  if (top.length === 0) return { content: 'Nobody has any bolts here yet. Run `/daily` to start!' };
  const lines = top.map((row, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || ('   ' + (i + 1) + '.');
    return medal + '  <@' + row.userId + '>  —  **' + row.w.balance + '** bolts';
  });
  return { content: '📊 **Top 10**\n' + lines.join('\n') };
}

async function cmdDaily(env, guild, userId, userName) {
  const r = await daily(env, guild, userId);
  return {
    content: r.explanation + (r.won ? '' : ''),
    ephemeral: !r.won   // keep "already claimed" private
  };
}

async function cmdCoinflip(env, guild, userId, bet, userName) {
  if (!Number.isInteger(bet) || bet <= 0)
    return { content: 'Bet must be a positive integer.', ephemeral: true };
  const r = await coinflip(env, guild, userId, bet);
  return { content: '<@' + userId + '> ' + r.explanation };
}

async function cmdDice(env, guild, userId, bet, target, userName) {
  if (!Number.isInteger(bet) || bet <= 0)
    return { content: 'Bet must be a positive integer.', ephemeral: true };
  if (!Number.isInteger(target) || target < 1 || target > 6)
    return { content: 'Target must be 1-6.', ephemeral: true };
  const r = await dice(env, guild, userId, bet, target);
  return { content: '<@' + userId + '> ' + r.explanation };
}

async function cmdLink(env, guild, userId, platform, username, callerName) {
  const supported = ['twitch', 'kick', 'youtube', 'tiktok'];
  const p = (platform || '').toLowerCase().trim();
  const u = (username || '').toLowerCase().trim();
  if (!supported.includes(p)) return { content: 'Platform must be one of: ' + supported.join(', '), ephemeral: true };
  if (!u) return { content: 'Username is required.', ephemeral: true };

  const w = await getWallet(env, guild, userId);
  w.links = (w.links || []).filter(l => !(l.platform === p));   // replace existing for that platform
  w.links.push({ platform: p, username: u, ts: Date.now() });
  const { putWallet } = await import('./wallet.js');
  await putWallet(env, guild, userId, w);
  return {
    content: '🔗 Linked Discord account to **' + p + ':' + u + '**. Off-stream bolts will reconcile when ' + callerName + ' is seen on stream.',
    ephemeral: true
  };
}

function cmdHelp() {
  return {
    content: '**Loadout · Bolts in your server**\n' +
      '`/balance [@user]` — check balance · `/gift @user N` — send bolts · `/leaderboard` — top 10\n' +
      '`/daily` — claim daily (streak bonus) · `/coinflip N` — 50/50 double-or-nothing · `/dice N target` — 1d6 for 5x\n' +
      '`/link <platform> <username>` — link to your stream identity (so on-stream earns + off-stream merge)\n' +
      'Powered by [Loadout](<https://aquilo.gg/loadout>) · run by your streamer.',
    ephemeral: true
  };
}
