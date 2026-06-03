// Welcome embed handler (Wave 3).
//
// Triggered by GUILD_MEMBER_ADD forwarded from aquilo-presence (the
// gateway shim) to POST /member/joined on this worker. Posts a rich
// themed embed in #👋│introductions with:
//   • Avatar thumbnail (Discord renders rounded)
//   • Title: "Welcome to aquilo.gg, <name>!"
//   • Description: "You're our **<N>th member** to join."
//   • Glossy Aquilo backdrop image (static PNG hosted on aquilo.gg)
//   • Accent color matching brand
//
// "Nth member" is tracked authoritatively at KV guild:join-counter:<g>
// (a monotonic integer we bump per event). approximate_member_count
// from Discord's API drifts under bans/leaves so we don't trust it.
//
// KV layout:
//   guild:join-counter:<g>     monotonic integer
//   guild:welcome-cfg:<g>      { channelId, backdropUrl?, accentColor? }
//   guild:welcomed:<g>:<uid>   '1' (dedup, same user joining twice in
//                                    quick succession only triggers once)

const BRAND_ACCENT_COLOR = 0xF47FFF;  // Aquilo pink
// Default static welcome backdrop hosted on aquilo.gg. The aquilo-site
// session can swap this URL at any time; per-guild override possible
// via the welcome-cfg KV record.
const DEFAULT_BACKDROP_URL =
  'https://aquilo.gg/sprites/welcome/aquilo-welcome-card.png';

