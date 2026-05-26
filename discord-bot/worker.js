// Loadout Discord bot - Cloudflare Worker entry point.
//
// Single-tenant Discord application: one bot ("Loadout"), one Public Key,
// many guilds. Streamers don't create their own Discord app anymore —
// they invite our bot and run /loadout-claim with a code minted by their
// Loadout install.
//
// Routes:
//   POST /interactions               - Discord slash command webhook
//   POST /claim                      - Loadout-side: mint a claim code (TTL 10m)
//   GET  /claim/:code/status         - Loadout-side: poll whether the code was claimed
//   POST /sync/:guildId/init         - Loadout-side: complete registration after claim
//   GET  /sync/:guildId              - Loadout-side: pull wallet snapshot (HMAC)
//   POST /sync/:guildId              - Loadout-side: push wallet snapshot (HMAC)
//   GET  /sync/:guildId/games?since= - Loadout-side: pull recent off-stream
//                                      minigame results so the DLL can
//                                      republish them on the local Aquilo
//                                      Bus and the OBS overlay can render
//                                      them (HMAC).
//   GET  /sync/:guildId/profiles?since= - Loadout-side: pull viewer profile
//                                      edits made via /profile-set-* slash
//                                      commands (HMAC).
//   GET  /health                     - liveness probe
//
// KV layout:
//   publickey                        - the (single) Loadout Discord public key (set once at deploy)
//   claim:<code>                     - { secret, mintedUtc, ttlExpiresUtc, claimedGuildId? }
//   secret:<guildId>                 - { secret, registeredUtc, ownerStreamerName }
//   wallet:<guildId>:<userId>        - per-viewer wallet (see wallet.js)
//   guildowner:<guildId>             - { discordUserId, claimedAt } - the claimer
//   games:<guildId>                  - JSON array (cap 32) of recent minigame
//                                      results, 5-min TTL. DLL polls via
//                                      /sync/:guildId/games to republish on
//                                      the local Aquilo Bus.

import { verifyDiscordSignature, verifyHmac } from './auth.js';
import { handleInteraction } from './commands.js';
import { applySnapshot, readSnapshot, getSecret, setSecret, applyVaultDelta, resetAllWallets, leaderboard } from './wallet.js';
import { readSince as readProfilesSince } from './profiles.js';
import { COMMANDS } from './commands-spec.js';
import { handleExt, handleRelay } from './ext.js';

// Aquilo-bot fold-in: re-export the OverlayBroadcaster Durable Object
// class at the entrypoint so wrangler can attach it to the OVERLAY_DO
// binding declared in wrangler.toml. The DO state on Cloudflare lives
// attached to the *script* that declares it, so even though the
// implementation file is under aquilo/, the class needs to surface
// from the top-level Worker entrypoint module.
export { OverlayBroadcaster } from './aquilo/worker.js';

