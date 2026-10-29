#!/usr/bin/env node
// Generates the promotional pictures from the real app (run scripts/screenshots.mjs first for the hero shots):
//   docs/images/banner.png          README header
//   docs/images/social-preview.png  1280x640, upload under Settings → Social preview on GitHub
//   public/og-image.png             link-preview card of the site itself (Open Graph / Twitter)
//   docs/images/demo.gif            the editor being typed into; encoded in plain JavaScript
//   node scripts/promo.mjs [banner] [gif]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { build } from "./build.mjs";
import { serve } from "./serve.mjs";
import { launch } from "../test/browser.mjs";

const root = path.dirname(import.meta.dirname);
const out = path.join(root, "docs", "images");
const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (p) => fs.readFileSync(p).toString("base64");

/* ---------- banner and cards ---------- */
function fontFace(pkg, family, weight) {
  const file = path.join(root, "node_modules", "@fontsource-variable", pkg, "files", pkg + "-latin-wght-normal.woff2");
  return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64(file)}) format('woff2');font-weight:${weight}}`;
}
function card(w, h) {
  const img = (n) => "data:image/png;base64," + b64(path.join(out, n));
  const css = `
    *{box-sizing:border-box;margin:0}
    body{width:${w}px;height:${h}px;overflow:hidden;font-family:Sans,sans-serif;color:#1f1e1d;position:relative;
      background:radial-gradient(1200px 600px at 85% 0%,#e9eefb 0%,transparent 60%),radial-gradient(900px 500px at 0% 100%,#f6e9dc 0%,transparent 60%),#faf9f5}
    .copy{position:absolute;left:${w * 0.055}px;top:50%;transform:translateY(-50%);width:${w * 0.42}px}
    .tag{display:inline-block;font-size:${h * 0.028}px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#2a78d6;margin-bottom:${h * 0.03}px}
    h1{font:400 ${h * 0.125}px/1.04 Serif,serif;letter-spacing:-.02em;margin-bottom:${h * 0.04}px}
    p{font-size:${h * 0.043}px;line-height:1.4;color:#52514e;margin-bottom:${h * 0.05}px}
    .chips{display:flex;flex-wrap:wrap;gap:${h * 0.018}px}
    .chips span{font-size:${h * 0.03}px;font-weight:600;padding:${h * 0.012}px ${h * 0.026}px;border-radius:99px;background:#fff;border:1px solid rgba(11,11,11,.12);box-shadow:0 1px 2px rgba(0,0,0,.05)}
    .win{position:absolute;border-radius:${h * 0.03}px;overflow:hidden;background:#fff;box-shadow:0 ${h * 0.04}px ${h * 0.12}px rgba(11,11,11,.22),0 0 0 1px rgba(11,11,11,.1)}
    .win img{display:block;width:100%;height:100%;object-fit:cover;object-position:top left}
    .a{left:${w * 0.5}px;top:${h * 0.13}px;width:${w * 0.46}px;height:${h * 0.62}px}
    .b{left:${w * 0.6}px;top:${h * 0.34}px;width:${w * 0.46}px;height:${h * 0.62}px}`;
  return `<!doctype html><meta charset="utf-8"><style>${fontFace("newsreader", "Serif", "200 800")}${fontFace("dm-sans", "Sans", "100 1000")}${css}</style>
<body><div class="copy"><div class="tag">Open source · MIT</div><h1>Professional Markdown Editor</h1>
<p>Write Markdown the way it will look. Math, diagrams, and export to PDF, Word and HTML, all in your browser.</p>
<div class="chips"><span>No account</span><span>No server</span><span>Works offline</span><span>Private</span></div></div>
<div class="win a"><img src="${img("hero-light.png")}"></div><div class="win b"><img src="${img("hero-dark.png")}"></div></body>`;
}

await build();
const { server, url } = await serve({ port: 0 });
const browser = await launch();
try {
  if (want("banner")) {
    for (const [name, w, h, dir, scale] of [["banner.png", 1600, 500, out, 2], ["social-preview.png", 1280, 640, out, 1], ["og-image.png", 1200, 630, path.join(root, "public"), 1]]) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: scale });
      await page.setContent(card(w, h), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(dir, name) });
      await page.close();
      console.log("wrote", path.relative(root, path.join(dir, name)));
    }
  }

  if (want("gif")) {
    const frames = fs.mkdtempSync(path.join(os.tmpdir(), "mde-gif-"));
    const page = await browser.newPage();
    await page.setViewport({ width: 880, height: 560, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.evaluateOnNewDocument(() => localStorage.setItem("mde:settings", JSON.stringify({ theme: "light", headingFont: "serif", textFont: "sans", wide: false, spellcheck: false })));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.classList.contains("is-ready"));
    await page.evaluate(() => window.__editor.app.openText("", "launch-notes.md"));
    await sleep(500);
    await page.addStyleTag({ content: ".ProseMirror{caret-color:#2a78d6 !important}" });
    await page.evaluate(() => window.__editor.view.focus());
    let n = 0;
    const frame = async (hold = 1) => { const buf = await page.screenshot(); for (let i = 0; i < hold; i++) fs.writeFileSync(path.join(frames, String(n++).padStart(4, "0") + ".png"), buf); };
    const type = async (text, every = 2) => { let i = 0; for (const ch of text) { await page.keyboard.type(ch, { delay: 10 }); if (++i % every === 0) await frame(); } await frame(); };
    const enter = () => page.keyboard.press("Enter");
    const click = (text, sel = "button, [role=menuitem]") => page.evaluate((t, s) => { const el = [...document.querySelectorAll(s)].find((b) => b.offsetParent && b.textContent.trim().startsWith(t)); if (el) el.click(); }, text, sel);

    await frame(8);
    await type("# Launch notes"); await enter(); await frame(5);
    await type("Type Markdown and it formats as you go. ", 3);
    await type("**Bold**", 3); await type(" and "); await type("*italic*", 3); await type(" just work."); await enter(); await frame(5);
    await type("- [ ] Write the draft", 3); await enter(); await type("Add the equation", 3); await enter(); await enter(); await frame(4);
    await type("Energy: $E = mc^2$ ", 2); await frame(10); await enter();
    await type("/", 1); await frame(5); await type("dia", 1); await frame(10); await enter();
    await sleep(1200); await frame(14);
    await click("", "[aria-label=Theme], [data-tip=Theme]"); await sleep(300); await frame(5);
    await click("Dark"); await sleep(600); await frame(12);
    await click("Export", ".tb-export"); await sleep(400); await frame(14);

    // Encode in plain JavaScript (no ffmpeg needed): identical neighbouring frames are merged into one frame
    // with a longer delay, and one palette is shared by all frames to keep the file small.
    const files = fs.readdirSync(frames).sort().map((n) => PNG.sync.read(fs.readFileSync(path.join(frames, n))));
    const sample = Buffer.concat(files.filter((_, i) => i % 12 === 0).map((p) => p.data));
    const palette = quantize(sample, 128);
    const gifFile = new GIFEncoder();
    let last = null, run = 0, wrote = false;
    const flush = () => {
      if (!last) return;
      // the first frame carries the shared palette; later frames reuse it
      gifFile.writeFrame(applyPalette(last.data, palette), last.width, last.height, { palette: wrote ? undefined : palette, delay: run * 83 });
      wrote = true;
    };
    for (const p of files) {
      if (last && Buffer.compare(last.data, p.data) === 0) { run++; continue; }
      flush(); last = p; run = 1;
    }
    flush();
    gifFile.finish();
    const gif = path.join(out, "demo.gif");
    fs.writeFileSync(gif, gifFile.bytes());
    fs.copyFileSync(path.join(frames, String(Math.floor(n * 0.62)).padStart(4, "0") + ".png"), path.join(os.tmpdir(), "mde-gif-mid.png"));
    fs.rmSync(frames, { recursive: true, force: true });
    console.log("wrote docs/images/demo.gif:", (fs.statSync(gif).size / 1048576).toFixed(1) + " MB,", n, "frames");
  }
} finally {
  await browser.close();
  server.close();
}
