// /admin — server-admin hub. MANAGE_GUILD only (enforced by Discord's
// default_member_permissions in commands-spec.js).
//
// Today the admin surface is just the Loadout install bind. As more
// admin actions land (e.g. resetting a guild's stocks ticker board,
// purging a viewer's holdings, etc.) they slot in here as additional
// buttons. Component routing prefix: "admin:".

const RESP_CHAT            = 4;
const RESP_UPDATE_MESSAGE  = 7;
const RESP_DEFER_UPDATE    = 6;
const FLAG_EPHEMERAL = 1 << 6;

const COMPONENT_ROW    = 1;
const COMPONENT_BUTTON = 2;
const STYLE_PRIMARY    = 1;
const STYLE_SECONDARY  = 2;
const STYLE_LINK       = 5;

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mainView() {
  return {
    embeds: [{
      title: '🛠 Admin hub',
      description:
        'Server-admin tools for Loadout.\n\n' +
        '• **Bind** — link this server to a Loadout install (or run `/loadout-claim code:<…>`)\n' +
        '• **Stocks board** — set or clear the auto-updating ticker channel (`/stocks ticker-setup` / `/stocks ticker-clear`)\n' +
        '• **Web admin** — full content + catalog editors at https://aquilo.gg/admin',
      color: 0x9a82ff,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: 'Bind server',     custom_id: 'admin:bind'   },
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: 'Stocks board',    custom_id: 'admin:stocks' },
          { type: COMPONENT_BUTTON, style: STYLE_LINK,      label: 'Web admin',       url: 'https://aquilo.gg/admin' },
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
        'A successful bind ties this server to that Loadout install — wallets, holdings, and bets all live in the same KV namespace per guild.',
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
        '`/stocks ticker-setup` — run it **in the channel you want to use as the board**. The bot posts a single embed and edits it in place every hour with the latest prices.\n\n' +
        '`/stocks ticker-clear` — release the binding. The previous message stays; the bot just stops updating it.',
      color: 0x9a82ff,
    }],
    components: [backRow()],
  };
}

export async function renderAdminCommand() {
  return { type: RESP_CHAT, data: { ...mainView(), flags: FLAG_EPHEMERAL } };
}

export async function handleAdminComponent(data) {
  const customId = data.data?.custom_id || '';
  if (!customId.startsWith('admin:')) {
    return json({ type: RESP_DEFER_UPDATE });
  }
  const view = customId.slice('admin:'.length);
  let payload;
  switch (view) {
    case 'home':   payload = mainView();    break;
    case 'bind':   payload = bindInfo();    break;
    case 'stocks': payload = stocksInfo();  break;
    default:       return json({ type: RESP_DEFER_UPDATE });
  }
  return json({ type: RESP_UPDATE_MESSAGE, data: payload });
}
