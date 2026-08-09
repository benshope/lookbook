# Agent-instruction sites

Every place where behavior should be changed by **installing instructions** (agent
config or prompt text) rather than editing code is marked with a grep-able tag:

```bash
grep -rn "AGENT-SITE" src/
```

This is the map for the installation LLM: when adapting Lookbook to an org, write
into these sites first; touch code only when a site can't express the change.

| Site | File | What to install there |
|---|---|---|
| `[AGENT-SITE:instructions]` | `src/agent.js` | Persona, stakeholder context, currency/fiscal conventions, ambiguity preferences ("prefer revenue over unit counts"). Prepended verbatim to every planner prompt. |
| `[AGENT-SITE:glossary]` | `src/agent.js` | Org jargon → LookML field. Seed from wikis, dashboard titles, and past chat transcripts; glossary hits outrank generic synonyms. |
| `[AGENT-SITE:default-filters]` | `src/agent.js` | Scope filters applied to every new query (e.g. region, brand-family). |
| `[AGENT-SITE:hidden-fields]` | `src/agent.js` | Fields the agent must never select or show. |
| `[AGENT-SITE:verified-queries]` | `src/agent.js` | Curated Q&A pairs that beat heuristics outright ("top sellers" = brands by revenue). Highest-leverage site: harvest from questions users re-ask. |
| `[AGENT-SITE:system]` | `src/compiler.js` | Global planner behavior: chart conventions, tone, output-shape rules. |
| `[AGENT-SITE:personalization]` | `src/compiler.js` | How boldly activity signals (recent explores, favorite dashboards, org-popular fields) may bias guesses, and when to cite them. Deliberately instructions, not code — the model is *empowered to peek*, and the wording sets how far it leans. |
| `[AGENT-SITE:clarify-policy]` | `src/compiler.js` | Ask-vs-guess tolerance for ambiguous terms. |
| `[AGENT-SITE:research-scope]` | `src/compiler.js` | Research-mode breadth and emphasis in LLM mode. |
| (signal selection) | `src/affinity.js` + `tuning.affinity` | *Which* signals reach the prompt and their tie-break weights — the only affinity decision kept in code, because it gates tokens. |

## Division of labor (why signals are code but judgment is prompt)

- **Code fetches** — affinity signals come from cheap, deterministic SDK calls
  (System Activity `history` via `run_inline_query`, `search_content_favorites`,
  content-view counts) at session start. Post-RLS by construction.
- **Instructions decide** — the PERSONALIZATION prompt block tells the model it may
  bias defaults, tie-breaks, and clarification-chip ordering using those signals,
  must cite when a signal changed a choice, and may never override the user's
  explicit words or invent filter values outside grounding.
- **The rules planner stays conservative** — it uses signals only where scores are
  exactly tied (clarify chip ordering, measure tie-breaks), so the deterministic
  fallback never surprises anyone.

Hill-climb the wording of these sites like any knob: golden set → one change →
`node evals/run.mjs` → ratchet (docs/EVAL-PLAN.md).
