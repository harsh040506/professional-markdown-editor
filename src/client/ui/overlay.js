/**
 * Floating UI: positioning, popovers, menus (keyboard navigation, filtering, type-ahead), tooltips,
 * toasts, modal dialogs, and the form controls used inside them.
 *
 * The app draws all of its own controls (no native <select>, alert(), confirm() or prompt()), so they
 * look the same in every browser and theme and can be fully keyboard driven. Everything floats in
 * #layer (public/index.html) with position: fixed.
 *
 * Global listeners registered once at module load:
 *   pointerdown outside a popover closes it (and the ones above it); Escape closes the top popover,
 *   or else the top dialog; window resize repositions popovers; window blur closes non-modal popovers;
 *   hovering or keyboard-focusing an element with data-tip shows a tooltip.
 */
import { h, svg, kbd, clamp } from "./dom.js";

/* ---------- positioning ---------- */
/**
 * Places a position:fixed element next to a rectangle (viewport coordinates), flipping to the
 * opposite side when it does not fit and clamping it inside the window with an 8px margin.
 * The element is measured invisibly first, so it never flashes in the wrong place.
 *
 * @param {HTMLElement} el
 * @param {{left:number,right:number,top:number,bottom:number,width:number,height:number}} rect
 * @param {{side?: "bottom"|"top"|"right"|"left", align?: "start"|"center"|"end", gap?: number, margin?: number}} [options]
 * @returns {string} the side actually used (also set as el.dataset.side for CSS arrows/animations)
 */
export function place(el, rect, { side = "bottom", align = "start", gap = 6, margin = 8 } = {}) {
  el.style.left = "0px"; el.style.top = "0px";
  el.style.visibility = "hidden";
  const w = el.offsetWidth, ht = el.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  let x, y;
  if (side === "bottom" || side === "top") {
    if (side === "bottom" && rect.bottom + gap + ht > vh - margin && rect.top - gap - ht >= margin) side = "top";
    else if (side === "top" && rect.top - gap - ht < margin && rect.bottom + gap + ht <= vh - margin) side = "bottom";
    y = side === "bottom" ? rect.bottom + gap : rect.top - gap - ht;
    x = align === "center" ? rect.left + rect.width / 2 - w / 2 : align === "end" ? rect.right - w : rect.left;
  } else {
    if (side === "right" && rect.right + gap + w > vw - margin && rect.left - gap - w >= margin) side = "left";
    else if (side === "left" && rect.left - gap - w < margin) side = "right";
    x = side === "right" ? rect.right + gap : rect.left - gap - w;
    y = align === "center" ? rect.top + rect.height / 2 - ht / 2 : align === "end" ? rect.bottom - ht : rect.top;
  }
  x = clamp(x, margin, Math.max(margin, vw - w - margin));
  y = clamp(y, margin, Math.max(margin, vh - ht - margin));
  el.style.left = Math.round(x) + "px"; el.style.top = Math.round(y) + "px";
  el.style.visibility = "";
  el.dataset.side = side;
  return side;
}

/* ---------- popover stack ---------- */
// Open popovers, oldest first. A popover opened from inside another sits above it in the stack.
const stack = [];
/**
 * Shows `el` as a popover next to `anchor` (an element) or `rect` (a rect, or a function returning
 * one, for anchors that move such as text positions).
 *
 * Options: side/align/gap (see place), onClose(reason), keepOpenOn (a CSS selector whose elements may
 * be clicked without closing it, e.g. the editor for the slash menu), modal (survives window blur),
 * focus (move focus to its first control; default true).
 * Close reasons: "run" (an item was chosen), "outside", "escape", "blur", "cancel", or a caller's own.
 * Closing a popover also closes every popover opened after it. The anchor gets aria-expanded and,
 * on Escape, its focus back.
 *
 * @returns {{el: HTMLElement, reposition(): void, close(reason?: string): void}}
 */
