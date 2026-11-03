/**
 * Find and replace panel (Mod-F, Mod-H / Mod-Alt-F), with every match highlighted in the document.
 *
 * Matching lives in editor/search.js. This plugin keeps the matches in its state, recomputed after every
 * edit while the panel is open, so the count and highlights never go stale; the "current" match is
 * drawn differently and is what Enter / F3 move between. Selecting a match also opens any collapsed
 * section holding it (editor.js revealSelection). Replace All is a single transaction: one Undo
 * restores everything.
 *
 * The panel floats in #layer like the other editor UI. Its query is remembered for the page's lifetime,
 * so reopening the panel (or opening it in another document) offers the last search.
 */
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { h, svg, debounce } from "../ui/dom.js";
import { toast } from "../ui/overlay.js";
import { buildQuery, findMatches, expandReplacement, replaceMatch, replaceAll, MAX_MATCHES } from "./search.js";

export const findKey = new PluginKey("find");

// The last search, shared by every document opened in this page.
const query = { text: "", replace: "", caseSensitive: false, wholeWord: false, regex: false };
// The panel of the live editor state (one editor per page), so commands can reach it.
let panel = null;

const CLOSED = { open: false, matches: [], truncated: false, error: null, current: -1, decos: DecorationSet.empty };

// Recomputes the matches. `near` is a document position: the current match becomes the first match at
// or after it (wrapping to the first), so typing or editing keeps the place.
function compute(doc, near) {
  const { re, error } = buildQuery(query);
  const { matches, truncated } = findMatches(doc, re);
  let current = -1;
  if (matches.length && near != null) {
    current = matches.findIndex((m) => m.from >= near);
    if (current < 0) current = 0;
  }
  const decos = DecorationSet.create(doc, matches.map((m) => Decoration.inline(m.from, m.to, { class: "find-match" })));
  return { open: true, matches, truncated, error, current, decos };
}

export function findPlugin() {
  return new Plugin({
    key: findKey,
    state: {
      init: () => CLOSED,
      apply(tr, st, _old, state) {
        const meta = tr.getMeta(findKey);
        if (meta && meta.close) return CLOSED;
        if (meta && meta.search) return compute(state.doc, meta.near != null ? meta.near : state.selection.from);
        if (!st.open) return st;
        if (tr.docChanged) {
          const prev = st.matches[st.current];
          const near = meta && meta.after != null ? meta.after : prev ? tr.mapping.map(prev.from, -1) : null;
          return compute(state.doc, near);
        }
        if (meta && meta.current != null) return { ...st, current: meta.current };
        return st;
      }
    },
    props: {
      decorations(state) {
        const st = findKey.getState(state);
        if (!st.open) return null;
        const cur = st.matches[st.current];
        return cur ? st.decos.add(state.doc, [Decoration.inline(cur.from, cur.to, { class: "find-match is-current" })]) : st.decos;
      }
    },
    view(view) {
      panel = createPanel(view);
      return {
        update(v) { panel && panel.sync(v); },
        destroy() { if (panel) { panel.el.remove(); panel = null; } }
      };
    }
  });
}

/* ---------- commands ---------- */
/**
 * Opens the panel (with the replace row when `replace`). A short single-line selection becomes the search
 * text; otherwise the last search is kept. Focus goes to the search field with its text selected.
 */
export function openFind(view, { replace = false } = {}) {
  if (!panel) return false;
  const { from, to, empty } = view.state.selection;
  if (!empty) {
    const sel = view.state.doc.textBetween(from, to, "\n");
    if (sel && sel.length <= 200 && !sel.includes("\n")) query.text = query.regex ? sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : sel;
  }
  panel.show(replace);
  panel.focusFind();
  runSearch(view, from);
  return true;
}
// Recomputes the matches around `near` and selects the current one (without taking focus from the panel).
function runSearch(view, near) {
  view.dispatch(view.state.tr.setMeta(findKey, { search: true, near }));
  const st = findKey.getState(view.state);
  if (st.current >= 0) selectMatch(view, st.current);
}

