// Scheduled Discord messages, admin-authored, fired by the :23
// hourly cron tick. The aquilo-site /admin UI calls these four
// HMAC-gated admin routes; the worker owns persistence + delivery.
//
// KV layout:
//   sched-msg:item:<guildId>:<id>      JSON record (see SCHEMA below)
//   sched-msg:due:<guildId>:<dueUtc>:<id>   sorted due-time index
//                                            (key sort = chronological,
//                                            since dueUtc is zero-
//                                            padded epoch-ms)
//   sched-msg:status:<guildId>:<status>:<dueUtc>:<id>
//                                            secondary index for the
//                                            list endpoint (status =
//                                            pending | sent | cancelled
//                                            | failed)
//
// Record schema:
//   {
//     id:           <opaque hex>,
//     channelId:    '<snowflake>',
//     scheduledUtc: <ms-epoch>,
//     content:      <string|''>,
//     embeds:       <array|undefined>,
//     components:   <array|undefined>,
//     status:       'pending' | 'sent' | 'cancelled' | 'failed',
//     createdAt:    <ms-epoch>,
//     createdBy:    <string, opaque to us, e.g. site session id>,
//     sentMsgId:    <snowflake|null>,
//     sentAt:       <ms-epoch|null>,
//     error:        <string|null>,    // populated on failure
//     attempts:     <int>,            // retry counter
//   }

const ITEM_KEY    = (g, id) => `sched-msg:item:${g}:${id}`;
const DUE_KEY     = (g, dueUtc, id) => `sched-msg:due:${g}:${padDue(dueUtc)}:${id}`;
const STATUS_KEY  = (g, status, dueUtc, id) => `sched-msg:status:${g}:${status}:${padDue(dueUtc)}:${id}`;
const STATUSES = new Set(['pending', 'sent', 'cancelled', 'failed']);

const MAX_ATTEMPTS = 2;   // initial send + 1 retry
const LIST_PAGE_DEFAULT = 50;

// 16-digit zero-padded ms-epoch, enough for ~5138 AD, so the
// lex-sort matches the numeric sort comfortably.
function padDue(ms) {
  return String(Math.max(0, Math.floor(Number(ms) || 0))).padStart(16, '0');
}

function newId() {
  // 8-byte random hex, collision-resistant for the volume we
  // expect (the admin UI creates one at a time, manually).
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Validation ────────────────────────────────────────────────────

// `now` injectable for tests so we can check "is in the future"
// against a known clock.
export function validateCreate(input, now = Date.now()) {
  const out = { ok: true, errors: [] };
  const channelId = String(input?.channelId || '').trim();
  if (!/^\d{5,25}$/.test(channelId)) { out.ok = false; out.errors.push('bad-channel-id'); }

  const scheduledUtc = Number(input?.scheduledUtc);
  if (!Number.isFinite(scheduledUtc) || scheduledUtc <= 0) {
    out.ok = false; out.errors.push('bad-scheduledUtc');
  } else if (scheduledUtc <= now) {
    out.ok = false; out.errors.push('scheduledUtc-must-be-in-future');
  }

  const content = typeof input?.content === 'string' ? input.content : '';
  const hasEmbeds = Array.isArray(input?.embeds) && input.embeds.length > 0;
  if (!content.trim() && !hasEmbeds) {
    out.ok = false; out.errors.push('content-or-embeds-required');
  }
  if (content.length > 2000) { out.ok = false; out.errors.push('content-too-long'); }

  return out;
}

// ── Public: create ────────────────────────────────────────────────

export async function createScheduled(env, guildId, input, createdBy) {
  const v = validateCreate(input);
  if (!v.ok) return { ok: false, error: 'validation', errors: v.errors };
  const id = newId();
  const now = Date.now();
  const rec = {
    id,
    channelId:    String(input.channelId).trim(),
    scheduledUtc: Math.floor(Number(input.scheduledUtc)),
    content:      typeof input.content === 'string' ? input.content : '',
    embeds:       Array.isArray(input.embeds) ? input.embeds : undefined,
    components:   Array.isArray(input.components) ? input.components : undefined,
    status:       'pending',
    createdAt:    now,
    createdBy:    createdBy || null,
    sentMsgId:    null,
    sentAt:       null,
    error:        null,
    attempts:     0,
  };
  await persistRecord(env, guildId, rec, /*prevStatus*/ null);
  return { ok: true, id, scheduledUtc: rec.scheduledUtc };
}

// ── Public: list ──────────────────────────────────────────────────
//
// Returns upcoming pending + the most recent N of each terminal
// status (sent / failed / cancelled). Caller passes a `limit` to
// cap each bucket; default 50.

export async function listScheduled(env, guildId, limit = LIST_PAGE_DEFAULT) {
  const lim = Math.max(1, Math.min(200, Number(limit) || LIST_PAGE_DEFAULT));
  const pending   = await listByStatus(env, guildId, 'pending',   lim);
  const sent      = await listByStatus(env, guildId, 'sent',      lim);
  const failed    = await listByStatus(env, guildId, 'failed',    lim);
  const cancelled = await listByStatus(env, guildId, 'cancelled', lim);
  // Pending: sorted by scheduledUtc ASC (next-up first).
  pending.sort((a, b) => a.scheduledUtc - b.scheduledUtc);
  // Terminal: DESC by sentAt/scheduledUtc (most recent first).
  const sortDesc = (a, b) => (b.sentAt || b.scheduledUtc || 0) - (a.sentAt || a.scheduledUtc || 0);
  sent.sort(sortDesc); failed.sort(sortDesc); cancelled.sort(sortDesc);
  return {
    ok: true,
    pending,
    sent,
    failed,
    cancelled,
  };
}

async function listByStatus(env, guildId, status, limit) {
  const prefix = `sched-msg:status:${guildId}:${status}:`;
  const out = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: Math.min(1000, limit * 2) });
    for (const k of r.keys) {
      // Status-index keys end in `:<dueUtc>:<id>`. Fetch the canonical item record.
      const tail = k.name.slice(prefix.length);
      const id = tail.split(':')[1];
      if (!id) continue;
      const rec = await env.LOADOUT_BOLTS.get(ITEM_KEY(guildId, id), { type: 'json' });
      if (rec) out.push(rec);
      if (out.length >= limit) return out;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return out;
}

