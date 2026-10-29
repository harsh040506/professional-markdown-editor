/**
 * Markdown -> HTML for the PDF and HTML exports (wrapped into a full page by page.js).
 *
 * Produces the same structure and class names the editor's node views draw (code-block, math-block,
 * details, task-item …), so one stylesheet (styles/doc.css) styles the editor and every export the same
 * way. Pure functions: they run in the browser and in Node (test/export.mjs). Math and code colours are
 * rendered here. Mermaid needs a DOM, so the caller draws the diagrams first (export/browser.js) and
 * passes the SVG in; they are placed in document order.
 *
 * Security: html_raw blocks and unknown inline HTML stay escaped (see shared/md.js), KaTeX runs with
 * trust: false, and external links get rel="noopener noreferrer".
 */
import { createMarkdown } from "../shared/md.js";
import { renderMath } from "../shared/math.js";
import { highlightCode, langLabel, normalizeLang, escapeCode } from "../shared/highlight.js";
import { icon } from "../client/ui/icons.js";

// Escapes text for HTML text and double-quoted attributes.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/**
 * Heading id for #anchor links, following GitHub's rules: lower case, punctuation removed (letters and
 * digits of any script kept), spaces to hyphens. Must stay identical to slugify in client/app/main.js.
 * Also used by docx.js for Word bookmarks.
 * @example slugify("Step 2: Install") === "step-2-install"
 */
export function slugify(s) { return s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-"); }

// A list is loose (blank lines between items, drawn with more spacing) when any of its own paragraphs is
// not hidden; nested lists are skipped. Mirrors listIsTight in client/markdown.js.
function looseList(tokens, idx) {
  let depth = 0;
  for (let i = idx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/_list_open$/.test(t.type)) depth++;
    else if (/_list_close$/.test(t.type)) { if (depth === 0) return false; depth--; }
    else if (t.type === "paragraph_open" && depth === 0 && !t.hidden) return true;
  }
  return false;
}

/**
 * Creates a renderer with the export's options.
 *
 * @param {{resolveImage?: (src: string) => string, details?: "expanded"|"collapsed"|"source",
 *          interactive?: boolean, diagrams?: ({svg: {light: string, dark?: string}}|{error: string})[]}} [options]
 *        resolveImage maps a Markdown image src to the URL used in the output (a blob: or data: URL).
 *        details: "expanded" shows section contents, "collapsed" only summaries, anything else follows
 *        each section's own `open`. interactive makes section toggles keyboard-focusable buttons (the
 *        HTML export adds the script that toggles them). diagrams: one entry per Mermaid block, in
 *        document order, as SVG markup (light and optionally dark variant) or an error message; blocks
 *        without an entry are shown as code.
 * @returns {{render(markdown: string): string, md: MarkdownIt}} render() returns the body HTML; each call
 *          starts heading ids and diagram numbering afresh, so a renderer can be reused
 */
