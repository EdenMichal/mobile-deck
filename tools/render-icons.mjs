// Renders assets/icon.svg, the one source for the Mobile Deck icon, to the PWA icons
// assets/app-192.png and assets/app-512.png. Re-run after replacing icon.svg.
// Run: PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node tools/render-icons.mjs
import { readFileSync } from "node:fs";

const assets = new URL("../assets/", import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const svg = readFileSync(new URL("icon.svg", assets), "utf8");
const browser = await chromium.launch();
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><img id="icon" width="${size}" height="${size}" style="display:block" src="${src}"></body>`);
    await page.waitForFunction(() => document.getElementById("icon").complete);
    const path = new URL(`app-${size}.png`, assets).pathname;
    await page.screenshot({ path: decodeURIComponent(path), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`Rendered assets/app-${size}.png`);
  }
} finally {
  await browser.close();
}
