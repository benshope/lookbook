// The Looker data layer. One interface, two implementations:
//
//   MockLookerClient        — in-memory LookML-style engine over the
//                             normalized synthetic DB, including real join
//                             resolution, so this repo runs standalone.
//   PostMessageLookerClient — the production seam: forwards the identical
//                             query spec over window.postMessage to a React
//                             host that calls @looker/sdk run_inline_query
//                             (never manual fetch — row-level security, user
//                             permissions and model grants stay enforced).
//
// The query spec IS the Looker inline-query body: {model, view, fields,
// filters, sorts, limit}. Swapping mock → real changes zero call sites.
//
// JOIN RESOLUTION IS NOT AN LLM PROBLEM. Fields name their view; the explore
// declares the join graph; the engine walks it deterministically (users joins
// through orders). The planner never spends a token on it, and every query
// cell displays the join plan it used — transparency instead of a black box.

import { DB } from "./data.js";

// ---------------------------------------------------------------------------
// LookML-style model: views own fields; the explore declares the join graph.
// `synonyms` power field disambiguation (compiler.js) and double as the
// vocabulary hints you'd hand Gemini in the system prompt.
// Accessors receive a JOINED context row: {oi, order, product, user}.
// ---------------------------------------------------------------------------
export const EXPLORE = {
  model: "thelook",
  view: "order_items",
  label: "E-commerce Order Items",
  joins: {
    orders:   { sql_on: "order_items.order_id = orders.id",   relationship: "many_to_one", requires: [] },
    products: { sql_on: "order_items.product_id = products.id", relationship: "many_to_one", requires: [] },
    users:    { sql_on: "orders.user_id = users.id",          relationship: "many_to_one", requires: ["orders"] },
  },
  fields: [
    // -------- dimensions --------
    {
      name: "order_items.created_month", label: "Created Month", type: "dimension", datatype: "time",
      synonyms: ["month", "monthly", "over time", "trend", "by month", "time"],
      accessor: c => c.order.created_date.slice(0, 7),
    },
    {
      name: "order_items.created_year", label: "Created Year", type: "dimension", datatype: "time",
      synonyms: ["year", "yearly", "annual"],
      accessor: c => c.order.created_date.slice(0, 4),
    },
    {
      name: "products.department", label: "Department", type: "dimension",
      synonyms: ["department", "departments", "dept", "category", "categories"],
      accessor: c => c.product.department,
    },
    {
      name: "products.brand", label: "Brand", type: "dimension",
      synonyms: ["brand", "brands", "vendor", "label", "make"],
      accessor: c => c.product.brand,
    },
    {
      name: "users.state", label: "State", type: "dimension",
      synonyms: ["state", "states", "region", "geography", "location", "where"],
      accessor: c => c.user.state,
    },
    {
      name: "orders.traffic_source", label: "Traffic Source", type: "dimension",
      synonyms: ["traffic", "channel", "channels", "source", "marketing", "acquisition"],
      accessor: c => c.order.traffic_source,
    },
    // -------- measures --------
    {
      name: "order_items.total_revenue", label: "Total Revenue", type: "measure", format: "usd",
      synonyms: ["revenue", "sales", "total sales", "gmv", "income", "earn", "made"],
      aggregate: ctxs => sum(ctxs, c => c.oi.sale_price),
    },
    {
      name: "order_items.total_profit", label: "Total Profit", type: "measure", format: "usd",
      synonyms: ["profit", "margin", "profitability", "net"],
      aggregate: ctxs => sum(ctxs, c => c.oi.sale_price - c.product.cost),
    },
    {
      name: "order_items.order_count", label: "Order Count", type: "measure", format: "int",
      synonyms: ["orders", "order count", "purchases", "transactions", "how many orders"],
      aggregate: ctxs => new Set(ctxs.map(c => c.oi.order_id)).size,
    },
    {
      name: "order_items.item_count", label: "Items Sold", type: "measure", format: "int",
      synonyms: ["items", "units", "quantity", "sold", "count"],
      aggregate: ctxs => ctxs.length,
    },
    {
      name: "order_items.average_order_value", label: "Average Order Value", type: "measure", format: "usd",
      synonyms: ["aov", "average order value", "average order", "basket size", "avg order"],
      aggregate: ctxs => {
        const orders = new Set(ctxs.map(c => c.oi.order_id)).size;
        return orders ? sum(ctxs, c => c.oi.sale_price) / orders : 0;
      },
    },
  ],
};

