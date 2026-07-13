// Popup UI logic. Reads sync status from chrome.storage.local, saves the Codex
// sync key + daily hour, and triggers a manual sync via the background worker.
// The key field is write-only in the UI; a "saved" pill confirms one is stored.

const $ = (id) => document.getElementById(id);

function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 90) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 90) return m + "m ago";
  const h = Math.floor(m / 60);
  return h < 36 ? h + "h ago" : Math.floor(h / 24) + "d ago";
}

function get(keys) { return new Promise((r) => chrome.storage.local.get(keys, r)); }
function set(obj) { return new Promise((r) => chrome.storage.local.set(obj, r)); }

async function refresh() {
  const d = await get(["lastSyncMs", "lastCount", "status", "lastError", "key", "syncHour"]);
  $("lastSync").textContent = ago(d.lastSyncMs);
  $("count").textContent = String(d.lastCount || 0);
  const st = $("status");
  if (d.lastError) { st.textContent = d.lastError; st.classList.add("err"); }
  else { st.textContent = d.status || ""; st.classList.remove("err"); }
  $("secretSaved").classList.toggle("hidden", !d.key);
  if (typeof d.syncHour === "number") $("hour").value = String(d.syncHour);
}

$("save").addEventListener("click", async () => {
  const key = $("secret").value.trim();
  const hourRaw = $("hour").value.trim();
  const patch = {};
  if (key) patch.key = key;
  if (hourRaw !== "" && /^\d+$/.test(hourRaw)) patch.syncHour = Math.min(23, Math.max(0, parseInt(hourRaw, 10)));
  await set(patch);
  $("secret").value = "";
  if ("syncHour" in patch) chrome.runtime.sendMessage({ type: "aquilo-rearm" });
  refresh();
});

$("sync").addEventListener("click", () => {
  $("sync").disabled = true;
  $("status").textContent = "Starting...";
  $("status").classList.remove("err");
  chrome.runtime.sendMessage({ type: "aquilo-sync-now" }, () => {
    $("sync").disabled = false;
    refresh();
  });
});

$("vault").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://scriptorium-77m.pages.dev/#/kindle" });
});

// Live-ish status while a sync runs.
chrome.storage.onChanged.addListener(refresh);
refresh();
setInterval(refresh, 2000);
