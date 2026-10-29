#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md: every package that ends up in the shipped app (the production dependencies
// and what they depend on), with its license, copyright line and source address, followed by the full text
// of each license. The build copies the file into the site (dist/THIRD_PARTY_NOTICES.txt), because the
// minified bundle does not carry the licenses' notices and MIT/BSD ask that they travel with the code.
//   npm run notices          regenerate after changing dependencies
//   npm run notices -- --check   exit 1 if the committed file is out of date (used by CI)
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(import.meta.dirname);
const out = path.join(root, "THIRD_PARTY_NOTICES.md");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const pkg = readJson(path.join(root, "package.json"));

// Finds where `name` is installed as seen from `from` (Node's lookup: nearest node_modules upward).
function locate(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const p = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(p, "package.json"))) return p;
    if (dir === path.dirname(dir) || dir === path.dirname(root)) return null;
  }
}

// The closure of production dependencies (optional ones that are not installed are skipped).
const found = new Map(); // dir -> package.json
const queue = Object.keys(pkg.dependencies || {}).map((d) => [d, root]);
while (queue.length) {
  const [name, from] = queue.pop();
  const dir = locate(name, from);
  if (!dir || found.has(dir)) continue;
  const p = readJson(path.join(dir, "package.json"));
  found.set(dir, p);
  for (const d of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) queue.push([d, dir]);
}

const licenseOf = (p) => (typeof p.license === "string" ? p.license : p.license && p.license.type) || (p.licenses && p.licenses.map((l) => l.type).join(" OR ")) || "UNKNOWN";
const repoOf = (p) => String((p.repository && (p.repository.url || p.repository)) || p.homepage || "").replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://");
function licenseFile(dir) {
  const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n").trim() : null;
}

// A package without a license field but with a recognisable license file (khroma ships an MIT "license" file).
const sniff = (text) => (/^The MIT License/i.test(text || "") ? "MIT" : /^ISC License/i.test(text || "") ? "ISC" : null);

const rows = [...found].map(([dir, p]) => {
  const text = licenseFile(dir);
  if (licenseOf(p) === "UNKNOWN" && sniff(text)) p = { ...p, license: sniff(text) };
  const copyright = text ? [...new Set(text.split("\n").filter((l) => /^\s*(copyright|\(c\)|©)/i.test(l)).map((l) => l.trim()))].slice(0, 3) : [];
  return { name: p.name, version: p.version, license: licenseOf(p), repo: repoOf(p), copyright, text };
}).filter((r) => r.name).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0)); // plain order: the same on every machine

const notable = rows.filter((r) => /GPL|EPL|MPL|CC-BY|UNKNOWN/i.test(r.license));
// What to say about each package that needs a note.
const noteFor = (r) => {
  if (/LGPL/.test(r.license)) return "Used only to turn equations into native Word equations when a .docx is exported. It is loaded as a separate file (a lazy chunk of the build) on first use and is not part of the editor itself, so it can be replaced by another build of the library: edit the `mathml2omml` entry in `package.json`, run `npm install` and `npm run build`. Its full license text is below, and its source is at " + r.repo + ".";
  if (/EPL/.test(r.license)) return "The layout engine that Mermaid loads, only when a diagram asks for it, as a separate lazy chunk. It is distributed unmodified; its source is at " + r.repo + ".";
  if (/MPL.*OR.*Apache|Apache.*OR.*MPL/.test(r.license)) return "Offered under either license; this project uses it under Apache-2.0.";
  return "See its license text below.";
};
// One copy of each license text, keyed by license id; the first package's file stands for the permissive ones
// (their texts differ only by the copyright line, which is listed per package above), but non-standard texts
// (fonts, copyleft) are kept in full for every package that has one.
const standard = new Map();
const special = [];
for (const r of rows) {
  if (!r.text) continue;
  if (/^(MIT|ISC|BSD-[23]-Clause|Apache-2\.0|0BSD|BlueOak-1\.0\.0|CC0-1\.0|Unlicense|Python-2\.0)$/.test(r.license)) { if (!standard.has(r.license)) standard.set(r.license, r); }
  else special.push(r);
}

let md = `# Third-party notices

Professional Markdown Editor is released under the MIT License (see \`LICENSE\`). The app contains the open-source
packages below, each under its own license. This file is generated by \`npm run notices\`; do not edit it by hand.

${notable.length ? `## Packages that need a note

${notable.map((r) => `- **${r.name}** ${r.version}: ${r.license}. ${noteFor(r)}`).join("\n")}

` : ""}## Packages

| Package | Version | License | Copyright |
|---|---|---|---|
${rows.map((r) => `| ${r.repo ? `[${r.name}](${r.repo})` : r.name} | ${r.version} | ${r.license} | ${r.copyright.join("; ").replace(/\|/g, "/") || "see license text"} |`).join("\n")}

## Fonts

The editor uses DM Sans, Newsreader and JetBrains Mono (SIL Open Font License 1.1, distributed through the
\`@fontsource-variable\` packages above) and KaTeX's math fonts (SIL Open Font License 1.1 / MIT, part of \`katex\`).
Icons are from Hugeicons Free (\`@hugeicons/core-free-icons\`, MIT).

## License texts
`;
for (const [id, r] of standard) md += `\n### ${id}\n\nAs published in \`${r.name}\` (the copyright line differs per package; see the table above).\n\n\`\`\`text\n${r.text}\n\`\`\`\n`;
for (const r of special) md += `\n### ${r.name} ${r.version} (${r.license})\n\n\`\`\`text\n${r.text}\n\`\`\`\n`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (current !== md) { console.error("THIRD_PARTY_NOTICES.md is out of date. Run: npm run notices"); process.exit(1); }
  console.log("THIRD_PARTY_NOTICES.md is up to date (" + rows.length + " packages)");
} else {
  fs.writeFileSync(out, md);
  console.log(`wrote THIRD_PARTY_NOTICES.md: ${rows.length} packages, ${notable.length} with a note`);
  for (const r of notable) console.log("  note:", r.name, r.license);
  const unknown = rows.filter((r) => r.license === "UNKNOWN");
  if (unknown.length) console.log("  no license field:", unknown.map((r) => r.name).join(", "));
}
