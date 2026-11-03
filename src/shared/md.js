/**
 * Shared Markdown tokenizer.
 *
 * The editor (via ../client/markdown.js) and every exporter (via ../export/render.js
 * and ../export/docx.js) tokenize with this one markdown-it setup, so a document reads the same
 * everywhere. On top of CommonMark + GFM tables/strikethrough it understands:
 *
 *   $inline$ and $$display$$ math   -> math_inline tokens (meta.display)
 *   $$ … $$ blocks                  -> math_block tokens (meta.layout: "fenced" | "line" | "attached")
 *   ==highlight==                   -> mark_open / mark_close
 *   <details><summary>…             -> details_open, details_summary_*, details_body_*, details_close
 *   - [ ] / - [x] items             -> task_list_* / task_item_* (meta.checked)
 *   <u> <sub> <sup> <mark> <kbd> …  -> the matching mark tokens (see TAG_MAP)
 *   any other HTML block            -> html_raw (kept as literal source, never rendered as HTML)
 *
 * Round-trip contract: the editor's serializer (client/markdown.js) writes these constructs back in
 * the same form, and token metadata such as the math layout exists only so that it can. Any change
 * to how a construct is tokenized must keep `npm run test:roundtrip` passing.
 *
 * Security: `html: true` is enabled only so these tags can be *recognized*. Unknown inline tags
 * become plain text and unknown HTML blocks become html_raw, which every renderer escapes, so
 * Markdown content can never inject markup or script into the editor or an export. markdown-it's
 * validateLink (left at its default) still rejects javascript:, vbscript: and most data: links.
 */
import MarkdownIt from "markdown-it";

/* ---------- math: $..$ and $$..$$ ---------- */
// Space, tab or newline: the characters that may not sit just inside $…$ or ==…== delimiters.
function isWs(c) { return c === 0x20 || c === 0x09 || c === 0x0a; }

/**
 * Inline rule for `$tex$` and `$$tex$$` inside a paragraph.
 *
 * Follows the Pandoc/KaTeX convention so prices and shell variables are not mistaken for math:
 * the opener may not be followed by whitespace, the closer may not be preceded by whitespace or
 * followed by a digit ("costs $5 and $6" stays text), and `\$` is an escaped dollar.
 *
 * @param {object} state    markdown-it inline state
 * @param {boolean} silent  true while markdown-it only probes whether the rule would match
 * @returns {boolean} whether a math token was (or would be) produced
 */
function mathInline(state, silent) {
  const src = state.src, start = state.pos, max = state.posMax;
  const c0 = src.charCodeAt(start);
  if (c0 !== 0x24 /* $ */) return false;
  if (src.charCodeAt(start + 1) === 0x24) {
    // $$ display $$ inside a paragraph
    let end = start + 2;
    while ((end = src.indexOf("$$", end)) >= 0 && src.charCodeAt(end - 1) === 0x5c) end += 2;
    if (end < 0 || end > max - 2 || end === start + 2) return false;
    if (!silent) {
      const t = state.push("math_inline", "math", 0);
      t.content = src.slice(start + 2, end).trim();
      t.meta = { display: true };
      t.markup = "$$";
    }
    state.pos = end + 2;
    return true;
  }
  // $inline$: no space after the opener, none before the closer, closer not followed by a digit
  if (start + 1 >= max || isWs(src.charCodeAt(start + 1))) return false;
  let end = start + 1;
  for (;;) {
    end = src.indexOf("$", end);
    if (end < 0 || end >= max) return false;
    if (src.charCodeAt(end - 1) === 0x5c) { end++; continue; }
    if (isWs(src.charCodeAt(end - 1))) { end++; continue; }
    const after = src.charCodeAt(end + 1);
    if (after >= 0x30 && after <= 0x39) { end++; continue; }
    break;
  }
  if (end === start + 1) return false;
  if (!silent) {
    const t = state.push("math_inline", "math", 0);
    t.content = src.slice(start + 1, end);
    t.meta = { display: false };
    t.markup = "$";
  }
  state.pos = end + 1;
  return true;
}

