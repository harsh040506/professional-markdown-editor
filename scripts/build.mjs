#!/usr/bin/env node
// Builds the static site into dist/. Everything in dist/ is plain files: host it on Vercel,
// Cloudflare Pages, Netlify or any web server. No server code runs.
//
//   npm run build              production build (hashed file names, minified)
//   npm run dev                development build + local server with rebuild on change
//   SITE_URL=https://example.com npm run build     absolute URLs for social-card meta tags
//
// What ends up in dist/:
//   index.html            from public/index.html with the hashed script and style names filled in
//   assets/               the app (esbuild output; heavy parts such as Mermaid are separate lazy chunks)
//   fonts/                DM Sans, Newsreader and JetBrains Mono (all SIL OFL) + fonts.css
//   vendor/katex/         KaTeX stylesheet and its woff2 fonts (the page and the exports both use them)
//   everything in public/ (icons, manifest, _headers …) and sw.js, the offline service worker
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FONT_FACES } from "../src/export/fonts.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const nm = (...p) => path.join(root, "node_modules", ...p);

// Absolute address of the deployed site, for the link-preview tags. SITE_URL wins; Vercel's production domain
// is picked up automatically, so a Vercel deploy needs no setup. Without either, the tags are left out.
const SITE_URL = (process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "")).replace(/\/+$/, "");

const copyFile = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
function copyDir(from, to, skip = () => false) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (skip(a)) continue;
    if (e.isDirectory()) copyDir(a, b, skip); else copyFile(a, b);
  }
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const esbuildOptions = (dev) => ({
  entryPoints: { "assets/app": path.join(root, "src/client/index.js") },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  target: ["es2022", "chrome105", "firefox104", "safari16"],
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  entryNames: dev ? "[dir]/[name]" : "[dir]/[name]-[hash]",
  chunkNames: dev ? "assets/chunks/[name]" : "assets/chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  legalComments: "none",
  metafile: true,
  logLevel: dev ? "info" : "warning"
});

// Fonts: copy the latin woff2 files and write fonts/fonts.css, which uses paths relative to itself so
// the site works from any sub-path (a site served from a folder such as /editor/).
function buildFonts() {
  const css = [];
  for (const f of FONT_FACES) {
    const pkg = f.file.replace(/-latin-wght-.*$/, "");
    copyFile(nm("@fontsource-variable", pkg, "files", f.file), path.join(dist, "fonts", f.file));
    css.push(`@font-face{font-family:"${f.family}";src:url(${f.file}) format("woff2");font-weight:${f.weight};font-style:${f.style};font-display:swap}`);
  }
  fs.writeFileSync(path.join(dist, "fonts", "fonts.css"), css.join("\n") + "\n");
}

// KaTeX: its stylesheet lists woff2, woff and ttf for every face; every browser the app supports reads
// woff2, so the other two are dropped (a third of the weight) and only the woff2 files are copied.
function buildKatex() {
  const src = nm("katex", "dist");
  const css = fs.readFileSync(path.join(src, "katex.min.css"), "utf8")
    .replace(/,url\(fonts\/[^)]+\) format\("(?:woff|truetype)"\)/g, "");
  fs.mkdirSync(path.join(dist, "vendor", "katex", "fonts"), { recursive: true });
  fs.writeFileSync(path.join(dist, "vendor", "katex", "katex.min.css"), css);
  for (const f of fs.readdirSync(path.join(src, "fonts")).filter((n) => n.endsWith(".woff2"))) {
    copyFile(path.join(src, "fonts", f), path.join(dist, "vendor", "katex", "fonts", f));
  }
}

// The app's entry script among the build outputs (dist/assets/app.js, or app-<hash>.js). Matched by name
// because esbuild's metafile also marks some shared chunks as entry points.
const isEntryScript = (p) => /(^|\/)assets\/app(-[A-Z0-9]+)?\.js$/.test(p);

