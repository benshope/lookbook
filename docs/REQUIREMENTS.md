# Feature requirements coverage

Positioning: Lookbook is an **iterative improvement to existing chat-BI product
surfaces** — it satisfies the feature requirements that managed data-agent products
document (agents, multi-turn conversations, grounded field selection, code-executing
analysis, permissions) while replacing only the *delivery mechanism*: reactive notebook
cells instead of static chart payloads, and one planner call per turn instead of a
multi-call backend pipeline.

| Standard data-agent capability | Lookbook status | Where / how |
|---|---|---|
| Natural-language questions over a governed Explore | ✅ | `compiler.js` planner; same question surface |
| **Fast vs deep answer modes** | ✅ | Chat vs **Research** toggle — research fans one planner call out into a 10–14-cell investigation with a computed findings narrative (`planResearch`) |
| **Agent custom instructions** (persona, tone, defaults) | ✅ | `agent.js` `AGENT.instructions` → prepended to the Gemini prompt; rules planner mirrors defaults |
| **Business glossary** (org jargon → fields) | ✅ | `AGENT.glossary`; glossary hits outrank ordinary synonyms in disambiguation (demo: "gmv", "basket", "merch") |
| **Default filters** per agent | ✅ | `AGENT.defaultFilters` merged into every new query spec (explicit filters win) |
| **Hidden fields** | ✅ | `AGENT.hiddenFields` excluded from resolution, help listings, pills, and the LLM catalog |
| **Verified queries** (curated example Q&A pairs) | ✅ | `AGENT.verifiedQueries` — exact-spec match beats heuristics (demo: "top sellers"); included as few-shot examples in the LLM prompt |
| Grounded in the LookML semantic layer (labels, types, descriptions) | ✅ | `EXPLORE.fields` catalog is the only field source; specs run through `run_inline_query` verbatim |
| Sample values + fuzzy filter matching | ✅ | `dimensionValues()` + word-boundary value index in `resolveFilters` ("only outerwear", "in california") |
| Join handling across views | ✅ **improved** | LookML join graph walked deterministically (`resolveJoins`, incl. transitive users-through-orders); zero LLM tokens spent; every query cell displays its join plan (⋈ chip) |
| Field-selection transparency | ✅ **improved** | Disambiguation notes in answers ("Interpreted *sales* as `order_items.total_revenue` — alternates: …") + clickable pills to swap — an affordance most chat-BI products lack |
| Multi-turn conversation sessions | ✅ | Turn history + conversational focus (`lastQuery`/`lastChart`) for follow-ups ("only 2025", "break that down") |
| **Code-executing analysis** (NL → executed code) | ✅ **improved** | NL → JavaScript cells executed in the in-browser Observable DAG — same capability class as a server-side Python interpreter, without the sandbox round-trip, and every generated program stays visible/editable in the Canvas |
| Data permissions (LookML model, access grants, RLS) | ✅ by construction | All execution via `@looker/sdk run_inline_query` (PostMessageLookerClient); the client never bypasses the SDK |
| Agent sharing / feedback (thumbs) | 🟡 roadmap | Agent = one serializable object (`agent.js`), so share/manage maps onto existing Looker content permissions; per-turn feedback is a UI affordance away |
| Dashboard-scoped agents | 🟡 roadmap | The `.lookernb.json` → dashboard exporter is the inverse path; a dashboard-scoped agent context is the same `AGENT` shape with tile-derived queries |
| Multiple Explores per agent | 🟡 roadmap | Catalog is explore-scoped by design; multi-explore = a catalog array + explore field in the spec (planner contract already carries `model`/`view`) |

## What Lookbook adds beyond the standard feature list

- **<2ms interactivity**: filter/breakdown turns mutate existing cells; charts re-render
  reactively with zero new LLM output (`±N updated · 0ms` turns).
- **83% multi-turn token reduction** (measured, `bench.html`): statistical profiles
  replace raw row echoes in context.
- **Revision history + undo/redo**: every turn is an inspectable diff; ⌘Z walks inverse
  patches.
- **Persistence**: `.lookernb.json` export; queries are already `create_query` bodies,
  so "Save to Looker" is lossless.
- **Deterministic fallback**: a malformed model response degrades to the rules planner,
  never to a failed turn.
