/**
 * Saved versions, shared by both backends. Before a save replaces a document, the text that was there is
 * kept as a version, so any earlier state can be brought back without a version-control system.
 *
 * A version belongs to a "scope" ("<backend id>:<path>"): the library keeps its own, and each opened
 * folder has its own, so two documents with the same path in different places never mix. The newest
 * KEEP_VERSIONS are kept. Renaming a document starts a new history, because versions are keyed by path.
 */
import { wrap } from "./idb.js";
import { KEEP_VERSIONS, fail } from "./common.js";

const SEP = "\u0000";

/**
 * Keeps `content` as the newest version of `scope`, unless it already is. Must be called with the
 * "versions" object store of a readwrite transaction, so the save and its version commit together.
 */
export async function snapshot(versions, scope, content) {
  const all = await wrap(versions.index("scope").getAll(scope));
  all.sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1));
  if (all[0] && all[0].content === content) return;
  const at = Math.max(Date.now(), all[0] ? all[0].at + 1 : 0);
  await wrap(versions.put({ key: scope + SEP + at, scope, id: String(at), at, size: new Blob([content]).size, content }));
  for (const old of all.slice(KEEP_VERSIONS - 1)) await wrap(versions.delete(old.key));
}

// Versions of a document, newest first, without their text.
export async function listVersions(versions, scope) {
  const all = await wrap(versions.index("scope").getAll(scope));
  return all.sort((a, b) => b.at - a.at).map(({ id, at, size }) => ({ id, at, size }));
}

// The text of one version.
export async function readVersion(versions, scope, id) {
  if (typeof id !== "string" || !/^\d{10,16}$/.test(id)) throw fail(400, "Unknown version");
  const rec = await wrap(versions.get(scope + SEP + id));
  if (!rec) throw fail(404, "That version no longer exists");
  return rec.content;
}

// Removes every version of a document (when the document is deleted).
export async function dropVersions(versions, scope) {
  const keys = await wrap(versions.index("scope").getAllKeys(scope));
  for (const k of keys) await wrap(versions.delete(k));
}
