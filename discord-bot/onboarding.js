// Bot-driven onboarding flow — independent of Discord's built-in
// Server Settings → Onboarding feature.
//
// Two entry points TODAY:
//   1. /onboard slash command anyone can run
//   2. A persistent welcome embed with a "Begin onboarding" button
//      (posted via /onboard post-embed by a guild admin into the
//      server's #start-here / #welcome channel)
//
// Auto-DM on join lights up automatically when the aquilo-presence
// gateway shim starts forwarding GUILD_MEMBER_ADD events to
// /member/joined — welcome.js calls maybeSendOnboardingDm() in
// that handler; it's a no-op today (no shim) and a real DM later
// (no flag flip needed).
//
// Multi-step component flow. Buttons / selects / modals only — no
// modal text input needed for the v1 (no free-text fields).
//
// Steps (in order):
//   1. welcome      "Hey! Here's what I'll walk you through" → Next
//   2. interests    multi-select of ping-role opt-ins → roles granted
//                    immediately, advance to next
//   3. links        deep-links to /link/ for Twitch + Patreon → Next
//   4. character    deep-link to /play/character/ (upload-based
//                    editor) → Next
//   5. tour         a key-channels embed → Finish
//   6. complete     bonus grant (idempotent) + recordMilestone for
//                    referral funnel
//
// State machine — every transition writes through, so a user who
// closes Discord mid-flow and runs /onboard again resumes on the
// step they were on, with their `choices` preserved. Re-running
// after completion shows a "you're already onboarded" recap.
//
// Role assignment is graceful: if the guild has no role configured
// for an interest, OR the configured role id no longer exists in
// the guild, the role is skipped + logged; the step still advances.
//
// KV layout (all LOADOUT_BOLTS):
//   onboard:state:<g>:<u>          per-user step state
//   onboard:role-map:<g>           interest-key → roleId mapping
//                                    (admin-settable; falls back to
//                                    ONBOARD_ROLE_MAP env var)
//   onboard:funnel:<g>             aggregate counters for the admin
//                                    status view
//   onboard:welcome-msg:<g>        message id of the persistent
//                                    welcome embed (so re-posts can
//                                    delete the old one)

import { earn, getWallet } from './wallet.js';
import { creditPack } from './cards-packs.js';
import { recordMilestone } from './referrals.js';
import { getBranding } from './branding.js';

// ── Constants ──────────────────────────────────────────────────────

export const ONBOARD_BONUS_BOLTS = 100;
export const ONBOARD_BONUS_PACK  = 'bolt';

// Stable interest keys — same set used by the multi-select component
// values, the KV role-map shape, and the admin status table.
export const INTERESTS = Object.freeze([
  { key: 'gamenight',  label: '🎮 Game Night',        description: 'Weekly community game sessions' },
  { key: 'clash',      label: '⚔️ Clash',             description: 'The town-builder + raid feature' },
  { key: 'boltbound',  label: '🃏 Boltbound',         description: 'Async card battler' },
  { key: 'boardgames', label: '♟️ Board games',       description: 'Chess, checkers, connect4' },
  { key: 'watching',   label: '👀 Just watching',     description: 'Stream notifications only' },
  { key: 'art',        label: '🎨 Art-only',          description: 'Art channels + drops' },
]);

// Ordered step machine — drives next/back navigation + the funnel
// counter buckets. Each id is also the `step` value persisted in
// `onboard:state:<g>:<u>`.
export const STEP_ORDER = ['welcome', 'interests', 'links', 'character', 'age18', 'tour', 'complete'];

// Discord component constants — mirrored from util.js / character.js
// for callsite isolation.
const RESP_CHAT          = 4;
const RESP_UPDATE_MSG    = 7;
const FLAG_EPHEMERAL     = 64;
const COMPONENT_ROW      = 1;
const COMPONENT_BUTTON   = 2;
const COMPONENT_SELECT   = 3;
const BTN_PRIMARY        = 1;
const BTN_SECONDARY      = 2;
const BTN_SUCCESS        = 3;
const BTN_LINK           = 5;

// ── KV helpers ─────────────────────────────────────────────────────

const STATE_KEY        = (g, u) => `onboard:state:${g}:${u}`;
const ROLE_MAP_KEY     = (g)    => `onboard:role-map:${g}`;
const FUNNEL_KEY       = (g)    => `onboard:funnel:${g}`;
const WELCOME_MSG_KEY  = (g)    => `onboard:welcome-msg:${g}`;

function freshState() {
  return {
    step: 'welcome',
    choices: { interests: [] },
    completedSteps: [],
    bonusGranted: false,
    startedAt: Date.now(),
    completedAt: 0,
  };
}

export async function getState(env, guildId, userId) {
  if (!env || !env.LOADOUT_BOLTS) return freshState();
  const raw = await env.LOADOUT_BOLTS.get(STATE_KEY(guildId, userId), { type: 'json' });
  if (!raw || typeof raw !== 'object') return freshState();
  // Migrate legacy/missing fields silently so a state record written
  // by an older build still loads cleanly.
  return {
    step:           raw.step           || 'welcome',
    choices:        raw.choices        || { interests: [] },
    completedSteps: Array.isArray(raw.completedSteps) ? raw.completedSteps : [],
    bonusGranted:   !!raw.bonusGranted,
    startedAt:      raw.startedAt      || Date.now(),
    completedAt:    raw.completedAt    || 0,
  };
}

async function putState(env, guildId, userId, state) {
  if (!env || !env.LOADOUT_BOLTS) return;
  await env.LOADOUT_BOLTS.put(STATE_KEY(guildId, userId), JSON.stringify(state));
}

// Marks a step done in BOTH the user's state and the per-guild
// funnel counter — idempotent on both (re-completing the same step
// won't double-count). Also bumps `started` the first time we see
// this user.
async function markStepDone(env, guildId, userId, state, stepId) {
  const firstTime = state.completedSteps.length === 0;
  if (!state.completedSteps.includes(stepId)) {
    state.completedSteps.push(stepId);
  }
  // Funnel: started bumps once-per-user; per-step bumps once-per-
  // user-per-step (guarded by the dedupe set we persist on the
  // state record itself).
  await bumpFunnel(env, guildId, {
    started: firstTime ? 1 : 0,
    perStep: { [stepId]: 1 },
  }, state.funnelMarked || []);
  state.funnelMarked = [...(state.funnelMarked || []), stepId]
    .filter((v, i, a) => a.indexOf(v) === i);
}

