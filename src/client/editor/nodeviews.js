/**
 * Node views: the parts of the document that need more than the schema's toDOM to display and edit.
 *
 *   CodeBlockView   language menu, copy and wrap buttons; Mermaid blocks drawn as diagrams
 *   MathInlineView  rendered KaTeX; click opens a popover TeX editor (openMathEditor)
 *   MathBlockView   rendered KaTeX; click opens an editor under the equation with a live preview
 *   TaskItemView    the clickable checkbox of a checklist item
 *   DetailsView     the fold/unfold arrow of a collapsible section
 *   ImageView       resolves document-relative image paths to blob: URLs read from storage
 *
 * ProseMirror node view contract used throughout: `dom` is the outer element; `contentDOM` (when
 * present) is where ProseMirror renders the node's editable children; update(node) returns false when
 * the view cannot show the new node (ProseMirror then recreates it); stopEvent(e) returning true keeps
 * ProseMirror from handling events on our own controls; ignoreMutation(m) returning true tells it that
 * DOM changes we make (buttons, rendered math) are not edits to read back into the document.
 *
 * Security: rendered math and diagrams are inserted as HTML. KaTeX runs with trust: false and Mermaid
 * with securityLevel "strict" (which sanitizes labels and disables click handlers), and every error
 * message is escaped, so document content cannot inject script through them.
 */
import { NodeSelection, TextSelection } from "prosemirror-state";
import { h, svg, escapeHtml } from "../ui/dom.js";
import { openPopover, buildMenu, toast, segmented } from "../ui/overlay.js";
import { renderMath } from "../../shared/math.js";
import { LANGUAGES, langLabel, normalizeLang, highlightCode } from "../../shared/highlight.js";
import { detailsKey } from "./details-plugin.js";
import { resolveSrc } from "../app/assets.js";

/* ---------- code blocks: language pill, copy, wrap, mermaid preview ---------- */
// Mermaid is large (~2 MB), so it is loaded only when the first diagram is shown, and once: every
// diagram shares the promise. The theme is fixed when it loads (dark or neutral, from the page theme).
let mermaidLoader = null;
export function loadMermaid() {
  if (!mermaidLoader) mermaidLoader = import("mermaid").then((m) => {
    const mermaid = m.default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "neutral", fontFamily: "inherit" });
    return mermaid;
  });
  return mermaidLoader;
}
// Renders Mermaid source to SVG markup. Each render needs a unique element id. On a syntax error
// Mermaid leaves a temporary error element ("d" + id) in the page, which is removed here.
// Returns {svg} or {error: first line of the message}; never throws.
let diagramSeq = 0;
export async function renderMermaid(code) {
  const mermaid = await loadMermaid();
  const id = "mmd" + ++diagramSeq;
  try { const { svg: out } = await mermaid.render(id, code); return { svg: out }; }
  catch (e) { document.getElementById("d" + id)?.remove(); return { error: String(e && e.message || e).split("\n")[0] }; }
}

/**
 * Code block view. The header (contenteditable=false) holds the controls; the code itself is the
 * contentDOM, coloured by highlight-plugin.js decorations.
 *
 * Mermaid blocks have two modes: "preview" (the diagram, shown when the block is not being edited)
 * and "code" (the source). Double-clicking the diagram or pressing the code button switches to code
 * with the cursor inside. Diagrams re-render when the code changes; an older render that finishes
 * after a newer one started is dropped (renderedCode check), so the newest code always wins.
 * Line wrapping is a view-only toggle, never saved.
 */
