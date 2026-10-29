/**
 * Keyboard shortcuts and Markdown-style input rules.
 *
 * Input rules turn Markdown typed at the keyboard into formatting the moment it is complete
 * ("## " becomes a heading, "**bold**" becomes bold). Backspace straight after a rule fires undoes
 * it and leaves the typed characters, so a rule never traps someone who meant the literal text.
 *
 * "Mod" is Cmd on macOS and Ctrl elsewhere. SHORTCUTS (bottom) is the list the shortcuts dialog shows;
 * keep it in step with buildKeymap when adding or changing a binding.
 */
import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule, undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock, selectParentNode, joinUp, joinDown } from "prosemirror-commands";
import { undo, redo } from "prosemirror-history";
import { goToNextCell } from "prosemirror-tables";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { schema } from "../schema.js";
import * as C from "./commands.js";

const N = schema.nodes, M = schema.marks;

/* ---------- input rules ---------- */
/**
 * Input rule for a delimited mark such as **bold** or `code`.
 *
 * `regexp` must end at the closing delimiter and capture (1) the character before the opener, which
 * keeps intra-word cases like snake_case_name from turning italic, and (2) the text inside. The rule
 * removes both delimiters, marks the text, and clears the stored mark so typing continues unformatted.
 * Inside code blocks (and code-like nodes) nothing happens unless skipCode is false.
 *
 * @param {RegExp} regexp
 * @param {import("prosemirror-model").MarkType} markType
 * @param {{skipCode?: boolean}} [options]
 */
