// warden-mods.js — mod-team ACL + whoami (BE-1)
//
// warden_mods is the authorization list: one row per (streamer, mod) the
// streamer has authorized. A "broadcaster" is the streamer acting on their
// OWN channel (they must have a connected vault token); a "mod" is any
// other aquilo user with a warden_mods row.
//
// isAuthorized() is the single ACL gate every worker route re-checks
// server-side — the browser never supplies the ACL. whoami() enumerates
// the channels an actor may moderate for the console's streamer picker.
//
// Graceful-degrade: DB-less env → empty lists / false, never throws.

import { ensureSchema, now } from './warden-db.js';

const VAULT_KEY = (id) => `vault:tw:${id}`;

async function readVault(env, twitchId) {
  if (!env || !env.LOADOUT_BOLTS || !twitchId) return null;
  try {
    return await env.LOADOUT_BOLTS.get(VAULT_KEY(twitchId), { type: 'json' });
  } catch {
    return null;
  }
}

// A streamer is "connected" when they have a broadcaster token in the
// vault; "needsReconnect" when that token lacks the mod-manage scope
// (connected before the scopes were added).
const MANAGE_SCOPE = 'moderator:manage:banned_users';
function slotScopeSet(slot) {
  if (!slot) return new Set();
  const raw = slot.scope;
  if (Array.isArray(raw)) return new Set(raw.map(String));
  if (typeof raw === 'string') return new Set(raw.split(/\s+/).filter(Boolean));
  return new Set();
}
function vaultStatus(rec) {
  const slot = rec && rec.broadcaster;
  if (!slot || !slot.access_token) return { connected: false, needsReconnect: false };
  return { connected: true, needsReconnect: !slotScopeSet(slot).has(MANAGE_SCOPE) };
}

// isAuthorized(env, actorId, streamerId) -> { ok:true, role } | false
// broadcaster: actor === streamer AND they have a connected vault token.
// mod: an active warden_mods row (actor is a mod of streamer).
export async function isAuthorized(env, actorId, streamerId) {
  const a = String(actorId || '');
  const s = String(streamerId || '');
  if (!a || !s) return false;

  if (a === s) {
    const rec = await readVault(env, s);
    const st = vaultStatus(rec);
    if (st.connected) return { ok: true, role: 'broadcaster' };
    return false;
  }

  await ensureSchema(env);
  if (!env.DB) return false;
  try {
    const row = await env.DB
      .prepare(`SELECT status FROM warden_mods WHERE streamer_id = ? AND mod_id = ?`)
      .bind(s, a)
      .first();
    if (row && (row.status == null || row.status === 'active')) return { ok: true, role: 'mod' };
  } catch (e) {
    console.warn('[warden] isAuthorized', e?.message || e);
  }
  return false;
}

// whoami(env, actorId, actorLogin) -> { streamers:[{streamerId, login,
// display, role, connected, needsReconnect}] }
//   - own channel if the actor has a connected vault token (role broadcaster)
//   - every warden_mods row where mod_id = actor (role mod)
export async function whoami(env, actorId, actorLogin) {
  const a = String(actorId || '');
  const out = [];
  if (!a) return { streamers: out };

  // Own channel.
  const ownRec = await readVault(env, a);
  const ownStatus = vaultStatus(ownRec);
  if (ownStatus.connected) {
    out.push({
      streamerId: a,
      login: String((ownRec && ownRec.login) || actorLogin || '').toLowerCase(),
      display: String((ownRec && ownRec.display_name) || actorLogin || ''),
      role: 'broadcaster',
      connected: true,
      needsReconnect: ownStatus.needsReconnect,
    });
  }

  // Channels the actor mods.
  await ensureSchema(env);
  if (env.DB) {
    try {
      const res = await env.DB
        .prepare(`SELECT streamer_id FROM warden_mods WHERE mod_id = ? AND (status IS NULL OR status = 'active')`)
        .bind(a)
        .all();
      const rows = (res && res.results) || [];
      for (const r of rows) {
        const sid = String(r.streamer_id || '');
        if (!sid || sid === a) continue;   // own channel already added
        const rec = await readVault(env, sid);
        const st = vaultStatus(rec);
        out.push({
          streamerId: sid,
          login: String((rec && rec.login) || '').toLowerCase(),
          display: String((rec && rec.display_name) || sid),
          role: 'mod',
          connected: st.connected,
          needsReconnect: st.needsReconnect,
        });
      }
    } catch (e) {
      console.warn('[warden] whoami', e?.message || e);
    }
  }

  return { streamers: out };
}

