/**
 * Editing commands used by the keymap, toolbar, selection bar, slash menu and context menu.
 *
 * Every command follows ProseMirror's command contract: `(state, dispatch?) => boolean`. It returns
 * whether it applies; when `dispatch` is omitted it only answers that question (used to enable or
 * disable buttons) and must not change anything. Factories such as setHeading(level) return a command.
 */
import { toggleMark, setBlockType, wrapIn, lift, chainCommands, exitCode } from "prosemirror-commands";
import { wrapInList, liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { NodeSelection, TextSelection, Selection } from "prosemirror-state";
import { schema } from "../schema.js";

const N = schema.nodes, M = schema.marks;

// Mark toggles. With an empty selection they set a stored mark, so the next typed text is formatted.
export const toggleBold = toggleMark(M.strong);
export const toggleItalic = toggleMark(M.em);
export const toggleUnderline = toggleMark(M.underline);
export const toggleStrike = toggleMark(M.strike);
export const toggleCode = toggleMark(M.code);
export const toggleHighlight = toggleMark(M.highlight);
export const toggleSub = toggleMark(M.sub);
export const toggleSup = toggleMark(M.sup);

/**
 * Whether a mark is active, for toolbar button states: at the cursor (including marks just toggled
 * on but not yet typed), or anywhere inside a non-empty selection.
 */
export function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  let found = false;
  state.doc.nodesBetween(from, to, (node) => { if (!found && node.isInline && type.isInSet(node.marks)) found = true; });
  return found;
}

// Removes all text formatting from the selection. Links are kept on purpose: they are content, not style.
export function clearFormatting(state, dispatch) {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  if (dispatch) {
    let tr = state.tr;
    for (const name of ["strong", "em", "underline", "strike", "highlight", "sub", "sup", "code"]) tr = tr.removeMark(from, to, M[name]);
    dispatch(tr);
  }
  return true;
}

/* ---------- block types ---------- */
// The innermost list (bullet, numbered or checklist) around a position, or null.
function findListAncestor($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type === N.bullet_list || n.type === N.ordered_list || n.type === N.task_list) return { node: n, depth: d, pos: $pos.before(d) };
  }
  return null;
}

/**
 * Names the kind of block at the selection, as a TURN_INTO id (editor/blocks.js): "paragraph",
 * "h1"…"h6", "bullet", "ordered", "task", "quote", "code", or "math" for a selected equation.
 * Lists win over quotes, so a list inside a quote reports the list.
 */
export function blockTypeName(state) {
  const { $from } = state.selection;
  if (state.selection instanceof NodeSelection) {
    const n = state.selection.node;
    if (n.type === N.math_block) return "math";
    if (n.type === N.code_block) return "code";
  }
  const parent = $from.parent;
  if (parent.type === N.heading) return "h" + parent.attrs.level;
  if (parent.type === N.code_block) return "code";
  const list = findListAncestor($from);
  if (list) return list.node.type === N.task_list ? "task" : list.node.type === N.ordered_list ? "ordered" : "bullet";
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === N.blockquote) return "quote";
  return "paragraph";
}

// Converts a list (and its items) to another list kind in place, keeping nested content and the
// tight/loose setting. Checked state survives only between checklists; numbering restarts at 1.
function convertList(state, dispatch, list, targetList) {
  const itemType = targetList === N.task_list ? N.task_item : N.list_item;
  const tr = state.tr;
  const convert = (node) => {
    const items = [];
    node.forEach((item) => {
      const content = [];
      item.forEach((child) => content.push(child));
      items.push(itemType.create(itemType === N.task_item ? { checked: !!item.attrs.checked } : null, content));
    });
    const attrs = targetList === N.ordered_list ? { order: 1, tight: node.attrs.tight } : { tight: node.attrs.tight };
    return targetList.create(attrs, items);
  };
  tr.replaceWith(list.pos, list.pos + list.node.nodeSize, convert(list.node));
  try { tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(state.selection.from)))); } catch { /* keep */ }
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}

