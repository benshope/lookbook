// Agent context — a portable "data agent" definition: custom instructions,
// a business glossary, default filters, hidden fields, and verified queries.
// The standard managed-data-agent feature surface, but consumed CLIENT-SIDE
// by the planner (rules or Gemini) — it costs prompt tokens once per turn,
// not extra LLM calls.
//
// In production this object is authored per-agent and stored alongside the
// agent config; here it ships a working example so the behavior is
// demonstrable offline.

export const AGENT = {
  name: "Retail revenue agent",

  // [AGENT-SITE:instructions] Persona, defaults, and domain guidance. This
  // string is prepended verbatim to the planner prompt every turn — the
  // primary place an installation LLM (or agent author) injects behavior.
  // Free-text instructions — prepended to the Gemini system prompt, and the
  // tone/defaults the rules planner mirrors.
  instructions:
    "You support merchandising and finance stakeholders of an apparel retailer. " +
    "When a question is ambiguous, prefer revenue over unit counts. " +
    "Currency is USD. Fiscal year equals calendar year.",

  // [AGENT-SITE:glossary] Org jargon → LookML field. Glossary hits outrank
  // ordinary synonym matches during disambiguation. Installation LLMs should
  // seed this from org wikis, dashboard titles, and past chat transcripts.
  glossary: {
    "gmv": "order_items.total_revenue",
    "take": "order_items.total_profit",
    "basket": "order_items.average_order_value",
    "doors": "users.state",           // retail slang: markets/regions
    "merch": "products.department",
    "labels": "products.brand",
  },

  // [AGENT-SITE:default-filters] Applied to every NEW query the planner creates (user filters win on
  // conflict). Example: an agent scoped to US business would set
  // {"users.country": "USA"}. Empty here so demo numbers match the raw data.
  defaultFilters: {},

  // [AGENT-SITE:hidden-fields] Fields the agent may never select or display.
  hiddenFields: [],

  // [AGENT-SITE:verified-queries] Curated example Q&A pairs. The rules planner checks these
  // before intent heuristics; planWithLLM includes them as few-shot examples.
  verifiedQueries: [
    {
      question: "what are our top sellers",
      spec: {
        fields: ["products.brand", "order_items.total_revenue"],
        sorts: ["-order_items.total_revenue"],
        limit: 10,
      },
      chart: "ranking",
      note: "Merchandising defines 'top sellers' as brands by revenue, not units.",
    },
  ],
};

// Compact serialization for the Gemini system prompt (~100 tokens).
export function agentToPrompt(agent = AGENT) {
  const g = Object.entries(agent.glossary).map(([k, v]) => `"${k}"→${v}`).join(", ");
  const vq = agent.verifiedQueries
    .map(v => `Q:"${v.question}" → ${JSON.stringify(v.spec)}${v.note ? ` (${v.note})` : ""}`)
    .join("\n");
  return `# Agent: ${agent.name}\n${agent.instructions}\nGlossary: ${g}\n` +
    (Object.keys(agent.defaultFilters).length ? `Default filters: ${JSON.stringify(agent.defaultFilters)}\n` : "") +
    (agent.hiddenFields.length ? `Never use fields: ${agent.hiddenFields.join(", ")}\n` : "") +
    (vq ? `Verified queries:\n${vq}` : "");
}
