/**
 * App shell: toolbar, document lifecycle (open, save, drafts, versions), settings, menus, drag and
 * drop, the context menu and start-up.
 *
 * State lives in three module-level objects:
 *   settings  editor preferences (theme, fonts, page width, spell check), kept in localStorage
 *   doc       the open document's identity and save state (see the field comments below)
 *   app       the command object shared with the editor plugins and dialogs: app.save(), app.openPath(),
 *             app.editLink() …
 * Documents live in storage/store.js: the browser library by default, or a folder on this computer.
 *
 * Document lifecycle and data-safety rules:
 *   - Every change is kept as a browser draft ~600 ms after typing stops (storeDraft), so closing the
 *     tab or a crash loses nothing. Opening the file again offers to restore it.
 *   - "dirty" is set at once on any change and confirmed (by comparing the Markdown with the saved
 *     text) after a pause, because serializing a large document on every keystroke is too slow.
 *   - Saves send the file's mtime from when it was loaded; storage answers 409 if the file changed
 *     since (another tab, or another program in folder mode), and the user chooses whether to
 *     overwrite. The replaced text is kept as a version either way (Version history…).
 *   - Leaving a file with unsaved changes asks first; untitled drafts never ask (they stay as drafts).
 */
import { TextSelection, NodeSelection, AllSelection } from "prosemirror-state";
import { undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import { h, svg, $, debounce, load, save as saveLocal, MOD } from "../ui/dom.js";
import { menuFromButton, toast, confirmDialog, promptDialog, closeAllPopovers, openPopover, buildMenu } from "../ui/overlay.js";
import { createEditor, createState, getMarkdown } from "../editor/editor.js";
import { detailsKey } from "../editor/details-plugin.js";
import { insertItems, TURN_INTO, turnIntoRun } from "../editor/blocks.js";
import * as C from "../editor/commands.js";
import { schema } from "../schema.js";
import { store } from "../storage/store.js";
import { FolderBackend } from "../storage/folder.js";
import { LibraryBackend } from "../storage/library.js";
import { setCurrentFile, dirname, joinPath, isSafeHref } from "./paths.js";
import { forgetAssets } from "./assets.js";
import { openFileBrowser } from "./files.js";
import { openExportDialog, exportMarkdown } from "./exporter.js";
import { openLinkEditor, showShortcuts, imageFromFile } from "./dialogs.js";
import { openHistory } from "./history.js";
import { looksLikeMarkdown } from "../editor/plugins.js";
import { parseMarkdown } from "../markdown.js";
import { Slice } from "prosemirror-model";
import { SAMPLE } from "./sample.js";

const N = schema.nodes;
const REPO_URL = "https://github.com/harsh040506/professional-markdown-editor";

// Editor preferences. Defaults first, then whatever was saved, so new settings get a default.
const settings = Object.assign({ theme: "system", headingFont: "serif", textFont: "sans", wide: false, spellcheck: true }, load("settings", {}));
function saveSettings() { saveLocal("settings", settings); }

const doc = {
  path: null,          // path in the current storage, or null for an untitled/local doc
  name: "Untitled",    // file name for downloads
  mtime: null,         // storage mtime when loaded (conflict check)
  savedMarkdown: "",   // what is stored, as the editor would write it (the baseline for "dirty")
  dirty: false         // the editor's Markdown differs from savedMarkdown
};

// The one EditorView for the page's lifetime (documents are swapped by replacing its state).
let view = null;
const app = {};

/* ---------- theme ---------- */
// "system" follows the OS setting live. The theme is set as data-theme on <html>; tokens.css does the rest.
// public/index.html applies the saved theme before the first paint, so there is no flash.
const mq = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const t = settings.theme === "system" ? (mq.matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = t;
}
mq.addEventListener("change", applyTheme);

// Applies the document-related settings to the page and the editor.
function applyDocSettings() {
  const page = $("#page");
  page.classList.toggle("is-wide", !!settings.wide);
  view.dom.dataset.headingFont = settings.headingFont;
  view.dom.dataset.textFont = settings.textFont;
  view.dom.setAttribute("spellcheck", String(!!settings.spellcheck));
  updateLarge();
}
// On very long documents (1500+ top-level blocks) data-large turns on content-visibility: auto for each
// block (ui.css), so the browser skips layout and painting of blocks far off screen.
function updateLarge() { view.dom.toggleAttribute("data-large", view.state.doc.childCount > 1500); }

/* ---------- title ---------- */
// The document's title: its first heading if it starts with one, else the file name without extension.
function docTitle() {
  const first = view.state.doc.firstChild;
  if (first && first.type === N.heading && first.textContent.trim()) return first.textContent.trim();
  return doc.path ? doc.path.split("/").pop().replace(/\.(md|markdown|txt)$/i, "") : doc.name.replace(/\.(md|markdown|txt)$/i, "");
}
// Base name for downloads and exports: the file name, or for an untitled document its title with
// characters that are invalid in file names removed.
function fileBase() {
  if (doc.path) return doc.path.split("/").pop().replace(/\.(md|markdown|txt)$/i, "");
  const t = docTitle() || "Untitled";
  return t.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
}
// Updates the toolbar title, the tab title ("• " marks unsaved changes) and the save-state label.
function refreshTitle() {
  const t = docTitle() || "Untitled";
  $("#doc-title-text").textContent = t;
  document.title = (doc.dirty ? "• " : "") + t + " — Professional Markdown Editor";
  const st = $("#save-state");
  if (!doc.path) { st.textContent = doc.dirty ? "Draft" : ""; st.dataset.state = doc.dirty ? "draft" : ""; }
  else { st.textContent = doc.dirty ? "Unsaved changes" : "Saved"; st.dataset.state = doc.dirty ? "dirty" : "saved"; }
  st.dataset.tip = doc.path ? (doc.dirty ? "Press " + MOD + "+S to save " + doc.path : "Saved to " + doc.path) : "Kept in this browser until you save it as a file";
}

/* ---------- drafts: every change is kept in the browser, so nothing is lost ---------- */
// One draft per file path (plus one for the untitled document), in localStorage under "mde:draft:…".
// Holds the Markdown, when it was stored, and the file's mtime it was based on. Paths are per storage, so
// a folder's "notes.md" and the library's "notes.md" have separate drafts.
const draftKey = () => "draft:" + (doc.path ? store.id + ":" + doc.path : "untitled");
const storeDraft = debounce(() => {
  if (!view) return;
  if (doc.dirty) saveLocal(draftKey(), { markdown: getMarkdown(view), at: Date.now(), base: doc.mtime });
  else saveLocal(draftKey(), null);
}, 600);

// Word count and reading time (230 words per minute) in the corner. Words are runs of letters/digits
// in any script, so the count works for non-English text too.
const updateCount = debounce(() => {
  const text = view.state.doc.textBetween(0, view.state.doc.content.size, " ", " ");
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
  $("#word-count").textContent = words.toLocaleString() + " words";
  $("#word-count").dataset.tip = Math.max(1, Math.round(words / 230)) + " min read · " + text.length.toLocaleString() + " characters";
}, 400);

// Comparing the whole document with the saved text is too slow per keystroke on big files:
// mark dirty at once, then confirm after a pause in typing.
const checkDirty = debounce(() => {
  const dirty = getMarkdown(view) !== doc.savedMarkdown;
  if (dirty !== doc.dirty) { doc.dirty = dirty; refreshTitle(); }
  storeDraft();
}, 700);
// Called by the editor (editor.js dispatchTransaction) after every document change.
app.onDocChange = () => {
  if (!doc.dirty) { doc.dirty = true; refreshTitle(); }
  checkDirty();
  if (view.state.doc.childCount > 1400 && view.state.doc.childCount < 1600) updateLarge();
  updateCount();
  updateUndo();
};
// Called after every selection change; nothing in the shell needs it at the moment.
app.onSelectionChange = () => {};

// Enables or disables the toolbar's undo/redo buttons.
function updateUndo() {
  $("#btn-undo").disabled = !undoDepth(view.state);
  $("#btn-redo").disabled = !redoDepth(view.state);
}

/* ---------- loading documents ---------- */
/**
 * Loads a document into the editor (new state: fresh undo history, plugins and node views).
 *
 * @param {string} markdown  the text to edit
 * @param {{path?: string|null, name?: string, mtime?: number|null, savedMarkdown?: string|null}} meta
 *        savedMarkdown: what counts as "saved". null means "the text just loaded", normalised through
 *        the editor (parse + serialize) so a file that the editor would write slightly differently does
 *        not appear modified the moment it is opened. "" makes an untitled draft count as unsaved.
 */
function setDocument(markdown, meta) {
  Object.assign(doc, { path: null, name: "Untitled.md", mtime: null }, meta);
  setCurrentFile(doc.path);
  doc.savedMarkdown = meta.savedMarkdown != null ? meta.savedMarkdown : markdown;
  closeAllPopovers("doc");
  view.updateState(createState(markdown, app));
  applyDocSettings();
  // normalise: what the editor would save is the baseline for "unsaved changes"
  const normal = getMarkdown(view);
  if (meta.savedMarkdown == null) doc.savedMarkdown = normal;
  doc.dirty = normal !== doc.savedMarkdown;
  refreshTitle(); updateCount(); updateUndo();
  saveLocal("last", { path: doc.path, store: store.id });
  $("#scroller").scrollTop = 0;
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).setMeta("pointer", true));
}

