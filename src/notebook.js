// The notebook document model. This is the core paradigm shift: the chat is
// not a transcript of static payloads — it is a *lens* over this document.
// Every planner/LLM turn emits patches (add/update/remove cells); the
// Observable runtime re-evaluates only the affected subgraph.
//
// Cell shape (serialized verbatim into .lookernb.json):
//   {
//     id:      stable unique id ("c1", "c2", …)
//     name:    reactive identifier, referenced by other cells' `inputs`
//     kind:    "md" | "query" | "js"
//     source:  md → markdown text
//              query → unused (spec is authoritative)
//              js → async function body; `return` its value (DOM, number, …)
//     query:   query cells only — Looker inline-query spec
//              {fields, filters, sorts, limit}
//     inputs:  js cells only — names this cell depends on (other cell names
//              + builtins: Plot, d3, fmt, kpi, table)
//   }

let idCounter = 0;
export const nextCellId = () => `c${++idCounter}`;

export function createNotebook() {
  return { version: 1, title: "Untitled analysis", cells: [] };
}

// --- Patch application ------------------------------------------------------
// patches: [{op:"add", cell, after?}, {op:"update", id, cell}, {op:"remove", id}]
// Returns inverse patches so history is a pure undo/redo stack.
export function applyPatches(nb, patches) {
  const inverse = [];
  for (const p of patches) {
    if (p.op === "add") {
      const idx = p.after ? nb.cells.findIndex(c => c.id === p.after) + 1 : nb.cells.length;
      nb.cells.splice(idx === 0 && p.after ? nb.cells.length : idx, 0, p.cell);
      inverse.unshift({ op: "remove", id: p.cell.id });
    } else if (p.op === "update") {
      const idx = nb.cells.findIndex(c => c.id === p.id);
      if (idx === -1) continue;
      inverse.unshift({ op: "update", id: p.id, cell: nb.cells[idx] });
      nb.cells[idx] = { ...p.cell, id: p.id };
    } else if (p.op === "remove") {
      const idx = nb.cells.findIndex(c => c.id === p.id);
      if (idx === -1) continue;
      inverse.unshift({ op: "add", cell: nb.cells[idx], after: nb.cells[idx - 1]?.id });
      nb.cells.splice(idx, 1);
    }
  }
  return inverse;
}

export const getCell = (nb, id) => nb.cells.find(c => c.id === id);
export const getCellByName = (nb, name) => nb.cells.find(c => c.name === name);

// Unique reactive name from a base slug.
export function uniqueName(nb, base) {
  let name = base, n = 2;
  while (nb.cells.some(c => c.name === name)) name = `${base}_${n++}`;
  return name;
}

// Canonical printable source for diffing/serialization (query cells diff on
// their spec, which is the semantically meaningful content).
export function cellPrintableSource(cell) {
  return cell.kind === "query" ? JSON.stringify(cell.query, null, 2) : cell.source || "";
}

// --- Serialization: the .lookernb.json artifact -----------------------------
export function serializeNotebook(nb, turns) {
  return JSON.stringify(
    {
      format: "lookernb",
      version: 1,
      title: nb.title,
      savedAt: new Date().toISOString(),
      cells: nb.cells,
      history: (turns || []).map(t => ({ question: t.question, patchSummary: t.patchSummary })),
    },
    null,
    2
  );
}

// --- Line diff (LCS) for revision display -----------------------------------
// Small and dependency-free; cell sources are short. Output rows:
// {type:"ctx"|"add"|"del", text}
export function diffLines(a, b) {
  const A = a ? a.split("\n") : [];
  const B = b ? b.split("\n") : [];
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: "ctx", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: A[i] }); i++; }
    else { out.push({ type: "add", text: B[j] }); j++; }
  }
  while (i < n) out.push({ type: "del", text: A[i++] });
  while (j < m) out.push({ type: "add", text: B[j++] });
  return out;
}

// Collapse long runs of unchanged lines (keep 2 lines of context).
export function compactDiff(rows, context = 2) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, idx) => {
    if (r.type === "ctx") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep[k] = true;
  });
  const out = [];
  let skipping = 0;
  rows.forEach((r, idx) => {
    if (keep[idx]) {
      if (skipping) { out.push({ type: "ctx", text: `⋯ ${skipping} unchanged lines` }); skipping = 0; }
      out.push(r);
    } else skipping++;
  });
  if (skipping) out.push({ type: "ctx", text: `⋯ ${skipping} unchanged lines` });
  return out;
}
