(function () {
  "use strict";

  const COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];
  const STORAGE_KEY = "powerrank.selected";
  const TABLE_ROWS = 30;
  const NEXT_ROWS = 5;
  const numberFormat = new Intl.NumberFormat("en-US");
  const fmt = (n) => (n == null ? "—" : numberFormat.format(n));
  const charUrl = (key) => `http://users.nexustk.com/?name=${encodeURIComponent(key)}`;

  // data.players: players.json - per-player daily series (rank, gap to next, real-rank
  // extras) plus current state for every player who has ever appeared on the list.
  const data = { players: null };
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

  function color(index) {
    return COLORS[index % COLORS.length];
  }

  // Rank on the given day index, or null when the player was not on the list.
  function rankOn(p, dayIndex) {
    return p.ranks[dayIndex] || null;
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

  // Better-ranked players with visible stats today, nearest first (ties with own rank excluded).
  function visibleAbove(p, limit) {
    const own = p.today;
    const rows = [];
    for (const key of data.players.keys) {
      const q = player(key);
      const t = q.today;
      if (!t || t.rank >= own.rank || t.power == null) continue;
      rows.push({ key, name: q.name, rank: t.rank, power: t.power });
    }
    rows.sort((a, b) => b.rank - a.rank);
    return rows.slice(0, limit);
  }

  function nextTable(p) {
    const today = p.today;
    const wrap = el("div", { class: "next" });
    if (today.rank === 1) {
      wrap.append(el("p", { class: "gap" }, "Top of the list"));
      return wrap;
    }
    const rows = visibleAbove(p, NEXT_ROWS);
    if (!rows.length) {
      wrap.append(el("p", { class: "gap muted" }, "No visible stats above"));
      return wrap;
    }
    const known = today.power != null;
    const hiddenBetween = today.rank - rows[0].rank - 1;
    const table = el(
      "table",
      { class: "next-table" },
      el(
        "thead",
        {},
        el("tr", {}, el("th", { class: "num" }, "Rank"), el("th", {}, "To pass"), el("th", { class: "num" }, known ? "Power needed" : "Their power"))
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
    else if (hiddenBetween > 0) wrap.append(el("p", { class: "stats" }, `${hiddenBetween} player${hiddenBetween === 1 ? "" : "s"} with hidden stats between #${today.rank} and #${rows[0].rank}.`));
    return wrap;
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
        card.append(rank, realRankNode(p), nextTable(p));
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
      top.append(el("th", { class: "group", colspan: 3 }, p.name));
      second.append(
        el("th", { class: "group" }, "Rank"),
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
        tr.append(rankCell, realCell, gapCell);
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

  async function loadJson(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }

  async function main() {
    try {
      data.players = await loadJson("data/players.json");
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
