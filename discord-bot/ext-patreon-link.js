// Phase P, Viewer→Patreon real linking (panel-driven).
//
// GET /ext/patreon/link-start  (JWT-gated, identity-required):
//   Mints a short-lived (5 min) JWT carrying { tw_id, exp } signed with
//   TWITCH_EXT_SECRET, the same secret the aquilo-site Pages Function
//   uses to verify it on the OAuth callback. Returns:
//     { ok: true, url: "https://aquilo.gg/api/link/start?platform=patreon&extToken=..." }
//   The panel opens that URL in a new tab; the user authorizes Patreon
//   once; the Pages Function verifies the extToken and writes
//     tw_patreon:tw:<id> = { patreon_id, patreon_email, tier, linked_at }
//   into the shared KV. After that, routePatronCorner sees the mapping
//   and flips eligibility to { eligible: true, kind: 'patron' }.
//
// Opaque viewers (no identity share) cannot link, we can't tie an
// anonymous opaque_user_id to a real Patreon account safely. They get
// an "identity-required" 400 the panel turns into a share prompt.

import { json } from './ext-shared.js';
import { signHs256 } from './auth.js';

const LINK_TTL_SEC = 5 * 60;
const LINK_ORIGIN = 'https://aquilo.gg';

export async function startPanelPatreonLink(env, payload, req) {
  if (req.method !== 'GET') return json({ error: 'method' }, 405);
  if (!payload || !payload.user_id) {
    return json({ error: 'identity-required' }, 400);
  }
  if (!env.TWITCH_EXT_SECRET) {
    return json({ error: 'not-configured' }, 503);
  }
  const token = await signHs256(env.TWITCH_EXT_SECRET, {
    tw_id: String(payload.user_id),
    exp: Math.floor(Date.now() / 1000) + LINK_TTL_SEC,
  });
  const url =
    LINK_ORIGIN +
    '/api/link/start?platform=patreon&extToken=' +
    encodeURIComponent(token);
  return json({ ok: true, url });
}
