#!/usr/bin/env node
// Serves dist/ the way a static host would (npm run preview). Also used by test/e2e.mjs.
//   node scripts/serve.mjs [--port 4318]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json"
};

// Reads dist/_headers (Cloudflare Pages format) so previews and tests run under the same
// Content-Security-Policy as production. Rules apply to every path ("/*") in this simple reader.
function globalHeaders(dir) {
  const out = {};
  try {
    let inAll = false;
    for (const line of fs.readFileSync(path.join(dir, "_headers"), "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      if (!/^\s/.test(line)) { inAll = line.trim() === "/*"; continue; }
      const i = line.indexOf(":");
      if (inAll && i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  } catch { /* no _headers file */ }
  return out;
}

export function serve({ dir = path.join(root, "dist"), port = 4318, host = "127.0.0.1" } = {}) {
  const headers = globalHeaders(dir);
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
    let file = path.join(dir, p.endsWith("/") ? p + "index.html" : p);
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
    res.writeHead(200, { ...headers, "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf("--port");
  const { url } = await serve({ port: i > 0 ? +process.argv[i + 1] : 4318 });
  console.log(`Serving dist/ at ${url}  (run npm run build first)`);
}
