#!/usr/bin/env python3
"""
SULFUR wiki scraper (https://sulfur.wiki.gg) -> data/recipes.json

Run by GitHub Actions (see .github/workflows/update-data.yml); it produces the data file that the app
downloads by itself. It can also be run by hand:

    python tools/scrape.py [--out path/to/recipes.json]

Python 3.8+ standard library only. Wiki content: see the licence shown in the wiki footer (usually CC BY-SA).
"""
import json, re, sys, time, urllib.error, urllib.parse, urllib.request
from html.parser import HTMLParser
from pathlib import Path

BASE = "https://sulfur.wiki.gg"
API = BASE + "/api.php"
HERE = Path(__file__).resolve().parent
UA = "SULFUR-Interactive-Cookbook-Scraper/1.0 (+https://github.com/SnailMango/sulfur-interactive-cookbook)"


OUT = HERE.parent / "data" / "recipes.json"


# --------------------------------------------------------------- scraping ---
STATUS = {"running": False, "msg": "", "error": None}


def say(msg):
    STATUS["msg"] = msg
    print(msg)


def http_get(url, tries=8):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for a in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            wait = 4 * (a + 1)
            if e.code == 429:
                try:
                    wait = max(wait, int(e.headers.get("Retry-After", "0")))
                except ValueError:
                    pass
            last = e
            time.sleep(wait)
        except Exception as e:
            last = e
            time.sleep(2 * (a + 1))
    raise last


def api(params):
    p = dict(params, format="json", formatversion="2")
    return json.loads(http_get(API + "?" + urllib.parse.urlencode(p)))


def category_members(cat):
    out, cont = [], {}
    while True:
        d = api({"action": "query", "list": "categorymembers", "cmtitle": "Category:" + cat,
                 "cmlimit": "500", "cmnamespace": "0", **cont})
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" in d:
            cont = d["continue"]
        else:
            return out


def page_html(title):
    d = api({"action": "parse", "page": title, "prop": "text", "redirects": "1"})
    return d["parse"]["text"]