async function bumpFunnel(env, guildId, deltas, alreadyMarkedSteps) {
  if (!env || !env.LOADOUT_BOLTS) return;
  const cur = (await env.LOADOUT_BOLTS.get(FUNNEL_KEY(guildId), { type: 'json' })) ||
    { started: 0, completed: 0, perStep: {} };
  cur.started   = (cur.started || 0)   + (deltas.started   || 0);
  cur.completed = (cur.completed || 0) + (deltas.completed || 0);
  for (const [step, n] of Object.entries(deltas.perStep || {})) {
    // Honour the per-user dedupe — caller passes the set of steps
    // this user has already bumped funnel for so a resume mid-flow
    // doesn't double-count.
    if (alreadyMarkedSteps && alreadyMarkedSteps.includes(step)) continue;
    cur.perStep[step] = (cur.perStep[step] || 0) + n;
  }
  await env.LOADOUT_BOLTS.put(FUNNEL_KEY(guildId), JSON.stringify(cur));
}

export async function getFunnel(env, guildId) {
  if (!env || !env.LOADOUT_BOLTS) return { started: 0, completed: 0, perStep: {} };
  return (await env.LOADOUT_BOLTS.get(FUNNEL_KEY(guildId), { type: 'json' })) ||
    { started: 0, completed: 0, perStep: {} };
}

// ── Role-mapping config ────────────────────────────────────────────
//
// Reads guild:onboard:role-map:<g> KV (admin-set, JSON). Falls back
// to the deploy-time ONBOARD_ROLE_MAP env var, which is itself JSON.
// Either source is a flat `{ interestKey: '<discordRoleId>' }`
// object — keys that aren't in INTERESTS are ignored, role ids that
// don't exist in the guild get skipped at grant-time with a log
// line (see grantRolesForInterests).
export async function loadRoleMap(env, guildId) {
  let raw = null;
  if (env && env.LOADOUT_BOLTS) {
    try { raw = await env.LOADOUT_BOLTS.get(ROLE_MAP_KEY(guildId), { type: 'json' }); }
    catch { /* fall through to env */ }
  }
  if (!raw && env && env.ONBOARD_ROLE_MAP) {
    try { raw = JSON.parse(env.ONBOARD_ROLE_MAP); } catch { raw = null; }
  }
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const valid = new Set(INTERESTS.map(i => i.key));
  for (const [k, v] of Object.entries(raw)) {
    if (!valid.has(k)) continue;
    if (typeof v !== 'string' || !/^\d{5,25}$/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

// ── Discord REST ──────────────────────────────────────────────────

async function discordApi(env, method, path) {
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      Authorization: 'Bot ' + (env.DISCORD_BOT_TOKEN || ''),
      'User-Agent':  'loadout-discord onboarding',
    },
  });
  return { ok: r.ok, status: r.status };
}

