// New-member onboarding quest, a short checklist that walks a fresh
// viewer through the four engagement primitives in their first session.
//
// (Bolts economy sunset: the checklist used to grant a tiny bolt/pack
// reward per step. That payout has been removed — it's now a pure
// progress tracker (completion + claimed/checked-off state) with no
// currency.)
//
// Steps are deliberately stateless where possible, completion is
// computed by reading the same KV records the user is already
// interacting with, so a step can flip to "claim available" without
// any explicit "you completed step X" write. Two exceptions:
//   • `patreon-linked`, the worker doesn't see the aq_link cookie,
//     so the website's Patreon-link handler POSTs to a tiny endpoint
//     that flips a flag here.
//   • `played-game`, game routes in web.js call markGamePlayed()
//     fire-and-forget so the completion is recorded explicitly.
//
// Claim state per step is persisted at quest:state:<g>:<u>:
//   { steps: { [stepId]: { claimedUtc?: number } } }

// (Bolts economy sunset: removed wallet/economy-pace/cards-packs import)
import { getStatus as getCheckinStatus } from './community-checkin.js';

const STATE_KEY        = (g, u) => `quest:state:${g}:${u}`;
const PATREON_FLAG_KEY = (g, u) => `quest:patreon-linked:${g}:${u}`;
const GAME_FLAG_KEY    = (g, u) => `quest:game-played:${g}:${u}`;

// Step catalog. Order is the recommended UI display order.
//   id          stable identifier (URL + KV)
//   label       human-readable
//   completion  async (env, g, u) -> bool, has the step been done?
// (Bolts economy sunset: the per-step `reward` bolt/pack payload has
// been removed. The checklist is now a pure progress tracker —
// completion + claimed state, no currency.)
export const STEPS = [
  {
    id:     'joined-discord',
    label:  'Join the Aquilo Discord',
    completion: async () => true,   // they're in the guild if they're calling
  },
  // (Patreon-link step removed 2026-07-01 — Patreon is retired in the
  // Twitch-native pivot. The markPatreonLinked mutator + PATREON_FLAG_KEY
  // are left in place so the site's legacy POST /web/quest/mark-patreon-
  // linked still 200s; it just no longer maps to a checklist step. A
  // Twitch-link step can slot in here when the identity work lands.)
  {
    id:     'first-checkin',
    label:  'Check in on aquilo.gg (aquilo.gg/checkin)',
    completion: async (env, g, u) => {
      const s = await getCheckinStatus(env, g, u);
      return (s.total || 0) > 0;
    },
  },
  {
    id:     'played-game',
    label:  'Play a game (any minigame, daily, or coinflip)',
    completion: async (env, g, u) => {
      // Explicit signal from a game route (markGamePlayed sets the
      // flag). (Bolts economy sunset: the former wallet lifetime-
      // earned/spent fallback is gone with the wallet module.)
      if (await env.LOADOUT_BOLTS.get(GAME_FLAG_KEY(g, u))) return true;
      return false;
    },
  },
  // Gift Supporter CTA removed from the onboarding checklist 2026-05-28
  // per Clay, too pushy as a first-session step. The gift link still
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
// Called by the corresponding milestone-firing call site. Idempotent, // re-setting a flag is harmless. Returns a structured result so the
// /web/quest/mark-patreon-linked route can surface whether the
// patreon:tier link was independently verified (useful debugging for
// the site).
export async function markPatreonLinked(env, guildId, userId) {
  await env.LOADOUT_BOLTS.put(PATREON_FLAG_KEY(guildId, userId), '1');
  // Best-effort patreon:tier verification, the actual link record is
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
  for (const step of STEPS) {
    const completed = await step.completion(env, guildId, userId).catch(() => false);
    const claim     = state.steps[step.id];
    const claimable = completed && !claim?.claimedUtc;
    out.push({
      id:          step.id,
      label:       step.label,
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
      // (Bolts economy sunset: bolt totals dropped; this is now a
      // simple checklist progress count.)
      total:         STEPS.length,
      completed:     out.filter(s => s.completed).length,
      claimed:       out.filter(s => s.claimed).length,
      pendingClaims: out.filter(s => s.claimable).length,
    },
  };
}

// ── Claim (check off) ───────────────────────────────────────────────────
// Idempotent, claiming an already-claimed step is a no-op (returns
// { ok: true, alreadyClaimed: true }). Claiming a step that hasn't
// been completed yet returns 400. `stepId` of 'all' checks off every
// available step in one call.
//
// (Bolts economy sunset: "claiming" no longer pays out bolts/packs —
// it just marks the step checked off so the checklist reflects
// claimed/unclaimed state.)
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

    state.steps[s.id] = {
      claimedUtc: Date.now(),
    };
    granted.push({ id: s.id, claimed: true });
  }
  await saveState(env, guildId, userId, state);

  return { ok: true, granted };
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
    lines.push(`${tick}  ${s.label}${s.claimable ? '  **← check off on aquilo.gg/quest**' : ''}`);
  }
  if (snap.summary.pendingClaims) {
    lines.push('');
    lines.push(`🎁  **${snap.summary.pendingClaims}** step${snap.summary.pendingClaims === 1 ? '' : 's'} ready to check off on https://aquilo.gg/quest`);
  } else if (snap.summary.claimed === snap.summary.total) {
    lines.push('');
    lines.push('🏁  Welcome Checklist complete, welcome to the community!');
  }
  return { type: 4, data: { content: lines.join('\n'), flags: 64 } };
}