export function openPopover(el, { anchor = null, rect = null, side, align, gap, onClose, keepOpenOn = null, modal = false, focus = true } = {}) {
  const layer = document.getElementById("layer") || document.body;
  el.classList.add("pop");
  layer.appendChild(el);
  const getRect = () => rect ? (typeof rect === "function" ? rect() : rect) : anchor.getBoundingClientRect();
  const rec = {
    el, anchor, keepOpenOn, modal,
    reposition() { place(el, getRect(), { side, align, gap }); },
    close(reason) {
      const i = stack.indexOf(rec);
      if (i < 0) return;
      // closing a popover closes the ones opened from it
      stack.splice(i).reverse().forEach((r) => {
        if (r !== rec) r.close(reason);
      });
      el.remove();
      if (anchor) { anchor.setAttribute("aria-expanded", "false"); anchor.classList.remove("is-open"); }
      if (onClose) onClose(reason);
      if (reason === "escape" && anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
    }
  };
  if (anchor) { anchor.setAttribute("aria-expanded", "true"); anchor.classList.add("is-open"); }
  stack.push(rec);
  rec.reposition();
  if (focus) {
    const f = el.querySelector("[autofocus]") || el.querySelector("input, textarea, [tabindex='0'], button:not([disabled])");
    if (f) requestAnimationFrame(() => f.focus({ preventScroll: true }));
  }
  return rec;
}
// Closes every popover, newest first (used when a dialog opens or the document is replaced).
export function closeAllPopovers(reason) { stack.slice().reverse().forEach((r) => r.close(reason)); }

// A press outside closes popovers from the top down, stopping at the first one that contains the
// target (or whose anchor or keepOpenOn area does). Capture phase, so it runs before the click lands.
document.addEventListener("pointerdown", (e) => {
  for (const r of stack.slice().reverse()) {
    if (r.el.contains(e.target)) return; // inside the top-most one that contains it; keep that and below
    if (r.anchor && r.anchor.contains(e.target)) return;
    if (r.keepOpenOn && e.target.closest && e.target.closest(r.keepOpenOn)) return;
    r.close("outside");
  }
}, true);
// Escape closes the top popover, unless it handles Escape itself (data-own-escape, e.g. the TeX editor).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !stack.length) return;
  const top = stack[stack.length - 1];
  if (top.el.dataset.ownEscape) return;
  e.preventDefault(); e.stopPropagation();
  top.close("escape");
}, true);
window.addEventListener("resize", () => stack.forEach((r) => r.reposition()));
window.addEventListener("blur", () => stack.slice().reverse().forEach((r) => { if (!r.modal) r.close("blur"); }));

/* ---------- menus ---------- */
/**
 * Builds a menu element (not yet shown; see menuFromButton / openPopover).
 *
 * Item fields: label, icon (name or element), indent (blank icon space), desc (second line), hint
 * (right-aligned text), kbd (shortcut chip), checked (true/false shows a check and makes it a
 * menuitemcheckbox), disabled, danger (red), run(), keep (do not close after run), keywords (extra
 * filter words), submenu: () => items, render(rowEl) (last-minute customisation),
 * type: "header" | "sep". Leading, doubled and trailing separators are dropped automatically.
 *
 * Keyboard: arrows, Home/End, Enter (and Space, or Tab when filtering) to run, ArrowRight for a
 * submenu, and type-ahead on the first letter when there is no filter box.
 *
 * @param {object[]} items
 * @param {{onRun?: (item) => void, filter?: string|null, className?: string, emptyText?: string, width?: number}} [options]
 *        filter non-null means a search box drives the menu (first item pre-highlighted)
 * @returns {{el: HTMLElement, onKey(e: KeyboardEvent): boolean, setItems(items): void,
 *            filter(query: string): number, focus(): void, readonly active: object|null}}
 *          filter() returns the number of matching items
 */