// Assign every mapped role for the user's selected interests.
// Returns { granted: [interestKey, ...], skipped: [{ key, reason }] }
// so the admin status view + tests can verify each branch.
//
// Skips (NOT failures) when:
//   - the interest isn't in the role map
//   - the configured role id no longer exists in the guild (404)
//   - the bot lacks Manage Roles or the role is above the bot's
//     highest role (403) — surface but don't crash the flow
export async function grantRolesForInterests(env, guildId, userId, interestKeys) {
  const roleMap = await loadRoleMap(env, guildId);
  const granted = [];
  const skipped = [];
  for (const key of interestKeys) {
    const rid = roleMap[key];
    if (!rid) { skipped.push({ key, reason: 'no-mapping' }); continue; }
    if (!env.DISCORD_BOT_TOKEN) {
      skipped.push({ key, reason: 'no-bot-token' });
      continue;
    }
    const r = await discordApi(env, 'PUT',
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(rid)}`);
    if (r.ok || r.status === 204) { granted.push(key); continue; }
    if (r.status === 404) { skipped.push({ key, reason: 'role-not-found', roleId: rid }); continue; }
    if (r.status === 403) { skipped.push({ key, reason: 'forbidden',      roleId: rid }); continue; }
    skipped.push({ key, reason: 'http-' + r.status, roleId: rid });
  }
  if (skipped.length) {
    console.warn('[onboard] role-grant skips', JSON.stringify(skipped));
  }
  return { granted, skipped };
}

// ── Completion: bonus + funnel ─────────────────────────────────────

// Idempotent: grants ONBOARD_BONUS_BOLTS + 1 'bolt' pack ONCE per
// user. Subsequent calls are no-ops + report { alreadyGranted: true }.
// Also fires recordMilestone('onboard') for the referral funnel —
// also idempotent (referrals.js gates on milestoneFiredUtc per
// referee), so a re-run after the user was later attributed still
// pays the referrer once.
export async function completeOnboarding(env, guildId, userId, state) {
  if (state.bonusGranted) {
    return { alreadyGranted: true, bolts: 0, pack: null };
  }
  await earn(env, guildId, userId, ONBOARD_BONUS_BOLTS, 'onboarding:complete');
  let packCreditOk = false;
  try {
    const r = await creditPack(env, guildId, userId, ONBOARD_BONUS_PACK, 'onboarding:complete');
    packCreditOk = !!r?.ok;
  } catch (e) {
    console.warn('[onboard] pack credit failed', e?.message || e);
  }
  state.bonusGranted = true;
  state.completedAt  = Date.now();
  state.step         = 'complete';
  if (!state.completedSteps.includes('complete')) state.completedSteps.push('complete');
  await putState(env, guildId, userId, state);

  // Funnel — bump the global `completed` counter once per user.
  await bumpFunnel(env, guildId, { completed: 1, perStep: { complete: 1 } },
    state.funnelMarked || []);

  // Best-effort referral milestone fire (no-op if not attributed).
  try {
    await recordMilestone(env, guildId, userId, 'onboard');
  } catch (e) {
    console.warn('[onboard] recordMilestone failed', e?.message || e);
  }

  return {
    alreadyGranted: false,
    bolts: ONBOARD_BONUS_BOLTS,
    pack: ONBOARD_BONUS_PACK,
    packCreditOk,
  };
}

// ── Embed builders ─────────────────────────────────────────────────

// The persistent welcome embed (posted by /onboard post-embed into
// the #start-here channel). Button id is `onb:begin`. Clay can
// re-post any time without state drift — the embed is purely a
// link to the flow; state lives in KV per-user.
export async function buildWelcomeEmbed(env, guildId) {
  const brand = await getBranding(env, guildId);
  return {
    embed: {
      title: `👋 Welcome to ${brand.brandName}!`,
      description:
        `Get oriented in 60 seconds:\n\n` +
        `• 🎮 Pick the channels + pings you want to see\n` +
        `• 🔗 Link your Twitch + Patreon (optional, unlocks perks)\n` +
        `• 🧑 Set your character + upload a hero pic\n` +
        `• 🗺 Quick tour of where things live\n\n` +
        `Finish to grab **${ONBOARD_BONUS_BOLTS} bolts** + a starter pack.`,
      color: brand.accentColor,
      thumbnail: { url: brand.welcomeBackdropUrl },
      footer: { text: 'You can run /onboard any time to resume.' },
    },
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: 'Begin onboarding', custom_id: 'onb:begin' },
      ],
    }],
  };
}

// Step-specific views. Each returns the message-data payload to
// reply with (RESP_CHAT for the first interaction, RESP_UPDATE_MSG
// for component updates). All ephemeral so the flow doesn't spam
// the channel.

async function viewWelcome(env, guildId) {
  const brand = await getBranding(env, guildId);
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: `👋 Welcome to ${brand.brandName}!`,
      description:
        `Five quick steps. Finish to grab **${ONBOARD_BONUS_BOLTS} bolts** + a starter pack.\n\n` +
        `1. Pick your interests\n` +
        `2. Link Twitch + Patreon\n` +
        `3. Set up your character\n` +
        `4. Quick tour of key channels\n` +
        `5. Done!`,
      color: brand.accentColor,
    }],
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: BTN_PRIMARY, label: '▶︎ Begin', custom_id: 'onb:step:interests' },
      ],
    }],
  };
}

async function viewInterests(env, guildId, state) {
  const selected = new Set(state.choices.interests || []);
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: '🎯 What brings you here?',
      description: 'Pick anything that catches your eye — I\'ll give you matching ping roles.',
      color: (await getBranding(env, guildId)).accentColor,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [{
          type: COMPONENT_SELECT,
          custom_id: 'onb:pick:interests',
          placeholder: 'Pick your interests (any number)',
          min_values: 0,
          max_values: INTERESTS.length,
          options: INTERESTS.map(i => ({
            label: i.label,
            value: i.key,
            description: i.description,
            default: selected.has(i.key),
          })),
        }],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Skip', custom_id: 'onb:step:links' },
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Next ▶︎', custom_id: 'onb:advance:interests' },
        ],
      },
    ],
  };
}

async function viewLinks(env, guildId) {
  const brand = await getBranding(env, guildId);
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: '🔗 Link your accounts',
      description:
        `Optional, but recommended:\n\n` +
        `• **Twitch** — counts your stream presence toward streak rewards\n` +
        `• **Patreon** — unlocks pets, cosmetics, and a referral-payout slot\n\n` +
        `These open on ${brand.siteUrl}. Pop back here when you\'re done.`,
      color: brand.accentColor,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          // Both buttons land on /profile/. The site's only OAuth
          // entry is Patreon (auth.aquilo.gg → Patreon → site reads
          // social_connections for Twitch/YouTube/TikTok), so there's
          // no separate /link/twitch route — older urls 404'd.
          // `?link=<provider>` is a hint a future Profile-page update
          // can use to pre-scroll/pre-open the matching linker tab;
          // ignored today, harmless.
          { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Link Twitch',   url: `${brand.siteUrl}/profile/?link=twitch` },
          { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Link Patreon',  url: `${brand.siteUrl}/profile/?link=patreon` },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Skip', custom_id: 'onb:step:character' },
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Next ▶︎', custom_id: 'onb:advance:links' },
        ],
      },
    ],
  };
}

async function viewCharacter(env, guildId) {
  const brand = await getBranding(env, guildId);
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: '🧑 Your character',
      description:
        `Two ways to set yours up:\n\n` +
        `• **Easy** — upload a picture or GIF of your hero on the web editor\n` +
        `• **Quick** — Discord: \`/character\` opens the in-Discord picker\n\n` +
        `(You can change either at any time.)`,
      color: brand.accentColor,
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_LINK, label: 'Open web editor', url: `${brand.siteUrl}/play/character/` },
        ],
      },
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'Skip', custom_id: 'onb:step:age18' },
          { type: COMPONENT_BUTTON, style: BTN_PRIMARY,   label: 'Next ▶︎', custom_id: 'onb:advance:character' },
        ],
      },
    ],
  };
}

// ── 18+ age-gate step ───────────────────────────────────────────────
//
// Strict warning copy — Discord ToS requires age verification for
// access to age-restricted content (we honour it via channel `nsfw:
// true` + role gate). The "Yes, I'm 18+" button grants the role
// stored at guild:cfg.ids.role_age18 (provisioned by
// /admin/discord/setup-18plus). Every grant gets logged to
// guild:cfg.ids.ch_mod_log with a per-user audit trail.
async function viewAge18(env, guildId) {
  const brand = await getBranding(env, guildId);
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: '🔞 Are you 18 or older?',
      description:
        `Aquilo has a small **18+** chat area for adult conversations.\n` +
        `It's tucked away in its own category — you won't see it unless ` +
        `you opt in here.\n\n` +
        `**⚠ Critical:** By claiming the 18+ role while under 18, you will be ` +
        `**permanently banned** from the server. This is non-negotiable — ` +
        `Discord's Terms of Service require us to enforce it.\n\n` +
        `Totally fine to skip this step if you'd rather not engage with ` +
        `the 18+ side. Nothing else in onboarding depends on it.`,
      color: 0xff6ab5,   // brand pink — matches the role color
    }],
    components: [
      {
        type: COMPONENT_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: BTN_SUCCESS, label: "Yes, I'm 18+", custom_id: 'onb:age18:yes' },
          { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: 'No / Skip',  custom_id: 'onb:age18:no'  },
        ],
      },
    ],
  };
}

