# Aquilo Kindle companion

Owner-only tool for Clay. A small Windows tray app that scrapes your own
Kindle highlights from `read.amazon.com/notebook` and syncs them into the
Knowledge Vault, where they feed the daily review push.

This is a personal note-taking tool for your own purchased books. Highlights
are stored only under your owner identity, never shown publicly, never shared.

## What it does
- Runs in the system tray (no window).
- First run opens a real browser so you log into Amazon yourself. The app then
  captures the session COOKIES and encrypts them at rest with Windows DPAPI
  (`%APPDATA%\AquiloKindle\session.enc`). Your Amazon password is never seen,
  stored, or transmitted.
- Daily at 4am local (configurable) and on demand ("Sync now"), it walks your
  library, scrapes every highlight (text, book, author, location, color, note),
  and pushes them to the vault. The worker dedupes, so re-syncing is safe.
- New highlights show up at https://aquilo.gg/vault/ and get mixed into the
  daily review push you already set up.

## One-time setup
1. **Set the ingest secret on the worker** (if not already done). Generate a
   long random hex and set it as the worker secret:
   ```
   node -e "console.log(crypto.randomBytes(32).toString('hex'))"
   cd discord-bot
   wrangler secret put VAULT_INGEST_SECRET
   ```
2. **Install the companion.** Download `AquiloKindle.exe` from the GitHub
   release and run it. A tray icon (aurora key + book) appears. SmartScreen may
   warn on first run because the exe is new and unsigned: click More info, then
   Run anyway. Verify the download with the published SHA256 if you like.
3. **Paste the same secret into the companion.** Tray menu, "Paste ingest
   secret...", paste the SAME hex you set on the worker. It is DPAPI-encrypted
   to `%APPDATA%\AquiloKindle\secret.enc`, never logged.
4. **Sign in to Amazon.** Tray menu, "Sign in to Amazon". A browser opens; log
   in normally, then leave it; the app captures the session and closes the
   window. Cookies persist, so this is a one-time step until they expire.
5. **Sync.** Tray menu, "Sync now". Progress shows in the tray ("Syncing book
   12/87..."). When it finishes, check https://aquilo.gg/vault/.

## Tray menu
- Sync now / live last-sync line
- Sign in to Amazon (re-auth when the session expires)
- Paste ingest secret
- Set daily sync time (local hour, default 4)
- Open Vault dashboard
- View log folder (`%APPDATA%\AquiloKindle`, holds `app.log`)
- Check for updates (pulls newer `companion-kindle-v*` releases)
- Start with Windows (HKCU Run, on by default after first launch)
- Quit

## Privacy
- Cookie-only auth. No password is stored.
- Everything runs on your machine. Only the highlight text + book metadata is
  sent to the worker, signed with your shared ingest secret, over HTTPS.
- The vault is owner-gated end to end; highlights are never public.

## Build (maintainers)
```
pip install -r requirements.txt pyinstaller
python gen_icon.py        # only if regenerating the icon
python build.py           # -> dist/AquiloKindle.exe
```

## Caveats
- The scraper depends on Amazon's notebook page structure, which is
  undocumented and can change. If a sync returns 0 highlights, the page HTML is
  dumped to `%APPDATA%\AquiloKindle\notebook-dump.html` and `app.log` records
  where it broke; the selectors in `notebook_scraper.py` then need an update.
- Selenium resolves the browser driver automatically (Chrome preferred, Edge
  fallback) and downloads it to a local cache on first use, which needs network
  that one time.
- Web Push on the vault side is unaffected by this app; it just fills the vault.
