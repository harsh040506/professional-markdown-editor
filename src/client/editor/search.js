/**
 * Find and replace: the matching and replacing logic, with no DOM, so test/editing.mjs runs it in Node.
 * The panel and highlighting are in editor/find-plugin.js.
 *
 * Text is searched one text block at a time (paragraph, heading, code block, table cell …), so a match
 * never spans two blocks. Inline atoms (equations, images, line breaks) count as one object character
 * that no match may include: their content is not document text, and replacing across one would delete it.
 * Positions are exact document positions, because text characters and inline leaves are each size 1.
 */
const OBJ = "￼";
// Matches beyond this are not collected; the count then shows "10000+". Keeps a pathological pattern
// (".") on a huge file from freezing the editor.
export const MAX_MATCHES = 10000;

/**
 * Turns the panel's options into a RegExp.
 * @param {{text: string, caseSensitive?: boolean, wholeWord?: boolean, regex?: boolean}} q
 * @returns {{re: RegExp|null, error: string|null}} re is null for an empty search or an invalid pattern
 */
export function buildQuery(q) {
  if (!q || !q.text) return { re: null, error: null };
  const body = q.regex ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = "g" + (q.caseSensitive ? "" : "i");
  // whole words: letters, digits and _ of any script; patterns that are invalid in Unicode mode fall back
  // to the ASCII word class
  const tries = q.wholeWord
    ? [[`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, flags + "u"], [`(?<!\\w)(?:${body})(?!\\w)`, flags]]
    : [[body, flags + "u"], [body, flags]];
  let error = null;
  for (const [src, f] of tries) {
    try { return { re: new RegExp(src, f), error: null }; } catch (e) { error = error || e.message; }
  }
  return { re: null, error: String(error).replace(/^Invalid regular expression: /, "") };
}

/**
 * Every match of `re` in the document, in order.
 * @param {import("prosemirror-model").Node} doc
 * @param {RegExp} re  a global RegExp from buildQuery
 * @returns {{matches: {from: number, to: number, groups: string[], named?: object}[], truncated: boolean}}
 */
export function findMatches(doc, re) {
  const matches = [];
  let truncated = false;
  if (!re) return { matches, truncated };
  doc.descendants((node, pos) => {
    if (truncated) return false;
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((c) => { text += c.isText ? c.text : OBJ.repeat(c.nodeSize); });
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; } // empty matches ("^", "x*") would never advance
      if (!m[0].includes(OBJ)) {
        if (matches.length >= MAX_MATCHES) { truncated = true; break; }
        matches.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length, groups: Array.from(m), named: m.groups });
      }
    }
    return false;
  });
  return { matches, truncated };
}

/**
 * The text that replaces one match. In regex mode, $& $1…$99 $<name> and $$ work as in String.replace;
 * otherwise the replacement is literal.
 */
export function expandReplacement(replacement, match, regex) {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (all, tok, name) => {
    if (tok === "$") return "$";
    if (tok === "&") return match.groups[0];
    if (name !== undefined) return match.named && name in match.named ? match.named[name] ?? "" : all;
    const n = +tok;
    return n > 0 && n < match.groups.length ? match.groups[n] ?? "" : all;
  });
}

/**
 * Replaces one match inside `tr` (text keeps the formatting of the text it replaces; an empty
 * replacement deletes). Returns the replacement's length.
 */
export function replaceMatch(tr, match, text) {
  if (text) tr.insertText(text, match.from, match.to);
  else tr.delete(match.from, match.to);
  return text.length;
}

/**
 * Replaces every match in one transaction (one undo step). Matches are applied from the end of the
 * document backwards, so earlier positions stay valid.
 * @returns {number} how many were replaced
 */
export function replaceAll(tr, matches, replacement, regex) {
  for (let i = matches.length - 1; i >= 0; i--) replaceMatch(tr, matches[i], expandReplacement(replacement, matches[i], regex));
  return matches.length;
}
