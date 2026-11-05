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
 *   - The lock (app.locked, kept in settings) makes the document read-only: the editor is not editable
 *     and lockPlugin refuses every document change. Loading a document is not a change, so opening,
 *     saving and exporting work while locked. Code that edits outside the editor's own checks calls
 *     refuseWhenLocked(), or marks its transaction lockBypass when it must go through (Save As image links).
 */
import { TextSelection, NodeSelection, AllSelection } from "prosemirror-state";
import { undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import { h, svg, $, debounce, load, save as saveLocal, keys as localKeys, MOD } from "../ui/dom.js";
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
import { forgetAssets, loadLocalImage, isDirectSrc } from "./assets.js";
import { openFileBrowser } from "./files.js";
import { openExportDialog, exportMarkdown } from "./exporter.js";
import { openLinkEditor, showShortcuts, imageFromFile } from "./dialogs.js";
import { openHistory } from "./history.js";
import { looksLikeMarkdown } from "../editor/plugins.js";
import { parseMarkdown } from "../markdown.js";
import { Slice } from "prosemirror-model";
import { SAMPLE } from "./sample.js";
import { checkDocPath, MAX_FILE } from "../storage/common.js";
import { openFind } from "../editor/find-plugin.js";
import { redrawDiagrams } from "../editor/nodeviews.js";

const N = schema.nodes;
const REPO_URL = "https://github.com/harsh040506/professional-markdown-editor";

// Editor preferences. Defaults first, then whatever was saved, so new settings get a default.
const settings = Object.assign({ theme: "system", headingFont: "serif", textFont: "sans", wide: false, spellcheck: true, locked: false }, load("settings", {}));
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
// Bumped whenever another document is loaded, so slow work (a save, a file read) that finishes after
// the user moved on can tell that the open document is no longer the one it started with.
let docGen = 0;
const app = {};
// Lock ("view mode"): while true the document is read-only. Kept in settings, so a reload stays locked.
// Read by the editor (editor.js: the editable prop, plugins.js: lockPlugin) and set only by setLocked.
app.locked = !!settings.locked;

/* ---------- theme ---------- */
// "system" follows the OS setting live. The theme is set as data-theme on <html>; tokens.css does the rest.
// public/index.html applies the saved theme before the first paint, so there is no flash.
// Diagrams are drawn in the theme's colours, so they are redrawn when the effective theme changes.
const mq = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const t = settings.theme === "system" ? (mq.matches ? "dark" : "light") : settings.theme;
  const changed = document.documentElement.dataset.theme !== t;
  document.documentElement.dataset.theme = t;
  if (changed && view) redrawDiagrams();
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
// Writes (or clears) the open document's draft now. If the browser refuses to keep it (storage full or
// blocked, or the document is larger than localStorage allows), the user is told once per visit, since
// they would otherwise believe their unsaved changes are safe.
let draftWarned = false;
function writeDraft(markdown) {
  if (!view) return;
  const ok = doc.dirty ? saveLocal(draftKey(), { markdown: markdown != null ? markdown : getMarkdown(view), at: Date.now(), base: doc.mtime }) : saveLocal(draftKey(), null);
  if (!ok && doc.dirty && !draftWarned) {
    draftWarned = true;
    toast("This browser cannot keep a draft of this document (storage is full or blocked). Save it with " + MOD + "+S, or Download as Markdown, so changes are not lost.", { kind: "error", timeout: 10000 });
  }
}
const storeDraft = debounce(() => writeDraft(), 600);
// Brings the dirty flag and the draft up to date at once, skipping the debounce. Runs when the tab is
// hidden or closed (pagehide), before an update reload and after an unexpected error, so the last
// seconds of typing are never lost.
function flushDraft() {
  if (!view) return;
  try {
    checkDirty.cancel(); storeDraft.cancel();
    const md = getMarkdown(view);
    const dirty = md !== doc.savedMarkdown;
    if (dirty !== doc.dirty) { doc.dirty = dirty; refreshTitle(); }
    writeDraft(md);
  } catch (e) { console.error("Could not keep the draft", e); }
}

// Word count and reading time (230 words per minute) in the corner; with text selected, "12 of 1,240
// words". Words are runs of letters/digits in any script, so the count works for non-English text too.
const countWords = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
const updateCount = debounce(() => {
  if (!view) return;
  const { doc: d, selection: sel } = view.state;
  const text = d.textBetween(0, d.content.size, " ", " ");
  const words = countWords(text);
  const picked = sel.empty ? "" : d.textBetween(sel.from, sel.to, " ", " ");
  const el = $("#word-count");
  el.textContent = (picked ? countWords(picked).toLocaleString() + " of " : "") + words.toLocaleString() + (words === 1 ? " word" : " words");
  el.dataset.tip = Math.max(1, Math.round(words / 230)) + " min read · " + text.length.toLocaleString() + " characters" + (picked ? " · " + picked.length.toLocaleString() + " selected" : "");
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
// Called after every selection change: the word count shows how much is selected.
app.onSelectionChange = () => updateCount();

// Enables or disables the toolbar's undo/redo buttons.
function updateUndo() {
  $("#btn-undo").disabled = app.locked || !undoDepth(view.state);
  $("#btn-redo").disabled = app.locked || !redoDepth(view.state);
}

/* ---------- lock (view mode) ---------- */
// Locking makes the document read-only: no caret or typing (contenteditable off), no editing buttons,
// and the editor refuses any change that still gets through (lockPlugin). Reading tools keep working:
// scrolling, selecting and copying, search, folding sections, "Show code" on diagrams, following links,
// saving, exports, theme and fonts. The state is remembered across reloads.
function applyLock() {
  const on = app.locked;
  view.setProps({ editable: () => !app.locked }); // re-reads the editable prop
  document.body.classList.toggle("is-locked", on);
  $("#page").classList.toggle("is-locked", on);
  for (const b of document.querySelectorAll("#toolbar .edit-only")) b.disabled = on;
  const lock = $("#btn-lock");
  lock.classList.toggle("is-on", on);
  lock.classList.toggle("has-label", on);
  lock.setAttribute("aria-pressed", String(on));
  lock.dataset.tip = on ? "Unlock to edit" : "Lock (view only)";
  lock.setAttribute("aria-label", lock.dataset.tip);
  lock.replaceChildren(svg(on ? "Lock" : "Unlock", 16), ...(on ? [h("span", null, "View only")] : []));
  updateUndo();
}
app.setLocked = async (on) => {
  on = !!on;
  if (on === app.locked) return;
  if (on) {
    // An open equation editor lives in the document; let it save its text before the document locks
    const a = document.activeElement;
    if (a && a.closest && a.closest(".math-block-editor")) { a.blur(); await new Promise((r) => setTimeout(r, 20)); }
    closeAllPopovers("lock");
  }
  app.locked = on;
  settings.locked = on; saveSettings();
  applyLock();
  if (!on) view.focus();
  toast(on ? "Locked: the document is view only." : "Unlocked: you can edit again.", { timeout: 1800 });
};
app.toggleLock = () => app.setLocked(!app.locked);
// Edits made from places that sit outside the editor's own checks say why nothing happened.
const refuseWhenLocked = () => { if (!app.locked) return false; toast("The document is locked. Unlock it to make changes.", { timeout: 2500 }); return true; };

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
  docGen++;
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
  const gen = docGen;
  try {
    const f = await store.read(path);
    if (gen !== docGen) return; // another document was opened while this one was being read
    if (f.content.length > MAX_FILE) throw Object.assign(new Error("the file is too large to edit here (over 50 MB)"), { status: 413 });
    const draft = load("draft:" + store.id + ":" + path, null);
    setDocument(f.content, { path: f.path, name: f.path.split("/").pop(), mtime: f.mtime, savedMarkdown: null });
    if (draft && draft.markdown && draft.markdown !== doc.savedMarkdown) {
      const opened = docGen;
      const changedSince = draft.base != null && f.mtime != null && draft.base !== f.mtime;
      toast("You have unsaved changes from " + new Date(draft.at).toLocaleString() + "." + (changedSince ? " The file has been saved since then." : ""), {
        timeout: 15000, action: { label: "Restore", run: () => {
          if (opened !== docGen) return; // the user has moved to another document meanwhile
          if (refuseWhenLocked()) return;
          // as one undoable change on top of the file, so Undo shows the saved text again
          replaceDocument(parseMarkdown(draft.markdown).content);
        } }
      });
    }
  } catch (e) { toast("Could not open " + path + ": " + e.message, { kind: "error", timeout: 6000 }); }
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
 * Saves the document to the current storage. Resolves true when the text was written.
 *   - untitled: asks for a name (saveAs)
 *   - 409 (the file changed since it was opened, or the name is taken): asks whether to overwrite
 *   - any other failure (storage full, folder access withdrawn): says why; the draft stays in the browser,
 *     and Export → Markdown always works as a fallback
 * @param {{force?: boolean}} [opts]  force: overwrite even if the file changed since it was opened
 */
// Saves are serialised: pressing Mod-S again while a save is running waits for it and then saves only if
// there is something new. Two overlapping writes would otherwise both send the old mtime, and the second
// would report a false "File changed" conflict.
let saving = null;
app.save = async (opts = {}) => {
  if (!doc.path) return app.saveAs();
  while (saving) {
    await saving;
    if (!doc.path || (!doc.dirty && !opts.force)) return;
  }
  saving = writeDoc(opts).finally(() => { saving = null; });
  return saving;
};
async function writeDoc(opts) {
  const md = getMarkdown(view);
  const gen = docGen, path = doc.path;
  const t = toast("Saving…", { kind: "busy", timeout: 0 });
  try {
    const r = await store.write(path, md, doc.mtime, !!opts.force);
    if (gen !== docGen || path !== doc.path) { t.update("Saved " + path, "success", 1600); return true; } // the user moved on meanwhile
    doc.mtime = r.mtime; doc.savedMarkdown = md;
    // typing that happened while the file was written is still unsaved, and stays in the draft
    doc.dirty = getMarkdown(view) !== md;
    writeDraft();
    saveLocal("last", { path, store: store.id }); // so a reload reopens this document
    refreshTitle();
    t.update("Saved " + path, "success", 1600);
    store.requestPersistence();
    return true;
  } catch (e) {
    if (e.status === 409 && gen === docGen) {
      t.dismiss();
      const taken = doc.mtime == null; // saving under a name that already exists, not saving over a newer version
      const where = store.kind === "folder" ? "on disk after you opened it" : "in another tab after you opened it";
      const ok = await confirmDialog(taken
        ? { title: "Replace existing document?", message: "“" + path + "” already exists. Replace it with this document? The old text is kept in its version history.", confirm: "Replace", danger: true }
        : { title: "File changed", message: "“" + path + "” was changed " + where + ". Overwrite it with your version? The other version is kept in Version history either way.", confirm: "Overwrite", danger: true });
      if (ok && gen === docGen) return writeDoc({ force: true });
    } else {
      console.error("Save failed", e);
      t.update("Save failed: " + e.message + ". Your changes are kept as a draft in this browser; Download as Markdown saves a copy.", "error", 10000);
      if (e.status === 403 && store.kind === "folder") toast("Reopen the folder from Open… to save there again.", { timeout: 8000 });
    }
    return false;
  }
}

// Saves under a new path (".md" is added when no Markdown extension is given). If the save does not
// happen (cancelled overwrite, error), the document keeps its previous path.
const withExt = (v) => (/\.(md|markdown|txt)$/i.test(v) ? v : v + ".md");
app.saveAs = async () => {
  if (saving) await saving;
  const suggestion = doc.path || (fileBase() + ".md");
  const folder = store.kind === "folder";
  const path = await promptDialog({
    title: "Save as", label: folder ? "File path inside " + store.rootName : "Name in your browser library (use / for folders)", value: suggestion, confirm: "Save",
    // the same rules storage applies, checked here so the dialog can say what is wrong and stay open
    validate: (v) => { if (!v) return "Enter a file name"; try { checkDocPath(withExt(v)); return ""; } catch (e) { return e.message; } }
  });
  if (!path) return;
  const target = checkDocPath(withExt(path));
  const prevPath = doc.path, prevMtime = doc.mtime;
  if (prevPath && dirname(prevPath) !== dirname(target)) await relocateImages(prevPath, target);
  doc.path = target; doc.mtime = null;
  setCurrentFile(target);
  saving = writeDoc({ force: false }).finally(() => { saving = null; });
  const ok = await saving;
  if (!ok) { doc.path = prevPath; doc.mtime = prevMtime; setCurrentFile(prevPath); }
  else if (!prevPath) saveLocal("draft:untitled", null);
  refreshTitle();
};
// Save As into another folder: images stored beside the old document ("assets/pic.png") would no longer
// resolve from the new place, so each one is copied beside the new document and its link updated, as
// one undoable change. Images that cannot be read are left as they are.
async function relocateImages(fromPath, toPath) {
  const srcs = new Set();
  view.state.doc.descendants((n) => { if (n.type === N.image && n.attrs.src && !isDirectSrc(n.attrs.src)) srcs.add(n.attrs.src); });
  if (!srcs.size) return;
  const moved = new Map();
  for (const src of srcs) {
    try {
      const blob = await loadLocalImage(src, fromPath);
      if (blob) moved.set(src, await store.saveAsset(toPath, decodeURIComponent(src.split(/[?#]/)[0].split("/").pop()), blob));
    } catch (e) { console.warn("Could not copy image", src, e); }
  }
  if (!moved.size) return;
  const tr = view.state.tr;
  view.state.doc.descendants((n, pos) => { if (n.type === N.image && moved.has(n.attrs.src)) tr.setNodeMarkup(pos, null, { ...n.attrs, src: moved.get(n.attrs.src) }); });
  view.dispatch(tr.setMeta("lockBypass", true)); // the links must follow the copies, even in a locked document
  forgetAssets();
  toast("Copied " + moved.size + (moved.size === 1 ? " image" : " images") + " next to the new document.", { kind: "success" });
}

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
  if (refuseWhenLocked()) return;
  const r = await imageFromFile(file, doc.path);
  if (r) C.insertImage(r.src, r.alt)(view.state, view.dispatch);
  view.focus();
}
app.pickImage = () => imageInput.click();

// Hidden file input behind "Open file from computer" (also used by the Open dialog).
const openLocal = h("input", { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain", class: "visually-hidden", tabindex: "-1", "aria-hidden": "true" });
openLocal.addEventListener("change", () => {
  const f = openLocal.files && openLocal.files[0];
  openLocal.value = "";
  if (f) openFileObject(f);
});
// Opens a File from the computer (picker, drop, or the operating system's "Open with") as an untitled
// document. Refuses what would freeze the tab or show garbage: files over 50 MB and binary files.
async function openFileObject(file) {
  if (file.size > MAX_FILE) { toast("“" + file.name + "” is too large to open (over 50 MB).", { kind: "error", timeout: 6000 }); return; }
  let text;
  try { text = await file.text(); } catch (e) { toast("Could not read “" + file.name + "”: " + e.message, { kind: "error", timeout: 6000 }); return; }
  if (text.includes("\u0000")) { toast("“" + file.name + "” is not a text file.", { kind: "error", timeout: 6000 }); return; }
  app.openText(text.replace(/^﻿/, ""), file.name);
}

/* ---------- other dialogs ---------- */
app.openFiles = () => openFileBrowser(app);
// Version history of the open file (app/history.js). Restoring replaces the whole document in a
// single transaction, so it is one Undo step and nothing is written until the user saves.
app.showHistory = () => {
  if (!doc.path) { toast("Save the document first; versions are kept from then on."); return; }
  openHistory(app, doc.path, (markdown) => {
    if (refuseWhenLocked()) return;
    // one undoable change, so the current text is never lost
    replaceDocument(parseMarkdown(markdown).content);
  });
};
// Replaces the whole document as one undoable change. The cursor goes to the start and nothing is
// scrolled: after replacing everything the cursor would otherwise sit at the end of the new text, and
// scrollIntoView would throw the page down to the bottom.
function replaceDocument(content) {
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, content);
  view.dispatch(tr.setSelection(TextSelection.atStart(tr.doc)));
  view.focus();
}
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
  if (doc.path !== path) { saveLocal("draft:" + store.id + ":" + path, null); return; } // its draft goes with it
  saveLocal(draftKey(), null);
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
      { type: "sep" },
      { label: "Find and replace…", icon: "Search", kbd: "Mod-F", run: () => openFind(view, { replace: true }) },
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
  insertBtn.classList.add("edit-only");
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
  // Lock / unlock (view mode). applyLock sets its icon, label and tooltip.
  const lockBtn = tbButton("Unlock", "Lock (view only)", "Mod-Shift-L", () => app.toggleLock(), { cls: "tb-lock" });
  lockBtn.id = "btn-lock";

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
      { label: "Find and replace…", icon: "Search", kbd: "Mod-F", run: () => openFind(view, { replace: true }) },
      { type: "sep" },
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
      tbButton("Table", "Insert table", null, () => { C.insertTable(3, 3)(view.state, view.dispatch); view.focus(); }, { cls: "tb-extra edit-only" }),
      tbButton("Image", "Insert image", null, () => app.pickImage(), { cls: "tb-extra edit-only" }),
      tbButton("Checklist", "Checklist", "Mod-Shift-9", () => { C.toggleList(N.task_list)(view.state, view.dispatch); view.focus(); }, { cls: "tb-extra edit-only" }),
      tbButton("Math", "Equation", "Mod-Shift-M", () => { C.insertMathBlock(view.state, view.dispatch); }, { cls: "tb-extra edit-only" }),
      insertBtn),
    h("div", { class: "tb-spacer" }),
    h("div", { class: "tb-group tb-right" },
      h("span", { class: "save-state", id: "save-state", "data-tip": "" }),
      lockBtn, undoBtn, redoBtn, h("span", { class: "tb-sep" }), exportBtn, themeBtn, moreBtn),
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
  // A locked editor takes no drops of its own, and a file dropped on the page would be opened by the
  // browser, replacing the editor. Dragging over must be accepted for the drop to arrive here.
  scroller.addEventListener("dragover", (e) => { if (app.locked && hasFiles(e)) e.preventDefault(); });
  scroller.addEventListener("drop", (e) => {
    if (!app.locked || !hasFiles(e)) return;
    e.preventDefault();
    const md = Array.from(e.dataTransfer.files).find((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (md) openFileObject(md); else refuseWhenLocked();
  });
  view.setProps({
    handleDrop(v, e) {
      const files = e.dataTransfer && Array.from(e.dataTransfer.files || []);
      if (!files || !files.length) return false;
      e.preventDefault();
      const md = files.find((f) => /\.(md|markdown|txt)$/i.test(f.name));
      if (md) { openFileObject(md); return true; }
      const img = files.filter((f) => f.type.startsWith("image/"));
      if (!img.length) { toast("Only Markdown or text files (.md, .markdown, .txt) and images can be dropped here.", { kind: "error", timeout: 5000 }); return true; }
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

// Selects the whole document. A locked editor holds no selection of its own (it is not editable), so
// the browser's selection is used and the editor reads it back; Copy then still writes Markdown.
function selectAll() {
  if (!app.locked) { view.focus(); view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc))); return; }
  const range = document.createRange();
  range.selectNodeContents(view.dom);
  const sel = getSelection();
  sel.removeAllRanges(); sel.addRange(range);
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
    const locked = app.locked;
    const items = [
      ...(link ? [
        { label: "Open link", icon: "OpenLink", run: () => app.openLink(link.href) },
        ...(locked ? [] : [
          { label: "Edit link", icon: "Edit", run: () => app.editLink(link) },
          { label: "Remove link", icon: "Unlink", run: run(() => view.dispatch(view.state.tr.removeMark(link.from, link.to, schema.marks.link))) }
        ]),
        { type: "sep" }
      ] : []),
      ...(locked ? [] : [{ label: "Cut", icon: "Copy", kbd: "Mod-X", disabled: !hasSel, run: run(() => document.execCommand("cut")) }]),
      { label: "Copy", icon: "Copy", kbd: "Mod-C", disabled: !hasSel, run: run(() => document.execCommand("copy")) },
      ...(locked ? [] : [
        { label: "Paste", icon: "Import", kbd: "Mod-V", run: () => paste(false) },
        { label: "Paste as plain text", icon: "Text", kbd: "Mod-Shift-V", run: () => paste(true) }
      ]),
      { type: "sep" },
      { label: "Select all", icon: "Preview", kbd: "Mod-A", run: () => selectAll() },
      { type: "sep" },
      { label: locked ? "Unlock to edit" : "Lock (view only)", icon: locked ? "Unlock" : "Lock", kbd: "Mod-Shift-L", run: () => app.toggleLock() },
      ...(hasSel && !locked ? [{ type: "sep" }, { label: "Bold", icon: "Bold", kbd: "Mod-B", run: run(() => C.toggleBold(view.state, view.dispatch)) }, { label: "Italic", icon: "Italic", kbd: "Mod-I", run: run(() => C.toggleItalic(view.state, view.dispatch)) }, { label: "Link…", icon: "Link", kbd: "Mod-K", run: () => app.editLink() }] : [])
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
  applyLock();
  setupDrop();
  setupContextMenu();
  // App shortcuts that must work while focus is outside the editor (toolbar, body, the find panel)
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return; // the editor's own shortcut already handled it
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey && e.code !== "KeyF") return;
    const k = e.key.toLowerCase();
    if (k === "s") { e.preventDefault(); app.save(); }
    else if (k === "o") { e.preventDefault(); app.openFiles(); }
    else if (k === "p") { e.preventDefault(); app.exportAs("pdf"); }
    else if (k === "f" && !e.altKey && !e.target.closest?.(".find-panel")) { e.preventDefault(); openFind(view); }
    else if (k === "l" && e.shiftKey && !e.altKey) { e.preventDefault(); app.toggleLock(); }
    // a locked editor has no focus to select within, so Select all is done here (not inside text fields)
    else if (k === "a" && !e.shiftKey && !e.altKey && app.locked && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { e.preventDefault(); selectAll(); }
  });
  // Data safety: the draft is written at once when the tab is hidden, closed or frozen, instead of
  // after the usual pause in typing.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDraft(); });
  window.addEventListener("pagehide", flushDraft);
  // Unexpected errors: logged, the draft secured, and the user told once (not for every repeat).
  let lastErrorAt = 0;
  const onError = (err) => {
    const msg = String((err && err.message) || err || "");
    if (!msg || /ResizeObserver loop|Script error\.?$/i.test(msg)) return; // browser noise, not a failure
    console.error("Unexpected error", err);
    flushDraft();
    if (Date.now() - lastErrorAt < 10000) return;
    lastErrorAt = Date.now();
    toast("Something went wrong: " + msg.slice(0, 160) + ". Your text is kept as a draft in this browser.", { kind: "error", timeout: 8000 });
  };
  window.addEventListener("error", (e) => onError(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => onError(e.reason));
  // A new version was deployed and its service worker took over (see index.js): offer a reload, with the
  // draft secured first so nothing typed is lost.
  window.addEventListener("mde:update", () => {
    toast("A new version of the editor is available.", { timeout: 60000, action: { label: "Reload", run: () => { flushDraft(); location.reload(); } } });
  });
  // Drafts cleared by earlier versions were stored as "null"; remove those leftovers.
  for (const k of localKeys("draft:")) if (load(k, undefined) === null) saveLocal(k, null);
  $("#scroller").addEventListener("mousedown", (e) => {
    // Clicking the empty page below the text puts the caret at the end. Only a left click on the page
    // itself, below the last block, counts. It must not fire for the scrollbar (which belongs to
    // #scroller, so grabbing it used to throw the view to the end of the document), for the margins
    // beside the page, or for the gaps beside and above the text.
    if (app.locked || e.button !== 0 || e.target.id !== "page") return;
    if (e.clientY <= view.dom.getBoundingClientRect().bottom) return;
    e.preventDefault();
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView());
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
      if (handle) { try { openFileObject(await handle.getFile()); } catch (e) { toast("Could not open the file: " + e.message, { kind: "error", timeout: 6000 }); } }
    });
  }
  document.body.classList.add("is-ready");
}
