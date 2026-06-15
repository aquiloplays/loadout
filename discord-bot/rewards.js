// Twitch channel point reward auto-create + per-product registry.
//
// Each Aquilo "product" that wants a channel point reward declares a
// spec in PRODUCT_REWARDS below. Three products are wired for v1
// (punchcard, tts, hangman); the other seven render in the admin UI
// with `comingSoon: true` so Clay sees the full menu but only the
// supported ones light up. Adding a new product later is one append
// to this registry plus a wire-up in the redemption handler.
//
// Wire-up (worker.js):
//   GET  /api/twitch/reward-registry            HMAC, owner.
//                                              Returns the public
//                                              shape of PRODUCT_REWARDS
//                                              + the currently-stored
//                                              reward IDs.
//   POST /api/twitch/create-reward              HMAC, owner. Body:
//                                                { productId }
//                                              Looks up the product
//                                              spec, calls Helix to
//                                              create the reward
//                                              against the streamer's
//                                              user token, persists
//                                              the resulting reward ID
//                                              under
//                                              `twitch:reward:<broadcaster>:<productId>`,
//                                              and indexes the reverse
//                                              lookup under
//                                              `twitch:reward-by-id:<rewardId>`
//                                              so the EventSub
//                                              redemption handler can
//                                              dispatch.
//   POST /api/twitch/delete-reward              HMAC, owner. Body:
//                                                { productId }
//                                              Deletes the Twitch
//                                              reward + clears KV.
//
// Twitch caps each broadcaster at ~50 simultaneous rewards; only
// auto-create the ones Clay enables.

import { verifyHmac } from './auth.js';
import { helixFetch, getUserAccessToken, hasTwitchUserAuth } from './twitch-helix.js';

const REWARD_KEY_PREFIX  = 'twitch:reward:';
const REWARD_INDEX_PREFIX = 'twitch:reward-by-id:';

// Each entry MUST have `productId` (matches the site's productRewards.ts),
// `title` (Twitch reward title, must be unique per broadcaster), `cost`
// (channel points), and the `requiresInput` toggle. Optional `prompt`
// is the text shown on the redeem dialog. `wired` controls whether
// auto-create is allowed; the seven coming-soon entries return 400
// 'product-coming-soon' from the create handler so the UI button stays
// disabled.
export const PRODUCT_REWARDS = [
  // ── Wired (v1) ─────────────────────────────────────────────────
  {
    productId: 'punchcard-checkin',
    label: 'Punchcard, Check In With Message',
    title: 'Check In With Message',
    prompt: 'Stamp your punchcard with a custom message Aquilo will say on stream.',
    cost: 500,
    requiresInput: true,
    wired: true,
  },
  {
    productId: 'tts-say',
    label: 'TTS, Say Something',
    title: 'Say Something',
    prompt: 'Make Aquilo say your message aloud on stream.',
    cost: 750,
    requiresInput: true,
    wired: true,
  },
  {
    productId: 'hangman-start',
    label: 'Hangman, Start Round',
    title: 'Start Hangman Round',
    prompt: 'Kick off a chat-played round of hangman. Streamer picks the word.',
    cost: 1000,
    requiresInput: false,
    wired: true,
  },
  // ── Coming soon (v2) ───────────────────────────────────────────
  { productId: 'boltbound-mana',     label: 'Boltbound, Tip +1 Mana',     title: 'Tip the Streamer +1 Mana',     cost: 1500, requiresInput: false, wired: false },
  { productId: 'scratch-buy',        label: 'Scratch-Off, Buy a Card',    title: 'Buy a Scratch-Off',            cost: 2500, requiresInput: false, wired: false },
  { productId: 'scene-themer-pick',  label: 'Scene Themer, Switch Theme', title: 'Switch Scene Theme',           cost: 1000, requiresInput: true,  wired: false },
  { productId: 'cam-border-pulse',   label: 'Cam Border, Test Pulse',     title: 'Cam Border Test Pulse',        cost: 250,  requiresInput: false, wired: false },
  { productId: 'minigame-amongus',   label: 'Mini-game, Among Us Round',  title: 'Start an Among Us Round',      cost: 2000, requiresInput: false, wired: false },
  { productId: 'minigame-lethal',    label: 'Mini-game, Lethal Monster',  title: 'Spawn a Lethal Company Monster', cost: 5000, requiresInput: false, wired: false },
  { productId: 'death-counter-buy',  label: 'Death Counter, +1 Bounty',   title: '+1 Death Bounty',              cost: 3000, requiresInput: false, wired: false },
];

const PRODUCT_BY_ID = new Map(PRODUCT_REWARDS.map((p) => [p.productId, p]));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bad(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

async function verifyOwnerHmac(req, env, body) {
  const ts  = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  if (!ts || !sig || !env.AQUILO_SITE_WEB_SECRET) return false;
  return verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts, body, sig);
}

function ownerBroadcaster(req, env) {
  // For v1 the broadcaster ID is Clay's Twitch channel from wrangler
  // vars. v2 should pull this per-streamer from a request body field
  // once the multi-tenant rollout starts.
  return req.headers.get('x-aquilo-broadcaster-id')
    || env.CLAY_TWITCH_CHANNEL_ID
    || '';
}

