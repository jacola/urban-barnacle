# NexusTK Power Rank Tracker

A GitHub Pages site that archives the NexusTK
[Top 1000 of Nexus](http://users.nexustk.com/webreport/PowerAll.htm) power
ranking (and the per-path Top 250 pages) once a day and charts the rank of any
character over time, including how much power they need to reach the next
rank, their rank **within their path**, and their **real rank** (what their
rank would be if currently unregistered players were counted).

Power is calculated as `vita + 2 * mana`, using the stats that players expose
on their character pages.

## What the site shows

The **Tracker** (`index.html`) follows selected characters over time.
**Players** (`directory.html`) joins the official Top 1000 and per-path Top 250
with the A–Z character indexes and the clan/subpath lists linked from
[Nexus Atlas](https://www.nexusatlas.com/userlist.php). Its columns sort by
name, numeric power, vita, mana, official and path rank, path, subpath, mark,
clan, activity, registration and power to next. Checkbox menus filter multiple
values within each category, including unknown values. Power evidence is
separated into observed values, last-known values, ranking bounds, mark
minimums and unknowns; sorting never treats a minimum as an exact stat.
Path/subpath and mark artwork is copied locally from Nexus Atlas, including
the [subpath index](https://www.nexusatlas.com/subpaths/index.php) and the
[mark quests](https://www.nexusatlas.com/quests/index.php). The page crops
the mark artwork to show only its symbol. The chart below the unified table
uses the same search and filters, with overall/path and power/vita/mana
controls. Only ranked players with visible stats can be plotted by rank.

The old `rankings.html` address redirects to the chart on Players.

* **Search box** – type a name to add any character who has ever appeared on
  the list; press **×** on a card to remove it. The selection is kept in the
  URL (`#p=inkey,aero`) and in the browser, so links are shareable.
  *Reset to defaults* restores the characters listed in `config.json`.
* **Overall / Within path** – switches the cards, the "to pass" tables and
  the chart between the overall Top 1000 and the character's path Top 250
  (Warriors, Rogues, Mages, Poets). Kept in the URL as `view=path`.
* **Cards** – current rank and daily change (both overall and within path),
  real rank (with the list of unregistered players above), the nearest five
  better-ranked players with visible stats and the power needed to pass each,
  and the character's stats.
* **Chart** – rank over time (1 at the top) for the last 7, 30 or 365 days
  of snapshots (1w / 1m / 1y); the selected period is remembered. In the
  overall view, *Show real rank* replaces the official-rank lines with
  real-rank lines.
* **History table** – overall rank, path rank, real rank and power to next
  per day for every selected character.

### Real rank

Players who unregister disappear from the official list. Every player's
last-known power is cached, so *real rank* = official rank + number of
missing players whose last-known power is higher. For players who hide their
stats, power is bounded by the nearest visible neighbours, which can produce
an uncertain range (`#38–#40`). `real_rank_max_absent_days` in `config.json`
limits how long a missing player keeps counting (default: forever).

### Path rank

The four per-path pages each list a Top 250. They add only a handful of
characters that are not already in the overall Top 1000, but they reveal each
player's path and exact rank within it. A player who drops out of the overall
Top 1000 but is still on a path page is still registered and is not counted
as unregistered for real rank.

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
| `data/raw/YYYY-MM-DD.htm`, `YYYY-MM-DD-<path>.htm` | Raw archived copies of the overall and per-path ranking pages. |
| `data/snapshots/YYYY-MM-DD.json` | Parsed rankings (overall and per path) plus every character stat looked up that day. Source of truth. |
| `data/players.json` | Per-player daily series (rank, power to next, real-rank extras), current state and last-known power for every player ever seen. What the site reads. Derived. |
| `data/directory.json` | Latest full directory with links to its A–Z and clan/subpath sources, refreshed daily. Activity and membership are a current snapshot rather than historical rank data. |
| `data/history.json` | Human-readable daily record (stats, next player, real rank) for the `config.json` characters. Derived. |
| `index.html`, `app.js` | The tracker page (Chart.js via CDN). |
| `rankings.html` | Redirect from the former separate rankings page to the Players chart. |
| `common.js`, `style.css` | Shared helpers and styles. |
| `.github/workflows/fetch.yml` | Daily cron: fetch + build + directory, then commit the result. |

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
| `min_path_rows` | `100` | Skip a per-path page with fewer rows for the day. |
| `real_rank_max_absent_days` | `null` | Ignore missing players last seen more than this many days ago when computing real rank. |

## Running locally

```sh
python3 scripts/powerrank.py --cache-dir .cache fetch   # archive today's page + stats
python3 scripts/powerrank.py build                       # regenerate data/history.json and data/players.json
python3 scripts/powerrank.py directory                   # fetch all A-Z and clan/subpath lists
python3 -m http.server 8000                              # open http://localhost:8000
```

`--cache-dir` (or `POWERRANK_CACHE_DIR`) stores every fetched page locally so
repeated development runs never re-hit the site. `fetch --max-lookups N`
limits character lookups for a quick run.

`players.json` holds one value per player per day for each series, so it grows
by roughly 7 MB (about 1 MB gzipped) per year of snapshots. If that ever gets
unwieldy the series can be split into one file per year.

### Load on users.nexustk.com

The directory job also checks up to 25 additional registered characters per
day outside the ranking lists, carrying those stats forward in `directory.json`.
Use `directory --max-lookups 0` for a source-only refresh.

The daily job makes five requests for the ranking pages, 55 requests for the
26 A–Z and 29 clan/subpath pages (four concurrent), and one request per
ranked character (~1060 static HTML files, fetched directly from
`/userfiles/<name>.html` rather than through the redirecting CGI), paced by
`request_delay_seconds`. Set `stats_refresh_days` to e.g. `7` to spread the
lookups over a week (~150 per day) if you want to be lighter on the site;
tracked characters and their neighbours are still refreshed daily.

The official membership legend defines active as played within 15 days,
inactive as 15–30 days, and absent as 30+ days. It does not provide a precise
last-login timestamp. A–Z entries show only names and titles; a missing mark
or activity means unknown. Mark lower bounds follow the game's Il/Ee/Sam/Sa
San requirements (160k/320k/640k/1.28m power); a player can have much more.