// Moves to the next (dir 1) or previous (dir -1) match, wrapping around. Opens the panel if needed.
export function findNext(view, dir = 1) {
  const st = findKey.getState(view.state);
  if (!st || !st.open) return openFind(view);
  const n = st.matches.length;
  if (!n) return true;
  let i;
  if (st.current >= 0) {
    const cur = st.matches[st.current];
    const sel = view.state.selection;
    // the selection already on the current match: step; elsewhere (the user clicked away): start from there
    if (sel.from === cur.from && sel.to === cur.to) i = (st.current + dir + n) % n;
    else i = dir > 0 ? st.matches.findIndex((m) => m.from >= sel.to) : findLastIndex(st.matches, (m) => m.to <= sel.from);
  } else i = dir > 0 ? st.matches.findIndex((m) => m.from >= view.state.selection.from) : findLastIndex(st.matches, (m) => m.to <= view.state.selection.from);
  if (i < 0) i = dir > 0 ? 0 : n - 1;
  selectMatch(view, i);
  return true;
}
const findLastIndex = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i; return -1; };

// Selects match i and scrolls it into view (centred, so the text around it is readable).
function selectMatch(view, i) {
  const m = findKey.getState(view.state).matches[i];
  if (!m) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).setMeta(findKey, { current: i }).scrollIntoView());
  requestAnimationFrame(() => {
    try {
      const { node } = view.domAtPos(m.from);
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
    } catch { /* the match was edited away meanwhile */ }
  });
}

// Replaces the current match (or first moves to one) and goes to the next.
function replaceCurrent(view) {
  const st = findKey.getState(view.state);
  const m = st.matches[st.current];
  const sel = view.state.selection;
  if (!m || sel.from !== m.from || sel.to !== m.to) { findNext(view, 1); return; }
  const tr = view.state.tr;
  const len = replaceMatch(tr, m, expandReplacement(query.replace, m, query.regex));
  view.dispatch(tr.setMeta(findKey, { after: m.from + len }).scrollIntoView());
  const next = findKey.getState(view.state);
  if (next.current >= 0) selectMatch(view, next.current);
}

function replaceEvery(view) {
  const st = findKey.getState(view.state);
  if (!st.matches.length) return;
  const tr = view.state.tr;
  const n = replaceAll(tr, st.matches, query.replace, query.regex);
  view.dispatch(tr.scrollIntoView());
  toast("Replaced " + n.toLocaleString() + (n === 1 ? " match" : " matches") + (st.truncated ? ". There may be more: replace again to continue." : ". Undo to take it back."), { kind: "success", timeout: 4000 });
}

export function closeFind(view, { focus = true } = {}) {
  if (!panel || !panel.isOpen()) return false;
  panel.hide();
  view.dispatch(view.state.tr.setMeta(findKey, { close: true }));
  if (focus) view.focus();
  return true;
}

