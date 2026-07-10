// Weekly recap, Sunday 8pm ET, one styled embed in RECAP_CHANNEL_ID
// summarising the past 7 days.
//
// Assembler is opportunistic: each section is independently best-
// effort, and a section with no data is silently omitted. That way
// the recap can run today against the existing data (XP + starboard)
// and grow new sections automatically once the corresponding data
// surfaces (new-member counter once the gateway shim lands, etc.).
//
// One-per-ISO-week idempotency via `recap:weekly:last-week:<g>`, a
// re-run on the same Sunday is a no-op so we can't double-post even
// if the :17 hourly cron somehow ticks twice (cron at-least-once
// delivery semantics).

import { topXp } from './progression/xp.js';
import { getBranding } from './branding.js';
import { getChannelBinding } from './channel-bindings.js';

const LAST_WEEK_KEY = (g) => `recap:weekly:last-week:${g}`;

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86_400_000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

// ── Section collectors, each returns a {title, value} embed-field
// or null when there's no data. assembleSections() filters nulls
// out so the embed is tight.

async function sectionTopXp(env) {
  try {
    const rows = await topXp(env, 5);
    if (!rows || rows.length === 0) return null;
    const lines = rows.map((r, i) =>
      `${i + 1}. <@${r.userId}> · **${(r.xp || 0).toLocaleString()}** XP (L${r.level || 1})`,
    );
    return { name: '🏅  Top XP', value: lines.join('\n'), inline: false };
  } catch (e) {
    console.warn('[recap] topXp failed', e?.message || e);
    return null;
  }
}

async function sectionTopStarboard(env, guildId) {
  try {
    const list = await env.LOADOUT_BOLTS.get(`guild:starboard:recent:${guildId}`, { type: 'json' });
    if (!Array.isArray(list) || list.length === 0) return null;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const inWindow = list.filter(item => item && (item.ts || 0) >= sevenDaysAgo);
    if (inWindow.length === 0) return null;
    const top = inWindow.sort((a, b) => (b.starCount || 0) - (a.starCount || 0)).slice(0, 3);
    const lines = top.map((p, i) => {
      const snippet = (p.content || '').slice(0, 80).replace(/\n+/g, ' ');
      const link = p.originalUrl ? ` · [jump](${p.originalUrl})` : '';
      return `${i + 1}. ${p.starCount || 0} ⭐, **${p.authorName || 'someone'}**` +
             (snippet ? `: _${snippet}${(p.content || '').length > 80 ? '…' : ''}_` : '') +
             link;
    });
    return { name: '⭐  Top starboard posts', value: lines.join('\n'), inline: false };
  } catch (e) {
    console.warn('[recap] topStarboard failed', e?.message || e);
    return null;
  }
}

async function sectionClashWars(env, guildId) {
  // The clash module's town-records use a structure (town:<g>) that
  // doesn't currently track a per-week win counter; without that
  // we'd be scraping every war record across all towns to assemble
  // a leaderboard. Skip, emit nothing rather than fake numbers. If
  // a `clash:wars:weekly:<g>` aggregator gets added later this
  // section can fill in without a recap.js change.
  try {
    const aggregator = await env.LOADOUT_BOLTS.get(`clash:wars:weekly:${guildId}`, { type: 'json' });
    if (!Array.isArray(aggregator) || aggregator.length === 0) return null;
    const top = aggregator.slice(0, 3);
    const lines = top.map((w, i) => `${i + 1}. **${w.townName || w.guildId}**, ${w.wins} wins`);
    return { name: '⚔️  Top Clash war winners', value: lines.join('\n'), inline: false };
  } catch { return null; }
}

async function sectionBoltbound(env, guildId) {
  // Same shape as the Clash section, graceful skip when no
  // weekly aggregator exists yet. Future-proof key:
  // `boltbound:weekly:<g>` → [{ userId, wins, ... }, ...].
  try {
    const aggregator = await env.LOADOUT_BOLTS.get(`boltbound:weekly:${guildId}`, { type: 'json' });
    if (!Array.isArray(aggregator) || aggregator.length === 0) return null;
    const best = aggregator[0];
    return {
      name: '🃏  Best Boltbound this week',
      value: `<@${best.userId}>, **${best.wins}** wins`,
      inline: false,
    };
  } catch { return null; }
}

