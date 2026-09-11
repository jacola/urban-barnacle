// Helpers shared by the tracker (app.js) and the rankings page (rankings.js).
window.PR = (function () {
  "use strict";

  const PATH_NAMES = { warrior: "Warrior", rogue: "Rogue", mage: "Mage", poet: "Poet" };
  const numberFormat = new Intl.NumberFormat("en-US");
  const fmt = (n) => (n == null ? "—" : numberFormat.format(n));
  const charUrl = (key) => `http://users.nexustk.com/?name=${encodeURIComponent(key)}`;
  const pathName = (path) => PATH_NAMES[path] || "Path";
  const pathPlural = (path) => (PATH_NAMES[path] ? `${PATH_NAMES[path]}s` : "path");

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

  // Change versus the previous day with a value in a 0-padded series (positive = climbed).
  function seriesDelta(series, dayIndex) {
    const current = series[dayIndex] || null;
    if (current == null) return null;
    for (let i = dayIndex - 1; i >= 0; i--) {
      if (series[i]) return series[i] - current;
    }
    return null;
  }

  function deltaNode(value, tag = "span") {
    if (value == null) return el(tag, { class: "delta muted" }, "");
    if (value === 0) return el(tag, { class: "delta muted" }, "=");
    const up = value > 0;
    return el(tag, { class: `delta ${up ? "up" : "down"}` }, `${up ? "▲" : "▼"}${Math.abs(value)}`);
  }

  async function loadJson(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }

  // Loads players.json and tags each player with its key.
  async function loadPlayers() {
    const players = await loadJson("data/players.json");
    for (const [key, p] of Object.entries(players.players)) p.key = key;
    return players;
  }

  return { PATH_NAMES, fmt, charUrl, pathName, pathPlural, el, link, seriesDelta, deltaNode, loadJson, loadPlayers };
})();
