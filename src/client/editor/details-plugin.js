/**
 * Open/closed state of collapsible sections in the editor.
 *
 * Whether a section is folded *while editing* is view state, kept as node decorations whose spec
 * carries `detailsOpen`, not in the document: folding a section therefore never marks the file as
 * changed and never enters the undo history. The node's `open` attribute (what <details open> says in
 * the file) is only the starting point when no decoration overrides it.
 *
 * Commands are sent as transaction meta on detailsKey:
 *   { toggle: pos }  flip one section     { open: pos }  open one section
 *   { all: bool }    open or close every section
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

// Plugin key: read the state with detailsKey.getState(state); send commands with tr.setMeta(detailsKey, …).
export const detailsKey = new PluginKey("details");

// Whether the section at `pos` is shown open: its override decoration if there is one, else its attribute.
function isOpen(set, node, pos) {
  const d = set.find(pos, pos + node.nodeSize, (spec) => spec.detailsOpen != null).find((x) => x.from === pos);
  return d ? d.spec.detailsOpen : node.attrs.open;
}
// Replaces the override decoration for the section at `pos` with one saying `open`.
function mark(set, doc, pos, node, open) {
  const old = set.find(pos, pos + node.nodeSize, (spec) => spec.detailsOpen != null).filter((x) => x.from === pos);
  set = set.remove(old);
  return set.add(doc, [Decoration.node(pos, pos + node.nodeSize, {}, { detailsOpen: open })]);
}

// The plugin. Decorations are mapped through every edit, so overrides follow their sections when
// text above them changes; a deleted section's override disappears with it.
export function detailsPlugin() {
  return new Plugin({
    key: detailsKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        set = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(detailsKey);
        if (!meta) return set;
        if (meta.toggle != null) {
          const node = tr.doc.nodeAt(meta.toggle);
          if (node && node.type.name === "details") set = mark(set, tr.doc, meta.toggle, node, !isOpen(set, node, meta.toggle));
        } else if (meta.open != null) {
          const node = tr.doc.nodeAt(meta.open);
          if (node && node.type.name === "details") set = mark(set, tr.doc, meta.open, node, true);
        } else if (meta.all != null) {
          const decos = [];
          tr.doc.descendants((node, pos) => {
            if (node.type.name === "details") decos.push(Decoration.node(pos, pos + node.nodeSize, {}, { detailsOpen: meta.all }));
          });
          set = DecorationSet.create(tr.doc, decos);
        }
        return set;
      }
    },
    props: { decorations: (state) => detailsKey.getState(state) }
  });
}

// Opens any collapsed section that contains the selection (each level, for nested sections), so the
// cursor is never inside hidden text, e.g. after search, undo or keyboard navigation.
export function revealSelection(view) {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === "details") {
      const pos = $from.before(d);
      const set = detailsKey.getState(view.state);
      if (!isOpen(set, n, pos)) view.dispatch(view.state.tr.setMeta(detailsKey, { open: pos }));
    }
  }
}
