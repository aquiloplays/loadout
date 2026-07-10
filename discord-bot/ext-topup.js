// Bits → Bolts top-up for the in-panel economy (multi-tenant, optional).
//
// Every game is free to play (Bolts are earned via watch-time / daily / bonuses).
// This is a purely optional "support the streamer + skip the grind" path: a
// viewer spends Twitch Bits on a `bolts_*` Bits Product and gets Bolts credited
// to their per-channel wallet. It only surfaces in the panel when the streamer
// has actually configured a `bolts_*` Bits Product — so it's opt-in by
// existence, no separate config flag.
//
// SKU-agnostic: we credit Bolts = (bits actually paid) × RATE, read from the
// signed receipt's cost — so any number of `bolts_*` tiers work with one rate.

import { verifyBitsReceipt } from './auth.js';
import { earn } from './wallet.js';
import { walletView } from './ext-econ.js';

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

const RATE = 10; // Bolts per Bit (mirror this in the panel's display)
const doneKey = (txId) => `topupdone:${txId}`;

// POST /ext/topup { bits: <transactionReceipt JWT> }
export async function handleTopup(env, guildId, userId, req) {
  const body = await req.json().catch(() => ({}));

  // Verify the Bits receipt is a real, signed, unexpired transaction for one of
  // OUR top-up SKUs (guards against replaying a song_request/doodle receipt).
  const receipt = await verifyBitsReceipt(body.bits, env.TWITCH_EXT_SECRET);
  const data = receipt && receipt.data;
  const product = data && data.product;
  const sku = product && product.sku ? String(product.sku) : '';
  if (!receipt || receipt.topic !== 'bits_transaction_receipt' || !/^bolts/i.test(sku)) {
    return json({ error: 'bad-payment', message: 'Payment could not be verified.' }, 402);
  }

  const txId = String(data.transactionId || '');
  if (!txId) return json({ error: 'bad-payment', message: 'Payment could not be verified.' }, 402);

  // Replay-protection: one credit per transaction id (best-effort — Twitch
  // issues one receipt per purchase; this stops a double-POST from the panel).
  try {
    if (await env.LOADOUT_BOLTS.get(doneKey(txId))) {
      return json({ ok: true, duplicate: true, granted: 0, wallet: await walletView(env, guildId, userId) });
    }
  } catch { /* fall through — better to risk a rare double than block a paid credit */ }

  const bits = Number(product.cost && product.cost.amount) || 0;
  const bolts = Math.max(0, Math.round(bits * RATE));

  try { await env.LOADOUT_BOLTS.put(doneKey(txId), '1', { expirationTtl: 90 * 24 * 3600 }); } catch { /* best-effort */ }
  if (bolts > 0) await earn(env, guildId, userId, bolts, 'topup:' + sku);

  return json({ ok: true, granted: bolts, bits, wallet: await walletView(env, guildId, userId) });
}
