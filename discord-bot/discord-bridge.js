// ── Discord ↔ stream bridge ──────────────────────────────────────────────────
// Verified pairing between a Discord user and their Twitch (extension) wallet,
// plus wallet commands that work from Discord once paired. Pairing is a
// two-surface handshake so nobody can claim someone else's wallet:
//
//   1. Discord:  /link            → 6-char code (ephemeral, 10 min TTL)
//   2. Extension: Loot tab → "Link Discord" box → enter code (Twitch JWT
//      authenticates the viewer) → pair stored both directions.
//
// Keys (all in LOADOUT_BOLTS, namespaced by guild):
//   dlinkcode:<CODE>          → { guild, discordId }        (TTL 10 min)
//   dlink:<guild>:<discordId> → twitchId
//   dlinkrev:<guild>:<twId>   → discordId
//
// Commands operate on the TWITCH-id-keyed wallet (the same one the extension
// games/predictions/gacha use) — one unified balance across surfaces. Works
// where the Discord guild IS the wallet namespace (Clay's vault guild ==
// AQUILO_VAULT_GUILD_ID == the extension's nsFor for his channel).

import { getWallet, earn } from './wallet.js';
import { handleGacha } from './ext-lootbox.js';

const CODE_TTL = 600;            // 10 min to enter the code in the panel
const DAILY_BOLTS = 25;          // small Discord-side faucet, separate cooldown
const DAILY_COOLDOWN_S = 20 * 3600;

const CODE_KEY = (code) => 'dlinkcode:' + code;
const LINK_KEY = (g, d) => `dlink:${g}:${d}`;
const REV_KEY = (g, t) => `dlinkrev:${g}:${t}`;
const DAILY_KEY = (g, t) => `ddaily:${g}:${t}`;

function reply(content) { return { type: 4, data: { content, flags: 64 } }; }

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((b) => alphabet[b % alphabet.length]).join('');
}

export async function resolveTwitchId(env, guild, discordId) {
  return await env.LOADOUT_BOLTS.get(LINK_KEY(guild, discordId)).catch(() => null);
}

// ── Discord slash commands ───────────────────────────────────────────────────
// handleBridgeCommand(env, data, cmd) → Discord interaction response object.
export async function handleBridgeCommand(env, data, cmd) {
  const guild = data.guild_id;
  const user = data.member?.user || data.user;
  const discordId = user?.id;
  if (!guild || !discordId) return reply('This only works inside the server.');

  if (cmd === 'link') {
    const existing = await resolveTwitchId(env, guild, discordId);
    const code = newCode();
    await env.LOADOUT_BOLTS.put(CODE_KEY(code), JSON.stringify({ guild, discordId }), { expirationTtl: CODE_TTL });
    return reply(
      (existing ? '🔗 You are already linked — entering a new code re-pairs.\n' : '') +
      '🔗 Your link code: **' + code + '**\n' +
      'Open the Twitch extension → **Loot** tab → *Link Discord* box and enter it within 10 minutes. ' +
      'That connects this Discord account to your stream Bolts wallet.'
    );
  }

  const twId = await resolveTwitchId(env, guild, discordId);
  if (!twId) return reply('You are not linked yet — run **/link** and enter the code in the Twitch extension (Loot tab).');

  if (cmd === 'bolts') {
    const w = await getWallet(env, guild, twId);
    return reply('⚡ **' + Number(w.balance || 0).toLocaleString() + ' Bolts** · lifetime earned ' +
      Number(w.lifetimeEarned || 0).toLocaleString() + ' — one wallet across stream + Discord.');
  }

  if (cmd === 'daily') {
    if (await env.LOADOUT_BOLTS.get(DAILY_KEY(guild, twId)).catch(() => null)) {
      return reply('🕐 Already claimed — the Discord daily resets 20h after each claim.');
    }
    await env.LOADOUT_BOLTS.put(DAILY_KEY(guild, twId), '1', { expirationTtl: DAILY_COOLDOWN_S });
    const w = await earn(env, guild, twId, DAILY_BOLTS, 'discord daily');
    return reply('☀️ Daily claimed: **+' + DAILY_BOLTS + ' Bolts** → balance ' +
      Number((w && w.balance) || 0).toLocaleString() + '.');
  }

  if (cmd === 'pull') {
    // Same engine as the panel's Loot tab — one pity meter, one bag.
    const fakeReq = { method: 'POST', async json() { return {}; }, async clone() { return this; } };
    const res = await handleGacha(env, guild, twId, 'pull', fakeReq, {});
    let j = null;
    try { j = await res.json(); } catch { /* fall through */ }
    if (!j || !j.ok) {
      if (j && j.error === 'insufficient') return reply('💸 Not enough Bolts (a pull costs ' + Number(j.need || 100).toLocaleString() + ', you have ' + Number(j.balance || 0).toLocaleString() + ').');
      return reply('The loot machine jammed — try again.');
    }
    const em = { common: '⚪', rare: '🔵', epic: '🟣', legendary: '🟡' }[j.prize.rarity] || '⚪';
    return reply('🎁 ' + em + ' **' + j.prize.name + '** (' + j.prize.rarity + (j.pityHit ? ' · pity!' : '') + ')' +
      (j.prize.slot === 'bolts' ? ' → +' + Number(j.prize.amount).toLocaleString() + ' Bolts' : ' → added to your badge bag') +
      ' · balance ' + Number(j.balance || 0).toLocaleString() +
      ' · guaranteed epic+ within ' + Math.max(0, (j.pityAt || 8) - (j.pity || 0)) + ' pulls');
  }

  return reply('Unknown bridge command.');
}

