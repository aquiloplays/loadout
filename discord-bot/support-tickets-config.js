// Static fallbacks used by support-tickets.js when KV / env haven't
// been wired yet. Pulled into a separate module so unit tests can
// stub the file without touching the main module.
//
// Aquilo guild Staff role id, verified from wrangler.toml line 97:
// STAFF_ROLE_ID = "1507973879442964660" (🛡️ Moderator).
export const STAFF_ROLE_ID_FALLBACK = '1507973879442964660';
