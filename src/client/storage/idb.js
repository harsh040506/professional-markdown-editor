/**
 * A small promise wrapper over IndexedDB, the browser's built-in database. One database ("mde") holds:
 *   files     the library's documents            key: path
 *   versions  earlier texts of any document      key: "<scope>\0<id>", index "scope" (= "<backend id>:<path>")
 *   assets    the library's images               key: path
 *   meta      small records, such as the remembered folder handle     key: key
 * The database is opened once and shared. It is created on first use and never needs a server.
 */
const NAME = "mde", VERSION = 1;
let opening = null;

export function openDB() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("This browser does not provide IndexedDB storage (private mode?).")); return; }
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("files", { keyPath: "path" });
        db.createObjectStore("versions", { keyPath: "key" }).createIndex("scope", "scope");
        db.createObjectStore("assets", { keyPath: "path" });
        db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => {
        // another tab upgrading or deleting the database: close so it is not blocked, reopen on next use
        req.result.onversionchange = () => { req.result.close(); opening = null; };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("The database is open in an older tab. Close other tabs of this app and reload."));
    }).catch((e) => { opening = null; throw e; });
  }
  return opening;
}

// An IDBRequest as a promise.
export const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/**
 * Runs `fn` inside one transaction over `stores` and resolves with its result once the transaction has
 * committed. `fn` receives the object stores (in the order given) and may await requests made through
 * wrap(); awaiting anything else would let the transaction close early. If `fn` throws, the transaction
 * is rolled back.
 *
 * @example await run(["files"], "readwrite", (files) => wrap(files.put({ path, content })));
 */
export async function run(stores, mode, fn) {
  const db = await openDB();
  const tx = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("The database transaction was cancelled"));
  });
  done.catch(() => {}); // surfaced through the await below; avoids an unhandled-rejection report
  let result;
  try { result = await fn(...stores.map((s) => tx.objectStore(s))); }
  catch (e) { try { tx.abort(); } catch { /* already finished */ } throw e; }
  await done;
  return result;
}

// meta records.
export const getMeta = (key) => run(["meta"], "readonly", (m) => wrap(m.get(key))).then((r) => (r ? r.value : null));
export const setMeta = (key, value) => run(["meta"], "readwrite", (m) => wrap(m.put({ key, value })));
export const delMeta = (key) => run(["meta"], "readwrite", (m) => wrap(m.delete(key)));
