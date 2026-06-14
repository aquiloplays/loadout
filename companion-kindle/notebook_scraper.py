"""Scrape Clay's highlights from read.amazon.com/notebook.

Given an authenticated Selenium driver parked on the notebook page, walk the
library top to bottom; for each book select it, let its annotations lazy-load,
and extract every highlight (text, location, color, note). Returns a flat list
of highlight dicts ready for vault_client.

CAVEAT: this depends on Amazon's notebook DOM, which is undocumented and can
change without notice. Selectors below have fallbacks and the scraper logs
counts at every step; if Amazon restructures the page, the per-book extract
returns 0 and we dump the page HTML to the log dir for diagnosis. Update the
selectors here when that happens.
"""
import os
import time

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

import config
from logsetup import log

KNOWN_COLORS = ("yellow", "blue", "pink", "orange", "green")

# Runs in the page; returns the selected book's annotations as plain data.
# Scoped querySelector within each row handles Amazon's (invalid) repeated
# id="highlight" / id="note" markup.
_EXTRACT_JS = r"""
const out = [];
const rows = document.querySelectorAll(
  '#kp-notebook-annotations .a-row.a-spacing-base, #kp-notebook-annotations div.kp-notebook-row-separator');
rows.forEach((row) => {
  const h = row.querySelector('#highlight, span#highlight, .kp-notebook-highlight');
  const text = h ? (h.innerText || h.textContent || '').trim() : '';
  if (!text) return;
  const hdr = row.querySelector('#annotationHighlightHeader, .kp-notebook-metadata');
  const header = hdr ? (hdr.innerText || '').trim() : '';
  const noteEl = row.querySelector('#note, .kp-notebook-note .kp-notebook-note-content');
  let note = noteEl ? (noteEl.innerText || '').trim() : '';
  if (note.toLowerCase() === 'note' ) note = '';
  out.push({ text, header, note });
});
return out;
"""


def _parse_header(header):
    """'Yellow highlight | Location: 1,234' -> (color, location)."""
    color = ""
    low = (header or "").lower()
    for c in KNOWN_COLORS:
        if c in low:
            color = c
            break
    location = ""
    if "location" in low:
        location = header.split("ocation", 1)[1].lstrip(":. ").strip()
    elif "page" in low:
        location = header.strip()
    return color or "yellow", location[:80]


def _collect_books(driver):
    sels = [
        "#kp-notebook-library .kp-notebook-library-each-book",
        ".kp-notebook-library-each-book",
        "#library [id]",
    ]
    for sel in sels:
        els = driver.find_elements(By.CSS_SELECTOR, sel)
        if els:
            books = []
            for el in els:
                asin = (el.get_attribute("id") or "").strip()
                if not asin:
                    continue
                title = ""
                author = ""
                try:
                    title = el.find_element(By.CSS_SELECTOR, "h2.kp-notebook-searchable, h2").text.strip()
                except Exception:
                    pass
                try:
                    a = el.find_element(By.CSS_SELECTOR, "p.kp-notebook-searchable, p").text.strip()
                    author = a.split(":", 1)[1].strip() if ":" in a else a
                except Exception:
                    pass
                books.append({"asin": asin, "title": title or "Untitled", "author": author})
            if books:
                return books
    return []


def _scroll_annotations(driver, rounds=20):
    """Trigger the notebook's lazy-load by scrolling the annotations region
    until the row count stops growing."""
    last = -1
    for _ in range(rounds):
        rows = driver.find_elements(By.CSS_SELECTOR, "#kp-notebook-annotations .a-row.a-spacing-base")
        n = len(rows)
        if n == last:
            break
        last = n
        try:
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        except Exception:
            pass
        time.sleep(0.6)


def scrape(driver, progress=None):
    try:
        WebDriverWait(driver, 25).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".kp-notebook-library-each-book"))
        )
    except Exception:
        log("scrape: library never appeared", "error")
        _dump(driver)
        return []

    books = _collect_books(driver)
    log(f"scrape: {len(books)} books in library")
    if not books:
        _dump(driver)
        return []

    highlights = []
    total = len(books)
    for i, book in enumerate(books, 1):
        if callable(progress):
            try:
                progress(i, total, book["title"])
            except Exception:
                pass
        try:
            # Re-find by id (clicking reloads the pane, stale-proofs the loop).
            el = driver.find_element(By.ID, book["asin"])
            driver.execute_script("arguments[0].click();", el)
        except Exception as e:
            log(f"scrape: could not open '{book['title']}' ({str(e)[:60]})", "warning")
            continue
        time.sleep(1.4)  # respectful pacing + let the pane swap
        _scroll_annotations(driver)
        try:
            rows = driver.execute_script(_EXTRACT_JS) or []
        except Exception as e:
            log(f"scrape: extract JS failed on '{book['title']}' ({str(e)[:60]})", "warning")
            rows = []
        for r in rows:
            color, location = _parse_header(r.get("header", ""))
            highlights.append({
                "book_title": book["title"],
                "book_author": book["author"],
                "asin": book["asin"],
                "highlight_text": r.get("text", ""),
                "location": location,
                "color": color,
                "note": r.get("note", ""),
            })
        log(f"scrape: [{i}/{total}] {book['title']} -> {len(rows)} highlights")

    log(f"scrape: {len(highlights)} highlights across {total} books")
    return highlights


def _dump(driver):
    """On a zero-result scrape, save the page HTML so a future DOM change is
    diagnosable. No cookies or tokens are in the rendered annotations markup."""
    try:
        path = os.path.join(config.config_dir(), "notebook-dump.html")
        with open(path, "w", encoding="utf-8", errors="replace") as f:
            f.write(driver.page_source or "")
        log(f"scrape: dumped page HTML to {path} for diagnosis", "warning")
    except Exception:
        pass
