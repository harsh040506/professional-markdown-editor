/**
 * Syntax highlighting with highlight.js, shared by the editor and the exporters.
 *
 * The editor cannot use highlight.js HTML directly: ProseMirror owns the code block's DOM, so colours
 * are applied as decorations over character ranges (editor/highlight-plugin.js). highlightCode()
 * therefore returns both the HTML (for exports) and the same result as {from, to, cls} ranges over
 * the plain text (for the editor and for coloured runs in Word).
 *
 * Only highlight.js's "common" bundle (~35 languages) is loaded, which keeps the browser bundle small.
 */
import hljs from "highlight.js/lib/common";

// Fence names people write -> highlight.js language ids. Languages missing here and unknown to
// highlight.js are shown uncoloured rather than guessed.
const ALIASES = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", python3: "python", sh: "bash", shell: "bash", zsh: "bash", console: "bash", yml: "yaml",
  "c++": "cpp", cc: "cpp", hpp: "cpp", h: "c", cs: "csharp", "c#": "csharp", rb: "ruby", rs: "rust", kt: "kotlin",
  md: "markdown", html: "xml", htm: "xml", svg: "xml", plaintext: "plaintext", text: "plaintext", txt: "plaintext",
  ipython: "python", jsonc: "json", golang: "go", ps1: "powershell", pwsh: "powershell", proto: "protobuf", tex: "latex"
};

// The languages offered in the code block's language menu, as [id, label], in menu order. "mermaid"
// is not a highlight.js language: choosing it turns the block into a rendered diagram.
export const LANGUAGES = [
  ["plaintext", "Plain text"], ["python", "Python"], ["javascript", "JavaScript"], ["typescript", "TypeScript"],
  ["bash", "Bash"], ["json", "JSON"], ["yaml", "YAML"], ["xml", "HTML / XML"], ["css", "CSS"], ["scss", "SCSS"],
  ["sql", "SQL"], ["markdown", "Markdown"], ["c", "C"], ["cpp", "C++"], ["csharp", "C#"], ["java", "Java"],
  ["kotlin", "Kotlin"], ["go", "Go"], ["rust", "Rust"], ["ruby", "Ruby"], ["php", "PHP"], ["swift", "Swift"],
  ["r", "R"], ["lua", "Lua"], ["perl", "Perl"], ["diff", "Diff"], ["ini", "INI / TOML"], ["makefile", "Makefile"],
  ["graphql", "GraphQL"], ["objectivec", "Objective-C"], ["vbnet", "VB.NET"], ["wasm", "WebAssembly"],
  ["mermaid", "Mermaid diagram"], ["latex", "LaTeX"]
];
const LABELS = Object.fromEntries(LANGUAGES);

/**
 * Normalises a fence info string to a language id: trimmed, lower-cased and alias-resolved.
 * @param {string|null|undefined} lang  e.g. "JS", " py ", "c++"
 * @returns {string} e.g. "javascript", "python", "cpp"; "" when no language was given
 */
export function normalizeLang(lang) {
  const l = String(lang || "").trim().toLowerCase();
  return ALIASES[l] || l;
}
/**
 * Human-readable name for a language, for the code block's label.
 * @returns {string} the menu label, else highlight.js's name, else the text as written; "" if none
 */
export function langLabel(lang) {
  const n = normalizeLang(lang);
  if (!n) return "";
  if (LABELS[n]) return LABELS[n];
  const def = hljs.getLanguage(n);
  return def && def.name ? def.name : lang;
}

// HTML entities highlight.js emits; each stands for one character of the original code.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };

/**
 * Converts highlight.js HTML into [{from, to, cls}] ranges over the plain text.
 *
 * Walks the markup once, counting only text characters (an entity counts as one), and emits a range
 * when each <span class="…"> closes. Nested spans give nested ranges; the decoration layer applies
 * them in order, so inner colours win. Assumes well-formed highlight.js output (every "<" and "&" is
 * closed), which highlight.js guarantees because it escapes the code itself.
 *
 * @param {string} html
 * @returns {{from: number, to: number, cls: string}[]}
 */
function htmlToRanges(html) {
  const ranges = [], stack = [];
  let pos = 0, i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end + 1);
      if (tag.startsWith("</")) {
        const open = stack.pop();
        if (open && pos > open.from) ranges.push({ from: open.from, to: pos, cls: open.cls });
      } else {
        const m = /class="([^"]*)"/.exec(tag);
        stack.push({ from: pos, cls: m ? m[1] : "" });
      }
      i = end + 1;
    } else if (html[i] === "&") {
      const end = html.indexOf(";", i);
      const name = html.slice(i + 1, end);
      if (!(name in ENT) && !name.startsWith("#")) { pos++; i++; continue; }
      pos++;
      i = end + 1;
    } else { pos++; i++; }
  }
  return ranges;
}

// Memo of results keyed by language + code; emptied past 4000 entries (see math.js for the reasoning).
const cache = new Map();
/**
 * Highlights a code block.
 *
 * - "plaintext", "mermaid" and languages highlight.js does not know: no colours.
 * - A known language: highlighted as that language.
 * - No language: auto-detected among a short list of common languages, but only for code longer than
 *   12 characters and only when highlight.js is reasonably confident (relevance >= 6). A wrong guess
 *   colours prose-like text oddly, so leaving it plain is the safer failure.
 * Errors inside highlight.js are swallowed and give an uncoloured result.
 *
 * @param {string} code
 * @param {string} [lang]  fence language as written
 * @returns {{language: string, detected: boolean, ranges: {from:number,to:number,cls:string}[], html: string|null}}
 *          `detected` is true when the language was guessed; `html` is null when nothing is coloured
 * @example
 *   highlightCode("let x = 1", "js").ranges  // [{ from: 0, to: 3, cls: "hljs-keyword" }, …]
 */
export function highlightCode(code, lang) {
  const n = normalizeLang(lang);
  const key = n + "\u0000" + code;
  const hit = cache.get(key);
  if (hit) return hit;
  let res;
  try {
    if (n === "plaintext" || n === "mermaid" || (n && !hljs.getLanguage(n))) res = { language: n, detected: false, ranges: [], html: null };
    else if (n) {
      const r = hljs.highlight(code, { language: n, ignoreIllegals: true });
      res = { language: n, detected: false, ranges: htmlToRanges(r.value), html: r.value };
    } else if (code.trim().length > 12) {
      const r = hljs.highlightAuto(code, ["python", "javascript", "typescript", "bash", "json", "sql", "cpp", "java", "yaml", "xml", "css", "go", "rust"]);
      const ok = r.relevance >= 6 && r.language;
      res = ok ? { language: r.language, detected: true, ranges: htmlToRanges(r.value), html: r.value } : { language: "", detected: false, ranges: [], html: null };
    } else res = { language: "", detected: false, ranges: [], html: null };
  } catch {
    res = { language: n, detected: false, ranges: [], html: null };
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, res);
  return res;
}

// Escapes code for use inside <pre><code> when there is no highlight.js HTML (quotes need no escaping there).
export function escapeCode(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