async function viewTour(env, guildId) {
  const brand = await getBranding(env, guildId);
  const cfg = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
  const ids = cfg?.ids || {};
  // Channel mentions render as #channel-name when the bot can see
  // them, else as a grey "deleted-channel" — either way they don\'t
  // break the embed. Skip missing slots gracefully.
  const ch = (slot) => ids[slot] ? `<#${ids[slot]}>` : null;
  const lines = [];
  if (ch('ch_checkin'))   lines.push(`• Daily check-ins → ${ch('ch_checkin')} (or \`/checkin\`)`);
  if (ch('ch_lfg'))       lines.push(`• Looking for game → ${ch('ch_lfg')} (or \`/lfg create\`)`);
  if (ch('ch_games'))     lines.push(`• Game hub → ${ch('ch_games')}`);
  if (ch('ch_highlights'))lines.push(`• Top posts wall → ${ch('ch_highlights')}`);
  if (lines.length === 0) lines.push('• Look around — channels show up here once a mod runs `/loadout-setup`.');
  lines.push('');
  lines.push(`• The full community page lives at ${brand.siteUrl}/community/`);
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: '🗺 The quick tour',
      description: lines.join('\n'),
      color: brand.accentColor,
    }],
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: BTN_SUCCESS, label: '🏁 Finish', custom_id: 'onb:advance:tour' },
      ],
    }],
  };
}

async function viewComplete(env, guildId, userId, state, grantInfo) {
  const brand = await getBranding(env, guildId);
  const w = await getWallet(env, guildId, userId).catch(() => ({ balance: 0 }));
  const grantLine = grantInfo.alreadyGranted
    ? '_You\'d already claimed your starter bonus — nothing extra granted this run._'
    : `🎁 **+${grantInfo.bolts} bolts** + 1 Boltbound **${grantInfo.pack}** pack landed in your wallet.`;
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: '🏁 You\'re onboarded!',
      description:
        grantLine +
        `\n\nWallet: **${w.balance || 0} bolts**.\n\n` +
        `Next up: try \`/checkin\` for today, browse the cards with \`/boltbound\`, ` +
        `or just hang out and watch the stream. Welcome to ${brand.brandName}.`,
      color: brand.accentColor,
    }],
  };
}

async function viewAlreadyOnboarded(env, guildId, userId, state) {
  const brand = await getBranding(env, guildId);
  const done = state.completedSteps.filter(s => STEP_ORDER.includes(s) && s !== 'complete');
  const remaining = STEP_ORDER.filter(s => s !== 'complete' && !done.includes(s));
  const lines = [
    `You finished onboarding ${state.completedAt ? `<t:${Math.floor(state.completedAt / 1000)}:R>` : 'previously'}.`,
    '',
    `**Steps you\'ve done:** ${done.length ? done.join(', ') : '(none recorded — legacy state)'}`,
  ];
  if (remaining.length) {
    lines.push(`**Skipped:** ${remaining.join(', ')} — re-run a step any time with the buttons below.`);
  } else {
    lines.push('All steps marked done. 👏');
  }
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: '✅ Already onboarded',
      description: lines.join('\n'),
      color: brand.accentColor,
    }],
    components: [{
      type: COMPONENT_ROW,
      components: [
        { type: COMPONENT_BUTTON, style: BTN_SECONDARY, label: '↻ Re-run from the top', custom_id: 'onb:restart' },
      ],
    }],
  };
}

// ── Dispatch ──────────────────────────────────────────────────────

// /onboard slash entry. If no state yet → welcome view. If state
// exists and is incomplete → resume at the current step. If
// already completed → "already onboarded" recap.
export async function handleOnboardCommand(env, data) {
  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  if (!guildId || !userId) {
    return { type: RESP_CHAT, data: { content: 'Run this in a server.', flags: FLAG_EPHEMERAL } };
  }
  const sub = data.data?.options?.[0]?.name;

  if (sub === 'post-embed') return handlePostEmbedSubcommand(env, data);
  if (sub === 'status')     return handleStatusSubcommand(env, data);

  // Default — interactive flow.
  const state = await getState(env, guildId, userId);
  if (state.bonusGranted) {
    return { type: RESP_CHAT, data: await viewAlreadyOnboarded(env, guildId, userId, state) };
  }
  return { type: RESP_CHAT, data: await viewForStep(env, guildId, userId, state) };
}

async function viewForStep(env, guildId, userId, state) {
  switch (state.step) {
    case 'interests': return viewInterests(env, guildId, state);
    case 'links':     return viewLinks(env, guildId);
    case 'character': return viewCharacter(env, guildId);
    case 'age18':     return viewAge18(env, guildId);
    case 'tour':      return viewTour(env, guildId);
    case 'complete':  return viewAlreadyOnboarded(env, guildId, userId, state);
    case 'welcome':
    default:          return viewWelcome(env, guildId);
  }
}

