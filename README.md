# Lookbook — an ObservableHQ Reactive Canvas for Looker

A working reference implementation of a **front-end-centric** chat-with-your-data
product: one planner/LLM call per turn, an in-browser reactive notebook as the source of
truth, and Observable Plot for visualization. Zero build step, zero backend — clone and open.

```bash
python3 -m http.server 8321
# open http://localhost:8321            — the app
# open http://localhost:8321/bench.html — the 11-case benchmark suite
node --test tests/                       # unit tests (joins, patches, profiler)
```

## Why this exists

Typical server-orchestrated chat-BI products route every user question through a
multi-call backend pipeline — field disambiguation calls, join-resolution calls, Python
sandboxes over result sets — then return **static chart payloads** into a transient chat
drawer. The result: 12–18s turns, ~2,100 tokens of context per turn, inert charts, opaque
field selection, and no revision history.

This repo demonstrates the inversion. The chat UI is a *lens over a reactive notebook
document*. Each turn is exactly **one planner call** that emits **cell patches** (add /
update / remove). An `@observablehq/runtime` DAG evaluates cells in browser memory, so a
filter change is a 0ms document mutation plus one `run_inline_query` — every downstream
chart re-renders reactively.

| Capability | Server-orchestrated pipeline | This repo |
|---|---|---|
| Output format | Static JSON schema / pre-rendered plot | In-memory JavaScript reactive DAG |
| Interactivity latency | 12–18s (server LLM round-trip) | <2ms client-side re-render |
| Multi-turn token overhead | ~2,100 tokens/turn (raw rows) | **86% smaller** (statistical profiles, measured by `bench.html`) |
| Scalar intent handling | Forced single-bar chart | 1-sentence answer + KPI card |
| LookML transparency | Opaque backend mapping | Clickable field pills, swap from the canvas |
| Exploration recovery | Corrective prompts | Native undo/redo (⌘Z / ⇧⌘Z) over patch stack |
| Downstream persistence | Ephemeral chat drawer | `.lookernb.json` export (→ Looker UDD) |

## The demo script (60 seconds)

1. **"How is the business doing?"** → multi-cell executive briefing: KPI row + monthly
   revenue area + department bars. No forced single chart.
2. **"Top 10 brands by revenue"** → horizontal bar, `marginLeft: 180`, `tip: true`, `LIMIT 10`.
3. **"Only 2025"** → *zero new cells*. Four query specs get a filter patch; every chart
   re-renders reactively. The turn reports `±4 updated · 0ms`.
4. **"Break that down by department"** → two cell diffs: dimension added to the query,
   chart recompiled to a stacked mark.
5. Switch to **Canvas** → the same document as a notebook: sources, field pills
   (click to swap a measure/dimension — the LookML disambiguation bar), pseudo-SQL,
   join-plan chips (⋈ orders → users), per-turn diffs in the revision history panel.
6. **⌘Z** → the breakdown reverts. **💾 Save** → `.lookernb.json`.
7. Toggle **🔬 Research** and ask **"Deep dive on gmv for 2025"** → the agent glossary
   resolves *gmv*, and ONE planner call fans out a 12-cell investigation: section
   header, KPI row, trend, three breakdowns, and a computed findings narrative.
   (Fast-answer and deep-investigation modes, plus code-executing analysis, in one.)
8. Ask **"What are our top sellers?"** → the agent's *verified query* answers with the
   merchandising definition, bypassing heuristics entirely.

## Architecture

```
┌──────────────────────────── Chat view ───────────────────────────┐
│  user bubble → answer md → live cells created by that turn       │
│  (cells are re-parented, never re-rendered, between views)       │
├──────────────────────────── Canvas view ─────────────────────────┤
│  full document: cell sources, field pills, diffs, undo/redo      │
└──────────────────────────────────────────────────────────────────┘
                 │ both views render the same state
                 ▼
   notebook.js  — cell list + patch application + inverse patches
   runtime.js   — @observablehq/runtime DAG; builtins: Plot, d3,
                  fmt, kpi, kpiRow, table, scheme
   compiler.js  — ONE call per turn: question → {answer, patches}
                  (rules planner now; planWithLLM() is the Gemini seam;
                  chat mode = minimal cells, research mode = full fan-out)
   agent.js     — data-agent context: instructions, business glossary,
                  default filters, hidden fields, verified queries
   profiler.js  — <150-token statistical profile per result set;
                  the ONLY data context that enters multi-turn history
   looker.js    — query spec = Looker inline-query body verbatim;
                  LookML join graph resolved deterministically (zero LLM
                  tokens — join plans shown on every query cell);
                  MockLookerClient (demo) | PostMessageLookerClient
                  (sandboxed iframe → React host → @looker/sdk)
   gemini.js    — Vertex AI generateContent adapter (one call, JSON out)
```

