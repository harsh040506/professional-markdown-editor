/**
 * Service worker: lets the editor open and work without a network connection, and makes it installable
 * as an app. scripts/build.mjs copies this file to dist/sw.js and fills in the two constants below.
 *
 * What is cached, and when:
 *   at install    the files the editor needs to start (PRECACHE: page, script, styles, fonts, icons)
 *   as used       everything else the page loads from this site, such as the Mermaid and Word-export code,
 *                 the first time it is needed. Diagrams and Word export therefore work offline after one
 *                 online use
 * How requests are answered:
 *   the page itself   network first, so a new version is picked up as soon as you are online; cache offline
 *   /assets/*         cache first: these file names contain a hash of their content, so they never change
 *   everything else   cache first, refreshed in the background (stale-while-revalidate)
 * Each deploy has a new VERSION and so a new cache; the previous one is deleted when the new worker activates.
 * Requests to other sites (images linked from a document) are never touched.
 */
const VERSION = "dev"; // replaced at build time
const PRECACHE = [];   // replaced at build time
const CACHE = "mde-" + VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // one missing file must not stop the worker from installing
    await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("mde-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate") { event.respondWith(networkFirst(req)); return; }
  if (/\/assets\//.test(url.pathname)) { event.respondWith(cacheFirst(req)); return; }
  event.respondWith(staleWhileRevalidate(req));
});

async function remember(req, res) {
  if (res && res.ok && res.type === "basic") (await caches.open(CACHE)).put(req, res.clone()).catch(() => {});
  return res;
}
async function networkFirst(req) {
  try { return await remember(req, await fetch(req)); }
  catch { return (await caches.match(req, { ignoreSearch: true })) || (await caches.match("./")) || Response.error(); }
}
async function cacheFirst(req) {
  return (await caches.match(req)) || remember(req, await fetch(req));
}
async function staleWhileRevalidate(req) {
  const hit = await caches.match(req);
  const fresh = fetch(req).then((res) => remember(req, res)).catch(() => null);
  return hit || (await fresh) || Response.error();
}
