// Aquilo's Vault — Discord interaction layer.
//
// Vault game logic stays put on the FS-Bot Railway service; the
// worker is just the Discord surface. Two channels:
//
//   vault-actions    persistent hub embed with player-action
//                     buttons (deposit / withdraw / leaderboard /
//                     daily / claim pending). Component prefix
//                     `vault:`. Same pattern as the other hubs.
//
//   vault-events     game-event feed. Railway POSTs each event
//                     (item drop, raid, etc.) to /vault/event;
//                     the worker posts an embed with action
//                     buttons (claim / react / ...) into this
//                     channel.
//
// Webhook /vault/event — HMAC-SHA256 via VAULT_WEBHOOK_SECRET
// over `ts + "\n" + body` (matches the Streamer.bot scheme).
// Body shape — minimum:
//   {
//     id:        'evt_xyz',          stable event id (KV dedup)
//     type:      'drop' | 'raid' | 'jackpot' | 'note',
//     title:     'Loot Drop · Phantom Sword',
//     description?: 'rendered description',
//     image?:    'https://...',
//     fields?:   [{ name, value, inline? }, ...],
//     actions?:  [                       // optional inline button row
//       { id: 'claim',  label: 'Claim',  style: 'success' },
//       { id: 'react',  label: '🎉',    style: 'secondary' },
//     ],
//     ts?:       <ms-epoch>,
//   }
//
// Button-click contract (player → worker → Railway):
//   custom_id = `vault:evt:<eventId>:<actionId>`
// On click, the worker POSTs the click upstream to FS-Bot's
// HTTP-ingest endpoint (VAULT_INGEST_URL + HMAC). Until that's
// configured, the worker just acks ephemerally.

import { verifyHmac } from './auth.js';
import { getChannelBinding } from './channel-bindings.js';
import { getBranding } from './branding.js';

const HUB_MSG_KEY = (g) => `vault-actions:hub-msg:${g}`;
const EVENT_DEDUP_KEY = (g, evtId) => `vault:event:seen:${g}:${evtId}`;
const EVENT_TTL_S = 24 * 60 * 60;

const RESP_CHAT          = 4;
const FLAG_EPHEMERAL     = 64;
const COMPONENT_ROW      = 1;
const COMPONENT_BUTTON   = 2;
const BTN_PRIMARY        = 1;
const BTN_SECONDARY      = 2;
const BTN_SUCCESS        = 3;
const BTN_DANGER         = 4;
const BTN_LINK           = 5;

// Style alias from Railway-side string names → Discord int values.
const STYLE_BY_NAME = {
  primary:   BTN_PRIMARY,
  secondary: BTN_SECONDARY,
  success:   BTN_SUCCESS,
  danger:    BTN_DANGER,
  link:      BTN_LINK,
};

// ── Actions-hub embed ───────────────────────────────────────────

export async function buildActionsHubEmbed(env, guildId) {
  const brand = await getBranding(env, guildId);
  return {
    embed: {
      title: '🏛️ Aquilo\'s Vault',
      description:
        'The community treasury. Bolts inside fund stream events + community drops.\n\n' +
        '• **Deposit** — add bolts to the vault\n' +
        '• **Withdraw** — take bolts back out (limits apply)\n' +
        '• **Daily bonus** — claim today\'s vault payout\n' +
        '• **Leaderboard** — top depositors this season\n' +
        '• **My pending** — unclaimed drops/payouts waiting for you',
      color: brand.accentColor || 0xe6c474,
      footer: { text: 'Vault game events stream into the events channel.' },
    },
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Deposit',     custom_id: 'vault:deposit' },
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Withdraw',    custom_id: 'vault:withdraw' },
        { type: COMPONENT_BUTTON, style: BTN_SUCCESS,   label: 'Daily bonus', custom_id: 'vault:daily' },
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Leaderboard', custom_id: 'vault:leaderboard' },
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'My pending',  custom_id: 'vault:pending' },
      ],
    }],
  };
}