// ── Extension side (panel claims the code with a Twitch-authed JWT) ─────────
// handleLinkExt(env, guildId, userId, sub, req) — dispatched from ext.js, so
// userId is the VERIFIED Twitch id from the extension JWT.
export async function handleLinkExt(env, guildId, userId, sub, req) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' },
  });
  if (req.method === 'OPTIONS') return json({ ok: true });

  if (sub === 'state' || sub === '') {
    const d = await env.LOADOUT_BOLTS.get(REV_KEY(guildId, userId)).catch(() => null);
    return json({ ok: true, linked: !!d });
  }
  if (sub === 'claim' && req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch { /* empty */ }
    const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code.length !== 6) return json({ ok: false, error: 'bad-code' }, 400);
    const rec = await env.LOADOUT_BOLTS.get(CODE_KEY(code), { type: 'json' }).catch(() => null);
    if (!rec || !rec.discordId) return json({ ok: false, error: 'expired' }, 404);
    if (String(rec.guild) !== String(guildId)) return json({ ok: false, error: 'wrong-server' }, 409);
    // Re-pairing: clear any prior link on either side so pairs stay 1:1.
    const prevTw = await env.LOADOUT_BOLTS.get(LINK_KEY(guildId, rec.discordId)).catch(() => null);
    if (prevTw) await env.LOADOUT_BOLTS.delete(REV_KEY(guildId, prevTw)).catch(() => {});
    const prevDiscord = await env.LOADOUT_BOLTS.get(REV_KEY(guildId, userId)).catch(() => null);
    if (prevDiscord) await env.LOADOUT_BOLTS.delete(LINK_KEY(guildId, prevDiscord)).catch(() => {});
    await env.LOADOUT_BOLTS.put(LINK_KEY(guildId, rec.discordId), String(userId));
    await env.LOADOUT_BOLTS.put(REV_KEY(guildId, userId), String(rec.discordId));
    await env.LOADOUT_BOLTS.delete(CODE_KEY(code)).catch(() => {});
    return json({ ok: true, linked: true });
  }
  if (sub === 'unlink' && req.method === 'POST') {
    const d = await env.LOADOUT_BOLTS.get(REV_KEY(guildId, userId)).catch(() => null);
    if (d) await env.LOADOUT_BOLTS.delete(LINK_KEY(guildId, d)).catch(() => {});
    await env.LOADOUT_BOLTS.delete(REV_KEY(guildId, userId)).catch(() => {});
    return json({ ok: true, linked: false });
  }
  return json({ ok: false, error: 'not-found' }, 404);
}