// Writes index.html with the entry script and stylesheet names filled in. Paths are relative.
function buildIndex(metafile) {
  const out = Object.entries(metafile.outputs);
  const rel = (p) => path.relative(dist, path.join(root, p)).split(path.sep).join("/");
  const js = out.find(([p]) => isEntryScript(p));
  const css = out.find(([p]) => p.endsWith(".css") && /assets\/app/.test(p));
  if (!js) throw new Error("build produced no entry script");
  let html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  html = html.replaceAll("%APP_JS%", rel(js[0])).replaceAll("%APP_CSS%", css ? rel(css[0]) : "");
  const abs = (p) => (SITE_URL ? SITE_URL + "/" + p : p);
  html = html.replaceAll("%OG_IMAGE%", abs("og-image.png")).replaceAll("%SITE_URL%", SITE_URL ? SITE_URL + "/" : "");
  if (!SITE_URL) html = html.replace(/^.*property="og:url".*\n/m, "").replace(/^.*rel="canonical".*\n/m, "");
  fs.writeFileSync(path.join(dist, "index.html"), html);
}

// Offline support: a service worker (src/sw.js) that caches the app shell. The cache name carries a hash of
// every file name, so each deploy gets a fresh cache and the old one is deleted on activation. Only the
// files needed to start the editor are precached: the entry script and everything it imports statically.
// Mermaid, the Word exporter and the like are separate lazy chunks, cached when first used.
function buildServiceWorker(metafile) {
  // metafile paths are relative to the project folder; the site's paths are relative to dist/
  const inDist = (p) => path.relative(dist, path.join(root, p)).split(path.sep).join("/");
  const entry = Object.keys(metafile.outputs).find(isEntryScript);
  const startup = new Set(); // dist-relative names of the entry script and its static imports
  const visit = (out) => {
    if (!metafile.outputs[out] || startup.has(inDist(out))) return;
    startup.add(inDist(out));
    for (const i of metafile.outputs[out].imports) if (i.kind === "import-statement") visit(i.path);
  };
  visit(entry);
  const files = walk(dist).map((p) => path.relative(dist, p).split(path.sep).join("/"));
  const skip = (p) => /^(sw\.js|_headers|_redirects|robots\.txt)$/.test(p) || /\.map$/.test(p);
  const needed = (p) => !p.startsWith("assets/") || startup.has(p) || p.endsWith(".css");
  const precache = files.filter((p) => !skip(p) && needed(p));
  const version = createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 10);
  const tpl = fs.readFileSync(path.join(root, "src", "sw.js"), "utf8");
  fs.writeFileSync(path.join(dist, "sw.js"), tpl
    .replace('const VERSION = "dev";', 'const VERSION = "' + version + '";')
    .replace("const PRECACHE = [];", "const PRECACHE = " + JSON.stringify(["./", ...precache]) + ";"));
}

function buildStatic() {
  copyDir(path.join(root, "public"), dist, (p) => path.basename(p) === "index.html" && path.dirname(p) === path.join(root, "public"));
  buildFonts();
  buildKatex();
  // The minified bundle carries no license notices, so they travel beside it as plain text files that
  // the app links to (More menu → Open-source licenses).
  copyFile(path.join(root, "LICENSE"), path.join(dist, "LICENSE.txt"));
  if (fs.existsSync(path.join(root, "THIRD_PARTY_NOTICES.md"))) copyFile(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(dist, "THIRD_PARTY_NOTICES.txt"));
}

export async function build({ dev = false } = {}) {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const result = await esbuild.build(esbuildOptions(dev));
  buildStatic();
  buildIndex(result.metafile);
  if (!dev) buildServiceWorker(result.metafile);
  return result;
}

// Development: build once, then let esbuild rebuild on change and serve dist/ on http://localhost:4317.
async function dev() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const ctx = await esbuild.context({
    ...esbuildOptions(true),
    plugins: [{
      name: "static", setup(b) {
        b.onEnd((r) => { if (r.metafile) { buildStatic(); buildIndex(r.metafile); } });
      }
    }]
  });
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: 4317, host: "127.0.0.1" });
  console.log(`dev server: http://127.0.0.1:${port}  (rebuilds on change; Ctrl+C to stop)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--watch")) await dev();
  else {
    const started = Date.now();
    await build();
    const size = walk(dist).reduce((n, p) => n + fs.statSync(p).size, 0);
    console.log(`built dist/ in ${Date.now() - started} ms (${walk(dist).length} files, ${(size / 1048576).toFixed(1)} MB)`);
  }
}
