/**
 * LaTeX rendering with KaTeX, shared by the editor (math node views) and the exporters
 * (render.js for HTML/PDF, docx.js for native Word equations via MathML).
 *
 * Rendering never throws: callers get either HTML or an error message to show in place of the
 * equation, so one bad formula cannot break a document or an export.
 */
import katex from "katex";

// Memo of rendered formulas, keyed by mode + output + TeX. Typing re-renders the same formulas on
// every keystroke, and KaTeX is the slowest step in drawing a math-heavy page. The cache is simply
// emptied when it grows past 6000 entries, which bounds memory without LRU bookkeeping.
const cache = new Map();
// throwOnError: report errors to the caller instead of drawing red source text.
// strict "ignore": accept common non-standard LaTeX (e.g. Unicode in \text{}) silently.
// trust false: \href, \url, \includegraphics and \htmlClass are refused, so a formula cannot add
//   links, images or attributes (security: documents may come from anyone).
// maxExpand: caps macro expansion so a recursive \def cannot hang the editor or an export.
export const KATEX_OPTIONS = { throwOnError: true, strict: "ignore", trust: false, output: "htmlAndMathml", maxExpand: 2000 };

/**
 * Renders TeX to an HTML string.
 *
 * @param {string} tex        the formula, without $ delimiters
 * @param {boolean} display   true for display (block) style, false for inline
 * @param {"htmlAndMathml"|"html"|"mathml"} [output]  KaTeX output; the default includes MathML for
 *                            screen readers and copy/paste
 * @returns {{html: string|null, error: string|null}} exactly one of the two is set; `error` is the
 *          KaTeX message without its "KaTeX parse error:" prefix
 */
export function renderMath(tex, display, output = "htmlAndMathml") {
  const key = (display ? "D" : "I") + output + "\u0000" + tex;
  const hit = cache.get(key);
  if (hit) return hit;
  let res;
  try {
    res = { html: katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: !!display, output }), error: null };
  } catch (e) {
    const msg = String(e && e.message || e).replace(/^KaTeX parse error: /, "");
    res = { html: null, error: msg };
  }
  if (cache.size > 6000) cache.clear();
  cache.set(key, res);
  return res;
}

/**
 * Renders TeX to a MathML string only, for conversion to Word equations (OMML) in docx.js.
 * Uncached: an export renders each formula once.
 *
 * @returns {string|null} MathML markup, or null when the formula does not parse (the caller then
 *          falls back to showing the TeX source)
 */
export function mathML(tex, display) {
  try { return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: !!display, output: "mathml" }); }
  catch { return null; }
}

