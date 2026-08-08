// Formatting helpers. Kept dependency-free (no browser, no CDN imports) so
// the planner (compiler.js) is runnable under node for tests and evals.

export const fmt = {
  usd: v => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${(+v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`),
  num: v => (+v).toLocaleString("en-US", { maximumFractionDigits: 1 }),
  pct: v => `${(v * 100).toFixed(1)}%`,
  month: key => new Date(`${key}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
  date: key => new Date(`${key}-01T00:00:00`),
  byFormat: (v, format) => (format === "usd" ? fmt.usd(v) : format === "pct" ? fmt.pct(v) : fmt.num(v)),
};