async function sectionNewMembers(env, guildId) {
  // Gateway-shim-dependent: welcome.js increments
  // `guild:join-counter:<g>` on each MEMBER_ADD. We don't snapshot
  // it per-week, so the BEST we can do here is read the current
  // counter and the previous week's snapshot we leave behind on
  // each recap. First-ever run can't compute a delta, so omits.
  try {
    const cur = parseInt((await env.LOADOUT_BOLTS.get(`guild:join-counter:${guildId}`)) || '0', 10);
    const prevSnap = await env.LOADOUT_BOLTS.get(`recap:join-snap:${guildId}`, { type: 'json' });
    // Always re-snap so NEXT week has a baseline.
    await env.LOADOUT_BOLTS.put(`recap:join-snap:${guildId}`, JSON.stringify({
      counter: cur, ts: Date.now(),
    }));
    if (!prevSnap || typeof prevSnap.counter !== 'number') return null;
    const delta = Math.max(0, cur - prevSnap.counter);
    if (delta === 0) return null;
    return {
      name: '👋  New members',
      value: `**${delta}** new member${delta === 1 ? '' : 's'} joined this week.`,
      inline: false,
    };
  } catch (e) {
    console.warn('[recap] newMembers failed', e?.message || e);
    return null;
  }
}

// ── 2026-07-09 enrichment (community roadmap item 15) ─────────────

