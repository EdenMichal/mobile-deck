// Phone-size UI test of Phase 4a creation in test-5e-world (Mobile Deck (DEV) enabled there), as Claude Test GM.
// Taps through: New character → Start → Class (Fighter) → Background (Soldier, +2 STR / +1 CON) → Species (Human)
// → Abilities (Standard Array + Suggested) → Equipment (A / A, trinket) → Details → Review → Create.
// Screenshots go to tests/foundry/screens/creation-*.png. Cleans up only what it made (its "CB" actor, its own user's
// new chat cards), the draft and creation rolls, the GM's assigned character and the house rules. Also prints the time of one step answer and one Equipment tap.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/creation-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.startsWith("creation-") && f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);

const phone = {
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  initScript: () => { try {
    localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("phone"));
    localStorage.setItem("music-deck.deckLink", "false");
  } catch {} }
};
const { browser, page } = await joinTestWorld("Claude Test GM", phone);
await pinToSrd(page); // the suite's expectations are for dnd5e's SRD content, not the user's books (pin-srd.mjs)
const results = [];
const check = (label, ok, info) => { results.push(ok); console.log(ok ? "PASS" : "FAIL", label, ok ? "" : JSON.stringify(info ?? "").slice(0, 400)); };
let n = 0;
const timings = {};
const shot = async name => { await page.waitForTimeout(350); await page.screenshot({ path: `${shotsDir}creation-${String(++n).padStart(2, "0")}-${name}.png` }); };

const before = await page.evaluate(async () => {
  const moduleId = game.modules.get("mobile-deck-dev")?.active ? "mobile-deck-dev" : "mobile-deck";
  const rules = foundry.utils.deepClone(game.settings.get(moduleId, "builderHouseRules") ?? {});
  await game.settings.set(moduleId, "builderHouseRules", { ...rules, abilityMethods: { standardArray: true, pointBuy: true, roll: false, manual: false }, abilityRerolls: 0 });
  const { createDraftStore } = await import(`/modules/${moduleId}/src/foundry/systems/dnd5e/builder/draft-store.mjs`);
  await createDraftStore(moduleId).finishCreation(); // no draft or rolls from an earlier run
  return { moduleId, rules, character: game.user.character?.id ?? null, messages: game.messages.map(m => m.id), actors: game.actors.map(a => a.id) };
});

const layer = page.locator(".ve-builder-layer");
const idle = () => page.waitForFunction(() => document.querySelector(".ve-builder-layer")?.getAttribute("aria-busy") !== "true");
const next = async () => { await layer.locator(".ve-builder-footer .ve-builder-primary").click(); await idle(); };
const screen = () => layer.getAttribute("data-screen");
// Answer whatever step is showing, the way a player would.
async function answerStep() {
  const type = await screen();
  if (type === "Trait") {
    for (let i = 0; i < 12 && await layer.locator(".ve-builder-footer .ve-builder-primary").isDisabled(); i++) {
      await layer.locator(".ve-builder-chip:visible:not([disabled]):not(.is-selected)").first().click();
    }
  } else if (type === "ItemChoice") {
    for (let i = 0; i < 6 && await layer.locator(".ve-builder-footer .ve-builder-primary").isDisabled(); i++) {
      await layer.locator(".ve-builder-card:visible:not([disabled]):not(.is-selected)").first().click();
    }
  } else if (type === "Size") {
    await layer.locator(".ve-builder-segment", { hasText: "Medium" }).click();
  } else if (type === "AbilityScoreImprovement") {
    await layer.locator('.ve-builder-segment[data-mode="21"]').click();
    await layer.locator('.ve-builder-bgasi-plus2 [data-ability="str"]').click();
    await layer.locator('.ve-builder-bgasi-plus1 [data-ability="con"]').click();
    await shot("background-asi");
  }
  const t0 = Date.now();
  await next();
  timings.step ??= { type, ms: Date.now() - t0 };
}
async function playTab(tab) {
  for (let i = 0; i < 20; i++) {
    const s = await screen();
    if (s === `${tab}-done`) return true;
    await answerStep();
  }
  return false;
}
async function pick(tab, name) {
  await page.waitForSelector(`.ve-builder-layer[data-screen="${tab}-pick"]`);
  await layer.locator(".ve-builder-card", { hasText: name }).first().click();
  await next();
}

