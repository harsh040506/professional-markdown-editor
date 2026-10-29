/**
 * Small behaviour plugins: placeholder text in empty blocks, a guaranteed trailing paragraph, and a
 * Markdown-aware clipboard (copy gives Markdown as plain text; pasting Markdown text gives formatting).
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Slice } from "prosemirror-model";
import { schema } from "../schema.js";
import { parseMarkdown, serializeMarkdown } from "../markdown.js";

const N = schema.nodes;

/* ---------- placeholders ---------- */
/**
 * Grey hint text in empty blocks, drawn by CSS from data-placeholder (doc.css). An empty document
 * shows the long hint; otherwise only the empty block holding the cursor gets one, so a page with
 * many blank lines is not covered in hints. Decorations only: nothing is added to the document.
 */
export function placeholderPlugin() {
  return new Plugin({
    props: {
      decorations(state) {
        const decos = [];
        const doc = state.doc;
        if (doc.childCount === 1 && doc.firstChild.isTextblock && doc.firstChild.content.size === 0) {
          decos.push(Decoration.node(0, doc.firstChild.nodeSize, { class: "is-empty", "data-placeholder": "Start writing, or type / for commands" }));
          return DecorationSet.create(doc, decos);
        }
        const { $from, empty } = state.selection;
        if (!empty) return null;
        const p = $from.parent;
        if (p.content.size !== 0) return null;
        const before = $from.before();
        if (p.type === N.paragraph && $from.depth <= 1) decos.push(Decoration.node(before, before + p.nodeSize, { class: "is-empty", "data-placeholder": "Type / for commands" }));
        else if (p.type === N.heading) decos.push(Decoration.node(before, before + p.nodeSize, { class: "is-empty", "data-placeholder": "Heading " + p.attrs.level }));
        else if (p.type === N.details_summary) decos.push(Decoration.node(before, before + p.nodeSize, { class: "is-empty", "data-placeholder": "Summary" }));
        else if (p.type === N.paragraph && $from.node($from.depth - 1).type === N.details_content) decos.push(Decoration.node(before, before + p.nodeSize, { class: "is-empty", "data-placeholder": "Hidden content" }));
        return decos.length ? DecorationSet.create(doc, decos) : null;
      }
    }
  });
}

/* ---------- always leave somewhere to type after a table, code block or equation at the end ---------- */
// After any change, makes sure the document ends with a paragraph. Without it the cursor could not get
// below a table, code block or equation at the end. Kept out of the undo history, so Undo never
// removes and re-adds it.
export function trailingParagraphPlugin() {
  return new Plugin({
    appendTransaction(trs, oldState, state) {
      if (!trs.some((t) => t.docChanged)) return null;
      const last = state.doc.lastChild;
      if (last && last.type === N.paragraph) return null;
      return state.tr.insert(state.doc.content.size, N.paragraph.create()).setMeta("addToHistory", false);
    }
  });
}

/* ---------- clipboard: copy writes Markdown as plain text; pasting Markdown text parses it ---------- */
/**
 * Heuristic: does pasted plain text contain Markdown syntax worth parsing (headings, list markers,
 * quotes, fences, tables, **bold**, `code`, [links](…), $math$, <details>)? Plain prose pastes as
 * typed text, so a sentence with an asterisk is not reinterpreted.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeMarkdown(text) {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\$\$|\|.*\|)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\$[^$\s][^$]*\$|<details/.test(text);
}
/**
 * Clipboard integration:
 *   copy                 plain-text flavour = the selection as Markdown (so pasting into a text
 *                        editor, chat or issue tracker keeps the formatting); HTML flavour unchanged
 *   paste plain text     parsed as Markdown when it looks like Markdown and the cursor is not in code;
 *                        a single paragraph is pasted inline into the current paragraph
 *   paste from VS Code   VS Code puts styled HTML of the *source* on the clipboard; the plain Markdown
 *                        text is used instead, otherwise a .md file would paste as a code block
 *   paste HTML           <style>/<script> elements are dropped first; the schema's parseDOM rules
 *                        then discard any other markup they do not know
 */
export function clipboardPlugin() {
  return new Plugin({
    key: new PluginKey("clipboard"),
    props: {
      clipboardTextSerializer(slice) {
        try {
          const doc = schema.topNodeType.createAndFill(null, slice.content.firstChild && slice.content.firstChild.isInline ? N.paragraph.create(null, slice.content) : slice.content);
          if (doc) return serializeMarkdown(doc).replace(/\n$/, "");
        } catch { /* fall back */ }
        return slice.content.textBetween(0, slice.content.size, "\n\n");
      },
      clipboardTextParser(text, $context, plain) {
        if ($context.parent.type.spec.code || plain) return null;
        if (!looksLikeMarkdown(text)) return null;
        const doc = parseMarkdown(text.replace(/\r\n?/g, "\n"));
        // a single paragraph pastes inline
        if (doc.childCount === 1 && doc.firstChild.type === N.paragraph) return new Slice(doc.firstChild.content, 0, 0);
        return new Slice(doc.content, 0, 0);
      },
      handlePaste(view, event) {
        const text = event.clipboardData && event.clipboardData.getData("text/plain");
        const html = event.clipboardData && event.clipboardData.getData("text/html");
        // VS Code and similar put Markdown in text and a code-styled copy in html: prefer the Markdown
        if (text && html && /vscode|monaco/i.test(html) && looksLikeMarkdown(text) && !view.state.selection.$from.parent.type.spec.code) {
          const doc = parseMarkdown(text);
          view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 0, 0)).scrollIntoView());
          return true;
        }
        return false;
      },
      transformPastedHTML(html) {
        // drop styling that would sneak in from web pages
        return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "");
      }
    }
  });
}

