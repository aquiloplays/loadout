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
              { name: 'Scrapper (common)',     value: 'scrapper' },
              { name: 'Archer (common)',       value: 'archerLite' },
              { name: 'Bolt Knight (rare)',    value: 'boltKnight' },
              { name: 'Sapper Rogue (rare)',   value: 'sapperRogue' },
              { name: 'Healer Cleric (rare)',  value: 'healerCleric' },
              { name: 'Voltaic Mage (epic)',   value: 'voltaicMage' },
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
                  { name: 'Town Hall',     value: 'townhall' },
                  { name: 'Wall',          value: 'wall' },
                  { name: 'Cannon',        value: 'cannon' },
                  { name: 'Archer Tower',  value: 'archerTower' },
                  { name: 'Trap',          value: 'trap' },
                  { name: 'Storage',       value: 'storage' },
                  { name: 'Barracks',      value: 'barracks' },
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
        ],
      },
    ],
  }
];