export class CodeBlockView {
  constructor(node, view, getPos) {
    this.node = node; this.view = view; this.getPos = getPos;
    this.mode = "code";
    this.dom = h("div", { class: "code-block" });
    this.langBtn = h("button", { class: "code-lang", type: "button", "data-tip": "Change language" });
    this.langBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.langBtn.addEventListener("click", () => this.pickLanguage());
    this.copyBtn = h("button", { class: "code-tool", type: "button", "data-tip": "Copy code" }, svg("Copy", 15));
    this.copyBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.copyBtn.addEventListener("click", () => this.copy());
    this.wrapBtn = h("button", { class: "code-tool", type: "button", "data-tip": "Wrap lines" }, svg("Wrap", 15));
    this.wrapBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.wrapBtn.addEventListener("click", () => {
      const on = !this.dom.hasAttribute("data-wrap");
      this.dom.toggleAttribute("data-wrap", on);
      this.wrapBtn.classList.toggle("is-on", on);
    });
    this.previewBtn = h("button", { class: "code-tool code-preview-btn", type: "button", "data-tip": "Show code" }, svg("Code", 15));
    this.previewBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.previewBtn.addEventListener("click", () => this.setMode(this.mode === "preview" ? "code" : "preview"));
    this.head = h("div", { class: "code-head", contenteditable: "false" }, this.previewBtn, this.wrapBtn, this.copyBtn, this.langBtn);
    this.contentDOM = h("code", { spellcheck: "false" });
    this.pre = h("pre", { spellcheck: "false" }, this.contentDOM);
    this.diagram = h("div", { class: "diagram", contenteditable: "false", hidden: true });
    this.diagram.addEventListener("dblclick", () => this.setMode("code"));
    this.dom.append(this.head, this.pre, this.diagram);
    this.sync();
    if (this.isMermaid()) this.setMode("preview");
  }
  // Whether this block's language is Mermaid (aliases normalised).
  isMermaid() { return normalizeLang(this.node.attrs.language) === "mermaid"; }
  // Refreshes the language label ("auto (Python)" when detected), the preview button and the diagram.
  sync() {
    const lang = this.node.attrs.language;
    let label = lang ? langLabel(lang) : "";
    if (!lang) {
      const r = highlightCode(this.node.textContent, "");
      label = r.detected ? "auto (" + langLabel(r.language) + ")" : "auto";
    }
    this.langBtn.replaceChildren(h("span", null, label), svg("ChevronDown", 12));
    this.dom.dataset.language = normalizeLang(lang) || "";
    this.previewBtn.hidden = !this.isMermaid();
    if (this.isMermaid() && this.mode === "preview") this.renderDiagram();
    if (!this.isMermaid() && this.mode === "preview") this.setMode("code");
  }
  // Switches a Mermaid block between "preview" and "code"; non-Mermaid blocks always stay in "code".
  setMode(mode) {
    this.mode = mode;
    const prev = mode === "preview" && this.isMermaid();
    this.pre.hidden = prev;
    this.diagram.hidden = !prev;
    this.dom.classList.toggle("is-preview", prev);
    this.previewBtn.dataset.tip = prev ? "Show code" : "Show diagram";
    this.previewBtn.replaceChildren(svg(prev ? "Code" : "Preview", 15));
    if (prev) this.renderDiagram();
    else if (mode === "code" && this.isMermaid()) {
      // put the caret in the code so it can be edited straight away
      const pos = this.getPos();
      if (pos != null) {
        const tr = this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1));
        this.view.dispatch(tr); this.view.focus();
      }
    }
  }
  // Draws the diagram for the current code, skipping work when the code has not changed since the last draw.
  async renderDiagram() {
    const code = this.node.textContent;
    if (code === this.renderedCode) return;
    this.renderedCode = code;
    if (!code.trim()) { this.diagram.innerHTML = '<div class="diagram-empty">Empty diagram. Double-click to edit.</div>'; return; }
    const r = await renderMermaid(code);
    if (code !== this.renderedCode) return;
    if (r.error) this.diagram.innerHTML = '<div class="math-error">Diagram error: ' + escapeHtml(r.error) + "</div>";
    else this.diagram.innerHTML = r.svg;
  }
  // Language menu with a search box. A search with no match offers "Use “…”", so any fence language
  // can be set, including ones without highlighting.
  pickLanguage() {
    const current = normalizeLang(this.node.attrs.language);
    const input = h("input", { class: "input menu-filter", type: "text", placeholder: "Search languages", spellcheck: "false", autocomplete: "off" });
    const items = [{ label: "Auto-detect", value: "", checked: !current }, ...LANGUAGES.map(([v, l]) => ({ label: l, value: v, keywords: v, checked: v === current }))];
    const menu = buildMenu(items, { filter: "", className: "menu-scroll", onRun: (it) => this.setLanguage(it.value) });
    const box = h("div", { class: "menu-with-filter" }, input, menu.el);
    const rec = openPopover(box, { anchor: this.langBtn, side: "bottom", align: "end", gap: 4 });
    menu.el.addEventListener("click", () => rec.close("run"));
    input.addEventListener("input", () => {
      const q = input.value.trim();
      const n = menu.filter(q);
      if (!n && q) menu.setItems([{ label: "Use “" + q + "”", value: q.toLowerCase() }]);
      else if (!q) menu.setItems(items);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && menu.active) { e.preventDefault(); this.setLanguage(menu.active.value); rec.close("run"); return; }
      menu.onKey(e);
    });
    requestAnimationFrame(() => input.focus());
  }
  // Sets the fence language (a node attribute change, so it is undoable and marks the file changed).
  setLanguage(lang) {
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, language: lang }));
    if (normalizeLang(lang) === "mermaid") this.setMode("preview");
    this.view.focus();
  }
  // Copies the code as plain text and briefly shows a tick. The Clipboard API needs a secure context
  // (localhost counts) and permission; failures are reported, not thrown.
  async copy() {
    try {
      await navigator.clipboard.writeText(this.node.textContent);
      this.copyBtn.replaceChildren(svg("Check", 15));
      setTimeout(() => this.copyBtn.replaceChildren(svg("Copy", 15)), 1200);
    } catch { toast("Copy failed", { kind: "error" }); }
  }
  // Re-syncs only when something shown in the header or the diagram depends on the change: the
  // language, auto-detection (no language set), or Mermaid source.
  update(node) {
    if (node.type !== this.node.type) return false;
    const langChanged = node.attrs.language !== this.node.attrs.language;
    const textChanged = node.textContent !== this.node.textContent;
    this.node = node;
    if (langChanged || (!node.attrs.language && textChanged) || (this.isMermaid() && textChanged)) this.sync();
    return true;
  }
  selectNode() { this.dom.classList.add("is-selected"); }
  deselectNode() { this.dom.classList.remove("is-selected"); }
  stopEvent(e) { return this.head.contains(e.target) || this.diagram.contains(e.target); }
  ignoreMutation(m) { return this.head.contains(m.target) || this.diagram.contains(m.target) || (m.type === "attributes" && (m.target === this.dom || m.target === this.pre)); }
}

