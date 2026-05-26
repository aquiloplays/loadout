// Single source of truth for the Loadout Discord slash command list.
// Imported by both register-commands.js (one-shot Node CLI) and worker.js
// (self-register endpoint). Adding a command means editing one file.
//
// We intentionally publish only TWO slash commands to Discord:
//   /loadout-claim  — server admin one-time bind (MANAGE_GUILD)
//   /loadout        — opens an ephemeral menu with buttons + select
//                     menus + modals for everything else: wallet,
//                     daily, gift, leaderboard, hero, bag, equip,
//                     unequip, sell, shop, buy, train, profile,
//                     coinflip, dice, help.
//
// The unified menu lives in loadout-menu.js. Replacing 24 granular
// slash commands with one menu command made discoverability much
// better — viewers don't need to remember 24 incantations and don't
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
    description: 'Open the Loadout menu — wallet, hero, bag, shop, daily, gift, profile, more'
  },
  // B7 — Temp voice channels
  {
    name: 'voice',
    description: 'Create a personal voice channel; auto-deletes after a while when empty',
  },
  // L8 — Ticketing
  {
    name: 'ticket',
    description: 'Open a private support ticket',
    options: [
      { type: TYPE_STRING, name: 'topic', description: 'What\'s the ticket about? (optional)', required: false },
    ],
  },
  // Community daily check-in — unified with aquilo.gg/checkin (one
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
  {
    name: 'quest',
    description: 'Your Welcome Checklist — steps + reward status',
  },
  // Bot-driven onboarding flow — runs without Discord's built-in
  // Server Settings → Onboarding feature. See onboarding.js.
  //   /onboard               start (or resume) the interactive flow
  //   /onboard post-embed    (admin) post the persistent welcome embed
  //                            with the "Begin onboarding" button
  //   /onboard status        (admin) funnel stats — started, completed,
  //                            per-step counts
  {
    name: 'onboard',
    description: 'Quick onboarding flow — interests, links, character, tour',
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
  // Productization — self-serve setup wizard for new tenants.
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
              { name: 'Booster perks',         value: 'booster' },
              { name: 'Boltbound card game',   value: 'boltbound' },
              { name: 'Clash town builder',    value: 'clash' },
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
          { type: TYPE_STRING,  name: 'command', description: 'Command name (e.g. checkin, play, boltbound)', required: true },
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
  // B8 — LFG slash command (same backing state as /web/lfg/create)
  {
    name: 'lfg',
    description: 'Looking for game — post an "open for playing" embed',
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
  {
    // Bolts-denominated stock market. Prices driven by real upstream
    // signals (Twitch viewer counts, Steam player counts, Spotify
    // popularity) so they actually move. Spot only, integer shares,
    // 1% fee, no leverage — see stocks.js.
    name: 'stocks',
    description: 'Buy and sell shares in real-world tickers, paid in bolts',
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'list',
        description: 'Show all tickers and current prices',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'buy',
        description: 'Buy shares with bolts at the current price',
        options: [
          { type: TYPE_STRING,  name: 'ticker', description: 'Ticker symbol (e.g. CS2)', required: true },
          { type: TYPE_INTEGER, name: 'bolts',  description: 'Bolts you want to spend',  required: true, min_value: 1 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'sell',
        description: 'Sell shares back to bolts at the current price',
        options: [
          { type: TYPE_STRING,  name: 'ticker', description: 'Ticker symbol', required: true },
          { type: TYPE_INTEGER, name: 'shares', description: 'Shares to sell', required: true, min_value: 1 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'portfolio',
        description: 'Show your holdings and their total value in bolts',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'chart',
        description: 'Show a compact recent-price chart',
        options: [
          { type: TYPE_STRING, name: 'ticker', description: 'Ticker symbol', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'ticker-setup',
        description: '(admin) Bind this channel as the auto-updating stocks board',
      },
      {
        type: TYPE_SUBCOMMAND, name: 'ticker-clear',
        description: '(admin) Stop auto-updating the bound channel',
      },
    ],
  },
  {
    // Sports betting. Subcommand group so future expansion (e.g. esports,
    // prop bets) slots in cleanly under /bet <group> <subcommand>.
    name: 'bet',
    description: 'Bolts-denominated sports betting',
    options: [
      {
        type: TYPE_SUBCOMMAND_GROUP, name: 'sports',
        description: 'Bet on NFL / NBA / MLB / NHL games',
        options: [
          {
            type: TYPE_SUBCOMMAND, name: 'list',
            description: 'List upcoming games across the four leagues',
          },
          {
            type: TYPE_SUBCOMMAND, name: 'place',
            description: 'Place a bet on a game',
            options: [
              // autocomplete pulls from the cached scoreboard so viewers
              // don't have to copy the gameId out of /bet sports list.
              { type: TYPE_STRING,  name: 'game',  description: 'Pick an upcoming game', required: true, autocomplete: true },
              { type: TYPE_STRING,  name: 'side',  description: 'home or away', required: true,
                choices: [
                  { name: 'home', value: 'home' },
                  { name: 'away', value: 'away' },
                ],
              },
              { type: TYPE_INTEGER, name: 'bolts', description: 'Stake — capped at 10% of wallet', required: true, min_value: 1 },
            ],
          },
          {
            type: TYPE_SUBCOMMAND, name: 'active',
            description: 'Show your open bets',
          },
          {
            type: TYPE_SUBCOMMAND, name: 'history',
            description: 'Show your last 20 settled bets',
          },
        ],
      },
    ],
  },
  {
    // Viewer hub — entry point with category buttons (Loadout, Stocks,
    // Sports, Profile, Help). The Loadout game menu stays at /loadout;
    // this is the broader "everything Aquilo" surface.
    name: 'hub',
    description: 'Open the Aquilo hub — Loadout, Stocks, Sports, Profile',
  },
  {
    // Admin-side hub. MANAGE_GUILD only via Discord's
    // default_member_permissions; the existing /loadout-claim stays in
    // place as the dedicated bind-code command.
    name: 'admin',
    description: '(server admins) Admin hub for Loadout install + tools',
    default_member_permissions: '32', // MANAGE_GUILD
  },
  {
    // Weekly stream-schedule editor — writes the same `schedule:v1:<g>`
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
    // Game catalog editor — writes the same `games:v1:<g>` KV record
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
    // Clash — communal town & global raiders. See CLASH-FEATURE-DESIGN.md.
    // Phase 1 surface — solo raids (NPC + goblin + global PvP), shared
    // town that the streamer + mods build, viewers contribute Bolts.
    // Town subgroup gates writes to streamer/mods; viewer-facing
    // commands are open.
    name: 'clash',
    description: 'Communal town & global raiders — build, train, raid',
    options: [
      { type: TYPE_SUBCOMMAND, name: 'status', description: 'Your raider profile' },
      { type: TYPE_SUBCOMMAND, name: 'army',   description: 'View your trained troops' },
      {
        type: TYPE_SUBCOMMAND, name: 'train',
        description: 'Train personal troops (Bolts spent from your wallet)',
        options: [
          { type: TYPE_STRING, name: 'troop', description: 'Troop to train', required: true,
            choices: [
              { name: 'Scrapper (common)',         value: 'scrapper' },
              { name: 'Archer (common)',           value: 'archerLite' },
              { name: 'Goblin Sneak (common)',     value: 'sneak' },
              { name: 'Bolt Knight (rare)',        value: 'boltKnight' },
              { name: 'Sapper Rogue (rare)',       value: 'sapperRogue' },
              { name: 'Healer Cleric (rare)',      value: 'healerCleric' },
              { name: 'Battering Ram (rare)',      value: 'batteringRam' },
              { name: 'Skyrider (rare, air)',      value: 'skyrider' },
              { name: 'Plague Doctor (rare)',      value: 'plagueDoctor' },
              { name: 'Voltaic Mage (epic)',       value: 'voltaicMage' },
              { name: 'Lightning Sapper (epic)',   value: 'lightningSapper' },
              { name: 'Storm Caller (epic, air)',  value: 'stormCaller' },
            ],
          },
          { type: TYPE_INTEGER, name: 'count', description: 'Number to train (1–50)', required: false, min_value: 1, max_value: 50 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'donate',
        description: 'Donate Bolts to your home town treasury',
        options: [
          { type: TYPE_INTEGER, name: 'amount', description: 'How many Bolts to donate', required: true, min_value: 1 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'raid',
        description: 'Fire a raid — goblin camp, NPC town, or a real player',
        options: [
          { type: TYPE_STRING, name: 'kind', description: 'What to raid', required: true,
            choices: [
              { name: 'Goblin camp (PvE, easy)',           value: 'goblin' },
              { name: 'NPC town (PvE, harder)',            value: 'npc' },
              { name: 'Player town (PvP, global match)',   value: 'player' },
            ],
          },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'log',         description: 'Your recent raids + your town\'s incoming raids' },
      { type: TYPE_SUBCOMMAND, name: 'leaderboard', description: 'Top raiders + top towns (global)' },
      // ── CLASH EXPANSION Phase E1 — resource economy ────────────────
      {
        type: TYPE_SUBCOMMAND, name: 'gather',
        description: 'Start a timed gather task (wood / stone / iron / gold)',
        options: [
          { type: TYPE_STRING, name: 'resource', description: 'Which resource to gather', required: true,
            choices: [
              { name: 'Wood (cheap, fast)',  value: 'wood' },
              { name: 'Stone',               value: 'stone' },
              { name: 'Iron',                value: 'iron' },
              { name: 'Gold (rare, slow)',   value: 'gold' },
            ],
          },
          { type: TYPE_STRING, name: 'tier', description: 'How long to gather for', required: true,
            choices: [
              { name: 'Short (5 min)',     value: 'short' },
              { name: 'Medium (30 min)',   value: 'medium' },
              { name: 'Long (2 h)',        value: 'long' },
              { name: 'Overnight (8 h)',   value: 'overnight' },
            ],
          },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'gathers', description: 'Show your in-flight gather tasks (and complete any that finished)' },
      {
        type: TYPE_SUBCOMMAND, name: 'cancel-gather',
        description: 'Cancel an in-flight gather task (no partial credit)',
        options: [
          { type: TYPE_STRING, name: 'id', description: 'Task id from /clash gathers (first 12 chars work)', required: true },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'tap',
        description: 'Tap collector buildings to flush their accumulated yield into the treasury',
        options: [
          { type: TYPE_INTEGER, name: 'building', description: 'Building id to tap (omit to tap every collector at once)', required: false, min_value: 1 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'notify',
        description: 'Toggle a Clash push-notification kind on/off',
        options: [
          { type: TYPE_STRING, name: 'kind', description: 'Which notification kind', required: true,
            choices: [
              { name: 'Incoming raid (town)',     value: 'clash.raid.incoming' },
              { name: 'Town defended',            value: 'clash.raid.lost' },
              { name: 'Town sacked',              value: 'clash.raid.won' },
              { name: 'Your raid result',         value: 'clash.raid.result' },
              { name: 'Build / training done',    value: 'clash.build.complete' },
              { name: 'Shield expiring soon',     value: 'clash.shield.expiring' },
            ],
          },
          { type: 5, name: 'on', description: 'On (default) or off', required: false }, // 5 = BOOLEAN
        ],
      },
      {
        type: TYPE_SUBCOMMAND_GROUP, name: 'war',
        description: 'Community-vs-community wars (Phase 2)',
        options: [
          {
            type: TYPE_SUBCOMMAND, name: 'declare',
            description: 'Open a declaration vote against another community\'s town',
            options: [
              { type: TYPE_STRING, name: 'target', description: 'Target guild id (find via /clash leaderboard)', required: true },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'view',    description: 'Show your community\'s current war + score' },
          { type: TYPE_SUBCOMMAND, name: 'accept',  description: '(streamer/mods) accept a pending war without waiting for the vote' },
          { type: TYPE_SUBCOMMAND, name: 'refuse',  description: '(streamer/mods) refuse a pending war without waiting for the vote' },
          { type: TYPE_SUBCOMMAND, name: 'history', description: 'Last 5 wars your community has been in' },
        ],
      },
      {
        type: TYPE_SUBCOMMAND_GROUP, name: 'defender',
        description: 'Accept or decline a designated defending-Champion role',
        options: [
          { type: TYPE_SUBCOMMAND, name: 'accept',  description: 'Accept the role — your hero will defend the town on every raid' },
          { type: TYPE_SUBCOMMAND, name: 'decline', description: 'Decline the role — the streamer can pick someone else' },
        ],
      },
      {
        type: TYPE_SUBCOMMAND_GROUP, name: 'town',
        description: 'Town management (streamer + mods)',
        options: [
          { type: TYPE_SUBCOMMAND, name: 'view', description: 'Show the current town state' },
          {
            type: TYPE_SUBCOMMAND, name: 'build',
            description: 'Place or upgrade a town building (treasury cost)',
            options: [
              { type: TYPE_STRING, name: 'kind', description: 'Building kind', required: true,
                choices: [
                  { name: 'Town Hall',      value: 'townhall' },
                  { name: 'Wall',           value: 'wall' },
                  { name: 'Cannon',         value: 'cannon' },
                  { name: 'Archer Tower',   value: 'archerTower' },
                  { name: 'Trap',           value: 'trap' },
                  { name: 'Storage',        value: 'storage' },
                  { name: 'Barracks',       value: 'barracks' },
                  { name: 'War Tent',       value: 'warTent' },
                  // CLASH EXPANSION E1 — new production / utility / vault buildings
                  { name: 'Sawmill (wood)',     value: 'sawmill' },
                  { name: 'Quarry (stone)',     value: 'quarry' },
                  { name: 'Forge (iron)',       value: 'forge' },
                  { name: 'Mint (gold)',        value: 'mint' },
                  { name: 'Workshop (gather slot)', value: 'workshop' },
                  { name: "Builder's Hut (build slot)", value: 'buildersHut' },
                  { name: 'Lumber Reserve',     value: 'lumberVault' },
                  { name: 'Stone Reserve',      value: 'stoneVault' },
                  { name: 'Iron Reserve',       value: 'ironVault' },
                  { name: 'Gold Reserve',       value: 'goldVault' },
                ],
              },
              { type: TYPE_INTEGER, name: 'building', description: 'Building id to upgrade (omit to place a new one)', required: false, min_value: 1 },
            ],
          },
          {
            type: TYPE_SUBCOMMAND, name: 'garrison',
            description: 'Train town garrison troops (treasury cost)',
            options: [
              { type: TYPE_STRING, name: 'troop', description: 'Garrison troop', required: true,
                choices: [
                  { name: 'Scrapper',     value: 'scrapper' },
                  { name: 'Archer',       value: 'archerLite' },
                  { name: 'Bolt Knight',  value: 'boltKnight' },
                  { name: 'Voltaic Mage', value: 'voltaicMage' },
                ],
              },
              { type: TYPE_INTEGER, name: 'count', description: 'Number to train (1–20)', required: false, min_value: 1, max_value: 20 },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'pause', description: 'Toggle PvP matchmaking opt-out for this town' },
          // ── CLASH EXPANSION Phase E3 — defenses + traps (extra cap) ──
          {
            type: TYPE_SUBCOMMAND, name: 'defense',
            description: 'Build a defense or trap (streamer/mods)',
            options: [
              {
                type: TYPE_STRING, name: 'kind', description: 'Which defense/trap to build', required: true,
                choices: [
                  { name: 'Mortar (splash, min-range)',          value: 'mortar' },
                  { name: 'Mage Tower (ignores walls)',          value: 'mageTower' },
                  { name: 'Skyward Bow (anti-air)',              value: 'skywardBow' },
                  { name: 'Bomb Tower (AoE; explodes on death)', value: 'bombTower' },
                  { name: 'Voltaic Coil (cloaked)',              value: 'voltaicCoil' },
                  { name: 'Heavy Cannon (TH8+)',                 value: 'heavyCannon' },
                  { name: 'Inferno Tower (TH8+, ramping)',       value: 'infernoTower' },
                  { name: 'Eagle Eye (TH9+, town-wide)',         value: 'eagleEye' },
                  { name: 'Spring Trap (pushback)',              value: 'springTrap' },
                  { name: 'Sky Mine (anti-air, one-shot)',       value: 'skyMine' },
                  { name: 'Static Trap (stun)',                  value: 'staticTrap' },
                  { name: 'Caltrops (slow)',                     value: 'caltrops' },
                  { name: 'Inferno Trap (DoT burn)',             value: 'infernoTrap' },
                  { name: 'Decoy Banner (aggro pull)',           value: 'decoyBanner' },
                ],
              },
              { type: TYPE_INTEGER, name: 'building', description: 'Existing building id (omit to place a new one)', required: false, min_value: 1 },
            ],
          },
          // ── CLASH EXPANSION Phase E2 — repair / demolish / damage ────
          {
            type: TYPE_SUBCOMMAND, name: 'repair',
            description: 'Repair a damaged or destroyed building (streamer/mods)',
            options: [
              { type: TYPE_INTEGER, name: 'building', description: 'Building id (see /clash town damage)', required: true, min_value: 1 },
            ],
          },
          {
            type: TYPE_SUBCOMMAND, name: 'demolish',
            description: 'Demolish a destroyed building (25% resource refund, streamer/mods)',
            options: [
              { type: TYPE_INTEGER, name: 'building', description: 'Building id to demolish', required: true, min_value: 1 },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'damage', description: 'Show damaged/destroyed buildings + repair costs' },
          {
            type: TYPE_SUBCOMMAND, name: 'designate-defender',
            description: 'Designate a community member\'s hero as the town\'s defending Champion (needs a War Tent)',
            options: [
              { type: TYPE_USER, name: 'user', description: 'Community member whose hero defends the town', required: true },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'clear-defender', description: 'Clear the defending-Champion designation' },
          {
            type: TYPE_SUBCOMMAND, name: 'clear-obstacle',
            description: 'Dispatch the Engineer to clear an obstacle blocking a tile (costs Scrap + time)',
            options: [
              { type: TYPE_INTEGER, name: 'obstacle', description: 'Obstacle id (from /clash town view)', required: true, min_value: 1 },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'skip',           description: 'Spend a Battle Plan to skip the oldest in-flight build cooldown' },
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
    description: 'Community / Variety Night queue — open, join, leave, view',
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
  // are intentionally NOT registered — they migrated to button-driven
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
    description: 'View your Aquilo profile — streak, achievements, stats',
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
  {
    name: 'shop',
    description: 'Browse the Aquilo Bolts shop and spend Bolts',
  },
  // /checkin moved to the canonical entry near the top of this file
  // (community-checkin.js handler, with the GIPHY gif-picker rolled
  // in). Duplicate fold-in entry deleted 2026-05 — Discord rejects
  // two slash commands with the same name on the same guild.
  {
    name: 'trivia-add',
    description: '(admin) Add a trivia question to the daily rotation',
    default_member_permissions: '8192',     // MANAGE_MESSAGES
  },
  {
    name: 'shop-add',
    description: '(admin) Add or update a shop item',
    default_member_permissions: '8192',     // MANAGE_MESSAGES
  },

  // ── Character + pet system ───────────────────────────────────────
  // Pixel-art identity editor + Patreon-gated cosmetic companion
  // with a tamagotchi care loop. See CHARACTER-SYSTEM-DESIGN.md.
  {
    name: 'character',
    description: 'Customise your pixel-art character — body, hair, eyes, accent',
  },
  {
    name: 'pet',
    description: 'Adopt + care for a cosmetic pet (Patreon perk)',
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'adopt',
        description: 'Adopt a new pet (Patrons only)',
        options: [
          { type: TYPE_STRING, name: 'species', description: 'Pet species', required: true,
            choices: [
              { name: '🐱 Cat',         value: 'cat' },
              { name: '🐶 Dog',         value: 'dog' },
              { name: '🦉 Owl',         value: 'owl' },
              { name: '🦊 Fox',         value: 'fox' },
              { name: '🟢 Slime',       value: 'slime' },
              { name: '🐲 Dragonling',  value: 'dragonling' },
              { name: '🐸 Frog',        value: 'frog' },
              { name: '🐰 Bunny',       value: 'bunny' },
            ],
          },
          { type: TYPE_STRING, name: 'colour', description: 'Coat / scale colour', required: true, max_length: 20 },
          { type: TYPE_STRING, name: 'name',   description: 'Name them (≤16 chars)', required: false, max_length: 16 },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'view',  description: 'Show your pet + stats' },
      { type: TYPE_SUBCOMMAND, name: 'feed',  description: 'Feed your pet (10 Bolts, 30 min cooldown)' },
      { type: TYPE_SUBCOMMAND, name: 'play',  description: 'Play with your pet (5 Bolts, 30 min cooldown)' },
      { type: TYPE_SUBCOMMAND, name: 'clean', description: 'Clean your pet (5 Bolts, 30 min cooldown)' },
      {
        type: TYPE_SUBCOMMAND, name: 'rename',
        description: 'Rename your pet',
        options: [
          { type: TYPE_STRING, name: 'name', description: 'New name (≤16 chars)', required: true, max_length: 16 },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'release', description: 'Release your pet (24h cooldown before re-adopting)' },
      { type: TYPE_SUBCOMMAND, name: 'collect', description: 'Collect rewards your pet has brought back (auto-accrues every 4-8h)' },
    ],
  },
  {
    // Boltbound — async card-battler. See CARD-GAME-DESIGN.md.
    // Phase 1 surface is command-driven (one slash per turn) so the
    // 24h-per-turn async pace works cleanly inside Discord's
    // stateless interaction model. Web + Twitch surfaces (Phase 2)
    // get the click-to-target UI on top of the same backend.
    name: 'boltbound',
    description: 'Boltbound — collect cards, build decks, battle other viewers',
    options: [
      { type: TYPE_SUBCOMMAND, name: 'status',      description: 'Your Boltbound profile + collection summary' },
      { type: TYPE_SUBCOMMAND, name: 'packs',       description: 'List your pending packs' },
      { type: TYPE_SUBCOMMAND, name: 'open',
        description: 'Open a pending pack',
        options: [
          { type: TYPE_STRING, name: 'id', description: 'Pack id (first 8 chars are enough)', required: true },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'buy',
        description: 'Buy a pack with Bolts',
        options: [
          { type: TYPE_STRING, name: 'pack', description: 'Pack SKU', required: true,
            choices: [{ name: 'Bolt Pack (250 Bolts)', value: 'bolt' }],
          },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'daily',       description: 'Claim today\'s free Common Pack' },
      { type: TYPE_SUBCOMMAND, name: 'collection',
        description: 'Show your card collection',
        options: [
          { type: TYPE_STRING, name: 'rarity', description: 'Filter by rarity', required: false,
            choices: [
              { name: 'common',    value: 'common' },
              { name: 'uncommon',  value: 'uncommon' },
              { name: 'rare',      value: 'rare' },
              { name: 'legendary', value: 'legendary' },
            ],
          },
        ],
      },
      // ── Decks ─────────────────────────────────────────────────────
      {
        type: TYPE_SUBCOMMAND_GROUP, name: 'deck',
        description: 'Manage your decks',
        options: [
          { type: TYPE_SUBCOMMAND, name: 'list', description: 'List your saved decks' },
          { type: TYPE_SUBCOMMAND, name: 'show',
            description: 'Show a deck\'s card list',
            options: [
              { type: TYPE_STRING, name: 'deck', description: 'Deck id (omit for active)', required: false },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'active',
            description: 'Set your active deck',
            options: [
              { type: TYPE_STRING, name: 'deck', description: 'Deck id (from /boltbound deck list)', required: true },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'rebuild',
            description: 'Auto-build a starter deck from your collection',
          },
        ],
      },
      // ── Play ──────────────────────────────────────────────────────
      {
        type: TYPE_SUBCOMMAND_GROUP, name: 'play',
        description: 'Start a match',
        options: [
          { type: TYPE_SUBCOMMAND, name: 'npc',
            description: 'Battle an NPC opponent',
            options: [
              { type: TYPE_STRING, name: 'archetype', description: 'Bot archetype (random if blank)', required: false,
                choices: [
                  { name: 'aggro',    value: 'aggro' },
                  { name: 'control',  value: 'control' },
                  { name: 'midrange', value: 'midrange' },
                  { name: 'tribal',   value: 'tribal' },
                  { name: 'burn',     value: 'burn' },
                  { name: 'swarm',    value: 'swarm' },
                ],
              },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'queue',
            description: 'Drop into the PvP queue for this channel',
          },
          { type: TYPE_SUBCOMMAND, name: 'challenge',
            description: 'Challenge another viewer directly',
            options: [
              { type: TYPE_USER, name: 'user', description: 'Who to challenge', required: true },
            ],
          },
          { type: TYPE_SUBCOMMAND, name: 'accept',
            description: 'Accept a pending challenge from someone',
            options: [
              { type: TYPE_USER, name: 'user', description: 'Who challenged you', required: true },
            ],
          },
        ],
      },
      // ── Turn actions ──────────────────────────────────────────────
      { type: TYPE_SUBCOMMAND, name: 'match', description: 'Show your current match state' },
      { type: TYPE_SUBCOMMAND, name: 'mulligan',
        description: 'Mulligan your starting hand',
        options: [
          { type: TYPE_STRING, name: 'keep', description: 'CSV of hand indices to KEEP (e.g. 0,2,3 — blank keeps none)', required: false },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'move',
        description: 'Play a card from your hand',
        options: [
          { type: TYPE_INTEGER, name: 'card',   description: 'Hand index (see /boltbound match)', required: true, min_value: 0 },
          { type: TYPE_STRING,  name: 'target', description: 'Target uid for cards that need one (e.g. m3, oppHero, selfHero)', required: false },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'attack',
        description: 'Attack with one of your minions',
        options: [
          { type: TYPE_STRING, name: 'attacker', description: 'Your minion uid (e.g. m3)', required: true },
          { type: TYPE_STRING, name: 'target',   description: 'Defender uid (e.g. m5) or "hero"', required: true },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'end-turn',  description: 'End your turn' },
      { type: TYPE_SUBCOMMAND, name: 'concede',   description: 'Concede the current match' },
      { type: TYPE_SUBCOMMAND, name: 'log',       description: 'Show your last 10 matches' },
      { type: TYPE_SUBCOMMAND, name: 'leaderboard', description: 'Top trophies (global)' },
      { type: TYPE_SUBCOMMAND, name: 'challenges',  description: 'See pending direct challenges to you' },
      // CR-1: recycle → fragments → craft
      { type: TYPE_SUBCOMMAND, name: 'fragments',
        description: 'Show your fragment balance + recycle/craft prices',
      },
      { type: TYPE_SUBCOMMAND, name: 'recycle',
        description: 'Recycle owned cards into fragments',
        options: [
          { type: TYPE_STRING,  name: 'card',  description: 'Card id (from /boltbound collection)', required: true },
          { type: TYPE_INTEGER, name: 'count', description: 'How many to recycle (default 1)', required: false, min_value: 1 },
        ],
      },
      { type: TYPE_SUBCOMMAND, name: 'craft',
        description: 'Craft a pack from fragments',
        options: [
          { type: TYPE_STRING, name: 'pack', description: 'Pack to craft', required: true,
            choices: [
              { name: 'Common Pack (100 frags)',  value: 'common' },
              { name: 'Bolt Pack (400 frags)',    value: 'bolt' },
              { name: 'Voltaic Pack (1500 frags)', value: 'voltaic' },
            ],
          },
        ],
      },
    ],
  },
  {
    // Bolts-denominated quick games — the same 7 games the website
    // exposes at /play (blackjack, roulette, wheel, hi-lo, mines,
    // plinko, crash). One subcommand per game. Stateful games
    // (blackjack, hi-lo, mines) attach action buttons to the response
    // for continuation; single-shots resolve inline.
    //
    // NOTE: Loadout bot token is invalid at the time of writing so
    // slash registration is blocked. This entry is ready to publish
    // the moment the token is rotated.
    name: 'play',
    description: 'Play a quick-bolts game — blackjack, roulette, wheel, hi-lo, mines, plinko, crash',
    options: [
      {
        type: TYPE_SUBCOMMAND, name: 'blackjack',
        description: 'Standard blackjack — natural pays 3:2, dealer stands on 17',
        options: [
          { type: TYPE_INTEGER, name: 'bet', description: 'Bolts to wager', required: true, min_value: 1 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'roulette',
        description: 'Spin the wheel — pick a color, parity, range, or a specific number',
        options: [
          { type: TYPE_INTEGER, name: 'bet', description: 'Bolts to wager', required: true, min_value: 1 },
          {
            type: TYPE_STRING, name: 'pick', description: 'red, black, even, odd, low, high, or a number 0-36',
            required: true,
            choices: [
              { name: 'red (2×)',    value: 'red' },
              { name: 'black (2×)',  value: 'black' },
              { name: 'even (2×)',   value: 'even' },
              { name: 'odd (2×)',    value: 'odd' },
              { name: 'low 1-18 (2×)',  value: 'low' },
              { name: 'high 19-36 (2×)', value: 'high' },
              // Bare-number bets accepted as a free-text fallback via
              // /play roulette pick:17  — but Discord doesn't let us
              // mix free-text with choices when choices is present.
              // For number bets, use /play roulette-number instead
              // (added below as a separate subcommand).
            ],
          },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'roulette-number',
        description: 'Roulette — bet on a specific number 0-36 (pays 36×)',
        options: [
          { type: TYPE_INTEGER, name: 'bet',    description: 'Bolts to wager', required: true, min_value: 1 },
          { type: TYPE_INTEGER, name: 'number', description: 'Number 0-36',   required: true, min_value: 0, max_value: 36 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'wheel',
        description: 'Multiplier wheel — low risk = safer, high risk = jackpot',
        options: [
          { type: TYPE_INTEGER, name: 'bet', description: 'Bolts to wager', required: true, min_value: 1 },
          {
            type: TYPE_STRING, name: 'risk', description: 'Risk tier (default medium)', required: false,
            choices: [
              { name: 'low',    value: 'low' },
              { name: 'medium', value: 'medium' },
              { name: 'high',   value: 'high' },
            ],
          },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'hilo',
        description: 'Higher-or-lower — keep guessing to grow the multiplier; cash out anytime',
        options: [
          { type: TYPE_INTEGER, name: 'bet', description: 'Bolts to wager', required: true, min_value: 1 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'mines',
        description: 'Reveal tiles without hitting a bomb — cash out anytime',
        options: [
          { type: TYPE_INTEGER, name: 'bet',   description: 'Bolts to wager', required: true, min_value: 1 },
          { type: TYPE_INTEGER, name: 'bombs', description: 'Bombs hidden in the 5×5 grid (1-24, default 3)',
            required: false, min_value: 1, max_value: 24 },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'plinko',
        description: 'Drop a ball through pegs — bucket multiplier pays out',
        options: [
          { type: TYPE_INTEGER, name: 'bet', description: 'Bolts to wager', required: true, min_value: 1 },
          {
            type: TYPE_STRING, name: 'risk', description: 'Risk tier (default medium)', required: false,
            choices: [
              { name: 'low',    value: 'low' },
              { name: 'medium', value: 'medium' },
              { name: 'high',   value: 'high' },
            ],
          },
        ],
      },
      {
        type: TYPE_SUBCOMMAND, name: 'crash',
        description: 'Multiplier climbs from 1× — cash out before it busts',
        options: [
          { type: TYPE_INTEGER, name: 'bet',     description: 'Bolts to wager', required: true, min_value: 1 },
          { type: TYPE_INTEGER, name: 'cashout', description: 'Auto-cashout at this multiplier × 100 (e.g. 200 = 2.00×)',
            required: false, min_value: 100, max_value: 10000 },
        ],
      },
    ],
  },
];