// Asks before leaving a file with unsaved changes. Resolves true when it is fine to continue.
async function confirmDiscard() {
  if (!doc.dirty) return true;
  if (!doc.path) return true; // untitled drafts stay in the browser
  return confirmDialog({ title: "Discard unsaved changes?", message: "“" + doc.path + "” has changes that are not saved. They are kept as a draft in this browser.", confirm: "Discard", danger: true });
}

/**
 * Opens a document from the current storage. If a browser draft of it differs from what is stored,
 * a toast offers to restore it (the draft is applied as a change, so it is marked unsaved).
 * Errors (missing file, storage unavailable) are shown as a toast and leave the current document open.
 * @param {string} path  relative to the storage root
 * @param {{skipConfirm?: boolean}} [options]  skip the unsaved-changes question (used at start-up)
 */
app.openPath = async (path, { skipConfirm = false } = {}) => {
  if (!skipConfirm && !(await confirmDiscard())) return;
  try {
    const f = await store.read(path);
    const draft = load("draft:" + store.id + ":" + path, null);
    setDocument(f.content, { path: f.path, name: f.path.split("/").pop(), mtime: f.mtime, savedMarkdown: null });
    if (draft && draft.markdown && draft.markdown !== doc.savedMarkdown) {
      toast("You have unsaved changes from " + new Date(draft.at).toLocaleString() + ".", {
        timeout: 12000, action: { label: "Restore", run: () => {
          const saved = doc.savedMarkdown;
          view.updateState(createState(draft.markdown, app)); applyDocSettings();
          doc.savedMarkdown = saved; app.onDocChange();
        } }
      });
    }
  } catch (e) { toast("Could not open " + path + ": " + e.message, { kind: "error", timeout: 5000 }); }
};

