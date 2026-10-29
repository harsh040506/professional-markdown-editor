// Finds an installed Chrome-family browser and starts it with Puppeteer, for the end-to-end tests and the
// screenshot script. Nothing is downloaded: set CHROME_PATH to use a specific browser.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

export function findBrowser() {
  const env = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env && fs.existsSync(env)) return env;
  const win = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    ...win.flatMap((d) => [path.join(d, "Google", "Chrome", "Application", "chrome.exe"), path.join(d, "Microsoft", "Edge", "Application", "msedge.exe")]),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

export async function launch(extraArgs = []) {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error("No Chrome, Edge or Chromium found. Install one, or set CHROME_PATH to its program file.");
  return puppeteer.launch({ executablePath, headless: true, protocolTimeout: 60000, args: ["--no-sandbox", "--disable-dev-shm-usage", ...extraArgs] });
}
