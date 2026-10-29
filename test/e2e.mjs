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

Math $a^2+b^2=c^2$ and a table:

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
  check("Word export has the diagram as an image", Object.keys(zip.files).some((n) => /^word\/media\/.+\.png$/.test(n)), Object.keys(zip.files).join());
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
