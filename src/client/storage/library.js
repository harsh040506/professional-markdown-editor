/**
 * The browser library: documents and images kept in this browser's IndexedDB. This is the default
 * storage, so the app works everywhere with nothing to set up, and nothing ever leaves the computer.
 *
 * Interface: see storage/common.js. A save and its version are written in one transaction, so a crash
 * or a second tab can never leave one without the other. mtime is the save time in milliseconds, made
 * strictly increasing per file, which is what the conflict check compares.
 *
 * Browsers may clear site data when storage is scarce; store.requestPersistence() asks them not to, and
 * the UI points people at folder mode and at Download for backups.
 */
import { run, wrap } from "./idb.js";
import { snapshot, listVersions, readVersion, dropVersions } from "./versions.js";
import { checkDocPath, dirOf, assetName, fail, friendly, MAX_ASSET } from "./common.js";

const SCOPE = (path) => "library:" + path;

export class LibraryBackend {
  kind = "library";
  id = "library";
  rootName = "Browser library";

  async list() {
    const all = await run(["files"], "readonly", (f) => wrap(f.getAll()));
    return all.map(({ path, size, mtime }) => ({ path, size, mtime }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
  }

  async read(path) {
    const rec = await run(["files"], "readonly", (f) => wrap(f.get(path)));
    if (!rec) throw fail(404, "File not found");
    return { path: rec.path, content: rec.content, mtime: rec.mtime };
  }

  async write(path, content, baseMtime, force = false) {
    const p = checkDocPath(path);
    if (typeof content !== "string") throw fail(400, "Missing content");
    try {
      return await run(["files", "versions"], "readwrite", async (files, versions) => {
        const existing = await wrap(files.get(p));
        if (existing && !force) {
          if (baseMtime == null) throw fail(409, "A file with that name already exists");
          if (existing.mtime !== baseMtime) throw fail(409, "The file changed in another tab");
        }
        if (existing && existing.content !== content) await snapshot(versions, SCOPE(p), existing.content);
        const mtime = Math.max(Date.now(), existing ? existing.mtime + 1 : 0);
        await wrap(files.put({ path: p, content, mtime, size: new Blob([content]).size }));
        return { path: p, mtime };
      });
    } catch (e) { throw friendly(e); }
  }

  async remove(path) {
    await run(["files", "versions"], "readwrite", async (files, versions) => {
      await wrap(files.delete(path));
      await dropVersions(versions, SCOPE(path));
    });
  }

  history(path) { return run(["versions"], "readonly", (v) => listVersions(v, SCOPE(path))); }
  version(path, id) { return run(["versions"], "readonly", (v) => readVersion(v, SCOPE(path), id)); }

  // Stores an image next to the document, in assets/. The returned src is relative to the document.
  async saveAsset(docPath, givenName, blob) {
    if (blob.size > MAX_ASSET) throw fail(413, "Images can be at most 25 MB");
    if (!blob.size) throw fail(400, "The image is empty");
    const dir = dirOf(docPath) ? dirOf(docPath) + "/assets/" : "assets/";
    try {
      return await run(["assets"], "readwrite", async (assets) => {
        const name = await assetName(givenName, blob.type, async (n) => !!(await wrap(assets.getKey(dir + n))));
        await wrap(assets.put({ path: dir + name, blob }));
        return "assets/" + encodeURIComponent(name);
      });
    } catch (e) { throw friendly(e); }
  }

  async readAsset(path) {
    const rec = await run(["assets"], "readonly", (a) => wrap(a.get(path)));
    return rec ? rec.blob : null;
  }
}
