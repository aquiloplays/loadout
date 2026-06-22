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

// (Bolts economy sunset 2026-06: the stocks.js / bet.js / bolts-feed.js
// imports — and the sports-feed / stocks-ticker / bolts-feed channel
// bindings + health checks + pipe tests they powered — were removed.
// The admin dashboard now manages only the non-currency check-in
// channel binding.)

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

const CHECKIN_CHANNEL_KEY = (guildId) => 'checkin:channel:guild:' + guildId;

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// (Bolts economy sunset: the sports-feed channel binding helpers
// getSportsChannel / setSportsChannel / clearSportsChannel were removed.)

// Discord pic/gif check-in channel binding. Read by aquilo-bot's
// checkin.js (filter incoming MESSAGE_CREATE forwards) AND by
// aquilo-presence (decide which channels to forward at all). Both
// reach this binding through the public GET /checkin-channel/:guildId
// endpoint at the bottom of this module -- no shared KV.
export async function getCheckinChannel(env, guildId) {
  try {
    return await env.LOADOUT_BOLTS.get(CHECKIN_CHANNEL_KEY(guildId), { type: 'json' });
  } catch { return null; }
}

async function setCheckinChannel(env, guildId, channelId) {
  await env.LOADOUT_BOLTS.put(
    CHECKIN_CHANNEL_KEY(guildId),
    JSON.stringify({ channelId, boundAt: Date.now() }),
  );
}

async function clearCheckinChannel(env, guildId) {
  try { await env.LOADOUT_BOLTS.delete(CHECKIN_CHANNEL_KEY(guildId)); } catch { /* idle */ }
}

// Public read endpoint for cross-Worker / aquilo-presence consumers.
// No auth -- channel IDs aren't sensitive (anyone in the guild can
// see them), and gating this would force every poller through a
// shared-secret setup that buys nothing.
//
// URL: GET /checkin-channel/:guildId
// Response: { channelId: string | null, boundAt?: number }
export async function handleCheckinChannelRead(env, guildId) {
  const v = await getCheckinChannel(env, guildId);
  return json({
    channelId: (v && v.channelId) || null,
    boundAt:   (v && v.boundAt)   || 0,
  });
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
  if (!ms) return '-';
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
  checks.push({ ok: true, label: 'Hourly crons', detail: '`:23` community tasks · `:17` Twitch/roster' });

  await tryCheck('Discord bot token', async () => {
    if (!env.DISCORD_BOT_TOKEN) throw new Error('not configured');
    return 'configured';
  });

  await tryCheck('Discord public key', async () => {
    const pk = await env.LOADOUT_BOLTS.get('publickey');
    if (!pk) throw new Error('no `publickey` in KV -- interactions will 500');
    return 'configured (' + pk.length + ' chars)';
  });

  // Per-guild binding presence echoed back here as a health signal.
  if (guildId) {
    const checkin = await getCheckinChannel(env, guildId);
    checks.push({
      ok: !!checkin,
      label: 'Check-in channel binding (this guild)',
      detail: checkin ? 'bound' : 'not bound',
    });
  }

  return checks;
}

function manualChecklist() {
  // Things the bot genuinely can't verify from its own state. Each line
  // is a checkbox + one-liner so the dashboard doubles as an onboarding
  // guide.
  return [
    '☐ **Slash commands registered**, `POST /admin/register-commands/<install-id>` (HMAC-gated)',
    '☐ **Twitch Bits products published**, `loot_box`, `dungeon_skip_cooldown`, `song_request` in Twitch dev console',
    '☐ **TWITCH_EXT_SECRET set** on aquilo-site Pages (panel-ext JWT)',
    '☐ **panel-bridge.json** at `%APPDATA%\\Aquilo\\` (workerUrl + relayToken)',
    '☐ **Streamer.bot DLL installed**, run `Loadout/tools/install-dev.ps1`',
    '☐ **Aquilo Bus running** at `ws://127.0.0.1:7470` (started by Streamer.bot action)',
  ].join('\n');
}

