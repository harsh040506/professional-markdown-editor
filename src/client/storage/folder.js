/**
 * Folder mode: edit a real folder of Markdown files on this computer, through the browser's File System
 * Access API (Chrome, Edge, Opera and other Chromium browsers; Firefox and Safari do not offer it).
 * The folder is chosen by the user in the browser's own picker, and the browser asks for permission; the
 * app can touch nothing outside that folder. Nothing is uploaded.
 *
 * Interface: see storage/common.js. Differences from the library:
 *   - mtime is the file's lastModified, so changes made by other programs are detected on save (409)
 *   - versions are still kept in the browser's database (the folder stays free of extra files), keyed by
 *     the folder's id, so each folder has its own history
 *   - images are written to assets/ next to the document, as ordinary files
 * Hidden entries (names starting with ".") and dependency/build folders are never listed, read or written.
 *
 * The constructor takes any FileSystemDirectoryHandle, including the origin-private one from
 * navigator.storage.getDirectory(), which is how the tests exercise this class in a headless browser.
 */
import { run } from "./idb.js";
import { snapshot, listVersions, readVersion, dropVersions } from "./versions.js";
import { checkDocPath, dirOf, baseOf, assetName, fail, friendly, MD_EXT, SKIP_DIRS, MAX_FILE, MAX_ASSET } from "./common.js";

const SCOPE = (id, path) => id + ":" + path;

export class FolderBackend {
  kind = "folder";
  constructor(handle, id) {
    this.handle = handle;
    this.id = id;
    this.rootName = handle.name || "Folder";
  }

  // Makes sure the browser lets us write to the folder. After a reload the permission has to be granted
  // again, and asking requires a click, so this can fail with 403 when called without one.
  async ensurePermission() {
    if (!this.handle.queryPermission) return true;
    const opts = { mode: "readwrite" };
    if ((await this.handle.queryPermission(opts)) === "granted") return true;
    if ((await this.handle.requestPermission(opts)) === "granted") return true;
    throw fail(403, "Permission to use the folder was not given");
  }

  // The directory handle for a "/"-separated folder path below the root ("" is the root itself).
  async dir(path, create = false) {
    let d = this.handle;
    for (const part of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
    return d;
  }
  async fileHandle(path, create = false) {
    const d = await this.dir(dirOf(path), create);
    return d.getFileHandle(baseOf(path), { create });
  }

  async list() {
    await this.ensurePermission();
    const out = [];
    const visit = async (dir, prefix, depth) => {
      if (depth > 8 || out.length > 5000) return;
      for await (const [name, h] of dir.entries()) {
        if (name.startsWith(".")) continue;
        if (h.kind === "directory") { if (!SKIP_DIRS.has(name)) await visit(h, prefix + name + "/", depth + 1); }
        else if (MD_EXT.test(name)) {
          try { const f = await h.getFile(); out.push({ path: prefix + name, size: f.size, mtime: f.lastModified }); } catch { /* removed while listing */ }
        }
      }
    };
    await visit(this.handle, "", 0);
    return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
  }

  async read(path) {
    const p = checkDocPath(path);
    await this.ensurePermission();
    try {
      const f = await (await this.fileHandle(p)).getFile();
      if (f.size > MAX_FILE) throw fail(413, "The file is too large to open (over 50 MB)");
      return { path: p, content: await f.text(), mtime: f.lastModified };
    } catch (e) { throw friendly(e); }
  }

  async write(path, content, baseMtime, force = false) {
    const p = checkDocPath(path);
    if (typeof content !== "string") throw fail(400, "Missing content");
    await this.ensurePermission();
    try {
      let previous = null;
      try {
        const f = await (await this.fileHandle(p)).getFile();
        if (!force) {
          if (baseMtime == null) throw fail(409, "A file with that name already exists");
          if (Math.abs(f.lastModified - baseMtime) > 1) throw fail(409, "The file changed on disk");
        }
        previous = await f.text();
      } catch (e) { if (e.status) throw e; /* a new file */ }
      if (previous != null && previous !== content) {
        // a failure to keep the version must not block the save
        await run(["versions"], "readwrite", (v) => snapshot(v, SCOPE(this.id, p), previous)).catch(() => {});
      }
      const w = await (await this.fileHandle(p, true)).createWritable();
      await w.write(content);
      await w.close(); // the file is replaced only now, so a crash never leaves half a document
      const f = await (await this.fileHandle(p)).getFile();
      return { path: p, mtime: f.lastModified };
    } catch (e) { throw friendly(e); }
  }

  async remove(path) {
    await this.ensurePermission();
    const d = await this.dir(dirOf(path));
    await d.removeEntry(baseOf(path));
    await run(["versions"], "readwrite", (v) => dropVersions(v, SCOPE(this.id, path)));
  }

  history(path) { return run(["versions"], "readonly", (v) => listVersions(v, SCOPE(this.id, path))); }
  version(path, id) { return run(["versions"], "readonly", (v) => readVersion(v, SCOPE(this.id, path), id)); }

  async saveAsset(docPath, givenName, blob) {
    if (blob.size > MAX_ASSET) throw fail(413, "Images can be at most 25 MB");
    if (!blob.size) throw fail(400, "The image is empty");
    await this.ensurePermission();
    try {
      const dir = await this.dir(dirOf(docPath) ? dirOf(docPath) + "/assets" : "assets", true);
      const name = await assetName(givenName, blob.type, async (n) => {
        try { await dir.getFileHandle(n); return true; } catch { return false; }
      });
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(blob);
      await w.close();
      return "assets/" + encodeURIComponent(name);
    } catch (e) { throw friendly(e); }
  }

  async readAsset(path) {
    try {
      if (path.split("/").some((s) => !s || s === ".." || s.startsWith("."))) return null;
      return await (await this.fileHandle(path)).getFile();
    } catch { return null; }
  }
}