/* ---------- math ---------- */
// KaTeX HTML for an equation in the editor: a placeholder when empty, the escaped TeX in red (with the
// error as a tooltip) when it does not parse. HTML-only output: MathML is not needed while editing.
function mathHTML(tex, display) {
  if (!tex.trim()) return '<span class="math-empty">' + (display ? "Empty equation" : "Empty") + "</span>";
  const r = renderMath(tex, display, "html");
  return r.error ? '<span class="math-error" title="' + escapeHtml(r.error) + '">' + escapeHtml(tex) + "</span>" : r.html;
}

/**
 * Popover TeX editor for an inline equation at `pos`, with a live preview and an Inline/Display switch.
 *
 * Enter or Done saves; Shift+Enter adds a new line; Escape cancels; clicking outside saves. Saving an
 * empty equation deletes it. Cancelling a *new* equation (isNew) deletes the empty placeholder, so
 * an aborted insert leaves no trace. The `done` flag makes save/cancel run at most once, because
 * closing the popover can itself trigger the outside-click handler.
 *
 * @param {import("prosemirror-view").EditorView} view
 * @param {number} pos     position of the math_inline node
 * @param {{anchor?: Element, isNew?: boolean}} [options]  anchor positions the popover if the node's
 *                         DOM is not available
 */
