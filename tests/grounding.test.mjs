// Unit tests for pre-flight grounding: fuzzy value binding, ambiguity
// detection, weak-match notes, and user-choice overrides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groundQuestion } from "../src/grounding.js";

const norm = q => " " + q.toLowerCase().replace(/[?!.,;:()"']/g, " ").replace(/\s+/g, " ").trim() + " ";

test("exact value commits silently ('jeans' → department)", () => {
  const g = groundQuestion(norm("total sales for jeans"));
  assert.equal(g.filters["products.department"], "Jeans");
  assert.equal(g.clarify, null);
});

test("weak partial becomes a note, never a filter ('blue')", () => {
  const g = groundQuestion(norm("total sales for blue jeans"));
  assert.equal(g.filters["products.department"], "Jeans");
  assert.ok(!g.filters["products.brand"]);
  assert.ok(g.notes.some(n => n.includes('"blue"') && n.includes("Bluegrain")));
});

test("confident matches in different fields trigger clarification ('georgia')", () => {
  const g = groundQuestion(norm("revenue in georgia"));
  assert.equal(g.clarify.term, "georgia");
  const fields = g.clarify.options.map(o => o.field).sort();
  assert.deepEqual(fields, ["products.brand", "users.state"]);
  assert.ok(!g.filters["users.state"], "must not guess while ambiguous");
});

test("a user choice resolves ambiguity with no clarification", () => {
  const g = groundQuestion(norm("revenue in georgia"), {
    choices: { georgia: { field: "users.state", value: "Georgia" } },
  });
  assert.equal(g.clarify, null);
  assert.equal(g.filters["users.state"], "Georgia");
});

test("multi-word values bind via bigrams ('true denim')", () => {
  const g = groundQuestion(norm("profit for true denim"));
  assert.equal(g.filters["products.brand"], "True Denim");
});

test("years and multiple values combine", () => {
  const g = groundQuestion(norm("outerwear in california 2025"));
  assert.equal(g.filters["order_items.created_year"], "2025");
  assert.equal(g.filters["products.department"], "Outerwear");
  assert.equal(g.filters["users.state"], "California");
});

test("consumed synonym words are not treated as values", () => {
  // "brand" is a field synonym; must not fuzzy-match against brand values.
  const g = groundQuestion(norm("revenue by brand"), { consumedWords: new Set(["revenue", "brand"]) });
  assert.deepEqual(g.filters, {});
  assert.equal(g.clarify, null);
});