// Discord interaction "claim" command custom handler — defined here rather
// than commands.js because it touches the claim KV and cross-cuts the
// invite flow's state. Returns a Discord interaction response object.
async function handleClaimCommand(env, data) {
  const code = (data?.data?.options?.find(o => o.name === 'code')?.value || '').toUpperCase().trim();
  const guildId = data?.guild_id;
  const member = data?.member;
  const userId = member?.user?.id;

  if (!guildId)
    return { type: 4, data: { content: 'This command must be run in a server.', flags: 64 } };
  if (!code || !/^[A-Z0-9]{4,12}$/.test(code))
    return { type: 4, data: { content: 'Code must be 4-12 alphanumeric characters.', flags: 64 } };

  // Permission check: only members with MANAGE_GUILD (0x20 = 32) can claim.
  // member.permissions is a string of the bitfield in Discord's payload.
  const perms = BigInt(member?.permissions || '0');
  const MANAGE_GUILD = 1n << 5n;
  if ((perms & MANAGE_GUILD) === 0n)
    return { type: 4, data: { content: '🔒 Only server admins (with **Manage Server**) can claim a code.', flags: 64 } };

  // Look up the code. Pop-on-claim: once claimed, the entry is replaced
  // with a usedAt marker and the secret is moved to secret:<guildId>.
  const key = 'claim:' + code;
  const raw = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  if (!raw)
    return { type: 4, data: { content: '❌ That code doesn\'t exist or has expired. Generate a new one in Loadout.', flags: 64 } };
  if (raw.claimedGuildId)
    return { type: 4, data: { content: '⚠️ That code was already claimed.', flags: 64 } };
  if (raw.ttlExpiresUtc && Date.now() > raw.ttlExpiresUtc)
    return { type: 4, data: { content: '⏰ That code expired. Generate a fresh one in Loadout (codes are valid for 10 minutes).', flags: 64 } };

  // Reject if this guild is already claimed (stops a streamer from accidentally
  // overwriting). Re-claiming requires the streamer to first hit "Unlink"
  // in Loadout, which talks to /sync/:guildId/init with the existing secret.
  const existing = await getSecret(env, guildId);
  if (existing?.secret)
    return { type: 4, data: { content: '⚠️ This server is already claimed by another Loadout install. Unlink first if you\'re moving rigs.', flags: 64 } };

  // Bind the code to this guild + persist the secret as the guild's
  // sync key. The Loadout install will poll /claim/:code/status and
  // see the claimedGuildId field flip; that's its signal to mark
  // setup complete.
  const claimed = { ...raw, claimedGuildId: guildId, claimedUtc: Date.now(), claimedByDiscordUserId: userId };
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(claimed), { expirationTtl: 3600 });   // keep 1h for status polls
  await setSecret(env, guildId, raw.secret, raw.ownerName || 'streamer');
  await env.LOADOUT_BOLTS.put('guildowner:' + guildId, JSON.stringify({
    discordUserId: userId,
    claimedAt: Date.now()
  }));

  return {
    type: 4,
    data: {
      content: '✅ **Loadout claimed for this server.**\n' +
               'The streamer can finish setup back in their Loadout window now. Try `/help` to see available commands.'
    }
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && (path === '/' || path === '/health')) {
      return new Response('loadout-discord ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // Public leaderboard for a guild — read-only, no auth. Filters out
    // wallets with no linked public platform so Discord-only users
    // don't get surfaced on the open web.
    if (method === 'GET' && path.startsWith('/leaderboard/')) {
      return handlePublicLeaderboard(req, env, path);
    }

    if (method === 'POST' && path === '/interactions') {
      return handleDiscordInteractions(req, env, ctx);
    }

    // Loadout-side endpoints
    if (method === 'POST' && path === '/claim')                      return mintClaim(req, env);
    if (method === 'GET'  && path.startsWith('/claim/') && path.endsWith('/status')) return claimStatus(req, env, path);
    // Clash sync routes MUST come before the generic /sync/ catch-all
    // below — otherwise handleSync swallows /sync/<g>/clash-events,
    // /sync/<g>/clash, /sync/<g>/clash/build, etc. and serves them as
    // wallet snapshots, silently dropping the DLL's clash-events
    // ring-buffer poll and the web editor's town write-throughs.
    if (method === 'GET' && path.startsWith('/sync/') && path.endsWith('/clash-events')) {
      const { handleClashEventsPull } = await import('./clash-http.js');
      return handleClashEventsPull(req, env, path);
    }
    if (path.startsWith('/sync/') && (path.endsWith('/clash') || path.includes('/clash/'))) {
      const { handleClashSync } = await import('./clash-http.js');
      return handleClashSync(req, env, path);
    }
    if (path.startsWith('/sync/'))                                   return handleSync(req, env, path);
    if (path.startsWith('/tips/'))                                   return handleTip(req, env, path);

    // Aquilo's Vault integration: gated to the guild in env.AQUILO_VAULT_GUILD_ID
    if (method === 'POST' && path === '/credit-bolts')               return handleVaultCredit(req, env);

    // Read-only balance lookup for cross-bot surfaces (FS Bot /wallet,
    // future StreamFusion widget). HMAC-gated with the same
    // X-Aquilo-Vault-Bolts-Secret as /credit-bolts so we don't expose
    // arbitrary wallet shapes on the open web. Guild allow-list also
    // applies — only AQUILO_VAULT_GUILD_ID can be queried.
    if (method === 'GET' && path === '/wallet-balance')              return handleWalletBalanceRead(req, env);

    // aquilo-bot counting game integration. Awards/deducts bolts when a
    // viewer correctly counts (or breaks the chain) in the counting
    // channel. Auth: shared secret in X-Counting-Secret header
    // (set as LOADOUT_BOLT_API_SECRET on both workers).
    if (method === 'POST' && path === '/counting/award-bolts')       return handleCountingAward(req, env);

    // Streak Freeze cross-Worker consume/read. aquilo-bot's Discord
    // pic/gif check-in handler calls these when a streak-break is
    // detected so it can decide whether to protect the streak. HMAC
    // shares the same LOADOUT_BOLT_API_SECRET used by counting.
    if (method === 'POST' && path === '/streak-freeze/consume') {
      const { handleStreakFreezeConsume } = await import('./streak-freeze.js');
      return handleStreakFreezeConsume(req, env);
    }
    if (method === 'GET'  && path === '/streak-freeze/get') {
      const { handleStreakFreezeRead } = await import('./streak-freeze.js');
      return handleStreakFreezeRead(req, env);
    }

    // Public read for the /admin-bound Discord check-in channel. Polled
    // by aquilo-presence (decide which channels to forward) and by
    // aquilo-bot's checkin.js (filter incoming forwarded messages).
    // Unauthed -- channel IDs aren't sensitive and gating would force
    // every poller through a secret-share setup that buys nothing.
    if (method === 'GET' && path.startsWith('/checkin-channel/')) {
      const guildId = path.slice('/checkin-channel/'.length).replace(/\/+$/, '');
      if (!guildId) return new Response('guildId required', { status: 400 });
      const { handleCheckinChannelRead } = await import('./admin-menu.js');
      return handleCheckinChannelRead(env, guildId);
    }

    // Self-register Loadout slash commands using the Worker's bot
    // token secret. HMAC-gated (same scheme as wallet sync). Lets a
    // Loadout install push the latest commands.spec without the
    // streamer needing to paste the bot token into a shell.
    if (method === 'POST' && path.startsWith('/admin/register-commands/')) {
      return handleRegisterCommands(req, env, path);
    }
    // Drop the onboarding welcome embed into a guild text channel
    // from the admin tooling — same HMAC scheme as register-commands,
    // body { channelId?, channelName? }. See onboarding.js for the
    // channel-pick heuristic and the shared poster.
    if (method === 'POST' && path.startsWith('/admin/onboarding/post-embed/')) {
      return handleOnboardingPostEmbed(req, env, path);
    }
    // Heuristically match the guild's existing roles to the six
    // onboarding interest keys and persist the mapping at
    // onboard:role-map:<g>. Body {}. See onboarding.js
    // matchInterestRoles.
    if (method === 'POST' && path.startsWith('/admin/onboarding/setup-roles/')) {
      return handleOnboardingSetupRoles(req, env, path);
    }
    // Create the baseline opt-in interest roles if a guild doesn't
    // already have a role matching each interest's heuristic. Body
    // { roles?: [{ key, name, color?, mentionable?, hoist?,
    //   permissions? }] } — omit `roles` to use BASELINE_ROLE_SPECS.
    // Idempotent — existing matching roles are skipped, not duped.
    if (method === 'POST' && path.startsWith('/admin/onboarding/ensure-roles/')) {
      return handleOnboardingEnsureRoles(req, env, path);
    }
    // Level-tier roles (Apprentice/Veteran/Elite/Mythic) — create
    // the four roles + map them in KV. Idempotent. See
    // level-tier-roles.js for the threshold spec.
    if (method === 'POST' && path.startsWith('/admin/level-tier-roles/ensure/')) {
      return handleLevelTierRolesEnsure(req, env, path);
    }
    // One-time-per-guild backfill: walk every pxp:* record and
    // grant tier roles to anyone who has already crossed the
    // threshold. Idempotent via a KV marker; pass `{ force: true }`
    // to re-scan.
    if (method === 'POST' && path.startsWith('/admin/level-tier-roles/backfill/')) {
      return handleLevelTierRolesBackfill(req, env, path);
    }
    // Twitch EventSub webhook. Signature is verified inside the
    // handler against env.TWITCH_EVENTSUB_SECRET. Three message
    // types: webhook_callback_verification (challenge handshake),
    // notification (real event — dispatch to twitch-live.js),
    // revocation (log + ack). See twitch-eventsub.js.
    if (method === 'POST' && path === '/twitch/eventsub') {
      const { handleEventSubWebhook } = await import('./twitch-eventsub.js');
      return handleEventSubWebhook(req, env, ctx);
    }
    // Admin-side EventSub subscription manager. HMAC-gated. Creates
    // stream.online + stream.offline subs for Clay's broadcaster id
    // pointing at THIS worker's /twitch/eventsub URL. Idempotent —
    // skips subs that already exist.
    if (method === 'POST' && path.startsWith('/admin/twitch-setup/')) {
      return handleTwitchSetup(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/list-commands/')) {
      return handleListCommands(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/guild-inventory/')) {
      return handleGuildInventory(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/guild-build/')) {
      return handleGuildBuild(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/guild-finalize/')) {
      return handleGuildFinalize(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/guild-automod/')) {
      return handleGuildAutomod(req, env, path);
    }
    if (method === 'POST' && path.startsWith('/admin/ticket-panel/')) {
      return handleTicketPanelPost(req, env, path);
    }
    // One-shot L8 deploy bootstrap. Token-gated via a KV-stored secret
    // (`bootstrap-l8-token`) written by the operator immediately before
    // calling this endpoint. The KV entry self-destructs on first
    // successful use, so the endpoint is harmless without it. Does:
    //   1. PUT slash commands (global + per-guild)
    //   2. Post the ticket panel into 🛠️│support (looked up by name)
    //   3. Backfill guild:cfg.ids with ch_introductions (looked up
    //      by name) — vc_join_to_create + cat_voice already present.
    if (method === 'POST' && path.startsWith('/admin/_bootstrap-l8/')) {
      return handleBootstrapL8(req, env, path);
    }
    // L9 phase-2: create missing channels, bind feature slots,
    // bind commands → channels, post the current schedule. Same
    // one-shot KV-token gate as the L8 bootstrap. See handler for
    // full action list.
    if (method === 'POST' && path.startsWith('/admin/_phase2/')) {
      return handlePhase2(req, env, path);
    }
    // L10 phase-3: create the self-promo channel if missing + post the
    // stylized rules embed above the existing verify button in
    // 🫡│rules. Same one-shot KV-token gate.
    if (method === 'POST' && path.startsWith('/admin/_phase3-rules/')) {
      return handlePhase3Rules(req, env, path);
    }
    // L10 chat-test: drive sendFromPwa with explicit args + return
    // the diagnostic so we can verify the end-to-end webhook flow
    // without needing a real PWA caller. Same token-gate.
    if (method === 'POST' && path.startsWith('/admin/_chat-test/')) {
      return handleChatTest(req, env, path);
    }
    // L10 phase-4: audit + repair category/channel permissions. Each
    // category gets the intended overwrite profile (open / member /
    // patron / staff); every child channel is then synced to its
    // category (overwrites match parent), with extra read-only on
    // announce/rules/feed-style channels. Same one-shot KV-token gate.
    if (method === 'POST' && path.startsWith('/admin/_phase4-perms/')) {
      return handlePhase4Perms(req, env, path);
    }
    // Trace the linked-patreon completion check for a specific user:
    // dumps every signal the worker considers + the snapshot result +
    // the claim outcome. Token-gated, single-use. Lets us prove
    // end-to-end that Clay's user can both see the step as claimable
    // AND successfully claim.
    if (method === 'POST' && path.startsWith('/admin/_quest-trace/')) {
      return handleQuestTrace(req, env, path);
    }

    // Twitch panel extension backend — additive, JWT- + channel-gated.
    // Public read-only stocks snapshot for the aquilo.gg /stocks page +
    // the Twitch panel's read-only Stocks tab. No auth gate — returns
    // catalog + prices + sparkline history slices.
    if (method === 'GET' && path === '/stocks/public') {
      const { publicStocksSnapshot } = await import('./stocks.js');
      return publicStocksSnapshot(env);
    }
    // Public read-only sports snapshot for the panel's Sports tab — the
    // 48h upcoming-games slice with optional moneyline odds.
    if (method === 'GET' && path === '/sports/public') {
      const { publicSportsSnapshot } = await import('./bet.js');
      return publicSportsSnapshot(env);
    }

    // Public read-only schedule snapshot for aquilo.gg + (later) the
    // panel's Schedule tab. Composes schedule:v1 + games:v1 +
    // channel:vote:guild and computes nextStream + voteActive. See
    // SCHEDULE-SYSTEM-DESIGN.md Phase 2.
    if (method === 'GET' && path === '/schedule/public') {
      const { handlePublicScheduleHttp } = await import('./schedule.js');
      return handlePublicScheduleHttp(env);
    }
    if (method === 'GET' && path === '/games/public') {
      const { handlePublicGamesHttp } = await import('./schedule.js');
      return handlePublicGamesHttp(env);
    }
    // Public read-only queue snapshot for aquilo.gg /community page +
    // the panel's Schedule tab. No auth -- counts only, no joiner
    // names. See queue.js + SCHEDULE-SYSTEM-DESIGN.md Phase 3.
    if (method === 'GET' && path === '/queues/public') {
      const { snapshotQueue } = await import('./queue.js');
      const guildId = env.AQUILO_VAULT_GUILD_ID;
      if (!env.LOADOUT_BOLTS || !guildId) {
        return new Response(JSON.stringify({ error: 'not-configured' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }
      const url2 = new URL(req.url);
      const date = url2.searchParams.get('date');
      const snap = await snapshotQueue(env, guildId, date);
      return new Response(JSON.stringify({ ok: true, ...snap }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=0, s-maxage=10',
          'access-control-allow-origin': '*',
        },
      });
    }

    if (path.startsWith('/ext/')) return handleExt(req, env, ctx);

    // Public read-only starboard wall for aquilo.gg /community/. Same
    // public-read shape as /stocks/public + /queues/public — no
    // auth, edge-cacheable. Path sits under /web/ for parity with the
    // site's other /api/* proxy paths, but is claimed BEFORE the
    // /web/* HMAC dispatcher below since it's a public read.
    //
    // Response shape (matches the aquilo-site wall consumer):
    //   {
    //     ok: true,
    //     items: [{
    //       messageId, authorName, authorAvatarUrl?, content,
    //       attachments?, starCount, originalUrl?, ts
    //     }, ...]
    //   }
    //
    // Source: KV ringbuffer fed by handleStarboardReaction once a
    // message crosses STARBOARD_THRESHOLD. See guild-features.js.
    // Guild defaults to AQUILO_VAULT_GUILD_ID; ?guildId=<id> overrides.
    if (method === 'GET' && path === '/web/starboard/recent') {
      const { readStarboardRecent } = await import('./guild-features.js');
      const url2 = new URL(req.url);
      const guildId = url2.searchParams.get('guildId') || env.AQUILO_VAULT_GUILD_ID;
      const limit = url2.searchParams.get('limit') || '25';
      if (!env.LOADOUT_BOLTS || !guildId) {
        return new Response(JSON.stringify({ ok: false, error: 'not-configured', items: [] }), {
          status: 503,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        });
      }
      const r = await readStarboardRecent(env, guildId, limit);
      return new Response(JSON.stringify(r), {
        status: r.ok ? 200 : 404,
        headers: {
          'content-type': 'application/json',
          // 30s edge cache + a fresh wall feels live without
          // hammering KV on every viewer pageload.
          'cache-control': 'public, max-age=0, s-maxage=30',
          'access-control-allow-origin': '*',
        },
      });
    }

    // Progression (P2) routes — public reads, claimed BEFORE the
    // generic /web/* dispatcher below (which is HMAC-gated and would
    // reject public reads). /p/season/* must be matched FIRST since
    // it's a sub-path of /p/* and the userId-shaped path below would
    // otherwise treat "season" as a userId.
    if (method === 'GET' && path.startsWith('/p/season')) {
      const { handlePublicSeason } = await import('./progression/http.js');
      return handlePublicSeason(req, env, path);
    }
    if (method === 'GET' && path.startsWith('/p/')) {
      const { handleProfilePage } = await import('./progression/http.js');
      return handleProfilePage(req, env, path);
    }
    // P5 — account-link OAuth/OpenID flows. These live under
    // /web/profile/link/ specifically so the more-generic profile
    // dispatcher below doesn't intercept the redirect callbacks.
    if (path.startsWith('/web/profile/link/')) {
      const { handleWebProfileLink } = await import('./progression/http.js');
      return handleWebProfileLink(req, env, path);
    }
    if (path.startsWith('/web/profile/')) {
      const { handleWebProfile } = await import('./progression/http.js');
      return handleWebProfile(req, env, path);
    }
    if (path.startsWith('/web/xp/')) {
      const { handleWebXp } = await import('./progression/http.js');
      return handleWebXp(req, env, path);
    }
    if (path.startsWith('/web/achievements/')) {
      const { handleWebAchievements } = await import('./progression/http.js');
      return handleWebAchievements(req, env, path);
    }
    if (path.startsWith('/web/badges/')) {
      const { handleWebBadges } = await import('./progression/http.js');
      return handleWebBadges(req, env, path);
    }
    // (season public read is dispatched up top under /p/season — see
    // line 245. Claim POST is routed via the HMAC-gated /web/* path
    // → /web/season/claim in web.js.)
    if (path.startsWith('/web/tournaments')) {
      const { handleWebTournaments } = await import('./progression/http.js');
      return handleWebTournaments(req, env, path);
    }
    if (path === '/web/progression/dashboard') {
      const { handleWebDashboard } = await import('./progression/http.js');
      return handleWebDashboard(req, env, path);
    }

    // ── B-batch: community + LFG + DM fan-out + voice ───────────────
    // All HMAC-gated against AQUILO_SITE_WEB_SECRET (the same secret
    // the existing /web/* surface uses). Aquilo-site's Pages Functions
    // bridge to these. Ordered BEFORE the generic /web/ dispatcher so
    // public-GET endpoints don't get gated by web.js's method check.

    // B1 — Username
    if (path.startsWith('/web/community/username')) {
      const { handleUsername } = await import('./community.js');
      return handleUsername(req, env, path);
    }
    // B2 — Gamertags
    if (path.startsWith('/web/gamertags/')) {
      const { handleGamertags } = await import('./community.js');
      return handleGamertags(req, env, path);
    }
    // B3 — Guild channels
    if (path.startsWith('/web/guild/') && path.endsWith('/channels')) {
      const { handleGuildChannels } = await import('./community.js');
      return handleGuildChannels(req, env, path);
    }
    // B4 — Members list
    if (path === '/web/community/members') {
      const { handleMembers } = await import('./community.js');
      return handleMembers(req, env, path);
    }
    // Public supporter wall (B1 integration — username field surfaces here)
    if (path === '/community/supporters' && method === 'GET') {
      const { handleSupporterWall } = await import('./community.js');
      return handleSupporterWall(req, env, path);
    }
    // B5 — LFG
    if (path.startsWith('/web/lfg')) {
      const { handleLfgRoute } = await import('./lfg.js');
      return handleLfgRoute(req, env, path);
    }
    // B6 — Discord-DM fan-out
    if (path === '/push/dm') {
      const { handlePushDm } = await import('./push-dm.js');
      return handlePushDm(req, env);
    }
    // F1 — Friends system (HMAC-gated writes, public GETs)
    if (path.startsWith('/web/friends/') || path === '/web/friends') {
      const { handleFriendsRoute } = await import('./friends.js');
      return handleFriendsRoute(req, env, path);
    }
    // F3 — Community activity feed (public GET)
    if (path === '/community/feed') {
      const { handleCommunityFeedRoute } = await import('./activity-feed.js');
      return handleCommunityFeedRoute(req, env);
    }
    // G2 — Weekly community challenge (public GET)
    if (path === '/community/challenge' || path === '/community/challenge/history') {
      const { handleChallengeRoute } = await import('./challenges.js');
      return handleChallengeRoute(req, env, path);
    }

    // aquilo.gg website minigames -- HMAC from the site's Pages
    // Functions, signed with AQUILO_SITE_WEB_SECRET. See web.js +
    // MINIGAMES-WEB-DESIGN.md.
    if (path.startsWith('/web/')) {
      const { handleWeb } = await import('./web.js');
      return handleWeb(req, env);
    }

    // Overlay relay queue — polled by Streamer.bot, RELAY_TOKEN-gated.
    if (path.startsWith('/relay/')) return handleRelay(req, env);

    // StreamFusion release-notes webhook (ported from the retired
    // StreamFusion/bot-service /post-release Node service). Voice-
    // channel detection — the only piece that needed a persistent
    // Gateway connection — was scrapped per Clay, so this is the
    // only SF-specific feature worth migrating into the Worker.
    // X-SF-Release-Secret header carries the auth; matches
    // SF_RELEASE_SECRET. See discord-bot/sf-release.js.
    if (method === 'POST' && path === '/sf/post-release') {
      const { handlePostRelease } = await import('./sf-release.js');
      return handlePostRelease(req, env);
    }

    // StreamFusion community-sharing surface — see sf-community.js.
    //   POST /sf/community-live     opt-in live-status heartbeat
    //   POST /sf/community-event    opt-in event relay (follows/subs/etc)
    //   GET  /community/live        public radar consumed by aquilo.gg
    if (method === 'POST' && path === '/sf/community-live') {
      const { handleCommunityLive } = await import('./sf-community.js');
      return handleCommunityLive(req, env);
    }
    if (method === 'POST' && path === '/sf/community-event') {
      const { handleCommunityEvent } = await import('./sf-community.js');
      return handleCommunityEvent(req, env);
    }
    if (method === 'GET' && path === '/community/live') {
      const { handlePublicCommunityLive } = await import('./sf-community.js');
      return handlePublicCommunityLive(req, env);
    }

    // StreamFusion community-night queue manager — see sf-queue.js.
    //   POST /sf/queue          full queue + per-joiner links for the panel
    //   POST /sf/queue/remove   drop a joiner after the streamer marks done
    if (method === 'POST' && path === '/sf/queue') {
      const { handleSfQueueRead } = await import('./sf-queue.js');
      return handleSfQueueRead(req, env);
    }
    if (method === 'POST' && path === '/sf/queue/remove') {
      const { handleSfQueueRemove } = await import('./sf-queue.js');
      return handleSfQueueRemove(req, env);
    }

    // Character paper-doll render endpoint. Public read; ETag/
    // cache-control tied to ?v=<lookVersion> so Discord embeds
    // re-fetch after a customisation change. See character.js.
    if (method === 'GET' && path.startsWith('/character/render/')) {
      const { handleCharacterRender } = await import('./character.js');
      return handleCharacterRender(req, env, path);
    }

    // User-uploaded hero avatar — public read. Stored in KV with
    // contentType metadata; route streams the bytes back. Cache pinned
    // to ?v=<uploadedAt>. See character.js handleCharacterAvatar.
    // Path shape: /character/avatar/<userId>(.bin|.png|.jpg|...)
    if (method === 'GET' && path.startsWith('/character/avatar/')) {
      const { handleCharacterAvatar } = await import('./character.js');
      return handleCharacterAvatar(req, env, path);
    }

    // Aquilo-bot fold-in HTTP routes. Returns null when none of the
    // aquilo routes match so we fall through to the final 404.
    // Covers: /today-game, /overlay/ws, /counting/message,
    // /forward-channels, /announce, /broadcast, /fourthwall,
    // /sr/pending. See discord-bot/aquilo/worker.js.
    {
      const { handleAquiloHttp } = await import('./aquilo/worker.js');
      const r = await handleAquiloHttp(req, env, ctx, url);
      if (r) return r;
    }

    // ── Clash (Phase 4) ────────────────────────────────────────────
    // Public global leaderboard (top raiders + top towns) — no auth,
    // mirrors /leaderboard/<guildId>. Future aquilo.gg /clash page
    // hits this for the ranked-ladder view.
    if (method === 'GET' && path === '/clash-leaderboard') {
      const { handleClashLeaderboardHttp } = await import('./clash-http.js');
      return handleClashLeaderboardHttp(req, env);
    }
    // Public per-town read for the web base editor + Twitch panel —
    // returns enough state to render the town view client-side.
    if (method === 'GET' && path.startsWith('/clash/town/')) {
      const { handleClashTownPublic } = await import('./clash-http.js');
      return handleClashTownPublic(env, path);
    }
    // /sync/<g>/clash[-events] are dispatched earlier (before the
    // generic /sync/ catch-all). See the block near /claim.

    // /p/ profile page hoisted earlier in dispatch order doesn't fit
    // here cleanly because /p/ doesn't collide with anything; placed
    // earlier to be findable. (handled above the /web/ block.)

    return new Response('not found', { status: 404 });
  },

  // Cron dispatcher. Wired via [triggers] crons in wrangler.toml.
  //   17 * * * *      stocks price refresh (stocks.js)
  //   23 * * * *      sports games + bet settlement + bolts-feed digest
  //   0 1,2 * * *     queue auto-open at 9 PM ET (1 UTC = 21 EST,
  //                   2 UTC = 21 EDT — one fires per day depending on
  //                   DST. autoOpenIfDue() filters on local hour == 21
  //                   so only the live one actually does anything.)
  // Errors caught per job so a single bad source can't break the rest.
  async scheduled(event, env, ctx) {
    try {
      if (event.cron === '17 * * * *') {
        const { stocksCronTick } = await import('./stocks.js');
        ctx.waitUntil(stocksCronTick(env));
        // Twitch hourly bundle — live-embed refresh + clip poll +
        // Sunday-22-ET clip-of-the-week + Sunday-20-ET weekly recap.
        // Each task is independently best-effort + no-ops cleanly
        // when the relevant secrets/env aren't set.
        ctx.waitUntil((async () => {
          try {
            const { isTwitchConfigured } = await import('./twitch-helix.js');
            if (isTwitchConfigured(env) && env.CLAY_TWITCH_CHANNEL_ID) {
              // Mid-stream refresh: hourly cadence (the cron tier
              // we're on caps at 4 triggers, all used elsewhere).
              // EventSub gives us instant on/off; the hourly tick
              // just keeps viewer-count + game name from going
              // stale during long sessions.
              const { refreshLiveEmbed } = await import('./twitch-live.js');
              await refreshLiveEmbed(env, env.CLAY_TWITCH_CHANNEL_ID).catch(e =>
                console.warn('[cron] refreshLiveEmbed', e?.message || e));
              const { pollNewClipsCron } = await import('./twitch-clips.js');
              await pollNewClipsCron(env).catch(e =>
                console.warn('[cron] pollNewClipsCron', e?.message || e));
            }
          } catch (e) {
            console.warn('[cron] twitch hourly bundle', e?.message || e);
          }
        })());
        // Sunday 8pm ET → weekly recap. Sunday 10pm ET → clip of
        // the week. ET-gated via getETInfo so DST is handled
        // automatically; both functions are KV-marker idempotent
        // so the at-least-once cron semantics don't double-fire.
        ctx.waitUntil((async () => {
          try {
            const { getETInfo } = await import('./aquilo/util.js');
            const { weekday, hour } = getETInfo(new Date(event.scheduledTime || Date.now()));
            if (weekday === 'sunday' && hour === 20) {
              const { postWeeklyRecap } = await import('./weekly-recap.js');
              const r = await postWeeklyRecap(env);
              console.log('[cron] weekly-recap', JSON.stringify(r));
            }
            if (weekday === 'sunday' && hour === 22) {
              const { postClipOfTheWeekCron } = await import('./twitch-clips.js');
              const r = await postClipOfTheWeekCron(env);
              console.log('[cron] clip-of-the-week', JSON.stringify(r));
            }
          } catch (e) {
            console.warn('[cron] sunday gates', e?.message || e);
          }
        })());
      } else if (event.cron === '23 * * * *') {
        const { betCronTick } = await import('./bet.js');
        ctx.waitUntil(betCronTick(env));
        // Bolts-feed digest piggybacks on the :23 tick — no extra cron
        // slot needed in wrangler.toml. Independent waitUntil so a
        // failure in one doesn't cancel the other.
        const { boltsFeedCronTick } = await import('./bolts-feed.js');
        ctx.waitUntil(boltsFeedCronTick(env));
      } else if (event.cron === '0 1 * * *' || event.cron === '0 2 * * *') {
        // Queue auto-open at 9 PM ET on variety/community nights.
        // autoOpenIfDue is idempotent + bails if conditions aren't met.
        const guildId = env.AQUILO_VAULT_GUILD_ID;
        if (guildId) {
          ctx.waitUntil((async () => {
            const { autoOpenIfDue } = await import('./queue.js');
            const r = await autoOpenIfDue(env, guildId);
            if (!r.fired) {
              console.log('queue auto-open: skipped (' + r.reason + ')');
              return;
            }
            // Empty queue created; tell aquilo-site to fan out the PWA push
            // (best-effort, never blocks the open).
            try {
              const { notifyQueueAutoOpened } = await import('./queue.js');
              await notifyQueueAutoOpened(env, guildId, r.streamDate, r.kind);
            } catch (e) {
              console.error('queue auto-open notify failed:', e && e.message);
            }
          })());
        }
      }
      // Clash housekeeping piggybacks on the :23 hourly tick — CF
      // free plan caps a Worker at 5 cron triggers and we're using
      // all five for stocks/sports/queue/aquilo. Inside
      // clash-cron.js the tick gates the once-per-day trophy decay
      // via a `clash:cron:last-decay` KV marker so it only runs once
      // per UTC day even though the cron fires hourly.
      if (event.cron === '23 * * * *') {
        const { clashDailyCronTick } = await import('./clash-cron.js');
        ctx.waitUntil(clashDailyCronTick(env, event.cron));
        // Aquilo-bot fold-in piggybacks on the same :23 tick (CF
        // free-plan 4-cron ceiling on this account). The aquilo
        // handler runs per-task hour checks and KV-marker dedupe so
        // firing once per hour is correct and idempotent. The
        // standalone worker's old 12:30 AM ET queue-cleanup minute-
        // branch shifts to 1:23 AM ET, which is a cosmetic ~30 min
        // delay on a post-stream message cleanup — fine.
        const { aquiloScheduledTick } = await import('./aquilo/worker.js');
        ctx.waitUntil(aquiloScheduledTick(event, env, ctx));
        // Consolidated daily-bonus push — first :23 tick at/after
        // 13 UTC fires the once-per-day PWA notification to
        // subscribers reminding them that boltbound free pack,
        // loadout daily, check-in, and daily missions are all
        // claimable again. KV-marker dedupe means only one fires
        // per UTC day even though the cron runs hourly.
        const { dailyBonusCronTick } = await import('./daily-bonus-push.js');
        ctx.waitUntil(dailyBonusCronTick(env));
        // Board-game async forfeit sweep — any correspondence match
        // whose 24h per-move deadline elapsed gets resolved to the
        // opponent (wager goes with the win). On-read paths in
        // boardgames-engine.js also catch expired matches when a
        // player actively loads them; this sweep is the safety net
        // for games no one is watching.
        const { cronSweepExpiredMatches } = await import('./boardgames-engine.js');
        ctx.waitUntil(cronSweepExpiredMatches(env));
      }
    } catch (e) {
      console.error('scheduled cron failed:', e && e.message);
    }
  },
};

// ---- /leaderboard/:guildId (public, read-only) ---------------------------
// Returns the top-N wallets for a guild, filtered to viewers who have
// linked at least one public platform handle (twitch/youtube/etc). The
// goal is community-facing "top contributors" surfaces — Discord-only
// users haven't opted in to public identification, so we omit them.
//
// Response shape:
//   {
//     guildId: "1504103035951906883",
//     updatedAt: 1700000000000,
//     entries: [
//       { rank: 1, display: "MidnightWolf", platform: "twitch", balance: 12450, lifetimeEarned: 25000 },
//       ...
//     ]
//   }
//
// Cached server-side in KV for 60s so a busy homepage doesn't churn
// the wallet:* list-and-fetch on every page view.

const LEADERBOARD_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'public, max-age=60',
};

async function handlePublicLeaderboard(req, env, path) {
  // path = /leaderboard/<guildId>
  const guildId = path.split('/')[2] || '';
  if (!/^\d{5,25}$/.test(guildId)) {
    return jsonCors({ error: 'guildId must be a numeric Discord snowflake' }, 400);
  }

  const url = new URL(req.url);
  const limit = Math.min(
    25,
    Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10) || 10)
  );

  // Server-side cache — leaderboard is the same for everyone, no point
  // recomputing per request.
  const cacheKey = `leaderboard-cache:${guildId}`;
  try {
    const cached = await env.LOADOUT_BOLTS.get(cacheKey, { type: 'json' });
    if (cached && cached.updatedAt && Date.now() - cached.updatedAt < 60_000) {
      // Trim to the requested limit even if the cache holds more.
      const out = { ...cached, entries: cached.entries.slice(0, limit) };
      return jsonCors(out, 200);
    }
  } catch {
    /* fall through to recompute */
  }

  try {
    // Fetch up to top 50 by raw balance, then filter and trim.
    const top = await leaderboard(env, guildId, 50);
    const filtered = top.filter(
      ({ w }) =>
        w &&
        Array.isArray(w.links) &&
        w.links.some(l => l && l.platform && l.username)
    );
    const entries = filtered.slice(0, limit).map(({ w }, i) => {
      const primary =
        (w.links || []).find(l => l && l.platform === 'twitch') ||
        (w.links || []).find(l => l && l.platform && l.username) ||
        null;
      return {
        rank: i + 1,
        display: primary?.username || 'Viewer',
        platform: primary?.platform || null,
        balance: Number(w.balance || 0),
        lifetimeEarned: Number(w.lifetimeEarned || 0),
      };
    });

    const payload = {
      guildId,
      updatedAt: Date.now(),
      entries,
    };

    // Cache for 2x the freshness window so a stampede doesn't all
    // recompute at exactly 60s. Lazy refresh — first request after
    // expiry rebuilds and overwrites.
    try {
      await env.LOADOUT_BOLTS.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: 300,
      });
    } catch {
      /* non-fatal */
    }

    return jsonCors(payload, 200);
  } catch (err) {
    return jsonCors({ error: 'leaderboard failed', detail: String(err) }, 500);
  }
}

function jsonCors(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...LEADERBOARD_CORS },
  });
}

