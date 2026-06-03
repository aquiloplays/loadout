// /play, Discord slash command for the 7 quick-bolts games.
//
// Single-shot games (roulette, wheel, plinko, crash) resolve in one
// command and return the result inline.
//
// Stateful games (blackjack, hilo, mines) post the opening hand with
// action buttons (Hit/Stand etc.) attached. Subsequent button clicks
// arrive as MESSAGE_COMPONENT interactions with custom_id `qg:<game>:<action>`
// and update the same message in place via UPDATE_MESSAGE (response
// type 7).
//
// Every game body calls the exact same games-quick.js function the
// website + Twitch panel use, single source of truth, no rule
// divergence possible.
//
// NOTE: at write time the Loadout bot token is invalid so slash-command
// registration is blocked. The spec entry in commands-spec.js will
// publish this command the moment the token is rotated; the dispatch
// in commands.js + this handler are ready to fire.

import {
  cooldownCheck, cooldownTouch,
  blackjackStart, blackjackHit, blackjackStand,
  roulette, wheel,
  hiloStart, hiloGuess, hiloCashout,
  minesStart, minesReveal, minesCashout,
  plinko, crash,
} from './games-quick.js';
import { getWallet } from './wallet.js';

const RESP_CHANNEL = 4;         // CHANNEL_MESSAGE_WITH_SOURCE
const RESP_UPDATE  = 7;         // UPDATE_MESSAGE (for component interactions)
const FLAG_EPHEMERAL = 64;

// Style codes for components (Discord docs):
//   1 PRIMARY (blurple), 2 SECONDARY (grey), 3 SUCCESS (green),
//   4 DANGER (red), 5 LINK (uses url).
const BTN_PRIMARY   = 1;
const BTN_SECONDARY = 2;
const BTN_SUCCESS   = 3;
const BTN_DANGER    = 4;

// ── Slash entry point ───────────────────────────────────────────────
//
// Discord invocation shapes:
//   /play blackjack bet:25
//   /play roulette bet:25 pick:red
//   /play wheel bet:25 risk:medium
//   /play hilo bet:25
//   /play mines bet:25 bombs:3
//   /play plinko bet:25 risk:medium
//   /play crash bet:25 cashout:2

export async function handlePlayCommand(env, data, guildId, userId, userName) {
  const sub = (data.data?.options?.[0]?.name || '').toLowerCase();
  const opts = optMap(data.data?.options?.[0]?.options || []);

  if (!sub) return reply('Pick a game: /play blackjack | roulette | wheel | hilo | mines | plinko | crash');

  const bet = Math.max(0, Math.floor(Number(opts.bet) || 0));
  if (bet <= 0) {
    return reply('Bet must be a positive number.');
  }

  // Cooldown gates the *start* of every game (matches the contract
  // games-quick.js / web.js / ext-quick.js use). Stateful continuations
  // come through button interactions and don't re-check.
  const cd = await cooldownCheck(env, userId);
  if (!cd.ok) return reply(cd.message || 'Slow down a moment.');

  try {
    switch (sub) {
      case 'blackjack':        return await runBlackjackStart(env, guildId, userId, userName, bet);
      case 'roulette':         return await runRoulette(env, guildId, userId, userName, bet, opts.pick);
      case 'roulette-number':  return await runRoulette(env, guildId, userId, userName, bet, Number(opts.number));
      case 'wheel':            return await runWheel(env, guildId, userId, userName, bet, opts.risk);
      case 'hilo':             return await runHiloStart(env, guildId, userId, userName, bet);
      case 'mines':            return await runMinesStart(env, guildId, userId, userName, bet, opts.bombs);
      case 'plinko':           return await runPlinko(env, guildId, userId, userName, bet, opts.risk);
      // Crash auto-cashout is sent as integer ×100 (Discord can't take
      // a float option), convert back to multiplier here.
      case 'crash':            return await runCrash(env, guildId, userId, userName, bet, opts.cashout ? Number(opts.cashout) / 100 : 0);
      default:                 return reply('Unknown game: ' + sub);
    }
  } catch (e) {
    return reply('Something blew up: ' + String((e && e.message) || e));
  }
}

