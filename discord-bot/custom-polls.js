// Custom bot-managed polls. Discord's native polls cap at 10 options
// and don't support image embeds + per-option art; both of Clay's
// 2026-05-28 polls (Triple-C Series 23 games, Variety Night 12 games)
// blow that cap and want a composite art grid above the picker.
//
// Architecture:
//   • The poll is one Discord message: an embed (title / subtitle /
//     composite grid image / close-timestamp) + a STRING SELECT MENU
//     (up to 25 options) + a "View Standings" button.
//   • Votes go to KV `poll:<id>:vote:<userId>` → `<optionValue>`.
//     One vote per user; submitting again overwrites the prior pick.
//   • "View Standings" renders an ephemeral horizontal bar chart of
//     current tallies — keeps the public message clean.
//   • At close time (cron sweep) the select-menu is disabled, the
//     embed flips to "Voting closed — winner …", and a follow-up
//     celebratory embed posts the winning game with full art.
//
// KV layout:
//   poll:<id>                    → JSON { channelId, messageId,
//                                        title, subtitle, optionCount,
//                                        compositeKey, closeAt, status,
//                                        options:[{value, label}],
//                                        followUpMessageId? }
//   poll:<id>:vote:<userId>      → option value (string), per-vote
//   poll:<id>:tally              → JSON { [value]: count } — rebuilt
//                                        lazily on read; not the source
//                                        of truth (votes are)
//
// Composite art is served by worker.js GET /asset/poll-composite/:id
// from KV `poll-composite:<id>` — built locally by build-poll-composite.py
// and pre-uploaded.

const RESP_CHAT          = 4;
const RESP_DEFER_UPDATE  = 6;
const RESP_UPDATE_MSG    = 7;
const FLAG_EPHEMERAL     = 64;

const COMP_ROW           = 1;
const COMP_BUTTON        = 2;
const COMP_STRING_SELECT = 3;
const STYLE_PRIMARY      = 1;
const STYLE_SECONDARY    = 2;
const STYLE_DANGER       = 4;

const POLL_KEY   = (id) => `poll:${id}`;
const VOTE_KEY   = (id, userId) => `poll:${id}:vote:${userId}`;
const TALLY_KEY  = (id) => `poll:${id}:tally`;

const ASSET_BASE = 'https://loadout-discord.aquiloplays.workers.dev/asset/poll-composite';

// Brand violet — header stripe matches the gradient banners.
const COLOR_OPEN     = 0x7c5cff;
const COLOR_CLOSED   = 0x6e7588;
const COLOR_WINNER   = 0x5bff95;

// ── Discord REST wrappers ───────────────────────────────────────

async function dapi(env, method, path, body) {
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord custom-polls',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* no body */ }
  return { ok: r.ok, status: r.status, body: parsed };
}

// ── Message builders ────────────────────────────────────────────

function buildOpenEmbed(state) {
  return {
    title: state.title,
    description: [
      state.subtitle,
      '',
      `Voting closes <t:${state.closeAt}:F> (<t:${state.closeAt}:R>).`,
      `Tap the select menu below to lock in your vote — change anytime until close.`,
    ].join('\n'),
    image: { url: `${ASSET_BASE}/${state.compositeKey}.png?v=${state.version || 1}` },
    color: COLOR_OPEN,
    footer: { text: `${state.options.length} options · one vote per person · view standings anytime` },
  };
}

function buildClosedEmbed(state, winner) {
  const winnerLabel = winner ? winner.label : '(no votes)';
  return {
    title: state.title + ' — closed',
    description: [
      state.subtitle,
      '',
      `Voting closed <t:${state.closeAt}:R>.`,
      '',
      winner
        ? `🏆 **Winner: ${winnerLabel}** with **${winner.count}** vote${winner.count === 1 ? '' : 's'}.`
        : '_No votes were cast._',
    ].join('\n'),
    image: { url: `${ASSET_BASE}/${state.compositeKey}.png?v=${state.version || 1}` },
    color: COLOR_CLOSED,
    footer: { text: 'Final tally posted as a follow-up below.' },
  };
}