export function buildMenu(items, { onRun, filter = null, className = "", emptyText = "No results", width } = {}) {
  const root = h("div", { class: "menu " + className, role: "menu", tabindex: "-1" });
  if (width) root.style.width = width + "px";
  const list = h("div", { class: "menu-list" });
  root.appendChild(list);
  let rows = [], active = -1, current = items;

  function render(its) {
    list.textContent = "";
    rows = [];
    let lastWasSep = true;
    its.forEach((it) => {
      if (it.type === "sep") {
        if (!lastWasSep) list.appendChild(h("div", { class: "menu-sep", role: "separator" }));
        lastWasSep = true;
        return;
      }
      if (it.type === "header") { list.appendChild(h("div", { class: "menu-header" }, it.label)); lastWasSep = false; return; }
      lastWasSep = false;
      const row = h("button", {
        class: "menu-item" + (it.danger ? " is-danger" : "") + (it.checked ? " is-checked" : ""),
        role: it.checked != null ? "menuitemcheckbox" : "menuitem", type: "button", tabindex: "-1",
        disabled: it.disabled || null, "aria-checked": it.checked != null ? String(!!it.checked) : null
      },
      it.icon ? h("span", { class: "menu-icon" }, typeof it.icon === "string" ? svg(it.icon, 16) : it.icon) : (it.indent ? h("span", { class: "menu-icon" }) : null),
      h("span", { class: "menu-label" }, it.label, it.desc ? h("span", { class: "menu-desc" }, it.desc) : null),
      it.hint ? h("span", { class: "menu-hint" }, it.hint) : null,
      it.kbd ? kbd(it.kbd, "menu-kbd") : null,
      it.checked ? h("span", { class: "menu-check" }, svg("Check", 16)) : null,
      it.submenu ? h("span", { class: "menu-sub" }, svg("ChevronRight", 14)) : null);
      if (it.render) it.render(row);
      const idx = rows.length;
      row.addEventListener("pointermove", () => setActive(idx, false));
      row.addEventListener("click", (e) => { e.preventDefault(); activate(idx); });
      rows.push({ el: row, it });
      list.appendChild(row);
    });
    // drop a trailing separator
    if (list.lastChild && list.lastChild.classList.contains("menu-sep")) list.lastChild.remove();
    if (!rows.length) list.appendChild(h("div", { class: "menu-empty" }, emptyText));
    active = -1;
    const first = rows.findIndex((r) => !r.it.disabled);
    if (filter != null || root.dataset.autoActive) setActive(first, true);
  }
  function setActive(i, scroll = true) {
    if (active >= 0 && rows[active]) rows[active].el.classList.remove("is-active");
    active = i;
    if (i >= 0 && rows[i]) {
      rows[i].el.classList.add("is-active");
      if (scroll) rows[i].el.scrollIntoView({ block: "nearest" });
    }
  }
  function move(d) {
    if (!rows.length) return;
    let i = active;
    for (let n = 0; n < rows.length; n++) {
      i = (i + d + rows.length) % rows.length;
      if (!rows[i].it.disabled) { setActive(i); return; }
    }
  }
  function activate(i) {
    const r = rows[i];
    if (!r || r.it.disabled) return;
    if (r.it.submenu) { openSub(r); return; }
    if (onRun) onRun(r.it);
    if (r.it.run) r.it.run();
  }
  let sub = null;
  function openSub(r) {
    if (sub) sub.close();
    const m = buildMenu(r.it.submenu(), { onRun });
    sub = openPopover(m.el, { anchor: r.el, side: "right", align: "start", gap: 4 });
    m.focus();
  }
  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return true; }
    if (e.key === "Home") { e.preventDefault(); setActive(rows.findIndex((r) => !r.it.disabled)); return true; }
    if (e.key === "End") { e.preventDefault(); for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].it.disabled) { setActive(i); break; } return true; }
    if (e.key === "Enter" || (e.key === "Tab" && filter != null && active >= 0)) { if (active >= 0) { e.preventDefault(); activate(active); return true; } }
    if (e.key === "ArrowRight" && active >= 0 && rows[active].it.submenu) { e.preventDefault(); openSub(rows[active]); return true; }
    if (e.key === " " && filter == null && active >= 0) { e.preventDefault(); activate(active); return true; }
    if (filter == null && e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      // type-ahead
      const ch = e.key.toLowerCase();
      for (let n = 1; n <= rows.length; n++) {
        const i = (active + n) % rows.length;
        if (!rows[i].it.disabled && String(rows[i].it.label).toLowerCase().startsWith(ch)) { setActive(i); return true; }
      }
    }
    return false;
  }
  root.addEventListener("keydown", (e) => { if (onKey(e)) e.stopPropagation(); });
  render(items);
  return {
    el: root,
    onKey,
    setItems(its) { current = its; render(its); },
    filter(q) {
      q = q.trim().toLowerCase();
      const its = !q ? current : current.filter((it) => it.type !== "header" && it.type !== "sep" &&
        (String(it.label).toLowerCase().includes(q) || (it.keywords || "").toLowerCase().includes(q)));
      render(its);
      return its.length;
    },
    focus() { root.focus({ preventScroll: true }); if (active < 0) move(1); },
    get active() { return active >= 0 ? rows[active].it : null; }
  };
}