const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
const round2 = n => Math.round(n * 100) / 100;
const fieldByName = new Map(EXPLORE.fields.map(f => [f.name, f]));
export const getField = name => fieldByName.get(name);
export const dimensions = () => EXPLORE.fields.filter(f => f.type === "dimension");
export const measures = () => EXPLORE.fields.filter(f => f.type === "measure");

// ---------------------------------------------------------------------------
// Join resolution: fields → required views → dependency-expanded, ordered
// join plan. Pure graph walk over the explore's LookML declarations.
// ---------------------------------------------------------------------------
export function resolveJoins(fieldNames) {
  const needed = new Set();
  for (const fname of fieldNames) {
    const view = fname.split(".")[0];
    if (view !== EXPLORE.view && EXPLORE.joins[view]) needed.add(view);
  }
  // Expand transitive requirements (users needs orders).
  let grew = true;
  while (grew) {
    grew = false;
    for (const view of [...needed])
      for (const req of EXPLORE.joins[view].requires)
        if (!needed.has(req)) { needed.add(req); grew = true; }
  }
  // Order so prerequisites join first.
  const ordered = [];
  const emit = view => {
    if (ordered.includes(view)) return;
    for (const req of EXPLORE.joins[view].requires) emit(req);
    ordered.push(view);
  };
  for (const view of needed) emit(view);
  return ordered.map(view => ({ view, ...EXPLORE.joins[view] }));
}

// The joined fact table, built once: every order_item hydrated with its
// order, product, and user (what the SQL join would materialize).
let JOINED = null;
export function joinedRows() {
  if (!JOINED) {
    const ordersById = new Map(DB.orders.map(o => [o.id, o]));
    const productsById = new Map(DB.products.map(p => [p.id, p]));
    const usersById = new Map(DB.users.map(u => [u.id, u]));
    JOINED = DB.order_items.map(oi => {
      const order = ordersById.get(oi.order_id);
      return { oi, order, product: productsById.get(oi.product_id), user: usersById.get(order.user_id) };
    });
  }
  return JOINED;
}

// Distinct values of a dimension (filter matching + cardinality decisions).
export function dimensionValues(name) {
  const f = getField(name);
  if (!f || f.type !== "dimension") return [];
  return [...new Set(joinedRows().map(f.accessor))].sort();
}