export async function postActionsHub(env, guildId, channelId) {
  if (!channelId) return { ok: false, error: 'no-channel-id' };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };

  let deletedPrior = false;
  try {
    const prior = await env.LOADOUT_BOLTS.get(HUB_MSG_KEY(guildId), { type: 'json' });
    if (prior?.channelId && prior?.messageId) {
      const del = await fetch(
        `https://discord.com/api/v10/channels/${prior.channelId}/messages/${prior.messageId}`,
        { method: 'DELETE', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord vault-hub' } },
      );
      if (del.ok || del.status === 204 || del.status === 404) deletedPrior = true;
    }
  } catch { /* idle */ }

  const built = await buildActionsHubEmbed(env, guildId);
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord vault-hub',
    },
    body: JSON.stringify({ embeds: [built.embed], components: built.components, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: 'post-failed', status: r.status, body: t.slice(0, 200) };
  }
  const j = await r.json();
  await env.LOADOUT_BOLTS.put(HUB_MSG_KEY(guildId),
    JSON.stringify({ channelId, messageId: j.id, postedAt: Date.now() }));
  return { ok: true, channelId, messageId: j.id, deletedPrior };
}

// Admin HTTP entry — resolves channel via opts → vault-actions binding.
export async function postActionsHubForGuild(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  let channelId = opts.channelId;
  if (!channelId) {
    channelId = await getChannelBinding(env, guildId, 'vault-actions');
    if (!channelId) {
      return { ok: false, error: 'no-vault-actions-channel',
        message: 'Bind vault-actions first via /admin/channels/bind { binding: "vault-actions", channelId: "..." }.' };
    }
  }
  return postActionsHub(env, guildId, channelId);
}

// ── Event-feed webhook ──────────────────────────────────────────

// POST /vault/event — same HMAC scheme as /streamerbot/event.
export async function handleVaultEventWebhook(req, env) {
  if (!env.VAULT_WEBHOOK_SECRET) {
    return jsonResp({ ok: false, error: 'webhook-secret-not-configured' }, 503);
  }
  const ts  = req.headers.get('x-aquilo-vault-ts');
  const sig = req.headers.get('x-aquilo-vault-sig');
  const body = await req.text();
  const ok = await verifyHmac(env.VAULT_WEBHOOK_SECRET, ts || '', body, sig || '');
  if (!ok) return jsonResp({ ok: false, error: 'bad-signature' }, 401);

  let event;
  try { event = JSON.parse(body); }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  if (!event || typeof event !== 'object') {
    return jsonResp({ ok: false, error: 'bad-event' }, 400);
  }
  if (!event.id || typeof event.id !== 'string') {
    return jsonResp({ ok: false, error: 'missing-id' }, 400);
  }
  if (!event.title || typeof event.title !== 'string') {
    return jsonResp({ ok: false, error: 'missing-title' }, 400);
  }

  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return jsonResp({ ok: false, error: 'no-guild-id' }, 503);

  // Replay-protect by event id.
  const dedupKey = EVENT_DEDUP_KEY(guildId, event.id);
  if (await env.LOADOUT_BOLTS.get(dedupKey)) {
    return jsonResp({ ok: true, skipped: 'duplicate' }, 200);
  }
  const channelId = await getChannelBinding(env, guildId, 'vault-events');
  if (!channelId) return jsonResp({ ok: false, error: 'no-vault-events-channel' }, 503);

  // Render the embed.
  const embed = {
    title: String(event.title).slice(0, 256),
    description: event.description ? String(event.description).slice(0, 4000) : undefined,
    color: 0xe6c474,
    image: event.image && /^https:\/\//.test(String(event.image)) ? { url: String(event.image) } : undefined,
    fields: Array.isArray(event.fields)
      ? event.fields.slice(0, 25).map(f => ({
          name:   String(f?.name || '').slice(0, 256),
          value:  String(f?.value || '').slice(0, 1024),
          inline: !!f?.inline,
        }))
      : undefined,
    timestamp: event.ts ? new Date(Number(event.ts) || Date.now()).toISOString() : new Date().toISOString(),
  };

  // Build action buttons.
  const components = [];
  if (Array.isArray(event.actions) && event.actions.length > 0) {
    const row = { type: COMPONENT_ROW, components: [] };
    for (const a of event.actions.slice(0, 5)) {
      if (!a?.id || !a?.label) continue;
      const id = String(a.id).slice(0, 32);
      if (!/^[a-z0-9-]+$/i.test(id)) continue;
      row.components.push({
        type: COMPONENT_BUTTON,
        style: STYLE_BY_NAME[String(a.style || 'secondary').toLowerCase()] || BTN_SECONDARY,
        label: String(a.label).slice(0, 80),
        custom_id: `vault:evt:${event.id}:${id}`,
      });
    }
    if (row.components.length > 0) components.push(row);
  }

  const post = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord vault-hub',
    },
    body: JSON.stringify({ embeds: [embed], components, allowed_mentions: { parse: [] } }),
  });
  if (!post.ok) {
    return jsonResp({ ok: false, error: 'post-failed', status: post.status,
      body: (await post.text()).slice(0, 200) }, 502);
  }
  const j = await post.json();
  // Persist the event id + posted message id so a future "edit
  // when stage X completes" call can target the right message.
  await env.LOADOUT_BOLTS.put(dedupKey, JSON.stringify({ messageId: j.id, postedAt: Date.now() }),
    { expirationTtl: EVENT_TTL_S });
  return jsonResp({ ok: true, eventId: event.id, channelId, messageId: j.id }, 200);
}