// Component dispatcher — `onb:*` custom_ids.
export async function handleOnboardComponent(env, data) {
  const guildId = data.guild_id;
  const userId  = data.member?.user?.id || data.user?.id;
  if (!guildId || !userId) {
    return { type: RESP_CHAT, data: { content: 'Run this in a server.', flags: FLAG_EPHEMERAL } };
  }
  const cid = data.data?.custom_id || '';
  const segs = cid.split(':');   // ['onb', '<action>', ...]
  const action = segs[1];

  let state = await getState(env, guildId, userId);

  // The persistent welcome-embed button — same as /onboard with no args.
  if (action === 'begin') {
    // First click ever bumps `started` counter via markStepDone on welcome.
    await markStepDone(env, guildId, userId, state, 'welcome');
    state.step = 'interests';
    await putState(env, guildId, userId, state);
    return { type: RESP_CHAT, data: await viewInterests(env, guildId, state) };
  }

  // Restart from completed — wipe state but KEEP bonusGranted (no
  // double-grant) and KEEP completedAt for the recap.
  if (action === 'restart') {
    const wasGranted = state.bonusGranted;
    const completedAt = state.completedAt;
    const funnelMarked = state.funnelMarked || [];
    state = freshState();
    state.bonusGranted = wasGranted;
    state.completedAt  = completedAt;
    state.funnelMarked = funnelMarked;
    await putState(env, guildId, userId, state);
    return { type: RESP_UPDATE_MSG, data: await viewWelcome(env, guildId) };
  }

  // Step navigation — `onb:step:<id>` jumps to a step (used by Skip
  // buttons that need to land in the next view without marking the
  // skipped step as completed).
  if (action === 'step') {
    const target = segs[2];
    if (STEP_ORDER.includes(target)) {
      state.step = target;
      await markStepDone(env, guildId, userId, state, target === 'complete' ? 'tour' : state.step);
      await putState(env, guildId, userId, state);
      return { type: RESP_UPDATE_MSG, data: await viewForStep(env, guildId, userId, state) };
    }
  }

  // 18+ age-gate click handlers. Yes → grant role + log to mod-log;
  // No → skip cleanly. Both advance state to the next step (tour).
  if (action === 'age18') {
    const choice = segs[2];
    const cfg = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
    const roleId  = cfg?.ids?.role_age18;
    const modLog  = cfg?.ids?.ch_mod_log;
    if (choice === 'yes') {
      if (!roleId) {
        return { type: RESP_CHAT, data: { content: '18+ role not configured yet — ping a mod.', flags: FLAG_EPHEMERAL } };
      }
      // PUT is idempotent — re-clicking just re-grants the same role.
      const r = await fetch(
        `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
        { method: 'PUT',
          headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
                     'X-Audit-Log-Reason': 'Aquilo 18+ self-grant via onboarding' } });
      if (!r.ok && r.status !== 204) {
        return { type: RESP_CHAT, data: { content: `Couldn't grant the role (${r.status}). Ping a mod.`, flags: FLAG_EPHEMERAL } };
      }
      // Audit log — fire-and-forget; the user's flow keeps moving
      // even if mod-log isn't configured.
      if (modLog) {
        const username = data?.member?.user?.username || data?.user?.username || 'unknown';
        const ts = Math.floor(Date.now() / 1000);
        fetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(modLog)}/messages`,
          { method: 'POST',
            headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
                       'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `🔞 **18+ self-grant** — <@${userId}> (${username}, id \`${userId}\`) claimed the 18+ role at <t:${ts}:F>.\n` +
                       `If their account looks under 18, ban per the onboarding warning copy.`,
              allowed_mentions: { parse: [] },
            }),
          }).catch(() => {});
      }
    }
    // Either choice advances past age18.
    await markStepDone(env, guildId, userId, state, 'age18');
    state.step = 'tour';
    await putState(env, guildId, userId, state);
    return { type: RESP_UPDATE_MSG, data: await viewTour(env, guildId) };
  }

  // Interest multi-select submit. Updates `choices.interests` +
  // immediately grants the matching roles. Stays on the same view
  // so the user can change their picks; they advance via the Next
  // button (onb:advance:interests).
  if (action === 'pick' && segs[2] === 'interests') {
    const picked = (data.data?.values || []).filter(v =>
      INTERESTS.some(i => i.key === v));
    state.choices.interests = picked;
    await putState(env, guildId, userId, state);
    if (picked.length > 0) {
      await grantRolesForInterests(env, guildId, userId, picked);
    }
    return { type: RESP_UPDATE_MSG, data: await viewInterests(env, guildId, state) };
  }

  // Step-complete + advance — `onb:advance:<currentStep>`. Marks
  // the current step done, advances to the next, renders that view.
  // The final advance (tour → complete) triggers completion.
  if (action === 'advance') {
    const current = segs[2];
    if (!STEP_ORDER.includes(current)) {
      return { type: RESP_CHAT, data: { content: 'Unknown step.', flags: FLAG_EPHEMERAL } };
    }
    await markStepDone(env, guildId, userId, state, current);
    const idx = STEP_ORDER.indexOf(current);
    const next = STEP_ORDER[idx + 1] || 'complete';
    state.step = next;
    if (next === 'complete') {
      const grant = await completeOnboarding(env, guildId, userId, state);
      // completeOnboarding already persisted state.
      return { type: RESP_UPDATE_MSG, data: await viewComplete(env, guildId, userId, state, grant) };
    }
    await putState(env, guildId, userId, state);
    return { type: RESP_UPDATE_MSG, data: await viewForStep(env, guildId, userId, state) };
  }

  return { type: RESP_CHAT, data: { content: 'Unknown onboarding action: ' + cid, flags: FLAG_EPHEMERAL } };
}

