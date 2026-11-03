// End-to-end: builds the site, serves dist/ like a static host (with the production Content-Security-Policy
// from public/_headers) and drives it in a real browser (Chrome, Edge or Chromium; set CHROME_PATH to
// choose). Covers start-up, saving to the library, version history, images, folder mode (against the
// browser's private file system, which has the same interface as a real folder), the three exports and
// offline use. Skips with a message when no browser is installed.
//   npm run test:e2e
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "../scripts/build.mjs";
import { serve } from "../scripts/serve.mjs";
import { findBrowser, launch } from "./browser.mjs";
import katex from "katex";

if (!findBrowser()) { console.log("skip e2e: no Chrome, Edge or Chromium found (set CHROME_PATH)"); process.exit(0); }

const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log((ok ? "ok   " : "FAIL ") + name + (ok || !extra ? "" : "  → " + extra)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await build();
const { server, url } = await serve({ port: 0 });
const browser = await launch();
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "mde-dl-"));
const problems = [];
// downloads are a browser-wide setting; they land in a temporary folder that is deleted at the end
await (await browser.target().createCDPSession()).send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/favicon/.test(m.text())) problems.push(m.type() + ": " + m.text()); });
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("response", (r) => { if (r.status() >= 400) problems.push("HTTP " + r.status() + " " + r.url() + " initiated by " + JSON.stringify(r.request().initiator()?.stack?.callFrames?.slice(0, 3).map((f) => f.functionName + "@" + f.url.split("/").pop() + ":" + f.lineNumber))); });
  // remember the page that the PDF export sends to the print dialog (headless browsers cannot show it)
  await page.evaluateOnNewDocument(() => {
    const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
    Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", { set(v) { window.__printed = v; d.set.call(this, v); }, get() { return d.get.call(this); } });
  });
  return page;
}
const ready = (page) => page.waitForFunction(() => document.body.classList.contains("is-ready"), { timeout: 30000 });
const clickText = (page, text, sel = "button, [role=menuitem]") => page.evaluate((text, sel) => {
  const el = [...document.querySelectorAll(sel)].find((b) => b.offsetParent && b.textContent.trim().startsWith(text));
  if (!el) throw new Error("nothing to click: " + text);
  el.click();
}, text, sel);
// Opens text as a new untitled document, answering the "discard unsaved changes?" question if it appears.
async function openText(page, text, name) {
  await page.evaluate((t, n) => { window.__editor.app.openText(t, n); }, text, name); // not awaited: the question blocks it
  for (let i = 0; i < 30; i++) { // wait up to 3 s for the question; there is none when the open document is untitled
    if (await page.evaluate(() => [...document.querySelectorAll(".dialog button")].some((b) => b.textContent.trim() === "Discard"))) { await clickText(page, "Discard"); break; }
    await sleep(100);
  }
  await page.waitForFunction(() => !document.querySelector(".dialog"), { timeout: 10000 });
  await sleep(300);
}
const md = (page) => page.evaluate(() => window.__editor.getMarkdown());
async function download(name) {
  for (let i = 0; i < 200; i++) {
    const f = path.join(downloads, name);
    if (fs.existsSync(f) && !fs.existsSync(f + ".crdownload")) { await sleep(150); return fs.readFileSync(f); }
    await sleep(100);
  }
  throw new Error("no download: " + name);
}

