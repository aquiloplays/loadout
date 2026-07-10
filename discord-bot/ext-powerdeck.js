// PowerDeck, the in-panel Card-Pack game backend for the Aquilo Twitch extension.
//
// Viewers spend Bolts to open a pack and draw 3 random stream-challenge cards
// into their hand, then "play" a card to surface it for the streamer to act on.
// Spend-only + cosmetic: there is NO Bolts payout, so there's zero faucet risk.
//
// Multi-tenant: `guildId` and `userId` are ALREADY resolved per-channel by the
// caller (guildId is the per-channel namespace, userId is `tw:<id>`). We use
// them verbatim and NEVER re-derive. All KV state is keyed with the guildId so
// it stays channel-isolated.
//
// Routes (all under /ext/powerdeck/):
//   GET  /ext/powerdeck/state        -> { ok, wallet, packCost, hand }
//   POST /ext/powerdeck/open  {name} -> { ok, wallet, cards, hand } | 400/429
//   POST /ext/powerdeck/play  {cardId} -> { ok, played, hand } | 400

import { getWallet, putWallet, spend } from './wallet.js';
import { walletView } from './ext-econ.js';
import { vaultHelix } from './warden-twitch.js';
import { pushGameEvent, enqueuePowerdeck } from './ext-events.js';

// ── local JSON helper (CORS + no-store) ──────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

// Cost to open one pack. Const — the panel mirrors this.
const PACK_COST = 100;

// Max cards a viewer keeps in hand; drawing past this drops the oldest.
const HAND_CAP = 12;

// Light anti-spam on the mutating POST routes. Keyed with guildId so it stays
// channel-isolated. Stored value is Date.now(); TTL floors in KV but the
// timestamp enforces the real ~800ms window.
const SPAM_WINDOW_MS = 800;
const SPAM_TTL = 2;
const cdKey = (guildId, userId) => `pdeckcd:${guildId}:${userId}`;
const handKey = (guildId, userId) => `pdeck:${guildId}:${userId}`;

// ── card pool ─────────────────────────────────────────────────────────
// Streamer-agnostic challenge cards. `key` is stable; each DRAWN copy gets a
// fresh instance `id`. Descriptions kept < 90 chars.
const CARD_POOL = [
  // common (65%)
  { key: 'voice_swap',   title: 'Voice Swap',     desc: 'Talk in a funny accent for 2 minutes.',            rarity: 'common' },
  { key: 'one_handed',   title: 'One-Handed',     desc: 'Play one-handed for a full round.',                rarity: 'common' },
  { key: 'narrate_it',   title: 'Narrate It',     desc: 'Commentate like a sports announcer for a bit.',    rarity: 'common' },
  { key: 'inverted',     title: 'Inverted',       desc: 'Flip your look/aim controls for one match.',       rarity: 'common' },
  { key: 'no_swearing',  title: 'Clean Mouth',    desc: 'No swearing for the next 5 minutes.',              rarity: 'common' },
  { key: 'hydrate',      title: 'Hydrate!',       desc: 'Take a big sip of water right now.',               rarity: 'common' },
  { key: 'name_chat',    title: 'Shout-Out',      desc: 'Read three chatters names out loud.',              rarity: 'common' },
  { key: 'silly_dance',  title: 'Silly Dance',    desc: 'Do a 10-second victory dance on cam.',             rarity: 'common' },
  // rare (27%)
  { key: 'difficulty_up', title: 'Difficulty Up', desc: 'Bump the difficulty for the next 10 minutes.',     rarity: 'rare' },
  { key: 'no_hud',        title: 'No HUD',        desc: 'Turn off the HUD for one fight.',                   rarity: 'rare' },
  { key: 'speed_run',     title: 'Speed Run',    desc: 'Rush the next objective as fast as possible.',      rarity: 'rare' },
  { key: 'pacifist',      title: 'Pacifist',     desc: 'No attacking for 3 minutes — dodge only.',          rarity: 'rare' },
  { key: 'random_loadout',title: 'Random Roll',  desc: 'Reroll to a random loadout for a round.',           rarity: 'rare' },
  // epic (8%)
  { key: 'viewers_choice', title: "Viewer's Choice", desc: 'Let chat pick your next loadout.',             rarity: 'epic' },
  { key: 'hardcore_run',   title: 'Hardcore Run', desc: 'Permadeath rules until your next death.',           rarity: 'epic' },
  { key: 'boss_rush',      title: 'Boss Rush',    desc: 'Take on the next boss with no healing.',            rarity: 'epic' },
];

// Rarity draw weights. Independent per card; duplicates allowed.
const RARITY_WEIGHTS = { common: 65, rare: 27, epic: 8 };

// Pre-bucket the pool by rarity so a draw is: roll rarity, then uniform pick.
const POOL_BY_RARITY = CARD_POOL.reduce((acc, c) => {
  (acc[c.rarity] = acc[c.rarity] || []).push(c);
  return acc;
}, {});

// Roll a rarity by weight, then a uniform card of that rarity.
function drawOne() {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  let rarity = 'common';
  for (const [r, w] of Object.entries(RARITY_WEIGHTS)) {
    if (roll < w) { rarity = r; break; }
    roll -= w;
  }
  const bucket = POOL_BY_RARITY[rarity] || POOL_BY_RARITY.common;
  const card = bucket[Math.floor(Math.random() * bucket.length)];
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    key: card.key,
    title: card.title,
    desc: card.desc,
    rarity: card.rarity,
  };
}

