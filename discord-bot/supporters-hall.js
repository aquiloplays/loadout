// Hall of Supporters — read-only roster of opted-in Patreon supporters.
//
// 2026-05-29 MVP unblocking the /supporter page on the site. Walks
// the patreon:tier:<userId>:* prefix, filters opted-in patrons,
// surfaces tier + since date + raw amount so the site can render the
// hall. Cached via in-KV pointer for 1h since this changes slowly.
//
// Per-user opt-out toggle: `supporters-hall-optout:<userId>` → '1'.
// Set via the optOut endpoint.
//
// Schema returned:
//   { ok, supporters: [{ userId, tier, paid, amountCents?, since?,
//                        totalMonths? }], count, generatedUtc, cachedTtl }

const CACHE_KEY  = 'supporters-hall:cache';
const CACHE_TTL  = 3600;

async function listOptedInPatrons(env) {
  const out = [];
  let cursor;
  for (let i = 0; i < 6; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: 'patreon:tier:', cursor, limit: 1000,
    });
    for (const k of (page.keys || [])) {
      const userId = k.name.slice('patreon:tier:'.length);
      if (!userId) continue;
      const optedOut = await env.LOADOUT_BOLTS.get(`supporters-hall-optout:${userId}`);
      if (optedOut) continue;
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' }).catch(() => null);
      if (!rec) continue;
      const tierName = String(rec.tier || rec.tierName || '').trim();
      if (!tierName || /^free$/i.test(tierName)) continue;
      const amountCents = Number(rec.amount_cents || rec.amount || 0);
      out.push({
        userId,
        tier:        tierName,
        paid:        !!(rec.paid !== false),
        amountCents: Number.isFinite(amountCents) && amountCents > 0 ? amountCents : null,
        since:       rec.since || rec.linkedUtc || rec.startedUtc || null,
        totalMonths: Number.isFinite(+rec.totalMonths) ? +rec.totalMonths : null,
      });
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

function tierRank(tierName) {
  // Higher = more prestigious. Pulls a number out of "tier 3", "Tier 1
  // Patron", "T2", etc.; falls back to 0 when not parseable so unknown
  // tiers sink to the bottom.
  const m = String(tierName || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function sortSupporters(list) {
  return list.sort((a, b) => {
    const ar = tierRank(a.tier), br = tierRank(b.tier);
    if (ar !== br) return br - ar;
    if (a.since && b.since) {
      const ad = Date.parse(a.since), bd = Date.parse(b.since);
      if (ad !== bd) return ad - bd;
    } else if (a.since) return -1;
    else if (b.since) return 1;
    return String(a.userId).localeCompare(String(b.userId));
  });
}

export async function getSupportersHall(env, opts = {}) {
  const force = !!opts.force;
  if (!force) {
    const cached = await env.LOADOUT_BOLTS.get(CACHE_KEY, { type: 'json' }).catch(() => null);
    if (cached) return { ...cached, fromCache: true };
  }
  const supporters = sortSupporters(await listOptedInPatrons(env));
  const body = {
    ok: true,
    supporters,
    count: supporters.length,
    generatedUtc: new Date().toISOString(),
    cachedTtl: CACHE_TTL,
  };
  await env.LOADOUT_BOLTS.put(CACHE_KEY, JSON.stringify(body),
                              { expirationTtl: CACHE_TTL });
  return body;
}

export async function setSupportersHallOptOut(env, userId, optOut) {
  if (!userId) return { ok: false, error: 'no-user' };
  const key = `supporters-hall-optout:${userId}`;
  if (optOut) await env.LOADOUT_BOLTS.put(key, '1');
  else        await env.LOADOUT_BOLTS.delete(key);
  // Burst the cache so the next reader gets a fresh roster.
  await env.LOADOUT_BOLTS.delete(CACHE_KEY).catch(() => {});
  return { ok: true, optOut: !!optOut };
}
