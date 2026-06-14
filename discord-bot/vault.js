// Knowledge Vault, Clay's personal highlights store (Kindle + PDF).
//
// Owner-only. The site dispatcher (functions/api/web/play) verifies Clay's
// session, stamps _owner:true, and HMAC-forwards to /web/admin/vault/api;
// web.js gates with ownerCheck(body) before calling handleVaultApi here.
// Every row is scoped to the owner's Discord id, nothing is public.
//
// One action-dispatched route keeps the /web allow-list small: the body
// carries { action, ...args } and we branch below. The companion (phase 3)
// uses a separate, secret-gated top-level route (handleKindleIngest) so a
// machine with no browser session can still push highlights.
//
// kindle_highlights + pdf_highlights share the review-state columns so the
// daily digest (phase 2) selects across both with one weighting pass.

const OWNER_ID = '1107161695262085210'; // Clay's Discord id, the only vault owner.
const COLORS = new Set(['yellow', 'blue', 'pink', 'orange', 'green']);

// Spaced-repetition interval ladder in days, indexed by review_count. After
// the ladder ends we multiply the last gap by the ease factor (SM-2-lite).
const LADDER_DAYS = [1, 3, 7, 16, 35];
const DAY_MS = 86400000;

function db(env) {
  if (!env || !env.DB) throw new Error('vault: no D1 binding (env.DB missing)');
  return env.DB;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function clampStr(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newId(prefix) {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

function nextReview(reviewCount, ease) {
  const i = Math.min(reviewCount, LADDER_DAYS.length - 1);
  let days = LADDER_DAYS[i];
  if (reviewCount >= LADDER_DAYS.length) {
    days = Math.round(LADDER_DAYS[LADDER_DAYS.length - 1] * Math.pow(ease || 2.5, reviewCount - LADDER_DAYS.length + 1));
  }
  return Date.now() + Math.min(days, 365) * DAY_MS;
}

// ── unified row mappers ────────────────────────────────────────────────
function mapKindle(r) {
  return {
    kind: 'kindle',
    id: r.id,
    source: 'Book',
    sourceTitle: r.book_title || 'Untitled',
    author: r.book_author || '',
    location: r.location || '',
    text: r.highlight_text || '',
    color: r.color || 'yellow',
    note: r.note || '',
    favorite: !!r.favorite,
    dateAdded: r.date_added || 0,
    lastReviewedAt: r.last_reviewed_at || null,
    nextReviewAt: r.next_review_at || null,
    reviewCount: r.review_count || 0,
  };
}
function mapPdf(r) {
  return {
    kind: 'pdf',
    id: r.id,
    source: 'PDF',
    sourceTitle: r.doc_title || r.filename || 'PDF',
    documentId: r.document_id,
    page: r.page_number || 0,
    text: r.highlight_text || '',
    color: r.color || 'yellow',
    note: r.note || '',
    favorite: !!r.favorite,
    inReview: !!r.in_review,
    dateAdded: r.date_added || 0,
    lastReviewedAt: r.last_reviewed_at || null,
    nextReviewAt: r.next_review_at || null,
    reviewCount: r.review_count || 0,
  };
}

// ── settings (KV) ──────────────────────────────────────────────────────
// digestCount: 3..10 highlights per daily push.
// mode: 'spaced' (due-first spaced repetition) or 'random' (weighted random).
// sendHourUtc: 0..23, the UTC hour the daily push fires (default 13 = 8am ET).
async function getSettings(env, userId) {
  let s = null;
  try { s = await env.LOADOUT_BOLTS.get('vault:settings:' + userId, { type: 'json' }); } catch { /* ignore */ }
  return {
    digestCount: Math.min(10, Math.max(3, Number(s?.digestCount) || 5)),
    mode: s?.mode === 'random' ? 'random' : 'spaced',
    sendHourUtc: Number.isInteger(s?.sendHourUtc) ? Math.min(23, Math.max(0, s.sendHourUtc)) : 13,
  };
}
async function setSettings(env, userId, patch) {
  const cur = await getSettings(env, userId);
  const next = {
    digestCount: Math.min(10, Math.max(3, Number(patch?.digestCount) || cur.digestCount)),
    mode: patch?.mode === 'random' || patch?.mode === 'spaced' ? patch.mode : cur.mode,
    sendHourUtc: Number.isInteger(patch?.sendHourUtc) ? Math.min(23, Math.max(0, patch.sendHourUtc)) : cur.sendHourUtc,
  };
  try { await env.LOADOUT_BOLTS.put('vault:settings:' + userId, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

// ── main owner API ─────────────────────────────────────────────────────
export async function handleVaultApi(env, body) {
  const userId = String(body?.discordId || '').trim() || OWNER_ID;
  const action = String(body?.action || '').trim();
  try {
    switch (action) {
      case 'list':        return await actList(env, userId, body);
      case 'stats':       return await actStats(env, userId);
      case 'digest':      return await actDigest(env, userId, body);
      case 'reviewed':    return await actReviewed(env, userId, body);
      case 'favorite':    return await actFavorite(env, userId, body);
      case 'summary':     return await actSummary(env, userId);
      case 'export':      return await actExport(env, userId, body);
      case 'settings-get':return json({ ok: true, settings: await getSettings(env, userId) });
      case 'settings-set':return json({ ok: true, settings: await setSettings(env, userId, body) });
      case 'daily-batch': return await actDailyBatch(env, userId);
      case 'highlight-add':return await actHighlightAdd(env, userId, body);
      case 'pdf-list':    return await actPdfList(env, userId);
      case 'pdf-create':  return await actPdfCreate(env, userId, body);
      case 'pdf-get':     return await actPdfGet(env, userId, body);
      case 'pdf-delete':  return await actPdfDelete(env, userId, body);
      case 'pdf-hl-add':  return await actPdfHlAdd(env, userId, body);
      case 'pdf-hl-update':return await actPdfHlUpdate(env, userId, body);
      case 'pdf-hl-delete':return await actPdfHlDelete(env, userId, body);
      default:            return json({ ok: false, error: 'unknown-action' }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e).slice(0, 120) }, 500);
  }
}

async function fetchAllKindle(env, userId) {
  const r = await db(env).prepare(
    `SELECT * FROM kindle_highlights WHERE user_id = ? ORDER BY date_added DESC`
  ).bind(userId).all();
  return (r?.results || []);
}
async function fetchAllPdfHl(env, userId) {
  const r = await db(env).prepare(
    `SELECT h.*, d.filename AS filename, d.title AS doc_title
       FROM pdf_highlights h LEFT JOIN pdf_documents d ON d.id = h.document_id
      WHERE h.user_id = ? ORDER BY h.date_added DESC`
  ).bind(userId).all();
  return (r?.results || []);
}

async function actList(env, userId, body) {
  const source = String(body?.source || 'all');
  const q = clampStr(body?.q, 200).toLowerCase().trim();
  const favOnly = !!body?.favorites;
  const book = clampStr(body?.book, 200).toLowerCase().trim();
  const author = clampStr(body?.author, 200).toLowerCase().trim();
  const limit = Math.min(200, Math.max(1, Number(body?.limit) || 50));
  const offset = Math.max(0, Number(body?.offset) || 0);

  let items = [];
  if (source === 'all' || source === 'kindle') items = items.concat((await fetchAllKindle(env, userId)).map(mapKindle));
  if (source === 'all' || source === 'pdf') items = items.concat((await fetchAllPdfHl(env, userId)).map(mapPdf));

  items = items.filter((it) => {
    if (favOnly && !it.favorite) return false;
    if (book && !(it.sourceTitle || '').toLowerCase().includes(book)) return false;
    if (author && !(it.author || '').toLowerCase().includes(author)) return false;
    if (q) {
      const hay = (it.text + ' ' + it.sourceTitle + ' ' + (it.author || '') + ' ' + (it.note || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  items.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
  const total = items.length;
  return json({ ok: true, total, items: items.slice(offset, offset + limit) });
}

async function actStats(env, userId) {
  const kindle = await fetchAllKindle(env, userId);
  const pdfHl = await fetchAllPdfHl(env, userId);
  const docsRow = await db(env).prepare(`SELECT COUNT(*) AS n FROM pdf_documents WHERE user_id = ?`).bind(userId).first();
  const books = new Set(kindle.map((r) => r.book_title).filter(Boolean));
  const weekAgo = Date.now() - 7 * DAY_MS;
  const reviewedThisWeek = [...kindle, ...pdfHl].filter((r) => (r.last_reviewed_at || 0) >= weekAgo).length;
  const favorites = [...kindle, ...pdfHl].filter((r) => r.favorite).length;
  return json({
    ok: true,
    stats: {
      totalKindle: kindle.length,
      totalPdf: pdfHl.length,
      total: kindle.length + pdfHl.length,
      books: books.size,
      pdfs: Number(docsRow?.n) || 0,
      favorites,
      reviewedThisWeek,
    },
  });
}

async function actDigest(env, userId, body) {
  const settings = await getSettings(env, userId);
  const n = Math.min(10, Math.max(1, Number(body?.count) || settings.digestCount));
  const now = Date.now();
  const kindle = (await fetchAllKindle(env, userId)).map(mapKindle);
  const pdf = (await fetchAllPdfHl(env, userId)).map(mapPdf).filter((it) => it.inReview);
  const pool = kindle.concat(pdf);
  // Weight: due items first (next_review_at <= now or null), then by how
  // overdue / how rarely seen. Light random jitter avoids the same order daily.
  const scored = pool.map((it) => {
    const due = !it.nextReviewAt || it.nextReviewAt <= now;
    const overdue = it.nextReviewAt ? Math.max(0, now - it.nextReviewAt) / DAY_MS : 30;
    const unseen = it.reviewCount === 0 ? 10 : 0;
    const score = (due ? 100 : 0) + overdue + unseen + Math.random() * 5;
    return { it, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return json({ ok: true, items: scored.slice(0, n).map((s) => s.it), digestCount: settings.digestCount });
}

async function actReviewed(env, userId, body) {
  const kind = body?.kind === 'pdf' ? 'pdf' : 'kindle';
  const id = clampStr(body?.id, 80);
  if (!id) return json({ ok: false, error: 'missing-id' }, 400);
  const table = kind === 'pdf' ? 'pdf_highlights' : 'kindle_highlights';
  const row = await db(env).prepare(`SELECT review_count, ease_factor FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId).first();
  if (!row) return json({ ok: false, error: 'not-found' }, 404);
  const rc = (Number(row.review_count) || 0) + 1;
  const ease = Number(row.ease_factor) || 2.5;
  const next = nextReview(rc, ease);
  await db(env).prepare(
    `UPDATE ${table} SET review_count = ?, last_reviewed_at = ?, next_review_at = ? WHERE id = ? AND user_id = ?`
  ).bind(rc, Date.now(), next, id, userId).run();
  return json({ ok: true, reviewCount: rc, nextReviewAt: next });
}

async function actFavorite(env, userId, body) {
  const kind = body?.kind === 'pdf' ? 'pdf' : 'kindle';
  const id = clampStr(body?.id, 80);
  const value = body?.value ? 1 : 0;
  if (!id) return json({ ok: false, error: 'missing-id' }, 400);
  const table = kind === 'pdf' ? 'pdf_highlights' : 'kindle_highlights';
  await db(env).prepare(`UPDATE ${table} SET favorite = ? WHERE id = ? AND user_id = ?`).bind(value, id, userId).run();
  return json({ ok: true, favorite: !!value });
}

async function actSummary(env, userId) {
  const key = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return json({ ok: false, error: 'ai-not-configured' }, 503);
  const kindle = (await fetchAllKindle(env, userId)).map(mapKindle);
  const pdf = (await fetchAllPdfHl(env, userId)).map(mapPdf);
  const recent = kindle.concat(pdf).sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0)).slice(0, 40);
  if (!recent.length) return json({ ok: true, summary: 'No highlights yet. Add some to see weekly themes.' });
  const corpus = recent.map((it, i) => `${i + 1}. [${it.sourceTitle}] ${it.text}`).join('\n').slice(0, 9000);
  const prompt =
    'These are recent reading highlights. Group them into 2 to 4 themes and write a 2 to 3 sentence synthesis ' +
    'of what the reader has been thinking about. Be concrete and specific to the content. Do not use em dashes. ' +
    'Reply with plain prose, no preamble.\n\n' + corpus;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) return json({ ok: false, error: 'ai ' + r.status }, 502);
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join('').trim();
    return json({ ok: true, summary: text, count: recent.length });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e).slice(0, 80) }, 502);
  }
}

async function actExport(env, userId, body) {
  const format = ['md', 'json', 'txt'].includes(body?.format) ? body.format : 'md';
  const kindle = (await fetchAllKindle(env, userId)).map(mapKindle);
  const pdf = (await fetchAllPdfHl(env, userId)).map(mapPdf);
  const all = kindle.concat(pdf).sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
  if (format === 'json') return json({ ok: true, format, content: JSON.stringify(all, null, 2) });
  if (format === 'txt') {
    const content = all.map((it) => `${it.text}\n  - ${it.sourceTitle}${it.author ? ', ' + it.author : ''}\n`).join('\n');
    return json({ ok: true, format, content });
  }
  // markdown grouped by source title
  const byTitle = new Map();
  for (const it of all) {
    if (!byTitle.has(it.sourceTitle)) byTitle.set(it.sourceTitle, []);
    byTitle.get(it.sourceTitle).push(it);
  }
  let md = '# Knowledge Vault export\n\n';
  for (const [title, items] of byTitle) {
    md += `## ${title}\n\n`;
    for (const it of items) {
      md += `> ${it.text}\n`;
      if (it.note) md += `\n*${it.note}*\n`;
      md += '\n';
    }
  }
  return json({ ok: true, format, content: md });
}

async function actHighlightAdd(env, userId, body) {
  const text = clampStr(body?.text, 6000).trim();
  if (!text) return json({ ok: false, error: 'empty' }, 400);
  const title = clampStr(body?.book_title || body?.title, 300).trim() || 'Untitled';
  const author = clampStr(body?.book_author || body?.author, 200).trim();
  const note = clampStr(body?.note, 2000).trim();
  const now = Date.now();
  const id = 'kh_' + (await sha256Hex(title + '|manual|' + text)).slice(0, 24);
  await db(env).prepare(
    `INSERT INTO kindle_highlights (id, user_id, book_title, book_author, highlight_text, note, date_added, next_review_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET highlight_text = excluded.highlight_text, note = excluded.note`
  ).bind(id, userId, title, author, text, note || null, now, now + DAY_MS, now).run();
  return json({ ok: true, id });
}

// ── PDF documents ──────────────────────────────────────────────────────
async function actPdfList(env, userId) {
  const r = await db(env).prepare(
    `SELECT d.id, d.filename, d.title, d.page_count, d.uploaded_at,
            (SELECT COUNT(*) FROM pdf_highlights h WHERE h.document_id = d.id) AS highlight_count
       FROM pdf_documents d WHERE d.user_id = ? ORDER BY d.uploaded_at DESC`
  ).bind(userId).all();
  return json({ ok: true, documents: r?.results || [] });
}

async function actPdfCreate(env, userId, body) {
  const filename = clampStr(body?.filename, 300).trim() || 'document.pdf';
  const title = clampStr(body?.title, 300).trim() || filename.replace(/\.pdf$/i, '');
  let pages = Array.isArray(body?.pages) ? body.pages.map((p) => clampStr(p, 200000)) : [];
  if (pages.length > 2000) pages = pages.slice(0, 2000);
  const pageCount = Number(body?.pageCount) || pages.length;
  const now = Date.now();
  const id = newId('pdf');
  await db(env).prepare(
    `INSERT INTO pdf_documents (id, user_id, filename, title, page_count, pages_json, uploaded_at, extracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, filename, title, pageCount, JSON.stringify(pages), now, now).run();
  return json({ ok: true, id, pageCount });
}

async function actPdfGet(env, userId, body) {
  const id = clampStr(body?.id, 80);
  const doc = await db(env).prepare(
    `SELECT id, filename, title, page_count, pages_json, uploaded_at FROM pdf_documents WHERE id = ? AND user_id = ?`
  ).bind(id, userId).first();
  if (!doc) return json({ ok: false, error: 'not-found' }, 404);
  let pages = [];
  try { pages = JSON.parse(doc.pages_json || '[]'); } catch { /* ignore */ }
  const hl = await db(env).prepare(
    `SELECT * FROM pdf_highlights WHERE document_id = ? AND user_id = ? ORDER BY page_number ASC, date_added ASC`
  ).bind(id, userId).all();
  return json({
    ok: true,
    document: { id: doc.id, filename: doc.filename, title: doc.title, pageCount: doc.page_count, uploadedAt: doc.uploaded_at, pages },
    highlights: (hl?.results || []).map(mapPdf),
  });
}

async function actPdfDelete(env, userId, body) {
  const id = clampStr(body?.id, 80);
  await db(env).prepare(`DELETE FROM pdf_highlights WHERE document_id = ? AND user_id = ?`).bind(id, userId).run();
  await db(env).prepare(`DELETE FROM pdf_documents WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  return json({ ok: true });
}

async function actPdfHlAdd(env, userId, body) {
  const documentId = clampStr(body?.document_id, 80);
  const text = clampStr(body?.highlight_text, 6000).trim();
  if (!documentId || !text) return json({ ok: false, error: 'missing' }, 400);
  const color = COLORS.has(body?.color) ? body.color : 'yellow';
  const page = Math.max(0, Number(body?.page_number) || 0);
  const note = clampStr(body?.note, 2000).trim();
  const inReview = body?.in_review ? 1 : 0;
  const position = body?.position ? clampStr(JSON.stringify(body.position), 2000) : null;
  const now = Date.now();
  const id = newId('phl');
  await db(env).prepare(
    `INSERT INTO pdf_highlights (id, user_id, document_id, page_number, highlight_text, color, note, in_review, position, date_added, next_review_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, documentId, page, text, color, note || null, inReview, position, now, inReview ? now + DAY_MS : null).run();
  return json({ ok: true, id });
}

async function actPdfHlUpdate(env, userId, body) {
  const id = clampStr(body?.id, 80);
  if (!id) return json({ ok: false, error: 'missing-id' }, 400);
  const sets = [];
  const binds = [];
  if (COLORS.has(body?.color)) { sets.push('color = ?'); binds.push(body.color); }
  if (typeof body?.note === 'string') { sets.push('note = ?'); binds.push(clampStr(body.note, 2000)); }
  if (typeof body?.favorite === 'boolean') { sets.push('favorite = ?'); binds.push(body.favorite ? 1 : 0); }
  if (typeof body?.in_review === 'boolean') {
    sets.push('in_review = ?'); binds.push(body.in_review ? 1 : 0);
    sets.push('next_review_at = ?'); binds.push(body.in_review ? Date.now() + DAY_MS : null);
  }
  if (!sets.length) return json({ ok: false, error: 'no-fields' }, 400);
  binds.push(id, userId);
  await db(env).prepare(`UPDATE pdf_highlights SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  return json({ ok: true });
}

async function actPdfHlDelete(env, userId, body) {
  const id = clampStr(body?.id, 80);
  await db(env).prepare(`DELETE FROM pdf_highlights WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  return json({ ok: true });
}

// ── Kindle companion ingest (machine-to-worker, secret-gated) ──────────
// POST /vault/kindle/ingest  with HMAC headers x-aquilo-vault-ts +
// x-aquilo-vault-sig (SHA-256 over ts + "\n" + rawBody) keyed by
// VAULT_INGEST_SECRET. Body: { highlights: [ {book_title, book_author,
// location, asin, highlight_text, color, note, date_added}, ... ] }.
// Dedupes by deterministic id; new highlights enter the review rotation.
export async function handleKindleIngest(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const secret = String(env.VAULT_INGEST_SECRET || '').trim();
  if (!secret) return json({ error: 'not-configured', message: 'VAULT_INGEST_SECRET missing on the bot' }, 503);
  const bodyText = await req.text();
  const ts = req.headers.get('x-aquilo-vault-ts') || '';
  const sig = req.headers.get('x-aquilo-vault-sig') || '';
  const { verifyHmac } = await import('./auth.js');
  if (!(await verifyHmac(secret, ts, bodyText, sig))) return json({ error: 'unauthorized' }, 401);
  let body;
  try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad-json' }, 400); }
  const items = Array.isArray(body?.highlights) ? body.highlights : [];
  if (!items.length) return json({ ok: true, inserted: 0, skipped: 0 });

  let inserted = 0;
  let skipped = 0;
  const now = Date.now();
  for (const h of items.slice(0, 5000)) {
    const text = clampStr(h?.highlight_text, 6000).trim();
    if (!text) { skipped++; continue; }
    const title = clampStr(h?.book_title, 300).trim() || 'Untitled';
    const author = clampStr(h?.book_author, 200).trim();
    const location = clampStr(h?.location, 80);
    const asin = clampStr(h?.asin, 40);
    const color = COLORS.has(h?.color) ? h.color : 'yellow';
    const note = clampStr(h?.note, 2000).trim();
    const dateAdded = Number(h?.date_added) || now;
    const id = 'kh_' + (await sha256Hex((asin || title) + '|' + location + '|' + text)).slice(0, 24);
    const res = await db(env).prepare(
      `INSERT INTO kindle_highlights
         (id, user_id, book_title, book_author, location, asin, highlight_text, color, note, date_added, next_review_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(id, OWNER_ID, title, author, location || null, asin || null, text, color, note || null, dateAdded, now + DAY_MS, now).run();
    if (res?.meta?.changes) inserted++; else skipped++;
  }
  return json({ ok: true, inserted, skipped });
}

// ── Daily digest (push notification, replaces the email path) ──────────
function dateKeyUtc(now) {
  const d = new Date(now);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// Pick N highlights for review. 'spaced' favors items that are due (or
// overdue, or never seen); 'random' is a flat weighted shuffle. PDF
// highlights only enter the pool when flagged "add to daily review".
async function pickHighlights(env, userId, n, mode) {
  const now = Date.now();
  const kindle = (await fetchAllKindle(env, userId)).map(mapKindle);
  const pdf = (await fetchAllPdfHl(env, userId)).map(mapPdf).filter((it) => it.inReview);
  const pool = kindle.concat(pdf);
  if (!pool.length) return [];
  const scored = pool.map((it) => {
    if (mode === 'random') return { it, score: Math.random() };
    const due = !it.nextReviewAt || it.nextReviewAt <= now;
    const overdue = it.nextReviewAt ? Math.max(0, now - it.nextReviewAt) / DAY_MS : 30;
    const unseen = it.reviewCount === 0 ? 10 : 0;
    return { it, score: (due ? 100 : 0) + overdue + unseen + Math.random() * 5 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, n)).map((s) => s.it);
}

// Today's batch persists in KV (TTL 48h) so every notification tap and
// every /vault/daily visit shows the SAME set until tomorrow's build.
async function buildDailyBatch(env, userId) {
  const settings = await getSettings(env, userId);
  const date = dateKeyUtc(Date.now());
  const key = `vault:daily:${userId}:${date}`;
  let batch = null;
  try { batch = await env.LOADOUT_BOLTS.get(key, { type: 'json' }); } catch { /* ignore */ }
  if (batch && Array.isArray(batch.items)) return batch;
  const items = await pickHighlights(env, userId, settings.digestCount, settings.mode);
  batch = { date, items, count: items.length, firstTitle: items[0]?.sourceTitle || '', builtAt: Date.now() };
  try { await env.LOADOUT_BOLTS.put(key, JSON.stringify(batch), { expirationTtl: 48 * 3600 }); } catch { /* ignore */ }
  return batch;
}

async function actDailyBatch(env, userId) {
  const batch = await buildDailyBatch(env, userId);
  return json({ ok: true, date: batch.date, items: batch.items || [] });
}

// Cron entrypoint. Builds today's batch and pushes ONE notification to
// the owner's subscribed devices via the existing /api/push/external
// bridge (firePush). Idempotent: gated on the configured UTC send hour
// plus a per-day "sent" marker, so calling it from both the hourly tick
// and the 0 13 cron never double-fires. No tag is passed, so it stays
// push-only (no Discord DM duplicate) and lands only on the owner's subs.
export async function runDailyDigest(env) {
  const userId = OWNER_ID;
  const settings = await getSettings(env, userId);
  const now = Date.now();
  if (new Date(now).getUTCHours() !== settings.sendHourUtc) return { ok: false, reason: 'not-the-hour' };
  const date = dateKeyUtc(now);
  const sentKey = `vault:daily-sent:${userId}:${date}`;
  let already = null;
  try { already = await env.LOADOUT_BOLTS.get(sentKey); } catch { /* ignore */ }
  if (already) return { ok: false, reason: 'already-sent' };
  const batch = await buildDailyBatch(env, userId);
  // Mark sent first so a push failure can't loop-retry all hour.
  try { await env.LOADOUT_BOLTS.put(sentKey, '1', { expirationTtl: 48 * 3600 }); } catch { /* ignore */ }
  if (!batch.items || batch.items.length === 0) return { ok: false, reason: 'no-highlights' };
  try {
    const { firePush } = await import('./push.js');
    const pushed = await firePush(env, {
      kind: 'vaultDaily',
      title: `${batch.count} highlight${batch.count === 1 ? '' : 's'} ready to review`,
      body: batch.firstTitle ? `Starting with ${batch.firstTitle}` : 'Open your daily review',
      url: 'https://aquilo.gg/vault/daily',
      audience: { kind: 'user', userIds: [userId] },
    });
    return { ok: true, count: batch.count, sent: pushed?.sent ?? null };
  } catch (e) {
    console.warn('[vault] daily push failed', e?.message || e);
    return { ok: false, reason: 'push-failed' };
  }
}