function markRule(regexp, markType, { skipCode = true } = {}) {
  return new InputRule(regexp, (state, match, start, end) => {
    const $s = state.doc.resolve(start);
    if (skipCode && $s.parent.type.spec.code) return null;
    const [full, pre, inner] = match;
    if (!inner) return null;
    const tr = state.tr;
    const textStart = start + full.indexOf(inner, pre ? pre.length : 0);
    const textEnd = textStart + inner.length;
    // marks the text, then deletes the delimiters around it
    if (textEnd < end) tr.delete(textEnd, end);
    if (textStart > start + (pre ? pre.length : 0)) tr.delete(start + (pre ? pre.length : 0), textStart);
    const a = start + (pre ? pre.length : 0);
    tr.addMark(a, a + inner.length, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  });
}

// All input rules, in priority order: block rules (which only match at the start of a paragraph),
// then equations, then inline marks. Each mark pattern requires non-space text just inside both
// delimiters, mirroring CommonMark's flanking rules, so "2 * 3 * 4" is left alone.
const rules = [
  // blocks
  textblockTypeInputRule(/^(#{1,6})\s$/, N.heading, (m) => ({ level: m[1].length })),
  wrappingInputRule(/^\s*>\s$/, N.blockquote),
  // "[ ] " or "[x] " (optionally after "- "): start a checklist. Typed inside an existing bullet list, the
  // whole list becomes a checklist, because the schema keeps lists all-tasks or no-tasks.
  new InputRule(/^\s*(?:[-+*]\s)?\[( |x|X)?\]\s$/, (state, match, start, end) => {
    const $s = state.doc.resolve(start);
    if ($s.parent.type !== N.paragraph) return null;
    const checked = !!match[1] && match[1] !== " ";
    const tr = state.tr.delete(start, end);
    const $p = tr.doc.resolve(start);
    // already in a bullet item: convert that list
    for (let d = $p.depth; d > 0; d--) {
      if ($p.node(d).type === N.bullet_list) {
        const list = $p.node(d), pos = $p.before(d);
        const items = [];
        list.forEach((it) => { const c = []; it.forEach((x) => c.push(x)); items.push(N.task_item.create({ checked }, c)); });
        tr.replaceWith(pos, pos + list.nodeSize, N.task_list.create({ tight: list.attrs.tight }, items));
        // The new list has the same nesting as the old one (list > item > paragraph) and nothing before `start`
        // changed, so `start` is still the cursor position. Mapping it through the whole-list replacement
        // would push it past the list, and the text typed next would land outside the item.
        tr.setSelection(TextSelection.near(tr.doc.resolve(start)));
        return tr;
      }
    }
    const range = $p.blockRange();
    if (!range) return null;
    tr.wrap(range, [{ type: N.task_list }, { type: N.task_item, attrs: { checked } }]);
    return tr;
  }),
  wrappingInputRule(/^\s*([-+*])\s$/, N.bullet_list),
  // "3. " starts a numbered list at 3. The join predicate merges it into a numbered list directly above
  // only when the number continues that list, so "1. " under an existing list starts a new one.
  wrappingInputRule(/^\s*(\d+)[.)]\s$/, N.ordered_list, (m) => ({ order: +m[1] }), (m, node) => node.childCount + node.attrs.order === +m[1]),
  // ``` plus a space or Enter: code block, with the word after the backticks as its language.
  new InputRule(/^```([\w+#-]*)[\s]$/, (state, match, start, end) => {
    const $s = state.doc.resolve(start);
    if ($s.parent.type !== N.paragraph) return null;
    const tr = state.tr.delete(start, end).setBlockType(start, start, N.code_block, { language: match[1] || "" });
    return tr;
  }),
  // "---" alone in a paragraph: divider, followed by a fresh paragraph for the cursor. The rule fires
  // on the third character, so the paragraph must contain exactly the two characters typed before it.
  new InputRule(/^(?:---|\*\*\*|___)$/, (state, match, start, end) => {
    const $s = state.doc.resolve(start);
    if ($s.parent.type !== N.paragraph || $s.parent.content.size !== match[0].length - 1) return null;
    const from = $s.before(), to = $s.after();
    const tr = state.tr.replaceWith(from, to, [N.horizontal_rule.create(), N.paragraph.create()]);
    tr.setSelection(TextSelection.create(tr.doc, from + 2));
    return tr;
  }),
  // "$$ " alone in a paragraph: empty equation block, whose TeX editor opens at once (see editor.js).
  new InputRule(/^\$\$\s$/, (state, match, start, end) => {
    const $s = state.doc.resolve(start);
    if ($s.parent.type !== N.paragraph || $s.depth < 1) return null;
    const from = $s.before(), to = $s.after();
    const tr = state.tr.replaceWith(from, to, N.math_block.create({ tex: "", layout: "fenced" }));
    tr.setSelection(NodeSelection.create(tr.doc, from));
    tr.setMeta("openMathBlock", from);
    return tr;
  }),
  // inline math: $x^2$ (no space after the first $ or before the last)
  new InputRule(/(^|[^$\\\w])\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, match, start, end) => {
    const $s = state.doc.resolve(start);
    if ($s.parent.type.spec.code || markActiveAt(state, start, M.code)) return null;
    const a = start + match[1].length;
    return state.tr.replaceWith(a, end, N.math_inline.create({ tex: match[2], display: false }));
  }),
  // marks
  markRule(/(^|[^*\w])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, M.strong),
  markRule(/(^|[^_\w])__([^_\s](?:[^_]*[^_\s])?)__$/, M.strong),
  markRule(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, M.em),
  markRule(/(^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, M.em),
  markRule(/(^|[^~])~~([^~\s](?:[^~]*[^~\s])?)~~$/, M.strike),
  markRule(/(^|[^=])==([^=\s](?:[^=]*[^=\s])?)==$/, M.highlight),
  markRule(/(^|[^`])`([^`]+)`$/, M.code),
];
// Whether `type` applies at `pos` (used to keep $…$ inside inline code literal).
function markActiveAt(state, pos, type) { return !!type.isInSet(state.doc.resolve(pos).marks()); }

// The input-rules plugin for the editor state (editor/editor.js).
export function buildInputRules() { return inputRules({ rules: rules.filter(Boolean) }); }

/* ---------- keymap ---------- */
/**
 * Key bindings, as two keymap plugins: ours first, then ProseMirror's baseKeymap for everything we do
 * not override (arrows, Delete, select-all …).
 *
 * Keys with several meanings use chainCommands, which tries each command in order until one applies:
 *   Enter      leave a code block on a second empty Enter, split list items, split blocks
 *   Tab        indent code, move to the next table cell, nest a list item; otherwise swallowed, so Tab
 *              never moves focus out of the page while typing
 *   Mod-Enter  toggle the checkbox of the current task item, or leave a code block
 * App-level shortcuts (save, open, export, links) call into the shell through `app`.
 *
 * @param {object} app  the shell's command object (app/main.js)
 * @returns {import("prosemirror-state").Plugin[]}
 */
export function buildKeymap(app) {
  const k = {
    "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo,
    Backspace: chainCommands(undoInputRule, C.resetBlockOnBackspace),
    "Mod-b": C.toggleBold, "Mod-i": C.toggleItalic, "Mod-u": C.toggleUnderline,
    "Mod-Shift-x": C.toggleStrike, "Mod-Shift-s": C.toggleStrike, "Mod-e": C.toggleCode, "Mod-Shift-h": C.toggleHighlight,
    "Mod-,": C.toggleSub, "Mod-.": C.toggleSup,
    "Mod-Shift-e": C.insertMathInline, "Mod-Shift-m": C.insertMathBlock,
    "Mod-Alt-0": C.setParagraph,
    "Mod-Alt-1": C.setHeading(1), "Mod-Alt-2": C.setHeading(2), "Mod-Alt-3": C.setHeading(3),
    "Mod-Alt-4": C.setHeading(4), "Mod-Alt-5": C.setHeading(5), "Mod-Alt-6": C.setHeading(6),
    "Mod-Shift-7": C.toggleList(N.ordered_list), "Mod-Shift-8": C.toggleList(N.bullet_list), "Mod-Shift-9": C.toggleList(N.task_list),
    "Mod-Shift-b": C.toggleQuote, "Mod-Alt-c": C.setCodeBlock(""),
    "Mod-Enter": chainCommands(C.toggleTaskAtCursor, C.exitCode),
    "Shift-Enter": chainCommands(C.exitCode, (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView());
      return true;
    }),
    Enter: chainCommands(C.exitCodeOnDoubleEnter, newlineInCode, C.splitItem, createParagraphNear, liftEmptyBlock, splitBlock),
    Tab: chainCommands(C.codeIndent(false), goToNextCell(1), C.sinkItem, () => true),
    "Shift-Tab": chainCommands(C.codeIndent(true), goToNextCell(-1), C.liftItem, () => true),
    "Alt-ArrowUp": joinUp, "Alt-ArrowDown": joinDown, Escape: selectParentNode,
    "Mod-k": () => { app.editLink(); return true; },
    "Mod-s": () => { app.save(); return true; },
    "Mod-o": () => { app.openFiles(); return true; },
    "Mod-Shift-p": () => { app.exportAs("pdf"); return true; },
    "Mod-/": () => { app.showShortcuts(); return true; }
  };
  return [keymap(k), keymap(baseKeymap)];
}

// Shown by the keyboard shortcuts dialog (app/dialogs.js), grouped. Key names use keymap notation.
export const SHORTCUTS = [
  { group: "Text", items: [
    ["Bold", "Mod-B"], ["Italic", "Mod-I"], ["Underline", "Mod-U"], ["Strikethrough", "Mod-Shift-X"],
    ["Inline code", "Mod-E"], ["Highlight", "Mod-Shift-H"], ["Link", "Mod-K"], ["Inline equation", "Mod-Shift-E"],
    ["Subscript", "Mod-,"], ["Superscript", "Mod-."], ["Line break", "Shift-Enter"]
  ] },
  { group: "Blocks", items: [
    ["Text", "Mod-Alt-0"], ["Heading 1", "Mod-Alt-1"], ["Heading 2", "Mod-Alt-2"], ["Heading 3", "Mod-Alt-3"],
    ["Bulleted list", "Mod-Shift-8"], ["Numbered list", "Mod-Shift-7"], ["Checklist", "Mod-Shift-9"],
    ["Quote", "Mod-Shift-B"], ["Code block", "Mod-Alt-C"], ["Equation block", "Mod-Shift-M"], ["Toggle checkbox", "Mod-Enter"],
    ["Indent / outdent", "Tab / Shift-Tab"], ["Move block up / down", "Alt-ArrowUp / Alt-ArrowDown"]
  ] },
  { group: "Markdown as you type", items: [
    ["# Heading", "# Space"], ["Bulleted list", "- Space"], ["Numbered list", "1. Space"], ["Checklist", "[ ] Space"],
    ["Quote", "> Space"], ["Code block", "``` Space"], ["Equation", "$$ Space"], ["Inline equation", "$x$"], ["Divider", "---"], ["Commands", "/"]
  ] },
  { group: "File", items: [
    ["Save", "Mod-S"], ["Open", "Mod-O"], ["Export PDF", "Mod-Shift-P"], ["Undo", "Mod-Z"], ["Redo", "Mod-Shift-Z"], ["Shortcuts", "Mod-/"]
  ] }
];
