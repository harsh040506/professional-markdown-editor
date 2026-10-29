/**
 * Shared rules for the storage backends (library.js: browser database, folder.js: a real folder).
 *
 * Both backends offer the same interface, so the rest of the app never knows where a document lives:
 *   kind, id, rootName
 *   list()                                  [{path, size, mtime}], sorted by path
 *   read(path)                              {path, content, mtime}
 *   write(path, content, baseMtime, force)  {path, mtime}; rejects with status 409 when the file changed
 *                                           since baseMtime (or exists, when baseMtime is null) unless force
 *   remove(path)
 *   history(path) / version(path, id)       earlier saved texts, newest first / one version's text
 *   saveAsset(docPath, name, blob)          stores an image beside the document, returns its relative src
 *   readAsset(path)                         the image as a Blob, or null
 * Paths are relative to the backend's root, with "/" separators on every OS.
 *
 * Errors carry an HTTP-style `status` (404 missing, 409 conflict, 400 bad input, 413 too large, 507 full)
 * so the shell can react without knowing which backend failed.
 */
export const TEXT_EXT = /\.(md|markdown|txt)$/i;
export const MD_EXT = /\.(md|markdown)$/i;
// Image types the editor can store, and the extension used for each (taken from the type, never from the
// uploaded name, so "x.exe" sent as a PNG is stored as x.png).
export const IMAGE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif", "image/svg+xml": ".svg", "image/bmp": ".bmp" };
export const IMAGE_TYPE = Object.fromEntries(Object.entries(IMAGE_EXT).map(([t, e]) => [e, t]).concat([[".jpeg", "image/jpeg"]]));
export const MAX_FILE = 50 * 1024 * 1024;   // largest document that is opened
export const MAX_ASSET = 25 * 1024 * 1024;  // largest image that is stored
export const KEEP_VERSIONS = 50;            // versions kept per file; the oldest are dropped first
// Folders that are never listed: dependencies, build output and tool folders. Hidden (dot) entries are skipped too.
export const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".cache", "__pycache__", "venv"]);

// An Error with an HTTP-style status, see above.
export const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Checks a document path before it is read or written. Returns the path with "/" separators, or throws
 * a 400 error. Rejects: empty or very long paths, NUL, "..", absolute paths, hidden parts (".git",
 * ".env" …), characters that are not valid in file names on some systems, and non-text extensions.
 */
export function checkDocPath(path) {
  if (typeof path !== "string" || !path || path.length > 1024 || path.includes("\0")) throw fail(400, "Enter a file name");
  const clean = path.replace(/\\/g, "/");
  if (/^\/|^[A-Za-z]:/.test(clean)) throw fail(400, "Use a path inside the folder, without a leading / or drive letter");
  const parts = clean.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) throw fail(400, "Use a path inside the folder (no empty parts, ./ or ../)");
  if (parts.some((p) => p.startsWith("."))) throw fail(400, "Names that start with a dot are not allowed");
  if (/[<>:"|?*\x00-\x1f]/.test(clean)) throw fail(400, "The file name contains characters that are not allowed (< > : \" | ? *)");
  if (!TEXT_EXT.test(clean)) throw fail(400, "Save as a .md, .markdown or .txt file");
  return clean;
}

// Path helpers ("/" separators).
export const dirOf = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
export const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * File name for a new image: the uploaded name reduced to safe characters, plus the extension that
 * belongs to its type. `taken(name)` says whether a name is already used; the first free "-2", "-3" … wins.
 * @returns {Promise<string>}
 */
export async function assetName(givenName, type, taken) {
  const ext = IMAGE_EXT[String(type).toLowerCase()];
  if (!ext) throw fail(400, "Only PNG, JPEG, GIF, WebP, AVIF, SVG and BMP images can be added");
  const stem = (String(givenName || "image").replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "image").slice(0, 60);
  let name = stem + ext, n = 1;
  while (await taken(name)) { if (++n > 999) throw fail(409, "Too many images with that name"); name = `${stem}-${n}${ext}`; }
  return name;
}

// Turns a storage failure into a message people can act on (a full disk is the one worth naming).
export function friendly(e) {
  if (e && e.status) return e;
  if (e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""))) return fail(507, "Browser storage is full. Download your documents (Export → Markdown) and free some space.");
  if (e && e.name === "NotAllowedError") return fail(403, "The browser no longer allows access to this folder. Open it again.");
  if (e && e.name === "NotFoundError") return fail(404, "File not found");
  return e;
}
