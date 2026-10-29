/**
 * Browser entry point, bundled by scripts/build.mjs into dist/assets/app-<hash>.js (+ .css).
 *
 * The app's own styles are imported here so esbuild emits them as one stylesheet that index.html links.
 * Not bundled: the fonts (dist/fonts/fonts.css) and KaTeX's stylesheet (dist/vendor/katex/), which
 * index.html links directly. The exporters read the same files when they embed fonts in an HTML export.
 *
 * If start-up fails (a bug, or a browser too old for the bundle) the message is shown on the page,
 * because a blank screen gives the user nothing to report.
 *
 * In production a service worker is registered so the editor also opens offline (src/sw.js).
 */
import "../styles/tokens.css";
import "../styles/doc.css";
import "../styles/ui.css";
import { boot } from "./app/main.js";

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", '<div class="boot-error">The editor failed to start: ' + String(e.message || e).replace(/</g, "&lt;") + "</div>");
});

// Offline support. Only on https or localhost (browsers require it), and not in the dev server.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => { /* offline support is optional */ }); });
}