// ── Public: get one ──────────────────────────────────────────────

export async function getScheduled(env, guildId, id) {
  if (!id) return null;
  return env.LOADOUT_BOLTS.get(ITEM_KEY(guildId, id), { type: 'json' });
}

// ── Public: cancel ───────────────────────────────────────────────

export async function cancelScheduled(env, guildId, id) {
  const rec = await getScheduled(env, guildId, id);
  if (!rec) return { ok: false, error: 'not-found' };
  if (rec.status === 'sent') return { ok: false, error: 'already-sent' };
  if (rec.status === 'cancelled') return { ok: true, alreadyCancelled: true, item: rec };
  const prev = rec.status;
  rec.status = 'cancelled';
  await persistRecord(env, guildId, rec, prev);
  return { ok: true, item: rec };
}

// ── Public: edit ─────────────────────────────────────────────────
//
// Allowed fields: scheduledUtc, content, embeds, components. Status
// stays whatever it was (must be 'pending' to allow edit at all).
// scheduledUtc must still be in the future if changed.

export async function editScheduled(env, guildId, id, patch) {
  const rec = await getScheduled(env, guildId, id);
  if (!rec) return { ok: false, error: 'not-found' };
  if (rec.status !== 'pending') return { ok: false, error: 'not-pending', status: rec.status };

  const prevScheduledUtc = rec.scheduledUtc;
  const proposed = { ...rec };
  if (patch.scheduledUtc != null) {
    const n = Number(patch.scheduledUtc);
    if (!Number.isFinite(n) || n <= Date.now()) {
      return { ok: false, error: 'bad-scheduledUtc' };
    }
    proposed.scheduledUtc = Math.floor(n);
  }
  if (patch.content != null) {
    if (typeof patch.content !== 'string' || patch.content.length > 2000) {
      return { ok: false, error: 'bad-content' };
    }
    proposed.content = patch.content;
  }
  if (patch.embeds != null) {
    if (!Array.isArray(patch.embeds)) return { ok: false, error: 'bad-embeds' };
    proposed.embeds = patch.embeds;
  }
  if (patch.components != null) {
    if (!Array.isArray(patch.components)) return { ok: false, error: 'bad-components' };
    proposed.components = patch.components;
  }
  const hasContent = proposed.content && proposed.content.trim();
  const hasEmbeds  = Array.isArray(proposed.embeds) && proposed.embeds.length > 0;
  if (!hasContent && !hasEmbeds) return { ok: false, error: 'content-or-embeds-required' };

  // Rewrite the due-time index if scheduledUtc changed; status
  // index doesn't move (still pending).
  if (proposed.scheduledUtc !== prevScheduledUtc) {
    await env.LOADOUT_BOLTS.delete(DUE_KEY(guildId, prevScheduledUtc, rec.id));
  }
  await persistRecord(env, guildId, proposed, /*prevStatus*/ rec.status === proposed.status ? null : rec.status);
  return { ok: true, item: proposed };
}

// ── Cron: scan + send due messages ────────────────────────────────
//
// Called from the :23 hourly tick. Walks the due-time index for
// every keyspace prefix matching `sched-msg:due:<guildId>:` and
// fires anything whose padded-due-time is ≤ now.
//
// At-most-once for the happy path (record moved to status:'sent'),
// at-most-twice for transient failures (one retry, then 'failed').

