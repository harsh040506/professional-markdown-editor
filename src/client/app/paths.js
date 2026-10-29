/**
 * Document-relative paths in the browser. Markdown refers to images and other documents relative to
 * the file that mentions them ("assets/pic.png", "../notes.md"); storage wants paths relative to its
 * root (the library or the opened folder). These helpers do that resolution with "/" separators on every
 * OS. No DOM is used here, so the functions are unit-tested in Node (test/paths.mjs).
 */
// The open file's path relative to the storage root (null for an untitled document). Set by the shell
// whenever the document changes; read by assets.js to show images.
let currentFile = null;
export function setCurrentFile(p) { currentFile = p; }
export function getCurrentFile() { return currentFile; }

// Folder part of a "/"-separated path: dirname("a/b/c.md") === "a/b", dirname("c.md") === "".
export function dirname(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
/**
 * Joins and normalises "/"-separated paths, resolving "." and "..".
 * ".." above the top is dropped rather than kept (joinPath("", "../x") === "x"), so a path can never
 * point outside the storage root.
 * @example joinPath("notes/week1", "../assets/a.png") === "notes/assets/a.png"
 */
export function joinPath(dir, rel) {
  const parts = (dir ? dir.split("/") : []).concat(rel.split("/"));
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return out.join("/");
}

/**
 * Whether a link target is safe to open from the editor: relative paths, #anchors, and the http(s),
 * mailto and tel schemes. Everything else, notably javascript:, data: and vbscript:, is refused.
 *
 * Why: a link can enter the document without passing markdown-it's link validation, by pasting HTML
 * from a web page or typing it into the link dialog. Opening a javascript: URL from this page would run
 * it with the editor's origin, which can read and write this browser's stored documents.
 * Leading whitespace and control characters are ignored, as browsers ignore them when parsing a URL.
 *
 * @param {string} href
 * @returns {boolean}
 * @example isSafeHref("https://example.com") === true; isSafeHref(" JavaScript:alert(1)") === false
 */
export function isSafeHref(href) {
  const s = String(href || "").replace(/[\u0000-\u0020]+/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  return !scheme || /^(https?|mailto|tel)$/i.test(scheme[1]);
}
