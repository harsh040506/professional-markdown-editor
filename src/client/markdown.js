/**
 * Markdown <-> ProseMirror document.
 *
 * parseMarkdown() turns text into a document using the shared tokenizer (../shared/md.js), so the
 * editor sees exactly the structure the exporters render. serializeMarkdown() writes it back using
 * the conventions the source files use ("-" bullets, "|---|" tables, "---" rules, "**" bold).
 *
 * The contract both sides keep (checked by test/roundtrip.mjs):
 *   serialize(parse(serialize(parse(text)))) === serialize(parse(text))
 * i.e. after one save, saving again never changes the text, so editing a file does not drift it.
 * Text is escaped only where it would otherwise change meaning (see esc below), which is why most
 * files also come back byte-identical on their very first save.
 *
 * Used by the editor (editor/editor.js), paste handling (editor/plugins.js) and the round-trip test.
 */
import { MarkdownParser, MarkdownSerializerState, defaultMarkdownSerializer } from "prosemirror-markdown";
import { schema } from "./schema.js";
import { md } from "../shared/md.js";

// markdown-it marks the paragraphs of a tight list as hidden; the first item's paragraph decides
// whether the whole list is saved tight (no blank lines) or loose.
function listIsTight(tokens, i) {
  while (++i < tokens.length) if (tokens[i].type !== "list_item_open" && tokens[i].type !== "task_item_open") return tokens[i].hidden;
  return false;
}
// Column alignment of a table cell, from the inline style markdown-it puts on th/td.
const align = (tok) => {
  const m = /text-align:\s*(left|center|right)/.exec(tok.attrGet("style") || "");
  return { align: m ? m[1] : null };
};

// Token -> schema mapping. `block` tokens have open/close pairs, `node` tokens are single (atoms),
// `mark` tokens wrap inline content, `noCloseToken` marks tokens that carry their content directly.
// thead/tbody are ignored because the schema has no row groups (the first row is the header).
const parser = new MarkdownParser(schema, md, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "list_item" },
  task_item: { block: "task_item", getAttrs: (tok) => ({ checked: !!(tok.meta && tok.meta.checked) }) },
  bullet_list: { block: "bullet_list", getAttrs: (_, tokens, i) => ({ tight: listIsTight(tokens, i) }) },
  task_list: { block: "task_list", getAttrs: (_, tokens, i) => ({ tight: listIsTight(tokens, i) }) },
  ordered_list: {
    block: "ordered_list",
    getAttrs: (tok, tokens, i) => ({ order: +tok.attrGet("start") || 1, tight: listIsTight(tokens, i) })
  },
  heading: { block: "heading", getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
  code_block: { block: "code_block", noCloseToken: true },
  fence: { block: "code_block", getAttrs: (tok) => ({ language: (tok.info || "").trim().split(/\s+/)[0] || "" }), noCloseToken: true },
  html_raw: { block: "html_raw", noCloseToken: true },
  math_block: { node: "math_block", getAttrs: (tok) => ({ tex: tok.content, layout: (tok.meta && tok.meta.layout) || "fenced" }) },
  math_inline: { node: "math_inline", getAttrs: (tok) => ({ tex: tok.content, display: !!(tok.meta && tok.meta.display) }) },
  details: { block: "details", getAttrs: (tok) => ({ open: !!(tok.meta && tok.meta.open) }) },
  details_summary: { block: "details_summary" },
  details_body: { block: "details_content" },
  hr: { node: "horizontal_rule" },
  image: {
    node: "image",
    getAttrs: (tok) => ({
      src: tok.attrGet("src"), title: tok.attrGet("title") || null,
      alt: (tok.children && tok.children[0] && tok.children[0].content) || ""
    })
  },
  hardbreak: { node: "hard_break" },
  softbreak: { node: "soft_break" },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: align },
  td: { block: "table_cell", getAttrs: align },
  em: { mark: "em" },
  strong: { mark: "strong" },
  s: { mark: "strike" },
  underline: { mark: "underline" },
  mark: { mark: "highlight" },
  sub: { mark: "sub" },
  sup: { mark: "sup" },
  link: { mark: "link", getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }) },
  code_inline: { mark: "code", noCloseToken: true }
});