// listMods(env, streamerId) -> { ok, mods:[{modId, login, addedBy,
// addedAt, connectedOwnToken}] }. connectedOwnToken tells the UI whether
// this mod acts with NATIVE attribution (own scoped token) or leans on
// the broadcaster token.
export async function listMods(env, streamerId) {
  const s = String(streamerId || '');
  await ensureSchema(env);
  if (!s || !env.DB) return { ok: true, mods: [] };
  try {
    const res = await env.DB
      .prepare(`SELECT mod_id, mod_login, added_by, added_at FROM warden_mods WHERE streamer_id = ? AND (status IS NULL OR status = 'active') ORDER BY added_at ASC`)
      .bind(s)
      .all();
    const rows = (res && res.results) || [];
    const mods = [];
    for (const r of rows) {
      const modId = String(r.mod_id || '');
      const rec = await readVault(env, modId);
      const connectedOwnToken = !!(rec && rec.broadcaster && slotScopeSet(rec.broadcaster).has(MANAGE_SCOPE));
      mods.push({
        modId,
        login: String(r.mod_login || (rec && rec.login) || ''),
        addedBy: String(r.added_by || ''),
        addedAt: Number(r.added_at || 0),
        connectedOwnToken,
      });
    }
    return { ok: true, mods };
  } catch (e) {
    console.warn('[warden] listMods', e?.message || e);
    return { ok: false, error: 'db-error', mods: [] };
  }
}

// addMod(env, streamerId, login, addedBy) -> { ok, mod } | { ok:false, error }
// Resolves the login → twitchId via Helix, then inserts (idempotent).
export async function addMod(env, streamerId, login, addedBy) {
  const s = String(streamerId || '');
  if (!s) return { ok: false, error: 'bad-streamer' };
  await ensureSchema(env);
  if (!env.DB) return { ok: false, error: 'no-db' };

  const { loginToId } = await import('./warden-twitch.js');
  const u = await loginToId(env, login);
  if (!u) return { ok: false, error: 'unknown-login' };
  if (u.id === s) return { ok: false, error: 'is-broadcaster' };

  try {
    await env.DB
      .prepare(`INSERT INTO warden_mods (streamer_id, mod_id, mod_login, added_by, added_at, status) VALUES (?, ?, ?, ?, ?, 'active') ON CONFLICT(streamer_id, mod_id) DO UPDATE SET mod_login = excluded.mod_login, status = 'active'`)
      .bind(s, u.id, u.login, String(addedBy || ''), now())
      .run();
    return { ok: true, mod: { modId: u.id, login: u.login, display: u.display } };
  } catch (e) {
    console.warn('[warden] addMod', e?.message || e);
    return { ok: false, error: 'db-error' };
  }
}

// removeMod(env, streamerId, modId) -> { ok }
// Tombstone (status='removed'), not DELETE: syncTwitchMods treats a
// tombstone as "the broadcaster explicitly kicked this person out of
// Warden" and won't resurrect them while they still hold the Twitch
// sword. A manual re-add via addMod flips them back to active.
export async function removeMod(env, streamerId, modId) {
  const s = String(streamerId || '');
  const m = String(modId || '');
  if (!s || !m) return { ok: false, error: 'bad-args' };
  await ensureSchema(env);
  if (!env.DB) return { ok: false, error: 'no-db' };
  try {
    await env.DB
      .prepare(`UPDATE warden_mods SET status = 'removed' WHERE streamer_id = ? AND mod_id = ?`)
      .bind(s, m)
      .run();
    return { ok: true };
  } catch (e) {
    console.warn('[warden] removeMod', e?.message || e);
    return { ok: false, error: 'db-error' };
  }
}

