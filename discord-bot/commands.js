// Slash command + component + modal dispatcher.
//
// Slash commands published to Discord: /loadout-claim, /loadout.
// Everything else (balance, gift, daily, hero, equip, profile, etc.)
// runs through buttons + select menus + modals inside the /loadout
// ephemeral message, see loadout-menu.js for the entire menu graph.
//
// The legacy granular commands (/balance, /gift, /daily, /coinflip,
// /dice, /link, /help, /profile*, /hero, /inventory, /equip, /sell,
// /shop*, /training) are NOT published anymore but the underlying
// wallet / games / profile / dungeon modules stay, the menu calls
// them. If a user has a stale slash command lingering in their
// client, the dispatcher answers with a hint to use /loadout instead.
//
// Discord interaction types:
//   1 PING, endpoint health check
//   2 APPLICATION_CMD, slash command invocation
//   3 MESSAGE_COMPONENT, button / select-menu click on our messages
//   5 MODAL_SUBMIT, modal form submission
// Response types:
//   4 CHANNEL_MESSAGE_WITH_SOURCE, new ephemeral or public message
//   7 UPDATE_MESSAGE, replace the source ephemeral message in place
//   9 MODAL, open a modal popup

import { renderLoadoutCommand, handleComponent, handleModal } from './loadout-menu.js';
import { renderAdminCommand, handleAdminComponent } from './admin-menu.js';
import { handleSchedule, handleGames } from './schedule.js';
import { handleQueueSlash } from './queue.js';
// Aquilo-bot fold-in. Single dispatcher that owns the aquilo command
// family, see discord-bot/aquilo/worker.js dispatchAquiloInteraction.
import { dispatchAquiloInteraction } from './aquilo/worker.js';
// NOTE (Bolts economy sunset 2026-06): the /bet (sports betting),
// /boltbound (card-battler) and /play (quick games) command imports
// were removed here. The Boltbound files (cards*.js, boltbound-*.js)
// stay on disk for a future revival but are no longer wired into the
// dispatch graph, so esbuild no longer bundles them.

const TYPE_PING                = 1;
const TYPE_APPLICATION_CMD     = 2;
const TYPE_MESSAGE_COMPONENT   = 3;
const TYPE_AUTOCOMPLETE        = 4;
const TYPE_MODAL_SUBMIT        = 5;

const RESP_PONG                = 1;
const RESP_CHAT                = 4;

const FLAG_EPHEMERAL = 64;

const ACK_PONG = { type: RESP_PONG };

// Aquilo-bot fold-in: button/select custom_id prefixes that the aquilo
// dispatch family owns. The hub:* prefix is intentionally NOT here, // it was rewritten to aquilo:* during the fold-in to avoid colliding
// with Loadout's viewer hub. See BOT-CONSOLIDATION-STATUS.md.
const AQUILO_COMPONENT_PREFIXES = [
  'vote:', 'queue:', 'aquilo:', 'notify:', 'tot:', 'sug:', 'roles:',
  'setup:', 'vh:', 'passport:', 'trivia:', 'ticket:',
  // /checkin gif picker, see aquilo/checkin-slash.js
  'aqci:',
];

