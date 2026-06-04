// Owner-only Twitch-panel test harness backend, POST /web/admin/panel-test.
//
// Lets Clay exercise every panel feature from /admin/twitch-panel-preview
// without being on a Twitch stream. Hard safety rules, enforced here:
//   1. ISOLATION, every write goes to a `test:*` KV key. This module never
//      touches live scratch / rotation / checkin / vote state.
//   2. DRY-RUN TAMPERS, a Streamer.bot tamper is only ever described
//      ("would fire: invert_mouse 30s"). It is never enqueued, so Clay's
//      keyboard / mouse / mic are never touched in test mode.
//   3. OWNER-ONLY, web.js gates this route on the _owner flag before we run.
//
// The rotation actions reuse the REAL resolver (resolveQuery / findClean /
// renderChatPreview), so Clay is testing the actual shipped code paths, just
// read-only (Spotify search + YouTube oEmbed are external reads, no writes).

import { json } from './ext-shared.js';
import {
  resolveQuery,
  findCleanVersion,
  getRotationConfig,
  renderChatPreview,
} from './rotation.js';
import { STREAMER_BOT_ACTIONS, LOSS_LINES, POOLS } from './scratch-challenges.js';

const LOG_KEY = 'test:eventlog';
const LOG_CAP = 60;
const TEST_PREFIX = 'test:';

async function logEvent(env, action, summary, detail) {
  try {
    const arr = (await env.LOADOUT_BOLTS.get(LOG_KEY, { type: 'json' })) || [];
    arr.push({ ts: Date.now(), action, summary: String(summary || action).slice(0, 200), detail: detail || null });
    if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
    await env.LOADOUT_BOLTS.put(LOG_KEY, JSON.stringify(arr), { expirationTtl: 86400 });
  } catch { /* log is best-effort */ }
}

function pickWeighted(rows) {
  const total = rows.reduce((s, r) => s + Math.max(1, r.weight || 1), 0);
  let n = Math.random() * total;
  for (const r of rows) { n -= Math.max(1, r.weight || 1); if (n <= 0) return r; }
  return rows[rows.length - 1];
}

function splitArtistTitleLoose(s) {
  const parts = String(s || '').split(/\s+[-\u2013\u2014]\s+/);
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return { artist: parts[0].trim(), song: parts[1].trim() };
  }
  return null;
}

