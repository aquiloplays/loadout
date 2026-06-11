#!/usr/bin/env node
// One-shot: post the Community Votes Night game-interest poll to the
// voting channel via the worker's /admin/post-embed (per-guild HMAC,
// native poll passthrough). The 29-game CVN pool spans 3 multiselect
// native polls because Discord caps a poll at 10 answers.
//
// Usage: node tools/post-cvn-poll.mjs [--execute]
//   (no flag = validate + print the plan without posting)

import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const WORKER = 'https://loadout-discord.aquiloplays.workers.dev';
const NS_ID = 'ffa4638187fd4c71b65f62e00b9437fa';
const GUILD = '1504103035951906883';
const CHANNEL = '1508318929855184987';   // voting channel (same as the schedule poll)
const DURATION_HOURS = 168;              // 7 days
const EXECUTE = process.argv.includes('--execute');
const WRANGLER = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const HEADER = [
  'Community Votes Nights are coming to the schedule: Sun, Tue, Thu, and Sat, with Fallout 4 Crowd Control Chaos holding down Mon, Wed, and Fri.',
  '',
  'Which games do you want to see on those nights? Pick as many as you like across the 3 polls below (Discord caps answers at 10 per poll). This shapes the nightly vote pool, the night-of vote picks the actual game.',
].join('\n');

const QUESTION = 'What games are you interested in seeing on Community Votes Nights?';

// The CVN pool, exactly as Clay set it (Fallout 4 stays an option).
const GAMES = [
  'Fallout 4',
  'R.E.P.O.',
  'Lethal Company',
  'MIMESIS',
  'Gamble With Your Friends',
  'RV There Yet?',
  'MECCHA CHAMELEON',
  'PUBG: BATTLEGROUNDS',
  'Apex Legends',
  'COD: Warzone',
  'Marbles on Stream',
  'Dead by Daylight',
  'Phasmophobia',
  'The Outlast Trials',
  'The Finals',
  'Hunt: Showdown 1896',
  'Overwatch',
  'DayZ',
  'Escape From Tarkov',
  'Dune: Awakening',
  'Hitman: World of Assassination',
  'Marathon',
  'Far Far West',
  'Arena Breakout: Infinite',
  'Path of Exile 2',
  'Wuthering Waves',
  'Rainbow Six Siege',
  'Where Winds Meet',
  'Slay the Spire 2',
];

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const parts = chunk(GAMES, 10);
const polls = parts.map((games, i) => ({
  question: `${QUESTION} (Part ${i + 1} of ${parts.length})`,
  answers: games,
}));

// ── validate against Discord's poll caps before touching the API ──
const problems = [];
if (HEADER.length > 2000) problems.push(`header ${HEADER.length} > 2000`);
for (const p of polls) {
  if (p.question.length > 300) problems.push(`question too long: ${p.question}`);
  if (p.answers.length > 10) problems.push(`>10 answers: ${p.question}`);
  for (const a of p.answers) {
    if (a.length > 55) problems.push(`answer ${a.length} chars: ${a}`);
  }
}
const seen = new Set();
for (const name of GAMES) {
  if (seen.has(name)) problems.push(`duplicate game: ${name}`);
  seen.add(name);
}
if (problems.length) {
  console.error('VALIDATION FAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const messages = [
  { channelId: CHANNEL, content: HEADER },
  ...polls.map((p) => ({
    channelId: CHANNEL,
    poll: {
      question: { text: p.question },
      answers: p.answers.map((text) => ({ poll_media: { text } })),
      duration: DURATION_HOURS,
      allow_multiselect: true,
      layout_type: 1,
    },
  })),
];

console.log('--- CVN game-interest poll plan ---');
console.log(HEADER);
console.log('');
for (const p of polls) {
  console.log(`POLL (multi-select, ${DURATION_HOURS}h): ${p.question}`);
  for (const a of p.answers) console.log(`   · ${a}`);
}
console.log(`\n${GAMES.length} games across ${parts.length} polls; target channel ${CHANNEL}`);

if (!EXECUTE) {
  console.log('\nDRY RUN, re-run with --execute to post.');
  process.exit(0);
}

function readGuildSecret() {
  const cmd = `${WRANGLER} wrangler kv key get secret:${GUILD} --namespace-id=${NS_ID} --remote`;
  const r = spawnSync(cmd, { encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('could not read guild secret from KV');
  const i = r.stdout.indexOf('{');
  const rec = JSON.parse(r.stdout.slice(i));
  if (!rec?.secret) throw new Error('guild secret record has no .secret');
  return rec.secret;
}

const secret = readGuildSecret();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [i, msg] of messages.entries()) {
  const body = JSON.stringify(msg);
  const ts = String(Math.floor(Date.now() / 1000));
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
  const label = msg.poll ? `poll ${i}/${messages.length - 1}` : 'header';
  console.log(`${label}: HTTP ${resp.status} message ${out.messageId || '?'} ${out.ok ? '' : JSON.stringify(out)}`);
  if (!resp.ok || !out.ok) {
    console.error('aborting, fix and re-run remaining posts manually');
    process.exit(1);
  }
  await sleep(700);
}
console.log('all posted.');