export function openMathEditor(view, pos, { anchor, isNew = false } = {}) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "math_inline") return;
  let tex = node.attrs.tex, display = node.attrs.display, done = false;
  const ta = h("textarea", { class: "input mono math-input", rows: "1", spellcheck: "false", placeholder: "LaTeX, e.g. \\frac{a}{b}" });
  ta.value = tex;
  const preview = h("div", { class: "math-preview" });
  const err = h("div", { class: "math-preview-error" });
  const mode = segmented([{ value: false, label: "Inline" }, { value: true, label: "Display" }], display, (v) => { display = v; draw(); }, { small: true });
  const doneBtn = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "Done");
  const box = h("div", { class: "math-pop", "data-own-escape": "" },
    h("div", { class: "math-pop-head" }, h("span", { class: "math-pop-title" }, svg("Math", 15), "Equation"), mode.el),
    ta, preview, err,
    h("div", { class: "math-pop-foot" }, h("span", { class: "math-pop-hint" }, "Enter to save · Shift+Enter for a new line · Esc to cancel"), doneBtn));
  function autosize() { ta.style.height = "auto"; ta.style.height = Math.min(220, ta.scrollHeight + 2) + "px"; }
  function draw() {
    tex = ta.value;
    const r = tex.trim() ? renderMath(tex, display, "html") : { html: '<span class="math-empty">Preview</span>' };
    if (r.error) { err.textContent = r.error; preview.classList.add("has-error"); }
    else { err.textContent = ""; preview.classList.remove("has-error"); preview.innerHTML = r.html; }
    autosize();
  }
  function commit() {
    if (done) return; done = true;
    const cur = view.state.doc.nodeAt(pos);
    if (!cur || cur.type.name !== "math_inline") { rec.close("run"); return; }
    let tr = view.state.tr;
    if (!ta.value.trim()) tr = tr.delete(pos, pos + cur.nodeSize);
    else {
      tr = tr.setNodeMarkup(pos, null, { tex: ta.value.trim(), display });
      tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    }
    view.dispatch(tr);
    rec.close("run");
    view.focus();
  }
  function cancel() {
    if (done) return; done = true;
    rec.close("cancel");
    if (isNew) {
      const cur = view.state.doc.nodeAt(pos);
      if (cur && cur.type.name === "math_inline" && !cur.attrs.tex) view.dispatch(view.state.tr.delete(pos, pos + cur.nodeSize));
    } else view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
    view.focus();
  }
  ta.addEventListener("input", draw);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
  });
  doneBtn.addEventListener("click", commit);
  const rec = openPopover(box, {
    rect: () => { const d = view.nodeDOM(pos); return d && d.getBoundingClientRect ? d.getBoundingClientRect() : anchor.getBoundingClientRect(); },
    side: "bottom", align: "start", gap: 8, focus: false,
    onClose: (reason) => { if (reason === "outside" && !done) commit(); }
  });
  draw();
  requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
}

// Equations render when they come within 1200px of the screen, so a document with thousands of
// formulas opens at once instead of rendering all of them up front. Until then the raw TeX is shown
// (class is-pending). One shared IntersectionObserver serves every equation; browsers without it
// render immediately.
const pending = new Map();
let observer = null;
function lazyMath(el, draw) {
  if (!("IntersectionObserver" in window)) { draw(); return; }
  if (!observer) observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const fn = pending.get(e.target);
      observer.unobserve(e.target);
      pending.delete(e.target);
      if (fn) fn();
    }
  }, { rootMargin: "1200px 0px" });
  pending.set(el, draw);
  observer.observe(el);
}

// Inline equation view. The TeX is an attribute, so the view has no contentDOM and ignores all its
// own DOM mutations; clicking opens openMathEditor.
export class MathInlineView {
  constructor(node, view, getPos) {
    this.node = node; this.view = view; this.getPos = getPos;
    this.dom = h("span", { class: "math-inline is-pending" + (node.attrs.display ? " is-display" : "") });
    this.dom.textContent = node.attrs.tex;
    lazyMath(this.dom, () => { this.dom.classList.remove("is-pending"); this.dom.innerHTML = mathHTML(this.node.attrs.tex, this.node.attrs.display); });
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos != null) openMathEditor(this.view, pos, { anchor: this.dom });
    });
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs.tex !== this.node.attrs.tex || node.attrs.display !== this.node.attrs.display) {
      pending.delete(this.dom); this.dom.classList.remove("is-pending");
      this.dom.innerHTML = mathHTML(node.attrs.tex, node.attrs.display);
      this.dom.classList.toggle("is-display", node.attrs.display);
    }
    this.node = node;
    return true;
  }
  selectNode() { this.dom.classList.add("is-selected"); }
  deselectNode() { this.dom.classList.remove("is-selected"); }
  stopEvent(e) { return e.type === "click"; }
  ignoreMutation() { return true; }
}

