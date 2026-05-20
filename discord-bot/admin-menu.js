// /admin — server-admin hub. MANAGE_GUILD only (Discord enforces the
// gate via the command's default_member_permissions in commands-spec).
//
// Surfaces:
//   - Install bind (/loadout-claim still exists as a direct command)
//   - Stocks ticker board (/stocks ticker-setup / ticker-clear remain
//     callable; this surfaces them in the admin UI)
//   - Sports feed channel (bind / clear) — used by bet.js's :23 cron
//     to post newly-seen games with @mentions
//   - Bolts feed channel (bind / clear) — hourly leaderboard + server
//     totals digest, edited in place by bolts-feed.js's tick (same
//     :23 cron as sports)
//
// Component routing prefix: "admin:".

import { bindBoltsFeed, getBoltsFeed, clearBoltsFeed } from './bolts-feed.js';

const RESP_CHAT            = 4;
const RESP_DEFER_UPDATE    = 6;
const RESP_UPDATE_MESSAGE  = 7;
const FLAG_EPHEMERAL = 1 << 6;

const COMPONENT_ROW    = 1;
const COMPONENT_BUTTON = 2;
const STYLE_PRIMARY    = 1;
const STYLE_SECONDARY  = 2;
const STYLE_SUCCESS    = 3;
const STYLE_DANGER     = 4;
const STYLE_LINK       = 5;

const SPORTS_CHANNEL_KEY = (guildId) => 'sports:channel:guild:' + guildId;

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function getSportsChannel(env, guildId) {
  try {
    return await env.LOADOUT_BOLTS.get(SPORTS_CHANNEL_KEY(guildId), { type: 'json' });
  } catch { return null; }
}

async function setSportsChannel(env, guildId, channelId) {
  await env.LOADOUT_BOLTS.put(
    SPORTS_CHANNEL_KEY(guildId),
    JSON.stringify({ channelId, knownGameIds: [], boundAt: Date.now() }),
  );
}

async function clearSportsChannel(env, guildId) {
  try { await env.LOADOUT_BOLTS.delete(SPORTS_CHANNEL_KEY(guildId)); } catch { /* idle */ }
}

async function mainView(env, guildId) {
  const sports = await getSportsChannel(env, guildId);
  const bolts  = await getBoltsFeed(env, guildId);
  const sportsLine = sports
    ? 'Sports feed: 🟢 bound to <#' + sports.channelId + '>'
    : 'Sports feed: ⚫ not bound';
  const boltsLine = bolts
    ? 'Bolts feed:  🟢 bound to <#' + bolts.channelId + '>'
    : 'Bolts feed:  ⚫ not bound';
  return {
    embeds: [{
      title: '🛠 Admin hub',
      description:
        'Server-admin tools for Aquilo.\n\n' +
        sportsLine + '\n' + boltsLine + '\n\n' +
        'Stocks ticker board uses `/stocks ticker-setup` in the target channel.',
      color: 0x9a82ff,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY, label: 'Bind server',     custom_id: 'admin:bind' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY, label: '📈 Stocks board', custom_id: 'admin:stocks' },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SUCCESS,   label: '🏈 Bind sports feed here', custom_id: 'admin:sports:bind' },
          { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '🛑 Clear sports feed',    custom_id: 'admin:sports:clear', disabled: !sports },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SUCCESS,   label: '⚡ Bind bolts feed here',  custom_id: 'admin:bolts:bind' },
          { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '🛑 Clear bolts feed',     custom_id: 'admin:bolts:clear', disabled: !bolts },
          { type: COMPONENT_BUTTON, style: STYLE_LINK,      label: 'Web admin',                url: 'https://aquilo.gg/admin' },
        ],
      },
    ],
  };
}

function backRow() {
  return {
    type: COMPONENT_ROW,
    components: [
      { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back', custom_id: 'admin:home' },
    ],
  };
}

function bindInfo() {
  return {
    embeds: [{
      title: '🔗 Bind server',
      description:
        'Open Loadout in Streamer.bot and visit **Settings → Discord bot** to copy the 8-character bind code, then run:\n\n' +
        '`/loadout-claim code:XXXXXXXX`\n\n' +
        'A successful bind ties this server to that Loadout install.',
      color: 0x9a82ff,
    }],
    components: [backRow()],
  };
}

function stocksInfo() {
  return {
    embeds: [{
      title: '📈 Stocks ticker board',
      description:
        '`/stocks ticker-setup` — run it **in the channel you want to use as the board**. The bot posts a single embed and edits it every hour.\n\n' +
        '`/stocks ticker-clear` — release the binding.',
      color: 0x9a82ff,
    }],
    components: [backRow()],
  };
}

export async function renderAdminCommand() {
  // Note: returned without env wiring — the dispatcher calls
  // handleAdminComponent with env in scope for re-renders.
  return {
    type: RESP_CHAT,
    data: { ...(await placeholderMain()), flags: FLAG_EPHEMERAL },
  };
}

// Slash-command entry uses this lazy initial render; the dispatcher
// fills in real KV state when env is available on component clicks.
async function placeholderMain() {
  return {
    embeds: [{
      title: '🛠 Admin hub',
      description: 'Loading…',
      color: 0x9a82ff,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY, label: 'Open', custom_id: 'admin:home' },
        ],
      },
    ],
  };
}

export async function handleAdminComponent(data, env) {
  const guildId = data.guild_id;
  const channelId = data.channel_id || data.channel?.id;
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('admin:')) {
    return json({ type: RESP_DEFER_UPDATE });
  }
  const path = customId.slice('admin:'.length);
  const segs = path.split(':');

  if (segs[0] === 'home') {
    return json({ type: RESP_UPDATE_MESSAGE, data: await mainView(env, guildId) });
  }
  if (segs[0] === 'bind') {
    return json({ type: RESP_UPDATE_MESSAGE, data: bindInfo() });
  }
  if (segs[0] === 'stocks') {
    return json({ type: RESP_UPDATE_MESSAGE, data: stocksInfo() });
  }
  if (segs[0] === 'sports' && segs[1] === 'bind') {
    if (!channelId) {
      return json({ type: RESP_UPDATE_MESSAGE, data: errorView("Couldn't read the current channel.") });
    }
    await setSportsChannel(env, guildId, channelId);
    return json({ type: RESP_UPDATE_MESSAGE, data: await mainView(env, guildId) });
  }
  if (segs[0] === 'sports' && segs[1] === 'clear') {
    await clearSportsChannel(env, guildId);
    return json({ type: RESP_UPDATE_MESSAGE, data: await mainView(env, guildId) });
  }
  if (segs[0] === 'bolts' && segs[1] === 'bind') {
    if (!channelId) {
      return json({ type: RESP_UPDATE_MESSAGE, data: errorView("Couldn't read the current channel.") });
    }
    const r = await bindBoltsFeed(env, guildId, channelId);
    if (!r.ok) {
      return json({ type: RESP_UPDATE_MESSAGE, data: errorView('Bind failed: ' + (r.reason || 'unknown error')) });
    }
    return json({ type: RESP_UPDATE_MESSAGE, data: await mainView(env, guildId) });
  }
  if (segs[0] === 'bolts' && segs[1] === 'clear') {
    await clearBoltsFeed(env, guildId);
    return json({ type: RESP_UPDATE_MESSAGE, data: await mainView(env, guildId) });
  }
  return json({ type: RESP_DEFER_UPDATE });
}

function errorView(msg) {
  return {
    embeds: [{ title: '⚠ Admin', description: msg, color: 0xff5c5c }],
    components: [backRow()],
  };
}
