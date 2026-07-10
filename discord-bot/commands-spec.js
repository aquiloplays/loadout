// Single source of truth for the Loadout Discord slash command list.
// Imported by both register-commands.js (one-shot Node CLI) and worker.js
// (self-register endpoint). Adding a command means editing one file.
//
// We intentionally publish only TWO slash commands to Discord:
//   /loadout-claim, server admin one-time bind (MANAGE_GUILD)
//   /loadout, opens an ephemeral menu with buttons + select
//                     menus + modals for everything else: wallet,
//                     daily, gift, leaderboard, hero, bag, equip,
//                     unequip, sell, shop, buy, train, profile,
//                     coinflip, dice, help.
//
// The unified menu lives in loadout-menu.js. Replacing 24 granular
// slash commands with one menu command made discoverability much
// better, viewers don't need to remember 24 incantations and don't
// need to type structured arguments; the menu walks them through it.

// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type
const TYPE_USER             = 6;
const TYPE_INTEGER          = 4;
const TYPE_STRING           = 3;
const TYPE_SUBCOMMAND       = 1;
const TYPE_SUBCOMMAND_GROUP = 2;
const TYPE_BOOLEAN          = 5;

export const COMMANDS = [
  {
    name: 'loadout-claim', description: '(server admins) Bind this server to a Loadout install',
    options: [
      { type: TYPE_STRING, name: 'code', description: 'The 8-char code from Loadout Settings → Discord bot', required: true }
    ],
    default_member_permissions: '32'   // MANAGE_GUILD
  },
  {
    name: 'loadout',
    description: 'Open your Loadout profile, bio, pic, pronouns, socials, gamer tags',
    // Hidden from viewer autocomplete (Clay 2026-05-28), viewers
    // reach the Loadout main menu via the pinned games menu in #games.
    default_member_permissions: '0',
  },
  // (2026-07 hygiene: the /voice slash command was removed with
  // voice-temp.js — the gateway-driven join-to-create system in
  // temp-vc.js is the single temp-VC implementation now. Re-register
  // commands after deploy: POST /admin/register-commands/<guildId>.)
  // L8, Ticketing
  {
    name: 'ticket',
    description: 'Open a private support ticket',
    options: [
      { type: TYPE_STRING, name: 'topic', description: 'What\'s the ticket about? (optional)', required: false },
    ],
  },
  // Community daily check-in, unified with aquilo.gg/checkin (one
  // check-in per ET day per user regardless of surface).
  {
    name: 'checkin',
    description: 'Daily community check-in (also available on aquilo.gg)',
  },
  // New-viewer funnel
  {
    name: 'referral',
    description: 'Your referral code + how many members you\'ve brought in',
  },
  // Patreon fan-to-fan gift CTA. Replies with an ephemeral violet
  // embed + a LINK button to patreon.com/aquilo/gift. Patreon hosts
  // the actual checkout flow.
  {
    name: 'gift',
    description: 'Gift Aquilo Supporter access to a friend (Patreon fan-to-fan gifting)',
  },
  {
    name: 'quest',
    description: 'Your Welcome Checklist, steps + reward status',
  },
  // Bot-driven onboarding flow, runs without Discord's built-in
  // Server Settings → Onboarding feature. See onboarding.js.
  //   /onboard               start (or resume) the interactive flow
  //   /onboard post-embed    (admin) post the persistent welcome embed
  //                            with the "Begin onboarding" button
  //   /onboard status        (admin) funnel stats, started, completed,
  //                            per-step counts
  {
    // Top 5 contributors per category (sub gifters, TikTok gifters,
    // cheerers) over a rolling 30-day window. The top 3 in each
    // category also hold the matching Discord role, see
    // gifter-roles.js.
    name: 'topgifters',
    description: 'Top contributors (sub gifts / TikTok tips / cheers) over the last 30 days',
  },
  {
    name: 'onboard',
    description: 'Quick onboarding flow, interests, links, character, tour',
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'post-embed',
        description: '(admin) Post the persistent welcome embed in this channel',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'status',
        description: '(admin) Onboarding funnel snapshot',
      },
    ],
  },
  // Productization, self-serve setup wizard for new tenants.
  // MANAGE_GUILD gated. Subcommands: (none) = open wizard; channel =
  // bind one channel; feature = toggle one feature; status = snapshot.
  {
    name: 'loadout-setup',
    description: 'Set up Loadout for this server (channels, features, tenant registration)',
    default_member_permissions: '32', // MANAGE_GUILD
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'channel',
        description: 'Bind one Loadout channel slot',
        options: [
          { type: TYPE_STRING, name: 'slot', description: 'Slot id (e.g. ch_counting, ch_welcome, ch_support)', required: true,
            choices: [
              { name: 'Welcome',             value: 'ch_welcome' },
              { name: 'Counting',            value: 'ch_counting' },
              { name: 'Daily check-in',      value: 'ch_checkin' },
              { name: 'Support / tickets',   value: 'ch_support' },
              { name: 'Voice category',      value: 'cat_voice' },
              { name: 'Join-to-create VC',   value: 'vc_join_to_create' },
              { name: 'Activity feed',       value: 'ch_activity_feed' },
              { name: 'Games hub',           value: 'ch_games' },
            ] },
          { type: 7, name: 'channel', description: 'The channel to bind', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'feature',
        description: 'Toggle one Loadout feature on/off',
        options: [
          { type: TYPE_STRING, name: 'id', description: 'Feature id', required: true,
            choices: [
              { name: 'Counting game',         value: 'counting' },
              { name: 'Daily check-in',        value: 'checkin' },
              { name: 'Support tickets',       value: 'tickets' },
              { name: 'Join-to-create voice',  value: 'temp-vc' },
              { name: 'Welcome embed',         value: 'welcome' },
              { name: 'Referrals + onboarding',value: 'referrals' },
            ] },
          { type: TYPE_STRING, name: 'state', description: 'on or off', required: true,
            choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'status',
        description: 'Current Loadout setup state for this server',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'bind',
        description: 'Restrict a slash command to a single channel (add channel to its allow-list)',
        options: [
          { type: TYPE_STRING,  name: 'command', description: 'Command name (e.g. checkin, queue, lfg)', required: true },
          { type: 7,            name: 'channel', description: 'Channel where this command is allowed', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'unbind',
        description: 'Remove all channel restrictions for a slash command (allow it anywhere)',
        options: [
          { type: TYPE_STRING, name: 'command', description: 'Command name', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'bindings',
        description: 'List current command→channel restrictions for this server',
      },
    ],
  },
  // B8, LFG slash command (same backing state as /web/lfg/create)
  {
    name: 'lfg',
    description: 'Looking for game, post an "open for playing" embed',
    default_member_permissions: '0',
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'create',
        description: 'Open an LFG entry for a game',
        options: [
          { type: TYPE_STRING,  name: 'game',  description: 'What you want to play (e.g. Among Us, Chess)', required: true },
          { type: TYPE_INTEGER, name: 'slots', description: 'Total players including yourself (2-16)',     required: true, min_value: 2, max_value: 16 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'join',
        description: 'Join an open LFG by id',
        options: [
          { type: TYPE_STRING, name: 'id', description: 'LFG id from the embed footer', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'close',
        description: 'Close your LFG (host only)',
        options: [
          { type: TYPE_STRING, name: 'id', description: 'LFG id', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'list',
        description: 'List active LFGs',
      },
    ],
  },
  // NOTE (Bolts economy sunset 2026-06): the /bet (sports betting) and
  // /hub (viewer wallet/stocks/sports hub) commands were removed here.
  {
    // Admin-side hub. MANAGE_GUILD only via Discord's
    // default_member_permissions; the existing /loadout-claim stays in
    // place as the dedicated bind-code command.
    // (The Boltbound `card-art` subcommand-group was removed with the
    // economy sunset.)
    name: 'admin',
    description: '(server admins) Admin hub for Loadout install + tools',
    default_member_permissions: '32', // MANAGE_GUILD
  },
  {
    // Twitch event embed routing. Per-event-type channel overrides
    // + on/off toggles. /twitch-event list shows the current routing
    // table; set + toggle mutate KV (twitch-event-channel:<type>,
    // twitch-event-toggle:<type>). See twitch-events.js for the
    // catalogue + handlers. MANAGE_GUILD.
    name: 'twitch-event',
    description: '(admins) Route Twitch event embeds (follows, subs, raids…) to channels',
    default_member_permissions: '32', // MANAGE_GUILD
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'list',
        description: 'Show the current channel + toggle table for every event type',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'set',
        description: 'Route an event type to a channel (omit channel to clear)',
        options: [
          { type: TYPE_STRING, name: 'type', description: 'Event type', required: true,
            choices: [
              { name: 'Follow',                       value: 'follow' },
              { name: 'Subscription (new)',           value: 'sub' },
              { name: 'Gift sub',                     value: 'gift' },
              { name: 'Resub (with message)',         value: 'resub' },
              { name: 'Cheer / bits',                 value: 'cheer' },
              { name: 'Raid (incoming)',              value: 'raid' },
              { name: 'Stream ended (summary)',       value: 'ended' },
              { name: 'Channel-point redemption',     value: 'redemption' },
              { name: 'Hype train, begin',           value: 'hypeTrainBegin' },
              { name: 'Hype train, progress',        value: 'hypeTrainProgress' },
              { name: 'Hype train, end',             value: 'hypeTrainEnd' },
              { name: 'Poll, begin',                 value: 'pollBegin' },
              { name: 'Poll, end',                   value: 'pollEnd' },
              { name: 'Prediction, begin',           value: 'predictionBegin' },
              { name: 'Prediction, end',             value: 'predictionEnd' },
              { name: 'Mod: ban / timeout',           value: 'ban' },
              { name: 'Mod: unban',                   value: 'unban' },
            ],
          },
          // channel option uses TYPE 7 = CHANNEL, Discord returns
          // the channel id directly so we don't need to parse mentions.
          { type: 7, name: 'channel', description: 'Target channel (omit to clear the override)', required: false },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'toggle',
        description: 'Enable or disable embeds for one event type (subscription stays registered)',
        options: [
          { type: TYPE_STRING, name: 'type', description: 'Event type', required: true,
            choices: [
              { name: 'Follow',                       value: 'follow' },
              { name: 'Subscription (new)',           value: 'sub' },
              { name: 'Gift sub',                     value: 'gift' },
              { name: 'Resub (with message)',         value: 'resub' },
              { name: 'Cheer / bits',                 value: 'cheer' },
              { name: 'Raid (incoming)',              value: 'raid' },
              { name: 'Stream ended (summary)',       value: 'ended' },
              { name: 'Channel-point redemption',     value: 'redemption' },
              { name: 'Hype train, begin',           value: 'hypeTrainBegin' },
              { name: 'Hype train, progress',        value: 'hypeTrainProgress' },
              { name: 'Hype train, end',             value: 'hypeTrainEnd' },
              { name: 'Poll, begin',                 value: 'pollBegin' },
              { name: 'Poll, end',                   value: 'pollEnd' },
              { name: 'Prediction, begin',           value: 'predictionBegin' },
              { name: 'Prediction, end',             value: 'predictionEnd' },
              { name: 'Mod: ban / timeout',           value: 'ban' },
              { name: 'Mod: unban',                   value: 'unban' },
            ],
          },
          { type: TYPE_BOOLEAN, name: 'enabled', description: 'On (default) or off', required: true },
        ],
      },
    ],
  },
  {
    // Weekly stream-schedule editor, writes the same `schedule:v1:<g>`
    // KV record that aquilo.gg's /admin Schedule editor writes. Either
    // surface stays usable if the other is inconvenient. MANAGE_GUILD.
    // See aquilo-site/SCHEDULE-SYSTEM-DESIGN.md for the data model.
    name: 'schedule',
    description: '(admins) View or edit the weekly stream schedule',
    default_member_permissions: '32', // MANAGE_GUILD
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'view',
        description: 'Show the current weekly schedule',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'set',
        description: 'Set one day of the schedule',
        options: [
          { type: TYPE_STRING, name: 'day', description: 'Day of week', required: true,
            choices: [
              { name: 'Sunday',    value: '0' },
              { name: 'Monday',    value: '1' },
              { name: 'Tuesday',   value: '2' },
              { name: 'Wednesday', value: '3' },
              { name: 'Thursday',  value: '4' },
              { name: 'Friday',    value: '5' },
              { name: 'Saturday',  value: '6' },
            ],
          },
          { type: TYPE_STRING, name: 'label', description: 'Theme/game (e.g. Minecraft, Variety Night)', required: false },
          { type: TYPE_STRING, name: 'start', description: 'Start time HH:MM in schedule TZ (blank = off day)', required: false },
          { type: TYPE_STRING, name: 'end',   description: 'End time HH:MM (00:30 rolls to next day)',         required: false },
          { type: TYPE_STRING, name: 'kind',  description: 'Day kind', required: false,
            choices: [
              { name: 'fixed',     value: 'fixed' },
              { name: 'variety',   value: 'variety' },
              { name: 'community', value: 'community' },
            ],
          },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'set-tz',
        description: 'Change the schedule timezone (IANA name)',
        options: [
          { type: TYPE_STRING, name: 'tz', description: 'e.g. America/New_York', required: true },
        ],
      },
    ],
  },
  {
    // Game catalog editor, writes the same `games:v1:<g>` KV record
    // that aquilo.gg's /admin Games editor writes. Steam art URLs are
    // derived deterministically from the appId at write time.
    // MANAGE_GUILD. See SCHEDULE-SYSTEM-DESIGN.md.
    name: 'games',
    description: '(admins) View or edit the community / variety game catalog',
    default_member_permissions: '32', // MANAGE_GUILD
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'view',
        description: 'List the current catalog',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'add',
        description: 'Add a game from a Steam appid',
        options: [
          { type: TYPE_INTEGER, name: 'steam',   description: 'Steam appid', required: true, min_value: 1 },
          { type: TYPE_STRING,  name: 'name',    description: 'Override the auto-detected name', required: false },
          { type: TYPE_STRING,  name: 'pools',   description: 'Which night pool(s) this game belongs to', required: false,
            choices: [
              { name: 'community',          value: 'community' },
              { name: 'variety',            value: 'variety' },
              { name: 'community+variety',  value: 'both' },
            ],
          },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'remove',
        description: 'Remove a game by id (the slug shown in /games view)',
        options: [
          { type: TYPE_STRING, name: 'id', description: 'Game id (slug)', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'set-pools',
        description: 'Change which night(s) a game shows up on',
        options: [
          { type: TYPE_STRING, name: 'id',    description: 'Game id (slug)', required: true },
          { type: TYPE_STRING, name: 'pools', description: 'New pool assignment', required: true,
            choices: [
              { name: 'community',          value: 'community' },
              { name: 'variety',            value: 'variety' },
              { name: 'community+variety',  value: 'both' },
            ],
          },
        ],
      },
    ],
  },
  {
    // Community / Variety Night queue. Admin opens game queues, viewers
    // join (or leave) them. Both the website and the Twitch panel
    // surface live counts read-only with a "Join in Discord" deep-link
    // -- this is the only write surface for joiners. See
    // aquilo-site/SCHEDULE-SYSTEM-DESIGN.md Phase 3.
    name: 'queue',
    description: 'Community / Variety Night queue, open, join, leave, view',
    // Admin-only at the top level; viewers reach queue via vote-hub
    // buttons in the dedicated queue channel.
    default_member_permissions: '0',
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'view',
        description: 'Show tonight\'s open queues + counts',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'open',
        description: '(admin) Open a queue for a game',
        options: [
          { type: TYPE_STRING, name: 'game', description: 'Game id (slug from /games view)', required: true },
          { type: TYPE_STRING, name: 'cap_mode', description: 'Per-game cap, or one combined cap for the night', required: false,
            choices: [
              { name: 'per-match', value: 'per-match' },
              { name: 'per-night', value: 'per-night' },
            ],
          },
          { type: TYPE_INTEGER, name: 'cap', description: 'Cap value (defaults to 8, ignored if night cap is already set)', required: false, min_value: 1 },
        ],
        default_member_permissions: '32', // MANAGE_GUILD
      },
      {
        type: TYPE_SUBCOMMAND, name: 'close',
        description: '(admin) Close a single game\'s queue',
        options: [
          { type: TYPE_STRING, name: 'game', description: 'Game id', required: true },
        ],
        default_member_permissions: '32',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'close-night',
        description: '(admin) Close every queue and end the night',
        default_member_permissions: '32',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'join',
        description: 'Join an open game\'s queue',
        options: [
          { type: TYPE_STRING, name: 'game', description: 'Game id (see /queue view)', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'leave',
        description: 'Leave a game\'s queue you\'re in',
        options: [
          { type: TYPE_STRING, name: 'game', description: 'Game id', required: true },
        ],
      },
    ],
  },

  // ── Aquilo-bot fold-in commands ──────────────────────────────────
  //
  // Ten slash commands that used to ship on the standalone aquilo-bot
  // Discord app (1500929968002044075). All now route through the
  // unified Loadout bot (1500849448866025573) via the
  // dispatchAquiloInteraction handler. /hub was renamed to /aquilo-hub
  // to avoid colliding with Loadout's existing viewer hub command.
  //
  // The viewer-facing /suggest, /encounter, /sr-add, /sr-list,
  // /sr-remove commands the original aquilo-bot worker dispatched
  // are intentionally NOT registered, they migrated to button-driven
  // UI inside the /aquilo-hub viewer-hub message (see aquilo/viewer-
  // hub.js). The dispatch cases in commands.js handle stale clients.

  {
    // Post a product announcement embed to the configured channel.
    name: 'announce',
    description: 'Post a product announcement',
    default_member_permissions: '8192',     // MANAGE_MESSAGES
    options: [
      { type: TYPE_STRING, name: 'product', description: 'Which product', required: true,
        choices: [
          { name: 'Loadout',      value: 'loadout' },
          { name: 'StreamFusion', value: 'streamfusion' },
          { name: 'aquilo.gg',    value: 'aquilo' },
        ],
      },
      { type: TYPE_STRING,  name: 'title', description: 'Headline (≤256 chars)', required: true, max_length: 256 },
      { type: TYPE_STRING,  name: 'body',  description: 'Body markdown (≤4000)', required: true, max_length: 4000 },
      { type: TYPE_STRING,  name: 'url',   description: 'Optional URL',          required: false },
      { type: TYPE_STRING,  name: 'kind',  description: 'Announcement kind',     required: false,
        choices: [
          { name: 'News',    value: 'news' },
          { name: 'Beta',    value: 'beta' },
          { name: 'Sale',    value: 'sale' },
          { name: 'Partner', value: 'partner' },
          { name: 'Update',  value: 'update' },
        ],
      },
      { type: TYPE_BOOLEAN, name: 'ping',  description: 'Ping role',             required: false },
    ],
  },
  {
    // Renamed from /hub during the bot-consolidation fold-in to
    // avoid colliding with Loadout's existing /hub viewer entry
    // point. Posts the admin hub message (action buttons for
    // schedule, polls, queue, games, engagement, self-roles,
    // tickets, viewer-hub).
    name: 'aquilo-hub',
    description: 'Post the aquilo.gg admin hub in this channel',
    default_member_permissions: '8192',     // MANAGE_MESSAGES
  },
  {
    name: 'setup',
    description: 'Walk through configuring the aquilo-side bot features for this server',
    default_member_permissions: '32',       // MANAGE_GUILD
  },
  {
    // Mod-only Rotation pre-queue wipe. /sr-add, /sr-list, /sr-remove
    // moved to viewer-hub buttons.
    name: 'sr-clear',
    description: '(mod) Wipe the entire Rotation pre-queue',
    default_member_permissions: '8192',     // MANAGE_MESSAGES
  },
  {
    // Rotation pre-stream music poll. `new` posts the poll; `close`
    // finalises with a winner highlight. Cron refreshes live tallies.
    name: 'rotation-poll',
    description: 'Post or close the pre-stream music poll',
    default_member_permissions: '8192',     // MANAGE_MESSAGES
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'new',
        description: 'Post a fresh poll with options (replaces any open one)',
        options: [
          { type: TYPE_STRING, name: 'option1', description: '"<emoji> <label>" (e.g. "🔥 Hype / energy")', required: true,  max_length: 100 },
          { type: TYPE_STRING, name: 'option2', description: '"<emoji> <label>"', required: true,  max_length: 100 },
          { type: TYPE_STRING, name: 'title',   description: 'Poll title',        required: false, max_length: 120 },
          { type: TYPE_STRING, name: 'message', description: 'Body text',         required: false, max_length: 500 },
          { type: TYPE_STRING, name: 'option3', description: '"<emoji> <label>" (optional)', required: false, max_length: 100 },
          { type: TYPE_STRING, name: 'option4', description: '"<emoji> <label>" (optional)', required: false, max_length: 100 },
          { type: TYPE_STRING, name: 'option5', description: '"<emoji> <label>" (optional)', required: false, max_length: 100 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'close',
        description: 'Close the open poll and post final tallies',
      },
    ],
  },
  {
    name: 'passport',
    description: 'View your Aquilo profile, streak, achievements, stats',
    default_member_permissions: '0',
    options: [
      { type: TYPE_USER, name: 'user', description: 'View someone else\'s passport', required: false },
    ],
  },
  {
    name: 'birthday',
    description: 'Set or view a birthday for a callout',
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'set',
        description: 'Set your birthday (MM-DD, no year stored)',
        options: [
          { type: TYPE_STRING, name: 'date', description: 'MM-DD, e.g. 03-14', required: true, max_length: 5 },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'clear', description: 'Remove your stored birthday' },
      {
        type: TYPE_SUBCOMMAND, name: 'show',
        description: 'Show your or someone else\'s birthday',
        options: [
          { type: TYPE_USER, name: 'user', description: 'Whose birthday?', required: false },
        ],
      },
    ],
  },
  // /checkin moved to the canonical entry near the top of this file
  // (community-checkin.js handler, with the GIPHY gif-picker rolled
  // in). Duplicate fold-in entry deleted 2026-05, Discord rejects
  // two slash commands with the same name on the same guild.
  {
    name: 'trivia-add',
    description: '(admin) Add a trivia question to the daily rotation',
    default_member_permissions: '8192',     // MANAGE_MESSAGES
  },
];
