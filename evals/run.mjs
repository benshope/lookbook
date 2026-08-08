// Golden-set planner eval — the hill-climbing instrument.
//
//   node evals/run.mjs             run + print metrics + save evals/last-run.json
//   node evals/run.mjs --baseline  also save as evals/baseline.json
//
// Workflow (docs/EVAL-PLAN.md): change ONE knob in src/tuning.js, re-run,
// compare against baseline. The runner scores the deterministic planner;
// with a Gemini key you can score planWithLLM through the same golden set
// by swapping the plan() call below.
//
// Runs under plain node (no browser): compiler.js depends only on
// format.js/looker.js/agent.js/grounding.js/tuning.js — never runtime.js.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { plan } from "../src/compiler.js";
import { createNotebook, applyPatches, getCell } from "../src/notebook.js";
import { MockLookerClient } from "../src/looker.js";

const looker = new MockLookerClient({ latency: 0 });
const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));

// Classify a planner result into an intent kind (mirrors bench.html).
function classify(result, nb) {
  const adds = result.patches.filter(p => p.op === "add");
  const updates = result.patches.filter(p => p.op === "update");
  if (result.clarify) return "clarify";
  if (adds.length >= 10) return "research";
  if (adds.length === 0 && updates.length > 0)
    return updates.some(p => p.cell.kind === "js") ? "breakdown-mutation" : "filter-mutation";
  if (adds.length === 1 && /return table\(/.test(adds[0].cell.source || "")) return "table";
  if (adds.some(p => p.cell.name === "exec_kpis")) return "exec";
  const q = adds.find(p => p.cell.kind === "query");
  const chart = adds.find(p => p.cell.kind === "js" && p.cell.name.startsWith("chart_"));
  if (q && !chart) return "scalar";
  if (chart && /barX/.test(chart.cell.source) && q?.cell.query.limit) return "ranking";
  if (chart && /areaY/.test(chart.cell.source)) return "trend";
  if (chart) return "breakdown";
  return "other";
}

function querySpecs(result, nb) {
  return result.patches
    .map(p => (p.cell?.kind === "query" ? p.cell.query : p.op === "update" ? getCell(nb, p.id)?.query : null))
    .filter(Boolean);
}

const rows = [];
let nb = createNotebook();
let lastQueryId = null, lastChartId = null;

for (const c of golden.cases) {
  if (c.fresh) { nb = createNotebook(); lastQueryId = lastChartId = null; }
  const result = await plan({
    question: c.q, nb, looker, mode: c.mode || "chat", choices: c.choices || {},
    lastQuery: lastQueryId ? getCell(nb, lastQueryId) : null,
    lastChart: lastChartId ? getCell(nb, lastChartId) : null,
  });

  const checks = {};
  const e = c.expect;
  checks.kind = classify(result, nb) === e.kind;

  const specs = querySpecs(result, nb);
  if (e.fields)
    checks.fields = e.fields.every(f => specs.some(s => s.fields.includes(f)));
  if (e.filters)
    checks.filters = Object.entries(e.filters).every(([k, v]) =>
      specs.some(s => JSON.stringify(s.filters?.[k]) === JSON.stringify(v)) ||
      result.patches.some(p => JSON.stringify(p.cell?.query?.filters?.[k]) === JSON.stringify(v)));
  if (e.limit) checks.limit = specs.some(s => s.limit === e.limit);
  if (e.answerIncludes)
    checks.answer = e.answerIncludes.every(t => result.answer.toLowerCase().includes(t.toLowerCase()));
  if (e.clarifyTerm) checks.clarifyTerm = result.clarify?.term === e.clarifyTerm;
  if (e.clarifyFields)
    checks.clarifyFields = e.clarifyFields.every(f => result.clarify?.options.some(o => o.field === f));
  if (e.minCells) checks.minCells = result.patches.filter(p => p.op === "add").length >= e.minCells;

  applyPatches(nb, result.patches);
  for (const p of result.patches) {
    const cell = p.cell || getCell(nb, p.id);
    if (cell?.kind === "query") lastQueryId = cell.id;
    if (cell?.kind === "js" && cell.name.startsWith("chart_")) lastChartId = cell.id;
  }

  const pass = Object.values(checks).every(Boolean);
  rows.push({ q: c.q, mode: c.mode || "chat", pass, checks, answer: result.answer.slice(0, 100) });
}

const passed = rows.filter(r => r.pass).length;
const score = { total: rows.length, passed, accuracy: +(passed / rows.length).toFixed(3), at: new Date().toISOString() };

for (const r of rows) {
  const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.q}${failed.length ? `  [failed: ${failed.join(",")}]` : ""}`);
}
console.log(`\n${passed}/${rows.length} · accuracy ${score.accuracy}`);

writeFileSync(new URL("./last-run.json", import.meta.url), JSON.stringify({ score, rows }, null, 2));
if (process.argv.includes("--baseline"))
  writeFileSync(new URL("./baseline.json", import.meta.url), JSON.stringify({ score }, null, 2));
else if (existsSync(new URL("./baseline.json", import.meta.url))) {
  const base = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
  const delta = +(score.accuracy - base.score.accuracy).toFixed(3);
  console.log(`vs baseline (${base.score.accuracy}): ${delta >= 0 ? "+" : ""}${delta}`);
  if (delta < 0) process.exitCode = 1; // regressions fail CI
}
