#!/usr/bin/env node
// Renders public/favicon.svg to the PNG icons that browsers and phones need (installable app icons and the
// iOS home-screen icon). Run it again only when the favicon changes; the PNGs are committed.
//   node scripts/make-icons.mjs
import fs from "node:fs";
import path from "node:path";
import { launch } from "../test/browser.mjs";

const pub = path.join(import.meta.dirname, "..", "public");
const svg = fs.readFileSync(path.join(pub, "favicon.svg"), "utf8");
const browser = await launch();
try {
  const page = await browser.newPage();
  const make = async (file, size, { square = false } = {}) => {
    await page.setViewport({ width: size, height: size });
    // iOS rounds the corners itself, so its icon is a full square; the others keep the rounded corners
    await page.setContent(`<body style="margin:0;background:${square ? "#1f1e1d" : "transparent"}"><div style="width:${size}px;height:${size}px">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div>`);
    await page.screenshot({ path: path.join(pub, file), omitBackground: !square });
    console.log("wrote public/" + file);
  };
  await make("icon-192.png", 192);
  await make("icon-512.png", 512);
  await make("apple-touch-icon.png", 180, { square: true });
} finally { await browser.close(); }
