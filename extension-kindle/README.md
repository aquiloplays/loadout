# Aquilo Kindle Vault Sync (browser extension)

Owner-only Manifest V3 extension (Chrome + Edge) that syncs your own Kindle
highlights into the Knowledge Vault. It runs inside your already-signed-in
`read.amazon.com/notebook` tab, so there is no login dance, no cookie handling,
and no desktop app. Supersedes the PyInstaller companion in
`Loadout/companion-kindle/`.

## How it works
- A content script on `read.amazon.com/notebook` walks your library, opens each
  book, lets the highlights lazy-load, and extracts text + author + ASIN +
  location + color + notes.
- The background service worker runs a daily alarm (4am local, configurable),
  opens the notebook in a background tab, collects the highlights, and POSTs
  them HMAC-signed to `https://aquilo.gg/api/vault/kindle/ingest` (which proxies
  to the HMAC-gated worker). The worker dedupes, so re-syncing is safe.
- The popup shows last sync time + count, takes your ingest secret, and has a
  "Sync now" button.

## Setup
1. **Set the worker secret** (one time): generate a long random hex and run
   `wrangler secret put VAULT_INGEST_SECRET` in `discord-bot`.
2. **Load the extension.** Download `aquilo-kindle-extension.zip` from the
   GitHub release and unzip it. Open `chrome://extensions/` (or
   `edge://extensions/`), turn on Developer mode, click "Load unpacked", and
   pick the unzipped folder.
3. **Paste the secret.** Click the extension icon; paste the SAME hex into the
   "Ingest secret" field and Save. It is stored in `chrome.storage.local` (your
   browser profile), never sent anywhere except signed ingest requests.
4. **Sync.** Make sure you are logged into `read.amazon.com`, then click
   "Sync now". Highlights appear at https://aquilo.gg/vault/. After that it
   auto-syncs daily.

## Privacy
- No password is ever handled; the extension uses your existing Amazon session
  in your own browser.
- Only highlight text + book metadata leave the browser, signed with your
  shared ingest secret, over HTTPS. The vault is owner-gated end to end.

## Build (maintainers)
```
python gen_icons.py     # only if regenerating icons
python build_zip.py      # -> dist/aquilo-kindle-extension.zip
```

## Caveat
The scraper depends on Amazon's notebook DOM, which can change. If a sync
returns 0 highlights, the selectors in `content.js` (ported from the
companion's `notebook_scraper.py`) need an update.