async function setupView(env, guildId) {
  const checkin = await getCheckinChannel(env, guildId);

  const checks = await runHealthChecks(env, guildId);
  const checkLines = checks.map((c) => (c.ok ? '✓' : '✗') + ' ' + c.label + ', ' + c.detail);

  const description =
    '**📡 Channel bindings**\n' +
    bindLine('📸', 'Check-in',      checkin) + '\n\n' +
    '**💚 Integration health**\n' +
    checkLines.join('\n') + '\n\n' +
    '**📋 Manual checklist** (bot can\'t verify; surface here so nothing slips)\n' +
    manualChecklist();

  // Status view: read-only dashboard + clear + nav buttons. The
  // editable channel select lives in a separate "Edit" view.
  return {
    embeds: [{
      title: '🔧 Setup & Status',
      description,
      color: 0x9a82ff,
      footer: { text: 'Click "Edit bindings" to pick the check-in channel.' },
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_DANGER, label: '🛑 Clear check-in', custom_id: 'admin:setup:clr:checkin', disabled: !checkin },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back',           custom_id: 'admin:home' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '✏ Edit bindings',  custom_id: 'admin:setup:edit' },
        ],
      },
    ],
  };
}

// Edit view: 4 channel-select dropdowns + a back button. Lives behind
// the Edit bindings button on setupView. Each select fires
// admin:setup:sel:<feed>; the handler binds and re-renders the status
// view so admins see the new state immediately.
async function editBindingsView(env, guildId) {
  const checkin = await getCheckinChannel(env, guildId);

  return {
    embeds: [{
      title: '✏ Edit channel bindings',
      description:
        'Pick a channel from the dropdown to bind the daily check-in feed. ' +
        'The bot needs **View + Send Messages + Embed Links + Add Reactions** ' +
        'in the chosen channel. Updates take effect within ~5 minutes ' +
        '(presence-service poll).\n\n' +
        bindLine('📸', 'Check-in',      checkin),
      color: 0x9a82ff,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [{
          type: COMPONENT_CHANNEL_SEL,
          custom_id: 'admin:setup:sel:checkin',
          placeholder: '📸 Bind check-in channel (image-post = daily check-in)...',
          channel_types: CHANNEL_TYPES_TEXT,
          min_values: 1, max_values: 1,
        }],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back to status', custom_id: 'admin:setup' },
        ],
      },
    ],
  };
}

// ---- Pipe tests ------------------------------------------------------
//
// Owner-gated diagnostic. Each pipe is a real upstream/internal round-trip
// so a stuck Yahoo or ESPN call surfaces immediately instead of going
// unnoticed until viewers complain. Discord's 3s interaction window can't
// hold these (~1-5s each), so the handler ACKs with DEFERRED_UPDATE_MESSAGE
// and the work runs under ctx.waitUntil() before PATCHing the original
// message via the interaction webhook.

const PIPE_TIMEOUT_MS = 10_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout after ' + ms + 'ms (' + label + ')')), ms),
    ),
  ]);
}

// (Bolts economy sunset: pipeStocks / pipeSports / pipeBoltsCompute /
// pipeChannelReach were removed — they exercised the deleted
// stocks.js / bet.js / bolts-feed.js data paths.)

async function pipeKvRoundtrip(env) {
  const key = 'pipetest:rt:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
  const payload = 'ok-' + Date.now();
  await env.LOADOUT_BOLTS.put(key, payload, { expirationTtl: 60 });
  const got = await env.LOADOUT_BOLTS.get(key);
  await env.LOADOUT_BOLTS.delete(key);
  if (got !== payload) throw new Error('KV read returned ' + JSON.stringify(got));
  return 'KV write -> read -> delete OK';
}

async function runOnePipe(label, fn) {
  const t0 = Date.now();
  try {
    const detail = await withTimeout(fn(), PIPE_TIMEOUT_MS, label);
    return { ok: true, label, detail, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, label, detail: (e && e.message) || 'error', ms: Date.now() - t0 };
  }
}

// Exported so the web admin (admin-web.js POST /web/admin/pipe-tests)
// can run the same five checks the Discord /admin "Run pipe tests"
// button does. Returns the same { results, totalMs } envelope the
// Discord results view consumes, so any future check we add lands on
// both surfaces at once.
export async function runAllPipes(env, guildId) {
  // (Bolts economy sunset: pipes 1-4 — Stocks/Sports/Bolts-feed/economy
  // channel-binding reach — were removed. Only the generic KV round-trip
  // remains.)
  const t0 = Date.now();
  const results = await Promise.all([
    runOnePipe('KV round-trip', () => pipeKvRoundtrip(env)),
  ]);
  return { results, totalMs: Date.now() - t0 };
}