// Opens text that did not come from storage (a dropped or picked local file) as an unsaved,
// untitled document; Save then asks where to put it.
app.openText = async (text, name) => {
  if (!(await confirmDiscard())) return;
  setDocument(text, { path: null, name: name || "Untitled.md", savedMarkdown: null });
  doc.dirty = true; refreshTitle(); storeDraft();
};

// Starts an empty untitled document.
app.newDoc = async () => {
  if (!(await confirmDiscard())) return;
  setDocument("", { path: null, name: "Untitled.md", savedMarkdown: "" });
};

/* ---------- saving ---------- */
/**
 * Saves the document to the current storage.
 *   - untitled: asks for a name (saveAs)
 *   - 409 (the file changed since it was opened, or the name is taken): asks whether to overwrite
 *   - any other failure (storage full, folder access withdrawn): says why; the draft stays in the browser,
 *     and Export → Markdown always works as a fallback
 * @param {{force?: boolean}} [opts]  force: overwrite even if the file changed since it was opened
 */
app.save = async (opts = {}) => {
  if (!doc.path) return app.saveAs();
  const md = getMarkdown(view);
  const t = toast("Saving…", { kind: "busy", timeout: 0 });
  try {
    const r = await store.write(doc.path, md, doc.mtime, !!opts.force);
    doc.mtime = r.mtime; doc.savedMarkdown = md; doc.dirty = false;
    saveLocal(draftKey(), null);
    saveLocal("last", { path: doc.path, store: store.id }); // so a reload reopens this document
    refreshTitle();
    t.update("Saved " + doc.path, "success", 1600);
    store.requestPersistence();
  } catch (e) {
    if (e.status === 409) {
      t.dismiss();
      const taken = doc.mtime == null; // saving under a name that already exists, not saving over a newer version
      const where = store.kind === "folder" ? "on disk after you opened it" : "in another tab after you opened it";
      const ok = await confirmDialog(taken
        ? { title: "Replace existing document?", message: "“" + doc.path + "” already exists. Replace it with this document? The old text is kept in its version history.", confirm: "Replace", danger: true }
        : { title: "File changed", message: "“" + doc.path + "” was changed " + where + ". Overwrite it with your version?", confirm: "Overwrite", danger: true });
      if (ok) return app.save({ force: true });
    } else t.update("Save failed: " + e.message + ". Your changes are kept as a draft in this browser; Export → Markdown downloads them.", "error", 8000);
  }
};

