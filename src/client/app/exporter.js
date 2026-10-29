/**
 * Export dialog for PDF, Word and HTML, plus the instant Markdown download.
 *
 * The dialog collects options; the file is then built in this browser by export/browser.js (loaded the
 * first time it is needed) from the editor's current Markdown, not from the saved file, so unsaved changes
 * are included. Nothing is uploaded. Options are remembered per format in localStorage ("mde:export:<format>").
 *
 * Options passed to the exporters:
 *   pageSize   "A4" | "Letter" | "Legal"          (PDF, Word)
 *   margins    "narrow" | "normal" | "wide"       (PDF, Word)
 *   pageNumbers, titleHeader                      (PDF, Word)
 *   details    "expanded" | "collapsed"           collapsible sections: contents shown, or summary only
 *   fonts      "document" | "office"              (Word) the editor's fonts, or Calibri/Georgia/Consolas
 *   codeWrap                                      (PDF) wrap long code lines
 *   embedFonts                                    (HTML) self-contained file with the fonts inside
 *   headingFont, textFont                         the editor's current font choices
 *
 * PDF is made by the browser's print dialog ("Save as PDF"), which is why that dialog has no file name
 * and explains the two print settings worth checking.
 */
import { h, load, save } from "../ui/dom.js";
import { dialog, toast, segmented, toggle, row, textField } from "../ui/overlay.js";
import { download } from "./download.js";
import { getMarkdown } from "../editor/editor.js";

// Dialog title, file extension and button label per format.
const FORMATS = {
  pdf: { title: "Export as PDF", ext: "pdf", label: "Open print window" },
  docx: { title: "Export as Word", ext: "docx", label: "Export Word" },
  html: { title: "Export as web page", ext: "html", label: "Export HTML" }
};
// Option defaults; saved choices are merged over these, so options added later get a default.
const DEFAULTS = { pageSize: "A4", margins: "normal", pageNumbers: true, titleHeader: false, details: "expanded", fonts: "document", embedFonts: true, codeWrap: true };

// Downloads the document as Markdown, exactly what Save would write.
export function exportMarkdown(view, base) {
  download(new Blob([getMarkdown(view)], { type: "text/markdown;charset=utf-8" }), base + ".md");
  toast("Downloaded " + base + ".md", { kind: "success" });
}

// Firefox does not draw CSS page-number boxes (Chrome, Edge and Safari do).
const NO_PAGE_BOXES = /Firefox\//.test(navigator.userAgent);

/**
 * Opens the export dialog for "pdf", "docx" or "html".
 * @param {"pdf"|"docx"|"html"} format
 * @param {{view, title: string, base: string, settings: object, docPath: string|null}} ctx
 *        title goes into the PDF header/metadata, base is the suggested file name, docPath lets the
 *        exporters find the document's stored images
 */