### Cell model (`.lookernb.json`)

```jsonc
{
  "id": "c3",                       // stable identity for patches/undo
  "name": "q_revenue_by_month",     // reactive symbol other cells reference
  "kind": "query",                  // "md" | "query" | "js"
  "query": {                        // Looker inline-query body, verbatim
    "fields": ["order_items.created_month", "order_items.total_revenue"],
    "filters": { "order_items.created_year": "2025" },
    "sorts": ["order_items.created_month"]
  }
}
{
  "id": "c4",
  "name": "chart_revenue_by_month",
  "kind": "js",
  "inputs": ["q_revenue_by_month", "Plot", "fmt", "scheme"],
  "source": "return Plot.plot({ ... })"   // async function body
}
```

Patches are the only mutation primitive; `applyPatches` returns inverse patches, which
*is* the undo/redo stack — no snapshots, no divergence.

### How a turn is orchestrated (LLM calls vs Looker API calls)

There is no hidden agent loop — but the discovery work a server-side pipeline does
across multiple LLM round-trips still happens. It moved into deterministic SDK phases
around exactly one model call. Principle: **SDK calls are essentially free; LLM calls
are not — so pound on the SDK.**

```
session start
   │
   ▼
[SDK bootstrap]       ← field catalog (lookml_model_explore) + value
   │                    inventories per filterable dimension (cheap
   │                    grouped run_inline_query scans). Zero LLM.
   ▼
user question
   │
   ▼
[grounding]           ← fuzzy-match question terms against real values;
   │                    score hypotheses: commit / clarify / note.
   │                    (grounding.js — still zero LLM)
   ▼
[1 planner/LLM call]  ← inputs assembled from memory: field catalog,
   │                    grounding hypotheses, notebook outline, per-cell
   │                    <150-token profiles. The LLM NEVER queries Looker
   │                    and never sees rows. If grounding reported genuine
   │                    ambiguity, this turn returns clarification chips —
   │                    the user resolves it with a click, and re-planning
   │                    with the binding costs ZERO further LLM calls.
   ▼
{answer, patches}     ← declarative output: query specs + JS cells
   │
   ▼
applyPatches → runtime.sync()
   │
   ▼
Observable DAG re-evaluates ONLY affected cells
   ├─ query cells (re)run  →  [N × run_inline_query]  ← the ONLY Looker
   │       │                    API traffic; independent queries run
   │       │                    concurrently, ordering comes free from
   │       │                    the dependency graph
   │       ▼
   │   profiler compresses each result → profiles map
   ▼
chart/KPI/table cells re-render from their query inputs
   │
   └─ profiles (not rows) become part of the NEXT turn's LLM context
```

So Looker API calls are a *side effect of document evaluation*, not steps in an
orchestration script. When a turn only mutates filters, the LLM emits two small
patches and the DAG re-runs the affected queries — the model is never consulted
about how to fetch, join, sort, or render.

**Cold start, worked example — "Total sales for blue jeans":**

1. Grounding strips field-synonym words ("sales" → `total_revenue`), then fuzzy-matches
   the leftovers against the value inventories: `jeans` is an exact department value →
   **committed filter**, `blue` only partially matches the brand *Bluegrain* → **note,
   never silently applied**.
2. The single planner call receives those hypotheses and emits a KPI cell filtered to
   `products.department = Jeans`, answering with the note about "blue" so the user can
   correct course with one pill tap.
3. Had the term been genuinely ambiguous — try *"revenue in georgia"* (the state vs the
   brand *Georgia Motion*) — the turn returns **clarification chips** instead of a
   guess. The click re-plans with the binding: still zero additional LLM calls.

**Standard Looker API usage** (all documented API 4.0, all via `@looker/sdk`):

| Endpoint | Used for | Status in this repo |
|---|---|---|
| `run_inline_query` | every data fetch — the spec in each query cell is the request body, verbatim | Mocked (`MockLookerClient`); production path is `PostMessageLookerClient` → host → SDK |
| `lookml_model_explore` | fetching the field catalog (names, labels, types, descriptions) at session start | Hardcoded in `looker.js` for the demo; a 1:1 swap |
| `create_query` / Look & dashboard endpoints | "Save to Looker" — query cells are already valid `create_query` bodies | Export to `.lookernb.json` today; see PORTING.md |

