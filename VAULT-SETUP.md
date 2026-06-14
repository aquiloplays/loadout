# Knowledge Vault, setup + manual actions

Personal, owner-only knowledge system for Clay (Kindle highlights + PDF
reader, both feeding one spaced-repetition vault). Nothing here is public.

Phases:
- Phase 1 (SHIPPED): worker backend + D1 + Vault dashboard + PDF upload/reader.
- Phase 2 (next): daily digest email via Resend cron.
- Phase 3 (next): Kindle companion app (Selenium scrape of read.amazon.com).

## URLs (owner-only, sign in as the owner first)
- Vault dashboard: https://aquilo.gg/vault/
- Kindle highlights: https://aquilo.gg/kindle/
- PDF library: https://aquilo.gg/pdf/
- PDF reader: https://aquilo.gg/pdf/view/?id=<documentId>

## What is live now
- D1 tables `kindle_highlights`, `pdf_documents`, `pdf_highlights` (applied to
  `aquilo_bot_db`).
- Worker module `discord-bot/vault.js`:
  - Owner dashboard API: `POST /web/admin/vault/api` (action-dispatched,
    gated by the existing site session owner flag + HMAC).
  - Kindle companion ingest: `POST /vault/kindle/ingest` (HMAC, secret-gated).
- Site pages: /vault, /kindle, /pdf, /pdf/view.
- PDF text is extracted in the browser (pdf.js from CDN) and stored in D1, so
  the reader works with no R2 bucket. Highlighting, favorites, spaced
  repetition, export (md/json/txt), and the Haiku "weekly themes" all work now.

## Manual actions required (each is a one-time setup, none echo secrets here)

1. AI weekly-themes (optional, recommended). The `ANTHROPIC_API_KEY` worker
   secret powers the "AI themes" button. If it is already set for other
   features it works as-is. To set or rotate:
   ```
   cd discord-bot
   wrangler secret put ANTHROPIC_API_KEY
   ```

2. Kindle companion ingest secret (needed for Phase 3, set it now so the
   endpoint is armed). Pick a long random hex; the companion will use the same
   value to sign its pushes.
   ```
   node -e "console.log(crypto.randomBytes(32).toString('hex'))"
   cd discord-bot
   wrangler secret put VAULT_INGEST_SECRET
   ```

3. R2 bucket for original-page PDF render (optional, Phase 1.1). The reader
   already shows clean extracted text without this; R2 only adds the
   side-by-side original-page image view. When ready:
   ```
   cd discord-bot
   wrangler r2 bucket create aquilo-pdf-vault
   ```
   Then add this binding to `discord-bot/wrangler.toml` and redeploy:
   ```
   [[r2_buckets]]
   binding = "VAULT_R2"
   bucket_name = "aquilo-pdf-vault"
   ```

4. Resend email API key (needed for Phase 2 daily digest). Sign up at
   resend.com, verify a sending domain (or use their onboarding sender), then:
   ```
   cd discord-bot
   wrangler secret put RESEND_API_KEY
   ```
   Phase 2 adds the `0 13 * * *` cron (8am ET) that emails the daily digest to
   bisherclay@gmail.com.

## Deploy notes
- D1 migration: `wrangler d1 execute aquilo_bot_db --file=./vault-migration.sql --remote`
  (already applied for phase 1).
- The worker MUST be deployed from a clean HEAD checkout (the shared working
  tree carries other in-flight edits); deploy from a `git worktree add` of HEAD.
- The site (aquilo-site) auto-deploys on push to master.
