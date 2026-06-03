// Boltbound, deck sharing + community decks (RET-7).
//
// Players publish a saved deck to the community gallery; others browse
// the most-copied lists, copy a deck (bumps its copy count + returns the
// card list to import), and see a "Deck of the Day" = the most-copied
// deck in the last 24h. Portable deck CODES (base64 of the card list)
// are encoded/decoded CLIENT-SIDE (src/lib/deck-code.ts); the worker
// stores the structured deck so it can rank by copies/views.
//
// D1: boltbound_shared_deck.

import { CARDS } from './cards-content.js';

const MAX_NAME = 48;
const MAX_DESC = 200;
const MAX_CARDS = 40;
const ARCHETYPES = new Set(['aggro', 'midrange', 'control', 'combo', 'other']);

function db(env) {
  if (!env || !env.DB) throw new Error('decks-share: no D1 binding (env.DB missing)');
  return env.DB;
}
function newId() { return crypto.randomUUID(); }

function dayKey(nowMs) {
  const d = new Date(nowMs == null ? Date.now() : nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function sanitizeCards(cards) {
  if (!Array.isArray(cards)) return null;
  const out = cards.map(String).filter(id => CARDS[id]);
  if (!out.length || out.length > MAX_CARDS) return null;
  return out;
}

// Decklist summary for the gallery (counts per card + rarity mix) so the
// list renders without the client re-fetching the catalogue.
function summarise(cards) {
  const tally = {};
  for (const id of cards) tally[id] = (tally[id] || 0) + 1;
  const rarity = {};
  for (const id of Object.keys(tally)) {
    const r = CARDS[id]?.rarity || 'common';
    rarity[r] = (rarity[r] || 0) + tally[id];
  }
  return { size: cards.length, unique: Object.keys(tally).length, rarity };
}

function shapeRow(r, withCards) {
  let cards = [];
  try { cards = JSON.parse(r.cards_json || '[]'); } catch { cards = []; }
  const base = {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    description: r.description || '',
    championClass: r.champion_class || null,
    archetype: r.archetype || 'other',
    views: Number(r.views) || 0,
    copies: Number(r.copies) || 0,
    createdAt: Number(r.created_at) || 0,
    summary: summarise(cards),
  };
  if (withCards) base.cards = cards;
  return base;
}

// ── Public API ──────────────────────────────────────────────────────

export async function shareDeck(env, userId, body) {
  const name = String((body && body.name) || '').trim().slice(0, MAX_NAME);
  const description = String((body && body.description) || '').trim().slice(0, MAX_DESC);
  const championClass = String((body && body.championClass) || '').trim().slice(0, 24) || null;
  let archetype = String((body && body.archetype) || 'other').trim().toLowerCase();
  if (!ARCHETYPES.has(archetype)) archetype = 'other';
  const cards = sanitizeCards(body && body.cards);
  if (!name) return { ok: false, error: 'name-required' };
  if (!cards) return { ok: false, error: 'bad-deck' };

  // Cap the per-user shared-deck count, trim the oldest beyond 25.
  try {
    const { results } = await db(env).prepare(
      'SELECT id FROM boltbound_shared_deck WHERE owner_id = ? ORDER BY created_at DESC'
    ).bind(String(userId)).all();
    const ids = (results || []).map(r => r.id);
    if (ids.length >= 25) {
      const drop = ids.slice(24);
      for (const id of drop) await db(env).prepare('DELETE FROM boltbound_shared_deck WHERE id = ?').bind(id).run();
    }
  } catch { /* best-effort trim */ }

  const id = newId();
  const now = Date.now();
  await db(env).prepare(
    `INSERT INTO boltbound_shared_deck
       (id, owner_id, name, description, champion_class, archetype, cards_json,
        views, copies, day_copies, day_key, created_at)
     VALUES (?,?,?,?,?,?,?,0,0,0,?,?)`
  ).bind(id, String(userId), name, description, championClass, archetype, JSON.stringify(cards), dayKey(now), now).run();
  return { ok: true, id };
}

// Popular list + Deck of the Day. Optional filters by class / archetype.
export async function listCommunity(env, opts = {}) {
  const D = db(env);
  const filters = [];
  const binds = [];
  if (opts.championClass) { filters.push('champion_class = ?'); binds.push(String(opts.championClass)); }
  if (opts.archetype && ARCHETYPES.has(opts.archetype)) { filters.push('archetype = ?'); binds.push(opts.archetype); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { results } = await D.prepare(
    `SELECT * FROM boltbound_shared_deck ${where}
      ORDER BY copies DESC, views DESC, created_at DESC LIMIT 50`
  ).bind(...binds).all();
  const decks = (results || []).map(r => shapeRow(r, false));

  // Deck of the Day, most copies today; fall back to the all-time
  // most-copied if nothing has been copied yet today.
  let deckOfTheDay = null;
  const today = dayKey();
  const dotd = await D.prepare(
    `SELECT * FROM boltbound_shared_deck WHERE day_key = ? AND day_copies > 0
      ORDER BY day_copies DESC LIMIT 1`
  ).bind(today).first();
  if (dotd) deckOfTheDay = { ...shapeRow(dotd, false), dayCopies: Number(dotd.day_copies) || 0 };
  else if (decks.length && decks[0].copies > 0) deckOfTheDay = decks[0];

  return { ok: true, deckOfTheDay, decks };
}

// Fetch one shared deck (bumps views), returns the card list for import.
export async function getSharedDeck(env, id) {
  const sid = String(id || '').trim();
  if (!sid) return { ok: false, error: 'bad-id' };
  const r = await db(env).prepare('SELECT * FROM boltbound_shared_deck WHERE id = ?').bind(sid).first();
  if (!r) return { ok: false, error: 'not-found' };
  try { await db(env).prepare('UPDATE boltbound_shared_deck SET views = views + 1 WHERE id = ?').bind(sid).run(); } catch { /* noop */ }
  return { ok: true, deck: shapeRow(r, true) };
}

// Copy a deck, bumps the copy count (+ today's bucket) and returns the
// card list so the client can import / save it.
export async function copySharedDeck(env, id) {
  const sid = String(id || '').trim();
  if (!sid) return { ok: false, error: 'bad-id' };
  const r = await db(env).prepare('SELECT * FROM boltbound_shared_deck WHERE id = ?').bind(sid).first();
  if (!r) return { ok: false, error: 'not-found' };
  const today = dayKey();
  const dayCopies = (r.day_key === today ? (Number(r.day_copies) || 0) : 0) + 1;
  try {
    await db(env).prepare(
      'UPDATE boltbound_shared_deck SET copies = copies + 1, day_copies = ?, day_key = ? WHERE id = ?'
    ).bind(dayCopies, today, sid).run();
  } catch { /* noop */ }
  return { ok: true, deck: shapeRow(r, true) };
}
