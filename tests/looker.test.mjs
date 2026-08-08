// Unit tests for the LookML-style mock engine: join resolution, filters,
// grouping, measures, sorting, limits, SQL transparency.
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MockLookerClient, resolveJoins, queryToSQL, dimensionValues, getField, EXPLORE,
} from "../src/looker.js";
import { DB } from "../src/data.js";

const looker = new MockLookerClient({ latency: 0 });

test("join resolution: users joins through orders (transitive requires)", () => {
  const plan = resolveJoins(["users.state", "order_items.total_revenue"]);
  assert.deepEqual(plan.map(j => j.view), ["orders", "users"]);
  assert.equal(plan[1].sql_on, "orders.user_id = users.id");
});

test("join resolution: base-view-only queries need no joins", () => {
  assert.deepEqual(resolveJoins(["order_items.total_revenue", "order_items.item_count"]), []);
});

test("join resolution: filters pull in joins too", () => {
  const sql = queryToSQL({ fields: ["order_items.total_revenue"], filters: { "users.state": "California" } });
  assert.match(sql, /LEFT JOIN orders ON order_items\.order_id = orders\.id/);
  assert.match(sql, /LEFT JOIN users ON orders\.user_id = users\.id/);
});

test("scalar query aggregates the whole fact table", async () => {
  const { rows, joins } = await looker.runInlineQuery({ fields: ["order_items.total_revenue", "order_items.item_count"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["order_items.item_count"], DB.order_items.length);
  const expected = Math.round(DB.order_items.reduce((a, oi) => a + oi.sale_price, 0) * 100) / 100;
  assert.ok(Math.abs(rows[0]["order_items.total_revenue"] - expected) < 0.01);
  assert.deepEqual(joins, []);
});

test("grouped query joins products and groups correctly", async () => {
  const { rows, joins } = await looker.runInlineQuery({
    fields: ["products.department", "order_items.total_revenue"],
    sorts: ["-order_items.total_revenue"],
  });
  assert.equal(rows.length, 8); // 8 departments
  assert.deepEqual(joins, ["products"]);
  // Descending sort holds.
  for (let i = 1; i < rows.length; i++)
    assert.ok(rows[i - 1]["order_items.total_revenue"] >= rows[i]["order_items.total_revenue"]);
  // Group totals reconcile with the ungrouped scalar.
  const total = rows.reduce((a, r) => a + r["order_items.total_revenue"], 0);
  const scalar = (await looker.runInlineQuery({ fields: ["order_items.total_revenue"] })).rows[0]["order_items.total_revenue"];
  assert.ok(Math.abs(total - scalar) < 0.5);
});

test("filters restrict via joined dimensions", async () => {
  const all = (await looker.runInlineQuery({ fields: ["order_items.item_count"] })).rows[0]["order_items.item_count"];
  const filtered = (await looker.runInlineQuery({
    fields: ["order_items.item_count"],
    filters: { "products.department": "Outerwear", "order_items.created_year": "2025" },
  })).rows[0]["order_items.item_count"];
  assert.ok(filtered > 0 && filtered < all);
});

test("order_count is distinct orders; AOV = revenue / distinct orders", async () => {
  const { rows } = await looker.runInlineQuery({
    fields: ["order_items.total_revenue", "order_items.order_count", "order_items.average_order_value"],
  });
  const r = rows[0];
  assert.equal(r["order_items.order_count"], new Set(DB.order_items.map(oi => oi.order_id)).size);
  assert.ok(Math.abs(r["order_items.average_order_value"] - r["order_items.total_revenue"] / r["order_items.order_count"]) < 0.01);
});

test("limit truncates after sort", async () => {
  const { rows } = await looker.runInlineQuery({
    fields: ["products.brand", "order_items.total_revenue"],
    sorts: ["-order_items.total_revenue"], limit: 10,
  });
  assert.equal(rows.length, 10);
});

test("dimensionValues enumerates joined values", () => {
  assert.equal(dimensionValues("products.department").length, 8);
  assert.ok(dimensionValues("users.state").includes("California"));
  assert.ok(dimensionValues("orders.traffic_source").includes("Search"));
});

test("every explore field has synonyms and an accessor/aggregate", () => {
  for (const f of EXPLORE.fields) {
    assert.ok(f.synonyms?.length, `${f.name} missing synonyms`);
    assert.ok(f.type === "measure" ? f.aggregate : f.accessor, `${f.name} missing impl`);
    assert.ok(getField(f.name) === f);
  }
});