// ── syncTwitchMods (auto-detect) ──────────────────────────────────────
// Mirror the channel's REAL Twitch mod list (Helix Get Moderators, the
// broadcaster's vault token, requires the `moderation:read` scope) into
// warden_mods, so anyone the streamer mods on Twitch gets Warden access
// the moment they sign in to aquilo.gg — no manual add. Matching is
// exact: aquilo user ids ARE Twitch ids, and Helix returns user_id.
//
// Rules:
//   • Rows created here carry added_by='twitch-sync'. Twitch stays the
//     source of truth for them: lose the sword on Twitch → dropped here
//     on the next sync.
//   • Manually-added rows are never pruned; manual removals (status
//     'removed') are never resurrected by a sync.
//   • Background callers pass no `force` and are throttled via KV so
//     console opens don't hammer Helix; the Team tab's explicit "Sync
//     now" bypasses the throttle.
//   • Token lacks moderation:read (streamer connected before the scope
//     was added) → { ok:false, error:'scope-missing', needsReconnect }.
export async function syncTwitchMods(env, streamerId, { force = false } = {}) {
  const s = String(streamerId || '');
  if (!s) return { ok: false, error: 'bad-streamer' };
  await ensureSchema(env);
  if (!env.DB) return { ok: false, error: 'no-db' };

  const gate = `warden:modsync:${s}`;
  if (!force) {
    try {
      if (env.LOADOUT_BOLTS && (await env.LOADOUT_BOLTS.get(gate))) {
        return { ok: true, skipped: true };
      }
    } catch { /* KV read best-effort */ }
  }
  try {
    if (env.LOADOUT_BOLTS) await env.LOADOUT_BOLTS.put(gate, '1', { expirationTtl: 600 });
  } catch { /* KV write best-effort */ }

  const { vaultHelix } = await import('./warden-twitch.js');
  const found = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) { // 20 × 100 = 2000 mods, plenty
    const r = await vaultHelix(env, s, '/moderation/moderators', {
      params: { broadcaster_id: s, first: 100, ...(cursor ? { after: cursor } : {}) },
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        return { ok: false, error: 'scope-missing', needsReconnect: true };
      }
      return { ok: false, error: (r.data && r.data.error) || `helix-${r.status}` };
    }
    for (const m of (r.data && r.data.data) || []) {
      const id = String(m.user_id || '');
      if (id && id !== s) {
        found.push({ id, login: String(m.user_login || '').toLowerCase() });
      }
    }
    cursor = (r.data && r.data.pagination && r.data.pagination.cursor) || null;
    if (!cursor) break;
  }

  try {
    const cur = await env.DB
      .prepare(`SELECT mod_id, added_by, status FROM warden_mods WHERE streamer_id = ?`)
      .bind(s)
      .all();
    const rows = (cur && cur.results) || [];
    const byId = new Map(rows.map((r) => [String(r.mod_id), r]));
    const foundIds = new Set(found.map((m) => m.id));

    const stmts = [];
    let added = 0;
    for (const m of found) {
      const existing = byId.get(m.id);
      // Respect an explicit manual removal — the broadcaster kicked this
      // person out of Warden while keeping their Twitch sword.
      if (existing && existing.status === 'removed') continue;
      if (!existing) added++;
      stmts.push(
        env.DB
          .prepare(`INSERT INTO warden_mods (streamer_id, mod_id, mod_login, added_by, added_at, status) VALUES (?, ?, ?, ?, ?, 'active') ON CONFLICT(streamer_id, mod_id) DO UPDATE SET mod_login = excluded.mod_login, status = 'active'`)
          .bind(s, m.id, m.login, 'twitch-sync', now()),
      );
    }
    let removed = 0;
    for (const [id, row] of byId) {
      if (String(row.added_by || '') === 'twitch-sync' && !foundIds.has(id)) {
        removed++;
        stmts.push(
          env.DB.prepare(`DELETE FROM warden_mods WHERE streamer_id = ? AND mod_id = ?`).bind(s, id),
        );
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    return { ok: true, added, removed, total: found.length };
  } catch (e) {
    console.warn('[warden] syncTwitchMods', e?.message || e);
    return { ok: false, error: 'db-error' };
  }
}