// Runs commands one after another, each against the state the previous one produced, and dispatches
// all their steps as ONE transaction, so a compound change ("heading -> paragraph -> list") is a
// single undo step. Fails without changing anything if any step does not apply.
function sequence(state, dispatch, steps) {
  let s = state;
  const tr = state.tr;
  for (const step of steps) {
    let ran = false;
    const ok = step(s, (t) => {
      t.steps.forEach((st) => tr.step(st));
      tr.setSelection(Selection.fromJSON(tr.doc, t.selection.toJSON()));
      s = s.apply(t);
      ran = true;
    });
    if (!ok || !ran) return false;
  }
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}

// Lifts the selection out of every list around it (nested lists included), as one transaction.
// The guard caps the loop in case a lift ever stops making progress.
function liftAllLists(state, dispatch) {
  if (!findListAncestor(state.selection.$from)) return false;
  let s = state;
  const tr = state.tr;
  for (let guard = 0; guard < 10 && findListAncestor(s.selection.$from); guard++) {
    let next = null;
    unwrapLists(s, (t) => { next = t; });
    if (!next) break;
    next.steps.forEach((st) => tr.step(st));
    tr.setSelection(Selection.fromJSON(tr.doc, next.selection.toJSON()));
    s = s.apply(next);
  }
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Toggle-list command factory used by the toolbar and shortcuts:
 *   already in that kind of list -> lift the item out of it
 *   in another kind of list      -> convert the whole list
 *   in a heading or other block  -> make it a paragraph first, then wrap
 * @param {import("prosemirror-model").NodeType} targetList  bullet_list, ordered_list or task_list
 */
export function toggleList(targetList) {
  const itemType = targetList === N.task_list ? N.task_item : N.list_item;
  return (state, dispatch) => {
    const list = findListAncestor(state.selection.$from);
    if (list && list.node.type === targetList) return liftListItem(itemType)(state, dispatch);
    if (list) return convertList(state, dispatch, list, targetList);
    const parent = state.selection.$from.parent;
    if (parent.type !== N.paragraph && parent.isTextblock) {
      if (!dispatch) return true;
      return sequence(state, dispatch, [setBlockType(N.paragraph), wrapInList(targetList)]);
    }
    return wrapInList(targetList)(state, dispatch);
  };
}

// Lifts the current item out of its innermost list (one level).
function unwrapLists(state, dispatch) {
  const list = findListAncestor(state.selection.$from);
  if (!list) return false;
  const itemType = list.node.type === N.task_list ? N.task_item : N.list_item;
  return liftListItem(itemType)(state, dispatch);
}

// "Text" in the block menu: whatever the block is (list item, quote, heading), make it a plain paragraph.
export function setParagraph(state, dispatch) {
  const name = blockTypeName(state);
  if (["bullet", "ordered", "task"].includes(name)) return liftAllLists(state, dispatch);
  if (name === "quote") return lift(state, dispatch);
  return setBlockType(N.paragraph)(state, dispatch);
}

/**
 * Turns the current block into another kind (selection bar, slash menu, Insert menu).
 * Converts by first returning to a plain paragraph and then applying the new type, all in one undo
 * step (see sequence). List-to-list changes convert the whole list instead, and heading-to-heading
 * changes only change the level. Choosing the current kind again is a no-op.
 * @param {string} kind  a TURN_INTO id
 */
export function turnInto(kind) {
  return (state, dispatch) => {
    const cur = blockTypeName(state);
    if (kind === cur && kind !== "paragraph") return true;
    const toPara = (s, d) => (["bullet", "ordered", "task"].includes(blockTypeName(s)) ? liftAllLists(s, d) : blockTypeName(s) === "quote" ? lift(s, d) : setBlockType(N.paragraph)(s, d));
    const steps = [];
    if (cur !== "paragraph" && !(kind.startsWith("h") && cur.startsWith("h"))) steps.push(toPara);
    if (kind === "paragraph") { /* done */ }
    else if (kind.startsWith("h")) steps.push(setBlockType(N.heading, { level: +kind.slice(1) }));
    else if (kind === "bullet") steps.push(wrapInList(N.bullet_list));
    else if (kind === "ordered") steps.push(wrapInList(N.ordered_list));
    else if (kind === "task") steps.push(wrapInList(N.task_list));
    else if (kind === "quote") steps.push(wrapIn(N.blockquote));
    else if (kind === "code") steps.push(setCodeBlock(""));
    if (!steps.length) return false;
    if (["bullet", "ordered", "task"].includes(cur) && ["bullet", "ordered", "task"].includes(kind)) {
      const list = findListAncestor(state.selection.$from);
      return convertList(state, dispatch, list, { bullet: N.bullet_list, ordered: N.ordered_list, task: N.task_list }[kind]);
    }
    return sequence(state, dispatch, steps);
  };
}

// Heading shortcut: applying the level the block already has turns it back into a paragraph.
export function setHeading(level) {
  return (state, dispatch) => {
    const p = state.selection.$from.parent;
    if (p.type === N.heading && p.attrs.level === level) return setBlockType(N.paragraph)(state, dispatch);
    return setBlockType(N.heading, { level })(state, dispatch);
  };
}

// Wraps the block in a quote, or lifts it out when it is already quoted.
export function toggleQuote(state, dispatch) {
  if (blockTypeName(state) === "quote") return lift(state, dispatch);
  return wrapIn(N.blockquote)(state, dispatch);
}

/**
 * Code block toggle. In a code block it becomes a paragraph again. With several blocks selected, their
 * text is joined line by line into one code block (formatting is dropped, since code has no marks).
 * @param {string} [language]  fence language for the new block
 */
export function setCodeBlock(language = "") {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    if ($from.parent.type === N.code_block) return setBlockType(N.paragraph)(state, dispatch);
    // several paragraphs selected: join them into one code block
    if (!$from.sameParent($to)) {
      const range = $from.blockRange($to);
      if (!range) return false;
      if (dispatch) {
        const lines = [];
        state.doc.nodesBetween(range.start, range.end, (n) => { if (n.isTextblock) { lines.push(n.textContent); return false; } return true; });
        const node = N.code_block.create({ language }, lines.join("\n") ? schema.text(lines.join("\n")) : null);
        const tr = state.tr.replaceWith(range.start, range.end, node);
        tr.setSelection(TextSelection.create(tr.doc, range.start + 1));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    return setBlockType(N.code_block, { language })(state, dispatch);
  };
}

/* ---------- inserting blocks ---------- */
/**
 * Inserts a block node near the selection:
 *   - an empty paragraph is replaced by it (the slash-menu case)
 *   - in the middle of text, the paragraph is split and the block goes between the halves
 *   - otherwise it goes after the current block (before it when the cursor is at the very start)
 * A paragraph is added after the block when nothing follows it, so the cursor can always get below
 * a table, equation or diagram at the end of the document.
 *
 * @param {import("prosemirror-model").Node} node
 * @param {{select?: "inside"|"node"|"after"}} [options]  where the selection goes afterwards: into
 *        the block (default), onto the block as a node selection (atoms such as equations), or into
 *        the paragraph after it
 */
export function insertBlock(node, { select = "inside" } = {}) {
  return (state, dispatch) => {
    const { $from } = state.selection;
    let tr = state.tr;
    let pos;
    const parent = $from.parent;
    if (state.selection instanceof NodeSelection) {
      pos = state.selection.to;
      tr = tr.insert(pos, node);
    } else if (parent.type === N.paragraph && parent.content.size === 0 && $from.depth >= 1) {
      pos = $from.before();
      tr = tr.replaceWith(pos, $from.after(), node);
    } else {
      // split if in the middle of text, else insert after the block
      if ($from.parentOffset > 0 && $from.parentOffset < parent.content.size && parent.isTextblock) {
        tr = tr.split($from.pos);
        pos = tr.mapping.map($from.pos);
        tr = tr.insert(pos, node);
      } else {
        pos = $from.parentOffset === 0 && parent.content.size > 0 ? $from.before() : $from.after();
        tr = tr.insert(pos, node);
      }
    }
    const end = pos + node.nodeSize;
    if (end >= tr.doc.content.size || !tr.doc.resolve(end).nodeAfter) tr = tr.insert(end, N.paragraph.create());
    if (select === "node") tr = tr.setSelection(NodeSelection.create(tr.doc, pos));
    else if (select === "after") tr = tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
    else tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

export function insertHorizontalRule(state, dispatch) {
  return insertBlock(N.horizontal_rule.create(), { select: "after" })(state, dispatch);
}

// Inserts an empty table whose first row is the header row (GFM tables always have one).
export function insertTable(rows = 3, cols = 3) {
  return (state, dispatch) => {
    const cell = (header) => (header ? N.table_header : N.table_cell).create();
    const rowsArr = [];
    for (let r = 0; r < rows; r++) {
      const cells = [];
      for (let c = 0; c < cols; c++) cells.push(cell(r === 0));
      rowsArr.push(N.table_row.create(null, cells));
    }
    return insertBlock(N.table.create(null, rowsArr))(state, dispatch);
  };
}

// Inserts an empty equation block, selected as a node so its TeX editor opens (editor/editor.js).
export function insertMathBlock(state, dispatch) {
  return insertBlock(N.math_block.create({ tex: "", layout: "fenced" }), { select: "node" })(state, dispatch);
}

// Inserts a collapsible section with an empty summary and body. It starts closed in exports
// (open: false) because sections are mostly used for answers and long derivations.
export function insertDetails(summary = "") {
  return (state, dispatch) => {
    const node = N.details.create({ open: false }, [
      N.details_summary.create(null, summary ? schema.text(summary) : null),
      N.details_content.create(null, [N.paragraph.create()])
    ]);
    return insertBlock(node)(state, dispatch);
  };
}

// Inserts a Mermaid code block with a small flowchart to edit, which CodeBlockView draws as a diagram.
export function insertDiagram(state, dispatch) {
  const tpl = "flowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]";
  return insertBlock(N.code_block.create({ language: "mermaid" }, schema.text(tpl)))(state, dispatch);
}

// Inserts an image inline at the cursor; outside text (or in code) it goes in a new paragraph instead.
export function insertImage(src, alt = "") {
  return (state, dispatch) => {
    const img = N.image.create({ src, alt });
    const { $from } = state.selection;
    if ($from.parent.inlineContent && $from.parent.type !== N.code_block) {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(img).scrollIntoView());
      return true;
    }
    return insertBlock(N.paragraph.create(null, img), { select: "after" })(state, dispatch);
  };
}

// Inline math: turns the selected text into an equation's TeX, or inserts an empty equation to edit.
export function insertMathInline(state, dispatch) {
  const { from, to, empty, $from } = state.selection;
  if (!$from.parent.inlineContent || $from.parent.type.spec.code) return false;
  const tex = empty ? "" : state.doc.textBetween(from, to, " ");
  if (dispatch) {
    const tr = state.tr.replaceRangeWith(from, to, N.math_inline.create({ tex, display: false }));
    tr.setSelection(NodeSelection.create(tr.doc, from));
    dispatch(tr);
  }
  return true;
}

/**
 * Adds, changes or removes a link (link editor dialog).
 *   href empty          -> remove links from the selection
 *   empty selection     -> insert `text` (or the URL itself) as a new link at the cursor
 *   text given and new  -> replace the selected text, keeping its other formatting
 *   otherwise           -> link the selected text as it is
 * The URL is stored as typed; app.openLink decides what may be opened.
 */
export function setLink(href, text) {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    let tr = state.tr;
    if (!href) { tr = tr.removeMark(from, to, M.link); dispatch(tr); return true; }
    const mark = M.link.create({ href });
    if (empty) {
      const t = text || href;
      tr = tr.insert(from, schema.text(t, [mark]));
      tr = tr.setSelection(TextSelection.create(tr.doc, from + t.length));
      tr = tr.removeStoredMark(M.link);
    } else {
      if (text && text !== state.doc.textBetween(from, to)) {
        tr = tr.replaceWith(from, to, schema.text(text, [...state.doc.resolve(from).marks().filter((m) => m.type !== M.link), mark]));
      } else tr = tr.addMark(from, to, mark);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * The extent of the link around a position: adjacent text nodes with the same link mark count as one
 * link even when their other formatting differs ("see **the** docs" as one link).
 * @returns {{from: number, to: number, href: string, mark: import("prosemirror-model").Mark}|null}
 */
export function linkRange(state, pos) {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.inlineContent) return null;
  const segs = [];
  let off = $pos.start();
  parent.forEach((c) => { segs.push({ from: off, to: off + c.nodeSize, link: M.link.isInSet(c.marks) }); off += c.nodeSize; });
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    if (!sg.link || pos < sg.from || pos > sg.to) continue;
    // at a boundary, prefer the segment the caret is inside of
    if (pos === sg.to && segs[i + 1] && segs[i + 1].link && segs[i + 1].link.eq(sg.link)) continue;
    let a = i, b = i;
    while (a > 0 && segs[a - 1].link && segs[a - 1].link.eq(sg.link)) a--;
    while (b < segs.length - 1 && segs[b + 1].link && segs[b + 1].link.eq(sg.link)) b++;
    return { from: segs[a].from, to: segs[b].to, href: sg.link.attrs.href, mark: sg.link };
  }
  return null;
}

/* ---------- keys ---------- */
// List item commands that work for both normal and checklist items.
export const splitItem = chainCommands(splitListItem(N.list_item), splitListItem(N.task_item));
export const sinkItem = chainCommands(sinkListItem(N.list_item), sinkListItem(N.task_item));
export const liftItem = chainCommands(liftListItem(N.list_item), liftListItem(N.task_item));

// Mod-Enter: checks or unchecks the checklist item the cursor is in.
export function toggleTaskAtCursor(state, dispatch) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type === N.task_item) {
      if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(d), null, { checked: !n.attrs.checked }));
      return true;
    }
  }
  return false;
}