// Saves under a new path (".md" is added when no Markdown extension is given). If the save does not
// happen (cancelled overwrite, error), the document keeps its previous path.
app.saveAs = async () => {
  const suggestion = doc.path || (fileBase() + ".md");
  const folder = store.kind === "folder";
  const path = await promptDialog({
    title: "Save as", label: folder ? "File path inside " + store.rootName : "Name in your browser library (use / for folders)", value: suggestion, confirm: "Save",
    validate: (v) => (!v ? "Enter a file name" : /\.\.|^\//.test(v) ? "Use a path inside the folder" : "")
  });
  if (!path) return;
  const target = /\.(md|markdown|txt)$/i.test(path) ? path : path + ".md";
  const prevPath = doc.path;
  doc.path = target; doc.mtime = null;
  setCurrentFile(target);
  await app.save({ force: false });
  if (doc.dirty) { doc.path = prevPath; setCurrentFile(prevPath); }
  else saveLocal("draft:untitled", null);
  refreshTitle();
};

/* ---------- links, images ---------- */
// Opens the link editor for the selection or a known link range.
app.editLink = (range) => openLinkEditor(view, range);
/**
 * Opens a link from the document:
 *   #anchor              scrolls to the heading with that slug
 *   relative .md path    opens that document in the editor (resolved against the open file)
 *   http(s), mailto, tel opens in a new tab, without giving the page access back to the editor
 *   anything else        refused (javascript:, data: …), see isSafeHref
 */
app.openLink = (href) => {
  if (/^#/.test(href)) { scrollToAnchor(href.slice(1)); return; }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && doc.path) {
    const target = joinPath(dirname(doc.path), decodeURIComponent(href.split("#")[0]));
    if (/\.(md|markdown)$/i.test(target)) { app.openPath(target); return; }
  }
  if (!isSafeHref(href)) { toast("This link was not opened: only web, email and phone links can be opened from the editor.", { kind: "error", timeout: 6000 }); return; }
  window.open(href, "_blank", "noopener,noreferrer");
};
// Heading slug for #anchor links: GitHub's rules. Must match slugify in export/render.js, which
// creates the anchors in exported HTML/PDF and the bookmarks in Word, so links work the same everywhere.
function slugify(s) { return s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-"); }
// Scrolls to the first heading whose slug matches `id` (case-insensitive), or says there is none.
function scrollToAnchor(id) {
  let target = null;
  const want = decodeURIComponent(id).toLowerCase();
  view.state.doc.descendants((n, pos) => {
    if (target != null) return false;
    if (n.type === N.heading && slugify(n.textContent) === want) target = pos;
    return n.isBlock && !n.isTextblock;
  });
  if (target != null) scrollToPos(target);
  else toast("No heading matches #" + id);
}
// Moves the cursor into the block at `pos` and scrolls it to the top of the window.
function scrollToPos(pos) {
  const dom = view.nodeDOM(pos);
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))));
  if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: "start", behavior: "smooth" });
  view.focus();
}

// Hidden file input behind "Insert image"; reset after each pick so the same file can be picked again.
const imageInput = h("input", { type: "file", accept: "image/*", class: "visually-hidden", tabindex: "-1", "aria-hidden": "true" });
imageInput.addEventListener("change", async () => {
  const f = imageInput.files && imageInput.files[0];
  imageInput.value = "";
  if (f) insertImageFile(f);
});
// Inserts an image file at the cursor: stored in assets/ next to the document when possible (dialogs.js).
async function insertImageFile(file) {
  const r = await imageFromFile(file, doc.path);
  if (r) C.insertImage(r.src, r.alt)(view.state, view.dispatch);
  view.focus();
}
app.pickImage = () => imageInput.click();

// Hidden file input behind "Open file from computer" (also used by the Open dialog).
const openLocal = h("input", { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain", class: "visually-hidden", tabindex: "-1", "aria-hidden": "true" });
openLocal.addEventListener("change", async () => {
  const f = openLocal.files && openLocal.files[0];
  openLocal.value = "";
  if (f) app.openText(await f.text(), f.name);
});

/* ---------- other dialogs ---------- */
app.openFiles = () => openFileBrowser(app);
// Version history of the open file (app/history.js). Restoring replaces the whole document in a
// single transaction, so it is one Undo step and nothing is written until the user saves.
app.showHistory = () => {
  if (!doc.path) { toast("Save the document first; versions are kept from then on."); return; }
  openHistory(app, doc.path, (markdown) => {
    // one undoable change, so the current text is never lost
    const d = parseMarkdown(markdown);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, d.content).scrollIntoView());
    view.focus();
  });
};
app.showShortcuts = () => showShortcuts();
// Exports: Markdown is a plain download; PDF (print dialog), Word and HTML are built in this browser by
// export/browser.js, after the dialog in app/exporter.js has collected the options.
app.exportAs = (format) => {
  if (format === "md") return exportMarkdown(view, fileBase());
  openExportDialog(format, { view, title: docTitle(), base: fileBase(), settings, docPath: doc.path });
};

