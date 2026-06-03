// Triple-C (Crowd Control Campaign) current-game state + admin API.
//
// 2026-06 schedule update. Triple-C is the fixed show on Mon/Tue/Thu
// (Sun moved to Dad Game Sunday, Fri to Community Night). The
// currently-locked-in campaign game is picked from the
// TRIPLE_C_POLL pool (custom-polls.js) and persisted here so the
// schedule embed + the site can show it. Initial value: Fallout 4.
//
// KV: triple-c:current:<guildId> -> { gameSlug, name, artUrl, setUtc, setBy }
//
// Endpoints (wired in worker/web):
//   GET  /triple-c/current        public  — current campaign
//   GET  /triple-c/pool           public  — the 23-game pool (admin dropdown)
//   POST /web/admin/triple-c/set  owner   — { gameSlug } -> lock it in + announce

import { TRIPLE_C_POLL } from './custom-polls.js';

const KEY = (g) => `triple-c:current:${g}`;
const DEFAULT_SLUG = 'fallout4';

// A few known Steam appIds for pool games so `current` can surface real
// header art. Missing entries just return null art (site falls back).
const SLUG_APPID = {
  fallout4: 377160, eldenring: 1245620, skyrim_se: 489830, borderlands2: 49520,
  borderlands3: 397540, witcher3: 292030, cyberpunk2077: 1091500, mgs_delta: 2417520,
  baby_steps: 2917180, hades: 1145360, hollow_knight: 367520, silksong: 1030300,
  kcd2: 1771300, blue_prince: 1569580, bg3: 1086940, dredge: 1562430,
  stardew: 413150, celeste: 504230, cult_lamb: 1313140, rdr2: 1174180, isaac: 250900,
};

export function getTripleCPool() {
  return TRIPLE_C_POLL.options.map(o => ({
    gameSlug: o.value,
    name: o.label,
    artUrl: SLUG_APPID[o.value]
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${SLUG_APPID[o.value]}/header.jpg`
      : null,
  }));
}

function poolEntry(slug) {
  const o = TRIPLE_C_POLL.options.find(x => x.value === slug);
  if (!o) return null;
  return {
    gameSlug: o.value,
    name: o.label,
    artUrl: SLUG_APPID[o.value]
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${SLUG_APPID[o.value]}/header.jpg`
      : null,
  };
}

export async function getCurrentTripleC(env, guildId) {
  const gid = guildId || String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  let rec = null;
  try { rec = await env.LOADOUT_BOLTS.get(KEY(gid), { type: 'json' }); } catch { /* ignore */ }
  if (rec && rec.gameSlug) return rec;
  // Lazy default — Fallout 4 until an owner sets one.
  const def = poolEntry(DEFAULT_SLUG);
  return { ...def, setUtc: 0, setBy: null, default: true };
}

// Validate + persist. Returns { ok, current } or { ok:false, error }.
export async function setCurrentTripleC(env, guildId, gameSlug, setBy) {
  const gid = guildId || String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  const entry = poolEntry(String(gameSlug || '').trim());
  if (!entry) {
    return { ok: false, error: 'unknown-game', allowed: TRIPLE_C_POLL.options.map(o => o.value) };
  }
  const rec = { ...entry, setUtc: Date.now(), setBy: setBy || null };
  await env.LOADOUT_BOLTS.put(KEY(gid), JSON.stringify(rec));
  return { ok: true, current: rec };
}

// Post the "Triple-C is now X" announcement embed. Best-effort.
export async function announceTripleC(env, current) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  // Lock-in announcements land in the 📅 schedule channel (next to the
  // pinned weekly embed), not the vote channel — see task brief #5.
  const channelId = String(env.TRIPLE_C_ANNOUNCE_CHANNEL || env.SCHEDULE_CHANNEL_ID
    || '1507973920282640485').trim();
  if (!channelId) return { ok: false, error: 'no-channel' };
  const time = env.STREAM_TIME_ET || '22:30';
  const [h, m] = time.split(':').map(Number);
  const pretty = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} ET`;
  const embed = {
    title: `📺 Triple-C is now: ${current.name}`,
    description: `The Crowd Control Campaign game is locked in.\nStreams **Mon · Tue · Thu** at **${pretty}**.`,
    color: 0x9b6cff,
    image: current.artUrl ? { url: current.artUrl } : undefined,
    footer: { text: 'Triple-C · Crowd Control Campaign' },
  };
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  return { ok: r.ok, status: r.status };
}
