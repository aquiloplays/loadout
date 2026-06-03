// One-shot guild message cleanup + menu-channel permission lockdown.
//
// Clay's 2026-06-02 directive. Destructive, so every cleanable channel is
// SNAPSHOTTED to KV (90-day TTL) BEFORE any delete; if the snapshot write
// fails the channel is skipped (never delete what cannot be archived).
//
// Architecture: the worker route drives ONE channel (or thread) per call so
// each request stays well under the subrequest budget and the whole run is
// re-runnable / idempotent (already-cleaned channels report 0 to delete).
// The local driver (tools/discord-cleanup-run.mjs) walks the plan and loops.
//
// Exposes:
//   planCleanup(env, guildId)                  -> classify every channel
//   cleanChannel(env, channelId, opts)         -> snapshot + delete one channel/thread
//   lockdownMenuChannel(env, guildId, chId, b) -> deny @everyone send, allow bots
//   verifyChannel(env, channelId)              -> sample remaining (post-clean check)
//   verifyLock(env, guildId, channelId)        -> resolve @everyone overwrite
//   readArchive(env, runId, channelId)         -> decode an archive entry

// ── Identities ────────────────────────────────────────────────────────
// Loadout bot user id from the directive. The worker's own posting identity
// is env.DISCORD_APP_ID (1500849448866025573). We treat BOTH as "the bot"
// for pin-detection and as send-allowed in the lockdown, so menus keep
// working regardless of which identity actually posted them.
const LOADOUT_BOT_USER_ID = '1107161695262085210';

// Channels Clay named explicitly as menu channels (never clean; lock perms).
const EXPLICIT_MENU_CHANNEL_IDS = new Set([
  '1507973902146732222',   // Clay's explicit example
  '1507973935973531808',   // Loadout games menu hub
  '1509619945322057758',   // Patreon gift link channel
  '1507973920282640485',   // Schedule pinned embed channel
]);

// Worker-tracked edit-in-place hub channels (schedule/poll/queue/vote/
// roster). The worker stores each hub's message id in KV and edits it in
// place; deleting the embed would 404 the next edit. Sourced from
// wrangler.toml (POLL/QUEUE_CHANNEL_ID) + the locked-in ids in memory
// (vote-hub, poll, cn-games roster). Preserved but NOT force-locked —
// some (suggestions, lfg) are channels members are meant to post in.
const KNOWN_BOT_HUB_IDS = new Set([
  '1507973910107389952',   // suggestions  (POLL_CHANNEL_ID)
  '1507973931372646490',   // lfg          (QUEUE_CHANNEL_ID)
  '1508318929855184987',   // voting       (vote-hub)
  '1508318930845044786',   // cn-queue     (poll/queue hub)
  '1509201629482713158',   // cn-games     (cn-games-list roster hub)
]);

// Welcome / rules / info / announcement channels: preserved (NOT locked —
// they are typically already configured; we only avoid deleting from them).
const PROTECT_NAME_RE =
  /(announce|rule|info|welcome|onboard|start.?here|read.?me|getting.?started|verify)/i;

// Discord channel types.
const T_TEXT = 0, T_DM = 1, T_VOICE = 2, T_CATEGORY = 4, T_ANNOUNCEMENT = 5,
      T_ANNOUNCEMENT_THREAD = 10, T_PUBLIC_THREAD = 11, T_PRIVATE_THREAD = 12,
      T_STAGE = 13, T_FORUM = 15, T_MEDIA = 16;
const TEXTLIKE = new Set([T_TEXT, T_ANNOUNCEMENT]);
const THREADLIKE = new Set([T_ANNOUNCEMENT_THREAD, T_PUBLIC_THREAD, T_PRIVATE_THREAD]);
const FORUMLIKE = new Set([T_FORUM, T_MEDIA]);

// Permission bits.
const SEND_MESSAGES = 1n << 11n;             // 0x800
const SEND_MESSAGES_IN_THREADS = 1n << 38n;  // 0x4000000000
const SEND_DENY = (SEND_MESSAGES | SEND_MESSAGES_IN_THREADS).toString(); // '274877908992'

const DAYS_14_MS = 14 * 24 * 60 * 60 * 1000;
const ARCHIVE_TTL_SEC = 90 * 24 * 60 * 60;   // 90 days
const SCAN_PAGE_MAX = 200;                   // 200 * 100 = 20k messages/channel cap
const ARCHIVE_CHUNK = 1500;                  // messages per KV archive part
const BULK_BATCH_MAX = 100;
const FORUM_CUTOFF_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;

