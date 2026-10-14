const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the page's real formatting and evidence functions without fetching data.
const source = fs.readFileSync(path.join(__dirname, "../directory.js"), "utf8")
  .replace("  main();", `
    directoryDate = "2026-10-13";
    rankingDate = "2026-10-13";
    globalThis.testFns = { evidence, evidenceText, sortValue, statClass };
  `);
const context = { window: { PR: { fmt: n => new Intl.NumberFormat("en-US").format(n) } } };
vm.createContext(context);
vm.runInContext(source, context);
const { evidence, evidenceText, sortValue, statClass } = context.testFns;

for (const row of [
  {},
  { rank: 1, today: { lo: 20841511, hi: null } },
  { rank: 2, today: { lo: 0, hi: 20841511 } },
  { rank: 3, today: { lo: 20841511, hi: 22000000 } },
  { min_power: 1280000 },
  { stats: { power: 9544231, date: "2026-10-01" } },
]) {
  row.evidence = evidence(row);
  assert.equal(row.evidence.kind, "Unknown");
  assert.equal(evidenceText(row.evidence), "-");
  assert.equal(sortValue(row, "power"), null);
}
assert.equal(evidenceText(evidence({ today: { power: 20841511 } })), "20,841,511");
assert.equal(evidenceText(evidence({ stats: { power: 123, date: "2026-10-13" } })), "123");
const dateAgo = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
assert.equal(statClass(dateAgo(5)), "num");
assert.equal(statClass(dateAgo(6)), "num stale-stat");
console.log("Directory display regression checks passed.");