// ---- /credit-bolts (Aquilo's Vault → Loadout Bolts) ---------------------
// Vault bot calls here to mirror cap activity into off-stream Bolts.
// Auth: shared secret in X-Aquilo-Vault-Bolts-Secret header.
// Allow-list: env.AQUILO_VAULT_GUILD_ID restricts which guild can be credited
// (so a leaked secret can only target the configured Vault server, not any
// random Loadout-using server).

async function handleVaultCredit(req, env) {
  const expected = env.AQUILO_VAULT_BOLTS_SECRET;
  if (!expected) return new Response('credit endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-aquilo-vault-bolts-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const guildId = String(body.guild_id || '');
  const userId  = String(body.user_id  || '');
  const amount  = Number(body.amount);
  const reason  = String(body.reason || 'vault');

  if (!guildId || !userId || !Number.isFinite(amount)) {
    return new Response('guild_id, user_id, integer amount required', { status: 400 });
  }
  const allowed = env.AQUILO_VAULT_GUILD_ID;
  if (allowed && guildId !== String(allowed)) {
    return new Response('guild not allowed', { status: 403 });
  }

  const { wallet, was_new } = await applyVaultDelta(env, guildId, userId, Math.trunc(amount), reason);
  return json({ ok: true, balance: wallet.balance, was_new });
}

// ---- /wallet-balance (read-only cross-bot lookup) -----------------------
// Lets the Aquilo's Vault bot's /wallet command (and future surfaces)
// show the SAME bolts number that /loadout shows in this server. No
// mutation — pure read. Auth + allow-list mirror /credit-bolts.
async function handleWalletBalanceRead(req, env) {
  const expected = env.AQUILO_VAULT_BOLTS_SECRET;
  if (!expected) return new Response('wallet endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-aquilo-vault-bolts-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  const url = new URL(req.url);
  const guildId = String(url.searchParams.get('guild_id') || '');
  const userId  = String(url.searchParams.get('user_id')  || '');
  if (!guildId || !userId) {
    return new Response('guild_id, user_id query params required', { status: 400 });
  }
  const allowed = env.AQUILO_VAULT_GUILD_ID;
  if (allowed && guildId !== String(allowed)) {
    return new Response('guild not allowed', { status: 403 });
  }

  const { getWallet } = await import('./wallet.js');
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    balance:        w.balance        || 0,
    lifetimeEarned: w.lifetimeEarned || 0,
    lifetimeSpent:  w.lifetimeSpent  || 0,
    dailyStreak:    w.dailyStreak    || 0,
    lastEarnUtc:    w.lastEarnUtc    || 0,
    lastEarnReason: w.lastEarnReason || '',
    linkedCount:   (w.links || []).length,
  });
}

