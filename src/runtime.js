// Reactive engine: wraps @observablehq/runtime so notebook cells become
// nodes in an in-memory dependency DAG. When a query cell's filters change,
// every downstream chart re-evaluates in-browser (<2ms scheduling, no server
// round-trip beyond the data fetch itself).
//
// Pinned versions match the target Looker host application exactly:
//   @observablehq/runtime 5.9.3 · @observablehq/plot 0.6.16 · d3 7.9.0
//   marked 12.0.2
// In restricted production builds these are bundled/vendored (no dynamic CDN
// tags in prod) — the CDN ESM imports below are the standalone-demo
// equivalent of the sandboxed iframe's static assets. See PORTING.md.

import { Runtime } from "https://cdn.jsdelivr.net/npm/@observablehq/runtime@5.9.3/+esm";
import * as Plot from "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.16/+esm";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";

import { profileRows, profileToPrompt, estimateTokens } from "./profiler.js";
import { getField, queryToSQL } from "./looker.js";
import { cellPrintableSource } from "./notebook.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ---- formatting helpers exposed to generated cells as `fmt` ----
// (lives in format.js so the node-run planner evals can import it CDN-free)
import { fmt } from "./format.js";
export { fmt };

// Material-flavored categorical palette used by generated Plot cells.
export const BRAND_SCHEME = ["#1a73e8", "#34a853", "#f9ab00", "#d93025", "#9334e6", "#12b5cb", "#e8710a", "#7cb342"];

// ---- DOM builders exposed to generated cells ----
export function kpi(label, value, note, delta) {
  const el = document.createElement("div");
  el.className = "kpi";
  const d = delta != null
    ? `<span class="kpi-delta ${delta >= 0 ? "up" : "down"}"> ${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta * 100).toFixed(1)}%</span>` : "";
  el.innerHTML = `<div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}${d}</div>${note ? `<div class="kpi-note">${esc(note)}</div>` : ""}`;
  return el;
}

export function kpiRow(...kpis) {
  const el = document.createElement("div");
  el.className = "kpi-row";
  kpis.forEach(k => el.appendChild(k));
  return el;
}

