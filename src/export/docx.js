/**
 * Markdown -> Word (.docx), built natively with the `docx` library rather than converted from HTML,
 * so the result is a real Word document that people can keep editing:
 *   - heading styles Heading 1-6 (navigation pane, table of contents) with keep-with-next
 *   - native numbered, bulleted and checkbox lists (Word numbering definitions, 9 levels)
 *   - native equations: TeX -> MathML (KaTeX) -> OMML (mathml2omml); TeX source if a formula fails
 *   - tables with a repeating header row, column alignment and rows that do not split across pages
 *   - syntax-coloured code (same colours as the editor's light theme), images, Mermaid diagrams as PNG
 *   - external hyperlinks, and #anchor links as internal links to heading bookmarks
 *   - page size, margins, page numbers and an optional title header from the export options
 *
 * The walk: markdown-it tokens (shared/md.js) -> blocks() for block structure -> inline() for runs.
 * Collapsible sections become a bordered one-column table: summary row, then the body when expanded.
 *
 * This file needs no DOM and no Node APIs, so it runs in the browser and in Node (test/export.mjs).
 * Everything that needs a browser is done by the caller (export/browser.js) and passed in: decoded images
 * (`images`) and Mermaid diagrams already drawn as PNG (`diagrams`).
 *
 * Licensing note: equations are converted with `mathml2omml`, which is LGPL-3.0. It is imported lazily
 * below, so it ships as its own separate file that is only downloaded when a Word file is exported,
 * and can be replaced by a different build of that library. See THIRD_PARTY_NOTICES.md.
 */
import {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink, InternalHyperlink, Bookmark, ImageRun, Table, TableRow,
  TableCell, WidthType, BorderStyle, ShadingType, AlignmentType, LevelFormat, Footer, Header, PageNumber,
  ImportedXmlComponent, TableLayoutType, VerticalAlign, LineRuleType, convertMillimetersToTwip
} from "docx";
import { createMarkdown } from "../shared/md.js";
import { mathML } from "../shared/math.js";
import { highlightCode, normalizeLang } from "../shared/highlight.js";
import { slugify } from "./render.js";

// The MathML -> Word converter, loaded on first use (see the licensing note above).
let mml2omml = null;

/* ---------- look: colours match the editor's light theme (styles/tokens.css, doc.css) ---------- */
const COLOR = {
  ink: "1F1E1D", ink2: "52514E", muted: "898781", link: "256ABF", preBg: "F5F4EF", codeBg: "EFEDE6",
  tblBorder: "E3E0D7", tblHead: "F5F3ED", quote: "DBD9D4", mark: "FCE6AE", rule: "D6D4CE", card: "FAF9F6", cardBorder: "E6E4DE"
};
// highlight.js class -> text colour for code runs.
const SYNTAX = {
  "hljs-comment": "8E9C8E", "hljs-quote": "8E9C8E", "hljs-keyword": "1E754F", "hljs-selector-tag": "1E754F", "hljs-name": "1E754F", "hljs-tag": "1E754F",
  "hljs-string": "B56959", "hljs-regexp": "B56959", "hljs-symbol": "B56959", "hljs-bullet": "B56959", "hljs-char": "B56959",
  "hljs-number": "2F798A", "hljs-literal": "2F798A", "hljs-title": "59873A", "hljs-section": "59873A",
  "hljs-attr": "998418", "hljs-attribute": "998418", "hljs-property": "998418", "hljs-meta": "998418",
  "hljs-type": "2E8F82", "hljs-built_in": "2E8F82", "hljs-variable": "B07D48", "hljs-template-variable": "B07D48", "hljs-params": "B07D48",
  "hljs-operator": "AB5959", "hljs-selector-attr": "AB5959", "hljs-selector-pseudo": "AB5959", "hljs-punctuation": "999999",
  "hljs-deletion": "B31D28", "hljs-addition": "1C6B48"
};
// Page sizes in twips (1/20 pt), margins in mm per export option, and the "Office fonts" choice: fonts
// installed with every copy of Office, so the document looks the same on any computer.
const PAGE = { A4: { w: 11906, h: 16838 }, Letter: { w: 12240, h: 15840 }, Legal: { w: 12240, h: 20160 } };
const MARGIN_MM = { narrow: { v: 14, h: 13 }, normal: { v: 20, h: 20 }, wide: { v: 26, h: 28 } };
const OFFICE = { sans: "Calibri", serif: "Georgia", mono: "Consolas" };
// The editor's own fonts, by the names Word knows when they are installed (the files are not embedded
// in the .docx; without them Word substitutes a similar font). Same families as styles/tokens.css.
const DOCUMENT = { sans: "DM Sans", serif: "Newsreader", mono: "JetBrains Mono" };