export async function handlePanelTest(env, guildId, discordId, body) {
  const action = String(body.action || '');
  const viewer = {
    userId: String(body.viewerId || discordId || 'test-viewer').slice(0, 64),
    name: String(body.viewerName || 'Test Viewer').slice(0, 40),
  };

  // ----- Rotation: real Spotify resolve (read-only) -----
  if (action === 'rotation-search') {
    const q = String(body.q || '').slice(0, 300);
    const r = await resolveQuery(env, q);
    const tracks = (r.tracks || []).slice(0, 5);
    await logEvent(env, action, `search "${q}" -> ${tracks.length} tracks${r.viaYouTube ? ' (via YouTube)' : ''}`,
      tracks[0] ? tracks[0].name + ' - ' + tracks[0].artist : null);
    return json({ ok: true, action, viewer, viaYouTube: !!r.viaYouTube, tracks });
  }

  if (action === 'rotation-clean') {
    const q = String(body.q || '').slice(0, 300);
    const r = await resolveQuery(env, q);
    const top = (r.tracks || [])[0] || null;
    let clean = null;
    if (top && top.explicit) {
      const sp = splitArtistTitleLoose(top.artist ? top.artist + ' - ' + top.name : q);
      clean = await findCleanVersion(env, sp ? sp.artist : (top.artist || null), sp ? sp.song : top.name);
    }
    const summary = !top ? 'no match'
      : !top.explicit ? `"${top.name}" is already clean`
        : clean ? `explicit -> clean: "${clean.name}"` : 'explicit, no clean version found';
    await logEvent(env, action, summary, null);
    return json({ ok: true, action, viewer, top, clean, wouldQueue: clean || (top && !top.explicit ? top : null) });
  }

  if (action === 'rotation-cooldown') {
    const tier = String(body.tier || 'default');
    const cfg = await getRotationConfig(env);
    const ms = tier === 'mod' ? cfg.tierCooldownMs.mod
      : tier === 't3' ? cfg.tierCooldownMs.t3
        : tier === 't2' ? cfg.tierCooldownMs.t2
          : cfg.cooldownMs;
    const mins = Math.max(1, Math.ceil(ms / 60000));
    const preview = await renderChatPreview(env, 'cooldown', { user: viewer.name, mins });
    await logEvent(env, action, `${tier} cooldown = ${mins} min`, preview.message);
    return json({ ok: true, action, viewer, tier, cooldownMs: ms, cooldownMin: mins, chatPreview: preview.message });
  }

  if (action === 'rotation-chat') {
    const type = String(body.notifType || 'accepted');
    const vars = { user: viewer.name, track: body.track || 'Test Track', eta: body.eta || 3, mins: body.mins || 5, reason: body.reason || 'not found', by: ' (requested by @' + viewer.name + ')' };
    const preview = await renderChatPreview(env, type, vars);
    await logEvent(env, action, `chat dry-run [${type}]`, preview.message);
    return json({ ok: true, action, viewer, dryRun: true, ...preview });
  }

  // ----- Scratch-off: dry-run outcome, never writes D1, never fires tamper -----
  if (action === 'scratch-sim') {
    const gameSlug = String(body.gameSlug || 'generic');
    const force = String(body.force || ''); // '', 'win', 'loss'
    if (force === 'loss') {
      const line = LOSS_LINES[Math.floor(Math.random() * LOSS_LINES.length)];
      await logEvent(env, action, `[${gameSlug}] forced LOSS`, line);
      return json({ ok: true, action, viewer, result: 'loss', line });
    }
    const pool = POOLS[gameSlug] || POOLS.generic;
    const outcome = force === 'win'
      ? pickWeighted(pool.filter((o) => o.kind === 'tamper').length ? pool : pool)
      : pickWeighted(pool);
    const isTamper = outcome.kind === 'tamper';
    const tamper = isTamper
      ? { dryRun: true, wouldFire: outcome.actionKey, durationSec: outcome.durationSec, note: 'DRY RUN, not fired, your inputs are safe' }
      : null;
    await logEvent(env, action, `[${gameSlug}] ${outcome.kind}: ${outcome.body}`, isTamper ? `would fire ${outcome.actionKey} ${outcome.durationSec}s (dry run)` : null);
    return json({ ok: true, action, viewer, result: 'win', outcome: { kind: outcome.kind, body: outcome.body }, tamper });
  }

  if (action === 'tamper-dryrun') {
    const key = String(body.actionKey || '');
    const a = STREAMER_BOT_ACTIONS.find((x) => x.action_key === key) || STREAMER_BOT_ACTIONS[0];
    await logEvent(env, action, `tamper dry-run: ${a.action_key}`, `${a.action_name} ${a.default_duration_sec}s (DRY RUN)`);
    return json({ ok: true, action, viewer, dryRun: true, wouldFire: a.action_key, name: a.action_name, durationSec: a.default_duration_sec, registry: STREAMER_BOT_ACTIONS.map((x) => x.action_key), note: 'Dry run only, no Streamer.bot action enqueued.' });
  }

  // ----- Simulated panel events (synthetic payloads, no live writes) -----
  if (action === 'checkin-sim') {
    const evt = { kind: 'stream.checkin.test', user: viewer.name, userId: viewer.userId, ts: Date.now() };
    await logEvent(env, action, `check-in simulated for ${viewer.name}`, null);
    return json({ ok: true, action, viewer, dryRun: true, event: evt });
  }
  if (action === 'vote-sim') {
    const choice = String(body.choice || 'A').slice(0, 40);
    const key = TEST_PREFIX + 'vote-tally';
    const tally = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {};
    tally[choice] = (tally[choice] || 0) + 1;
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(tally), { expirationTtl: 86400 });
    await logEvent(env, action, `vote for "${choice}"`, JSON.stringify(tally));
    return json({ ok: true, action, viewer, choice, tally });
  }
  if (action === 'bits-sim') {
    const sku = String(body.sku || 'song_request');
    const bits = Math.max(0, Math.min(100000, parseInt(body.bits, 10) || 100));
    await logEvent(env, action, `bits txn sim: ${bits} bits (${sku})`, null);
    return json({ ok: true, action, viewer, dryRun: true, transaction: { sku, bits, transactionId: 'test-' + Math.random().toString(36).slice(2, 10) } });
  }

  // ----- Test context (isolated; does NOT change the live currentGame) -----
  if (action === 'set-game') {
    const slug = String(body.slug || '').slice(0, 60);
    await env.LOADOUT_BOLTS.put(TEST_PREFIX + 'currentGame', slug, { expirationTtl: 86400 });
    await logEvent(env, action, `test currentGame = ${slug}`, null);
    return json({ ok: true, action, currentGame: slug });
  }
  if (action === 'live-state') {
    const live = !!body.live;
    await env.LOADOUT_BOLTS.put(TEST_PREFIX + 'liveState', live ? '1' : '0', { expirationTtl: 86400 });
    await logEvent(env, action, `test live state = ${live}`, null);
    return json({ ok: true, action, live });
  }

  // ----- Observation -----
  if (action === 'state') {
    const [eventlog, currentGame, liveState, voteTally] = await Promise.all([
      env.LOADOUT_BOLTS.get(LOG_KEY, { type: 'json' }),
      env.LOADOUT_BOLTS.get(TEST_PREFIX + 'currentGame'),
      env.LOADOUT_BOLTS.get(TEST_PREFIX + 'liveState'),
      env.LOADOUT_BOLTS.get(TEST_PREFIX + 'vote-tally', { type: 'json' }),
    ]);
    // Live (read-only) rotation + scratch state for the inspector.
    const rotState = await env.LOADOUT_BOLTS.get('rot:state', { type: 'json' });
    return json({
      ok: true,
      action,
      test: {
        currentGame: currentGame || null,
        liveState: liveState === '1',
        voteTally: voteTally || {},
      },
      live: {
        rotation: rotState ? { nowPlaying: rotState.nowPlaying || null, queueLength: (rotState.queue || []).length } : null,
      },
      eventlog: Array.isArray(eventlog) ? eventlog.slice(-40).reverse() : [],
    });
  }

  if (action === 'clear') {
    let deleted = 0;
    let cursor;
    for (let i = 0; i < 10; i++) {
      const r = await env.LOADOUT_BOLTS.list({ prefix: TEST_PREFIX, cursor, limit: 1000 });
      for (const k of r.keys) { try { await env.LOADOUT_BOLTS.delete(k.name); deleted++; } catch { /* idle */ } }
      if (r.list_complete) break;
      cursor = r.cursor;
    }
    return json({ ok: true, action, deleted });
  }

  return json({ ok: false, error: 'unknown-action', action }, 400);
}
