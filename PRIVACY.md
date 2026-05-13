# Privacy

Plain-English version of where Loadout sends your data and where it doesn't.

## tl;dr

Loadout runs **on your PC**. Almost everything stays there. The two exceptions:

1. **Patreon sign-in** (only if you click *Connect Patreon*) — talks to Patreon's official OAuth endpoint via a Cloudflare Worker we operate, then queries Patreon's `/identity` API once an hour to confirm your tier.
2. **AI shoutouts** (only if you provide an API key and the module is enabled) — your raid-shoutout prompt goes to Anthropic or OpenAI, depending on which provider you configured. Loadout itself never sees these requests; they're direct from your PC to the provider you chose.

Loadout does **not** run telemetry. We do not phone home. We do not aggregate usage. There is no analytics endpoint.

## Where data lives

On your PC, in `%APPDATA%\Loadout\` and `%APPDATA%\Aquilo\`:

| File | Contains | Encrypted? |
|---|---|---|
| `settings.json` | All configuration including (optionally) AI API keys you typed in | Plaintext (DPAPI-encrypt-at-rest planned for keys; track [issue](https://github.com/aquiloplays/loadout/issues)) |
| `bolts.json` | Per-viewer Bolts balances + streaks | Plaintext |
| `engagement.json` | Per-viewer chat / sub / cheer / raid counts | Plaintext |
| `quotes.json` | Quote book contents | Plaintext |
| `apex.json` | Current Apex state + last 50 reigns | Plaintext |
| `identity.json` | Cross-platform `!link` requests + approvals | Plaintext |
| `sub-anniversary.json` | Sub-start dates + last-fired milestones | Plaintext |
| `discord-live.json` | Last live-status Discord message ID | Plaintext |
| `patreon-state.bin` | Patreon access + refresh tokens, tier, full name, email | **DPAPI-encrypted** (current-user scope, can only be decrypted on the same Windows account on the same PC) |
| `loadout-errors.log` | Module exceptions for debugging | Plaintext, auto-rotates at 1 MB |
| `..\Aquilo\bus-secret.txt` | 32-char shared secret for the local Aquilo Bus | Plaintext |

These files only ever contain data about **your channel's viewers** that already passed through your bot — no separate viewer database, no scraping.

## What goes off-device

### Patreon sign-in (optional, opt-in)

When you click *Connect Patreon*:

1. Your default browser opens Patreon's OAuth page (`patreon.com`). You log in there — Loadout never sees your Patreon password.
2. Patreon redirects to `127.0.0.1:17823–17825` on your local machine with an authorization code.
3. Loadout POSTs that code to a Cloudflare Worker at `streamfusion-patreon-proxy.bisherclay.workers.dev`. The Worker adds the OAuth `client_secret` (which can't ship in the binary) and exchanges the code for tokens with Patreon.
4. The Worker returns the tokens directly to Loadout. The Worker stores nothing.
5. Loadout queries `patreon.com/api/oauth2/v2/identity` once an hour to confirm your current tier. Same Worker isn't involved at this step — it's a direct call from your PC to Patreon.

**What Patreon sees:** the standard OAuth identity grant — your full name, email address, and current memberships on the StreamFusion campaign. Same as any other Patreon-integrated app.

**What the Worker sees:** the OAuth code on the way to Patreon, and the tokens on the way back. The Worker keeps no logs of either; the source is in this repo at [`aquilo-gg/worker/loadout-link-worker.js`](aquilo-gg/worker/loadout-link-worker.js).

**What's stored:** the access + refresh tokens, your name, email, and current tier — DPAPI-encrypted in `patreon-state.bin` on your PC.

**Sign out** any time from Settings → Patreon → Sign out, or by deleting `%APPDATA%\Loadout\patreon-state.bin`.

### AI shoutouts (optional, opt-in)

When the AI Shoutouts module is enabled and a raid fires:

1. Loadout builds a short prompt with the raider's name, last category, and last title (pulled from CPH event args).
2. The prompt is sent **directly from your PC to your configured provider** — `api.anthropic.com` or `api.openai.com`.
3. The response is posted to chat.

We never see this traffic. Your API key never leaves your PC except as the `Authorization` / `x-api-key` header on those requests.

### `!link` viewer self-claim (used only by your viewers, not you)

Viewers who want a Patreon supporter flair can visit `aquilo.gg/link` and link their Twitch / YouTube / Kick / TikTok handle to their Patreon account. That mapping lives in a Cloudflare Workers KV namespace we operate, keyed by Patreon user ID. Loadout reads it via the anonymous `/api/link/lookup?platform=...&handle=...` endpoint, which returns only `tier: "tier1"|"tier2"|"tier3"|null` — never the viewer's name, email, or Patreon ID.

This endpoint is the only Loadout-controlled service Loadout queries during normal operation. Lookups are cached locally for 5 minutes (positive) / 1 minute (negative).

### GitHub releases (update checking)

Once every 6 hours Loadout calls `api.github.com/repos/aquiloplays/loadout-downloads/releases` to check for new versions. This is a public, anonymous read — GitHub sees the request as anonymous traffic. No token, no identifying header.

### Discord webhooks (optional, opt-in)

If you configure a Discord webhook URL, the live-status / recap modules POST to it. Discord sees your channel's go-live and recap embeds. We don't log any of this; it's webhook → Discord, no middleman.

### TikTok via TikFinity

TikFinity runs locally and sends events to Streamer.bot via a WebSocket. Loadout listens for those events through SB. **Nothing TikTok-related leaves your PC** — TikFinity handles the platform side.

## What we never collect

- Telemetry, analytics, crash reports, or usage stats — none of it
- Chat content (the kit reads chat to react to it; nothing logs the contents off-device)
- Stream titles, game categories, or VOD info beyond what you tell Loadout to post (Discord live-status / recap)
- Viewer information beyond their handle and the activity counters needed for the modules you've enabled
- IP addresses, system specs, OS version

## Subjects' rights (for your viewers)

Viewer data lives **on your PC**. If a viewer asks you to remove their data:

- Bolts balance: `!gift` it back to themselves at 0 or hand-edit `bolts.json` and reload
- Engagement counters: hand-edit `engagement.json` (find their entry by handle) and reload
- Apex history: hand-edit `apex.json`
- Patreon supporter mapping: they can sign out at `aquilo.gg/link` or contact aquilo.gg

## Data deletion (you)

To wipe everything Loadout knows:

1. Sign out of Patreon (Settings → Patreon → Sign out) — this also tells the Worker to invalidate your session token
2. Delete `%APPDATA%\Loadout\` and `%APPDATA%\Aquilo\`
3. (Optional) Visit [patreon.com → Settings → Connections](https://www.patreon.com/settings/apps) and revoke Loadout's app authorization

The Worker's KV namespace stores Patreon-user-ID-to-handle mappings created via `aquilo.gg/link`. Those persist independent of your local state. To delete those, sign in at `aquilo.gg/link` and remove the handles, or contact aquilo.gg.

## Changes

If this policy changes meaningfully, the new version ships with the next release and is called out in [CHANGELOG.md](CHANGELOG.md). The version of this file at any tag is the policy in effect at that release.

## Contact

[aquilo.gg](https://aquilo.gg) · [issues](https://github.com/aquiloplays/loadout/issues)
