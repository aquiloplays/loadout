// Aquilo's Vault — Discord surface for the community cross-section.
//
// Idempotent guild setup (roles + Vault category + channels), crisis
// announcement embeds, affected-dweller DMs, and class resolution for
// the onboarding "Join the Vault?" step. Pairs with vault-community.js
// (the engine) and is wired from worker.js (setup endpoint) + the
// onboarding flow.
//
// Discord REST is called directly with the bot token (mirrors
// guild-builder.js dapi()). All Discord side-effects are best-effort —
// the vault engine never blocks on a Discord failure.

import { listDwellers, getActiveCrises, CRISIS_KINDS, ROOM_TYPES } from './vault-community.js';

const API = 'https://discord.com/api/v10';
const CT = 0xf1c40f; // vault amber accent for embeds

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function dapi(token, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bot ' + (token || ''),
      'Content-Type': 'application/json',
      'User-Agent': 'loadout-discord vault',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* 204 No Content */ }
  return { ok: r.ok, status: r.status, body: json };
}

// ── Guild config helpers ──────────────────────────────────────────────

async function readCfg(env, guildId) {
  return (await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' })) || {};
}
async function writeCfgIds(env, guildId, newIds) {
  const cfg = await readCfg(env, guildId);
  cfg.ids = { ...(cfg.ids || {}), ...newIds };
  cfg.vaultBuiltUtc = Date.now();
  await env.LOADOUT_BOLTS.put(`guild:cfg:${guildId}`, JSON.stringify(cfg));
  return cfg;
}

// ── Setup: roles + category + channels (idempotent by name) ───────────

const VAULT_ROLES = [
  { slot: 'role_vault_dweller',  name: 'Vault Dweller',    color: 0x5bff95, hoist: false,
    reason: 'Opted into Aquilo\'s Vault' },
  { slot: 'role_vault_overseer', name: 'Vault Overseer',   color: 0xf1c40f, hoist: true,
    reason: 'Top vault contributor' },
  { slot: 'role_vault_responder', name: 'Crisis Responder', color: 0xff7a7a, hoist: false,
    reason: 'Active during a vault crisis' },
];

const VAULT_CHANNELS = [
  { slot: 'ch_vault_status',   name: 'vault-status',   topic: 'Live status of Aquilo\'s Vault — auto-updates as the community builds and defends it.' },
  { slot: 'ch_vault_crises',   name: 'vault-crises',    topic: 'Crisis alerts. Rally here when raiders, fire, or radstorms hit the vault.' },
  { slot: 'ch_vault_overseer', name: 'vault-overseer',  topic: 'Private channel for the vault\'s top contributors.' },
];

// Create everything idempotently. Re-running matches existing roles/
// channels by name (case-insensitive) so it never duplicates.
export async function setupVaultGuild(env, guildId) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { ok: false, error: 'no-bot-token' };
  const report = { roles: {}, category: null, channels: {}, created: [], kept: [], errors: [] };
  const ids = {};

  // 1. Roles.
  const existingRoles = (await dapi(token, 'GET', `/guilds/${guildId}/roles`)).body || [];
  const roleByName = (n) => existingRoles.find(r => (r.name || '').toLowerCase() === n.toLowerCase());
  for (const spec of VAULT_ROLES) {
    const found = roleByName(spec.name);
    if (found) { ids[spec.slot] = found.id; report.roles[spec.slot] = found.id; report.kept.push(spec.name); continue; }
    const r = await dapi(token, 'POST', `/guilds/${guildId}/roles`,
      { name: spec.name, color: spec.color, hoist: spec.hoist, mentionable: false });
    if (r.ok && r.body?.id) { ids[spec.slot] = r.body.id; report.roles[spec.slot] = r.body.id; report.created.push(spec.name); }
    else report.errors.push(`role ${spec.name}: ${r.status}`);
    await sleep(250);
  }

  // 2. Vault category.
  const existingCh = (await dapi(token, 'GET', `/guilds/${guildId}/channels`)).body || [];
  const chByName = (n, type) => existingCh.find(c => (c.name || '').toLowerCase() === n.toLowerCase() && (type == null || c.type === type));
  let catId = chByName('Vault', 4)?.id;
  if (!catId) {
    // Lock the category to Vault Dwellers (+ staff) by default.
    const everyone = guildId; // @everyone role id == guild id
    const overwrites = [
      { id: everyone, type: 0, deny: String(0x400) },                       // VIEW_CHANNEL deny
      ...(ids.role_vault_dweller ? [{ id: ids.role_vault_dweller, type: 0, allow: String(0x400) }] : []),
      ...(env.STAFF_ROLE_ID ? [{ id: env.STAFF_ROLE_ID, type: 0, allow: String(0x400) }] : []),
    ];
    const r = await dapi(token, 'POST', `/guilds/${guildId}/channels`,
      { name: 'Vault', type: 4, permission_overwrites: overwrites });
    if (r.ok && r.body?.id) { catId = r.body.id; report.created.push('category:Vault'); }
    else report.errors.push(`category Vault: ${r.status}`);
    await sleep(250);
  } else { report.kept.push('category:Vault'); }
  ids.cat_vault = catId || null;
  report.category = catId || null;

  // 3. Channels under the category.
  for (const spec of VAULT_CHANNELS) {
    const found = chByName(spec.name, 0);
    if (found) { ids[spec.slot] = found.id; report.channels[spec.slot] = found.id; report.kept.push(spec.name); continue; }
    const payload = { name: spec.name, type: 0, topic: spec.topic, parent_id: catId || undefined };
    // The overseer channel is further locked to the Overseer role.
    if (spec.slot === 'ch_vault_overseer' && ids.role_vault_overseer) {
      payload.permission_overwrites = [
        { id: guildId, type: 0, deny: String(0x400) },
        { id: ids.role_vault_overseer, type: 0, allow: String(0x400) },
        ...(env.STAFF_ROLE_ID ? [{ id: env.STAFF_ROLE_ID, type: 0, allow: String(0x400) }] : []),
      ];
    }
    const r = await dapi(token, 'POST', `/guilds/${guildId}/channels`, payload);
    if (r.ok && r.body?.id) { ids[spec.slot] = r.body.id; report.channels[spec.slot] = r.body.id; report.created.push(spec.name); }
    else report.errors.push(`channel ${spec.name}: ${r.status}`);
    await sleep(250);
  }

  await writeCfgIds(env, guildId, ids);
  report.ok = report.errors.length === 0;
  report.ids = ids;
  return report;
}