// UTC day-string diff for "is this streak still alive" checks.
// Inputs are YYYY-MM-DD (the ET day-keys community-checkin stores).
function dayDiff(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  if (![ay, am, ad, by, bm, bd].every(Number.isFinite)) return Infinity;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

// Top-3 ACTIVE check-in streaks. Walks community-checkin:<g>:* via
// KV list() METADATA only — community-checkin.js saveState attaches
// { streak, lastDayEt } to every put, so the whole roster costs 1-5
// list subrequests and ZERO gets. Keys written before the metadata
// change (legacy state) fall back to a per-key get, hard-capped so a
// large un-migrated roster can't exhaust the shared Sunday-cron
// invocation's subrequest budget — once the cap is hit the section
// degrades to a partial top-3 built from whatever rows were readable.
// A streak counts as active when the last check-in was today or
// yesterday (ET) — older means it's broken and shouting it out would
// be salt in the wound.
const STREAK_LEGACY_GET_CAP = 20;

async function sectionTopStreaks(env, guildId) {
  try {
    const { todayET } = await import('./community-checkin.js');
    const today = todayET();
    const prefix = `community-checkin:${guildId}:`;
    const rows = [];
    let cursor;
    let legacyGets = 0;
    for (let page = 0; page < 5; page++) {
      const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
      for (const k of r.keys) {
        let st = null;
        const md = k.metadata;
        if (md && (md.streak !== undefined || md.lastDayEt !== undefined)) {
          // Metadata row (post-deploy state). `longest` isn't carried
          // in metadata, so the cosmetic "(best N)" annotation is
          // omitted for these rows — worth it, the walk stays O(list).
          st = { streak: md.streak, lastDayEt: md.lastDayEt, longest: md.streak };
        } else {
          // Legacy metadata-less key: bounded get-fallback. Over the
          // cap → skip (partial rows) rather than burn the invocation.
          if (legacyGets >= STREAK_LEGACY_GET_CAP) continue;
          legacyGets++;
          const full = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
          if (full) st = { streak: full.streak, lastDayEt: full.lastDayEt, longest: full.longest || full.streak };
        }
        if (!st || !(st.streak > 0) || !st.lastDayEt) continue;
        if (dayDiff(st.lastDayEt, today) > 1) continue;
        rows.push({
          userId: k.name.slice(prefix.length),
          streak: st.streak,
          longest: st.longest || st.streak,
        });
      }
      if (r.list_complete || !r.cursor) break;
      cursor = r.cursor;
    }
    if (rows.length === 0) return null;
    rows.sort((a, b) => b.streak - a.streak);
    const lines = rows.slice(0, 3).map((r, i) =>
      `${i + 1}. <@${r.userId}> · 🔥 **${r.streak}-day** streak` +
      (r.longest > r.streak ? ` _(best ${r.longest})_` : ''),
    );
    return { name: '🔥  Longest active check-in streaks', value: lines.join('\n'), inline: false };
  } catch (e) {
    console.warn('[recap] topStreaks failed', e?.message || e);
    return null;
  }
}

// This week's community challenge result. The recap fires Sunday 8pm
// ET; the worker-side rotation gate (worker.js ':23' block) holds the
// weekly rotation until Monday 02:23 UTC (after this recap in both
// DST regimes) so challenge:current is normally the week being
// recapped. Defense-in-depth: if challenge:current was minted within
// the last 3h (a delayed tick let the rotation run first), fall back
// to the just-closed week's entry in challenge:list / its archive
// record so the recap never reports the NEW week's 0-progress bar.
async function sectionWeeklyChallenge(env) {
  try {
    const { readCurrent } = await import('./challenges.js');
    let c = await readCurrent(env);
    if (!c || !c.name) return null;
    // `fresh` = rotation already ran inside this recap window.
    const fresh = !!c.startedUtc && (Date.now() - c.startedUtc) < 3 * 3600e3;
    let rotatedAway = false;   // rendering the just-closed week's record
    if (fresh) {
      const list = await env.LOADOUT_BOLTS.get('challenge:list', { type: 'json' });
      const prev = Array.isArray(list) && list.length ? list[0] : null;
      if (prev && prev.name) {
        // Prefer the full archive record (has contributors + icon);
        // the list entry alone lacks both, degrade gracefully.
        let full = null;
        if (prev.id) {
          try { full = await env.LOADOUT_BOLTS.get(`challenge:archive:${prev.id}`, { type: 'json' }); }
          catch { /* list entry is enough */ }
        }
        c = (full && full.name) ? full : prev;
        rotatedAway = true;
      }
      // No list entry (first-ever week): keep rendering the fresh
      // current challenge, just without the misleading final-push line.
    }
    const progress = c.progress | 0;
    const target = Math.max(1, c.target | 0);
    const pct = Math.min(100, Math.round((progress / target) * 100));
    // A rotated-away challenge is CLOSED: done means it completed, no
    // "final push" is possible anymore.
    const done = !!c.completedUtc || progress >= target;
    const contributors = Object.keys(c.contributors || {}).length;
    const lines = [
      (done ? '✅ **COMPLETE!** ' : '') +
        `**${c.name}**: ${progress.toLocaleString()} / ${target.toLocaleString()} (${pct}%)`,
    ];
    if (contributors > 0) lines.push(`${contributors} contributor${contributors === 1 ? '' : 's'} pitched in.`);
    if (!done) {
      if (rotatedAway) {
        lines.push('_A fresh challenge is already live. Check the challenge channel!_');
      } else if (!fresh) {
        lines.push('_Final push: a fresh challenge starts Monday._');
      }
    }
    return { name: `${c.icon || '🎯'}  Weekly challenge`, value: lines.join('\n'), inline: false };
  } catch (e) {
    console.warn('[recap] weeklyChallenge failed', e?.message || e);
    return null;
  }
}

// Clip of the week: the same D1 tally aquilo/clipoftheweek.js posts
// from Sunday 10am ET; the recap re-surfaces the current leader with
// its link so night-missers can one-click it.
async function sectionClipOfTheWeek(env) {
  try {
    if (!env.DB) return null;
    const { weekStartET } = await import('./aquilo/util.js');
    const since = weekStartET();
    const row = await env.DB.prepare(
      `SELECT author_id, url, clap_count
         FROM clips
        WHERE posted_at >= ? AND clap_count > 0
        ORDER BY clap_count DESC, posted_at ASC
        LIMIT 1`
    ).bind(since).first();
    if (!row || !row.url) return null;
    return {
      name: '🎬  Clip of the week',
      value: `👏 **${row.clap_count}** · shared by <@${row.author_id}>\n${row.url}`,
      inline: false,
    };
  } catch (e) {
    console.warn('[recap] clipOfTheWeek failed', e?.message || e);
    return null;
  }
}

// ("Community vs. The House" — the shared panel-game payout path this
// section would count from (ext-econ.js) is WIP in another checkout
// and does NOT exist on the deployed sunset line, so the per-ISO-week
// won/lost counters were intentionally NOT added here. When that
// payout path lands, add the two KV counters there and a section
// reading them here.)

async function sectionTopReactions(env, guildId) {
  // Gateway-shim-dependent, we don't ingest MESSAGE_REACTION_ADD
  // events from chat-at-large, just the starboard ⭐ pathway. Until
  // a forwarder writes a `guild:reactions:weekly:<g>` aggregator
  // (top emoji counts), this section omits.
  try {
    const aggregator = await env.LOADOUT_BOLTS.get(`guild:reactions:weekly:${guildId}`, { type: 'json' });
    if (!Array.isArray(aggregator) || aggregator.length === 0) return null;
    const top = aggregator.slice(0, 5);
    const lines = top.map((r, i) => `${i + 1}. ${r.emoji}, ${r.count}`);
    return { name: '🎉  Most-used reactions', value: lines.join('\n'), inline: false };
  } catch { return null; }
}

// ── Public entry ──────────────────────────────────────────────────

export async function postWeeklyRecap(env) {
  if (!env.DISCORD_BOT_TOKEN) return { skipped: 'no-bot-token' };
  const guildId = env.AQUILO_VAULT_GUILD_ID;
  if (!guildId) return { skipped: 'no-guild-id' };
  const recapChannelId = await getChannelBinding(env, guildId, 'recap');
  if (!recapChannelId) return { skipped: 'no-recap-channel' };

  const week = isoWeek(new Date());
  const last = await env.LOADOUT_BOLTS.get(LAST_WEEK_KEY(guildId));
  if (last === week) return { skipped: 'already-posted-this-week', week };

  const sections = (await Promise.all([
    sectionTopXp(env),
    sectionTopStreaks(env, guildId),
    sectionWeeklyChallenge(env),
    sectionTopStarboard(env, guildId),
    sectionClipOfTheWeek(env),
    sectionClashWars(env, guildId),
    sectionBoltbound(env, guildId),
    sectionNewMembers(env, guildId),
    sectionTopReactions(env, guildId),
  ])).filter(Boolean);

  // Even with zero data sections we stamp the week so we don't
  // keep retrying every hourly tick this Sunday, and we still
  // post a one-line "quiet week" embed so the channel stays alive.
  // Own try/catch with a distinct tag: if this put throws (KV outage,
  // subrequest-budget exhaustion), bail WITHOUT posting — posting
  // unstamped risks a double-post on the cron's at-least-once retry,
  // and the distinct log line tells us exactly which step died.
  try {
    await env.LOADOUT_BOLTS.put(LAST_WEEK_KEY(guildId), week);
  } catch (e) {
    console.warn('[recap] last-week stamp put failed:', e?.message || e);
    return { ok: false, error: 'stamp-failed', week };
  }

  const brand = await getBranding(env, guildId);
  const embed = sections.length > 0 ? {
    title: `📅  Week in review · ${week}`,
    description: `Here\'s what happened in the last 7 days on ${brand.brandName}.`,
    color: brand.accentColor,
    fields: sections,
    timestamp: new Date().toISOString(),
  } : {
    title: `📅  Week in review · ${week}`,
    description: 'Quiet week. See you next Sunday.',
    color: brand.accentColor,
    timestamp: new Date().toISOString(),
  };

  // Own try/catch with a distinct tag (see the stamp put above): a
  // throw here (network failure, budget exhaustion) must be legible
  // in the logs as "the Discord POST died", not a generic cron warn.
  let r;
  try {
    r = await fetch(`https://discord.com/api/v10/channels/${recapChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent':   'loadout-discord weekly-recap',
      },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    });
  } catch (e) {
    console.warn('[recap] discord post threw:', e?.message || e);
    return { ok: false, error: 'post-threw', message: String(e?.message || e), week };
  }
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: 'post-failed', status: r.status, body: t.slice(0, 200), week };
  }
  const j = await r.json();
  return { ok: true, week, messageId: j.id, sectionsCount: sections.length };
}

export { isoWeek as _isoWeekForTest };