// Word measures font sizes in half-points and spacing in twips.
const PT = (pt) => Math.round(pt * 2); // half-points
const SP = (pt) => Math.round(pt * 20); // twips

// Font family per role (sans, serif, mono) for this export: the editor's fonts or the Office fonts.
const fontNames = (options) => (options.fonts === "office" ? { ...OFFICE } : { ...DOCUMENT });

/* ---------- math ---------- */
/**
 * TeX -> a Word equation element (OMML), or null when the formula cannot be converted (the caller then
 * writes the TeX as text). KaTeX's MathML is unwrapped first: its <span> wrapper and the <annotation>
 * holding the TeX source would otherwise end up inside the equation.
 */
function omml(tex, display) {
  if (!mml2omml) return null;
  const ml = mathML(tex, display);
  if (!ml) return null;
  const clean = ml.replace(/^<span class="katex">/, "").replace(/<\/span>$/, "")
    .replace(/<annotation[\s\S]*?<\/annotation>/g, "").replace(/<semantics>|<\/semantics>/g, "");
  try {
    const xml = mml2omml(clean);
    const wrapper = ImportedXmlComponent.fromXmlString(xml);
    // fromXmlString wraps the parsed XML in an unnamed element (written out as <undefined>), which
    // Word and LibreOffice reject. The real <m:oMath> element is its first child.
    return (wrapper.root && wrapper.root.find((c) => c && c.rootKey === "m:oMath")) || wrapper.root[0] || wrapper;
  } catch { return null; }
}

/* ---------- converter ---------- */
/**
 * Builds a .docx file.
 *
 * @param {object} args
 * @param {string} args.markdown
 * @param {string} args.title
 * @param {object} [args.options]  see client/app/exporter.js
 * @param {Map<string, {data: Uint8Array, type: "png"|"jpg"|"gif"|"bmp", width: number, height: number}|null>} [args.images]
 *        decoded images by the src written in the Markdown (see imageSources in render.js); a missing or
 *        null entry becomes "[Image: alt]" text. Word cannot show SVG or WebP, so the caller converts those to PNG
 * @param {({png: Uint8Array, width: number, height: number}|{error: string})[]} [args.diagrams]
 *        Mermaid diagrams as PNG, in document order (see diagramSources in render.js); a missing entry or
 *        an error falls back to the diagram's source as a code block
 * @returns {Promise<Blob>} the .docx file
 * @throws only on unexpected library errors: bad formulas, images and diagrams degrade to text
 */
