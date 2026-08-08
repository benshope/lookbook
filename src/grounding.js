// Pre-flight grounding: the SDK-heavy discovery phase that runs BEFORE the
// planner/LLM call. This is where the "loop" went.
//
// Principle: SDK calls are essentially free; LLM calls are not. So every
// question first gets grounded against real LookML metadata and real
// dimension values — the same discovery work a server-side agent pipeline
// does across multiple LLM round-trips, done here deterministically:
//
//   1. Session bootstrap (once): field catalog via lookml_model_explore +
//      value inventories per filterable dimension via cheap grouped
//      run_inline_query scans (the mock's dimensionValues()).
//   2. Per-question: extract candidate terms, fuzzy-match them against the
//      value inventories, and score hypotheses.
//   3. Outcomes per term:
//        commit   — one confident binding → becomes a filter, silently
//        clarify  — near-tie across DIFFERENT fields → the planner returns
//                   a clarification turn (user picks a chip; resolving a
//                   choice costs ZERO additional LLM calls)
//        note     — weak partial match → mentioned in the answer, never
//                   silently applied
//
// The full hypothesis report is also handed to Gemini in planWithLLM, so a
// real model sees the same grounded evidence the rules planner uses.

import { dimensionValues } from "./looker.js";
import { TUNING } from "./tuning.js";
const T = TUNING.grounding;

// Dimensions worth scanning for literal values. In production this list is
// "every string dimension with reasonable cardinality" from the explore
// metadata; values come from grouped queries (or the sample-data endpoint).
export const FILTERABLE = ["products.department", "products.brand", "users.state", "orders.traffic_source"];

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "at", "by", "and", "or", "vs",
  "what", "whats", "was", "is", "are", "were", "how", "much", "many", "our", "we", "my",
  "show", "me", "see", "give", "get", "did", "do", "does", "with", "from", "per",
  "total", "top", "best", "worst", "bottom", "only", "just", "all", "please",
  "chart", "graph", "plot", "table", "number", "breakdown", "deep", "dive",
]);

let valueCache = null;
function valueInventory() {
  if (!valueCache) {
    valueCache = [];
    for (const field of FILTERABLE)
      for (const value of dimensionValues(field))
        valueCache.push({ field, value, lower: String(value).toLowerCase(), words: String(value).toLowerCase().split(/[^a-z0-9]+/) });
  }
  return valueCache;
}

// Fuzzy score for how well a question term matches a dimension value.
function scoreMatch(term, entry) {
  if (entry.lower === term) return T.SCORE_EXACT;                          // exact value
  if (entry.words.includes(term)) return T.SCORE_WORD;                     // matches one word of the value
  if (term.length >= 4 && entry.lower.startsWith(term)) return T.SCORE_PREFIX;
  if (term.length >= 5 && entry.lower.includes(term)) return T.SCORE_SUBSTRING;
  return 0;
}

// Extract candidate terms: unigrams + bigrams, minus stopwords, numbers, and
// any words already consumed by field-synonym resolution (passed in).
function extractTerms(qn, consumedWords) {
  const tokens = qn.trim().split(/\s+/).filter(t =>
    t.length >= 3 && !STOPWORDS.has(t) && !consumedWords.has(t) && !/^\d+$/.test(t));
  const terms = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) terms.push(`${tokens[i]} ${tokens[i + 1]}`);
  return [...new Set(terms)];
}

// choices: {term → {field, value}} — bindings the user already resolved by
// clicking a clarification chip; they always win.
export function groundQuestion(qn, { consumedWords = new Set(), choices = {} } = {}) {
  const filters = {};
  const notes = [];
  let clarify = null;

  const yr = qn.match(/\b(20\d{2})\b/);
  if (yr) filters["order_items.created_year"] = yr[1];

  const claimed = new Set(); // values already bound (skip sub-terms of committed bigrams)

  const addFilter = (field, value) => {
    if (!filters[field]) filters[field] = [];
    if (Array.isArray(filters[field]) && !filters[field].includes(value)) filters[field].push(value);
  };

  // Longer terms first so "true denim" wins before "denim".
  const terms = extractTerms(qn, consumedWords).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    if ([...claimed].some(v => v.includes(term))) continue;
    if (choices[term]) { addFilter(choices[term].field, choices[term].value); claimed.add(term); continue; }

    const candidates = valueInventory()
      .map(e => ({ ...e, score: scoreMatch(term, e) }))
      .filter(e => e.score >= T.NOTE_FLOOR)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) continue;

    const top = candidates[0];
    const rival = candidates.find(c => c.field !== top.field && c.score >= top.score - T.RIVAL_GAP);

    if (top.score >= T.COMMIT_THRESHOLD && rival && !clarify) {
      // Confident matches in different fields — genuinely ambiguous. Ask.
      clarify = {
        term,
        options: [top, rival].map(c => ({ field: c.field, value: c.value, score: c.score })),
      };
      claimed.add(term);
    } else if (top.score >= T.COMMIT_THRESHOLD) {
      addFilter(top.field, top.value);
      claimed.add(term);
    } else {
      // Weak partial: surface, never silently filter.
      notes.push(`No LookML value matched "${term}" — closest: \`${top.field} = ${top.value}\` (tap a pill to add it).`);
    }
  }

  for (const k of Object.keys(filters))
    if (Array.isArray(filters[k]) && filters[k].length === 1) filters[k] = filters[k][0];

  return { filters, notes, clarify };
}

// Compact hypothesis report for the Gemini prompt (~40 tokens per question).
export function groundingToPrompt(g) {
  const parts = [];
  if (Object.keys(g.filters).length) parts.push(`committed filters: ${JSON.stringify(g.filters)}`);
  if (g.clarify)
    parts.push(`AMBIGUOUS "${g.clarify.term}": ${g.clarify.options.map(o => `${o.field}=${o.value}(${o.score})`).join(" vs ")} — ask the user, do not guess`);
  for (const n of g.notes) parts.push(n.replace(/`/g, ""));
  return parts.length ? `# Grounding (from SDK value scans)\n${parts.join("\n")}` : "";
}
