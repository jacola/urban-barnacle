(function () {
  "use strict";
  const { fmt, el, link, pathName, loadPlayers } = window.PR;
  const PAGE_SIZE = 200;
  const UNKNOWN = "Unknown";
  const MARKS = ["Sa San", "Sam San", "Ee San", "Il San", "Level 99", "Below 99", UNKNOWN];
  const PATHS = ["Warrior", "Rogue", "Mage", "Poet", UNKNOWN];
  const SUBPATHS = ["Barbarian", "Chongun", "Do", "Merchant", "Ranger", "Spy", "Diviner", "Geomancer", "Shaman", "Druid", "Monk", "Muse", UNKNOWN];
  const SUBPATH_PATH = {
    Barbarian: "warrior", Chongun: "warrior", Do: "warrior",
    Merchant: "rogue", Ranger: "rogue", Spy: "rogue",
    Diviner: "mage", Geomancer: "mage", Shaman: "mage",
    Druid: "poet", Monk: "poet", Muse: "poet",
  };
  const ACTIVITY = ["active", "inactive", "absent", UNKNOWN];
  const REGISTRATION = ["registered", "unregistered", UNKNOWN];
  const EVIDENCE = ["Observed", "Last known", "Rank bounds", "Mark minimum", UNKNOWN];
  const RANKING = ["Top 1000", "Path Top 250 only", "Outside rankings"];
  const ICONS = {
    marks: { "Il San": "il", "Ee San": "ee", "Sam San": "sam", "Sa San": "sa" },
    paths: new Set(["Warrior", "Rogue", "Mage", "Poet"]),
    subpaths: new Set(SUBPATHS.filter((name) => name !== UNKNOWN)),
  };
  const FILTERS = [
    { id: "ranking", label: "Ranking", options: RANKING },
    { id: "evidence", label: "Power", options: EVIDENCE },
    { id: "path", label: "Path", options: PATHS },
    { id: "subpath", label: "Subpath", options: SUBPATHS },
    { id: "mark", label: "Mark", options: MARKS },
    { id: "clan", label: "Clan", options: [] },
    { id: "activity", label: "Activity", options: ACTIVITY },
    { id: "registration", label: "Registration", options: REGISTRATION },
  ];
  const COLUMNS = [
    { id: "name", label: "Player", text: true },
    { id: "power", label: "Power", number: true },
    { id: "vita", label: "Vita", number: true },
    { id: "mana", label: "Mana", number: true },
    { id: "rank", label: "Official #", number: true },
    { id: "pathRank", label: "Path #", number: true },
    { id: "path", label: "Path", text: true },
    { id: "subpath", label: "Subpath", text: true },
    { id: "mark", label: "Mark", defaultDesc: true },
    { id: "clan", label: "Clan", text: true },
    { id: "lastActive", label: "Last active", defaultDesc: true },
    { id: "gap", label: "To next", number: true },
  ];

  let rows = [];
  let shown = PAGE_SIZE;
  let directoryDate = "";
  let rankingDate = "";
  let sortKey = "rank";
  let sortDir = 1;
  let chart = null;
  const selected = {};

  function markGroup(mark) {
    if (!mark) return UNKNOWN;
    return /^Level \d+$/i.test(mark) && mark !== "Level 99" ? "Below 99" : mark;
  }

  function lastActive(activity) {
    if (!activity || !directoryDate) return { label: "—", sort: null, title: "No activity information in the membership lists" };
    const checked = new Date(`${directoryDate}T00:00:00Z`);
    const daysAgo = (days) => new Date(checked.getTime() - days * 86400000);
    const shortDate = (date) => new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", ...(date.getUTCFullYear() !== checked.getUTCFullYear() ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(date);
    const fifteen = daysAgo(15), thirty = daysAgo(30);
    const label = activity === "active" ? `${shortDate(fifteen)}–${shortDate(checked)}`
      : activity === "inactive" ? `${shortDate(thirty)}–${shortDate(fifteen)}`
      : activity === "absent" ? `Before ${shortDate(thirty)}` : "—";
    const newest = activity === "active" ? checked : activity === "inactive" ? fifteen : activity === "absent" ? thirty : null;
    return { label, sort: newest?.getTime() ?? null,
      title: `Estimated from the ${activity} activity indicator checked ${directoryDate}; no exact login date is published` };
  }

  function evidence(row) {
    if (row.today?.power != null) return { kind: "Observed", value: row.today.power, date: rankingDate };
    if (row.stats) return { kind: row.stats.date < directoryDate ? "Last known" : "Observed", value: row.stats.power, date: row.stats.date };
    // Ranking bounds are possible power values, not a measured stat.
    const lo = row.today?.lo;
    const hi = row.today?.hi;
    if (row.rank != null && (lo > 0 || hi != null)) {
      return { kind: "Rank bounds", lo: Math.max(lo || 0, row.min_power || 0), hi };
    }
    if (row.min_power != null) return { kind: "Mark minimum", lo: row.min_power };
    return { kind: UNKNOWN };
  }

  function evidenceText(e) {
    if (e.value != null) return `${fmt(e.value)}${e.kind === "Last known" ? " (last known)" : ""}`;
    if (e.kind === "Rank bounds") {
      if (e.hi == null) return `≥ ${fmt(e.lo)}`;
      if (e.lo <= 0) return `≤ ${fmt(e.hi)}`;
      return `${fmt(e.lo)}–${fmt(e.hi)}`;
    }
    return e.lo != null ? `≥ ${fmt(e.lo)}` : "—";
  }

  function icon(type, name) {
    const file = type === "marks" ? ICONS.marks[name] : name.toLowerCase();
    if (!file || (type !== "marks" && !ICONS[type].has(name))) return null;
    return el("img", { class: type === "marks" ? "mark-icon" : type === "subpaths" ? "subpath-icon" : "player-icon",
      src: `assets/${type}/${file}.${type === "paths" ? "gif" : "png"}`,
      alt: type === "marks" || type === "subpaths" ? name : "", title: type === "marks" || type === "subpaths" ? name : "", loading: "lazy" });
  }

  function values(row, field) {
    switch (field) {
      case "ranking": return [row.rank != null ? "Top 1000" : row.pathRank != null ? "Path Top 250 only" : "Outside rankings"];
      case "evidence": return [row.evidence.kind];
      case "path": return [row.path ? pathName(row.path) : UNKNOWN];
      case "subpath": return row.subpaths.length ? row.subpaths : [UNKNOWN];
      case "mark": return [markGroup(row.mark)];
      case "clan": return row.clans.length ? row.clans : [UNKNOWN];
      case "activity": return [row.activity || UNKNOWN];
      case "registration": return [row.registration || UNKNOWN];
      default: return [UNKNOWN];
    }
  }

  function filtered() {
    const query = document.getElementById("directory-search").value.trim().toLocaleLowerCase();
    return rows.filter((row) => (!query || row.name.toLocaleLowerCase().includes(query)) &&
      FILTERS.every((filter) => values(row, filter.id).some((value) => selected[filter.id].has(value))));
  }

  function sortValue(row, key) {
    switch (key) {
      case "name": return row.name;
      case "power": return row.evidence.value ?? row.evidence.lo ?? row.evidence.hi ?? null;
      case "vita": return row.today?.vita ?? row.stats?.vita ?? null;
      case "mana": return row.today?.mana ?? row.stats?.mana ?? null;
      case "rank": return row.rank;
      case "pathRank": return row.pathRank;
      case "path": return row.path ? pathName(row.path) : null;
      case "subpath": return row.subpaths[0];
      case "mark": return { "Sa San": 4, "Sam San": 3, "Ee San": 2, "Il San": 1 }[row.mark] ?? (/^Level \d+$/.test(row.mark || "") ? Number(row.mark.slice(6)) / 100 : null);
      case "clan": return row.clans[0];
      case "lastActive": return row.lastActive.sort;
      case "gap": return row.today?.next?.gap;
      default: return null;
    }
  }

  function compare(a, b) {
    // Exact and last-known figures, bounds, and minima cannot be interleaved as
    // if all three represented a measured current value.
    if (sortKey === "power") {
      const order = { Observed: 0, "Last known": 1, "Rank bounds": 2, "Mark minimum": 3, [UNKNOWN]: 4 };
      const group = order[a.evidence.kind] - order[b.evidence.kind];
      if (group) return group;
    }
    const av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
    if (av == null && bv != null) return 1;
    if (bv == null && av != null) return -1;
    let result = 0;
    if (av != null && bv != null) result = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
    return result * sortDir || a.name.localeCompare(b.name);
  }

  function renderHeader() {
    const tr = el("tr");
    for (const col of COLUMNS) {
      const active = sortKey === col.id;
      const button = el("button", { type: "button", onclick: () => {
        sortDir = sortKey === col.id ? -sortDir : col.defaultDesc ? -1 : col.text || col.id === "rank" || col.id === "pathRank" || col.id === "gap" ? 1 : -1;
        sortKey = col.id;
        shown = PAGE_SIZE;
        render();
      }, "aria-label": `Sort by ${col.label}${active ? (sortDir > 0 ? ", ascending" : ", descending") : ""}` },
      col.label, active ? el("span", { class: "arrow" }, sortDir > 0 ? "▲" : "▼") : "");
      tr.append(el("th", { class: `${col.number ? "num " : ""}sortable${active ? " active" : ""}` }, button));
    }
    document.getElementById("directory-head").replaceChildren(tr);
  }

  function renderRow(row) {
    const e = row.evidence;
    const player = el("td", { class: "player", title: row.sources.join(" · ") }, link(row.key, row.name));
    if (row.tracked) player.append(" ", el("a", { class: "chart-link", href: `./#p=${encodeURIComponent(row.key)}` }, "chart"));
    const powerTitle = e.value != null ? `Vita + 2 × mana, checked ${e.date}` : e.kind === "Rank bounds" ? "Inferred from neighbours on the overall ranking" : e.kind === "Mark minimum" ? `Minimum inferred from ${row.mark}` : "No public power evidence";
    const subpath = el("td", { title: row.subpaths.join(", ") }, ...row.subpaths.map((name) => icon("subpaths", name)).filter(Boolean));
    if (!row.subpaths.length) subpath.append("—");
    const mark = el("td", {}, icon("marks", row.mark) || row.mark || "—");
    const path = row.path ? pathName(row.path) : null;
    return el("tr", { class: row.tracked ? "tracked" : "" },
      player,
      el("td", { class: "num", title: powerTitle }, evidenceText(e)),
      el("td", { class: "num", title: row.stats ? `Stats checked ${row.stats.date}` : "" }, sortValue(row, "vita") != null ? fmt(sortValue(row, "vita")) : "—"),
      el("td", { class: "num", title: row.stats ? `Stats checked ${row.stats.date}` : "" }, sortValue(row, "mana") != null ? fmt(sortValue(row, "mana")) : "—"),
      el("td", { class: "num" }, row.rank != null ? `#${row.rank}` : "—"),
      el("td", { class: "num" }, row.pathRank != null ? `#${row.pathRank}` : "—"),
      el("td", { title: row.inferredPath ? "Path inferred from the listed subpath" : "" }, path ? icon("paths", path) : "", path || "—"), subpath, mark,
      el("td", {}, row.clans.join(", ") || "—"),
      el("td", { title: row.lastActive.title }, row.lastActive.label),
      el("td", { class: "num" }, row.today?.next?.gap != null ? fmt(row.today.next.gap) : "—"));
  }

  function render() {
    renderHeader();
    const matches = filtered().sort(compare);
    document.getElementById("directory-body").replaceChildren(...matches.slice(0, shown).map(renderRow));
    document.getElementById("directory-count").textContent = `Showing ${fmt(Math.min(shown, matches.length))} of ${fmt(matches.length)} matching players (${fmt(rows.length)} known).`;
    document.getElementById("directory-more").hidden = shown >= matches.length;
    renderChart(matches);
  }

  function renderChart(matches) {
    const list = document.getElementById("chart-list").value;
    const metric = document.getElementById("chart-metric").value;
    const label = { power: "Power", vita: "Vita", mana: "Mana" }[metric];
    const rankKey = list === "overall" ? "rank" : "pathRank";
    const ranked = matches.filter((row) => row[rankKey] != null && (list === "overall" || row.path === list));
    const visible = ranked.filter((row) => row.today?.[metric] != null);
    if (metric !== "power") visible.sort((a, b) => b.today[metric] - a.today[metric] || a[rankKey] - b[rankKey]);
    const points = visible.map((row, i) => ({
      x: metric === "power" ? row[rankKey] : i > 0 && row.today[metric] === visible[i - 1].today[metric] ? null : i + 1,
      y: row.today[metric], name: row.name,
    }));
    // Players tied on vita or mana share the same competition rank.
    if (metric !== "power") {
      let tiedRank = 1;
      points.forEach((point) => { if (point.x == null) point.x = tiedRank; else tiedRank = point.x; });
    }
    points.sort((a, b) => a.x - b.x || a.name.localeCompare(b.name));
    const title = `${label} by ${metric === "power" ? "official" : label.toLowerCase()} ${list === "overall" ? "rank" : `${pathName(list)} rank`}`;
    const canvas = document.getElementById("rank-chart");
    const status = document.getElementById("chart-status");
    document.getElementById("rank-chart-title").textContent = title;
    canvas.setAttribute("aria-label", `${title} for players with visible stats`);
    if (chart) { chart.destroy(); chart = null; }
    if (!points.length || typeof Chart === "undefined") {
      canvas.hidden = true;
      status.textContent = points.length ? "Chart library failed to load." : "No ranked players with visible stats match these filters.";
      status.hidden = false;
      return;
    }
    canvas.hidden = false;
    status.hidden = true;
    chart = new Chart(canvas, {
      type: "line",
      data: { datasets: [{ data: points, borderColor: "#2563eb", backgroundColor: "#2563eb", borderWidth: 2,
        pointRadius: points.length > 200 ? 1 : 2, pointHoverRadius: 5, tension: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: (items) => items.length ? `#${items[0].raw.x} ${items[0].raw.name}` : "",
          label: (item) => `${label}: ${fmt(item.raw.y)}`,
        } } },
        scales: {
          x: { type: "linear", min: 1, max: Math.max(2, metric === "power" ? (list === "overall" ? 1000 : 250) : visible.length),
            title: { display: true, text: metric === "power" ? "Official rank" : `Rank by ${label.toLowerCase()}` }, ticks: { precision: 0 } },
          y: { title: { display: true, text: label }, ticks: { callback: (value) => fmt(value) } },
        },
      },
    });
  }

  function updateFilterSummary(filter, summary) {
    const count = selected[filter.id].size;
    summary.textContent = `${filter.label}: ${count === filter.options.length ? "All" : count === 0 ? "None" : `${count}/${filter.options.length}`}`;
  }

  function renderFilters() {
    const container = document.getElementById("directory-filters");
    container.replaceChildren();
    for (const filter of FILTERS) {
      selected[filter.id] = new Set(filter.options);
      const details = el("details", { class: "filter-menu" });
      const summary = el("summary");
      updateFilterSummary(filter, summary);
      const choices = el("div", { class: "filter-choices" });
      const actions = el("div", { class: "filter-actions" });
      for (const [label, checked] of [["All", true], ["None", false]]) {
        actions.append(el("button", { type: "button", onclick: () => {
          choices.querySelectorAll('input[type="checkbox"]').forEach((input) => (input.checked = checked));
          selected[filter.id] = checked ? new Set(filter.options) : new Set();
          updateFilterSummary(filter, summary);
          shown = PAGE_SIZE;
          render();
        } }, label));
      }
      choices.append(actions);
      for (const option of filter.options) {
        const input = el("input", { type: "checkbox", checked: "", value: option });
        input.addEventListener("change", () => {
          if (input.checked) selected[filter.id].add(option);
          else selected[filter.id].delete(option);
          updateFilterSummary(filter, summary);
          shown = PAGE_SIZE;
          render();
        });
        choices.append(el("label", {}, input, option));
      }
      details.append(summary, choices);
      container.append(details);
    }
  }

  async function main() {
    try {
      const [directory, ranked] = await Promise.all([fetch("data/directory.json", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("Directory not fetched yet");
        return response.json();
      }), loadPlayers()]);
      directoryDate = directory.date;
      rankingDate = ranked.dates.at(-1);
      const tracked = new Set(ranked.tracked);
      const keys = new Set([...Object.keys(directory.entries), ...Object.keys(ranked.players)]);
      rows = [...keys].map((key) => {
        const entry = directory.entries[key] || {};
        const p = ranked.players[key];
        const today = p?.today;
        const stats = [p?.stats, entry.stats].filter(Boolean).sort((a, b) => b.date.localeCompare(a.date))[0];
        const subpaths = entry.subpaths || [];
        const mappedPaths = [...new Set(subpaths.map((name) => SUBPATH_PATH[name]).filter(Boolean))];
        const inferredPath = !today?.path_rank && mappedPaths.length === 1;
        const row = {
          key, name: entry.name || p?.name || key, mark: entry.level_mark,
          min_power: entry.min_power, activity: entry.activity, registration: entry.registration,
          clans: entry.clans || [], subpaths,
          sources: (entry.sources || []).map((source) => directory.source_urls?.[source] || source),
          path: inferredPath ? mappedPaths[0] : p?.path, inferredPath,
          rank: today?.rank, pathRank: today?.path_rank,
          today, stats, tracked: tracked.has(key),
        };
        row.evidence = evidence(row);
        row.lastActive = lastActive(row.activity);
        return row;
      });
      FILTERS.find((filter) => filter.id === "clan").options = [...new Set(rows.flatMap((row) => row.clans))].sort().concat(UNKNOWN);
      renderFilters();
      document.getElementById("directory-meta").textContent = `Rankings ${rankingDate} · directory ${directoryDate}.`;
      document.getElementById("directory-search").addEventListener("input", () => { shown = PAGE_SIZE; render(); });
      for (const id of ["chart-list", "chart-metric"]) document.getElementById(id).addEventListener("change", () => renderChart(filtered()));
      document.getElementById("directory-more").addEventListener("click", () => { shown += PAGE_SIZE; render(); });
      document.getElementById("directory-reset").addEventListener("click", () => {
        document.getElementById("directory-search").value = "";
        sortKey = "rank";
        sortDir = 1;
        shown = PAGE_SIZE;
        renderFilters();
        render();
      });
      render();
    } catch (error) {
      document.getElementById("directory-meta").textContent = error.message;
    }
  }
  main();
})();
