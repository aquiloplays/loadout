// Aquilo Kindle Vault Sync, content script.
//
// Runs inside read.amazon.com/notebook (the user's own authenticated tab, so
// there is no login dance and no cookie handling). On an "aquilo-scrape"
// message it walks the library top to bottom, opens each book, lets the
// annotations lazy-load, and extracts every highlight. Ported directly from
// the companion's notebook_scraper.py selectors.
//
// CAVEAT: depends on Amazon's notebook DOM, which is undocumented and can
// change. Selectors have fallbacks; a zero-result book is logged. Update the
// selectors here if Amazon restructures the page.

const KNOWN_COLORS = ["yellow", "blue", "pink", "orange", "green"];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseHeader(header) {
  let color = "yellow";
  const low = (header || "").toLowerCase();
  for (const c of KNOWN_COLORS) {
    if (low.includes(c)) { color = c; break; }
  }
  let location = "";
  if (low.includes("location")) {
    location = header.split(/ocation/i)[1].replace(/^[:.\s]+/, "").trim();
  } else if (low.includes("page")) {
    location = header.trim();
  }
  return { color, location: location.slice(0, 80) };
}

function collectBooks() {
  const sels = [
    "#kp-notebook-library .kp-notebook-library-each-book",
    ".kp-notebook-library-each-book",
    "#library [id]",
  ];
  for (const sel of sels) {
    const els = Array.from(document.querySelectorAll(sel));
    if (!els.length) continue;
    const books = [];
    for (const el of els) {
      const asin = (el.id || "").trim();
      if (!asin) continue;
      let title = "";
      let author = "";
      const h = el.querySelector("h2.kp-notebook-searchable, h2");
      if (h) title = h.textContent.trim();
      const p = el.querySelector("p.kp-notebook-searchable, p");
      if (p) {
        const t = p.textContent.trim();
        author = t.includes(":") ? t.split(":", 2)[1].trim() : t;
      }
      books.push({ asin, title: title || "Untitled", author });
    }
    if (books.length) return books;
  }
  return [];
}

function extractCurrent() {
  const out = [];
  const rows = document.querySelectorAll(
    "#kp-notebook-annotations .a-row.a-spacing-base, #kp-notebook-annotations div.kp-notebook-row-separator");
  rows.forEach((row) => {
    const h = row.querySelector("#highlight, span#highlight, .kp-notebook-highlight");
    const text = h ? (h.innerText || h.textContent || "").trim() : "";
    if (!text) return;
    const hdr = row.querySelector("#annotationHighlightHeader, .kp-notebook-metadata");
    const header = hdr ? (hdr.innerText || "").trim() : "";
    const noteEl = row.querySelector("#note, .kp-notebook-note .kp-notebook-note-content");
    let note = noteEl ? (noteEl.innerText || "").trim() : "";
    if (note.toLowerCase() === "note") note = "";
    out.push({ text, header, note });
  });
  return out;
}

async function scrollAnnotations(rounds = 20) {
  let last = -1;
  for (let i = 0; i < rounds; i++) {
    const n = document.querySelectorAll("#kp-notebook-annotations .a-row.a-spacing-base").length;
    if (n === last) break;
    last = n;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(600);
  }
}

async function scrapeAll() {
  // Wait for the library to render.
  for (let i = 0; i < 25 && !document.querySelector(".kp-notebook-library-each-book"); i++) {
    await sleep(1000);
  }
  const books = collectBooks();
  const highlights = [];
  const total = books.length;
  for (let i = 0; i < total; i++) {
    const book = books[i];
    try { chrome.runtime.sendMessage({ type: "aquilo-progress", i: i + 1, total, title: book.title }); } catch (e) { /* popup may be closed */ }
    const el = document.getElementById(book.asin);
    if (!el) continue;
    el.click();
    await sleep(1400);
    await scrollAnnotations();
    let rows = [];
    try { rows = extractCurrent(); } catch (e) { rows = []; }
    for (const r of rows) {
      const { color, location } = parseHeader(r.header);
      highlights.push({
        book_title: book.title,
        book_author: book.author,
        asin: book.asin,
        highlight_text: r.text,
        location,
        color,
        note: r.note,
      });
    }
  }
  return { ok: true, total, highlights };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "aquilo-scrape") {
    scrapeAll().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }
  return false;
});
