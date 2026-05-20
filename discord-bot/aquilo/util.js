// Shared helpers for the slash-command handlers in schedule.js, queue.js,
// and poll.js. The original worker.js inlined option-parsing + Discord
// REST; pulled out here so the new feature modules can stay terse.

export const TYPE_PING = 1;
export const TYPE_APPLICATION_CMD = 2;
export const RESP_PONG = 1;
export const RESP_CHAT = 4;
export const FLAG_EPHEMERAL = 64;

export function ephemeral(content) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL } };
}

export function chat(payload) {
  return { type: RESP_CHAT, data: payload };
}

// Discord interaction option arrays come back as [{name, type, value}, ...].
// For subcommand-style commands the top-level option is the subcommand and
// its own .options carries the leaf args.
export function flattenOptions(options) {
  const out = {};
  if (!Array.isArray(options)) return out;
  for (const o of options) {
    if (typeof o.value !== 'undefined') out[o.name] = o.value;
  }
  return out;
}

export function getSubcommand(data) {
  const top = data?.data?.options?.[0];
  if (!top || top.type !== 1) return { name: null, options: {} };
  return { name: top.name, options: flattenOptions(top.options) };
}

// Wrapper for Discord REST. Throws with status + truncated body on non-2xx
// so callers can return a useful ephemeral error. 204 returns null.
export async function discordFetch(env, path, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not configured');
  const headers = {
    'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
    'Content-Type':  'application/json',
    'User-Agent':    'aquilo-bot-worker (1.0)',
    ...(opts.headers || {})
  };
  const resp = await fetch('https://discord.com/api/v10' + path, { ...opts, headers });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('Discord ' + resp.status + ' ' + path + ': ' + t.slice(0, 300));
  }
  if (resp.status === 204) return null;
  return resp.json();
}

