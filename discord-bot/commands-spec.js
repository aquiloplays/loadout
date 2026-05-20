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
              { type: TYPE_STRING,  name: 'game',  description: 'Game ID from /bet sports list', required: true },
              { type: TYPE_STRING,  name: 'side',  description: 'home or away', required: true },
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
  }
];
