/**
 * Editor plugins with their own UI: the slash menu, the floating selection (formatting) bar, the link
 * bar, and the row/column controls drawn around the table being edited.
 *
 * Floating elements live in #layer (public/index.html), outside the editable DOM, so ProseMirror never
 * sees them as document content; they are positioned in viewport coordinates with overlay.place().
 * Their buttons cancel mousedown so clicking them does not take focus or the selection from the
 * editor. Each plugin view removes its elements and listeners in destroy(), which runs whenever the
 * shell loads another document.
 */
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import {
  addColumnBefore, addColumnAfter, deleteColumn, addRowBefore, addRowAfter, deleteRow, deleteTable,
  selectedRect, isInTable
} from "prosemirror-tables";
import { h, svg } from "../ui/dom.js";
import { openPopover, buildMenu, menuFromButton, place } from "../ui/overlay.js";
import { schema } from "../schema.js";
import * as C from "./commands.js";
import { isSafeHref } from "../app/paths.js";
import { TURN_INTO, insertItems, turnIntoRun, blockLabel } from "./blocks.js";

const N = schema.nodes, M = schema.marks;

/* =====================================================================
   Slash menu: type "/" at the start of a block or after a space
   ===================================================================== */
// Plugin state: { active, from, query }. `from` is the position of the "/", `query` what was typed
// after it. The state follows the text being typed, so the menu filters as the user types.
export const slashKey = new PluginKey("slash");

/**
 * Slash menu. Typing "/" at the start of a block or after a space opens a filtered list of blocks
 * and inserts (editor/blocks.js); Enter or Tab picks, Escape closes, and the typed "/query" is removed
 * before the chosen command runs.
 *
 * The menu closes on its own when the cursor leaves the "/query" text, the selection is no longer a
 * cursor, the query grows past 40 characters or contains a double space or newline, or nothing has
 * matched for more than 2 characters. So it never gets in the way of typing a real slash, as in
 * "and/or" (no space before it) or a path.
 *
 * @param {object} app  passed to insertItems for items that open dialogs
 */
export function slashPlugin(app) {
  let menu = null, pop = null;
  const allItems = () => [
    { type: "header", label: "Blocks" },
    ...TURN_INTO.map((t) => ({ ...t, act: turnIntoRun(t.id) })),
    { type: "header", label: "Insert" },
    ...insertItems(app).map(({ run, ...it }) => ({ ...it, act: run }))
  ];
  // Closes the popover (if open) and clears the plugin state.
  function close(view) {
    if (pop) { const p = pop; pop = null; menu = null; p.close("run"); }
    if (view && slashKey.getState(view.state).active) view.dispatch(view.state.tr.setMeta(slashKey, { close: true }));
  }
  // Runs a picked item: delete "/query" first, then act, so the command sees a clean block.
  function choose(view, it) {
    const st = slashKey.getState(view.state);
    if (!st.active) return;
    const to = view.state.selection.from;
    view.dispatch(view.state.tr.delete(st.from, to).setMeta(slashKey, { close: true }));
    if (pop) { const p = pop; pop = null; menu = null; p.close("run"); }
    if (it.act) it.act(view);
    view.focus();
  }
  return new Plugin({
    key: slashKey,
    state: {
      init: () => ({ active: false, from: 0, query: "" }),
      apply(tr, prev, oldState, state) {
        const meta = tr.getMeta(slashKey);
        if (meta && meta.close) return { active: false, from: 0, query: "" };
        if (meta && meta.open != null) return { active: true, from: meta.open, query: "" };
        if (!prev.active) return prev;
        const from = tr.mapping.map(prev.from);
        const sel = state.selection;
        if (!sel.empty || sel.from <= from) return { active: false, from: 0, query: "" };
        const $f = state.doc.resolve(from), $c = sel.$from;
        if (!$f.sameParent($c)) return { active: false, from: 0, query: "" };
        const text = state.doc.textBetween(from, sel.from, "\n");
        if (!text.startsWith("/") || text.length > 40 || /\s\s|\n/.test(text)) return { active: false, from: 0, query: "" };
        return { active: true, from, query: text.slice(1) };
      }
    },
    props: {
      // Opens the menu when "/" is typed at the start of a text block or after whitespace (not in code).
      handleTextInput(view, from, to, text) {
        if (text !== "/") return false;
        const $from = view.state.doc.resolve(from);
        if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
        const before = $from.parent.textBetween(0, $from.parentOffset, "\n", " ");
        if (before && !/\s$/.test(before)) return false;
        view.dispatch(view.state.tr.insertText("/", from, to).setMeta(slashKey, { open: from }));
        return true;
      },
      // While open, the menu takes navigation keys. Enter/Tab with nothing highlighted close it and
      // fall through, so they still do their normal job in the document.
      handleKeyDown(view, e) {
        const st = slashKey.getState(view.state);
        if (!st.active || !menu) return false;
        if (e.key === "Escape") { close(view); return true; }
        if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Home", "End"].includes(e.key)) {
          if ((e.key === "Enter" || e.key === "Tab") && !menu.active) { close(view); return false; }
          menu.onKey(e);
          return true;
        }
        return false;
      }
    },
    view(view) {
      return {
        update(view) {
          const st = slashKey.getState(view.state);
          if (!st.active) { if (pop) { const p = pop; pop = null; menu = null; p.close("run"); } return; }
          const rect = () => { const c = view.coordsAtPos(st.from); return { left: c.left, right: c.left, top: c.top, bottom: c.bottom, width: 0, height: c.bottom - c.top }; };
          if (!pop) {
            menu = buildMenu(allItems(), { filter: "", className: "menu-scroll slash-menu", onRun: (it) => choose(view, it), emptyText: "No matching blocks" });
            pop = openPopover(menu.el, { rect, side: "bottom", align: "start", gap: 6, focus: false, keepOpenOn: ".ProseMirror", onClose: (r) => { if (r !== "run") { pop = null; menu = null; close(view); } } });
          }
          const n = menu.filter(st.query);
          if (!n && st.query.length > 2) { close(view); return; }
          pop.reposition();
        },
        destroy() { if (pop) pop.close("run"); }
      };
    }
  });
}