// Pseudo-SQL with the real join plan, for transparency in the query cell UI.
export function queryToSQL(spec) {
  const dims = spec.fields.filter(f => getField(f)?.type === "dimension");
  const meas = spec.fields.filter(f => getField(f)?.type === "measure");
  const joins = resolveJoins([...spec.fields, ...Object.keys(spec.filters || {})]);
  const lines = [
    `SELECT ${[...dims, ...meas.map(m => `AGG(${m})`)].join(", ") || "*"}`,
    `FROM ${spec.model || EXPLORE.model}.${spec.view || EXPLORE.view}`,
    ...joins.map(j => `LEFT JOIN ${j.view} ON ${j.sql_on}  -- ${j.relationship}`),
  ];
  const filters = Object.entries(spec.filters || {});
  if (filters.length)
    lines.push(`WHERE ${filters.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(" AND ")}`);
  if (dims.length) lines.push(`GROUP BY ${dims.join(", ")}`);
  if (spec.sorts?.length)
    lines.push(`ORDER BY ${spec.sorts.map(s => s.startsWith("-") ? `${s.slice(1)} DESC` : s).join(", ")}`);
  if (spec.limit) lines.push(`LIMIT ${spec.limit}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MockLookerClient — grouped aggregation over the joined fact table.
// Result rows match run_inline_query's shape: one object per row, keys are
// fully-qualified LookML field names.
// ---------------------------------------------------------------------------
export class MockLookerClient {
  constructor({ latency = 120 } = {}) { this.latency = latency; }

  async runInlineQuery(spec) {
    const t0 = performance.now();
    const joins = resolveJoins([...spec.fields, ...Object.keys(spec.filters || {})]);
    let ctxs = joinedRows();

    for (const [fname, want] of Object.entries(spec.filters || {})) {
      const f = getField(fname);
      if (!f || f.type !== "dimension") continue;
      const wants = Array.isArray(want) ? want.map(String) : [String(want)];
      ctxs = ctxs.filter(c => wants.includes(String(f.accessor(c))));
    }

    const dims = spec.fields.filter(f => getField(f)?.type === "dimension");
    const meas = spec.fields.filter(f => getField(f)?.type === "measure");

    let out;
    if (dims.length === 0) {
      const row = {};
      for (const m of meas) row[m] = round2(getField(m).aggregate(ctxs));
      out = [row];
    } else {
      const groups = new Map();
      for (const c of ctxs) {
        const key = dims.map(d => getField(d).accessor(c)).join(" ");
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push(c);
      }
      out = [...groups.entries()].map(([key, g]) => {
        const row = {};
        key.split(" ").forEach((v, i) => (row[dims[i]] = v));
        for (const m of meas) row[m] = round2(getField(m).aggregate(g));
        return row;
      });
    }

    const sorts = spec.sorts?.length ? spec.sorts : dims.length ? [dims[0]] : [];
    for (const s of [...sorts].reverse()) {
      const desc = s.startsWith("-");
      const f = desc ? s.slice(1) : s;
      out.sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0) * (desc ? -1 : 1));
    }
    if (spec.limit) out = out.slice(0, spec.limit);

    if (this.latency) await new Promise(res => setTimeout(res, this.latency));
    return {
      rows: out,
      sql: queryToSQL(spec),
      joins: joins.map(j => j.view),
      elapsedMs: Math.round(performance.now() - t0 + this.latency),
    };
  }
}

// ---------------------------------------------------------------------------
// PostMessageLookerClient — production seam for the sandboxed iframe.
// The host (React 17, no JSX — see PORTING.md) listens for LOOKBOOK_QUERY,
// executes via @looker/sdk:
//   const res = await sdk.ok(sdk.run_inline_query({result_format:"json", body: spec}))
// and posts back LOOKBOOK_RESULT with the same requestId.
// ---------------------------------------------------------------------------
export class PostMessageLookerClient {
  constructor({ targetOrigin }) {
    if (!targetOrigin) throw new Error("targetOrigin is required — never use '*' for query traffic");
    this.targetOrigin = targetOrigin;
    this.pending = new Map();
    this.nextId = 1;
    window.addEventListener("message", ev => {
      if (ev.origin !== this.targetOrigin) return; // validated bridge
      const msg = ev.data;
      if (msg?.type !== "LOOKBOOK_RESULT" || !this.pending.has(msg.requestId)) return;
      const { resolve, reject } = this.pending.get(msg.requestId);
      this.pending.delete(msg.requestId);
      msg.error ? reject(new Error(msg.error)) : resolve(msg.payload);
    });
  }
  runInlineQuery(spec) {
    return new Promise((resolve, reject) => {
      const requestId = this.nextId++;
      this.pending.set(requestId, { resolve, reject });
      window.parent.postMessage({ type: "LOOKBOOK_QUERY", requestId, spec }, this.targetOrigin);
      setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error("Looker host timed out after 30s"));
      }, 30_000);
    });
  }
}