// ── hand state ─────────────────────────────────────────────────────────
async function readHand(env, guildId, userId) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(handKey(guildId, userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.hand) ? parsed.hand : [];
  } catch {
    return [];
  }
}

async function writeHand(env, guildId, userId, hand) {
  await env.LOADOUT_BOLTS.put(handKey(guildId, userId), JSON.stringify({ hand }));
}

// True when the caller is still inside the anti-spam window.
async function rateLimited(env, guildId, userId) {
  try {
    const key = cdKey(guildId, userId);
    const last = parseInt((await env.LOADOUT_BOLTS.get(key)) || '0', 10);
    const now = Date.now();
    if (last && now - last < SPAM_WINDOW_MS) return true;
    await env.LOADOUT_BOLTS.put(key, String(now), { expirationTtl: SPAM_TTL });
    return false;
  } catch {
    // Best-effort — never block a play because the cooldown store hiccuped.
    return false;
  }
}

// Persist the viewer's display name onto their wallet, opportunistically.
async function rememberName(env, guildId, userId, name) {
  const nm = (name || '').toString().trim().slice(0, 40);
  if (!nm) return;
  try {
    const w = await getWallet(env, guildId, userId);
    if (w.name !== nm) {
      w.name = nm;
      await putWallet(env, guildId, userId, w);
    }
  } catch {
    /* name is cosmetic — never fail a play over it */
  }
}

// ── open a pack ────────────────────────────────────────────────────────
async function handleOpen(env, guildId, userId) {
  const balance = (await getWallet(env, guildId, userId)).balance || 0;
  if (balance < PACK_COST) {
    return json({ error: 'insufficient', message: 'Not enough Bolts.' }, 400);
  }

  await spend(env, guildId, userId, PACK_COST, 'powerdeck:pack');

  const cards = [drawOne(), drawOne(), drawOne()];
  let hand = await readHand(env, guildId, userId);
  hand = hand.concat(cards);
  if (hand.length > HAND_CAP) hand = hand.slice(hand.length - HAND_CAP); // drop oldest
  await writeHand(env, guildId, userId, hand);

  const wallet = await walletView(env, guildId, userId);
  return json({ ok: true, wallet, cards, hand });
}

// Announce a played card in the channel's own Twitch chat, as the broadcaster,
// via the per-channel OAuth vault (`vault:tw:<channelId>`, needs
// user:write:chat). Best-effort: no channel id or no vault token → silent
// no-op; a chat failure never fails the play. This is what makes "play a card"
// actually surface to the streamer.
async function announcePlay(env, meta, played) {
  try {
    const channelId = meta && meta.channelId ? String(meta.channelId) : '';
    if (!channelId || !played) return;
    const who = (meta.name || 'A viewer').toString().slice(0, 40);
    const rarity = played.rarity && played.rarity !== 'common' ? ' [' + played.rarity + ']' : '';
    const message = ('🃏 ' + who + ' played a PowerDeck card: ' + played.title + rarity +
      ' — ' + (played.desc || '')).slice(0, 400);
    await vaultHelix(env, channelId, '/chat/messages', {
      method: 'POST',
      body: { broadcaster_id: channelId, sender_id: channelId, message },
    });
  } catch {
    /* best-effort — never fail the play over a chat hiccup */
  }
}

// ── play a card ────────────────────────────────────────────────────────
async function handlePlay(env, guildId, userId, body, meta) {
  const cardId = (body.cardId || '').toString();
  const hand = await readHand(env, guildId, userId);
  const idx = hand.findIndex((c) => c && c.id === cardId);
  if (idx < 0) {
    return json({ error: 'not-found', message: 'Card not in your hand.' }, 400);
  }

  const [played] = hand.splice(idx, 1);
  await writeHand(env, guildId, userId, hand);

  // Surface the played card: (1) channel chat, (2) OBS overlay event bus,
  // (3) the streamer's Dock queue to accept/complete/decline. All best-effort.
  const who = (meta && meta.name) ? String(meta.name).slice(0, 40) : 'A viewer';
  await announcePlay(env, meta, played);
  await pushGameEvent(env, guildId, {
    type: 'powerdeck-play', name: who, title: played.title, rarity: played.rarity,
  });
  await enqueuePowerdeck(env, guildId, {
    id: played.id, viewer: who, title: played.title, desc: played.desc,
    rarity: played.rarity, ts: Date.now(), status: 'new',
  });

  return json({ ok: true, played, hand });
}

// ── entry point ────────────────────────────────────────────────────────
// sub: the action after /ext/powerdeck/ ('state'|'open'|'play').
// meta = { twId, name, isClay }.
export async function handlePanelPowerdeck(env, guildId, userId, sub, req, meta) {
  meta = meta || {};

  // Read-only state — no rate limit.
  if (sub === 'state') {
    const [wallet, hand] = await Promise.all([
      walletView(env, guildId, userId),
      readHand(env, guildId, userId),
    ]);
    return json({ ok: true, wallet, packCost: PACK_COST, hand });
  }

  // Everything else mutates — POST + anti-spam gated.
  const body = await req.json().catch(() => ({}));

  if (await rateLimited(env, guildId, userId)) {
    return json({ error: 'rate', message: 'Slow down a sec.' }, 429);
  }

  // Stamp the display name opportunistically.
  await rememberName(env, guildId, userId, meta.name || body.name);

  switch (sub) {
    case 'open': return handleOpen(env, guildId, userId);
    case 'play': return handlePlay(env, guildId, userId, body, meta);
    default:     return json({ error: 'not-found' }, 404);
  }
}
