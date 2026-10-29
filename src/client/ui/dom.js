/**
 * Tiny DOM helpers used by every UI module: element creation, icons, platform key names,
 * debouncing and browser storage. No framework: the UI is built from plain elements with h().
 */
import { icon } from "./icons.js";

// querySelector shorthand.
export const $ = (s, r = document) => r.querySelector(s);

/**
 * Creates an element.
 *
 * props: `class`, `text` (textContent), `html` (innerHTML; only ever pass trusted markup such as our
 * own icons, never document or user text), `style` (object), `dataset` (object), `on…` functions
 * (event listeners, e.g. onclick), anything else as an attribute (true -> empty attribute). null,
 * undefined and false props are skipped, which makes optional attributes easy to write.
 * kids: strings and numbers become text nodes (so text is always escaped), elements are appended,
 * arrays are flattened, null/false are skipped.
 *
 * @example h("button", { class: "btn", type: "button", onclick: save }, svg("Save", 16), "Save")
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}

// An icon from ui/icons.js as an SVG element. `sw` is the stroke width (default 1.5).
export function svg(name, size, sw) {
  const t = document.createElement("template");
  t.innerHTML = icon(name, size, sw);
  return t.content.firstChild;
}

// Platform key names for shortcut labels: ⌘ ⌥ ⇧ on Apple devices, Ctrl Alt Shift elsewhere.
export const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
export const MOD = MAC ? "⌘" : "Ctrl";
export const ALT = MAC ? "⌥" : "Alt";
export const SHIFT = MAC ? "⇧" : "Shift";

// Splits a keymap-style shortcut into display names: "Mod-Shift-8" -> ["Ctrl", "Shift", "8"] (or ["⌘", "⇧", "8"]).
export function keyParts(spec) {
  if (!spec) return [];
  return spec.split("-").map((p) => ({ Mod: MOD, Alt: ALT, Shift: SHIFT, Enter: "↵", Backspace: "⌫", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓" }[p] || p.toUpperCase()));
}
// A shortcut as <span class=cls><kbd>…</kbd>…</span> chips, or null when there is no shortcut.
export function kbd(spec, cls = "kbd") {
  const parts = keyParts(spec);
  if (!parts.length) return null;
  return h("span", { class: cls }, parts.map((p) => h("kbd", null, p)));
}

// Limits v to the range [a, b].
export function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
// Escapes text for use inside HTML text or a double-quoted attribute.
export function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/**
 * Delays calls to `fn` until `ms` have passed without another call (the last call's arguments win).
 * The returned function also has .flush(...args) to run at once and .cancel() to drop a pending call.
 */
export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// localStorage, if it can be used: it is missing or throws in some private modes and when storage is
// blocked. Without it settings and drafts simply are not kept; nothing else breaks.
const store = (() => { try { const k = "__t"; localStorage.setItem(k, k); localStorage.removeItem(k); return localStorage; } catch { return null; } })();
/**
 * Reads a JSON value saved with save(). Keys are prefixed with "mde:" (public/index.html reads
 * "mde:settings" directly to set the theme before the first paint).
 * @returns the stored value, or `fallback` when missing, unreadable or storage is unavailable
 */
export function load(key, fallback) {
  try { const v = store && store.getItem("mde:" + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
// Stores a JSON value. Fails silently (full or blocked storage): callers treat storage as best effort.
// Saving null stores "null", which load() returns as null; that is how drafts are cleared.
export function save(key, value) {
  try { store && store.setItem("mde:" + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
