# Eval & hill-climbing plan

Several decisions in this product have no provably optimal setting — they must be
climbed with evals, not argued in review. Every such decision is a named knob in
[`src/tuning.js`](../src/tuning.js); this document is the operating manual for whoever
(human or LLM) iterates on them after installation.

## Instruments

| Instrument | Command | What it measures |
|---|---|---|
| Unit tests | `node --test tests/` | Invariants that must never regress (join resolution, patch inverses, profile token budget) |
| Golden planner evals | `node evals/run.mjs` | Intent accuracy, field precision, filter exactness, clarification precision — against `evals/golden.json`; compares to `evals/baseline.json` and fails on regression |
| End-to-end bench | `bench.html` in a browser | Everything above **plus** generated-cell compilation and multi-turn context token cost |

## Procedure (one loop iteration)

1. **Grow the golden set first.** Harvest real user questions (especially misses) into
   `evals/golden.json`. A knob change evaluated against 16 cases is noise; against 200
   it's signal.
2. Change **one** knob in `src/tuning.js`.
3. `node --test tests/ && node evals/run.mjs` (+ bench.html for token-cost deltas).
4. Keep if accuracy improves without unacceptable token/interruption cost; else revert.
5. On keep: `node evals/run.mjs --baseline` to ratchet.

## Knob inventory (what to climb, and against which metric)

| Knob | Trade-off to measure |
|---|---|
| `grounding.COMMIT_THRESHOLD` / `RIVAL_GAP` | Silent-guess accuracy vs clarification interruption rate. Lower RIVAL_GAP = fewer questions to the user but more wrong filters. Score both: filter exactness AND % of turns interrupted. |
| `grounding.SCORE_*` shape | Fuzzy-match quality on messy vocabulary ("blue jeans", plurals, typos). Candidate: add edit-distance scoring; add plural stemming. |
| `profiler.TOKEN_BUDGET` / `TOP_CATEGORIES` | Follow-up answer accuracy vs per-turn context cost. Candidates: quartiles, month-over-month deltas, null counts. |
| `planner.WIDE_CARDINALITY`, `DEFAULT_TOP_N` | Chart legibility vs completeness. |
| `planner.RESEARCH_BREAKDOWNS` | Research usefulness vs cell sprawl; consider choosing breakdowns dynamically by variance across dimensions (computable from SDK scans, still zero LLM). |
| `planner.GLOSSARY_BOOST` | Whether org jargon should ever lose to a longer generic synonym. |
| Verified-query match strictness (`matchVerifiedQuery`) | Recall of curated answers vs false-positive hijacking of unrelated questions. |
| `affinity.*_WEIGHT`, `PROMPT_FIELDS_N` | Personalization lift (clarify-first-chip acceptance rate, default-field precision) vs prompt tokens and filter-bubble risk — a user who once ran a weird explore shouldn't be haunted by it. |
| Prompt wording at `[AGENT-SITE:personalization]` / `[AGENT-SITE:clarify-policy]` | The *instructions* are knobs too (docs/AGENT-SITES.md): how boldly the model may lean on activity signals, and its ask-vs-guess tolerance. Climb wording changes exactly like numeric knobs — one edit, run evals, ratchet. |

## Context-size experiments ([candidate] flags in `tuning.context`)

The single biggest open question is **how much context buys how much accuracy** for the
one planner call. Ship-state is minimal; these are staged, each needs an A/B over the
golden set with a real model (see below):

1. `VALUES_PER_DIMENSION_IN_PROMPT` — include N sample values per dimension in the
   catalog. Hypothesis: helps value-heavy questions; costs ~20 tokens/dimension/N.
2. `SEND_CELL_OUTPUTS` — after a turn's cells evaluate, feed selected cell *outputs*
   (KPI numbers, chart domain extents) into the next turn's context alongside profiles.
   Hypothesis: improves "why did that spike?"-style follow-ups.
3. `ANSWER_HISTORY_TURNS` — include the last N answers verbatim, not just the notebook
   outline. Hypothesis: helps pronoun-heavy threads; risks context pollution (the
   original failure mode this architecture removed — measure carefully).

## Evaluating the real model (for the LLM that installs this into Looker)

The golden runner scores the deterministic planner today. To score Gemini through the
identical harness:

1. In `evals/run.mjs`, swap `plan(ctx)` for `planWithLLM(ctx, caller)` with a caller
   from `src/gemini.js` (env-var the credentials; keep `temperature: 0`).
2. Run the same golden set; the classifier and checks are planner-agnostic because the
   output contract is the same `{answer, patches, clarify}` shape.
3. Report three numbers per run: accuracy, mean prompt tokens, fallback rate (how often
   `planWithLLM` fell back to rules on malformed output). Climb prompt content
   (`tuning.context`) against all three — accuracy gains that double prompt size or
   fallback rate are not wins.
4. Nightly: run rules-planner evals as the regression floor; run model evals on the
   grown golden set; ratchet `baseline.json` only on human review.

## What is deliberately NOT tunable

- One planner call per user turn (clarifications route through the user, not the model).
- Raw rows never enter LLM context (the profiler is the gate; widen the profile
  instead).
- All data access via `run_inline_query` (never bypass the SDK's permission model).
