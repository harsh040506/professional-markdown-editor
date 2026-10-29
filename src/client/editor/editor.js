/**
 * Builds the ProseMirror editor: the state (document + plugins) and the view (DOM, node views,
 * transaction handling).
 *
 * The app shell (app/main.js) creates one view for the page's lifetime and swaps documents by
 * replacing its state (createState), so plugins and node views are rebuilt per document while the
 * view and its event listeners stay. `app` is the shell's command object; plugins call back into it
 * (app.save, app.editLink, app.pickImage …) instead of importing the shell, which avoids an import
 * cycle between the editor and the UI.
 */
import { EditorState, NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing, TableView, fixTables } from "prosemirror-tables";
import { schema } from "../schema.js";
import { parseMarkdown, serializeMarkdown } from "../markdown.js";
import { buildInputRules, buildKeymap } from "./keys.js";
import { highlightPlugin } from "./highlight-plugin.js";
import { detailsPlugin, revealSelection } from "./details-plugin.js";
import { placeholderPlugin, trailingParagraphPlugin, clipboardPlugin } from "./plugins.js";
import { slashPlugin, selectionBarPlugin, linkBarPlugin, tableControlsPlugin, tableNormalizePlugin } from "./ui-plugins.js";
import { nodeViews, openMathEditor } from "./nodeviews.js";

/**
 * Creates an editor state for a Markdown text.
 *
 * Plugin order matters: plugins earlier in the list see key presses first, so the slash menu (when
 * open) takes Enter/arrow keys before input rules and the keymap. The history plugin groups typing
 * that happens within 600 ms into one undo step and keeps 500 steps.
 *
 * fixTables repairs tables whose rows have different numbers of cells (common in hand-written
 * Markdown). The repair is applied outside the undo history, so the first Undo does not "unfix" it.
 *
 * @param {string} markdown
 * @param {object} app  the shell's command object (see app/main.js)
 * @returns {import("prosemirror-state").EditorState}
 */
export function createState(markdown, app) {
  let doc = parseMarkdown(markdown);
  const plugins = [
    slashPlugin(app),
    buildInputRules(),
    ...buildKeymap(app),
    history({ depth: 500, newGroupDelay: 600 }),
    dropCursor({ color: "var(--accent)", width: 2 }),
    gapCursor(),
    tableEditing({ allowTableNodeSelection: true }),
    highlightPlugin(),
    detailsPlugin(),
    placeholderPlugin(),
    trailingParagraphPlugin(),
    clipboardPlugin(),
    selectionBarPlugin(app),
    linkBarPlugin(app),
    tableControlsPlugin(),
    tableNormalizePlugin()
  ];
  let state = EditorState.create({ doc, plugins });
  const fix = fixTables(state);
  if (fix) state = state.apply(fix.setMeta("addToHistory", false));
  return state;
}

/**
 * Creates the editor view inside `mount`.
 *
 * dispatchTransaction is the single place every change passes through. After applying a
 * transaction it notifies the shell (app.onDocChange for the dirty flag, draft, word count and undo
 * buttons; app.onSelectionChange), opens the TeX editor for a newly inserted empty equation, and
 * expands collapsed sections that the selection moved into (revealSelection), except when the
 * selection came from a mouse click (meta "pointer"), where expanding would move the clicked text.
 *
 * Tables use prosemirror-tables' TableView with a 48px minimum column width.
 *
 * @param {HTMLElement} mount
 * @param {string} markdown  initial document
 * @param {object} app
 * @returns {import("prosemirror-view").EditorView}
 */
export function createEditor(mount, markdown, app) {
  const view = new EditorView(mount, {
    state: createState(markdown, app),
    nodeViews: { ...nodeViews, table: (node) => new TableView(node, 48) },
    attributes: { class: "doc-body", spellcheck: "true", "aria-label": "Document", role: "textbox", "aria-multiline": "true" },
    dispatchTransaction(tr) {
      const state = view.state.apply(tr);
      view.updateState(state);
      if (tr.docChanged) app.onDocChange(tr);
      if (tr.selectionSet || tr.docChanged) app.onSelectionChange(state);
      // a fresh, empty equation opens its editor straight away
      const sel = state.selection;
      if (sel instanceof NodeSelection && (tr.docChanged || tr.getMeta("openMathBlock") != null)) {
        if (sel.node.type === schema.nodes.math_inline && !sel.node.attrs.tex) {
          requestAnimationFrame(() => openMathEditor(view, sel.from, { isNew: true, anchor: view.nodeDOM(sel.from) }));
        } else if (sel.node.type === schema.nodes.math_block && !sel.node.attrs.tex) {
          requestAnimationFrame(() => { const d = view.nodeDOM(sel.from); const v = d && d.pmViewDesc; if (v && v.spec && v.spec.open) v.spec.open(); else d && d.querySelector(".math-render")?.click(); });
        }
      }
      if (tr.selectionSet && !tr.getMeta("pointer")) revealSelection(view);
    },
    handleKeyDown(view, e) {
      // Enter on a selected equation opens its editor
      const sel = view.state.selection;
      if (e.key === "Enter" && sel instanceof NodeSelection) {
        if (sel.node.type === schema.nodes.math_inline) { openMathEditor(view, sel.from, { anchor: view.nodeDOM(sel.from) }); return true; }
        if (sel.node.type === schema.nodes.math_block) { view.nodeDOM(sel.from)?.querySelector(".math-render")?.click(); return true; }
      }
      return false;
    }
  });
  return view;
}

// The open document as Markdown: what Save writes and what exports receive.
export function getMarkdown(view) { return serializeMarkdown(view.state.doc); }
export { parseMarkdown, serializeMarkdown };
