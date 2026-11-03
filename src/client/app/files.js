/**
 * "Open" dialog: the Markdown documents in the current storage (the browser library, or the opened
 * folder and its subfolders), with search.
 * Keyboard: type to filter (any part of the path), arrows to move, Enter to open. Rows show the file
 * name, its folder, and when it was last changed and how big it is. Library documents can be deleted
 * (a folder's files are never deleted from here).
 * The footer buttons switch between the library, a folder on this computer, and a single file from disk.
 */
import { h, svg, load, save } from "../ui/dom.js";
import { dialog, toast, confirmDialog, segmented } from "../ui/overlay.js";
import { store } from "../storage/store.js";

// 1536 -> "1.5 KB".
function fmtSize(n) { return n < 1024 ? n + " B" : n < 1024 * 1024 ? (n / 1024).toFixed(1) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB"; }
// Time today ("3:41 PM"), else the date, with the year only for other years.
function fmtTime(ms) {
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

// Opens the dialog; choosing a file calls app.openPath (which asks about unsaved changes first).
export async function openFileBrowser(app) {
  const info = store.info();
  const inFolder = info.kind === "folder";
  const search = h("input", { class: "input", type: "text", placeholder: "Search documents", spellcheck: "false", autocomplete: "off", autofocus: true });
  const list = h("div", { class: "file-list", role: "listbox", tabindex: "0", "aria-label": "Documents" }, h("div", { class: "file-empty" }, "Loading…"));
  const where = h("span", null, inFolder ? "Folder: " + info.rootName : "Saved in this browser only. Nothing is uploaded.");
  const usage = h("span", { class: "file-usage" });
  // Sort order, remembered across visits: by name (folders grouped) or most recently changed first.
  let sort = load("files-sort", "name") === "recent" ? "recent" : "name";
  const sorter = segmented([{ value: "name", label: "Name" }, { value: "recent", label: "Recent" }], sort, (v) => { sort = v; save("files-sort", v); active = 0; render(); }, { label: "Sort by", small: true });
  const body = h("div", { class: "file-browser" },
    h("div", { class: "file-search-row" }, h("div", { class: "file-search" }, svg("Search", 16), search), sorter.el),
    list,
    h("div", { class: "file-root" }, svg(inFolder ? "Folder" : "File", 14), where, usage));

  const actions = [];
  const go = (fn) => (close) => { close(); fn(); };
  if (info.pendingFolder) actions.push({ label: "Reconnect “" + info.pendingFolder + "”", icon: "Folder", variant: "primary", run: go(() => app.reconnectFolder()) });
  if (info.canPickFolder) actions.push({ label: inFolder ? "Open another folder…" : "Open folder…", icon: "Folder", run: go(() => app.openFolder()) });
  if (inFolder) actions.push({ label: "Browser library", icon: "File", run: go(() => app.useLibrary()) });
  actions.push({ label: "Open file from computer…", icon: "Import", run: go(() => app.openLocalFile()) });
  const d = dialog({ title: "Open", body, width: 600, className: "dialog-files", actions });

  let files = [], shown = [], active = 0, loaded = false;
  // Lists the documents; on failure (folder permission withdrawn, storage unavailable) says why and offers
  // to try again, instead of leaving an empty dialog.
  async function loadFiles() {
    list.replaceChildren(h("div", { class: "file-empty" }, "Loading…"));
    try { files = await store.list(); loaded = true; }
    catch (e) {
      const retry = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Try again");
      retry.addEventListener("click", loadFiles);
      list.replaceChildren(h("div", { class: "file-empty" }, h("div", null, "Could not list documents: " + e.message), h("div", { style: { marginTop: "10px" } }, retry)));
      return;
    }
    render();
  }
  store.usage().then((u) => { if (u && !inFolder) usage.textContent = fmtSize(u.used) + " used"; });

  function render() {
    if (!loaded) return;
    const q = search.value.trim().toLowerCase();
    // every word must appear somewhere in the path, in any order ("week notes" finds "notes/week1.md")
    const words = q.split(/\s+/).filter(Boolean);
    shown = files.filter((f) => { const p = f.path.toLowerCase(); return words.every((w) => p.includes(w)); });
    if (sort === "recent") shown.sort((a, b) => b.mtime - a.mtime);
    where.textContent = (inFolder ? "Folder: " + info.rootName : "Saved in this browser only. Nothing is uploaded.") + " · " + files.length + (files.length === 1 ? " document" : " documents");
    list.textContent = "";
    if (!shown.length) {
      list.appendChild(h("div", { class: "file-empty" }, q ? "No documents match “" + search.value + "”"
        : inFolder ? "No Markdown files in this folder yet" : "No saved documents yet. Press Ctrl+S (⌘S on a Mac) to save the current one here, or open a file from your computer."));
      return;
    }
    active = Math.min(active, shown.length - 1);
    shown.forEach((f, i) => {
      const parts = f.path.split("/");
      const name = parts.pop();
      const row = h("button", { class: "file-row" + (i === active ? " is-active" : ""), type: "button", role: "option", tabindex: "-1" },
        h("span", { class: "file-icon" }, svg("File", 16)),
        h("span", { class: "file-main" }, h("span", { class: "file-name" }, name.replace(/\.(md|markdown)$/i, "")), parts.length ? h("span", { class: "file-dir" }, parts.join(" / ")) : null),
        h("span", { class: "file-meta" }, fmtTime(f.mtime) + " · " + fmtSize(f.size)));
      row.addEventListener("click", () => choose(f));
      row.addEventListener("pointermove", () => setActive(i));
      const item = h("div", { class: "file-item" }, row);
      if (!inFolder) {
        const del = h("button", { class: "icon-btn file-del", type: "button", "aria-label": "Delete " + name, "data-tip": "Delete from this browser" }, svg("Delete", 15));
        del.addEventListener("click", () => remove(f));
        item.appendChild(del);
      }
      list.appendChild(item);
    });
  }
  function setActive(i) {
    const rows = list.querySelectorAll(".file-row");
    rows[active] && rows[active].classList.remove("is-active");
    active = i;
    rows[active] && rows[active].classList.add("is-active");
    rows[active] && rows[active].scrollIntoView({ block: "nearest" });
  }
  function choose(f) { d.close(); app.openPath(f.path); }
  async function remove(f) {
    const ok = await confirmDialog({ title: "Delete document?", message: "“" + f.path + "” and its saved versions will be removed from this browser. You can undo right after, but not once you leave this page.", confirm: "Delete", danger: true });
    if (!ok) return;
    try {
      // keep the text so the deletion can be undone from the toast (the version history cannot be brought back)
      const { content } = await store.read(f.path);
      await store.remove(f.path);
      files = files.filter((x) => x.path !== f.path);
      app.onFileRemoved && app.onFileRemoved(f.path);
      render();
      toast("Deleted “" + f.path + "”.", { timeout: 10000, action: { label: "Undo", run: async () => {
        try {
          const r = await store.write(f.path, content, null);
          files = [...files, { path: f.path, size: f.size, mtime: r.mtime }].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
          if (list.isConnected) render();
          toast("Restored “" + f.path + "”.", { kind: "success" });
        } catch (e) { toast("Could not restore: " + e.message, { kind: "error", timeout: 6000 }); }
      } } });
    }
    catch (e) { toast("Could not delete: " + e.message, { kind: "error" }); }
  }
  search.addEventListener("input", () => { active = 0; render(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(shown.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)); }
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); choose(shown[active]); }
  });
  await loadFiles();
}