function buildOptionRows(state, disabled) {
  // Discord caps string-select at 25 options; both polls fit.
  return [{
    type: COMP_ROW,
    components: [{
      type: COMP_STRING_SELECT,
      custom_id: `poll:vote:${state.id}`,
      placeholder: disabled ? 'Voting is closed' : 'Pick your vote…',
      min_values: 1,
      max_values: 1,
      disabled: !!disabled,
      options: state.options.slice(0, 25).map(o => ({
        label: String(o.label).slice(0, 100),
        value: String(o.value).slice(0, 100),
      })),
    }],
  }, {
    type: COMP_ROW,
    components: [{
      type: COMP_BUTTON,
      style: STYLE_SECONDARY,
      label: '📊 View standings',
      custom_id: `poll:standings:${state.id}`,
      disabled: false,   // standings stay viewable even after close
    }],
  }];
}

// ── Vote storage ────────────────────────────────────────────────

async function readState(env, pollId) {
  try {
    return await env.LOADOUT_BOLTS.get(POLL_KEY(pollId), { type: 'json' });
  } catch { return null; }
}

async function writeState(env, pollId, state) {
  await env.LOADOUT_BOLTS.put(POLL_KEY(pollId), JSON.stringify(state));
}

async function recordVote(env, pollId, userId, value) {
  await env.LOADOUT_BOLTS.put(VOTE_KEY(pollId, userId), value);
  // Invalidate the cached tally; next standings read will rebuild.
  try { await env.LOADOUT_BOLTS.delete(TALLY_KEY(pollId)); } catch { /* ignore */ }
}

// Walk all `poll:<id>:vote:*` keys and return a tally map. Cached
// briefly at `poll:<id>:tally` so a flurry of standings views during
// active voting doesn't list-walk KV every time.
async function computeTally(env, pollId) {
  // Try cache first.
  try {
    const cached = await env.LOADOUT_BOLTS.get(TALLY_KEY(pollId), { type: 'json' });
    if (cached && typeof cached === 'object') return cached;
  } catch { /* fall through */ }
  const tally = Object.create(null);
  let cursor = undefined;
  for (let page = 0; page < 20; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: `poll:${pollId}:vote:`, cursor, limit: 1000 });
    for (const k of r.keys) {
      const v = await env.LOADOUT_BOLTS.get(k.name);
      if (!v) continue;
      tally[v] = (tally[v] || 0) + 1;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  // Cache for 60s — votes are not a tight loop and the cache busts on
  // any new vote via recordVote().
  try { await env.LOADOUT_BOLTS.put(TALLY_KEY(pollId), JSON.stringify(tally), { expirationTtl: 60 }); }
  catch { /* ignore */ }
  return tally;
}

// ── Public: poll creation ───────────────────────────────────────
//
// Caller (worker.js admin route) supplies the full option list +
// composite key + close timestamp. Returns { ok, pollId, messageId,
// channelId }.
export async function createPoll(env, opts) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const channelId = String(opts.channelId || '').trim();
  if (!/^\d{15,25}$/.test(channelId)) return { ok: false, error: 'bad-channel-id' };
  const pollId = String(opts.pollId || '').trim();
  if (!/^[a-z0-9_-]{2,40}$/.test(pollId)) return { ok: false, error: 'bad-poll-id' };
  if (!Array.isArray(opts.options) || opts.options.length < 2 || opts.options.length > 25) {
    return { ok: false, error: 'bad-options' };
  }
  // Reject re-create when there's already a live message — caller can
  // pass `replace: true` to delete the old one first.
  const prior = await readState(env, pollId);
  if (prior?.messageId && prior?.channelId && !opts.replace) {
    return { ok: false, error: 'poll-exists', priorMessageId: prior.messageId };
  }
  if (prior && opts.replace) {
    await dapi(env, 'DELETE',
      `/channels/${prior.channelId}/messages/${prior.messageId}`).catch(() => {});
  }
  const state = {
    id:           pollId,
    channelId,
    title:        String(opts.title || 'Poll').slice(0, 200),
    subtitle:     String(opts.subtitle || '').slice(0, 600),
    closeAt:      Number(opts.closeAt) || 0,
    compositeKey: String(opts.compositeKey || pollId),
    options:      opts.options.map(o => ({
      value: String(o.value).slice(0, 100),
      label: String(o.label).slice(0, 100),
    })),
    version:      Number(opts.version) || 1,
    status:       'open',
  };
  const payload = {
    embeds:     [buildOpenEmbed(state)],
    components: buildOptionRows(state, false),
    allowed_mentions: { parse: [] },
  };
  const post = await dapi(env, 'POST', `/channels/${channelId}/messages`, payload);
  if (!post.ok || !post.body?.id) {
    return { ok: false, error: 'post-failed', status: post.status, body: post.body };
  }
  state.messageId = post.body.id;
  await writeState(env, pollId, state);
  return { ok: true, pollId, channelId, messageId: state.messageId };
}

