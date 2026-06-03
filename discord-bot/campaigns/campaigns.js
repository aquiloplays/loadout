// AI-driven D&D-style one-shot campaigns (Item 4 from Clay 2026-05-28).
//
// Slash surface (registered in commands-spec.js):
//   /campaign start   invite1 invite2? invite3?
//   /campaign action  text:<player action>
//   /campaign status
//   /campaign end
//
// Component dispatch: handleCampaignComponent in dispatcher map for
//   campaign:accept:<sessionId>
//   campaign:decline:<sessionId>
//
// Architecture choices:
//   • D1 table campaign_sessions (schema.sql) — one row per session
//   • State machine: forming → active → (paused | complete | abandoned)
//   • DM-group creation isn't possible for bots, so the spec's "shared
//     DM group" lands as ephemeral-only narration in v1 — every party
//     member runs /campaign action and gets the next beat as their
//     own ephemeral. v2 can upgrade to an auto-created private channel
//     under a Campaigns category when channel-provisioning lands.
//   • Token budget tracked per session; calls refuse to fire once
//     cost_cents >= cost_cap_cents (default $2).

import { generateBeat, buildSystemPrompt, formatCharacter, estimateCostCents } from './ai-gm.js';
import { PREMISES, pickPremise, premiseById } from './premises.js';

const FLAG_EPHEMERAL = 64;
const RESP_CHAT      = 4;
const RESP_UPDATE_MSG = 7;

const STATUS = Object.freeze({
  FORMING:   'forming',
  ACTIVE:    'active',
  PAUSED:    'paused',
  COMPLETE:  'complete',
  ABANDONED: 'abandoned',
});

// ── D1 helpers ──────────────────────────────────────────────────────

async function ensureSchema(env) {
  // Best-effort idempotent create. Each call no-ops after the first
  // CREATE TABLE IF NOT EXISTS succeeds. Wrapped in a try so a transient
  // D1 error doesn't break the slash-command path.
  if (!env.DB) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS campaign_sessions (
        id                  TEXT PRIMARY KEY,
        guild_id            TEXT NOT NULL,
        starter_user_id     TEXT NOT NULL,
        invited_user_ids    TEXT NOT NULL DEFAULT '[]',
        accepted_user_ids   TEXT NOT NULL DEFAULT '[]',
        declined_user_ids   TEXT NOT NULL DEFAULT '[]',
        status              TEXT NOT NULL,
        channel_id          TEXT,
        premise_id          TEXT,
        history             TEXT NOT NULL DEFAULT '[]',
        tokens_in           INTEGER NOT NULL DEFAULT 0,
        tokens_out          INTEGER NOT NULL DEFAULT 0,
        cost_cents          INTEGER NOT NULL DEFAULT 0,
        cost_cap_cents      INTEGER NOT NULL DEFAULT 200,
        started_at          TEXT NOT NULL DEFAULT (datetime('now')),
        last_beat_at        TEXT,
        completed_at        TEXT
      )
    `).run();
  } catch (e) {
    console.warn('[campaigns] schema ensure failed', e?.message || e);
  }
}

function newSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback. Shouldn't happen in CF Workers (crypto.randomUUID is always there).
  return 'cmp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function loadSession(env, id) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM campaign_sessions WHERE id = ?`
  ).bind(id).first();
  if (!row) return null;
  return decodeSession(row);
}

async function loadActiveSessionForUser(env, guildId, userId) {
  if (!env.DB) return null;
  // Find any session this user is in (as starter, invitee, or accepted)
  // that isn't complete/abandoned. We can't SQL-search JSON arrays
  // efficiently in D1 (no JSON1 here) so we fetch recent guild sessions
  // and filter in JS. Capped at 20 to keep this cheap.
  const { results } = await env.DB.prepare(
    `SELECT * FROM campaign_sessions
     WHERE guild_id = ? AND status NOT IN ('complete', 'abandoned')
     ORDER BY datetime(started_at) DESC
     LIMIT 20`
  ).bind(guildId).all();
  for (const row of (results || [])) {
    const s = decodeSession(row);
    if (s.starterUserId === userId
        || s.invitedUserIds.includes(userId)
        || s.acceptedUserIds.includes(userId)) {
      return s;
    }
  }
  return null;
}

function decodeSession(row) {
  return {
    id:                row.id,
    guildId:           row.guild_id,
    starterUserId:     row.starter_user_id,
    invitedUserIds:    safeJsonArray(row.invited_user_ids),
    acceptedUserIds:   safeJsonArray(row.accepted_user_ids),
    declinedUserIds:   safeJsonArray(row.declined_user_ids),
    status:            row.status,
    channelId:         row.channel_id || null,
    premiseId:         row.premise_id || null,
    history:           safeJsonArray(row.history),
    tokensIn:          row.tokens_in || 0,
    tokensOut:         row.tokens_out || 0,
    costCents:         row.cost_cents || 0,
    costCapCents:      row.cost_cap_cents || 200,
    startedAt:         row.started_at,
    lastBeatAt:        row.last_beat_at,
    completedAt:       row.completed_at,
  };
}

function safeJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

async function saveSession(env, s) {
  if (!env.DB) return;
  await env.DB.prepare(
    `UPDATE campaign_sessions
     SET invited_user_ids = ?, accepted_user_ids = ?, declined_user_ids = ?,
         status = ?, channel_id = ?, premise_id = ?, history = ?,
         tokens_in = ?, tokens_out = ?, cost_cents = ?,
         last_beat_at = ?, completed_at = ?
     WHERE id = ?`
  ).bind(
    JSON.stringify(s.invitedUserIds), JSON.stringify(s.acceptedUserIds),
    JSON.stringify(s.declinedUserIds),
    s.status, s.channelId, s.premiseId, JSON.stringify(s.history),
    s.tokensIn, s.tokensOut, s.costCents,
    s.lastBeatAt, s.completedAt,
    s.id,
  ).run();
}

async function insertSession(env, s) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO campaign_sessions (
      id, guild_id, starter_user_id, invited_user_ids, accepted_user_ids,
      declined_user_ids, status, channel_id, premise_id, history,
      tokens_in, tokens_out, cost_cents, cost_cap_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    s.id, s.guildId, s.starterUserId,
    JSON.stringify(s.invitedUserIds), JSON.stringify(s.acceptedUserIds),
    JSON.stringify(s.declinedUserIds), s.status, s.channelId,
    s.premiseId, JSON.stringify(s.history),
    s.tokensIn, s.tokensOut, s.costCents, s.costCapCents,
  ).run();
}

// ── Helpers ─────────────────────────────────────────────────────────

function ephemeral(content, extra = {}) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL, ...extra } };
}

function pretty(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

async function fetchDisplayName(env, guildId, userId) {
  try {
    const r = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } });
    if (!r.ok) return userId;
    const m = await r.json();
    return m?.nick || m?.user?.global_name || m?.user?.username || userId;
  } catch { return userId; }
}

async function buildPartyBlob(env, guildId, userIds) {
  const { loadHero } = await import('../hero-state.js');
  const lines = [];
  for (const uid of userIds) {
    const [hero, name] = await Promise.all([
      loadHero(env, guildId, uid).catch(() => null),
      fetchDisplayName(env, guildId, uid),
    ]);
    lines.push(formatCharacter(uid, name, hero));
  }
  return lines.join('\n\n');
}

// ── Slash commands ──────────────────────────────────────────────────

// /campaign start — initiates a new session with 1-3 invitees.
// Slash spec lives in commands-spec.js; this just consumes the
// parsed options.
export async function handleCampaignStart(env, data) {
  await ensureSchema(env);

  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  if (!guildId || !userId) return ephemeral('Run this in a server.');

  // Read invited user IDs from slash options. Discord USER-typed
  // options come as snowflake strings under options.value.
  const opts = data.data?.options || [];
  const subOpts = (opts.find(o => o.name === 'start')?.options) || [];
  const inviteIds = subOpts
    .filter(o => o.name?.startsWith('invite') && o.type === 6 /* USER */)
    .map(o => String(o.value))
    .filter(id => id && id !== userId);

  // Cap at 3 invitees (party of 4 total including the starter).
  if (inviteIds.length === 0) {
    return ephemeral('Invite at least one other player. `/campaign start invite1:@user [invite2:@user] [invite3:@user]`');
  }
  if (inviteIds.length > 3) inviteIds.length = 3;

  // Refuse if the starter is already in an active session — keep
  // things simple for v1, one campaign per starter at a time.
  const existing = await loadActiveSessionForUser(env, guildId, userId);
  if (existing) {
    return ephemeral(`You already have an active campaign (id \`${existing.id.slice(0, 8)}\`, status: ${existing.status}). Use \`/campaign status\` to check it, or \`/campaign end\` to abandon.`);
  }

  const session = {
    id: newSessionId(),
    guildId,
    starterUserId:   userId,
    invitedUserIds:  inviteIds.slice(),
    acceptedUserIds: [userId],  // starter implicitly accepts
    declinedUserIds: [],
    status:          STATUS.FORMING,
    channelId:       null,
    premiseId:       null,
    history:         [],
    tokensIn:        0,
    tokensOut:       0,
    costCents:       0,
    costCapCents:    200,
    lastBeatAt:      null,
    completedAt:     null,
  };
  await insertSession(env, session);

  const mentions = inviteIds.map(id => `<@${id}>`).join(' ');
  const lines = [
    `🎲 **Campaign forming.** Starter <@${userId}>.`,
    `Invitees: ${mentions}`,
    '',
    `Accept by clicking the button below within 10 minutes. When all invitees accept, the GM opens the curtain. Session id \`${session.id.slice(0, 8)}\`.`,
  ];
  return {
    type: RESP_CHAT,
    data: {
      content: lines.join('\n'),
      allowed_mentions: { parse: [], users: inviteIds },
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Accept',  custom_id: `campaign:accept:${session.id}` },
          { type: 2, style: 4, label: 'Decline', custom_id: `campaign:decline:${session.id}` },
        ],
      }],
    },
  };
}

