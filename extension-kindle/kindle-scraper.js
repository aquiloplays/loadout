// Aquilo Kindle scraper, SHARED by the bookmarklet loader (fetched fresh from
// aquilo.gg each click) and the browser extension (committed copy in
// Loadout/extension-kindle/kindle-scraper.js, loaded before content.js).
//
// Defines window.AQK.scrape(onProgress) -> Promise<highlight[]>. Walks
// read.amazon.com/notebook top to bottom: opens each book, lazy-loads its
// annotations, extracts text + author + ASIN + location + color + note.
//
// CAVEAT: depends on Amazon's undocumented notebook DOM. Because the
// bookmarklet pulls this file fresh, a selector fix here is live instantly with
// no re-install. Keep the extension copy in sync.
(function () {
  var COLORS = ["yellow", "blue", "pink", "orange", "green"];
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function parseHeader(header) {
    var color = "yellow", low = (header || "").toLowerCase(), c, i;
    for (i = 0; i < COLORS.length; i++) { if (low.indexOf(COLORS[i]) >= 0) { color = COLORS[i]; break; } }
    var location = "";
    if (low.indexOf("location") >= 0) location = header.split(/ocation/i)[1].replace(/^[:.\s]+/, "").trim();
    else if (low.indexOf("page") >= 0) location = header.trim();
    return { color: color, location: location.slice(0, 80) };
  }

  function collectBooks() {
    var sels = ["#kp-notebook-library .kp-notebook-library-each-book", ".kp-notebook-library-each-book", "#library [id]"];
    for (var s = 0; s < sels.length; s++) {
      var els = document.querySelectorAll(sels[s]);
      if (!els.length) continue;
      var books = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i], asin = (el.id || "").trim();
        if (!asin) continue;
        var h = el.querySelector("h2.kp-notebook-searchable, h2");
        var p = el.querySelector("p.kp-notebook-searchable, p");
        var title = h ? h.textContent.trim() : "";
        var author = "";
        if (p) { var t = p.textContent.trim(); author = t.indexOf(":") >= 0 ? t.split(":")[1].trim() : t; }
        books.push({ asin: asin, title: title || "Untitled", author: author });
      }
      if (books.length) return books;
    }
    return [];
  }

  function extractCurrent() {
    var out = [];
    var rows = document.querySelectorAll("#kp-notebook-annotations .a-row.a-spacing-base, #kp-notebook-annotations div.kp-notebook-row-separator");
    rows.forEach(function (row) {
      var h = row.querySelector("#highlight, span#highlight, .kp-notebook-highlight");
      var text = h ? (h.innerText || h.textContent || "").trim() : "";
      if (!text) return;
      var hdr = row.querySelector("#annotationHighlightHeader, .kp-notebook-metadata");
      var header = hdr ? (hdr.innerText || "").trim() : "";
      var noteEl = row.querySelector("#note, .kp-notebook-note .kp-notebook-note-content");
      var note = noteEl ? (noteEl.innerText || "").trim() : "";
      if (note.toLowerCase() === "note") note = "";
      out.push({ text: text, header: header, note: note });
    });
    return out;
  }

  async function scrollAnnotations(rounds) {
    var last = -1;
    for (var i = 0; i < (rounds || 20); i++) {
      var n = document.querySelectorAll("#kp-notebook-annotations .a-row.a-spacing-base").length;
      if (n === last) break;
      last = n;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(600);
    }
  }

  async function scrape(onProgress) {
    for (var w = 0; w < 25 && !document.querySelector(".kp-notebook-library-each-book"); w++) await sleep(1000);
    var books = collectBooks(), highlights = [], total = books.length;
    for (var i = 0; i < total; i++) {
      var book = books[i];
      if (onProgress) try { onProgress(i + 1, total, book.title); } catch (e) { /* ignore */ }
      var el = document.getElementById(book.asin);
      if (!el) continue;
      el.click();
      await sleep(1400);
      await scrollAnnotations();
      var rows = [];
      try { rows = extractCurrent(); } catch (e) { rows = []; }
      for (var j = 0; j < rows.length; j++) {
        var ph = parseHeader(rows[j].header);
        highlights.push({
          book_title: book.title, book_author: book.author, asin: book.asin,
          highlight_text: rows[j].text, location: ph.location, color: ph.color, note: rows[j].note,
        });
      }
    }
    return highlights;
  }

  window.AQK = { scrape: scrape };
})();