// Opens a menu as a popover under a trigger button, focused with its first item highlighted. Choosing an
// item closes it unless the item has `keep`. Returns the menu and its popover record.
export function menuFromButton(btn, items, opts = {}) {
  const m = buildMenu(typeof items === "function" ? items() : items, {
    ...opts,
    onRun: (it) => { if (!it.keep) rec.close("run"); if (opts.onRun) opts.onRun(it); }
  });
  const rec = openPopover(m.el, { anchor: btn, side: opts.side || "bottom", align: opts.align || "start", gap: 4, onClose: opts.onClose });
  m.el.dataset.autoActive = "";
  m.focus();
  return { menu: m, popover: rec };
}

/* ---------- tooltips: any element with data-tip (and optional data-kbd) ---------- */
// One tooltip at a time. It appears after 450 ms of hovering, or at once when another tooltip was
// shown less than 400 ms ago (moving along a toolbar), and on keyboard focus (:focus-visible only, so
// mouse clicks do not pop tooltips). Any press, key or scroll hides it. Elements with an open menu
// (.is-open) show no tooltip, since the menu would cover it.
let tipEl = null, tipFor = null, tipTimer = 0, lastHide = 0;
function hideTip() { clearTimeout(tipTimer); tipFor = null; if (tipEl) { tipEl.remove(); tipEl = null; lastHide = Date.now(); } }
function showTip(t) {
  const text = t.getAttribute("data-tip");
  if (!text || !t.isConnected) return;
  if (tipEl) tipEl.remove();
  tipEl = h("div", { class: "tooltip", role: "tooltip" }, text, t.dataset.kbd ? kbd(t.dataset.kbd, "tooltip-kbd") : null);
  (document.getElementById("layer") || document.body).appendChild(tipEl);
  place(tipEl, t.getBoundingClientRect(), { side: t.dataset.tipSide || "bottom", align: "center", gap: 6 });
}
document.addEventListener("pointerover", (e) => {
  const t = e.target.closest && e.target.closest("[data-tip]");
  if (t === tipFor) return;
  if (!t || t.classList.contains("is-open")) { hideTip(); return; }
  clearTimeout(tipTimer);
  tipFor = t;
  const warm = tipEl || Date.now() - lastHide < 400;
  tipTimer = setTimeout(() => showTip(t), warm ? 0 : 450);
});
document.addEventListener("focusin", (e) => {
  const t = e.target.closest && e.target.closest("[data-tip]");
  if (t && t.matches(":focus-visible")) { tipFor = t; showTip(t); }
});
document.addEventListener("focusout", hideTip);
document.addEventListener("pointerdown", hideTip, true);
document.addEventListener("keydown", hideTip, true);
window.addEventListener("scroll", hideTip, true);

/* ---------- toasts ---------- */
/**
 * Shows a short message at the bottom of the window (announced to screen readers via aria-live).
 *
 * @param {string} message
 * @param {{kind?: "info"|"success"|"error"|"busy", timeout?: number, action?: {label: string, run(): void}}} [options]
 *        timeout in ms; 0 keeps it until dismissed. "busy" shows a spinner (use timeout 0 and update()).
 * @returns {{dismiss(): void, update(message: string, kind: string, ms?: number): void}}
 *          update() turns a busy toast into its result ("Saving…" -> "Saved")
 * @example
 *   const t = toast("Exporting…", { kind: "busy", timeout: 0 });
 *   try { await work(); t.update("Exported", "success"); } catch (e) { t.update(e.message, "error", 7000); }
 */
export function toast(message, { kind = "info", timeout = 2600, action = null } = {}) {
  let host = document.getElementById("toasts");
  if (!host) { host = h("div", { id: "toasts", class: "toasts", "aria-live": "polite" }); document.body.appendChild(host); }
  const t = h("div", { class: "toast is-" + kind, role: "status" },
    kind === "busy" ? h("span", { class: "toast-icon spin" }, svg("Spinner", 16)) :
      kind === "error" ? h("span", { class: "toast-icon" }, svg("Warning", 16)) :
        kind === "success" ? h("span", { class: "toast-icon" }, svg("Check", 16)) : null,
    h("span", { class: "toast-text" }, message),
    action ? h("button", { class: "toast-action", type: "button", onclick: () => { action.run(); dismiss(); } }, action.label) : null);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("is-in"));
  let timer = timeout ? setTimeout(dismiss, timeout) : 0;
  function dismiss() { clearTimeout(timer); t.classList.remove("is-in"); setTimeout(() => t.remove(), 180); }
  return {
    dismiss,
    update(msg, k, ms = 2600) {
      t.className = "toast is-in is-" + k;
      t.querySelector(".toast-text").textContent = msg;
      const ic = t.querySelector(".toast-icon");
      const icon = k === "error" ? svg("Warning", 16) : k === "success" ? svg("Check", 16) : k === "busy" ? svg("Spinner", 16) : null;
      if (ic) { if (icon) { ic.replaceChildren(icon); ic.className = "toast-icon" + (k === "busy" ? " spin" : ""); } else ic.remove(); }
      clearTimeout(timer); if (ms) timer = setTimeout(dismiss, ms);
    }
  };
}