// ── Component handlers ──────────────────────────────────────────

const eph = (content) => ({ type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } });
const ephEmbed = (embed, extra = {}) => ({
  type: RESP_CHAT,
  data: { embeds: [embed], flags: FLAG_EPHEMERAL, ...extra },
});

export async function handleVaultComponent(env, data) {
  const userId = data.member?.user?.id || data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return eph('Run this in a server.');

  const cid = data.data?.custom_id || '';
  const parts = cid.split(':');
  const action = parts[1];

  if (action === 'deposit')     return depositMenu(env, guildId, userId);
  if (action === 'withdraw')    return withdrawNote(env, guildId, userId);
  if (action === 'daily')       return dailyClaim(env, guildId, userId);
  if (action === 'leaderboard') return leaderboard(env, guildId);
  if (action === 'pending')     return pendingMenu(env, guildId, userId);
  if (action === 'deposit-amount') {
    const amount = parseInt(parts[2] || '', 10);
    return doDeposit(env, guildId, userId, amount);
  }
  if (action === 'evt') {
    // Event-action button: vault:evt:<eventId>:<actionId>
    return forwardEventAction(env, guildId, userId, parts[2], parts[3], data);
  }
  return eph('Unknown vault action: ' + cid);
}

// Quick deposit menu — same pattern as the bolts hub.
async function depositMenu(env, guildId, userId) {
  const { getWallet } = await import('./wallet.js');
  const w = await getWallet(env, guildId, userId);
  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: '💰 Deposit to Vault',
        description: `Your wallet: **${(w.balance || 0).toLocaleString()}** bolts.\n\nPick an amount:`,
        color: 0xe6c474,
      }],
      components: [{
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Deposit 100',  custom_id: 'vault:deposit-amount:100' },
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Deposit 500',  custom_id: 'vault:deposit-amount:500' },
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Deposit 1000', custom_id: 'vault:deposit-amount:1000' },
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Deposit 5000', custom_id: 'vault:deposit-amount:5000' },
        ],
      }],
      flags: FLAG_EPHEMERAL,
    },
  };
}

async function doDeposit(env, guildId, userId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return eph('❌ Bad amount.');
  try {
    const { spend, getWallet } = await import('./wallet.js');
    const { addTreasury } = await import('./clash-state.js');
    const w = await getWallet(env, guildId, userId);
    if ((w.balance || 0) < amount) {
      return eph(`❌ You only have ${(w.balance || 0).toLocaleString()} bolts.`);
    }
    const r = await spend(env, guildId, userId, amount, 'vault-deposit');
    if (!r || r.balance < 0) return eph('❌ Could not deduct bolts.');
    await addTreasury(env, guildId, amount);
    return eph(`🏛️ Deposited **${amount.toLocaleString()}** bolts to the Vault. New balance: **${r.balance.toLocaleString()}**.`);
  } catch (e) {
    return eph('❌ ' + (e?.message || e));
  }
}