try {
  await page.reload();
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60000 });
  await page.addStyleTag({ content: "#notifications { display: none !important; }" });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.rendered && app.options?.window) await app.close().catch(() => {});
    for (const app of Object.values(ui.windows ?? {})) await app.close?.().catch?.(() => {});
  });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.first().click().catch(() => {});

  // Open the character chooser if the New character row isn't already on screen.
  const row = page.locator(".ve-character-menu-new");
  if (!(await row.isVisible().catch(() => false))) await page.locator('.ve-character-screen button[aria-haspopup="menu"]').first().click();
  await row.waitFor({ timeout: 20000 });
  check("New character row in the character chooser", await row.isVisible());
  await shot("chooser");
  await row.click();
  await page.waitForSelector('.ve-builder-layer[data-screen="start"]');
  await shot("start");
  check("GM sees owner choices", await layer.locator("[data-owner]").count() >= 1);
  await layer.locator('[data-action="start"]').click();
  await idle();

  await pick("class", "Fighter");
  await shot("class-step");
  check("class tab finished", await playTab("class"));
  check("tabs show Class done", (await layer.locator('.ve-builder-tab[data-tab="class"]').getAttribute("class")).includes("is-done"));
  await shot("class-done");

  await layer.locator('.ve-builder-tab[data-tab="background"]').click();
  await idle();
  await pick("background", "Soldier");
  check("background tab finished", await playTab("background"));

  await layer.locator('.ve-builder-tab[data-tab="species"]').click();
  await idle();
  await page.waitForSelector('.ve-builder-layer[data-screen="species-pick"]');
  await shot("species-pick");
  await pick("species", "Human");
  check("species tab finished", await playTab("species"));
  // Data fix 4: Human's Skillful may take a skill the Fighter already picked (the replay runs species before class);
  // the Class tab then needs attention, and its skill step re-opens with a banner. Answer it again, as a player would.
  if ((await layer.locator('.ve-builder-tab[data-tab="class"]').getAttribute("class")).includes("is-attention")) {
    await layer.locator('.ve-builder-tab[data-tab="class"]').click();
    await idle();
    check("a re-opened class step shows the conflict banner", await layer.locator(".ve-builder-conflict").isVisible());
    await shot("class-conflict");
    check("class tab finished again", await playTab("class"));
  }

  await layer.locator('.ve-builder-tab[data-tab="abilities"]').click();
  await idle();
  await layer.locator('.ve-builder-segment[data-method="standardArray"]').click();
  await layer.locator('[data-action="suggested"]').click();
  await page.waitForTimeout(800); // debounced save
  const strText = await layer.locator('.ve-builder-ability-row[data-ability="str"]').innerText();
  check("Suggested puts 15 on STR, shown as 15 + 2 = 17", /17/.test(strText) && /15 \+ 2/.test(strText), strText);
  await shot("abilities-array");
  await layer.locator('.ve-builder-segment[data-method="pointBuy"]').click();
  await shot("abilities-point-buy");
  check("point buy counter shows 27 left", /27 \/ 27/.test(await layer.locator(".ve-builder-points").innerText()));
  const costs = await layer.locator(".ve-builder-step-cost").allInnerTexts();
  check("point buy shows the next step's cost under each +", costs.length === 6 && costs.every(c => c === "1 pt"), costs);
  check("Abilities tab follows Point Buy at once: unspent points need attention",
    (await layer.locator('.ve-builder-tab[data-tab="abilities"]').getAttribute("class")).includes("is-attention"));
  await layer.locator('.ve-builder-segment[data-method="standardArray"]').click();
  await layer.locator('[data-action="suggested"]').click();
  await page.waitForTimeout(800);

  await layer.locator('.ve-builder-tab[data-tab="equipment"]').click();
  await idle();
  const t1 = Date.now();
  await layer.locator('[data-source="class"] [data-option="A"]').click();
  await idle();
  timings.equipmentTap = Date.now() - t1;
  await layer.locator('[data-source="background"] [data-option="A"]').click();
  await idle();
  await layer.locator('[data-action="trinket"]').click();
  await idle();
  await shot("equipment");
  await layer.locator(".ve-builder-body").evaluate(el => { el.scrollTop = 0; });
  await shot("equipment-top");
  check("class package A selected", (await layer.locator('[data-source="class"] [data-option="A"]').getAttribute("aria-checked")) === "true");

  await layer.locator('.ve-builder-tab[data-tab="details"]').click();
  await idle();
  await layer.locator('.ve-builder-details input[name="name"]').fill("Brannoc (CB creation phone test)");
  await layer.locator('.ve-builder-details [data-alignment="Lawful Good"]').click();
  await page.waitForTimeout(800);
  await shot("details");

  await layer.locator('.ve-builder-tab[data-tab="review"]').click();
  await idle();
  await page.waitForSelector('.ve-builder-layer[data-screen="review"]');
  const review = await layer.locator(".ve-builder-body").innerText();
  check("Review shows STR 15 + 2 = 17 and package A", /STR 15 \+ 2 = 17/.test(review) && /Chain Mail/.test(review), review.slice(0, 600));
  check("nothing needs attention", !/Needs attention/i.test(review), review.slice(0, 400));
  check("Review says Level 1 (not level-up's Character level 0 → 1)", /Level 1/.test(review) && !/Character level/.test(review), review.slice(0, 400));
  await shot("review");
  await layer.locator(".ve-builder-body").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot("review-bottom");
  await next();
  await page.waitForSelector('.ve-builder-layer[data-screen="done"]', { timeout: 30000 });
  await shot("done");
  const made = await page.evaluate(() => game.actors.find(a => a.name === "Brannoc (CB creation phone test)")?.system.abilities.str.value ?? null);
  check("character saved with STR 17", made === 17, made);
  await layer.locator(".ve-builder-footer .ve-builder-primary").click();
  await page.waitForSelector(".ve-builder-layer", { state: "detached" });
} catch (error) {
  check(`no exception (${error.message})`, false);
  await shot("error").catch(() => {});
} finally {
  await page.evaluate(async b => {
    // Only what this test made: its "CB" character and its own user's new chat cards.
    for (const a of game.actors.filter(a => !b.actors.includes(a.id) && a.name.includes("(CB creation phone test)"))) await a.delete().catch(() => {});
    const messages = game.messages.filter(m => !b.messages.includes(m.id) && m.author?.id === game.user.id).map(m => m.id);
    if (messages.length) await ChatMessage.deleteDocuments(messages);
    const { createDraftStore } = await import(`/modules/${b.moduleId}/src/foundry/systems/dnd5e/builder/draft-store.mjs`);
    await createDraftStore(b.moduleId).finishCreation();
    await game.settings.set(b.moduleId, "builderHouseRules", b.rules);
    await game.user.update({ character: b.character });
  }, before).catch(error => console.log("cleanup failed", error.message));
  await browser.close();
}
const passed = results.filter(Boolean).length;
console.log(`TIMING step answer (${timings.step?.type}): ${timings.step?.ms} ms; Equipment tap: ${timings.equipmentTap} ms`);
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