/* ---------- where documents live: library, folder, or a single file ---------- */
// Switching storage closes the current document (after asking about unsaved changes) and starts a fresh
// untitled one, because the open document's path belongs to the storage it came from. Its draft stays.
async function switchStorage(change, then) {
  if (!(await confirmDiscard())) return;
  try {
    if ((await change()) === false) return; // picker cancelled
  } catch (e) { toast(e.message, { kind: "error", timeout: 6000 }); return; }
  forgetAssets();
  setDocument("", { path: null, name: "Untitled.md", savedMarkdown: "" });
  toast(store.kind === "folder" ? "Now editing the folder “" + store.rootName + "”" : "Back in your browser library", { kind: "success" });
  if (then) then();
}
app.openFolder = () => switchStorage(() => store.openFolder(), () => app.openFiles());
app.reconnectFolder = () => switchStorage(() => store.reconnectFolder(), () => app.openFiles());
app.useLibrary = () => switchStorage(() => store.useLibrary(), () => app.openFiles());
// "Open file from computer": a one-off file, opened as an untitled document (Save then stores it).
app.openLocalFile = () => openLocal.click();
// A document was deleted from the Open dialog: if it is the open one, it becomes an untitled draft.
app.onFileRemoved = (path) => {
  if (doc.path !== path) return;
  doc.path = null; doc.mtime = null; setCurrentFile(null);
  doc.dirty = true; refreshTitle(); storeDraft();
};

/* ---------- toolbar ---------- */
// A toolbar button with icon, tooltip and shortcut hint. mousedown is cancelled so clicking it keeps
// the editor's focus and selection (add class keep-focus to opt out).
function tbButton(iconName, tip, k, onClick, { label, cls = "" } = {}) {
  const b = h("button", { class: "tb-btn " + cls + (label ? " has-label" : ""), type: "button", "data-tip": tip, "data-kbd": k || null, "aria-label": tip },
    svg(iconName, 16), label ? h("span", null, label) : null);
  b.addEventListener("mousedown", (e) => { if (!b.classList.contains("keep-focus")) e.preventDefault(); });
  b.addEventListener("click", onClick);
  return b;
}
function chevron() { return h("span", { class: "tb-caret" }, svg("ChevronDown", 12)); }

// The document outline for the title menu: headings of levels 1-3, top level and inside quotes, lists
// and sections (not inside tables).
function outlineItems() {
  const items = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type === N.heading && n.attrs.level <= 3 && n.textContent.trim()) {
      items.push({ label: n.textContent.trim(), cls: "lvl-" + n.attrs.level, run: () => scrollToPos(pos), render: (row) => row.classList.add("outline-item", "lvl-" + n.attrs.level) });
    }
    return n.isBlock && !n.isTextblock && n.type !== N.table;
  });
  return items;
}

