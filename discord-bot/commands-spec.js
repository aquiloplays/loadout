// Single source of truth for the Loadout Discord slash command list.
// Imported by both register-commands.js (one-shot Node CLI) and worker.js
// (self-register endpoint). Adding a command means editing one file.

// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type
const TYPE_USER    = 6;
const TYPE_INTEGER = 4;
const TYPE_STRING  = 3;

export const COMMANDS = [
  {
    name: 'loadout-claim', description: '(server admins) Bind this server to a Loadout install',
    options: [
      { type: TYPE_STRING, name: 'code', description: 'The 8-char code from Loadout Settings → Discord bot', required: true }
    ],
    default_member_permissions: '32'   // MANAGE_GUILD
  },
  {
    name: 'balance', description: 'Check your bolts balance (or @user)',
    options: [
      { type: TYPE_USER, name: 'user', description: 'Optional viewer to look up', required: false }
    ]
  },
  {
    name: 'gift', description: 'Send some of your bolts to another viewer',
    options: [
      { type: TYPE_USER,    name: 'user',   description: 'Recipient', required: true },
      { type: TYPE_INTEGER, name: 'amount', description: 'How many bolts', required: true, min_value: 1 }
    ]
  },
  { name: 'leaderboard', description: 'Top 10 wallet holders in this server' },
  { name: 'daily',       description: 'Claim your daily bolts (24h cooldown, streak bonus)' },
  {
    name: 'coinflip', description: '50/50 - bet some bolts, double or nothing',
    options: [
      { type: TYPE_INTEGER, name: 'bet', description: 'How many bolts to wager', required: true, min_value: 1 }
    ]
  },
  {
    name: 'dice', description: 'Roll 1d6 - hit your target for a 5x payout',
    options: [
      { type: TYPE_INTEGER, name: 'bet',    description: 'Wager', required: true, min_value: 1 },
      { type: TYPE_INTEGER, name: 'target', description: 'Target face (1-6)', required: true, min_value: 1, max_value: 6 }
    ]
  },
  {
    name: 'link', description: 'Link your Discord identity to a stream platform username',
    options: [
      { type: TYPE_STRING, name: 'platform', description: 'twitch / kick / youtube / tiktok', required: true,
        choices: [
          { name: 'Twitch',  value: 'twitch'  },
          { name: 'Kick',    value: 'kick'    },
          { name: 'YouTube', value: 'youtube' },
          { name: 'TikTok',  value: 'tiktok'  }
        ]
      },
      { type: TYPE_STRING, name: 'username', description: 'Your handle on that platform', required: true }
    ]
  },
  { name: 'help', description: 'List all Loadout commands' },

  // ── Viewer profile self-edit commands ─────────────────────────────────
  {
    name: 'profile-set-bio', description: 'Save your !profile bio',
    options: [
      { type: TYPE_STRING, name: 'text', description: 'Up to 200 chars', required: true, max_length: 200 }
    ]
  },
  {
    name: 'profile-set-pfp', description: 'Save your !profile picture URL',
    options: [
      { type: TYPE_STRING, name: 'url', description: 'PNG/JPG/WebP image URL', required: true, max_length: 400 }
    ]
  },
  {
    name: 'profile-set-pronouns', description: 'Save your pronouns (e.g. they/them)',
    options: [
      { type: TYPE_STRING, name: 'text', description: 'Short pronoun string', required: true, max_length: 24 }
    ]
  },
  {
    name: 'profile-set-social', description: 'Save a social handle on your profile',
    options: [
      { type: TYPE_STRING, name: 'platform', description: 'twitter / instagram / bluesky / etc.', required: true,
        choices: [
          { name: 'Twitter / X', value: 'twitter' },
          { name: 'Instagram',   value: 'instagram' },
          { name: 'TikTok',      value: 'tiktok' },
          { name: 'YouTube',     value: 'youtube' },
          { name: 'Twitch',      value: 'twitch' },
          { name: 'Kick',        value: 'kick' },
          { name: 'Bluesky',     value: 'bluesky' },
          { name: 'Threads',     value: 'threads' },
          { name: 'GitHub',      value: 'github' },
          { name: 'LinkedIn',    value: 'linkedin' }
        ]
      },
      { type: TYPE_STRING, name: 'handle', description: 'Your username on that platform', required: true, max_length: 80 }
    ]
  },
  {
    name: 'profile-set-gamertag', description: 'Save a gaming handle on your profile',
    options: [
      { type: TYPE_STRING, name: 'platform', description: 'psn / xbox / steam / riot / ...', required: true,
        choices: [
          { name: 'PSN',       value: 'psn' },
          { name: 'Xbox',      value: 'xbox' },
          { name: 'Steam',     value: 'steam' },
          { name: 'Riot',      value: 'riot' },
          { name: 'Valorant',  value: 'valorant' },
          { name: 'Minecraft', value: 'minecraft' },
          { name: 'Fortnite',  value: 'fortnite' },
          { name: 'Nintendo',  value: 'nintendo' },
          { name: 'Epic',      value: 'epic' }
        ]
      },
      { type: TYPE_STRING, name: 'tag', description: 'Your tag on that platform', required: true, max_length: 60 }
    ]
  },
  { name: 'profile-clear', description: 'Wipe all profile data you saved here' },
  {
    name: 'profile', description: 'Show your (or someone else\'s) profile',
    options: [
      { type: TYPE_USER, name: 'user', description: 'Optional viewer to look up', required: false }
    ]
  }
];