// ── Component (button) router ────────────────────────────────────────
//
// custom_id format: qg:<game>:<action>[:<arg>]
//   qg:bj:hit, blackjack hit
//   qg:bj:stand, blackjack stand
//   qg:hl:higher, hilo higher
//   qg:hl:lower, hilo lower
//   qg:hl:cash, hilo cashout
//   qg:mn:<tile>, mines reveal tile (0..24)
//   qg:mn:cash, mines cashout

export async function handlePlayComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const user = data.member?.user || data.user;
  const userId = user?.id;
  const userName = user?.global_name || user?.username || 'viewer';
  const guildId = data.guild_id;
  if (!guildId || !userId) {
    return reply('This action must be run in a server.');
  }

  // Lock down button-presses to the player who started the hand. The
  // games-quick.js session key includes the user id, so a different
  // user clicking can only act on their OWN session (if any), but
  // discord shows the buttons on a public message, so we still want
  // a friendly "this isn't your hand" reply rather than silently
  // mutating someone else's session.
  // We embed the starting user in the message itself; check it here.
  // Skipping for v1 (ephemeral messages already gate this; if Clay
  // ever flips these to public, we'd add an embed-footer marker).

  const parts = cid.split(':');
  // parts[0] === 'qg'
  const game = parts[1];
  const action = parts[2];

  try {
    if (game === 'bj') {
      let r;
      if (action === 'hit') r = await blackjackHit(env, guildId, userId);
      else if (action === 'stand') r = await blackjackStand(env, guildId, userId);
      else return updateNoop();
      return updateBlackjack(r, userName);
    }
    if (game === 'hl') {
      let r;
      if (action === 'higher') r = await hiloGuess(env, guildId, userId, 'higher');
      else if (action === 'lower') r = await hiloGuess(env, guildId, userId, 'lower');
      else if (action === 'cash')  r = await hiloCashout(env, guildId, userId);
      else return updateNoop();
      return updateHilo(r, userName);
    }
    if (game === 'mn') {
      let r;
      if (action === 'cash') {
        r = await minesCashout(env, guildId, userId);
      } else {
        const tile = parseInt(action, 10);
        if (!Number.isFinite(tile) || tile < 0 || tile > 24) return updateNoop();
        r = await minesReveal(env, guildId, userId, tile);
      }
      return updateMines(r, userName);
    }
  } catch (e) {
    return updateContent('Something blew up: ' + String((e && e.message) || e));
  }
  return updateNoop();
}

// ── Single-shot game handlers ───────────────────────────────────────

async function runRoulette(env, guildId, userId, userName, bet, pickRaw) {
  // Allowed picks: red, black, even, odd, low, high (1-18 / 19-36),
  // or a single number 0-36. games-quick.js's roulette doesn't accept
  // a bare "green" color, but `0` is the only green pocket, so a
  // number bet on 0 is the equivalent.
  const pick = parsePick(pickRaw);
  if (!pick) return reply("Pick must be one of: red, black, even, odd, low, high, or a number 0-36.");
  const r = await roulette(env, guildId, userId, bet, pick);
  await cooldownTouch(env, userId);
  if (!r.ok) return reply(r.message || 'Roulette error.');
  const w = await getWallet(env, guildId, userId);
  const verb = r.won ? `won **${(r.payout || 0).toLocaleString()}** bolts` : `lost **${bet.toLocaleString()}** bolts`;
  return reply(
    `🎰 Roulette · ${userName}\nLanded on **${r.spin} ${r.color}**, ${verb}.\nBalance: **${(w.balance || 0).toLocaleString()}**`,
    /* ephemeral */ false,
  );
}

async function runWheel(env, guildId, userId, userName, bet, risk) {
  const r = await wheel(env, guildId, userId, bet, (risk || 'medium'));
  await cooldownTouch(env, userId);
  if (!r.ok) return reply(r.message || 'Wheel error.');
  const w = await getWallet(env, guildId, userId);
  const mult = r.multiplier ? r.multiplier.toFixed(2) + '×' : '0×';
  const tail = r.won ? `won **${(r.payout || 0).toLocaleString()}**` : `lost **${bet.toLocaleString()}**`;
  return reply(
    `🎡 Wheel · ${userName}\nMultiplier landed: **${mult}**, ${tail}\nBalance: **${(w.balance || 0).toLocaleString()}**`,
    false,
  );
}