// Builds the toolbar: document menu (title), formatting tools, Insert menu, save state, undo/redo,
// Export, theme and More. Items with class tb-extra are hidden on narrow screens (ui.css), where the
// same actions remain reachable through the Insert and More menus and the slash menu.
function buildToolbar() {
  const tb = $("#toolbar");
  const titleBtn = h("button", { class: "tb-doc", type: "button", id: "doc-title", "aria-label": "Document menu", "data-tip": "Document, outline and files" },
    svg("File", 16), h("span", { class: "tb-doc-title", id: "doc-title-text" }, "Untitled"), chevron());
  titleBtn.addEventListener("mousedown", (e) => e.preventDefault());
  titleBtn.addEventListener("click", () => {
    const outline = outlineItems();
    menuFromButton(titleBtn, [
      { label: "New document", icon: "New", run: () => app.newDoc() },
      { label: "Open…", icon: "Folder", kbd: "Mod-O", run: () => app.openFiles() },
      { label: "Open file from computer…", icon: "Import", run: () => app.openLocalFile() },
      ...(store.info().canPickFolder ? [{ label: store.kind === "folder" ? "Open another folder…" : "Open folder…", icon: "Folder", run: () => app.openFolder() }] : []),
      { type: "sep" },
      { label: doc.path ? "Save" : "Save…", icon: "Save", kbd: "Mod-S", disabled: !!doc.path && !doc.dirty, run: () => app.save() },
      { label: "Save as…", icon: "Edit", run: () => app.saveAs() },
      { label: "Download as Markdown", icon: "Markdown", run: () => app.exportAs("md") },
      { label: "Version history…", icon: "History", disabled: !doc.path, run: () => app.showHistory() },
      ...(outline.length ? [{ type: "sep" }, { type: "header", label: "Outline" }, ...outline] : [])
    ], { className: "menu-scroll doc-menu", width: 300 });
  });

  const fontBtn = h("button", { class: "tb-btn tb-extra has-caret", type: "button", "data-tip": "Fonts", "aria-label": "Fonts" }, svg("Font", 16), chevron());
  fontBtn.addEventListener("mousedown", (e) => e.preventDefault());
  fontBtn.addEventListener("click", () => {
    const opt = (key, value, label) => ({ label, checked: settings[key] === value, indent: true, run: () => { settings[key] = value; saveSettings(); applyDocSettings(); } });
    menuFromButton(fontBtn, [
      { type: "header", label: "Headings" }, opt("headingFont", "serif", "Serif"), opt("headingFont", "sans", "Sans"), opt("headingFont", "mono", "Mono"),
      { type: "sep" },
      { type: "header", label: "Text" }, opt("textFont", "sans", "Sans"), opt("textFont", "serif", "Serif"), opt("textFont", "mono", "Mono")
    ], { width: 190 });
  });

  const widthBtn = tbButton("Width", "Page width", null, () => {
    settings.wide = !settings.wide; saveSettings(); applyDocSettings();
    widthBtn.classList.toggle("is-on", settings.wide);
  });
  widthBtn.classList.add("tb-extra"); widthBtn.classList.toggle("is-on", !!settings.wide);

  const insertBtn = h("button", { class: "tb-btn has-label has-caret", type: "button", "aria-label": "Insert", "data-tip": "Insert a block" }, svg("Add", 16), h("span", null, "Insert"), chevron());
  insertBtn.addEventListener("mousedown", (e) => e.preventDefault());
  insertBtn.addEventListener("click", () => {
    menuFromButton(insertBtn, [
      { type: "header", label: "Blocks" },
      ...TURN_INTO.map((t) => ({ label: t.label, icon: t.icon, kbd: t.kbd, run: () => { turnIntoRun(t.id)(view); view.focus(); } })),
      { type: "header", label: "Insert" },
      ...insertItems(app).map((it) => ({ ...it, run: () => { it.run(view); view.focus(); } }))
    ], { className: "menu-scroll", width: 260 });
  });

  const undoBtn = tbButton("Undo", "Undo", "Mod-Z", () => { undo(view.state, view.dispatch); view.focus(); });
  undoBtn.id = "btn-undo";
  const redoBtn = tbButton("Redo", "Redo", "Mod-Shift-Z", () => { redo(view.state, view.dispatch); view.focus(); });
  redoBtn.id = "btn-redo";

  const exportBtn = h("button", { class: "tb-btn tb-export has-label has-caret", type: "button", "data-tip": "Export", "aria-label": "Export" }, svg("Export", 16), h("span", null, "Export"), chevron());
  exportBtn.addEventListener("mousedown", (e) => e.preventDefault());
  exportBtn.addEventListener("click", () => {
    menuFromButton(exportBtn, [
      { label: "PDF (.pdf)", icon: "Pdf", kbd: "Mod-Shift-P", run: () => app.exportAs("pdf") },
      { label: "Word (.docx)", icon: "Word", run: () => app.exportAs("docx") },
      { label: "Markdown (.md)", icon: "Markdown", run: () => app.exportAs("md") },
      { label: "Web page (.html)", icon: "Html", run: () => app.exportAs("html") }
    ], { align: "end", width: 230 });
  });

  const themeBtn = tbButton(settings.theme === "dark" ? "Moon" : settings.theme === "light" ? "Sun" : "Preview", "Theme", null, () => {
    const cur = settings.theme;
    menuFromButton(themeBtn, [
      { label: "System", icon: "Preview", checked: cur === "system", run: () => setTheme("system") },
      { label: "Light", icon: "Sun", checked: cur === "light", run: () => setTheme("light") },
      { label: "Dark", icon: "Moon", checked: cur === "dark", run: () => setTheme("dark") }
    ], { align: "end", width: 170 });
  });
  themeBtn.classList.add("tb-extra");
  function setTheme(t) { settings.theme = t; saveSettings(); applyTheme(); themeBtn.replaceChildren(svg(t === "dark" ? "Moon" : t === "light" ? "Sun" : "Preview", 16)); }

  const moreBtn = tbButton("More", "More", null, () => {
    menuFromButton(moreBtn, [
      { label: "Expand all sections", icon: "Details", run: () => view.dispatch(view.state.tr.setMeta(detailsKey, { all: true })) },
      { label: "Collapse all sections", icon: "Details", run: () => view.dispatch(view.state.tr.setMeta(detailsKey, { all: false })) },
      { type: "sep" },
      { type: "header", label: "Theme" },
      { label: "System", icon: "Preview", indent: true, checked: settings.theme === "system", run: () => setTheme("system") },
      { label: "Light", icon: "Sun", indent: true, checked: settings.theme === "light", run: () => setTheme("light") },
      { label: "Dark", icon: "Moon", indent: true, checked: settings.theme === "dark", run: () => setTheme("dark") },
      { type: "sep" },
      { label: "Spell check", icon: "Check", checked: !!settings.spellcheck, run: () => { settings.spellcheck = !settings.spellcheck; saveSettings(); applyDocSettings(); } },
      { label: "Keyboard shortcuts", icon: "Keyboard", kbd: "Mod-/", run: () => app.showShortcuts() },
      { type: "sep" },
      { label: "Source code on GitHub", icon: "OpenLink", run: () => window.open(REPO_URL, "_blank", "noopener,noreferrer") },
      { label: "Open-source licenses", icon: "File", run: () => window.open("THIRD_PARTY_NOTICES.txt", "_blank", "noopener,noreferrer") }
    ], { align: "end", width: 250 });
  });

  tb.append(
    h("div", { class: "tb-group" }, titleBtn),
    h("div", { class: "tb-group tb-tools" },
      fontBtn, widthBtn, h("span", { class: "tb-sep" }),
      tbButton("Table", "Insert table", null, () => { C.insertTable(3, 3)(view.state, view.dispatch); view.focus(); }, { cls: "tb-extra" }),
      tbButton("Image", "Insert image", null, () => app.pickImage(), { cls: "tb-extra" }),
      tbButton("Checklist", "Checklist", "Mod-Shift-9", () => { C.toggleList(N.task_list)(view.state, view.dispatch); view.focus(); }, { cls: "tb-extra" }),
      tbButton("Math", "Equation", "Mod-Shift-M", () => { C.insertMathBlock(view.state, view.dispatch); }, { cls: "tb-extra" }),
      insertBtn),
    h("div", { class: "tb-spacer" }),
    h("div", { class: "tb-group tb-right" },
      h("span", { class: "save-state", id: "save-state", "data-tip": "" }),
      undoBtn, redoBtn, h("span", { class: "tb-sep" }), exportBtn, themeBtn, moreBtn),
    openLocal, imageInput);
}