export async function handleInteraction(req, env, body, ctx) {
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
    // Route by custom_id prefix so each menu's components stay scoped.
    const cid = data.data?.custom_id || '';
    if (cid.startsWith('guild:'))     {
      const { handleGuildComponent } = await import('./guild-features.js');
      return json(await handleGuildComponent(env, data));
    }
    if (cid.startsWith('onb:'))       {
      // Bot-driven onboarding flow, see onboarding.js. Buttons +
      // selects all start with `onb:` (begin, restart, step:<id>,
      // advance:<id>, pick:<id>).
      const { handleOnboardComponent } = await import('./onboarding.js');
      return json(await handleOnboardComponent(env, data));
    }
    if (cid.startsWith('lfg:'))       {
      // LFG hub buttons + Join buttons on enriched pings.
      // See lfg-hub.js for the component catalogue.
      const { handleLfgHubComponent } = await import('./lfg-hub.js');
      return json(await handleLfgHubComponent(env, data));
    }
    if (cid.startsWith('cnv:'))       {
      // Legacy CN vote menu, retired in favour of `vh:` below, but
      // kept dispatching so stale-button clicks on un-swept old
      // messages route somewhere sensible.
      const { handleCnVoteComponent } = await import('./cn-vote-hub.js');
      return json(await handleCnVoteComponent(env, data));
    }
    if (cid.startsWith('vh:'))        {
      // Unified vote hub, variety + community night, state-machine
      // driven. See vote-hub.js.
      const { handleVoteHubComponent } = await import('./vote-hub.js');
      return json(await handleVoteHubComponent(env, data));
    }
    // Phase-1 channel hubs (check-in / character / bolts / play /
    // achievements). Each prefix routes to its own handler in
    // channel-hubs.js.
    if (cid.startsWith('checkin:'))   {
      const { handleCheckinHubComponent } = await import('./channel-hubs.js');
      return json(await handleCheckinHubComponent(env, data));
    }
    if (cid.startsWith('ach:'))       {
      const { handleAchievementsHubComponent } = await import('./channel-hubs.js');
      return json(await handleAchievementsHubComponent(env, data));
    }
    if (cid.startsWith('ticket:'))    {
      const { handleTicketComponent } = await import('./tickets.js');
      return json(await handleTicketComponent(env, data));
    }
    if (cid.startsWith('tempvc:'))    {
      const { handleTempVcComponent } = await import('./temp-vc.js');
      return json(await handleTempVcComponent(env, data));
    }
    if (cid.startsWith('setup:'))     {
      // /loadout-setup wizard step buttons.
      const { handleSetupComponent } = await import('./setup-wizard.js');
      return json(await handleSetupComponent(env, data));
    }
    if (cid.startsWith('admin:'))     return handleAdminComponent(data, env, ctx);
    if (cid.startsWith('gm:')) {
      const { handleGamesMenuComponent } = await import('./games-menu.js');
      return json(await handleGamesMenuComponent(data, env, ctx));
    }
    if (cid.startsWith('poll:')) {
      // Custom-poll dispatch: poll:vote:<id> (select submit) and
      // poll:standings:<id> (button). See custom-polls.js.
      const seg = cid.split(':')[1];
      if (seg === 'vote') {
        const { handlePollVote } = await import('./custom-polls.js');
        return json(await handlePollVote(data, env));
      }
      if (seg === 'standings') {
        const { handlePollStandings } = await import('./custom-polls.js');
        return json(await handlePollStandings(data, env));
      }
    }
    if (cid.startsWith('st:')) {
      // Support tickets, string-select / button dispatch. See
      // support-tickets.js. Modal submission is routed in the
      // modal-submit branch below (Discord interaction-type 5).
      const { handleSupportTicketComponent } = await import('./support-tickets.js');
      return json(await handleSupportTicketComponent(data, env));
    }
    // Aquilo-bot fold-in: every aquilo component custom_id is
    // namespaced (vote:*, queue:*, aquilo:*, notify:*, tot:*, sug:*,
    // roles:*, setup:*, vh:*, passport:*, trivia:*, shop:*,
    // ticket:*) so we can just match the prefix here and delegate.
    if (AQUILO_COMPONENT_PREFIXES.some(p => cid.startsWith(p))) {
      return dispatchAquiloInteraction(data, env, ctx);
    }
    return handleComponent(data, env);
  }
  if (data.type === TYPE_AUTOCOMPLETE) {
    // No autocomplete-backed commands remain after the Bolts economy
    // sunset (the only one was /bet sports place). Fall through with
    // empty choices for any stale client still sending autocomplete.
    return json({ type: 8, data: { choices: [] } });
  }
  if (data.type === TYPE_MODAL_SUBMIT) {
    // Aquilo-bot modals use a bare `modal:*` prefix. (The Loadout
    // viewer-hub `hub:modal:*` route was removed with the Bolts
    // economy sunset — /hub was the wallet/stocks/sports hub.)
    const cid = data.data?.custom_id || '';
    // LFG hub create modal, bare modal:lfg-* prefix, claimed here
    // before the generic modal:* aquilo route.
    if (cid.startsWith('modal:lfg-')) {
      const { handleLfgModalSubmit } = await import('./lfg-hub.js');
      return json(await handleLfgModalSubmit(env, data));
    }
    // Support tickets, modal submit (subject + description).
    if (cid.startsWith('st:submit:')) {
      const { handleSupportTicketModal } = await import('./support-tickets.js');
      return json(await handleSupportTicketModal(data, env));
    }
    if (cid.startsWith('modal:'))     return dispatchAquiloInteraction(data, env, ctx);
    if (cid.startsWith('tempvc:')) {
      const { handleTempVcModal } = await import('./temp-vc.js');
      return json(await handleTempVcModal(env, data));
    }
    return handleModal(data, env);
  }
  if (data.type !== TYPE_APPLICATION_CMD) {
    return json({ type: RESP_CHAT, data: { content: 'Unknown interaction type.', flags: FLAG_EPHEMERAL } });
  }

  const cmd = (data.data?.name || '').toLowerCase();

  // Per-guild command-channel binding gate. If the server admin has
  // restricted this command via /loadout-setup bind, refuse here
  // before any handler-specific logic. Buttons/select-menus/modals
  // bypass this gate (they're contextual to where their parent
  // interaction was opened). /loadout-setup itself + the legacy
  // /loadout-claim are always allowed so admins can't lock
  // themselves out.
  if (data.guild_id && !['loadout-setup', 'loadout-claim'].includes(cmd)) {
    try {
      const { isCommandAllowedHere, wrongChannelReply } = await import('./command-bindings.js');
      const channelId = data.channel_id || data.channel?.id;
      const gate = await isCommandAllowedHere(env, data.guild_id, cmd, channelId);
      if (!gate.ok && gate.allowed.length) {
        return json(wrongChannelReply(cmd, gate.allowed));
      }
    } catch { /* fall through, bindings are best-effort */ }
  }

  switch (cmd) {
    case 'loadout':
      // Slimmed profile menu (Bolts economy sunset). Opens the
      // ephemeral profile editor (bio / pic / pronouns / socials /
      // gamer tags). See loadout-menu.js.
      return json(await renderLoadoutCommand(env, guild, userId, userName));

    case 'admin':
      // Admin-side hub. MANAGE_GUILD enforced by Discord via the
      // command's default_member_permissions; an extra in-handler
      // check would only fire if Discord changed its enforcement
      // model, so we trust the platform here.
      // (The Boltbound `card-art` subcommand-group was removed with
      // the economy sunset; bare /admin renders the hub.)
      return json(await renderAdminCommand());

    case 'twitch-event': {
      // Per-event-type routing + on/off toggle. See twitch-events.js
      // for the routing model. MANAGE_GUILD enforced by Discord
      // (default_member_permissions on the command).
      const { handleTwitchEventSlash } = await import('./twitch-events-admin.js');
      return json(await handleTwitchEventSlash(env, guild, data.data?.options || []));
    }

    case 'gift':
      // Patreon fan-to-fan gifting CTA. Returns a single ephemeral
      // violet embed + a LINK button to patreon.com/aquilo/gift. No
      // round-trips through the worker after the ack.
      return json({
        type: 4,   // CHANNEL_MESSAGE_WITH_SOURCE
        data: {
          flags: 64,   // EPHEMERAL
          embeds: [{
            title: '💝 Gift Aquilo Supporter access',
            description: [
              "Gift Aquilo Supporter access to a friend, every paid gift gets them all the Patreon perks in the Aquilo ecosystem.",
              "",
              "Patreon hosts the checkout flow. Pick 1-12 months, any tier, they get the gift link via email + redeem on patreon.com.",
              "",
              "**[Open Patreon gift link below ↓](https://www.patreon.com/aquilo/gift)**",
            ].join('\n'),
            color: 0x7c5cff,
            footer: { text: 'fan-to-fan gifting · powered by Patreon' },
          }],
          components: [{
            type: 1,
            components: [{
              type:  2,
              style: 5,   // LINK
              label: 'Open gift flow on Patreon',
              emoji: { name: '💝' },
              url:   'https://www.patreon.com/aquilo/gift',
            }],
          }],
        },
      });

    case 'schedule':
      // Stream-schedule editor, writes the same `schedule:v1:<g>` KV
      // record that aquilo.gg/admin writes. MANAGE_GUILD enforced by
      // Discord (default_member_permissions).
      return json(await handleSchedule(env, guild, data.data?.options || []));

    case 'games':
      // Game-catalog editor, companion to /schedule. Writes
      // `games:v1:<g>` shared with aquilo.gg/admin.
      return json(await handleGames(env, guild, data.data?.options || []));

    case 'queue':
      // Community / Variety Night per-game queue. Open / close are
      // admin-gated by Discord (default_member_permissions on the
      // subcommands); join / leave are anyone.
      return json(await handleQueueSlash(env, guild, data));

    // NOTE: /boltbound (card-battler) and /play (Bolts quick games)
    // were unregistered with the Bolts economy sunset. Stale clients
    // fall through to the default "unknown command" reply below.

    case 'voice': {
      // B7, temp voice channels. /voice creates a personal VC + moves
      // the caller in. Auto-deletes on inactivity (cron sweep).
      const { handleVoiceSlash } = await import('./voice-temp.js');
      const text = await handleVoiceSlash(env, guild, userId, userName);
      return json({ type: 4, data: { content: text, flags: 64 } });
    }

    case 'ticket': {
      // L8, Support ticketing. Opens a private channel visible only
      // to the opener + 🛡️ Moderator.
      const { handleTicketCommand } = await import('./tickets.js');
      return json(await handleTicketCommand(env, data));
    }

    case 'checkin': {
      // Daily community check-in. Same core as POST /web/checkin, // one check-in per ET day per user, regardless of surface.
      const { handleCheckinCommand } = await import('./community-checkin.js');
      return json(await handleCheckinCommand(env, data));
    }

    case 'referral': {
      // Show this viewer's referral code + their bring-in stats.
      const { handleReferralCommand } = await import('./referrals.js');
      return json(await handleReferralCommand(env, data));
    }

    case 'quest': {
      // Onboarding quest checklist + claim status (mirrors aquilo.gg/quest).
      const { handleQuestCommand } = await import('./quests.js');
      return json(await handleQuestCommand(env, data));
    }

    case 'onboard': {
      // Bot-driven onboarding flow, independent of Discord's built-in
      // Server Settings → Onboarding feature. /onboard runs the
      // interactive walkthrough; /onboard post-embed + /onboard status
      // are admin subcommands. See onboarding.js.
      const { handleOnboardCommand } = await import('./onboarding.js');
      return json(await handleOnboardCommand(env, data));
    }

    case 'topgifters': {
      // Top 5 per category (rolling 30d). See gifter-roles.js.
      const { handleTopGiftersCommand } = await import('./gifter-roles.js');
      return json(await handleTopGiftersCommand(env, data));
    }

    case 'loadout-setup': {
      // Productization: self-serve setup wizard. MANAGE_GUILD gated
      // (enforced by Discord via default_member_permissions on the
      // command). Opens the wizard at step 1, or handles channel /
      // feature / status subcommands.
      const { handleSetupCommand } = await import('./setup-wizard.js');
      return json(await handleSetupCommand(env, data));
    }

    case 'lfg': {
      // B8, LFG slash command. Shares state with POST /web/lfg/create
      // so an LFG created via the website appears in /lfg list, and
      // vice versa.
      const sub = (data.data?.options || [])[0];
      if (!sub) return json({ type: 4, data: { content: 'Pick a subcommand.', flags: 64 } });
      const opts = sub.options || [];
      const getOpt = (n) => opts.find(o => o.name === n)?.value;
      const lfg = await import('./lfg.js');
      let resp;
      if (sub.name === 'create') {
        const r = await lfg.createLfg(env, {
          userId, hostName: userName, game: getOpt('game'), slots: getOpt('slots'), guildId: guild,
        });
        resp = r.ok
          ? `🎮 Opened **${r.lfg.game}**, ${r.lfg.players.length}/${r.lfg.slots}. id \`${r.lfg.id}\`. See the embed in the LFG channel.`
          : `❌ ${r.error}`;
      } else if (sub.name === 'join') {
        const r = await lfg.joinLfg(env, getOpt('id'), { userId, name: userName });
        resp = r.ok
          ? `✅ Joined **${r.lfg.game}** (${r.lfg.players.length}/${r.lfg.slots}).${r.autoClosed ? ' That was the last slot, it just closed.' : ''}`
          : `❌ ${r.error}`;
      } else if (sub.name === 'close') {
        const r = await lfg.closeLfg(env, getOpt('id'), userId);
        resp = r.ok ? `🔒 Closed.` : `❌ ${r.error}`;
      } else if (sub.name === 'list') {
        const list = await lfg.listActiveLfgs(env, { limit: 10 });
        if (!list.length) resp = '_No active LFGs right now._';
        else resp = list.map(l => `• \`${l.id}\` **${l.game}** ${l.players.length}/${l.slots} host <@${l.hostUserId}>`).join('\n');
      } else {
        resp = '❌ Unknown subcommand.';
      }
      return json({ type: 4, data: { content: resp, flags: 64 } });
    }

    // ── Aquilo-bot fold-in: 13 command names dispatch to the shared
    //    aquilo interaction handler. Single delegation point keeps
    //    the routing flat here; the actual command bodies live in
    //    discord-bot/aquilo/*.js. The /hub command was renamed to
    //    /aquilo-hub to avoid colliding with Loadout's viewer hub.
    case 'announce':
    case 'aquilo-hub':
    case 'setup':
    case 'suggest':
    case 'encounter':
    case 'passport':
    case 'birthday':
    case 'trivia-add':
    case 'sr-add':
    case 'sr-list':
    case 'sr-remove':
    case 'sr-clear':
    case 'rotation-poll':
      // /checkin used to fall through here to aquilo's GIPHY slash
      // handler, now consolidated into community-checkin.js (the
      // first 'case checkin' above) with the gif picker rolled in.
      return dispatchAquiloInteraction(data, env, ctx);

    case 'loadout-claim':
      // /loadout-claim is handled inline in worker.js (separate path)
      // because it needs to verify the install code without going
      // through the wallet/menu plumbing. If we end up here it means
      // worker.js fell through, best-effort hint.
      return reply('That command is handled by Loadout, try again in a moment.');

    // Fallthrough for legacy granular commands. We don't publish these
    // anymore but Discord caches client-side, so a stale entry might
    // still appear in someone's autocomplete. Send them to the menu.
    // (`gift` is NOT listed here — it's a live command, the Patreon
    // fan-to-fan gifting CTA handled above.)
    case 'balance': case 'daily': case 'leaderboard':
    case 'coinflip': case 'dice': case 'link': case 'help':
    case 'profile': case 'profile-set-bio': case 'profile-set-pfp':
    case 'profile-set-pronouns': case 'profile-set-social':
    case 'profile-set-gamertag': case 'profile-clear':
      return reply('💡 Those individual commands are gone. Run **/loadout** for your profile or **/passport** for your full profile.');

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