/**
 * Display equation view. Clicking opens an editor below the rendered equation; typing updates the
 * rendering live (errors are listed under the textarea while the last good rendering stays visible).
 * Enter, Escape, Done and leaving the textarea all save; saving an empty equation turns the block
 * into an empty paragraph so the space can be reused.
 */
export class MathBlockView {
  constructor(node, view, getPos) {
    this.node = node; this.view = view; this.getPos = getPos;
    this.render = h("div", { class: "math-render" }, node.attrs.tex);
    this.dom = h("div", { class: "math-block" }, this.render);
    lazyMath(this.dom, () => this.draw());
    this.render.addEventListener("click", (e) => { e.preventDefault(); this.open(); });
  }
  draw() {
    pending.delete(this.dom);
    this.render.innerHTML = mathHTML(this.node.attrs.tex, true);
  }
  open() {
    if (this.editor) { this.ta.focus(); return; }
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    this.ta = h("textarea", { class: "input mono math-input", rows: "2", spellcheck: "false", placeholder: "LaTeX, e.g. \\sum_{i=1}^{n} x_i" });
    this.ta.value = this.node.attrs.tex;
    this.err = h("div", { class: "math-preview-error" });
    this.editor = h("div", { class: "math-block-editor", contenteditable: "false" },
      this.ta, this.err,
      h("div", { class: "math-pop-foot" }, h("span", { class: "math-pop-hint" }, "Enter to save · Shift+Enter for a new line · Esc to close"),
        h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => this.commit(true) }, "Done")));
    this.dom.appendChild(this.editor);
    this.dom.classList.add("is-editing");
    const autosize = () => { this.ta.style.height = "auto"; this.ta.style.height = Math.min(320, this.ta.scrollHeight + 2) + "px"; };
    this.ta.addEventListener("input", () => {
      const r = this.ta.value.trim() ? renderMath(this.ta.value, true, "html") : { html: '<span class="math-empty">Empty equation</span>' };
      if (r.error) this.err.textContent = r.error;
      else { this.err.textContent = ""; this.render.innerHTML = r.html; }
      autosize();
    });
    this.ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.commit(true); }
    });
    this.ta.addEventListener("blur", () => setTimeout(() => { if (this.editor && !this.editor.contains(document.activeElement)) this.commit(false); }, 0));
    requestAnimationFrame(() => { autosize(); this.ta.focus(); this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length); });
  }
  // Closes the editor and writes the TeX back. With refocus, the cursor is put just after the equation.
  commit(refocus) {
    if (!this.editor) return;
    const tex = this.ta.value.trim();
    this.editor.remove(); this.editor = null;
    this.dom.classList.remove("is-editing");
    const pos = this.getPos();
    if (pos == null) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur) return;
    let tr = this.view.state.tr;
    if (tex !== cur.attrs.tex) tr = tr.setNodeMarkup(pos, null, { ...cur.attrs, tex });
    if (!tex) tr = tr.replaceWith(pos, pos + cur.nodeSize, this.view.state.schema.nodes.paragraph.create());
    if (refocus) {
      const after = Math.min(tr.doc.content.size, pos + (tex ? cur.nodeSize : 1));
      try { tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after))); } catch { /* keep selection */ }
    }
    this.view.dispatch(tr);
    this.draw();
    if (refocus) this.view.focus();
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.tex !== this.node.attrs.tex;
    this.node = node;
    if (changed && !this.editor) this.draw();
    return true;
  }
  selectNode() { this.dom.classList.add("is-selected"); }
  deselectNode() { this.dom.classList.remove("is-selected"); }
  stopEvent(e) { return !!(this.editor && this.editor.contains(e.target)) || e.type === "click"; }
  ignoreMutation() { return true; }
  destroy() { this.editor = null; }
}

