// View layer. Both views are lenses over the SAME notebook + runtime:
//   Chat   — turns interleaved with the live cells each turn created.
//   Canvas — the full document: sources, field pills, revision history.
// Cell output DOM nodes are single instances owned by the engine; switching
// views re-parents them (they are never re-rendered, state is preserved).

import { getField, dimensions, measures, EXPLORE } from "./looker.js";
import { compactDiff, diffLines, cellPrintableSource } from "./notebook.js";
import { renderMarkdown } from "./runtime.js";

const $ = sel => document.querySelector(sel);

export const SUGGESTIONS = [
  "How is the business doing?",
  "Top 10 brands by revenue",
  "Revenue by month",
  "What's our average order value?",
  "Only 2025",
  "Break that down by department",
];

// ---------------------------------------------------------------------------
// Field pills
// ---------------------------------------------------------------------------
export function fieldPill(field, { onClick, removable } = {}) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `pill ${field.type}`;
  el.innerHTML = `<span>${field.name}</span><span class="kind">${field.type === "measure" ? "Measure" : "Dimension"}</span>${removable ? " ✕" : ""}`;
  if (onClick) el.onclick = onClick;
  return el;
}

export function filterPill(name, value, onRemove) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "pill filter";
  el.innerHTML = `<span>${name} = ${Array.isArray(value) ? value.join(",") : value}</span><span class="kind">Filter</span> ✕`;
  el.title = "Remove this filter";
  if (onRemove) el.onclick = onRemove;
  return el;
}

// The amber LookML Explore bar: explore label + every visible field as a pill.
export function renderComposerPills(onInsert) {
  const bar = $("#pills-bar");
  bar.innerHTML = "";
  const label = document.createElement("span");
  label.className = "explore-label";
  label.textContent = `⊞ ${EXPLORE.model}::${EXPLORE.view}`;
  label.title = `Explore: ${EXPLORE.label} — joins ${Object.keys(EXPLORE.joins).join(", ")} resolve automatically`;
  bar.appendChild(label);
  for (const f of [...measures(), ...dimensions()])
    bar.appendChild(fieldPill(f, { onClick: () => onInsert(f) }));
}

