// Adaptive Intent Compiler.
//
// One turn = ONE planner call that emits:
//   { answer: markdown, patches: [cell patches], label: history label }
//
// This file ships a deterministic rules planner so the demo runs with zero
// backend, and defines the exact contract a Gemini call drops into
// (see COMPILER_SYSTEM_PROMPT + planWithLLM at the bottom). Either way the
// output is the same: small cell diffs against the notebook — never
// server-rendered chart payloads, never multi-call agent pipelines.
//
// Field disambiguation is TRANSPARENT, not silent: when several fields match
// (or a default is assumed), the answer names the chosen LookML field and its
// alternates, and the query cell's pills are the one-click correction UI.
// Join resolution never reaches the planner at all — looker.js walks the
// LookML join graph deterministically.
//
// Modes:
//   chat     — minimal cells, direct answers (the default).
//   research — the same single call fans out a full investigation: KPI row,
//              trend, breakdowns across major dimensions, and a computed
//              findings narrative. Depth = more cells, never more LLM calls.

import { EXPLORE, getField, dimensions, measures, dimensionValues } from "./looker.js";
import { nextCellId, uniqueName } from "./notebook.js";
import { fmt } from "./format.js";
import { AGENT, agentToPrompt } from "./agent.js";
import { groundQuestion, groundingToPrompt } from "./grounding.js";
import { TUNING } from "./tuning.js";