// ── Class resolution (for the onboarding class -> starter room) ───────

export async function resolveUserClass(env, guildId, userId) {
  try {
    const hero = await env.LOADOUT_BOLTS.get(`d:hero:${guildId}:${userId}`, { type: 'json' });
    const c = (hero?.class || '').toLowerCase().trim();
    return ['warrior', 'mage', 'rogue', 'ranger', 'healer'].includes(c) ? c : null;
  } catch { return null; }
}

// ── Role grant/remove (best-effort, idempotent) ───────────────────────

export async function grantRole(env, guildId, userId, roleId, reason = 'vault') {
  if (!roleId || !env.DISCORD_BOT_TOKEN) return false;
  const r = await fetch(`${API}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    { method: 'PUT', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'X-Audit-Log-Reason': reason } });
  return r.ok || r.status === 204;
}

export async function grantVaultDweller(env, guildId, userId) {
  const cfg = await readCfg(env, guildId);
  return grantRole(env, guildId, userId, cfg?.ids?.role_vault_dweller, 'Vault opt-in via onboarding');
}

export async function grantCrisisResponder(env, guildId, userId) {
  const cfg = await readCfg(env, guildId);
  return grantRole(env, guildId, userId, cfg?.ids?.role_vault_responder, 'Responded to a vault crisis');
}

// ── DM + channel posts ────────────────────────────────────────────────

async function dmUser(env, userId, payload) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return false;
  const dm = await dapi(token, 'POST', '/users/@me/channels', { recipient_id: String(userId) });
  const chId = dm.body?.id;
  if (!chId) return false;
  const r = await dapi(token, 'POST', `/channels/${chId}/messages`, payload);
  return r.ok;
}

async function postToChannel(env, channelId, payload) {
  if (!channelId || !env.DISCORD_BOT_TOKEN) return null;
  const r = await dapi(env.DISCORD_BOT_TOKEN, 'POST', `/channels/${channelId}/messages`, payload);
  return r.ok ? r.body : null;
}

function roomName(roomId, snapshotRooms) {
  const r = (snapshotRooms || []).find(x => x.id === roomId);
  return r ? (ROOM_TYPES[r.type]?.name || r.type) : null;
}

// Crisis START — announce in #vault-crises + DM dwellers in the room.
export async function announceCrisisStart(env, guildId, crisis, stateRooms) {
  try {
    const cfg = await readCfg(env, guildId);
    const ch = cfg?.ids?.ch_vault_crises;
    const def = CRISIS_KINDS[crisis.kind] || {};
    const rn = crisis.roomId ? roomName(crisis.roomId, stateRooms) : null;
    const resp = cfg?.ids?.role_vault_responder;
    const embed = {
      title: `⚠ ${def.name || crisis.kind} hits the Vault!`,
      description:
        (rn ? `The **${rn}** is under threat.` : `The whole vault is under threat.`) +
        `\n\nRally to defend it — contribute on the **Vault** page or with \`/vault contribute\`. ` +
        `Resolve **${crisis.threshold}** response points before it's too late.`,
      color: 0xff7a7a,
      footer: { text: `Crisis ${crisis.crisisId || crisis.id}` },
    };
    await postToChannel(env, ch, {
      content: resp ? `<@&${resp}>` : undefined,
      embeds: [embed],
      allowed_mentions: { roles: resp ? [resp] : [] },
    });

    // DM the dwellers assigned to the affected room.
    if (crisis.roomId) {
      const dwellers = await listDwellers(env, guildId);
      const affected = dwellers.filter(d => d.assigned_room === crisis.roomId);
      for (const d of affected.slice(0, 25)) {
        await dmUser(env, d.user_id, {
          embeds: [{
            title: `⚠ Your room is under attack`,
            description: `A **${def.name || crisis.kind}** is hitting the **${rn || 'vault'}** — the room your dweller is stationed in. Jump in and help resolve it!`,
            color: 0xff7a7a,
          }],
        });
        await sleep(120);
      }
    }
  } catch (e) { console.warn('[vault] announceCrisisStart', e?.message || e); }
}