/**
 * Block rule for display math that starts with `$$` at the beginning of a line.
 *
 * Three source layouts are accepted. The one found is kept in token.meta.layout so the serializer
 * writes the block back exactly as it was written:
 *   "line"      $$ E = mc^2 $$          one line
 *   "fenced"    $$ / tex lines / $$     delimiters on their own lines
 *   "attached"  $$tex … / … tex$$       delimiters touching the first or last line
 * Indented code (4+ spaces) is left alone, and an unclosed `$$` is not math at all (it falls
 * through to the paragraph rule), so a stray `$$` never swallows the rest of the document.
 *
 * @returns {boolean} whether a math_block token was (or would be) produced
 */
function mathBlock(state, startLine, endLine, silent) {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const line = state.src.slice(pos, max).trim();
  const open = "$$", close = "$$";
  if (!line.startsWith("$$")) return false;
  const rest = line.slice(2);
  let content, next = startLine, layout = "fenced";
  if (rest.trim().endsWith(close) && rest.trim().length >= close.length) {
    // one line: $$ ... $$ (must be the whole line, else it is inline display math)
    const inner = rest.trim().slice(0, -close.length);
    if (inner.includes(close)) return false;
    content = inner.trim();
    if (!content) return false;
    layout = "line";
  } else {
    if (rest.includes(close)) return false;
    const lines = rest.trim() ? [rest] : [];
    if (rest.trim()) layout = "attached";
    let found = false;
    for (next = startLine + 1; next < endLine; next++) {
      const p = state.bMarks[next] + state.tShift[next];
      const l = state.src.slice(p, state.eMarks[next]);
      if (state.sCount[next] < state.blkIndent && l.trim()) break;
      const tl = l.trimEnd();
      if (tl.endsWith(close)) {
        const head = tl.slice(0, -close.length);
        if (head.trim()) { lines.push(head); if (layout === "fenced") layout = "attached"; }
        found = true; break;
      }
      lines.push(l);
    }
    if (!found) return false;
    content = lines.join("\n").replace(/^\n+|\s+$/g, "");
  }
  if (silent) return true;
  const t = state.push("math_block", "math", 0);
  t.block = true;
  t.content = content;
  t.markup = open;
  t.meta = { layout };
  t.map = [startLine, next + 1];
  state.line = next + 1;
  return true;
}

/* ---------- ==highlight== ---------- */
/**
 * Inline rule for `==highlight==` (rendered as <mark>). As with emphasis, the text may not start or
 * end with whitespace, and runs of three or more "=" are skipped so `a === b` stays text. The inner
 * text is tokenized normally, so **bold** and links work inside a highlight.
 */
function highlight(state, silent) {
  const src = state.src, start = state.pos, max = state.posMax;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  const first = src.charCodeAt(start + 2);
  if (!first || isWs(first) || first === 0x3d) return false;
  let end = start + 2;
  for (;;) {
    end = src.indexOf("==", end);
    if (end < 0 || end + 2 > max) return false;
    if (!isWs(src.charCodeAt(end - 1)) && src.charCodeAt(end + 2) !== 0x3d) break;
    end++;
  }
  if (silent) return true;
  state.push("mark_open", "mark", 1).markup = "==";
  const oldMax = state.posMax;
  state.pos = start + 2; state.posMax = end;
  state.md.inline.tokenize(state);
  state.posMax = oldMax;
  state.push("mark_close", "mark", -1).markup = "==";
  state.pos = end + 2;
  return true;
}

/* ---------- <details><summary> as real structure ---------- */
// <details> is written as HTML in Markdown sources, but the editor treats it as real structure (a
// collapsible section with an editable summary and body). DETAILS_RE finds its three pieces inside an
// HTML block: an opening tag (group 1 = its attributes, which may say `open`), a whole
// <summary>…</summary> (group 2 = its inline Markdown), and a closing tag. Attributes such as
// class="faq" are accepted and dropped.
const DETAILS_RE = /<details(?=[\s>\/])([^>]*)>|<summary(?=[\s>\/])[^>]*>([\s\S]*?)<\/summary\s*>|<\/details\s*>/gi;
const hasOpenAttr = (attrs) => /(^|\s)open(?=[\s=\/]|$)/i.test(attrs || "");

