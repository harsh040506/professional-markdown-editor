// "Version history" dialog: the earlier saved states of the open file, kept in this browser each time
// a save replaces the file. Restoring puts that text in the editor as an ordinary change, so Undo
// takes it back and nothing is saved until the next save.
import { h, svg } from "../ui/dom.js";
import { dialog, toast } from "../ui/overlay.js";
import { store } from "../storage/store.js";

// Same formatting as the Open dialog (files.js).
function fmtSize(n) { return n < 1024 ? n + " B" : n < 1024 * 1024 ? (n / 1024).toFixed(1) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB"; }
// "Just now", "5 min ago", "3 h ago", "2 d ago"; "" for anything older than a week (the date says it).
function fmtWhen(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  if (s < 7 * 86400) return Math.round(s / 86400) + " d ago";
  return "";
}
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Opens the dialog for `path`. The newest version is selected and previewed at once. Previews load on
 * demand; when the user moves quickly through the list, only the last selection's answer is shown
 * (loadSeq), so a slow earlier response can never replace a newer preview.
 *
 * @param {object} app
 * @param {string} path  the open document's path
 * @param {(markdown: string) => void} onRestore  puts the chosen version into the editor
 */
export async function openHistory(app, path, onRestore) {
  const list = h("div", { class: "file-list history-list", role: "listbox", tabindex: "0", "aria-label": "Saved versions" }, h("div", { class: "file-empty" }, "Loading…"));
  const preview = h("pre", { class: "history-preview", "aria-live": "polite", tabindex: "0", "aria-label": "Version preview" }, "");
  const body = h("div", { class: "file-browser" },
    h("p", { class: "dialog-text" }, "Each save keeps the text it replaces. Pick a version to see it, then restore it into the editor."),
    list, preview);
  let versions = [], active = -1, content = null, loadSeq = 0;
  const d = dialog({
    title: "Version history · " + path.split("/").pop(), body, width: 620, className: "dialog-files dialog-history",
    actions: [
      { label: "Cancel", run: (close) => close() },
      { label: "Restore this version", id: "history-restore", variant: "primary", icon: "History", run: (close) => {
        if (content == null) return;
        const v = versions[active];
        close();
        onRestore(content);
        toast("Restored the version from " + fmtDate(v.at) + ". Save to keep it, or Undo.", { kind: "success", timeout: 6000 });
      } }
    ]
  });
  const restoreBtn = d.el.querySelector("#history-restore");
  restoreBtn.disabled = true;
  preview.hidden = true;

  try { versions = await store.history(path); }
  catch (e) { list.replaceChildren(h("div", { class: "file-empty" }, "Could not load versions: " + e.message)); return; }
  if (!versions.length) {
    list.replaceChildren(h("div", { class: "file-empty" }, "No earlier versions yet. One is kept each time you save changes to this file."));
    return;
  }

  list.textContent = "";
  versions.forEach((v, i) => {
    const ago = fmtWhen(v.at);
    const row = h("button", { class: "file-row", type: "button", role: "option", tabindex: "-1", "aria-selected": "false" },
      h("span", { class: "file-icon" }, svg("History", 16)),
      h("span", { class: "file-main" }, h("span", { class: "file-name" }, fmtDate(v.at)), ago ? h("span", { class: "file-dir" }, ago) : null),
      h("span", { class: "file-meta" }, fmtSize(v.size)));
    row.addEventListener("click", () => select(i));
    list.appendChild(row);
  });

  async function select(i) {
    if (i < 0 || i >= versions.length) return;
    const rows = list.querySelectorAll(".file-row");
    rows.forEach((r, j) => { r.classList.toggle("is-active", j === i); r.setAttribute("aria-selected", String(j === i)); });
    rows[i].scrollIntoView({ block: "nearest" });
    active = i; content = null; restoreBtn.disabled = true;
    preview.hidden = false; preview.textContent = "Loading…";
    const seq = ++loadSeq;
    try {
      const text = await store.version(path, versions[i].id);
      if (seq !== loadSeq) return; // a later choice won
      content = text;
      preview.textContent = content.length > 20000 ? content.slice(0, 20000) + "\n…" : content || "(empty file)";
      restoreBtn.disabled = false;
    } catch (e) {
      if (seq === loadSeq) preview.textContent = "Could not load this version: " + e.message;
    }
  }
  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); select(Math.min(versions.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(Math.max(0, active - 1)); }
    else if (e.key === "Enter" && !restoreBtn.disabled) { e.preventDefault(); restoreBtn.click(); }
  });
  list.focus();
  select(0);
}
