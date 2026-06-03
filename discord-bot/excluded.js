// Leaderboard exclusion list.
//
// Filters Clay's own accounts out of every leaderboard surface
// (Discord /loadout leaderboard, panel /ext/leaderboard, panel
// check-in leaderboard, the website's /leaderboard/:guildId public
// endpoint, the hourly bolts-feed digest channel). Clay is the
// primary tester right now and his balances would skew the boards.
//
// To turn this off entirely once he's done testing: set the env var
// LEADERBOARD_EXCLUDE_ENABLED = "false" in wrangler.toml [vars] and
// redeploy. Adding / removing individual accounts: edit the lists
// below.
//
// Identity formats this module recognises:
//   Discord-keyed wallets:  bare numeric snowflake (e.g. "1107161695262085210")
//   Twitch-keyed wallets:   "tw:<numeric twitch user id>" (e.g. "tw:1497793223")
//   Other linked accounts:  filtered indirectly via the wallet's `links` array
//                           (a wallet whose links includes `aquilogg`).

const EXCLUDED_DISCORD_IDS = new Set([
  '1107161695262085210', // Clay (aquilo / bisherclay)
]);

const EXCLUDED_TWITCH_IDS = new Set([
  '991099623',  // Clay's Twitch channel id (prodigalttv), active 2026-06-02
  '1497793223', // Clay's old Twitch channel id (aquilogg), kept for legacy wallets
]);

// Legacy username-based fallback for cross-linked wallets whose link
// record carries only a handle (no platform id). Twitch logins can be
// renamed, so the ID-based EXCLUDED_TWITCH_IDS above is the canonical,
// rename-proof mechanism, a link record that carries a numeric id is
// matched against that set instead (see isExcludedWallet). These
// handles only catch link records that predate id capture.
const EXCLUDED_LINK_HANDLES = new Set([
  'twitch:prodigalttv',
  'twitch:aquilogg',
  'tiktok:%40aquilo.gg',
  'tiktok:aquilo.gg',
]);

const EXCLUDED_PATREON_EMAILS = new Set([
  'bisherclay@gmail.com',
]);

function isEnabled(env) {
  // Default-on. Set LEADERBOARD_EXCLUDE_ENABLED = "false" to disable.
  return String((env && env.LEADERBOARD_EXCLUDE_ENABLED) || 'true').toLowerCase() !== 'false';
}

/** True if the given wallet-key userId belongs to an excluded account. */
export function isExcludedUserId(env, userId) {
  if (!isEnabled(env) || !userId) return false;
  const s = String(userId);
  if (EXCLUDED_DISCORD_IDS.has(s)) return true;
  if (s.startsWith('tw:') && EXCLUDED_TWITCH_IDS.has(s.slice(3))) return true;
  return false;
}

/**
 * True if the userId is one of the owner's own accounts (Clay), checked
 * regardless of LEADERBOARD_EXCLUDE_ENABLED. Use this where the owner
 * should NEVER appear no matter the leaderboard toggle, e.g. his own
 * Patron / supporter wall. Accepts a bare Discord snowflake or a
 * "tw:<twitch id>" wallet key.
 */
export function isOwnerUserId(userId) {
  if (!userId) return false;
  const s = String(userId);
  if (EXCLUDED_DISCORD_IDS.has(s)) return true;
  if (s.startsWith('tw:') && EXCLUDED_TWITCH_IDS.has(s.slice(3))) return true;
  return false;
}

/**
 * True if the given wallet snapshot (the value side of wallet:<g>:<id>
 * or the panel's hero/checkin records) belongs to an excluded account.
 * Walks the `links` array so we catch wallets that haven't been keyed
 * to Clay's Discord ID directly, e.g. an unlinked Twitch viewer who
 * happens to use the `aquilogg` handle.
 */
export function isExcludedWallet(env, userId, wallet) {
  if (isExcludedUserId(env, userId)) return true;
  if (!isEnabled(env) || !wallet) return false;
  const links = Array.isArray(wallet.links) ? wallet.links : [];
  for (const l of links) {
    if (!l) continue;
    const platform = String(l.platform || '').toLowerCase();
    // Prefer the permanent platform id when the link record carries one
    //, rename-proof. (Twitch logins change; ids don't.)
    const linkId = l.id != null ? String(l.id) : (l.userId != null ? String(l.userId) : null);
    if (platform === 'twitch' && linkId && EXCLUDED_TWITCH_IDS.has(linkId)) return true;
    // Legacy fallback: handle match for link records without an id.
    const key = platform + ':' + String(l.username || '');
    if (EXCLUDED_LINK_HANDLES.has(key)) return true;
  }
  return false;
}

/** True if the given Patreon email is excluded (for site-side use). */
export function isExcludedPatreon(env, email) {
  if (!isEnabled(env) || !email) return false;
  return EXCLUDED_PATREON_EMAILS.has(String(email).toLowerCase());
}

/** Filter a list of `{ userId, w }` rows in place. Used by leaderboard(). */
export function filterLeaderboardRows(env, rows) {
  if (!isEnabled(env)) return rows;
  return rows.filter((r) => !isExcludedWallet(env, r.userId, r.w));
}