/* ---------- modal dialogs ---------- */
// Open dialogs, oldest first. Escape closes the top one, but only when no popover is open (the popover
// gets that Escape first).
const dialogs = [];
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !dialogs.length || stack.length) return;
  e.preventDefault(); e.stopPropagation();
  dialogs[dialogs.length - 1].close("cancel");
}, true);
/**
 * Opens a modal dialog over a scrim.
 *
 * Accessibility: role=dialog + aria-modal, labelled by its title; focus moves to the [autofocus]
 * element, the first field, or the primary button; Tab is trapped inside; focus returns to where it
 * was on close. Clicking the scrim, the close button or pressing Escape closes it with "cancel".
 *
 * @param {{title: string, body: Node, actions?: {label: string, variant?: string, icon?: string, id?: string,
 *          run(close: Function, button: HTMLButtonElement): void}[], width?: number,
 *          onClose?: (reason: string) => void, className?: string}} options
 *        Actions do not close the dialog on their own: run() calls close() when it is done, which lets
 *        an action validate first or keep the dialog open on error.
 * @returns {{el: HTMLElement, close(reason?: string): void}}
 */
export function dialog({ title, body, actions = [], width = 440, onClose, className = "" }) {
  const layer = document.getElementById("layer") || document.body;
  const prevFocus = document.activeElement;
  const panel = h("div", { class: "dialog " + className, role: "dialog", "aria-modal": "true", "aria-label": title, tabindex: "-1", style: { width: width + "px" } },
    h("div", { class: "dialog-head" },
      h("div", { class: "dialog-title" }, title),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", "data-tip": "Close", onclick: () => close("cancel") }, svg("Close", 16))),
    h("div", { class: "dialog-body" }, body),
    actions.length ? h("div", { class: "dialog-foot" }, actions.map((a) => {
      const b = button(a.label, { variant: a.variant || "ghost", icon: a.icon, onClick: () => a.run(close, b) });
      if (a.id) b.id = a.id;
      return b;
    })) : null);
  const scrim = h("div", { class: "scrim" }, panel);
  scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close("cancel"); });
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !stack.length) { e.preventDefault(); close("cancel"); }
    if (e.key === "Tab") {
      const f = Array.from(panel.querySelectorAll("button:not([disabled]), input, textarea, [tabindex='0']")).filter((x) => x.offsetParent);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  });
  layer.appendChild(scrim);
  requestAnimationFrame(() => {
    scrim.classList.add("is-in");
    const f = panel.querySelector("[autofocus]") || panel.querySelector(".dialog-body input, .dialog-body textarea, .dialog-foot .btn-primary");
    (f || panel).focus();
  });
  let closed = false;
  const self = { el: panel, close: (r) => close(r) };
  dialogs.push(self);
  function close(reason) {
    if (closed) return;
    closed = true;
    const di = dialogs.indexOf(self); if (di >= 0) dialogs.splice(di, 1);
    closeAllPopovers("dialog");
    scrim.classList.remove("is-in");
    setTimeout(() => scrim.remove(), 150);
    if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    if (onClose) onClose(reason);
  }
  return self;
}

// Yes/no dialog. Resolves true only when the confirm button was pressed (closing in any other way is "no").
// danger styles the confirm button red, for destructive actions.
export function confirmDialog({ title, message, confirm = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    dialog({
      title, width: 400,
      body: h("p", { class: "dialog-text" }, message),
      actions: [
        { label: "Cancel", run: (close) => close() },
        { label: confirm, variant: danger ? "danger" : "primary", run: (close) => { result = true; close(); } }
      ],
      onClose: () => resolve(result)
    });
  });
}

/**
 * Single text field dialog. Resolves the trimmed text, or null when cancelled.
 * validate(value) returns an error message to show (the dialog stays open) or "" to accept.
 * Enter submits; the initial value is pre-selected so it can be typed over.
 */
