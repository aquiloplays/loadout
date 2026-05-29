// Patron of the Month — auto-select monthly winner + history surface.
//
// 2026-05-29 MVP unblocking the site's patron-of-month feature.
// First-of-month cron (wired in worker.js scheduled handler) picks
// the highest cumulative supporter from patreon:tier:* records
// (subject to opt-out), writes patron-of-month:<YYYY-MM>, posts an
// announcement embed to env.PATRON_OF_MONTH_CHANNEL_ID, grants the
// 30-day role env.PATRON_OF_MONTH_ROLE_ID.
//
// KV layout:
//   patron-of-month:<YYYY-MM>           selected winner record
//   patron-of-month-optout:<userId>     '1' = opt-out
//   patron-of-month-role-expiry:<userId> ms timestamp when role expires

const KEY = {
  winner:  (ym) => `patron-of-month:${ym}`,
  optout:  (u)  => `patron-of-month-optout:${u}`,
  expiry:  (u)  => `patron-of-month-role-expiry:${u}`,
};

function yearMonth(d = new Date()) {
  return d.getUTCFullYear() + '-' +
         String(d.getUTCMonth() + 1).padStart(2, '0');
}

function prevYearMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return yearMonth(d);
}

// Score = monthly pledge amount (cents). Tiebreak: longer-tenured wins
// (smaller `since` epoch). Returns winner record or null.
async function pickWinner(env) {
  let cursor;
  let best = null;
  for (let i = 0; i < 6; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: 'patreon:tier:', cursor, limit: 1000,
    });
    for (const k of (page.keys || [])) {
      const userId = k.name.slice('patreon:tier:'.length);
      const optedOut = await env.LOADOUT_BOLTS.get(KEY.optout(userId));
      if (optedOut) continue;
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' }).catch(() => null);
      if (!rec) continue;
      const tier = String(rec.tier || rec.tierName || '').trim();
      if (!tier || /^free$/i.test(tier)) continue;
      const amount = Number(rec.amount_cents || rec.amount || 0);
      const sinceMs = Date.parse(rec.since || rec.linkedUtc || rec.startedUtc || '') || Number.MAX_SAFE_INTEGER;
      const candidate = { userId, tier, amountCents: amount, sinceMs };
      if (!best
          || candidate.amountCents > best.amountCents
          || (candidate.amountCents === best.amountCents && candidate.sinceMs < best.sinceMs)) {
        best = candidate;
      }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return best;
}

export async function getCurrentPatron(env) {
  const ym = prevYearMonth();
  const rec = await env.LOADOUT_BOLTS.get(KEY.winner(ym), { type: 'json' });
  return { ok: true, month: ym, winner: rec || null };
}

export async function getPatronHistory(env, opts = {}) {
  const limit = Math.max(1, Math.min(36, parseInt(opts.limit, 10) || 12));
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  for (let i = 0; i < limit; i++) {
    const ym = yearMonth(d);
    const rec = await env.LOADOUT_BOLTS.get(KEY.winner(ym), { type: 'json' });
    if (rec) out.push({ month: ym, ...rec });
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return { ok: true, history: out };
}

export async function setPatronOptOut(env, userId, optOut) {
  if (!userId) return { ok: false, error: 'no-user' };
  if (optOut) await env.LOADOUT_BOLTS.put(KEY.optout(userId), '1');
  else        await env.LOADOUT_BOLTS.delete(KEY.optout(userId));
  return { ok: true, optOut: !!optOut };
}

// Cron + admin entrypoint. Idempotent — re-running for the same month
// returns the existing record instead of re-selecting.
export async function runMonthlySelection(env) {
  const ym = prevYearMonth();
  const existing = await env.LOADOUT_BOLTS.get(KEY.winner(ym), { type: 'json' });
  if (existing) {
    return { ok: true, month: ym, winner: existing, alreadyRan: true };
  }
  const candidate = await pickWinner(env);
  if (!candidate) {
    return { ok: true, month: ym, winner: null, reason: 'no-eligible-patrons' };
  }
  const winner = {
    ...candidate,
    selectedUtc: new Date().toISOString(),
  };
  await env.LOADOUT_BOLTS.put(KEY.winner(ym), JSON.stringify(winner));

  // Best-effort Discord announcement + role grant.
  let announced = false, roleGranted = false;
  if (env.DISCORD_BOT_TOKEN && env.PATRON_OF_MONTH_CHANNEL_ID) {
    try {
      const r = await fetch(
        `https://discord.com/api/v10/channels/${env.PATRON_OF_MONTH_CHANNEL_ID}/messages`,
        { method: 'POST',
          headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: `Patron of the Month — ${ym}`,
              description: `<@${winner.userId}> — thank you for being our ` +
                `most generous supporter this month. Your support keeps ` +
                `Aquilo flying. 💜`,
              color: 0xFF6AB5,
              footer: { text: `Tier: ${winner.tier}` },
            }],
          }) },
      );
      announced = r.ok;
    } catch { /* non-fatal */ }
  }
  if (env.DISCORD_BOT_TOKEN && env.AQUILO_VAULT_GUILD_ID
      && env.PATRON_OF_MONTH_ROLE_ID) {
    try {
      const r = await fetch(
        `https://discord.com/api/v10/guilds/${env.AQUILO_VAULT_GUILD_ID}/members/${winner.userId}/roles/${env.PATRON_OF_MONTH_ROLE_ID}`,
        { method: 'PUT', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } },
      );
      roleGranted = r.ok;
      if (r.ok) {
        const endsUtc = Date.now() + 30 * 24 * 3600_000;
        await env.LOADOUT_BOLTS.put(KEY.expiry(winner.userId), String(endsUtc));
      }
    } catch { /* non-fatal */ }
  }
  return { ok: true, month: ym, winner, announced, roleGranted };
}

// Sweep — strip the role from anyone whose expiry has passed. Called
// from the same cron tick so winners get exactly 30 days.
export async function sweepExpiredRoles(env) {
  if (!env.DISCORD_BOT_TOKEN || !env.AQUILO_VAULT_GUILD_ID
      || !env.PATRON_OF_MONTH_ROLE_ID) {
    return { ok: false, error: 'not-configured' };
  }
  const now = Date.now();
  let cursor, stripped = 0;
  for (let i = 0; i < 4; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: 'patron-of-month-role-expiry:', cursor, limit: 1000,
    });
    for (const k of (page.keys || [])) {
      const endsUtc = parseInt(await env.LOADOUT_BOLTS.get(k.name), 10);
      if (!Number.isFinite(endsUtc) || endsUtc > now) continue;
      const userId = k.name.slice('patron-of-month-role-expiry:'.length);
      try {
        await fetch(
          `https://discord.com/api/v10/guilds/${env.AQUILO_VAULT_GUILD_ID}/members/${userId}/roles/${env.PATRON_OF_MONTH_ROLE_ID}`,
          { method: 'DELETE', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } },
        );
        await env.LOADOUT_BOLTS.delete(k.name);
        stripped++;
      } catch { /* non-fatal */ }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return { ok: true, stripped };
}
