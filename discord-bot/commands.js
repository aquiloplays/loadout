// Slash command handlers. Each one returns a Discord interaction response
// object: https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object
//
// Pattern: every handler is fast (single KV read + small RNG). Discord
// gives us 3 seconds to respond before the interaction expires.

import { getWallet, transfer, leaderboard } from './wallet.js';
import { coinflip, dice, daily } from './games.js';
import {
  getProfile, clearProfile, setField, setSocial, setGamerTag
} from './profiles.js';

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
  // Profile commands skip the gate — they store Discord-side data the
  // DLL bridge will later map to a linked identity. Lets viewers edit
  // their card before they ever stream-link.
  const allowWithoutLink = new Set([
    'link', 'help',
    'profile', 'profile-set-bio', 'profile-set-pfp', 'profile-set-pronouns',
    'profile-set-social', 'profile-set-gamertag', 'profile-clear'
  ]);
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

    // ── Profile self-edit (mirrors chat-side !set* commands). DLL polls
    //    the changes in via /sync/<guild>/profiles and merges into its
    //    local store, so a Discord-set bio shows up on the !profile
    //    overlay next time someone runs the chat command. ─────────────
    case 'profile-set-bio':       return reply(await cmdProfileBio(env, guild, userId, opts.text));
    case 'profile-set-pfp':       return reply(await cmdProfilePfp(env, guild, userId, opts.url));
    case 'profile-set-pronouns':  return reply(await cmdProfilePronouns(env, guild, userId, opts.text));
    case 'profile-set-social':    return reply(await cmdProfileSocial(env, guild, userId, opts.platform, opts.handle));
    case 'profile-set-gamertag':  return reply(await cmdProfileGamerTag(env, guild, userId, opts.platform, opts.tag));
    case 'profile-clear':         return reply(await cmdProfileClear(env, guild, userId));
    case 'profile':               return reply(await cmdProfileShow(env, guild, opts.user?.id || userId, userName));

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
  // Mirror to the per-guild games ring so the OBS bolts minigames overlay
  // (via DiscordMinigameBridge in the DLL) can render the same animation
  // chat-side games drive. Best-effort - never block the Discord reply.
  await recordGame(env, guild, {
    kind:    'coinflip',
    user:    userName,
    userId:  userId,
    wager:   bet,
    won:     !!r.won,
    payout:  r.payout || 0,
    result:  r.won ? 'heads' : 'tails',
    ts:      Date.now()
  });
  return { content: '<@' + userId + '> ' + r.explanation };
}

async function cmdDice(env, guild, userId, bet, target, userName) {
  if (!Number.isInteger(bet) || bet <= 0)
    return { content: 'Bet must be a positive integer.', ephemeral: true };
  if (!Number.isInteger(target) || target < 1 || target > 6)
    return { content: 'Target must be 1-6.', ephemeral: true };
  const r = await dice(env, guild, userId, bet, target);
  await recordGame(env, guild, {
    kind:    'dice',
    user:    userName,
    userId:  userId,
    wager:   bet,
    target:  target,
    rolled:  r.roll,
    won:     !!r.won,
    payout:  r.payout || 0,
    ts:      Date.now()
  });
  return { content: '<@' + userId + '> ' + r.explanation };
}

// Per-guild ring buffer of recent minigame results. Capped at 32 entries so
// a chatty server can't blow KV write quota. TTL is 5 min — long enough for
// the DLL's 5s poll to catch every event even if the streamer's OBS was
// briefly offline; short enough that we don't accumulate forever.
const GAMES_RING_MAX = 32;
async function recordGame(env, guildId, evt) {
  if (!guildId) return;
  try {
    const key = 'games:' + guildId;
    const existing = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
    existing.push(evt);
    while (existing.length > GAMES_RING_MAX) existing.shift();
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(existing), { expirationTtl: 300 });
  } catch (e) {
    // Logging only - the Discord reply already went out.
    console.warn('recordGame failed for ' + guildId + ': ' + (e && e.message));
  }
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

// ---------- Viewer profile commands ----------
// All profile-set commands are ephemeral — only the caller sees the
// "saved" reply, so chat doesn't get spammed when a bunch of viewers
// edit their profiles at once.

async function cmdProfileBio(env, guildId, userId, text) {
  if (!text) return { content: 'Bio is required.', ephemeral: true };
  await setField(env, guildId, userId, 'bio', text);
  return { content: '📝 Bio saved (' + text.length + ' chars).', ephemeral: true };
}

async function cmdProfilePfp(env, guildId, userId, url) {
  url = (url || '').trim();
  if (!url || !/^https?:\/\//i.test(url))
    return { content: 'URL must start with http(s)://', ephemeral: true };
  await setField(env, guildId, userId, 'pfp', url);
  return { content: '🖼️ Profile picture saved.', ephemeral: true };
}

async function cmdProfilePronouns(env, guildId, userId, text) {
  if (!text) return { content: 'Pronouns required.', ephemeral: true };
  await setField(env, guildId, userId, 'pronouns', text);
  return { content: '✨ Pronouns saved.', ephemeral: true };
}

async function cmdProfileSocial(env, guildId, userId, platform, handle) {
  if (!platform || !handle) return { content: 'Platform + handle required.', ephemeral: true };
  await setSocial(env, guildId, userId, platform, handle);
  return { content: '🔗 Saved ' + platform + ': ' + handle, ephemeral: true };
}

async function cmdProfileGamerTag(env, guildId, userId, platform, tag) {
  if (!platform || !tag) return { content: 'Platform + tag required.', ephemeral: true };
  await setGamerTag(env, guildId, userId, platform, tag);
  return { content: '🎮 Saved ' + platform + ': ' + tag, ephemeral: true };
}

async function cmdProfileClear(env, guildId, userId) {
  await clearProfile(env, guildId, userId);
  return { content: '🧹 Profile wiped.', ephemeral: true };
}

async function cmdProfileShow(env, guildId, targetId, callerName) {
  const p = await getProfile(env, guildId, targetId);
  const lines = [];
  lines.push('🪪 **<@' + targetId + '>**' + (p.pronouns ? '  *(' + p.pronouns + ')*' : ''));
  if (p.bio)             lines.push('> ' + p.bio);
  if (p.pfp)             lines.push('🖼️ ' + p.pfp);
  const socials = Object.entries(p.socials || {});
  if (socials.length > 0)
    lines.push('🔗 ' + socials.map(([k, v]) => k + ':' + v).join(' · '));
  const tags = Object.entries(p.gamerTags || {});
  if (tags.length > 0)
    lines.push('🎮 ' + tags.map(([k, v]) => k + ':' + v).join(' · '));
  if (lines.length === 1) lines.push('*(no profile saved yet — try `/profile-set-bio`)*');
  return { content: lines.join('\n'), ephemeral: targetId !== callerName };
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
