# Knowledge Vault, setup + manual actions

Personal, owner-only knowledge system for Clay (Kindle highlights + PDF
reader, both feeding one spaced-repetition vault, with a daily PWA push).
Nothing here is public.

Phases:
- Phase 1 (SHIPPED): worker backend + D1 + Vault dashboard + PDF upload/reader.
- Phase 2+3 (SHIPPED): PWA push notifications + daily cron + spaced repetition.
  (The email digest path was dropped in favor of Web Push.)
- Phase 4 (next): Kindle companion app (Selenium scrape of read.amazon.com).

## URLs (owner-only, sign in as the owner first)
- Vault dashboard: https://aquilo.gg/vault/
- Daily review: https://aquilo.gg/vault/daily/  (the page the push opens)
- Vault settings: https://aquilo.gg/vault/settings/  (notifications + digest prefs)
- Kindle highlights: https://aquilo.gg/kindle/
- PDF library: https://aquilo.gg/pdf/
- PDF reader: https://aquilo.gg/pdf/view/?id=<documentId>

## What is live now
- D1 tables `kindle_highlights`, `pdf_documents`, `pdf_highlights` (applied to
  `aquilo_bot_db`).
- Worker module `discord-bot/vault.js`:
  - Owner dashboard API: `POST /web/admin/vault/api` (action-dispatched,
    gated by the site session owner flag + HMAC).
  - Kindle companion ingest: `POST /vault/kindle/ingest` (HMAC, secret-gated).
  - Daily digest: `runDailyDigest` fires from the every-minute cron at the top
    of the configured send hour (default 13 UTC = 8am ET), builds the day's
    batch (KV `vault:daily:<userId>:<date>`, 48h TTL), and pushes ONE
    notification to the owner's devices.
- Site pages: /vault, /vault/daily, /vault/settings, /kindle, /pdf, /pdf/view.
- PDF text is extracted in the browser (pdf.js from CDN) and stored in D1.

## Push notifications: already configured, nothing to generate
Phase 3 REUSES the site's existing Web Push system (the same one behind the
go-live notifications):
- VAPID is already set up: `VAPID_PUBLIC_KEY` is a constant in
  `aquilo-site/functions/_lib/push.js` and `VAPID_PRIVATE_KEY` is already a
  Pages secret. No `web-push generate-vapid-keys`, no new secret.
- The daily cron sends via the existing worker -> site bridge
  (`firePush` -> `/api/push/external` -> `pushToAll`), which uses the
  `AQUILO_SITE_WEB_SECRET` that already gates the other site<->bot callbacks.
- The notification targets ONLY the owner's subscriptions (audience filtered by
  Clay's Discord id), so non-owners never receive vault pushes even though the
  public subscribe endpoint exists for the site's other notifications.

## Manual actions required (one-time; none echo secrets here)

1. Enable notifications on each device (after this deploy). Open
   https://aquilo.gg/vault/settings/ signed in as the owner and tap "Enable
   notifications". Repeat on every device you want pinged (phone home-screen
   app, laptop browser, etc). The daily cron fires to all of them.
   - iOS: install the site to the Home Screen first (Share, then Add to Home
     Screen), then open vault settings from the installed app and enable.

2. AI weekly-themes (optional). The `ANTHROPIC_API_KEY` worker secret powers the
   "AI themes" button; if it is already set for other features it works as-is.
   ```
   cd discord-bot
   wrangler secret put ANTHROPIC_API_KEY
   ```

3. Kindle companion ingest secret (needed for Phase 4; set it now so the
   endpoint is armed). Pick a long random hex; the companion signs its pushes
   with the same value.
   ```
   node -e "console.log(crypto.randomBytes(32).toString('hex'))"
   cd discord-bot
   wrangler secret put VAULT_INGEST_SECRET
   ```

4. R2 bucket for original-page PDF render (optional, Phase 1.1). The reader
   already shows clean extracted text without this; R2 only adds the
   side-by-side original-page image view.
   ```
   cd discord-bot
   wrangler r2 bucket create aquilo-pdf-vault
   ```
   Then add this binding to `discord-bot/wrangler.toml` and redeploy:
   ```
   [[r2_buckets]]
   binding = "PDF_VAULT"
   bucket_name = "aquilo-pdf-vault"
   ```

## Deploy notes
- D1 migration: `wrangler d1 execute aquilo_bot_db --file=./vault-migration.sql --remote`
  (already applied).
- The worker MUST be deployed from a clean HEAD checkout (the shared working
  tree carries other in-flight edits); deploy from a `git worktree add` of HEAD.
- The site (aquilo-site) auto-deploys on push to master.