// Component handler — accept / decline buttons.
export async function handleCampaignComponent(env, data) {
  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');

  const cid = data.data?.custom_id || '';
  const m = cid.match(/^campaign:(accept|decline):(.+)$/);
  if (!m) return ephemeral('Bad campaign button.');
  const action = m[1];
  const sessionId = m[2];

  const session = await loadSession(env, sessionId);
  if (!session) return ephemeral('Campaign not found (already ended?).');
  if (session.status !== STATUS.FORMING) {
    return ephemeral(`This campaign is already ${session.status}.`);
  }
  if (!session.invitedUserIds.includes(userId)) {
    return ephemeral("You're not on this campaign's invite list.");
  }
  if (session.acceptedUserIds.includes(userId)) {
    return ephemeral("You've already accepted this campaign.");
  }
  if (session.declinedUserIds.includes(userId)) {
    return ephemeral('You already declined this campaign.');
  }

  if (action === 'decline') {
    session.declinedUserIds.push(userId);
    await saveSession(env, session);
    return ephemeral('Declined. No hard feelings.');
  }

  // Accept.
  session.acceptedUserIds.push(userId);
  await saveSession(env, session);

  const everyone = [session.starterUserId, ...session.invitedUserIds];
  const allAccepted = everyone.every(uid => session.acceptedUserIds.includes(uid));
  if (!allAccepted) {
    const pending = everyone.filter(uid => !session.acceptedUserIds.includes(uid)
                                        && !session.declinedUserIds.includes(uid));
    return ephemeral(`✅ Accepted. Waiting on ${pending.length} more: ${pending.map(u => `<@${u}>`).join(' ')}`);
  }

  // All accepted — pick a premise + generate the opening beat.
  return openCampaign(env, session);
}

async function openCampaign(env, session) {
  const premise = pickPremise();
  session.premiseId = premise.id;
  session.status    = STATUS.ACTIVE;

  const party = [session.starterUserId, ...session.invitedUserIds]
    .filter(uid => session.acceptedUserIds.includes(uid));
  const partyBlob = await buildPartyBlob(env, session.guildId, party);
  const systemPrompt = buildSystemPrompt({ partyBlob, premise });

  // Opening beat — single user turn primes the GM with "scene-set".
  const openingTurn = {
    role: 'user',
    content: 'Open the scene. Establish the location, the immediate situation, and the first hook the party encounters. Two to four sentences.',
  };

  // Budget gate (always passes on opening since costCents=0, but
  // keep the check uniform with the action handler below).
  if (session.costCents >= session.costCapCents) {
    return ephemeral('Budget for this campaign is exhausted before it could even start. Tell a mod.');
  }

  const r = await generateBeat(env, {
    systemPrompt,
    messages: [openingTurn],
    maxTokens: 600,
  });
  if (!r.ok) {
    // Revert to forming so the players can retry. Common failure
    // mode: ANTHROPIC_API_KEY missing in prod (the slash command
    // shouldn't surface in that case but defend anyway).
    session.status = STATUS.FORMING;
    await saveSession(env, session);
    return ephemeral(`AI GM call failed: \`${r.error}\`${r.status ? ` (${r.status})` : ''}. Ping a mod.`);
  }

  session.history.push(openingTurn, { role: 'assistant', content: r.text });
  session.tokensIn  += r.usage.tokensIn;
  session.tokensOut += r.usage.tokensOut;
  session.costCents += r.costCents;
  session.lastBeatAt = new Date().toISOString();
  await saveSession(env, session);

  const lines = [
    `🎲 **Campaign \`${session.id.slice(0, 8)}\` — _${premise.title}_**`,
    `Party: ${party.map(u => `<@${u}>`).join(', ')}`,
    '',
    r.text,
    '',
    `_Use \`/campaign action text:<what you do>\` to take your turn._`,
  ];
  return {
    type: RESP_CHAT,
    data: {
      content: lines.join('\n').slice(0, 1900),
      // Mention party members so they see the opening notification;
      // future turns ephemeral so the channel doesn't fill up.
      allowed_mentions: { parse: [], users: party },
    },
  };
}

