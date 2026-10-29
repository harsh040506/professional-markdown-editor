/**
 * Turning pictures into the forms the exporters need, using the browser's own image decoder and canvas:
 *   decodeImage(blob)        any image the browser can show -> bytes Word accepts (PNG, JPEG, GIF, BMP) with its size.
 *                            SVG, WebP and AVIF, which Word cannot show, are redrawn as PNG
 *   svgToPng(svg, scale)     an SVG string (a Mermaid diagram) -> PNG bytes with its size, at `scale` times
 *                            the drawn size so it stays sharp in print
 * Both return null / throw on pictures the browser cannot decode; callers then fall back to text.
 */

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("The image could not be decoded"));
  img.src = url;
});

const toBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not draw the image"))), "image/png"));

// The file type from its first bytes (the file name and MIME type are not trusted), for the formats Word reads.
function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  return null;
}

/**
 * @param {Blob} blob
 * @returns {Promise<{data: Uint8Array, type: "png"|"jpg"|"gif"|"bmp", width: number, height: number}|null>}
 */
export async function decodeImage(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const width = img.naturalWidth || 800, height = img.naturalHeight || 600;
      const type = sniff(bytes);
      if (type) return { data: bytes, type, width, height };
      // SVG, WebP, AVIF …: redraw as PNG
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      return { data: new Uint8Array(await (await toBlob(canvas)).arrayBuffer()), type: "png", width, height };
    } finally { URL.revokeObjectURL(url); }
  } catch { return null; }
}

/**
 * Draws an SVG string onto a white canvas and returns it as PNG. The drawn size comes from the SVG's own
 * width/height or viewBox (Mermaid writes width="100%" and a viewBox, so the viewBox decides). Diagrams
 * must be drawn without HTML labels (<foreignObject>), which would taint the canvas; export/browser.js
 * asks Mermaid for that.
 * @returns {Promise<{png: Uint8Array, width: number, height: number}>}
 */
export async function svgToPng(svgText, scale = 2) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName !== "svg") throw new Error("Not an SVG");
  const vb = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const num = (v) => (/^[\d.]+(px)?$/.test(v || "") ? parseFloat(v) : 0);
  const width = Math.ceil(num(root.getAttribute("width")) || vb[2] || 800);
  const height = Math.ceil(num(root.getAttribute("height")) || vb[3] || 600);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute("style", (root.getAttribute("style") || "").replace(/max-width:[^;]*;?/g, ""));
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(root)));
  const canvas = document.createElement("canvas");
  canvas.width = width * scale; canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { png: new Uint8Array(await (await toBlob(canvas)).arrayBuffer()), width, height };
}
