#!/usr/bin/env node
// One-shot — post the season-reset announcement to the Aquilo updates
// channel via the worker's sanctioned admin channel-post endpoint
// (/admin/post-embed/:guildId, per-guild HMAC). The guild signing secret
// is read from KV at run time and used only to sign the request; it is
// never printed. The bot token stays server-side in the worker.
//
// Usage: node tools/post-announcement.mjs [--execute]
//   (no flag = print the plan + signed-target without posting)

import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const WORKER = 'https://loadout-discord.aquiloplays.workers.dev';
const NS_ID = 'ffa4638187fd4c71b65f62e00b9437fa';
const GUILD = '1504103035951906883';
const CHANNEL = '1507973904164061194';   // 💬│general — CHECKIN/ENGAGEMENT/LEADERBOARD channel
                                         // (where daily check-in embeds post; bot-confirmed)
const EXECUTE = process.argv.includes('--execute');
const WRANGLER = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const TEXT = [
  'Fresh season, fresh climb.',
  '',
  'The Aquilo Pass has reset to tier 1 and XP is back to zero for everyone. Daily check-ins start over from day 1, beginning now.',
  '',
  'Your bolts, cards, decks, and ranks stay exactly where you left them. Only the climb resets.',
  '',
  'See you on the ladder.',
].join('\n');

function readGuildSecret() {
  const cmd = `${WRANGLER} wrangler kv key get secret:${GUILD} --namespace-id=${NS_ID} --remote`;
  const r = spawnSync(cmd, { encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('could not read guild secret from KV');
  const i = r.stdout.indexOf('{');
  const rec = JSON.parse(r.stdout.slice(i));
  if (!rec?.secret) throw new Error('guild secret record has no .secret');
  return rec.secret;
}

const body = JSON.stringify({ channelId: CHANNEL, content: TEXT });
const ts = String(Math.floor(Date.now() / 1000));

console.log('--- announcement ---');
console.log(TEXT);
console.log('\ntarget channel:', CHANNEL, '(💬│general — check-in channel)');
console.log('endpoint:', `${WORKER}/admin/post-embed/${GUILD}`);

if (!EXECUTE) {
  console.log('\nDRY RUN — re-run with --execute to post.');
  process.exit(0);
}

const secret = readGuildSecret();
const sig = createHmac('sha256', secret).update(ts + '\n' + body).digest('hex');

const resp = await fetch(`${WORKER}/admin/post-embed/${GUILD}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-loadout-ts': ts,
    'x-loadout-sig': sig,
  },
  body,
});
const out = await resp.json().catch(() => ({}));
console.log('\nHTTP', resp.status, JSON.stringify(out));
process.exit(resp.ok && out.ok ? 0 : 1);