async function withdrawNote() {
  return ephEmbed({
    title: '🔒 Withdraw',
    description:
      'Withdraw is gated by FS-Bot game state — request via the Vault game events channel ' +
      'when a withdraw window opens. Daily bonuses are claimable from the **Daily bonus** button.',
    color: 0xe6c474,
  });
}

async function dailyClaim(env, guildId, userId) {
  // Reuse the existing daily flow on the wallet side.
  try {
    const { daily } = await import('./games.js');
    const r = await daily(env, guildId, userId);
    if (!r.won) return eph(`❌ ${r.explanation || 'Already claimed today.'}`);
    const { getWallet } = await import('./wallet.js');
    const w = await getWallet(env, guildId, userId);
    return eph(`💰 Daily claimed — **+${r.payout}** bolts (streak ${r.streak}). Balance: **${(w.balance || 0).toLocaleString()}**.`);
  } catch (e) {
    return eph('❌ ' + (e?.message || e));
  }
}

async function leaderboard(env, guildId) {
  // Top N treasury depositors — for now, just show town treasury.
  try {
    const { getTreasury } = await import('./clash-state.js');
    const t = await getTreasury(env, guildId).catch(() => 0);
    return ephEmbed({
      title: '🏆 Vault leaderboard',
      description:
        `**Current town treasury:** ${(t || 0).toLocaleString()} bolts\n\n` +
        '_(Per-user depositor leaderboard pending — FS-Bot side aggregator coming.)_',
      color: 0xe6c474,
    });
  } catch (e) {
    return eph('❌ ' + (e?.message || e));
  }
}

async function pendingMenu(env, guildId, userId) {
  // Surface unclaimed check-in bonuses + any vault-side pending
  // (TBD when Railway exposes it).
  try {
    const { getStatus } = await import('./community-checkin.js');
    const s = await getStatus(env, guildId, userId);
    const lines = [];
    if (s?.pendingBonuses?.length) {
      lines.push(`🎁 **${s.pendingBonuses.length}** check-in bonus${s.pendingBonuses.length === 1 ? '' : 'es'} pending.`);
    } else {
      lines.push('No pending claims right now.');
    }
    lines.push('');
    lines.push('_(Vault-side pending claims will surface here once FS-Bot ships the per-user feed.)_');
    return ephEmbed({
      title: '📥 Pending claims',
      description: lines.join('\n'),
      color: 0xe6c474,
    });
  } catch (e) {
    return eph('❌ ' + (e?.message || e));
  }
}

// Forward an event-button click upstream to Railway's vault ingest.
// Until VAULT_INGEST_URL is configured, just ack ephemerally so
// nothing blows up if a viewer clicks a stale button.
async function forwardEventAction(env, guildId, userId, eventId, actionId) {
  if (!eventId || !actionId) return eph('Bad event button.');
  if (!env.VAULT_INGEST_URL || !env.VAULT_INGEST_SECRET) {
    return eph(`Recorded your **${actionId}** on event \`${eventId}\` — Vault server isn\'t wired up yet, ` +
               'so this is a no-op for now.');
  }
  const payload = JSON.stringify({
    eventId, actionId, userId, guildId, ts: Date.now(),
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  // Sign with the same scheme our webhooks use — Railway side will
  // verify with VAULT_INGEST_SECRET.
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.VAULT_INGEST_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(ts + '\n' + payload));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  try {
    const r = await fetch(env.VAULT_INGEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aquilo-vault-ts':  ts,
        'x-aquilo-vault-sig': sigHex,
      },
      body: payload,
    });
    if (!r.ok) return eph(`❌ Vault ingest error: HTTP ${r.status}`);
    return eph(`✅ Sent **${actionId}** to the Vault game.`);
  } catch (e) {
    return eph('❌ ' + (e?.message || e));
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Test export.
export { STYLE_BY_NAME as _STYLE_BY_NAME_FOR_TEST };
