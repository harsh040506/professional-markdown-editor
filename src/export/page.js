/**
 * Builds the full HTML page used for printing to PDF and for the standalone HTML export.
 *
 * The page = fonts + KaTeX CSS + the editor's own document styles (tokens.css, doc.css, export.css) +
 * the rendered body (render.js). Two modes:
 *   "pdf"   shown in a hidden frame and printed by the browser (export/browser.js → print.js). Light theme
 *           is forced because paper is white; page size, margins, page numbers and the title header are CSS
 *           @page rules, which Chrome, Edge and Safari honour (Firefox ignores the page-number boxes)
 *   "html"  one self-contained file: fonts and KaTeX fonts inlined, images embedded, theme follows the
 *           reader's system setting, collapsible sections are clickable
 *
 * Pure function: stylesheets, fonts and diagrams are handed in as strings by export/browser.js (which
 * fetches them) or by test/export.mjs (which reads them from disk), so this file needs no DOM.
 */
import { createRenderer } from "./render.js";

// Escapes text for HTML text and double-quoted attributes.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Escapes text for a CSS string literal. "<" is written as an escape so a title can never close the <style> element.
const cssStr = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\3C ").replace(/[\r\n]+/g, " ") + '"';

// Page sizes accepted by @page, and margins (top/bottom, left/right in mm) per export option.
const PAGE_SIZE = { A4: "A4", Letter: "letter", Legal: "legal" };
const MARGINS = { narrow: [14, 13], normal: [20, 20], wide: [26, 28] };

/**
 * The @page rules for a PDF. Page numbers ("3 / 12") and the title header are page margin boxes, so the
 * bottom/top margin is raised to leave them room.
 */
export function pageCss(options, title) {
  const [v, hz] = MARGINS[options.margins] || MARGINS.normal;
  const numbers = options.pageNumbers !== false, header = !!options.titleHeader;
  const top = header ? Math.max(v, 18) : v, bottom = numbers ? Math.max(v, 16) : v;
  const box = `font: 500 7.5pt/1 "DM Sans Variable", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #898781;`;
  return `@page { size: ${PAGE_SIZE[options.pageSize] || "A4"}; margin: ${top}mm ${hz}mm ${bottom}mm;
  ${numbers ? `@bottom-right { content: counter(page) " / " counter(pages); ${box} }` : ""}
  ${header ? `@top-left { content: ${cssStr(title || "")}; ${box} max-width: 75%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }` : ""}
}
${header ? "@page :first { @top-left { content: none; } }" : ""}`;
}

/**
 * Builds the page.
 *
 * @param {object} args
 * @param {string} args.markdown
 * @param {string} args.title
 * @param {object} [args.options]   export options (see client/app/exporter.js): pageSize, margins,
 *        pageNumbers, titleHeader, details, codeWrap, embedFonts, wide, headingFont, textFont
 * @param {"pdf"|"html"} args.mode
 * @param {(src: string) => string} [args.resolveImage]  image src -> URL to embed
 * @param {object[]} [args.diagrams]  drawn Mermaid diagrams, see render.js
 * @param {{docCss: string, fontCss: string, katexCss: string}} args.assets  stylesheets as text. docCss is
 *        tokens.css + doc.css + export.css; fontCss the @font-face rules; katexCss only if the document has math
 * @returns {string} the complete HTML document
 */
export function buildPage({ markdown, title, options = {}, mode, resolveImage, diagrams = [], assets }) {
  const interactive = mode === "html";
  const { render } = createRenderer({ resolveImage, details: options.details || "expanded", interactive, diagrams });
  const body = render(markdown);
  const katex = /class="katex/.test(body) ? assets.katexCss : "";
  const fontCss = mode === "html" && options.embedFonts === false ? "" : assets.fontCss;

  const htmlAttrs = [
    mode === "pdf" ? 'data-theme="light"' : "",
    interactive ? "data-interactive" : "",
    options.codeWrap !== false ? "data-wrap-code" : ""
  ].filter(Boolean).join(" ");

  // Inline scripts, written here and never taken from the document. The HTML file is downloaded and
  // opened outside the app, so it is not under the app's Content-Security-Policy.
  //   theme   follow prefers-color-scheme live
  //   toggle  open/close collapsible sections by click or Enter/Space
  const themeScript = mode === "html"
    ? `<script>(function(){var m=matchMedia("(prefers-color-scheme: dark)");function a(){document.documentElement.dataset.theme=m.matches?"dark":"light"}a();m.addEventListener("change",a)})();</script>`
    : "";
  const toggleScript = interactive
    ? `<script>document.addEventListener("click",function(e){var t=e.target.closest(".details-toggle, .details-summary");if(!t)return;var d=t.closest(".details");if(!d||t.closest(".details-content"))return;d.dataset.open=d.dataset.open==="true"?"false":"true"});document.addEventListener("keydown",function(e){if((e.key==="Enter"||e.key===" ")&&e.target.classList.contains("details-toggle")){e.preventDefault();e.target.click()}});</script>`
    : "";

  return `<!doctype html>
<html lang="en" ${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || "Document")}</title>
<meta name="generator" content="Professional Markdown Editor">
${themeScript}
<style>${fontCss}</style>
<style>${katex}</style>
<style>${assets.docCss}</style>
${mode === "pdf" ? `<style>${pageCss(options, title)}</style>` : ""}
</head>
<body>
<main class="export-page${options.wide ? " is-wide" : ""}">
<article class="doc-body" data-heading-font="${esc(options.headingFont || "serif")}" data-text-font="${esc(options.textFont || "sans")}">
${body}
</article>
</main>
${toggleScript}
</body>
</html>`;
}