/* =====================================================================
   Selection bar: formatting for a text selection
   ===================================================================== */
/**
 * Selection bar: a floating formatting toolbar above a non-empty text selection (not in code). It is
 * hidden while the mouse button is down, so it does not jump around during a drag, and shown on
 * mouseup; it follows scrolling. Button states (bold on/off …) are refreshed on every selection change.
 *
 * @param {object} app  for the link editor
 */
export function selectionBarPlugin(app) {
  return new Plugin({
    view(view) {
      const bar = h("div", { class: "selbar", role: "toolbar", "aria-label": "Format text" });
      let mouseDown = false, visible = false;
      const btn = (iconName, tip, k, run, isActive) => {
        const b = h("button", { class: "selbar-btn", type: "button", "data-tip": tip, "data-kbd": k || null, "aria-label": tip }, svg(iconName, 16));
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => { run(view.state, view.dispatch, view); view.focus(); });
        b._active = isActive;
        return b;
      };
      const turnBtn = h("button", { class: "selbar-turn", type: "button", "data-tip": "Turn into" }, h("span", { class: "selbar-turn-label" }), svg("ChevronDown", 14));
      turnBtn.addEventListener("mousedown", (e) => e.preventDefault());
      turnBtn.addEventListener("click", () => {
        const cur = blockLabel(view.state).id;
        menuFromButton(turnBtn, TURN_INTO.map((t) => ({ label: t.label, icon: t.icon, kbd: t.kbd, checked: t.id === cur, run: () => { turnIntoRun(t.id)(view); view.focus(); } })), { width: 240 });
      });
      const buttons = [
        btn("Bold", "Bold", "Mod-B", C.toggleBold, (s) => C.markActive(s, M.strong)),
        btn("Italic", "Italic", "Mod-I", C.toggleItalic, (s) => C.markActive(s, M.em)),
        btn("Underline", "Underline", "Mod-U", C.toggleUnderline, (s) => C.markActive(s, M.underline)),
        btn("Strike", "Strikethrough", "Mod-Shift-X", C.toggleStrike, (s) => C.markActive(s, M.strike)),
        "sep",
        btn("Code", "Inline code", "Mod-E", C.toggleCode, (s) => C.markActive(s, M.code)),
        btn("Highlight", "Highlight", "Mod-Shift-H", C.toggleHighlight, (s) => C.markActive(s, M.highlight)),
        btn("Link", "Link", "Mod-K", () => app.editLink(), (s) => C.markActive(s, M.link)),
        btn("MathInline", "Turn into equation", "Mod-Shift-E", C.insertMathInline, () => false),
        "sep"
      ];
      const more = h("button", { class: "selbar-btn", type: "button", "data-tip": "More", "aria-label": "More formatting" }, svg("More", 16));
      more.addEventListener("mousedown", (e) => e.preventDefault());
      more.addEventListener("click", () => {
        const s = view.state;
        menuFromButton(more, [
          { label: "Subscript", icon: "Sub", kbd: "Mod-,", checked: C.markActive(s, M.sub), run: () => { C.toggleSub(view.state, view.dispatch); view.focus(); } },
          { label: "Superscript", icon: "Sup", kbd: "Mod-.", checked: C.markActive(s, M.sup), run: () => { C.toggleSup(view.state, view.dispatch); view.focus(); } },
          { type: "sep" },
          { label: "Clear formatting", icon: "ClearFormat", run: () => { C.clearFormatting(view.state, view.dispatch); view.focus(); } }
        ], { align: "end" });
      });
      bar.append(turnBtn, h("span", { class: "selbar-sep" }), ...buttons.map((b) => (b === "sep" ? h("span", { class: "selbar-sep" }) : b)), more);
      (document.getElementById("layer") || document.body).appendChild(bar);

      const onDown = () => { mouseDown = true; hide(); };
      const onUp = () => { if (!mouseDown) return; mouseDown = false; setTimeout(() => update(view), 0); };
      view.dom.addEventListener("mousedown", onDown);
      document.addEventListener("mouseup", onUp);

      function hide() { if (visible) { bar.classList.remove("is-visible"); visible = false; } }
      // Only for real text selections with some non-blank text, and never inside code blocks.
      function shouldShow(state) {
        const sel = state.selection;
        if (!(sel instanceof TextSelection) || sel.empty) return false;
        if (sel.$from.parent.type.spec.code || sel.$to.parent.type.spec.code) return false;
        if (!state.doc.textBetween(sel.from, sel.to).trim()) return false;
        return true;
      }
      // Positions the bar centred above the selection. For a selection spanning several lines its left
      // edge is clamped to the editor, so the bar does not jump to the far left of the page.
      function update(view) {
        if (mouseDown || !view.hasFocus() && !bar.contains(document.activeElement)) { hide(); return; }
        if (!shouldShow(view.state)) { hide(); return; }
        const label = blockLabel(view.state);
        turnBtn.querySelector(".selbar-turn-label").textContent = label.label;
        for (const b of buttons) if (b !== "sep") b.classList.toggle("is-active", !!b._active(view.state));
        const { from, to } = view.state.selection;
        const a = view.coordsAtPos(from), b = view.coordsAtPos(to, -1);
        const rect = { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
        if (a.top !== b.top) { const r = view.dom.getBoundingClientRect(); rect.left = Math.max(r.left, Math.min(a.left, b.left)); }
        rect.width = rect.right - rect.left; rect.height = rect.bottom - rect.top;
        bar.classList.add("is-visible");
        visible = true;
        place(bar, rect, { side: "top", align: "center", gap: 8 });
      }
      const onScroll = () => { if (visible) update(view); };
      window.addEventListener("scroll", onScroll, true);
      return {
        update(view, prev) {
          if (prev && prev.selection.eq(view.state.selection) && prev.doc.eq(view.state.doc)) return;
          update(view);
        },
        destroy() { bar.remove(); view.dom.removeEventListener("mousedown", onDown); document.removeEventListener("mouseup", onUp); window.removeEventListener("scroll", onScroll, true); }
      };
    },
    props: {
      handleDOMEvents: {
        blur(view, e) {
          const bar = document.querySelector(".selbar");
          if (bar && e.relatedTarget && bar.contains(e.relatedTarget)) return false;
          setTimeout(() => { if (!view.hasFocus() && bar && !bar.contains(document.activeElement) && !document.querySelector(".pop")) bar.classList.remove("is-visible"); }, 0);
          return false;
        }
      }
    }
  });
}