// ── Public: select-menu vote handler ────────────────────────────
//
// custom_id format: `poll:vote:<pollId>`.  data.values is the single
// picked option. ACK with an ephemeral confirmation; the public
// message is NOT mutated (we keep the embed stable; users see
// updated standings via the button).
export async function handlePollVote(data, env) {
  const customId = data.data?.custom_id || '';
  const pollId   = customId.split(':')[2];
  const choice   = String(data.data?.values?.[0] || '').trim();
  const userId   = data.member?.user?.id || data.user?.id;
  if (!pollId || !choice || !userId) {
    return { type: RESP_CHAT, data: { content: 'Bad vote — missing data.', flags: FLAG_EPHEMERAL } };
  }
  const state = await readState(env, pollId);
  if (!state) {
    return { type: RESP_CHAT, data: { content: 'This poll is gone.', flags: FLAG_EPHEMERAL } };
  }
  if (state.status === 'closed') {
    return { type: RESP_CHAT, data: { content: 'Voting is closed.', flags: FLAG_EPHEMERAL } };
  }
  const opt = state.options.find(o => o.value === choice);
  if (!opt) {
    return { type: RESP_CHAT, data: { content: `Unknown choice: \`${choice}\``, flags: FLAG_EPHEMERAL } };
  }
  // Detect change vs first-time vote so the confirmation can flag the change.
  let prior = null;
  try { prior = await env.LOADOUT_BOLTS.get(VOTE_KEY(pollId, userId)); } catch { /* ignore */ }
  await recordVote(env, pollId, userId, opt.value);
  const isChange = prior && prior !== opt.value;
  const lines = [
    isChange
      ? `🗳️ Vote updated → **${opt.label}**`
      : `🗳️ Vote locked in → **${opt.label}**`,
    `Change any time before <t:${state.closeAt}:R>.`,
  ];
  return { type: RESP_CHAT, data: { content: lines.join('\n'), flags: FLAG_EPHEMERAL } };
}

// ── Public: "View standings" button handler ─────────────────────
//
// Ephemeral horizontal-bar chart using ASCII block runs. Sorted by
// vote count desc; ties resolved by alphabetical option label.
export async function handlePollStandings(data, env) {
  const customId = data.data?.custom_id || '';
  const pollId   = customId.split(':')[2];
  if (!pollId) {
    return { type: RESP_CHAT, data: { content: 'Bad button.', flags: FLAG_EPHEMERAL } };
  }
  const state = await readState(env, pollId);
  if (!state) {
    return { type: RESP_CHAT, data: { content: 'This poll is gone.', flags: FLAG_EPHEMERAL } };
  }
  const tally = await computeTally(env, pollId);
  const total = Object.values(tally).reduce((a, b) => a + Number(b || 0), 0);
  // Build the rows.
  const rows = state.options.map(o => ({
    label: o.label,
    count: Number(tally[o.value] || 0),
  })).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.label).localeCompare(String(b.label));
  });
  const max = rows[0]?.count || 0;
  const BAR_WIDTH = 16;
  const lines = [`**Standings — ${state.title}**`, `Total votes: **${total}**`, ''];
  for (const r of rows) {
    const filled = max > 0 ? Math.round((r.count / max) * BAR_WIDTH) : 0;
    const bar = '█'.repeat(filled) + '·'.repeat(BAR_WIDTH - filled);
    const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
    lines.push(`\`${bar}\` **${r.count.toString().padStart(3)}** (${pct}%) ${r.label}`);
  }
  lines.push('');
  lines.push(state.status === 'closed'
    ? '_Voting closed._'
    : `_Voting closes <t:${state.closeAt}:R>._`);
  return {
    type: RESP_CHAT,
    data: {
      content: lines.join('\n').slice(0, 1990),
      flags: FLAG_EPHEMERAL,
    },
  };
}

