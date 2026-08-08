// App orchestration: one notebook, one reactive engine, two views,
// an undo/redo stack of patch sets, and .lookernb.json export.

import { MockLookerClient, getField } from "./looker.js";
import { createNotebook, applyPatches, getCell, cellPrintableSource, serializeNotebook, nextCellId } from "./notebook.js";
import { createEngine } from "./runtime.js";
import { plan, planWithLLM } from "./compiler.js";
import { configuredGeminiCaller } from "./gemini.js";
import {
  renderComposerPills, renderSuggestions, appendThinking, fillTurn, adoptChatCells,
  rebuildCanvas, rebuildHistory, showSwapMenu, markTurnUndone,
} from "./views.js";

const $ = sel => document.querySelector(sel);

const state = {
  nb: createNotebook(),
  looker: new MockLookerClient(),
  engine: null,
  turns: [],        // {id, question, answer, patches, diffs, patchSummary, label, latencyMs, undone}
  undoStack: [],    // {inverse, redo, turnId}
  redoStack: [],
  profiles: new Map(), // cellId → compact profile string (the multi-turn LLM context)
  view: "chat",
  mode: "chat",        // "chat" | "research" — fast answers vs deep investigation
  lastQueryId: null,
  lastChartId: null,
  turnSeq: 0,
};

// If a Vertex Gemini config is present (see src/gemini.js), plan through the
// model with automatic fallback to the rules planner; otherwise rules only.
const geminiCaller = configuredGeminiCaller();

state.engine = createEngine(state.looker, {
  onQueryResult: (cell, rows) => state.profiles.set(cell.id, rows.__meta?.profilePrompt),
});

// ---------------------------------------------------------------------------
// Turn pipeline — every mutation (chat, pill swap, manual edit, delete) flows
// through here, so all of them are diffed, undoable, and visible in history.
// ---------------------------------------------------------------------------
function computeDiffs(nb, patches) {
  return patches.map(p => {
    if (p.op === "add") return { name: p.cell.name, kind: p.cell.kind, op: "add", before: "", after: cellPrintableSource(p.cell) };
    const existing = getCell(nb, p.id);
    if (p.op === "remove") return { name: existing?.name || p.id, kind: existing?.kind || "?", op: "remove", before: existing ? cellPrintableSource(existing) : "", after: "" };
    return { name: p.cell.name, kind: p.cell.kind, op: "update", before: existing ? cellPrintableSource(existing) : "", after: cellPrintableSource(p.cell) };
  });
}

function summarize(patches) {
  const n = { add: 0, update: 0, remove: 0 };
  for (const p of patches) n[p.op]++;
  const bits = [];
  if (n.add) bits.push(`+${n.add} cell${n.add > 1 ? "s" : ""}`);
  if (n.update) bits.push(`±${n.update} updated`);
  if (n.remove) bits.push(`−${n.remove} removed`);
  return bits.join(" · ") || "no changes";
}

function commit(question, result, { turnEl, latencyMs }) {
  const diffs = computeDiffs(state.nb, result.patches);
  const inverse = applyPatches(state.nb, result.patches);
  state.engine.sync(state.nb);

  const turn = {
    id: `t${++state.turnSeq}`,
    question, answer: result.answer, patches: result.patches, diffs,
    clarify: result.clarify || null,
    patchSummary: result.clarify ? "needs your input" : summarize(result.patches),
    label: result.label,
    latencyMs: Math.round(latencyMs), undone: false,
  };
  state.turns.push(turn);
  if (result.patches.length) {
    state.undoStack.push({ inverse, redo: result.patches, turnId: turn.id });
    state.redoStack = [];
  }

  // Track conversational focus for follow-ups ("break that down…").
  for (const p of result.patches) {
    const cell = p.cell || getCell(state.nb, p.id);
    if (!cell) continue;
    if (cell.kind === "query") state.lastQueryId = cell.id;
    if (cell.kind === "js" && cell.name.startsWith("chart_")) state.lastChartId = cell.id;
  }

  fillTurn(state, turnEl, turn);
  refreshChrome();
  return turn;
}

async function ask(question, opts = {}) {
  const input = $("#ask-input");
  const send = $("#ask-send");
  send.disabled = true;
  const turnEl = appendThinking(question);
  const t0 = performance.now();
  try {
    const ctx = {
      question,
      nb: state.nb,
      looker: state.looker,
      profiles: state.profiles,
      mode: state.mode,
      choices: opts.choices || {},   // clarification chips the user resolved
      lastQuery: state.lastQueryId ? getCell(state.nb, state.lastQueryId) : null,
      lastChart: state.lastChartId ? getCell(state.nb, state.lastChartId) : null,
    };
    const result = geminiCaller ? await planWithLLM(ctx, geminiCaller) : await plan(ctx);
    commit(question, result, { turnEl, latencyMs: performance.now() - t0 });
  } catch (err) {
    console.error(err);
    turnEl.querySelector(".payload").innerHTML = `<div class="cell-error">⚠ ${err.message}</div>`;
  } finally {
    send.disabled = false;
    input.focus();
  }
}

// Non-chat mutations reuse the same pipeline with a synthetic "question".
function applyDirect(label, patches, answer) {
  const turnEl = appendThinking(label);
  commit(label, { answer, patches, label }, { turnEl, latencyMs: 0 });
}

// ---------------------------------------------------------------------------
// Undo / redo — snapshot-free: pure inverse patch application.
// ---------------------------------------------------------------------------
function undo() {
  const entry = state.undoStack.pop();
  if (!entry) return;
  applyPatches(state.nb, entry.inverse);
  state.engine.sync(state.nb);
  state.redoStack.push(entry);
  const turn = state.turns.find(t => t.id === entry.turnId);
  if (turn) { turn.undone = true; markTurnUndone(turn, true); }
  refreshChrome();
  adoptChatCells(state);
}

