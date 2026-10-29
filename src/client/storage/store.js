/**
 * The app's storage: one object that forwards to the active backend, the browser library by default or
 * a folder on this computer after "Open folder…". Replaces the HTTP API the app used to have; the
 * interface is documented in storage/common.js.
 *
 * Which backend was last used is remembered, so a reload returns to it. A folder handle is kept in the
 * browser's database; after a reload the browser wants the user to confirm access again, which needs a
 * click, so the folder is offered as "Reconnect" (store.pendingFolder) instead of opening silently.
 */
import { LibraryBackend } from "./library.js";
import { FolderBackend } from "./folder.js";
import { getMeta, setMeta, delMeta } from "./idb.js";
import { fail } from "./common.js";

const library = new LibraryBackend();
let backend = library;

export const folderSupported = () => typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

export const store = {
  // The folder remembered from an earlier visit whose access has to be confirmed again: {name, handle, id} or null.
  pendingFolder: null,

  get backend() { return backend; },
  get kind() { return backend.kind; },
  get id() { return backend.id; },
  get rootName() { return backend.rootName; },
  // Everything the UI needs to decide what to offer.
  info() { return { kind: backend.kind, rootName: backend.rootName, canPickFolder: folderSupported(), pendingFolder: this.pendingFolder && this.pendingFolder.name }; },

  /**
   * Start-up: returns to the folder used last time if the browser still allows it without asking; otherwise
   * stays in the library and remembers the folder as pendingFolder. Never throws.
   */
  async restore() {
    try {
      const saved = await getMeta("folder");
      if (!saved || !saved.handle) return;
      const permission = saved.handle.queryPermission ? await saved.handle.queryPermission({ mode: "readwrite" }) : "denied";
      if (permission === "granted") backend = new FolderBackend(saved.handle, saved.id);
      else this.pendingFolder = saved;
    } catch { /* storage unavailable: the library will report it when used */ }
  },

  // Lets the user choose a folder (must run from a click) and switches to it.
  async openFolder() {
    if (!folderSupported()) throw fail(400, "Your browser cannot open folders. Use Chrome, Edge or another Chromium browser, or keep working in the library.");
    let handle;
    try { handle = await window.showDirectoryPicker({ id: "mde-folder", mode: "readwrite" }); }
    catch (e) { if (e && e.name === "AbortError") return false; throw e; }
    const id = "folder-" + crypto.randomUUID().slice(0, 8);
    await setMeta("folder", { id, name: handle.name, handle });
    backend = new FolderBackend(handle, id);
    this.pendingFolder = null;
    return true;
  },

  // Confirms access to the remembered folder (must run from a click) and switches to it.
  async reconnectFolder() {
    const saved = this.pendingFolder;
    if (!saved) return false;
    const b = new FolderBackend(saved.handle, saved.id);
    await b.ensurePermission();
    backend = b;
    this.pendingFolder = null;
    return true;
  },

  // Returns to the browser library. The folder is forgotten (its files are untouched).
  async useLibrary() {
    backend = library;
    this.pendingFolder = null;
    await delMeta("folder").catch(() => {});
  },

  // Asks the browser not to clear this site's data when storage runs low. Best effort, once per visit.
  async requestPersistence() {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* optional */ }
  },
  // {used, quota} in bytes, or null when the browser does not say.
  async usage() {
    try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return null; }
  },

  list: () => backend.list(),
  read: (path) => backend.read(path),
  write: (path, content, baseMtime, force) => backend.write(path, content, baseMtime, force),
  remove: (path) => backend.remove(path),
  history: (path) => backend.history(path),
  version: (path, id) => backend.version(path, id),
  saveAsset: (docPath, name, blob) => backend.saveAsset(docPath, name, blob),
  readAsset: (path) => backend.readAsset(path)
};