// ── Close logic ─────────────────────────────────────────────────
//
// Called by cron. Locks the menu, edits the original embed, posts
// a celebratory follow-up with the winner's name + art (the same
// composite, the embed already has it).

export async function closePollIfDue(env, pollId) {
  const state = await readState(env, pollId);
  if (!state) return { ok: false, error: 'no-such-poll', pollId };
  if (state.status === 'closed') return { ok: true, action: 'already-closed', pollId };
  if (!state.closeAt || Date.now() / 1000 < state.closeAt) {
    return { ok: true, action: 'not-due', pollId, untilSec: state.closeAt - Math.floor(Date.now() / 1000) };
  }
  return await closePollNow(env, pollId);
}

export async function closePollNow(env, pollId) {
  const state = await readState(env, pollId);
  if (!state) return { ok: false, error: 'no-such-poll', pollId };
  const tally = await computeTally(env, pollId);
  // Pick the winner — highest count; ties broken by first appearance in options.
  let winner = null;
  for (const o of state.options) {
    const count = Number(tally[o.value] || 0);
    if (!winner || count > winner.count) winner = { ...o, count };
  }
  if (winner && winner.count === 0) winner = null;
  // PATCH the original message — disable menu + flip embed to closed.
  state.status = 'closed';
  await dapi(env, 'PATCH',
    `/channels/${state.channelId}/messages/${state.messageId}`, {
      embeds:     [buildClosedEmbed(state, winner)],
      components: buildOptionRows(state, true),
      allowed_mentions: { parse: [] },
    }).catch(() => { /* ignore — we still want to save state */ });
  // Follow-up celebratory embed.
  if (winner) {
    const followUp = await dapi(env, 'POST',
      `/channels/${state.channelId}/messages`, {
        embeds: [{
          title: '🏆 Winner: ' + winner.label,
          description: `**${winner.label}** wins **${state.title}** with **${winner.count}** vote${winner.count === 1 ? '' : 's'}.`,
          color: COLOR_WINNER,
          image: { url: `${ASSET_BASE}/${state.compositeKey}.png?v=${state.version || 1}` },
          footer: { text: 'Queued into the schedule for the next slot of this series.' },
        }],
        allowed_mentions: { parse: [] },
      });
    if (followUp.ok && followUp.body?.id) state.followUpMessageId = followUp.body.id;
  }
  await writeState(env, pollId, state);
  return { ok: true, action: 'closed', pollId, winner };
}

// ── Admin: list / detail / mutate ───────────────────────────────
//
// Used by the PWA admin UI via /web/admin/polls* routes. Read-only
// helpers are cheap; mutators (lock/extend/cancel) carry the same
// auth as the original create.

// List every active + closed poll. Returns a summary array sorted by
// closeAt desc (newest first), capped at 50 — the catalogue is small.
export async function adminListPolls(env) {
  const out = [];
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'poll:', cursor, limit: 200 });
    for (const k of r.keys) {
      // Only top-level `poll:<id>` JSON docs; skip vote/tally sub-keys.
      if (k.name.split(':').length !== 2) continue;
      const id = k.name.slice('poll:'.length);
      const state = await readState(env, id);
      if (!state) continue;
      const tally = await computeTally(env, id);
      const totalVotes = Object.values(tally).reduce((a, b) => a + Number(b || 0), 0);
      out.push({
        id,
        title:        state.title,
        subtitle:     state.subtitle,
        status:       state.status,
        channelId:    state.channelId,
        messageId:    state.messageId,
        closeAt:      state.closeAt,
        optionCount:  Array.isArray(state.options) ? state.options.length : 0,
        totalVotes,
      });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  out.sort((a, b) => (b.closeAt || 0) - (a.closeAt || 0));
  return { ok: true, polls: out.slice(0, 50) };
}