function redo() {
  const entry = state.redoStack.pop();
  if (!entry) return;
  entry.inverse = applyPatches(state.nb, entry.redo);
  state.engine.sync(state.nb);
  state.undoStack.push(entry);
  const turn = state.turns.find(t => t.id === entry.turnId);
  if (turn) { turn.undone = false; markTurnUndone(turn, false); }
  refreshChrome();
  adoptChatCells(state);
}

// ---------------------------------------------------------------------------
// Canvas interaction handlers
// ---------------------------------------------------------------------------
const canvasHandlers = {
  onSwapField(cell, fname, anchorEl) {
    showSwapMenu(anchorEl, fname, replacement => {
      const spec = structuredClone(cell.query);
      spec.fields = spec.fields.map(f => (f === fname ? replacement : f));
      spec.sorts = (spec.sorts || []).map(s =>
        s === fname ? replacement : s === `-${fname}` ? `-${replacement}` : s);
      applyDirect(
        `Swap ${fname} → ${replacement}`,
        [{ op: "update", id: cell.id, cell: { ...cell, query: spec } }],
        `Swapped \`${fname}\` for \`${replacement}\` in \`${cell.name}\` — dependents re-evaluated reactively.`);
    });
  },
  onRemoveFilter(cell, fname) {
    const spec = structuredClone(cell.query);
    delete spec.filters[fname];
    applyDirect(
      `Remove filter ${fname}`,
      [{ op: "update", id: cell.id, cell: { ...cell, query: spec } }],
      `Removed filter \`${fname}\` from \`${cell.name}\`.`);
  },
  onEditSource(cell, newSource) {
    let updated;
    if (cell.kind === "query") {
      try { updated = { ...cell, query: JSON.parse(newSource) }; }
      catch (e) { alert(`Invalid query JSON: ${e.message}`); return; }
    } else {
      updated = { ...cell, source: newSource };
    }
    applyDirect(
      `Edit ${cell.name}`,
      [{ op: "update", id: cell.id, cell: updated }],
      `Manually edited \`${cell.name}\`.`);
  },
  onRemoveCell(cell) {
    // Cascade: also remove cells that list this cell's name as an input.
    const doomed = [cell, ...state.nb.cells.filter(c => c.inputs?.includes(cell.name))];
    applyDirect(
      `Remove ${cell.name}`,
      doomed.map(c => ({ op: "remove", id: c.id })),
      `Removed \`${doomed.map(c => c.name).join("`, `")}\`.`);
  },
};

// ---------------------------------------------------------------------------
// Chrome: view switching, header buttons, composer
// ---------------------------------------------------------------------------
function setView(view) {
  state.view = view;
  $("#view-chat").classList.toggle("active", view === "chat");
  $("#view-canvas").classList.toggle("active", view === "canvas");
  $("#chat-view").classList.toggle("active", view === "chat");
  $("#canvas-view").classList.toggle("active", view === "canvas");
  if (view === "canvas") rebuildCanvas(state, canvasHandlers);
  else adoptChatCells(state);
}

function refreshChrome() {
  $("#btn-undo").disabled = !state.undoStack.length;
  $("#btn-redo").disabled = !state.redoStack.length;
  if (state.view === "canvas") rebuildCanvas(state, canvasHandlers);
  rebuildHistory(state);
}

function saveNotebook() {
  const blob = new Blob([serializeNotebook(state.nb, state.turns)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.nb.title || "analysis").replace(/\s+/g, "-").toLowerCase()}.lookernb.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function init() {
  renderSuggestions(q => { $("#ask-input").value = q; ask(q); $("#ask-input").value = ""; });
  renderComposerPills(f => {
    const input = $("#ask-input");
    input.value = (input.value + " " + f.synonyms[0]).trimStart();
    input.focus();
  });

  $("#ask-form").addEventListener("submit", ev => {
    ev.preventDefault();
    const q = $("#ask-input").value.trim();
    if (!q) return;
    $("#ask-input").value = "";
    ask(q);
  });

  $("#view-chat").onclick = () => setView("chat");
  $("#view-canvas").onclick = () => setView("canvas");
  $("#mode-toggle").onclick = () => {
    state.mode = state.mode === "chat" ? "research" : "chat";
    $("#mode-toggle").classList.toggle("active", state.mode === "research");
    $("#mode-toggle").title = state.mode === "research"
      ? "Research mode: one planner call fans out a full investigation (KPIs, trend, breakdowns, findings)"
      : "Chat mode: minimal cells, direct answers";
  };
  $("#btn-undo").onclick = undo;
  $("#btn-redo").onclick = redo;
  $("#btn-save").onclick = saveNotebook;
  $("#nb-title").addEventListener("input", ev => (state.nb.title = ev.target.value));

  document.addEventListener("keydown", ev => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod || ev.target.tagName === "TEXTAREA" || ev.target.tagName === "INPUT") return;
    if (ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      ev.shiftKey ? redo() : undo();
    }
  });

  // Clarification chip clicked → re-plan the same question with the binding.
  state.onClarify = (turn, option) =>
    ask(turn.question, { choices: { [turn.clarify.term]: option } });

  refreshChrome();
  $("#ask-input").focus();
}

init();

// Exposed for the benchmark harness (bench.html) and console debugging.
window.__lookbook = { state, ask, undo, redo, applyDirect };