// ── Shared poster ──────────────────────────────────────────────────
//
// Core "drop the welcome embed in this channel" routine — used by
// both the /onboard post-embed slash handler AND the admin HTTP
// route in worker.js (POST /admin/onboarding/post-embed/<g>).
//
// Idempotency model: any prior welcome message tracked at
// `onboard:welcome-msg:<g>` is deleted first (best-effort, since
// it may already be gone — channel deleted, message swept). The
// new message id is then recorded over the top. Re-running just
// relocates the embed cleanly.
//
// Returns { ok: true, channelId, messageId, deletedPrior } on
// success; { ok: false, error: 'post-failed', status, body } on a
// Discord REST failure (caller decides whether to surface).
export async function postOnboardingEmbed(env, guildId, channelId) {
  if (!channelId) return { ok: false, error: 'no-channel-id' };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };

  let deletedPrior = false;
  try {
    const priorRaw = await env.LOADOUT_BOLTS.get(WELCOME_MSG_KEY(guildId), { type: 'json' });
    if (priorRaw?.channelId && priorRaw?.messageId) {
      const delRes = await fetch(
        `https://discord.com/api/v10/channels/${priorRaw.channelId}/messages/${priorRaw.messageId}`,
        {
          method: 'DELETE',
          headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord onboarding' },
        },
      );
      if (delRes.ok || delRes.status === 204 || delRes.status === 404) deletedPrior = true;
    }
  } catch { /* ignore — old message may already be gone */ }

  const { embed, components } = await buildWelcomeEmbed(env, guildId);
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':  'loadout-discord onboarding',
    },
    body: JSON.stringify({ embeds: [embed], components, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: 'post-failed', status: r.status, body: t.slice(0, 200) };
  }
  const j = await r.json();
  await env.LOADOUT_BOLTS.put(WELCOME_MSG_KEY(guildId),
    JSON.stringify({ channelId, messageId: j.id, postedAt: Date.now() }));
  return { ok: true, channelId, messageId: j.id, deletedPrior };
}

// ── /onboard post-embed (admin slash) ──────────────────────────────
async function handlePostEmbedSubcommand(env, data) {
  if (!isAdmin(data)) {
    return { type: RESP_CHAT, data: { content: '🔒 Admins only.', flags: FLAG_EPHEMERAL } };
  }
  const guildId  = data.guild_id;
  const channelId = data.channel_id || data.channel?.id;
  if (!channelId) {
    return { type: RESP_CHAT, data: { content: 'Couldn\'t resolve the channel.', flags: FLAG_EPHEMERAL } };
  }
  const r = await postOnboardingEmbed(env, guildId, channelId);
  if (!r.ok) {
    return { type: RESP_CHAT, data: {
      content: `❌ Post failed (${r.status || ''}): \`${(r.body || r.error || '').slice(0, 120)}\``,
      flags: FLAG_EPHEMERAL,
    } };
  }
  return { type: RESP_CHAT, data: {
    content: `✅ Welcome embed posted in <#${r.channelId}> — message id \`${r.messageId}\`.`,
    flags: FLAG_EPHEMERAL,
  } };
}

// ── /onboard status (admin) ────────────────────────────────────────
//
// Ephemeral funnel snapshot — per-step counts + completion rate.
// Pulled from the per-guild `onboard:funnel:<g>` aggregate counter.
async function handleStatusSubcommand(env, data) {
  if (!isAdmin(data)) {
    return { type: RESP_CHAT, data: { content: '🔒 Admins only.', flags: FLAG_EPHEMERAL } };
  }
  const guildId = data.guild_id;
  const funnel  = await getFunnel(env, guildId);
  const lines = [
    `🚥 **Onboarding funnel — ${data.guild_id}**`,
    '',
    `Started: **${funnel.started || 0}**`,
    `Completed: **${funnel.completed || 0}** (${pct(funnel.completed, funnel.started)})`,
    '',
    '**Per step:**',
  ];
  for (const step of STEP_ORDER) {
    const n = funnel.perStep?.[step] || 0;
    const drop = funnel.started ? funnel.started - n : 0;
    lines.push(`  • \`${step.padEnd(10)}\`  ${String(n).padStart(4)}   _(drop-off: ${drop})_`);
  }
  const roleMap = await loadRoleMap(env, guildId);
  lines.push('');
  lines.push(`**Role-map keys configured:** ${Object.keys(roleMap).length ? Object.keys(roleMap).join(', ') : '_(none — set onboard:role-map:<g> KV or ONBOARD_ROLE_MAP env)_'}`);
  return { type: RESP_CHAT, data: { content: lines.join('\n'), flags: FLAG_EPHEMERAL } };
}

function pct(num, denom) {
  if (!denom) return '—';
  return Math.round((num / denom) * 100) + '%';
}

function isAdmin(data) {
  const perms = BigInt(data.member?.permissions || '0');
  const ADMIN = 1n << 3n;       // 0x8
  const MANAGE_GUILD = 1n << 5n; // 0x20
  return (perms & ADMIN) !== 0n || (perms & MANAGE_GUILD) !== 0n;
}

// ── Admin: pick a welcome channel ──────────────────────────────────
//
// Pure-function channel-name match used by the admin route + tests.
// `opts` is `{ channelId?, channelName? }` from the request body:
//
//   - channelId  → if present, return it verbatim (no lookup needed)
//   - channelName → first text channel whose lowercased name
//                    *contains* the lowercased search string
//   - neither    → first text channel whose name contains any of
//                    DEFAULT_WELCOME_CHANNEL_HINTS, tried in order
//
// `channels` is the raw `GET /guilds/{g}/channels` response array.
// Only `type === 0` (GUILD_TEXT) channels are considered.
//
// Returns { id, name } on a match, null on no match.

export const DEFAULT_WELCOME_CHANNEL_HINTS = [
  'start-here', 'welcome', 'introductions', '👋',
];

export function pickWelcomeChannel(channels, opts = {}) {
  const list = (Array.isArray(channels) ? channels : []).filter(c => c && c.type === 0);
  if (opts.channelId) {
    const explicit = list.find(c => String(c.id) === String(opts.channelId));
    return explicit ? { id: explicit.id, name: explicit.name || '' } : null;
  }
  if (opts.channelName) {
    const needle = String(opts.channelName).toLowerCase();
    const hit = list.find(c => String(c.name || '').toLowerCase().includes(needle));
    return hit ? { id: hit.id, name: hit.name || '' } : null;
  }
  for (const hint of DEFAULT_WELCOME_CHANNEL_HINTS) {
    const needle = hint.toLowerCase();
    const hit = list.find(c => String(c.name || '').toLowerCase().includes(needle));
    if (hit) return { id: hit.id, name: hit.name || '' };
  }
  return null;
}

