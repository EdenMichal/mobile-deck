// Shared Playwright login for the e2e suites. Joins test-5e-world as "Claude Test GM" only.
// Keep Playwright outside a cloud-synced folder (evicted node_modules files can hang on import).
// Set PLAYWRIGHT to its index.mjs, e.g. a scratch `npm i playwright@1.60.0`.
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");

// Second argument: a viewport, or { context, initScript } for device emulation (phone tests).
export async function joinTestWorld(name = "Claude Test GM", options = { width: 1280, height: 800 }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(options.context ?? { viewport: options });
  if (options.initScript) await ctx.addInitScript(options.initScript);
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  await page.goto("http://localhost:30000/join");
  await page.waitForSelector("select[name=userid]");
  const title = await page.title();
  if (!/test 5e world/i.test(title)) throw new Error("wrong world: " + title);
  const opt = await page.$eval("select[name=userid]", (s, n) => {
    const o = [...s.options].find(o => o.textContent.trim() === n);
    return o && { v: o.value, dis: o.disabled };
  }, name);
  if (!opt || opt.dis) throw new Error(name + " not available on the join page");
  await page.selectOption("select[name=userid]", opt.v);
  // At phone size Foundry shows a permanent "screen too small" notice over the Join button.
  await page.evaluate(() => document.querySelector("#notifications")?.remove());
  await page.click("button[name=join]");
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60000 });
  return { browser, page };
}