/* =====================================================================
   Link bar: shows the URL of the link under the caret
   ===================================================================== */
/**
 * Link bar: when the cursor is inside a link, shows its URL with Open, Edit and Remove buttons.
 * Ctrl/Cmd-click on a link opens it directly. Links open through app.openLink, which opens other
 * Markdown documents in the same storage inside the editor and refuses unsafe URL schemes.
 *
 * @param {object} app
 */
export function linkBarPlugin(app) {
  return new Plugin({
    view(view) {
      const urlEl = h("a", { class: "linkbar-url", target: "_blank", rel: "noopener noreferrer" });
      const edit = h("button", { class: "selbar-btn", type: "button", "data-tip": "Edit link", "aria-label": "Edit link" }, svg("Edit", 15));
      const unlink = h("button", { class: "selbar-btn", type: "button", "data-tip": "Remove link", "aria-label": "Remove link" }, svg("Unlink", 15));
      const open = h("button", { class: "selbar-btn", type: "button", "data-tip": "Open link", "aria-label": "Open link" }, svg("OpenLink", 15));
      const bar = h("div", { class: "selbar linkbar" }, h("span", { class: "linkbar-icon" }, svg("Link", 14)), urlEl, h("span", { class: "selbar-sep" }), open, edit, unlink);
      [edit, unlink, open].forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
      (document.getElementById("layer") || document.body).appendChild(bar);
      let range = null;
      edit.addEventListener("click", () => app.editLink(range));
      unlink.addEventListener("click", () => {
        if (!range) return;
        view.dispatch(view.state.tr.removeMark(range.from, range.to, M.link));
        view.focus();
      });
      open.addEventListener("click", () => { if (range) app.openLink(range.href); });
      urlEl.addEventListener("click", (e) => { e.preventDefault(); if (range) app.openLink(range.href); });
      function update(view) {
        const sel = view.state.selection;
        range = sel.empty && view.hasFocus() ? C.linkRange(view.state, sel.from) : null;
        if (!range) { bar.classList.remove("is-visible"); return; }
        urlEl.textContent = range.href;
        // only safe targets become a real href (middle-click and "copy link" bypass app.openLink)
        urlEl.href = isSafeHref(range.href) ? range.href : "#";
        const a = view.coordsAtPos(range.from), b = view.coordsAtPos(range.to, -1);
        const rect = { left: a.left, right: Math.max(a.right, b.right), top: a.top, bottom: Math.max(a.bottom, b.bottom) };
        if (a.top !== b.top) rect.right = a.left + 40;
        rect.width = rect.right - rect.left; rect.height = rect.bottom - rect.top;
        bar.classList.add("is-visible");
        place(bar, rect, { side: "bottom", align: "start", gap: 6 });
      }
      const onScroll = () => { if (range) update(view); };
      window.addEventListener("scroll", onScroll, true);
      return {
        update(view, prev) { if (prev && prev.selection.eq(view.state.selection) && prev.doc.eq(view.state.doc)) return; update(view); },
        destroy() { bar.remove(); window.removeEventListener("scroll", onScroll, true); }
      };
    },
    props: {
      handleClickOn(view, pos, node, nodePos, e) {
        // Ctrl/Cmd-click opens links
        if (!(e.metaKey || e.ctrlKey)) return false;
        const r = C.linkRange(view.state, pos);
        if (r) { app.openLink(r.href); return true; }
        return false;
      },
      handleDOMEvents: {
        blur() { setTimeout(() => { const b = document.querySelector(".linkbar"); if (b && !b.matches(":hover")) b.classList.remove("is-visible"); }, 120); return false; }
      }
    }
  });
}

