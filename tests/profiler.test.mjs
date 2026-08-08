// Unit tests for the statistical profiler: the <150-token guarantee and the
// self-healing extreme-row retention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { profileRows, profileToPrompt, estimateTokens } from "../src/profiler.js";
import { MockLookerClient } from "../src/looker.js";

test("numeric + categorical columns profile correctly", () => {
  const rows = [
    { "products.brand": "A", "order_items.total_revenue": 10 },
    { "products.brand": "B", "order_items.total_revenue": 30 },
    { "products.brand": "A", "order_items.total_revenue": 20 },
  ];
  const p = profileRows(rows);
  assert.equal(p.rowCount, 3);
  const num = p.columns.find(c => c.kind === "number");
  assert.equal(num.min, 10);
  assert.equal(num.max, 30);
  assert.equal(num.sum, 60);
  assert.equal(num.maxRow["products.brand"], "B"); // exact extreme row retained
  const cat = p.columns.find(c => c.kind === "category");
  assert.equal(cat.distinct, 2);
  assert.equal(cat.top[0], "A(2)");
});

test("profiles of real query results stay under 150 tokens", async () => {
  const looker = new MockLookerClient({ latency: 0 });
  const specs = [
    { fields: ["order_items.created_month", "order_items.total_revenue"] },
    { fields: ["products.brand", "order_items.total_revenue"], limit: 25 },
    { fields: ["users.state", "products.department", "order_items.total_revenue", "order_items.item_count"] },
  ];
  for (const spec of specs) {
    const { rows } = await looker.runInlineQuery(spec);
    const prompt = profileToPrompt(profileRows(rows));
    assert.ok(estimateTokens(prompt) < 150, `${estimateTokens(prompt)} tokens for ${spec.fields.join(",")}`);
  }
});

test("profile prompt is dramatically smaller than raw rows", async () => {
  const looker = new MockLookerClient({ latency: 0 });
  const { rows } = await looker.runInlineQuery({
    fields: ["users.state", "products.department", "order_items.total_revenue"],
  });
  const raw = estimateTokens(JSON.stringify(rows));
  const prof = estimateTokens(profileToPrompt(profileRows(rows)));
  assert.ok(prof < raw * 0.2, `profile ${prof} should be <20% of raw ${raw}`);
});

test("empty result sets profile safely", () => {
  assert.equal(profileToPrompt(profileRows([])), "0 rows");
});
