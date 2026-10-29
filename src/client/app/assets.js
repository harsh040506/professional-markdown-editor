/**
 * Images that live in storage (the library or the opened folder) rather than on the web.
 *
 * A document refers to them by a path relative to itself ("assets/pic.png"); the editor and the exporters
 * turn that into something a browser can show or embed:
 *   resolveSrc(src)            for the editor: a URL string at once for web/data/blob sources, otherwise a
 *                              Promise of a blob: URL (null when the image is missing)
 *   loadLocalImage(src, doc)   for the exporters: the image as a Blob, or null
 * Object URLs are cached per storage + path, so scrolling a long document does not read the database again.
 */
import { store } from "../storage/store.js";
import { IMAGE_TYPE } from "../storage/common.js";
import { getCurrentFile, joinPath, dirname } from "./paths.js";

// Sources the browser can load by itself: web, data, blob and site-absolute URLs.
export const isDirectSrc = (src) => /^(https?:|data:|blob:|\/)/i.test(src);

const cache = new Map(); // "<backend id>:<path>" -> Promise<string|null>

// The storage path an image src points to, resolved against the document it appears in.
function storagePath(src, docPath) {
  try { return joinPath(dirname(docPath), decodeURIComponent(src.split(/[?#]/)[0])); } catch { return null; }
}

// Reads an image from storage with a usable MIME type (folder files come back untyped).
async function readTyped(path) {
  const blob = await store.readAsset(path);
  if (!blob) return null;
  const type = IMAGE_TYPE[(/\.[^./]+$/.exec(path) || [""])[0].toLowerCase()];
  return blob.type || !type ? blob : new Blob([blob], { type });
}

/**
 * URL for showing an image in the editor. The document keeps `src` unchanged; only the <img> uses the result.
 * Untitled documents have no folder, so relative paths cannot be resolved: they resolve to null (shown as a
 * broken-image placeholder) rather than being requested from the website, where they would only 404.
 * @returns {string|Promise<string|null>}
 */
export function resolveSrc(src) {
  if (!src) return "";
  if (isDirectSrc(src)) return src;
  const doc = getCurrentFile();
  if (!doc) return Promise.resolve(null);
  const path = storagePath(src, doc);
  if (!path) return Promise.resolve(null);
  const key = store.id + ":" + path;
  if (!cache.has(key)) cache.set(key, readTyped(path).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null));
  return cache.get(key);
}

// Forgets a cached image (after it was replaced or removed), so the next request reads it again.
export function forgetAssets() {
  for (const p of cache.values()) p.then((u) => u && URL.revokeObjectURL(u));
  cache.clear();
}

/** An image of the document at `docPath`, from storage. Used by the exporters. */
export async function loadLocalImage(src, docPath) {
  const path = storagePath(src, docPath || "");
  return path ? readTyped(path).catch(() => null) : null;
}