**Managed data-agent chat endpoints are deliberately not used.** Those services are
themselves multi-call server pipelines that return pre-rendered Vega-Lite payloads.
Planner calls go to Vertex Gemini `generateContent` instead (`src/gemini.js`), one per
turn, JSON out. In the shipped product both traffic types route through the React host
(which holds auth): `LOOKBOOK_QUERY` messages for SDK queries, and an equivalent
message for the planner call — the sandboxed iframe holds no credentials for either.

### The one-call-per-turn contract (Gemini integration)

`compiler.js` exports `COMPILER_SYSTEM_PROMPT` and `planWithLLM(ctx, callModel)`.
The model sees three things, all tiny by construction:

1. the Explore field catalog (~200 tokens),
2. the notebook outline (cell names, kinds, query specs),
3. the <150-token statistical profile of each live result set — **never raw rows**.

It returns the same `{answer, patches}` JSON the rules planner emits. Invalid JSON falls
back to the deterministic planner, so a weak model response degrades gracefully instead
of failing the turn. This is deliberately the *entire* LLM surface area: no
disambiguation calls, no join-resolution calls, no Python sandboxes.

## Pinned versions

Matches the target Looker host application exactly — these cannot drift:

| Library | Version | Role |
|---|---|---|
| `@observablehq/runtime` | 5.9.3 | Reactive DAG evaluation |
| `@observablehq/plot` | 0.6.16 | Declarative charts |
| `d3` | 7.9.0 | Scales, formats, aggregation |
| `marked` | 12.0.2 | Answer markdown |

CDN ESM here for zero-setup; in restricted production builds these are vendored (see
[docs/PORTING.md](docs/PORTING.md) — no dynamic CDN tags in production).

## Tests & benchmark

- `node --test tests/` — 26 unit tests: transitive join resolution, query engine
  correctness (grouping, distinct-order measures, filters through joins), grounding
  (fuzzy binding, ambiguity detection, choice overrides), patch inverse round-trips
  (undo/redo), diffing, and the profiler's <150-token guarantee.
- `node evals/run.mjs` — golden-set planner evals (intent accuracy, field precision,
  filter exactness, clarification precision) with a `--baseline` ratchet; regressions
  exit nonzero. This is the hill-climbing instrument — see
  [docs/EVAL-PLAN.md](docs/EVAL-PLAN.md).
- `bench.html` — 14 scripted end-to-end cases (adds grounding commits, clarification,
  and chip resolution to the intent suite). Asserts the structural shape of every
  emitted patch set, compiles every generated cell, and measures the token cost of
  carrying each turn's data context forward: **83% context-token reduction** vs
  raw-row echoing.

## Tuning & hill-climbing

Every decision without a provably optimal setting is a named knob in
[src/tuning.js](src/tuning.js) — grounding thresholds, profile budgets, chart
cardinality cutoffs, research fan-out, and staged `[candidate]` context experiments
(sample values in the prompt, feeding selected cell outputs into next-turn context,
answer history). [docs/EVAL-PLAN.md](docs/EVAL-PLAN.md) is the operating manual for
climbing them: grow `evals/golden.json` from real questions, change one knob, run the
instruments, ratchet the baseline.

## Feature requirements coverage

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — a requirement-by-requirement map
against the standard managed data-agent feature set (agents, glossaries, verified
queries, hidden fields, fast/deep answer modes, code-executing analysis, permissions),
framing this as an iterative improvement to an existing product surface.

## Repo layout

```
index.html          app shell (chat + canvas views)
styles.css          Material-flavored styling (CSS custom properties)
bench.html          scripted benchmark suite
src/
  data.js           deterministic synthetic "thelook" DB (normalized tables)
  looker.js         explore catalog, LookML join resolution, mock & postMessage clients
  grounding.js      SDK-derived value scans → commit/clarify/note hypotheses
  agent.js          agent context: instructions, glossary, verified queries
  profiler.js       <150-token statistical profiler
  notebook.js       document model, patches, inverse patches, line diffs
  runtime.js        Observable runtime adapter + cell builtins
  compiler.js       intent → patches planner (chat/research) + Gemini contract
  tuning.js         every hill-climbable knob, in one place
  format.js         dependency-free formatters (keeps the planner node-runnable)
  gemini.js         Vertex AI generateContent adapter
  views.js          chat & canvas renderers, pills, diff display, clarify chips
  main.js           orchestration, undo/redo, export
tests/              node:test unit suite (joins, grounding, patches, profiler)
evals/              golden-set planner evals + baseline ratchet
docs/PORTING.md         absorbing this into an existing React host application
docs/REQUIREMENTS.md    requirement map vs standard data-agent feature sets
docs/EVAL-PLAN.md       hill-climbing manual: knobs, metrics, procedure
```
