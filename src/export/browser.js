/**
 * The browser side of exporting: everything that needs a DOM, the network or storage, so that page.js and
 * docx.js can stay pure. Loaded on demand (the first time the user exports), so it costs nothing at start-up.
 *
 *   exportHtml(ctx)  -> Blob   one self-contained .html file (fonts, math fonts, images and diagrams inside)
 *   exportDocx(ctx)  -> Blob   a Word file (native equations, real headings, images, diagrams as PNG)
 *   printPdf(ctx)    -> void   opens the print dialog on the finished page; "Save as PDF" is a destination
 *
 * ctx = { markdown, title, docPath, fileName, options }. The markdown is the editor's current text, so
 * unsaved changes are included. Preparation shared by all three:
 *   images    stored images are read from the library or folder; web images are used as they are (HTML, PDF)
 *             or fetched (Word, which needs the bytes; sites that forbid cross-origin reads become "[Image]")
 *   diagrams  Mermaid is run here, in the browser, with HTML labels off so the SVG is plain and can be
 *             drawn onto a canvas for Word
 *   assets    stylesheets and fonts come from this site's own files (see scripts/build.mjs)
 */
import { buildPage } from "./page.js";
import { diagramSources, imageSources } from "./render.js";
import { printHtml } from "./print.js";
import { FONT_FACES } from "./fonts.js";
import { decodeImage, svgToPng } from "./raster.js";
import { createMarkdown } from "../shared/md.js";
import { renderMermaid } from "../client/editor/nodeviews.js";
import { loadLocalImage, isDirectSrc } from "../client/app/assets.js";
import tokensCss from "../styles/tokens.css" with { type: "text" };
import docCss from "../styles/doc.css" with { type: "text" };
import exportCss from "../styles/export.css" with { type: "text" };

const url = (rel) => new URL(rel, document.baseURI).href;

/* ---------- assets ---------- */
async function fetchOk(rel) {
  const res = await fetch(url(rel));
  if (!res.ok) throw new Error(`Could not load ${rel} (${res.status})`);
  return res;
}
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const dataUrl = async (rel, type) => `data:${type};base64,${toBase64(new Uint8Array(await (await fetchOk(rel)).arrayBuffer()))}`;
const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob);
});

const memo = new Map(); // embedded fonts are the same on every export
const once = (key, make) => { if (!memo.has(key)) memo.set(key, make().catch((e) => { memo.delete(key); throw e; })); return memo.get(key); };

