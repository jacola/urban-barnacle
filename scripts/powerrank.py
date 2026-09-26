#!/usr/bin/env python3
"""
powerrank - archive the NexusTK "Top 1000 of Nexus" power ranking and derive
rank history, power-to-next-rank and "real rank" for the GitHub Pages site.

Commands:
  fetch   Download today's ranking page and archive it (raw HTML + parsed JSON
          snapshot). Then look up character stats: always for the tracked
          players and the players directly above them, and for everyone else
          on the list whose stats are due for a refresh (stats_refresh_days),
          up to max_lookups_per_run lookups per run.
  build   Regenerate data/history.json (daily detail for the tracked players)
          and data/players.json (rank matrix, current state and last-known
          power of every player ever seen) from the archived snapshots.

Power is defined as: vita + 2 * mana.

"Real rank" = official rank + the number of players who are missing from
today's list (unregistered) but whose last-known power is higher. Players
with hidden stats are bounded by their nearest visible neighbours instead of
an exact power, which yields a definite count and an uncertain count.

Only the Python standard library is used.
"""
import argparse
import bisect
import datetime as dt
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
HISTORY_PATH = DATA_DIR / "history.json"
PLAYERS_PATH = DATA_DIR / "players.json"
DIRECTORY_PATH = DATA_DIR / "directory.json"
DIRECTORY_BASE = "http://users.nexustk.com"
# These are the official lists linked from Nexus Atlas' user-list index.
CLANS = "Alizarin Bear Covenant Destiny Dharma Enigma Heavens Kurimja LostKingdom Oceana Pegasus Phoenix Sansin Silla SunMoon The_Forsaken Tiger".split()
SUBPATHS = "Barbarian Chongun Do Merchant Ranger Spy Diviner Geomancer Shaman Druid Monk Muse".split()
MARK_POWER = {"Il San": 160000, "Ee San": 320000, "Sam San": 640000, "Sa San": 1280000}

RANKING_URL = "http://users.nexustk.com/webreport/PowerAll.htm"
# Per-path "Top 250" rankings, refreshed together with the overall list.
PATH_URLS = {
    "warrior": "http://users.nexustk.com/webreport/PowerWarrior.htm",
    "rogue": "http://users.nexustk.com/webreport/PowerRogue.htm",
    "mage": "http://users.nexustk.com/webreport/PowerMage.htm",
    "poet": "http://users.nexustk.com/webreport/PowerPoet.htm",
}
# Character pages are static files. Fetching them directly avoids the two-hop
# redirect (through a CGI script) behind http://users.nexustk.com/?name=...
CHARACTER_URL = "http://users.nexustk.com/userfiles/{key}.html"
USER_AGENT = "powerrank-archiver/1.0 (daily ranking archive for a GitHub Pages site)"
TIMEOUT_SECONDS = 30
# Optional on-disk cache of fetched pages (--cache-dir / POWERRANK_CACHE_DIR) so
# development and testing never hit the site more than once per page.
CACHE_DIR = None

DEFAULTS = {
    "request_delay_seconds": 1.0,
    "stats_refresh_days": 1,
    "max_lookups_per_run": 1100,
    "max_lookups_above": 10,
    "max_consecutive_errors": 20,
    "min_rows": 500,
    "min_path_rows": 100,
    "real_rank_max_absent_days": None,
}

# One ranking row looks like:
# <tr><td ...><span class="big">86.</span></td>
#     <td><a class="link" href="http://users.nexustk.com/?name=inkey" ...>Guardian Inkey (Sa San)</a></td></tr>
ROW_RE = re.compile(
    r'<span class="big">\s*(\d+)\.\s*</span>.*?'
    r'href="[^"]*\?name=([^"&]+)"[^>]*>(.*?)</a>',
    re.S | re.I,
)
# "Guardian Inkey (Sa San)" or "Sa San (W) ohyes (Sa San)" -> title / name / level
DISPLAY_RE = re.compile(r"^(?P<title>.*?)\s*(?P<name>\S+)\s*\((?P<level>[^)]*)\)\s*$", re.S)
# <tr><td width="20%">Vita :</td><td width="80%">2600200</td></tr>
STAT_RE = r"{label}\s*:\s*</td>\s*<td[^>]*>\s*([\d,]+)"
NO_PAGE_MARKER = "does not have a current web listing"


