// Aquilo Kindle Vault Sync, background service worker (MV3).
//
// Owns the daily alarm and the sync pipeline: open/focus the notebook tab,
// ask the content script to scrape, then HMAC-sign and POST the highlights to
// aquilo.gg/api/vault/kindle/ingest (which proxies to the HMAC-gated worker).
// The ingest secret lives in chrome.storage.local (Chrome profile encryption),
// is the same hex set as the worker's VAULT_INGEST_SECRET, and is never logged.

const INGEST_URL = "https://aquilo.gg/api/vault/kindle/ingest";
const NOTEBOOK_URL = "https://read.amazon.com/notebook";
const CHUNK = 500;
const ALARM = "aquilo-kindle-daily";

// ── HMAC (WebCrypto), matches the worker: hex SHA-256 over ts + "\n" + body ──
async function sign(secret, ts, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ts + "\n" + body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getStore(keys) {
  return new Promise((res) => chrome.storage.local.get(keys, res));
}
async function setStore(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, res));
}

// ── daily alarm at the configured local hour (default 4am) ──────────────
async function rearmAlarm() {
  const { syncHour = 4 } = await getStore(["syncHour"]);
  const now = new Date();
  const next = new Date(now);
  next.setHours(syncHour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  chrome.alarms.create(ALARM, { when: next.getTime(), periodInMinutes: 1440 });
}

chrome.runtime.onInstalled.addListener(rearmAlarm);
chrome.runtime.onStartup.addListener(rearmAlarm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runSync().catch(() => {});
});

// ── find or open the notebook tab ───────────────────────────────────────
function queryTabs(q) {
  return new Promise((res) => chrome.tabs.query(q, res));
}
function waitForComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return reject(new Error("tab gone"));
        if (tab.status === "complete") return resolve(tab);
        if (Date.now() - t0 > timeoutMs) return reject(new Error("tab load timeout"));
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}
function sendScrape(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "aquilo-scrape" }, (resp) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(resp || { ok: false, error: "no-response" });
    });
  });
}

// ── push highlights (chunked, HMAC) ─────────────────────────────────────
async function pushHighlights(secret, highlights) {
  let inserted = 0;
  for (let i = 0; i < highlights.length; i += CHUNK) {
    const body = JSON.stringify({ highlights: highlights.slice(i, i + CHUNK) });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(secret, ts, body);
    const r = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aquilo-vault-ts": ts, "x-aquilo-vault-sig": sig },
      body,
    });
    if (r.status === 401) return { ok: false, error: "bad-secret", inserted };
    if (r.status === 503) return { ok: false, error: "secret-not-set-on-worker", inserted };
    if (!r.ok) return { ok: false, error: "http-" + r.status, inserted };
    let d = {};
    try { d = await r.json(); } catch (e) { d = {}; }
    inserted += Number(d.inserted || 0);
  }
  return { ok: true, inserted };
}

// ── the sync pipeline ───────────────────────────────────────────────────
let SYNCING = false;

async function runSync() {
  if (SYNCING) return { ok: false, error: "already-syncing" };
  SYNCING = true;
  await setStore({ status: "Starting...", lastError: "" });
  let createdTabId = null;
  try {
    const { secret } = await getStore(["secret"]);
    if (!secret) {
      await setStore({ lastError: "Paste your ingest secret in the popup first.", status: "" });
      return { ok: false, error: "no-secret" };
    }
    // Reuse an open notebook tab, else open one in the background.
    let tabs = await queryTabs({ url: "https://read.amazon.com/notebook*" });
    let tab = tabs[0];
    if (!tab) {
      tab = await new Promise((res) => chrome.tabs.create({ url: NOTEBOOK_URL, active: false }, res));
      createdTabId = tab.id;
    }
    await waitForComplete(tab.id);
    await setStore({ status: "Scraping highlights..." });
    const res = await sendScrape(tab.id);
    if (!res || !res.ok) {
      await setStore({ lastError: "Scrape failed: " + (res && res.error || "unknown") + ". Open the notebook page and retry.", status: "" });
      return { ok: false, error: "scrape-failed" };
    }
    const highlights = res.highlights || [];
    await setStore({ status: "Uploading " + highlights.length + " highlights..." });
    const out = await pushHighlights(secret, highlights);
    if (out.ok) {
      await setStore({ lastSyncMs: Date.now(), lastCount: highlights.length, lastError: "", status: "" });
      return { ok: true, count: highlights.length, inserted: out.inserted };
    }
    await setStore({ lastError: "Upload failed: " + out.error, status: "" });
    return out;
  } catch (e) {
    await setStore({ lastError: "Sync error: " + String(e && e.message || e), status: "" });
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    if (createdTabId != null) { try { chrome.tabs.remove(createdTabId); } catch (e) { /* ignore */ } }
    SYNCING = false;
  }
}

// ── messages from the popup ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "aquilo-sync-now") {
    runSync().then(sendResponse);
    return true;
  }
  if (msg.type === "aquilo-progress") {
    chrome.storage.local.set({ status: "Syncing book " + msg.i + "/" + msg.total + ": " + (msg.title || "").slice(0, 36) });
    return false;
  }
  if (msg.type === "aquilo-rearm") {
    rearmAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
