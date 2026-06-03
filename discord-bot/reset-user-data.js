// Destructive one-shot, wipes user-facing economy + progression state
// for a guild. Driven by POST /admin/reset-user-data/<g> (HMAC-gated
// + confirm-string-gated). NEVER fires implicitly.
//
// Wipes:
//   wallet:<g>:<u>, Bolts balances (uses resetAllWallets
//                                    which zeroes counters + preserves
//                                    the user's links[] array so /link
//                                    pairings survive)
//   community-checkin:<g>:<u>, daily check-in streak / lastDayEt
//   community-checkin-bonus:<g>:<u>, unclaimed bonus queue
//   freeze:<g>:<u>, streak shields (economy item)
//   pxp:<u>, progression XP / level (NOT guild-
//                                    scoped in KV; wipes ALL of this
//                                    user's XP across every guild they
//                                    appear in. Acceptable for the
//                                    single-guild Aquilo deploy)
//
// Preserves (do NOT delete):
//   character:* / character-portrait:*, avatars users have uploaded
//   checkin-card:<g>:<u>, PWA check-in card cosmetics
//   referral:* / ref-attrib:*, referral attributions
//   guild:* / channel-binding:*, admin config
//   secret:*, auth secrets
//   onboard:role-map:*, admin-side role wiring
//   gifter-roles:* / level-tier-roles:*, role-membership snapshots
//
// Returns per-prefix counts so the admin tooling can show what got
// wiped, plus a list of any error reasons.

import { resetAllWallets } from './wallet.js';

const KEY_LIMIT = 1000;
const MAX_PAGES = 50;   // 50 × 1000 = 50k per prefix, enough for any
                         // single Aquilo-scale guild and bounded against
                         // runaway scans.

// One full scan of a prefix, deleting every match. Returns { deleted,
// pages } so the caller can verify the prefix didn't paginate further
// than the bound (would indicate KV bigger than expected).
async function deletePrefix(env, prefix) {
  let cursor;
  let deleted = 0;
  let pages = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    pages++;
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: KEY_LIMIT });
    for (const k of r.keys) {
      await env.LOADOUT_BOLTS.delete(k.name).catch(() => {});
      deleted++;
    }
    if (r.list_complete || !r.cursor) return { deleted, pages, complete: true };
    cursor = r.cursor;
  }
  return { deleted, pages, complete: false };
}

// Scan pxp:*, keys are pxp:<userId>, NOT guild-scoped. For the
// Aquilo single-guild deploy this is fine; for a hypothetical multi-
// guild deploy a caller would need to scope by user list instead.
async function deletePxpAll(env) {
  return deletePrefix(env, 'pxp:');
}

export async function resetUserData(env, guildId, opts = {}) {
  if (!env?.LOADOUT_BOLTS) return { ok: false, error: 'no-kv' };
  if (!guildId || !/^\d{5,25}$/.test(String(guildId))) {
    return { ok: false, error: 'bad-guild-id' };
  }

  const summary = {};

  // wallets, use the existing resetAllWallets so links[] is preserved
  // and the on-disk shape stays canonical. Returns the count of
  // wallets cleared rather than deleted; the KV records remain but
  // are zeroed.
  try {
    const cleared = await resetAllWallets(env, guildId);
    summary['wallet:'] = { reset: cleared, mode: 'zeroed-preserved-links' };
  } catch (e) {
    summary['wallet:'] = { error: String(e?.message || e) };
  }

  // Hard-delete the per-user progression + streak records. Anything
  // recreated by the user's next interaction starts fresh.
  for (const prefix of [
    `community-checkin:${guildId}:`,
    `community-checkin-bonus:${guildId}:`,
    `freeze:${guildId}:`,
  ]) {
    try { summary[prefix] = await deletePrefix(env, prefix); }
    catch (e) { summary[prefix] = { error: String(e?.message || e) }; }
  }

  // pxp:* is global (no guild segment). Documented in the call-site
  // comment so the caller knows what they're nuking.
  try {
    if (opts.includeGlobalPxp !== false) {
      summary['pxp:'] = { ...(await deletePxpAll(env)), scope: 'global-not-guild-scoped' };
    } else {
      summary['pxp:'] = { skipped: 'opts.includeGlobalPxp=false' };
    }
  } catch (e) {
    summary['pxp:'] = { error: String(e?.message || e) };
  }

  return { ok: true, guildId, summary };
}