/**
 * Parses Markdown into an editor document.
 *
 * Never throws: if parsing fails (a tokenizer bug on unusual input), the text is loaded as plain
 * paragraphs split at blank lines, so the user can still see and rescue it, and the error is logged.
 * An empty input gives a document with one empty paragraph (the schema needs at least one block).
 *
 * @param {string} text  Markdown source; null/undefined are treated as ""
 * @returns {import("prosemirror-model").Node} a `doc` node of `schema`
 */
export function parseMarkdown(text) {
  try {
    const doc = parser.parse(text || "");
    if (doc && doc.childCount) return doc;
  } catch (e) {
    console.error("Markdown parse failed, loading as plain text", e);
    const paras = String(text || "").split(/\n{2,}/).map((p) => schema.node("paragraph", null, p ? [schema.text(p)] : []));
    return schema.node("doc", null, paras.length ? paras : [schema.node("paragraph")]);
  }
  return schema.node("doc", null, [schema.node("paragraph")]);
}

/* ---------- serializer ---------- */
// A code fence one backtick longer than any backtick run inside the code (min 3), so code that
// itself contains ``` is not cut short.
function fenceFor(text) {
  let n = 3;
  const runs = text.match(/`{3,}/g);
  if (runs) n = Math.max(n, ...runs.map((r) => r.length + 1));
  return "`".repeat(n);
}

// In a tight list, keep an item's blocks together; only two paragraphs in a row need a blank line.
function renderItem(state, node) {
  node.forEach((child, _, i) => {
    if (i && state.inTightList && !(child.type.name === "paragraph" && node.child(i - 1).type.name === "paragraph")) state.flushClose(1);
    state.render(child, node, i);
  });
}

// Serializer per node type. Each writes its Markdown to `state` and closes its block, which inserts
// the blank line between blocks. Behaviour worth knowing:
//   html_raw      written back verbatim (it was never interpreted)
//   math_block    in the layout it was read in ("line" falls back to fenced once the TeX has newlines)
//   details       as <details>/<summary> HTML around Markdown content, which GitHub also renders
//   ordered_list  numbers recomputed from `order`, aligned so continuation lines indent evenly
//   soft_break    kept as a newline unless the next line would then start a block (see below)
//   table         as a GFM table: header row, alignment row, body rows; | and newlines escaped
const nodes = {
  blockquote: defaultMarkdownSerializer.nodes.blockquote,
  heading: defaultMarkdownSerializer.nodes.heading,
  paragraph: defaultMarkdownSerializer.nodes.paragraph,
  text: defaultMarkdownSerializer.nodes.text,
  horizontal_rule(state, node) { state.write("---"); state.closeBlock(node); },
  code_block(state, node) {
    const fence = fenceFor(node.textContent);
    state.write(fence + (node.attrs.language || "") + "\n");
    state.text(node.textContent, false);
    state.write("\n");
    state.write(fence);
    state.closeBlock(node);
  },
  html_raw(state, node) { state.text(node.textContent, false); state.closeBlock(node); },
  math_block(state, node) {
    const tex = node.attrs.tex.trim();
    const layout = node.attrs.layout;
    if (layout === "line" && !tex.includes("\n")) state.text("$$" + tex + "$$", false);
    else if (layout === "attached") state.text("$$" + tex + "$$", false);
    else { state.write("$$\n"); state.text(tex, false); state.write("\n$$"); }
    state.closeBlock(node);
  },
  math_inline(state, node) {
    const tex = node.attrs.tex;
    state.write(node.attrs.display ? "$$" + tex.trim() + "$$" : "$" + tex.trim() + "$");
  },
  details(state, node) {
    state.write(node.attrs.open ? "<details open>" : "<details>");
    state.write("<summary>");
    state.renderInline(node.firstChild);
    state.write("</summary>");
    state.ensureNewLine();
    state.write("\n");
    state.renderContent(node.lastChild);
    state.flushClose(1);
    state.write("</details>");
    state.closeBlock(node);
  },
  details_summary(state, node) { state.renderInline(node); },
  details_content(state, node) { state.renderContent(node); },
  bullet_list(state, node) { state.renderList(node, "  ", () => "- "); },
  task_list(state, node) {
    state.renderList(node, "  ", (i) => (node.child(i).attrs.checked ? "- [x] " : "- [ ] "));
  },
  ordered_list(state, node) {
    const start = node.attrs.order || 1;
    const maxW = String(start + node.childCount - 1).length;
    const space = state.repeat(" ", maxW + 2);
    state.renderList(node, space, (i) => {
      const nStr = String(start + i) + ". ";
      return nStr + state.repeat(" ", space.length - nStr.length);
    });
  },
  list_item: renderItem,
  task_item: renderItem,
  image: defaultMarkdownSerializer.nodes.image,
  // A soft break is a newline inside a paragraph. Written as "\n" it would be re-read as the start of a
  // list, heading, quote, table or fence if the next line began with one of those markers, so in that
  // case (and inside table cells, which are one line) it is written as a space instead.
  soft_break(state, node, parent, index) {
    const next = index + 1 < parent.childCount ? parent.child(index + 1) : null;
    // a new line that would start a block (list, heading, quote...) must stay on this line
    let risky = true;
    if (next && next.type.name === "math_inline") risky = next.attrs.display;
    else if (next && next.isText) risky = next.marks.length ? false : /^\s*([-+*>#|=]|1[.)]|```|~~~|\$\$|<)/.test(next.text);
    if (risky || state.options.inTable) state.write(" ");
    else state.write("\n");
  },
  // "\" + newline, or <br> inside a table cell. Trailing hard breaks at the end of a paragraph are
  // dropped: Markdown cannot express them, and writing one would turn into a literal backslash.
  hard_break(state, node, parent, index) {
    if (state.options.inTable) { state.write("<br>"); return; }
    for (let i = index + 1; i < parent.childCount; i++) {
      if (parent.child(i).type !== node.type) { state.write("\\\n"); return; }
    }
  },
  // Alignment comes from the first row's cells; tableNormalizePlugin keeps each column consistent.
  table(state, node) {
    const rows = [];
    node.forEach((row) => {
      const cells = [];
      row.forEach((cell) => cells.push(cellMarkdown(cell)));
      rows.push(cells);
    });
    const cols = Math.max(...rows.map((r) => r.length));
    const aligns = [];
    node.firstChild.forEach((cell) => aligns.push(cell.attrs.align));
    const line = (cells) => "| " + Array.from({ length: cols }, (_, i) => cells[i] || "").join(" | ") + " |";
    const delim = "|" + Array.from({ length: cols }, (_, i) => {
      const a = aligns[i];
      return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
    }).join("|") + "|";
    const out = [line(rows[0]), delim, ...rows.slice(1).map(line)];
    state.text(out.join("\n"), false);
    state.closeBlock(node);
  }
};

// Mark delimiters. Underline, sub and sup have no Markdown syntax, so they are written as the HTML
// tags md.js maps back to marks. expelEnclosingWhitespace moves spaces outside the delimiters
// ("** bold **" is not bold in CommonMark, "**bold**" is).
const marks = {
  em: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
  strong: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
  link: defaultMarkdownSerializer.marks.link,
  underline: { open: "<u>", close: "</u>", mixable: true, expelEnclosingWhitespace: true },
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  highlight: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
  sub: { open: "<sub>", close: "</sub>", mixable: true, expelEnclosingWhitespace: true },
  sup: { open: "<sup>", close: "</sup>", mixable: true, expelEnclosingWhitespace: true },
  code: defaultMarkdownSerializer.marks.code
};

// Serializer options. inTable is added for table cells (cellMarkdown) and read by soft_break/hard_break.
const OPTIONS = { tightLists: true };

/*
 * Text escaping. Replaces prosemirror-markdown's escaping, which backslash-escapes every * _ [ etc.
 * and would litter files with "\" on their first save. Only what would otherwise change meaning on
 * re-reading is escaped:
 *   - backslashes before punctuation, backticks, ~~, ==, $ (our extensions), ![ and [ before ]( / ][ / ]:
 *   - * and _ runs that could open or close emphasis (a run with spaces on both sides, or an
 *     intra-word underscore as in snake_case, cannot, so it is left alone)
 *   - the inline HTML tags md.js would interpret, and <https:…> autolinks
 *   - at the start of a line: list, heading, quote, numbered-list, rule and table markers
 * This patches the prototype, so it applies to every MarkdownSerializerState in this bundle; this
 * module is the only user. Each rule is covered by test/fixtures/everything.md.
 */
const HTML_TAGS = /<(\/?)(u|ins|b|strong|i|em|s|del|strike|mark|sub|sup|code|kbd|br|details|summary)\b/gi;
MarkdownSerializerState.prototype.esc = function (str, startOfLine = false) {
  str = str.replace(/\\(?=[!-\/:-@\[-`{-~])/g, "\\\\");
  str = str.replace(/`/g, "\\`");
  // a run of * or _ with whitespace on both sides (or _ inside a word) can never open or close emphasis
  str = str.replace(/[*_]+/g, (run, i, all) => {
    const before = all[i - 1], after = all[i + run.length];
    const ws = (c) => c !== undefined && /\s/.test(c);
    if (ws(before) && ws(after)) return run;
    if (run[0] === "_" && before && after && /[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after)) return run;
    return run.replace(/./g, "\\$&");
  });
  str = str.replace(/~~/g, "\\~\\~");
  str = str.replace(/==/g, "\\=\\=");
  str = str.replace(/\$/g, "\\$");
  str = str.replace(/\[(?=[^\]]*\][(\[:])/g, "\\[");
  str = str.replace(/!\[/g, "!\\[");
  str = str.replace(HTML_TAGS, "\\<$1$2");
  str = str.replace(/<(?=(https?|mailto):)/gi, "\\<");
  if (startOfLine) {
    str = str.replace(/^(\+[ ]|[\-*>])/, "\\$&").replace(/^(\s*)(#{1,6})(\s|$)/, "$1\\$2$3").replace(/^(\s*\d+)([.)])(\s|$)/, "$1\\$2$3");
    str = str.replace(/^(\s*)(---+|\*\*\*+|___+)\s*$/, "$1\\$2");
    str = str.replace(/^(\s*)\|/, "$1\\|");
  }
  return str;
};

// Inline Markdown for one table cell, on one line, with "|" escaped. The pipe replace runs twice
// because the regex consumes the character before each pipe, so in "||" the second pipe is only
// seen on the second pass.
function cellMarkdown(cell) {
  const st = new MarkdownSerializerState(nodes, marks, { ...OPTIONS, inTable: true });
  st.renderInline(cell);
  return st.out.replace(/\n/g, " ").replace(/(^|[^\\])\|/g, "$1\\|").replace(/(^|[^\\])\|/g, "$1\\|").trim();
}

/**
 * Serializes an editor document to Markdown.
 *
 * Top-level blocks are rendered one by one and finished text is moved out of state.out into chunks.
 * Appending to one huge string and reading its last characters (which the serializer does all the
 * time) makes the JS engine flatten the whole string each time: seconds per save on a large file.
 * The last 8 characters stay in state.out because the serializer looks back at them to decide on
 * blank lines between blocks.
 *
 * @param {import("prosemirror-model").Node} doc
 * @returns {string} Markdown ending in exactly one newline
 * @example
 *   serializeMarkdown(parseMarkdown("# Title\n\nSome *text*"))  // "# Title\n\nSome *text*\n"
 */
export function serializeMarkdown(doc) {
  const state = new MarkdownSerializerState(nodes, marks, OPTIONS);
  const chunks = [];
  doc.forEach((child, _, i) => {
    state.render(child, doc, i);
    if (state.out.length > 2048) {
      chunks.push(state.out.slice(0, -8));
      state.out = state.out.slice(-8);
    }
  });
  chunks.push(state.out);
  return chunks.join("").replace(/\s+$/, "") + "\n";
}