// ---- /counting/award-bolts (aquilo-bot → Loadout) ----------------------
// Counting-game integration. aquilo-bot calls here on each successful
// count (positive amount) or fail (negative amount). Same wallet
// primitive as the Vault integration — applyVaultDelta handles the
// balance clamp at 0 and tracks lifetimeEarned/Spent correctly.
//
// Auth: shared secret in X-Counting-Secret header, set as
// LOADOUT_BOLT_API_SECRET on this worker (and the same value on
// aquilo-bot's wrangler secret of the same name).
async function handleCountingAward(req, env) {
  const expected = env.LOADOUT_BOLT_API_SECRET;
  if (!expected) return new Response('counting endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-counting-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const guildId = String(body.guildId || body.guild_id || '');
  const userId  = String(body.userId  || body.user_id  || '');
  const amount  = Number(body.amount);
  const reason  = String(body.reason || 'counting');

  if (!guildId || !userId || !Number.isFinite(amount)) {
    return new Response('guildId, userId, integer amount required', { status: 400 });
  }

  const { wallet, was_new } = await applyVaultDelta(env, guildId, userId, Math.trunc(amount), reason);
  return json({ ok: true, balance: wallet.balance, was_new });
}

// ---- /interactions ------------------------------------------------------

async function handleDiscordInteractions(req, env, ctx) {
  // Single-tenant: one public key. Set it once via:
  //   wrangler kv:key put --binding=LOADOUT_BOLTS publickey <hex>
  const publicKey = await env.LOADOUT_BOLTS.get('publickey');
  if (!publicKey) return new Response('worker not provisioned', { status: 500 });

  const body = await req.text();
  const reReq = new Request(req.url, { method: 'POST', headers: req.headers, body });
  const v = await verifyDiscordSignature(reReq, publicKey);
  if (!v.ok) return new Response('bad signature', { status: 401 });

  let data;
  try { data = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }

  // PING
  if (data.type === 1) return json({ type: 1 });

  // /loadout-claim is special-cased — handled inline because it touches
  // the claim KV. Everything else flows through handleInteraction.
  if (data.type === 2 && data?.data?.name === 'loadout-claim') {
    const resp = await handleClaimCommand(env, data);
    return json(resp);
  }

  return handleInteraction(req, env, body, ctx);
}

// ---- /claim (Loadout mints a code) --------------------------------------

async function mintClaim(req, env) {
  // Loadout-side bootstrap: a streamer hits "Get my code" in Settings;
  // Loadout calls this with no auth (well, just the worker URL the user
  // configured). We mint a short alphanumeric code, generate a fresh
  // HMAC secret, and store both with a 10-min TTL. The streamer types
  // the code in their Discord server; that POSTs through /interactions
  // and gets bound to a guild id.
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const ownerName = (body.ownerName || '').slice(0, 64);

  const code = randomCode(8);
  const secret = randomSecret();
  const ttlMs = 10 * 60 * 1000;

  await env.LOADOUT_BOLTS.put('claim:' + code, JSON.stringify({
    secret,
    ownerName,
    mintedUtc: Date.now(),
    ttlExpiresUtc: Date.now() + ttlMs
  }), { expirationTtl: 600 });

  return json({
    code,
    secret,
    expiresInSec: 600,
    invite: 'https://discord.com/oauth2/authorize?client_id=' + (env.DISCORD_APP_ID || 'CLIENT_ID') +
            '&permissions=2147485696&scope=bot+applications.commands'
  });
}

// ---- /claim/:code/status (Loadout polls until claimed) ------------------

async function claimStatus(req, env, path) {
  const parts = path.split('/').filter(Boolean);  // ['claim', '<code>', 'status']
  const code = (parts[1] || '').toUpperCase();
  if (!code) return new Response('code required', { status: 400 });
  const raw = await env.LOADOUT_BOLTS.get('claim:' + code, { type: 'json' });
  if (!raw) return json({ status: 'expired' });
  if (raw.claimedGuildId) return json({ status: 'claimed', guildId: raw.claimedGuildId });
  return json({ status: 'pending' });
}

// ---- /tips/:guildId/:secret --------------------------------------------
// Streamer's tip-provider (Streamlabs / StreamElements / Ko-fi / etc.)
// posts a normalized donation here. We append it to a rolling per-guild
// log; the DLL polls /sync/<guild>/tips?since=<ms> to pick them up,
// award bolts, and republish on the local Aquilo Bus so overlays light
// up. We deliberately don't accept upstream webhook formats directly —
// the streamer wires their provider to this endpoint via a Streamer.bot
// HTTP request action that posts the normalized shape:
//
//   POST /tips/<guildId>/<secret>
//   {
//     "tipper": "rosie",                // display name
//     "tipperPlatform": "twitch",       // optional, lowercase
//     "tipperHandle": "rosie_91",       // optional, the actual handle on the platform
//     "amount": 5.00,
//     "currency": "USD",
//     "message": "love the stream",
//     "source": "streamlabs",           // audit only
//     "tipId": "sl-12345"               // dedup key (optional)
//   }
//
// Why a path-segment secret: tip providers tend to be picky about
// custom headers but happy to take an arbitrary URL. Easier wire-up
// for streamers, comparable security to a header-bearing token.
async function handleTip(req, env, path) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const parts = path.split('/').filter(Boolean);   // ['tips', '<guildId>', '<secret>']
  if (parts.length < 3) return new Response('guildId and secret required', { status: 400 });
  const guildId = parts[1];
  const presented = parts[2];
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('guild not registered', { status: 404 });
  // Constant-time-ish compare. Worker timing isn't a great side-channel
  // anyway, but no reason to leak more than necessary.
  if (presented.length !== stored.secret.length) return new Response('bad secret', { status: 401 });
  let acc = 0;
  for (let i = 0; i < presented.length; i++) acc |= presented.charCodeAt(i) ^ stored.secret.charCodeAt(i);
  if (acc !== 0) return new Response('bad secret', { status: 401 });

  let payload;
  try { payload = await req.json(); }
  catch { return new Response('bad json', { status: 400 }); }
  const amount = Number(payload?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return new Response('amount required', { status: 400 });

  const tip = {
    tipper:         String(payload.tipper        || 'anonymous').slice(0, 64),
    tipperPlatform: String(payload.tipperPlatform || '').toLowerCase().slice(0, 16),
    tipperHandle:   String(payload.tipperHandle  || '').slice(0, 64),
    amount,
    currency:       String(payload.currency || 'USD').toUpperCase().slice(0, 8),
    message:        String(payload.message  || '').slice(0, 240),
    source:         String(payload.source   || 'unknown').toLowerCase().slice(0, 32),
    tipId:          String(payload.tipId    || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
    ts:             Date.now()
  };

  // Append to the rolling tip log. Capped at 200 entries — the DLL
  // polls every minute and clears its cursor, so even an active
  // multi-day-offline backlog stays well under cap.
  const key = 'tips:' + guildId;
  const existing = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
  // Dedup by tipId — re-deliveries from the streamer's tip provider
  // would otherwise double-credit the viewer.
  if (existing.some(e => e.tipId === tip.tipId)) {
    return new Response(JSON.stringify({ ok: true, dedup: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  existing.push(tip);
  while (existing.length > 200) existing.shift();
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(existing));

  return new Response(JSON.stringify({ ok: true, tipId: tip.tipId }),
                      { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /sync/:guildId... --------------------------------------------------

async function handleSync(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['sync', ':guildId', maybe 'init'|'games']
  const guildId = parts[1];
  const sub = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  if (sub === 'init' && req.method === 'POST') return handleSyncInit(req, env, guildId);

  const ts  = req.headers.get('x-loadout-ts');
  const sig = req.headers.get('x-loadout-sig');
  const body = req.method === 'POST' ? await req.text() : '';
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('guild not registered', { status: 404 });

  const ok = await verifyHmac(stored.secret, ts || '', body, sig || '');
  if (!ok) return new Response('bad signature', { status: 401 });

  // B7 — /sync/:guildId/voice/joined — DLL forwards Discord voice-state
  // events here so the worker can drive "join channel X → spawn a temp
  // VC" without maintaining a Gateway connection. HMAC same as the
  // other /sync/* routes. Body: { userId, displayName?, channelId|null }.
  // channelId === TEMP_VC_PARENT_ID → spawn-then-move flow;
  // channelId on a tracked temp VC → stamp lastActivityUtc so the
  // cleanup heuristic doesn't delete a busy room.
  if (sub === 'voice' && parts[3] === 'joined' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(body); } catch { return new Response('bad-json', { status: 400 }); }
    const { handleVoiceStateUpdate } = await import('./voice-temp.js');
    const r = await handleVoiceStateUpdate(env, { ...payload, guildId });
    return new Response(JSON.stringify(r), { status: r.ok ? 200 : 400, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/games?since=<ms> — DLL pulls recent minigame results so
  // they can be republished on the local Aquilo Bus. Same HMAC scheme as
  // the wallet endpoints; ts+\n is the signed payload for GETs.
  if (sub === 'games' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const all = (await env.LOADOUT_BOLTS.get('games:' + guildId, { type: 'json' })) || [];
    const fresh = all.filter(e => (e.ts || 0) > sinceMs);
    const latest = fresh.length > 0 ? fresh[fresh.length - 1].ts : (all.length > 0 ? all[all.length - 1].ts : sinceMs);
    return new Response(JSON.stringify({ events: fresh, ts: latest }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/tips?since=<ms> — DLL pulls recent tip events to award
  // bolts locally and republish on the Aquilo Bus. Same HMAC scheme as
  // the wallet endpoints; ts+\n is the signed payload for GETs. Returns
  // { tips: [...], ts } so the DLL can advance its cursor.
  if (sub === 'tips' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const all = (await env.LOADOUT_BOLTS.get('tips:' + guildId, { type: 'json' })) || [];
    const fresh = all.filter(e => (e.ts || 0) > sinceMs);
    const latest = fresh.length > 0 ? fresh[fresh.length - 1].ts : (all.length > 0 ? all[all.length - 1].ts : sinceMs);
    return new Response(JSON.stringify({ tips: fresh, ts: latest }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/profiles?since=<ms> — DLL pulls Discord-side profile
  // edits (/profile-set-bio, etc.) and merges them into its local
  // ViewerProfileStore via the wallet's identity links. Returns
  // { profiles: [{userId, profile, deleted, ts}], ts } so the DLL can
  // advance its cursor to the latest seen.
  if (sub === 'profiles' && req.method === 'GET') {
    const url = new URL(req.url);
    const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const page = await readProfilesSince(env, guildId, sinceMs);
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/heroes — DLL pushes the dungeon hero registry
  // (DungeonGameStore) so the /loadout menu can render stream-earned
  // gear without polling the DLL on every Hero / Bag click. Body:
  //   { ts: <ms>, heroes: { "twitch:bish":  {level,xp,bag,equipped,...}, ... } }
  // Stored under d:hero-by-handle:<guild>:<platform>:<handle> so the
  // /loadout menu can resolve a Discord user → wallet → first link →
  // hero in two KV reads. The Worker's own per-Discord-user hero
  // (d:hero:<guild>:<userId>) stays as fallback for users who haven't
  // linked yet — it's the off-stream-only progression path.
  if (sub === 'heroes' && req.method === 'POST') {
    let payload; try { payload = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const heroes = payload?.heroes || {};
    let count = 0;
    for (const key of Object.keys(heroes)) {
      // key is "platform:handle" lowercase. Mirror that into the KV key.
      const safeKey = key.replace(/[^a-z0-9_:.-]/gi, '');
      if (!safeKey.includes(':')) continue;
      await env.LOADOUT_BOLTS.put('d:hero-by-handle:' + guildId + ':' + safeKey,
                                  JSON.stringify(heroes[key]));
      count++;
    }
    return new Response(JSON.stringify({ ok: true, applied: count }),
                        { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // /sync/:guildId/digest — DLL posts a weekly stats snapshot here once
  // a week. We format it as a rich Discord embed and POST to the
  // configured channel via the bot token. The DLL only retries on
  // failure, so a Discord 5xx self-heals next minute.
  if (sub === 'digest' && req.method === 'POST') {
    let payload; try { payload = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const channelId = String(payload?.channelId || '').trim();
    if (!channelId) return new Response('channelId required', { status: 400 });
    const token = env.DISCORD_BOT_TOKEN;
    if (!token) return new Response('bot token not set', { status: 500 });
    const embed = buildDigestEmbed(payload);
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bot ' + token,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ embeds: [embed] })
      });
      if (!resp.ok) {
        const txt = await resp.text();
        return new Response(JSON.stringify({ ok: false, status: resp.status, body: txt.slice(0, 400) }),
                            { status: 502, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }),
                          { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
                          { status: 500, headers: { 'content-type': 'application/json' } });
    }
  }

  // /sync/:guildId/reset-wallets — streamer-initiated wipe of every
  // wallet balance + lifetime counter for the guild. Links and the
  // streamer's bot config are preserved so viewers don't need to
  // re-link after a reset. HMAC-gated by the same scheme as push/pull.
  if (sub === 'reset-wallets' && req.method === 'POST') {
    const cleared = await resetAllWallets(env, guildId);
    return new Response(JSON.stringify({ ok: true, cleared }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (req.method === 'GET') {
    const snap = await readSnapshot(env, guildId);
    return new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (req.method === 'POST') {
    let snap; try { snap = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const n = await applySnapshot(env, guildId, snap);
    return new Response(JSON.stringify({ ok: true, applied: n }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('method not allowed', { status: 405 });
}

async function handleSyncInit(req, env, guildId) {
  // After a successful claim the guild's secret is already in KV from the
  // /interactions handler. Init now is just a no-op confirmation OR
  // unlink (if body says so). Loadout calls this to confirm the binding
  // is intact, or to clear it.
  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  if (body.action === 'unlink') {
    if (body.existingSecret !== (await getSecret(env, guildId))?.secret)
      return new Response('existingSecret required', { status: 401 });
    await env.LOADOUT_BOLTS.delete('secret:' + guildId);
    await env.LOADOUT_BOLTS.delete('guildowner:' + guildId);
    return json({ ok: true, unlinked: true });
  }
  // Default: confirm.
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return new Response('not registered', { status: 404 });
  return json({ ok: true, registeredUtc: stored.registeredUtc });
}

// ---- /admin/register-commands/:guildId (HMAC) ---------------------------
// POST body: optional. Empty body is fine — the commands list is baked
// into the deployed Worker. Returns Discord's response so the caller can
// confirm the new command count.

// Verify the request via either the per-guild HMAC secret (DLL install
// path, header `x-loadout-{ts,sig}`) OR the shared site-admin
// HMAC secret (`x-aquilo-web-{ts,sig}`, AQUILO_SITE_WEB_SECRET). The
// guildId in the URL determines which per-guild secret to try; if
// that guild isn't registered, the site-admin secret is the fallback.
async function verifyAdminAuth(req, env, guildId, body) {
  // Try per-guild first (DLL-installed bots).
  const lts = req.headers.get('x-loadout-ts');
  const lsig = req.headers.get('x-loadout-sig');
  if (lts && lsig) {
    const stored = await getSecret(env, guildId);
    if (stored?.secret) {
      const ok = await verifyHmac(stored.secret, lts, body, lsig);
      if (ok) return { ok: true, via: 'guild' };
    }
  }
  // Fall back to the site-admin HMAC (the same secret /web/* uses).
  const wts = req.headers.get('x-aquilo-web-ts');
  const wsig = req.headers.get('x-aquilo-web-sig');
  if (wts && wsig && env.AQUILO_SITE_WEB_SECRET) {
    const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, wts, body, wsig);
    if (ok) return { ok: true, via: 'site' };
  }
  return { ok: false };
}

async function handleRegisterCommands(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'register-commands', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const url0 = new URL(req.url);
  const scope = (url0.searchParams.get('scope') || 'global').toLowerCase(); // 'global' | 'guild'

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature or guild not registered', { status: 401 });

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token)
    return new Response('worker not provisioned (DISCORD_APP_ID + DISCORD_BOT_TOKEN required)', { status: 503 });

  // PUT replaces the entire command set with the body. For scope=guild
  // the registration is instant; global propagates over ~1 hour.
  const url = scope === 'guild'
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS)
  });
  const text = await r.text();
  if (!r.ok)
    return new Response(JSON.stringify({ ok: false, scope, status: r.status, body: text.slice(0, 800) }),
                        { status: 502, headers: { 'content-type': 'application/json' } });

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const names = Array.isArray(parsed) ? parsed.map(c => c.name) : null;
  return new Response(JSON.stringify({
    ok: true,
    scope,
    guildId: scope === 'guild' ? guildId : null,
    registered: Array.isArray(parsed) ? parsed.length : COMMANDS.length,
    via: auth.via,
    commands: names,
    status: r.status,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ── /admin/onboarding/post-embed/:guildId (HMAC) ─────────────────────
//
// Posts the persistent welcome embed into a guild text channel from
// the admin tooling — useful when Clay isn't running the
// /onboard post-embed slash in-server.
//
// Body (JSON, optional fields):
//   { channelId?: '<snowflake>', channelName?: 'string' }
//
// Resolution order:
//   1. channelId — used verbatim, no REST lookup
//   2. channelName — first GUILD_TEXT channel whose name contains
//                     the lowercased search string (substring match)
//   3. neither    — first GUILD_TEXT channel matching any of
//                     'start-here', 'welcome', 'introductions', '👋',
//                     tried in that order
//
// Idempotent — any prior welcome message tracked at
// `onboard:welcome-msg:<g>` is deleted before posting. Re-running
// just relocates the embed.
//
// Returns:
//   { ok: true, channelId, channelName, messageId, deletedPrior }
//   { ok: false, error: '<reason>', ... }
async function handleOnboardingPostEmbed(req, env, path) {
  const parts = path.split('/').filter(Boolean);    // ['admin', 'onboarding', 'post-embed', ':guildId']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { postWelcomeEmbedForGuild } = await import('./onboarding.js');
  const r = await postWelcomeEmbedForGuild(env, guildId, {
    channelId:   typeof opts.channelId   === 'string' ? opts.channelId.trim()   : undefined,
    channelName: typeof opts.channelName === 'string' ? opts.channelName.trim() : undefined,
  });
  if (!r.ok) {
    const status = r.error === 'no-channel-match' ? 404
      : r.error === 'channels-fetch-failed' || r.error === 'post-failed' ? 502
      : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/onboarding/setup-roles/:guildId (HMAC) ─────────────────
//
// Heuristically match the guild's existing roles to the six
// onboarding interest keys (see INTERESTS in onboarding.js) and
// persist the mapping at `onboard:role-map:<g>`.
//
// Body: {} (no inputs — the heuristic is fixed in code so re-running
// against the same guild always produces the same mapping for the
// same role names).
//
// Returns:
//   { ok: true, mapped: { key: { id, name } }, unmapped: [...keys],
//     roleCount }
//   { ok: false, error: '<reason>', ... }
async function handleOnboardingSetupRoles(req, env, path) {
  const parts = path.split('/').filter(Boolean);    // ['admin', 'onboarding', 'setup-roles', ':guildId']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  const { matchAndSetupGuildRoles } = await import('./onboarding.js');
  const r = await matchAndSetupGuildRoles(env, guildId);
  if (!r.ok) {
    const status = r.error === 'roles-fetch-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/onboarding/ensure-roles/:guildId (HMAC) ────────────────
//
// Create the baseline opt-in interest roles if (and only if) the
// guild doesn't already have a role satisfying the same heuristic
// for each interest key. Idempotent — re-running on a guild that
// already has matching roles returns every key under `skipped`
// with reason `already-exists`. See onboarding.js
// ensureBaselineRoles for the per-key shape.
//
// Body (JSON, optional):
//   { roles?: [{ key, name, color?, mentionable?, hoist?,
//                permissions? }] }
// Omit `roles` to use BASELINE_ROLE_SPECS (the five standard
// opt-in pings: clash, boltbound, boardgames, watching, art).
//
// Caller typically chains this with /admin/onboarding/setup-roles
// to refresh the KV mapping after creates.
//
// Returns:
//   { ok: true, created: [{ key, id, name, color }],
//     skipped: [{ key, reason, existing?, status? }], roleCount }
// ── /admin/twitch-setup/:guildId (HMAC) ─────────────────────────
//
// Create (or refresh) the Twitch EventSub subscriptions for Clay's
// broadcaster id, pointing at this worker's /twitch/eventsub URL.
// Idempotent — re-running on an already-configured guild returns
// the existing subs in the `existing` array.
//
// Body (JSON, optional):
//   { broadcasterId?, callbackUrl? }
// Both default sensibly: broadcasterId defaults to env.CLAY_TWITCH_CHANNEL_ID,
// callbackUrl defaults to env.PUBLIC_WORKER_URL + '/twitch/eventsub'
// (with the workers.dev URL as the ultimate fallback).
//
// Returns:
//   { ok: true, broadcasterId, callbackUrl,
//     created: [{ type, id, status }],
//     existing: [{ type, id, status }],
//     failed: [{ type, reason }] }
async function handleTwitchSetup(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'twitch-setup', ':guildId']
  const guildId = parts[2];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { setupTwitchSubscriptions } = await import('./twitch-eventsub.js');
  const r = await setupTwitchSubscriptions(env, opts);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  return jsonResp({ ...r, via: auth.via }, 200);
}

async function handleOnboardingEnsureRoles(req, env, path) {
  const parts = path.split('/').filter(Boolean);    // ['admin', 'onboarding', 'ensure-roles', ':guildId']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { ensureBaselineRoles } = await import('./onboarding.js');
  const r = await ensureBaselineRoles(env, guildId, opts.roles);
  if (!r.ok) {
    const status = r.error === 'roles-fetch-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/level-tier-roles/ensure/:guildId (HMAC) ────────────────
//
// Create the four level-tier roles (Apprentice/Veteran/Elite/Mythic)
// + persist the {key:roleId} map at `level-tier-roles:<g>`.
// Idempotent — reuses existing roles when name OR mapped-id matches.
async function handleLevelTierRolesEnsure(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','level-tier-roles','ensure',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  const { ensureLevelTierRoles } = await import('./level-tier-roles.js');
  const r = await ensureLevelTierRoles(env, guildId);
  if (!r.ok) {
    const status = r.error === 'roles-fetch-failed' ? 502 : 400;
    return jsonResp({ ...r, via: auth.via }, status);
  }
  return jsonResp({ ...r, via: auth.via }, 200);
}

// ── /admin/level-tier-roles/backfill/:guildId (HMAC) ──────────────
//
// One-time-per-guild grant pass: for every pxp:<userId> record,
// grant the tier roles the user has already earned. Idempotent
// (KV marker — pass `{ force: true }` body to re-scan).
async function handleLevelTierRolesBackfill(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','level-tier-roles','backfill',':g']
  const guildId = parts[3];
  if (!guildId) return jsonResp({ ok: false, error: 'guildId required' }, 400);
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

  let opts = {};
  if (body) {
    try { opts = JSON.parse(body) || {}; }
    catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  }
  const { backfillLevelTierRoles } = await import('./level-tier-roles.js');
  const r = await backfillLevelTierRoles(env, guildId, opts);
  if (!r.ok) return jsonResp({ ...r, via: auth.via }, 400);
  return jsonResp({ ...r, via: auth.via }, 200);
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// GET the currently-registered commands (global by default,
// ?scope=guild for the per-guild set). Same auth as register.
async function handleListCommands(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'list-commands', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const url0 = new URL(req.url);
  const scope = (url0.searchParams.get('scope') || 'global').toLowerCase();

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature or guild not registered', { status: 401 });

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token)
    return new Response('worker not provisioned (DISCORD_APP_ID + DISCORD_BOT_TOKEN required)', { status: 503 });

  const url = scope === 'guild'
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;
  const r = await fetch(url, { headers: { 'Authorization': 'Bot ' + token } });
  const text = await r.text();
  if (!r.ok)
    return new Response(JSON.stringify({ ok: false, scope, status: r.status, body: text.slice(0, 800) }),
                        { status: 502, headers: { 'content-type': 'application/json' } });

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const summary = Array.isArray(parsed)
    ? parsed.map(c => ({ id: c.id, name: c.name, description: c.description, type: c.type, options: (c.options || []).map(o => o.name) }))
    : [];
  return new Response(JSON.stringify({
    ok: true,
    scope,
    guildId: scope === 'guild' ? guildId : null,
    count: summary.length,
    commands: summary,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_bootstrap-l8/:guildId  (one-shot KV token) -----------------
//
// Self-contained deploy step for the L8 feature batch. Token-gated via
// `bootstrap-l8-token` in KV (written by the operator immediately
// before calling). On first match, the KV entry is deleted so the
// endpoint is single-use — leaving the route in place is harmless.
//
// Actions, in order:
//   1. Re-register slash commands GLOBALLY (idempotent — picks up
//      /ticket and any other newly-added entries in commands-spec.js).
//   2. Look up the live channel list for :guildId, find:
//        • 🛠️│support  (or any channel name containing "support")
//        • 👋│introductions (welcome target)
//   3. Post the ticket panel to the support channel.
//   4. Backfill guild:cfg.ids with ch_introductions so the welcome
//      handler resolves the channel without needing welcome-cfg.
//
// Returns a JSON summary of what was done + any non-fatal warnings.
async function handleBootstrapL8(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_bootstrap-l8',':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('bootstrap already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });

  // Single-use — burn the token before doing any side-effects so a
  // partial failure can't be retried with the same token.
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token) {
    return new Response('worker not provisioned (DISCORD_APP_ID + DISCORD_BOT_TOKEN required)', { status: 503 });
  }
  const H = { Authorization: 'Bot ' + token };
  const report = { guildId, steps: {} };

  // 1) Re-register slash commands ON THE GUILD ONLY. We used to push
  // them both globally + per-guild, which made every command appear
  // TWICE in the Discord picker (one copy per scope). Guild-only
  // registration is instant + clean; once the bot is shipped to
  // additional guilds we'll fan-out per-guild from a known list
  // (cheap — 31 commands, one PUT each, ~200ms total).
  //
  // ALSO: PUT [] globally to clear any previously-registered global
  // copies left behind by the old dual-registration path. Idempotent
  // — re-running this is fine.
  {
    const globalUrl = `https://discord.com/api/v10/applications/${appId}/commands`;
    const clearGlobal = await fetch(globalUrl, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    const ctext = await clearGlobal.text();
    let cparsed = null; try { cparsed = JSON.parse(ctext); } catch {}
    report.steps.register_global_cleared = {
      ok: clearGlobal.ok, status: clearGlobal.status,
      cleared_count_now: Array.isArray(cparsed) ? cparsed.length : null,
      error: clearGlobal.ok ? null : ctext.slice(0, 200),
    };
  }
  {
    const guildUrl = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
    const r = await fetch(guildUrl, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    report.steps.register_guild = {
      ok: r.ok, status: r.status,
      count: Array.isArray(parsed) ? parsed.length : null,
      names: Array.isArray(parsed) ? parsed.map(c => c.name) : null,
      error: r.ok ? null : text.slice(0, 200),
    };
  }

  // 2) Channel lookup by name (case-insensitive, emoji-tolerant).
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: H });
  if (!chRes.ok) {
    report.steps.channels = { ok: false, status: chRes.status, error: (await chRes.text()).slice(0, 200) };
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const channels = await chRes.json();
  function findChannelByContains(needle) {
    const n = needle.toLowerCase();
    return channels.find(c => (c.name || '').toLowerCase().includes(n));
  }
  const supportCh = findChannelByContains('support');
  const introsCh  = findChannelByContains('introductions') || findChannelByContains('welcome');
  report.steps.channels = {
    support:        supportCh ? { id: supportCh.id, name: supportCh.name, type: supportCh.type } : null,
    introductions:  introsCh  ? { id: introsCh.id,  name: introsCh.name,  type: introsCh.type  } : null,
  };

  // 3) Post ticket panel into support channel — only if it's a TEXT
  // channel (type 0). The current 🛠️│support is a FORUM (type 15)
  // from the original guild build; per Clay's spec it's being
  // repurposed as the ticket-panel channel, so we POST regardless
  // and let Discord reject if it's a forum.
  if (supportCh) {
    try {
      const { postTicketPanel } = await import('./tickets.js');
      const r = await postTicketPanel(env, guildId, supportCh.id);
      report.steps.ticket_panel = { ok: !!r?.ok, result: r };
    } catch (e) {
      report.steps.ticket_panel = { ok: false, error: String(e?.message || e) };
    }
  } else {
    report.steps.ticket_panel = { ok: false, error: 'no-support-channel-found' };
  }

  // 4) Backfill guild:cfg.ids.ch_introductions so the welcome handler
  // resolves a channel without needing a separate welcome-cfg record.
  // vc_join_to_create + cat_voice already exist in cfg.ids — confirm
  // they're present and surface a warning if not.
  const cfgKey = `guild:cfg:${guildId}`;
  const cfg = (await env.LOADOUT_BOLTS.get(cfgKey, { type: 'json' })) || { ids: {} };
  cfg.ids = cfg.ids || {};
  const before = {
    ch_introductions:   cfg.ids.ch_introductions || null,
    vc_join_to_create:  cfg.ids.vc_join_to_create || null,
    cat_voice:          cfg.ids.cat_voice || null,
  };
  if (introsCh && !cfg.ids.ch_introductions) {
    cfg.ids.ch_introductions = introsCh.id;
  }
  await env.LOADOUT_BOLTS.put(cfgKey, JSON.stringify(cfg));
  report.steps.guild_cfg = {
    ok: true,
    before, after: {
      ch_introductions:   cfg.ids.ch_introductions || null,
      vc_join_to_create:  cfg.ids.vc_join_to_create || null,
      cat_voice:          cfg.ids.cat_voice || null,
    },
    warnings: [
      !cfg.ids.vc_join_to_create ? 'vc_join_to_create missing — temp VCs will skip' : null,
      !cfg.ids.cat_voice         ? 'cat_voice missing — new temp VCs will land at root'  : null,
      !cfg.ids.ch_introductions  ? 'ch_introductions missing — welcome embed has no target' : null,
    ].filter(Boolean),
  };

  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_phase2/:guildId  (one-shot KV token) ───────────────────────
//
// Second-pass setup. Same token-gating as the L8 bootstrap (writes
// `bootstrap-l8-token` to KV, calls endpoint, KV entry self-destructs
// on first valid call). Idempotent operations:
//
//   1. Re-register slash commands (guild-only + clear global) — re-uses
//      the same path L8 fixed for the duplicate-command issue.
//   2. Create channels that don't exist yet:
//        • 📰│activity-feed            (text — community events)
//        • 🃏│games                     (text — game commands hub)
//        • 🗳️│voting                    (text — community-night polls)
//        • 🧩│community-night-queue     (text — queue sign-ups)
//      Each create is idempotent: GET /guilds/{g}/channels first;
//      if a name match exists, adopt it.
//   3. Write the IDs into guild:cfg:<g>.ids:
//        ch_activity_feed, ch_games, ch_voting, ch_cn_queue,
//        ch_schedule (auto-discovered from 📅│schedule), ch_support
//   4. Command bindings → channels:
//        /play, /boltbound, /character, /pet, /clash      → ch_games
//        /checkin                                          → ch_checkin
//        /lfg                                              → ch_games
//        /trivia-add, /rotation-poll                       → ch_voting
//        /queue                                            → ch_cn_queue
//   5. Set the SCHEDULE_CHANNEL_ID / POLL_CHANNEL_ID / QUEUE_CHANNEL_ID
//      env values via guild:env:<g> KV overlay (so the schedule
//      module reads the new bindings without a wrangler redeploy).
//   6. Call postOrRefreshSchedule() to put the embed in #schedule.
//
// Returns a JSON report of everything that did/didn't happen.
async function handlePhase2(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin','_phase2',':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('phase2 already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  const appId = env.DISCORD_APP_ID;
  const token = env.DISCORD_BOT_TOKEN;
  if (!appId || !token) return new Response('worker not provisioned', { status: 503 });
  const H = { Authorization: 'Bot ' + token };
  const report = { guildId, steps: {} };

  // 1) Re-register commands guild-only + clear globals.
  {
    const globalUrl = `https://discord.com/api/v10/applications/${appId}/commands`;
    const clear = await fetch(globalUrl, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    report.steps.register_global_cleared = { ok: clear.ok, status: clear.status };
    const guildUrl = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
    const r = await fetch(guildUrl, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    report.steps.register_guild = {
      ok: r.ok, status: r.status,
      count: Array.isArray(parsed) ? parsed.length : null,
    };
  }

  // 2) Channel lookup + idempotent create.
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: H });
  if (!chRes.ok) {
    report.steps.channels = { ok: false, status: chRes.status, error: (await chRes.text()).slice(0, 200) };
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const channels = await chRes.json();
  function findByContains(needle) {
    const n = needle.toLowerCase();
    return channels.find(c => (c.name || '').toLowerCase().includes(n));
  }
  // Reusable parent for new community-style text channels — the
  // "community" category from the existing server build, fetched
  // by name. If absent, channels land at root (still works, just
  // ungrouped). For the queue channel we prefer the games category
  // if it exists.
  const catCommunity = channels.find(c => c.type === 4 && /community/i.test(c.name || ''));
  const catGames     = channels.find(c => c.type === 4 && /games|play/i.test(c.name || ''));

  async function ensureTextChannel(name, parentId) {
    const existing = findByContains(name.replace(/[│|·\s]/g, '').toLowerCase());
    if (existing && existing.type === 0) return { id: existing.id, name: existing.name, adopted: true };
    // Try the exact name match first as a stricter signal.
    const exact = channels.find(c => c.type === 0 && c.name === name);
    if (exact) return { id: exact.id, name: exact.name, adopted: true };
    const create = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 0, parent_id: parentId || undefined }),
    });
    if (!create.ok) {
      const txt = (await create.text()).slice(0, 200);
      return { error: 'create-failed', status: create.status, body: txt };
    }
    const c = await create.json();
    channels.push(c);
    return { id: c.id, name: c.name, created: true };
  }

  const want = [
    { slot: 'ch_activity_feed', name: '📰│activity-feed',         parent: catCommunity?.id },
    { slot: 'ch_games',         name: '🃏│games',                  parent: catGames?.id || catCommunity?.id },
    { slot: 'ch_voting',        name: '🗳️│voting',                 parent: catCommunity?.id },
    { slot: 'ch_cn_queue',      name: '🧩│community-night-queue',  parent: catGames?.id || catCommunity?.id },
  ];
  report.steps.channels = {};
  for (const w of want) {
    report.steps.channels[w.slot] = await ensureTextChannel(w.name, w.parent);
  }
  // Auto-discover the existing schedule channel + support channel for
  // completeness (these were created in the original guild build).
  const schedCh = findByContains('schedule');
  const supportCh = findByContains('support');
  if (schedCh) report.steps.channels.ch_schedule = { id: schedCh.id, name: schedCh.name, adopted: true };
  if (supportCh) report.steps.channels.ch_support = { id: supportCh.id, name: supportCh.name, adopted: true };

  // 3) Write IDs into guild:cfg.
  const cfgKey = `guild:cfg:${guildId}`;
  const cfg = (await env.LOADOUT_BOLTS.get(cfgKey, { type: 'json' })) || { ids: {} };
  cfg.ids = cfg.ids || {};
  for (const [slot, info] of Object.entries(report.steps.channels)) {
    if (info?.id && !cfg.ids[slot]) cfg.ids[slot] = info.id;
  }
  await env.LOADOUT_BOLTS.put(cfgKey, JSON.stringify(cfg));
  report.steps.cfg_written = { ids: cfg.ids };

  // 4) Command → channel bindings.
  const { saveBindings } = await import('./command-bindings.js');
  const games = cfg.ids.ch_games;
  const checkin = cfg.ids.ch_checkin;
  const voting = cfg.ids.ch_voting;
  const queue  = cfg.ids.ch_cn_queue;
  const bindings = {};
  if (games)   { bindings.play = [games]; bindings.boltbound = [games]; bindings.character = [games]; bindings.pet = [games]; bindings.clash = [games]; bindings.lfg = [games]; }
  if (checkin) { bindings.checkin = [checkin]; }
  if (voting)  { bindings['rotation-poll'] = [voting]; bindings['trivia-add'] = [voting]; }
  if (queue)   { bindings.queue = [queue]; bindings.schedule = [voting || games].filter(Boolean); }
  await saveBindings(env, guildId, bindings);
  report.steps.command_bindings = bindings;

  // 5) Per-guild env-overlay for SCHEDULE / POLL / QUEUE channel ids
  // (aq-schedule.js reads from env, with KV `schedule:<g>.channel_id`
  // taking precedence — we set it directly).
  if (cfg.ids.ch_schedule) {
    const schedKey = `schedule:${guildId}`;
    const sched = (await env.STATE?.get?.(schedKey).then(v => v && JSON.parse(v)).catch(() => null)) || {};
    sched.channel_id = cfg.ids.ch_schedule;
    sched.poll_channel_id = cfg.ids.ch_voting || sched.poll_channel_id;
    try { await env.STATE.put(schedKey, JSON.stringify(sched)); } catch { /* idle */ }
    report.steps.schedule_bound = { channel_id: sched.channel_id, poll_channel_id: sched.poll_channel_id };
  }

  // 6) Post / refresh the schedule embed.
  try {
    const { postOrRefreshSchedule } = await import('./aquilo/aq-schedule.js');
    const messageId = await postOrRefreshSchedule(env, guildId);
    report.steps.schedule_posted = { ok: true, messageId };
  } catch (e) {
    report.steps.schedule_posted = { ok: false, error: String(e?.message || e) };
  }

  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_phase3-rules/:guildId ----------------------------------
//
// 1. Create 📣│self-promo under the existing community category if
//    no `*self-promo*` text channel already exists.
// 2. Find the existing verify-button message in 🫡│rules (looking for
//    the bot's own message with a button) and DELETE it — so the
//    new rules embed lands ABOVE it after a re-post.
// 3. POST the stylized rules embed (banner image + 10-rule body) to
//    🫡│rules.
// 4. RE-POST the verify button so it appears below the rules embed.
// 5. Persist self-promo + rules-message ids in guild:cfg.ids.
async function handlePhase3Rules(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('phase3-rules already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('worker not provisioned', { status: 503 });
  const H = { Authorization: 'Bot ' + token };
  const report = { guildId, steps: {} };

  // 1) Channel list + find rules / category.
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: H });
  if (!chRes.ok) {
    return new Response(JSON.stringify({ error: 'channel-list-failed', status: chRes.status }), { status: 500 });
  }
  const channels = await chRes.json();
  const rulesCh    = channels.find(c => c.type === 0 && /rules/i.test(c.name || ''));
  const catCommunity = channels.find(c => c.type === 4 && /community/i.test(c.name || ''));
  let selfPromoCh = channels.find(c => c.type === 0 && /self.?promo/i.test(c.name || ''));

  if (!selfPromoCh) {
    const create = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '📣│self-promo',
        type: 0,
        parent_id: catCommunity?.id,
        topic: 'Share your streams, videos, projects — your own content only. No bare invite links or ads.',
      }),
    });
    if (!create.ok) {
      report.steps.self_promo = { ok: false, status: create.status, error: (await create.text()).slice(0, 200) };
      return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    selfPromoCh = await create.json();
    report.steps.self_promo = { id: selfPromoCh.id, name: selfPromoCh.name, created: true };
  } else {
    report.steps.self_promo = { id: selfPromoCh.id, name: selfPromoCh.name, adopted: true };
  }

  if (!rulesCh) {
    report.steps.rules = { ok: false, error: 'no-rules-channel' };
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // 2) Find + delete the existing verify-button message (bot-authored
  //    message with a component button — newest 50 messages should
  //    cover this comfortably).
  const appId = env.DISCORD_APP_ID;
  const msgsRes = await fetch(`https://discord.com/api/v10/channels/${rulesCh.id}/messages?limit=50`, { headers: H });
  let oldVerify = null;
  if (msgsRes.ok) {
    const msgs = await msgsRes.json();
    oldVerify = msgs.find(m =>
      m.author?.id === appId &&
      Array.isArray(m.components) && m.components.length > 0
    );
  }
  if (oldVerify) {
    const del = await fetch(`https://discord.com/api/v10/channels/${rulesCh.id}/messages/${oldVerify.id}`, {
      method: 'DELETE', headers: H,
    });
    report.steps.deleted_old_verify = { id: oldVerify.id, ok: del.ok, status: del.status };
  } else {
    report.steps.deleted_old_verify = { skipped: 'no-existing-verify-button' };
  }

  // 3) Post the rules embed.
  const BRAND_ACCENT = 0xF47FFF;
  const RULES_HEADER_URL = 'https://aquilo.gg/sprites/welcome/aquilo-rules-header.png';
  const rulesEmbed = {
    title: 'Aquilo Community Rules',
    description: [
      `**1 — Be respectful.** Treat everyone with kindness. No harassment, hate speech, slurs, discrimination, or personal attacks. Disagree without being hostile.`,
      `**2 — Keep it appropriate.** No NSFW, gory, or shocking content anywhere. Keep language and content friendly for a mixed-age community.`,
      `**3 — No spam.** Don't flood channels, spam emojis or mentions, mass-ping, or post the same thing repeatedly.`,
      `**4 — Use the right channels.** Keep conversations on-topic. Support questions go through the ticket system.`,
      `**5 — No unsolicited self-promo or advertising.** Don't post invite links or ads, and don't DM members ads. Share your own content in <#${selfPromoCh.id}> where it belongs.`,
      `**6 — Respect privacy.** No sharing anyone's personal information, no posting private messages or screenshots without consent.`,
      `**7 — Settle conflicts properly.** No drama, call-outs, or witch-hunts in public. Open a ticket instead.`,
      `**8 — Play fair.** Don't cheat, exploit, or abuse bugs in the games or the bolts economy. Report bugs — don't farm them.`,
      `**9 — Follow Discord's rules.** Everyone must follow Discord's Terms of Service and Community Guidelines.`,
      `**10 — Staff have the final say.** Listen to the moderators. Rules can be updated, and staff may act on anything that harms the community.`,
      ``,
      `_Welcome to Aquilo — have fun and look out for each other._`,
    ].join('\n\n'),
    color: BRAND_ACCENT,
    image: { url: RULES_HEADER_URL },
    footer: { text: 'aquilo.gg · community rules' },
  };
  const rulesPost = await fetch(`https://discord.com/api/v10/channels/${rulesCh.id}/messages`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [rulesEmbed], allowed_mentions: { parse: [] } }),
  });
  if (!rulesPost.ok) {
    report.steps.rules_posted = { ok: false, status: rulesPost.status, error: (await rulesPost.text()).slice(0, 200) };
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const rulesMsg = await rulesPost.json();
  report.steps.rules_posted = { id: rulesMsg.id, channelId: rulesCh.id, ok: true };

  // 4) Re-post the verify button below the rules embed (if we just
  //    deleted one). Reuses the same custom_id the original button
  //    used so existing onClick handling continues to work.
  if (oldVerify) {
    // Use the original button's custom_id + label if present so we don't
    // accidentally rename / re-key it.
    const orig = oldVerify.components?.[0]?.components?.[0] || {};
    const customId = orig.custom_id || 'verify:start';
    const label    = orig.label     || '✅ Verify';
    const verifyContent = oldVerify.content && oldVerify.content.length
      ? oldVerify.content
      : 'Tap **Verify** to gain access to the rest of the server.';
    const repost = await fetch(`https://discord.com/api/v10/channels/${rulesCh.id}/messages`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: verifyContent,
        components: [{
          type: 1, components: [{
            type: 2, style: 3, label, custom_id: customId,
          }],
        }],
        allowed_mentions: { parse: [] },
      }),
    });
    if (repost.ok) {
      const m = await repost.json();
      report.steps.verify_reposted = { id: m.id, ok: true, custom_id: customId };
    } else {
      report.steps.verify_reposted = { ok: false, status: repost.status, error: (await repost.text()).slice(0, 200) };
    }
  }

  // 5) Persist channel + message ids.
  const cfgKey = `guild:cfg:${guildId}`;
  const cfg = (await env.LOADOUT_BOLTS.get(cfgKey, { type: 'json' })) || { ids: {} };
  cfg.ids = cfg.ids || {};
  cfg.ids.ch_self_promo = selfPromoCh.id;
  cfg.ids.msg_rules     = rulesMsg.id;
  await env.LOADOUT_BOLTS.put(cfgKey, JSON.stringify(cfg));
  report.steps.cfg_written = { ch_self_promo: cfg.ids.ch_self_promo, msg_rules: cfg.ids.msg_rules };

  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_chat-test/:guildId ----------------------------------------
// One-shot diagnostic for /web/chat/send. Reads ?channelId= (or
// defaults to the first COMMUNITY_CHAT_CHANNELS_JSON entry) +
// ?discordId= (the user the worker pretends to be) + ?content= and
// runs sendFromPwa() in-process. Returns the FULL diagnostic so any
// failure shows the actual webhook-list / webhook-create / webhook-
// post response detail.
async function handleChatTest(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('chat-test already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  let channelId = u.searchParams.get('channelId') || '';
  if (!channelId) {
    // Default to the first channel in the COMMUNITY_CHAT_CHANNELS_JSON
    // allow-list — that's the canonical relay-eligible channel.
    try {
      const arr = JSON.parse(env.COMMUNITY_CHAT_CHANNELS_JSON || '[]');
      const first = arr[0];
      channelId = typeof first === 'string' ? first : (first?.id || '');
    } catch { /* idle */ }
  }
  const discordId = u.searchParams.get('discordId') || env.AQUILO_VAULT_GUILD_ID || '';
  const content   = u.searchParams.get('content')   || 'chat-relay diagnostic — please ignore';

  const report = {
    inputs: { guildId, channelId, discordId, content },
    allowlist: [],
  };
  try {
    report.allowlist = JSON.parse(env.COMMUNITY_CHAT_CHANNELS_JSON || '[]');
  } catch { /* idle */ }

  if (!channelId) {
    report.error = 'no-channelId-and-no-allowlist-default';
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  try {
    const { sendFromPwa } = await import('./chat-relay.js');
    const r = await sendFromPwa(env, { discordId, guildId, channelId, content });
    report.result = r;
  } catch (e) {
    report.threw = String(e?.message || e);
  }
  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_phase4-perms/:guildId ----------------------------------
//
// Audit + repair the guild's channel permission tree. For each
// category we know about, set the intended overwrite profile; then
// for each channel under that category, sync its overwrites to the
// category's (Discord client "Sync Now" equivalent) and layer in any
// channel-specific extras (announce/rules/feed channels get a
// read-only @everyone overwrite on top).
//
// Profiles:
//   "open"     — no role-based view restriction (default for
//                start-here so the verification gate works).
//   "member"   — deny @everyone VIEW; allow `role_member` VIEW.
//   "patron"   — deny @everyone VIEW; allow `role_patron` VIEW.
//   "staff"    — deny @everyone VIEW; allow `role_owner` + `role_mod`.
//   "voice-member" — like "member" but also CONNECT + SPEAK.
//
// Read-only flag (channel-level extra): @everyone gets an explicit
//   deny on SEND_MESSAGES + CREATE_PUBLIC_THREADS + SEND_MESSAGES_IN_THREADS.
//   Bots / moderators bypass via their admin permission.
//
// Returns a per-channel diff: what the overwrites WERE vs what we
// wrote. Channels whose overwrites already matched the target shape
// are skipped (no API call), so re-running the endpoint is cheap.
async function handlePhase4Perms(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('phase4-perms already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');
  const dryRun = u.searchParams.get('dryRun') === '1';

  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('worker not provisioned', { status: 503 });
  const H = { Authorization: 'Bot ' + token };

  // ── 1. Pull live state ─────────────────────────────────────────────
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: H });
  if (!chRes.ok) return new Response('channel-list-failed', { status: 502 });
  const channels = await chRes.json();
  const cfg = (await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' })) || { ids: {} };
  const ids = cfg.ids || {};

  // Required role ids — bail loudly if any are missing rather than
  // writing partial overwrites.
  const everyoneId = guildId;                  // @everyone role id == guild id
  const memberId   = ids.role_member;
  const patronId   = ids.role_patron;
  const modId      = ids.role_mod;
  const ownerId    = ids.role_owner;
  if (!memberId || !patronId || !modId || !ownerId) {
    return new Response(JSON.stringify({
      error: 'missing-role-ids',
      need: ['role_member','role_patron','role_mod','role_owner'],
      have: { memberId, patronId, modId, ownerId },
    }, null, 2), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  // ── 2. Permission bits (Discord docs) ──────────────────────────────
  const VIEW          = 0x400n;          // VIEW_CHANNEL
  const SEND          = 0x800n;          // SEND_MESSAGES
  const HISTORY       = 0x10000n;        // READ_MESSAGE_HISTORY
  const CONNECT       = 0x100000n;       // CONNECT
  const SPEAK         = 0x200000n;       // SPEAK
  const SEND_THREAD   = 0x4000000000n;   // SEND_MESSAGES_IN_THREADS
  const CREATE_THREAD = 0x800000000n;    // CREATE_PUBLIC_THREADS

  // ── 3. Category-name → profile catalogue ───────────────────────────
  // Matched by substring (case-insensitive) on the category name. The
  // names came out of the original server build (server-spec.js); if
  // anyone renames a category in Discord, this match still works as
  // long as the keyword stays.
  // ORDER MATTERS: first match wins. Staff/admin/mod patterns are
  // listed FIRST so a hypothetical "mod hangout" in the staff
  // category can't fall through to one of the more permissive
  // member-tier profiles.
  const CAT_PROFILES = [
    { match: /staff|admin|moderator|mod[\s-]?only/i, profile: 'staff' },
    { match: /patron/i,        profile: 'patron'      },
    { match: /start/i,         profile: 'open'         },
    { match: /voice/i,         profile: 'voice-member' },
    { match: /community/i,     profile: 'member'       },
    { match: /streams|content/i, profile: 'member'     },
    { match: /products/i,      profile: 'member'       },
    { match: /games|play/i,    profile: 'member'       },
    { match: /minecraft/i,     profile: 'member'       },
  ];

  // Channel-name → extra-flag catalogue. These layer ON TOP of the
  // category profile after the sync.
  const READ_ONLY_PATTERNS = [
    /rules/i, /announcement/i, /announce/i,
    /activity.?feed/i, /live.?now/i, /highlights/i, /mod.?log/i,
  ];

  function categoryProfile(catName) {
    for (const p of CAT_PROFILES) if (p.match.test(catName || '')) return p.profile;
    return 'member';   // safe default
  }
  function isReadOnly(chName) {
    return READ_ONLY_PATTERNS.some(rx => rx.test(chName || ''));
  }

  // ── 4. Build the intended overwrite array per profile ──────────────
  function buildOverwrites(profile) {
    const out = [];
    switch (profile) {
      case 'open':
        // No overwrites — channels default to "anyone with role can see".
        // Pre-verification members hit @everyone permissions only,
        // which include VIEW_CHANNEL by default.
        break;
      case 'member':
        out.push({ id: everyoneId, type: 0, allow: '0', deny:  String(VIEW) });
        out.push({ id: memberId,   type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        out.push({ id: modId,      type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        out.push({ id: ownerId,    type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        break;
      case 'voice-member':
        out.push({ id: everyoneId, type: 0, allow: '0', deny: String(VIEW | CONNECT) });
        out.push({ id: memberId,   type: 0, allow: String(VIEW | CONNECT | SPEAK), deny: '0' });
        out.push({ id: modId,      type: 0, allow: String(VIEW | CONNECT | SPEAK), deny: '0' });
        out.push({ id: ownerId,    type: 0, allow: String(VIEW | CONNECT | SPEAK), deny: '0' });
        break;
      case 'patron':
        out.push({ id: everyoneId, type: 0, allow: '0', deny: String(VIEW) });
        out.push({ id: patronId,   type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        out.push({ id: modId,      type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        out.push({ id: ownerId,    type: 0, allow: String(VIEW | HISTORY), deny: '0' });
        break;
      case 'staff':
        out.push({ id: everyoneId, type: 0, allow: '0', deny: String(VIEW) });
        out.push({ id: modId,      type: 0, allow: String(VIEW | HISTORY | SEND), deny: '0' });
        out.push({ id: ownerId,    type: 0, allow: String(VIEW | HISTORY | SEND), deny: '0' });
        break;
    }
    return out;
  }

  function withReadOnlyExtra(base) {
    // Merge a SEND-deny onto the @everyone row (creating one if the
    // profile didn't have it). Preserves the existing VIEW state.
    const out = base.map(o => ({ ...o }));
    let row = out.find(o => o.id === everyoneId && o.type === 0);
    const denyMask = SEND | SEND_THREAD | CREATE_THREAD;
    if (!row) {
      row = { id: everyoneId, type: 0, allow: '0', deny: String(denyMask) };
      out.unshift(row);
    } else {
      const cur = BigInt(row.deny || '0');
      row.deny = String(cur | denyMask);
    }
    return out;
  }

  // ── 5. Apply ──────────────────────────────────────────────────────
  const report = { guildId, dryRun, categories: [], channels: [] };

  // Normalise existing overwrites for diff comparison (sorted by id,
  // bigint-equality on allow/deny so a "0x400" vs "1024" string diff
  // doesn't count as a change).
  function normaliseOverwrites(arr) {
    return (Array.isArray(arr) ? arr : [])
      .map(o => ({ id: String(o.id), type: Number(o.type),
                   allow: String(BigInt(o.allow || '0')),
                   deny:  String(BigInt(o.deny  || '0')) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  function overwritesEqual(a, b) {
    const na = normaliseOverwrites(a);
    const nb = normaliseOverwrites(b);
    if (na.length !== nb.length) return false;
    for (let i = 0; i < na.length; i++) {
      if (na[i].id !== nb[i].id) return false;
      if (na[i].type !== nb[i].type) return false;
      if (na[i].allow !== nb[i].allow) return false;
      if (na[i].deny  !== nb[i].deny)  return false;
    }
    return true;
  }

  async function patchOverwrites(channelId, overwrites) {
    if (dryRun) return { ok: true, dryRun: true };
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission_overwrites: overwrites }),
    });
    if (!r.ok) return { ok: false, status: r.status, body: (await r.text()).slice(0, 200) };
    return { ok: true };
  }

  // First pass: categories.
  const catById = new Map();
  for (const c of channels) {
    if (c.type !== 4) continue;
    const profile = categoryProfile(c.name);
    const desired = buildOverwrites(profile);
    catById.set(c.id, { profile, desired });
    const before = normaliseOverwrites(c.permission_overwrites);
    const after  = normaliseOverwrites(desired);
    if (overwritesEqual(c.permission_overwrites, desired)) {
      report.categories.push({ id: c.id, name: c.name, profile, action: 'no-change' });
      continue;
    }
    const r = await patchOverwrites(c.id, desired);
    report.categories.push({
      id: c.id, name: c.name, profile,
      action: r.ok ? 'patched' : 'failed',
      detail: r.ok ? undefined : r,
      before, after,
    });
  }

  // Second pass: every non-category, non-thread child channel.
  for (const c of channels) {
    if (c.type === 4) continue;                  // skip categories
    if (c.type === 11 || c.type === 12) continue; // skip threads
    const parent = c.parent_id ? catById.get(c.parent_id) : null;
    let desired;
    let basis;
    if (parent) {
      desired = parent.desired.map(o => ({ ...o }));
      basis   = 'category:' + parent.profile;
    } else {
      // No parent — use the open profile so we don't accidentally
      // hide things at the root level.
      desired = buildOverwrites('open');
      basis   = 'orphan:open';
    }
    if (isReadOnly(c.name)) {
      desired = withReadOnlyExtra(desired);
      basis += '+readOnly';
    }
    if (overwritesEqual(c.permission_overwrites, desired)) {
      report.channels.push({ id: c.id, name: c.name, parent_id: c.parent_id || null, basis, action: 'no-change' });
      continue;
    }
    const before = normaliseOverwrites(c.permission_overwrites);
    const after  = normaliseOverwrites(desired);
    const r = await patchOverwrites(c.id, desired);
    report.channels.push({
      id: c.id, name: c.name, parent_id: c.parent_id || null, basis,
      action: r.ok ? 'patched' : 'failed',
      detail: r.ok ? undefined : r,
      before, after,
    });
  }

  // Summary counters.
  const tally = (arr) => arr.reduce((m, e) => { m[e.action] = (m[e.action] || 0) + 1; return m; }, {});
  report.summary = {
    categories: tally(report.categories),
    channels:   tally(report.channels),
  };
  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/_quest-trace/:guildId/:userId  (one-shot KV token) -------
//
// Diagnostic for the linked-patreon Welcome-Checklist step. Reports
// every signal the worker reads + the snapshot result + an optional
// dry-claim outcome (?claim=1 actually runs claimStep). Used to verify
// the auto-mark-on-web fix before/after the user actually hits the
// site.
async function handleQuestTrace(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[2];
  const userId  = parts[3];
  if (!guildId || !userId) return new Response('guildId + userId required', { status: 400 });
  const u = new URL(req.url);
  const got = u.searchParams.get('token') || '';
  const expected = await env.LOADOUT_BOLTS.get('bootstrap-l8-token');
  if (!expected) return new Response('quest-trace already consumed or never armed', { status: 410 });
  if (!got || got !== expected) return new Response('bad token', { status: 401 });
  await env.LOADOUT_BOLTS.delete('bootstrap-l8-token');

  const claim = u.searchParams.get('claim') === '1';
  const markFlag = u.searchParams.get('mark') === '1';
  const report = { guildId, userId, signals: {}, snapshot: null, claim: null };

  // Read each signal individually.
  report.signals.explicit_flag = !!(await env.LOADOUT_BOLTS.get(`quest:patreon-linked:${guildId}:${userId}`));
  const tier = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
  report.signals.patreon_tier  = tier ? { present: true, hasImageUrl: !!(tier.imageUrl || tier.image_url || tier.avatar) } : { present: false };
  const wallet = await env.LOADOUT_BOLTS.get(`wallet:${guildId}:${userId}`, { type: 'json' });
  const links = Array.isArray(wallet?.links) ? wallet.links : [];
  report.signals.wallet_links = {
    present: !!wallet,
    platforms: links.map(l => l?.platform).filter(Boolean),
    hasPatreon: links.some(l => String(l?.platform || '').toLowerCase() === 'patreon'),
  };

  // Optional: pretend we hit the web bridge by marking the flag first.
  if (markFlag) {
    const { markPatreonLinked } = await import('./quests.js');
    const mark = await markPatreonLinked(env, guildId, userId);
    report.mark_applied = mark;
  }

  // Snapshot the checklist.
  const { getSnapshot, claimStep } = await import('./quests.js');
  const snap = await getSnapshot(env, guildId, userId);
  const stepRow = (snap.steps || []).find(s => s.id === 'linked-patreon');
  report.snapshot = {
    summary: snap.summary,
    linked_patreon: stepRow || null,
  };

  // Optional: actually run the claim.
  if (claim) {
    report.claim = await claimStep(env, guildId, userId, 'linked-patreon');
  }
  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/guild-inventory/:guildId ------------------------------------
//
// Read-only dump of every category, channel, role, and AutoMod rule in
// the target guild — same admin-auth as the register/list endpoints
// (per-guild HMAC OR AQUILO_SITE_WEB_SECRET fallback). Used to recon
// existing server state before applying a guild-build.
async function handleGuildInventory(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'guild-inventory', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature or guild not registered', { status: 401 });

  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });

  const H = { Authorization: 'Bot ' + token };
  async function gj(p) {
    const r = await fetch(`https://discord.com/api/v10${p}`, { headers: H });
    if (!r.ok) return { _error: `${r.status} ${(await r.text()).slice(0, 200)}` };
    return r.json();
  }
  const [guild, channels, roles, automod] = await Promise.all([
    gj(`/guilds/${guildId}?with_counts=true`),
    gj(`/guilds/${guildId}/channels`),
    gj(`/guilds/${guildId}/roles`),
    gj(`/guilds/${guildId}/auto-moderation/rules`),
  ]);

  // Channel TYPES per Discord docs:
  //   0=GUILD_TEXT, 2=GUILD_VOICE, 4=GUILD_CATEGORY, 5=GUILD_ANNOUNCEMENT,
  //   13=GUILD_STAGE_VOICE, 15=GUILD_FORUM, 16=GUILD_MEDIA
  const TYPE_NAME = {
    0: 'text', 2: 'voice', 4: 'category', 5: 'announcement',
    13: 'stage', 15: 'forum', 16: 'media',
  };
  const slim = Array.isArray(channels) ? channels.map(c => ({
    id: c.id, name: c.name, type: c.type, type_name: TYPE_NAME[c.type] || `unknown_${c.type}`,
    parent_id: c.parent_id || null, position: c.position,
  })) : [];
  slim.sort((a, b) => {
    // Group by parent: categories first (parent_id===null), then children grouped under parent.
    const ap = a.parent_id || '';
    const bp = b.parent_id || '';
    if (ap !== bp) return ap.localeCompare(bp);
    return a.position - b.position;
  });
  const rolesSlim = Array.isArray(roles) ? roles.map(r => ({
    id: r.id, name: r.name, position: r.position, color: r.color,
    hoist: r.hoist, mentionable: r.mentionable, managed: r.managed,
    permissions: r.permissions,
  })).sort((a, b) => b.position - a.position) : [];

  return new Response(JSON.stringify({
    ok: true,
    guild: guild && !guild._error ? {
      id: guild.id, name: guild.name,
      member_count: guild.approximate_member_count,
      premium_tier: guild.premium_tier, features: guild.features,
    } : { error: guild?._error },
    channels: slim,
    roles:    rolesSlim,
    automod:  Array.isArray(automod) ? automod : (automod?._error ? [{ _error: automod._error }] : []),
  }, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- /admin/guild-build/:guildId  --------------------------------------
//
// Idempotent reconciler — applies the baked SERVER_SPEC against the
// guild's current state. Default mode is DRY-RUN; pass ?apply=1 to
// execute. Same admin auth as guild-inventory.
//
// Reconciliation strategy:
//   • Categories matched by name (after normalisation). Missing →
//     created. Existing → kept (no destructive delete).
//   • Channels matched by name. Missing → created in correct
//     category. Existing → re-parented to the spec category +
//     ensured to be the right TYPE if a type mismatch is recoverable
//     (we never delete to fix a type mismatch — we leave it + log).
//   • Roles matched by name. Missing → created with color/hoist;
//     existing → kept.
//   • Nothing is deleted. The endpoint returns a `noted_extras`
//     list of channels/roles that exist in the guild but aren't in
//     the spec, so the caller can decide whether to remove them
//     manually.

async function handleGuildBuild(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['admin', 'guild-build', ':guildId']
  const guildId = parts[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const url0 = new URL(req.url);
  const apply = url0.searchParams.get('apply') === '1';

  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature or guild not registered', { status: 401 });

  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });

  const { SERVER_SPEC } = await import('./server-spec.js');
  const { applyServerSpec } = await import('./guild-builder.js');
  const result = await applyServerSpec(token, guildId, SERVER_SPEC, { apply });
  return new Response(JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 207,
    headers: { 'content-type': 'application/json' },
  });
}

async function handleGuildFinalize(req, env, path) {
  const guildId = path.split('/').filter(Boolean)[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature', { status: 401 });
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });
  const { applyPhase2 } = await import('./guild-builder.js');
  const result = await applyPhase2(token, guildId, env.LOADOUT_BOLTS);
  return new Response(JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 207,
    headers: { 'content-type': 'application/json' },
  });
}

async function handleGuildAutomod(req, env, path) {
  const guildId = path.split('/').filter(Boolean)[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const body = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, body);
  if (!auth.ok) return new Response('bad signature', { status: 401 });
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });

  // Discord AutoMod TRIGGER TYPES:
  //   1=KEYWORD, 3=SPAM, 4=KEYWORD_PRESET, 5=MENTION_SPAM, 6=MEMBER_PROFILE
  // ACTION TYPES: 1=BLOCK_MESSAGE, 2=SEND_ALERT_MESSAGE, 3=TIMEOUT
  //
  // Three baseline rules. KEYWORD_PRESET 1=PROFANITY 2=SEXUAL_CONTENT 3=SLURS.
  const cfg = await env.LOADOUT_BOLTS.get(`guild:cfg:${guildId}`, { type: 'json' });
  const modLogId = cfg?.ids?.ch_mod_log;
  const baseAction = modLogId
    ? [{ type: 1 }, { type: 2, metadata: { channel_id: modLogId } }]
    : [{ type: 1 }];

  const rules = [
    {
      // Discord caps KEYWORD_PRESET rules at ONE per guild — so all
      // three baked-in word lists go into the single rule.
      // PRESET ids: 1=PROFANITY, 2=SEXUAL_CONTENT, 3=SLURS.
      name: 'Profanity + sexual + slurs (Discord presets)',
      event_type: 1, // MESSAGE_SEND
      trigger_type: 4,
      trigger_metadata: { presets: [1, 2, 3] },
      actions: baseAction,
      enabled: true,
    },
    {
      name: 'Spam keywords (custom)',
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: {
        keyword_filter: [
          'discord-nitro', 'free-nitro', 'free nitro', 'steam-gift-card',
          '@everyone @here', '*free* *nitro*',
        ],
      },
      actions: baseAction,
      enabled: true,
    },
    {
      name: 'Mention spam (>5 unique pings)',
      event_type: 1,
      trigger_type: 5,
      trigger_metadata: { mention_total_limit: 5 },
      actions: baseAction,
      enabled: true,
    },
    {
      name: 'Suspicious links',
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: {
        keyword_filter: [
          'https://discord-nitro*', 'https://discord-gift*', 'https://steamcommunity*free*',
          'https://*.zip/*', 'https://*.ru/*free*',
        ],
      },
      actions: baseAction,
      enabled: true,
    },
  ];

  // Idempotent upsert: fetch existing rules, delete any whose name
  // matches one we're about to create (so a re-run produces the same
  // end-state instead of "max rules exceeded"). Also clean up the
  // legacy "Slurs (Discord preset)" name that the first build created.
  //
  // PLUS: trigger types 4 (KEYWORD_PRESET) and 5 (MENTION_SPAM) are
  // capped at 1 rule per type per guild. Whatever existing rule
  // occupies those slots gets removed too — our managed rule has to
  // be the single occupant for the create to succeed. (Name-match
  // alone misses these when Discord normalises the stored name
  // slightly differently than what we POSTed.)
  const existingRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules`, {
    headers: { Authorization: 'Bot ' + token },
  });
  const existing = existingRes.ok ? await existingRes.json() : [];
  const targetNames = new Set([...rules.map(r => r.name), 'Slurs (Discord preset)', 'Sexual content (Discord preset)']);
  const cappedTypes = new Set(rules.map(r => r.trigger_type).filter(t => t === 4 || t === 5));
  const deleted = [];
  const deleteFailures = [];
  for (const r of existing) {
    const byName = targetNames.has(r.name);
    const byCapType = cappedTypes.has(r.trigger_type);
    if (!byName && !byCapType) continue;
    const d = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules/${r.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bot ' + token },
    });
    if (d.ok) {
      deleted.push({ name: r.name, id: r.id, reason: byName ? 'name-match' : 'capped-type-slot' });
    } else {
      const t = await d.text();
      deleteFailures.push({ name: r.name, id: r.id, status: d.status, body: t.slice(0, 200) });
    }
    await new Promise(rr => setTimeout(rr, 250));
  }

  const created = [];
  const patched = [];
  const errors = [];
  for (const rule of rules) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules`, {
      method: 'POST',
      headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    });
    const text = await r.text();
    if (r.ok) {
      try { created.push({ rule: rule.name, id: JSON.parse(text).id }); } catch { created.push({ rule: rule.name }); }
      await new Promise(rr => setTimeout(rr, 250));
      continue;
    }
    // Fallback: if the create failed because the per-type cap is full
    // (e.g. Discord pre-installs an undeletable Mention Spam rule on
    // Community servers), find the existing rule of that trigger_type
    // and PATCH it to our desired settings instead.
    let isCapHit = false;
    try {
      const errBody = JSON.parse(text);
      if (errBody?.errors?._errors?.some(e => e.code === 'AUTO_MODERATION_MAX_RULES_OF_TYPE_EXCEEDED')) {
        isCapHit = true;
      }
    } catch { /* fall through */ }
    if (isCapHit) {
      const occupant = existing.find(e => e.trigger_type === rule.trigger_type);
      if (occupant) {
        const p = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules/${occupant.id}`, {
          method: 'PATCH',
          headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: rule.name,
            event_type: rule.event_type,
            trigger_metadata: rule.trigger_metadata,
            actions: rule.actions,
            enabled: rule.enabled,
          }),
        });
        if (p.ok) {
          patched.push({ rule: rule.name, id: occupant.id, reason: 'cap-hit-patched-existing' });
        } else {
          const pt = await p.text();
          errors.push({ rule: rule.name, status: p.status, body: pt.slice(0, 300) });
        }
        await new Promise(rr => setTimeout(rr, 250));
        continue;
      }
    }
    errors.push({ rule: rule.name, status: r.status, body: text.slice(0, 300) });
    await new Promise(rr => setTimeout(rr, 250));
  }

  return new Response(JSON.stringify({ ok: errors.length === 0, deleted, deleteFailures, created, patched, errors }, null, 2), {
    status: errors.length === 0 ? 200 : 207,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- /admin/ticket-panel/:guildId  (HMAC) --------------------------------
// Body: { channelId: "<id>" } — posts the ticket-panel button in that
// channel and remembers it as the panel target for future reposts /
// stale-message replacement.
async function handleTicketPanelPost(req, env, path) {
  const guildId = path.split('/').filter(Boolean)[2];
  if (!guildId) return new Response('guildId required', { status: 400 });
  const bodyText = await req.text();
  const auth = await verifyAdminAuth(req, env, guildId, bodyText);
  if (!auth.ok) return new Response('bad signature', { status: 401 });
  if (!env.DISCORD_BOT_TOKEN) return new Response('DISCORD_BOT_TOKEN missing', { status: 503 });
  let body;
  try { body = JSON.parse(bodyText || '{}'); } catch { body = {}; }
  const channelId = String(body.channelId || '').trim();
  if (!/^\d{5,25}$/.test(channelId)) return new Response('bad channelId', { status: 400 });
  const { postTicketPanel } = await import('./tickets.js');
  const result = await postTicketPanel(env, guildId, channelId);
  return new Response(JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 502,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- helpers ------------------------------------------------------------

function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function randomCode(len) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I/L/O/0/1 to avoid OCR confusion
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
function randomSecret() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

// Build the weekly-digest Discord embed from the DLL's stats snapshot.
// Discord embed reference: https://discord.com/developers/docs/resources/channel#embed-object
function buildDigestEmbed(p) {
  const emoji = p.boltsEmoji || '⚡';
  const name  = p.boltsName  || 'Bolts';
  const fmtNum = (n) => {
    const x = Number(n) || 0;
    return x.toLocaleString('en-US');
  };
  const fmtUsd = (n) => '$' + (Number(n) || 0).toFixed(2);
  const safeStreamer = (p.streamerName || '').trim() || 'this stream';
  const accentInt = parseInt((p.accent || '#3A86FF').replace('#', ''), 16) || 0x3A86FF;

  // Top earners: fenced-code list so handles align cleanly even with
  // wide names. Markdown won't help much in Discord embeds — the
  // monospace block is the most legible option.
  const top = Array.isArray(p.topEarners) ? p.topEarners : [];
  let topField;
  if (top.length === 0) {
    topField = '_no activity this week_';
  } else {
    const maxName = top.reduce((m, e) => Math.max(m, (e.user || '').length), 0);
    const lines = top.map((e, i) => {
      const medal = ['🥇', '🥈', '🥉', '4.', '5.'][i] || ((i + 1) + '.');
      const handle = (e.user || '?').padEnd(Math.min(maxName, 16), ' ');
      return `${medal}  \`${handle}\`  ${fmtNum(e.bolts)} ${emoji}`;
    });
    topField = lines.join('\n');
  }

  // Highlights field — auto-pruned to skip rows that didn't happen.
  const highlights = [];
  if (p.hypeTrains > 0) highlights.push(`🚂  **${p.hypeTrains}** hype train${p.hypeTrains === 1 ? '' : 's'} (peak Lv ${p.hypeTrainMaxLevel || 0})`);
  if (p.heistsSucceeded > 0) {
    const crew = p.biggestHeistCrew > 0 ? ` — biggest pulled with ${p.biggestHeistCrew} crewmates for ${fmtNum(p.biggestHeistPot)} ${emoji}` : '';
    highlights.push(`🦹  **${p.heistsSucceeded}** heist${p.heistsSucceeded === 1 ? '' : 's'} pulled${crew}`);
  }
  if (p.minigamesPlayed > 0) highlights.push(`🎰  **${fmtNum(p.minigamesPlayed)}** minigames played`);
  if (p.tipsCount > 0) {
    const big = p.biggestTipUsd > 0 ? ` — biggest from **${p.biggestTipper || 'anonymous'}** at ${fmtUsd(p.biggestTipUsd)}` : '';
    highlights.push(`💖  **${p.tipsCount}** tip${p.tipsCount === 1 ? '' : 's'} totalling ${fmtUsd(p.tipsTotalUsd)}${big}`);
  }
  if (p.welcomesShown > 0) highlights.push(`👋  **${fmtNum(p.welcomesShown)}** welcome${p.welcomesShown === 1 ? '' : 's'} delivered`);
  const highlightsField = highlights.length > 0 ? highlights.join('\n') : '_quiet week — try a hype train next stream._';

  return {
    title:       `📊 Weekly digest — ${safeStreamer}`,
    description: `Here's what went down this week.`,
    color:       accentInt,
    timestamp:   new Date().toISOString(),
    fields: [
      {
        name:   `${emoji} ${name} earned`,
        value:  `**${fmtNum(p.boltsEarned)}** ${name.toLowerCase()}`,
        inline: true
      },
      {
        name:   '🎯 Activity',
        value:  `${fmtNum(p.minigamesPlayed)} games · ${fmtNum(p.heistsSucceeded)} heists · ${fmtNum(p.hypeTrains)} trains`,
        inline: true
      },
      {
        name:   '​',                        // zero-width spacer — keeps layout stable
        value:  '​',
        inline: true
      },
      {
        name:   '🏆 Top 5 earners',
        value:  topField.slice(0, 1024),         // Discord field cap
        inline: false
      },
      {
        name:   '✨ Highlights',
        value:  highlightsField.slice(0, 1024),
        inline: false
      }
    ],
    footer: {
      text: `Loadout · ${new Date(p.weekStartedUtc || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${new Date(p.weekEndedUtc || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    }
  };
}
