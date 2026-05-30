// Twitch Drops — watch-time accrual + milestone rewards for
// Twitch-linked aquilo viewers while Clay is live.
//
// Concept (Clay 2026-05-30 spec):
//   • Every 5 minutes while the broadcaster is live, every linked
//     viewer earns +5 cumulative watch-minutes. (MVP fallback: we
//     credit every linked viewer regardless of "actively watching"
//     since the Helix chatters endpoint isn't wired in yet.)
//   • Milestones at 15 / 30 / 60 / 120 cumulative minutes unlock a
//     reward (bolts or a pack). Unlocks are auto-detected at tick
//     time; viewers claim each unlocked milestone manually so the
//     web UI gets to show a "claim" affordance with a nice toast.
//   • Cumulative minutes never reset — milestones are lifetime, not
//     per-stream. A drop-in viewer who racks up watch-time across
//     many sessions can claim each tier exactly once.
//
// Linkage source: the Twitch-link OAuth flow already writes the
// reverse index `plink:twitch:<twitchUserId>` → aquilo Discord ID
// (see twitch-rewards.js). We walk that prefix to find every linked
// viewer. There's no forward index from aquilo→twitch in KV, so the
// reverse prefix is the canonical "who's linked" list.
//
// KV layout:
//   twitch-drops:<aquiloUserId> = {
//     watchMinutes: int,           // lifetime cumulative
//     unlocked:     [int, ...],    // milestone minute-marks crossed
//                                  //   but not yet claimed (auto-set
//                                  //   by the tick when crossing)
//     claimed:      [int, ...],    // milestones claim() has paid out
//     lastTickUtc:  int,           // ms; per-user dedup so a flapping
//                                  //   cron can't double-credit
//   }
//
// Live-state probe is shared with stream-bonus.js (isStreamLive) so
// the two modules see the same "is Clay live" answer. Reward grant
// flows through wallet.earn (bolts) + cards-packs.creditPack (packs)
// — both go through the existing economy pipeline so booster
// multipliers + lifetime stats apply identically to other grants.

import { isStreamLive } from './stream-bonus.js';

// ── Milestones ────────────────────────────────────────────────────
//
// Frozen so callers (incl. the web embed) can use Object.freeze
// reference equality + can't accidentally mutate the ladder.
// Map of "pack-bronze" / "pack-gold" → existing cards-packs.js pack
// type names. The spec uses bronze/gold semantically; common/epic are
// the catalogue rows those land on.

export const MILESTONES = Object.freeze([
  Object.freeze({ minutes:  15, reward: Object.freeze({ bolts: 50 }) }),
  Object.freeze({ minutes:  30, reward: Object.freeze({ packId: 'pack-bronze' }) }),
  Object.freeze({ minutes:  60, reward: Object.freeze({ bolts: 500 }) }),
  Object.freeze({ minutes: 120, reward: Object.freeze({ packId: 'pack-gold' }) }),
]);

// Map the spec's packId names → cards-packs.js pack types. Keeping
// the indirection so future tiers ("pack-platinum" → "voltaic") can
// be added without changing MILESTONES' wire shape.
const PACK_ID_TO_TYPE = Object.freeze({
  'pack-bronze':   'common',
  'pack-gold':     'epic',
  'pack-silver':   'rare',
  'pack-platinum': 'voltaic',
});

// How many cumulative minutes each tick credits. Five minutes ==
// the boltRain cadence in worker.js — both fire on mm % 5 === 0.
const MINUTES_PER_TICK = 5;

// Per-user dedup window — re-running the tick within this window is
// a no-op for that user. Slightly under one MINUTES_PER_TICK interval
// so a slightly-late tick still credits, but a back-to-back retry
// inside the same minute doesn't double-pay.
const TICK_DEDUP_MS = (MINUTES_PER_TICK * 60 - 30) * 1000;

const KV_KEY = (userId) => `twitch-drops:${userId}`;
const LINK_PREFIX = 'plink:twitch:';

// ── State accessors ───────────────────────────────────────────────

function freshState() {
  return { watchMinutes: 0, unlocked: [], claimed: [], lastTickUtc: 0 };
}

function normalizeState(raw) {
  const s = { ...freshState(), ...(raw || {}) };
  // Defensive coercion — KV round-trips drop types if a write was
  // ever truncated; this guarantees the rest of the module sees
  // arrays + integers exactly.
  s.watchMinutes = Math.max(0, Math.floor(Number(s.watchMinutes) || 0));
  s.unlocked     = Array.isArray(s.unlocked) ? s.unlocked.map(Number).filter(Number.isFinite) : [];
  s.claimed      = Array.isArray(s.claimed)  ? s.claimed.map(Number).filter(Number.isFinite)  : [];
  s.lastTickUtc  = Math.max(0, Number(s.lastTickUtc) || 0);
  return s;
}

