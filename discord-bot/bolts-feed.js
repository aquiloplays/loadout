// Hourly bolts-feed channel.
//
// Design choice: digest-only, edit-in-place (option B in the spec).
// A per-transaction firehose would have meant threading a "maybe post"
// hook through every earn() / spend() / applyVaultDelta() call in
// wallet.js, touching the 15+ sites catalogued in economy.md just to
// gate them on a threshold + binding lookup. That risks regressions in
// the wallet primitive that the entire bolts economy rides on, and
// produces a feed that gets noisy fast even at threshold 250.
//
// Instead this module piggybacks on the existing :23 cron (alongside
// sports) to edit a single pinned digest message in place: top-10
// leaderboard + server totals, refreshed once an hour. Same UX shape
// as the stocks ticker board, same KV/Discord patch primitive.
//
// Per-transaction "X just hit a 10K jackpot!" notifications are still
// a worthwhile feature but want a separate notable-activity tail log
// in KV (`bolts:notable:<guildId>` capped at ~20 entries) plus a
// threshold-gated push. Left for a follow-up.
//
// KV:
//   bolts:feed:guild:<guildId>  -> { channelId, messageId, boundAt }
//
// Wired in:
//   admin-menu.js, bind / clear buttons
//   worker.js scheduled(), runs `boltsFeedCronTick` alongside betCronTick

import { leaderboard } from './wallet.js';

const FEED_KEY = (guildId) => 'bolts:feed:guild:' + guildId;

export async function getBoltsFeed(env, guildId) {
  try {
    return await env.LOADOUT_BOLTS.get(FEED_KEY(guildId), { type: 'json' });
  } catch { return null; }
}

export async function setBoltsFeed(env, guildId, channelId, messageId) {
  await env.LOADOUT_BOLTS.put(
    FEED_KEY(guildId),
    JSON.stringify({ channelId, messageId, boundAt: Date.now() }),
  );
}

export async function clearBoltsFeed(env, guildId) {
  try { await env.LOADOUT_BOLTS.delete(FEED_KEY(guildId)); } catch { /* idle */ }
}

async function listBoltsFeeds(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'bolts:feed:guild:', cursor });
    for (const k of r.keys) {
      const guildId = k.name.slice('bolts:feed:guild:'.length);
      const v = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (v && v.channelId && v.messageId) out.push({ guildId, ...v });
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

// Walk every wallet:<guildId>:* key to compute server-wide totals. This
// is the same prefix-scan pattern leaderboard() uses. Cheap enough for
// the hourly cron, KV list is paginated and we cap each page at 1000.
async function computeServerTotals(env, guildId) {
  let cursor;
  let totalBalance = 0;
  let totalEarned = 0;
  let totalSpent = 0;
  let wallets = 0;
  const prefix = 'wallet:' + guildId + ':';
  do {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor });
    for (const k of r.keys) {
      const w = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!w) continue;
      wallets += 1;
      totalBalance += Number(w.balance        || 0);
      totalEarned  += Number(w.lifetimeEarned || 0);
      totalSpent   += Number(w.lifetimeSpent  || 0);
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return { wallets, totalBalance, totalEarned, totalSpent };
}

function fmtNum(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export async function buildDigestEmbed(env, guildId) {
  const top = await leaderboard(env, guildId, 10);
  const totals = await computeServerTotals(env, guildId);

  let leaderboardBlock;
  if (!top || top.length === 0) {
    leaderboardBlock =
      '*No wallets yet, earn bolts via `/loadout daily`, mini-games, bets, ' +
      'or stocks to land on this board.*';
  } else {
    const rows = top.map((entry, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      const rank = String(i + 1).padStart(2);
      const bal  = fmtNum(entry.w && entry.w.balance).padStart(8);
      return medal + ' `' + rank + '` ' + bal + ' ⚡  <@' + entry.userId + '>';
    });
    leaderboardBlock = rows.join('\n');
  }

  const totalsBlock =
    '`wallets         ` ' + totals.wallets + '\n' +
    '`in circulation  ` ' + fmtNum(totals.totalBalance) + ' ⚡\n' +
    '`lifetime earned ` ' + fmtNum(totals.totalEarned) + ' ⚡\n' +
    '`lifetime spent  ` ' + fmtNum(totals.totalSpent) + ' ⚡';

  return {
    title: '⚡ Bolts feed',
    description:
      'Server-wide bolts economy. Refreshed hourly.\n\n' +
      '**Top 10**\n' + leaderboardBlock + '\n\n' +
      '**Server totals**\n' + totalsBlock,
    color: 0xf7b500,
    footer: { text: 'Earn with /loadout, mini-games, bets, stocks · /wallet shows yours' },
    timestamp: new Date().toISOString(),
  };
}

// Discord REST helpers, duplicated from stocks.js intentionally so this
// module has no inbound dep on stocks.js. Keep both copies thin.
//
// Returns the HTTP status (0 on network failure) instead of just a
// boolean so the caller can distinguish "message gone" (404) from
// "Discord blip" (5xx). The latter should NOT unbind the feed, // otherwise one transient Discord outage permanently silences every
// guild's hourly digest until a streamer re-binds.
async function discordPatchMessage(env, channelId, messageId, body) {
  if (!env.DISCORD_BOT_TOKEN) return 0;
  try {
    const res = await fetch(
      'https://discord.com/api/v10/channels/' +
        encodeURIComponent(channelId) +
        '/messages/' +
        encodeURIComponent(messageId),
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    return res.status;
  } catch {
    return 0;
  }
}

export async function discordPostMessage(env, channelId, body) {
  if (!env.DISCORD_BOT_TOKEN) return null;
  try {
    const res = await fetch(
      'https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) + '/messages',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Post the initial digest message in `channelId` and store the binding.
// Returns true on success. Caller surfaces the result to the admin.
export async function bindBoltsFeed(env, guildId, channelId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, reason: 'bot token missing' };
  const embed = await buildDigestEmbed(env, guildId);
  const msg = await discordPostMessage(env, channelId, { embeds: [embed] });
  if (!msg || !msg.id) return { ok: false, reason: "couldn't post message, check channel perms" };
  await setBoltsFeed(env, guildId, channelId, msg.id);
  return { ok: true, channelId, messageId: msg.id };
}

// Edit every bound digest message in place. Releases the binding for
// any message that's gone (PATCH 404), so we don't keep retrying.
// Transient Discord 5xx / network failures leave the binding alone so
// one outage doesn't silently mass-unbind every guild's hourly digest.
export async function boltsFeedCronTick(env) {
  const feeds = await listBoltsFeeds(env);
  if (feeds.length === 0) return;
  for (const f of feeds) {
    const embed = await buildDigestEmbed(env, f.guildId);
    const status = await discordPatchMessage(env, f.channelId, f.messageId, { embeds: [embed] });
    // 404 = message deleted, 403 = lost channel perms, both worth
    // releasing the binding for. Anything else (5xx, network blip, 0)
    // is transient, keep the binding and retry next hour.
    if (status === 404 || status === 403) await clearBoltsFeed(env, f.guildId);
  }
}
