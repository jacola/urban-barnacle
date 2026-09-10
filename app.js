(function () {
  "use strict";

  const COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];
  const STORAGE_KEY = "powerrank.selected";
  const TABLE_ROWS = 30;
  const numberFormat = new Intl.NumberFormat("en-US");
  const fmt = (n) => (n == null ? "—" : numberFormat.format(n));
  const charUrl = (key) => `http://users.nexustk.com/?name=${encodeURIComponent(key)}`;

  // data.players: players.json (rank matrix + current state for everyone)
  // data.hist:    history.json (daily power detail for players tracked in config.json)
  const data = { players: null, hist: null };
  let selected = [];
  let chart = null;
  let showAllRows = false;

  // ------------------------------------------------------------------ helpers

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "class") node.className = value;
      else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
  }

  function link(key, text) {
    return el("a", { href: charUrl(key), target: "_blank", rel: "noopener" }, text);
  }

  function player(key) {
    return data.players.players[key];
  }

  function isTracked(key) {
    return Boolean(data.hist && data.hist.players[key]);
  }

  function color(index) {
    return COLORS[index % COLORS.length];
  }

  // Rank on the given day index, or null when the player was not on the list.
  function rankOn(p, dayIndex) {
    return p.ranks[dayIndex] || null;
  }

  // Change versus the previous day the player was on the list (positive = climbed).
  function delta(p, dayIndex) {
    const current = rankOn(p, dayIndex);
    if (current == null) return null;
    for (let i = dayIndex - 1; i >= 0; i--) {
      const previous = rankOn(p, i);
      if (previous != null) return previous - current;
    }
    return null;
  }

  function deltaNode(value, tag = "span") {
    if (value == null) return el(tag, { class: "delta muted" }, "");
    if (value === 0) return el(tag, { class: "delta muted" }, "=");
    const up = value > 0;
    return el(tag, { class: `delta ${up ? "up" : "down"}` }, `${up ? "▲" : "▼"}${Math.abs(value)}`);
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

  // ------------------------------------------------------------------ selection

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

  function persistSelection() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
    } catch (error) {
      /* storage unavailable */
    }
    const hash = selected.length ? `#p=${selected.join(",")}` : "";
    window.history.replaceState(null, "", location.pathname + location.search + hash);
  }

  function addPlayer(key) {
    if (!player(key) || selected.includes(key)) return;
    selected.push(key);
    persistSelection();
    render();
  }

  function removePlayer(key) {
    selected = selected.filter((k) => k !== key);
    persistSelection();
    render();
  }

  function resetSelection() {
    selected = [...data.players.tracked];
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      /* ignore */
    }
    persistSelection();
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
        const status = p.today ? `#${p.today.rank}` : `last seen #${p.last_rank} on ${p.last_seen}`;
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

  function gapNode(today) {
    const p = el("p", { class: "gap" });
    const next = today.next;
    if (today.rank === 1) {
      p.append("Top of the list");
    } else if (!next) {
      p.append(el("span", { class: "muted" }, "Power to next rank unknown (no visible stats above)"));
    } else if (next.gap == null) {
      p.append(el("span", { class: "muted" }, `Next: ${next.name} (#${next.rank}) at ${fmt(next.power)} power — own stats hidden`));
    } else if (next.gap <= 0) {
      p.append(el("strong", {}, fmt(-next.gap)), " power ahead of ", link(next.key, next.name), ` (#${next.rank})`, el("span", { class: "muted" }, " · ranking not refreshed yet"));
    } else {
      p.append(el("strong", {}, fmt(next.gap)), " power to pass ", link(next.key, next.name), ` (#${next.rank})`);
      if (next.skipped) p.append(el("span", { class: "muted" }, ` · ${next.skipped} hidden in between`));
    }
    return p;
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
        const rank = el("div", { class: "rank" }, `#${today.rank}`);
        const change = delta(p, lastDay);
        if (change) rank.append(deltaNode(change, "small"));
        card.append(rank, realRankNode(p), gapNode(today));
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
          el("p", { class: "gap" }, `Not on today's list (unregistered?). Last seen #${p.last_rank} on ${p.last_seen}.`),
          el("p", { class: "stats" }, p.stats ? `Last known power ${fmt(p.stats.power)} · Vita ${fmt(p.stats.vita)} · Mana ${fmt(p.stats.mana)} (${p.stats.date})` : "Stats were never visible.")
        );
      }
      card.append(
        isTracked(key)
          ? el("span", { class: "badge", title: "Daily power detail is recorded for this player" }, "tracked in config.json")
          : el("span", { class: "badge adhoc", title: "Add this name to config.json to record daily power detail" }, "rank history only")
      );
      cards.append(card);
    });
  }

  // ------------------------------------------------------------------ chart

  function renderChart() {
    const dates = data.players.dates;
    const showReal = document.getElementById("show-real").checked;
    const datasets = [];
    const values = [];

    selected.forEach((key, index) => {
      const p = player(key);
      if (!p) return;
      const points = dates.map((date, i) => ({ x: date, y: rankOn(p, i) }));
      points.forEach((pt) => pt.y != null && values.push(pt.y));
      datasets.push({
        label: p.name,
        data: points,
        borderColor: color(index),
        backgroundColor: color(index),
        borderWidth: 2,
        pointRadius: dates.length > 120 ? 0 : 3,
        pointHoverRadius: 5,
        tension: 0.15,
        spanGaps: false,
      });
      if (showReal && isTracked(key)) {
        const byDate = new Map(data.hist.players[key].history.map((r) => [r.date, r]));
        const realPoints = dates.map((date) => {
          const r = byDate.get(date);
          return { x: date, y: r && r.real_rank != null ? r.real_rank : null, record: r };
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
            title: { display: true, text: "Rank (1 = top)" },
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
                const r = ctx.raw.record;
                if (r && r.real_rank_max != null && r.real_rank_max !== r.real_rank) {
                  return `${ctx.dataset.label}: #${r.real_rank}–#${r.real_rank_max}`;
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
      const tracked = isTracked(key);
      top.append(el("th", { class: "group", colspan: tracked ? 3 : 1 }, p.name));
      second.append(el("th", { class: "group" }, "Rank"));
      if (tracked) {
        second.append(el("th", { title: "Official rank + unregistered players with higher last-known power" }, "Real"), el("th", {}, "Power to next"));
      }
      columns.push({ key, p, tracked, records: tracked ? new Map(data.hist.players[key].history.map((r) => [r.date, r])) : null });
    }
    table.tHead.replaceChildren(top, second);

    const indices = dates.map((_, i) => i).reverse();
    const visible = showAllRows ? indices : indices.slice(0, TABLE_ROWS);
    const rows = visible.map((dayIndex) => {
      const tr = el("tr", {}, el("td", {}, dates[dayIndex]));
      for (const column of columns) {
        const rank = rankOn(column.p, dayIndex);
        const rankCell = el("td", { class: "group" });
        if (rank != null) {
          rankCell.append(`#${rank}`);
          const change = delta(column.p, dayIndex);
          if (change != null) rankCell.append(deltaNode(change));
        } else {
          rankCell.append(el("span", { class: "muted" }, "—"));
        }
        tr.append(rankCell);
        if (!column.tracked) continue;

        const r = column.records.get(dates[dayIndex]);
        const realCell = el("td");
        if (r && r.real_rank != null) {
          realCell.append(`#${r.real_rank}`);
          if (r.real_rank_max != null && r.real_rank_max !== r.real_rank) realCell.append(el("span", { class: "uncertain" }, `–${r.real_rank_max}`));
        } else {
          realCell.append(el("span", { class: "muted" }, "—"));
        }
        const gapCell = el("td");
        if (r && r.next && r.next.gap != null) {
          const hidden = r.next.skipped ? `, ${r.next.skipped} hidden skipped` : "";
          gapCell.append(fmt(r.next.gap), el("span", { class: "target" }, `→ ${r.next.name} (#${r.next.rank}${hidden})`));
        } else {
          gapCell.append(el("span", { class: "muted" }, "—"));
        }
        tr.append(realCell, gapCell);
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

  async function loadJson(path, optional = false) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      if (optional) return null;
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    return response.json();
  }

  async function main() {
    try {
      [data.players, data.hist] = await Promise.all([loadJson("data/players.json"), loadJson("data/history.json", true)]);
    } catch (error) {
      document.getElementById("cards").replaceChildren(el("p", { class: "muted" }, `No data yet (${error.message}). The daily workflow populates the data files.`));
      return;
    }
    for (const [key, p] of Object.entries(data.players.players)) p.key = key;

    const present = Object.values(data.players.players).filter((p) => p.today).length;
    const updated = data.players.generated_at.slice(0, 16).replace("T", " ");
    const days = data.players.dates.length;
    document.getElementById("meta").textContent =
      `${days} snapshot${days === 1 ? "" : "s"} · ${fmt(present)} on today's list · ${fmt(Object.keys(data.players.players).length)} players known · ${fmt(data.players.absent.length)} unregistered · updated ${updated} UTC.`;

    selected = readSelection();
    setupSearch();
    document.getElementById("show-real").addEventListener("change", renderChart);
    document.getElementById("reset").addEventListener("click", resetSelection);
    document.getElementById("show-all").addEventListener("click", () => {
      showAllRows = !showAllRows;
      renderTable();
    });
    window.addEventListener("hashchange", () => {
      selected = readSelection();
      render();
    });
    render();
  }

  main();
})();
