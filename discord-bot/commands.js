// Slash command + component + modal dispatcher.
//
// Slash commands published to Discord: /loadout-claim, /loadout.
// Everything else (balance, gift, daily, hero, equip, profile, etc.)
// runs through buttons + select menus + modals inside the /loadout
// ephemeral message — see loadout-menu.js for the entire menu graph.
//
// The legacy granular commands (/balance, /gift, /daily, /coinflip,
// /dice, /link, /help, /profile*, /hero, /inventory, /equip, /sell,
// /shop*, /training) are NOT published anymore but the underlying
// wallet / games / profile / dungeon modules stay — the menu calls
// them. If a user has a stale slash command lingering in their
// client, the dispatcher answers with a hint to use /loadout instead.
//
// Discord interaction types:
//   1 PING               — endpoint health check
//   2 APPLICATION_CMD    — slash command invocation
//   3 MESSAGE_COMPONENT  — button / select-menu click on our messages
//   5 MODAL_SUBMIT       — modal form submission
// Response types:
//   4 CHANNEL_MESSAGE_WITH_SOURCE — new ephemeral or public message
//   7 UPDATE_MESSAGE              — replace the source ephemeral message in place
//   9 MODAL                       — open a modal popup

import { renderLoadoutCommand, handleComponent, handleModal } from './loadout-menu.js';

const TYPE_PING                = 1;
const TYPE_APPLICATION_CMD     = 2;
const TYPE_MESSAGE_COMPONENT   = 3;
const TYPE_MODAL_SUBMIT        = 5;

const RESP_PONG                = 1;
const RESP_CHAT                = 4;

const FLAG_EPHEMERAL = 64;

const ACK_PONG = { type: RESP_PONG };

export async function handleInteraction(req, env, body) {
  let data;
  try { data = JSON.parse(body); }
  catch { return new Response('bad json', { status: 400 }); }

  if (data.type === TYPE_PING) return json(ACK_PONG);

  const guild = data.guild_id;
  const user  = data.member?.user || data.user;
  const userId = user?.id;
  const userName = user?.global_name || user?.username || 'viewer';

  if (!guild || !userId) {
    return json({ type: RESP_CHAT, data: { content: 'This command must be run in a server.', flags: FLAG_EPHEMERAL } });
  }

  if (data.type === TYPE_MESSAGE_COMPONENT) {
    return handleComponent(data, env);
  }
  if (data.type === TYPE_MODAL_SUBMIT) {
    return handleModal(data, env);
  }
  if (data.type !== TYPE_APPLICATION_CMD) {
    return json({ type: RESP_CHAT, data: { content: 'Unknown interaction type.', flags: FLAG_EPHEMERAL } });
  }

  const cmd = (data.data?.name || '').toLowerCase();
  switch (cmd) {
    case 'loadout':
      // Main menu — auto-creates the wallet (so first-time users see
      // 0 bolts rather than an error) and surfaces the link button if
      // they haven't connected a stream identity yet.
      return json(await renderLoadoutCommand(env, guild, userId, userName));

    case 'loadout-claim':
      // /loadout-claim is handled inline in worker.js (separate path)
      // because it needs to verify the install code without going
      // through the wallet/menu plumbing. If we end up here it means
      // worker.js fell through — best-effort hint.
      return reply('That command is handled by Loadout — try again in a moment.');

    // Fallthrough for legacy granular commands. We don't publish these
    // anymore but Discord caches client-side, so a stale entry might
    // still appear in someone's autocomplete. Send them to the menu.
    case 'balance': case 'gift': case 'daily': case 'leaderboard':
    case 'coinflip': case 'dice': case 'link': case 'help':
    case 'profile': case 'profile-set-bio': case 'profile-set-pfp':
    case 'profile-set-pronouns': case 'profile-set-social':
    case 'profile-set-gamertag': case 'profile-clear':
    case 'hero': case 'inventory': case 'equip': case 'unequip':
    case 'sell': case 'shop': case 'shop-buy': case 'training':
      return reply('💡 We replaced the individual commands with a single menu — run **/loadout** instead.');

    default:
      return reply('Unknown command: ' + cmd);
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
function reply(content, ephemeral = true) {
  const data = { content };
  if (ephemeral) data.flags = FLAG_EPHEMERAL;
  return json({ type: RESP_CHAT, data });
}
