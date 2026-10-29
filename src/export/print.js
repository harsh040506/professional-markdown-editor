/**
 * PDF export: prints a finished HTML page through the browser's own print dialog, where "Save as PDF"
 * is a destination. No server or PDF library is involved, so the PDF has real selectable text, embedded
 * fonts, links, and (in Chrome and Edge, which draw PDF outlines from headings) a navigable outline.
 *
 * The page (export/page.js, mode "pdf") is loaded into an off-screen frame, so the editor underneath is
 * untouched. Printing waits for the frame's fonts and images, because printing a half-loaded page gives a
 * PDF with fallback fonts and missing pictures. The browser takes the suggested PDF file name from the
 * top page's title, so that is set for the duration of the dialog.
 */

/**
 * @param {string} html      the complete page
 * @param {{fileName?: string}} [options]  suggested name without extension
 * @returns {Promise<void>}  resolves once the print dialog has been closed (or after a safety timeout)
 */
export function printHtml(html, { fileName } = {}) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "Print preview";
    // Off-screen but laid out at A4 width: a frame that is display:none or 0 x 0 prints blank in some browsers.
    Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: "794px", height: "1123px", border: "0" });
    const oldTitle = document.title;
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      document.title = oldTitle;
      setTimeout(() => frame.remove(), 500);
      if (err) reject(err); else resolve();
    };
    frame.onload = async () => {
      try {
        const win = frame.contentWindow, doc = frame.contentDocument;
        await doc.fonts.ready;
        await Promise.all([...doc.images].map((img) => (img.complete ? null : img.decode().catch(() => {}))));
        if (fileName) document.title = fileName;
        win.addEventListener("afterprint", () => finish());
        win.focus();
        win.print(); // blocks in Chrome until the dialog closes; Firefox returns at once and fires afterprint later
        setTimeout(() => finish(), 5 * 60 * 1000);
        if (!("onafterprint" in win)) finish();
      } catch (e) { finish(e); }
    };
    frame.onerror = () => finish(new Error("Could not prepare the print preview"));
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}