export function createRenderer({ resolveImage = (s) => s, details = "expanded", interactive = false, diagrams = [] } = {}) {
  const md = createMarkdown();
  const r = md.renderer.rules;
  const usedSlugs = new Map();
  let diagramIndex = 0;

  // Equations: KaTeX HTML + MathML. A formula that does not parse is shown as its TeX source in red,
  // with the error as a tooltip, instead of failing the export.
  r.math_inline = (tokens, i) => {
    const t = tokens[i], display = !!(t.meta && t.meta.display);
    const out = renderMath(t.content, display);
    const inner = out.error ? `<span class="math-error" title="${esc(out.error)}">${esc(t.content)}</span>` : out.html;
    return `<span class="math-inline${display ? " is-display" : ""}">${inner}</span>`;
  };
  r.math_block = (tokens, i) => {
    const t = tokens[i];
    const out = renderMath(t.content, true);
    const inner = out.error ? `<div class="math-error">${esc(t.content)}</div>` : out.html;
    return `<div class="math-block">${inner}</div>\n`;
  };
  // Code blocks. Mermaid fences become the diagram drawn by the caller: SVG for the light theme and, in the
  // HTML export, the dark theme too (export.css shows the matching one). Blocks of up to 24 lines get
  // is-short, which export.css uses to keep them on one page in PDFs.
  const code = (tokens, i) => {
    const t = tokens[i];
    const lang = t.type === "fence" ? (t.info || "").trim().split(/\s+/)[0] : "";
    const text = t.content.replace(/\n$/, "");
    if (normalizeLang(lang) === "mermaid") {
      const d = diagrams[diagramIndex++];
      if (d && d.svg) return `<div class="diagram"><div class="d-light">${d.svg.light}</div>${d.svg.dark ? `<div class="d-dark">${d.svg.dark}</div>` : ""}</div>\n`;
      if (d && d.error) return `<div class="diagram"><div class="math-error">Diagram error: ${esc(d.error)}</div></div>\n`;
    }
    const hl = highlightCode(text, lang);
    const body = hl.html != null ? hl.html : escapeCode(text);
    const label = lang ? langLabel(lang) : "";
    const short = text.split("\n").length <= 24 ? " is-short" : "";
    return `<div class="code-block${short}" data-language="${esc(normalizeLang(lang) || hl.language || "")}">${label ? `<span class="code-label">${esc(label)}</span>` : ""}<pre><code class="hljs">${body}</code></pre></div>\n`;
  };
  r.fence = code;
  r.code_block = code;
  r.html_raw = (tokens, i) => `<pre class="html-raw"><code>${esc(tokens[i].content.replace(/\n$/, ""))}</code></pre>\n`;

  // Collapsible sections, drawn like the editor's DetailsView: arrow, summary, body.
  r.details_open = (tokens, i) => {
    const open = details === "expanded" ? true : details === "collapsed" ? false : !!(tokens[i].meta && tokens[i].meta.open);
    return `<div class="details" data-open="${open}"><span class="details-toggle"${interactive ? ' role="button" tabindex="0" aria-label="Show or hide"' : ""}>${icon("ChevronRight", 16)}</span><div class="details-inner">`;
  };
  r.details_close = () => "</div></div>\n";
  r.details_summary_open = () => '<div class="details-summary">';
  r.details_summary_close = () => "</div>";
  r.details_body_open = () => '<div class="details-content">';
  r.details_body_close = () => "</div>";

  // Lists. Checklists get the same checkbox markup as the editor (a tick icon, styled by data-checked).
  r.task_list_open = (tokens, i) => `<ul class="task-list"${looseList(tokens, i) ? " data-loose" : ""}>\n`;
  r.task_list_close = () => "</ul>\n";
  r.task_item_open = (tokens, i) => {
    const c = !!(tokens[i].meta && tokens[i].meta.checked);
    return `<li class="task-item" data-checked="${c}"><span class="task-check">${icon("Check", 14, 2.4)}</span><div class="task-body">`;
  };
  r.task_item_close = () => "</div></li>\n";
  r.bullet_list_open = (tokens, i) => `<ul${looseList(tokens, i) ? " data-loose" : ""}>\n`;
  r.ordered_list_open = (tokens, i) => {
    const start = tokens[i].attrGet("start");
    return `<ol${start && start !== "1" ? ` start="${esc(start)}"` : ""}${looseList(tokens, i) ? " data-loose" : ""}>\n`;
  };

  // Tables, wrapped for horizontal scrolling; column alignment as data-align (styled in doc.css).
  r.table_open = () => '<div class="tableWrapper"><table>\n';
  r.table_close = () => "</table></div>\n";
  const cell = (tag) => (tokens, i) => {
    const m = /text-align:\s*(left|center|right)/.exec(tokens[i].attrGet("style") || "");
    return `<${tag}${m ? ` data-align="${m[1]}"` : ""}>`;
  };
  r.th_open = cell("th");
  r.td_open = cell("td");

  r.hr = () => "<hr>\n";
  // Headings get ids for #anchor links and the PDF outline. Repeated titles get -1, -2 … like GitHub.
  r.heading_open = (tokens, i) => {
    const text = tokens[i + 1].children ? tokens[i + 1].children.filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content).join("") : tokens[i + 1].content;
    let id = slugify(text);
    const n = usedSlugs.get(id) || 0;
    usedSlugs.set(id, n + 1);
    if (n) id += "-" + n;
    return `<${tokens[i].tag} id="${esc(id)}">`;
  };
  r.mark_open = () => "<mark>";
  r.mark_close = () => "</mark>";
  r.underline_open = () => "<u>";
  r.underline_close = () => "</u>";
  r.sub_open = () => "<sub>";
  r.sub_close = () => "</sub>";
  r.sup_open = () => "<sup>";
  r.sup_close = () => "</sup>";
  // Images: src passed through resolveImage; everything else is markdown-it's default rendering.
  const defaultImage = r.image;
  r.image = (tokens, i, opts, env, self) => {
    const t = tokens[i];
    t.attrSet("src", resolveImage(t.attrGet("src")));
    return defaultImage(tokens, i, opts, env, self);
  };
  // Web links open in a new tab in the HTML export; internal and relative links are left as they are.
  const defaultLink = r.link_open || ((tokens, i, opts, env, self) => self.renderToken(tokens, i, opts));
  r.link_open = (tokens, i, opts, env, self) => {
    const href = tokens[i].attrGet("href") || "";
    if (/^https?:/i.test(href)) { tokens[i].attrSet("target", "_blank"); tokens[i].attrSet("rel", "noopener noreferrer"); }
    return defaultLink(tokens, i, opts, env, self);
  };
  return { render: (markdown) => { usedSlugs.clear(); diagramIndex = 0; return md.render(markdown); }, md };
}

/**
 * The Mermaid sources in a document, in order, so the exporters can draw the diagrams up front. Uses the
 * same tokens the renderers walk, so the numbering always agrees with theirs.
 * @param {import("markdown-it").Token[]} tokens  from createMarkdown().parse(markdown, {})
 * @returns {string[]}
 */
export function diagramSources(tokens) {
  const out = [];
  for (const t of tokens) if (t.type === "fence" && normalizeLang((t.info || "").trim().split(/\s+/)[0]) === "mermaid") out.push(t.content);
  return out;
}

/** Image sources in a document (distinct, in order), so the exporters can load them up front. */
export function imageSources(tokens) {
  const out = new Set();
  const walk = (ts) => ts.forEach((t) => { if (t.type === "image") out.add(t.attrGet("src")); if (t.children) walk(t.children); });
  walk(tokens);
  return [...out];
}