/* =====================================================================
   Tables: keep the first row as the header row (Markdown needs one), and
   show row/column handles with their menus around the table in focus
   ===================================================================== */
// Markdown tables always have exactly one header row: the first. After any change (rows moved, a row
// inserted above the header, a pasted table) this makes the first row header cells and every other
// row normal cells. Outside the undo history, so it never shows up as a separate step.
export function tableNormalizePlugin() {
  return new Plugin({
    appendTransaction(trs, old, state) {
      if (!trs.some((t) => t.docChanged)) return null;
      let tr = null;
      state.doc.descendants((node, pos) => {
        if (node.type !== N.table) return node.isBlock && !node.isTextblock;
        node.forEach((row, rowOff, r) => {
          row.forEach((cell, cellOff) => {
            const want = r === 0 ? N.table_header : N.table_cell;
            if (cell.type !== want) {
              tr = tr || state.tr;
              tr.setNodeMarkup(pos + 1 + rowOff + 1 + cellOff, want, cell.attrs);
            }
          });
        });
        return false;
      });
      return tr ? tr.setMeta("addToHistory", false) : null;
    }
  });
}

/**
 * Row and column controls for the table holding the cursor: a grip above the current column and left
 * of the current row (each opens a menu: insert, align, delete), plus "+" bars to add a column on the
 * right and a row at the bottom. Positions are recomputed on every update, scroll and resize; the
 * column grip is hidden when its column is scrolled out of view in a wide table.
 * The header row cannot be deleted when it is the only row (a table needs a header).
 */
