/**
 * The catalogue of things a block can be turned into, or inserted. One list feeds the slash menu,
 * the toolbar's Insert menu and the selection bar's "turn into" dropdown, so all three always offer
 * the same choices with the same labels, icons and shortcuts.
 *
 * Item fields: id (stable identifier), label, icon (a name from ui/icons.js), kbd (shortcut shown,
 * keymap notation), keywords (extra words the slash menu's search matches), run (insert items only).
 */
import { schema } from "../schema.js";
import * as C from "./commands.js";

const N = schema.nodes;

// Block types an existing block can become; `id` is what commands.turnInto and blockTypeName use.
export const TURN_INTO = [
  { id: "paragraph", label: "Text", icon: "Text", kbd: "Mod-Alt-0", keywords: "paragraph plain body" },
  { id: "h1", label: "Heading 1", icon: "H1", kbd: "Mod-Alt-1", keywords: "title h1 #" },
  { id: "h2", label: "Heading 2", icon: "H2", kbd: "Mod-Alt-2", keywords: "subtitle h2 ##" },
  { id: "h3", label: "Heading 3", icon: "H3", kbd: "Mod-Alt-3", keywords: "h3 ###" },
  { id: "h4", label: "Heading 4", icon: "H4", keywords: "h4 ####" },
  { id: "bullet", label: "Bulleted list", icon: "Bullets", kbd: "Mod-Shift-8", keywords: "ul unordered - *" },
  { id: "ordered", label: "Numbered list", icon: "Numbers", kbd: "Mod-Shift-7", keywords: "ol ordered 1." },
  { id: "task", label: "Checklist", icon: "Checklist", kbd: "Mod-Shift-9", keywords: "todo task checkbox [ ]" },
  { id: "quote", label: "Quote", icon: "Quote", kbd: "Mod-Shift-B", keywords: "blockquote >" },
  { id: "code", label: "Code block", icon: "CodeBlock", kbd: "Mod-Alt-C", keywords: "pre ``` snippet" }
];

/**
 * Things that can be inserted at the cursor. A function of `app` because some items open the shell's
 * dialogs (image picker, link editor).
 * @param {object} app
 * @returns {{id: string, label: string, icon: string, kbd?: string, keywords: string, run: (view: import("prosemirror-view").EditorView) => void}[]}
 */
export function insertItems(app) {
  return [
    { id: "table", label: "Table", icon: "Table", keywords: "grid rows columns", run: (v) => C.insertTable(3, 3)(v.state, v.dispatch) },
    { id: "image", label: "Image…", icon: "Image", keywords: "picture photo png jpg", run: () => app.pickImage() },
    { id: "link", label: "Link", icon: "Link", kbd: "Mod-K", keywords: "url href", run: () => app.editLink() },
    { id: "math", label: "Equation", icon: "Math", kbd: "Mod-Shift-M", keywords: "math latex katex formula block $$", run: (v) => C.insertMathBlock(v.state, v.dispatch) },
    { id: "math-inline", label: "Inline equation", icon: "MathInline", kbd: "Mod-Shift-E", keywords: "math latex inline $", run: (v) => C.insertMathInline(v.state, v.dispatch) },
    { id: "diagram", label: "Diagram", icon: "Diagram", keywords: "mermaid flowchart chart graph sequence", run: (v) => C.insertDiagram(v.state, v.dispatch) },
    { id: "details", label: "Collapsible section", icon: "Details", keywords: "details summary toggle accordion answer", run: (v) => C.insertDetails("")(v.state, v.dispatch) },
    { id: "divider", label: "Divider", icon: "Divider", keywords: "hr rule line ---", run: (v) => C.insertHorizontalRule(v.state, v.dispatch) },
    { id: "date", label: "Today's date", icon: "Calendar", keywords: "date today time", run: (v) => {
      const d = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      v.dispatch(v.state.tr.insertText(d).scrollIntoView());
    } }
  ];
}

// A view-level runner for turning the current block into TURN_INTO item `id`.
export function turnIntoRun(id) {
  return (v) => C.turnInto(id)(v.state, v.dispatch);
}

// The TURN_INTO entry describing the block at the selection, for the selection bar's dropdown.
// Equations and headings 5-6 are not in the list but still get an accurate label.
export function blockLabel(state) {
  const name = C.blockTypeName(state);
  const hit = TURN_INTO.find((t) => t.id === name);
  if (hit) return hit;
  if (name === "math") return { id: "math", label: "Equation", icon: "Math" };
  if (/^h[5-6]$/.test(name)) return { id: name, label: "Heading " + name.slice(1), icon: "H4" };
  return TURN_INTO[0];
}

