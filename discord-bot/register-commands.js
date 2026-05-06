// One-shot Node script: publishes the Loadout slash commands to Discord.
// Run after creating your Discord application and getting a bot token.
//
// Usage:
//   APP_ID=123 BOT_TOKEN=abc node register-commands.js
//   (optionally GUILD_ID=456 for instant per-guild registration; without
//    it, commands publish globally and take ~1h to propagate)
//
// We deliberately keep this as a Node script (not a Worker route) because
// command registration is one-time-per-streamer and we'd rather not give
// the Worker bot-token privilege.

const APP_ID    = process.env.APP_ID    || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const GUILD_ID  = process.env.GUILD_ID  || '';

if (!APP_ID || !BOT_TOKEN) {
  console.error('APP_ID and BOT_TOKEN env vars are required.');
  process.exit(1);
}

// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type
const TYPE_USER    = 6;
const TYPE_INTEGER = 4;
const TYPE_STRING  = 3;

const commands = [
  {
    name: 'loadout-claim', description: '(server admins) Bind this server to a Loadout install',
    options: [
      { type: TYPE_STRING, name: 'code', description: 'The 8-char code from Loadout Settings → Discord bot', required: true }
    ],
    // Discord-side default permission gate. We re-check inside the handler
    // since this surface is advisory only (Discord lets server owners
    // configure visibility).
    default_member_permissions: '32'   // MANAGE_GUILD
  },
  {
    name: 'balance', description: 'Check your bolts balance (or @user)',
    options: [
      { type: TYPE_USER,    name: 'user',  description: 'Optional viewer to look up', required: false }
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
  // Mirror the chat-side !setbio / !setpfp / !setsocial / !setgamertag /
  // !setpronouns / !clearprofile commands so off-stream editing works.
  // The Worker stores edits in KV; the DLL polls /sync/<guild>/profiles
  // to pull them into the local store and re-publish on the bus.
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

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

(async () => {
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bot ' + BOT_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error('FAILED:', resp.status, text);
    process.exit(1);
  }
  console.log('Registered', commands.length, 'commands at', url);
  console.log('Discord response:', text.slice(0, 200));
})();