export async function handleRewardRegistry(req, env) {
  const ok = await verifyOwnerHmac(req, env, '');
  if (!ok) return bad('unauthorized', 401);
  const broadcaster = ownerBroadcaster(req, env);
  // Fan out KV reads for each product's current reward ID.
  const ids = await Promise.all(PRODUCT_REWARDS.map((p) =>
    env.LOADOUT_BOLTS.get(REWARD_KEY_PREFIX + broadcaster + ':' + p.productId)
  ));
  const products = PRODUCT_REWARDS.map((p, i) => ({
    productId:     p.productId,
    label:         p.label,
    title:         p.title,
    prompt:        p.prompt || '',
    cost:          p.cost,
    requiresInput: !!p.requiresInput,
    wired:         !!p.wired,
    rewardId:      ids[i] || null,
  }));
  return json({
    ok: true,
    broadcaster,
    twitchLinked: await hasTwitchUserAuth(env),
    products,
  });
}

export async function handleCreateReward(req, env) {
  const body = await req.text();
  const ok = await verifyOwnerHmac(req, env, body);
  if (!ok) return bad('unauthorized', 401);
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { return bad('bad json', 400); }
  const productId = String(payload.productId || '');
  const spec = PRODUCT_BY_ID.get(productId);
  if (!spec) return bad('unknown-product', 400);
  if (!spec.wired) return bad('product-coming-soon', 400);

  const broadcaster = ownerBroadcaster(req, env);
  if (!broadcaster) return bad('no-broadcaster', 400);
  if (!(await hasTwitchUserAuth(env))) {
    return json({ ok: false, error: 'twitch-not-linked' });
  }

  // Idempotency: if a reward already exists for this product+broadcaster,
  // return it instead of creating a duplicate (Twitch rejects duplicates
  // by title with 400 anyway).
  const existing = await env.LOADOUT_BOLTS.get(
    REWARD_KEY_PREFIX + broadcaster + ':' + productId,
  );
  if (existing) {
    return json({ ok: true, rewardId: existing, productId, existed: true });
  }

  const created = await helixFetch(env, '/channel_points/custom_rewards', {
    broadcaster_id: broadcaster,
  }, {
    method: 'POST',
    userToken: true,
    body: {
      title: spec.title,
      cost: spec.cost,
      prompt: spec.prompt || '',
      is_user_input_required: !!spec.requiresInput,
      is_enabled: true,
      background_color: '#7C5CFF',
    },
    returnErrors: true,
  });
  if (!created || created._error) {
    return json({
      ok: false,
      error: 'helix-failed',
      status: created?.status || 500,
      detail: created?.message || 'unknown',
    });
  }
  const rewardId = created.data?.[0]?.id;
  if (!rewardId) return json({ ok: false, error: 'no-reward-id', body: created });

  await env.LOADOUT_BOLTS.put(REWARD_KEY_PREFIX + broadcaster + ':' + productId, rewardId);
  await env.LOADOUT_BOLTS.put(REWARD_INDEX_PREFIX + rewardId, JSON.stringify({
    productId, broadcaster, createdUtc: Date.now(),
  }));
  return json({ ok: true, rewardId, productId });
}

export async function handleDeleteReward(req, env) {
  const body = await req.text();
  const ok = await verifyOwnerHmac(req, env, body);
  if (!ok) return bad('unauthorized', 401);
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { return bad('bad json', 400); }
  const productId = String(payload.productId || '');
  const spec = PRODUCT_BY_ID.get(productId);
  if (!spec) return bad('unknown-product', 400);

  const broadcaster = ownerBroadcaster(req, env);
  if (!broadcaster) return bad('no-broadcaster', 400);

  const rewardId = await env.LOADOUT_BOLTS.get(
    REWARD_KEY_PREFIX + broadcaster + ':' + productId,
  );
  if (!rewardId) return json({ ok: true, productId, deleted: false, note: 'no-reward' });

  if (await hasTwitchUserAuth(env)) {
    await helixFetch(env, '/channel_points/custom_rewards', {
      broadcaster_id: broadcaster,
      id: rewardId,
    }, { method: 'DELETE', userToken: true, returnErrors: true });
  }
  await env.LOADOUT_BOLTS.delete(REWARD_KEY_PREFIX + broadcaster + ':' + productId);
  await env.LOADOUT_BOLTS.delete(REWARD_INDEX_PREFIX + rewardId);
  return json({ ok: true, productId, deleted: true, rewardId });
}

// Called by twitch-events.js on a channel_points_custom_reward_redemption.add
// EventSub payload. Looks up which product owns the reward and returns
// the productId so the existing dispatch can fire the right handler.
// Returns null when the redemption is for a reward Aquilo didn't auto-
// create (e.g. a manually-configured reward the streamer set up).
export async function resolveRewardProduct(env, rewardId) {
  if (!rewardId) return null;
  const raw = await env.LOADOUT_BOLTS.get(REWARD_INDEX_PREFIX + rewardId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