/* ---------- drag and drop: .md files open, images insert ---------- */
// Drag and drop onto the page: a .md/.markdown/.txt file opens (as an untitled document), images are
// inserted where they are dropped. Pasted image files are inserted too. The depth counter keeps the
// drop highlight steady while the pointer moves over child elements.
function setupDrop() {
  const scroller = $("#scroller");
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  scroller.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; document.body.classList.add("is-dropping"); } });
  scroller.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("is-dropping"); } });
  scroller.addEventListener("drop", () => { depth = 0; document.body.classList.remove("is-dropping"); });
  view.setProps({
    handleDrop(v, e) {
      const files = e.dataTransfer && Array.from(e.dataTransfer.files || []);
      if (!files || !files.length) return false;
      e.preventDefault();
      const md = files.find((f) => /\.(md|markdown|txt)$/i.test(f.name));
      if (md) { md.text().then((t) => app.openText(t, md.name)); return true; }
      const img = files.filter((f) => f.type.startsWith("image/"));
      if (img.length) {
        const coords = v.posAtCoords({ left: e.clientX, top: e.clientY });
        if (coords) v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(coords.pos))));
        img.forEach(insertImageFile);
        return true;
      }
      return false;
    },
    handlePaste(v, e) {
      const files = e.clipboardData && Array.from(e.clipboardData.files || []).filter((f) => f.type.startsWith("image/"));
      if (files && files.length) { files.forEach(insertImageFile); return true; }
      return false;
    }
  });
}