// A <details> or </details> tag that really is one: not escaped with a backslash (`\<details>` is
// the text "<details>", which the serializer itself writes for literal text) and not inside a code span.
function detailsIndex(text) {
  const re = /<\/?details(?=[\s>\/])/gi;
  let m;
  while ((m = re.exec(text))) {
    let bs = 0;
    while (text.charCodeAt(m.index - 1 - bs) === 0x5c) bs++;
    if (bs % 2) continue;
    const ticks = (text.slice(0, m.index).match(/`+/g) || []).length;
    if (ticks % 2 === 0) return m.index;
  }
  return -1;
}

// Word, Google Docs and many LLM tools export <details> with every "<" escaped: a paragraph that is
// nothing but `\<details>\<summary>Q\</summary>` or `\</details>`. Returns the unescaped tag text
// when `content` is exactly such a paragraph, else null.
const ESCAPED_OPEN_RE = /^<details(?:\s[^>]*)?>(?:\s*<summary(?:\s[^>]*)?>[\s\S]*?<\/summary\s*>)?$/i;
const ESCAPED_CLOSE_RE = /^<\/details\s*>$/i;
function unescapedTags(content) {
  if (!/\\[<>]/.test(content)) return null;
  const plain = content.replace(/\\(?=[<>])/g, "").trim();
  if (ESCAPED_OPEN_RE.test(plain)) return { plain, open: true };
  if (ESCAPED_CLOSE_RE.test(plain)) return { plain, open: false };
  return null;
}

/**
 * Repairs <details> tags that CommonMark does not see as an HTML block, so they still become real
 * sections the way a browser (and GitHub) shows them:
 *   - a `<details>` or `</details>` in the middle of a paragraph is moved into its own HTML block, keeping
 *     the text before it as a paragraph (CommonMark only starts an HTML block at the start of a line);
 *   - escaped tags (`\<details>`) stay literal text, EXCEPT paragraphs made only of escaped tags when the
 *     document has both an escaped opener and an escaped closer. That pairing shows the author meant a
 *     fold and an exporter escaped it; a lone `\<details>` in prose is left as text.
 */
function liftInlineDetails(state) {
  const Token = state.Token, toks = state.tokens, out = [];
  const isLone = (i) => toks[i].type === "paragraph_open" && toks[i + 1] && toks[i + 1].type === "inline" && toks[i + 2] && toks[i + 2].type === "paragraph_close";
  let escOpen = 0, escClose = 0;
  for (let i = 0; i < toks.length; i++) {
    if (!isLone(i)) continue;
    const e = unescapedTags(toks[i + 1].content);
    if (e) e.open ? escOpen++ : escClose++;
  }
  const recoverEscaped = escOpen > 0 && escClose > 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isLone(i)) {
      const inl = toks[i + 1];
      const esc = recoverEscaped ? unescapedTags(inl.content) : null;
      const at = esc ? 0 : detailsIndex(inl.content);
      if (at >= 0) {
        const full = esc ? esc.plain : inl.content;
        const before = full.slice(0, at).trimEnd();
        if (before) {
          inl.content = before;
          out.push(t, inl, toks[i + 2]);
        }
        const hb = new Token("html_block", "", 0);
        hb.block = true;
        hb.content = full.slice(at) + "\n";
        out.push(hb);
        i += 2;
        continue;
      }
    }
    out.push(t);
  }
  state.tokens = out;
}

const isDetailsTok = (t) => t.type.startsWith("details_");

/**
 * Core rule that turns <details> HTML blocks into structural tokens, then repairs the nesting.
 *
 * 1. convert(): split each HTML block at the details/summary tags. The text between tags is parsed
 *    again as Markdown (recursively), so sections can nest and contain lists, code, math and so on.
 *    An HTML block that mentions the tags but yields no usable tag (e.g. an unclosed <summary>) is
 *    kept as it is; re-parsing it would never end.
 * 2. Balance, per container: every details_open gets exactly one summary (a default "Details" when the
 *    source has none), a body and a close. A section can never cross the edge of the list item or
 *    quote it started in: it is closed there, and a </details> with nothing open in its own container
 *    is dropped. A stray <summary> becomes a plain paragraph.
 * 3. A section whose </details> is missing anywhere in its container ends at the next heading or
 *    rule instead of swallowing the rest of the document (it is closed at the end of the container
 *    otherwise), so one lost tag stays a local problem.
 * 4. An empty body gets one empty paragraph, because the editor's schema requires block content.
 * Malformed HTML therefore never throws and never loses text; it degrades to the closest valid structure.
 */
function detailsRule(state) {
  liftInlineDetails(state);
  const Token = state.Token;
  const mk = (type, tag, nesting) => Object.assign(new Token(type, tag, nesting), { block: true });
  function convert(tokens) {
    const res = [];
    for (const tok of tokens) {
      if (tok.type !== "html_block" || !/<\/?details|<summary/i.test(tok.content)) { res.push(tok); continue; }
      const src = tok.content;
      // a fresh regex per block: chunk() below recurses, and a shared one would lose its position
      const re = new RegExp(DETAILS_RE.source, DETAILS_RE.flags);
      if (!re.test(src)) { res.push(tok); continue; }
      re.lastIndex = 0;
      let last = 0, m;
      const chunk = (s) => {
        if (!s.trim()) return;
        const sub = [];
        state.md.block.parse(s, state.md, state.env, sub);
        res.push(...convert(sub));
      };
      while ((m = re.exec(src))) {
        chunk(src.slice(last, m.index));
        last = re.lastIndex;
        const t = m[0];
        if (/^<details/i.test(t)) {
          const o = mk("details_open", "details", 1);
          o.meta = { open: hasOpenAttr(m[1]) };
          res.push(o);
        } else if (/^<summary/i.test(t)) {
          const inl = new Token("inline", "", 0); inl.content = (m[2] || "").trim(); inl.children = [];
          res.push(mk("details_summary_open", "summary", 1), inl, mk("details_summary_close", "summary", -1));
        } else {
          res.push(mk("details_close", "details", -1));
        }
      }
      chunk(src.slice(last));
    }
    return res;
  }
  const converted = convert(state.tokens);

  // Pass 1: which openers never meet a closer inside their own container?
  const loose = new Set();
  {
    const frames = [[]];
    for (const t of converted) {
      if (t.type === "details_open") frames[frames.length - 1].push(t);
      else if (t.type === "details_close") frames[frames.length - 1].pop();
      else if (isDetailsTok(t)) continue;
      else if (t.nesting === 1) frames.push([]);
      else if (t.nesting === -1 && frames.length > 1) for (const o of frames.pop()) loose.add(o);
    }
    for (const o of frames[0]) loose.add(o);
  }

  // Pass 2: rebuild with one stack of open sections per container.
  const fixed = [];
  const frames = [[]];
  const stack = () => frames[frames.length - 1];
  const closeSection = () => {
    stack().pop();
    fixed.push(mk("details_body_close", "div", -1), mk("details_close", "details", -1));
  };
  const openBody = (sec) => { fixed.push(mk("details_body_open", "div", 1)); sec.body = true; };
  for (let i = 0; i < converted.length; i++) {
    const tok = converted[i];
    const cur = stack(), sec = cur[cur.length - 1];
    if (tok.type === "details_open") {
      if (sec) sec.filled = true;
      fixed.push(tok);
      const frame = { body: false, filled: false, loose: loose.has(tok) };
      cur.push(frame);
      const n = converted[i + 1];
      if (!n || n.type !== "details_summary_open") {
        const inl = new Token("inline", "", 0); inl.content = "Details"; inl.children = [];
        fixed.push(mk("details_summary_open", "summary", 1), inl, mk("details_summary_close", "summary", -1));
        openBody(frame);
      }
      continue;
    }
    if (tok.type === "details_summary_close" && sec && !sec.body) { fixed.push(tok); openBody(sec); continue; }
    if (tok.type === "details_summary_open" && (!sec || sec.body)) {
      // stray <summary>: keep its text as a paragraph
      fixed.push(mk("paragraph_open", "p", 1), converted[i + 1], mk("paragraph_close", "p", -1));
      if (sec) sec.filled = true;
      i += 2;
      continue;
    }
    if (tok.type === "details_close") {
      if (sec) closeSection(); // else a stray </details>: dropped
      continue;
    }
    if (tok.type === "heading_open" || tok.type === "hr") {
      // a section that never gets its </details> ends at the next heading or rule
      while (stack().length && stack()[stack().length - 1].loose && stack()[stack().length - 1].filled) closeSection();
    }
    if (!isDetailsTok(tok) && tok.nesting === 1) {
      if (stack()[stack().length - 1]) stack()[stack().length - 1].filled = true;
      frames.push([]);
      fixed.push(tok);
      continue;
    }
    if (!isDetailsTok(tok) && tok.nesting === -1 && frames.length > 1) {
      while (stack().length) closeSection(); // a section ends where its list item or quote ends
      frames.pop();
      fixed.push(tok);
      continue;
    }
    const now = stack()[stack().length - 1];
    if (now && now.body && !isDetailsTok(tok)) now.filled = true;
    fixed.push(tok);
  }
  while (frames[0].length) { frames.length = 1; closeSection(); }

  // an empty body needs one paragraph so the structure stays editable
  for (let i = 0; i < fixed.length; i++) {
    if (fixed[i].type === "details_body_open" && fixed[i + 1] && fixed[i + 1].type === "details_body_close") {
      const inl = new Token("inline", "", 0); inl.content = ""; inl.children = [];
      fixed.splice(i + 1, 0, mk("paragraph_open", "p", 1), inl, mk("paragraph_close", "p", -1));
    }
  }
  state.tokens = fixed;
}

/* ---------- task lists: "- [ ] item" ---------- */
/**
 * Core rule that turns a bullet list whose *first* item starts with `[ ]` or `[x]` into a task list.
 *
 * The first item decides for the whole list, as in the editor's schema (a list is a checklist or it
 * is not); later items without a box become unchecked tasks. Ordered lists never become checklists,
 * because "1. [ ] x" has no task-list form to round-trip to. The box is removed from both the inline
 * source and its first text child so it is not shown twice.
 */
function taskRule(state) {
  const toks = state.tokens;
  const listStack = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === "bullet_list_open" || t.type === "ordered_list_open") { listStack.push({ open: t, task: null }); continue; }
    if (t.type === "bullet_list_close" || t.type === "ordered_list_close") {
      const fr = listStack.pop();
      if (fr && fr.task) t.type = "task_list_close";
      continue;
    }
    if (t.type !== "list_item_open") continue;
    const fr = listStack[listStack.length - 1];
    if (!fr || fr.open.type === "ordered_list_open") continue; // ordered lists never become checklists
    const p = toks[i + 1], inl = toks[i + 2];
    let checked = null;
    if (p && p.type === "paragraph_open" && inl && inl.type === "inline") {
      const m = /^\[([ xX])\](?:\s+|$)/.exec(inl.content);
      if (m) {
        checked = m[1] !== " ";
        inl.content = inl.content.slice(m[0].length);
        const first = inl.children && inl.children[0];
        if (first && first.type === "text") first.content = first.content.replace(/^\[([ xX])\]\s*/, "");
      }
    }
    if (fr.task === null) {
      fr.task = checked !== null && fr.open.type === "bullet_list_open";
      if (fr.task) fr.open.type = "task_list_open";
    }
    if (fr.task) {
      t.type = "task_item_open";
      t.meta = { checked: !!checked };
      // find the matching close
      let depth = 0;
      for (let j = i + 1; j < toks.length; j++) {
        if (toks[j].type === "list_item_open" || toks[j].type === "task_item_open") depth++;
        else if (toks[j].type === "list_item_close") { if (depth === 0) { toks[j].type = "task_item_close"; break; } depth--; }
      }
    }
  }
}

/* ---------- inline HTML: a few tags become marks, the rest is literal text ---------- */
// Inline HTML tags that map to editor marks. Any other tag (and any tag that is self-closing or never
// closed) stays literal text, so unknown or unsafe HTML is shown, never interpreted.
const TAG_MAP = {
  u: "underline", ins: "underline", b: "strong", strong: "strong", i: "em", em: "em",
  s: "s", del: "s", strike: "s", mark: "mark", sub: "sub", sup: "sup", code: "code_html", kbd: "code_html"
};
/**
 * Core rule that pairs inline HTML open/close tags from TAG_MAP into mark tokens. `<br>` becomes a
 * hard break; `<code>`/`<kbd>` collapse everything between them into one code_inline token. A
 * closing tag matches the nearest open tag of the same name and discards unmatched opens above it,
 * which is how browsers recover from mis-nested inline tags.
 */
function htmlInlineRule(state) {
  for (const blk of state.tokens) {
    if (blk.type !== "inline" || !blk.children) continue;
    const kids = blk.children;
    const opens = [];
    for (let i = 0; i < kids.length; i++) {
      const t = kids[i];
      if (t.type !== "html_inline") continue;
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>$/.exec(t.content.trim());
      if (m && m[2].toLowerCase() === "br") { t.type = "hardbreak"; t.content = ""; continue; }
      const name = m && TAG_MAP[m[2].toLowerCase()];
      if (!name || m[3]) { t.type = "text"; continue; }
      if (!m[1]) opens.push({ i, name, tag: m[2].toLowerCase() });
      else {
        let k = opens.length - 1;
        while (k >= 0 && opens[k].tag !== m[2].toLowerCase()) k--;
        if (k < 0) { t.type = "text"; continue; }
        const o = opens[k];
        opens.splice(k);
        if (name === "code_html") {
          // <code>/<kbd>: everything between becomes code text
          const text = kids.slice(o.i + 1, i).map((x) => x.content || "").join("");
          const c = new state.Token("code_inline", "code", 0);
          c.content = text; c.markup = "<" + o.tag + ">";
          kids.splice(o.i, i - o.i + 1, c);
          i = o.i;
          continue;
        }
        kids[o.i].type = name + "_open"; kids[o.i].markup = "<" + o.tag + ">";
        t.type = name + "_close"; t.markup = "</" + o.tag + ">";
      }
    }
    for (const o of opens) kids[o.i].type = "text"; // never closed: literal
  }
}

/* ---------- other HTML blocks stay as literal source (rendered escaped, never as HTML) ---------- */
function htmlBlockRule(state) {
  for (const t of state.tokens) if (t.type === "html_block") t.type = "html_raw";
}

/**
 * Creates a configured markdown-it instance. Every call returns an independent instance, so
 * renderers that override output rules (export/render.js) cannot affect each other or the editor.
 *
 * Link targets are kept exactly as written (no percent-encoding or punycode) because the editor must
 * save them back byte for byte. Rule order matters: details runs on block tokens before inline
 * parsing, and the HTML mapping runs after task detection has removed the "[ ]" prefixes.
 *
 * @returns {MarkdownIt}
 * @example
 *   const tokens = createMarkdown().parse("Area: $\pi r^2$", {});
 */
export function createMarkdown() {
  const md = new MarkdownIt("default", { html: true, linkify: false, typographer: false, breaks: false });
  md.normalizeLink = (url) => url; // keep link targets exactly as written
  md.normalizeLinkText = (url) => url;
  md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.inline.ruler.before("escape", "math_inline", mathInline);
  md.inline.ruler.before("emphasis", "highlight", highlight);
  md.core.ruler.after("block", "details", detailsRule);
  md.core.ruler.after("inline", "tasks", taskRule);
  md.core.ruler.after("tasks", "html_inline_map", htmlInlineRule);
  md.core.ruler.after("html_inline_map", "html_block_raw", htmlBlockRule);
  return md;
}

// Shared instance used by the editor's parser (client/markdown.js). Never add renderer rules to it.
export const md = createMarkdown();
