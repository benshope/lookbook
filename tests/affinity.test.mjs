// Unit tests for affinity signals: tie-break weighting and the guarantee
// that signals order guesses but never override explicit matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldWeight, MOCK_AFFINITY, affinityToPrompt } from "../src/affinity.js";
import { plan } from "../src/compiler.js";
import { createNotebook } from "../src/notebook.js";
import { MockLookerClient } from "../src/looker.js";

const looker = new MockLookerClient({ latency: 0 });

test("fieldWeight compounds user, org, dashboard, and conversation signals", () => {
  const wState = fieldWeight(MOCK_AFFINITY, "users.state");
  const wBrand = fieldWeight(MOCK_AFFINITY, "products.brand");
  assert.ok(wState > wBrand, `state (${wState}) should outweigh brand (${wBrand})`);
  assert.equal(fieldWeight(MOCK_AFFINITY, "orders.traffic_source"), 0);
  assert.equal(fieldWeight(null, "users.state"), 0);
});

test("clarification chips are ordered by affinity (most-likely first)", async () => {
  const r = await plan({
    question: "Revenue in georgia", nb: createNotebook(), looker, affinity: MOCK_AFFINITY,
  });
  assert.equal(r.clarify.term, "georgia");
  assert.equal(r.clarify.options[0].field, "users.state"); // user's frequent field leads
});

test("affinity does not override an unambiguous match", async () => {
  // "jeans" is exact — no signal should turn it into anything else.
  const r = await plan({
    question: "Total revenue for jeans", nb: createNotebook(), looker, affinity: MOCK_AFFINITY,
  });
  const q = r.patches.find(p => p.cell?.kind === "query");
  assert.equal(q.cell.query.filters["products.department"], "Jeans");
  assert.equal(r.clarify, undefined);
});

test("affinityToPrompt is compact and lists the signal sources", () => {
  const p = affinityToPrompt(MOCK_AFFINITY);
  assert.ok(p.includes("frequent fields"));
  assert.ok(p.includes("Regional performance"));
  assert.ok(p.length < 600, `prompt block too large: ${p.length} chars`);
  assert.equal(affinityToPrompt(null), "");
});
