// Link safety and path helpers used by the browser app (src/client/app/paths.js, which has no DOM
// dependency, so it runs in Node).
//   node test/paths.mjs
import { isSafeHref, joinPath, dirname } from "../src/client/app/paths.js";

let failed = 0, total = 0;
const eq = (name, got, want) => {
  total++;
  const ok = got === want;
  if (!ok) failed++;
  console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : `  → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};

// Opened from the editor: web, mail, phone, anchors and relative paths.
for (const href of ["https://example.com", "http://a.b/c?d=e#f", "mailto:a@b.c", "tel:+123", "#section", "notes/other.md", "../up.md", "/abs/path", "example.com"]) {
  eq("allows " + href, isSafeHref(href), true);
}
// Refused: anything that could run script or load a document in the editor's origin, including the
// whitespace/control-character and case tricks browsers tolerate when parsing a URL.
for (const href of ["javascript:alert(1)", " JavaScript:alert(1)", "JAVASCRIPT:alert(1)", "java\tscript:alert(1)", "\u0001javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "file:///C:/x", "blob:http://x/y"]) {
  eq("refuses " + JSON.stringify(href), isSafeHref(href), false);
}
eq("empty href is safe (nothing to open)", isSafeHref(""), true);
eq("joinPath resolves ..", joinPath("notes/week1", "../assets/a.png"), "notes/assets/a.png");
eq("joinPath cannot climb above the top", joinPath("", "../x"), "x");
eq("dirname of a nested file", dirname("a/b/c.md"), "a/b");
eq("dirname of a top-level file", dirname("c.md"), "");

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