export function openExportDialog(format, { view, title, base, settings, docPath }) {
  const f = FORMATS[format];
  const opts = Object.assign({}, DEFAULTS, load("export:" + format, {}));
  const name = textField({ label: "File name", value: base });
  const ctl = {};
  const rows = [h("div", { class: "export-name" }, name.el, h("span", { class: "export-ext" }, "." + f.ext))];
  if (format === "pdf" || format === "docx") {
    ctl.pageSize = segmented([{ value: "A4", label: "A4" }, { value: "Letter", label: "Letter" }, { value: "Legal", label: "Legal" }], opts.pageSize, (v) => (opts.pageSize = v), { label: "Page size" });
    ctl.margins = segmented([{ value: "narrow", label: "Narrow" }, { value: "normal", label: "Normal" }, { value: "wide", label: "Wide" }], opts.margins, (v) => (opts.margins = v), { label: "Margins" });
    ctl.pageNumbers = toggle(opts.pageNumbers, (v) => (opts.pageNumbers = v), { label: "Page numbers" });
    rows.push(row("Page size", ctl.pageSize.el), row("Margins", ctl.margins.el), row("Page numbers", ctl.pageNumbers.el, format === "pdf" && NO_PAGE_BOXES ? "Firefox cannot print page numbers; use Chrome, Edge or Safari for these" : "In the footer of every page"));
    ctl.titleHeader = toggle(opts.titleHeader, (v) => (opts.titleHeader = v), { label: "Title in header" });
    rows.push(row("Title in header", ctl.titleHeader.el, "The document title at the top of each page after the first"));
  }
  ctl.details = segmented([{ value: "expanded", label: "Show contents" }, { value: "collapsed", label: "Summary only" }], opts.details, (v) => (opts.details = v), { label: "Collapsible sections" });
  rows.push(row("Collapsible sections", ctl.details.el, format === "html" ? "How they start out; readers can still open them" : "For answer keys, choose Summary only to hide the answers"));
  if (format === "docx") {
    ctl.fonts = segmented([{ value: "document", label: "Editor fonts" }, { value: "office", label: "Office fonts" }], opts.fonts, (v) => (opts.fonts = v), { label: "Fonts" });
    rows.push(row("Fonts", ctl.fonts.el, "Editor fonts (DM Sans, Newsreader, JetBrains Mono) look right where they are installed. Office fonts (Calibri, Georgia, Consolas) look the same on every computer."));
  }
  if (format === "pdf") {
    ctl.codeWrap = toggle(opts.codeWrap, (v) => (opts.codeWrap = v), { label: "Wrap long code lines" });
    rows.push(row("Wrap long code lines", ctl.codeWrap.el, "Otherwise long lines are cut at the page edge"));
  }
  if (format === "html") {
    ctl.embedFonts = toggle(opts.embedFonts, (v) => (opts.embedFonts = v), { label: "Embed fonts" });
    rows.push(row("Embed fonts", ctl.embedFonts.el, "One self-contained file that looks the same anywhere (larger file)"));
  }
  const note = h("div", { class: "export-note" }, format === "pdf"
    ? "Your browser's print window opens next. Choose “Save as PDF” as the destination, and switch off “Headers and footers” if it is on. The PDF has selectable text, links and the fonts you see here."
    : "Fonts: headings " + settings.headingFont + ", text " + settings.textFont + " (change them with the Aa menu). Built in this browser; nothing is uploaded.");

  dialog({
    title: f.title, width: 520, className: "dialog-export",
    body: h("div", { class: "export-form" }, rows, note),
    actions: [
      { label: "Cancel", run: (close) => close() },
      { label: f.label, variant: "primary", icon: "Export", run: (close, btn) => run(close, btn) }
    ]
  });

  // Runs the export: closes the dialog at once and shows progress in a toast (a large document with
  // diagrams can take a few seconds). Characters that are invalid in file names are replaced by spaces.
  async function run(close, btn) {
    save("export:" + format, opts);
    const fileBase = (name.value.trim() || base).replace(/[\\/:*?"<>|]+/g, " ").trim();
    const fileName = fileBase + "." + f.ext;
    btn.disabled = true;
    close();
    const t = toast(format === "pdf" ? "Preparing the print view…" : "Exporting " + fileName + "…", { kind: "busy", timeout: 0 });
    try {
      const ctx = { markdown: getMarkdown(view), title, docPath, fileName: fileBase, options: { ...opts, headingFont: settings.headingFont, textFont: settings.textFont } };
      const exporters = await import("../../export/browser.js");
      if (format === "pdf") {
        t.dismiss();
        await exporters.printPdf(ctx);
        return;
      }
      const blob = format === "docx" ? await exporters.exportDocx(ctx) : await exporters.exportHtml(ctx);
      download(blob, fileName);
      t.update("Exported " + fileName, "success", 2400);
    } catch (e) {
      t.update("Export failed: " + (e && e.message || e), "error", 7000);
    }
  }
}
