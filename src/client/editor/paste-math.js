/**
 * Math in content pasted from web pages, chat apps and other editors.
 *
 * Two shapes reach the editor:
 *   rendered math   KaTeX, MathML or Wikipedia formulas. The schema's parseDOM rules (schema.js) read
 *                   the TeX source back out of them with texFromMathElement().
 *   math as text    "$x^2$", "$$…$$", "\(…\)" or "\[…\]" shown as plain characters, as when a page or
 *                   chat did not render its math. convertPastedMath() turns these into equations.
 *
 * Text conversion is deliberately cautious, because a wrong guess silently changes what was pasted:
 *   - `$` follows the same rules as the Markdown parser (scanInlineMath), so prices like "$5 and $6"
 *     and shell variables stay text, and `\$` stays a dollar sign;
 *   - text in code (inline code or code blocks) is never touched;
 *   - a candidate becomes an equation only if KaTeX can render it, otherwise it stays text;
 *   - formulas must lie within one run of identically formatted text (half-bold math is left alone);
 *   - only HTML pastes from outside the editor are converted. A paste from the editor itself already
 *     has its equations, and its literal dollar signs were typed on purpose. Plain-text pastes go
 *     through the Markdown parser instead (clipboardTextParser), and Ctrl+Shift+V pastes text as-is.
 */
import { Fragment, Slice } from "prosemirror-model";
import { scanInlineMath } from "../../shared/md.js";
import { renderMath } from "../../shared/math.js";

// Invisible characters web pages put inside text (soft hyphen, zero-width space/joiners, word joiner,
// byte-order mark). KaTeX rejects most of them, and none belong in a formula.
const INVISIBLE = /[­​-‍⁠﻿]/g;
// Longer than this is not a formula someone pasted; it is a stray `$` pairing across a whole page.
const MAX_TEX = 4000;

/**
 * Normalizes TeX taken from pasted text: drops invisible characters, turns non-breaking spaces
 * into spaces and trims.
 * @param {string} tex
 * @returns {string}
 */
export function cleanTex(tex) {
  return tex.replace(INVISIBLE, "").replace(/ /g, " ").trim();
}

function renders(tex, display) {
  return !!tex && tex.length <= MAX_TEX && !renderMath(tex, display).error;
}

/**
 * Finds the formulas written as text in one string.
 *
 * @param {string} text
 * @returns {{from: number, to: number, tex: string, display: boolean}[]}  ranges in `text`, in order
 */
export function findTextMath(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5c /* \ */) {
      const n = text[i + 1];
      if (n === "(" || n === "[") {
        const display = n === "[";
        const end = text.indexOf(display ? "\\]" : "\\)", i + 2);
        const tex = end > 0 ? cleanTex(text.slice(i + 2, end)) : "";
        if (renders(tex, display)) {
          out.push({ from: i, to: end + 2, tex, display });
          i = end + 1;
          continue;
        }
      }
      i++; // the next character is escaped: "\$" is a dollar sign, not an opener
      continue;
    }
    if (c === 0x24 /* $ */) {
      const m = scanInlineMath(text, i);
      const tex = m ? cleanTex(m.tex) : "";
      if (m && renders(tex, m.display)) {
        out.push({ from: i, to: m.end, tex, display: m.display });
        i = m.end - 1;
      }
    }
  }
  return out;
}

/**
 * Removes an outer `{\displaystyle …}` or `{\textstyle …}` wrapper, which Wikipedia adds to the TeX
 * of every formula. Only a wrapper whose brace closes at the very end is removed, so
 * "{\displaystyle a}{b}" is left as it is.
 * @param {string} tex
 * @returns {string}
 */
export function unwrapStyle(tex) {
  const m = /^\{\\(?:displaystyle|textstyle)\b\s*/.exec(tex);
  if (!m) return tex;
  let depth = 0;
  for (let i = 0; i < tex.length; i++) {
    const ch = tex[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i === tex.length - 1 ? tex.slice(m[0].length, -1).trim() : tex;
  }
  return tex;
}

/**
 * The TeX source of a rendered formula from another site, or "" when it carries none.
 * KaTeX keeps the source in a MathML <annotation>; MathML from Wikipedia, MathJax and Word keeps it
 * in an `alttext` attribute or an annotation.
 * @param {Element} el  a KaTeX span, a <math> element or an element containing one
 * @returns {string}
 */
export function texFromMathElement(el) {
  const ann = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="application/x-latex"], annotation[encoding="TeX"]');
  const alt = el.matches("math[alttext]") ? el : el.querySelector("math[alttext]");
  const raw = ann ? ann.textContent : alt ? alt.getAttribute("alttext") : "";
  return unwrapStyle(cleanTex(raw || ""));
}

/* ---------- slice conversion ---------- */

// The text of a paragraph, with line breaks as "\n", or null when it holds anything but text and breaks.
function paragraphSource(node) {
  let s = "";
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.isText) s += c.text;
    else if (c.type.name === "hard_break" || c.type.name === "soft_break") s += "\n";
    else return null;
  }
  return s;
}

