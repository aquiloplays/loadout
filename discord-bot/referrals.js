// Referral system — each linked member can refer new members and earn
// a reward when a referee hits their first meaningful milestone.
//
// Two attribution paths:
//   A) Web link (works NOW, no gateway shim required):
//      Referee lands on aquilo.gg/?ref=CODE → cookie captured → on
//      Patreon-link the site POSTs /web/referral/attribute to record
//      the (refereeId, refCode) pair.
//   B) Discord invite (gateway-shim-gated, built dormant):
//      When the shim starts forwarding GUILD_MEMBER_ADD with the
//      `invite_code` field, welcome.js can call attributeFromInvite()
//      to look up the invite-code → referrer mapping and attribute
//      automatically. Until then, path (A) covers it.
//
// Milestone semantics: each referee can only credit their referrer
// ONCE. The first milestone (whichever fires first — Patreon-link or
// first community check-in) pays out + locks the record. Subsequent
// milestones for the same referee are no-ops.
//
// Reward (single Patreon tier — no scaling per Clay):
//   • 50 bolts
//   • 1 'bolt' Boltbound pack
//
// Anti-abuse:
//   • Self-referral: refused at attribute time.
//   • Double-attribution: first attribution wins; subsequent calls
//     for the same referee return { ok: false, error: 'already-attributed' }.
//   • Double-payout: protected by the milestoneFiredUtc stamp on the
//     referee record.
//
// KV layout (all on LOADOUT_BOLTS):
//   referral:code-by-user:<g>:<u>  → 'CODE1234'                (one code per user)
//   referral:user-by-code:<g>:<c>  → '<userId>'                (reverse lookup)
//   referral:referee:<g>:<u>       → { refCode, referrerId,
//                                       attributedUtc,
//                                       milestoneFiredUtc?,
//                                       milestoneKind? }
//   referral:referrer:<g>:<u>      → { count, paid, lastUtc,
//                                       history: [...] }  (capped to 50)
//
// `count` is # referees attributed; `paid` is # referees whose first
// milestone has fired (and thus paid the reward).

import { earn } from './wallet.js';
import { creditPack } from './cards-packs.js';

export const REFERRAL_REWARD_BOLTS = 50;
export const REFERRAL_REWARD_PACK  = 'bolt';

const CODE_KEY_BY_USER = (g, u) => `referral:code-by-user:${g}:${u}`;
const CODE_KEY_BY_CODE = (g, c) => `referral:user-by-code:${g}:${c}`;
const REFEREE_KEY      = (g, u) => `referral:referee:${g}:${u}`;
const REFERRER_KEY     = (g, u) => `referral:referrer:${g}:${u}`;

// Crockford base32 minus easily-confused chars (I, L, O, U). 8 chars
// → 32^8 ≈ 1.1 trillion combinations; collision-resistant for our
// guild size without per-attempt retry plumbing on top.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH   = 8;

function generateCode() {
  const a = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(a);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
  return out;
}

// ── Code provisioning ──────────────────────────────────────────────────
// Idempotent: same user always gets the same code. First call mints +
// stores both directions; subsequent calls read the existing one.
export async function getOrMintCode(env, guildId, userId) {
  const existing = await env.LOADOUT_BOLTS.get(CODE_KEY_BY_USER(guildId, userId));
  if (existing) return existing;
  // Mint a fresh code. Collision check against the reverse-lookup KV
  // (would mean two random 8-char codes landed on the same string —
  // possible but vanishingly rare).
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const c = generateCode();
    const collision = await env.LOADOUT_BOLTS.get(CODE_KEY_BY_CODE(guildId, c));
    if (!collision) { code = c; break; }
  }
  if (!code) throw new Error('referral-code-mint-collision');
  await env.LOADOUT_BOLTS.put(CODE_KEY_BY_USER(guildId, userId), code);
  await env.LOADOUT_BOLTS.put(CODE_KEY_BY_CODE(guildId, code),  String(userId));
  return code;
}

// ── Stats ──────────────────────────────────────────────────────────────
export async function getReferrerStats(env, guildId, userId) {
  return (await env.LOADOUT_BOLTS.get(REFERRER_KEY(guildId, userId), { type: 'json' }))
    || { count: 0, paid: 0, lastUtc: 0, history: [] };
}

async function putReferrerStats(env, guildId, userId, stats) {
  // Cap history to the last 50 referees so the record stays bounded.
  if (stats.history.length > 50) stats.history = stats.history.slice(-50);
  await env.LOADOUT_BOLTS.put(REFERRER_KEY(guildId, userId), JSON.stringify(stats));
}

export async function getRefereeRecord(env, guildId, userId) {
  return env.LOADOUT_BOLTS.get(REFEREE_KEY(guildId, userId), { type: 'json' });
}

