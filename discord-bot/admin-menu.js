// /admin -- server-admin hub. MANAGE_GUILD only (Discord enforces the
// gate via the command's default_member_permissions in commands-spec).
//
// Primary surface: "Setup & Status" dashboard. Channel bindings, integration
// health, and the manual checklist all live behind a single button so an
// admin sees the whole onboarding state in one place.
//
// Bindable channels (all per-guild KV):
//   sports:channel:guild:<g>       -- newly-seen games + @-mentions       (bet.js :23 cron)
//   stocks:ticker:guild:<g>        -- hourly price table, edited in place (stocks.js :17 cron)
//   bolts:feed:guild:<g>           -- hourly leaderboard + totals digest  (bolts-feed.js :23 cron)
//
// Channel selection uses Discord component type 8 (channel select menu) so
// admins pick the destination from a dropdown -- no need to re-run /admin
// in the target channel. We restrict to text + announcement channel types.
//
// Component routing prefix: "admin:".
//   admin:home               -- back to main view
//   admin:setup              -- open the Setup & Status dashboard
//   admin:setup:sel:<feed>   -- channel-select interaction, data.values[0] = channelId
//   admin:setup:clr:<feed>   -- clear a specific binding
//   admin:bind               -- legacy info screen (server bind code instructions)
//   admin:stocks             -- legacy info screen
//   admin:sports:bind/clear  -- legacy "bind to current channel" buttons (folded into Setup,
//                                kept routable so any old message components don't 500)
//   admin:bolts:bind/clear   -- same

import {
  bindTickerBoard,
  unbindTickerBoard,
  getTickerBoardForGuild,
  getCatalog,
  getPrice,
} from './stocks.js';
import { readGamesCache } from './bet.js';
import { bindBoltsFeed, getBoltsFeed, clearBoltsFeed } from './bolts-feed.js';

const RESP_CHAT            = 4;
const RESP_DEFER_UPDATE    = 6;
const RESP_UPDATE_MESSAGE  = 7;
const FLAG_EPHEMERAL = 1 << 6;

const COMPONENT_ROW         = 1;
const COMPONENT_BUTTON      = 2;
const COMPONENT_CHANNEL_SEL = 8;

const STYLE_PRIMARY    = 1;
const STYLE_SECONDARY  = 2;
const STYLE_SUCCESS    = 3;
const STYLE_DANGER     = 4;
const STYLE_LINK       = 5;

// Discord channel types: 0 = GUILD_TEXT, 5 = GUILD_ANNOUNCEMENT.
// We deliberately exclude voice/forum/thread types -- the bot posts text
// embeds that wouldn't render usefully in those.
const CHANNEL_TYPES_TEXT = [0, 5];

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
  // Preserve knownGameIds across re-binds so the cron doesn't re-announce
  // games it already mentioned (avoids "welcome to LIVE" spam after an
  // admin moves the feed to a different channel).
  const existing = await getSportsChannel(env, guildId);
  const knownGameIds = (existing && Array.isArray(existing.knownGameIds))
    ? existing.knownGameIds
    : [];
  await env.LOADOUT_BOLTS.put(
    SPORTS_CHANNEL_KEY(guildId),
    JSON.stringify({ channelId, knownGameIds, boundAt: Date.now() }),
  );
}

async function clearSportsChannel(env, guildId) {
  try { await env.LOADOUT_BOLTS.delete(SPORTS_CHANNEL_KEY(guildId)); } catch { /* idle */ }
}

// ---- main view --------------------------------------------------------

