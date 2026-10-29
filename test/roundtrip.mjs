// Every Markdown file in a folder must survive open -> save -> open -> save unchanged
// (the second save equals the first), so editing never drifts the text.
//   node test/roundtrip.mjs [folder]
import fs from "node:fs";
import path from "node:path";
import { parseMarkdown, serializeMarkdown } from "../src/client/markdown.js";
import { SAMPLE } from "../src/client/app/sample.js";

const dir = path.resolve(process.argv[2] || path.join(import.meta.dirname, "fixtures"));
let failed = 0, total = 0;
for (const f of fs.readdirSync(dir).filter((f) => /\.(md|markdown)$/i.test(f))) {
  total++;
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  const d1 = parseMarkdown(src), s1 = serializeMarkdown(d1);
  const d2 = parseMarkdown(s1), s2 = serializeMarkdown(d2);
  const ok = s1 === s2 && d1.eq(d2);
  if (!ok) failed++;
  console.log((ok ? "ok   " : "FAIL ") + f);
}
// the welcome document is shown to every new visitor, so it must be stable too
total++;
{
  const s1 = serializeMarkdown(parseMarkdown(SAMPLE)), s2 = serializeMarkdown(parseMarkdown(s1));
  const ok = s1 === s2 && s1 === SAMPLE;
  if (!ok) { failed++; console.log("     welcome document changes when saved:\n" + s1); }
  console.log((ok ? "ok   " : "FAIL ") + "welcome document (src/client/app/sample.js)");
}
console.log(`${total - failed}/${total} stable`);
process.exit(failed ? 1 : 0);