// ── Attribution ────────────────────────────────────────────────────────
// First-attribution-wins. Refuses self-referral and any second call.
// Returns { ok: true, referrerId, refCode } on success.
export async function recordAttribution(env, guildId, refereeId, refCode) {
  if (!guildId || !refereeId || !refCode) return { ok: false, error: 'bad-args' };
  const code = String(refCode).toUpperCase().trim();

  const referrerId = await env.LOADOUT_BOLTS.get(CODE_KEY_BY_CODE(guildId, code));
  if (!referrerId) return { ok: false, error: 'unknown-code' };
  if (String(referrerId) === String(refereeId)) return { ok: false, error: 'self-referral' };

  // First attribution wins.
  const prior = await getRefereeRecord(env, guildId, refereeId);
  if (prior) return { ok: false, error: 'already-attributed', referrerId: prior.referrerId };

  const now = Date.now();
  await env.LOADOUT_BOLTS.put(REFEREE_KEY(guildId, refereeId), JSON.stringify({
    refCode: code,
    referrerId,
    attributedUtc: now,
  }));

  // Bump referrer's running count (no payout yet — that fires on the
  // first milestone, not at attribution time).
  const stats = await getReferrerStats(env, guildId, referrerId);
  stats.count += 1;
  stats.lastUtc = now;
  await putReferrerStats(env, guildId, referrerId, stats);

  return { ok: true, referrerId, refCode: code };
}

// Discord-invite attribution path. Dormant until the gateway shim
// starts forwarding GUILD_MEMBER_ADD with an `invite_code` field — at
// which point welcome.js can call this with the joiner's id + the
// invite code Discord reports they used. Map invite_code → refCode →
// referrer via the same recordAttribution() flow.
//
// To map invite → refCode we'd need a per-referrer Discord-invite
// minted via /channels/{ch}/invites with the invite's code stored on
// the referrer's record. Building that mint flow is a future task;
// for now the function is a placeholder so the call site doesn't
// crash if the shim starts firing early.
export async function attributeFromInvite(env, guildId, refereeId, inviteCode) {
  if (!inviteCode) return { ok: false, error: 'no-invite-code' };
  const refCode = await env.LOADOUT_BOLTS.get(`referral:invite-map:${guildId}:${inviteCode}`);
  if (!refCode) return { ok: false, error: 'invite-not-mapped' };
  return recordAttribution(env, guildId, refereeId, refCode);
}

// ── Milestone payout ───────────────────────────────────────────────────
// Called by milestone-firing call sites (the community-checkin first
// success, the Patreon-link handler). If the referee is attributed AND
// no prior milestone has fired, credits the referrer with the reward
// and stamps the referee record so future milestones don't double-pay.
//
// Returns { paid: bool, reason?: string, referrerId?: string,
//           reward?: { bolts, pack } }.
export async function recordMilestone(env, guildId, refereeId, kind) {
  if (!guildId || !refereeId || !kind) return { paid: false, reason: 'bad-args' };
  const rec = await getRefereeRecord(env, guildId, refereeId);
  if (!rec) return { paid: false, reason: 'not-attributed' };
  if (rec.milestoneFiredUtc) return { paid: false, reason: 'already-paid', referrerId: rec.referrerId };

  // Pay the referrer.
  await earn(env, guildId, rec.referrerId, REFERRAL_REWARD_BOLTS,
             `referral:milestone:${kind}:${refereeId}`);
  const pack = await creditPack(env, guildId, rec.referrerId, REFERRAL_REWARD_PACK,
                                `referral:milestone:${kind}:${refereeId}`);

  // Stamp referee → no future double-pay.
  rec.milestoneFiredUtc = Date.now();
  rec.milestoneKind     = kind;
  await env.LOADOUT_BOLTS.put(REFEREE_KEY(guildId, refereeId), JSON.stringify(rec));

  // Update referrer's stats.
  const stats = await getReferrerStats(env, guildId, rec.referrerId);
  stats.paid += 1;
  stats.history.push({
    refereeId, kind, ts: rec.milestoneFiredUtc,
    reward: { bolts: REFERRAL_REWARD_BOLTS, pack: REFERRAL_REWARD_PACK },
  });
  stats.lastUtc = rec.milestoneFiredUtc;
  await putReferrerStats(env, guildId, rec.referrerId, stats);

  return {
    paid: true,
    referrerId: rec.referrerId,
    reward: { bolts: REFERRAL_REWARD_BOLTS, pack: REFERRAL_REWARD_PACK, packCreditOk: !!pack?.ok },
  };
}

// ── /referral slash command ────────────────────────────────────────────
export async function handleReferralCommand(env, data) {
  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  if (!guildId || !userId) {
    return { type: 4, data: { content: 'Run this in a server.', flags: 64 } };
  }
  const code  = await getOrMintCode(env, guildId, userId);
  const stats = await getReferrerStats(env, guildId, userId);
  const link  = `https://aquilo.gg/?ref=${code}`;

  const lines = [
    `🎟️  **Your referral code:** \`${code}\``,
    `🔗  ${link}`,
    '',
    `📊  **Referrals so far:**`,
    `   • ${stats.count} member${stats.count === 1 ? '' : 's'} signed up with your code`,
    `   • ${stats.paid} hit a milestone → you earned **${stats.paid * REFERRAL_REWARD_BOLTS} bolts** + **${stats.paid} pack${stats.paid === 1 ? '' : 's'}**`,
    '',
    `_Each referred member who links their Patreon OR does their first daily check-in earns you **${REFERRAL_REWARD_BOLTS} bolts** + **1 Boltbound pack**._`,
  ];
  return { type: 4, data: { content: lines.join('\n'), flags: 64 } };
}