try {
  /* ---------- start-up ---------- */
  let page = await newPage();
  await page.goto(url, { waitUntil: "load" });
  await ready(page);
  check("the app starts and shows the welcome document", (await page.$eval(".ProseMirror h1", (e) => e.textContent)).startsWith("Welcome"));
  await page.waitForFunction(() => document.querySelectorAll(".katex").length >= 2, { timeout: 20000 }).catch(() => {});
  check("math is drawn with KaTeX", (await page.$$(".katex")).length >= 2);
  await page.waitForSelector(".diagram svg", { timeout: 20000 });
  check("the Mermaid diagram is drawn", true);
  await page.waitForFunction(() => ["DM Sans Variable", "Newsreader Variable", "JetBrains Mono Variable"].every((f) => [...document.fonts].some((x) => x.family === f && x.status === "loaded")), { timeout: 20000 }).catch(() => {});
  const faces = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
  check("the open-source fonts load", ["DM Sans Variable", "Newsreader Variable", "JetBrains Mono Variable"].every((f) => faces.includes(f)), faces.join());
  check("no proprietary font is referenced", !(await page.evaluate(() => [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => /anthropic/i.test(r.cssText)); } catch { return false; } }))));

  /* ---------- typing shortcuts ---------- */
  await openText(page, "", "typing.md");
  await page.evaluate(() => window.__editor.view.focus());
  await page.keyboard.type("- [ ] Write the draft", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ship it", { delay: 15 });
  check("typing \"- [ ] \" starts a checklist and keeps the text in the item", (await md(page)) === "- [ ] Write the draft\n- [ ] Ship it\n", JSON.stringify(await md(page)));
  await page.keyboard.down("Alt"); await page.keyboard.press("ArrowUp"); await page.keyboard.up("Alt");
  check("Alt+ArrowUp moves the item up", (await md(page)) === "- [ ] Ship it\n- [ ] Write the draft\n", JSON.stringify(await md(page)));

  /* ---------- find and replace ---------- */
  await openText(page, "alpha beta alpha\n\nAlpha in **bold**\n", "find.md");
  await page.evaluate(() => window.__editor.view.focus());
  await page.keyboard.down("Control"); await page.keyboard.press("f"); await page.keyboard.up("Control");
  await page.waitForSelector(".find-panel:not([hidden]) .find-input");
  await page.keyboard.type("alpha");
  await page.waitForFunction(() => document.querySelector(".find-count").textContent.includes("3"), { timeout: 5000 }).catch(() => {});
  check("Ctrl+F finds every match", (await page.$eval(".find-count", (e) => e.textContent)) === "1 of 3", await page.$eval(".find-count", (e) => e.textContent));
  check("matches are highlighted in the page", (await page.$$(".ProseMirror .find-match")).length >= 3);
  await page.keyboard.press("Enter");
  check("Enter moves to the next match", (await page.$eval(".find-count", (e) => e.textContent)) === "2 of 3");
  await page.keyboard.down("Control"); await page.keyboard.press("h"); await page.keyboard.up("Control");
  await page.keyboard.type("omega");
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  check("Replace all replaces every match in one step", (await md(page)) === "omega beta omega\n\nomega in **bold**\n", JSON.stringify(await md(page)));
  await page.keyboard.press("Escape");
  check("Escape closes the find panel", await page.$eval(".find-panel", (e) => e.hidden) && (await page.$$(".ProseMirror .find-match")).length === 0);
  await page.evaluate(() => window.__editor.view.focus());
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  check("one Undo restores the replaced text", (await md(page)) === "alpha beta alpha\n\nAlpha in **bold**\n", JSON.stringify(await md(page)));

  /* ---------- pasting math from web pages ---------- */
  // Pastes HTML (as if copied from another site) into an empty document and returns the Markdown.
  const pasteHtml = async (html) => {
    await openText(page, "", "paste.md");
    await page.evaluate((h) => { const v = window.__editor.view; v.focus(); v.pasteHTML(h); }, html);
    return (await md(page)).trim();
  };
  {
    const out = await pasteHtml(String.raw`<p>Disk: $\text{space} = \lceil \text{size}/4096 \rceil$. Done</p><p>Costs $5 and $6</p><p>a</p><p>$$\text{digit} = 4r + 2w + x$$</p><p>b</p>`);
    check("pasted $…$ text becomes inline math", out.includes(String.raw`Disk: $\text{space} = \lceil \text{size}/4096 \rceil$. Done`), out);
    check("pasted prices stay text", out.includes("Costs \\$5 and \\$6"), out);
    check("a pasted $$…$$ paragraph becomes an equation block", out.includes("a\n\n$$\\text{digit} = 4r + 2w + x$$\n\nb"), out);
    check("pasted math is drawn", (await page.$$(".ProseMirror .katex")).length >= 2);
  }
  {
    const inline = katex.renderToString("\\pi r^2"), display = katex.renderToString("E = mc^2", { displayMode: true });
    const out = await pasteHtml(`<p>Area ${inline} here</p><p>x</p>${display}<p>y</p>`);
    check("pasted KaTeX keeps its TeX", out.includes("Area $\\pi r^2$ here"), out);
    check("a pasted KaTeX display equation becomes an equation block", out.includes("x\n\n$$E = mc^2$$\n\ny"), out);
  }
  {
    const out = await pasteHtml(`<p>Only ${katex.renderToString("q^2", { output: "html" })} drawn</p>`);
    check("KaTeX without TeX source pastes its text once", (out.match(/q/g) || []).length === 1, out);
  }
  {
    const wiki = String.raw`<p>See <span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\displaystyle x^{2}}"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">{\displaystyle x^{2}}</annotation></semantics></math></span><img src="data:," class="mwe-math-fallback-image-inline" alt="{\displaystyle x^{2}}"></span> here and <math alttext="a+b"><mi>a</mi><mo>+</mo><mi>b</mi></math>.</p>`;
    const out = await pasteHtml(wiki);
    check("pasted Wikipedia and MathML formulas keep their TeX", out === "See $x^{2}$ here and $a+b$.", out);
  }
  {
    const out = await pasteHtml(`<p data-pm-slice="1 1 []">Literal $x$ typed here</p>`);
    check("a paste from the editor itself keeps its literal dollars", out === "Literal \\$x\\$ typed here", out);
  }

  /* ---------- library: save, reload, versions ---------- */
  await openText(page, "# Trip notes\n\nFirst draft with $x^2$.\n", "trip.md");
  await page.keyboard.down("Control"); await page.keyboard.press("s"); await page.keyboard.up("Control");
  await page.waitForSelector(".dialog input");
  await page.$eval(".dialog input", (i) => { i.value = "notes/trip"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.keyboard.press("Enter");
  await page.waitForFunction(async () => (await window.__editor.store.list()).some((f) => f.path === "notes/trip.md"), { timeout: 15000, polling: 200 });
  const saved = await page.evaluate(() => window.__editor.store.read("notes/trip.md"));
  check("Ctrl+S saves a new document into the library", saved.content.startsWith("# Trip notes"), JSON.stringify(saved.content));
  await page.evaluate(() => { const v = window.__editor.view; v.dispatch(v.state.tr.insertText(" Second draft.", v.state.doc.content.size - 1)); });
  await sleep(900);
  await page.keyboard.down("Control"); await page.keyboard.press("s"); await page.keyboard.up("Control");
  await page.waitForFunction(async () => (await window.__editor.store.history("notes/trip.md")).length >= 1, { timeout: 15000, polling: 200 }).catch(() => {});
  const hist = await page.evaluate(() => window.__editor.store.history("notes/trip.md"));
  check("a second save keeps the first text as a version", hist.length === 1, JSON.stringify(hist));
  const old = await page.evaluate((id) => window.__editor.store.version("notes/trip.md", id), hist[0] && hist[0].id);
  check("the version holds the text that was replaced", old.includes("First draft") && !old.includes("Second draft"));
  const conflict = await page.evaluate(async () => { try { await window.__editor.store.write("notes/trip.md", "x", 12345); return "no error"; } catch (e) { return e.status; } });
  check("saving over a changed file is refused (409)", conflict === 409, String(conflict));
  const badPath = await page.evaluate(async () => { try { await window.__editor.store.write("../evil.md", "x", null); return "no error"; } catch (e) { return e.status; } });
  check("paths that leave the library are refused (400)", badPath === 400, String(badPath));

  await page.reload({ waitUntil: "load" });
  await ready(page);
  check("after a reload the last document opens again", (await page.title()).startsWith("Trip notes"), await page.title());
  check("and has the saved text", (await md(page)).includes("Second draft"));

  /* ---------- images stored beside the document ---------- */
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const src = await page.evaluate(async (b64) => {
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" });
    return window.__editor.store.saveAsset("notes/trip.md", "My pic.png", blob);
  }, png);
  check("an image is stored in assets/ next to the document", src === "assets/My-pic.png", src);
  await page.evaluate((src) => { const { app, view } = window.__editor; app.openText("![dot](" + src + ")\n", "x.md"); }, src);
  await page.evaluate(() => window.__editor.app.openPath("notes/trip.md"));
  await page.evaluate((src) => { const v = window.__editor.view; const { schema } = v.state; v.dispatch(v.state.tr.insert(1, schema.nodes.image.create({ src, alt: "dot" }))); }, src);
  await page.waitForFunction(() => { const i = document.querySelector("img.doc-img"); return i && i.src.startsWith("blob:") && i.naturalWidth === 1; }, { timeout: 15000 });
  check("the editor shows stored images", true);

  /* ---------- folder mode, on the browser's private file system ---------- */
  const folder = await page.evaluate(async () => {
    const out = {};
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-" + Date.now(), { create: true });
    const { FolderBackend } = window.__editor;
    const f = new FolderBackend(root, "e2e");
    const w = await f.write("a/note.md", "# One\n", null);
    out.write = !!w.mtime;
    out.list = (await f.list()).map((x) => x.path).join();
    out.read = (await f.read("a/note.md")).content;
    const w2 = await f.write("a/note.md", "# Two\n", w.mtime);
    out.history = (await f.history("a/note.md")).length;
    // a change made by another program is noticed
    const h = await (await root.getDirectoryHandle("a")).getFileHandle("note.md");
    const ws = await h.createWritable(); await ws.write("# Outside\n"); await ws.close();
    try { await f.write("a/note.md", "# Three\n", w2.mtime); out.conflict = "none"; } catch (e) { out.conflict = e.status; }
    await f.write("a/note.md", "# Three\n", w2.mtime, true);
    out.forced = (await f.read("a/note.md")).content;
    out.asset = await f.saveAsset("a/note.md", "pic.png", new Blob([Uint8Array.from([137, 80, 78, 71])], { type: "image/png" }));
    out.assetRead = (await f.readAsset("a/assets/pic.png")).size;
    await (await root.getDirectoryHandle(".git", { create: true })).getFileHandle("x.md", { create: true });
    out.hidden = (await f.list()).map((x) => x.path).join();
    try { await f.read(".git/x.md"); out.hiddenRead = "readable"; } catch (e) { out.hiddenRead = e.status; }
    try { await f.write("../out.md", "x", null); out.escape = "allowed"; } catch (e) { out.escape = e.status; }
    await f.remove("a/note.md");
    out.afterRemove = (await f.list()).length;
    return out;
  });
  check("folder mode writes, lists and reads real files", folder.write && folder.list === "a/note.md" && folder.read === "# One\n", JSON.stringify(folder));
  check("folder mode keeps versions", folder.history === 1);
  check("folder mode notices a change made by another program", folder.conflict === 409 && folder.forced === "# Three\n", JSON.stringify(folder));
  check("folder mode stores images in assets/", folder.asset === "assets/pic.png" && folder.assetRead === 4, JSON.stringify(folder));
  check("folder mode hides and protects dot-folders", !folder.hidden.includes(".git") && folder.hiddenRead === 400 && folder.escape === 400, JSON.stringify(folder));
  check("folder mode deletes", folder.afterRemove === 0);

  /* ---------- exports ---------- */
  await openText(page, `# Export check

Math $a^2+b^2=c^2$ and an embedded image ![dot](data:image/png;base64,${png}) and a table:

| A | B |
|---|---|
| 1 | 2 |

$$\\int_0^1 x\\,dx = \\tfrac12$$

\`\`\`mermaid
flowchart LR
  A[Write] --> B[Export]
\`\`\`

<details><summary>Answer</summary>

Forty-two.
</details>
`, "export-check.md");
  await page.waitForSelector(".diagram svg", { timeout: 20000 });

  await clickText(page, "Export", ".tb-export"); await sleep(200);
  await clickText(page, "Web page", "[role=menuitem]"); await page.waitForSelector(".dialog-export");
  await clickText(page, "Export HTML");
  const html = (await download("Export check.html")).toString();
  check("HTML export is one self-contained file", html.includes('class="katex"') && html.includes("<svg") && html.includes("data:font/woff2;base64,") && !/<link /.test(html) && !/<script[^>]+src=/.test(html));
  check("HTML export has the table and the collapsible section", html.includes("<table>") && html.includes('class="details"'));

  await clickText(page, "Export", ".tb-export"); await sleep(200);
  await clickText(page, "Word", "[role=menuitem]"); await page.waitForSelector(".dialog-export");
  await clickText(page, "Export Word");
  const docx = await download("Export check.docx");
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file("word/document.xml").async("string");
  check("Word export has native equations", (xml.match(/<m:oMath[ >]/g) || []).length >= 2, String((xml.match(/<m:oMath[ >]/g) || []).length));
  check("Word export has the diagram and the embedded (data:) image", Object.keys(zip.files).filter((n) => /^word\/media\/.+\.png$/.test(n)).length === 2 && !xml.includes("[Image"), Object.keys(zip.files).join());
  check("Word export has the table and real headings", xml.includes("<w:tbl>") && xml.includes('w:val="Heading1"'));

  await clickText(page, "Export", ".tb-export"); await sleep(200);
  await clickText(page, "PDF", "[role=menuitem]"); await page.waitForSelector(".dialog-export");
  await clickText(page, "Open print window");
  await page.waitForFunction(() => window.__printed, { timeout: 15000 });
  const printed = await page.evaluate(() => window.__printed);
  check("PDF export prepares a print page with page rules", printed.includes("@page") && printed.includes("counter(page)") && printed.includes('data-theme="light"') && printed.includes("<svg"));
  const pdfPage = await browser.newPage();
  await pdfPage.setContent(printed, { waitUntil: "load" });
  const pdf = Buffer.from(await pdfPage.pdf({ preferCSSPageSize: true, printBackground: true }));
  check("the print page turns into a real PDF", pdf.subarray(0, 4).toString() === "%PDF" && pdf.length > 15000, String(pdf.length));
  await pdfPage.close();

  /* ---------- offline ---------- */
  await page.close();
  page = await newPage();
  await page.goto(url, { waitUntil: "load" });
  await ready(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith("mde-")) && (await (await caches.open((await caches.keys()).find((k) => k.startsWith("mde-")))).keys()).length > 5, { timeout: 15000, polling: 300 });
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: "load" });
  await ready(page);
  check("the editor opens with no network connection", (await page.$$(".ProseMirror")).length === 1);
  await page.setOfflineMode(false);

  check("no console errors or warnings", problems.length === 0, "\n" + problems.join("\n"));
} catch (e) {
  check("e2e run: " + (e && e.stack || e), false);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(downloads, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