async function runPlinko(env, guildId, userId, userName, bet, risk) {
  const r = await plinko(env, guildId, userId, bet, (risk || 'medium'));
  await cooldownTouch(env, userId);
  if (!r.ok) return reply(r.message || 'Plinko error.');
  const w = await getWallet(env, guildId, userId);
  const mult = r.multiplier ? r.multiplier.toFixed(2) + '×' : '0×';
  const tail = r.won ? `won **${(r.payout || 0).toLocaleString()}**` : `lost **${bet.toLocaleString()}**`;
  return reply(
    `🪜 Plinko · ${userName}\nBucket multiplier: **${mult}**, ${tail}\nBalance: **${(w.balance || 0).toLocaleString()}**`,
    false,
  );
}

async function runCrash(env, guildId, userId, userName, bet, cashoutAt) {
  const r = await crash(env, guildId, userId, bet, Math.max(1, Number(cashoutAt) || 0));
  await cooldownTouch(env, userId);
  if (!r.ok) return reply(r.message || 'Crash error.');
  const w = await getWallet(env, guildId, userId);
  const target = (r.cashout || 0).toFixed(2) + '×';
  const bust = (r.bust || 0).toFixed(2) + '×';
  const verb = r.won ? `cashed out at ${target}, won **${(r.payout || 0).toLocaleString()}**`
    : `crashed at ${bust} before ${target}, lost **${bet.toLocaleString()}**`;
  return reply(
    `🚀 Crash · ${userName}\n${verb}\nBalance: **${(w.balance || 0).toLocaleString()}**`,
    false,
  );
}

// ── Stateful game starts (button-driven continuations) ───────────────

async function runBlackjackStart(env, guildId, userId, userName, bet) {
  const r = await blackjackStart(env, guildId, userId, bet);
  await cooldownTouch(env, userId);
  return updateBlackjack(r, userName, /* freshMessage */ true);
}

async function runHiloStart(env, guildId, userId, userName, bet) {
  const r = await hiloStart(env, guildId, userId, bet);
  await cooldownTouch(env, userId);
  return updateHilo(r, userName, /* freshMessage */ true);
}

async function runMinesStart(env, guildId, userId, userName, bet, bombs) {
  const b = Math.max(1, Math.min(24, Math.floor(Number(bombs) || 3)));
  const r = await minesStart(env, guildId, userId, bet, b);
  await cooldownTouch(env, userId);
  return updateMines(r, userName, /* freshMessage */ true);
}

// ── Stateful renderers ──────────────────────────────────────────────

function updateBlackjack(r, userName, freshMessage = false) {
  if (!r) return updateContent('Hand fizzled.');
  if (!r.ok) {
    return freshMessage
      ? reply(r.message || 'Blackjack error.')
      : updateContent(r.message || 'Blackjack error.');
  }

  const handStr = (cards) => Array.isArray(cards) ? cards.map(prettyCard).join(' ') : '-';
  const tail = (r.phase === 'finished' || r.finished)
    ? `\n**${outcomeLabel(r.outcome)}** · Payout **${(r.payout || 0).toLocaleString()}** · Balance **${(r.balance || 0).toLocaleString()}**`
    : `\nBalance **${(r.balance || 0).toLocaleString()}**`;

  const content =
    `🃏 Blackjack · ${userName}\n` +
    `Your hand: ${handStr(r.player)} (**${r.playerTotal ?? '-'}**)\n` +
    `Dealer:    ${handStr(r.dealer)}${r.phase === 'player' ? ' (one face-down)' : ''}` +
    (r.dealerTotal != null ? ` (**${r.dealerTotal}**)` : '') +
    tail;

  const components = (r.phase === 'player') ? [
    actionRow([
      button('qg:bj:hit',   'Hit',   BTN_PRIMARY),
      button('qg:bj:stand', 'Stand', BTN_SECONDARY),
    ]),
  ] : [];

  const payload = { content, components, flags: FLAG_EPHEMERAL };
  return freshMessage
    ? json({ type: RESP_CHANNEL, data: payload })
    : json({ type: RESP_UPDATE,  data: payload });
}