// ── Admin: match interest roles ────────────────────────────────────
//
// Heuristic name-matching of an interest key against the guild's
// role list. Tokenized on non-letter chars (so "🎮 Game Night"
// becomes ["game", "night"]) — that gives us word-boundary
// semantics for free and avoids the "art" trap (token "party"
// won't match the predicate `tokens.includes('art')`).
//
// First role in Discord's `GET /guilds/{g}/roles` response order
// that matches a key wins; subsequent matches for the same key are
// ignored. @everyone (role id == guildId) and managed roles
// (`managed: true`, integration / bot roles) are skipped.
//
// `interestKey` MUST be one of INTERESTS[].key — unknown keys
// return false. Exported for the test harness.
export function matchesInterest(key, roleName) {
  const tokens = tokenize(roleName);
  if (tokens.length === 0) return false;
  switch (key) {
    case 'gamenight':
      return tokens.includes('gamenight')
          || (tokens.includes('game') && tokens.includes('night'));
    case 'clash':
      return tokens.includes('clash');
    case 'boltbound':
      return tokens.includes('boltbound')
          || (tokens.includes('bolt') && tokens.includes('bound'));
    case 'boardgames':
      return tokens.includes('boardgames')
          || (tokens.includes('board') && (tokens.includes('game') || tokens.includes('games')));
    case 'watching':
      return ['watching', 'watcher', 'watchers',
              'lurker', 'lurkers',
              'viewer', 'viewers'].some(w => tokens.includes(w));
    case 'art':
      // Token-level membership — "art", "arts", "artist", "artists".
      // Won't match "party" / "smart" / "depart" because tokenize()
      // splits on non-letters, so "art" is its own token only when
      // surrounded by non-letters (or at start/end).
      return ['art', 'arts', 'artist', 'artists'].some(w => tokens.includes(w));
    default:
      return false;
  }
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

// Walk every (interestKey × role) pair, return the first match per
// key. Output shape mirrors the admin route's `mapped` field.
// `guildId` is needed to skip @everyone (whose id equals the guild
// id by Discord convention).
export function matchInterestRoles(roles, guildId) {
  const mapped = {};
  const list = Array.isArray(roles) ? roles : [];
  for (const role of list) {
    if (!role || !role.id || !role.name) continue;
    if (String(role.id) === String(guildId)) continue;   // @everyone
    if (role.managed) continue;                          // bot / integration role
    for (const interest of INTERESTS) {
      if (mapped[interest.key]) continue;                // first match wins
      if (matchesInterest(interest.key, role.name)) {
        mapped[interest.key] = { id: String(role.id), name: String(role.name) };
      }
    }
  }
  const unmapped = INTERESTS.map(i => i.key).filter(k => !mapped[k]);
  return { mapped, unmapped };
}

// ── Admin HTTP route: post-embed (channel resolution) ──────────────
//
// Resolve a channel id from { channelId?, channelName? } and post
// the welcome embed there via the shared postOnboardingEmbed().
// Designed for the worker.js admin route — pure resolution +
// existing poster, no Discord-interaction shape baked in.
//
// Returns:
//   { ok: true, channelId, channelName, messageId, deletedPrior }
//   { ok: false, error: 'no-bot-token' | 'channels-fetch-failed'
//                       | 'no-channel-match' | 'post-failed', ... }
export async function postWelcomeEmbedForGuild(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  let pick;
  if (opts.channelId && !opts.channelName) {
    // Caller supplied an explicit id — no REST round-trip needed,
    // but we still record the (potentially unknown) name for the
    // report. Discord will reject the post itself if the id is bogus.
    pick = { id: String(opts.channelId), name: '' };
  } else {
    // Need the channel list either way (name match or default-hint).
    const chRes = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent': 'loadout-discord onboarding',
      },
    });
    if (!chRes.ok) {
      const t = await chRes.text();
      return { ok: false, error: 'channels-fetch-failed', status: chRes.status, body: t.slice(0, 200) };
    }
    const channels = await chRes.json();
    pick = pickWelcomeChannel(channels, opts);
    if (!pick) return { ok: false, error: 'no-channel-match', tried: opts.channelName || DEFAULT_WELCOME_CHANNEL_HINTS };
  }

  const post = await postOnboardingEmbed(env, guildId, pick.id);
  if (!post.ok) return { ok: false, error: post.error, status: post.status, body: post.body, channelId: pick.id, channelName: pick.name };
  return {
    ok: true,
    channelId: pick.id,
    channelName: pick.name,
    messageId: post.messageId,
    deletedPrior: !!post.deletedPrior,
  };
}

// ── Admin: ensure baseline interest roles exist ────────────────────
//
// Companion to matchAndSetupGuildRoles. The setup-roles flow can
// only map roles that ALREADY exist in the guild — if a tenant
// doesn't have, say, a "Clash" role for opt-in pings, the
// `clash` interest stays unmapped and users picking it just get a
// `no-mapping` skip.
//
// This helper fills that gap: for each provided spec, check if any
// existing role already matches the heuristic for that interest
// key (via matchesInterest). If a hit, skip — DON\'T create a
// duplicate (the user may have already hand-rolled the role).
// Otherwise POST a fresh opt-in ping role with the supplied
// name/colour and `permissions: "0"` (no perms by default).
//
// Default spec set is BASELINE_ROLE_SPECS below — covers the five
// interest keys Aquilo's onboarding ships with. Body { roles: [...] }
// overrides if a different tenant wants a different palette / names.
//
// Idempotent — re-running on a guild that already has matching
// roles is a no-op (every key in `skipped`).

export const BASELINE_ROLE_SPECS = Object.freeze([
  { key: 'clash',      name: 'Clash',         color: 0x2f8f55 },  // green
  { key: 'boltbound',  name: 'Boltbound',     color: 0x3a82ff },  // primary blue
  { key: 'boardgames', name: 'Board Games',   color: 0xe6c474 },  // amber
  { key: 'watching',   name: 'Just Watching', color: 0x6a7488 },  // soft slate
  { key: 'art',        name: 'Art',           color: 0x9b6cff },  // violet
]);

