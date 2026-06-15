// Aquilo Kindle Vault Sync, content script (thin caller).
//
// The scrape logic lives in kindle-scraper.js (shared with the aquilo.gg
// bookmarklet), loaded before this file via manifest content_scripts, so the
// selectors have a single source of truth. This file just relays the
// "aquilo-scrape" message to window.AQK.scrape and streams progress back to
// the background worker.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "aquilo-scrape") {
    if (!window.AQK || !window.AQK.scrape) {
      sendResponse({ ok: false, error: "scraper-not-loaded" });
      return false;
    }
    window.AQK.scrape(function (i, total, title) {
      try { chrome.runtime.sendMessage({ type: "aquilo-progress", i: i, total: total, title: title }); } catch (e) { /* popup closed */ }
    })
      .then((highlights) => sendResponse({ ok: true, total: highlights.length, highlights: highlights }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }
  return false;
});