/* ---------- checklist items ---------- */
// Checklist item: a checkbox (role=checkbox for screen readers) beside the item's editable content.
// Toggling it is a document change, so it is undoable and saved as [x] / [ ].
export class TaskItemView {
  constructor(node, view, getPos) {
    this.node = node; this.view = view; this.getPos = getPos;
    this.box = h("span", { class: "task-check", contenteditable: "false", role: "checkbox", tabindex: "-1", "aria-checked": String(node.attrs.checked) }, svg("Check", 14, 2.4));
    this.box.addEventListener("mousedown", (e) => e.preventDefault());
    this.box.addEventListener("click", () => {
      const pos = this.getPos();
      if (pos == null) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { checked: !this.node.attrs.checked }));
    });
    this.contentDOM = h("div", { class: "task-body" });
    this.dom = h("li", { class: "task-item", "data-checked": String(node.attrs.checked) }, this.box, this.contentDOM);
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.dataset.checked = String(node.attrs.checked);
    this.box.setAttribute("aria-checked", String(node.attrs.checked));
    return true;
  }
  stopEvent(e) { return this.box.contains(e.target); }
  ignoreMutation(m) { return this.box.contains(m.target) || m.target === this.dom && m.type === "attributes"; }
}

/* ---------- collapsible sections: open/closed is view state, the file is not changed ---------- */
// Collapsible section: an arrow button beside the summary and body. Open/closed comes from the
// details plugin's decorations (passed in by ProseMirror), falling back to the node's `open` attribute.
export class DetailsView {
  constructor(node, view, getPos, decorations) {
    this.node = node; this.view = view; this.getPos = getPos;
    this.toggle = h("button", { class: "details-toggle", type: "button", contenteditable: "false", tabindex: "-1", "aria-label": "Show or hide" }, svg("ChevronRight", 16));
    this.toggle.addEventListener("mousedown", (e) => e.preventDefault());
    this.toggle.addEventListener("click", () => {
      const pos = this.getPos();
      if (pos != null) this.view.dispatch(this.view.state.tr.setMeta(detailsKey, { toggle: pos }));
    });
    this.contentDOM = h("div", { class: "details-inner" });
    this.dom = h("div", { class: "details" }, this.toggle, this.contentDOM);
    this.setOpen(decorations);
  }
  setOpen(decorations) {
    const d = decorations && decorations.find((x) => x.spec && x.spec.detailsOpen != null);
    const open = d ? d.spec.detailsOpen : this.node.attrs.open;
    this.dom.dataset.open = String(open);
    this.toggle.setAttribute("aria-expanded", String(open));
  }
  update(node, decorations) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.setOpen(decorations);
    return true;
  }
  stopEvent(e) { return this.toggle.contains(e.target); }
  ignoreMutation(m) { return this.toggle.contains(m.target) || (m.type === "attributes" && m.target === this.dom); }
}

/* ---------- images: resolve paths relative to the open file ---------- */
// Image view: displays the image through resolveSrc while the document keeps the path as written.
// Web and data: images show at once; images stored beside the document are read from storage first
// (resolveSrc then returns a promise). Images that fail to load or are missing get class is-broken,
// which doc.css shows as a placeholder with the alt text.
export class ImageView {
  constructor(node) {
    this.node = node;
    this.dom = h("img", { class: "doc-img", alt: node.attrs.alt || "", title: node.attrs.title || null, draggable: "true" });
    this.dom.addEventListener("error", () => this.dom.classList.add("is-broken"));
    this.show(node.attrs.src);
  }
  // Points the <img> at `src`; a slower earlier lookup never overwrites a newer one.
  show(src) {
    this.dom.classList.remove("is-broken");
    const url = resolveSrc(src);
    if (typeof url === "string") { this.dom.src = url; return; }
    url.then((u) => {
      if (this.node.attrs.src !== src) return;
      if (u) this.dom.src = u; else this.dom.classList.add("is-broken");
    });
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.src !== this.node.attrs.src;
    this.node = node;
    if (changed) this.show(node.attrs.src);
    this.dom.alt = node.attrs.alt || "";
    return true;
  }
  selectNode() { this.dom.classList.add("is-selected"); }
  deselectNode() { this.dom.classList.remove("is-selected"); }
}

// Node view constructors by node type, passed to the EditorView in editor/editor.js.
export const nodeViews = {
  code_block: (n, v, g) => new CodeBlockView(n, v, g),
  math_inline: (n, v, g) => new MathInlineView(n, v, g),
  math_block: (n, v, g) => new MathBlockView(n, v, g),
  task_item: (n, v, g) => new TaskItemView(n, v, g),
  details: (n, v, g, d) => new DetailsView(n, v, g, d),
  image: (n) => new ImageView(n)
};