async function mainView() {
  return {
    embeds: [{
      title: '🛠 Admin hub',
      description:
        'Server-admin tools for Aquilo.\n\n' +
        '**Setup & Status** is the one-stop dashboard for channel bindings, ' +
        'integration health, and the manual onboarding checklist.',
      color: 0x9a82ff,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY, label: '🔧 Setup & Status', custom_id: 'admin:setup' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY, label: '🔗 Bind server',     custom_id: 'admin:bind' },
          { type: COMPONENT_BUTTON, style: STYLE_LINK,    label: 'Web admin',          url: 'https://aquilo.gg/admin' },
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

function errorView(msg) {
  return {
    embeds: [{ title: '⚠ Admin', description: msg, color: 0xff5c5c }],
    components: [backRow()],
  };
}

// ---- Setup & Status dashboard ----------------------------------------

function fmtAgo(ms) {
  if (!ms) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000)        return Math.round(delta / 1000) + 's ago';
  if (delta < 3_600_000)     return Math.round(delta / 60_000) + 'm ago';
  if (delta < 86_400_000)    return Math.round(delta / 3_600_000) + 'h ago';
  return Math.round(delta / 86_400_000) + 'd ago';
}

function bindLine(emoji, label, binding) {
  if (!binding || !binding.channelId) {
    return emoji + ' **' + label + '**: ⚫ Not bound';
  }
  const bound = binding.boundAt ? ' · bound ' + fmtAgo(binding.boundAt) : '';
  return emoji + ' **' + label + '**: 🟢 <#' + binding.channelId + '>' + bound;
}

async function runHealthChecks(env, guildId) {
  // Each check is wrapped so a single failure (e.g. KV transient error)
  // can't cascade and blank the whole dashboard.
  const checks = [];

  const tryCheck = async (label, fn) => {
    try { checks.push({ ok: true,  label, detail: await fn() }); }
    catch (e) { checks.push({ ok: false, label, detail: (e && e.message) || 'error' }); }
  };

  // Worker self-check is implicit -- if we're rendering, we're up.
  checks.push({ ok: true, label: 'Worker responding', detail: 'this request reached us' });

  // Cron presence is hardcoded in wrangler.toml; we re-affirm so admins
  // know the schedules are configured even if they can't see the toml.
  checks.push({ ok: true, label: 'Hourly crons', detail: '`:17` stocks · `:23` sports + bolts-feed' });

  await tryCheck('Stock catalog', async () => {
    const cat = await getCatalog(env);
    const n = (cat && cat.tickers && cat.tickers.length) || 0;
    if (n === 0) throw new Error('catalog empty -- run /admin web to seed');
    // Sample one price to confirm the catalog is actually populated with
    // fresh data, not just a stale shell.
    const sample = cat.tickers[0];
    const rec = await getPrice(env, sample.ticker);
    const priced = rec && rec.price ? ' · sample ' + sample.ticker + '=' + rec.price : ' · no prices yet';
    return n + ' tickers' + priced;
  });

  await tryCheck('Sports games cache', async () => {
    const games = await readGamesCache(env);
    const n = (games && games.length) || 0;
    if (n === 0) return 'empty (cron has not run yet or no games in window)';
    // games entries have a .date ISO field
    return n + ' games loaded';
  });

  await tryCheck('Team registry', async () => {
    const reg = await env.LOADOUT_BOLTS.get('sports:teams:registry', { type: 'json' });
    const n = (reg && Array.isArray(reg) && reg.length) || 0;
    if (n === 0) throw new Error('not yet seeded -- runs on first :23 cron tick');
    return n + ' teams indexed';
  });

  await tryCheck('Discord bot token', async () => {
    if (!env.DISCORD_BOT_TOKEN) throw new Error('not configured');
    return 'configured';
  });

  await tryCheck('Vault bolts secret', async () => {
    if (!env.AQUILO_VAULT_BOLTS_SECRET) throw new Error('not set (FS Bot /wallet will be dormant)');
    return 'configured';
  });

  await tryCheck('Discord public key', async () => {
    const pk = await env.LOADOUT_BOLTS.get('publickey');
    if (!pk) throw new Error('no `publickey` in KV -- interactions will 500');
    return 'configured (' + pk.length + ' chars)';
  });

  // Per-guild binding presence echoed back here as health signal, since
  // an unbound feed isn't surfaced anywhere else as "not configured."
  if (guildId) {
    const sports = await getSportsChannel(env, guildId);
    const stocks = await getTickerBoardForGuild(env, guildId);
    const bolts  = await getBoltsFeed(env, guildId);
    const boundCount = [sports, stocks, bolts].filter(Boolean).length;
    checks.push({
      ok: boundCount > 0,
      label: 'Channel bindings (this guild)',
      detail: boundCount + ' of 3 bound',
    });
  }

  return checks;
}

function manualChecklist() {
  // Things the bot genuinely can't verify from its own state. Each line
  // is a checkbox + one-liner so the dashboard doubles as an onboarding
  // guide.
  return [
    '☐ **Slash commands registered** — `POST /admin/register-commands/<install-id>` (HMAC-gated)',
    '☐ **Twitch Bits products published** — `loot_box`, `dungeon_skip_cooldown`, `song_request` in Twitch dev console',
    '☐ **TWITCH_EXT_SECRET set** on aquilo-site Pages (panel-ext JWT)',
    '☐ **panel-bridge.json** at `%APPDATA%\\Aquilo\\` (workerUrl + relayToken)',
    '☐ **Streamer.bot DLL installed** — run `Loadout/tools/install-dev.ps1`',
    '☐ **Aquilo Bus running** at `ws://127.0.0.1:7470` (started by Streamer.bot action)',
  ].join('\n');
}

async function setupView(env, guildId) {
  const sports = await getSportsChannel(env, guildId);
  const stocks = await getTickerBoardForGuild(env, guildId);
  const bolts  = await getBoltsFeed(env, guildId);

  const checks = await runHealthChecks(env, guildId);
  const checkLines = checks.map((c) => (c.ok ? '✓' : '✗') + ' ' + c.label + ' — ' + c.detail);

  const description =
    '**📡 Channel bindings**\n' +
    bindLine('🏈', 'Sports feed',  sports) + '\n' +
    bindLine('📈', 'Stocks ticker', stocks) + '\n' +
    bindLine('⚡', 'Bolts feed',   bolts) + '\n\n' +
    '**💚 Integration health**\n' +
    checkLines.join('\n') + '\n\n' +
    '**📋 Manual checklist** (bot can\'t verify; surface here so nothing slips)\n' +
    manualChecklist();

  return {
    embeds: [{
      title: '🔧 Setup & Status',
      description,
      color: 0x9a82ff,
      footer: { text: 'Pick channels below to bind. Clears are one click each.' },
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [{
          type: COMPONENT_CHANNEL_SEL,
          custom_id: 'admin:setup:sel:sports',
          placeholder: sports
            ? 'Sports feed: currently #' + (sports.channelId ? sports.channelId : '?')
            : '🏈 Bind sports feed channel...',
          channel_types: CHANNEL_TYPES_TEXT,
          min_values: 1, max_values: 1,
        }],
      },
      {
        type: COMPONENT_ROW,
        components: [{
          type: COMPONENT_CHANNEL_SEL,
          custom_id: 'admin:setup:sel:stocks',
          placeholder: stocks
            ? 'Stocks ticker: currently #' + (stocks.channelId ? stocks.channelId : '?')
            : '📈 Bind stocks ticker channel...',
          channel_types: CHANNEL_TYPES_TEXT,
          min_values: 1, max_values: 1,
        }],
      },
      {
        type: COMPONENT_ROW,
        components: [{
          type: COMPONENT_CHANNEL_SEL,
          custom_id: 'admin:setup:sel:bolts',
          placeholder: bolts
            ? 'Bolts feed: currently #' + (bolts.channelId ? bolts.channelId : '?')
            : '⚡ Bind bolts feed channel...',
          channel_types: CHANNEL_TYPES_TEXT,
          min_values: 1, max_values: 1,
        }],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '🛑 Clear sports', custom_id: 'admin:setup:clr:sports', disabled: !sports },
          { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '🛑 Clear stocks', custom_id: 'admin:setup:clr:stocks', disabled: !stocks },
          { type: COMPONENT_BUTTON, style: STYLE_DANGER,    label: '🛑 Clear bolts',  custom_id: 'admin:setup:clr:bolts',  disabled: !bolts },
        ],
      },
      backRow(),
    ],
  };
}

