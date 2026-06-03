"""Prune now-inert `peek` / `thankYou` / `celebration` top-level props from the
unified follow-overlay theme modules. After the Card Reveal pivot the shell no
longer reads them. Keeps everything live (slug/displayName/bar/font/palette/
sprites/counter/promo/bg/sheenColor). String- and comment-aware brace matching;
whole-line removal. Operates on aquilo-site (the overlay source of truth).

  python prune-theme-fields.py [--dry-run]

_generic.js is left untouched (it doubles as the documented theme contract).
"""
import sys, glob
from pathlib import Path

THEMES = Path("C:/Users/bishe/Desktop/aquilo-site/public/personal-overlays/follow/themes")
TARGETS = {"peek", "thankYou", "celebration"}
DRY = "--dry-run" in sys.argv


def skip_string(s, i, q):
    """i at opening quote q; return index just past the closing quote."""
    n = len(s); i += 1
    while i < n:
        c = s[i]
        if c == "\\":
            i += 2; continue
        if q == "`" and c == "$" and i + 1 < n and s[i + 1] == "{":
            depth = 1; i += 2
            while i < n and depth:
                d = s[i]
                if d in "'\"`": i = skip_string(s, i, d); continue
                if d == "{": depth += 1
                elif d == "}": depth -= 1
                i += 1
            continue
        if c == q:
            return i + 1
        i += 1
    return i


def find_value_end(s, i):
    """From i (first char of a value), return index of the depth-0 terminator
    (',' or the object-closing '}')."""
    n = len(s); depth = 0
    while i < n:
        c = s[i]
        if c in "'\"`": i = skip_string(s, i, c); continue
        if c == "/" and i + 1 < n and s[i + 1] == "/":
            while i < n and s[i] != "\n": i += 1
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "*":
            i += 2
            while i + 1 < n and not (s[i] == "*" and s[i + 1] == "/"): i += 1
            i += 2; continue
        if c in "{[(": depth += 1; i += 1; continue
        if c in "}])":
            if depth == 0: return i      # the theme object's closing brace
            depth -= 1; i += 1; continue
        if c == "," and depth == 0: return i
        i += 1
    return i


def prune(src):
    import re
    m = re.search(r"export\s+const\s+theme\s*=\s*\{", src)
    if not m:
        return src, []
    n = len(src)
    i = m.end()          # just past '{'
    depth = 1
    spans = []; removed = []
    while i < n and depth > 0:
        c = src[i]
        if c in "'\"`": i = skip_string(src, i, c); continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n": i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"): i += 1
            i += 2; continue
        if c in "{[(": depth += 1; i += 1; continue
        if c in "}])": depth -= 1; i += 1; continue
        if depth == 1 and (c.isalpha() or c == "_" or c == '"' or c == "'"):
            key_start = i
            if c in "\"'":
                j = skip_string(src, i, c); key = src[i + 1:j - 1]; i = j
            else:
                j = i
                while j < n and (src[j].isalnum() or src[j] == "_" or src[j] == "$"): j += 1
                key = src[i:j]; i = j
            k = i
            while k < n and src[k] in " \t\r\n": k += 1
            if k < n and src[k] == ":":
                i = k + 1
                while i < n and src[i] in " \t\r\n": i += 1
                val_end = find_value_end(src, i)
                if key in TARGETS:
                    line_start = src.rfind("\n", 0, key_start) + 1
                    de = val_end
                    if de < n and src[de] == ",": de += 1
                    nl = src.find("\n", de)
                    de = (nl + 1) if nl != -1 else n
                    spans.append((line_start, de)); removed.append(key)
                i = val_end + 1 if (val_end < n and src[val_end] == ",") else val_end
                continue
        i += 1
    for a, b in sorted(spans, reverse=True):
        src = src[:a] + src[b:]
    return src, removed


def main():
    files = [f for f in sorted(glob.glob(str(THEMES / "*.js"))) if Path(f).name != "_generic.js"]
    total = 0
    for f in files:
        src = Path(f).read_text(encoding="utf-8")
        out, removed = prune(src)
        tag = ",".join(removed) if removed else "(none)"
        print(f"{Path(f).name:42s} -> removed {tag}")
        if removed and not DRY:
            Path(f).write_text(out, encoding="utf-8", newline="")
            total += 1
    print(f"\n{'DRY-RUN, no writes' if DRY else f'pruned {total} files'} ({len(files)} themes scanned)")


if __name__ == "__main__":
    main()