// /campaign action — submits a player action; bot generates the next
// beat and returns it ephemeral. The action is visible only to the
// acting player in v1 (no DM group / private-channel infra yet);
// future iterations will post turns to a shared campaign channel.
export async function handleCampaignAction(env, data) {
  await ensureSchema(env);
  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');

  const opts    = data.data?.options || [];
  const subOpts = (opts.find(o => o.name === 'action')?.options) || [];
  const actionText = String(subOpts.find(o => o.name === 'text')?.value || '').trim();
  if (!actionText) return ephemeral('Provide an action: `/campaign action text:<what you do>`');
  if (actionText.length > 600) {
    return ephemeral('Keep actions under 600 characters. The GM does the narration; you just describe what you do.');
  }

  const session = await loadActiveSessionForUser(env, guildId, userId);
  if (!session) return ephemeral("You're not in an active campaign. Start one with `/campaign start`.");
  if (session.status !== STATUS.ACTIVE) {
    return ephemeral(`This campaign is ${session.status}, not active.`);
  }
  if (session.costCents >= session.costCapCents) {
    return ephemeral(`💸 Campaign \`${session.id.slice(0, 8)}\` has exhausted its AI budget ($${(session.costCapCents / 100).toFixed(2)}). Tell a mod if you want to continue.`);
  }

  const premise = premiseById(session.premiseId);
  const partyBlob = await buildPartyBlob(env, session.guildId,
    [session.starterUserId, ...session.invitedUserIds]
      .filter(uid => session.acceptedUserIds.includes(uid)));
  const systemPrompt = buildSystemPrompt({ partyBlob, premise });

  // Compose history into Anthropic messages. Keep history capped at
  // the last 40 turns to stay within reasonable per-call token spend.
  const recent = session.history.slice(-40);
  const playerDisplay = await fetchDisplayName(env, guildId, userId);
  const turn = {
    role: 'user',
    content: `${playerDisplay}: ${actionText}`,
  };
  const r = await generateBeat(env, {
    systemPrompt,
    messages: [...recent, turn],
    maxTokens: 500,
  });
  if (!r.ok) {
    return ephemeral(`AI GM call failed: \`${r.error}\`${r.status ? ` (${r.status})` : ''}. Try again in a moment.`);
  }

  session.history.push(turn, { role: 'assistant', content: r.text });
  session.tokensIn  += r.usage.tokensIn;
  session.tokensOut += r.usage.tokensOut;
  session.costCents += r.costCents;
  session.lastBeatAt = new Date().toISOString();
  await saveSession(env, session);

  return {
    type: RESP_CHAT,
    data: {
      content: r.text.slice(0, 1900),
      flags:   FLAG_EPHEMERAL,
    },
  };
}

// /campaign status — show progress + budget for the caller's
// current campaign.
export async function handleCampaignStatus(env, data) {
  await ensureSchema(env);
  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');

  const session = await loadActiveSessionForUser(env, guildId, userId);
  if (!session) return ephemeral("You're not in an active campaign. Start one with `/campaign start`.");

  const premise = premiseById(session.premiseId);
  const beats = session.history.filter(h => h.role === 'assistant').length;
  const budgetPct = Math.min(100, Math.round(session.costCents / session.costCapCents * 100));
  const lines = [
    `🎲 **Campaign \`${session.id.slice(0, 8)}\`** · status: \`${session.status}\``,
    premise ? `Premise: _${premise.title}_` : null,
    '',
    `Beats so far: **${beats}**`,
    `Party: ${session.acceptedUserIds.map(u => `<@${u}>`).join(', ')}`,
    session.declinedUserIds.length
      ? `Declined: ${session.declinedUserIds.map(u => `<@${u}>`).join(', ')}`
      : null,
    '',
    `💸 Budget: **${budgetPct}%** used (${session.costCents}¢ / ${session.costCapCents}¢ cap)`,
    `🪙 Tokens: ${session.tokensIn.toLocaleString()} in · ${session.tokensOut.toLocaleString()} out`,
  ].filter(Boolean);
  return ephemeral(lines.join('\n'));
}

// /campaign end — starter-only. Marks status='complete' (player-led
// completion) or 'abandoned' (no party).
export async function handleCampaignEnd(env, data) {
  await ensureSchema(env);
  const userId  = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return ephemeral('Run this in a server.');

  const session = await loadActiveSessionForUser(env, guildId, userId);
  if (!session) return ephemeral("You're not in an active campaign.");
  if (session.starterUserId !== userId) {
    return ephemeral('Only the starter can end the campaign.');
  }
  session.status      = session.history.length > 2 ? STATUS.COMPLETE : STATUS.ABANDONED;
  session.completedAt = new Date().toISOString();
  await saveSession(env, session);
  return ephemeral(`🎲 Campaign \`${session.id.slice(0, 8)}\` marked **${session.status}**. Final spend: ${session.costCents}¢. Thanks for playing.`);
}
