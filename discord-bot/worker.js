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

    // Character paper-doll render endpoint. Public read; ETag/
    // cache-control tied to ?v=<lookVersion> so Discord embeds
    // re-fetch after a customisation change. See character.js.
    if (method === 'GET' && path.startsWith('/character/render/')) {
      const { handleCharacterRender } = await import('./character.js');
      return handleCharacterRender(req, env, path);
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
    // Recent-events ring buffer for the DLL to republish on the local
    // Aquilo Bus (drives the OBS browser-source overlay). HMAC-gated.
    if (method === 'GET' && path.startsWith('/sync/') && path.endsWith('/clash-events')) {
      const { handleClashEventsPull } = await import('./clash-http.js');
      return handleClashEventsPull(req, env, path);
    }
    // Signed sync — full town state. HMAC-gated; the future web
    // editor calls this. Also POST endpoints for write-through
    // building queue + garrison training so the editor doesn't have
    // to round-trip through a Discord interaction.
    if (path.startsWith('/sync/') && (path.endsWith('/clash') || path.includes('/clash/'))) {
      const { handleClashSync } = await import('./clash-http.js');
      return handleClashSync(req, env, path);
    }

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
  // channelId === TEMP_VC_JOIN_TO_CREATE_ID → spawn-then-move flow;
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
  const existingRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules`, {
    headers: { Authorization: 'Bot ' + token },
  });
  const existing = existingRes.ok ? await existingRes.json() : [];
  const targetNames = new Set([...rules.map(r => r.name), 'Slurs (Discord preset)', 'Sexual content (Discord preset)']);
  const deleted = [];
  for (const r of existing) {
    if (!targetNames.has(r.name)) continue;
    const d = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules/${r.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bot ' + token },
    });
    if (d.ok) deleted.push({ name: r.name, id: r.id });
    await new Promise(rr => setTimeout(rr, 250));
  }

  const created = [];
  const errors = [];
  for (const rule of rules) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules`, {
      method: 'POST',
      headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    });
    const text = await r.text();
    if (!r.ok) {
      errors.push({ rule: rule.name, status: r.status, body: text.slice(0, 300) });
      continue;
    }
    try { created.push({ rule: rule.name, id: JSON.parse(text).id }); } catch { created.push({ rule: rule.name }); }
    await new Promise(rr => setTimeout(rr, 250));
  }

  return new Response(JSON.stringify({ ok: errors.length === 0, deleted, created, errors }, null, 2), {
    status: errors.length === 0 ? 200 : 207,
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