export function postChannelMessage(env, channelId, payload) {
  return discordFetch(env, '/channels/' + encodeURIComponent(channelId) + '/messages', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function editChannelMessage(env, channelId, messageId, payload) {
  return discordFetch(env,
    '/channels/' + encodeURIComponent(channelId) +
    '/messages/' + encodeURIComponent(messageId), {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export const COLOR_SCHEDULE = 0x3A86FF;
export const COLOR_POLL     = 0xF0B429;
export const COLOR_QUEUE    = 0x9147FF;

export function cap(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Extract a Steam store URL from a Steam header.jpg URL by pulling the
// app id out of the path. Works for both the cdn.cloudflare.steamstatic
// pattern and the hashed shared.akamai pattern. Returns null if the
// input doesn't look like a Steam asset URL (e.g. Minecraft's Wikimedia).
export function steamStoreUrl(artUrl) {
  if (!artUrl) return null;
  const m = String(artUrl).match(/\/steam\/apps\/(\d+)\//);
  if (!m) return null;
  return 'https://store.steampowered.com/app/' + m[1] + '/';
}

// Admin check from interaction's member.permissions bitfield string.
// Treats Administrator | ManageGuild | ManageMessages as admin.
export function isAdmin(data) {
  if (!data?.member?.permissions) return false;
  try {
    const perms = BigInt(data.member.permissions);
    return (perms & 0x8n) !== 0n || (perms & 0x20n) !== 0n || (perms & 0x2000n) !== 0n;
  } catch { return false; }
}

// ---- Component builders ------------------------------------------------

// Discord interaction response types (RESP_PONG / RESP_CHAT are exported
// at the top of the file for backward compat; remaining types added here).
export const RESP_DEFER              = 5;   // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
export const RESP_DEFER_UPDATE       = 6;   // DEFERRED_UPDATE_MESSAGE
export const RESP_UPDATE_MESSAGE     = 7;   // UPDATE_MESSAGE
export const RESP_MODAL              = 9;   // MODAL

// Component types
export const C_ACTION_ROW = 1;
export const C_BUTTON     = 2;
export const C_SELECT     = 3;
export const C_TEXT_INPUT = 4;

// Button styles
export const BTN_PRIMARY   = 1;  // blurple
export const BTN_SECONDARY = 2;  // grey
export const BTN_SUCCESS   = 3;  // green
export const BTN_DANGER    = 4;  // red
export const BTN_LINK      = 5;  // url-link, no custom_id

export function btn(custom_id, label, opts = {}) {
  const b = {
    type: C_BUTTON,
    style: opts.style ?? BTN_SECONDARY,
    custom_id,
    label: (label || '').slice(0, 80)
  };
  if (opts.emoji) b.emoji = typeof opts.emoji === 'string' ? { name: opts.emoji } : opts.emoji;
  if (opts.disabled) b.disabled = true;
  return b;
}

export function linkBtn(url, label, opts = {}) {
  const b = {
    type: C_BUTTON,
    style: BTN_LINK,
    url,
    label: (label || '').slice(0, 80)
  };
  if (opts.emoji) b.emoji = typeof opts.emoji === 'string' ? { name: opts.emoji } : opts.emoji;
  return b;
}

export function row(...children) {
  return { type: C_ACTION_ROW, components: children.filter(Boolean) };
}

// Update-message response (used after button click that should refresh the
// original message, e.g. updating a poll's vote tally inline).
export function updateMessage(payload) {
  return { type: RESP_UPDATE_MESSAGE, data: payload };
}

// Modal response. fields is an array of { custom_id, label, style?, value?,
// placeholder?, required?, max_length?, min_length? }. style 1 = SHORT, 2 = PARAGRAPH.
export function modal(custom_id, title, fields) {
  return {
    type: RESP_MODAL,
    data: {
      custom_id,
      title: title.slice(0, 45),
      components: fields.map(f => ({
        type: C_ACTION_ROW,
        components: [{
          type: C_TEXT_INPUT,
          custom_id: f.custom_id,
          label: f.label.slice(0, 45),
          style: f.style ?? 1,
          value: f.value || undefined,
          placeholder: f.placeholder || undefined,
          required: f.required ?? false,
          max_length: f.max_length || undefined,
          min_length: f.min_length || undefined
        }]
      }))
    }
  };
}

// ---- ET time helpers ---------------------------------------------------

// Returns the day-of-week + hour (24h) in America/New_York for the given date.
// Used by the scheduled() handler to dispatch on hourly cron ticks.
export function getETInfo(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  // Intl can return "24" for hour at midnight under hour12:false; normalize to 0.
  const hour = parseInt(get('hour'), 10) % 24;
  return {
    weekday: (get('weekday') || '').toLowerCase(),
    year:    parseInt(get('year'), 10),
    month:   parseInt(get('month'), 10),
    day:     parseInt(get('day'), 10),
    hour:    Number.isFinite(hour) ? hour : 0,
    minute:  parseInt(get('minute'), 10)
  };
}

// Compute the start-of-week boundary (Sunday 00:00 ET, in UTC ISO form) for
// the given date. Used to filter "polls posted this week" for cross-poll
// winner exclusion. Approximation: returns midnight UTC of the calendar
// date that was Sunday in ET — close enough since polls fire at fixed
// 6/9 PM ET, never near the boundary.
export function weekStartET(date = new Date()) {
  const info = getETInfo(date);
  const dayIdx = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(info.weekday);
  if (dayIdx < 0) return new Date(0).toISOString().slice(0, 19).replace('T', ' ');
  // Step back the right number of UTC days (close to ET days at the boundary).
  const sundayMs = date.getTime() - dayIdx * 86400000;
  const sundayInfo = getETInfo(new Date(sundayMs));
  const pad = (n) => n < 10 ? '0' + n : '' + n;
  return sundayInfo.year + '-' + pad(sundayInfo.month) + '-' + pad(sundayInfo.day) + ' 00:00:00';
}

// ---- Modal-submit helpers ---------------------------------------------

// Modal submit data shape: data.data.components is an array of action_rows,
// each containing one text_input. Walk and pull by custom_id.
export function getModalField(data, customId) {
  for (const r of (data.data?.components || [])) {
    for (const c of (r.components || [])) {
      if (c.custom_id === customId) return c.value ?? '';
    }
  }
  return '';
}

// ---- Thread / DM helpers -----------------------------------------------

// Open a discussion thread on an existing channel message.
export function openThread(env, channelId, messageId, name, autoArchiveMinutes = 1440) {
  return discordFetch(env,
    '/channels/' + encodeURIComponent(channelId) +
    '/messages/' + encodeURIComponent(messageId) + '/threads', {
    method: 'POST',
    body: JSON.stringify({
      name: (name || '').slice(0, 100),
      auto_archive_duration: autoArchiveMinutes
    })
  });
}

// Open a DM channel with a user and post a message. Returns the message
// object. Most failures are 50007 (cannot message this user) — caller
// should swallow.
export async function sendDm(env, userId, payload) {
  const ch = await discordFetch(env, '/users/@me/channels', {
    method: 'POST',
    body: JSON.stringify({ recipient_id: userId })
  });
  return discordFetch(env,
    '/channels/' + encodeURIComponent(ch.id) + '/messages', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// Tiny sleep for rate-limit pacing. CF Workers supports setTimeout via Promise.
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