/* ---------- right-click menu (replaces the browser's) ---------- */
// Right-click menu, replacing the browser's: link actions, clipboard, select all and basic formatting.
// "Paste" from a menu needs the async Clipboard API, which asks for permission; when it is refused the
// user is told to use the keyboard shortcut, which always works.
function setupContextMenu() {
  async function paste(plain) {
    view.focus();
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { toast("Allow clipboard access to paste from the menu, or press " + MOD + "+V", { kind: "error" }); return; }
    if (!text) return;
    const inCode = view.state.selection.$from.parent.type.spec.code;
    if (!plain && !inCode && looksLikeMarkdown(text)) {
      const d = parseMarkdown(text.replace(/\r\n?/g, "\n"));
      view.dispatch(view.state.tr.replaceSelection(new Slice(d.content, 0, 0)).scrollIntoView());
    } else view.pasteText(text);
  }
  view.dom.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const hasSel = !view.state.selection.empty;
    const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
    const link = hit ? C.linkRange(view.state, hit.pos) : null;
    if (hit && !hasSel && !(view.state.selection instanceof NodeSelection)) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))).setMeta("pointer", true));
    const run = (fn) => () => { view.focus(); fn(); };
    const items = [
      ...(link ? [
        { label: "Open link", icon: "OpenLink", run: () => app.openLink(link.href) },
        { label: "Edit link", icon: "Edit", run: () => app.editLink(link) },
        { label: "Remove link", icon: "Unlink", run: run(() => view.dispatch(view.state.tr.removeMark(link.from, link.to, schema.marks.link))) },
        { type: "sep" }
      ] : []),
      { label: "Cut", icon: "Copy", kbd: "Mod-X", disabled: !hasSel, run: run(() => document.execCommand("cut")) },
      { label: "Copy", icon: "Copy", kbd: "Mod-C", disabled: !hasSel, run: run(() => document.execCommand("copy")) },
      { label: "Paste", icon: "Import", kbd: "Mod-V", run: () => paste(false) },
      { label: "Paste as plain text", icon: "Text", kbd: "Mod-Shift-V", run: () => paste(true) },
      { type: "sep" },
      { label: "Select all", icon: "Preview", kbd: "Mod-A", run: run(() => view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))) },
      ...(hasSel ? [{ type: "sep" }, { label: "Bold", icon: "Bold", kbd: "Mod-B", run: run(() => C.toggleBold(view.state, view.dispatch)) }, { label: "Italic", icon: "Italic", kbd: "Mod-I", run: run(() => C.toggleItalic(view.state, view.dispatch)) }, { label: "Link…", icon: "Link", kbd: "Mod-K", run: () => app.editLink() }] : [])
    ];
    const m = buildMenu(items, { onRun: () => rec.close("run"), width: 230 });
    const rec = openPopover(m.el, { rect: { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 }, side: "bottom", align: "start", gap: 2, focus: false });
    m.el.dataset.autoActive = ""; m.focus();
  });
}

/* ---------- boot ---------- */
/**
 * Starts the app (called by ../index.js): storage, toolbar, editor, global shortcuts, then the first
 * document. Which one: ?file=path in the address, else the file open last time (if it was in the storage
 * that is active now), else the untitled draft, else the welcome document (sample.js).
 *
 * An installed app (PWA) can also be launched with a Markdown file from the operating system; it opens as
 * an untitled document through the Launch Handler API.
 *
 * window.__editor exposes the view, the app object, the storage (and its backend classes) and getMarkdown()
 * for debugging from the browser console and for scripted browser checks (test/e2e.mjs); nothing in the
 * app depends on it.
 */
export async function boot() {
  applyTheme();
  await store.restore();
  buildToolbar();
  view = createEditor($("#editor"), "", app);
  app.view = view;
  window.__editor = { view, app, store, FolderBackend, LibraryBackend, getMarkdown: () => getMarkdown(view) };
  applyDocSettings();
  setupDrop();
  setupContextMenu();
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return; // the editor's own shortcut already handled it
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); app.save(); }
    else if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); app.openFiles(); }
  });
  $("#scroller").addEventListener("mousedown", (e) => {
    // clicking the empty page below the text puts the caret at the end
    if (e.target.id === "scroller" || e.target.id === "page") {
      e.preventDefault();
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView());
    }
  });
  window.addEventListener("beforeunload", (e) => { if (doc.dirty && doc.path) { e.preventDefault(); e.returnValue = ""; } });

  const params = new URLSearchParams(location.search);
  const last = load("last", {}) || {};
  const want = params.get("file") || (last.store === store.id ? last.path : null);
  const untitled = load("draft:untitled", null);
  if (want) {
    await app.openPath(want, { skipConfirm: true });
    if (!doc.path && untitled) setDocument(untitled.markdown, { savedMarkdown: "" });
  }
  if (!doc.path && !want) {
    if (untitled && untitled.markdown) setDocument(untitled.markdown, { path: null, savedMarkdown: "" });
    else setDocument(SAMPLE, { path: null, name: "Welcome.md", savedMarkdown: null });
  } else if (!doc.path && !untitled) setDocument(SAMPLE, { path: null, name: "Welcome.md", savedMarkdown: null });

  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (launch) => {
      const handle = launch.files && launch.files[0];
      if (handle) { const file = await handle.getFile(); app.openText(await file.text(), file.name); }
    });
  }
  document.body.classList.add("is-ready");
}
