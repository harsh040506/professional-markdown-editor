/**
 * The app's fonts: DM Sans (interface and body), Newsreader (headings) and JetBrains Mono (code), all
 * published under the SIL Open Font License through the @fontsource-variable packages. One list, used by
 * the build (scripts/build.mjs copies the files and writes fonts/fonts.css) and by the exporters (which
 * inline the same files into the HTML export). The family names are the ones in styles/tokens.css.
 *
 * Variable fonts: one file covers every weight. Only the Latin subset ships, to keep the app small;
 * other scripts fall back to the system font.
 */
export const FONTS = [
  { family: "DM Sans Variable", pkg: "dm-sans", weight: "100 1000" },
  { family: "Newsreader Variable", pkg: "newsreader", weight: "200 800" },
  { family: "JetBrains Mono Variable", pkg: "jetbrains-mono", weight: "100 800" }
];

/** Every font file with its @font-face properties: [{family, weight, style, file}]. */
export const FONT_FACES = FONTS.flatMap((f) => ["normal", "italic"].map((style) => ({
  family: f.family, weight: f.weight, style, file: `${f.pkg}-latin-wght-${style}.woff2`
})));
