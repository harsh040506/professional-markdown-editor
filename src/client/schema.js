/**
 * Document schema: everything Markdown (plus math, details and checklists) can express, and nothing
 * it cannot. Because every node and mark has a Markdown form, any document the editor can hold can
 * be saved without loss (client/markdown.js has the serializer for each type).
 *
 * Each type has:
 *   toDOM     how the editor draws it when no node view takes over (see editor/nodeviews.js for the
 *             code blocks, math, task items, details and images that have richer views)
 *   parseDOM  how HTML pasted from other apps or web pages maps onto it. Pasted HTML that matches
 *             none of these rules is reduced to plain paragraphs and text, which is what keeps
 *             foreign markup (scripts, styles, iframes) out of the document.
 *
 * Attributes that exist only for faithful saving: `tight` on lists (blank lines between items or
 * not), `layout` on math blocks, `display` on inline math ($$…$$ inside a paragraph).
 */
import { Schema } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

// GFM tables from prosemirror-tables. Cells hold inline content only, because a GFM table cell is a
// single line of Markdown. `align` stores the column alignment from the |:--|:-:|--:| delimiter row;
// it is set per cell, and tableNormalizePlugin (editor/ui-plugins.js) keeps a column consistent.
const tables = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => dom.style.textAlign || dom.getAttribute("data-align") || null,
      setDOMAttr: (value, attrs) => { if (value) attrs["data-align"] = value; }
    }
  }
});

