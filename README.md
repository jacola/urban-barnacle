# NexusTK Power Rank Tracker

A GitHub Pages site that archives the NexusTK
[Top 1000 of Nexus](http://users.nexustk.com/webreport/PowerAll.htm) power
ranking once a day and charts the rank of any character over time, including
how much power they need to reach the next rank and their **real rank**
(what their rank would be if currently unregistered players were counted).

Power is calculated as `vita + 2 * mana`, using the stats that players expose
on their character pages.

## What the site shows

* **Search box** – type a name to add any character who has ever appeared on
  the list; press **×** on a card to remove it. The selection is kept in the
  URL (`#p=inkey,aero`) and in the browser, so links are shareable.
  *Reset to defaults* restores the characters listed in `config.json`.
* **Cards** – current rank and daily change, real rank (with the list of
  unregistered players above), power needed to pass the next player, and
  the character's stats.
* **Chart** – official rank over time (1 at the top); optional dashed
  real-rank lines.
* **History table** – rank, real rank and power to next per day for every
  selected character.

### Real rank

Players who unregister disappear from the official list. Every player's
last-known power is cached, so *real rank* = official rank + number of
missing players whose last-known power is higher. For players who hide their
stats, power is bounded by the nearest visible neighbours, which can produce
an uncertain range (`#38–#40`). `real_rank_max_absent_days` in `config.json`
limits how long a missing player keeps counting (default: forever).

### Power to next

Many players hide their stats, so "power to next" is measured against the
nearest better-ranked player whose stats are visible (the number of hidden
players skipped is shown). Tied ranks are skipped because they share the same
power.

## Layout

| Path | Purpose |
| --- | --- |
| `config.json` | Characters with full daily tracking, and fetch settings. |
| `scripts/powerrank.py` | Stdlib-only Python: `fetch` archives today's data, `build` regenerates the site data. |
| `data/raw/YYYY-MM-DD.htm` | Raw archived copy of the ranking page. |
| `data/snapshots/YYYY-MM-DD.json` | Parsed ranking (all 1000 rows) plus every character stat looked up that day. Source of truth. |
| `data/players.json` | Per-player daily series (rank, power to next, real-rank extras), current state and last-known power for every player ever seen. What the site reads. Derived. |
| `data/history.json` | Human-readable daily record (stats, next player, real rank) for the `config.json` characters. Derived. |
| `index.html`, `app.js`, `style.css` | The static site (Chart.js via CDN). |
| `.github/workflows/fetch.yml` | Daily cron: fetch + build, then commit the result. |

## Setup

1. Push this directory to the `main` branch of a GitHub repository.
2. **Settings → Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. **Actions** tab: run "Daily ranking snapshot" once via *Run workflow* to
   confirm it works (it takes ~20 minutes because of the character lookups).
   Afterwards it runs every day at 06:23 UTC.

The site is then served at `https://<user>.github.io/<repo>/`.

> GitHub disables cron workflows in repositories with no activity for 60 days.
> The bot's daily commits normally keep it alive, but if the chart stops
> updating, check the Actions tab and re-enable the workflow.

## Configuration (`config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `tracked` | – | Characters selected by default on the site; their stats and neighbours are always looked up first, and they get a readable record in `history.json`. Add or remove names at any time; `build` back-fills from the archived snapshots. |
| `request_delay_seconds` | `1.0` | Pause between requests to the site. |
| `stats_refresh_days` | `1` | Re-fetch a character page only if the last lookup is at least this many days old. |
| `max_lookups_per_run` | `1100` | Safety cap on character lookups per run (tracked characters and their neighbours are always looked up first). |
| `max_lookups_above` | `10` | How far to walk up the list past hidden stats to find the "next" player. |
| `max_consecutive_errors` | `20` | Stop looking up stats for the day after this many consecutive failures. |
| `min_rows` | `500` | Refuse to archive a ranking page with fewer rows (guards against error pages). |
| `real_rank_max_absent_days` | `null` | Ignore missing players last seen more than this many days ago when computing real rank. |

## Running locally

```sh
python3 scripts/powerrank.py --cache-dir .cache fetch   # archive today's page + stats
python3 scripts/powerrank.py build                       # regenerate data/history.json and data/players.json
python3 -m http.server 8000                              # open http://localhost:8000
```

`--cache-dir` (or `POWERRANK_CACHE_DIR`) stores every fetched page locally so
repeated development runs never re-hit the site. `fetch --max-lookups N`
limits character lookups for a quick run.

`players.json` holds one value per player per day for each series, so it grows
by roughly 7 MB (about 1 MB gzipped) per year of snapshots. If that ever gets
unwieldy the series can be split into one file per year.

### Load on users.nexustk.com

The daily job makes one request for the ranking page and one request per
ranked character (~1000 static HTML files, fetched directly from
`/userfiles/<name>.html` rather than through the redirecting CGI), paced by
`request_delay_seconds`. Set `stats_refresh_days` to e.g. `7` to spread the
lookups over a week (~150 per day) if you want to be lighter on the site;
tracked characters and their neighbours are still refreshed daily.