function updateHilo(r, userName, freshMessage = false) {
  if (!r) return updateContent('Hand fizzled.');
  if (!r.ok) {
    return freshMessage
      ? reply(r.message || 'Hi-Lo error.')
      : updateContent(r.message || 'Hi-Lo error.');
  }

  const mult = (r.multiplier || 1).toFixed(2) + '×';
  const card = r.currentCard != null ? prettyCard(r.currentCard) : '-';
  const finished = r.phase === 'finished' || r.finished;
  const head = finished
    ? `🎲 Hi-Lo · ${userName}\nFinal card **${card}**.\n**${r.outcome || 'done'}** at **${mult}**, Payout **${(r.payout || 0).toLocaleString()}**.\nBalance **${(r.balance || 0).toLocaleString()}**`
    : `🎲 Hi-Lo · ${userName}\nCurrent card: **${card}**. Multiplier so far: **${mult}**\nBalance **${(r.balance || 0).toLocaleString()}**`;

  const components = finished ? [] : [
    actionRow([
      button('qg:hl:higher', 'Higher', BTN_PRIMARY),
      button('qg:hl:lower',  'Lower',  BTN_SECONDARY),
      button('qg:hl:cash',   `Cash out (${mult})`, BTN_SUCCESS),
    ]),
  ];
  const payload = { content: head, components, flags: FLAG_EPHEMERAL };
  return freshMessage
    ? json({ type: RESP_CHANNEL, data: payload })
    : json({ type: RESP_UPDATE,  data: payload });
}

function updateMines(r, userName, freshMessage = false) {
  if (!r) return updateContent('Hand fizzled.');
  if (!r.ok) {
    return freshMessage
      ? reply(r.message || 'Mines error.')
      : updateContent(r.message || 'Mines error.');
  }

  const board = Array.isArray(r.board) ? r.board : new Array(25).fill('?');
  const mult = (r.multiplier || 1).toFixed(2) + '×';
  const finished = r.phase === 'finished' || r.finished;
  const head = finished
    ? `💣 Mines · ${userName}\n${r.outcome === 'win' ? 'Cashed out' : 'Boom'} at **${mult}**, Payout **${(r.payout || 0).toLocaleString()}**.\nBalance **${(r.balance || 0).toLocaleString()}**`
    : `💣 Mines · ${userName}\nMultiplier: **${mult}** · Bombs: **${r.bombs || 3}**\nTap a tile to reveal, or cash out.\nBalance **${(r.balance || 0).toLocaleString()}**`;

  // 5×5 grid of buttons = 5 action rows of 5 buttons each. Discord
  // caps a message at 5 action rows; for mines the cash-out goes into
  // the message header (we use a SECOND message for the result), or
  // we sacrifice one tile slot for the cashout button.
  //
  // Simpler: render the 5×5 with revealed tiles disabled + their face
  // shown; cash-out becomes a 6th button in the LAST row by replacing
  // the bottom-right tile button with cash-out IF the tile is still
  // hidden. If it's already revealed (and game's still going), we drop
  // cash-out into a tile that's been clicked, no, that breaks 5x5.
  //
  // Cleanest: use 4 rows of 5 tile buttons (positions 0..19) plus a
  // 5th row with the last 5 tile buttons (20..24); the cash-out is a
  // dedicated row only when finished=false AND there's a clicked tile
  // (revealed[].length > 0). When fresh-start, no cash-out.
  const components = [];
  if (!finished) {
    for (let r0 = 0; r0 < 5; r0++) {
      const row = [];
      for (let c = 0; c < 5; c++) {
        const i = r0 * 5 + c;
        const cell = board[i];
        const isHidden = cell === '?' || cell == null;
        row.push({
          type: 2,
          style: isHidden ? BTN_SECONDARY : (cell === 'gem' ? BTN_SUCCESS : BTN_DANGER),
          label: isHidden ? ' ' : (cell === 'gem' ? '💎' : '💣'),
          custom_id: 'qg:mn:' + i,
          disabled: !isHidden,
        });
      }
      components.push({ type: 1, components: row });
    }
    // Cash-out lives below the grid only after at least one safe pick;
    // games-quick.js returns multiplier > 1 once you've revealed one
    // gem. For an empty board we still show it to allow bailing out.
    components.push(actionRow([
      button('qg:mn:cash', `Cash out (${mult})`, BTN_SUCCESS),
    ]));
  } else {
    // Reveal the final board read-only.
    for (let r0 = 0; r0 < 5; r0++) {
      const row = [];
      for (let c = 0; c < 5; c++) {
        const i = r0 * 5 + c;
        const cell = board[i];
        row.push({
          type: 2,
          style: cell === 'gem' ? BTN_SUCCESS : (cell === 'bomb' ? BTN_DANGER : BTN_SECONDARY),
          label: cell === 'gem' ? '💎' : (cell === 'bomb' ? '💣' : ' '),
          custom_id: 'qg:mn:done:' + i,
          disabled: true,
        });
      }
      components.push({ type: 1, components: row });
    }
  }

  // Discord allows at most 5 action rows. The grid is 5 rows; if we
  // also added a cash-out row, we'd hit 6. Trim to 5 by dropping the
  // last grid row's last button and putting cash-out there instead.
  if (components.length > 5) {
    const last = components.pop(); // cash-out row
    const grid5 = components[4];
    grid5.components[4] = last.components[0];
  }

  const payload = { content: head, components, flags: FLAG_EPHEMERAL };
  return freshMessage
    ? json({ type: RESP_CHANNEL, data: payload })
    : json({ type: RESP_UPDATE,  data: payload });
}

