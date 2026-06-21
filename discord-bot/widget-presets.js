// Server-side premium-preset entitlement for the Rotation widget
// (widget.aquilo.gg/rotation). The widget config page sends the visitor's
// Patreon access token; we derive their identity + pledge tier from Patreon
// (authoritative, NOT spoofable by editing localStorage) and return the
// preset slugs they may use. Caches the raw entitlement by token hash (1h)
// so we do not hit Patreon on every config load; the allowed-list is then
// computed fresh on each call so gating-logic changes take effect at once.
//
// Never log or echo the access token; only its SHA-256 hash is used as a
// cache key.

const BASE_PRESETS = ['minimal', 'album-hero', 'retro', 'neon', 'square', 'vertical'];

// Premium preset groups, keyed for future expansion (e.g. a later T3
// 'cyberpunk' pack). minCents = the Patreon entitled-amount floor that
// unlocks the group. Fallout is the first premium pack: T2+ ($5+).
const PREMIUM_GROUPS = {
  fallout: { presets: ['pipboy', 'vault-tec', 'wasteland-radio'], minCents: 500 },
};

// Campaign owner emails: always entitled to every premium group regardless
// of pledge tier (wired into computeAccess by the owner-always bypass).
const OWNER_EMAILS = new Set(['bisherclay@gmail.com']);

// The Aquilo campaign. Pledges to OTHER creators' Patreon campaigns must
// not unlock our premium features, so we filter memberships by this id.
// Keep in sync with patreon-auth.js / patreon-proxy.worker.js. Overridable
// via env.PATREON_CAMPAIGN_ID.
const AQUILO_CAMPAIGN_ID = '3410750';

const PATREON_IDENTITY_URL =
  'https://www.patreon.com/api/oauth2/v2/identity' +
  '?include=memberships,memberships.campaign&fields[member]=currently_entitled_amount_cents,patron_status&fields[user]=email';

function centsToTier(cents) {
  if (cents >= 1000) return 't3';
  if (cents >= 500) return 't2';
  if (cents >= 1) return 't1';
  return 'none';
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Fetch identity + the max active entitled cents from Patreon using the
// visitor's access token. Returns { userId, email, cents } or null on
// failure (expired token, network, no email scope, etc.).
async function fetchPatreonEntitlement(accessToken, campaignId) {
  let res;
  try {
    res = await fetch(PATREON_IDENTITY_URL, { headers: { Authorization: 'Bearer ' + accessToken } });
  } catch { return null; }
  if (!res.ok) return null;
  let j;
  try { j = await res.json(); } catch { return null; }
  const userId = String(j?.data?.id || '');
  const email = String(j?.data?.attributes?.email || '').toLowerCase().trim();
  const wantCampaign = String(campaignId || AQUILO_CAMPAIGN_ID);
  let cents = 0;
  for (const m of (j?.included || [])) {
    if (m.type !== 'member') continue;
    if (m.attributes?.patron_status !== 'active_patron') continue;
    // Only count pledges on OUR campaign: a $5 pledge to some other
    // creator must not unlock Aquilo premium.
    const memberCampaign = String(m.relationships?.campaign?.data?.id || '');
    if (memberCampaign !== wantCampaign) continue;
    const c = Number(m.attributes?.currently_entitled_amount_cents || 0);
    if (c > cents) cents = c;
  }
  return { userId, email, cents };
}

const FREE = () => ({ ok: true, tier: 'none', owner: false, cents: 0, allowed: BASE_PRESETS.slice(), premiumUnlocked: [] });

// Compute the allowed preset list from an entitlement record. Kept separate
// from the cache so logic changes (e.g. the owner-always bypass) apply
// immediately without waiting for cached entitlements to expire.
function computeAccess(ent) {
  const owner = !!ent.email && OWNER_EMAILS.has(ent.email);
  const tier = centsToTier(ent.cents);
  const allowed = BASE_PRESETS.slice();
  const premiumUnlocked = [];
  for (const [group, def] of Object.entries(PREMIUM_GROUPS)) {
    const unlocked = ent.cents >= def.minCents;
    if (unlocked) { allowed.push(...def.presets); premiumUnlocked.push(group); }
  }
  return { ok: true, tier, owner, cents: ent.cents, allowed, premiumUnlocked };
}

// Resolve preset access for a Patreon access token. Caches the raw
// entitlement (userId/email/cents) by token hash for 1h, mirrored to
// patreon:tier:<userId>. Returns { ok, tier, owner, cents, allowed,
// premiumUnlocked }.
export async function getWidgetPresetAccess(env, accessToken) {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.length < 10) {
    return { ...FREE(), reason: 'no-token' };
  }
  let ent = null;
  // v2 cache namespace: entries cached before campaign-scoping landed were
  // over-permissive (counted pledges to any campaign), so ignore them.
  const cacheKey = 'patreon:tier:tok:v2:' + (await sha256Hex(accessToken)).slice(0, 40);
  try {
    ent = await env.LOADOUT_BOLTS.get(cacheKey, { type: 'json' });
  } catch { /* ignore */ }
  if (!ent) {
    ent = await fetchPatreonEntitlement(accessToken, (env && env.PATREON_CAMPAIGN_ID) || AQUILO_CAMPAIGN_ID);
    if (ent) {
      try {
        const payload = JSON.stringify(ent);
        await env.LOADOUT_BOLTS.put(cacheKey, payload, { expirationTtl: 3600 });
        if (ent.userId) await env.LOADOUT_BOLTS.put('patreon:tier:' + ent.userId, payload, { expirationTtl: 3600 });
      } catch { /* ignore */ }
    }
  }
  if (!ent) return { ...FREE(), reason: 'identity-failed' };
  return computeAccess(ent);
}