export function renderSuggestions(onPick) {
  const box = $("#suggestions");
  box.innerHTML = "";
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = s;
    b.onclick = () => onPick(s);
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------
export function renderDiffs(diffs) {
  const wrap = document.createElement("div");
  for (const d of diffs) {
    const block = document.createElement("div");
    block.className = "diff";
    const opLabel = d.op === "add" ? `<span class="op-add">+ added</span>` : d.op === "remove" ? `<span class="op-del">− removed</span>` : `<span class="op-mod">± updated</span>`;
    block.innerHTML = `<div class="diff-file">${d.name} · ${d.kind} ${opLabel}</div>`;
    const pre = document.createElement("pre");
    const rows = compactDiff(diffLines(d.before || "", d.after || ""));
    for (const r of rows) {
      const line = document.createElement("span");
      line.className = `dl ${r.type === "add" ? "add" : r.type === "del" ? "del" : "ctx"}`;
      line.textContent = (r.type === "add" ? "+ " : r.type === "del" ? "− " : "  ") + r.text;
      pre.appendChild(line);
    }
    block.appendChild(pre);
    wrap.appendChild(block);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Chat view
// ---------------------------------------------------------------------------
export function appendThinking(question) {
  $("#chat-empty").classList.add("hidden");
  const turns = $("#turns");
  const el = document.createElement("div");
  el.className = "turn";
  el.innerHTML = `
    <div class="turn-q"><div class="bubble"></div></div>
    <div class="turn-a">
      <div class="avatar">✦</div>
      <div class="payload"><div class="thinking">compiling cells</div></div>
    </div>`;
  el.querySelector(".bubble").textContent = question;
  turns.appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
  return el;
}

export function fillTurn(state, turnEl, turn) {
  const payload = turnEl.querySelector(".payload");
  payload.innerHTML = "";
  payload.appendChild(renderMarkdown(turn.answer));

  // Clarification turn: ambiguity resolved by a user click, not a model guess.
  // Picking an option re-plans with the binding — zero additional LLM calls.
  if (turn.clarify) {
    const box = document.createElement("div");
    box.className = "clarify-options";
    for (const opt of turn.clarify.options) {
      const b = document.createElement("button");
      b.className = "chip";
      b.innerHTML = `<b>${opt.value}</b>&nbsp;<span style="color:var(--text-2)">${opt.field}</span>`;
      b.onclick = () => {
        [...box.children].forEach(c => (c.disabled = true));
        state.onClarify(turn, { field: opt.field, value: opt.value });
      };
      box.appendChild(b);
    }
    payload.appendChild(box);
  }

  // Adopt the live output nodes for cells ADDED by this turn.
  const added = turn.patches.filter(p => p.op === "add").map(p => p.cell.id);
  if (added.length) {
    const cellsBox = document.createElement("div");
    cellsBox.className = "turn-cells";
    cellsBox.dataset.turnId = turn.id;
    for (const id of added) {
      const out = state.engine.outputFor(id);
      if (out) cellsBox.appendChild(out);
    }
    payload.appendChild(cellsBox);
  }

  // Patch chips + latency + expandable diff.
  const meta = document.createElement("div");
  meta.className = "turn-meta";
  if (turn.diffs.length) {
    const chip = document.createElement("button");
    chip.className = "patch-chip";
    chip.textContent = `▸ ${turn.patchSummary}`;
    const diffBox = document.createElement("div");
    diffBox.className = "turn-diff";
    diffBox.appendChild(renderDiffs(turn.diffs));
    chip.onclick = () => {
      diffBox.classList.toggle("open");
      chip.textContent = `${diffBox.classList.contains("open") ? "▾" : "▸"} ${turn.patchSummary}`;
    };
    meta.appendChild(chip);
    payload.appendChild(meta);
    payload.appendChild(diffBox);
  } else {
    payload.appendChild(meta);
  }
  const lat = document.createElement("span");
  lat.className = "latency-chip";
  lat.textContent = `${turn.latencyMs}ms · 1 planner call`;
  meta.appendChild(lat);

  // Updated (not added) cells: flash them wherever they live.
  for (const p of turn.patches.filter(p => p.op === "update")) state.engine.flash(p.id);
  turnEl.scrollIntoView({ behavior: "smooth", block: "end" });
}

// Re-parent every added cell back into its owning chat turn (after canvas view
// or after undo/redo rebuilt things).
export function adoptChatCells(state) {
  for (const turn of state.turns) {
    const box = document.querySelector(`.turn-cells[data-turn-id="${turn.id}"]`);
    if (!box) continue;
    box.innerHTML = "";
    for (const p of turn.patches.filter(p => p.op === "add")) {
      const out = state.engine.outputFor(p.cell.id);
      if (out) box.appendChild(out);
    }
  }
}

export function markTurnUndone(turn, undone) {
  const el = document.querySelector(`.turn-cells[data-turn-id="${turn.id}"]`)?.closest(".turn");
  if (el) el.style.opacity = undone ? "0.35" : "1";
}

// ---------------------------------------------------------------------------
// Canvas view
// ---------------------------------------------------------------------------
export function rebuildCanvas(state, handlers) {
  const { nb } = state;
  const cellsBox = $("#cells");
  cellsBox.innerHTML = "";
  $("#canvas-empty").classList.toggle("hidden", nb.cells.length > 0);
  $("#canvas-meta").textContent =
    `${nb.cells.length} cells · model ${EXPLORE.model} · Explore ${EXPLORE.view} · runtime @observablehq/runtime 5.9.3`;

  const lastTouched = new Set((state.turns.filter(t => !t.undone).at(-1)?.patches || []).map(p => p.cell?.id || p.id));

  for (const cell of nb.cells) {
    const frame = document.createElement("div");
    frame.className = "nb-cell" + (lastTouched.has(cell.id) ? " touched" : "");
    frame.dataset.cellId = cell.id;

    const head = document.createElement("div");
    head.className = "nb-cell-head";
    head.innerHTML = `<span class="nb-cell-name">${cell.name}</span>
      <span class="kind-badge ${cell.kind}">${cell.kind}</span><span class="spacer"></span>`;
    const srcBtn = document.createElement("button");
    srcBtn.textContent = "{ } source";
    const editBtn = document.createElement("button");
    editBtn.textContent = "✎ edit";
    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑";
    delBtn.title = "Remove cell (and dependents)";
    head.append(srcBtn, editBtn, delBtn);
    frame.appendChild(head);

    // Field pills for query cells — the LookML disambiguation bar.
    if (cell.kind === "query") {
      const pills = document.createElement("div");
      pills.className = "nb-cell-pills";
      for (const fname of cell.query.fields) {
        const f = getField(fname);
        if (!f) continue;
        pills.appendChild(fieldPill(f, { onClick: ev => handlers.onSwapField(cell, fname, ev.currentTarget) }));
      }
      for (const [fname, value] of Object.entries(cell.query.filters || {}))
        pills.appendChild(filterPill(fname, value, () => handlers.onRemoveFilter(cell, fname)));
      frame.appendChild(pills);
    }

    const body = document.createElement("div");
    body.className = "nb-cell-body";
    const out = state.engine.outputFor(cell.id);
    if (out) body.appendChild(out);
    frame.appendChild(body);

    // Source panel (read + edit).
    const srcPanel = document.createElement("div");
    srcPanel.className = "nb-cell-src";
    srcPanel.style.display = "none";
    const pre = document.createElement("pre");
    pre.textContent = cellPrintableSource(cell);
    srcPanel.appendChild(pre);
    frame.appendChild(srcPanel);
    srcBtn.onclick = () => {
      srcPanel.style.display = srcPanel.style.display === "none" ? "block" : "none";
    };
    editBtn.onclick = () => {
      srcPanel.style.display = "block";
      srcPanel.innerHTML = "";
      const ta = document.createElement("textarea");
      ta.value = cellPrintableSource(cell);
      const actions = document.createElement("div");
      actions.className = "src-actions";
      const apply = document.createElement("button");
      apply.className = "btn-primary";
      apply.textContent = "Apply";
      const cancel = document.createElement("button");
      cancel.className = "btn-ghost";
      cancel.textContent = "Cancel";
      apply.onclick = () => handlers.onEditSource(cell, ta.value);
      cancel.onclick = () => { srcPanel.style.display = "none"; srcPanel.innerHTML = ""; srcPanel.appendChild(pre); };
      actions.append(apply, cancel);
      srcPanel.append(ta, actions);
      ta.focus();
    };
    delBtn.onclick = () => handlers.onRemoveCell(cell);

    cellsBox.appendChild(frame);
  }
}

// Swap-field popup menu for query pills.
export function showSwapMenu(anchorEl, currentName, onPick) {
  document.querySelector(".swap-menu")?.remove();
  const current = getField(currentName);
  const options = (current.type === "measure" ? measures() : dimensions());
  const menu = document.createElement("div");
  menu.className = "swap-menu";
  menu.innerHTML = `<div class="swap-title">Swap ${current.type} — reruns the query + all dependents</div>`;
  for (const f of options) {
    const b = document.createElement("button");
    b.textContent = (f.name === currentName ? "● " : "○ ") + f.name;
    if (f.name === currentName) b.className = "current";
    b.onclick = () => { menu.remove(); if (f.name !== currentName) onPick(f.name); };
    menu.appendChild(b);
  }
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.position = "fixed";
  document.body.appendChild(menu);
  const close = ev => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", close); }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

// ---------------------------------------------------------------------------
// History panel
// ---------------------------------------------------------------------------
export function rebuildHistory(state) {
  const list = $("#history-list");
  list.innerHTML = "";
  if (!state.turns.length) {
    list.innerHTML = `<div class="hint" style="color:var(--text-2);font-size:12px">Each turn lands here as a reviewable diff.</div>`;
    return;
  }
  for (const turn of [...state.turns].reverse()) {
    const item = document.createElement("div");
    item.className = "history-item" + (turn.undone ? "" : "");
    item.style.opacity = turn.undone ? "0.4" : "1";
    item.innerHTML = `<div class="hq">${escapeHtml(turn.question)}</div><div class="hp">${turn.patchSummary} · ${turn.latencyMs}ms</div>`;
    const diffBox = document.createElement("div");
    diffBox.style.display = "none";
    diffBox.style.marginTop = "8px";
    if (turn.diffs.length) diffBox.appendChild(renderDiffs(turn.diffs));
    item.appendChild(diffBox);
    item.onclick = () => { diffBox.style.display = diffBox.style.display === "none" ? "block" : "none"; };
    list.appendChild(item);
  }
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
