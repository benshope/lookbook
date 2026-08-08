// Unit tests for the document model: patch application, inverse patches
// (undo/redo correctness), name uniqueness, diffing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNotebook, applyPatches, uniqueName, diffLines, compactDiff, getCell,
} from "../src/notebook.js";

const cell = (id, name, source = "x") => ({ id, name, kind: "js", inputs: [], source });

test("add / update / remove round-trip through inverse patches", () => {
  const nb = createNotebook();
  const inv1 = applyPatches(nb, [{ op: "add", cell: cell("c1", "a") }, { op: "add", cell: cell("c2", "b") }]);
  assert.equal(nb.cells.length, 2);

  const inv2 = applyPatches(nb, [{ op: "update", id: "c1", cell: cell("c1", "a", "y") }]);
  assert.equal(getCell(nb, "c1").source, "y");

  const inv3 = applyPatches(nb, [{ op: "remove", id: "c2" }]);
  assert.equal(nb.cells.length, 1);

  // Unwind in reverse order → exact original state.
  applyPatches(nb, inv3);
  applyPatches(nb, inv2);
  assert.equal(getCell(nb, "c1").source, "x");
  assert.equal(nb.cells.length, 2);
  applyPatches(nb, inv1);
  assert.equal(nb.cells.length, 0);
});

test("remove inverse restores original position", () => {
  const nb = createNotebook();
  applyPatches(nb, [
    { op: "add", cell: cell("c1", "a") }, { op: "add", cell: cell("c2", "b") }, { op: "add", cell: cell("c3", "c") },
  ]);
  const inv = applyPatches(nb, [{ op: "remove", id: "c2" }]);
  applyPatches(nb, inv);
  assert.deepEqual(nb.cells.map(c => c.id), ["c1", "c2", "c3"]);
});

test("uniqueName suffixes on collision", () => {
  const nb = createNotebook();
  applyPatches(nb, [{ op: "add", cell: cell("c1", "q_revenue") }]);
  assert.equal(uniqueName(nb, "q_revenue"), "q_revenue_2");
  assert.equal(uniqueName(nb, "q_other"), "q_other");
});

test("diffLines produces minimal add/del rows", () => {
  const d = diffLines("a\nb\nc", "a\nx\nc");
  assert.deepEqual(d.map(r => r.type + ":" + r.text), ["ctx:a", "del:b", "add:x", "ctx:c"]);
});

test("compactDiff collapses long unchanged runs", () => {
  const a = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
  const b = a.replace("line10", "changed");
  const rows = compactDiff(diffLines(a, b));
  assert.ok(rows.some(r => r.text.includes("unchanged lines")));
  assert.ok(rows.some(r => r.type === "add" && r.text === "changed"));
});
