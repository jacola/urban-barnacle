(function () {
  "use strict";
  const { fmt, el, link, pathName, loadPlayers } = window.PR;
  const pageSize = 200;
  let rows = [];
  let shown = pageSize;
  let directoryDate = "";

  function powerKind(row) {
    if (row.stats) return "exact";
    if (row.min_power != null) return "minimum";
    return "unknown";
  }

  function filtered() {
    const query = document.getElementById("directory-search").value.trim().toLowerCase();
    const power = document.getElementById("power-filter").value;
    const activity = document.getElementById("activity-filter").value;
    const registration = document.getElementById("registration-filter").value;
    return rows.filter((row) =>
      (!query || row.name.toLowerCase().includes(query)) &&
      (power === "all" || powerKind(row) === power) &&
      (activity === "all" || row.activity === activity) &&
      (registration === "all" || row.registration === registration));
  }

  function render() {
    const matches = filtered();
    const body = document.getElementById("directory-body");
    body.replaceChildren(...matches.slice(0, shown).map((row) => {
      const kind = powerKind(row);
      const powerText = kind === "exact" ? `${fmt(row.stats.power)}${row.stats.date < directoryDate ? " (last known)" : ""}` : kind === "minimum" ? `≥ ${fmt(row.min_power)}` : "—";
      const powerTitle = kind === "exact" ? `Visible vita + 2 × mana, checked ${row.stats.date}` : kind === "minimum" ? `Minimum inferred from ${row.level_mark} mark` : "No public stats or mark minimum";
      const player = el("td", { class: "player", title: row.sources.join(" · ") }, link(row.key, row.name));
      if (row.tracked) player.append(" ", el("a", { class: "chart-link", href: `./#p=${encodeURIComponent(row.key)}` }, "chart"));
      return el("tr", {}, player,
        el("td", { class: "num", title: powerTitle }, powerText),
        el("td", {}, row.level_mark || "—"),
        el("td", {}, [...new Set([row.path ? pathName(row.path) : null, ...row.subpaths].filter(Boolean))].join(", ") || "—"),
        el("td", {}, row.clans.join(", ") || "—"),
        el("td", {}, row.activity || "—"),
        el("td", {}, row.registration || "—"),
        el("td", { class: "num" }, row.rank ? `#${row.rank}` : "—"));
    }));
    document.getElementById("directory-count").textContent = `Showing ${fmt(Math.min(shown, matches.length))} of ${fmt(matches.length)} matching players (${fmt(rows.length)} known).`;
    document.getElementById("directory-more").hidden = shown >= matches.length;
  }

  async function main() {
    try {
      const [directory, ranked] = await Promise.all([
        fetch("data/directory.json").then((response) => { if (!response.ok) throw new Error("Directory not fetched yet"); return response.json(); }),
        loadPlayers(),
      ]);
      directoryDate = directory.date;
      const tracked = new Set(ranked.tracked);
      const keys = new Set([...Object.keys(directory.entries), ...Object.keys(ranked.players)]);
      rows = [...keys].map((key) => {
        const entry = directory.entries[key] || {};
        const p = ranked.players[key];
        return {
          key, name: entry.name || p?.name || key,
          level_mark: entry.level_mark, min_power: entry.min_power,
          activity: entry.activity, registration: entry.registration,
          clans: entry.clans || [], subpaths: entry.subpaths || [],
          sources: (entry.sources || []).map((source) => directory.source_urls?.[source] || source),
          path: p?.path, rank: p?.today?.rank,
          stats: [p?.stats, entry.stats].filter(Boolean).sort((a, b) => b.date.localeCompare(a.date))[0],
          tracked: tracked.has(key),
        };
      });
      rows.sort((a, b) => {
        const order = { exact: 0, minimum: 1, unknown: 2 };
        const kindA = powerKind(a), kindB = powerKind(b);
        return order[kindA] - order[kindB] ||
          (kindA === "exact" ? b.stats.power - a.stats.power : kindA === "minimum" ? b.min_power - a.min_power : 0) ||
          a.name.localeCompare(b.name);
      });
      document.getElementById("directory-meta").textContent = `Directory checked ${directory.date}.`;
      for (const id of ["directory-search", "power-filter", "activity-filter", "registration-filter"]) {
        document.getElementById(id).addEventListener("input", () => { shown = pageSize; render(); });
      }
      document.getElementById("directory-more").addEventListener("click", () => { shown += pageSize; render(); });
      render();
    } catch (error) {
      document.getElementById("directory-meta").textContent = error.message;
    }
  }
  main();
})();
