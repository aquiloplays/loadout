// Site → bot games sync.
//
// aquilo.gg/admin manages the canonical game catalog at
// `games:v1:<guildId>` in the shared LOADOUT_BOLTS KV namespace (see
// aquilo-site functions/_lib/schedule.js). The Community Votes Night
// polls (aquilo/poll.js) draw their candidates from the D1 `games`
// table, so this mirrors the KV catalog's "community" pool into D1:
// upsert actives, refresh art, deactivate anything removed on the
// site. Vote history is untouched, poll_options pins game ids and
// deactivated rows keep their ids.
//
// Called from /admin/aquilo/site-sync/:guildId (worker.js), which the
// site's admin games/schedule editors ping after every save.
export async function syncSiteGamesToD1(env, guildId) {
  const cat = await env.LOADOUT_BOLTS.get(`games:v1:${guildId}`, { type: 'json' });
  const items = (cat && Array.isArray(cat.items)) ? cat.items : [];
  const pool = items.filter((g) =>
    g && g.name && Array.isArray(g.pools) && g.pools.includes('community'));
  if (!pool.length) {
    // An empty community pool is far more likely a bad save than a real
    // intent to deactivate every game, so refuse to mass-deactivate.
    return { synced: 0, deactivated: 0, skipped: 'empty-community-pool' };
  }

  const names = pool.map((g) => String(g.name).slice(0, 80));
  let synced = 0;
  for (const g of pool) {
    const name = String(g.name).slice(0, 80);
    const art = g.headerUrl || g.capsuleUrl || null;
    await env.DB.prepare(
      `INSERT INTO games (guild_id, name, art_url, active, dropped_at)
       VALUES (?, ?, ?, 1, NULL)
       ON CONFLICT (guild_id, name)
       DO UPDATE SET art_url = COALESCE(excluded.art_url, games.art_url),
                     active = 1, dropped_at = NULL`
    ).bind(guildId, name, art).run();
    synced++;
  }

  const placeholders = names.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `UPDATE games SET active = 0, dropped_at = datetime('now')
     WHERE guild_id = ? AND active = 1 AND name NOT IN (${placeholders})`
  ).bind(guildId, ...names).run();

  return { synced, deactivated: r?.meta?.changes ?? 0 };
}