function pipeResultsView(report) {
  const { results, totalMs } = report;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const allOk = failed === 0;

  const lines = results.map((r) => {
    const icon = r.ok ? '✅' : '❌';
    return icon + ' **' + r.label + '**, ' + r.ms + 'ms · ' + r.detail;
  });

  const color = allOk ? 0x46d160 : (passed >= 3 ? 0xf7b500 : 0xff5c5c);

  return {
    embeds: [{
      title: '🧪 Pipe Test Results',
      description: lines.join('\n'),
      color,
      footer: {
        text: passed + '/' + results.length + ' passed · total ' + totalMs + 'ms',
      },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back',    custom_id: 'admin:setup' },
        { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '🔄 Re-run', custom_id: 'admin:setup:pipetest' },
      ],
    }],
  };
}

// PATCH the original interaction message via the webhook URL. The token in
// the URL is itself the auth -- no Bot header. 15-minute window from the
// interaction's creation; we're well inside that.
async function patchOriginalInteraction(env, interactionToken, body) {
  const appId = env.DISCORD_APP_ID;
  if (!appId) {
    console.error('patchOriginalInteraction: DISCORD_APP_ID env var missing');
    return;
  }
  try {
    const res = await fetch(
      'https://discord.com/api/v10/webhooks/' +
        encodeURIComponent(appId) +
        '/' + encodeURIComponent(interactionToken) +
        '/messages/@original',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      console.error('patchOriginalInteraction failed: HTTP', res.status, await res.text());
    }
  } catch (e) {
    console.error('patchOriginalInteraction threw:', e && e.message);
  }
}

async function runPipeTestsAndPatch(env, interactionToken, guildId) {
  const report = await runAllPipes(env, guildId);
  const view = pipeResultsView(report);
  await patchOriginalInteraction(env, interactionToken, view);
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

export async function handleAdminComponent(data, env, ctx) {
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

  // Edit-bindings sub-view. Holds the 4 channel-select dropdowns
  // (separated from the status view because 4 selects + clears + nav
  // exceeds Discord's 5-row message limit).
  if (segs[0] === 'setup' && segs[1] === 'edit') {
    return json({ type: RESP_UPDATE_MESSAGE, data: await editBindingsView(env, guildId) });
  }

  // Pipe tests: ACK with DEFERRED_UPDATE_MESSAGE so the user sees the
  // existing message stay (with a "thinking" indicator on the button),
  // then run the tests under ctx.waitUntil and PATCH the original.
  // Discord allows up to 15 minutes for the follow-up PATCH; with all
  // pipes capped at 10s each running in parallel, total wall time is
  // bounded at ~10s + Discord PATCH overhead.
  if (segs[0] === 'setup' && segs[1] === 'pipetest') {
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(runPipeTestsAndPatch(env, data.token, guildId));
    } else {
      // No ctx (shouldn't happen in production -- worker.js threads it
      // through). Fall back to inline await; user sees a longer wait but
      // gets a real result instead of a silent no-op.
      await runPipeTestsAndPatch(env, data.token, guildId);
    }
    return json({ type: RESP_DEFER_UPDATE });
  }

  // Channel-select binds. data.values[0] is the chosen channelId.
  // (Bolts economy sunset: only the check-in feed binding remains;
  // sports/stocks/bolts feed binds were removed.)
  if (segs[0] === 'setup' && segs[1] === 'sel') {
    const feed = segs[2];
    const chosen = values[0];
    if (!chosen) {
      return json({ type: RESP_UPDATE_MESSAGE, data: errorView('No channel chosen.') });
    }
    if (feed === 'checkin') {
      // The Discord pic/gif check-in. Just stores the channel id;
      // aquilo-bot's checkin.js polls this binding via the public
      // /checkin-channel/:guildId endpoint and aquilo-presence does
      // the same to know which channel to forward MESSAGE_CREATE for.
      await setCheckinChannel(env, guildId, chosen);
    } else {
      return json({ type: RESP_UPDATE_MESSAGE, data: errorView('Unknown feed: ' + feed) });
    }
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }

  // Clears
  if (segs[0] === 'setup' && segs[1] === 'clr') {
    const feed = segs[2];
    if (feed === 'checkin') await clearCheckinChannel(env, guildId);
    else return json({ type: RESP_UPDATE_MESSAGE, data: errorView('Unknown feed: ' + feed) });
    return json({ type: RESP_UPDATE_MESSAGE, data: await setupView(env, guildId) });
  }

  // (Bolts economy sunset: the legacy bind-to-current-channel routes for
  // sports / stocks / bolts feeds were removed.)

  return json({ type: RESP_DEFER_UPDATE });
}
