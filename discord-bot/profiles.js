// Viewer profile storage on the Worker side. Mirrors the DLL's
// ViewerProfileStore one-to-one — same shape, same semantics — so a
// `/profile-set-bio` slash command and a chat `!setbio` end up in
// the same logical record once the DLL's poller pulls the Worker
// updates back home.
//
// KV layout:
//   profile:<guildId>:<userId>  - JSON ViewerProfile (Discord user ID
//                                  is the canonical key on this side)
//   profile-index:<guildId>     - JSON array of recently-modified
//                                  user IDs (cap 256). The DLL polls
//                                  ?since=<ts> and we filter from this
//                                  index instead of scanning every
//                                  profile key (which KV doesn't make
//                                  cheap on Workers).

const INDEX_MAX = 256;

export async function getProfile(env, guildId, userId) {
  const key = 'profile:' + guildId + ':' + userId;
  return (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || emptyProfile(userId);
}

export async function putProfile(env, guildId, userId, profile) {
  profile.userId = userId;
  profile.updatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put('profile:' + guildId + ':' + userId, JSON.stringify(profile));
  await touchIndex(env, guildId, userId, profile.updatedUtc);
}

export async function clearProfile(env, guildId, userId) {
  await env.LOADOUT_BOLTS.delete('profile:' + guildId + ':' + userId);
  // Mark the deletion in the index so a polling DLL learns about it.
  await touchIndex(env, guildId, userId, Date.now(), /*tombstone*/ true);
}

// Index sliding-window of recently-touched users. Each entry:
// { userId, ts, deleted? }. DLL filters by ts > since.
async function touchIndex(env, guildId, userId, ts, tombstone) {
  const key = 'profile-index:' + guildId;
  const arr = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
  // Drop any prior entry for this user (we only care about the latest).
  const filtered = arr.filter(e => e.userId !== userId);
  filtered.push({ userId, ts, deleted: !!tombstone });
  while (filtered.length > INDEX_MAX) filtered.shift();
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(filtered));
}

// Returns { profiles: [{userId, profile, deleted, ts}], ts }.
// Filters by `since` (ms epoch).
export async function readSince(env, guildId, sinceMs) {
  const idx = (await env.LOADOUT_BOLTS.get('profile-index:' + guildId, { type: 'json' })) || [];
  const fresh = idx.filter(e => (e.ts || 0) > (sinceMs || 0));
  const out = [];
  for (const e of fresh) {
    if (e.deleted) {
      out.push({ userId: e.userId, deleted: true, ts: e.ts });
    } else {
      const p = await env.LOADOUT_BOLTS.get('profile:' + guildId + ':' + e.userId, { type: 'json' });
      if (p) out.push({ userId: e.userId, profile: p, ts: e.ts });
    }
  }
  const latest = idx.length > 0 ? Math.max.apply(null, idx.map(e => e.ts || 0)) : (sinceMs || 0);
  return { profiles: out, ts: latest };
}

function emptyProfile(userId) {
  return {
    userId,
    bio: '',
    pfp: '',
    pronouns: '',
    socials: {},
    gamerTags: {},
    updatedUtc: 0
  };
}

// Per-field setters wrap getProfile/putProfile so the slash command
// handlers stay tiny.
export async function setField(env, guildId, userId, field, value) {
  const p = await getProfile(env, guildId, userId);
  if (field === 'bio')      p.bio      = (value || '').slice(0, 200);
  if (field === 'pfp')      p.pfp      = (value || '').slice(0, 400);
  if (field === 'pronouns') p.pronouns = (value || '').slice(0, 24);
  await putProfile(env, guildId, userId, p);
  return p;
}

export async function setSocial(env, guildId, userId, platform, handle) {
  const p = await getProfile(env, guildId, userId);
  if (!p.socials) p.socials = {};
  const k = (platform || '').toLowerCase();
  const v = (handle || '').slice(0, 80);
  if (!k) return p;
  if (!v) delete p.socials[k];
  else    p.socials[k] = v;
  await putProfile(env, guildId, userId, p);
  return p;
}

export async function setGamerTag(env, guildId, userId, platform, tag) {
  const p = await getProfile(env, guildId, userId);
  if (!p.gamerTags) p.gamerTags = {};
  const k = (platform || '').toLowerCase();
  const v = (tag || '').slice(0, 60);
  if (!k) return p;
  if (!v) delete p.gamerTags[k];
  else    p.gamerTags[k] = v;
  await putProfile(env, guildId, userId, p);
  return p;
}