// ---- slash command entrypoint ----------------------------------------

export async function renderAdminCommand() {
  return {
    type: RESP_CHAT,
    data: { ...(await placeholderMain()), flags: FLAG_EPHEMERAL },
  };
}

async function placeholderMain() {
  // Slash-command entry: render a stub. The first button click re-renders
  // with real KV state (component handlers get env in scope).
  return {
    embeds: [{ title: '🛠 Admin hub', description: 'Loading…', color: 0x9a82ff }],
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: STYLE_PRIMARY, label: 'Open', custom_id: 'admin:home' },
      ],
    }],
  };
}

// ---- component dispatcher -------------------------------------------

export async function handleAdminComponent(data, env) {
  const guildId = data.guild_id;
  const channelId = data.channel_id || data.channel?.id;
  const customId = data.data?.custom_id || '';
  const values   = data.data?.values || [];
  if (!customId.startsWith('admin:')) {
    return json({ type: RESP_DEFER_UPDATE });
  }
  const path = customId.slice('admin:'.length);
  const segs = path.split(':');

  if (segs[0] === 'home') {
    return json({ type: RESP_UPDATE_MESSAGE, data: await mainView() });
  }
  if (segs[0] === 'bind') {
    return json({ type: RESP_UPDATE_MESSAGE, data: bindInfo() });
  }

  // ---- Setup & Status ----
  if (segs[0] === 'setup' && segs.length === 1) {
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }

  // Channel-select binds. data.values[0] is the chosen channelId.
  if (segs[0] === 'setup' && segs[1] === 'sel') {
    const feed = segs[2];
    const chosen = values[0];
    if (!chosen) {
      return json({ type: RESP_UPDATE_MESSAGE, data: errorView('No channel chosen.') });
    }
    if (feed === 'sports') {
      await setSportsChannel(env, guildId, chosen);
    } else if (feed === 'stocks') {
      const r = await bindTickerBoard(env, guildId, chosen);
      if (!r.ok) {
        return json({ type: RESP_UPDATE_MESSAGE, data: errorView('Stocks bind failed: ' + (r.reason || 'unknown')) });
      }
    } else if (feed === 'bolts') {
      const r = await bindBoltsFeed(env, guildId, chosen);
      if (!r.ok) {
        return json({ type: RESP_UPDATE_MESSAGE, data: errorView('Bolts bind failed: ' + (r.reason || 'unknown')) });
      }
    } else {
      return json({ type: RESP_UPDATE_MESSAGE, data: errorView('Unknown feed: ' + feed) });
    }
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }

  // Clears
  if (segs[0] === 'setup' && segs[1] === 'clr') {
    const feed = segs[2];
    if (feed === 'sports') await clearSportsChannel(env, guildId);
    else if (feed === 'stocks') await unbindTickerBoard(env, guildId);
    else if (feed === 'bolts')  await clearBoltsFeed(env, guildId);
    else return json({ type: RESP_UPDATE_MESSAGE, data: errorView('Unknown feed: ' + feed) });
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }

  // ---- Legacy routes (kept so older messages don't 500) ----
  // These bind to the channel /admin was run from. New flow uses channel
  // selects above; these stay routable until any pre-existing dashboards
  // age out of users' message history.
  if (segs[0] === 'stocks' && segs.length === 1) {
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }
  if (segs[0] === 'sports' && segs[1] === 'bind') {
    if (!channelId) return json({ type: RESP_UPDATE_MESSAGE, data: errorView("Couldn't read channel.") });
    await setSportsChannel(env, guildId, channelId);
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }
  if (segs[0] === 'sports' && segs[1] === 'clear') {
    await clearSportsChannel(env, guildId);
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }
  if (segs[0] === 'bolts' && segs[1] === 'bind') {
    if (!channelId) return json({ type: RESP_UPDATE_MESSAGE, data: errorView("Couldn't read channel.") });
    const r = await bindBoltsFeed(env, guildId, channelId);
    if (!r.ok) return json({ type: RESP_UPDATE_MESSAGE, data: errorView('Bind failed: ' + (r.reason || 'unknown error')) });
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }
  if (segs[0] === 'bolts' && segs[1] === 'clear') {
    await clearBoltsFeed(env, guildId);
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }

  return json({ type: RESP_DEFER_UPDATE });
}