function discordFetch(env, path, init = {}) {
  return fetch('https://discord.com/api/v10' + path, {
    ...init,
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

// 429-aware fetch. Honour retry_after (seconds), cap 5s/attempt, 4 attempts.
async function dfetch(env, path, init = {}, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const r = await discordFetch(env, path, init);
    if (r.status !== 429) return r;
    let waitMs = 1000;
    try {
      const peek = await r.clone().json();
      const ra = Number(peek?.retry_after);
      if (Number.isFinite(ra) && ra > 0) waitMs = Math.min(5000, Math.ceil(ra * 1000));
    } catch { /* default backoff */ }
    if (i === attempts - 1) return r;
    await new Promise(res => setTimeout(res, waitMs));
  }
  return discordFetch(env, path, init);
}

// Discord snowflake -> ms-epoch (snowflake epoch 2015-01-01).
function snowflakeMs(id) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

// ── Plan: classify every guild channel ─────────────────────────────────
// Returns {
//   ok, guildId,
//   clean:    [{ id, name, type, kind, reason }],   // channels/threads to wipe
//   preserve: [{ id, name, type, reason, isMenu }],
//   menu:     [{ id, name, type, reason }],          // perm-lockdown targets
//   skipped:  [{ id, name, type, reason }],
//   errors:   [...]
// }
export async function planCleanup(env, guildId) {
  if (!env?.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const errors = [];

  const chRes = await dfetch(env, `/guilds/${guildId}/channels`);
  if (!chRes.ok) {
    return { ok: false, error: 'guild-channels-failed', status: chRes.status,
      body: (await chRes.text()).slice(0, 300) };
  }
  const channels = await chRes.json();

  // Active threads (one call covers the whole guild).
  const activeThreads = [];
  const atRes = await dfetch(env, `/guilds/${guildId}/threads/active`);
  if (atRes.ok) {
    const j = await atRes.json();
    if (Array.isArray(j?.threads)) activeThreads.push(...j.threads);
  } else {
    errors.push({ phase: 'active-threads', status: atRes.status });
  }

  const clean = [], preserve = [], menu = [], skipped = [];
  const cleanParentIds = new Set();

  for (const c of channels) {
    const base = { id: c.id, name: c.name || '(unnamed)', type: c.type };

    if (c.type === T_VOICE || c.type === T_STAGE) {
      skipped.push({ ...base, reason: 'voice' }); continue;
    }
    if (c.type === T_CATEGORY) {
      skipped.push({ ...base, reason: 'category' }); continue;
    }

    // Explicit menu channels.
    if (EXPLICIT_MENU_CHANNEL_IDS.has(c.id)) {
      preserve.push({ ...base, reason: 'menu-explicit', isMenu: true });
      menu.push({ ...base, reason: 'menu-explicit' });
      continue;
    }
    // Name-protected (welcome/rules/info/announcements).
    if (PROTECT_NAME_RE.test(c.name || '')) {
      preserve.push({ ...base, reason: 'name-protected', isMenu: false });
      continue;
    }
    // Worker-tracked hub channels (edit-in-place embeds) -> preserve.
    if (KNOWN_BOT_HUB_IDS.has(c.id)) {
      preserve.push({ ...base, reason: 'worker-hub', isMenu: false });
      continue;
    }

    // Auto-detect bot-pinned menu channels (text/announcement/forum only).
    // A bot-PINNED message marks a hard menu channel -> preserve AND lock.
    if (TEXTLIKE.has(c.type) || FORUMLIKE.has(c.type)) {
      const pinRes = await dfetch(env, `/channels/${c.id}/pins`);
      if (pinRes.ok) {
        const pins = await pinRes.json();
        const botPinned = Array.isArray(pins) && pins.some(p =>
          p.author?.id === LOADOUT_BOT_USER_ID ||
          p.author?.id === env.DISCORD_APP_ID ||
          p.author?.bot === true);
        if (botPinned) {
          preserve.push({ ...base, reason: 'bot-pinned-menu', isMenu: true });
          menu.push({ ...base, reason: 'bot-pinned-menu' });
          continue;
        }
      } else if (pinRes.status !== 404) {
        errors.push({ phase: 'pins', channel: c.id, status: pinRes.status });
      }
    }

    // Auto-detect live bot HUB embeds (vote-hub, cn-queue, lfg, self-roles,
    // games menu, ...). A bot message carrying interactive components
    // (buttons / select menus) in the recent window is an edit-in-place
    // hub the directive wants preserved ("OR a menu-style embed"). We
    // preserve but do NOT force-lock these: some (e.g. #suggestions) are
    // where members are meant to post. Cleaning would wipe the live hub.
    if (TEXTLIKE.has(c.type)) {
      const rRes = await dfetch(env, `/channels/${c.id}/messages?limit=50`);
      if (rRes.ok) {
        const recent = await rRes.json();
        const hasHub = Array.isArray(recent) && recent.some(m =>
          (m.author?.bot || m.webhook_id) &&
          Array.isArray(m.components) && m.components.length > 0);
        if (hasHub) {
          preserve.push({ ...base, reason: 'bot-menu-embed', isMenu: false });
          continue;
        }
      } else {
        errors.push({ phase: 'recent', channel: c.id, status: rRes.status });
      }
    }

    // Everything else gets cleaned.
    if (TEXTLIKE.has(c.type)) {
      clean.push({ ...base, kind: 'channel', reason: 'general' });
      cleanParentIds.add(c.id);
    } else if (FORUMLIKE.has(c.type)) {
      // Forum container itself has no messages; its threads are handled below.
      clean.push({ ...base, kind: 'forum', reason: 'forum-container' });
      cleanParentIds.add(c.id);
    } else {
      skipped.push({ ...base, reason: `type-${c.type}` });
    }
  }

  // Active threads whose parent is being cleaned -> clean them too.
  for (const t of activeThreads) {
    if (cleanParentIds.has(t.parent_id)) {
      clean.push({ id: t.id, name: t.name || '(thread)', type: t.type,
        kind: 'thread', reason: 'thread-of-cleaned', parentId: t.parent_id });
    }
  }

  return { ok: true, guildId, clean, preserve, menu, skipped, errors };
}

// ── Clean a single channel / thread ────────────────────────────────────
// opts: { runId, channelName?, forumCutoffMs?, isForumContainer? }
// For a forum CONTAINER we enumerate its threads (active+archived) and clean
// each thread whose starter is older than the 30-day cutoff, deleting the
// whole thread; newer threads are preserved.
export async function cleanChannel(env, channelId, opts = {}) {
  if (!env?.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!/^\d{5,25}$/.test(String(channelId))) return { ok: false, error: 'bad-channel-id' };

  if (opts.isForumContainer) return cleanForumContainer(env, channelId, opts);

  const runId = String(opts.runId || 'run');
  const errors = [];

  // Pins to preserve.
  const pinnedIds = new Set();
  const pinRes = await dfetch(env, `/channels/${channelId}/pins`);
  if (pinRes.ok) {
    const pins = await pinRes.json();
    if (Array.isArray(pins)) for (const p of pins) pinnedIds.add(p.id);
  } else if (pinRes.status !== 404) {
    errors.push({ phase: 'pins', status: pinRes.status });
  }

  // Page newest -> oldest, building the archive + delete candidates.
  const records = [];                 // full archive payload
  const candidates = [];              // { id, old }
  const kept = { pinned: 0 };
  let scanned = 0, before, truncated = false;
  for (let page = 0; page < SCAN_PAGE_MAX; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (before) qs.set('before', before);
    const r = await dfetch(env, `/channels/${channelId}/messages?${qs}`);
    if (!r.ok) { errors.push({ phase: 'list', status: r.status, body: (await r.text()).slice(0, 200) }); break; }
    const msgs = await r.json();
    if (!Array.isArray(msgs) || msgs.length === 0) break;
    scanned += msgs.length;
    for (const m of msgs) {
      if (m.pinned || pinnedIds.has(m.id)) { kept.pinned++; continue; }
      records.push({
        id: m.id,
        authorId: m.author?.id || null,
        author: m.author ? (m.author.global_name || m.author.username || null) : null,
        bot: !!(m.author?.bot || m.webhook_id),
        ts: new Date(snowflakeMs(m.id)).toISOString(),
        content: m.content || '',
        attachments: Array.isArray(m.attachments) ? m.attachments.map(a => a.url).filter(Boolean) : [],
        embeds: Array.isArray(m.embeds) ? m.embeds.length : 0,
      });
      candidates.push({ id: m.id, old: snowflakeMs(m.id) < (Date.now() - DAYS_14_MS + 60_000) });
    }
    before = msgs[msgs.length - 1].id;
    if (msgs.length < 100) break;
    if (page === SCAN_PAGE_MAX - 1) truncated = true;
  }

  // SNAPSHOT FIRST. If the archive write fails, skip deletion entirely.
  if (records.length > 0) {
    const wrote = await writeArchive(env, runId, channelId, opts.channelName || '', records, truncated);
    if (!wrote.ok) {
      return { ok: false, channelId, error: 'archive-failed', detail: wrote.error,
        scanned, archived: 0, deleted: 0, kept, errors };
    }
  }

  // Delete: bulk (<14d) in batches of 100, single-delete for older.
  const fresh = candidates.filter(c => !c.old).map(c => c.id);
  const old = candidates.filter(c => c.old).map(c => c.id);
  let deleted = 0;
  for (let i = 0; i < fresh.length; i += BULK_BATCH_MAX) {
    const batch = fresh.slice(i, i + BULK_BATCH_MAX);
    if (batch.length === 1) { if (await singleDelete(env, channelId, batch[0])) deleted++; else errors.push({ phase: 'single', id: batch[0] }); continue; }
    const r = await dfetch(env, `/channels/${channelId}/messages/bulk-delete`, {
      method: 'POST', body: JSON.stringify({ messages: batch }) });
    if (r.ok || r.status === 204) deleted += batch.length;
    else {
      // Bulk failed (e.g. a member crossed the 14-day line mid-run): fall
      // back to single-delete for this batch so the run still progresses.
      errors.push({ phase: 'bulk', count: batch.length, status: r.status, body: (await r.text()).slice(0, 150) });
      for (const id of batch) { if (await singleDelete(env, channelId, id)) deleted++; }
    }
  }
  for (const id of old) { if (await singleDelete(env, channelId, id)) deleted++; else errors.push({ phase: 'single-old', id }); }

  return { ok: true, channelId, channelName: opts.channelName || '', scanned,
    archived: records.length, deleted, kept, truncated, errors };
}

async function singleDelete(env, channelId, id) {
  const r = await dfetch(env, `/channels/${channelId}/messages/${id}`, { method: 'DELETE' });
  return r.ok || r.status === 204 || r.status === 404;
}

// Forum / media container: snapshot + delete threads older than the cutoff.
async function cleanForumContainer(env, channelId, opts = {}) {
  const runId = String(opts.runId || 'run');
  const cutoffMs = Number(opts.forumCutoffMs ?? FORUM_CUTOFF_MS_DEFAULT);
  const cutoffTs = Date.now() - cutoffMs;
  const errors = [];

  // Gather threads: active (filtered to this parent) + archived public.
  const threads = [];
  const at = await dfetch(env, `/guilds/${opts.guildId}/threads/active`);
  if (opts.guildId && at.ok) {
    const j = await at.json();
    if (Array.isArray(j?.threads)) threads.push(...j.threads.filter(t => t.parent_id === channelId));
  }
  let beforeTs;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (beforeTs) qs.set('before', beforeTs);
    const r = await dfetch(env, `/channels/${channelId}/threads/archived/public?${qs}`);
    if (!r.ok) { if (r.status !== 404) errors.push({ phase: 'archived', status: r.status }); break; }
    const j = await r.json();
    const arr = Array.isArray(j?.threads) ? j.threads : [];
    threads.push(...arr);
    if (!j?.has_more || arr.length === 0) break;
    const last = arr[arr.length - 1];
    beforeTs = last?.thread_metadata?.archive_timestamp;
    if (!beforeTs) break;
  }

  let deletedThreads = 0, keptThreads = 0, archived = 0;
  const perThread = [];
  for (const t of threads) {
    const createdMs = snowflakeMs(t.id);
    if (createdMs >= cutoffTs) { keptThreads++; continue; }   // newer than 30d -> preserve
    // Snapshot the thread's messages, then delete the whole thread.
    const res = await cleanChannel(env, t.id, { runId, channelName: `[forum]${t.name || ''}` });
    if (res.ok) {
      archived += res.archived || 0;
      const del = await dfetch(env, `/channels/${t.id}`, { method: 'DELETE' });
      if (del.ok || del.status === 204 || del.status === 404) deletedThreads++;
      else errors.push({ phase: 'thread-delete', id: t.id, status: del.status });
      perThread.push({ id: t.id, name: t.name, archived: res.archived, deleted: res.deleted });
    } else {
      errors.push({ phase: 'thread-clean', id: t.id, error: res.error });
    }
  }

  return { ok: true, channelId, channelName: opts.channelName || '', kind: 'forum',
    threadsScanned: threads.length, deletedThreads, keptThreads, archived, perThread, errors };
}

// ── Archive helpers ────────────────────────────────────────────────────
// Key: discord-cleanup-archive:<runId>:<channelId>  (part 0 / index)
//      ...:<channelId>:p1, :p2  for overflow chunks.
async function writeArchive(env, runId, channelId, channelName, records, truncated) {
  try {
    const parts = [];
    for (let i = 0; i < records.length; i += ARCHIVE_CHUNK) parts.push(records.slice(i, i + ARCHIVE_CHUNK));
    if (parts.length === 0) parts.push([]);
    // Overflow chunks first.
    for (let p = 1; p < parts.length; p++) {
      await env.LOADOUT_BOLTS.put(
        `discord-cleanup-archive:${runId}:${channelId}:p${p}`,
        JSON.stringify({ channelId, part: p, messages: parts[p] }),
        { expirationTtl: ARCHIVE_TTL_SEC });
    }
    // Index / part 0.
    await env.LOADOUT_BOLTS.put(
      `discord-cleanup-archive:${runId}:${channelId}`,
      JSON.stringify({
        channelId, channelName, runId,
        count: records.length, parts: parts.length, truncated: !!truncated,
        messages: parts[0],
      }),
      { expirationTtl: ARCHIVE_TTL_SEC });
    return { ok: true, count: records.length, parts: parts.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function readArchive(env, runId, channelId) {
  const raw = await env.LOADOUT_BOLTS.get(`discord-cleanup-archive:${runId}:${channelId}`);
  if (!raw) return { ok: false, error: 'not-found' };
  let head;
  try { head = JSON.parse(raw); } catch { return { ok: false, error: 'corrupt' }; }
  return { ok: true, ...head };
}

// ── Permission lockdown ────────────────────────────────────────────────
export async function lockdownMenuChannel(env, guildId, channelId, botIds = []) {
  if (!env?.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const applied = [], errors = [];

  // @everyone (role overwrite, type 0) deny SEND + SEND_IN_THREADS.
  const ev = await dfetch(env, `/channels/${channelId}/permissions/${guildId}`, {
    method: 'PUT', body: JSON.stringify({ type: 0, allow: '0', deny: SEND_DENY }) });
  if (ev.ok || ev.status === 204) applied.push('@everyone:deny-send');
  else errors.push({ target: '@everyone', status: ev.status, body: (await ev.text()).slice(0, 150) });

  // Bot user overwrites (member, type 1) allow SEND + SEND_IN_THREADS.
  for (const bid of botIds) {
    const r = await dfetch(env, `/channels/${channelId}/permissions/${bid}`, {
      method: 'PUT', body: JSON.stringify({ type: 1, allow: SEND_DENY, deny: '0' }) });
    if (r.ok || r.status === 204) applied.push(`bot:${bid}:allow-send`);
    else errors.push({ target: bid, status: r.status, body: (await r.text()).slice(0, 150) });
  }

  return { ok: errors.length === 0, channelId, applied, errors };
}

// Resolve the @everyone overwrite to confirm SEND is denied.
export async function verifyLock(env, guildId, channelId) {
  const r = await dfetch(env, `/channels/${channelId}`);
  if (!r.ok) return { ok: false, channelId, error: 'fetch-failed', status: r.status };
  const ch = await r.json();
  const ov = (ch.permission_overwrites || []).find(o => o.id === guildId);
  if (!ov) return { ok: false, channelId, everyoneSendDenied: false, reason: 'no-overwrite' };
  const denied = (BigInt(ov.deny || '0') & SEND_MESSAGES) === SEND_MESSAGES;
  return { ok: true, channelId, everyoneSendDenied: denied, deny: ov.deny };
}

// Sample remaining messages after a clean (should be empty or pinned-only).
export async function verifyChannel(env, channelId) {
  const r = await dfetch(env, `/channels/${channelId}/messages?limit=50`);
  if (!r.ok) return { ok: false, channelId, error: 'fetch-failed', status: r.status };
  const msgs = await r.json();
  const arr = Array.isArray(msgs) ? msgs : [];
  const nonPinned = arr.filter(m => !m.pinned).length;
  return { ok: true, channelId, remaining: arr.length, nonPinned,
    clean: nonPinned === 0 };
}
