// New-member onboarding quest — a short checklist that walks a fresh
// viewer through the four engagement primitives in their first session.
// Each step has a tiny reward to make the funnel feel rewarding even
// before the bigger systems (Boltbound, dungeon, clash) light up.
//
// Steps are deliberately stateless where possible — completion is
// computed by reading the same KV/wallet records the user is already
// interacting with — so a step can flip to "claim available" without
// any explicit "you completed step X" write. Two exceptions:
//   • `patreon-linked` — the worker doesn't see the aq_link cookie,
//     so the website's Patreon-link handler POSTs to a tiny endpoint
//     that flips a flag here.
//   • `played-game` — game routes in web.js call markGamePlayed()
//     fire-and-forget so the completion isn't lost if the user's
//     wallet earnings happen to roll back below the proxy threshold.
//
// Claim state per step is persisted at quest:state:<g>:<u>:
//   { steps: { [stepId]: { claimedUtc?: number, reward?: { bolts, pack? } } } }
//
// Single Patreon tier per Clay — rewards are flat, no scaling.

import { earn, getWallet } from './wallet.js';
import { creditPack } from './cards-packs.js';
import { getStatus as getCheckinStatus } from './community-checkin.js';

const STATE_KEY        = (g, u) => `quest:state:${g}:${u}`;
const PATREON_FLAG_KEY = (g, u) => `quest:patreon-linked:${g}:${u}`;
const GAME_FLAG_KEY    = (g, u) => `quest:game-played:${g}:${u}`;

// Step catalog. Order is the recommended UI display order.
//   id          stable identifier (URL + KV)
//   label       human-readable
//   reward      bolts + optional packType
//   completion  async (env, g, u) -> bool — has the step been done?
export const STEPS = [
  {
    id:     'joined-discord',
    label:  'Join the Aquilo Discord',
    reward: { bolts: 5 },
    completion: async () => true,   // they're in the guild if they're calling
  },
  {
    id:     'linked-patreon',
    label:  'Link your Patreon account',
    reward: { bolts: 25, pack: 'bolt' },
    // Completes when ANY of these signals are present:
    //   (a) /web/quest/mark-patreon-linked has been called for this
    //       (guild, user) → explicit `quest:patreon-linked:<g>:<u>` flag.
    //   (b) patreon:tier:<userId> exists in KV (aquilo-site's OAuth
    //       callback writes it, BUT only if the Patreon profile has
    //       a non-empty image_url — see functions/api/link/[[route]].js
    //       around line 312, the write is gated on patreonImageUrl).
    //       Many real users (especially Patreon-only freebies) don't
    //       carry an avatar, so this signal is unreliable.
    //   (c) wallet:<g>:<u>.links contains a `patreon` entry. THIS is
    //       the bulletproof signal — the link handler unconditionally
    //       merges every linked platform into `w.links` at the same
    //       site code path. If you've successfully completed Patreon
    //       OAuth, this entry exists.
    // Without (c), users without a Patreon avatar were stuck unable
    // to claim the step even though they'd genuinely linked. The
    // three-way check is the fix.
    completion: async (env, g, u) => {
      if (await env.LOADOUT_BOLTS.get(PATREON_FLAG_KEY(g, u))) return true;
      try {
        const { isPatron } = await import('./progression/linking.js');
        if (await isPatron(env, u)) return true;
      } catch { /* fall through to wallet-links check */ }
      try {
        const w = await getWallet(env, g, u);
        const links = Array.isArray(w?.links) ? w.links : [];
        if (links.some(l => l && String(l.platform || '').toLowerCase() === 'patreon')) {
          return true;
        }
      } catch { /* idle */ }
      return false;
    },
  },
  {
    id:     'first-checkin',
    label:  'Do your first community check-in',
    reward: { bolts: 10 },
    completion: async (env, g, u) => {
      const s = await getCheckinStatus(env, g, u);
      return (s.total || 0) > 0;
    },
  },
  {
    id:     'played-game',
    label:  'Play a game (any minigame, daily, or coinflip)',
    reward: { bolts: 5 },
    completion: async (env, g, u) => {
      // Flag-first (explicit signal from a game route), wallet-fallback
      // (catches existing players who pre-date the funnel).
      if (await env.LOADOUT_BOLTS.get(GAME_FLAG_KEY(g, u))) return true;
      const w = await getWallet(env, g, u);
      return (w.lifetimeEarned || 0) > 0 || (w.lifetimeSpent || 0) > 0;
    },
  },
  // Gift Supporter CTA removed from the onboarding checklist 2026-05-28
  // per Clay — too pushy as a first-session step. The gift link still
  // surfaces via /gift, the role-picker hub footer, and the pinned
  // embed in the dedicated gift channel.
];

async function loadState(env, guildId, userId) {
  return (await env.LOADOUT_BOLTS.get(STATE_KEY(guildId, userId), { type: 'json' }))
    || { steps: {} };
}
async function saveState(env, guildId, userId, state) {
  await env.LOADOUT_BOLTS.put(STATE_KEY(guildId, userId), JSON.stringify(state));
}

