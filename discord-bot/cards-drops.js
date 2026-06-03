// Limited-time Boltbound card drops, MVP unblocking the site UI.
//
// 2026-05-29. Drop events are themed monthly runs (e.g. "Bone Reliquary
// drops Nov 2026"); a subset of cards is flagged as belonging to the
// event. During the window, pack openings get a multiplier-weighted
// chance to include those cards. After the window, the cards remain in
// players' collections but stop appearing in packs.
//
// KV layout:
//   drop-event:<eventId>     event JSON
//   drop-event-active        string eventId (single active at a time)
//   drop-event-history       { eventIds: [...] }
//
// Event JSON:
//   { id, name, theme, startsUtc, endsUtc, cardIds: [...],
//     multiplier: number, createdUtc, updatedUtc }
//
// Pack-roller integration is a separate diff in cards-packs.js, this
// module owns the event registry + activation + queries.

const KEY = {
  event:    (id) => `drop-event:${id}`,
  active:        'drop-event-active',
  history:       'drop-event-history',
};

function nowIso() { return new Date().toISOString(); }

async function readEvent(env, id) {
  if (!id) return null;
  return await env.LOADOUT_BOLTS.get(KEY.event(id), { type: 'json' });
}

async function readHistory(env) {
  const raw = await env.LOADOUT_BOLTS.get(KEY.history, { type: 'json' });
  return raw || { eventIds: [] };
}

async function writeHistory(env, hist) {
  await env.LOADOUT_BOLTS.put(KEY.history, JSON.stringify(hist));
}

export async function getActiveDrop(env) {
  const activeId = await env.LOADOUT_BOLTS.get(KEY.active);
  if (!activeId) return { ok: true, active: null };
  const event = await readEvent(env, activeId);
  if (!event) return { ok: true, active: null, stale: true };
  const nowMs = Date.now();
  const endsMs = Date.parse(event.endsUtc || '') || 0;
  if (endsMs && endsMs < nowMs) {
    // Event window passed, close it lazily on next active read.
    await env.LOADOUT_BOLTS.delete(KEY.active).catch(() => {});
    return { ok: true, active: null, justClosed: event.id };
  }
  return {
    ok: true,
    active: event,
    remainingMs: Math.max(0, endsMs - nowMs),
  };
}

export async function getUpcomingDrops(env, opts = {}) {
  const limit = Math.max(1, Math.min(10, parseInt(opts.limit, 10) || 3));
  const hist = await readHistory(env);
  const nowMs = Date.now();
  const upcoming = [];
  for (const id of (hist.eventIds || [])) {
    const ev = await readEvent(env, id);
    if (!ev) continue;
    const startsMs = Date.parse(ev.startsUtc || '') || 0;
    if (startsMs > nowMs) upcoming.push(ev);
    if (upcoming.length >= limit) break;
  }
  upcoming.sort((a, b) => (Date.parse(a.startsUtc) || 0) - (Date.parse(b.startsUtc) || 0));
  return { ok: true, upcoming };
}

export async function createDropEvent(env, opts = {}) {
  const id    = String(opts.eventId || '').trim();
  const name  = String(opts.name    || '').trim();
  const theme = String(opts.theme   || '').trim();
  if (!id || !name) return { ok: false, error: 'missing-fields' };
  if (await readEvent(env, id)) {
    return { ok: false, error: 'event-exists' };
  }
  const cardIds = Array.isArray(opts.cardIds) ? opts.cardIds.filter(Boolean).map(String) : [];
  const event = {
    id, name, theme,
    startsUtc: opts.startsUtc || nowIso(),
    endsUtc:   opts.endsUtc   || new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    cardIds,
    multiplier: Math.max(1, Math.min(10, Number(opts.multiplier) || 2.5)),
    createdUtc: nowIso(), updatedUtc: nowIso(),
  };
  await env.LOADOUT_BOLTS.put(KEY.event(id), JSON.stringify(event));
  const hist = await readHistory(env);
  if (!hist.eventIds.includes(id)) {
    hist.eventIds.unshift(id);
    await writeHistory(env, hist);
  }
  // If startsUtc is in the past + no active event, activate now.
  const nowMs = Date.now();
  const startsMs = Date.parse(event.startsUtc) || 0;
  const endsMs   = Date.parse(event.endsUtc)   || 0;
  if (startsMs <= nowMs && (!endsMs || endsMs > nowMs)) {
    const cur = await env.LOADOUT_BOLTS.get(KEY.active);
    if (!cur) await env.LOADOUT_BOLTS.put(KEY.active, id);
  }
  return { ok: true, event };
}

export async function endCurrentDrop(env) {
  const cur = await env.LOADOUT_BOLTS.get(KEY.active);
  if (!cur) return { ok: true, ended: null };
  await env.LOADOUT_BOLTS.delete(KEY.active);
  return { ok: true, ended: cur };
}

// Helper: returns the active event's multiplier + cardIds set or null.
// Pack-roller will call this each pack open to apply the weight bump.
export async function getActiveDropWeights(env) {
  const cur = await getActiveDrop(env);
  if (!cur.active) return null;
  return {
    eventId:    cur.active.id,
    multiplier: cur.active.multiplier,
    cardIds:    new Set(cur.active.cardIds || []),
  };
}

// Cron tick, close any active event whose window has passed + activate
// the next eligible upcoming event. Called from the monthly cron.
export async function rotateActiveDrop(env) {
  const cur = await getActiveDrop(env);    // side-effect: lazy-closes stale
  if (cur.active) return { ok: true, kept: cur.active.id };

  const hist = await readHistory(env);
  const nowMs = Date.now();
  let nextId = null;
  for (const id of (hist.eventIds || [])) {
    const ev = await readEvent(env, id);
    if (!ev) continue;
    const startsMs = Date.parse(ev.startsUtc) || 0;
    const endsMs   = Date.parse(ev.endsUtc)   || 0;
    if (startsMs <= nowMs && endsMs > nowMs) {
      nextId = id;
      break;
    }
  }
  if (nextId) {
    await env.LOADOUT_BOLTS.put(KEY.active, nextId);
    return { ok: true, activated: nextId };
  }
  return { ok: true, activated: null };
}
