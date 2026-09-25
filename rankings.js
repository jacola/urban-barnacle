(function () {
  "use strict";

  const { fmt, pathName, pathPlural, el, link, seriesDelta, deltaNode, loadPlayers } = window.PR;
  const LIST_KEY = "powerrank.rankings.list";
  const METRIC_KEY = "powerrank.rankings.by";
  const LISTS = ["overall", "warrior", "rogue", "mage", "poet"];
  const METRICS = ["power", "vita", "mana"];
  const METRIC_LABELS = { power: "Power", vita: "Vita", mana: "Mana" };

  let data = null;
  let list = "overall";
  let metric = "power"; // "power" = the official ranking; "vita" / "mana" re-rank by that stat
  let sortKey = "rank";
  let sortDir = 1;
  let filter = "";
  let visibleOnly = false;
  let chart = null;

  // ------------------------------------------------------------------ state

  function readStored(key, allowed) {
    try {
      const stored = localStorage.getItem(key);
      if (allowed.includes(stored)) return stored;
    } catch (error) {
      /* ignore */
    }
    return null;
  }

  function readState() {
    const params = new URLSearchParams(location.hash.slice(1));
    const fromHash = params.get("list");
    list = LISTS.includes(fromHash) ? fromHash : readStored(LIST_KEY, LISTS) || "overall";
    const by = params.get("by");
    metric = METRICS.includes(by) ? by : readStored(METRIC_KEY, METRICS) || "power";
    filter = params.get("q") || "";
  }

  function persistState() {
    try {
      localStorage.setItem(LIST_KEY, list);
      localStorage.setItem(METRIC_KEY, metric);
    } catch (error) {
      /* ignore */
    }
    const params = [];
    if (list !== "overall") params.push(`list=${list}`);
    if (metric !== "power") params.push(`by=${metric}`);
    if (filter) params.push(`q=${encodeURIComponent(filter)}`);
    window.history.replaceState(null, "", location.pathname + location.search + (params.length ? `#${params.join("&")}` : ""));
  }

  // ------------------------------------------------------------------ rows

  // Today's players on the selected list.
  function baseRows() {
    const lastDay = data.dates.length - 1;
    const inPath = list !== "overall";
    const rows = [];
    for (const p of Object.values(data.players)) {
      const t = p.today;
      if (!t) continue;
      if (inPath ? p.path !== list || t.path_rank == null : t.rank == null) continue;
      rows.push({
        key: p.key,
        p,
        official: inPath ? t.path_rank : t.rank,
        rank: inPath ? t.path_rank : t.rank,
        delta: seriesDelta(inPath ? p.path_ranks : p.ranks, lastDay),
        power: t.power,
        vita: t.vita,
        mana: t.mana,
        status: t.stats_status,
        next: null,
        gap: null,
        between: 0,
      });
    }
    return rows;
  }

  // Official ranking order, with the gap to the nearest better-ranked player with
  // visible stats (ties share a rank and are skipped).
  function officialRows(rows) {
    rows.sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name));
    let lastVisible = null; // nearest visible player with a strictly better rank
    let groupVisible = null; // visible player within the current tie group
    let groupRank = null;
    let hiddenSince = 0;
    for (const row of rows) {
      if (row.rank !== groupRank) {
        if (groupVisible) {
          lastVisible = groupVisible;
          hiddenSince = 0;
        }
        groupRank = row.rank;
        groupVisible = null;
      }
      if (lastVisible) {
        row.next = lastVisible;
        row.between = hiddenSince;
        if (row.power != null) row.gap = lastVisible.power - row.power;
      }
      if (row.power != null) groupVisible = groupVisible || row;
      else hiddenSince++;
    }
    return { rows, unranked: 0 };
  }

  // Re-ranked by a single stat (competition ranking for ties); players without visible
  // stats cannot be placed and are left out.
  function statRows(rows) {
    const ranked = rows.filter((row) => row[metric] != null);
    ranked.sort((a, b) => b[metric] - a[metric] || a.official - b.official);
    let groupValue = null;
    let groupRank = 0;
    let groupFirst = null;
    let lastHigher = null; // nearest player with a strictly higher stat
    ranked.forEach((row, index) => {
      if (row[metric] !== groupValue) {
        if (groupFirst) lastHigher = groupFirst;
        groupValue = row[metric];
        groupRank = index + 1;
        groupFirst = row;
      }
      row.rank = groupRank;
      row.delta = null; // no history for stat-based ranks
      row.next = lastHigher;
      row.gap = lastHigher ? lastHigher[metric] - row[metric] : null;
      row.between = 0;
    });
    return { rows: ranked, unranked: rows.length - ranked.length };
  }

  function buildRows() {
    const rows = baseRows();
    return metric === "power" ? officialRows(rows) : statRows(rows);
  }

  function sortRows(rows) {
    if (sortKey === "rank") return rows;
    const value = (row) => (sortKey === "gap" ? row.gap : row[sortKey]);
    return [...rows].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av == null && bv == null) return a.rank - b.rank;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * sortDir || a.rank - b.rank;
    });
  }

  // ------------------------------------------------------------------ render

  function header(label, key, attrs = {}) {
    if (!key) return el("th", attrs, label);
    const active = sortKey === key;
    const title = attrs.title ? `${attrs.title} · click to sort` : `Sort by ${label.toLowerCase()}`;
    const th = el("th", { ...attrs, class: `${attrs.class || ""} sortable${active ? " active" : ""}`.trim(), title });
    th.append(el("button", { type: "button", onclick: () => setSort(key) }, label, active ? el("span", { class: "arrow" }, sortDir > 0 ? "▲" : "▼") : ""));
    return th;
  }

  function setSort(key) {
    if (sortKey === key) {
      if (key === "rank") sortDir = 1;
      else sortDir = -sortDir;
    } else {
      sortKey = key;
      sortDir = key === "rank" || key === "gap" ? 1 : -1; // biggest stats first, smallest gap first
    }
    render();
  }

  function renderChart(rows, maxRank) {
    const label = METRIC_LABELS[metric];
    const title = `${label} by rank`;
    const canvas = document.getElementById("rank-chart");
    const status = document.getElementById("chart-status");
    const points = rows
      .filter((row) => row[metric] != null)
      .sort((a, b) => a.rank - b.rank)
      .map((row) => ({ x: row.rank, y: row[metric], name: row.p.name }));

    document.getElementById("rank-chart-title").textContent = title;
    canvas.setAttribute("aria-label", `${title} for players with visible stats`);
    if (chart) {
      chart.destroy();
      chart = null;
    }
    if (!points.length || typeof Chart === "undefined") {
      canvas.hidden = true;
      status.textContent = points.length ? "Chart library failed to load." : "No players with visible stats match this selection.";
      status.hidden = false;
      return;
    }
    canvas.hidden = false;
    status.hidden = true;
    chart = new Chart(canvas, {
      type: "line",
      data: {
        datasets: [{
          data: points,
          borderColor: "#2563eb",
          backgroundColor: "#2563eb",
          borderWidth: 2,
          pointRadius: points.length > 200 ? 1 : 2,
          pointHoverRadius: 5,
          tension: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => items.length ? `#${items[0].raw.x} ${items[0].raw.name}` : "",
              label: (item) => `${label}: ${fmt(item.raw.y)}`,
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            min: 1,
            max: Math.max(2, maxRank),
            title: { display: true, text: metric === "power" ? "Official rank" : `Rank by ${label.toLowerCase()}` },
            ticks: { precision: 0 },
          },
          y: {
            title: { display: true, text: label },
            ticks: { callback: (value) => fmt(value) },
          },
        },
      },
    });
  }

  function render() {
    const inPath = list !== "overall";
    const byStat = metric !== "power";
    const table = document.getElementById("board");
    const tracked = new Set(data.tracked);
    const statClass = (name) => `num${metric === name ? " strong" : ""}`;

    table.tHead.replaceChildren(
      el(
        "tr",
        {},
        header("#", "rank", { class: "num", title: byStat ? `Rank by ${metric}` : "Official rank" }),
        header("Player"),
        header(inPath ? "Overall" : "Path", null, { class: inPath ? "num" : "" }),
        ...(byStat ? [el("th", { class: "num", title: inPath ? `Official rank among ${pathPlural(list)}` : "Official rank" }, inPath ? `${pathName(list)} #` : "Power #")] : []),
        header("Vita", "vita", { class: statClass("vita") }),
        header("Mana", "mana", { class: statClass("mana") }),
        header("Power", "power", { class: statClass("power") }),
        header(byStat ? `To next (${metric})` : "To next", "gap", { class: "num" }),
        ...(inPath || byStat ? [] : [el("th", { class: "num", title: "Official rank + unregistered players with higher last-known power" }, "Real")])
      )
    );

    const q = filter.trim().toLowerCase();
    const built = buildRows();
    let rows = built.rows;
    const total = rows.length;
    if (q) rows = rows.filter((row) => row.p.name.toLowerCase().includes(q));
    if (visibleOnly && !byStat) rows = rows.filter((row) => row.power != null);
    renderChart(rows, total ? Math.max(...built.rows.map((row) => row.rank)) : 1);
    rows = sortRows(rows);

    const body = rows.map((row) => {
      const p = row.p;
      const t = p.today;
      const tr = el("tr", { class: tracked.has(row.key) ? "tracked" : "" });
      const rankCell = el("td", { class: "num" }, `#${row.rank}`);
      if (row.delta != null) rankCell.append(deltaNode(row.delta));
      tr.append(rankCell);

      const playerCell = el("td", { class: "player" }, link(row.key, p.name));
      if (p.title) playerCell.append(" ", el("span", { class: "muted" }, p.title));
      playerCell.append(" ", el("a", { class: "chart-link", href: `./#p=${encodeURIComponent(row.key)}`, title: "Open in the tracker" }, "chart"));
      tr.append(playerCell);

      if (inPath) {
        tr.append(el("td", { class: "num" }, t.rank != null ? `#${t.rank}` : el("span", { class: "muted" }, "—")));
      } else {
        tr.append(el("td", {}, p.path ? `${pathName(p.path)}${t.path_rank != null ? ` #${t.path_rank}` : ""}` : el("span", { class: "muted" }, "—")));
      }
      if (byStat) tr.append(el("td", { class: "num muted" }, `#${row.official}`));

      if (row.power != null) {
        tr.append(el("td", { class: statClass("vita") }, fmt(row.vita)), el("td", { class: statClass("mana") }, fmt(row.mana)), el("td", { class: statClass("power") }, fmt(row.power)));
      } else {
        tr.append(el("td", { class: "muted status", colspan: 3 }, row.status === "no_page" ? "no character page" : row.status === "error" ? "lookup failed" : "stats hidden"));
      }

      const gapCell = el("td", { class: "num" });
      if (!row.next) {
        gapCell.append(el("span", { class: "muted" }, row.rank === 1 ? "top" : "—"));
      } else {
        if (row.gap != null) {
          gapCell.append(row.gap <= 0 ? el("span", { class: "muted", title: "Ranking not refreshed yet" }, fmt(row.gap)) : fmt(row.gap));
        } else {
          gapCell.append(el("span", { class: "muted" }, "?"));
        }
        const between = row.between > 0 ? `, ${row.between} hidden between` : "";
        gapCell.append(el("span", { class: "target", title: `${row.next.p.name} (#${row.next.rank}${between})` }, `→ ${row.next.p.name}`));
      }
      tr.append(gapCell);

      if (!inPath && !byStat) {
        const realCell = el("td", { class: "num" });
        if (t.real_rank != null) {
          realCell.append(`#${t.real_rank}`);
          if (t.real_rank_max != null && t.real_rank_max !== t.real_rank) realCell.append(el("span", { class: "uncertain" }, `–${t.real_rank_max}`));
        } else {
          realCell.append(el("span", { class: "muted" }, "—"));
        }
        tr.append(realCell);
      }
      return tr;
    });
    table.tBodies[0].replaceChildren(...body);
    document.getElementById("empty").hidden = rows.length > 0;
    document.getElementById("visible-only").disabled = byStat;

    const listName = inPath ? `top ${total + built.unranked} ${pathPlural(list)}` : `top ${total + built.unranked} overall`;
    const parts = [`As of ${data.dates[data.dates.length - 1]}`, listName];
    if (byStat) parts.push(`ranked by ${metric}`, `${fmt(built.unranked)} with hidden stats not ranked`);
    else parts.push(`${fmt(built.rows.filter((row) => row.power != null).length)} with visible stats`);
    if (rows.length !== total) parts.push(`showing ${fmt(rows.length)}`);
    document.getElementById("meta").textContent = `${parts.join(" · ")}.`;
  }

  // ------------------------------------------------------------------ main

  async function main() {
    try {
      data = await loadPlayers();
    } catch (error) {
      document.getElementById("meta").textContent = `No data yet (${error.message}).`;
      return;
    }
    readState();
    const syncControls = () => {
      document.querySelectorAll('input[name="list"]').forEach((input) => (input.checked = input.value === list));
      document.querySelectorAll('input[name="metric"]').forEach((input) => (input.checked = input.value === metric));
      document.getElementById("filter").value = filter;
    };
    document.querySelectorAll('input[name="list"]').forEach((input) => {
      input.addEventListener("change", () => {
        list = input.value;
        persistState();
        render();
      });
    });
    document.querySelectorAll('input[name="metric"]').forEach((input) => {
      input.addEventListener("change", () => {
        metric = input.value;
        sortKey = "rank";
        sortDir = 1;
        persistState();
        render();
      });
    });
    const filterInput = document.getElementById("filter");
    filterInput.addEventListener("input", () => {
      filter = filterInput.value;
      persistState();
      render();
    });
    document.getElementById("visible-only").addEventListener("change", (event) => {
      visibleOnly = event.target.checked;
      render();
    });
    window.addEventListener("hashchange", () => {
      readState();
      syncControls();
      render();
    });
    syncControls();
    render();
  }

  main();
})();