async function readState(env, userId) {
  if (!userId) return freshState();
  try {
    const raw = await env.LOADOUT_BOLTS.get(KV_KEY(userId), { type: 'json' });
    return normalizeState(raw);
  } catch { return freshState(); }
}

async function writeState(env, userId, state) {
  await env.LOADOUT_BOLTS.put(KV_KEY(userId), JSON.stringify(state));
}

// Public read — adds derived `milestonesUnlocked` + `milestonesClaimed`
// names alongside the raw arrays so the web embed has both shapes
// (the test contract uses milestonesUnlocked/Claimed; KV stores
// unlocked/claimed to keep the on-disk record terse).
export async function getDropsState(env, userId) {
  const s = await readState(env, userId);
  return {
    watchMinutes:        s.watchMinutes,
    milestonesUnlocked:  s.unlocked.slice().sort((a, b) => a - b),
    milestonesClaimed:   s.claimed.slice().sort((a, b) => a - b),
    lastTickUtc:         s.lastTickUtc,
  };
}

// ── Milestone crossing detection ──────────────────────────────────
//
// Given an old + new cumulative-minutes value, returns the milestone
// minute-marks that were crossed in this tick (i.e. that should be
// added to `unlocked` if not already in `unlocked` or `claimed`).

function newlyCrossedMilestones(oldMin, newMin) {
  const out = [];
  for (const m of MILESTONES) {
    if (oldMin < m.minutes && newMin >= m.minutes) out.push(m.minutes);
  }
  return out;
}

// ── Linked-viewer enumeration ─────────────────────────────────────
//
// Walks the `plink:twitch:` KV prefix to get the list of aquilo
// userIds that have a Twitch link. The KV values are aquilo user
// IDs (twitch-rewards.js reads them as 'text'). We paginate up to
// 6 pages (CF KV cap is 1000/page → 6k linked viewers fits easily
// in the free tier of a per-minute cron).

async function listLinkedAquiloIds(env) {
  let cursor;
  const out = [];
  for (let i = 0; i < 6; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: LINK_PREFIX, cursor, limit: 1000,
    });
    for (const k of (page.keys || [])) {
      try {
        const aquiloId = await env.LOADOUT_BOLTS.get(k.name, { type: 'text' });
        if (aquiloId) out.push(String(aquiloId));
      } catch { /* skip unreadable */ }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  // Dedup — a viewer could in theory have multiple Twitch links
  // (account migration etc); we only want to credit them once.
  return Array.from(new Set(out));
}

// ── Per-tick accrual ──────────────────────────────────────────────
//
// Called from the per-minute cron in worker.js, gated to fire every
// 5 minutes (mm % 5 === 0). No-ops cleanly when the streamer isn't
// live. Returns { ok, credited, crossings, skipped? } so the cron
// log can show the watch-time fan-out summary.

export async function watchTimeTickCron(env, opts = {}) {
  const live = await isStreamLive(env);
  if (!live.live) return { ok: true, skipped: 'not-live' };

  const minutesPerTick = Math.max(1,
    Number.isFinite(opts.minutesPerTick) ? opts.minutesPerTick : MINUTES_PER_TICK);
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  const linked = await listLinkedAquiloIds(env);
  if (!linked.length) return { ok: true, credited: 0, crossings: 0, walkedUsers: 0 };

  let credited = 0, crossings = 0, walkedUsers = 0, skippedDedup = 0;
  for (const userId of linked) {
    walkedUsers++;
    try {
      const s = await readState(env, userId);
      // Per-user dedup — if the last tick was very recent (cron
      // retry / overlap), skip this user. Stays per-user so a fresh
      // linker mid-window still gets their first credit.
      if (s.lastTickUtc && (now - s.lastTickUtc) < TICK_DEDUP_MS) {
        skippedDedup++; continue;
      }
      const oldMin = s.watchMinutes;
      s.watchMinutes = oldMin + minutesPerTick;
      s.lastTickUtc  = now;
      const crossed = newlyCrossedMilestones(oldMin, s.watchMinutes);
      for (const m of crossed) {
        // Only mark "unlocked" if not already claimed. (A re-tick
        // shouldn't add it back to unlocked once claim() has paid.)
        if (!s.claimed.includes(m) && !s.unlocked.includes(m)) {
          s.unlocked.push(m);
          crossings++;
        }
      }
      await writeState(env, userId, s);
      credited += minutesPerTick;
    } catch { /* per-user swallow */ }
  }
  return { ok: true, credited, crossings, walkedUsers, skippedDedup };
}

