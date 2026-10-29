// Export output: the standalone HTML / PDF page and the Word file, built from a fixture that uses every
// feature. These modules are pure (no DOM), so they run here in Node; the browser parts (drawing diagrams,
// decoding images, printing) are covered by test/e2e.mjs.
//   node test/export.mjs
import fs from "node:fs";
import path from "node:path";
import { buildPage, pageCss } from "../src/export/page.js";
import { renderDocx } from "../src/export/docx.js";
import { createMarkdown } from "../src/shared/md.js";
import { diagramSources, imageSources } from "../src/export/render.js";

const dir = import.meta.dirname;
const markdown = fs.readFileSync(path.join(dir, "fixtures", "everything.md"), "utf8");
const read = (...p) => fs.readFileSync(path.join(dir, "..", ...p), "utf8");
const assets = {
  docCss: ["tokens", "doc", "export"].map((n) => read("src", "styles", n + ".css")).join("\n"),
  fontCss: '@font-face{font-family:"DM Sans Variable";src:url(x.woff2)}',
  katexCss: read("node_modules", "katex", "dist", "katex.min.css")
};
// A 1x1 transparent PNG, standing in for a decoded image and a drawn diagram.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log((ok ? "ok   " : "FAIL ") + name + (ok || !extra ? "" : "  → " + extra)); };

/* ---------- sources found in the document ---------- */
const tokens = createMarkdown().parse(markdown, {});
check("finds the Mermaid diagram", diagramSources(tokens).length === 1);
check("finds the image", imageSources(tokens).join() === "https://example.com/image.png");

/* ---------- HTML ---------- */
const svg = '<svg id="m1" viewBox="0 0 10 10"><g/></svg>';
const html = buildPage({ markdown, title: "Smoke", mode: "html", assets, resolveImage: (s) => "data:image/png;base64,AAAA", diagrams: [{ svg: { light: svg, dark: svg.replace("m1", "m2") } }] });
check("html has rendered math", html.includes('class="katex"'));
check("html embeds the KaTeX font faces because math is present", html.includes("KaTeX_Main"));
check("html has highlighted code", html.includes("hljs-keyword"));
check("html places the diagram, light and dark", html.includes('class="d-light"><svg id="m1"') && html.includes('class="d-dark"><svg id="m2"'));
check("html resolves images", html.includes('src="data:image/png;base64,AAAA"'));
check("html starts sections open", html.includes('class="details" data-open="true"'));
check("html is interactive and follows the system theme", html.includes("data-interactive") && html.includes("prefers-color-scheme"));
check("html has no external script", !/<script[^>]+src=/.test(html));
const collapsed = buildPage({ markdown, title: "Smoke", mode: "html", assets, options: { details: "collapsed" } });
check("collapsed option hides section contents at first", collapsed.includes('data-open="false"'));
const plain = buildPage({ markdown: "# Hi\n\ntext", title: "Plain", mode: "html", assets });
check("a page without math carries no KaTeX font faces", !plain.includes("KaTeX_Main"));
check("a diagram error is shown in place", buildPage({ markdown, title: "t", mode: "html", assets, diagrams: [{ error: "bad <x>" }] }).includes("Diagram error: bad &lt;x&gt;"));
check("a diagram that was not drawn stays as code", buildPage({ markdown, title: "t", mode: "html", assets }).includes('data-language="mermaid"'));
check("raw HTML in a document is shown as text, not run", buildPage({ markdown: "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>", title: "t", mode: "html", assets }).split("<article")[1].includes("&lt;script&gt;"));

/* ---------- PDF page ---------- */
const pdf = buildPage({ markdown, title: "A </style><b>title", mode: "pdf", assets, options: { pageSize: "Letter", margins: "wide", titleHeader: true } });
check("pdf page forces the light theme", pdf.includes('data-theme="light"'));
check("pdf page sets size and margins with @page", /@page \{ size: letter; margin: 26mm 28mm 26mm;/.test(pdf), pageCss({ pageSize: "Letter", margins: "wide" }, ""));
check("pdf page numbers use a margin box", pdf.includes('counter(page) " / " counter(pages)'));
check("pdf title header is a margin box, not on the first page", pdf.includes("@top-left") && pdf.includes("@page :first"));
check("a title cannot close the style element", !pdf.includes("</style><b>") && pdf.includes("\\3C /style>"));
check("page numbers can be turned off", !pageCss({ pageNumbers: false }, "").includes("counter(page)"));
check("header and footer raise narrow margins", /margin: 18mm 13mm 16mm/.test(pageCss({ margins: "narrow", titleHeader: true }, "t")));

/* ---------- Word ---------- */
const { default: JSZip } = await import("jszip");
const unzip = async (blob) => JSZip.loadAsync(await blob.arrayBuffer());
let blob = await renderDocx({
  markdown, title: "Smoke",
  images: new Map([["https://example.com/image.png", { data: PNG, type: "png", width: 1, height: 1 }]]),
  diagrams: [{ png: Uint8Array.from([...PNG, 0]), width: 1, height: 1 }] // different bytes: identical images are stored once
});
let zip = await unzip(blob);
let xml = await zip.file("word/document.xml").async("string");
check("docx is a zip with a document", !!xml);
check("docx has Word equations", (xml.match(/<m:oMath[ >]/g) || []).length >= 3, String((xml.match(/<m:oMath[ >]/g) || []).length));
check("docx has no <undefined> wrapper", !xml.includes("<undefined"));
check("docx has an image and a diagram", Object.keys(zip.files).filter((f) => /^word\/media\//.test(f)).length === 2);
check("docx uses real heading styles", xml.includes('w:val="Heading1"') && xml.includes('w:val="Heading2"'));
check("docx keeps hyperlinks", /<w:hyperlink/.test(xml));
check("docx has a table", xml.includes("<w:tbl>"));
blob = await renderDocx({ markdown, title: "Smoke", options: { pageSize: "Letter", fonts: "office", details: "collapsed" } });
zip = await unzip(blob);
xml = await zip.file("word/document.xml").async("string");
check("docx honours the page size option", xml.includes('w:w="12240"'));
check("docx falls back to text for a missing image", xml.includes("[Image: placeholder]"));
check("docx falls back to code for an undrawn diagram", xml.includes("flowchart LR"));
check("collapsed sections show only the summary", xml.includes("Show the answer") && !xml.includes("The answer is"));
const styles = await zip.file("word/styles.xml").async("string");
check("office fonts option uses Calibri", styles.includes("Calibri"));

process.exit(results.every(Boolean) ? 0 : 1);