class NotFound(Exception):
    """The character page does not exist (HTTP 404)."""


def log(message):
    print(message, file=sys.stderr, flush=True)


def rel(path):
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_config():
    with CONFIG_PATH.open(encoding="utf-8") as fh:
        cfg = {**DEFAULTS, **json.load(fh)}
    if not cfg.get("tracked"):
        sys.exit("config.json: 'tracked' must list at least one character name")
    return cfg


def write_json(path, payload, indent=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=indent, ensure_ascii=False)
        fh.write("\n")


def power(vita, mana):
    return vita + 2 * mana


def parse_date(text):
    return dt.date.fromisoformat(text)


# --------------------------------------------------------------------------- HTTP


def cache_paths(url):
    base = CACHE_DIR / re.sub(r"[^A-Za-z0-9._-]+", "_", url)
    return base, base.parent / (base.name + ".404")


def http_get(url, retries=3, backoff_seconds=5):
    if CACHE_DIR is not None:
        body, missing = cache_paths(url)
        if missing.exists():
            raise NotFound(url)
        if body.exists():
            return body.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                raw = response.read()
            if CACHE_DIR is not None:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache_paths(url)[0].write_bytes(raw)
            return raw
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                if CACHE_DIR is not None:
                    CACHE_DIR.mkdir(parents=True, exist_ok=True)
                    cache_paths(url)[1].touch()
                raise NotFound(url) from exc
            if attempt == retries:
                raise
            log(f"  attempt {attempt}/{retries} failed for {url}: HTTP {exc.code}")
            time.sleep(backoff_seconds * attempt)
        except (urllib.error.URLError, OSError) as exc:
            if attempt == retries:
                raise
            log(f"  attempt {attempt}/{retries} failed for {url}: {exc}")
            time.sleep(backoff_seconds * attempt)


def decode(raw):
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


# --------------------------------------------------------------------------- parsing


def split_display(display, key):
    """Split 'Title Name (Level)' into its parts, using the URL key to locate the name."""
    match = DISPLAY_RE.match(display)
    if match and match.group("name").lower() == key:
        return match.group("title").strip(), match.group("name"), match.group("level").strip()
    tokens = display.split()
    for index, token in enumerate(tokens):
        if token.lower() == key:
            title = " ".join(tokens[:index])
            level = " ".join(tokens[index + 1:]).strip("() ")
            return title, token, level
    return "", key, ""


def parse_rankings(text):
    """Ordered list of ranked rows. Ties share a rank number (competition ranking)."""
    rows = []
    for chunk in re.split(r"<tr\b", text, flags=re.I)[1:]:
        match = ROW_RE.search(chunk)
        if not match:
            continue
        rank = int(match.group(1))
        key = urllib.parse.unquote(match.group(2)).lower()
        display = html.unescape(re.sub(r"<[^>]+>", "", match.group(3)))
        display = re.sub(r"\s+", " ", display).strip()
        title, name, level = split_display(display, key)
        rows.append({"rank": rank, "key": key, "name": name, "title": title, "level": level})
    rows.sort(key=lambda row: row["rank"])  # stable: keeps page order within ties
    return rows


def index_by_key(rankings):
    index = {}
    for position, row in enumerate(rankings):
        index.setdefault(row["key"], position)
    return index


def rows_above(rankings, position):
    """Rows ranked strictly better than rankings[position], nearest first (ties are skipped)."""
    own_rank = rankings[position]["rank"]
    for index in range(position - 1, -1, -1):
        row = rankings[index]
        if row["rank"] < own_rank:
            yield row