/* ---------- panel ---------- */
function createPanel(view) {
  let open = false, withReplace = false;
  const iconBtn = (icon, tip, k, onClick, extra = {}) => {
    const b = h("button", { class: "find-btn", type: "button", "data-tip": tip, "data-kbd": k || null, "aria-label": tip, ...extra }, svg(icon, 15));
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", onClick);
    return b;
  };
  const toggleBtn = (label, tip, k, key) => {
    const b = h("button", { class: "find-opt", type: "button", "data-tip": tip, "data-kbd": k, "aria-label": tip, "aria-pressed": String(query[key]) }, label);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => toggle(key));
    return b;
  };
  const findInput = h("input", { class: "input find-input", type: "text", placeholder: "Find", spellcheck: "false", autocomplete: "off", "aria-label": "Find" });
  const replaceInput = h("input", { class: "input find-input", type: "text", placeholder: "Replace with", spellcheck: "false", autocomplete: "off", "aria-label": "Replace with" });
  const count = h("span", { class: "find-count", "aria-live": "polite" });
  const error = h("div", { class: "find-error", role: "alert" });
  const opts = {
    caseSensitive: toggleBtn("Aa", "Match case", "Alt-C", "caseSensitive"),
    wholeWord: toggleBtn("ab", "Whole word", "Alt-W", "wholeWord"),
    regex: toggleBtn(".*", "Regular expression", "Alt-R", "regex")
  };
  const expand = iconBtn("ChevronRight", "Toggle replace", "Mod-H", () => { show(!withReplace); (withReplace ? replaceInput : findInput).focus(); }, { class: "find-btn find-expand" });
  const prev = iconBtn("ChevronUp", "Previous match", "Shift-Enter", () => findNext(view, -1));
  const next = iconBtn("ChevronDown", "Next match", "Enter", () => findNext(view, 1));
  const close = iconBtn("Close", "Close", "Escape", () => closeFind(view));
  const replaceOne = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Replace");
  const replaceAllBtn = h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-tip": "Replace all", "data-kbd": "Mod-Enter" }, "All");
  replaceOne.addEventListener("click", () => replaceCurrent(view));
  replaceAllBtn.addEventListener("click", () => replaceEvery(view));
  const replaceRow = h("div", { class: "find-row find-replace-row" }, replaceInput, replaceOne, replaceAllBtn);
  const el = h("div", { class: "find-panel", role: "search", "aria-label": "Find and replace", hidden: true },
    h("div", { class: "find-row" }, expand, findInput, count, opts.caseSensitive, opts.wholeWord, opts.regex, prev, next, close),
    replaceRow, error);
  (document.getElementById("layer") || document.body).appendChild(el);

  let pending = false; // a debounced search has not run yet
  // searches and selects the nearest match as the user types, so Enter then moves on to the next one
  const search = () => { pending = false; runSearch(view, view.state.selection.from); };
  // long documents are searched once typing pauses; short ones at every key
  const searchSoon = debounce(search, 120);
  function toggle(key) {
    query[key] = !query[key];
    opts[key].setAttribute("aria-pressed", String(query[key]));
    search();
  }
  findInput.addEventListener("input", () => {
    query.text = findInput.value;
    if (view.state.doc.content.size > 200000) { pending = true; searchSoon(); } else search();
  });
  replaceInput.addEventListener("input", () => { query.replace = replaceInput.value; });
  el.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(view); return; }
    if (e.key === "Enter" && e.target === findInput) { e.preventDefault(); if (pending) { searchSoon.cancel(); search(); } findNext(view, e.shiftKey ? -1 : 1); return; }
    if (e.key === "Enter" && e.target === replaceInput) { e.preventDefault(); if (mod) replaceEvery(view); else replaceCurrent(view); return; }
    if (e.key === "F3" || (mod && e.key.toLowerCase() === "g")) { e.preventDefault(); findNext(view, e.shiftKey ? -1 : 1); return; }
    if (mod && e.key.toLowerCase() === "f" && !e.altKey) { e.preventDefault(); findInput.focus(); findInput.select(); return; }
    if (mod && (e.key.toLowerCase() === "h" || (e.altKey && e.code === "KeyF"))) { e.preventDefault(); show(true); replaceInput.focus(); replaceInput.select(); return; }
    if (e.altKey && !mod) {
      const key = { KeyC: "caseSensitive", KeyW: "wholeWord", KeyR: "regex" }[e.code];
      if (key) { e.preventDefault(); toggle(key); }
    }
  });

  function show(replace) {
    open = true;
    withReplace = !!replace;
    el.hidden = false;
    replaceRow.hidden = !withReplace;
    expand.classList.toggle("is-on", withReplace);
    expand.setAttribute("aria-expanded", String(withReplace));
    findInput.value = query.text;
    replaceInput.value = query.replace;
    for (const k in opts) opts[k].setAttribute("aria-pressed", String(query[k]));
  }
  function sync(v) {
    if (!open) return;
    const st = findKey.getState(v.state);
    if (!st.open) { open = false; el.hidden = true; return; }
    const n = st.matches.length;
    error.textContent = st.error ? "Invalid pattern: " + st.error : "";
    el.classList.toggle("has-error", !!st.error);
    count.textContent = !query.text ? "" : !n ? "No results" : (st.current >= 0 ? (st.current + 1).toLocaleString() + " of " : "") + n.toLocaleString() + (st.truncated ? "+" : "");
    el.classList.toggle("no-results", !!query.text && !n && !st.error);
    prev.disabled = next.disabled = !n;
    replaceOne.disabled = replaceAllBtn.disabled = !n;
    replaceAllBtn.dataset.tip = st.truncated ? "Replace the first " + MAX_MATCHES.toLocaleString() : "Replace all " + n.toLocaleString();
  }
  return {
    el, show, sync,
    hide() { open = false; el.hidden = true; },
    isOpen: () => open,
    // synchronously: keys typed right after Mod-F must land in the field, not in the document
    focusFind() { findInput.focus({ preventScroll: true }); findInput.select(); }
  };
}