// Detail — full state + per-option tally + voter list. Voter list is
// the canonical `{userId, choice, ts}` shape; ordering is KV-list
// insertion order (effectively most-recent-first by KV traversal).
// Cap voter list at 5000 — enough for any single-poll audit.
export async function adminPollDetail(env, pollId) {
  const state = await readState(env, pollId);
  if (!state) return { ok: false, error: 'no-such-poll', pollId };
  const tally = await computeTally(env, pollId);
  const voters = [];
  let cursor = undefined;
  for (let page = 0; page < 6; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: `poll:${pollId}:vote:`, cursor, limit: 1000 });
    for (const k of r.keys) {
      const userId = k.name.slice(`poll:${pollId}:vote:`.length);
      const choice = await env.LOADOUT_BOLTS.get(k.name);
      if (choice) voters.push({ userId, choice });
      if (voters.length >= 5000) break;
    }
    if (r.list_complete || voters.length >= 5000) break;
    cursor = r.cursor;
  }
  return { ok: true, poll: state, tally, voters };
}

// Lock — closes voting immediately. Reuses closePollNow (which
// handles the embed PATCH + winner-announce follow-up).
export async function adminLockPoll(env, pollId) {
  const state = await readState(env, pollId);
  if (!state) return { ok: false, error: 'no-such-poll', pollId };
  if (state.status === 'closed' || state.status === 'cancelled') {
    return { ok: true, action: 'already-' + state.status, pollId };
  }
  return await closePollNow(env, pollId);
}

// Extend — push closeAt by `hours` (positive). PATCHes the public
// embed so the new close time appears immediately.
export async function adminExtendPoll(env, pollId, hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) {
    return { ok: false, error: 'bad-hours', hours };
  }
  const state = await readState(env, pollId);
  if (!state) return { ok: false, error: 'no-such-poll', pollId };
  if (state.status !== 'open') {
    return { ok: false, error: 'not-open', status: state.status };
  }
  state.closeAt = (state.closeAt || Math.floor(Date.now() / 1000)) + Math.floor(h * 3600);
  await writeState(env, pollId, state);
  // Refresh the embed so the new close timestamp shows.
  await dapi(env, 'PATCH',
    `/channels/${state.channelId}/messages/${state.messageId}`, {
      embeds:     [buildOpenEmbed(state)],
      components: buildOptionRows(state, false),
      allowed_mentions: { parse: [] },
    }).catch(() => { /* tolerate edit failure */ });
  return { ok: true, action: 'extended', pollId, newCloseAt: state.closeAt };
}

// Cancel — mark as cancelled (NOT closed; no winner declared), lock
// the menu, replace the embed body with a "cancelled" message.
export async function adminCancelPoll(env, pollId, reason) {
  const state = await readState(env, pollId);
  if (!state) return { ok: false, error: 'no-such-poll', pollId };
  if (state.status === 'cancelled') return { ok: true, action: 'already-cancelled', pollId };
  state.status = 'cancelled';
  const cancelEmbed = {
    title: state.title + ' — cancelled',
    description: [
      state.subtitle,
      '',
      '_This poll was cancelled — no winner declared._',
      reason ? `\nReason: ${String(reason).slice(0, 300)}` : '',
    ].join('\n'),
    image: { url: `${ASSET_BASE}/${state.compositeKey}.png?v=${state.version || 1}` },
    color: COLOR_CLOSED,
  };
  await dapi(env, 'PATCH',
    `/channels/${state.channelId}/messages/${state.messageId}`, {
      embeds:     [cancelEmbed],
      components: buildOptionRows(state, true),
      allowed_mentions: { parse: [] },
    }).catch(() => { /* ignore */ });
  await writeState(env, pollId, state);
  return { ok: true, action: 'cancelled', pollId };
}

