// Editing commands that run without a browser: moving blocks (Alt-ArrowUp/Down) and the find-and-replace
// logic (src/client/editor/search.js). The panel itself is covered by test/e2e.mjs.
//   node test/editing.mjs
import { EditorState, TextSelection } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from "../src/client/markdown.js";
import { moveBlock } from "../src/client/editor/commands.js";
import { buildQuery, findMatches, expandReplacement, replaceAll, MAX_MATCHES } from "../src/client/editor/search.js";

let failed = 0, total = 0;
const check = (name, ok, extra = "") => { total++; if (!ok) failed++; console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : "  → " + extra)); };

// A state with the cursor at the first occurrence of `marker` in the document text.
function stateAt(md, marker) {
  const doc = parseMarkdown(md);
  let pos = null;
  doc.descendants((n, p) => { if (pos == null && n.isText && n.text.includes(marker)) pos = p + n.text.indexOf(marker); });
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}
// Runs a command; returns [applied, markdown after, state after].
function run(state, cmd) {
  let next = state;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return [ok, serializeMarkdown(next.doc), next];
}
const cursorText = (s) => s.selection.$from.parent.textContent;

/* ---------- moving blocks ---------- */
{
  const [ok, out, s] = run(stateAt("one\n\ntwo\n\nthree\n", "two"), moveBlock(-1));
  check("moves a paragraph up", ok && out === "two\n\none\n\nthree\n", JSON.stringify(out));
  check("the cursor stays in the moved paragraph", cursorText(s) === "two");
}
{
  const [ok, out] = run(stateAt("# Title\n\ntext\n", "Title"), moveBlock(1));
  check("moves a heading down", ok && out === "text\n\n# Title\n", JSON.stringify(out));
}
check("does nothing at the top", run(stateAt("one\n\ntwo\n", "one"), moveBlock(-1))[0] === false);
{
  const [ok, out, s] = run(stateAt("- a\n- b\n- c\n", "c"), moveBlock(-1));
  check("moves a list item within its list", ok && out === "- a\n- c\n- b\n", JSON.stringify(out));
  check("the cursor follows the list item", cursorText(s) === "c");
}
check("a list item does not leave its list", run(stateAt("- a\n- b\n\nafter\n", "b"), moveBlock(1))[0] === false);
{
  const [ok, out] = run(stateAt("- [ ] one\n- [x] two\n", "two"), moveBlock(-1));
  check("moves checklist items with their state", ok && out === "- [x] two\n- [ ] one\n", JSON.stringify(out));
}
{
  const [ok, out] = run(stateAt("> a\n>\n> b\n", "b"), moveBlock(-1));
  check("moves a paragraph inside a quote", ok && out === "> b\n>\n> a\n", JSON.stringify(out));
}
{
  const [ok, out] = run(stateAt("before\n\n| A | B |\n|---|---|\n| x | y |\n", "x"), moveBlock(-1));
  check("moves a table as a whole", ok && out.startsWith("| A | B |") && out.trim().endsWith("before"), JSON.stringify(out));
}

/* ---------- find ---------- */
const doc = parseMarkdown("Cat cat CAT concat\n\n`cat` and $cat$ math\n\n```\ncat code\n```\n");
const count = (q) => findMatches(doc, buildQuery(q).re).matches.length;
check("finds ignoring case by default", count({ text: "cat" }) === 6, String(count({ text: "cat" })));
check("match case", count({ text: "cat", caseSensitive: true }) === 4, String(count({ text: "cat", caseSensitive: true })));
check("whole word skips 'concat'", count({ text: "cat", wholeWord: true }) === 5, String(count({ text: "cat", wholeWord: true })));
check("equations are not searched as text", count({ text: "$" }) === 0);
check("regex", count({ text: "c.t", regex: true }) === 6);
check("an invalid regex reports an error instead of throwing", buildQuery({ text: "(", regex: true }).error && !buildQuery({ text: "(", regex: true }).re);
check("special characters are literal without regex", count({ text: "." }) === 0 && count({ text: "c.t" }) === 0);
check("an empty search finds nothing", count({ text: "" }) === 0);
check("empty regex matches do not hang", count({ text: "x*", regex: true }) === 0);
{
  const big = parseMarkdown("a".repeat(MAX_MATCHES + 50) + "\n");
  const r = findMatches(big, buildQuery({ text: "a" }).re);
  check("matches are capped on huge results", r.matches.length === MAX_MATCHES && r.truncated);
}

/* ---------- replace ---------- */
function replaced(md, q, replacement) {
  const state = EditorState.create({ doc: parseMarkdown(md) });
  const { matches } = findMatches(state.doc, buildQuery(q).re);
  const tr = state.tr;
  const n = replaceAll(tr, matches, replacement, !!q.regex);
  return [n, serializeMarkdown(state.apply(tr).doc)];
}
{
  const [n, out] = replaced("one **two** two\n", { text: "two" }, "2");
  check("replace all keeps formatting", n === 2 && out === "one **2** 2\n", JSON.stringify(out));
}
{
  const [, out] = replaced("John Smith\n", { text: "(\\w+) (\\w+)", regex: true }, "$2, $1");
  check("regex replacement uses groups", out === "Smith, John\n", JSON.stringify(out));
}
{
  const [, out] = replaced("cost 5\n", { text: "\\d", regex: true }, "$$$&");
  check("$$ and $& in replacements", out === "cost \\$5\n", JSON.stringify(out));
}
{
  const [, out] = replaced("a-b-c\n", { text: "-" }, "");
  check("an empty replacement deletes", out === "abc\n", JSON.stringify(out));
}
check("literal replacement ignores $ patterns", expandReplacement("$1", { groups: ["x", "y"] }, false) === "$1");

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
