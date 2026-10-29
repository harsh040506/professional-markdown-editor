# Security

## Reporting a vulnerability

Please report vulnerabilities **privately** through [GitHub's private vulnerability reporting](https://github.com/harsh040506/professional-markdown-editor/security/advisories/new) rather than a public issue. I will acknowledge a report within a few days and keep you updated until it is fixed.

## What the app does and does not do

The editor is a static web page. There is no server component, no account, no analytics and no network call that carries your documents.

- Documents are kept in your browser (IndexedDB) or, in folder mode, in a folder you pick with the browser's own picker. Nothing is uploaded.
- Exports (PDF, Word, HTML) are built in your browser.
- The only requests the app makes beyond loading itself are the ones a document asks for: images and links that point to the web.

## What protects you

- **Content-Security-Policy** (`public/_headers`, `vercel.json`): scripts may only come from the app's own files; no inline scripts, no `eval`, no plugins, no framing.
- **Documents cannot inject markup.** Raw HTML in Markdown is shown as text, never run. KaTeX runs with `trust: false`. Mermaid runs with `securityLevel: "strict"`.
- **Links are filtered.** Only web, email, phone, `#anchor` and relative links open from the editor; `javascript:`, `data:` and similar targets are refused (`isSafeHref`, tested in `test/paths.mjs`).
- **Storage paths are checked.** Names with `..`, absolute paths, hidden parts (`.git`, `.env`) and unsafe characters are refused before any read or write, in both the library and folder mode (`src/client/storage/common.js`, tested in `test/e2e.mjs`).
- **Folder mode is limited by the browser.** The app can only touch the folder you chose, only after you allow it.

## Things to be aware of

- A document can link to an image on any HTTPS site. Opening such a document makes your browser request that image, which tells that site your IP address. Remote images are not fetched into the library.
- Browser storage is not a backup. Browsers can clear site data when disk space is low, or if you clear it yourself. Use folder mode, or Export → Markdown, for anything you cannot lose.
- Anyone with access to your browser profile can read the library.

## Supported versions

Only the latest release and the `main` branch are maintained.