// A paragraph that is exactly one display formula ("$$…$$" or "\[…\]", possibly across line breaks)
// as an equation block, or null.
function asMathBlock(node, schema) {
  const src = paragraphSource(node);
  if (src == null) return null;
  const s = src.trim();
  let inner = null;
  if (s.length > 4 && s.startsWith("$$") && s.endsWith("$$")) inner = s.slice(2, -2);
  else if (s.length > 4 && s.startsWith("\\[") && s.endsWith("\\]")) inner = s.slice(2, -2);
  if (inner == null || inner.includes("$$") || inner.includes("\\]")) return null;
  const tex = cleanTex(inner);
  if (!renders(tex, true)) return null;
  return schema.nodes.math_block.create({ tex, layout: tex.includes("\n") ? "fenced" : "line" });
}

// A paragraph holding one display formula and nothing else (e.g. a pasted KaTeX display equation)
// as an equation block, or null.
function lonelyDisplayMath(node, schema) {
  let math = null;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.isText && !c.text.trim()) continue;
    if (math || c.type !== schema.nodes.math_inline || !c.attrs.display) return null;
    math = c;
  }
  return math ? schema.nodes.math_block.create({ tex: math.attrs.tex.trim(), layout: "line" }) : null;
}

// Converts formulas written as text inside one textblock. `open` is true when the block is cut off at
// an edge of the pasted slice (it merges into the paragraph at the cursor), in which case it must
// stay a paragraph and is never replaced by an equation block.
function convertTextblock(node, open, schema) {
  const isPara = node.type === schema.nodes.paragraph;
  if (isPara && !open) {
    const block = asMathBlock(node, schema);
    if (block) return block;
  }
  const codeMark = schema.marks.code;
  const kids = [];
  let changed = false;
  node.forEach((child) => {
    if (!child.isText || child.marks.some((m) => m.type === codeMark)) { kids.push(child); return; }
    const found = findTextMath(child.text);
    if (!found.length) { kids.push(child); return; }
    changed = true;
    let pos = 0;
    for (const f of found) {
      if (f.from > pos) kids.push(child.cut(pos, f.from));
      kids.push(schema.nodes.math_inline.create({ tex: f.tex, display: f.display }, null, child.marks));
      pos = f.to;
    }
    if (pos < child.text.length) kids.push(child.cut(pos));
  });
  const out = changed ? node.copy(Fragment.fromArray(kids)) : node;
  if (isPara && !open) return lonelyDisplayMath(out, schema) || out;
  return out;
}

function mapFragment(frag, openStart, openEnd, schema) {
  const kids = [];
  let changed = false;
  const last = frag.childCount - 1;
  frag.forEach((node, _, i) => {
    const oS = i === 0 ? openStart : 0, oE = i === last ? openEnd : 0;
    let out = node;
    if (node.isTextblock) {
      if (!node.type.spec.code) out = convertTextblock(node, oS > 0 || oE > 0, schema);
    } else if (!node.isLeaf) {
      const content = mapFragment(node.content, Math.max(oS - 1, 0), Math.max(oE - 1, 0), schema);
      if (content !== node.content) out = node.copy(content);
    }
    if (out !== node) changed = true;
    kids.push(out);
  });
  return changed ? Fragment.fromArray(kids) : frag;
}

/**
 * Turns formulas written as text in a pasted slice into equations (see the module comment for the
 * rules). The slice's shape is kept: blocks at its open edges stay paragraphs.
 *
 * @param {Slice} slice
 * @param {import("prosemirror-model").Schema} schema
 * @returns {Slice}  the same slice when nothing changed
 */
export function convertPastedMath(slice, schema) {
  const content = mapFragment(slice.content, slice.openStart, slice.openEnd, schema);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}