// ── External-mutator helpers ───────────────────────────────────────────
// Called by the corresponding milestone-firing call site. Idempotent —
// re-setting a flag is harmless. Returns a structured result so the
// /web/quest/mark-patreon-linked route can surface whether the
// patreon:tier link was independently verified (useful debugging for
// the site).
export async function markPatreonLinked(env, guildId, userId) {
  await env.LOADOUT_BOLTS.put(PATREON_FLAG_KEY(guildId, userId), '1');
  // Best-effort patreon:tier verification — the actual link record is
  // written by aquilo-site's Patreon-OAuth handler; we just confirm
  // it's there so the site can flag a "site says linked but worker
  // can't see it" mismatch in the response.
  let verified = false;
  try {
    const { isPatron } = await import('./progression/linking.js');
    verified = await isPatron(env, userId);
  } catch { /* idle */ }
  return { ok: true, verified };
}
export async function markGamePlayed(env, guildId, userId) {
  await env.LOADOUT_BOLTS.put(GAME_FLAG_KEY(guildId, userId), '1');
}

// ── Snapshot for the website ───────────────────────────────────────────
export async function getSnapshot(env, guildId, userId) {
  const state = await loadState(env, guildId, userId);
  const out = [];
  let totalAvailableBolts = 0;
  let totalClaimedBolts   = 0;
  for (const step of STEPS) {
    const completed = await step.completion(env, guildId, userId).catch(() => false);
    const claim     = state.steps[step.id];
    const claimable = completed && !claim?.claimedUtc;
    if (claimable) totalAvailableBolts += step.reward.bolts;
    if (claim?.claimedUtc) totalClaimedBolts += (claim.reward?.bolts || step.reward.bolts);
    out.push({
      id:          step.id,
      label:       step.label,
      reward:      step.reward,
      completed,
      claimed:     !!claim?.claimedUtc,
      claimable,
      claimedUtc:  claim?.claimedUtc || 0,
    });
  }
  return {
    ok: true,
    steps: out,
    summary: {
      total:               STEPS.length,
      completed:           out.filter(s => s.completed).length,
      claimed:             out.filter(s => s.claimed).length,
      pendingClaims:       out.filter(s => s.claimable).length,
      totalAvailableBolts,
      totalClaimedBolts,
    },
  };
}

// ── Claim ──────────────────────────────────────────────────────────────
// Idempotent — claiming an already-claimed step is a no-op (returns
// { ok: true, alreadyClaimed: true }). Claiming a step that hasn't
// been completed yet returns 400. `stepId` of 'all' drains every
// available claim in one call.
export async function claimStep(env, guildId, userId, stepId) {
  if (!stepId) return { ok: false, error: 'stepId-required' };

  const snapshot = await getSnapshot(env, guildId, userId);
  const state    = await loadState(env, guildId, userId);

  const target = stepId === 'all'
    ? snapshot.steps.filter(s => s.claimable)
    : snapshot.steps.filter(s => s.id === stepId);
  if (target.length === 0 && stepId !== 'all') {
    return { ok: false, error: 'unknown-step' };
  }

  const granted = [];
  for (const s of target) {
    if (s.claimed)    { granted.push({ id: s.id, alreadyClaimed: true }); continue; }
    if (!s.completed) { granted.push({ id: s.id, error: 'not-completed' }); continue; }

    await earn(env, guildId, userId, s.reward.bolts, `quest:${s.id}`);
    let packResult = null;
    if (s.reward.pack) {
      packResult = await creditPack(env, guildId, userId, s.reward.pack, `quest:${s.id}`);
    }
    state.steps[s.id] = {
      claimedUtc: Date.now(),
      reward: s.reward,
    };
    granted.push({ id: s.id, bolts: s.reward.bolts, pack: s.reward.pack || null,
                   packCreditOk: packResult ? !!packResult.ok : null });
  }
  await saveState(env, guildId, userId, state);

  const w = await getWallet(env, guildId, userId);
  return { ok: true, granted, balance: w.balance || 0 };
}

// ── /quest slash command ───────────────────────────────────────────────
export async function handleQuestCommand(env, data) {
  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  if (!guildId || !userId) {
    return { type: 4, data: { content: 'Run this in a server.', flags: 64 } };
  }
  const snap = await getSnapshot(env, guildId, userId);
  // User-facing copy says "Welcome Checklist" (matches the website
  // rename); the slash command name, KV namespace, and step ids
  // still say "quest" for stability.
  const lines = ['🎯  **Welcome Checklist**', ''];
  for (const s of snap.steps) {
    const tick =
      s.claimed   ? '✅'
    : s.claimable ? '🎁'
    : s.completed ? '✔︎'
    :               '◯';
    const reward = s.reward.pack
      ? `${s.reward.bolts} bolts + ${s.reward.pack} pack`
      : `${s.reward.bolts} bolts`;
    lines.push(`${tick}  ${s.label}  · _${reward}_${s.claimable ? '  **← claim on aquilo.gg/quest**' : ''}`);
  }
  if (snap.summary.pendingClaims) {
    lines.push('');
    lines.push(`🎁  **${snap.summary.pendingClaims}** reward${snap.summary.pendingClaims === 1 ? '' : 's'} ready (${snap.summary.totalAvailableBolts} bolts) — collect on https://aquilo.gg/quest`);
  } else if (snap.summary.claimed === snap.summary.total) {
    lines.push('');
    lines.push('🏁  Welcome Checklist complete — welcome to the community!');
  }
  return { type: 4, data: { content: lines.join('\n'), flags: 64 } };
}
