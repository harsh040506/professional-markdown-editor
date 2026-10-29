/**
 * Icons. Every icon in the app comes from Hugeicons (free, stroke-rounded set). Only the icons named
 * in SET are bundled (esbuild drops the rest of the package), so adding an icon means importing it
 * here and giving it a short app name.
 *
 * icon("Bold") returns an inline SVG string that follows currentColor, so icons take the colour of the
 * text around them in both themes. The exporters use it too (export/render.js), for icons in exported HTML.
 */
import {
  File01Icon, ArrowDown01Icon, ArrowRight01Icon, ArrowUp01Icon, ArrowLeft01Icon, TextFontIcon, TableIcon,
  Image01Icon, CheckListIcon, Add01Icon, Download04Icon, Moon02Icon, Sun03Icon, MoreHorizontalIcon,
  Undo02Icon, Redo02Icon, Heading01Icon, Heading02Icon, Heading03Icon, Heading04Icon, TextIcon,
  LeftToRightListBulletIcon, LeftToRightListNumberIcon, QuoteDownIcon, SourceCodeIcon, CodeIcon,
  SolidLine01Icon, SigmaIcon, FlowConnectionIcon, Link01Icon, Unlink02Icon, TextBoldIcon, TextItalicIcon,
  TextUnderlineIcon, TextStrikethroughIcon, HighlighterIcon, TextClearIcon, Copy01Icon, Tick02Icon,
  Delete02Icon, Search01Icon, FolderOpenIcon, FloppyDiskIcon, FileAddIcon, Pdf02Icon, Doc02Icon, Html5Icon,
  KeyboardIcon, Cancel01Icon, TextAlignLeftIcon, TextAlignCenterIcon, TextAlignRightIcon, TextWrapIcon,
  DragDropVerticalIcon, DragDropHorizontalIcon, Calendar03Icon, PencilEdit02Icon, ArrowUpRight01Icon,
  InformationCircleIcon, Alert02Icon, Loading03Icon, ViewIcon, ArrowExpandIcon, ArrowShrinkIcon,
  InsertRowUpIcon, InsertRowDownIcon, InsertColumnLeftIcon, InsertColumnRightIcon, RowDeleteIcon,
  ColumnDeleteIcon, ListCollapseIcon, TextSubscriptIcon, TextSuperscriptIcon, FileImportIcon,
  ArrowHorizontalIcon, Settings02Icon, FunctionIcon, Layout2RowIcon, PlusSignIcon, Note01Icon, MinusSignIcon,
  Clock01Icon
} from "@hugeicons/core-free-icons";

// App icon names -> Hugeicons definitions. Names describe the use ("Export", "History"), not the drawing.
const SET = {
  File: File01Icon, ChevronDown: ArrowDown01Icon, ChevronRight: ArrowRight01Icon, ChevronUp: ArrowUp01Icon,
  ChevronLeft: ArrowLeft01Icon, Font: TextFontIcon, Table: TableIcon, Image: Image01Icon, Checklist: CheckListIcon,
  Add: Add01Icon, Plus: PlusSignIcon, Minus: MinusSignIcon, Export: Download04Icon, Moon: Moon02Icon, Sun: Sun03Icon,
  More: MoreHorizontalIcon, Undo: Undo02Icon, Redo: Redo02Icon, H1: Heading01Icon, H2: Heading02Icon,
  H3: Heading03Icon, H4: Heading04Icon, Text: TextIcon, Bullets: LeftToRightListBulletIcon,
  Numbers: LeftToRightListNumberIcon, Quote: QuoteDownIcon, CodeBlock: SourceCodeIcon, Code: CodeIcon,
  Divider: SolidLine01Icon, Math: SigmaIcon, MathInline: FunctionIcon, Diagram: FlowConnectionIcon, Link: Link01Icon,
  Unlink: Unlink02Icon, Bold: TextBoldIcon, Italic: TextItalicIcon, Underline: TextUnderlineIcon,
  Strike: TextStrikethroughIcon, Highlight: HighlighterIcon, ClearFormat: TextClearIcon, Copy: Copy01Icon,
  Check: Tick02Icon, Delete: Delete02Icon, Search: Search01Icon, Folder: FolderOpenIcon, Save: FloppyDiskIcon,
  New: FileAddIcon, Pdf: Pdf02Icon, Word: Doc02Icon, Html: Html5Icon, Keyboard: KeyboardIcon, Close: Cancel01Icon,
  AlignLeft: TextAlignLeftIcon, AlignCenter: TextAlignCenterIcon, AlignRight: TextAlignRightIcon, Wrap: TextWrapIcon,
  GripV: DragDropVerticalIcon, GripH: DragDropHorizontalIcon, Calendar: Calendar03Icon, Edit: PencilEdit02Icon,
  OpenLink: ArrowUpRight01Icon, Info: InformationCircleIcon, Warning: Alert02Icon, Spinner: Loading03Icon,
  Preview: ViewIcon, Expand: ArrowExpandIcon, Shrink: ArrowShrinkIcon, RowAbove: InsertRowUpIcon,
  RowBelow: InsertRowDownIcon, ColLeft: InsertColumnLeftIcon, ColRight: InsertColumnRightIcon,
  RowDelete: RowDeleteIcon, ColDelete: ColumnDeleteIcon, Details: ListCollapseIcon, Sub: TextSubscriptIcon,
  Sup: TextSuperscriptIcon, Import: FileImportIcon, Width: ArrowHorizontalIcon, Settings: Settings02Icon,
  Header: Layout2RowIcon, Markdown: Note01Icon, History: Clock01Icon
};

// Hugeicons definitions use camelCase attribute names; SVG markup needs the hyphenated ones.
const ATTR = { strokeWidth: "stroke-width", strokeLinecap: "stroke-linecap", strokeLinejoin: "stroke-linejoin",
  fillRule: "fill-rule", clipRule: "clip-rule", strokeMiterlimit: "stroke-miterlimit", fillOpacity: "fill-opacity", strokeOpacity: "stroke-opacity" };
// Rendered SVG strings by name|size|stroke, since the same icons are drawn many times.
const cache = new Map();

/**
 * An icon as an SVG string.
 * @param {string} name         a key of SET
 * @param {number} [size=16]    width and height in px
 * @param {number} [strokeWidth=1.5]
 * @returns {string} SVG markup (aria-hidden: icons are decorative; buttons carry aria-label);
 *          "" with a console warning for an unknown name
 */
export function icon(name, size = 16, strokeWidth = 1.5) {
  const key = name + "|" + size + "|" + strokeWidth;
  if (cache.has(key)) return cache.get(key);
  const data = SET[name];
  if (!data) { console.warn("missing icon", name); return ""; }
  let inner = "";
  for (const [tag, attrs] of data) {
    let a = "";
    for (const k in attrs) {
      if (k === "key") continue;
      let v = attrs[k];
      if (k === "strokeWidth") v = strokeWidth;
      a += " " + (ATTR[k] || k) + '="' + v + '"';
    }
    inner += "<" + tag + a + "/>";
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
    '" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" class="hi" data-icon="' + name + '">' + inner + "</svg>";
  cache.set(key, svg);
  return svg;
}