def parse_stats(text):
    if NO_PAGE_MARKER in text:
        return {"status": "no_page"}
    values = {}
    for label in ("Level", "Vita", "Mana"):
        match = re.search(STAT_RE.format(label=label), text, re.I)
        if match:
            values[label.lower()] = int(match.group(1).replace(",", ""))
    if "vita" not in values or "mana" not in values:
        return {"status": "hidden"}
    values["power"] = power(values["vita"], values["mana"])
    values["status"] = "ok"
    return values


def parse_directory_names(text):
    """A-Z index: only character links have a ?name= query (navigation does not)."""
    result = {}
    for key, label in re.findall(r'<a\b[^>]*href="[^"]*\?name=([^"&]+)"[^>]*>(.*?)</a>', text, re.I | re.S):
        key = urllib.parse.unquote(key).lower()
        display = html.unescape(re.sub(r"<[^>]+>", "", label)).strip()
        if re.fullmatch(r"[a-z0-9_]+", key):
            result[key] = {"name": display.split()[-1], "title": " ".join(display.split()[:-1])}
    return result


def parse_members(text):
    """Official clan/subpath rows carry a mark and the site's activity icons."""
    members = {}
    pattern = re.compile(r'<a\b[^>]*href="[^"]*\?name=([^"&]+)"[^>]*>(.*?)</a>(.*?)(?=<BR\s*/?>|</li>|$)', re.I | re.S)
    for match in pattern.finditer(text):
        key = urllib.parse.unquote(match.group(1)).lower()
        if not re.fullmatch(r"[a-z0-9_]+", key):
            continue
        label = html.unescape(re.sub(r"<[^>]+>", "", match.group(2))).strip()
        # A clan motto may contain parentheses; take the first mark or level after the name.
        level = re.search(r"\((?:[^)]*? - )?(Level \d+|Il San|Ee San|Sam San|Sa San)\)", label, re.I)
        name = label.split(" (")[0].split()[0]
        icons = match.group(3).lower()
        activities = [name for icon, name in (("buttongreen.gif", "active"), ("buttonyellow.gif", "inactive"), ("buttonred.gif", "absent")) if icon in icons]
        members[key] = {
            "name": name, "level_mark": level.group(1).title() if level else None,
            "activity": activities[0] if len(activities) == 1 else None,
            "registration": "unregistered" if "notreg.gif" in icons else "registered",
        }
    return members


def directory_sources():
    sources = {f"letter-{letter}": f"{DIRECTORY_BASE}/userfiles/{letter}.html" for letter in "abcdefghijklmnopqrstuvwxyz"}
    sources.update({f"clan-{name}": f"{DIRECTORY_BASE}/webreport/{name}.html" for name in CLANS})
    sources.update({f"subpath-{name}": f"{DIRECTORY_BASE}/webreport/{name}.htm" for name in SUBPATHS})
    return sources