// ── Cron: sweep all open polls and close any past close time ───
//
// Lists every `poll:*` JSON key (cheap — small N), reads its status,
// closes any whose closeAt has elapsed. Idempotent: re-running on a
// fully-closed catalogue is a no-op.
export async function pollsCronSweep(env) {
  const out = { swept: 0, closed: 0, skipped: 0, errors: [] };
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'poll:', cursor, limit: 200 });
    for (const k of r.keys) {
      // Skip vote / tally sub-keys; only top-level `poll:<id>` JSON docs.
      if (k.name.split(':').length !== 2) continue;
      const pollId = k.name.slice('poll:'.length);
      out.swept++;
      try {
        const r2 = await closePollIfDue(env, pollId);
        if (r2.action === 'closed') out.closed++;
        else out.skipped++;
      } catch (e) {
        out.errors.push({ pollId, error: e?.message || String(e) });
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return out;
}

// ── Public catalogues — the two polls Clay specified ───────────
//
// Exported so the admin route can post both with a single call.

export const TRIPLE_C_POLL = Object.freeze({
  pollId:       'triple-c-2026-05',
  title:        'Triple-C Series — pick the game',
  subtitle:     'Vote for the next game in the Triple-C Series. Streams Sun · Mon · Tue · Thu.',
  compositeKey: 'triple-c',
  options: [
    { value: 'fallout4',        label: 'Fallout 4' },
    { value: 'eldenring',       label: 'Elden Ring' },
    { value: 'skyrim_se',       label: 'Skyrim (Special Edition)' },
    { value: 'borderlands2',    label: 'Borderlands 2' },
    { value: 'borderlands3',    label: 'Borderlands 3' },
    { value: 'witcher3',        label: 'The Witcher 3' },
    { value: 'cyberpunk2077',   label: 'Cyberpunk 2077' },
    { value: 're_series',       label: 'Resident Evil 2 - 7 (series)' },
    { value: 'mgs_delta',       label: 'Metal Gear Solid DELTA' },
    { value: 'minecraft',       label: 'Minecraft (beat the ender dragon)' },
    { value: 'baby_steps',      label: 'Baby Steps' },
    { value: 'hades',           label: 'HADES' },
    { value: 'hollow_knight',   label: 'Hollow Knight' },
    { value: 'silksong',        label: 'Hollow Knight: Silksong' },
    { value: 'kcd2',            label: 'Kingdom Come: Deliverance 2' },
    { value: 'blue_prince',     label: 'Blue Prince' },
    { value: 'bg3',             label: "Baldur's Gate 3" },
    { value: 'dredge',          label: 'DREDGE' },
    { value: 'stardew',         label: 'Stardew Valley' },
    { value: 'celeste',         label: 'Celeste' },
    { value: 'cult_lamb',       label: 'Cult of the Lamb' },
    { value: 'rdr2',            label: 'Red Dead Redemption 2' },
    { value: 'isaac',           label: 'The Binding of Isaac' },
  ],
});

export const VARIETY_POLL = Object.freeze({
  pollId:       'variety-2026-05',
  title:        'Variety Night — pick the game',
  subtitle:     'Vote for the next Variety Night game. Streams Wed. CC icon = Crowd Control supported (crowdcontrol.live).',
  compositeKey: 'variety',
  // 2026-06 (Batch C3): reconciled to the 9-game Variety pool, matching
  // games:v1. Retro Rewind moved to Dad Game Sunday (C2); the sim/cozy
  // titles that used to live here (waterpark, paralives, supermarket,
  // pws2, hf2, roadside) are dad-sunday games now and were removed from
  // variety. Added Burgie's Cozy Kitchen. (CC) = Crowd Control supported.
  options: [
    { value: 'climbing',         label: 'A Difficult Game About Climbing' },
    { value: 'ballxpit',         label: 'BALL x PIT' },
    { value: 'megabonk',         label: 'Megabonk (CC)' },
    { value: 'flip_master',      label: 'Flip Master' },
    { value: 'sts2',             label: 'Slay the Spire 2 (CC)' },
    { value: 'cloverpit',        label: 'CloverPit' },
    { value: 'balatro',          label: 'Balatro' },
    { value: 'vampire_crawlers', label: 'Vampire Crawlers (CC)' },
    { value: 'burgie',           label: "Burgie's Cozy Kitchen" },
    { value: 'everything_crab',  label: 'Everything is Crab' },
    { value: 'egging_on',        label: 'Egging On' },
  ],
});