// Crisis RESOLVED/FAILED — announce outcome in #vault-crises.
export async function announceCrisisResolved(env, guildId, crisis, resolution) {
  try {
    const cfg = await readCfg(env, guildId);
    const ch = cfg?.ids?.ch_vault_crises;
    const def = CRISIS_KINDS[crisis.kind] || {};
    const win = resolution === 'resolved';
    await postToChannel(env, ch, {
      embeds: [{
        title: win ? `✅ ${def.name || crisis.kind} repelled!` : `❌ The Vault took damage`,
        description: win
          ? `The community pulled together and beat back the **${def.name || crisis.kind}**. The vault holds.`
          : `The **${def.name || crisis.kind}** wasn't resolved in time — the vault's happiness took a hit. Regroup for the next one.`,
        color: win ? 0x5bff95 : 0xff7a7a,
        footer: { text: `Crisis ${crisis.crisisId || crisis.id}` },
      }],
    });
  } catch (e) { console.warn('[vault] announceCrisisResolved', e?.message || e); }
}

// Lightweight status line into #vault-status (e.g. room unlocked).
export async function postVaultStatus(env, guildId, text) {
  try {
    const cfg = await readCfg(env, guildId);
    await postToChannel(env, cfg?.ids?.ch_vault_status, {
      embeds: [{ description: text, color: CT }],
    });
  } catch (e) { console.warn('[vault] postVaultStatus', e?.message || e); }
}
