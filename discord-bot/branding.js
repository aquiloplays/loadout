// Per-guild branding overrides.
//
// Loadout ships with Aquilo's branding as the global default (siteUrl
// = aquilo.gg, accent = pink, welcome-card image hosted on aquilo.gg).
// Other tenants can override any subset of these via /setup or the
// website's branding tab. Unset fields fall back to the Aquilo
// defaults so an empty record is fine.
//
// KV: guild:branding:<g> → { siteUrl?, accentColor?, welcomeBackdropUrl?,
//                             checkinDefaultImageUrl?, brandName?, updatedUtc }
//
// Read pattern at call sites:
//   const b = await getBranding(env, guildId);
//   const url = b.siteUrl;          // never empty — falls back to default
//   const color = b.accentColor;    // 0xRRGGBB

const KEY = (g) => `guild:branding:${g}`;

// Defaults — Aquilo's branding. ANY change here is a default change
// for every un-customised tenant, so prefer per-guild override KV writes
// over editing this table.
const DEFAULTS = Object.freeze({
  brandName:              'aquilo.gg',
  siteUrl:                'https://aquilo.gg',
  accentColor:            0xF47FFF,
  welcomeBackdropUrl:     'https://aquilo.gg/sprites/welcome/aquilo-welcome-card.png',
  checkinDefaultImageUrl: 'https://aquilo.gg/sprites/checkin/default-card.png',
});

export async function getBranding(env, guildId) {
  let raw = null;
  try { raw = await env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' }); } catch { /* idle */ }
  return { ...DEFAULTS, ...(raw || {}) };
}

export async function putBranding(env, guildId, patch) {
  const existing = (await env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' })) || {};
  const clean = { ...existing };
  if (typeof patch?.brandName === 'string')
    clean.brandName = patch.brandName.trim().slice(0, 60);
  if (typeof patch?.siteUrl === 'string') {
    const u = patch.siteUrl.trim();
    if (u && !/^https?:\/\//i.test(u)) return { ok: false, error: 'siteUrl-must-be-http(s)' };
    clean.siteUrl = u || undefined;
  }
  if (Number.isInteger(patch?.accentColor))
    clean.accentColor = patch.accentColor & 0xFFFFFF;
  if (typeof patch?.welcomeBackdropUrl === 'string') {
    const u = patch.welcomeBackdropUrl.trim();
    if (u && !/^https:\/\//i.test(u)) return { ok: false, error: 'welcomeBackdropUrl-must-be-https' };
    clean.welcomeBackdropUrl = u || undefined;
  }
  if (typeof patch?.checkinDefaultImageUrl === 'string') {
    const u = patch.checkinDefaultImageUrl.trim();
    if (u && !/^https:\/\//i.test(u)) return { ok: false, error: 'checkinDefaultImageUrl-must-be-https' };
    clean.checkinDefaultImageUrl = u || undefined;
  }
  clean.updatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(clean));
  return { ok: true, branding: { ...DEFAULTS, ...clean } };
}
