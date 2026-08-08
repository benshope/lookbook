// Smart Statistical Profiler.
//
// The single biggest token sink in multi-turn chat analytics is
// echoing raw query result tables back into LLM context. This module
// compresses any result set into a <150-token profile that preserves
// qualitative awareness: shape, ranges, central tendency, top categories,
// and the exact extreme rows (so the model can still answer "which one was
// highest?" without re-querying).
//
// Pass profileToPrompt(profile) — never raw rows — into conversation history.

import { TUNING } from "./tuning.js";

export function profileRows(rows) {
  if (!rows?.length) return { rowCount: 0, columns: [] };
  const cols = Object.keys(rows[0]);
  const columns = cols.map(name => {
    const values = rows.map(r => r[name]);
    const numeric = values.every(v => typeof v === "number" && Number.isFinite(v));
    if (numeric) {
      const sorted = [...values].sort((a, b) => a - b);
      const total = values.reduce((a, b) => a + b, 0);
      const maxIdx = values.indexOf(sorted[sorted.length - 1]);
      const minIdx = values.indexOf(sorted[0]);
      return {
        name, kind: "number",
        min: round(sorted[0]), max: round(sorted[sorted.length - 1]),
        mean: round(total / values.length),
        median: round(sorted[Math.floor(sorted.length / 2)]),
        sum: round(total),
        // Exact extreme rows: the self-healing hook for follow-up questions.
        maxRow: rows[maxIdx], minRow: rows[minIdx],
      };
    }
    const freq = new Map();
    for (const v of values) freq.set(v, (freq.get(v) || 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TUNING.profiler.TOP_CATEGORIES);
    return { name, kind: "category", distinct: freq.size, top: top.map(([v, n]) => `${v}(${n})`) };
  });
  return { rowCount: rows.length, columns };
}

// Compact single-string rendering for LLM context. Typically 60–140 tokens.
export function profileToPrompt(profile) {
  if (!profile.rowCount) return "0 rows";
  const parts = profile.columns.map(c =>
    c.kind === "number"
      ? `${c.name}: num min=${c.min} max=${c.max} mean=${c.mean} sum=${c.sum}; max@${firstDim(c.maxRow)} min@${firstDim(c.minRow)}`
      : `${c.name}: cat distinct=${c.distinct} top=${c.top.join(",")}`
  );
  return `${profile.rowCount} rows | ${parts.join(" | ")}`;
}

export const estimateTokens = str => Math.ceil(str.length / 4);

function firstDim(row) {
  if (!row) return "?";
  const k = Object.keys(row).find(key => typeof row[key] !== "number");
  return k ? row[k] : "?";
}

const round = n => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);