// Validate + normalise a caller-supplied spec list. Drops anything
// without a valid interest key or a non-empty name. Defaults
// mentionable:true, hoist:false, permissions:"0" so plain opt-in
// pings are the zero-config path. Returns the cleaned list.
export function normaliseRoleSpecs(specs) {
  const valid = new Set(INTERESTS.map(i => i.key));
  const out = [];
  for (const s of (Array.isArray(specs) ? specs : [])) {
    if (!s || !valid.has(s.key)) continue;
    const name = String(s.name || '').trim().slice(0, 100);
    if (!name) continue;
    out.push({
      key: s.key,
      name,
      color: Number.isInteger(s.color) ? (s.color & 0xFFFFFF) : 0,
      mentionable: s.mentionable === false ? false : true,
      hoist:       s.hoist === true,
      permissions: typeof s.permissions === 'string' ? s.permissions : '0',
    });
  }
  return out;
}

// Create the missing opt-in roles. Returns
// { ok, created: [{ key, id, name, color }],
//   skipped: [{ key, reason, existing?: { id, name } }],
//   roleCount }.
//
// `skipped.reason` is one of:
//   - 'already-exists' — a role already satisfies the heuristic
//   - 'create-failed'  — Discord 4xx/5xx; status echoed
export async function ensureBaselineRoles(env, guildId, specsArg) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const specs = normaliseRoleSpecs(
    Array.isArray(specsArg) && specsArg.length ? specsArg : BASELINE_ROLE_SPECS,
  );
  if (specs.length === 0) return { ok: true, created: [], skipped: [], roleCount: 0 };

  // Snapshot the guild's existing roles ONCE up front so we can
  // resolve every spec against the same view (no race between specs).
  const listRes = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`, {
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'User-Agent': 'loadout-discord onboarding',
    },
  });
  if (!listRes.ok) {
    const t = await listRes.text();
    return { ok: false, error: 'roles-fetch-failed', status: listRes.status, body: t.slice(0, 200) };
  }
  const existing = await listRes.json();

  const created = [];
  const skipped = [];
  for (const spec of specs) {
    // Skip if any current role (other than @everyone or a managed
    // role) already satisfies the heuristic for this key — we DON\'T
    // want to dupe a role someone made manually with a slightly
    // different name.
    const hit = (existing || []).find(role =>
      role && role.id && role.name
      && String(role.id) !== String(guildId)
      && !role.managed
      && matchesInterest(spec.key, role.name),
    );
    if (hit) {
      skipped.push({ key: spec.key, reason: 'already-exists',
        existing: { id: String(hit.id), name: String(hit.name) } });
      continue;
    }
    // Create. Discord requires the `reason` audit-log field on the
    // X-Audit-Log-Reason header (≤512 chars).
    const createRes = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent':   'loadout-discord onboarding',
        'X-Audit-Log-Reason': `aquilo onboarding: ensure opt-in role for "${spec.key}"`,
      },
      body: JSON.stringify({
        name:        spec.name,
        permissions: spec.permissions,
        color:       spec.color,
        hoist:       spec.hoist,
        mentionable: spec.mentionable,
      }),
    });
    if (!createRes.ok) {
      const t = await createRes.text();
      skipped.push({ key: spec.key, reason: 'create-failed',
        status: createRes.status, body: t.slice(0, 200) });
      continue;
    }
    const j = await createRes.json();
    created.push({ key: spec.key, id: String(j.id), name: spec.name, color: spec.color });
  }
  return { ok: true, created, skipped, roleCount: (existing || []).length };
}

// ── Admin HTTP route: setup-roles ──────────────────────────────────
//
// Fetch guild roles, match each interest key, write the resulting
// map to `onboard:role-map:<g>`, return the structured result so
// Clay can see what landed.
//
// Re-running overwrites the map — safe because matchInterestRoles
// is deterministic over the (current) role list. If the guild's
// role names change, the next run reflects that. Existing
// onboarding state records aren't affected; only the mapping
// loadRoleMap() reads from changes.
export async function matchAndSetupGuildRoles(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const r = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`, {
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'User-Agent': 'loadout-discord onboarding',
    },
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: 'roles-fetch-failed', status: r.status, body: t.slice(0, 200) };
  }
  const roles = await r.json();
  const result = matchInterestRoles(roles, guildId);
  // Persist ONLY the snowflake-id form loadRoleMap reads back; the
  // names live in the response for the report but aren't needed at
  // runtime.
  const flat = {};
  for (const [k, v] of Object.entries(result.mapped)) flat[k] = v.id;
  await env.LOADOUT_BOLTS.put(ROLE_MAP_KEY(guildId), JSON.stringify(flat));
  return { ok: true, mapped: result.mapped, unmapped: result.unmapped, roleCount: roles.length };
}

// ── Future-gated auto-DM hook ──────────────────────────────────────
//
// Called from welcome.js handleMemberJoined. Today, with no gateway
// shim, that handler is never invoked — so this fires zero times.
// Once the shim lands + starts POSTing /member/joined, every join
// will get a DM with the welcome embed + the same "Begin onboarding"
// button. Failures (DM closed, rate limit) are logged + swallowed so
// the join callout still posts even if the DM 403s.
export async function maybeSendOnboardingDm(env, guildId, userId) {
  if (!env.DISCORD_BOT_TOKEN) return { skipped: 'no-bot-token' };
  try {
    // Open a DM channel with the user.
    const chRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent':  'loadout-discord onboarding',
      },
      body: JSON.stringify({ recipient_id: String(userId) }),
    });
    if (!chRes.ok) return { skipped: 'dm-channel-failed', status: chRes.status };
    const ch = await chRes.json();
    const { embed, components } = await buildWelcomeEmbed(env, guildId);
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent':  'loadout-discord onboarding',
      },
      body: JSON.stringify({ embeds: [embed], components, allowed_mentions: { parse: [] } }),
    });
    if (!msgRes.ok) return { skipped: 'dm-post-failed', status: msgRes.status };
    return { ok: true };
  } catch (e) {
    console.warn('[onboard] DM send threw', e?.message || e);
    return { skipped: 'threw', error: String(e?.message || e) };
  }
}
