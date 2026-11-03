// <details> sections must come out right however the source is written or broken: balanced, local
// (one lost tag never swallows the document), lossless and stable when saved again.
//   node test/details.mjs
import { parseMarkdown, serializeMarkdown } from "../src/client/markdown.js";

const r = String.raw;
let failed = 0, total = 0;
const check = (name, ok, extra = "") => { total++; if (!ok) failed++; console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : "  " + extra)); };

// A summary of the parsed document: how many sections, how deeply nested, which top-level blocks exist.
function shape(src) {
  const doc = parseMarkdown(src);
  let sections = 0, depth = 0, maxDepth = 0;
  const walk = (n, d) => n.forEach((c) => {
    if (c.type.name === "details") { sections++; maxDepth = Math.max(maxDepth, d + 1); }
    walk(c, d + (c.type.name === "details" ? 1 : 0));
  });
  walk(doc, depth);
  const saved = serializeMarkdown(doc);
  return { sections, maxDepth, saved, stable: serializeMarkdown(parseMarkdown(saved)) === saved, text: doc.textContent };
}

// The tags written with every "<" escaped, as Word, Google Docs and LLM exports do. One section per question.
const escaped = Array.from({ length: 6 }, (_, i) =>
  r` \<details>\<summary>Answers\</summary> ` + `\n\nanswer ${i}\n\n` + r` \</details> ` + `\n\n### Next ${i}\n\ntext ${i}\n`).join("\n");
{
  const s = shape(escaped);
  check("escaped tags become real sections", s.sections === 6, `sections=${s.sections}`);
  check("escaped sections do not nest inside each other", s.maxDepth === 1, `depth=${s.maxDepth}`);
  check("no stray backslashes or literal tags are left", !/[\\]|<\/?details>.*<\/?details>/.test(s.text) && !s.text.includes("</details>"), s.text.slice(0, 80));
  check("escaped sections are saved as plain HTML and stay stable", s.stable && !s.saved.includes("\\<") && (s.saved.match(/<details><summary>Answers<\/summary>/g) || []).length === 6);
}

// [name, source, expected sections, expected max depth, words that must survive]
const cases = [
  ["a literal \\<details> in prose stays text", r`Type \<details> to start a fold.` + "\n", 0, 0, ["Type", "fold"]],
  ["a lone escaped opener (no closer) stays text", r` \<details>\<summary>Q\</summary> ` + "\n\nbody\n", 0, 0, ["body"]],
  ["escaped text next to a real section", r`Use \<details> like this:` + "\n\n<details><summary>S</summary>\n\nbody\n\n</details>\n", 1, 1, ["Use", "body"]],
  ["closing tag in the middle of a paragraph", "<details><summary>S</summary>\n\nbody text </details>\n\nafter\n", 1, 1, ["body", "after"]],
  ["opening tag in the middle of a paragraph", "before <details><summary>S</summary>\n\nbody\n\n</details>\n", 1, 1, ["before", "body"]],
  ["attributes on details and summary", '<details open class="faq"><summary class="q">S</summary>\n\nbody\n\n</details>\n', 1, 1, ["body"]],
  ["upper-case tags", "<DETAILS><SUMMARY>S</SUMMARY>\n\nbody\n\n</DETAILS>\n", 1, 1, ["body"]],
  ["unclosed <summary> or look-alike tag does not hang", "<summary>S\n\nbody\n\n<detailsfoo>\n\nmore\n", 0, 0, ["body", "more"]],
  ["missing </details> ends at the next heading", "## A\n\n<details><summary>1</summary>\n\nx\n\n## B\n\n<details><summary>2</summary>\n\ny\n\n## C\n\nz\n", 2, 1, ["x", "y", "z"]],
  ["stray </details> is dropped", "text\n\n</details>\n\nmore\n", 0, 0, ["text", "more"]],
  ["section in a list item", "- item\n\n  <details><summary>S</summary>\n\n  body\n\n  </details>\n\n- two\n", 1, 1, ["item", "body", "two"]],
  ["unclosed section ends with its list item", "- item\n\n  <details><summary>S</summary>\n\n  body\n\n- two\n\nafter\n", 1, 1, ["item", "body", "two", "after"]],
  ["closer outside the list does not cross it", "- <details><summary>S</summary>\n\n  body\n\n</details>\n\nafter\n", 1, 1, ["body", "after"]],
  ["section starting a list item stays in the list", "- <details><summary>S</summary>\n\n  body\n\n  </details>\n\n- two\n", 1, 1, ["body", "two"]],
  ["section in a tight list item", "- a\n- <details>\n", 1, 1, ["a"]],
  ["section in a quote", "> <details><summary>S</summary>\n>\n> body\n>\n> </details>\n\nafter\n", 1, 1, ["body", "after"]],
  ["real nesting", "<details><summary>A</summary>\n\n<details><summary>B</summary>\n\nx\n\n</details>\n\n</details>\n", 2, 2, ["x"]],
  ["tags inside code are not sections", "Use `<details>`.\n\n```html\n<details><summary>x</summary>\n```\n", 0, 0, ["Use"]],
  ["no summary gets a default one", "<details>\n\nbody\n\n</details>\n", 1, 1, ["body", "Details"]],
  ["empty section", "<details><summary>S</summary></details>\n", 1, 1, ["S"]]
];
for (const [name, src, sections, depth, words] of cases) {
  let s;
  try { s = shape(src); } catch (e) { check(name, false, "threw " + e.message); continue; }
  const lost = words.filter((w) => !s.saved.includes(w));
  check(name, s.sections === sections && s.maxDepth === depth && s.stable && !lost.length,
    `sections=${s.sections}/${sections} depth=${s.maxDepth}/${depth} stable=${s.stable} lost=${lost}`);
}

// Random combinations of fragments: never fall back to plain text, never lose a word, always stable.
{
  const B = "\\";
  const frags = ["<details>", "<details open>", '<details class="a">', "</details>", "<summary>S</summary>", "<summary>", "</summary>",
    B + "<details>", B + "</details>", B + "<summary>Q" + B + "</summary>", "## H", "---", "- ZITEM", "  - ZNEST", "> ZQUOTE", "> <details>",
    "- <details>", "  </details>", "ZWORD", "text </details> ZTAIL", "pre <details> ZPOST", "`</details>`", "```", "1. ZONE", "- [ ] ZTASK",
    "| a | b |", "<div>", "<detailsx>"];
  const seps = ["\n", "\n\n", " ", "\n  "];
  let seed = 20240607;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const words = (t) => (t.match(/Z[A-Z]+/g) || []).length;
  const errors = console.error;
  let bad = null;
  for (let k = 0; k < 3000 && !bad; k++) {
    let src = "";
    for (let i = 0, m = 2 + rnd(8); i < m; i++) src += frags[rnd(frags.length)] + (i < m - 1 ? seps[rnd(seps.length)] : "\n");
    let fellBack = false;
    console.error = () => { fellBack = true; };
    try {
      const saved = serializeMarkdown(parseMarkdown(src));
      if (fellBack) bad = "fell back to plain text: " + JSON.stringify(src);
      else if (serializeMarkdown(parseMarkdown(saved)) !== saved) bad = "unstable: " + JSON.stringify(src);
      else if (words(saved) < words(src)) bad = "lost text: " + JSON.stringify(src);
    } catch (e) { bad = "threw " + e.message + ": " + JSON.stringify(src); }
    finally { console.error = errors; }
  }
  check("3000 random <details> mixes: no fallback, no loss, stable", !bad, bad || "");
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
