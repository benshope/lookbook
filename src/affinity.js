// Affinity signals: recency & popularity context gathered from the Looker
// SDK at session start — cheap deterministic calls whose INTERPRETATION is
// deliberately delegated to the LLM via prompt instructions (see
// PERSONALIZATION block in compiler.js), not hardcoded heuristics. The
// rules planner uses them only for mild tie-breaks; a real model is told it
// is empowered to peek at them and bias its guesses, citing when it does.
//
// Every signal maps to a documented SDK surface — and most flow through the
// SAME run_inline_query seam the data path already uses:
//
//   user recent/frequent   run_inline_query on model "system__activity",
//   explores & fields      view "history": fields [query.view,
//                          query.formatted_fields, history.query_run_count],
//                          filters {user.id: "me", history.created_date:
//                          "30 days"} — query history, per user
//   org-popular fields     same query without the user filter
//   favorite dashboards    search_content_favorites(user_id) → dashboard()
//                          → tile queries → their fields
//   most-viewed content    search_content_views / search_dashboards
//                          (sorts: "view_count desc")
//   recent conversations   this product's own saved .lookernb.json
//                          artifacts (turn history + cell fields)
//
// All of it is post-RLS: System Activity and content endpoints only return
// what this user is permitted to see.

import { TUNING } from "./tuning.js";

// ---------------------------------------------------------------------------
// Mock signals for the standalone demo — the shape is the contract.
// Swap for SdkAffinitySource in production (calls documented above).
// ---------------------------------------------------------------------------
export const MOCK_AFFINITY = {
  user: {
    recentExplores: [{ explore: "order_items", runs30d: 14 }],
    frequentFields: [
      { field: "order_items.total_revenue", runs30d: 11 },
      { field: "users.state", runs30d: 7 },
      { field: "products.brand", runs30d: 5 },
    ],
  },
  org: {
    popularFields: [
      { field: "order_items.total_revenue", runs30d: 240 },
      { field: "products.department", runs30d: 130 },
      { field: "order_items.created_month", runs30d: 95 },
    ],
    favoriteDashboards: [
      { title: "Regional performance", views30d: 62, fields: ["users.state", "order_items.total_revenue"] },
      { title: "Brand scorecard", views30d: 41, fields: ["products.brand", "order_items.total_revenue"] },
    ],
  },
  recentConversations: [
    { title: "State revenue follow-ups", fields: ["users.state", "order_items.total_revenue"] },
  ],
};

// ---------------------------------------------------------------------------
// Deterministic tie-break weight for a field. The RULES planner only uses
// this where scores are otherwise EQUAL (clarify option ordering, measure
// ties) — affinity may order guesses, never override explicit user words.
// ---------------------------------------------------------------------------
export function fieldWeight(signals, field) {
  if (!signals) return 0;
  const A = TUNING.affinity;
  let w = 0;
  for (const f of signals.user?.frequentFields || [])
    if (f.field === field) w += f.runs30d * A.USER_RUN_WEIGHT;
  for (const f of signals.org?.popularFields || [])
    if (f.field === field) w += f.runs30d * A.ORG_RUN_WEIGHT;
  for (const d of signals.org?.favoriteDashboards || [])
    if (d.fields.includes(field)) w += d.views30d * A.FAVORITE_DASHBOARD_WEIGHT;
  for (const c of signals.recentConversations || [])
    if (c.fields.includes(field)) w += A.CONVERSATION_WEIGHT;
  return w;
}

// ---------------------------------------------------------------------------
// Compact prompt block (~80 tokens). What to include is a tuning decision;
// how to USE it is an instruction decision — see [AGENT-SITE:personalization]
// in compiler.js.
// ---------------------------------------------------------------------------
export function affinityToPrompt(signals) {
  if (!signals) return "";
  const lines = [];
  const ff = signals.user?.frequentFields?.slice(0, TUNING.affinity.PROMPT_FIELDS_N);
  if (ff?.length) lines.push(`user's frequent fields (30d): ${ff.map(f => `${f.field}(${f.runs30d})`).join(", ")}`);
  const pf = signals.org?.popularFields?.slice(0, TUNING.affinity.PROMPT_FIELDS_N);
  if (pf?.length) lines.push(`org-popular fields (30d): ${pf.map(f => `${f.field}(${f.runs30d})`).join(", ")}`);
  for (const d of signals.org?.favoriteDashboards?.slice(0, 2) || [])
    lines.push(`favorite dashboard "${d.title}" uses: ${d.fields.join(", ")}`);
  for (const c of signals.recentConversations?.slice(0, 2) || [])
    lines.push(`recent conversation "${c.title}" touched: ${c.fields.join(", ")}`);
  return lines.length ? `# Activity signals (from SDK, post-RLS)\n${lines.join("\n")}` : "";
}