// ── Helpers ─────────────────────────────────────────────────────────

function optMap(opts) {
  const o = {};
  for (const it of (opts || [])) o[it.name] = it.value;
  return o;
}

function parsePick(raw) {
  if (raw == null) return null;
  // Numbers come through as INTEGER option type, Discord stringifies them
  // anyway; allow either shape.
  if (typeof raw === 'number') {
    if (raw >= 0 && raw <= 36) return { kind: 'number', number: raw };
    return null;
  }
  const s = String(raw).trim().toLowerCase();
  if (/^[0-9]{1,2}$/.test(s)) {
    const n = parseInt(s, 10);
    if (n >= 0 && n <= 36) return { kind: 'number', number: n };
    return null;
  }
  if (s === 'red' || s === 'black' || s === 'green') return { kind: 'color', color: s };
  if (s === 'even' || s === 'odd')   return { kind: 'parity', parity: s };
  if (s === 'low')  return { kind: 'range', range: 'low' };
  if (s === 'high') return { kind: 'range', range: 'high' };
  return null;
}

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function prettyCard(c) {
  if (c == null) return '🂠';
  if (c === -1) return '🂠';
  const s = SUITS[(c >> 4) & 3];
  const r = RANKS[c & 0xF];
  return r + s;
}

function outcomeLabel(o) {
  if (!o) return '';
  if (o === 'win')  return 'You win';
  if (o === 'lose') return 'You lose';
  if (o === 'push') return 'Push';
  if (o === 'natural') return 'Blackjack!';
  return o;
}

function button(custom_id, label, style) {
  return { type: 2, style, label, custom_id };
}
function actionRow(components) {
  return { type: 1, components };
}

function reply(content, ephemeral = true) {
  const data = { content };
  if (ephemeral) data.flags = FLAG_EPHEMERAL;
  return json({ type: RESP_CHANNEL, data });
}
function updateContent(content) {
  return json({ type: RESP_UPDATE, data: { content, components: [], flags: FLAG_EPHEMERAL } });
}
function updateNoop() {
  return json({ type: RESP_UPDATE, data: { content: '(no-op)', components: [], flags: FLAG_EPHEMERAL } });
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