export async function processDueMessages(env, guildId, opts = {}) {
  const now = Date.now();
  const prefix = `sched-msg:due:${guildId}:`;
  const cutoff = padDue(now);
  let cursor;
  let processed = 0;
  let sent = 0;
  let failed = 0;
  for (let page = 0; page < 5; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys) {
      // Stop walking past the cutoff, list order is lex, padded
      // due-time sorts ascending, so first key past the cutoff
      // means no due items remain in this page.
      const tail = k.name.slice(prefix.length);
      const colonAt = tail.indexOf(':');
      const dueStr = colonAt >= 0 ? tail.slice(0, colonAt) : tail;
      if (dueStr > cutoff) { return finishStats(processed, sent, failed); }
      const id = tail.slice(colonAt + 1);
      const rec = await getScheduled(env, guildId, id);
      if (!rec) {
        // Index entry without an item, sweep it.
        await env.LOADOUT_BOLTS.delete(k.name);
        continue;
      }
      if (rec.status !== 'pending') {
        // Stale due-index entry (cancelled / sent). Sweep.
        await env.LOADOUT_BOLTS.delete(k.name);
        continue;
      }
      processed += 1;
      const r2 = await sendOne(env, guildId, rec);
      if (r2.ok) sent += 1; else failed += 1;
      if (opts.maxPerTick && processed >= opts.maxPerTick) {
        return finishStats(processed, sent, failed);
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return finishStats(processed, sent, failed);
}

function finishStats(processed, sent, failed) {
  return { ok: true, processed, sent, failed };
}

async function sendOne(env, guildId, rec) {
  rec.attempts = (rec.attempts || 0) + 1;
  if (!env.DISCORD_BOT_TOKEN) {
    rec.status = 'failed';
    rec.error = 'no-bot-token';
    await persistRecord(env, guildId, rec, 'pending');
    return { ok: false, error: 'no-bot-token' };
  }
  const payload = { allowed_mentions: { parse: [] } };
  if (rec.content) payload.content = rec.content;
  if (rec.embeds) payload.embeds = rec.embeds;
  if (rec.components) payload.components = rec.components;
  const r = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(rec.channelId)}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent':   'loadout-discord scheduled-messages',
      },
      body: JSON.stringify(payload),
    },
  );
  if (r.ok) {
    const j = await r.json();
    rec.status = 'sent';
    rec.sentMsgId = String(j.id);
    rec.sentAt = Date.now();
    rec.error = null;
    await persistRecord(env, guildId, rec, 'pending');
    return { ok: true, messageId: rec.sentMsgId };
  }
  const txt = await r.text();
  if (rec.attempts < MAX_ATTEMPTS) {
    // Retry once on the next cron tick by leaving status pending.
    // Don't move the due index, it stays in place for the next pass.
    rec.error = 'attempt-' + rec.attempts + ': http-' + r.status + ' ' + txt.slice(0, 120);
    await persistRecord(env, guildId, rec, null);
    return { ok: false, retry: true, status: r.status };
  }
  rec.status = 'failed';
  rec.error  = 'http-' + r.status + ' ' + txt.slice(0, 200);
  await persistRecord(env, guildId, rec, 'pending');
  return { ok: false, error: 'failed', status: r.status };
}

// ── Persistence helper ───────────────────────────────────────────
//
// Writes the canonical item record + manages the secondary indexes
// (due-time + status). `prevStatus` is the status BEFORE the change
//, null when the status didn't change OR this is a new record.

async function persistRecord(env, guildId, rec, prevStatus) {
  await env.LOADOUT_BOLTS.put(ITEM_KEY(guildId, rec.id), JSON.stringify(rec));
  // Due-time index, present only while pending.
  if (rec.status === 'pending') {
    await env.LOADOUT_BOLTS.put(DUE_KEY(guildId, rec.scheduledUtc, rec.id), rec.id);
  } else {
    // Sweep the due index entry on any terminal transition.
    await env.LOADOUT_BOLTS.delete(DUE_KEY(guildId, rec.scheduledUtc, rec.id));
  }
  // Status index, refresh.
  if (prevStatus && STATUSES.has(prevStatus) && prevStatus !== rec.status) {
    await env.LOADOUT_BOLTS.delete(STATUS_KEY(guildId, prevStatus, rec.scheduledUtc, rec.id));
  }
  if (STATUSES.has(rec.status)) {
    await env.LOADOUT_BOLTS.put(STATUS_KEY(guildId, rec.status, rec.scheduledUtc, rec.id), rec.id);
  }
}

// Exposed for tests.
export {
  newId       as _newIdForTest,
  padDue      as _padDueForTest,
};
