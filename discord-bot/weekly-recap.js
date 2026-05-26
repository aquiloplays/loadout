// Weekly recap — Sunday 8pm ET, one styled embed in RECAP_CHANNEL_ID
// summarising the past 7 days.
//
// Assembler is opportunistic: each section is independently best-
// effort, and a section with no data is silently omitted. That way
// the recap can run today against the existing data (XP + starboard)
// and grow new sections automatically once the corresponding data
// surfaces (new-member counter once the gateway shim lands, etc.).
//
// One-per-ISO-week idempotency via `recap:weekly:last-week:<g>` — a
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

// ── Section collectors — each returns a {title, value} embed-field
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
      return `${i + 1}. ${p.starCount || 0} ⭐ — **${p.authorName || 'someone'}**` +
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
  // a leaderboard. Skip — emit nothing rather than fake numbers. If
  // a `clash:wars:weekly:<g>` aggregator gets added later this
  // section can fill in without a recap.js change.
  try {
    const aggregator = await env.LOADOUT_BOLTS.get(`clash:wars:weekly:${guildId}`, { type: 'json' });
    if (!Array.isArray(aggregator) || aggregator.length === 0) return null;
    const top = aggregator.slice(0, 3);
    const lines = top.map((w, i) => `${i + 1}. **${w.townName || w.guildId}** — ${w.wins} wins`);
    return { name: '⚔️  Top Clash war winners', value: lines.join('\n'), inline: false };
  } catch { return null; }
}

async function sectionBoltbound(env, guildId) {
  // Same shape as the Clash section — graceful skip when no
  // weekly aggregator exists yet. Future-proof key:
  // `boltbound:weekly:<g>` → [{ userId, wins, ... }, ...].
  try {
    const aggregator = await env.LOADOUT_BOLTS.get(`boltbound:weekly:${guildId}`, { type: 'json' });
    if (!Array.isArray(aggregator) || aggregator.length === 0) return null;
    const best = aggregator[0];
    return {
      name: '🃏  Best Boltbound this week',
      value: `<@${best.userId}> — **${best.wins}** wins`,
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

async function sectionTopReactions(env, guildId) {
  // Gateway-shim-dependent — we don't ingest MESSAGE_REACTION_ADD
  // events from chat-at-large, just the starboard ⭐ pathway. Until
  // a forwarder writes a `guild:reactions:weekly:<g>` aggregator
  // (top emoji counts), this section omits.
  try {
    const aggregator = await env.LOADOUT_BOLTS.get(`guild:reactions:weekly:${guildId}`, { type: 'json' });
    if (!Array.isArray(aggregator) || aggregator.length === 0) return null;
    const top = aggregator.slice(0, 5);
    const lines = top.map((r, i) => `${i + 1}. ${r.emoji} — ${r.count}`);
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
    sectionTopStarboard(env, guildId),
    sectionClashWars(env, guildId),
    sectionBoltbound(env, guildId),
    sectionNewMembers(env, guildId),
    sectionTopReactions(env, guildId),
  ])).filter(Boolean);

  // Even with zero data sections we stamp the week so we don't
  // keep retrying every hourly tick this Sunday — and we still
  // post a one-line "quiet week" embed so the channel stays alive.
  await env.LOADOUT_BOLTS.put(LAST_WEEK_KEY(guildId), week);

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

  const r = await fetch(`https://discord.com/api/v10/channels/${recapChannelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord weekly-recap',
    },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: 'post-failed', status: r.status, body: t.slice(0, 200), week };
  }
  const j = await r.json();
  return { ok: true, week, messageId: j.id, sectionsCount: sections.length };
}

export { isoWeek as _isoWeekForTest };
