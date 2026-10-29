# Contributing

Thanks for helping. This is a small project with one rule that shapes most decisions: **the editor runs entirely in the browser, with no server and no account.** Changes that keep that true are easy to accept; changes that need a backend are not a fit.

## Set up

You need Node 20.11 or newer (22 recommended; see `.nvmrc`).

```bash
git clone https://github.com/harsh040506/professional-markdown-editor
cd professional-markdown-editor
npm install
npm run dev        # http://127.0.0.1:4317, rebuilds on every change
```

## Before you open a pull request

```bash
npm test           # round-trip, link safety, export output (a few seconds)
npm run test:e2e   # builds the site and drives it in Chrome, Edge or Chromium
```

`test:e2e` needs a Chromium-based browser; it finds an installed one, or set `CHROME_PATH`. It checks start-up, saving, version history, folder mode, the three exports and offline use, and fails on any console error.

If you change how Markdown is read or written, add a file that exercises it to `test/fixtures/`. `npm run test:roundtrip` requires every fixture to survive open, save, open, save without changing.

## Where things are

| Path | What it does |
|---|---|
| `src/client/app/main.js` | The app shell: toolbar, document lifecycle, drafts, saving |
| `src/client/storage/` | Where documents live: the browser library (IndexedDB) and folder mode (File System Access API) |
| `src/client/editor/` | The ProseMirror editor: schema, commands, node views, plugins |
| `src/client/markdown.js` | The save format and the round-trip guarantee |
| `src/shared/` | Markdown parsing, highlighting and math, shared by the editor and the exporters |
| `src/export/` | PDF (print), Word and HTML export. `page.js`, `render.js` and `docx.js` are pure and run in Node tests; `browser.js` does the parts that need a browser |
| `src/styles/` | `tokens.css` (colours and fonts), `doc.css` (the document), `ui.css` (the app), `export.css` (print and exports) |
| `scripts/build.mjs` | Builds the static site into `dist/` |

Every source file starts with a comment describing its role and the rules it must keep. Please keep that up when you change a file.

## Dependencies and licenses

The project is MIT. New dependencies should be permissively licensed (MIT, BSD, ISC, Apache-2.0, or OFL for fonts). After adding or updating one, run:

```bash
npm run notices
```

and commit the regenerated `THIRD_PARTY_NOTICES.md`. CI fails if it is out of date. Please do not add fonts, icons or images unless their license allows redistribution in an MIT project, and say where they came from in the pull request.

## Security headers

`public/_headers` (Cloudflare, Netlify) and `vercel.json` carry the same Content-Security-Policy and caching rules. If you change one, change the other.

## Style

- Plain modern JavaScript (ES modules), no framework and no TypeScript build step.
- Two-space indent, semicolons, double quotes. `.editorconfig` has the rest.
- Comments explain *why*, and name the rule a piece of code protects. Match the density of the surrounding code.
- User-visible text is plain and specific: say what happened and what to do.

## Reporting problems

Use the issue templates. For security problems, see [SECURITY.md](SECURITY.md) and report privately.