// Tab inside a code block inserts 4 spaces (or indents every selected line); Shift-Tab removes up to
// 4 spaces or one tab from the start of each selected line. Lines are edited bottom-up so earlier
// positions stay valid while text is inserted.
export function codeIndent(outdent) {
  return (state, dispatch) => {
    const { $from, from, to } = state.selection;
    if ($from.parent.type !== N.code_block) return false;
    if (!dispatch) return true;
    const start = $from.start();
    const text = $from.parent.textContent;
    const relFrom = from - start, relTo = to - start;
    const lineStart = text.lastIndexOf("\n", relFrom - 1) + 1;
    let tr = state.tr;
    if (!outdent && from === to) { dispatch(tr.insertText("    ")); return true; }
    const lines = [];
    let i = lineStart;
    while (i <= relTo) {
      lines.push(i);
      const nl = text.indexOf("\n", i);
      if (nl < 0 || nl >= relTo) break;
      i = nl + 1;
    }
    for (const ls of lines.reverse()) {
      const at = start + ls;
      if (outdent) {
        const m = /^( {1,4}|\t)/.exec(text.slice(ls));
        if (m) tr = tr.delete(at, at + m[0].length);
      } else tr = tr.insertText("    ", at);
    }
    dispatch(tr);
    return true;
  };
}

// Backspace at the start of a heading, or in an empty code block, turns it into a paragraph first
// (instead of joining it with the block above).
export function resetBlockOnBackspace(state, dispatch) {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const p = $from.parent;
  if (p.type === N.heading || (p.type === N.code_block && p.content.size === 0)) return setBlockType(N.paragraph)(state, dispatch);
  return false;
}

// Enter on a second empty line at the end of a code block leaves it: the two blank lines are removed
// and a paragraph is started below, as in most Markdown editors.
export function exitCodeOnDoubleEnter(state, dispatch) {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== N.code_block) return false;
  const text = $from.parent.textContent;
  if ($from.parentOffset !== text.length || !text.endsWith("\n\n")) return false;
  if (dispatch) {
    let tr = state.tr.delete($from.pos - 2, $from.pos);
    const after = tr.mapping.map($from.after());
    tr = tr.insert(after, N.paragraph.create());
    tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

// Re-exported for the keymap: leave a code block into a new paragraph below (Mod-Enter / Shift-Enter).
export { exitCode };
