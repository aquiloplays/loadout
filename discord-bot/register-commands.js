// One-shot Node script: publishes the Loadout slash commands to Discord.
// Two ways to invoke:
//
//   1. Standalone Node (first-time setup, before the guild is bound):
//        APP_ID=123 BOT_TOKEN=abc node register-commands.js
//        (optionally GUILD_ID=456 for instant per-guild registration)
//
//   2. From inside Loadout once a guild is claimed: the DLL hits
//      POST /admin/register-commands/:guildId on the Worker, signed
//      with the streamer's syncSecret. The Worker uses its own
//      DISCORD_BOT_TOKEN secret so the token never has to be pasted
//      anywhere by the user.
//
// commands-spec.js is the single source of truth for the command list;
// both this script and worker.js's self-register endpoint import it.

import { COMMANDS } from './commands-spec.js';

const APP_ID    = process.env.APP_ID    || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const GUILD_ID  = process.env.GUILD_ID  || '';

if (!APP_ID || !BOT_TOKEN) {
  console.error('APP_ID and BOT_TOKEN env vars are required.');
  process.exit(1);
}

// commands-spec.js is the single source of truth -- see import above.
// (The previous inline-list-for-reference block was deleted; it
// referenced undefined TYPE_STRING / TYPE_USER / TYPE_INTEGER constants
// that crashed the script at module load.)

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
    body: JSON.stringify(COMMANDS)
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error('FAILED:', resp.status, text);
    process.exit(1);
  }
  console.log('Registered', COMMANDS.length, 'commands at', url);
  console.log('Discord response:', text.slice(0, 200));
})();