export function promptDialog({ title, label, value = "", placeholder = "", confirm = "Save", validate }) {
  return new Promise((resolve) => {
    let result = null;
    const field = textField({ label, value, placeholder, autofocus: true });
    const err = h("div", { class: "field-error" });
    const d = dialog({
      title, width: 420,
      body: h("div", null, field.el, err),
      actions: [
        { label: "Cancel", run: (close) => close() },
        { label: confirm, variant: "primary", run: (close) => submit(close) }
      ],
      onClose: () => resolve(result)
    });
    function submit(close) {
      const v = field.value.trim();
      const msg = validate ? validate(v) : "";
      if (msg) { err.textContent = msg; return; }
      result = v; close();
    }
    field.input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(d.close); } });
    field.input.select();
  });
}

/* ---------- controls ---------- */
// A styled button. variant: ghost | primary | danger; with no label it is an icon button labelled by `tip`.
export function button(label, { variant = "ghost", icon, onClick, tip, kbd: k, size, disabled, cls = "" } = {}) {
  const b = h("button", {
    class: "btn btn-" + variant + (size ? " btn-" + size : "") + (label ? "" : " btn-icon") + (cls ? " " + cls : ""),
    type: "button", "data-tip": tip || null, "data-kbd": k || null, "aria-label": !label && tip ? tip : null, disabled: disabled || null
  }, icon ? svg(icon, 16) : null, label ? h("span", { class: "btn-label" }, label) : null);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

// A labelled text input (or textarea). Returns the wrapper `el`, the `input`, and a value getter/setter.
export function textField({ label, value = "", placeholder = "", autofocus = false, mono = false, multiline = false, rows = 3, onInput } = {}) {
  const input = multiline
    ? h("textarea", { class: "input" + (mono ? " mono" : ""), rows, placeholder, spellcheck: "false" })
    : h("input", { class: "input" + (mono ? " mono" : ""), type: "text", placeholder, spellcheck: "false", autocomplete: "off" });
  input.value = value;
  if (autofocus) input.setAttribute("autofocus", "");
  if (onInput) input.addEventListener("input", () => onInput(input.value));
  const el = h("label", { class: "field" }, label ? h("span", { class: "field-label" }, label) : null, input);
  return { el, input, get value() { return input.value; }, set value(v) { input.value = v; } };
}

// A segmented control (radio group): one of a few options, with Left/Right arrow navigation and a single
// tab stop (roving tabindex). options: [{value, label?, icon?, tip?}]. onChange runs on user choices only.
export function segmented(options, value, onChange, { label, small } = {}) {
  const el = h("div", { class: "segmented" + (small ? " is-small" : ""), role: "radiogroup", "aria-label": label || null });
  const btns = options.map((o) => {
    const b = h("button", { type: "button", role: "radio", class: "seg", "aria-checked": String(o.value === value), "data-tip": o.tip || null },
      o.icon ? svg(o.icon, 15) : null, o.label ? h("span", null, o.label) : null);
    b.addEventListener("click", () => set(o.value, true));
    return b;
  });
  btns.forEach((b) => el.appendChild(b));
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const n = (i + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    set(options[n].value, true); btns[n].focus();
  });
  function set(v, fire) {
    value = v;
    btns.forEach((b, i) => { b.setAttribute("aria-checked", String(options[i].value === v)); b.tabIndex = options[i].value === v ? 0 : -1; });
    if (fire && onChange) onChange(v);
  }
  set(value, false);
  return { el, set: (v) => set(v, false), get value() { return value; } };
}

// An on/off switch (role=switch). onChange receives the new value.
export function toggle(checked, onChange, { label } = {}) {
  const sw = h("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(!!checked), "aria-label": label || null }, h("span", { class: "switch-thumb" }));
  sw.addEventListener("click", () => { checked = !checked; sw.setAttribute("aria-checked", String(checked)); if (onChange) onChange(checked); });
  return { el: sw, get value() { return checked; }, set(v) { checked = v; sw.setAttribute("aria-checked", String(v)); } };
}

// A settings row for dialogs: label and optional hint on the left, the control on the right.
export function row(label, control, hint) {
  return h("div", { class: "form-row" },
    h("div", { class: "form-row-text" }, h("div", { class: "form-row-label" }, label), hint ? h("div", { class: "form-row-hint" }, hint) : null),
    h("div", { class: "form-row-control" }, control));
}
