// Math in pasted web content (src/client/editor/paste-math.js): formulas that arrive as plain text
// become equations, and everything that only looks like math stays text. Runs without a browser;
// the HTML side (KaTeX, MathML, Wikipedia markup) is covered by test/e2e.mjs.
//   node test/paste.mjs
import { Slice } from "prosemirror-model";
import { schema } from "../src/client/schema.js";
import { parseMarkdown, serializeMarkdown } from "../src/client/markdown.js";
import { convertPastedMath, findTextMath, unwrapStyle, cleanTex } from "../src/client/editor/paste-math.js";

let failed = 0, total = 0;
const check = (name, ok, extra = "") => { total++; if (!ok) failed++; console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : "  → " + extra)); };

// Builds the document a web paste would give (Markdown source with \$ = a literal dollar in the text),
// converts it, and returns the result as Markdown. `open` pastes it as an open slice (merging into
// the paragraph at the cursor), as ProseMirror does for most pastes from web pages.
function paste(md, open = false) {
  const doc = parseMarkdown(md);
  const slice = open ? Slice.maxOpen(doc.content) : new Slice(doc.content, 0, 0);
  const out = convertPastedMath(slice, schema);
  const result = schema.topNodeType.create(null, out.content);
  return { md: serializeMarkdown(result), doc: result, same: out === slice };
}
const types = (doc) => { const t = []; doc.descendants((n) => { t.push(n.type.name); }); return t; };
const has = (doc, name) => types(doc).includes(name);
const texOf = (doc) => { let t = null; doc.descendants((n) => { if (t == null && /^math/.test(n.type.name)) t = n.attrs.tex; }); return t; };

/* ---------- the reported case ---------- */
{
  const r = paste(String.raw`Blocks of 4 KiB: \$\text{space} = \lceil \text{size}/4096 \rceil \times 4096\$. A 1-byte file.` + "\n");
  check("inline $…$ from a web page becomes math", has(r.doc, "math_inline") && texOf(r.doc) === String.raw`\text{space} = \lceil \text{size}/4096 \rceil \times 4096`, r.md);
  check("the text around it is kept", r.md.startsWith("Blocks of 4 KiB: $") && r.md.includes("$. A 1-byte file."), r.md);
}
{
  const r = paste("With r=4:\n\n\\$\\$\\text{digit} = 4r + 2w + x\\$\\$\n\nnext\n");
  check("a paragraph that is only $$…$$ becomes an equation block", has(r.doc, "math_block") && texOf(r.doc) === String.raw`\text{digit} = 4r + 2w + x`, r.md);
}

/* ---------- things that must stay text ---------- */
check("prices stay text", paste("It costs \\$5 and \\$6.\n").same);
check("a price range stays text", paste("Between \\$5-\\$10 a month.\n").same);
check("shell variables stay text", paste("Set \\$PATH and \\$HOME first.\n").same);
check("one dollar sign stays text", paste("US\\$ 100\n").same);
check("an escaped dollar stays a dollar", paste("Use \\\\\\$x\\\\\\$ for a literal.\n").same);
check("inline code is not touched", paste("Run `echo $x$` now.\n").same);
check("code blocks are not touched", paste("```\nprice=$a$b\n```\n").same);
check("TeX that KaTeX cannot render stays text", paste("Broken \\$\\frac{a\\$ here.\n").same);
check("an unknown command stays text", paste("Hi \\$\\notacommand\\$ there.\n").same);
check("a formula split by formatting stays text", paste("Half \\$x **+ y\\$** bold.\n").same);
check("a formula across a line break stays text", paste("a \\$x\\\nb\\$ c\n").same);
check("very long dollar spans stay text", paste("\\$" + "a".repeat(5000) + "\\$\n").same);

/* ---------- other delimiters and layouts ---------- */
{
  const r = paste("Euler: \\\\(e^{i\\pi} + 1 = 0\\\\) holds.\n");
  check("\\(…\\) becomes inline math", has(r.doc, "math_inline") && texOf(r.doc) === String.raw`e^{i\pi} + 1 = 0`, r.md);
}
{
  const r = paste("\\\\[\\int_0^1 x\\\\,dx\\\\]\n");
  check("\\[…\\] alone in a paragraph becomes an equation block", has(r.doc, "math_block") && texOf(r.doc) === String.raw`\int_0^1 x\,dx`, r.md);
}
{
  const r = paste("\\$\\$\\\na^2 + b^2\\\n= c^2\\\n\\$\\$\n");
  check("$$ on separate lines becomes one equation block", has(r.doc, "math_block") && texOf(r.doc) === "a^2 + b^2\n= c^2", r.md);
  check("…written back with the delimiters on their own lines", r.md === "$$\na^2 + b^2\n= c^2\n$$\n", JSON.stringify(r.md));
}
{
  const r = paste("so \\$\\$x^2\\$\\$ inline\n");
  check("$$…$$ inside a sentence stays inline display math", has(r.doc, "math_inline") && !has(r.doc, "math_block") && r.md === "so $$x^2$$ inline\n", r.md);
}
{
  const r = paste("\\$\\$x^2\\$\\$\n", true);
  check("an open edge paragraph is not turned into a block", has(r.doc, "paragraph") && has(r.doc, "math_inline") && !has(r.doc, "math_block"), r.md);
}

/* ---------- formatting and containers ---------- */
{
  const r = paste("**Area \\$\\pi r^2\\$**\n");
  check("math inside bold keeps the bold", r.md === "**Area $\\pi r^2$**\n", JSON.stringify(r.md));
}
{
  const r = paste("## Rule \\$a^2\\$\n\n- item \\$b_1\\$\n- [ ] task \\$c\\$\n\n> quote \\$d\\$\n\n| A | B |\n|---|---|\n| \\$\\|x\\|\\$ | y |\n");
  const n = types(r.doc).filter((t) => t === "math_inline").length;
  check("headings, lists, tasks, quotes and table cells convert", n === 5, r.md);
  check("a formula with | in a table cell survives saving", parseMarkdown(r.md).toString() === r.doc.toString(), r.md);
}
{
  const r = paste("Two \\$a\\$ and \\$b\\$ here.\n");
  check("several formulas in one paragraph", types(r.doc).filter((t) => t === "math_inline").length === 2 && r.md === "Two $a$ and $b$ here.\n", r.md);
}
{
  const r = paste(String.raw`A paragraph with \$x\$` + "\n\n" + String.raw`and \$\$y\$\$` + "\n");
  check("converted documents round-trip through Markdown", serializeMarkdown(parseMarkdown(r.md)) === r.md, r.md);
}

/* ---------- text clean-up ---------- */
check("non-breaking spaces become spaces", cleanTex("a\u00a0+\u00a0b") === "a + b");
check("zero-width characters and soft hyphens are removed", cleanTex("x\u200b^\u00ad2\ufeff") === "x^2");
{
  const f = findTextMath("val $x\u200b^2$ ok");
  check("a formula with a zero-width space still converts", f.length === 1 && f[0].tex === "x^2", JSON.stringify(f));
}
check("Wikipedia's {\\displaystyle …} wrapper is removed", unwrapStyle("{\\displaystyle x^{2}}") === "x^{2}");
check("…only when it wraps the whole formula", unwrapStyle("{\\displaystyle a}{b}") === "{\\displaystyle a}{b}");
check("…and escaped braces do not confuse it", unwrapStyle("{\\displaystyle \\{a\\}}") === "\\{a\\}");

console.log(`${total - failed}/${total} passed`);
if (failed) process.exit(1);