async function loadCfg(env, guildId) {
  return env.LOADOUT_BOLTS.get(`guild:welcome-cfg:${guildId}`, { type: 'json' });
}
async function loadGuildBuildCfg(env, guildId) {
  return env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// One-shot admin helper: seed guild:join-counter:<g> from Discord's
// approximate_member_count so the FIRST observed new member doesn't
// appear as "1st member" in a guild with hundreds of pre-existing
// joiners. Idempotent, only seeds when the counter is unset, never
// overwrites an already-running tally unless `force` is true.
//
// Discord's GET /guilds/<g>/preview requires the bot to be a member
// of the guild (which we are, post-claim). It returns
// approximate_member_count which drifts under bans/leaves but is
// the closest thing to "historical member count" we can cheaply
// fetch.
export async function backfillJoinCounter(env, guildId, opts = {}) {
  if (!env?.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId) return { ok: false, error: 'no-guild-id' };
  const key = `guild:join-counter:${guildId}`;
  const existing = await env.LOADOUT_BOLTS.get(key);
  if (existing && !opts.force) {
    return { ok: true, skipped: 'already-set', value: parseInt(existing, 10) || 0 };
  }
  const r = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/preview`,
    { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } },
  );
  if (!r.ok) {
    return { ok: false, error: 'preview-failed', status: r.status, body: (await r.text()).slice(0, 200) };
  }
  const j = await r.json();
  const seed = Number(j?.approximate_member_count) || Number(opts.seedIfPreviewMissing) || 0;
  if (!seed) {
    return { ok: false, error: 'no-member-count', preview: j };
  }
  await env.LOADOUT_BOLTS.put(key, String(seed));
  return { ok: true, seeded: seed, source: 'preview.approximate_member_count', previous: existing || null };
}

function avatarUrl(userId, avatarHash) {
  // animated avatars carry an "a_" prefix on the hash; serve as .gif
  // when present, else .png. Size 256 is enough for the embed thumbnail.
  if (!avatarHash) {
    const disc = Number(BigInt(userId) >> 22n) % 6;   // default-avatar bucket
    return `https://cdn.discordapp.com/embed/avatars/${disc}.png`;
  }
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=256`;
}

// Forwarded payload (Discord GUILD_MEMBER_ADD slim):
//   { guild_id, user: { id, username, global_name, avatar, bot, discriminator } }
export async function handleMemberJoined(env, payload) {
  if (!payload || !payload.guild_id || !payload.user) return { skipped: 'bad-payload' };
  if (payload.user.bot) return { skipped: 'bot' };

  const guildId = String(payload.guild_id);
  const userId = String(payload.user.id);

  // Dedup, same user joining twice in quick succession only triggers
  // one welcome. 30-day TTL: re-joins after that DO trigger again.
  const dedupKey = `guild:welcomed:${guildId}:${userId}`;
  const already = await env.LOADOUT_BOLTS.get(dedupKey);
  if (already) return { skipped: 'already-welcomed' };

  // Resolution order:
  //   1. channel-binding(welcome), KV-only, set by Clay via
  //      /admin/channels/bind so rebinds take effect without
  //      a redeploy
  //   2. guild:welcome-cfg.channelId, legacy per-guild override
  //   3. guild:cfg.ids.ch_introductions, guild-build default
  let channelId = null;
  try {
    const { getChannelBinding } = await import('./channel-bindings.js');
    channelId = await getChannelBinding(env, guildId, 'welcome');
  } catch { /* fall through */ }
  const cfg = await loadCfg(env, guildId);
  const guildCfg = await loadGuildBuildCfg(env, guildId);
  if (!channelId) {
    channelId = cfg?.channelId
      || guildCfg?.ids?.ch_introductions
      || null;
  }
  if (!channelId) return { skipped: 'no-welcome-channel' };

  // Bump the monotonic join counter, the "Nth member" we display.
  // Note: this isn't backfilled with the guild's historical joins, // it starts at 1 for the first new member we observe. For Aquilo
  // (~4 current members) this is fine; for a larger pre-existing
  // server you'd seed it via wrangler kv:key put.
  const counterRaw = await env.LOADOUT_BOLTS.get(`guild:join-counter:${guildId}`);
  const seq = (parseInt(counterRaw || '0', 10) || 0) + 1;
  await env.LOADOUT_BOLTS.put(`guild:join-counter:${guildId}`, String(seq));

  const displayName = payload.user.global_name || payload.user.username || 'friend';
  const avatar = avatarUrl(userId, payload.user.avatar);
  // Per-guild branding overrides, falls back to Aquilo defaults if
  // the tenant hasn't customised any of these.
  const { getBranding } = await import('./branding.js');
  const brand = await getBranding(env, guildId);
  // Per-guild welcome-cfg can still override branding (cfg wins),
  // matching the existing precedence: cfg overrides > brand > defaults.
  const accent   = cfg?.accentColor || brand.accentColor;
  const backdrop = cfg?.backdropUrl || brand.welcomeBackdropUrl;

  const embed = {
    title: `✨ Welcome to ${brand.brandName}, ${displayName}!`,
    description:
      `You're our **${ordinal(seq)} member** to join. 🎉\n\n` +
      `Read the rules in <#${guildCfg?.ids?.ch_rules || ''}>, pick up roles in ` +
      `<#${guildCfg?.ids?.ch_roles || ''}>, and say hi in this channel!\n\n` +
      `🎯 **Open your Welcome Checklist** at ${brand.siteUrl}/quest, four quick steps with a bolts reward at each.`,
    color: accent,
    thumbnail: { url: avatar },
    image: { url: backdrop },
    footer: { text: `Member #${seq} · ${brand.brandName}` },
    timestamp: new Date().toISOString(),
  };

  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: `<@${userId}>`,
      embeds: [embed],
      allowed_mentions: { users: [userId], parse: [] },
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    return { error: 'post-failed', status: r.status, body: txt.slice(0, 200) };
  }

  // Mark dedup AFTER successful post, if the post fails (channel
  // gone, perms revoked) a retry can still try.
  await env.LOADOUT_BOLTS.put(dedupKey, '1', { expirationTtl: 30 * 24 * 60 * 60 });

  // Auto-DM the new joiner with the onboarding flow. Best-effort, // a DM 403 (user has DMs closed) is logged + ignored so the
  // welcome embed above still stands. Dormant in practice until the
  // gateway shim starts forwarding GUILD_MEMBER_ADD, since this
  // function is what the shim calls.
  let dm = null;
  try {
    const { maybeSendOnboardingDm } = await import('./onboarding.js');
    dm = await maybeSendOnboardingDm(env, guildId, userId);
  } catch (e) {
    console.warn('[welcome] onboarding DM threw', e?.message || e);
    dm = { skipped: 'threw', error: String(e?.message || e) };
  }

  return { ok: true, memberNumber: seq, channelId, onboardingDm: dm };
}
