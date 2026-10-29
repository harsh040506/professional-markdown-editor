/**
 * Smaller dialogs of the app shell: the link editor popover, the keyboard shortcuts sheet, and turning
 * an image file (picked, dropped or pasted) into an image source.
 */
import { TextSelection } from "prosemirror-state";
import { h, svg, kbd } from "../ui/dom.js";
import { openPopover, dialog, toast } from "../ui/overlay.js";
import * as C from "../editor/commands.js";
import { SHORTCUTS } from "../editor/keys.js";
import { store } from "../storage/store.js";
import { forgetAssets } from "./assets.js";

/**
 * Link editor popover under the selection (or the link at the cursor).
 *
 * Fields: the text to show and the URL. A bare domain such as "example.com/page" gets "https://"
 * added; anything with a scheme, an #anchor, or a path starting with "/" or "." is kept as typed (so
 * relative links to other documents work). An empty URL removes an existing link. Whether a link may
 * be *opened* is decided later by app.openLink (see isSafeHref in paths.js).
 *
 * @param {import("prosemirror-view").EditorView} view
 * @param {{from: number, to: number, href: string}} [range]  the link being edited, when known
 */
export function openLinkEditor(view, range) {
  const state = view.state;
  let { from, to } = state.selection;
  const existing = range || C.linkRange(state, from);
  if (existing) { from = existing.from; to = existing.to; }
  const text = h("input", { class: "input", type: "text", placeholder: "Text to show", spellcheck: "false" });
  const url = h("input", { class: "input", type: "text", placeholder: "Paste or type a link", spellcheck: "false", autocomplete: "off" });
  text.value = state.doc.textBetween(from, to, " ");
  url.value = existing ? existing.href : "";
  const apply = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "Apply");
  const remove = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, svg("Unlink", 14), h("span", null, "Remove"));
  remove.hidden = !existing;
  const box = h("div", { class: "link-pop" },
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Text"), text),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Link"), url),
    h("div", { class: "link-pop-foot" }, remove, h("span", { class: "spacer" }), apply));
  const coords = () => {
    const a = view.coordsAtPos(from), b = view.coordsAtPos(to, -1);
    return { left: a.left, right: Math.max(a.right, b.right), top: a.top, bottom: Math.max(a.bottom, b.bottom), width: Math.max(1, b.right - a.left), height: b.bottom - a.top };
  };
  const rec = openPopover(box, { rect: coords, side: "bottom", align: "start", gap: 8, focus: false });
  // Applies the dialog: first restores the selection the popover was opened for (focus moved away).
  function done() {
    let href = url.value.trim();
    if (href && !/^([a-z][a-z0-9+.-]*:|#|\/|\.)/i.test(href) && /^[\w-]+(\.[\w-]+)+/.test(href)) href = "https://" + href;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    if (!href) {
      if (existing) view.dispatch(view.state.tr.removeMark(from, to, view.state.schema.marks.link));
    } else C.setLink(href, text.value)(view.state, view.dispatch);
    rec.close("run");
    view.focus();
  }
  apply.addEventListener("click", done);
  remove.addEventListener("click", () => {
    view.dispatch(view.state.tr.removeMark(from, to, view.state.schema.marks.link));
    rec.close("run"); view.focus();
  });
  [text, url].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(); } }));
  // focus the URL when there is already text to link, else start with the text field
  requestAnimationFrame(() => (text.value || existing ? url : text).focus());
}

// Keyboard shortcuts sheet, from SHORTCUTS in editor/keys.js. Real key combinations are shown as key
// chips with platform names (⌘ or Ctrl); typed Markdown such as "# Space" is shown literally.
export function showShortcuts() {
  const body = h("div", { class: "shortcuts" }, SHORTCUTS.map((g) => h("section", { class: "shortcut-group" },
    h("h3", null, g.group),
    h("dl", null, g.items.map(([label, keys]) => [
      h("dt", null, label),
      h("dd", null, keys.includes(" ") || keys.length === 1 || /[$`#>\[\]]/.test(keys)
        ? keys.split(" / ").map((k, i) => [i ? h("span", { class: "kbd-or" }, "/") : null, /^(Mod|Shift|Alt|Tab|Enter)/.test(k) ? kbd(k) : h("span", { class: "kbd" }, h("kbd", null, k))])
        : keys.split(" / ").map((k, i) => [i ? h("span", { class: "kbd-or" }, "/") : null, kbd(k)]))
    ])))));
  dialog({ title: "Keyboard shortcuts", body, width: 720, className: "dialog-shortcuts" });
}

// Reads a File as a data: URL (base64), which is how images are embedded in a document.
function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}

/**
 * Turns an image file into an image source for the document.
 *
 * With a saved document, the image is stored next to it in assets/ (in the library or the opened folder;
 * a free file name is picked) and the relative path is returned, so the Markdown stays small and portable.
 * Otherwise (untitled document, or storing failed) the image is embedded as a data: URL, with a notice for
 * large images since they bloat the file.
 *
 * @param {File} file
 * @param {string|null} docPath  the open document's path, or null when untitled
 * @returns {Promise<{src: string, alt: string}>} alt text is the file name without extension
 */
export async function imageFromFile(file, docPath) {
  const alt = file.name.replace(/.[^.]+$/, "").replace(/[-_]+/g, " ");
  if (docPath) {
    try {
      const src = await store.saveAsset(docPath, file.name, file);
      forgetAssets();
      return { src, alt };
    } catch (e) { toast("Could not store the image beside the document, embedding it instead: " + e.message, { kind: "error", timeout: 5000 }); }
  } else if (file.size > 1.5 * 1024 * 1024) {
    toast("Large image embedded in the document. Save the document first to store images beside it.", { timeout: 6000 });
  }
  return { src: await readAsDataURL(file), alt };
}
