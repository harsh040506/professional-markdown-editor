/**
 * Syntax colouring for code blocks, as inline decorations carrying highlight.js classes (the colours
 * themselves are in styles/doc.css). ProseMirror owns the code block's text, so colours cannot be
 * applied by rewriting its HTML.
 *
 * Performance: highlighting is done once for the whole document when it loads, then only for the
 * code blocks an edit touched. A keystroke in a paragraph costs nothing; a keystroke in a code block
 * re-highlights that one block (and highlightCode's cache makes unchanged blocks free).
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { highlightCode } from "../../shared/highlight.js";

// Plugin key; the plugin state is the DecorationSet of colour ranges.
export const highlightKey = new PluginKey("highlight");

// Adds the colour decorations of the code block at `pos` to `out` (positions inside the block start at pos + 1).
function decorateBlock(node, pos, out) {
  const res = highlightCode(node.textContent, node.attrs.language);
  const base = pos + 1;
  for (const r of res.ranges) out.push(Decoration.inline(base + r.from, base + r.to, { class: r.cls }));
  return res;
}

// Decorations for every code block in a document. Does not descend into textblocks (they hold no blocks).
function buildAll(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "code_block") { decorateBlock(node, pos, decos); return false; }
    return node.isBlock && !node.isTextblock;
  });
  return DecorationSet.create(doc, decos);
}

export function highlightPlugin() {
  return new Plugin({
    key: highlightKey,
    state: {
      init: (_, state) => buildAll(state.doc),
      apply(tr, set, oldState, newState) {
        if (!tr.docChanged) return set;
        set = set.map(tr.mapping, tr.doc);
        // Every range the transaction changed, mapped forward through its later steps so the positions
        // refer to the new document.
        const ranges = [];
        tr.mapping.maps.forEach((map, i) => {
          map.forEach((_s, _e, from, to) => {
            const rest = tr.mapping.slice(i + 1);
            ranges.push([rest.map(from, -1), rest.map(to, 1)]);
          });
        });
        if (!ranges.length) return set;
        const doc = newState.doc;
        // Re-highlight each code block that overlaps a changed range, once per block.
        const seen = new Set();
        for (const [from, to] of ranges) {
          const a = Math.max(0, Math.min(from, doc.content.size)), b = Math.max(0, Math.min(to, doc.content.size));
          doc.nodesBetween(a, Math.max(a, b), (node, pos) => {
            if (node.type.name !== "code_block") return node.isBlock && !node.isTextblock;
            if (seen.has(pos)) return false;
            seen.add(pos);
            const old = set.find(pos + 1, pos + node.nodeSize - 1);
            set = set.remove(old);
            const add = [];
            decorateBlock(node, pos, add);
            set = set.add(doc, add);
            return false;
          });
        }
        return set;
      }
    },
    props: { decorations(state) { return highlightKey.getState(state); } }
  });
}
