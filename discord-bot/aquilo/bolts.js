// Cross-worker Loadout bolt award/deduct. Called by counting.js,
// encounter.js, and anywhere else that needs to credit/debit bolts via
// Loadout's wallet (the source of truth, KV-backed inside the
// loadout-discord worker).
//
// Auth: shared LOADOUT_BOLT_API_SECRET secret on both workers, passed
// as X-Counting-Secret on the POST. Loadout's /counting/award-bolts
// endpoint accepts positive or negative `amount` and clamps balance ≥ 0.

export async function applyBolts(env, guildId, userId, amount, reason) {
  if (!env.LOADOUT_BOLT_API || !env.LOADOUT_BOLT_API_SECRET) {
    console.warn('[bolts] Loadout API unconfigured, skip');
    return { ok: false, reason: 'loadout_unconfigured' };
  }
  if (!Number.isFinite(amount) || amount === 0) {
    return { ok: false, reason: 'zero_or_invalid_amount' };
  }
  try {
    const resp = await fetch(env.LOADOUT_BOLT_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-counting-secret': env.LOADOUT_BOLT_API_SECRET
      },
      body: JSON.stringify({ guildId, userId, amount: Math.trunc(amount), reason })
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.warn('[bolts] ' + resp.status + ': ' + t.slice(0, 200));
      return { ok: false, reason: 'http_' + resp.status };
    }
    return await resp.json();
  } catch (e) {
    console.warn('[bolts] throw:', e?.message || e);
    return { ok: false, reason: 'throw' };
  }
}