// @font-face rules for the app's fonts: the files inlined as data: URLs (embed) or their URLs on this site.
async function fontCss(embed) {
  const faces = await Promise.all(FONT_FACES.map(async (f) => {
    const src = embed ? await once("font:" + f.file, () => dataUrl("fonts/" + f.file, "font/woff2")) : url("fonts/" + f.file);
    return `@font-face{font-family:"${f.family}";src:url(${src}) format("woff2");font-weight:${f.weight};font-style:${f.style};font-display:block}`;
  }));
  return faces.join("\n");
}
// KaTeX's stylesheet with its font URLs made absolute, or with the woff2 files inlined.
async function katexCss(embed) {
  const css = await once("katex", async () => (await fetchOk("vendor/katex/katex.min.css")).text());
  if (!embed) return css.replace(/url\(fonts\//g, `url(${url("vendor/katex/fonts/")}`);
  const names = [...new Set([...css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map((m) => m[1]))];
  const data = new Map(await Promise.all(names.map(async (n) => [n, await once("katex:" + n, () => dataUrl("vendor/katex/fonts/" + n, "font/woff2"))])));
  return css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (_, n) => `url(${data.get(n)})`);
}
const documentCss = () => [tokensCss, docCss, exportCss].join("\n");

/* ---------- preparation ---------- */
const hasMath = (tokens) => tokens.some((t) => t.type === "math_block" || (t.children || []).some((c) => c.type === "math_inline") || t.type === "math_inline");

// Mermaid directive that fixes the theme for one diagram without touching the editor's own theme, and
// turns HTML labels off. A diagram that starts with its own front matter is left alone.
const directive = (theme) => `%%{init: {"theme": "${theme}", "flowchart": {"htmlLabels": false}}}%%\n`;
const themed = (code, theme) => (/^\s*---/.test(code) ? code : directive(theme) + code);

/** Draws each diagram: [{svg: {light, dark?}} | {error}]. `dark` adds the dark variant (HTML export). */
async function drawDiagrams(sources, { dark = false } = {}) {
  const out = [];
  for (const code of sources) {
    const light = await renderMermaid(themed(code, "neutral"));
    if (light.error) { out.push({ error: light.error }); continue; }
    let darkSvg;
    if (dark) { const d = await renderMermaid(themed(code, "dark")); darkSvg = d.svg; }
    out.push({ svg: { light: light.svg, dark: darkSvg } });
  }
  return out;
}

// Stored images by src -> URL for the page: object URLs (kept alive until `release()`) or data: URLs.
async function pageImages(srcs, docPath, kind) {
  const map = new Map(), made = [];
  await Promise.all(srcs.filter((s) => !isDirectSrc(s)).map(async (src) => {
    const blob = await loadLocalImage(src, docPath);
    if (!blob) return;
    if (kind === "data") map.set(src, await blobToDataUrl(blob));
    else { const u = URL.createObjectURL(blob); made.push(u); map.set(src, u); }
  }));
  return { resolve: (src) => map.get(src) || src, release: () => made.forEach((u) => URL.revokeObjectURL(u)) };
}

const parse = (markdown) => createMarkdown().parse(markdown, {});

/* ---------- HTML ---------- */
export async function exportHtml({ markdown, title, docPath, options = {} }) {
  const tokens = parse(markdown);
  const [images, diagrams, fonts, katex] = await Promise.all([
    pageImages(imageSources(tokens), docPath, "data"),
    drawDiagrams(diagramSources(tokens), { dark: true }),
    fontCss(options.embedFonts !== false),
    hasMath(tokens) ? katexCss(options.embedFonts !== false) : ""
  ]);
  const html = buildPage({ markdown, title, options, mode: "html", resolveImage: images.resolve, diagrams, assets: { docCss: documentCss(), fontCss: fonts, katexCss: katex } });
  return new Blob([html], { type: "text/html;charset=utf-8" });
}

/* ---------- PDF (print) ---------- */
export async function printPdf({ markdown, title, docPath, fileName, options = {} }) {
  const tokens = parse(markdown);
  const [images, diagrams, fonts, katex] = await Promise.all([
    pageImages(imageSources(tokens), docPath, "blob"),
    drawDiagrams(diagramSources(tokens)),
    fontCss(false),
    hasMath(tokens) ? katexCss(false) : ""
  ]);
  try {
    const html = buildPage({ markdown, title, options, mode: "pdf", resolveImage: images.resolve, diagrams, assets: { docCss: documentCss(), fontCss: fonts, katexCss: katex } });
    await printHtml(html, { fileName });
  } finally { images.release(); }
}

/* ---------- Word ---------- */
// Fetches a web image (10 s limit). Sites that do not allow cross-origin reads fail here and are skipped.
async function fetchRemote(src) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try { const r = await fetch(src, { signal: ctl.signal }); return r.ok ? await r.blob() : null; }
  catch { return null; } finally { clearTimeout(timer); }
}

export async function exportDocx({ markdown, title, docPath, options = {} }) {
  const tokens = parse(markdown);
  const srcs = imageSources(tokens);
  const images = new Map();
  await Promise.all(srcs.map(async (src) => {
    const blob = isDirectSrc(src) ? await fetchRemote(src) : await loadLocalImage(src, docPath);
    images.set(src, blob ? await decodeImage(blob) : null);
  }));
  const drawn = await drawDiagrams(diagramSources(tokens));
  const diagrams = await Promise.all(drawn.map(async (d) => {
    if (d.error) return d;
    try { return await svgToPng(d.svg.light); } catch (e) { return { error: e.message }; }
  }));
  const { renderDocx } = await import("./docx.js"); // the Word library is large: loaded only now
  return renderDocx({ markdown, title, options, images, diagrams });
}