export function tableControlsPlugin() {
  return new Plugin({
    view(view) {
      const layer = document.getElementById("layer") || document.body;
      const colGrip = h("button", { class: "tbl-grip tbl-grip-col", type: "button", "data-tip": "Column options", "aria-label": "Column options" }, svg("GripH", 14));
      const rowGrip = h("button", { class: "tbl-grip tbl-grip-row", type: "button", "data-tip": "Row options", "aria-label": "Row options" }, svg("GripV", 14));
      const addCol = h("button", { class: "tbl-add tbl-add-col", type: "button", "data-tip": "Add column", "aria-label": "Add column" }, svg("Plus", 13));
      const addRow = h("button", { class: "tbl-add tbl-add-row", type: "button", "data-tip": "Add row", "aria-label": "Add row" }, svg("Plus", 13));
      const els = [colGrip, rowGrip, addCol, addRow];
      els.forEach((e) => { e.addEventListener("mousedown", (ev) => ev.preventDefault()); layer.appendChild(e); });
      let info = null;

      const run = (cmd) => { cmd(view.state, view.dispatch); view.focus(); };
      // Sets the alignment of every cell in the selected column(s); null means default (left), which
      // the serializer writes as plain "---".
      function alignColumn(align) {
        const rect = selectedRect(view.state);
        const tr = view.state.tr;
        const seen = new Set();
        for (let row = 0; row < rect.map.height; row++) {
          for (let col = rect.left; col < rect.right; col++) {
            const cellPos = rect.map.map[row * rect.map.width + col];
            if (seen.has(cellPos)) continue;
            seen.add(cellPos);
            const cell = rect.table.nodeAt(cellPos);
            tr.setNodeMarkup(rect.tableStart + cellPos, null, { ...cell.attrs, align });
          }
        }
        view.dispatch(tr); view.focus();
      }
      // Alignment of the current column, for the menu's check marks.
      function currentAlign() {
        try { const rect = selectedRect(view.state); const cell = rect.table.nodeAt(rect.map.map[rect.left]); return cell.attrs.align || "left"; } catch { return "left"; }
      }
      colGrip.addEventListener("click", () => {
        const al = currentAlign();
        menuFromButton(colGrip, [
          { label: "Insert column left", icon: "ColLeft", run: () => run(addColumnBefore) },
          { label: "Insert column right", icon: "ColRight", run: () => run(addColumnAfter) },
          { type: "sep" },
          { label: "Align left", icon: "AlignLeft", checked: al === "left", run: () => alignColumn(null) },
          { label: "Align center", icon: "AlignCenter", checked: al === "center", run: () => alignColumn("center") },
          { label: "Align right", icon: "AlignRight", checked: al === "right", run: () => alignColumn("right") },
          { type: "sep" },
          { label: "Delete column", icon: "ColDelete", danger: true, run: () => run(deleteColumn) },
          { label: "Delete table", icon: "Delete", danger: true, run: () => run(deleteTable) }
        ], { width: 230 });
      });
      rowGrip.addEventListener("click", () => {
        const isHeader = info && info.row === 0;
        menuFromButton(rowGrip, [
          { label: "Insert row above", icon: "RowAbove", run: () => run(addRowBefore) },
          { label: "Insert row below", icon: "RowBelow", run: () => run(addRowAfter) },
          { type: "sep" },
          { label: "Delete row", icon: "RowDelete", danger: true, disabled: isHeader && info.rows === 1, run: () => run(deleteRow) },
          { label: "Delete table", icon: "Delete", danger: true, run: () => run(deleteTable) }
        ], { side: "right", width: 220 });
      });
      addCol.addEventListener("click", () => {
        if (!info) return;
        // move into the last column, then add one after it
        const rect = selectedRect(view.state);
        const lastCellPos = rect.tableStart + rect.map.map[rect.top * rect.map.width + rect.map.width - 1];
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(lastCellPos + 1))));
        addColumnAfter(view.state, view.dispatch);
        view.focus();
      });
      addRow.addEventListener("click", () => {
        if (!info) return;
        const rect = selectedRect(view.state);
        const lastCellPos = rect.tableStart + rect.map.map[(rect.map.height - 1) * rect.map.width + rect.left];
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(lastCellPos + 1))));
        addRowAfter(view.state, view.dispatch);
        view.focus();
      });

      function hide() { els.forEach((e) => e.classList.remove("is-visible")); info = null; }
      // Shows the controls only while the editor (or one of the controls, or their menu) has focus.
      function update() {
        const state = view.state;
        if (!view.editable || !isInTable(state) || !(view.hasFocus() || els.some((e) => e === document.activeElement) || document.querySelector(".pop"))) { if (!document.querySelector(".pop")) hide(); return; }
        let rect;
        try { rect = selectedRect(state); } catch { hide(); return; }
        const tableDom = view.nodeDOM(rect.tableStart - 1);
        const table = tableDom && (tableDom.tagName === "TABLE" ? tableDom : tableDom.querySelector && tableDom.querySelector("table"));
        if (!table) { hide(); return; }
        const cellPos = rect.tableStart + rect.map.map[rect.top * rect.map.width + rect.left];
        const cellDom = view.nodeDOM(cellPos);
        if (!cellDom || !cellDom.getBoundingClientRect) { hide(); return; }
        const tr = table.getBoundingClientRect(), cr = cellDom.getBoundingClientRect();
        const wrap = table.parentElement.getBoundingClientRect();
        const visLeft = Math.max(tr.left, wrap.left), visRight = Math.min(tr.right, wrap.right);
        info = { row: rect.top, rows: rect.map.height };
        colGrip.style.left = Math.round(cr.left + cr.width / 2 - 14) + "px"; colGrip.style.top = Math.round(tr.top - 13) + "px";
        rowGrip.style.left = Math.round(visLeft - 13) + "px"; rowGrip.style.top = Math.round(cr.top + cr.height / 2 - 14) + "px";
        addCol.style.left = Math.round(visRight + 4) + "px"; addCol.style.top = Math.round(tr.top) + "px"; addCol.style.height = Math.round(tr.height) + "px";
        addRow.style.left = Math.round(visLeft) + "px"; addRow.style.top = Math.round(tr.bottom + 4) + "px"; addRow.style.width = Math.round(visRight - visLeft) + "px";
        const showCol = cr.left + cr.width / 2 >= visLeft && cr.left + cr.width / 2 <= visRight;
        colGrip.classList.toggle("is-visible", showCol);
        rowGrip.classList.add("is-visible");
        addCol.classList.toggle("is-visible", tr.right <= wrap.right + 1);
        addRow.classList.add("is-visible");
      }
      const onScroll = () => update();
      const onFocus = () => setTimeout(update, 0);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onScroll);
      view.dom.addEventListener("focus", onFocus);
      return {
        update: () => update(),
        destroy() { view.dom.removeEventListener("focus", onFocus); els.forEach((e) => e.remove()); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onScroll); }
      };
    },
    props: {
      handleDOMEvents: {
        blur() { setTimeout(() => { if (!document.querySelector(".pop") && !document.activeElement?.closest?.(".tbl-grip, .tbl-add")) document.querySelectorAll(".tbl-grip, .tbl-add").forEach((e) => e.classList.remove("is-visible")); }, 0); return false; }
      }
    }
  });
}

