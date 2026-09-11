(function () {
  "use strict";

  const { fmt, pathName, pathPlural, el, link, seriesDelta, deltaNode, loadPlayers } = window.PR;
  const COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];
  const STORAGE_KEY = "powerrank.selected";
  const VIEW_KEY = "powerrank.view";
  const TABLE_ROWS = 30;
  const NEXT_ROWS = 5;

  // data.players: players.json - per-player daily series (rank, path rank, gap to next,
  // real-rank extras) plus current state for every player who has ever appeared on a list.
  const data = { players: null };
  let selected = [];
  let view = "overall"; // "overall" ranks or "path" (rank within the player's path Top 250)
  let chart = null;
  let showAllRows = false;

  // ------------------------------------------------------------------ helpers

  function player(key) {
    return data.players.players[key];
  }

  function color(index) {
    return COLORS[index % COLORS.length];
  }

  // Rank on the given day index, or null when the player was not on the list.
  function rankOn(p, dayIndex) {
    return p.ranks[dayIndex] || null;
  }

  // Rank within the player's path Top 250 on that day, or null.
  function pathRankOn(p, dayIndex) {
    return p.path_ranks[dayIndex] || null;
  }

  // Rank in the current view (overall or within path).
  function viewRankOn(p, dayIndex) {
    return view === "path" ? pathRankOn(p, dayIndex) : rankOn(p, dayIndex);
  }

  // Official rank plus unregistered players definitely above; max includes uncertain ones.
  function realRankOn(p, dayIndex) {
    const rank = rankOn(p, dayIndex);
    return rank == null ? null : { rank: rank + p.unreg[dayIndex], max: rank + p.unreg_max[dayIndex] };
  }

  // Nearest better-ranked player with visible stats on that day, and the power needed to pass them.
  function nextOn(p, dayIndex) {
    const index = p.next[dayIndex];
    if (!index) return null;
    const key = data.players.keys[index - 1];
    const q = player(key);
    const rank = rankOn(q, dayIndex);
    const own = rankOn(p, dayIndex);
    return { key, name: q.name, rank, gap: p.gaps[dayIndex] || null, between: rank != null && own != null ? own - rank - 1 : 0 };
  }

  // Change versus the previous day the player had a value in the series (positive = climbed).
  function delta(p, dayIndex, series = rankOn) {
    return seriesDelta(series === pathRankOn ? p.path_ranks : p.ranks, dayIndex);
  }

  // Absent (unregistered) players whose last-known power is above this player's bounds today.
  function unregisteredAbove(p) {
    const today = p.today;
    const definite = [];
    const possible = [];
    if (!today) return { definite, possible };
    for (const key of data.players.absent) {
      const other = player(key);
      if (!other) continue;
      if (today.hi != null && other.lo > today.hi) definite.push(other);
      else if (other.hi == null || other.hi > today.lo) possible.push(other);
    }
    const byPower = (a, b) => (b.lo || 0) - (a.lo || 0);
    definite.sort(byPower);
    possible.sort(byPower);
    return { definite, possible };
  }

  // ------------------------------------------------------------------ selection & view

  function readSelection() {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("p");
    if (fromHash) return fromHash.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(stored)) return stored;
    } catch (error) {
      /* ignore corrupt storage */
    }
    return [...data.players.tracked];
  }

  function readView() {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("view");
    if (fromHash === "path" || fromHash === "overall") return fromHash;
    try {
      if (localStorage.getItem(VIEW_KEY) === "path") return "path";
    } catch (error) {
      /* ignore */
    }
    return "overall";
  }

  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
      localStorage.setItem(VIEW_KEY, view);
    } catch (error) {
      /* storage unavailable */
    }
    const params = [];
    if (selected.length) params.push(`p=${selected.join(",")}`);
    if (view === "path") params.push("view=path");
    window.history.replaceState(null, "", location.pathname + location.search + (params.length ? `#${params.join("&")}` : ""));
  }

  function addPlayer(key) {
    if (!player(key) || selected.includes(key)) return;
    selected.push(key);
    persistState();
    render();
  }

  function removePlayer(key) {
    selected = selected.filter((k) => k !== key);
    persistState();
    render();
  }

  function resetSelection() {
    selected = [...data.players.tracked];
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      /* ignore */
    }
    persistState();
    render();
  }

  function setView(next) {
    view = next;
    document.querySelectorAll('input[name="view"]').forEach((input) => (input.checked = input.value === view));
    document.getElementById("show-real").disabled = view === "path";
    persistState();
    render();
  }

  // ------------------------------------------------------------------ search

  function setupSearch() {
    const input = document.getElementById("search");
    const list = document.getElementById("suggestions");
    const everyone = Object.entries(data.players.players).map(([key, p]) => ({ key, ...p }));

    function matches(query) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const rows = everyone.filter((p) => !selected.includes(p.key) && p.name.toLowerCase().includes(q));
      rows.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q);
        const bStarts = b.name.toLowerCase().startsWith(q);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        const aRank = a.today ? a.today.rank : 100000 + a.last_rank;
        const bRank = b.today ? b.today.rank : 100000 + b.last_rank;
        return aRank - bRank;
      });
      return rows.slice(0, 12);
    }

    function show() {
      const rows = matches(input.value);
      list.replaceChildren();
      if (!input.value.trim()) {
        list.hidden = true;
        return;
      }
      if (!rows.length) {
        list.append(el("li", { class: "empty" }, "No player with that name has appeared on the list."));
      }
      for (const p of rows) {
        const status = p.today
          ? [p.today.rank != null ? `#${p.today.rank}` : null, p.today.path_rank != null ? `${pathName(p.path)} #${p.today.path_rank}` : null].filter(Boolean).join(" · ")
          : `last seen ${p.last_active}`;
        list.append(
          el(
            "li",
            {},
            el(
              "button",
              { type: "button", onclick: () => choose(p.key) },
              el("span", {}, `${p.name} `, el("span", { class: "muted" }, p.title)),
              el("span", { class: "rank" }, status)
            )
          )
        );
      }
      list.hidden = false;
    }

    function choose(key) {
      addPlayer(key);
      input.value = "";
      list.hidden = true;
      input.focus();
    }

    input.addEventListener("input", show);
    input.addEventListener("focus", show);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const first = matches(input.value)[0];
        if (first) choose(first.key);
        event.preventDefault();
      } else if (event.key === "Escape") {
        list.hidden = true;
      } else if (event.key === "ArrowDown") {
        const firstButton = list.querySelector("button");
        if (firstButton) {
          firstButton.focus();
          event.preventDefault();
        }
      }
    });
    list.addEventListener("keydown", (event) => {
      const buttons = [...list.querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === "ArrowDown" && index < buttons.length - 1) buttons[index + 1].focus();
      else if (event.key === "ArrowUp" && index > 0) buttons[index - 1].focus();
      else if (event.key === "ArrowUp" && index === 0) input.focus();
      else if (event.key === "Escape") {
        list.hidden = true;
        input.focus();
      } else return;
      event.preventDefault();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search")) list.hidden = true;
    });
  }

  // ------------------------------------------------------------------ cards

  function absentList(players, label) {
    if (!players.length) return null;
    return el(
      "details",
      { class: "absent-list" },
      el("summary", { class: "muted" }, label),
      el(
        "ul",
        {},
        ...players.map((a) =>
          el(
            "li",
            {},
            link(a.key || a.name.toLowerCase(), a.name),
            ` — ${a.lo === a.hi ? fmt(a.lo) + " power" : `${fmt(a.lo)}–${a.hi == null ? "?" : fmt(a.hi)} power`}, last seen #${a.last_rank} on ${a.last_seen}`
          )
        )
      )
    );
  }

  function realRankNode(p) {
    const today = p.today;
    const { definite, possible } = unregisteredAbove(p);
    const realRank = today.rank + definite.length;
    const wrap = el("div", { class: "real" });
    if (!definite.length && !possible.length) {
      wrap.append(el("span", { class: "muted" }, "Real rank #", String(realRank), " · no unregistered players above"));
      return wrap;
    }
    const range = possible.length ? `#${realRank}–#${realRank + possible.length}` : `#${realRank}`;
    wrap.append("Real rank ", el("strong", {}, range));
    const parts = [];
    if (definite.length) parts.push(`${definite.length} unregistered above`);
    if (possible.length) parts.push(`${possible.length} uncertain`);
    wrap.append(el("span", { class: "muted" }, ` · ${parts.join(", ")}`));
    const detail = absentList([...definite, ...possible], "show");
    if (detail) wrap.append(" ", detail);
    return wrap;
  }

  // Better-ranked players with visible stats today, nearest first (ties with own rank excluded).
  // In the path view only players of the same path count, ordered by their path rank.
  function visibleAbove(p, limit) {
    const own = p.today;
    const inPath = view === "path";
    const ownRank = inPath ? own.path_rank : own.rank;
    const rows = [];
    if (ownRank == null) return rows;
    for (const key of data.players.keys) {
      const q = player(key);
      const t = q.today;
      if (!t || t.power == null) continue;
      if (inPath && q.path !== p.path) continue;
      const rank = inPath ? t.path_rank : t.rank;
      if (rank == null || rank >= ownRank) continue;
      rows.push({ key, name: q.name, rank, power: t.power });
    }
    rows.sort((a, b) => b.rank - a.rank);
    return rows.slice(0, limit);
  }

  function nextTable(p) {
    const today = p.today;
    const inPath = view === "path";
    const ownRank = inPath ? today.path_rank : today.rank;
    const wrap = el("div", { class: "next" });
    if (ownRank == null) {
      const reason = inPath
        ? p.path
          ? `Not in the top 250 ${pathPlural(p.path)} today.`
          : "Path unknown (not in any path Top 250)."
        : "Not in the overall top 1000 today.";
      wrap.append(el("p", { class: "gap muted" }, reason));
      return wrap;
    }
    if (ownRank === 1) {
      wrap.append(el("p", { class: "gap" }, inPath ? `Top ${pathName(p.path)}` : "Top of the list"));
      return wrap;
    }
    const rows = visibleAbove(p, NEXT_ROWS);
    if (!rows.length) {
      wrap.append(el("p", { class: "gap muted" }, "No visible stats above"));
      return wrap;
    }
    const known = today.power != null;
    const hiddenBetween = ownRank - rows[0].rank - 1;
    const table = el(
      "table",
      { class: "next-table" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { class: "num" }, inPath ? `${pathName(p.path)} rank` : "Rank"),
          el("th", {}, "To pass"),
          el("th", { class: "num" }, known ? "Power needed" : "Their power")
        )
      )
    );
    const body = el("tbody");
    rows.forEach((r, index) => {
      const cell = el("td", { class: "num" });
      if (!known) {
        cell.append(fmt(r.power));
      } else {
        const gap = r.power - today.power;
        const text = index === 0 ? el("strong", {}, fmt(gap)) : fmt(gap);
        cell.append(gap <= 0 ? el("span", { class: "muted", title: "Ranking not refreshed yet" }, text) : text);
      }
      body.append(el("tr", {}, el("td", { class: "num muted" }, `#${r.rank}`), el("td", {}, link(r.key, r.name)), cell));
    });
    table.append(body);
    wrap.append(table);
    if (!known) wrap.append(el("p", { class: "stats" }, "Own stats are hidden, so the gap is unknown."));
    else if (hiddenBetween > 0) wrap.append(el("p", { class: "stats" }, `${hiddenBetween} player${hiddenBetween === 1 ? "" : "s"} with hidden stats between #${ownRank} and #${rows[0].rank}.`));
    return wrap;
  }

  // "#86 ▲1" for the current view, with the other view's rank underneath.
  function rankHeader(p, lastDay) {
    const inPath = view === "path";
    const primary = inPath ? pathRankOn(p, lastDay) : rankOn(p, lastDay);
    const primaryDelta = delta(p, lastDay, inPath ? pathRankOn : rankOn);
    const secondary = inPath ? rankOn(p, lastDay) : pathRankOn(p, lastDay);
    const secondaryDelta = delta(p, lastDay, inPath ? rankOn : pathRankOn);

    const big = el("div", { class: "rank" }, primary == null ? "—" : `#${primary}`);
    if (primary != null && primaryDelta) big.append(deltaNode(primaryDelta, "small"));
    if (inPath) big.append(el("small", { class: "muted rank-label" }, p.path ? pathName(p.path) : "path unknown"));

    const sub = el("div", { class: "rank-sub" });
    if (inPath) {
      sub.append(secondary == null ? "Not in the overall top 1000" : `Overall #${secondary}`);
    } else if (!p.path) {
      sub.append(el("span", { class: "muted" }, "Path unknown (not in any path Top 250)"));
    } else {
      sub.append(secondary == null ? `${pathName(p.path)} · not in the top 250` : `${pathName(p.path)} #${secondary}`);
    }
    if (secondary != null && secondaryDelta) sub.append(deltaNode(secondaryDelta));
    return [big, sub];
  }

  function lastSeenText(p) {
    const where = p.last_rank != null ? `#${p.last_rank} overall` : p.last_path_rank != null ? `${pathName(p.path)} #${p.last_path_rank}` : "on the lists";
    return `Not on any list today (unregistered?). Last seen ${where} on ${p.last_active}.`;
  }

  function renderCards() {
    const cards = document.getElementById("cards");
    cards.replaceChildren();
    if (!selected.length) {
      cards.append(el("p", { class: "muted" }, "No characters selected. Use the search box to add one."));
      return;
    }
    const lastDay = data.players.dates.length - 1;
    selected.forEach((key, index) => {
      const p = player(key);
      const card = el("article", { class: "card" });
      card.style.borderLeftColor = color(index);
      card.append(el("button", { class: "remove", type: "button", title: "Remove from view", "aria-label": `Remove ${p ? p.name : key}`, onclick: () => removePlayer(key) }, "×"));

      if (!p) {
        card.classList.add("absent");
        card.append(el("h3", {}, key), el("p", { class: "muted" }, "Never appeared on the list in any snapshot."));
        cards.append(card);
        return;
      }
      const heading = el("h3", {}, link(key, p.name));
      if (p.title) heading.append(" ", el("span", { class: "title" }, p.title));
      card.append(heading);

      const today = p.today;
      if (today) {
        card.append(...rankHeader(p, lastDay));
        if (today.rank != null) card.append(realRankNode(p));
        card.append(nextTable(p));
        card.append(
          el(
            "p",
            { class: "stats" },
            today.power != null
              ? `Power ${fmt(today.power)} · Vita ${fmt(today.vita)} · Mana ${fmt(today.mana)}`
              : today.stats_status === "no_page"
              ? "No character page."
              : "Own stats are hidden on the character page."
          )
        );
        card.append(el("p", { class: "stats" }, `as of ${today.date}`));
      } else {
        card.classList.add("absent");
        card.append(
          el("div", { class: "rank muted" }, "—"),
          el("p", { class: "gap" }, lastSeenText(p)),
          el("p", { class: "stats" }, p.stats ? `Last known power ${fmt(p.stats.power)} · Vita ${fmt(p.stats.vita)} · Mana ${fmt(p.stats.mana)} (${p.stats.date})` : "Stats were never visible.")
        );
      }
      cards.append(card);
    });
  }

  // ------------------------------------------------------------------ chart

  function renderChart() {
    const dates = data.players.dates;
    const inPath = view === "path";
    const showReal = !inPath && document.getElementById("show-real").checked;
    const datasets = [];
    const values = [];

    selected.forEach((key, index) => {
      const p = player(key);
      if (!p) return;
      const points = dates.map((date, i) => ({ x: date, y: viewRankOn(p, i) }));
      points.forEach((pt) => pt.y != null && values.push(pt.y));
      datasets.push({
        label: inPath && p.path ? `${p.name} (${pathName(p.path)})` : p.name,
        data: points,
        borderColor: color(index),
        backgroundColor: color(index),
        borderWidth: 2,
        pointRadius: dates.length > 120 ? 0 : 3,
        pointHoverRadius: 5,
        tension: 0.15,
        spanGaps: false,
      });
      if (showReal) {
        const realPoints = dates.map((date, i) => {
          const real = realRankOn(p, i);
          return { x: date, y: real ? real.rank : null, real };
        });
        realPoints.forEach((pt) => pt.y != null && values.push(pt.y));
        datasets.push({
          label: `${p.name} (real)`,
          data: realPoints,
          borderColor: color(index),
          backgroundColor: "transparent",
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.15,
          spanGaps: false,
        });
      }
    });

    const maxRank = values.length ? Math.max(...values) : 100;
    const step = maxRank <= 30 ? 5 : maxRank <= 150 ? 10 : maxRank <= 400 ? 25 : maxRank <= 700 ? 50 : 100;
    const yMax = Math.ceil((maxRank + 2) / step) * step;
    const ticks = [1];
    for (let value = step; value <= yMax; value += step) ticks.push(value);

    if (chart) chart.destroy();
    chart = new Chart(document.getElementById("chart"), {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          x: {
            type: "time",
            time: { minUnit: "day", tooltipFormat: "yyyy-MM-dd" },
            ticks: { maxRotation: 0, autoSkipPadding: 16 },
            grid: { display: false },
          },
          y: {
            reverse: true, // rank 1 at the top
            min: 1,
            max: yMax,
            title: { display: true, text: inPath ? "Rank within path (1 = top)" : "Rank (1 = top)" },
            afterBuildTicks: (scale) => {
              scale.ticks = ticks.map((value) => ({ value }));
            },
          },
        },
        plugins: {
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const real = ctx.raw.real;
                if (real && real.max !== real.rank) {
                  return `${ctx.dataset.label}: #${real.rank}–#${real.max}`;
                }
                return `${ctx.dataset.label}: #${ctx.parsed.y}`;
              },
            },
          },
        },
      },
    });
  }

  // ------------------------------------------------------------------ table

  function renderTable() {
    const table = document.getElementById("history");
    const dates = data.players.dates;
    const top = el("tr", {}, el("th", { rowspan: 2 }, "Date"));
    const second = el("tr");
    const columns = [];

    for (const key of selected) {
      const p = player(key);
      if (!p) continue;
      top.append(el("th", { class: "group", colspan: 4 }, p.name));
      second.append(
        el("th", { class: "group" }, "Rank"),
        el("th", { title: p.path ? `Rank among the top 250 ${pathPlural(p.path)}` : "Path unknown (never in a path Top 250)" }, p.path ? pathName(p.path) : "Path"),
        el("th", { title: "Official rank + unregistered players with higher last-known power" }, "Real"),
        el("th", { title: "Power needed to pass the nearest better-ranked player with visible stats" }, "Power to next")
      );
      columns.push(p);
    }
    table.tHead.replaceChildren(top, second);

    const indices = dates.map((_, i) => i).reverse();
    const visible = showAllRows ? indices : indices.slice(0, TABLE_ROWS);
    const rows = visible.map((dayIndex) => {
      const tr = el("tr", {}, el("td", {}, dates[dayIndex]));
      for (const p of columns) {
        const rank = rankOn(p, dayIndex);
        const rankCell = el("td", { class: "group" });
        if (rank != null) {
          rankCell.append(`#${rank}`);
          const change = delta(p, dayIndex);
          if (change != null) rankCell.append(deltaNode(change));
        } else {
          rankCell.append(el("span", { class: "muted" }, "—"));
        }

        const pathRank = pathRankOn(p, dayIndex);
        const pathCell = el("td");
        if (pathRank != null) {
          pathCell.append(`#${pathRank}`);
          const change = delta(p, dayIndex, pathRankOn);
          if (change != null) pathCell.append(deltaNode(change));
        } else {
          pathCell.append(el("span", { class: "muted" }, "—"));
        }

        const real = realRankOn(p, dayIndex);
        const realCell = el("td");
        if (real) {
          realCell.append(`#${real.rank}`);
          if (real.max !== real.rank) realCell.append(el("span", { class: "uncertain" }, `–${real.max}`));
        } else {
          realCell.append(el("span", { class: "muted" }, "—"));
        }

        const next = rank != null ? nextOn(p, dayIndex) : null;
        const gapCell = el("td");
        if (next && next.gap != null) {
          const between = next.between > 0 ? `, ${next.between} hidden between` : "";
          gapCell.append(fmt(next.gap), el("span", { class: "target" }, `→ ${next.name} (#${next.rank}${between})`));
        } else if (rank === 1) {
          gapCell.append(el("span", { class: "muted" }, "top"));
        } else if (next) {
          gapCell.append(el("span", { class: "muted", title: "Own stats hidden" }, `? → ${next.name} (#${next.rank})`));
        } else {
          gapCell.append(el("span", { class: "muted" }, "—"));
        }
        tr.append(rankCell, pathCell, realCell, gapCell);
      }
      return tr;
    });
    table.tBodies[0].replaceChildren(...rows);

    const button = document.getElementById("show-all");
    if (dates.length > TABLE_ROWS) {
      button.hidden = false;
      button.textContent = showAllRows ? `Show latest ${TABLE_ROWS} days` : `Show all ${dates.length} days`;
    } else {
      button.hidden = true;
    }
  }

  // ------------------------------------------------------------------ main

  function render() {
    renderCards();
    if (typeof Chart === "undefined") {
      document.querySelector(".chart-wrap").replaceChildren(el("p", { class: "muted" }, "Chart library failed to load."));
    } else {
      renderChart();
    }
    renderTable();
  }

  async function main() {
    try {
      data.players = await loadPlayers();
    } catch (error) {
      document.getElementById("cards").replaceChildren(el("p", { class: "muted" }, `No data yet (${error.message}). The daily workflow populates the data files.`));
      return;
    }

    const present = Object.values(data.players.players).filter((p) => p.today).length;
    const updated = data.players.generated_at.slice(0, 16).replace("T", " ");
    const days = data.players.dates.length;
    document.getElementById("meta").textContent =
      `${days} snapshot${days === 1 ? "" : "s"} · ${fmt(present)} on today's lists · ${fmt(Object.keys(data.players.players).length)} players known · ${fmt(data.players.absent.length)} unregistered · updated ${updated} UTC.`;

    selected = readSelection();
    view = readView();
    setupSearch();
    document.querySelectorAll('input[name="view"]').forEach((input) => {
      input.checked = input.value === view;
      input.addEventListener("change", () => setView(input.value));
    });
    document.getElementById("show-real").disabled = view === "path";
    document.getElementById("show-real").addEventListener("change", renderChart);
    document.getElementById("reset").addEventListener("click", resetSelection);
    document.getElementById("show-all").addEventListener("click", () => {
      showAllRows = !showAllRows;
      renderTable();
    });
    window.addEventListener("hashchange", () => {
      selected = readSelection();
      setView(readView());
    });
    render();
  }

  main();
})();