// ── Claim flow ────────────────────────────────────────────────────
//
// Idempotent: claiming an already-claimed milestone returns
// { ok: false, reason: 'already-claimed' }. Claiming a milestone the
// viewer hasn't crossed yet returns { ok: false, reason: 'locked' }.
// Otherwise grants the reward and atomically flips unlocked→claimed.
//
// Grant routes:
//   reward.bolts  → wallet.earn(env, vaultGuildId, userId, bolts, reason)
//   reward.packId → cards-packs.creditPack(env, vaultGuildId, userId,
//                                          packType, reason)
// Test seams: opts.walletModule / opts.packsModule let the test
// harness short-circuit the real imports without monkey-patching.

export async function claimDropMilestone(env, userId, minutes, opts = {}) {
  if (!userId)  return { ok: false, reason: 'bad-args' };
  const m = Number(minutes);
  if (!Number.isFinite(m)) return { ok: false, reason: 'bad-args' };
  const milestone = MILESTONES.find(x => x.minutes === m);
  if (!milestone) return { ok: false, reason: 'unknown-milestone' };

  const s = await readState(env, userId);
  if (s.claimed.includes(m)) return { ok: false, reason: 'already-claimed' };
  if (!s.unlocked.includes(m) && s.watchMinutes < m) {
    return { ok: false, reason: 'locked', watchMinutes: s.watchMinutes, required: m };
  }

  // Move unlocked→claimed BEFORE the grant so a concurrent claim
  // racing the same milestone hits the already-claimed branch.
  // (KV doesn't have CAS — this is the best we can do, and mirrors
  // daily-quests' claim-flag-first pattern.)
  s.unlocked = s.unlocked.filter(x => x !== m);
  if (!s.claimed.includes(m)) s.claimed.push(m);
  await writeState(env, userId, s);

  const guildId = opts.guildId || env.AQUILO_VAULT_GUILD_ID;
  const granted = { ...milestone.reward };
  const reason  = `twitch-drops:${m}m`;
  if (milestone.reward.bolts && guildId) {
    try {
      const wallet = opts.walletModule || (await import('./wallet.js'));
      await wallet.earn(env, guildId, userId, milestone.reward.bolts, reason);
    } catch (e) {
      granted.walletError = e?.message || String(e);
    }
  }
  if (milestone.reward.packId && guildId) {
    const packType = PACK_ID_TO_TYPE[milestone.reward.packId] || milestone.reward.packId;
    try {
      const packs = opts.packsModule || (await import('./cards-packs.js'));
      const r = await packs.creditPack(env, guildId, userId, packType, reason);
      if (r && r.ok === false) granted.packError = r.error || 'pack-credit-failed';
      else granted.pack = r?.pack || null;
    } catch (e) {
      granted.packError = e?.message || String(e);
    }
  }
  return { ok: true, milestone: m, granted };
}

// ── HTTP route handler ────────────────────────────────────────────
//
// Mirrors the daily-quests / friends pattern.
//
//   GET  /web/twitch-drops/me?userId=<id>   public read
//   POST /web/twitch-drops/claim            HMAC-gated:
//     body: { userId, minutes }

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

async function _gateHmac(req, env) {
  const { verifyHmac } = await import('./auth.js');
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return { ok: false, status: 503, error: 'AQUILO_SITE_WEB_SECRET missing' };
  }
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const ts  = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok  = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'unauthorized' };
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch { return { ok: false, status: 400, error: 'bad-json' }; }
  }
  return { ok: true, body };
}

export async function handleDropsRoute(req, env, path) {
  // GET /web/twitch-drops/me?userId=<id> — public, no HMAC. (The
  // viewer's own watch state is non-sensitive — mirrors how friends
  // GET is public.)
  if (req.method === 'GET' && path === '/web/twitch-drops/me') {
    const url = new URL(req.url);
    const userId = (url.searchParams.get('userId') || '').trim();
    if (!userId) return _json({ error: 'userId required' }, 400);
    const state = await getDropsState(env, userId);
    return _json({
      userId,
      ...state,
      milestones: MILESTONES.map(x => ({ minutes: x.minutes, reward: x.reward })),
    });
  }
  if (req.method === 'POST' && path === '/web/twitch-drops/claim') {
    const gate = await _gateHmac(req, env);
    if (!gate.ok) return _json({ error: gate.error }, gate.status);
    const b = gate.body || {};
    const userId  = String(b.userId || '').trim();
    const minutes = Number(b.minutes);
    if (!userId)            return _json({ error: 'userId required' }, 400);
    if (!Number.isFinite(minutes)) return _json({ error: 'minutes required' }, 400);
    const r = await claimDropMilestone(env, userId, minutes);
    return _json(r, r.ok ? 200 : 400);
  }
  return _json({ error: 'unknown-op' }, 404);
}

// Test-only — lets the harness reach internals (listLinkedAquiloIds,
// newlyCrossedMilestones) without exporting them publicly.
export const __internals = {
  listLinkedAquiloIds,
  newlyCrossedMilestones,
  normalizeState,
  freshState,
  PACK_ID_TO_TYPE,
  MINUTES_PER_TICK,
};
