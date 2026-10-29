#!/usr/bin/env node
// Generates the pictures used in README.md and the link previews, from the real app, so they never go
// stale. Builds the site, opens it in headless Chrome/Edge and photographs it:
//   docs/images/hero-light.png, hero-dark.png, slash-menu.png, selection.png, export-dialog.png,
//   open-dialog.png, mobile.png, export-pdf.png
// The banner, social cards and demo GIF are made from these by scripts/promo.mjs, so run this one first.
//   npm run screenshots              everything
//   node scripts/screenshots.mjs hero menus dialogs mobile pdf     only some
// Needs a Chromium-based browser (set CHROME_PATH if none is found).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "./build.mjs";
import { serve } from "./serve.mjs";
import { launch } from "../test/browser.mjs";

const root = path.dirname(import.meta.dirname);
const out = path.join(root, "docs", "images");
fs.mkdirSync(out, { recursive: true });
const demo = fs.readFileSync(path.join(root, "docs", "demo-document.md"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.slice(2); // e.g. `node scripts/screenshots.mjs gif banner`
const want = (name) => !only.length || only.includes(name);

await build();
const { server, url } = await serve({ port: 0 });
const browser = await launch();

// A page with the editor loaded in the given theme and size.
async function open({ theme = "light", width = 1280, height = 800, scale = 2, text = demo } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  await page.evaluateOnNewDocument((t) => { localStorage.setItem("mde:settings", JSON.stringify({ theme: t, headingFont: "serif", textFont: "sans", wide: false, spellcheck: false })); }, theme);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.classList.contains("is-ready"));
  if (text != null) {
    await page.evaluate((t) => window.__editor.app.openText(t, "gradient-descent.md"), text);
    await sleep(300);
    await page.evaluate(() => { const d = [...document.querySelectorAll(".dialog button")].find((b) => b.textContent.trim() === "Discard"); d && d.click(); });
  }
  await page.waitForSelector(".diagram svg", { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await sleep(700);
  // hide the caret blink and the word count pill's tooltip for steady pictures
  await page.addStyleTag({ content: ".ProseMirror { caret-color: transparent !important; }" });
  return page;
}
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, name), ...opts });
const scrollTo = (page, selector, offset = 90) => page.evaluate((s, o) => { const el = document.querySelector(s); document.getElementById("scroller").scrollTop = el.offsetTop - o; }, selector, offset);
const clickText = (page, text, sel = "button, [role=menuitem]") => page.evaluate((text, sel) => {
  const el = [...document.querySelectorAll(sel)].find((b) => b.offsetParent && b.textContent.trim().startsWith(text));
  if (!el) throw new Error("nothing to click: " + text);
  el.click();
}, text, sel);

try {
  /* ---------- the editor, light and dark ---------- */
  if (want("hero")) {
    for (const theme of ["light", "dark"]) {
      const page = await open({ theme });
      await shot(page, `hero-${theme}.png`);
      await page.close();
      console.log("hero-" + theme);
    }
  }

  /* ---------- slash menu, selection bar ---------- */
  if (want("menus")) {
    let page = await open({ theme: "light", text: "# Quarterly report\n\nThe numbers are in, and the trend is clear.\n\n" });
    await page.evaluate(() => { const v = window.__editor.view; v.focus(); const end = v.state.doc.content.size; v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.atEnd(v.state.doc))); });
    await page.keyboard.press("Enter");
    await page.keyboard.type("/", { delay: 40 });
    await sleep(500);
    await shot(page, "slash-menu.png", { clip: { x: 160, y: 40, width: 960, height: 640 } });
    await page.close();
    page = await open({ theme: "light", text: "# Quarterly report\n\nThe numbers are in, and the trend is clear: revenue is up and churn is down.\n" });
    // select the words "revenue is up" to bring up the formatting bar
    await page.evaluate(() => {
      const v = window.__editor.view; let from = 0, to = 0;
      v.state.doc.descendants((n, pos) => { if (n.isText && n.text.includes("revenue is up")) { from = pos + n.text.indexOf("revenue is up"); to = from + "revenue is up".length; } });
      const { TextSelection } = v.state.selection.constructor === Object ? {} : { TextSelection: v.state.selection.constructor };
      v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
    });
    await sleep(500);
    await shot(page, "selection.png", { clip: { x: 160, y: 40, width: 960, height: 330 } });
    await page.close();
    console.log("menus");
  }

  /* ---------- dialogs ---------- */
  if (want("dialogs")) {
    let page = await open({ theme: "light" });
    await clickText(page, "Export", ".tb-export"); await sleep(250);
    await clickText(page, "PDF", "[role=menuitem]"); await page.waitForSelector(".dialog-export"); await sleep(400);
    await shot(page, "export-dialog.png", { clip: { x: 340, y: 60, width: 600, height: 700 } });
    await page.close();

    page = await open({ theme: "light" });
    await page.evaluate(async () => {
      const { store } = window.__editor;
      const docs = { "Gradient descent.md": "# Gradient descent\n\nNotes.\n", "Meeting notes/2026-10-27 Planning.md": "# Planning\n", "Meeting notes/2026-10-20 Retro.md": "# Retro\n", "Reading list.md": "# Reading list\n- Paper A\n- Paper B\n", "Trip to Lisbon.md": "# Lisbon\n" };
      for (const [p, c] of Object.entries(docs)) await store.write(p, c, null, true);
    });
    await page.keyboard.down("Control"); await page.keyboard.press("o"); await page.keyboard.up("Control");
    await page.waitForSelector(".dialog-files .file-row"); await sleep(500);
    await shot(page, "open-dialog.png", { clip: { x: 320, y: 60, width: 640, height: 640 } });
    await page.close();
    console.log("dialogs");
  }

  /* ---------- phone ---------- */
  if (want("mobile")) {
    const page = await open({ theme: "light", width: 390, height: 844 });
    await shot(page, "mobile.png");
    await page.close();
    console.log("mobile");
  }

  /* ---------- what the PDF looks like ---------- */
  if (want("pdf")) {
    const page = await open({ theme: "light" });
    await clickText(page, "Export", ".tb-export"); await sleep(250);
    await clickText(page, "PDF", "[role=menuitem]"); await page.waitForSelector(".dialog-export");
    await page.evaluate(() => {
      const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
      Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", { set(v) { window.__printed = v; d.set.call(this, v); }, get() { return d.get.call(this); } });
    });
    await clickText(page, "Open print window");
    await page.waitForFunction(() => window.__printed, { timeout: 15000 });
    const html = await page.evaluate(() => window.__printed);
    // Show the print page on a sheet of paper. It is written into a page of the app's own origin, as the real
    // print frame is, so the fonts load; the margins stand in for @page, which only the PDF engine applies.
    const paper = await browser.newPage();
    await paper.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
    await paper.goto(url + "robots.txt");
    await paper.emulateMediaType("print");
    await paper.evaluate((h) => { document.open(); document.write(h); document.close(); }, html);
    await paper.addStyleTag({ content: "html{background:#fff} .export-page{padding:76px 76px 0 !important} .doc-body{font-size:10.5pt !important}" });
    await paper.evaluate(() => document.fonts.ready);
    await sleep(800);
    await paper.screenshot({ path: path.join(out, "export-pdf.png"), clip: { x: 0, y: 0, width: 794, height: 1123 } });
    await page.close(); await paper.close();
    console.log("pdf");
  }
} finally {
  await browser.close();
  server.close();
}
console.log("done: " + out);