class RowParser(HTMLParser):
    """Extracts table rows containing the arrow ➡ (ingredients ➡ result)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = {"t": "", "cat": None}
        elif tag == "a" and self.cell is not None:
            title = a.get("title", "")
            if title.startswith("Category:") and not self.cell["cat"]:
                self.cell["cat"] = title[len("Category:"):]

    def handle_data(self, data):
        if self.cell is not None:
            self.cell["t"] += data

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.cell["t"] = re.sub(r"\s+", " ", self.cell["t"]).strip()
            self.row.append(self.cell)
            self.cell = None
        elif tag == "tr" and self.row is not None:
            if any(c["t"] == "➡" for c in self.row):
                self.rows.append(self.row)
            self.row = None


class InfoParser(HTMLParser):
    """From a page's 'Description' section: effects (bold text, or paragraphs/lists as a fallback) and italics."""
    VOID = {"img", "br", "hr", "input", "meta", "link", "wbr", "col", "area", "base", "embed", "source", "track"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.desc, self.h2 = [], False, None
        self.bold, self.ital, self.blocks = [], [], []
        self.b_buf, self.i_buf, self.p_buf = [], [], []

    def handle_starttag(self, tag, attrs):
        if tag in self.VOID:
            return
        self.stack.append(tag)
        if tag == "h2":
            self.h2 = []
        if self.desc:
            if tag in ("b", "strong"):
                self.b_buf.append([])
            elif tag in ("i", "em"):
                self.i_buf.append([])
            elif tag in ("p", "li"):
                self.p_buf.append([])

    def handle_startendtag(self, tag, attrs):
        pass

    def handle_data(self, data):
        if self.h2 is not None:
            self.h2.append(data)
        if self.desc:
            for buf in (self.b_buf, self.i_buf, self.p_buf):
                if buf:
                    buf[-1].append(data)

    def handle_endtag(self, tag):
        if tag in self.VOID or tag not in self.stack:
            return
        while self.stack:
            t = self.stack.pop()
            self._close(t)
            if t == tag:
                break

    def _close(self, t):
        clean = lambda parts: re.sub(r"\s+", " ", "".join(parts)).strip()
        if t == "h2":
            h = clean(self.h2 or []).lower()
            self.desc = h.startswith("description") or h.startswith("effect")
            self.h2 = None
        elif not self.desc:
            return
        elif t in ("b", "strong") and self.b_buf:
            x = clean(self.b_buf.pop())
            if x:
                self.bold.append(x)
        elif t in ("i", "em") and self.i_buf:
            x = clean(self.i_buf.pop())
            if x:
                self.ital.append(x)
        elif t in ("p", "li") and self.p_buf:
            x = clean(self.p_buf.pop())
            if x:
                self.blocks.append(x)


GENERIC = {"consumable", "throwable", "equipment", "food", "drink", "ingredient", "beverage"}


def parse_info(html):
    p = InfoParser()
    p.feed(html)
    ok = lambda b: b.lower().rstrip(".:") not in GENERIC and len(b) > 2
    eff = list(dict.fromkeys(b for b in p.bold if ok(b)))
    if not eff:  # no bold text: use paragraphs/list items that are not the italic flavour text
        eff = list(dict.fromkeys(b for b in p.blocks if ok(b) and b not in p.ital and len(b) < 160))
    d = {}
    if eff:
        d["e"] = eff
    if p.ital:
        d["f"] = p.ital[0]
    return d or None


QTY = re.compile(r"^(.*?)\s*[x×]\s*(\d+)(?:\s*[--]\s*(\d+))?\s*$")


def split_qty(text):
    """'Beans x1-2' -> ('Beans', 1, '1-2'); 'Cheese x2' -> ('Cheese', 2, None)."""
    m = QTY.match(text)
    if not m:
        return text.strip(), 1, None
    lo, hi = int(m.group(2)), m.group(3)
    return m.group(1).strip(), lo, (f"{lo}-{hi}" if hi else None)


def parse_item(cell):
    n, q, qr = split_qty(cell["t"])
    d = {"n": n, "q": q, "cat": cell["cat"]}
    if qr:
        d["qr"] = qr
    return d


def parse_recipes(html):
    p = RowParser()
    p.feed(html)
    out = []
    for row in p.rows:
        i = next(k for k, c in enumerate(row) if c["t"] == "➡")
        ins = [parse_item(c) for c in row[:i] if c["t"] not in ("", "+")]
        outs = [parse_item(c) for c in row[i + 1:] if c["t"]]
        if ins and outs:
            out.append({"in": ins, "out": [{k: v for k, v in o.items() if k != "cat"} for o in outs]})
    return out


def canon(db):
    """Cleans the data: splits quantities from names, merges case variants
    (e.g. 'sugar'/'Sugar'), separates single ingredients from generic groups ('Any ...')."""
    sp = lambda n: (lambda t: t[:1].upper() + t[1:])(re.sub(r"\s+", " ", n).strip())  # MediaWiki: first letter is always upper case
    key = lambda n: sp(n).lower()
    rec = db.get("recipes", [])
    for r in rec:
        for lst in (r["in"], r["out"]):
            for x in lst:
                n, q, qr = split_qty(x["n"])
                if n != x["n"]:
                    x["n"] = n
                    if x.get("q", 1) == 1:
                        x["q"] = q
                    if qr:
                        x["qr"] = qr
                x["n"] = sp(x["n"])
    cats, icons = db.get("cats", {}), db.get("icons", {})
    seen = {}
    for r in rec:
        for x in r["in"] + r["out"]:
            seen.setdefault(key(x["n"]), set()).add(x["n"])
    for ms in cats.values():
        for m in ms:
            seen.setdefault(key(m), set()).add(sp(m))
    members = {sp(m) for ms in cats.values() for m in ms}
    outs = {x["n"] for r in rec for x in r["out"]}
    fetched = {sp(x) for x in db.get("fetched", [])}
    for f in fetched:
        seen.setdefault(key(f), set()).add(f)
    pick = {k: sorted(v, key=lambda t: (t not in icons, t not in fetched, t not in members, t not in outs, not t[:1].isupper(), t))[0]
            for k, v in seen.items()}
    fix = lambda n: pick.get(key(n), sp(n))
    for r in rec:
        for x in r["in"] + r["out"]:
            x["n"] = fix(x["n"])
    db["cats"] = {c: list(dict.fromkeys(fix(m) for m in ms)) for c, ms in cats.items()}
    ni = {}
    for n, f in icons.items():
        c = fix(n)
        if n == c or c not in ni:
            ni[c] = f
    db["icons"] = ni
    groups = {x["n"] for r in rec for x in r["in"] if x.get("cat") or x["n"].startswith("Any ")}
    gm = {x["n"]: db["cats"].get(x["cat"], []) for r in rec for x in r["in"] if x.get("cat")}
    ing = {x["n"] for r in rec for x in r["in"] if x["n"] not in groups} | {m for ms in db["cats"].values() for m in ms}
    db["ingredients"] = sorted(ing)
    db["items"] = sorted(ing | {x["n"] for r in rec for x in r["out"] if x["n"] not in groups})
    db["groups"] = sorted(groups)
    db["gm"] = gm
    db["info"] = {fix(k): v for k, v in db.get("info", {}).items()}
    db["fetched"] = sorted({fix(k) for k in db.get("fetched", [])})
    return db


def resolve_icons(names):
    """Finds the icon URLs (128px) on the wiki. Nothing is downloaded: the app does that on the user's PC."""
    icons, urls = {}, {}
    names = sorted(names)
    for k in range(0, len(names), 40):
        say(f"Looking up icons... {min(k + 40, len(names))}/{len(names)}")
        chunk = names[k:k + 40]
        want = {"File:" + n[:1].upper() + n[1:] + ".png": n for n in chunk}
        try:
            d = api({"action": "query", "titles": "|".join("File:" + n.replace(" ", "_") + ".png" for n in chunk),
                     "prop": "imageinfo", "iiprop": "url", "iiurlwidth": "128"})
        except Exception:
            continue
        for pg in d.get("query", {}).get("pages", []):
            n = want.get(pg.get("title"))
            info = pg.get("imageinfo")
            if not n or not info:
                continue
            url = info[0].get("thumburl") or info[0].get("url")
            if url.startswith("/"):
                url = BASE + url
            ext = Path(urllib.parse.urlparse(url).path).suffix or ".png"
            fn = re.sub(r"[^A-Za-z0-9_-]", "_", n) + "-128" + ext
            icons[n] = fn
            urls[fn] = url
        time.sleep(0.2)
    return icons, urls


def _build():
    say("Looking for pages with recipes...")
    titles = set(category_members("Cookables"))
    d = api({"action": "parse", "page": "Recipes", "prop": "links"})
    titles |= {l["title"] for l in d["parse"]["links"] if l.get("ns") == 0 and l.get("exists", True)}
    titles = sorted(titles)
    seen, recipes, failed, info, fetched = set(), [], [], {}, set()

    def read(t):
        try:
            html = page_html(t)
        except KeyError:  # page does not exist
            return
        fetched.add(t)
        rs = parse_recipes(html)
        inf = parse_info(html)
        if inf:
            info[t] = inf
        for r in rs:
            key = json.dumps(r, sort_keys=True)
            if key not in seen:
                seen.add(key)
                recipes.append(r)

    for k, t in enumerate(titles, 1):
        say(f"Reading recipes... {k}/{len(titles)}")
        try:
            read(t)
        except Exception:
            failed.append(t)
        time.sleep(0.4)
    if failed:  # second, slower pass for pages the server refused (429)
        say(f"Retrying {len(failed)} pages that were left behind...")
        time.sleep(10)
        still = []
        for t in failed:
            try:
                read(t)
            except Exception:
                still.append(t)
            time.sleep(1)
        failed = still
    cats, guessed = {}, {}
    key = lambda n: re.sub(r"\s+", " ", n).strip().lower()

    def read_missing(include_cats):
        """Reads the pages of items that are not linked from the recipe list (e.g. dishes or drinks that only
        appear inside other tables)."""
        have = {key(t) for t in fetched}
        names = {}
        for r in recipes:
            for x in r["in"] + r["out"]:
                n = split_qty(x["n"])[0]
                names.setdefault(key(n), n)
        if include_cats:
            for ms in cats.values():
                for m in ms:
                    names.setdefault(key(m), m)
        todo = [n for k, n in sorted(names.items()) if k not in have and not n.startswith("Any ")]
        for k, n in enumerate(todo, 1):
            say(f"Reading missing pages... {k}/{len(todo)}")
            try:
                read(n)
            except Exception:
                pass
            time.sleep(0.4)

    read_missing(False)
    for r in recipes:
        for i in r["in"]:
            if not i["cat"] and i["n"].startswith("Any "):  # group without a category link: try to guess the category
                if i["n"] not in guessed:
                    base = i["n"][4:].strip()
                    guessed[i["n"]] = next(((c, m) for c in (base, base + "s", base.rstrip("s"), base + "es")
                                            for m in [category_members(c)] if m), None)
                if guessed[i["n"]]:
                    i["cat"] = guessed[i["n"]][0]
                    cats[i["cat"]] = guessed[i["n"]][1]
            if i["cat"] and i["cat"] not in cats:
                cats[i["cat"]] = category_members(i["cat"])
    read_missing(True)
    db = canon({"recipes": recipes, "cats": cats, "icons": {}, "info": info, "fetched": sorted(fetched)})
    db["icons"], db["iconUrls"] = resolve_icons(db["items"])
    db["updated"] = time.strftime("%d/%m/%Y %H:%M")
    db["version"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    db["schema"] = 1
    if len(recipes) < 50 or len(failed) > 8:
        raise RuntimeError(f"Incomplete scrape ({len(recipes)} recipes, {len(failed)} unreadable pages): data NOT written")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    msg = f"Done: {len(recipes)} recipes, {len(db['items'])} items, {len(db['icons'])} icons."
    if failed:
        msg += f" {len(failed)} pages could not be read."
    say(msg)




def build():
    STATUS.update(running=True, error=None)
    try:
        _build()
    except Exception as e:
        STATUS["error"] = str(e)
        say(f"Error during the update: {e}")
    finally:
        STATUS["running"] = False


def main():
    global OUT
    if "--out" in sys.argv:
        OUT = Path(sys.argv[sys.argv.index("--out") + 1])
    build()
    if STATUS["error"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
