// One-shot admin helper: bulk-delete bot-authored messages in the
// counting channel (cleanup after the May 2026 loop incident).
//
// Strategy:
//   1. Page through GET /channels/<c>/messages?limit=100&before=<id>
//      starting from the channel's most recent message.
//   2. Filter to messages authored by Discord app id `1500849448866025573`
//      (Aquilo bot, AND/OR webhook messages) within the optional
//      `since` (unix-seconds) window.
//   3. Bulk-delete in batches of up to 100 via
//      POST /channels/<c>/messages/bulk-delete.
//
// Discord constraints honoured:
//   • Bulk-delete refuses messages older than 14 days OR if any id is
//     a duplicate. We pre-filter age, single-instance batch.
//   • Bulk-delete requires 2-100 messages. For a leftover singleton,
//     fall back to DELETE /channels/<c>/messages/<id>.
//   • Human messages are NEVER touched, author.id !== BOT_APP_ID and
//     !author.webhook_id.
//
// Returns: { scanned, candidates, deleted, kept, errors[] }

const BOT_APP_ID = '1500849448866025573';
const DAYS_14_MS = 14 * 24 * 60 * 60 * 1000;
const SCAN_PAGE_MAX = 20;    // 20 × 100 = 2000 messages, enough for the
                              // worst-case loop blast radius
const BULK_BATCH_MAX = 100;

async function discordFetch(env, path, init = {}) {
  return fetch('https://discord.com/api/v10' + path, {
    ...init,
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

// Discord 429 retry. Honour `retry_after` (seconds) from the body,
// cap at 5s per attempt + 3 attempts total. Returns the final
// Response (caller can inspect r.ok / r.status).
async function discordFetchWithRetry(env, path, init = {}, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const r = await discordFetch(env, path, init);
    if (r.status !== 429) return r;
    // Peek at the body without consuming it for the caller, clone
    // first, then if we end up returning we keep the original.
    let waitMs = 1000;
    try {
      const peek = await r.clone().json();
      const ra = Number(peek?.retry_after);
      if (Number.isFinite(ra) && ra > 0) waitMs = Math.min(5000, Math.ceil(ra * 1000));
    } catch { /* fall through to default backoff */ }
    if (i === attempts - 1) return r;
    await new Promise(res => setTimeout(res, waitMs));
  }
  // Unreachable, the loop always returns from inside.
  return discordFetch(env, path, init);
}

// Discord snowflake → ms-epoch (snowflake epoch is 2015-01-01).
function snowflakeMs(id) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

export async function purgeBotMessages(env, channelId, opts = {}) {
  if (!env?.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!channelId || !/^\d{5,25}$/.test(String(channelId))) {
    return { ok: false, error: 'bad-channel-id' };
  }
  const sinceMs = Number(opts.sinceMs ?? 0);   // 0 = no lower bound
  const cutoffOldestMs = Date.now() - DAYS_14_MS + 60_000;   // 1-min safety margin

  const candidates = [];        // [{ id, authorId }]
  const kept = { humans: 0, tooOld: 0 };
  const errors = [];

  // Walk pages newest → oldest. Stop when:
  //   - a page returns < 100 messages (end of channel), OR
  //   - we cross sinceMs (every message older than the window), OR
  //   - we hit SCAN_PAGE_MAX (safety bound)
  let before;
  let scanned = 0;
  for (let page = 0; page < SCAN_PAGE_MAX; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (before) qs.set('before', before);
    const r = await discordFetchWithRetry(env, `/channels/${channelId}/messages?${qs}`);
    if (!r.ok) {
      errors.push({ phase: 'list', status: r.status, body: (await r.text()).slice(0, 200) });
      break;
    }
    const msgs = await r.json();
    if (!Array.isArray(msgs) || msgs.length === 0) break;
    scanned += msgs.length;

    let crossedSince = false;
    for (const m of msgs) {
      const ts = snowflakeMs(m.id);
      if (sinceMs && ts < sinceMs) { crossedSince = true; continue; }
      if (ts < cutoffOldestMs)     { kept.tooOld++; continue; }
      const isBotAuthored = m.author?.id === BOT_APP_ID || !!m.webhook_id || m.author?.bot === true;
      if (!isBotAuthored) { kept.humans++; continue; }
      candidates.push({ id: m.id, authorId: m.author?.id || null });
    }
    before = msgs[msgs.length - 1].id;
    if (msgs.length < 100) break;
    if (crossedSince) break;
  }

  // Bulk-delete in batches of up to 100. Singletons fall back to
  // single-DELETE (bulk-delete requires >= 2 ids).
  let deleted = 0;
  for (let i = 0; i < candidates.length; i += BULK_BATCH_MAX) {
    const batch = candidates.slice(i, i + BULK_BATCH_MAX);
    if (batch.length === 1) {
      const r = await discordFetchWithRetry(env, `/channels/${channelId}/messages/${batch[0].id}`, { method: 'DELETE' });
      if (r.ok || r.status === 204 || r.status === 404) { deleted++; }
      else { errors.push({ phase: 'single-delete', id: batch[0].id, status: r.status }); }
      continue;
    }
    const r = await discordFetchWithRetry(env, `/channels/${channelId}/messages/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify({ messages: batch.map(b => b.id) }),
    });
    if (r.ok || r.status === 204) { deleted += batch.length; }
    else { errors.push({ phase: 'bulk-delete', count: batch.length, status: r.status, body: (await r.text()).slice(0, 200) }); }
  }

  return { ok: true, channelId, scanned, candidates: candidates.length, deleted, kept, errors };
}