export function table(rows, { limit = 12 } = {}) {
  const el = document.createElement("div");
  el.className = "cell-card";
  if (!rows?.length) { el.textContent = "No rows."; return el; }
  const cols = Object.keys(rows[0]);
  const t = document.createElement("table");
  t.className = "data-table";
  t.innerHTML =
    `<thead><tr>${cols.map(c => `<th>${esc(shortField(c))}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.slice(0, limit).map(r =>
      `<tr>${cols.map(c => typeof r[c] === "number"
        ? `<td class="num">${esc(fmt.byFormat(r[c], getField(c)?.format))}</td>`
        : `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</tbody>`;
  el.appendChild(t);
  if (rows.length > limit) {
    const note = document.createElement("div");
    note.className = "table-note";
    note.textContent = `Showing ${limit} of ${rows.length} rows`;
    el.appendChild(note);
  }
  return el;
}

const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const shortField = f => f.includes(".") ? f.split(".")[1].replace(/_/g, " ") : f;

export function renderMarkdown(md) {
  const el = document.createElement("div");
  el.className = "answer-md";
  el.innerHTML = marked.parse(md);
  // Chat-panel convention: bold metric values render as blue metric pills.
  el.querySelectorAll("strong").forEach(s => {
    if (/[\d$%]/.test(s.textContent)) s.classList.add("metric-pill");
  });
  return el;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export function createEngine(looker, { onQueryResult } = {}) {
  const runtime = new Runtime();
  const module = runtime.module();

  // Builtins available as inputs to every js cell.
  const builtins = { Plot, d3, fmt, kpi, kpiRow, table, scheme: BRAND_SCHEME };
  for (const [name, value] of Object.entries(builtins)) module.define(name, [], () => value);

  // cellId → {variable, outEl, cell, srcKey}
  const nodes = new Map();

  function makeObserver(id) {
    return {
      pending() {
        const node = nodes.get(id);
        if (node && !node.outEl.hasChildNodes())
          node.outEl.innerHTML = `<div class="cell-running">running…</div>`;
      },
      fulfilled(value) {
        const node = nodes.get(id);
        if (!node) return;
        renderValue(node, value);
      },
      rejected(error) {
        const node = nodes.get(id);
        if (!node) return;
        node.outEl.innerHTML = "";
        const e = document.createElement("div");
        e.className = "cell-error";
        e.textContent = `⚠ ${error?.message || error}`;
        node.outEl.appendChild(e);
      },
    };
  }

  function renderValue(node, value) {
    const { outEl, cell } = node;
    outEl.innerHTML = "";
    if (cell.kind === "query") {
      // Query cells show a transparency line: row count, latency, profile
      // (the <150-token artifact that goes into LLM context), pseudo-SQL.
      const meta = value.__meta || {};
      const wrap = document.createElement("div");
      wrap.className = "query-status";
      wrap.innerHTML = `<span class="rows">${value.length.toLocaleString()} rows</span>` +
        (meta.elapsedMs ? `<span>· ${meta.elapsedMs}ms via run_inline_query</span>` : "") +
        (meta.joins?.length ? `<span class="join-chip" title="LookML join plan — resolved by the engine, zero LLM tokens">⋈ ${meta.joins.join(" → ")}</span>` : "");
      const profBtn = document.createElement("button");
      profBtn.className = "profile-chip";
      profBtn.textContent = `profile ~${meta.profileTokens ?? "?"} tokens`;
      const profPre = document.createElement("div");
      profPre.className = "profile-pre";
      profPre.textContent = meta.profilePrompt || "";
      profBtn.onclick = () => profPre.classList.toggle("open");
      const sqlBtn = document.createElement("button");
      sqlBtn.className = "profile-chip";
      sqlBtn.style.color = "var(--text-2)";
      sqlBtn.style.background = "var(--surface)";
      sqlBtn.textContent = "sql";
      const sqlPre = document.createElement("div");
      sqlPre.className = "sql-pre";
      sqlPre.textContent = meta.sql || "";
      sqlBtn.onclick = () => sqlPre.classList.toggle("open");
      wrap.append(profBtn, sqlBtn);
      outEl.append(wrap, profPre, sqlPre);
      return;
    }
    if (value instanceof Node) { outEl.appendChild(value); return; }
    if (value == null) return;
    const pre = document.createElement("div");
    pre.className = "cell-card";
    pre.style.fontFamily = "var(--mono)";
    pre.style.fontSize = "12px";
    pre.textContent = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    outEl.appendChild(pre);
  }

  function defineCell(node) {
    const { cell, variable } = node;
    if (cell.kind === "md") {
      variable.define(cell.name, [], () => renderMarkdown(cell.source));
      // md renders through the same pipeline for uniformity
      return;
    }
    if (cell.kind === "query") {
      const spec = cell.query;
      variable.define(cell.name, [], async () => {
        const res = await looker.runInlineQuery(spec);
        const rows = res.rows;
        const profile = profileRows(rows);
        const profilePrompt = profileToPrompt(profile);
        Object.defineProperty(rows, "__meta", {
          value: {
            elapsedMs: res.elapsedMs, sql: res.sql || queryToSQL(spec), joins: res.joins,
            profile, profilePrompt, profileTokens: estimateTokens(profilePrompt),
          },
          enumerable: false, configurable: true,
        });
        onQueryResult?.(cell, rows);
        return rows;
      });
      return;
    }
    // js cell: async function of its inputs
    const inputs = cell.inputs || [];
    let fn;
    try {
      fn = new AsyncFunction(...inputs, `"use strict";\n${cell.source}`);
    } catch (err) {
      variable.define(cell.name, [], () => { throw new Error(`Cell compile error: ${err.message}`); });
      return;
    }
    variable.define(cell.name, inputs, (...args) => fn(...args));
  }

  return {
    Plot, d3, marked,
    // Reconcile the runtime DAG with the notebook's cell list.
    sync(nb) {
      const seen = new Set();
      for (const cell of nb.cells) {
        seen.add(cell.id);
        let node = nodes.get(cell.id);
        const srcKey = cell.name + "\u0000" + cellPrintableSource(cell) + "\u0000" + JSON.stringify(cell.inputs || []);
        if (!node) {
          const outEl = document.createElement("div");
          outEl.className = "cell-out";
          outEl.dataset.cellId = cell.id;
          node = { outEl, cell, srcKey: null, variable: module.variable(makeObserver(cell.id)) };
          nodes.set(cell.id, node);
        }
        node.cell = cell;
        if (node.srcKey !== srcKey) {
          node.srcKey = srcKey;
          defineCell(node);
        }
      }
      for (const [id, node] of [...nodes]) {
        if (!seen.has(id)) {
          node.variable.delete();
          node.outEl.remove();
          nodes.delete(id);
        }
      }
    },
    outputFor: id => nodes.get(id)?.outEl,
    flash(id) {
      const el = nodes.get(id)?.outEl;
      if (!el) return;
      el.animate([{ backgroundColor: "rgba(232,240,254,0.9)" }, { backgroundColor: "transparent" }], { duration: 1200 });
    },
  };
}
