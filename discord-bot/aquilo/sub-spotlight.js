// Twitch Sub Spotlight. Friday 10 AM ET cron fires this: pick a random
// active Twitch subscriber of the broadcaster's channel and post a
// "Sub Spotlight" embed in ENGAGEMENT_CHANNEL_ID.
//
// Replaces the old Patreon-role "Patron Spotlight" (spotlight.js) after
// the Twitch-native pivot — a supporter is now anyone subscribed on
// Twitch, so we source the pool from Helix /subscriptions (broadcaster
// user token, channel:read:subscriptions) instead of Discord roles.
//
// If the picked subscriber has linked their Twitch to Discord
// (plink:twitch:<twitchId>), we @-mention them; otherwise we shout out
// their Twitch name and link their channel. Never throws; degrades to a
// clean skip when Twitch isn't configured / authorized or nobody's subbed.

import { postChannelMessage } from './util.js';
import { helixFetch, isTwitchConfigured, hasTwitchUserAuth } from '../twitch-helix.js';
import { getSubTenure } from '../twitch-stats-store.js';

const KV_LAST_SPOTLIGHT = 'sub-spotlight:last_user';
const TWITCH_PURPLE = 0x9146FF;
const MAX_SUB_PAGES = 30; // up to 3000 subs @ 100/page

// Tier badge: Helix `tier` is "1000" | "2000" | "3000".
function tierInfo(tierRaw) {
  const t = Math.max(1, Math.min(3, Math.round(Number(tierRaw || 1000) / 1000) || 1));
  const stamp = t >= 3 ? '👑' : t >= 2 ? '💎' : '⭐';
  return { tier: t, stamp, label: 'Tier ' + t };
}

// Fetch the broadcaster's subscribers, keeping the Twitch user_id we need
// for the Discord-link lookup + avatar. Best-effort; returns [] on failure.
async function fetchSubscribers(env, broadcasterId) {
  const subs = [];
  try {
    let cursor;
    for (let page = 0; page < MAX_SUB_PAGES; page++) {
      const params = { broadcaster_id: broadcasterId, first: 100 };
      if (cursor) params.after = cursor;
      const j = await helixFetch(env, '/subscriptions', params, { userToken: true });
      if (!j || !Array.isArray(j.data)) break;
      for (const s of j.data) {
        if (String(s.user_id) === broadcasterId) continue; // broadcaster's own auto-entry
        subs.push({
          id: String(s.user_id),
          name: s.user_name || s.user_login || 'viewer',
          login: s.user_login || '',
          tierRaw: s.tier,
        });
      }
      cursor = j.pagination && j.pagination.cursor;
      if (!cursor) break;
    }
  } catch { /* best-effort */ }
  return subs;
}

async function fetchAvatar(env, login) {
  if (!login) return null;
  try {
    const j = await helixFetch(env, '/users', { login: [login] });
    const u = j && Array.isArray(j.data) ? j.data[0] : null;
    return (u && u.profile_image_url) || null;
  } catch { return null; }
}

async function resolveDiscordId(env, twitchId) {
  try {
    return (await env.LOADOUT_BOLTS.get(`plink:twitch:${twitchId}`, { type: 'text' })) || null;
  } catch { return null; }
}

export async function postSubSpotlight(env) {
  if (!env.ENGAGEMENT_CHANNEL_ID) return { skipped: 'no_channel' };
  if (!isTwitchConfigured(env)) return { skipped: 'twitch_not_configured' };
  const broadcasterId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  if (!broadcasterId) return { skipped: 'no_broadcaster' };
  if (!(await hasTwitchUserAuth(env))) return { skipped: 'no_user_token' };

  const subs = await fetchSubscribers(env, broadcasterId);
  if (!subs.length) return { skipped: 'no_subscribers' };

  // Attach tenure (months) where a resub has been observed. Forward-only.
  try {
    const tenure = await getSubTenure(env);
    for (const s of subs) {
      const m = s.login && tenure[s.login];
      if (m) s.months = Number(m) || undefined;
    }
  } catch { /* best-effort */ }

  // Avoid spotlighting the same Twitch account two weeks running.
  const last = await env.STATE.get(KV_LAST_SPOTLIGHT).catch(() => null);
  const pool = subs.length > 1 ? subs.filter((s) => s.id !== last) : subs;
  const pick = pool[Math.floor(Math.random() * pool.length)];

  const { stamp, label } = tierInfo(pick.tierRaw);
  const login = pick.login || '';
  const channelUrl = login ? 'https://twitch.tv/' + login : null;
  const [avatar, discordId] = await Promise.all([
    fetchAvatar(env, login),
    resolveDiscordId(env, pick.id),
  ]);

  // Headline: @-mention when the sub has linked Discord; otherwise a
  // bolded (and channel-linked) Twitch name.
  const who = discordId
    ? '<@' + discordId + '>'
    : (channelUrl ? '[' + pick.name + '](' + channelUrl + ')' : '**' + pick.name + '**');

  const lines = [stamp + ' ' + who + ' — _' + label + ' subscriber_'];
  if (pick.months) {
    lines.push('💜 Subscribed for ' + pick.months + ' month' + (pick.months === 1 ? '' : 's'));
  }
  lines.push('');
  lines.push('Thank you for supporting the stream! Drop a 👋 and show some love.');

  const embed = {
    title: '⚡ Sub Spotlight',
    url: channelUrl || undefined,
    description: lines.join('\n'),
    color: TWITCH_PURPLE,
    thumbnail: avatar ? { url: avatar } : undefined,
    footer: { text: 'Aquilo · Twitch Sub Spotlight · Fridays' },
  };

  const payload = { embeds: [embed] };
  if (discordId) {
    payload.content = '<@' + discordId + '>';
    payload.allowed_mentions = { parse: [], users: [discordId] };
  } else {
    payload.allowed_mentions = { parse: [] };
  }
  await postChannelMessage(env, env.ENGAGEMENT_CHANNEL_ID, payload);
  await env.STATE.put(KV_LAST_SPOTLIGHT, pick.id).catch(() => {});
  return { spotlighted: pick.id, login, tier: label, linked: !!discordId };
}