export const schema = new Schema({
  nodes: {
    // The document is one or more blocks; an empty document still holds one empty paragraph.
    doc: { content: "block+" },
    paragraph: {
      content: "inline*", group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0]
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: "inline*", group: "block", defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((l) => ({ tag: "h" + l, attrs: { level: l } })),
      toDOM: (n) => ["h" + n.attrs.level, 0]
    },
    blockquote: {
      content: "block+", group: "block", defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0]
    },
    // "---". Wrapped in a div so the rule can have a larger click target than a 1px line.
    horizontal_rule: {
      group: "block",
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["div", { class: "hr-wrap" }, ["hr"]]
    },
    // Fenced code. `language` is the fence info word as written (normalised only for display).
    // "mermaid" code blocks are drawn as diagrams by CodeBlockView. No marks: code is literal.
    code_block: {
      attrs: { language: { default: "" } },
      content: "text*", marks: "", group: "block", code: true, defining: true,
      parseDOM: [{
        tag: "pre", preserveWhitespace: "full",
        getAttrs: (dom) => {
          const c = dom.querySelector("code");
          const cls = (c && c.className) || dom.className || "";
          const m = /language-([\w+#-]+)/.exec(cls);
          return { language: dom.getAttribute("data-language") || (m ? m[1] : "") };
        }
      }],
      toDOM: (n) => ["pre", { "data-language": n.attrs.language || null }, ["code", 0]]
    },
    // $$ display math $$. An atom: the TeX is an attribute, edited in a popover (openMathEditor),
    // not as document text, so the cursor never enters half-rendered math.
    math_block: {
      attrs: { tex: { default: "" }, layout: { default: "fenced" } },
      group: "block", atom: true, selectable: true, draggable: true,
      parseDOM: [{ tag: "div[data-math-block]", getAttrs: (d) => ({ tex: d.getAttribute("data-tex") || d.textContent }) }],
      toDOM: (n) => ["div", { "data-math-block": "", "data-tex": n.attrs.tex }, n.attrs.tex]
    },
    // An HTML block the editor does not understand, kept verbatim and shown as code. It is never
    // rendered as HTML, in the editor or in exports (security, and faithful saving).
    html_raw: {
      content: "text*", marks: "", group: "block", code: true, defining: true,
      parseDOM: [{ tag: "pre[data-html-raw]", preserveWhitespace: "full" }],
      toDOM: () => ["pre", { "data-html-raw": "", class: "html-raw" }, ["code", 0]]
    },
    // <details><summary>…</summary>…</details>: exactly one summary line and a body of blocks.
    // `open` is whether the section starts expanded when the file is read elsewhere; whether it is
    // collapsed *in the editor* is view state (editor/details-plugin.js), so folding never dirties a file.
    details: {
      attrs: { open: { default: true } },
      content: "details_summary details_content", group: "block", defining: true,
      parseDOM: [{ tag: "details", getAttrs: (d) => ({ open: d.hasAttribute("open") }) }],
      toDOM: (n) => ["div", { class: "details", "data-open": n.attrs.open ? "true" : "false" }, 0]
    },
    // isolating: Backspace at the start of the summary must not merge it into the block above.
    details_summary: {
      content: "inline*", defining: true, isolating: true,
      parseDOM: [{ tag: "summary" }],
      toDOM: () => ["div", { class: "details-summary" }, 0]
    },
    details_content: {
      content: "block+", defining: true,
      parseDOM: [{ tag: "div[data-details-content]" }],
      toDOM: () => ["div", { class: "details-content", "data-details-content": "" }, 0]
    },
    // Bullet lists. `tight` (no blank lines between items) is kept so saving does not reflow the list.
    // Pasted <ul data-kind="check"> belongs to task_list (getAttrs returns false to decline it).
    bullet_list: {
      attrs: { tight: { default: true } },
      content: "list_item+", group: "block",
      parseDOM: [{ tag: "ul", getAttrs: (d) => d.getAttribute("data-kind") === "check" ? false : { tight: true } }],
      toDOM: (n) => ["ul", { "data-loose": n.attrs.tight ? null : "" }, 0]
    },
    // Numbered lists. `order` is the first number ("3." starts at 3); later numbers are recomputed on save.
    ordered_list: {
      attrs: { order: { default: 1 }, tight: { default: true } },
      content: "list_item+", group: "block",
      parseDOM: [{ tag: "ol", getAttrs: (d) => ({ order: d.hasAttribute("start") ? +d.getAttribute("start") : 1 }) }],
      toDOM: (n) => ["ol", { start: n.attrs.order === 1 ? null : n.attrs.order, "data-loose": n.attrs.tight ? null : "" }, 0]
    },
    // An item starts with a paragraph (Markdown requires text after the marker) and may hold more blocks.
    list_item: {
      content: "paragraph block*", defining: true,
      parseDOM: [{ tag: "li", getAttrs: (d) => d.closest("ul[data-kind=check]") ? false : null }],
      toDOM: () => ["li", 0]
    },
    // Checklists: "- [ ] item". A separate type rather than an attribute on bullet_list, because a list
    // is either all checkboxes or none in Markdown as written by this editor.
    task_list: {
      attrs: { tight: { default: true } },
      content: "task_item+", group: "block",
      parseDOM: [{ tag: "ul[data-kind=check]", priority: 60 }],
      toDOM: (n) => ["ul", { class: "task-list", "data-kind": "check", "data-loose": n.attrs.tight ? null : "" }, 0]
    },
    // One checklist item; `checked` toggles from the checkbox in TaskItemView.
    task_item: {
      attrs: { checked: { default: false } },
      content: "paragraph block*", defining: true,
      parseDOM: [{ tag: "ul[data-kind=check] > li", priority: 60, getAttrs: (d) => ({ checked: d.getAttribute("data-checked") === "true" }) }],
      toDOM: (n) => ["li", { class: "task-item", "data-checked": n.attrs.checked ? "true" : "false" }, 0]
    },
    ...tables,
    text: { group: "inline" },
    // $inline math$ (or $$…$$ inside a paragraph when `display` is true). Not draggable, so a stray
    // drag while selecting text cannot move a formula.
    math_inline: {
      attrs: { tex: { default: "" }, display: { default: false } },
      group: "inline", inline: true, atom: true, selectable: true, draggable: false,
      parseDOM: [{ tag: "span[data-math]", getAttrs: (d) => ({ tex: d.getAttribute("data-tex") || d.textContent, display: d.hasAttribute("data-display") }) }],
      toDOM: (n) => ["span", { "data-math": "", "data-tex": n.attrs.tex, "data-display": n.attrs.display ? "" : null }, n.attrs.tex]
    },
    // ![alt](src "title"). `src` is kept exactly as written (often relative to the document); ImageView
    // turns relative paths into blob: URLs read from storage, only for display.
    image: {
      attrs: { src: {}, alt: { default: "" }, title: { default: null } },
      group: "inline", inline: true, draggable: true,
      parseDOM: [{ tag: "img[src]", getAttrs: (d) => ({ src: d.getAttribute("src"), alt: d.getAttribute("alt") || "", title: d.getAttribute("title") }) }],
      toDOM: (n) => ["img", { src: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title }]
    },
    // a line break inside a paragraph in the source: shown as a space, kept on save
    soft_break: {
      group: "inline", inline: true, selectable: false, leafText: () => " ",
      parseDOM: [{ tag: "span.sb" }],
      toDOM: () => ["span", { class: "sb" }]
    },
    // A line break that is kept as one: "\" or two trailing spaces at the end of a Markdown line, <br> in HTML.
    hard_break: {
      group: "inline", inline: true, selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"]
    }
  },
  marks: {
    // Links. Not inclusive, so typing at the end of a link does not extend it. rel=noopener noreferrer
    // keeps a page opened from a link from reaching back into the editor.
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (d) => ({ href: d.getAttribute("href"), title: d.getAttribute("title") }) }],
      toDOM: (m) => ["a", { href: m.attrs.href, title: m.attrs.title, rel: "noopener noreferrer" }, 0]
    },
    // Bold. Google Docs wraps pasted text in <b style="font-weight:normal">, which is *not* bold, hence
    // the font-weight check.
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b", getAttrs: (n) => n.style.fontWeight !== "normal" && null },
        { style: "font-weight", getAttrs: (v) => /^(bold(er)?|[6-9]\d{2,})$/.test(v) && null }],
      toDOM: () => ["strong", 0]
    },
    em: {
      parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0]
    },
    underline: {
      parseDOM: [{ tag: "u" }, { tag: "ins" }, { style: "text-decoration=underline" }],
      toDOM: () => ["u", 0]
    },
    strike: {
      parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
      toDOM: () => ["s", 0]
    },
    highlight: {
      parseDOM: [{ tag: "mark" }],
      toDOM: () => ["mark", 0]
    },
    // Sub- and superscript (<sub>, <sup>) exclude each other, as in Word.
    sub: { excludes: "sup", parseDOM: [{ tag: "sub" }], toDOM: () => ["sub", 0] },
    sup: { excludes: "sub", parseDOM: [{ tag: "sup" }], toDOM: () => ["sup", 0] },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", 0]
    }
  }
});