def cmd_directory(args):
    """Fetch a current directory independently of the Top 1000 snapshot."""
    sources = directory_sources()
    date = args.date or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")

    def fetch_one(item):
        source, url = item
        raw = http_get(url)
        members = parse_directory_names(decode(raw)) if source.startswith("letter-") else parse_members(decode(raw))
        if not members:
            raise ValueError(f"{source}: no character rows parsed")
        return source, url, raw, members

    fetched = {}
    # A failed page must never turn a missing member into an inferred departure.
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_one, item): item[0] for item in sources.items()}
        for future in as_completed(futures):
            source, url, raw, members = future.result()
            fetched[source] = members
            log(f"  {source}: {len(members)}")

    entries = {}
    for source in sources:  # deterministic ordering despite parallel downloads
        members = fetched[source]
        for key, info in members.items():
            entry = entries.setdefault(key, {"name": info["name"], "title": "", "clans": [], "subpaths": [], "sources": []})
            entry["sources"].append(source)
            if source.startswith("letter-"):
                entry["name"] = info["name"]
                entry["title"] = info["title"]
            else:
                group = "clans" if source.startswith("clan-") else "subpaths"
                entry[group].append(source.split("-", 1)[1].replace("_", " "))
                for field in ("level_mark", "activity", "registration"):
                    if info[field] is not None:
                        if field in entry and entry[field] != info[field]:
                            entry[field] = None  # disagreeing live sources; don't guess
                        else:
                            entry[field] = info[field]
    for entry in entries.values():
        entry["min_power"] = MARK_POWER.get(entry.get("level_mark"))
    previous_entries = {}
    if DIRECTORY_PATH.exists():
        with DIRECTORY_PATH.open(encoding="utf-8") as fh:
            previous_entries = json.load(fh).get("entries", {})
    with PLAYERS_PATH.open(encoding="utf-8") as fh:
        ranked_players = json.load(fh).get("players", {})
    for key, entry in entries.items():
        prior = previous_entries.get(key, {})
        for field in ("stats", "stats_checked", "stats_status"):
            if field in prior:
                entry[field] = prior[field]
    # Slowly fill the gap beyond the Top 1000; keep earlier successful checks.
    candidates = []
    for key, entry in entries.items():
        if entry.get("registration") != "registered" or ranked_players.get(key, {}).get("stats"):
            continue
        checked = entry.get("stats_checked")
        if checked and (parse_date(date) - parse_date(checked)).days < 30:
            continue
        candidates.append(key)
    candidates.sort(key=lambda key: (entries[key].get("stats_checked") or "", key))
    delay = load_config()["request_delay_seconds"]
    for key in candidates[:args.max_lookups]:
        time.sleep(delay)
        result = fetch_stats(key)
        if result["status"] == "error":
            log(f"  {key}: stats lookup failed ({result.get('error')})")
            continue
        entry = entries[key]
        entry["stats_checked"] = date
        entry["stats_status"] = result["status"]
        if result["status"] == "ok":
            entry["stats"] = {"date": date, "vita": result["vita"], "mana": result["mana"], "power": result["power"]}
    log(f"Extra character lookups: {min(len(candidates), args.max_lookups)} / {len(candidates)} due")
    write_json(DIRECTORY_PATH, {"date": date, "fetched_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(), "source_urls": sources, "entries": entries}, indent=None)
    log(f"Wrote {rel(DIRECTORY_PATH)}: {len(entries)} characters")


def fetch_stats(key):
    url = CHARACTER_URL.format(key=urllib.parse.quote(key))
    try:
        return parse_stats(decode(http_get(url, retries=2)))
    except NotFound:
        return {"status": "no_page"}
    except Exception as exc:  # one failing character page must not abort the run
        return {"status": "error", "error": str(exc)[:200]}


# --------------------------------------------------------------------------- fetch


def load_previous_checks():
    """key -> date of the last stats lookup, taken from the previous build's players.json."""
    if not PLAYERS_PATH.exists():
        return {}
    with PLAYERS_PATH.open(encoding="utf-8") as fh:
        payload = json.load(fh)
    return {key: p["stats_checked"] for key, p in payload.get("players", {}).items() if p.get("stats_checked")}


def fetch_path_lists(date, cfg):
    """path -> parsed rows of the per-path Top 250 pages. A failing page is skipped, not fatal."""
    paths = {}
    for path, url in PATH_URLS.items():
        time.sleep(cfg["request_delay_seconds"])
        try:
            raw = http_get(url)
        except Exception as exc:
            log(f"  {path}: failed to fetch ({exc}); skipping today")
            continue
        rows = parse_rankings(decode(raw))
        if len(rows) < cfg["min_path_rows"]:
            log(f"  {path}: only {len(rows)} rows (< {cfg['min_path_rows']}); skipping suspicious page")
            continue
        (RAW_DIR / f"{date}-{path}.htm").write_bytes(raw)
        paths[path] = rows
    return paths


def cmd_fetch(args):
    cfg = load_config()
    now = dt.datetime.now(dt.timezone.utc)
    date = args.date or now.strftime("%Y-%m-%d")
    today = parse_date(date)

    log(f"Fetching {RANKING_URL}")
    raw = http_get(RANKING_URL)
    rankings = parse_rankings(decode(raw))
    if len(rankings) < cfg["min_rows"]:
        sys.exit(f"Parsed only {len(rankings)} rows (< {cfg['min_rows']}); refusing to archive a suspicious page")
    log(f"Parsed {len(rankings)} ranked characters")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    (RAW_DIR / f"{date}.htm").write_bytes(raw)

    log("Fetching path rankings")
    paths = fetch_path_lists(date, cfg)
    everyone = {row["key"]: row for row in rankings}
    for rows in paths.values():
        for row in rows:
            everyone.setdefault(row["key"], row)
    log(f"Path pages: {', '.join(f'{path} {len(rows)}' for path, rows in paths.items()) or 'none'}"
        f" (+{len(everyone) - len(rankings)} characters not in the overall list)")

    positions = index_by_key(rankings)
    previous = load_previous_checks()
    budget = cfg["max_lookups_per_run"] if args.max_lookups is None else args.max_lookups
    stats = {}
    state = {"errors_in_row": 0, "aborted": False}

    # A re-run on the same date must not discard the lookups already archived that day.
    snapshot_path = SNAPSHOT_DIR / f"{date}.json"
    carried = {}
    if snapshot_path.exists():
        with snapshot_path.open(encoding="utf-8") as fh:
            carried = {key: value for key, value in json.load(fh).get("stats", {}).items() if value.get("status") != "error"}
        log(f"Carrying over {len(carried)} stats from the earlier snapshot of {date}")

    def lookup(row, verbose=False):
        key = row["key"]
        if key in stats:
            return stats[key]
        if len(stats) >= budget or state["aborted"]:
            return None
        time.sleep(cfg["request_delay_seconds"])
        result = fetch_stats(key)
        stats[key] = result
        if result["status"] == "error":
            state["errors_in_row"] += 1
            if state["errors_in_row"] >= cfg["max_consecutive_errors"]:
                state["aborted"] = True
                log(f"  {state['errors_in_row']} consecutive errors - stopping stat lookups for this run")
        else:
            state["errors_in_row"] = 0
        if verbose:
            detail = f" power={result['power']}" if result["status"] == "ok" else ""
            log(f"  {row['name']} (#{row['rank']}): {result['status']}{detail}")
        return result

    def walk_up(rows, position):
        """Look up the players above rows[position] until one with visible stats is found."""
        for attempt, row in enumerate(rows_above(rows, position)):
            if attempt >= cfg["max_lookups_above"]:
                break
            result = lookup(row, verbose=True)
            if result is None or result["status"] == "ok":
                break

    # 1. Tracked players and the players directly above them, on the overall and their path list.
    for name in cfg["tracked"]:
        key = name.lower()
        if key not in everyone:
            log(f"{name}: not on any list today")
            continue
        if key in positions:
            log(f"{name}: rank {rankings[positions[key]]['rank']}")
            lookup(rankings[positions[key]], verbose=True)
            walk_up(rankings, positions[key])
        for path, rows in paths.items():
            position = index_by_key(rows).get(key)
            if position is not None:
                log(f"{name}: {path} rank {rows[position]['rank']}")
                lookup(rows[position], verbose=True)
                walk_up(rows, position)

    # 2. Everyone else whose stats are due, never-checked first, then the stalest.
    def due(row):
        checked = date if row["key"] in carried else previous.get(row["key"])
        if not checked:
            return True
        try:
            return (today - parse_date(checked)).days >= cfg["stats_refresh_days"]
        except ValueError:
            return True

    candidates = [row for row in everyone.values() if row["key"] not in stats and due(row)]
    candidates.sort(key=lambda row: (previous.get(row["key"]) or "", row["rank"]))
    planned = max(0, min(len(candidates), budget - len(stats)))
    log(f"Refreshing stats for {planned} of {len(candidates)} due players ({len(everyone) - len(candidates) - len(stats)} fresh, skipped)")
    for count, row in enumerate(candidates, 1):
        if lookup(row) is None:
            break
        if count % 100 == 0:
            log(f"  ...{count} lookups done")
    log(f"Stats lookups: {dict(Counter(result['status'] for result in stats.values()))}")
    merged = {**carried, **stats}
    if carried:
        log(f"Snapshot stats after merge: {len(merged)}")

    snapshot = {
        "date": date,
        "fetched_at": now.replace(microsecond=0).isoformat(),
        "source": RANKING_URL,
        "count": len(rankings),
        "rankings": rankings,
        "paths": paths,
        "stats": merged,
    }
    write_json(snapshot_path, snapshot, indent=None if len(merged) > 50 else 1)
    log(f"Wrote {rel(snapshot_path)}")


# --------------------------------------------------------------------------- build


def compute_bounds(rankings, stats):
    """key -> (lo, hi) power bounds for every row on the list.

    Visible stats give exact bounds. Otherwise the nearest visible player above
    gives hi (None = unbounded) and the nearest visible player below gives lo
    (0 = unknown). Tied ranks mean equal power, so a visible tie partner gives
    an exact value.
    """
    n = len(rankings)
    exact = [None] * n
    for i, row in enumerate(rankings):
        s = stats.get(row["key"])
        if s and s["status"] == "ok":
            exact[i] = s["power"]
    tie_power = {}
    for i, row in enumerate(rankings):
        if exact[i] is not None:
            tie_power.setdefault(row["rank"], exact[i])
    for i, row in enumerate(rankings):
        if exact[i] is None and row["rank"] in tie_power:
            exact[i] = tie_power[row["rank"]]

    above = [None] * n
    last = None
    for i in range(n):
        above[i] = last if exact[i] is None else exact[i]
        if exact[i] is not None:
            last = exact[i]
    below = [0] * n
    last = 0
    for i in reversed(range(n)):
        below[i] = last if exact[i] is None else exact[i]
        if exact[i] is not None:
            last = exact[i]
    return {row["key"]: (below[i], above[i]) for i, row in enumerate(rankings)}


def find_next_above(rankings, position, stats):
    """Nearest better-ranked character whose stats were visible, or None if unknown."""
    skipped = 0
    for row in rows_above(rankings, position):
        row_stats = stats.get(row["key"])
        if row_stats is None:  # never looked up on that day
            return None
        if row_stats["status"] == "ok":
            return {
                "rank": row["rank"],
                "key": row["key"],
                "name": row["name"],
                "power": row_stats["power"],
                "skipped": skipped,
            }
        skipped += 1
    return None


class AbsentIndex:
    """Sorted power bounds of the absent (unregistered) players, for fast real-rank counting."""

    def __init__(self, players):
        players = list(players)
        self.lo = sorted(player["lo"] for player in players)
        self.hi = sorted(player["hi"] for player in players if player["hi"] is not None)
        self.unbounded = sum(1 for player in players if player["hi"] is None)

    def counts(self, lo, hi):
        """(definite, possible) number of absent players whose power is above the (lo, hi) bounds."""
        definite = 0 if hi is None else len(self.lo) - bisect.bisect_right(self.lo, hi)
        candidates = self.unbounded + len(self.hi) - bisect.bisect_right(self.hi, lo)
        return definite, max(0, candidates - definite)


def daily_record(date, rankings, position, stats, bounds, absent):
    row = rankings[position]
    record = {"date": date, "rank": row["rank"], "power": None, "vita": None, "mana": None}
    own = stats.get(row["key"])
    if own and own["status"] == "ok":
        record.update(vita=own["vita"], mana=own["mana"], power=own["power"])
    elif own:
        record["stats_status"] = own["status"]
    lo, hi = bounds[row["key"]]
    record["lo"], record["hi"] = lo, hi

    nxt = find_next_above(rankings, position, stats) if row["rank"] > 1 else None
    if nxt:
        nxt["gap"] = nxt["power"] - record["power"] if record["power"] is not None else None
    record["next"] = nxt

    definite, possible = absent.counts(lo, hi)
    record["unregistered_above"] = definite
    record["real_rank"] = row["rank"] + definite
    record["real_rank_max"] = row["rank"] + definite + possible
    return record


def load_snapshots():
    snapshots = []
    for path in sorted(SNAPSHOT_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as fh:
            snapshots.append(json.load(fh))
    return snapshots


def new_player(row, date, n_days):
    return {
        "name": row["name"],
        "title": row["title"],
        "first_seen": date,
        "path": None,  # warrior / rogue / mage / poet, from the per-path pages
        "stats": None,
        "stats_checked": None,
        "last_seen": None,  # last day on the overall list, and the rank there
        "last_rank": None,
        "last_active": date,  # last day on any list (overall or path)
        "last_path_rank": None,
        # Per-day series aligned with "dates". 0 = not on the list / unknown.
        "ranks": [0] * n_days,
        "path_ranks": [0] * n_days,  # rank on the player's path Top 250
        "gaps": [0] * n_days,  # power needed to pass the next visible player
        "next": [None] * n_days,  # key of that player (converted to a 1-based index into "keys")
        "unreg": [0] * n_days,  # unregistered players definitely above
        "unreg_max": [0] * n_days,  # ... including uncertain ones
    }


def note_stats(player, own, date):
    if own and own["status"] != "error":
        player["stats_checked"] = date
        player["stats_status"] = own["status"]
    if own and own["status"] == "ok":
        player["stats"] = {"date": date, "vita": own["vita"], "mana": own["mana"], "power": own["power"]}


def path_only_record(date, row, own, bounds):
    """Today's state for a player who is on a path list but not on the overall list."""
    record = {"date": date, "rank": None, "power": None, "vita": None, "mana": None, "next": None}
    if own and own["status"] == "ok":
        record.update(vita=own["vita"], mana=own["mana"], power=own["power"])
    elif own:
        record["stats_status"] = own["status"]
    record["lo"], record["hi"] = bounds[row["key"]]
    record.update(unregistered_above=None, real_rank=None, real_rank_max=None)
    return record


def cmd_build(args):
    cfg = load_config()
    tracked = [name.lower() for name in cfg["tracked"]]
    snapshots = load_snapshots()
    dates = [snapshot["date"] for snapshot in snapshots]
    n_days = len(dates)
    window = cfg["real_rank_max_absent_days"]

    players = {}
    history = {key: [] for key in tracked}
    absent_keys = []

    for day_index, snapshot in enumerate(snapshots):
        date = snapshot["date"]
        rankings = snapshot["rankings"]
        stats = snapshot.get("stats", {})
        paths = snapshot.get("paths", {})
        positions = index_by_key(rankings)
        bounds = compute_bounds(rankings, stats)
        last_day = day_index == n_days - 1

        for row in rankings:
            player = players.get(row["key"])
            if player is None:
                player = players[row["key"]] = new_player(row, date, n_days)
            player.update(name=row["name"], title=row["title"], last_seen=date, last_rank=row["rank"], last_active=date)
            player["ranks"][day_index] = row["rank"]
            note_stats(player, stats.get(row["key"]), date)
            player["lo"], player["hi"] = bounds[row["key"]]

        present = set(positions)
        for path, rows in paths.items():
            path_bounds = compute_bounds(rows, stats)
            for row in rows:
                player = players.get(row["key"])
                if player is None:
                    player = players[row["key"]] = new_player(row, date, n_days)
                player.update(path=path, last_active=date, last_path_rank=row["rank"])
                player["path_ranks"][day_index] = row["rank"]
                if row["key"] not in positions:  # only on the path list: bounds come from its neighbours there
                    player.update(name=row["name"], title=row["title"])
                    note_stats(player, stats.get(row["key"]), date)
                    player["lo"], player["hi"] = path_bounds[row["key"]]
                    if last_day:
                        player["today"] = path_only_record(date, row, stats.get(row["key"]), path_bounds)
                present.add(row["key"])

        def within_window(player):
            return window is None or (parse_date(date) - parse_date(player["last_active"])).days <= window

        absent_keys = [key for key, player in players.items() if key not in present and within_window(player)]
        absent = AbsentIndex(players[key] for key in absent_keys)

        for position, row in enumerate(rankings):
            record = daily_record(date, rankings, position, stats, bounds, absent)
            player = players[row["key"]]
            record["path"] = player["path"]
            record["path_rank"] = player["path_ranks"][day_index] or None
            if record["next"]:
                player["next"][day_index] = record["next"]["key"]
                if record["next"]["gap"] is not None:
                    player["gaps"][day_index] = record["next"]["gap"]
            player["unreg"][day_index] = record["unregistered_above"]
            player["unreg_max"][day_index] = record["real_rank_max"] - record["rank"]
            if row["key"] in history:
                history[row["key"]].append(record)
            if last_day:
                player["today"] = record
        for key in tracked:
            if key not in positions:
                history[key].append({"date": date, "rank": None, "power": None, "next": None})
        if last_day:
            for key, player in players.items():
                if key not in present:
                    player["today"] = None
                elif key not in positions:  # path-only today
                    player["today"].update(path=player["path"], path_rank=player["path_ranks"][day_index])

    keys = sorted(players)
    key_index = {key: index + 1 for index, key in enumerate(keys)}  # 1-based; 0 = none
    for player in players.values():
        player["next"] = [key_index[key] if key else 0 for key in player["next"]]

    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    history_payload = {
        "generated_at": generated_at,
        "source": RANKING_URL,
        "power_formula": "vita + 2 * mana",
        "snapshots": len(snapshots),
        "tracked": tracked,
        "players": {
            key: {
                "name": players[key]["name"] if key in players else cfg["tracked"][index],
                "title": players[key]["title"] if key in players else "",
                "history": history[key],
            }
            for index, key in enumerate(tracked)
        },
    }
    write_json(HISTORY_PATH, history_payload)
    log(f"Wrote {rel(HISTORY_PATH)} from {len(snapshots)} snapshot(s)")

    write_players(generated_at, dates, tracked, absent_keys, keys, players)
    present = sum(1 for player in players.values() if player.get("today"))
    log(f"Wrote {rel(PLAYERS_PATH)}: {len(players)} players known, {present} on the latest list, {len(absent_keys)} absent")


def write_players(generated_at, dates, tracked, absent_keys, keys, players):
    """players.json is large, so it is written compactly with one player per line."""
    PLAYERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    compact = {"separators": (",", ":"), "ensure_ascii": False}
    with PLAYERS_PATH.open("w", encoding="utf-8") as fh:
        fh.write("{\n")
        fh.write(f'"generated_at":{json.dumps(generated_at)},\n')
        fh.write('"power_formula":"vita + 2 * mana",\n')
        fh.write(f'"dates":{json.dumps(dates)},\n')
        fh.write(f'"tracked":{json.dumps(tracked)},\n')
        fh.write(f'"absent":{json.dumps(sorted(absent_keys))},\n')
        fh.write(f'"keys":{json.dumps(keys, **compact)},\n')
        fh.write('"players":{\n')
        for index, key in enumerate(keys):
            separator = "," if index < len(players) - 1 else ""
            fh.write(f"{json.dumps(key)}:{json.dumps(players[key], **compact)}{separator}\n")
        fh.write("}\n}\n")


# --------------------------------------------------------------------------- main


def main(argv=None):
    global CACHE_DIR
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("POWERRANK_CACHE_DIR"),
        help="cache fetched pages in this directory (for development; avoids re-hitting the site)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch", help="download and archive today's ranking")
    fetch.add_argument("--date", help="override the snapshot date (YYYY-MM-DD, default: today UTC)")
    fetch.add_argument("--max-lookups", type=int, help="override max_lookups_per_run for this run")
    fetch.set_defaults(func=cmd_fetch)
    build = sub.add_parser("build", help="rebuild data/history.json and data/players.json from snapshots")
    build.set_defaults(func=cmd_build)
    directory = sub.add_parser("directory", help="refresh A-Z, clan and subpath directory")
    directory.add_argument("--date", help="override the directory date (YYYY-MM-DD, default: today UTC)")
    directory.add_argument("--max-lookups", type=int, default=25, help="extra character stat lookups beyond the ranking lists (default: 25)")
    directory.set_defaults(func=cmd_directory)
    args = parser.parse_args(argv)
    if args.cache_dir:
        CACHE_DIR = Path(args.cache_dir)
    args.func(args)


if __name__ == "__main__":
    main()