export async function renderDocx({ markdown, title, options = {}, images = new Map(), diagrams = [] }) {
  if (!mml2omml) ({ mml2omml } = await import("mathml2omml"));
  const md = createMarkdown();
  const tokens = md.parse(markdown, {});
  const F = fontNames(options);
  const bodyFont = F[options.textFont === "serif" ? "serif" : options.textFont === "mono" ? "mono" : "sans"];
  const headFont = F[options.headingFont === "sans" ? "sans" : options.headingFont === "mono" ? "mono" : "serif"];
  const monoFont = F.mono;
  const bodySize = options.textFont === "mono" ? 9.75 : options.textFont === "serif" ? 11 : 10.5;
  const pageSize = PAGE[options.pageSize] || PAGE.A4;
  const mm = MARGIN_MM[options.margins] || MARGIN_MM.normal;
  const marginV = convertMillimetersToTwip(mm.v), marginH = convertMillimetersToTwip(mm.h);
  const contentWidthTw = pageSize.w - 2 * marginH;
  const contentWidthPx = Math.floor(contentWidthTw / 15); // 96 dpi
  const detailsMode = options.details || "expanded";

  // Diagrams and images arrive ready (see the parameters above) and are used in document order / by src.
  let diagramIndex = 0;
  const imageCache = images;

  // Bookmarks for headings so "#anchor" links work inside the document. Word bookmark names must be
  // short and alphanumeric, hence the numbered, sanitised names.
  const bookmarkIds = new Map();
  const used = new Map();
  function bookmarkFor(slug) {
    if (!bookmarkIds.has(slug)) bookmarkIds.set(slug, "h" + (bookmarkIds.size + 1) + "_" + slug.replace(/[^A-Za-z0-9]/g, "").slice(0, 24));
    return bookmarkIds.get(slug);
  }

  // List numbering. Word lists are numbering definitions referenced by paragraphs: one per kind (bullet,
  // checked/unchecked task, numbered per start number), 9 levels each. Numbered levels cycle 1. a. i.
  // Each list gets its own `instance`, so a new list restarts at its first number.
  const numberingConfigs = new Map();
  const bulletChars = ["•", "◦", "▪"];
  function levels(kind, start = 1) {
    return Array.from({ length: 9 }, (_, lvl) => {
      const indent = { left: 360 * (lvl + 1), hanging: 280 };
      if (kind === "bullet") return { level: lvl, format: LevelFormat.BULLET, text: bulletChars[lvl % 3], alignment: AlignmentType.LEFT, style: { paragraph: { indent }, run: { font: bodyFont, color: COLOR.ink2 } } };
      if (kind === "task-on" || kind === "task-off") return { level: lvl, format: LevelFormat.BULLET, text: kind === "task-on" ? "☑" : "☐", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (lvl + 1), hanging: 300 } }, run: { font: "Segoe UI Symbol", color: kind === "task-on" ? "2A78D6" : COLOR.muted } } };
      const fmt = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][lvl % 3];
      return { level: lvl, format: fmt, text: `%${lvl + 1}.`, start: lvl === 0 ? start : 1, alignment: AlignmentType.LEFT, style: { paragraph: { indent }, run: { color: COLOR.ink2 } } };
    });
  }
  function numberingRef(kind, start = 1) {
    const ref = kind === "ordered" && start !== 1 ? "ordered-" + start : kind;
    if (!numberingConfigs.has(ref)) numberingConfigs.set(ref, { reference: ref, levels: levels(kind, start) });
    return ref;
  }
  let listInstance = 0;

  /* ----- inline: tokens -> TextRun/ImageRun/hyperlink children; nested marks are counters ----- */
  function inline(children, base = {}) {
    const out = [];
    const st = { bold: 0, italics: 0, strike: 0, underline: 0, mark: 0, sub: 0, sup: 0 };
    let link = null;
    const push = (run) => { if (link) link.runs.push(run); else out.push(run); };
    const textRun = (text, extra = {}) => new TextRun({
      text,
      bold: base.bold || st.bold > 0 || undefined,
      italics: base.italics || st.italics > 0 || undefined,
      strike: base.strike || st.strike > 0 || undefined,
      underline: st.underline > 0 ? {} : undefined,
      shading: st.mark > 0 ? { type: ShadingType.CLEAR, fill: COLOR.mark, color: "auto" } : undefined,
      subScript: st.sub > 0 || undefined,
      superScript: st.sup > 0 || undefined,
      color: link ? COLOR.link : base.color,
      font: base.font, size: base.size,
      ...extra
    });
    for (const t of children || []) {
      switch (t.type) {
        case "text": if (t.content) push(textRun(t.content)); break;
        case "softbreak": push(textRun(" ")); break;
        case "hardbreak": push(new TextRun({ break: 1 })); break;
        case "strong_open": st.bold++; break; case "strong_close": st.bold--; break;
        case "em_open": st.italics++; break; case "em_close": st.italics--; break;
        case "s_open": st.strike++; break; case "s_close": st.strike--; break;
        case "underline_open": st.underline++; break; case "underline_close": st.underline--; break;
        case "mark_open": st.mark++; break; case "mark_close": st.mark--; break;
        case "sub_open": st.sub++; break; case "sub_close": st.sub--; break;
        case "sup_open": st.sup++; break; case "sup_close": st.sup--; break;
        case "code_inline":
          push(textRun(t.content, { font: monoFont, size: PT((base.sizePt || bodySize) - 1), shading: { type: ShadingType.CLEAR, fill: COLOR.codeBg, color: "auto" } }));
          break;
        case "math_inline": {
          const m = omml(t.content, !!(t.meta && t.meta.display));
          push(m || textRun(t.content, { font: monoFont }));
          break;
        }
        case "image": {
          const img = imageCache.get(t.attrGet("src"));
          const alt = (t.children && t.children[0] && t.children[0].content) || "";
          if (!img) { push(textRun("[Image" + (alt ? ": " + alt : "") + "]", { color: COLOR.muted })); break; }
          const maxW = Math.min(contentWidthPx - (base.indentPx || 0), img.width);
          const w = maxW, h = Math.round(img.height * (w / img.width));
          push(new ImageRun({ type: img.type, data: img.data, transformation: { width: w, height: h }, altText: { name: alt || "image", description: alt, title: alt } }));
          break;
        }
        case "link_open": link = { href: t.attrGet("href") || "", runs: [] }; break;
        case "link_close": {
          if (!link) break;
          const l = link; link = null;
          if (l.href.startsWith("#")) out.push(new InternalHyperlink({ anchor: bookmarkFor(decodeURIComponent(l.href.slice(1)).toLowerCase()), children: l.runs }));
          else out.push(new ExternalHyperlink({ link: l.href, children: l.runs }));
          break;
        }
        default: if (t.content) push(textRun(t.content));
      }
    }
    if (link) out.push(...link.runs);
    return out;
  }

  /* ----- block helpers. ctx carries the indent (twips), quote depth and list level of the current block ----- */
  const para = (children, opts = {}) => new Paragraph({ children, ...opts });
  function quoteProps(ctx) {
    if (!ctx.quote) return {};
    return { border: { left: { style: BorderStyle.SINGLE, size: 18, color: COLOR.quote, space: 9 } } };
  }
  function indentFor(ctx, extra = 0) {
    const left = (ctx.indent || 0) + extra;
    return left ? { left } : undefined;
  }

  // A code block as shaded, monospace paragraphs, one per line, with syntax-coloured runs.
  function codeParagraphs(text, lang, ctx) {
    const res = highlightCode(text, lang);
    const lines = text.split("\n");
    // ranges -> per-line coloured segments
    const colorAt = new Array(text.length).fill(null);
    const italicAt = new Array(text.length).fill(false);
    for (const r of res.ranges) {
      const cls = r.cls.split(/\s+/);
      const c = cls.map((x) => SYNTAX[x]).find(Boolean);
      for (let k = r.from; k < r.to; k++) { if (c) colorAt[k] = c; if (cls.includes("hljs-comment")) italicAt[k] = true; }
    }
    const box = { style: BorderStyle.SINGLE, size: 1, color: COLOR.preBg, space: 6 };
    const out = [];
    let offset = 0;
    lines.forEach((line, li) => {
      const runs = [];
      let k = 0;
      while (k < line.length) {
        const c = colorAt[offset + k], it = italicAt[offset + k];
        let e = k + 1;
        while (e < line.length && colorAt[offset + e] === c && italicAt[offset + e] === it) e++;
        runs.push(new TextRun({ text: line.slice(k, e), font: monoFont, size: PT(8.75), color: c || "393A34", italics: it || undefined }));
        k = e;
      }
      if (!runs.length) runs.push(new TextRun({ text: "", font: monoFont, size: PT(8.75) }));
      out.push(para(runs, {
        shading: { type: ShadingType.CLEAR, fill: COLOR.preBg, color: "auto" },
        border: { top: box, bottom: box, left: { ...box, space: 8 }, right: { ...box, space: 8 } },
        spacing: { before: li === 0 ? SP(6) : 0, after: li === lines.length - 1 ? SP(8) : 0, line: 276, lineRule: LineRuleType.AUTO },
        indent: { left: (ctx.indent || 0) + 170, right: 170 },
        keepLines: true, keepNext: lines.length <= 24 && li < lines.length - 1
      }));
      offset += line.length + 1;
    });
    return out;
  }

  // A GFM table. Returns the table and the index of its table_close token.
  function tableBlock(tokens, i, ctx) {
    // tokens[i] = table_open
    const rows = [];
    let row = null, isHead = false;
    for (i++; i < tokens.length && tokens[i].type !== "table_close"; i++) {
      const t = tokens[i];
      if (t.type === "thead_open") isHead = true;
      else if (t.type === "thead_close") isHead = false;
      else if (t.type === "tr_open") row = { head: isHead, cells: [] };
      else if (t.type === "tr_close") { rows.push(row); row = null; }
      else if (t.type === "th_open" || t.type === "td_open") {
        const m = /text-align:\s*(left|center|right)/.exec(t.attrGet("style") || "");
        const inl = tokens[i + 1];
        row.cells.push({ align: m ? m[1] : null, children: inl.children, head: t.type === "th_open" });
        i += 2;
      }
    }
    const cols = Math.max(1, ...rows.map((r) => r.cells.length));
    const border = { style: BorderStyle.SINGLE, size: 6, color: COLOR.tblBorder };
    const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
    const table = new Table({
      rows: rows.map((r) => new TableRow({
        tableHeader: r.head, cantSplit: true,
        children: Array.from({ length: cols }, (_, c) => {
          const cell = r.cells[c] || { children: [], align: null };
          return new TableCell({
            shading: r.head ? { type: ShadingType.CLEAR, fill: COLOR.tblHead, color: "auto" } : undefined,
            margins: { top: 70, bottom: 70, left: 110, right: 110 },
            verticalAlign: VerticalAlign.TOP,
            children: [para(inline(cell.children, { bold: r.head || undefined, size: PT(9.25), sizePt: 9.25 }), {
              alignment: cell.align === "center" ? AlignmentType.CENTER : cell.align === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT,
              spacing: { before: 0, after: 0, line: 264, lineRule: LineRuleType.AUTO }
            })]
          });
        })
      })),
      borders,
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.AUTOFIT,
      indent: ctx.indent ? { size: ctx.indent, type: WidthType.DXA } : undefined
    });
    return { nodes: [table, para([], { spacing: { before: 0, after: SP(4) } })], i };
  }

  // Converts block tokens from index i until the token type `closer` (or the end). Recursive for
  // quotes, list items and section bodies. Returns { nodes, i } where i is the index of the closer.
  function blocks(tokens, i, closer, ctx) {
    const nodes = [];
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (closer && t.type === closer) break;
      switch (t.type) {
        case "heading_open": {
          const level = +t.tag.slice(1);
          const inl = tokens[i + 1];
          const text = (inl.children || []).filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content).join("");
          let slug = slugify(text);
          const n = used.get(slug) || 0; used.set(slug, n + 1);
          if (n) slug += "-" + n;
          const runs = inline(inl.children);
          nodes.push(para([new Bookmark({ id: bookmarkFor(slug), children: runs })], { style: "Heading" + level, indent: indentFor(ctx), ...quoteProps(ctx) }));
          i += 2;
          break;
        }
        case "paragraph_open": {
          const inl = tokens[i + 1];
          const opts = { indent: indentFor(ctx), ...quoteProps(ctx) };
          let base = {};
          if (ctx.item && !ctx.item.numbered) {
            ctx.item.numbered = true;
            opts.numbering = { reference: ctx.item.ref, level: ctx.item.level, instance: ctx.item.instance };
            delete opts.indent;
            if (ctx.quote) opts.indent = { left: ctx.indent - 360 * (ctx.item.level + 1) + 360 * (ctx.item.level + 1) };
            if (ctx.item.checked) base = { strike: true, color: COLOR.ink2 };
          }
          if (ctx.item) opts.spacing = { before: 0, after: ctx.item.tight ? SP(2) : SP(6) };
          // a paragraph that is only an image stays on its own
          nodes.push(para(inline(inl.children, { ...base, indentPx: Math.round((ctx.indent || 0) / 15) }), opts));
          i += 2;
          break;
        }
        case "bullet_list_open": case "ordered_list_open": case "task_list_open": {
          const kind = t.type === "bullet_list_open" ? "bullet" : t.type === "ordered_list_open" ? "ordered" : "task";
          const start = kind === "ordered" ? +(t.attrGet("start") || 1) : 1;
          const level = ctx.listLevel || 0;
          const instance = ++listInstance;
          const closeType = t.type.replace("_open", "_close");
          // tight lists hide their paragraphs
          let tight = true;
          for (let k = i + 1; k < tokens.length && tokens[k].type !== closeType; k++) if (tokens[k].type === "paragraph_open" && tokens[k].level === t.level + 2 && !tokens[k].hidden) { tight = false; break; }
          i++;
          while (i < tokens.length && tokens[i].type !== closeType) {
            const it = tokens[i];
            if (it.type === "list_item_open" || it.type === "task_item_open") {
              const checked = !!(it.meta && it.meta.checked);
              const ref = kind === "task" ? numberingRef(checked ? "task-on" : "task-off") : numberingRef(kind, start);
              const item = { ref, level, instance, numbered: false, checked: kind === "task" && checked, tight };
              const r = blocks(tokens, i + 1, it.type === "list_item_open" ? "list_item_close" : "task_item_close",
                { ...ctx, item, listLevel: level + 1, indent: (ctx.baseIndent || 0) + 360 * (level + 1), baseIndent: ctx.baseIndent || 0 });
              if (!item.numbered) nodes.push(para([], { numbering: { reference: ref, level, instance } }));
              nodes.push(...r.nodes);
              i = r.i + 1;
            } else i++;
          }
          if (!ctx.item) nodes.push(para([], { spacing: { before: 0, after: SP(2) } }));
          break;
        }
        case "blockquote_open": {
          const r = blocks(tokens, i + 1, "blockquote_close", { ...ctx, quote: (ctx.quote || 0) + 1, indent: (ctx.indent || 0) + 200, baseIndent: (ctx.indent || 0) + 200, item: ctx.item && ctx.item.numbered ? null : ctx.item });
          nodes.push(...r.nodes);
          i = r.i;
          break;
        }
        case "fence": case "code_block": {
          const lang = t.type === "fence" ? (t.info || "").trim().split(/\s+/)[0] : "";
          if (ctx.item && !ctx.item.numbered) { ctx.item.numbered = true; nodes.push(para([], { numbering: { reference: ctx.item.ref, level: ctx.item.level, instance: ctx.item.instance } })); }
          if (normalizeLang(lang) === "mermaid") {
            const d = diagrams[diagramIndex++];
            if (d && d.png) {
              const w = Math.min(contentWidthPx - Math.round((ctx.indent || 0) / 15), Math.round(d.width));
              const hgt = Math.round(d.height * (w / d.width));
              nodes.push(para([new ImageRun({ type: "png", data: d.png, transformation: { width: w, height: hgt }, altText: { name: "diagram", description: "Diagram", title: "Diagram" } })], { alignment: AlignmentType.CENTER, spacing: { before: SP(6), after: SP(8) }, indent: indentFor(ctx) }));
              break;
            }
          }
          nodes.push(...codeParagraphs(t.content.replace(/\n$/, ""), lang, ctx));
          break;
        }
        case "math_block": {
          if (ctx.item && !ctx.item.numbered) { ctx.item.numbered = true; nodes.push(para([], { numbering: { reference: ctx.item.ref, level: ctx.item.level, instance: ctx.item.instance } })); }
          const m = omml(t.content, true);
          nodes.push(para(m ? [m] : [new TextRun({ text: t.content, font: monoFont })], { alignment: AlignmentType.CENTER, spacing: { before: SP(6), after: SP(8) }, indent: indentFor(ctx), ...quoteProps(ctx), keepLines: true }));
          break;
        }
        case "table_open": {
          const r = tableBlock(tokens, i, ctx);
          nodes.push(...r.nodes);
          i = r.i;
          break;
        }
        case "hr":
          nodes.push(para([], { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.rule, space: 1 } }, spacing: { before: SP(8), after: SP(14) }, indent: indentFor(ctx) }));
          break;
        case "html_raw":
          nodes.push(...codeParagraphs(t.content.replace(/\n$/, ""), "xml", ctx));
          break;
        case "details_open": {
          const open = detailsMode === "expanded" ? true : detailsMode === "collapsed" ? false : !!(t.meta && t.meta.open);
          // summary
          let j = i + 1, summary = [];
          if (tokens[j] && tokens[j].type === "details_summary_open") { summary = tokens[j + 1].children || []; j += 3; }
          // body
          let body = { nodes: [], i: j };
          if (tokens[j] && tokens[j].type === "details_body_open") body = blocks(tokens, j + 1, "details_body_close", { quote: 0, indent: 0, listLevel: 0 });
          let k = body.i + 1;
          while (k < tokens.length && tokens[k].type !== "details_close") k++;
          i = k;
          const border = { style: BorderStyle.SINGLE, size: 6, color: COLOR.cardBorder };
          const summaryPara = para([new TextRun({ text: open ? "▾  " : "▸  ", color: COLOR.muted }), ...inline(summary, { bold: true })], { spacing: { before: 0, after: 0 }, keepNext: open });
          const rows = [new TableRow({ cantSplit: true, children: [new TableCell({ shading: { type: ShadingType.CLEAR, fill: COLOR.card, color: "auto" }, margins: { top: 100, bottom: 100, left: 160, right: 160 }, children: [summaryPara] })] })];
          if (open && body.nodes.length) rows.push(new TableRow({ children: [new TableCell({ margins: { top: 60, bottom: 80, left: 380, right: 160 }, children: body.nodes })] }));
          nodes.push(new Table({ rows, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }, width: { size: 100, type: WidthType.PERCENTAGE }, indent: ctx.indent ? { size: ctx.indent, type: WidthType.DXA } : undefined }));
          nodes.push(para([], { spacing: { before: 0, after: SP(4) } }));
          break;
        }
        default: break;
      }
    }
    return { nodes, i };
  }

  const body = blocks(tokens, 0, null, { indent: 0, quote: 0, listLevel: 0 }).nodes;
  if (!body.length) body.push(para([]));

  // Page numbers ("3 / 12") in the footer, and the title in the header, both small and grey.
  const footer = options.pageNumbers !== false ? new Footer({
    children: [para([new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], size: PT(8), color: COLOR.muted, font: F.sans })], { alignment: AlignmentType.RIGHT })]
  }) : undefined;
  const header = options.titleHeader ? new Header({
    children: [para([new TextRun({ text: title || "", size: PT(8), color: COLOR.muted, font: F.sans })], { alignment: AlignmentType.LEFT })]
  }) : undefined;

  // Heading paragraph styles. outlineLevel puts them in Word's navigation pane and table of contents.
  const hStyle = (id, name, sizePt, { font = headFont, bold = false, color = COLOR.ink, before = 0, after = 6 } = {}) => ({
    id, name, basedOn: "Normal", next: "Normal", quickFormat: true,
    run: { font, size: PT(sizePt), bold, color },
    paragraph: { spacing: { before: SP(before), after: SP(after), line: 264, lineRule: LineRuleType.AUTO }, keepNext: true, keepLines: true, outlineLevel: +id.slice(-1) - 1 }
  });
  const headingBold = options.headingFont === "sans";
  const doc = new Document({
    creator: "Markdown Editor", title: title || "Document", description: "Exported from Markdown",
    features: { updateFields: false },
    styles: {
      default: {
        document: { run: { font: bodyFont, size: PT(bodySize), color: COLOR.ink }, paragraph: { spacing: { after: SP(6), line: 324, lineRule: LineRuleType.AUTO } } },
        hyperlink: { run: { color: COLOR.link, underline: { type: "none" } } }
      },
      paragraphStyles: [
        hStyle("Heading1", "Heading 1", 22, { bold: headingBold, after: 8 }),
        hStyle("Heading2", "Heading 2", 15, { bold: headingBold, before: 18, after: 6 }),
        hStyle("Heading3", "Heading 3", 12.5, { bold: headingBold, before: 14, after: 4 }),
        hStyle("Heading4", "Heading 4", 10.5, { font: bodyFont, bold: true, before: 12, after: 3 }),
        hStyle("Heading5", "Heading 5", 9.5, { font: bodyFont, bold: true, before: 10, after: 2 }),
        hStyle("Heading6", "Heading 6", 9.5, { font: bodyFont, color: COLOR.ink2, before: 10, after: 2 })
      ]
    },
    numbering: { config: [...numberingConfigs.values()].length ? [...numberingConfigs.values()] : [{ reference: "bullet", levels: levels("bullet") }] },
    sections: [{
      properties: {
        page: {
          size: { width: pageSize.w, height: pageSize.h },
          margin: { top: marginV, bottom: marginV, left: marginH, right: marginH, header: convertMillimetersToTwip(8), footer: convertMillimetersToTwip(8) }
        }
      },
      headers: header ? { default: header } : undefined,
      footers: footer ? { default: footer } : undefined,
      children: body
    }]
  });
  return Packer.toBlob(doc);
}
