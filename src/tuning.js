// TUNING — every decision in this codebase that has no provably optimal
// value lives here as a named knob, so it can be hill-climbed with evals
// instead of argued about in review.
//
// Procedure (see docs/EVAL-PLAN.md for the full plan):
//   1. change ONE knob
//   2. node --test tests/  &&  node evals/run.mjs   (plus bench.html in a browser)
//   3. compare the printed metrics against the previous run; keep or revert
//
// Anything marked [candidate] is a behavior we believe may help but ship
// disabled/neutral until an eval proves it.

export const TUNING = {
  grounding: {
    // Fuzzy value-match score at/above which a binding commits silently.
    COMMIT_THRESHOLD: 0.8,
    // A second confident match in a DIFFERENT field within this gap of the
    // top match triggers a clarification turn instead of a silent guess.
    // Lower ⇒ fewer interruptions but more wrong guesses; hill-climb against
    // clarify-precision AND filter-accuracy together.
    RIVAL_GAP: 0.2,
    // Below COMMIT, at/above this: mention as a note, never filter.
    NOTE_FLOOR: 0.55,
    // Fuzzy score by match type — the shape of the whole scorer.
    SCORE_EXACT: 1.0,
    SCORE_WORD: 0.85,
    SCORE_PREFIX: 0.6,
    SCORE_SUBSTRING: 0.55,
  },

  profiler: {
    // Token budget per result-set profile; tests enforce it. Raising it buys
    // the model more qualitative awareness per turn — eval answer-accuracy
    // against turn token cost before moving.
    TOKEN_BUDGET: 150,
    // Top-N category values retained per string column.
    TOP_CATEGORIES: 3,
  },

  planner: {
    // Dimension cardinality above which breakdowns become top-N rankings.
    WIDE_CARDINALITY: 10,
    // Ranking default when the user gives no N.
    DEFAULT_TOP_N: 10,
    // Agent-glossary score boost over ordinary synonyms in field resolution.
    GLOSSARY_BOOST: 100,
    // Research-mode fan-out: which dimensions get breakdown cells.
    RESEARCH_BREAKDOWNS: [
      { dim: "products.department", wide: false },
      { dim: "users.state", wide: true },
      { dim: "orders.traffic_source", wide: false },
    ],
  },

  context: {
    // [candidate] Include N sample values per dimension in the LLM catalog.
    // More grounding for value-heavy questions vs prompt growth. 0 = off.
    VALUES_PER_DIMENSION_IN_PROMPT: 0,
    // [candidate] After a turn's cells evaluate, feed selected cell OUTPUTS
    // (e.g. the rendered KPI numbers, chart domain extents) back into the
    // next turn's context alongside profiles. Off until an eval shows the
    // extra tokens improve follow-up accuracy.
    SEND_CELL_OUTPUTS: false,
    // [candidate] Include the last N turns' answers in the prompt (0 = only
    // the notebook outline + profiles carry history).
    ANSWER_HISTORY_TURNS: 0,
  },
};
