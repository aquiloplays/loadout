#!/usr/bin/env node
// One-shot: post the two-part stream-schedule poll to the schedule
// input channel via the worker's sanctioned admin channel-post
// endpoint (/admin/post-embed/:guildId, per-guild HMAC; the bot token
// never leaves the worker). Requires the worker deployed with native
// poll passthrough (payload.poll).
//
// Part 1 = single-select content-direction poll (3 options).
// Part 2 = the 46-game interest list as five multiselect polls,
//          because Discord caps a native poll at 10 answers.
//
// Usage: node tools/post-schedule-poll.mjs [--execute]
//   (no flag = validate + print the plan without posting)

import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const WORKER = 'https://loadout-discord.aquiloplays.workers.dev';
const NS_ID = 'ffa4638187fd4c71b65f62e00b9437fa';
const GUILD = '1504103035951906883';
const CHANNEL = '1508318929855184987';   // schedule-input channel (Clay-provided)
const DURATION_HOURS = 168;              // polls stay open 7 days
const EXECUTE = process.argv.includes('--execute');
const WRANGLER = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const PLAY = '🎮';   // multiplayer: viewers can opt in to play along
const WATCH = '📺';  // solo/variety: watch only

const HEADER = [
  'Schedule time, Vault crew! I want YOUR input on what hits the stream. Two-part poll below.',
  '',
  'Part 1: what kind of content do you want to see? One vote each. (CC = Crowd Control)',
  '',
  'Part 2: which games would you actually show up for? It spans 5 polls because Discord caps each poll at 10 answers. Vote in every part, pick as many games as you like.',
  '',
  `${PLAY} = multiplayer: you can opt in to PLAY these with me. A multiplayer game needs at least 3 of you ready to squad up before it lands on the schedule (Elden Ring: Nightreign only needs 2).`,
  `${WATCH} = watch and hang out, no opt-in needed.`,
  '',
  'When a night has no clear winner, the default is Fallout 4 Crowd Control Chaos.',
].join('\n');

const Q1 = {
  question: 'What kind of content do you want to see on stream?',
  multi: false,
  answers: [
    { text: 'Fallout 4 Crowd Control Chaos & Community Nights Only' },
    // Discord caps answers at 55 chars; "CC" expansion is in HEADER.
    { text: 'CC Play Throughs, Variety Chaos, & Community Nights' },
    { text: 'Crowd Control Chaos, Community Nights, & Variety' },
  ],
};

const Q2_TEXT =
  'What games from this are you interested in watching and/or playing with me?';

// [name, tag], deduped across Clay's multiplayer + solo lists, plus
// the extra additions. PLAY = on the play-along list; everything else
// WATCH (per the current rules; the added titles have no play-along
// offer yet).
const GAMES = [
  ['Dead by Daylight', PLAY],
  ["Burglin' Gnomes", PLAY],
  ['R.E.P.O.', PLAY],
  ['Lethal Company', PLAY],
  ['Gamble With Your Friends', PLAY],
  ['MIMESIS', PLAY],
  ['RV There Yet?', PLAY],
  ['Phasmophobia', PLAY],
  ['Fortnite', PLAY],
  ['PUBG', PLAY],
  ['Left 4 Dead 2', PLAY],
  ['Among Us', PLAY],
  ['Apex Legends', PLAY],
  ['ARC Raiders', PLAY],
  ['Minecraft', PLAY],
  ['Elden Ring: Nightreign', PLAY],
  ['Hunt: Showdown 1896', PLAY],
  ['Far Far West', PLAY],
  ['Sea of Thieves', PLAY],
  ['Escape from Tarkov', PLAY],
  ['COD Warzone', PLAY],
  ['Baby Steps', WATCH],
  ['Cult of the Lamb', WATCH],
  ['Megabonk', WATCH],
  ['Slay the Spire 2', WATCH],
  ['Supermarket Simulator', WATCH],
  ['Waterpark Simulator', WATCH],
  ['Marbles on Stream', WATCH],
  ["Burgie's Cozy Kitchen", WATCH],
  ['Hitman: World of Assassination', WATCH],
  ['Dune: Awakening', WATCH],
  ['DayZ', WATCH],
  ['Age of Empires 2', WATCH],
  ['Paralives', WATCH],
  ['Retro Rewind', WATCH],
  ["Baldur's Gate 3", WATCH],
  ['Stardew Valley', WATCH],
  ['Skyrim', WATCH],
  ['Elden Ring', WATCH],
  ['The Witcher 3', WATCH],
  ['Kingdom Come: Deliverance', WATCH],
  ['Red Dead Redemption 2', WATCH],
  ['Sons of the Forest', WATCH],
  ['Cyberpunk 2077', WATCH],
  ['Rimworld', WATCH],
  ['Subnautica 2', WATCH],
];

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const gameChunks = chunk(GAMES, 10);
const polls = [
  Q1,
  ...gameChunks.map((games, i) => ({
    question: `${Q2_TEXT} (Part ${i + 1} of ${gameChunks.length})`,
    multi: true,
    answers: games.map(([text, emoji]) => ({ text, emoji })),
  })),
];

// ── validate against Discord's poll caps before touching the API ──
const problems = [];
if (HEADER.length > 2000) problems.push(`header ${HEADER.length} > 2000`);
for (const p of polls) {
  if (p.question.length > 300) problems.push(`question too long: ${p.question}`);
  if (p.answers.length > 10) problems.push(`>10 answers: ${p.question}`);
  for (const a of p.answers) {
    if (a.text.length > 55) problems.push(`answer ${a.text.length} chars: ${a.text}`);
  }
}
const seen = new Set();
for (const [name] of GAMES) {
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
      answers: p.answers.map((a) => ({
        poll_media: { text: a.text, ...(a.emoji ? { emoji: { name: a.emoji } } : {}) },
      })),
      duration: DURATION_HOURS,
      allow_multiselect: p.multi,
      layout_type: 1,
    },
  })),
];

console.log('--- schedule poll plan ---');
console.log(HEADER);
console.log('');
for (const p of polls) {
  console.log(`POLL (${p.multi ? 'multi' : 'single'}-select, ${DURATION_HOURS}h): ${p.question}`);
  for (const a of p.answers) console.log(`   ${a.emoji ?? '·'} ${a.text}`);
}
console.log(`\n${GAMES.length} games across ${gameChunks.length} polls; target channel ${CHANNEL}`);
console.log('endpoint:', `${WORKER}/admin/post-embed/${GUILD}`);

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