// ---------------------------------------------------------------------------
// Field + value resolution (scored, with alternates surfaced)
// ---------------------------------------------------------------------------
function normalize(q) {
  return " " + q.toLowerCase().replace(/[?!.,;:()"']/g, " ").replace(/\s+/g, " ").trim() + " ";
}

// Earliest/longest synonym hit; longer synonyms score higher (more specific).
// Agent-glossary terms outrank ordinary synonyms — org jargon is authoritative.
function matchField(qn, field) {
  const glossaryTerms = Object.entries(AGENT.glossary)
    .filter(([, fname]) => fname === field.name)
    .map(([term]) => term);
  let best = null;
  for (const syn of [...field.synonyms, ...glossaryTerms].sort((a, b) => b.length - a.length)) {
    const idx = qn.indexOf(` ${syn} `);
    if (idx === -1) continue;
    const score = syn.length + (glossaryTerms.includes(syn) ? TUNING.planner.GLOSSARY_BOOST : 0);
    if (!best || score > best.score || (score === best.score && idx < best.at)) best = { at: idx, syn, score };
  }
  return best;
}

const visible = f => !AGENT.hiddenFields.includes(f.name);

function resolveFields(qn) {
  const score = list => list
    .filter(visible)
    .map(f => ({ f, m: matchField(qn, f) }))
    .filter(x => x.m)
    .sort((a, b) => b.m.score - a.m.score || a.m.at - b.m.at);
  return { dims: score(dimensions()), meas: score(measures()) };
}

// Verified queries: if the question covers a verified example's content words,
// use its exact spec — the agent author's answer beats the heuristics.
function matchVerifiedQuery(qn) {
  for (const vq of AGENT.verifiedQueries) {
    const words = vq.question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length && words.every(w => qn.includes(w))) return vq;
  }
  return null;
}

// Transparency note appended to answers when a choice was made for the user.
function disambigNote(measMatches, defaulted) {
  if (defaulted)
    return ` *(No measure named — assumed \`order_items.total_revenue\`; tap a pill on the query cell to swap.)*`;
  if (measMatches.length > 1) {
    const alts = measMatches.slice(1, 3).map(x => `\`${x.f.name}\``).join(", ");
    return ` *(Interpreted "${measMatches[0].m.syn}" as \`${measMatches[0].f.name}\` — alternates: ${alts}; tap a pill to swap.)*`;
  }
  return "";
}

// Words consumed by field-synonym matches — excluded from value grounding so
// "revenue by brand" doesn't try to match "brand" against brand values.
function consumedSynonymWords(matches) {
  const words = new Set();
  for (const { m } of matches) for (const w of m.syn.split(" ")) words.add(w);
  return words;
}

// ---------------------------------------------------------------------------
// Cell factories — generated sources are idiomatic Observable Plot, kept
// concise on purpose: cells are what the LLM writes, so fewer tokens per turn.
// ---------------------------------------------------------------------------
const M = name => `d["${name}"]`;
const tickFor = f => (getField(f)?.format === "usd" ? `"$~s"` : `"~s"`);

function queryCell(nb, base, spec) {
  // Agent default filters apply to every new query; explicit filters win.
  const filters = { ...AGENT.defaultFilters, ...spec.filters };
  return { id: nextCellId(), name: uniqueName(nb, base), kind: "query", query: { ...spec, filters } };
}
function jsCell(nb, base, inputs, source) {
  return { id: nextCellId(), name: uniqueName(nb, base), kind: "js", inputs, source };
}
function mdCell(nb, base, source) {
  return { id: nextCellId(), name: uniqueName(nb, base), kind: "md", source };
}

function trendChartSource(q, m, splitDim) {
  const x = `d => fmt.date(${M("order_items.created_month")})`;
  if (splitDim) {
    return `const rows = ${q};
return Plot.plot({
  height: 300, marginLeft: 60,
  x: {type: "utc", label: null},
  y: {label: "${getField(m).label}", grid: true, tickFormat: ${tickFor(m)}},
  color: {legend: true, range: scheme},
  marks: [
    Plot.areaY(rows, {x: ${x}, y: d => ${M(m)}, fill: d => ${M(splitDim)}, fillOpacity: 0.85, curve: "catmull-rom", tip: true}),
    Plot.ruleY([0])
  ]
});`;
  }
  return `const rows = ${q};
return Plot.plot({
  height: 280, marginLeft: 60,
  x: {type: "utc", label: null},
  y: {label: "${getField(m).label}", grid: true, tickFormat: ${tickFor(m)}},
  marks: [
    Plot.areaY(rows, {x: ${x}, y: d => ${M(m)}, fill: "#1a73e8", fillOpacity: 0.12, curve: "catmull-rom"}),
    Plot.lineY(rows, {x: ${x}, y: d => ${M(m)}, stroke: "#1a73e8", strokeWidth: 2.5, curve: "catmull-rom", tip: true}),
    Plot.ruleY([0])
  ]
});`;
}

function rankingChartSource(q, m, dim, n) {
  return `const rows = ${q};
return Plot.plot({
  height: ${Math.max(160, 34 * n + 70)}, marginLeft: 180,
  x: {label: "${getField(m).label}", grid: true, tickFormat: ${tickFor(m)}},
  y: {label: null},
  marks: [
    Plot.barX(rows, {x: d => ${M(m)}, y: d => ${M(dim)}, fill: "#1a73e8", sort: {y: "-x"}, tip: true}),
    Plot.ruleX([0])
  ]
});`;
}

function categoryChartSource(q, m, dim, splitDim) {
  if (splitDim) {
    return `const rows = ${q};
return Plot.plot({
  height: 300, marginLeft: 60,
  x: {label: null, tickRotate: -20},
  y: {label: "${getField(m).label}", grid: true, tickFormat: ${tickFor(m)}},
  color: {legend: true, range: scheme},
  marks: [
    Plot.barY(rows, {x: d => ${M(dim)}, y: d => ${M(m)}, fill: d => ${M(splitDim)}, sort: {x: "-y"}, tip: true}),
    Plot.ruleY([0])
  ]
});`;
  }
  return `const rows = ${q};
return Plot.plot({
  height: 280, marginLeft: 60,
  x: {label: null, tickRotate: -20},
  y: {label: "${getField(m).label}", grid: true, tickFormat: ${tickFor(m)}},
  marks: [
    Plot.barY(rows, {x: d => ${M(dim)}, y: d => ${M(m)}, fill: "#1a73e8", sort: {x: "-y"}, tip: true}),
    Plot.ruleY([0])
  ]
});`;
}

const slugOf = fname => fname.split(".")[1].replace(/[^a-z0-9]+/gi, "_");

// ---------------------------------------------------------------------------
// Research mode: one call, a whole investigation.
// ---------------------------------------------------------------------------
async function planResearch({ nb, looker, filters, m, topic }) {
  const patches = [];
  const add = cell => { patches.push({ op: "add", cell }); return cell; };
  const mLabel = getField(m).label;

  add(mdCell(nb, `md_dive_${slugOf(m)}`, `## Deep dive: ${mLabel}${filterTitle(filters)}`));

  const qTotals = add(queryCell(nb, "q_dive_totals", {
    fields: ["order_items.total_revenue", "order_items.order_count", "order_items.average_order_value", "order_items.total_profit"],
    filters,
  }));
  add(jsCell(nb, "dive_kpis", [qTotals.name, "kpi", "kpiRow", "fmt"], `const t = ${qTotals.name}[0];
const margin = t["order_items.total_profit"] / t["order_items.total_revenue"];
return kpiRow(
  kpi("Total revenue", fmt.usd(t["order_items.total_revenue"]), "order_items.total_revenue"),
  kpi("Orders", fmt.num(t["order_items.order_count"]), "order_items.order_count"),
  kpi("Avg order value", fmt.usd(t["order_items.average_order_value"]), "order_items.average_order_value"),
  kpi("Profit margin", fmt.pct(margin), "total_profit / total_revenue")
);`));

  const qMonthly = add(queryCell(nb, `q_${slugOf(m)}_by_month`, {
    fields: ["order_items.created_month", m], filters, sorts: ["order_items.created_month"],
  }));
  add(jsCell(nb, `chart_${slugOf(m)}_by_month`, [qMonthly.name, "Plot", "fmt", "scheme"], trendChartSource(qMonthly.name, m)));

  const breakdowns = TUNING.planner.RESEARCH_BREAKDOWNS;
  const breakdownRows = {};
  for (const { dim, wide } of breakdowns) {
    const q = add(queryCell(nb, `q_${slugOf(m)}_by_${slugOf(dim)}`, {
      fields: [dim, m], filters, sorts: [`-${m}`], ...(wide ? { limit: 10 } : {}),
    }));
    add(jsCell(nb, `chart_${slugOf(m)}_by_${slugOf(dim)}`, [q.name, "Plot", "fmt", "scheme"],
      wide ? rankingChartSource(q.name, m, dim, 10) : categoryChartSource(q.name, m, dim)));
    breakdownRows[dim] = (await looker.runInlineQuery(q.query)).rows;
  }

  // Computed findings narrative (in LLM mode Gemini writes this md cell from
  // the same profiles — either way it costs zero extra model calls).
  const totals = (await looker.runInlineQuery(qTotals.query)).rows[0];
  const monthly = (await looker.runInlineQuery(qMonthly.query)).rows;
  const growth = sixMonthGrowth(monthly, m);
  const bestMonth = [...monthly].sort((a, b) => b[m] - a[m])[0];
  const topDept = breakdownRows["products.department"][0];
  const deptShare = totals["order_items.total_revenue"]
    ? breakdownRows["products.department"][0][m] / sum(breakdownRows["products.department"], r => r[m]) : 0;
  const topState = breakdownRows["users.state"][0];
  const topTraffic = breakdownRows["orders.traffic_source"][0];
  const fmtM = v => fmt.byFormat(v, getField(m).format);

  add(mdCell(nb, `md_findings_${slugOf(m)}`, `### Findings
- ${mLabel} is ${growthPhrase(growth)} over the trailing 6 months; the best month was **${fmt.month(bestMonth["order_items.created_month"])}** at **${fmtM(bestMonth[m])}**.
- **${topDept["products.department"]}** leads departments at **${fmtM(topDept[m])}** (${(deptShare * 100).toFixed(0)}% of the top-line).
- Strongest state: **${topState["users.state"]}** (**${fmtM(topState[m])}**). Strongest channel: **${topTraffic["orders.traffic_source"]}**.
- Profit margin is **${fmt.pct(totals["order_items.total_profit"] / totals["order_items.total_revenue"])}** on **${fmt.num(totals["order_items.order_count"])} orders** (AOV **${fmt.usd(totals["order_items.average_order_value"])}**).`));

  return {
    answer: `**Research: ${mLabel.toLowerCase()}${filterTitle(filters)}** — ${patches.length} cells from one planner call: KPIs, trend, and breakdowns by department, state, and channel, with computed findings at the end. Headline: ${growthPhrase(growth)} trailing 6 months; **${topDept["products.department"]}** and **${topState["users.state"]}** lead their splits.`,
    patches, label: `research: ${topic}`,
  };
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------
export async function plan(ctx) {
  const { question, nb, looker, lastQuery, lastChart, mode = "chat", choices = {} } = ctx;
  const qn = normalize(question);
  const { dims: dimMatches, meas: measMatches } = resolveFields(qn);
  const dims = dimMatches.map(x => x.f);
  const meas = measMatches.map(x => x.f);

  // Pre-flight grounding: fuzzy-match leftover question terms against real
  // dimension values (SDK-derived, zero LLM cost). See grounding.js.
  const g = groundQuestion(qn, { consumedWords: consumedSynonymWords([...dimMatches, ...measMatches]), choices });
  const filters = g.filters;
  const gNote = g.notes.length ? ` *(${g.notes.join(" ")})*` : "";
  const patches = [];

  const hasWord = (...ws) => ws.some(w => qn.includes(` ${w} `));

  // Genuine ambiguity → ask the user, don't guess. Resolving the chip the
  // user clicks re-plans with the binding — zero additional LLM calls.
  if (g.clarify && !hasWord("help")) {
    const opts = g.clarify.options;
    return {
      answer: `"${g.clarify.term}" matches more than one thing in this Explore — which did you mean?`,
      clarify: { term: g.clarify.term, options: opts },
      patches: [], label: `clarify: ${g.clarify.term}`,
    };
  }

  // ---- help --------------------------------------------------------------
  if (hasWord("help", "what can i ask", "fields", "what can you do")) {
    const dimList = dimensions().filter(visible).map(f => `\`${f.name}\``).join(", ");
    const measList = measures().filter(visible).map(f => `\`${f.name}\``).join(", ");
    return {
      answer: `You're connected to the **${EXPLORE.label}** Explore (joins: ${Object.keys(EXPLORE.joins).join(", ")} — resolved automatically).\n\n**Dimensions:** ${dimList}\n\n**Measures:** ${measList}\n\nTry: *"How is the business doing?"*, *"Top 10 brands by revenue"*, then refine with *"only 2025"* or *"break that down by department"*. Toggle **Research** for a full investigation from a single question.`,
      patches: [], label: "help",
    };
  }

  // ---- clear filters -----------------------------------------------------
  if (hasWord("clear filters", "remove filters", "clear the filters", "show everything", "reset filters", "remove the filter")) {
    let touched = 0;
    for (const cell of nb.cells.filter(c => c.kind === "query" && Object.keys(c.query.filters || {}).length)) {
      patches.push({ op: "update", id: cell.id, cell: { ...cell, query: { ...cell.query, filters: {} } } });
      touched++;
    }
    return {
      answer: touched
        ? `Cleared filters on **${touched} ${touched === 1 ? "query" : "queries"}** — every downstream cell re-evaluated in-browser.`
        : `No active filters to clear.`,
      patches, label: "clear filters",
    };
  }

  // ---- pure filter mutation ("only 2025", "just outerwear") --------------
  const filterVerb = hasWord("only", "just", "filter", "restrict", "narrow", "limit to", "exclude");
  const hasFilters = Object.keys(filters).length > 0;
  if (hasFilters && (filterVerb || (meas.length === 0 && dims.length === 0)) && nb.cells.some(c => c.kind === "query")) {
    const targets = nb.cells.filter(c => c.kind === "query");
    for (const cell of targets)
      patches.push({ op: "update", id: cell.id, cell: { ...cell, query: { ...cell.query, filters: { ...cell.query.filters, ...filters } } } });
    const desc = Object.entries(filters).map(([k, v]) => `\`${k} = ${Array.isArray(v) ? v.join(", ") : v}\``).join(" and ");
    return {
      answer: `Applied ${desc} to **${targets.length} ${targets.length === 1 ? "query" : "queries"}**. Charts re-rendered reactively — no server round-trip, no new cells.`,
      patches, label: `filter: ${Object.values(filters).flat().join(", ")}`,
    };
  }

  // ---- breakdown mutation ("break that down by department") --------------
  if (hasWord("break", "split", "segment", "breakdown") && lastQuery && dims.length) {
    const newDim = dims.find(d => !lastQuery.query.fields.includes(d.name));
    if (newDim) {
      const oldDims = lastQuery.query.fields.filter(f => getField(f)?.type === "dimension");
      const oldMeas = lastQuery.query.fields.filter(f => getField(f)?.type === "measure");
      const m = oldMeas[0] || "order_items.total_revenue";
      const isTrend = oldDims.includes("order_items.created_month");
      const newSpec = {
        ...lastQuery.query,
        fields: [...oldDims, newDim.name, ...oldMeas],
        limit: isTrend ? undefined : 5000,
        sorts: isTrend ? ["order_items.created_month"] : [`-${m}`],
      };
      patches.push({ op: "update", id: lastQuery.id, cell: { ...lastQuery, query: newSpec } });
      if (lastChart) {
        const src = isTrend
          ? trendChartSource(lastQuery.name, m, newDim.name)
          : categoryChartSource(lastQuery.name, m, oldDims[0] || newDim.name, oldDims[0] ? newDim.name : undefined);
        patches.push({ op: "update", id: lastChart.id, cell: { ...lastChart, source: src } });
      }
      return {
        answer: `Split by **${newDim.label}** — updated \`${lastQuery.name}\` and recompiled the chart as a ${isTrend ? "stacked area" : "stacked bar"}. Two cell diffs, zero new cells.`,
        patches, label: `break down by ${newDim.label}`,
      };
    }
  }

  // ---- table request -----------------------------------------------------
  if (hasWord("table", "underlying data", "raw data", "the data", "rows", "as a table") && lastQuery) {
    const t = jsCell(nb, `table_${lastQuery.name.replace(/^q_/, "")}`, [lastQuery.name, "table"], `return table(${lastQuery.name}, {limit: 15});`);
    patches.push({ op: "add", cell: t });
    return { answer: `Here's the underlying result of \`${lastQuery.name}\` as a table — same reactive node, so it tracks every future filter change.`, patches, label: "show table" };
  }

  // ---- verified queries: the agent author's answer beats heuristics ------
  const vq = matchVerifiedQuery(qn);
  if (vq) {
    const spec = { ...structuredClone(vq.spec), filters: { ...vq.spec.filters, ...filters } };
    const dim = spec.fields.find(f => getField(f)?.type === "dimension");
    const m = spec.fields.find(f => getField(f)?.type === "measure");
    const q = queryCell(nb, `q_${slugOf(dim || m)}_verified`, spec);
    const chart = jsCell(nb, `chart_${slugOf(dim || m)}_verified`, [q.name, "Plot", "fmt", "scheme"],
      rankingChartSource(q.name, m, dim, spec.limit || 10));
    patches.push({ op: "add", cell: q }, { op: "add", cell: chart });
    const rows = (await looker.runInlineQuery(q.query)).rows;
    return {
      answer: `Matched the verified query **"${vq.question}"** from the *${AGENT.name}* agent${vq.note ? ` (${vq.note.toLowerCase().replace(/\.$/, "")})` : ""} — **${rows[0]?.[dim]}** leads at **${fmt.byFormat(rows[0]?.[m], getField(m).format)}**.` + gNote,
      patches, label: `verified: ${vq.question}`,
    };
  }

  // ---- research mode: any analytical question fans out ------------------
  const isExec = /(how (is|'s| is) (the )?business|how are we doing|business doing|overview|executive|briefing|big picture|health|state of)/.test(qn);
  if (mode === "research" && (isExec || meas.length || dims.length)) {
    const m = (meas[0] || getField("order_items.total_revenue")).name;
    return planResearch({ nb, looker, filters, m, topic: question.slice(0, 40) });
  }

  // ---- executive briefing ------------------------------------------------
  if (isExec) {
    const qTotals = queryCell(nb, "q_exec_totals", {
      fields: ["order_items.total_revenue", "order_items.order_count", "order_items.average_order_value", "order_items.total_profit"],
      filters,
    });
    const kpis = jsCell(nb, "exec_kpis", [qTotals.name, "kpi", "kpiRow", "fmt"], `const t = ${qTotals.name}[0];
const margin = t["order_items.total_profit"] / t["order_items.total_revenue"];
return kpiRow(
  kpi("Total revenue", fmt.usd(t["order_items.total_revenue"]), "order_items.total_revenue"),
  kpi("Orders", fmt.num(t["order_items.order_count"]), "order_items.order_count"),
  kpi("Avg order value", fmt.usd(t["order_items.average_order_value"]), "order_items.average_order_value"),
  kpi("Profit margin", fmt.pct(margin), "total_profit / total_revenue")
);`);
    const qMonthly = queryCell(nb, "q_revenue_by_month", {
      fields: ["order_items.created_month", "order_items.total_revenue"],
      filters, sorts: ["order_items.created_month"],
    });
    const chartMonthly = jsCell(nb, "chart_revenue_by_month", [qMonthly.name, "Plot", "fmt", "scheme"], trendChartSource(qMonthly.name, "order_items.total_revenue"));
    const qDept = queryCell(nb, "q_revenue_by_department", {
      fields: ["products.department", "order_items.total_revenue"],
      filters, sorts: ["-order_items.total_revenue"],
    });
    const chartDept = jsCell(nb, "chart_revenue_by_department", [qDept.name, "Plot", "fmt", "scheme"], categoryChartSource(qDept.name, "order_items.total_revenue", "products.department"));
    patches.push(
      { op: "add", cell: qTotals }, { op: "add", cell: kpis },
      { op: "add", cell: qMonthly }, { op: "add", cell: chartMonthly },
      { op: "add", cell: qDept }, { op: "add", cell: chartDept },
    );

    const totals = (await looker.runInlineQuery(qTotals.query)).rows[0];
    const monthly = (await looker.runInlineQuery(qMonthly.query)).rows;
    const growth = sixMonthGrowth(monthly, "order_items.total_revenue");
    return {
      answer: `**Business briefing** — lifetime revenue is **${fmt.usd(totals["order_items.total_revenue"])}** across **${fmt.num(totals["order_items.order_count"])} orders** (AOV **${fmt.usd(totals["order_items.average_order_value"])}**). Revenue is ${growthPhrase(growth)} over the last 6 months. Breakdown below by month and department.` + gNote,
      patches, label: "executive briefing",
    };
  }

  // ---- ranking ("top 10 brands by revenue") ------------------------------
  const topMatch = qn.match(/\b(?:top|best|leading|biggest|largest)\s*(\d+)?\b/) || qn.match(/\b(bottom|worst|smallest)\s*(\d+)?\b/);
  if (topMatch && (dims.length || meas.length)) {
    const asc = /bottom|worst|smallest/.test(topMatch[0]);
    const n = parseInt(topMatch[1] || topMatch[2] || String(TUNING.planner.DEFAULT_TOP_N), 10);
    const dim = dims.find(d => d.datatype !== "time") || getField("products.brand");
    const m = (meas[0] || getField("order_items.total_revenue")).name;
    const q = queryCell(nb, `q_${asc ? "bottom" : "top"}_${slugOf(dim.name)}`, {
      fields: [dim.name, m], filters, sorts: [`${asc ? "" : "-"}${m}`], limit: n,
    });
    const chart = jsCell(nb, `chart_${asc ? "bottom" : "top"}_${slugOf(dim.name)}`, [q.name, "Plot", "fmt", "scheme"], rankingChartSource(q.name, m, dim.name, n));
    patches.push({ op: "add", cell: q }, { op: "add", cell: chart });
    const rows = (await looker.runInlineQuery(q.query)).rows;
    const lead = rows[0];
    return {
      answer: (lead
        ? `${asc ? "Bottom" : "Top"} ${n} ${dim.label.toLowerCase()}s by **${getField(m).label.toLowerCase()}** — **${lead[dim.name]}** ${asc ? "is lowest" : "leads"} at **${fmt.byFormat(lead[m], getField(m).format)}**.`
        : `No rows matched.`) + disambigNote(measMatches, meas.length === 0) + gNote,
      patches, label: `${asc ? "bottom" : "top"} ${n} ${dim.label.toLowerCase()}s`,
    };
  }

  // ---- trend -------------------------------------------------------------
  const timeDim = dims.find(d => d.name === "order_items.created_month");
  const catDims = dims.filter(d => d.datatype !== "time");
  if (timeDim && (meas.length || catDims.length === 0)) {
    const m = (meas[0] || getField("order_items.total_revenue")).name;
    const split = catDims[0];
    const base = `q_${slugOf(m)}_by_month${split ? `_${slugOf(split.name)}` : ""}`;
    const q = queryCell(nb, base, {
      fields: split ? ["order_items.created_month", split.name, m] : ["order_items.created_month", m],
      filters, sorts: ["order_items.created_month"],
    });
    const chart = jsCell(nb, base.replace(/^q_/, "chart_"), [q.name, "Plot", "fmt", "scheme"], trendChartSource(q.name, m, split?.name));
    patches.push({ op: "add", cell: q }, { op: "add", cell: chart });
    const rows = (await looker.runInlineQuery(q.query)).rows;
    const growth = split ? null : sixMonthGrowth(rows, m);
    return {
      answer: `Monthly **${getField(m).label.toLowerCase()}**${split ? ` split by **${split.label.toLowerCase()}**` : ""}${filterNote(filters)}${growth != null ? ` — ${growthPhrase(growth)} over the last 6 months` : ""}.` + disambigNote(measMatches, meas.length === 0) + gNote,
      patches, label: `${getField(m).label} by month`,
    };
  }

  // ---- scalar (never force a chart) --------------------------------------
  if (meas.length && catDims.length === 0) {
    const m = meas[0].name;
    const q = queryCell(nb, `q_${slugOf(m)}`, { fields: [m], filters });
    const card = jsCell(nb, `kpi_${slugOf(m)}`, [q.name, "kpi", "fmt"],
      `const v = ${q.name}[0]["${m}"];\nreturn kpi("${getField(m).label}", fmt.byFormat(v, "${getField(m).format}"), "${m}${filterSuffix(filters)}");`);
    patches.push({ op: "add", cell: q }, { op: "add", cell: card });
    const v = (await looker.runInlineQuery(q.query)).rows[0][m];
    return {
      answer: `**${getField(m).label}**${filterNote(filters)} is **${fmt.byFormat(v, getField(m).format)}**.` + disambigNote(measMatches, false) + gNote,
      patches, label: getField(m).label.toLowerCase(),
    };
  }

  // ---- generic breakdown (measure × category dimension) ------------------
  if (catDims.length) {
    const dim = catDims[0];
    const m = (meas[0] || getField("order_items.total_revenue")).name;
    const cardinality = dimensionValues(dim.name).length;
    const wide = cardinality > TUNING.planner.WIDE_CARDINALITY;
    const base = `q_${slugOf(m)}_by_${slugOf(dim.name)}`;
    const q = queryCell(nb, base, {
      fields: [dim.name, m], filters, sorts: [`-${m}`], ...(wide ? { limit: 10 } : {}),
    });
    const chart = jsCell(nb, base.replace(/^q_/, "chart_"), [q.name, "Plot", "fmt", "scheme"],
      wide ? rankingChartSource(q.name, m, dim.name, 10) : categoryChartSource(q.name, m, dim.name));
    patches.push({ op: "add", cell: q }, { op: "add", cell: chart });
    const rows = (await looker.runInlineQuery(q.query)).rows;
    return {
      answer: `**${getField(m).label}** by **${dim.label.toLowerCase()}**${filterNote(filters)}${wide ? ` (top 10 of ${cardinality})` : ""} — **${rows[0]?.[dim.name]}** leads at **${fmt.byFormat(rows[0]?.[m], getField(m).format)}**.` + disambigNote(measMatches, meas.length === 0) + gNote,
      patches, label: `${getField(m).label} by ${dim.label.toLowerCase()}`,
    };
  }

  // ---- fallback ----------------------------------------------------------
  return {
    answer: `I couldn't map that to the **${EXPLORE.label}** Explore. Try a measure (*revenue, profit, orders, AOV*) with an optional dimension (*by brand, by department, by state, by month*) — or ask *"help"* to see every field.`,
    patches: [], label: "unrecognized",
  };
}

// ---------------------------------------------------------------------------
const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
function sixMonthGrowth(rows, m) {
  if (!rows || rows.length < 12) return null;
  const last6 = rows.slice(-6).reduce((a, r) => a + r[m], 0);
  const prev6 = rows.slice(-12, -6).reduce((a, r) => a + r[m], 0);
  return prev6 ? (last6 - prev6) / prev6 : null;
}
const growthPhrase = g => (g == null ? "steady" : g >= 0 ? `**up ${(g * 100).toFixed(0)}%**` : `**down ${(-g * 100).toFixed(0)}%**`);
const filterNote = f => (Object.keys(f).length ? ` for ${Object.values(f).flat().join(", ")}` : "");
const filterTitle = f => (Object.keys(f).length ? ` (${Object.values(f).flat().join(", ")})` : "");
const filterSuffix = f => (Object.keys(f).length ? ` · ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ")}` : "");

// ---------------------------------------------------------------------------
// LLM adapter — the production integration point for Gemini (Vertex AI,
// generateContent, responseMimeType: application/json — see src/gemini.js).
//
// One call per turn. The context is tiny by construction: the field catalog
// (~200 tokens), the notebook outline (names + kinds + query specs), and the
// <150-token statistical profile of each live result set. NO raw rows.
// The model returns the same {answer, patches} shape the rules planner emits;
// on any parse/validation failure, fall back to plan() above so the product
// never hard-fails on a weak model response.
// ---------------------------------------------------------------------------
export const COMPILER_SYSTEM_PROMPT = `You are a notebook compiler for chat-driven Looker analytics.
Given a user question, an Explore field catalog, the current notebook outline, and compact
statistical profiles of live query results, emit ONE JSON object:
{"answer": "<markdown, 1-2 sentences, cite real numbers from profiles>",
 "patches": [
   {"op":"add","cell":{"name":"q_x","kind":"query","query":{"fields":[...],"filters":{...},"sorts":[...],"limit":N}}},
   {"op":"add","cell":{"name":"chart_x","kind":"js","inputs":["q_x","Plot","fmt","scheme"],"source":"return Plot.plot({...})"}},
   {"op":"add","cell":{"name":"md_x","kind":"md","source":"### heading..."}},
   {"op":"update","id":"<cellId>","cell":{...full replacement...}},
   {"op":"remove","id":"<cellId>"}]}
When the Grounding section reports AMBIGUOUS for a term, output
{"answer":"<one-line question>","clarify":{"term":"...","options":[{"field":"...","value":"..."}]},"patches":[]}
instead of guessing — the user resolves it with one click and no further model call.
Rules:
- Prefer UPDATING existing cells (filters, added dimensions) over adding new ones.
- Grounding's committed filters are authoritative value bindings from real SDK value
  scans — use them verbatim; never invent filter values not present in grounding.
- Scalar questions: KPI cell only, never a chart. Rankings: Plot.barX, marginLeft:180,
  tip:true, explicit limit. Trends: areaY+lineY over created_month.
- DISAMBIGUATION: when several catalog fields could match the user's words, or you
  assume a default, say so in the answer: name the chosen LookML field and up to two
  alternates. The query cell's field pills are the user's one-click correction.
- JOINS: never reason about them. Reference fields from any view; the engine resolves
  the LookML join graph deterministically.
- MODE=chat: minimal cells, direct answer. MODE=research: fan out one exhaustive
  investigation (8–14 cells): md section header, KPI row, trend, breakdowns across the
  major dimensions, and a closing md findings cell citing numbers from the profiles.
- js cell "source" is an async function body; inputs are injected by name.
  Builtins: Plot, d3, fmt (usd/num/pct/date/month), kpi, kpiRow, table, scheme.
- Query specs run through Looker run_inline_query verbatim; only use catalog fields.
- Output JSON only.`;

export async function planWithLLM(ctx, callModel) {
  const { question, nb, profiles, mode = "chat", choices = {} } = ctx;
  const catalog = EXPLORE.fields.filter(visible).map(f => `${f.name} (${f.type}${f.format ? ":" + f.format : ""}) aka ${f.synonyms.join("/")}`).join("\n");
  const outline = nb.cells.map(c =>
    `${c.id} ${c.name} [${c.kind}]${c.kind === "query" ? " " + JSON.stringify(c.query) : ""}${profiles?.get(c.id) ? `\n  profile: ${profiles.get(c.id)}` : ""}`).join("\n");
  // Same SDK-derived grounding evidence the rules planner uses (~40 tokens).
  const g = groundQuestion(normalize(question), { choices });
  const user = `# Question\n${question}\n\n# MODE\n${mode}\n\n${agentToPrompt()}\n\n${groundingToPrompt(g)}\n\n# Explore catalog (model=${EXPLORE.model}, view=${EXPLORE.view}, joins auto-resolved)\n${catalog}\n\n# Notebook\n${outline || "(empty)"}`;
  const raw = await callModel({ system: COMPILER_SYSTEM_PROMPT, user });
  try {
    const parsed = JSON.parse(raw.replace(/^```json?\s*|```\s*$/g, ""));
    if (!parsed || typeof parsed.answer !== "string" || !Array.isArray(parsed.patches)) throw new Error("bad shape");
    for (const p of parsed.patches)
      if (p.op === "add") { p.cell.id = nextCellId(); p.cell.name = uniqueName(nb, p.cell.name || "cell"); }
    return { ...parsed, label: question.slice(0, 40) };
  } catch {
    return plan(ctx); // deterministic fallback — never hard-fail the turn
  }
}
